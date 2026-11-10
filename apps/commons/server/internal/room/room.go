// Package room is the Commons hub. A guild server holds one room, the guild's Commons. The room has a main channel and
// extra channels the Founder (or an Officer with manage_spaces) makes; each channel has its own voice, its own live
// board and saved boards, its own people, and its own chat thread.
package room

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/chat"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/ident"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/store"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/voice"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/wire"
	"github.com/pion/webrtc/v4"
)

// ProtocolVersion is the link protocol. A client with another version is told to reload.
const ProtocolVersion = 2

// Colors is how many member colors there are (names live in the client's tokens).
const Colors = 8

// MainChannel is the main channel's id. Its boards stay where task 21 kept the room's, so older data carries over.
const MainChannel = "main"

// DefaultMaxChannels is the roster's maxCommonsChannels default: the main channel and nine more.
const DefaultMaxChannels = 10

var roomIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

// Options set up a server.
type Options struct {
	// Ceiling is the most channels any guild may have: the roster's maxCommonsChannels. 0 means DefaultMaxChannels.
	Ceiling int
}

// Server holds the rooms on this guild server and the voice SFU they share.
type Server struct {
	dir  string
	sfu  *voice.SFU
	opts Options

	mu      sync.Mutex
	rooms   map[string]*Room
	conns   map[uint16]*Conn
	nextIdx uint16
}

// New makes a server keeping rooms under dir.
func New(dir string, opts Options) *Server {
	if opts.Ceiling < 1 {
		opts.Ceiling = DefaultMaxChannels
	}
	return &Server{dir: dir, opts: opts, rooms: map[string]*Room{}, conns: map[uint16]*Conn{}}
}

// SetSFU wires the voice server in.
func (s *Server) SetSFU(v *voice.SFU) { s.sfu = v }

// VoiceEvents are the SFU's callbacks into the rooms.
func (s *Server) VoiceEvents() voice.Events {
	return voice.Events{
		Slots: func(idx uint16, slots []int32) {
			if c := s.conn(idx); c != nil {
				c.ctrl(map[string]any{"t": "slots", "s": slots})
			}
		},
		Speaking: func(members []uint16) {
			for _, r := range s.allRooms() {
				r.speaking(members)
			}
		},
		ICE: func(idx uint16, c webrtc.ICECandidateInit) {
			if conn := s.conn(idx); conn != nil {
				conn.ctrl(map[string]any{"t": "rtc-ice", "candidate": c})
			}
		},
		Down: func(idx uint16) {
			if c := s.conn(idx); c != nil {
				c.ctrl(map[string]any{"t": "rtc-down"})
			}
		},
		Policed: func(idx uint16) {
			if c := s.conn(idx); c != nil {
				c.ctrl(map[string]any{"t": "rtc-down", "reason": "policed"})
			}
		},
		Usage: func(idx uint16, sent uint64, final bool) {
			if c := s.conn(idx); c != nil {
				c.reportUsage(sent, final)
			}
		},
	}
}

func (s *Server) conn(idx uint16) *Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns[idx]
}

func (s *Server) allRooms() []*Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	rooms := make([]*Room, 0, len(s.rooms))
	for _, r := range s.rooms {
		rooms = append(rooms, r)
	}
	return rooms
}

// Room opens (or loads) a room by id.
func (s *Server) Room(id string) (*Room, error) {
	if !roomIDRe.MatchString(id) {
		return nil, errors.New("room: bad id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rooms[id]; ok {
		return r, nil
	}
	r, err := openRoom(s, id, filepath.Join(s.dir, id))
	if err != nil {
		return nil, err
	}
	s.rooms[id] = r
	return r, nil
}

func (s *Server) register(c *Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.conns) >= 60000 {
		return false
	}
	for {
		s.nextIdx++
		if s.nextIdx == 0 {
			s.nextIdx = 1
		}
		if _, used := s.conns[s.nextIdx]; !used {
			break
		}
	}
	c.idx = s.nextIdx
	s.conns[c.idx] = c
	return true
}

func (s *Server) unregister(c *Conn) {
	s.mu.Lock()
	if s.conns[c.idx] == c {
		delete(s.conns, c.idx)
	}
	s.mu.Unlock()
}

// Flush writes every room's buffered records; sync also fsyncs them.
func (s *Server) Flush(sync bool) {
	for _, r := range s.allRooms() {
		r.mu.Lock()
		for _, ch := range r.channels {
			if err := ch.store.Flush(sync); err != nil {
				log.Printf("room %s/%s: flush: %v", r.id, ch.Meta.ID, err)
			}
			if err := ch.chat.Flush(sync); err != nil {
				log.Printf("room %s/%s: chat: %v", r.id, ch.Meta.ID, err)
			}
		}
		r.mu.Unlock()
	}
}

// Close flushes and closes every room's files.
func (s *Server) Close() {
	for _, r := range s.allRooms() {
		r.mu.Lock()
		for _, ch := range r.channels {
			ch.store.Close()
			ch.chat.Close()
		}
		if r.audit != nil {
			r.audit.Close()
		}
		r.mu.Unlock()
	}
}

// Stats is a count of members by state.
type Stats struct {
	Rooms, Conns, InRoom, Muted, Channels int
}

func (s *Server) Stats() Stats {
	rooms := s.allRooms()
	st := Stats{Rooms: len(rooms)}
	for _, r := range rooms {
		r.mu.Lock()
		st.Channels += len(r.channels)
		for _, c := range r.conns {
			st.Conns++
			if c.inRoom {
				st.InRoom++
				if c.muted {
					st.Muted++
				}
			}
		}
		r.mu.Unlock()
	}
	return st
}

// Settings are the guild's Commons settings: everyone reads them; the Founder or manage_spaces sets them.
type Settings struct {
	JoinMuted   bool `json:"joinMuted"`
	MaxChannels int  `json:"maxChannels"`
}

// ChannelMeta is what the channel list shows. Times are Unix milliseconds.
type ChannelMeta struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Main    bool   `json:"main,omitempty"`
	Created int64  `json:"created"`
	By      string `json:"by,omitempty"` // name of who made it
}

// Channel is one channel: its boards and its chat thread. Voice and presence are its members' state.
type Channel struct {
	Meta  ChannelMeta
	dir   string
	store *store.Room
	chat  *chat.Log
	// lastSpeaking is per room; cursors and boards go only to the channel's own members.
}

type roomFile struct {
	Settings Settings      `json:"settings"`
	Channels []ChannelMeta `json:"channels"`
}

// Room is one guild's Commons.
type Room struct {
	id           string
	srv          *Server
	dir          string
	mu           sync.Mutex
	settings     Settings
	ceiling      int
	channels     map[string]*Channel
	conns        map[uint16]*Conn
	lastSpeaking []uint16
	audit        *os.File
	now          func() time.Time
}

func openRoom(s *Server, id, dir string) (*Room, error) {
	if err := os.MkdirAll(filepath.Join(dir, "channels"), 0o700); err != nil {
		return nil, err
	}
	r := &Room{id: id, srv: s, dir: dir, ceiling: s.opts.Ceiling, channels: map[string]*Channel{}, conns: map[uint16]*Conn{}, now: time.Now}
	r.settings = Settings{MaxChannels: r.ceiling}
	var rf roomFile
	b, err := os.ReadFile(filepath.Join(dir, "commons.json"))
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &rf); err != nil {
			return nil, err
		}
		r.settings = rf.Settings
		if r.settings.MaxChannels < 1 {
			r.settings.MaxChannels = r.ceiling
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	hasMain := false
	for _, m := range rf.Channels {
		if m.ID == MainChannel {
			m.Main = true
			hasMain = true
		}
		if _, err := r.openChannel(m); err != nil {
			return nil, err
		}
	}
	if !hasMain {
		if _, err := r.openChannel(ChannelMeta{ID: MainChannel, Name: "Main", Main: true, Created: r.now().UnixMilli()}); err != nil {
			return nil, err
		}
	}
	if r.audit, err = os.OpenFile(filepath.Join(dir, "audit.log"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600); err != nil {
		return nil, err
	}
	return r, r.save()
}

func (r *Room) channelDir(id string) string {
	if id == MainChannel {
		return r.dir // task 21's room layout: room.json and boards/ at the room's root
	}
	return filepath.Join(r.dir, "channels", id)
}

func (r *Room) openChannel(m ChannelMeta) (*Channel, error) {
	dir := r.channelDir(m.ID)
	st, err := store.Open(dir)
	if err != nil {
		return nil, err
	}
	cl, err := chat.Open(filepath.Join(dir, "chat.log"))
	if err != nil {
		st.Close()
		return nil, err
	}
	ch := &Channel{Meta: m, dir: dir, store: st, chat: cl}
	r.channels[m.ID] = ch
	return ch, nil
}

// save writes commons.json whole and renames it into place. Call with r.mu held (or before the room is shared).
func (r *Room) save() error {
	rf := roomFile{Settings: r.settings, Channels: r.channelList()}
	b, err := json.MarshalIndent(rf, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(r.dir, "commons.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(r.dir, "commons.json"))
}

// channelList is every channel, main first, then by when they were made.
func (r *Room) channelList() []ChannelMeta {
	out := make([]ChannelMeta, 0, len(r.channels))
	for _, ch := range r.channels {
		out = append(out, ch.Meta)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Main != out[j].Main {
			return out[i].Main
		}
		if out[i].Created != out[j].Created {
			return out[i].Created < out[j].Created
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (r *Room) main() *Channel { return r.channels[MainChannel] }

// maxChannels is the cap in force: the guild's setting under the roster's ceiling.
func (r *Room) maxChannels() int { return max(1, min(r.settings.MaxChannels, r.ceiling)) }

// SetCeiling takes the roster's maxCommonsChannels (from deskd's hello, when it passes one).
func (r *Room) SetCeiling(n int) {
	if n < 1 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if n != r.ceiling {
		r.ceiling = n
		r.broadcastCtrl(r.settingsMsg(""), 0)
	}
}

// auditLog appends one line to the room's audit log: who did what, never the words of a message.
func (r *Room) auditLog(c *Conn, act string, fields map[string]any) {
	rec := map[string]any{"at": r.now().UTC().Format(time.RFC3339Nano), "by": c.id.MemberID, "role": c.id.Role, "act": act}
	for k, v := range fields {
		rec[k] = v
	}
	b, _ := json.Marshal(rec)
	if _, err := r.audit.Write(append(b, '\n')); err != nil {
		log.Printf("room %s: audit: %v", r.id, err)
	}
	_ = r.audit.Sync()
}

// memberJSON is how a member appears to the others. Never anything about age.
type memberJSON struct {
	I     uint16 `json:"i"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Badge string `json:"badge,omitempty"`
	Role  string `json:"role"`
	Color int    `json:"color"`
	Ch    string `json:"ch"`
	In    bool   `json:"in"`
	Muted bool   `json:"muted"`
}

func (c *Conn) member() memberJSON {
	return memberJSON{I: c.idx, ID: c.id.MemberID, Name: c.id.Name, Badge: c.id.Badge, Role: c.id.Role, Color: c.color, Ch: c.ch.Meta.ID, In: c.inRoom, Muted: c.muted}
}

func (c *Conn) can() map[string]bool {
	return map[string]bool{"manage": c.id.Can(ident.ManageSpaces), "moderate": c.id.Can(ident.Moderate)}
}

// broadcast sends a record to everyone in the room except skip (0 for nobody). Call with r.mu held.
func (r *Room) broadcast(rec []byte, skip uint16, droppable bool) {
	for idx, c := range r.conns {
		if idx != skip && c.ready {
			c.sendPaced(rec, droppable, false)
		}
	}
}

// broadcastCh sends a record to everyone looking at one channel. Call with r.mu held.
func (r *Room) broadcastCh(ch *Channel, rec []byte, skip uint16, droppable, paced bool) {
	for idx, c := range r.conns {
		if idx != skip && c.ready && c.ch == ch {
			c.sendPaced(rec, droppable, paced)
		}
	}
}

func ctrlRec(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return wire.Append(nil, wire.Ctrl, b)
}

func (r *Room) broadcastCtrl(v any, skip uint16) {
	if rec := ctrlRec(v); rec != nil {
		r.broadcast(rec, skip, false)
	}
}

func (r *Room) broadcastChCtrl(ch *Channel, v any, skip uint16) {
	if rec := ctrlRec(v); rec != nil {
		r.broadcastCh(ch, rec, skip, false, false)
	}
}

type channelJSON struct {
	ChannelMeta
	Last uint32 `json:"last"` // the newest chat seq, for unread marks
}

func (r *Room) channelsMsg(by string) map[string]any {
	list := r.channelList()
	out := make([]channelJSON, 0, len(list))
	for _, m := range list {
		out = append(out, channelJSON{ChannelMeta: m, Last: r.channels[m.ID].chat.Last()})
	}
	msg := map[string]any{"t": "channels", "list": out}
	if by != "" {
		msg["by"] = by
	}
	return msg
}

func (r *Room) settingsMsg(by string) map[string]any {
	m := map[string]any{"t": "settings", "settings": r.settings, "ceiling": r.ceiling, "max": r.maxChannels()}
	if by != "" {
		m["by"] = by
	}
	return m
}

func boardsMsg(ch *Channel, by string) map[string]any {
	m := map[string]any{"t": "boards", "ch": ch.Meta.ID, "list": ch.store.List(), "active": ch.store.Active}
	if by != "" {
		m["by"] = by
	}
	return m
}

// sendBoard sends the channel's up board's log to one member, then board-ready. Call with r.mu held.
func (r *Room) sendBoard(c *Conn) {
	ch := c.ch
	bd, ok := ch.store.Board(ch.store.Active)
	if !ok {
		return
	}
	prefix := wire.BoardPrefix(bd.Meta.ID)
	for _, e := range bd.Entries {
		c.send(wire.Append(nil, wire.BoardEntry, prefix, wire.U32(e.Seq), e.Data), false)
	}
	c.ctrl(map[string]any{"t": "board-ready", "ch": ch.Meta.ID, "id": bd.Meta.ID, "seq": bd.Seq})
}

// sendChat sends the latest page of a channel's thread to one member. Call with r.mu held.
func (r *Room) sendChat(c *Conn, ch *Channel) {
	msgs, more := ch.chat.Page(0, 50)
	c.ctrl(map[string]any{"t": "chat-page", "ch": ch.Meta.ID, "msgs": msgs, "more": more, "latest": true})
}

func (r *Room) pickColor() int {
	used := make([]int, Colors)
	for _, c := range r.conns {
		if c.ready {
			used[c.color]++
		}
	}
	best := 0
	for i := 1; i < Colors; i++ {
		if used[i] < used[best] {
			best = i
		}
	}
	return best
}

// attach adds a new connection to the room, in the main channel. Not ready until its hello.
func (r *Room) attach(c *Conn) {
	r.mu.Lock()
	c.ch = r.main()
	r.conns[c.idx] = c
	r.mu.Unlock()
}

// hello admits a member who has said hello.
func (r *Room) hello(c *Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c.id.Name == "" {
		c.id.Name = "Guest"
	}
	c.color = r.pickColor()
	members := []memberJSON{}
	for _, o := range r.conns {
		if o.ready {
			members = append(members, o.member())
		}
	}
	sort.Slice(members, func(i, j int) bool { return members[i].I < members[j].I })
	c.ready = true
	slots := 0
	if r.srv.sfu != nil {
		slots = r.srv.sfu.Slots()
	}
	w := map[string]any{
		"t": "welcome", "v": ProtocolVersion, "you": c.member(), "room": r.id, "members": members,
		"channels": r.channelsMsg("")["list"], "ch": c.ch.Meta.ID, "boards": boardsMsg(c.ch, ""),
		"settings": r.settingsMsg(""), "can": c.can(), "slots": slots, "speaking": r.lastSpeaking,
	}
	c.ctrl(w)
	r.sendBoard(c)
	r.sendChat(c, c.ch)
	r.broadcastCtrl(map[string]any{"t": "member", "m": c.member()}, c.idx)
}

// recheck applies a refreshed identity from deskd: a new name, badge, role or grants take effect at once.
func (r *Room) recheck(c *Conn, id ident.Identity) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c.id = id
	if !c.ready {
		return
	}
	c.ctrl(map[string]any{"t": "you", "m": c.member(), "can": c.can()})
	r.broadcastCtrl(map[string]any{"t": "member", "m": c.member()}, c.idx)
}

func (r *Room) leave(c *Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.conns, c.idx)
	if c.ready {
		r.broadcastCtrl(map[string]any{"t": "gone", "i": c.idx}, 0)
	}
}

func (r *Room) voiceRoom(ch *Channel) string { return r.id + "/" + ch.Meta.ID }

func (r *Room) setInRoom(c *Conn, in bool) {
	r.mu.Lock()
	changed := c.inRoom != in
	c.inRoom = in
	var moved []*Conn
	if in && changed {
		// One voice per member: joining here takes them out of the room in their other windows.
		for _, o := range r.conns {
			if o != c && o.inRoom && o.id.MemberID == c.id.MemberID {
				moved = append(moved, o)
			}
		}
	}
	if changed {
		r.broadcastCtrl(map[string]any{"t": "member", "m": c.member()}, 0)
		if !in {
			r.broadcastCh(c.ch, wire.Append(nil, wire.Cursor, wire.CursorOut(c.idx, hiddenCursor)), c.idx, true, false)
		}
	}
	r.mu.Unlock()
	if !in && r.srv.sfu != nil {
		r.srv.sfu.Remove(c.idx)
	}
	for _, o := range moved {
		r.setInRoom(o, false)
		o.ctrl(map[string]any{"t": "moved"})
	}
}

func (r *Room) setMuted(c *Conn, muted bool) {
	r.mu.Lock()
	changed := c.muted != muted
	c.muted = muted
	if changed {
		r.broadcastCtrl(map[string]any{"t": "member", "m": c.member()}, 0)
	}
	r.mu.Unlock()
	if r.srv.sfu != nil {
		r.srv.sfu.SetMuted(c.idx, muted)
	}
}

func (r *Room) speaking(all []uint16) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var mine []uint16
	for _, idx := range all {
		if _, ok := r.conns[idx]; ok {
			mine = append(mine, idx)
		}
	}
	if equal16(mine, r.lastSpeaking) {
		return
	}
	r.lastSpeaking = mine
	body := make([]byte, 0, 2+2*len(mine))
	body = append(body, wire.U16(uint16(len(mine)))...)
	for _, idx := range mine {
		body = append(body, wire.U16(idx)...)
	}
	r.broadcast(wire.Append(nil, wire.Speaking, body), 0, true)
}

func equal16(a, b []uint16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// update takes a member's Yjs update for a board in their channel.
func (r *Room) update(c *Conn, id string, ref uint32, data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch := c.ch
	bd, ok := ch.store.Board(id)
	if !ok {
		c.ctrl(map[string]any{"t": "error", "code": "no-board", "id": id})
		return
	}
	if !c.inRoom {
		c.ctrl(map[string]any{"t": "error", "code": "read-only", "id": id})
		return
	}
	if len(data) > store.MaxUpdate {
		c.ctrl(map[string]any{"t": "error", "code": "too-big", "id": id})
		return
	}
	// The channel's budget (Security's GDS-6). The board up may be able to give room back: its log, compacted.
	if !ch.store.Fits(len(data)) {
		c.ctrl(map[string]any{"t": "error", "code": "full", "id": id})
		if id == ch.store.Active && bd.SinceSnapN > 0 && time.Since(bd.CompactAsked) > 10*time.Second {
			bd.CompactAsked = time.Now()
			c.ctrl(map[string]any{"t": "compact", "id": id})
		}
		return
	}
	seq := ch.store.Append(bd, data, c.id.Name)
	prefix := wire.BoardPrefix(id)
	if id == ch.store.Active {
		r.broadcastCh(ch, wire.Append(nil, wire.BoardEntry, prefix, wire.U32(seq), data), c.idx, false, false)
	}
	c.send(wire.Append(nil, wire.BoardAck, prefix, wire.U32(seq), wire.U32(ref)), false)
	if id == ch.store.Active && ch.store.WantsCompaction(bd) {
		bd.CompactAsked = time.Now()
		c.ctrl(map[string]any{"t": "compact", "id": id})
	}
}

// snapshot takes the whole board from a member the server asked, in place of its older entries.
func (r *Room) snapshot(c *Conn, id string, upto uint32, data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch := c.ch
	bd, ok := ch.store.Board(id)
	if !ok || !c.inRoom || bd.CompactAsked.IsZero() || len(data) > store.MaxSnapshot {
		return
	}
	if err := ch.store.Compact(bd, upto, data); err != nil {
		log.Printf("room %s/%s: compact %s: %v", r.id, ch.Meta.ID, id, err)
	}
}

// boards runs a board-list command in the member's channel: new, switch, rename, delete, list, empty.
func (r *Room) boards(c *Conn, m ctrlIn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch := c.ch
	if m.Op != "list" && !c.inRoom {
		c.ctrl(map[string]any{"t": "error", "code": "read-only"})
		return
	}
	st := ch.store
	prev := st.Active
	var err error
	switch m.Op {
	case "list":
		c.ctrl(boardsMsg(ch, ""))
		return
	case "empty":
		st.SetEmpty(m.ID, m.Empty)
		return
	case "new":
		_, err = st.Create(m.Name)
		if err == nil {
			// The board left behind may be dropped if it was blank and unnamed.
			if p, ok := st.Board(prev); ok && p.Meta.Name == "" && (p.Meta.Empty || p.Seq == 0) {
				err = st.Delete(prev)
			}
		}
	case "switch":
		err = st.Switch(m.ID)
	case "rename":
		err = st.Rename(m.ID, m.Name)
	case "delete":
		err = st.Delete(m.ID)
	default:
		err = errors.New("unknown op")
	}
	if err != nil {
		c.ctrl(map[string]any{"t": "error", "code": "boards", "msg": err.Error()})
		return
	}
	_ = st.SaveIndex()
	r.broadcastChCtrl(ch, boardsMsg(ch, c.id.Name), 0)
	if st.Active != prev {
		for _, o := range r.conns {
			if o.ready && o.ch == ch {
				r.sendBoard(o)
			}
		}
	}
}

var hiddenCursor = []byte{0, 0, 0xc0, 0x7f, 0, 0, 0xc0, 0x7f} // two NaNs

// relay passes a cursor or a stroke in progress to everyone else in the member's channel.
func (r *Room) relay(c *Conn, typ byte, body []byte) {
	if !c.inRoom {
		return
	}
	rec := wire.Append(nil, typ, wire.U16(c.idx), body)
	r.mu.Lock()
	r.broadcastCh(c.ch, rec, c.idx, true, typ == wire.Cursor)
	r.mu.Unlock()
}

// ---------------------------------------------------------------- channels

// cleanChannelName tidies a channel's name: 1 to 40 characters, no control characters.
func cleanChannelName(s string) string {
	return ident.CleanName(s)
}

func (r *Room) nameTaken(name, except string) bool {
	for id, ch := range r.channels {
		if id != except && strings.EqualFold(ch.Meta.Name, name) {
			return true
		}
	}
	return false
}

func newChannelID(r *Room) (string, error) {
	for {
		id, err := store.NewID("c")
		if err != nil {
			return "", err
		}
		if _, used := r.channels[id]; !used {
			return id, nil
		}
	}
}

// switchTo moves a member to another channel: their voice follows them, and they get its boards and chat. Call with
// r.mu held.
func (r *Room) switchTo(c *Conn, ch *Channel) {
	if c.ch == ch {
		return
	}
	old := c.ch
	if c.inRoom {
		r.broadcastCh(old, wire.Append(nil, wire.Cursor, wire.CursorOut(c.idx, hiddenCursor)), c.idx, true, false)
	}
	c.ch = ch
	if c.inRoom && r.srv.sfu != nil {
		r.srv.sfu.SetRoom(c.idx, r.voiceRoom(ch))
	}
	r.broadcastCtrl(map[string]any{"t": "member", "m": c.member()}, 0)
	if c.ready {
		c.ctrl(map[string]any{"t": "channel", "ch": ch.Meta.ID, "boards": boardsMsg(ch, "")})
		r.sendBoard(c)
		r.sendChat(c, ch)
	}
}

// channel runs a channel command: switch (anyone), create, rename, delete (the Founder or manage_spaces).
func (r *Room) channel(c *Conn, m ctrlIn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fail := func(code string) { c.ctrl(map[string]any{"t": "error", "code": "channel", "reason": code, "op": m.Op}) }
	if m.Op == "switch" {
		ch, ok := r.channels[m.ID]
		if !ok {
			fail("no-channel")
			return
		}
		r.switchTo(c, ch)
		return
	}
	if !c.id.Can(ident.ManageSpaces) {
		fail("forbidden")
		return
	}
	switch m.Op {
	case "create":
		name := cleanChannelName(m.Name)
		if name == "" {
			fail("name")
			return
		}
		if len(r.channels) >= r.maxChannels() {
			fail("limit")
			return
		}
		if r.nameTaken(name, "") {
			fail("name-taken")
			return
		}
		id, err := newChannelID(r)
		if err != nil {
			fail("internal")
			return
		}
		ch, err := r.openChannel(ChannelMeta{ID: id, Name: name, Created: r.now().UnixMilli(), By: c.id.Name})
		if err != nil {
			log.Printf("room %s: new channel: %v", r.id, err)
			fail("internal")
			return
		}
		r.auditLog(c, "channel.create", map[string]any{"ch": id, "name": name})
		_ = r.save()
		r.broadcastCtrl(r.channelsMsg(c.id.Name), 0)
		r.switchTo(c, ch)
	case "rename":
		ch, ok := r.channels[m.ID]
		name := cleanChannelName(m.Name)
		if !ok {
			fail("no-channel")
			return
		}
		if name == "" {
			fail("name")
			return
		}
		if r.nameTaken(name, m.ID) {
			fail("name-taken")
			return
		}
		r.auditLog(c, "channel.rename", map[string]any{"ch": ch.Meta.ID, "from": ch.Meta.Name, "name": name})
		ch.Meta.Name = name
		_ = r.save()
		r.broadcastCtrl(r.channelsMsg(c.id.Name), 0)
	case "delete":
		ch, ok := r.channels[m.ID]
		if !ok {
			fail("no-channel")
			return
		}
		if ch.Meta.Main {
			fail("main")
			return
		}
		main := r.main()
		for _, o := range r.conns {
			if o.ch == ch {
				r.switchTo(o, main)
				if o.ready {
					o.ctrl(map[string]any{"t": "notice", "text": c.id.Name + " deleted " + ch.Meta.Name})
				}
			}
		}
		delete(r.channels, ch.Meta.ID)
		ch.store.Close()
		ch.chat.Close()
		if err := os.RemoveAll(ch.dir); err != nil {
			log.Printf("room %s: delete channel %s: %v", r.id, ch.Meta.ID, err)
		}
		r.auditLog(c, "channel.delete", map[string]any{"ch": ch.Meta.ID, "name": ch.Meta.Name})
		_ = r.save()
		r.broadcastCtrl(r.channelsMsg(c.id.Name), 0)
	default:
		fail("op")
	}
}

// setSettings changes Commons' settings: the Founder or manage_spaces.
func (r *Room) setSettings(c *Conn, m ctrlIn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !c.id.Can(ident.ManageSpaces) {
		c.ctrl(map[string]any{"t": "error", "code": "settings", "reason": "forbidden"})
		return
	}
	next := r.settings
	if m.JoinMuted != nil {
		next.JoinMuted = *m.JoinMuted
	}
	if m.MaxChannels != nil {
		n := *m.MaxChannels
		if n < 1 || n > r.ceiling {
			c.ctrl(map[string]any{"t": "error", "code": "settings", "reason": "max-channels", "ceiling": r.ceiling})
			return
		}
		next.MaxChannels = n
	}
	if next == r.settings {
		return
	}
	r.auditLog(c, "settings.set", map[string]any{"from": r.settings, "to": next})
	r.settings = next
	_ = r.save()
	r.broadcastCtrl(r.settingsMsg(c.id.Name), 0)
}

// ---------------------------------------------------------------- chat

// chatOp runs a chat command: send, edit, delete, history.
func (r *Room) chatOp(c *Conn, m ctrlIn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch, ok := r.channels[m.Ch]
	fail := func(reason string) {
		c.ctrl(map[string]any{"t": "error", "code": "chat", "reason": reason, "ch": m.Ch, "nonce": m.Nonce, "seq": m.Seq})
	}
	if !ok {
		fail("no-channel")
		return
	}
	switch m.T {
	case "chat-history":
		msgs, more := ch.chat.Page(m.Before, m.Limit)
		c.ctrl(map[string]any{"t": "chat-page", "ch": ch.Meta.ID, "msgs": msgs, "more": more, "before": m.Before})
		return
	}
	if !c.allowChat() {
		fail("rate")
		return
	}
	switch m.T {
	case "chat-send":
		msg, fresh, err := ch.chat.Post(c.id.MemberID, c.id.Name, c.id.Badge, m.Nonce, m.Text)
		if err != nil {
			fail(err.Error())
			return
		}
		if fresh {
			others := msg
			others.Nonce = ""
			r.broadcastCtrl(map[string]any{"t": "chat", "ch": ch.Meta.ID, "m": others}, c.idx)
		}
		c.ctrl(map[string]any{"t": "chat", "ch": ch.Meta.ID, "m": msg})
	case "chat-edit":
		msg, err := ch.chat.Edit(m.Seq, c.id.MemberID, m.Text)
		if err != nil {
			fail(err.Error())
			return
		}
		r.broadcastCtrl(map[string]any{"t": "chat-edit", "ch": ch.Meta.ID, "m": msg}, 0)
	case "chat-delete":
		author, err := ch.chat.Author(m.Seq)
		if err != nil {
			fail(err.Error())
			return
		}
		mod := author != c.id.MemberID
		if mod && !c.id.Can(ident.Moderate) {
			fail(chat.ErrNotYours.Error())
			return
		}
		if err := ch.chat.Delete(m.Seq, c.id.MemberID, mod); err != nil {
			fail(err.Error())
			return
		}
		if mod {
			r.auditLog(c, "chat.delete", map[string]any{"ch": ch.Meta.ID, "seq": m.Seq, "author": author})
		}
		r.broadcastCtrl(map[string]any{"t": "chat-delete", "ch": ch.Meta.ID, "seq": m.Seq, "mod": mod}, 0)
	}
}
