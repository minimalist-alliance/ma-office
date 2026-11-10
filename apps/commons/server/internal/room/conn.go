package room

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/ident"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/relay"
	"github.com/minimalist-alliance/ma-desk/apps/commons/server/internal/wire"
	"github.com/pion/webrtc/v4"
)

// Outbox limits per member. Cursors and strokes in progress are dropped for a member who has
// fallen this far behind; board records never are. Past the hard limit the member is cut off,
// and their client reconnects and reloads the board.
const (
	dropAbove = 1 << 20
	cutAbove  = 64 << 20
)

// Ephemeral rate: cursors and strokes in progress, per member.
const (
	ratePerSec = 240.0
	rateBurst  = 480.0
)

// Board rate, per member (Security's GDS-6): finished board updates and snapshots, by count and by bytes. A member
// past it is slowed, not dropped, since a lost Yjs update would leave their board apart from the room's; one who'd have
// to wait more than MaxWait is cut off. Drawing by hand sends a few a second; a big paste is one update.
type boardRate struct {
	PerSec, Burst           float64
	BytesPerSec, BytesBurst float64
	MaxWait                 time.Duration
}

var boardRateNow atomic.Pointer[boardRate]

func init() {
	boardRateNow.Store(&boardRate{PerSec: 120, Burst: 480, BytesPerSec: 2 << 20, BytesBurst: 16 << 20, MaxWait: 5 * time.Second})
}

// Chat rate, per member: sends, edits and deletes. A burst of ten, then two a second.
const (
	chatPerSec = 2.0
	chatBurst  = 10.0
)

// Counters for the stats page, across every connection.
var (
	WSBytesIn, WSBytesOut, WSMsgsOut atomic.Uint64
	Dropped                          atomic.Uint64
	BoardPaced                       atomic.Uint64 // board records a member had to wait for
)

var errBoardRate = errors.New("room: board updates far past the rate")

// usageReporter is a transport that tells deskd how much voice a member's session took (the relay; -dev has none).
type usageReporter interface {
	writeUsage(voiceBytesSent uint64, final bool) error
}

type usageMsg struct {
	sent  uint64
	final bool
}

// transport is one member's room link: deskd's relay on a guild desk, a WebSocket in -dev.
type transport interface {
	// read returns the next room-link message.
	read(ctx context.Context) ([]byte, error)
	// write sends one room-link message.
	write(ctx context.Context, msg []byte) error
	close()
}

// Conn is one member's link.
type Conn struct {
	idx  uint16
	room *Room
	t    transport

	// Guarded by room.mu.
	id     ident.Identity
	ch     *Channel
	color  int
	ready  bool
	inRoom bool
	muted  bool

	omu    sync.Mutex
	out    []byte
	wake   chan struct{}
	urgent atomic.Bool // something besides cursors is queued
	dead   atomic.Bool

	tokens     float64
	filled     time.Time
	chatTokens float64
	chatFilled time.Time
	// Voice metering to deskd, in order, off the SFU's goroutines. Nil queue: the transport doesn't report.
	usageQ    chan usageMsg
	usageDone chan struct{}
	usageEnd  chan struct{}
	umu       sync.Mutex
	uclosed   bool

	boardN  float64 // board updates left in the bucket
	boardB  float64 // bytes
	boardAt time.Time
	parts   wire.Joiner
}

// ctrlIn is every field a client's control message may carry.
type ctrlIn struct {
	T           string                   `json:"t"`
	V           int                      `json:"v"`
	Name        string                   `json:"name"`
	Muted       bool                     `json:"muted"`
	SDP         string                   `json:"sdp"`
	Candidate   *webrtc.ICECandidateInit `json:"candidate"`
	Op          string                   `json:"op"`
	ID          string                   `json:"id"`
	Empty       bool                     `json:"empty"`
	N           float64                  `json:"n"`
	Ch          string                   `json:"ch"`
	Text        string                   `json:"text"`
	Nonce       string                   `json:"nonce"`
	Seq         uint32                   `json:"seq"`
	Before      uint32                   `json:"before"`
	Limit       int                      `json:"limit"`
	JoinMuted   *bool                    `json:"joinMuted"`
	MaxChannels *int                     `json:"maxChannels"`
}

func newConn(rm *Room, t transport, id ident.Identity) *Conn {
	now := time.Now()
	br := boardRateNow.Load()
	return &Conn{room: rm, t: t, id: id, wake: make(chan struct{}, 1), tokens: rateBurst, filled: now, chatTokens: chatBurst, chatFilled: now,
		boardN: br.Burst, boardB: br.BytesBurst, boardAt: now}
}

// run serves one member's link until it ends.
func (s *Server) run(ctx context.Context, rm *Room, c *Conn) {
	// Before the connection can be found by the SFU's events.
	var ur usageReporter
	if r, ok := c.t.(usageReporter); ok {
		ur = r
		c.usageQ, c.usageDone, c.usageEnd = make(chan usageMsg, 16), make(chan struct{}), make(chan struct{})
	}
	if !s.register(c) {
		c.t.close()
		return
	}
	rm.attach(c)
	if ur != nil {
		go c.usageLoop(ur)
	}
	ctx, cancel := context.WithCancel(ctx)
	go c.writer(ctx, cancel)
	c.reader(ctx)
	cancel()
	c.dead.Store(true)
	rm.setInRoom(c, false) // ends the member's voice connection, which queues its final usage
	c.endUsage()
	rm.leave(c)
	s.unregister(c)
	c.t.close()
}

// reportUsage queues a voice usage report for deskd. A periodic one is dropped if deskd is far behind; the final one
// waits a moment for room.
func (c *Conn) reportUsage(sent uint64, final bool) {
	c.umu.Lock()
	defer c.umu.Unlock()
	if c.usageQ == nil || c.uclosed {
		return
	}
	m := usageMsg{sent, final}
	if !final {
		select {
		case c.usageQ <- m:
		default:
		}
		return
	}
	t := time.NewTimer(time.Second)
	defer t.Stop()
	select {
	case c.usageQ <- m:
	case <-t.C:
	}
}

// usageLoop writes the queued reports to deskd in order.
func (c *Conn) usageLoop(ur usageReporter) {
	defer close(c.usageEnd)
	for {
		select {
		case m := <-c.usageQ:
			_ = ur.writeUsage(m.sent, m.final)
		case <-c.usageDone:
			for {
				select {
				case m := <-c.usageQ:
					_ = ur.writeUsage(m.sent, m.final)
				default:
					return
				}
			}
		}
	}
}

// endUsage sends what's queued, the final report included, and stops reporting.
func (c *Conn) endUsage() {
	c.umu.Lock()
	if c.usageQ == nil || c.uclosed {
		c.umu.Unlock()
		return
	}
	c.uclosed = true
	c.umu.Unlock()
	close(c.usageDone)
	<-c.usageEnd
}

// ---------------------------------------------------------------- deskd's relay (production)

// ServeRelay takes deskd's connections on its socket until the listener closes. Each is one member session.
func (s *Server) ServeRelay(ln *relay.Listener, roomID string) error {
	rm, err := s.Room(roomID)
	if err != nil {
		return err
	}
	for {
		rc, err := ln.Accept()
		if err != nil {
			return err
		}
		go func() {
			h, id, err := rc.ReadHello(10 * time.Second)
			if err != nil {
				log.Printf("relay: %v", err)
				rc.Close()
				return
			}
			if h.Limits != nil && h.Limits.MaxCommonsChannels > 0 {
				rm.SetCeiling(h.Limits.MaxCommonsChannels)
			}
			c := newConn(rm, nil, id)
			c.t = &relayTransport{rc: rc, c: c}
			s.run(context.Background(), rm, c)
		}()
	}
}

type relayTransport struct {
	rc   *relay.Conn
	c    *Conn
	once sync.Once
}

func (t *relayTransport) read(ctx context.Context) ([]byte, error) {
	stop := context.AfterFunc(ctx, func() { t.rc.Close() })
	defer stop()
	for {
		typ, body, err := t.rc.ReadFrame()
		if err != nil {
			return nil, err
		}
		switch typ {
		case relay.Link:
			WSBytesIn.Add(uint64(len(body)))
			return body, nil
		case relay.JSON:
			var f struct {
				T      string       `json:"t"`
				Caller ident.Caller `json:"caller"`
			}
			if json.Unmarshal(body, &f) != nil || f.T != "caller" {
				continue // reserved
			}
			id, err := f.Caller.Identity()
			if err != nil {
				return nil, err
			}
			if id.MemberID != t.c.id.MemberID {
				return nil, errors.New("relay: a caller frame changed the member")
			}
			t.c.room.recheck(t.c, id)
		}
	}
}

func (t *relayTransport) write(_ context.Context, msg []byte) error {
	return t.rc.WriteFrame(relay.Link, msg, 30*time.Second)
}

func (t *relayTransport) close() { t.once.Do(func() { t.rc.Close() }) }

// writeUsage tells deskd the voice bytes sent to this session's voice connection since it began (README, "On a guild
// desk"). final marks a voice connection's last report; the next one starts again at 0.
func (t *relayTransport) writeUsage(sent uint64, final bool) error {
	m := map[string]any{"t": "usage", "voiceBytesSent": sent}
	if final {
		m["final"] = true
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return t.rc.WriteFrame(relay.JSON, b, 2*time.Second)
}

// ---------------------------------------------------------------- WebSocket (-dev only)

// ServeWS is the -dev room link: /ws?room=<id>&name=…, with an identity from the URL. Never on a guild desk.
func (s *Server) ServeWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("room")
	if id == "" {
		id = "commons"
	}
	rm, err := s.Room(id)
	if err != nil {
		http.Error(w, "no such room", http.StatusBadRequest)
		return
	}
	ws, err := websocket.Accept(w, r, nil) // same origin only
	if err != nil {
		return
	}
	ws.SetReadLimit(wire.MaxRecord + 1024)
	s.run(r.Context(), rm, newConn(rm, &wsTransport{ws: ws}, DevIdentity(q.Get("name"), q.Get("member"), q.Get("role"), q.Get("grants"), q.Get("badge"))))
}

// DevIdentity is a -dev member: whoever the URL says. The member id follows from the name unless given.
func DevIdentity(name, member, role, grants, badge string) ident.Identity {
	name = ident.CleanName(name)
	if member == "" && name != "" {
		h := sha256.Sum256([]byte(strings.ToLower(name)))
		member = "dev-" + hex.EncodeToString(h[:5])
	}
	if member == "" {
		var b [5]byte
		_, _ = rand.Read(b[:])
		member = "dev-" + hex.EncodeToString(b[:])
	}
	switch role {
	case ident.Lead, ident.Officer:
	default:
		role = ident.Member
	}
	if badge != ident.BadgeOfficer && badge != ident.BadgeLead {
		badge = ""
	}
	var gs []string
	for _, g := range strings.Split(grants, ",") {
		if g = strings.TrimSpace(g); g != "" {
			gs = append(gs, g)
		}
	}
	return ident.Identity{MemberID: member, Role: role, Grants: gs, Name: name, Badge: badge}
}

type wsTransport struct{ ws *websocket.Conn }

func (t *wsTransport) read(ctx context.Context) ([]byte, error) {
	for {
		typ, msg, err := t.ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		if typ == websocket.MessageBinary {
			WSBytesIn.Add(uint64(len(msg)))
			return msg, nil
		}
	}
}

func (t *wsTransport) write(ctx context.Context, msg []byte) error {
	wctx, done := context.WithTimeout(ctx, 30*time.Second)
	defer done()
	return t.ws.Write(wctx, websocket.MessageBinary, msg)
}

func (t *wsTransport) close() { t.ws.CloseNow() }

// ---------------------------------------------------------------- reading

func (c *Conn) reader(ctx context.Context) {
	for {
		msg, err := c.t.read(ctx)
		if err != nil {
			return
		}
		if err := wire.Each(msg, c.handle); err != nil {
			log.Printf("member %d: %v", c.idx, err)
			return
		}
		if c.dead.Load() {
			return
		}
	}
}

func (c *Conn) allow() bool {
	now := time.Now()
	c.tokens = min(rateBurst, c.tokens+now.Sub(c.filled).Seconds()*ratePerSec)
	c.filled = now
	if c.tokens < 1 {
		Dropped.Add(1)
		return false
	}
	c.tokens--
	return true
}

// paceBoard takes one board record of n bytes from the member's board bucket, waiting for it if it must. False: the
// member is far past the rate and is cut off. Called from the reader only.
func (c *Conn) paceBoard(n int) bool {
	br := boardRateNow.Load()
	now := time.Now()
	dt := now.Sub(c.boardAt).Seconds()
	c.boardAt = now
	c.boardN = min(br.Burst, c.boardN+dt*br.PerSec)
	c.boardB = min(br.BytesBurst, c.boardB+dt*br.BytesPerSec)
	var wait time.Duration
	if c.boardN < 1 {
		wait = time.Duration((1 - c.boardN) / br.PerSec * float64(time.Second))
	}
	if need := float64(n); c.boardB < need {
		wait = max(wait, time.Duration((need-c.boardB)/br.BytesPerSec*float64(time.Second)))
	}
	if wait > br.MaxWait {
		Dropped.Add(1)
		return false
	}
	if wait > 0 {
		BoardPaced.Add(1)
		time.Sleep(wait)
		c.boardAt = c.boardAt.Add(wait)
		c.boardN += wait.Seconds() * br.PerSec
		c.boardB += wait.Seconds() * br.BytesPerSec
	}
	c.boardN--
	c.boardB -= float64(n)
	return true
}

// allowChat is the chat rate. Called with room.mu held, from the reader.
func (c *Conn) allowChat() bool {
	now := time.Now()
	c.chatTokens = min(chatBurst, c.chatTokens+now.Sub(c.chatFilled).Seconds()*chatPerSec)
	c.chatFilled = now
	if c.chatTokens < 1 {
		return false
	}
	c.chatTokens--
	return true
}

func (c *Conn) handle(typ byte, p []byte) error {
	r := c.room
	if typ == wire.Part {
		rec, done, err := c.parts.Add(p)
		if err != nil || !done {
			return err
		}
		return wire.Each(rec, c.handle)
	}
	if typ != wire.Ctrl && !c.ready {
		return nil
	}
	switch typ {
	case wire.Ctrl:
		var m ctrlIn
		if err := json.Unmarshal(p, &m); err != nil {
			return nil
		}
		c.control(m)
	case wire.BoardUpdate:
		if !c.paceBoard(len(p)) {
			return errBoardRate
		}
		id, rest, err := wire.BoardID(p)
		if err != nil {
			return err
		}
		ref, data, err := wire.ReadU32(rest)
		if err != nil {
			return err
		}
		r.update(c, id, ref, data)
	case wire.BoardSnapshot:
		if !c.paceBoard(len(p)) {
			return errBoardRate
		}
		id, rest, err := wire.BoardID(p)
		if err != nil {
			return err
		}
		upto, data, err := wire.ReadU32(rest)
		if err != nil {
			return err
		}
		r.snapshot(c, id, upto, data)
	case wire.Cursor:
		if wire.ValidCursor(p) && c.allow() {
			r.relay(c, wire.Cursor, p)
		}
	case wire.Live:
		if len(p) <= 8<<10 && c.allow() {
			r.relay(c, wire.Live, p)
		}
	}
	return nil
}

func (c *Conn) control(m ctrlIn) {
	r := c.room
	sfu := r.srv.sfu
	if m.T != "hello" && !c.ready {
		return
	}
	switch m.T {
	case "hello":
		if m.V != ProtocolVersion {
			c.ctrl(map[string]any{"t": "error", "code": "version", "v": ProtocolVersion})
			c.dead.Store(true)
			return
		}
		if c.ready {
			return
		}
		r.mu.Lock()
		if c.id.Name == "" {
			// -dev only: a member with no name in the URL says it here. On a desk the name comes from deskd.
			c.id.Name = ident.CleanName(m.Name)
		}
		r.mu.Unlock()
		r.hello(c)
	case "join":
		r.mu.Lock()
		c.muted = m.Muted
		r.mu.Unlock()
		r.setInRoom(c, true)
	case "leave":
		r.setInRoom(c, false)
	case "mute":
		r.setMuted(c, m.Muted)
	case "rtc-offer":
		r.mu.Lock()
		in, muted, ch := c.inRoom, c.muted, c.ch
		r.mu.Unlock()
		if !in || sfu == nil {
			c.ctrl(map[string]any{"t": "error", "code": "not-in-room"})
			return
		}
		// Bound to this connection's member, never to anything in the offer.
		ans, mids, err := sfu.Answer(r.voiceRoom(ch), c.idx, m.SDP, muted)
		if err != nil {
			log.Printf("member %d: voice: %v", c.idx, err)
			c.ctrl(map[string]any{"t": "error", "code": "voice", "msg": err.Error()})
			return
		}
		// The channel may have changed while the answer was made.
		r.mu.Lock()
		if c.ch != ch {
			sfu.SetRoom(c.idx, r.voiceRoom(c.ch))
		}
		r.mu.Unlock()
		c.ctrl(map[string]any{"t": "rtc-answer", "sdp": ans, "mids": mids})
	case "rtc-ice":
		if m.Candidate != nil && sfu != nil {
			_ = sfu.AddICE(c.idx, *m.Candidate)
		}
	case "boards":
		r.boards(c, m)
	case "channel":
		r.channel(c, m)
	case "settings":
		r.setSettings(c, m)
	case "chat-send", "chat-edit", "chat-delete", "chat-history":
		r.chatOp(c, m)
	case "ping":
		c.ctrl(map[string]any{"t": "pong", "n": m.N})
	}
}

// ---------------------------------------------------------------- writing

// send queues a record for this member. Droppable records (cursors, strokes in progress, the
// speaking lights) are dropped for a member who has fallen behind.
func (c *Conn) send(rec []byte, droppable bool) {
	c.sendPaced(rec, droppable, false)
}

// sendPaced is send, where paced records (cursors) may wait up to ephemeralGap.
func (c *Conn) sendPaced(rec []byte, droppable, paced bool) {
	if c.dead.Load() {
		return
	}
	c.omu.Lock()
	if droppable && len(c.out) > dropAbove {
		c.omu.Unlock()
		Dropped.Add(1)
		return
	}
	if len(c.out) > cutAbove {
		c.omu.Unlock()
		c.dead.Store(true)
		c.t.close()
		return
	}
	c.out = append(c.out, rec...)
	c.omu.Unlock()
	if !paced {
		c.urgent.Store(true)
	}
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *Conn) ctrl(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.send(wire.Append(nil, wire.Ctrl, b), false)
}

// ephemeralGap paces a member's link when it carries only cursors: at most one write a frame. A
// screen shows cursors once a frame anyway, and in a room of 200 it turns tens of thousands of small
// writes a second into a few thousand. Strokes in progress, board records and control messages never
// wait (they take any queued cursors with them), and a link quiet for a frame sends at once.
const ephemeralGap = 16 * time.Millisecond

// writer sends whatever has queued, as one link message or, past wire.MaxMessage, several: a quiet room adds no delay,
// and a busy one batches by itself.
func (c *Conn) writer(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	var spare []byte
	var last time.Time
	pace := time.NewTimer(time.Hour)
	pace.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		}
		if !c.urgent.Load() {
			if wait := ephemeralGap - time.Since(last); wait > 0 {
				pace.Reset(wait)
			paced:
				for {
					select {
					case <-ctx.Done():
						return
					case <-pace.C:
						break paced
					case <-c.wake:
						if c.urgent.Load() {
							if !pace.Stop() {
								<-pace.C
							}
							break paced
						}
					}
				}
			}
		}
		c.urgent.Store(false)
		c.omu.Lock()
		buf := c.out
		c.out = spare[:0]
		c.omu.Unlock()
		if len(buf) == 0 {
			spare = buf
			continue
		}
		for _, msg := range wire.Split(buf, wire.MaxMessage) {
			if err := c.t.write(ctx, msg); err != nil {
				return
			}
			WSBytesOut.Add(uint64(len(msg)))
			WSMsgsOut.Add(1)
		}
		last = time.Now()
		if cap(buf) > 4<<20 {
			buf = nil // don't keep a huge board burst's buffer around
		}
		spare = buf
	}
}
