// Package store keeps a room's boards on the guild server's disk.
//
// The server never parses Yjs. A board is a log of the updates members sent, each with a sequence
// number, replayed to whoever opens it. When a log grows, the server asks one member's client for
// its whole document (a Yjs state update covering every entry up to some seq) and puts that in
// place of those entries. Yjs updates commute and repeat safely, so a snapshot that also holds a
// little more than it claims does no harm.
//
// On disk, per room:
//
//	room.json           the board list and which board is up (written whole, then renamed)
//	boards/<id>.log     "CMB1", then [seq u32][len u32][bytes] records
//	boards/<id>.prev    the log before the latest compaction, one generation
package store

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const magic = "CMB1"

// Compaction thresholds: ask a client for a snapshot past either.
const (
	CompactEntries = 400
	CompactBytes   = 512 << 10
)

// MaxUpdate caps one member update; MaxSnapshot caps a whole board.
const (
	MaxUpdate   = 1 << 20
	MaxSnapshot = 16 << 20
)

// A channel's budget (Security's GDS-6): what its boards' logs may hold together, and how many boards it may have. The
// rate in room/conn.go bounds how fast a member writes, and this bounds how much: a board that's never put up is never
// compacted, so without it a member could fill the guild server's disk at that rate. A board's .prev, the log before
// its latest compaction, holds at most what the log did, so a channel's boards take at most twice ChannelBytes on disk.
// Vars so tests can shorten them.
var (
	ChannelBytes = 256 << 20
	MaxBoards    = 100
)

var (
	ErrNoBoard = errors.New("store: no such board")
	ErrFull    = errors.New("store: the channel's boards are full")
)

// Meta is what the board list shows. Times are Unix milliseconds.
type Meta struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
	By      string `json:"by,omitempty"` // display name of the last editor
	Empty   bool   `json:"empty"`        // the last client to say so found no items on it
	Bytes   int    `json:"bytes"`
}

// Entry is one log record.
type Entry struct {
	Seq  uint32
	Data []byte
}

// Board is one board's log in memory, with its file.
type Board struct {
	Meta    Meta
	Entries []Entry
	Seq     uint32 // last seq handed out
	// SinceSnap counts entries and bytes after the first entry (the latest snapshot, if any).
	SinceSnapN, SinceSnapB int
	CompactAsked           time.Time
	file                   *os.File
	w                      *bufio.Writer
	dirty                  bool
}

type index struct {
	Active string `json:"active"`
	Boards []Meta `json:"boards"`
}

// Room is one room's boards. Not safe for concurrent use: the room hub holds its lock.
type Room struct {
	dir    string
	Active string
	boards map[string]*Board
	dirty  bool
	now    func() time.Time
}

// Open loads a room from dir, creating it with one blank board if it's new.
func Open(dir string) (*Room, error) {
	if err := os.MkdirAll(filepath.Join(dir, "boards"), 0o700); err != nil {
		return nil, err
	}
	r := &Room{dir: dir, boards: map[string]*Board{}, now: time.Now}
	var idx index
	b, err := os.ReadFile(filepath.Join(dir, "room.json"))
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &idx); err != nil {
			return nil, fmt.Errorf("store: room.json: %w", err)
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	for _, m := range idx.Boards {
		bd, err := r.load(m)
		if err != nil {
			return nil, err
		}
		r.boards[m.ID] = bd
	}
	r.Active = idx.Active
	if _, ok := r.boards[r.Active]; !ok {
		if list := r.List(); len(list) > 0 {
			r.Active = list[0].ID
		} else if _, err := r.Create(""); err != nil {
			return nil, err
		}
	}
	return r, r.SaveIndex()
}

func (r *Room) path(id, ext string) string { return filepath.Join(r.dir, "boards", id+ext) }

func (r *Room) load(m Meta) (*Board, error) {
	bd := &Board{Meta: m}
	f, err := os.OpenFile(r.path(m.ID, ".log"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	rd := bufio.NewReader(f)
	head := make([]byte, 4)
	if _, err := io.ReadFull(rd, head); err == nil && string(head) == magic {
		var hdr [8]byte
		for {
			if _, err := io.ReadFull(rd, hdr[:]); err != nil {
				break // a torn last record is dropped
			}
			seq := binary.LittleEndian.Uint32(hdr[:4])
			n := binary.LittleEndian.Uint32(hdr[4:])
			if n > MaxSnapshot {
				break
			}
			data := make([]byte, n)
			if _, err := io.ReadFull(rd, data); err != nil {
				break
			}
			bd.Entries = append(bd.Entries, Entry{Seq: seq, Data: data})
			bd.Seq = seq
		}
	}
	// Rewrite to what was read, so a torn tail doesn't stay on disk.
	if err := r.rewrite(bd, f); err != nil {
		return nil, err
	}
	bd.recount()
	return bd, nil
}

// rewrite replaces bd's file with its entries, keeping the old one as .prev when compacting.
func (r *Room) rewrite(bd *Board, old *os.File) error {
	tmp := r.path(bd.Meta.ID, ".tmp")
	f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 64<<10)
	w.WriteString(magic)
	for _, e := range bd.Entries {
		writeEntry(w, e)
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if old != nil {
		old.Close()
	}
	if bd.file != nil {
		bd.w.Flush()
		bd.file.Close()
		_ = os.Rename(r.path(bd.Meta.ID, ".log"), r.path(bd.Meta.ID, ".prev"))
	}
	if err := os.Rename(tmp, r.path(bd.Meta.ID, ".log")); err != nil {
		f.Close()
		return err
	}
	bd.file, bd.w = f, bufio.NewWriterSize(f, 64<<10)
	return nil
}

func writeEntry(w *bufio.Writer, e Entry) {
	var hdr [8]byte
	binary.LittleEndian.PutUint32(hdr[:4], e.Seq)
	binary.LittleEndian.PutUint32(hdr[4:], uint32(len(e.Data)))
	w.Write(hdr[:])
	w.Write(e.Data)
}

func (bd *Board) recount() {
	bd.SinceSnapN, bd.SinceSnapB, bd.Meta.Bytes = 0, 0, 0
	for i, e := range bd.Entries {
		bd.Meta.Bytes += len(e.Data)
		if i > 0 {
			bd.SinceSnapN++
			bd.SinceSnapB += len(e.Data)
		}
	}
}

// Board returns a board by id.
func (r *Room) Board(id string) (*Board, bool) {
	bd, ok := r.boards[id]
	return bd, ok
}

// List is every board, most recently edited first.
func (r *Room) List() []Meta {
	out := make([]Meta, 0, len(r.boards))
	for _, bd := range r.boards {
		out = append(out, bd.Meta)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Updated != out[j].Updated {
			return out[i].Updated > out[j].Updated
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Bytes is what the channel's boards hold together, by their logs.
func (r *Room) Bytes() int {
	n := 0
	for _, bd := range r.boards {
		n += bd.Meta.Bytes
	}
	return n
}

// Fits says whether n more bytes of updates fit the channel's budget.
func (r *Room) Fits(n int) bool { return r.Bytes()+n <= ChannelBytes }

// Create adds a blank board and puts it up, unless the channel has MaxBoards already.
func (r *Room) Create(name string) (*Board, error) {
	if len(r.boards) >= MaxBoards {
		return nil, ErrFull
	}
	id, err := newID()
	if err != nil {
		return nil, err
	}
	now := r.now().UnixMilli()
	bd := &Board{Meta: Meta{ID: id, Name: cleanName(name), Created: now, Updated: now, Empty: true}}
	if err := r.rewrite(bd, nil); err != nil {
		return nil, err
	}
	r.boards[id] = bd
	r.Active = id
	r.dirty = true
	return bd, nil
}

// Append logs one update to a board and returns its seq.
func (r *Room) Append(bd *Board, data []byte, by string) uint32 {
	bd.Seq++
	e := Entry{Seq: bd.Seq, Data: data}
	bd.Entries = append(bd.Entries, e)
	writeEntry(bd.w, e)
	bd.dirty = true
	if len(bd.Entries) > 1 {
		bd.SinceSnapN++
		bd.SinceSnapB += len(data)
	}
	bd.Meta.Bytes += len(data)
	bd.Meta.Updated = r.now().UnixMilli()
	bd.Meta.By = by
	r.dirty = true
	return bd.Seq
}

// WantsCompaction says whether to ask a client for a snapshot now.
func (r *Room) WantsCompaction(bd *Board) bool {
	if bd.SinceSnapN < CompactEntries && bd.SinceSnapB < CompactBytes {
		return false
	}
	return r.now().Sub(bd.CompactAsked) > 10*time.Second
}

// Compact puts snapshot in place of every entry up to upto. One that would make the board bigger is taken only while
// the channel stays within its budget, so a channel that's full can always shrink.
func (r *Room) Compact(bd *Board, upto uint32, snapshot []byte) error {
	if upto == 0 || upto > bd.Seq {
		return fmt.Errorf("store: snapshot at %d, board at %d", upto, bd.Seq)
	}
	keep := []Entry{{Seq: upto, Data: snapshot}}
	size := len(snapshot)
	for _, e := range bd.Entries {
		if e.Seq > upto {
			keep = append(keep, e)
			size += len(e.Data)
		}
	}
	if size > bd.Meta.Bytes && r.Bytes()-bd.Meta.Bytes+size > ChannelBytes {
		return ErrFull
	}
	bd.Entries = keep
	bd.CompactAsked = time.Time{}
	bd.recount()
	r.dirty = true
	return r.rewrite(bd, nil)
}

// Rename names a board.
func (r *Room) Rename(id, name string) error {
	bd, ok := r.boards[id]
	if !ok {
		return ErrNoBoard
	}
	bd.Meta.Name = cleanName(name)
	r.dirty = true
	return nil
}

// SetEmpty records a client's report that a board has, or hasn't, any items.
func (r *Room) SetEmpty(id string, empty bool) {
	if bd, ok := r.boards[id]; ok && bd.Meta.Empty != empty {
		bd.Meta.Empty = empty
		r.dirty = true
	}
}

// Delete removes a board and its files. The room always keeps one board up.
func (r *Room) Delete(id string) error {
	bd, ok := r.boards[id]
	if !ok {
		return ErrNoBoard
	}
	if bd.file != nil {
		bd.file.Close()
	}
	delete(r.boards, id)
	for _, ext := range []string{".log", ".prev", ".tmp"} {
		_ = os.Remove(r.path(id, ext))
	}
	r.dirty = true
	if r.Active == id {
		if list := r.List(); len(list) > 0 {
			r.Active = list[0].ID
		} else if _, err := r.Create(""); err != nil {
			return err
		}
	}
	return nil
}

// Switch puts another board up. A board left blank and unnamed is dropped as it's left.
func (r *Room) Switch(id string) error {
	if _, ok := r.boards[id]; !ok {
		return ErrNoBoard
	}
	prev := r.Active
	r.Active = id
	r.dirty = true
	if p, ok := r.boards[prev]; ok && prev != id && p.Meta.Name == "" && (p.Meta.Empty || p.Seq == 0) {
		return r.Delete(prev)
	}
	return nil
}

// Flush writes buffered log records and the index. Called on a timer and at shutdown.
func (r *Room) Flush(sync bool) error {
	var first error
	for _, bd := range r.boards {
		if !bd.dirty {
			continue
		}
		if err := bd.w.Flush(); err != nil && first == nil {
			first = err
		}
		if sync {
			bd.file.Sync()
		}
		bd.dirty = false
	}
	if r.dirty {
		if err := r.SaveIndex(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// SaveIndex writes room.json whole and renames it into place.
func (r *Room) SaveIndex() error {
	idx := index{Active: r.Active, Boards: r.List()}
	b, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(r.dir, "room.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(r.dir, "room.json")); err != nil {
		return err
	}
	r.dirty = false
	return nil
}

// Close flushes and closes every file.
func (r *Room) Close() error {
	err := r.Flush(true)
	for _, bd := range r.boards {
		if bd.file != nil {
			bd.file.Close()
		}
	}
	return err
}

func cleanName(s string) string {
	s = strings.TrimSpace(strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f {
			return -1
		}
		return c
	}, s))
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}

func newID() (string, error) { return NewID("b") }

// NewID is a random id: the prefix and ten characters a person can read back.
func NewID(prefix string) (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return prefix + string(b), nil
}
