// Package chat keeps one Commons channel's chat thread on the guild server's disk.
//
// The thread is an append-only log of posts, edits and deletes, each post with a sequence number the server gives it.
// Only an index (about 30 bytes a message) stays in memory; pages are read from the file. An edit or a delete
// overwrites the text it replaces with zero bytes in place, so a deleted or edited message's words don't stay on disk.
//
// On disk, chat.log: "CMC1", then records
//
//	[len u32 LE: bytes after this field][op u8][seq u32][at i64 ms][metaLen u16][meta JSON][textLen u32][text]
package chat

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxText is the most characters a message may hold.
const MaxText = 4000

// PageSize is how many messages a page holds at most.
const PageSize = 100

const magic = "CMC1"

const (
	opPost   = 1
	opEdit   = 2
	opDelete = 3
)

// Errors a member can be told about.
var (
	ErrEmpty     = errors.New("empty")
	ErrTooLong   = errors.New("too-long")
	ErrNoMessage = errors.New("no-message")
	ErrNotYours  = errors.New("not-yours")
)

// Msg is one message as members see it. Times are Unix milliseconds.
type Msg struct {
	Seq    uint32 `json:"seq"`
	From   string `json:"from"` // the author's guild member id
	Name   string `json:"name"` // their name when they posted
	Badge  string `json:"badge,omitempty"`
	Text   string `json:"text"`
	At     int64  `json:"at"`
	Edited int64  `json:"edited,omitempty"`
	Nonce  string `json:"nonce,omitempty"` // only to the author, so their pending copy can settle
}

type meta struct {
	From  string `json:"from,omitempty"`
	Name  string `json:"name,omitempty"`
	Badge string `json:"badge,omitempty"`
	Nonce string `json:"nonce,omitempty"`
	By    string `json:"by,omitempty"`
	Mod   bool   `json:"mod,omitempty"`
}

type entry struct {
	seq     uint32
	post    int64 // offset of the post record
	cur     int64 // offset of the record holding the current text: the post, or the latest edit
	deleted bool
}

type nonceKey struct{ from, nonce string }

// Log is one channel's thread. Not safe for concurrent use: the room holds its lock.
type Log struct {
	path    string
	f       *os.File
	size    int64
	entries []entry // by seq, deleted ones included
	byseq   map[uint32]int
	last    uint32
	nonces  map[nonceKey]uint32
	order   []nonceKey // oldest first, for trimming nonces
	dirty   bool
	now     func() time.Time
}

const keepNonces = 4096

// Open loads a thread, creating it if new. A torn last record is dropped.
func Open(path string) (*Log, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	l := &Log{path: path, f: f, byseq: map[uint32]int{}, nonces: map[nonceKey]uint32{}, now: time.Now}
	if err := l.load(); err != nil {
		f.Close()
		return nil, err
	}
	return l, nil
}

func (l *Log) load() error {
	fi, err := l.f.Stat()
	if err != nil {
		return err
	}
	if fi.Size() < int64(len(magic)) {
		if _, err := l.f.WriteAt([]byte(magic), 0); err != nil {
			return err
		}
		l.size = int64(len(magic))
		return l.f.Truncate(l.size)
	}
	head := make([]byte, len(magic))
	if _, err := l.f.ReadAt(head, 0); err != nil || string(head) != magic {
		return errors.New("chat: not a chat log")
	}
	r := io.NewSectionReader(l.f, 0, fi.Size())
	at := int64(len(magic))
	var lenb [4]byte
	type postAt struct {
		off int64
		seq uint32
	}
	var posts []postAt
	for {
		if _, err := r.ReadAt(lenb[:], at); err != nil {
			break
		}
		n := int64(binary.LittleEndian.Uint32(lenb[:]))
		if n < 19 || n > 1<<20 || at+4+n > fi.Size() {
			break
		}
		rec := make([]byte, n)
		if _, err := r.ReadAt(rec, at+4); err != nil {
			break
		}
		op, seq := rec[0], binary.LittleEndian.Uint32(rec[1:5])
		switch op {
		case opPost:
			l.byseq[seq] = len(l.entries)
			l.entries = append(l.entries, entry{seq: seq, post: at, cur: at})
			l.last = max(l.last, seq)
			posts = append(posts, postAt{at, seq})
		case opEdit:
			if i, ok := l.byseq[seq]; ok {
				l.entries[i].cur = at
			}
		case opDelete:
			if i, ok := l.byseq[seq]; ok {
				l.entries[i].deleted = true
			}
		}
		at += 4 + n
	}
	l.size = at
	if at < fi.Size() {
		if err := l.f.Truncate(at); err != nil {
			return err
		}
	}
	sort.Slice(l.entries, func(i, j int) bool { return l.entries[i].seq < l.entries[j].seq })
	for i, e := range l.entries {
		l.byseq[e.seq] = i
	}
	// The latest posts' nonces, so a client resending a post the server already has gets it back, not a copy.
	if len(posts) > keepNonces {
		posts = posts[len(posts)-keepNonces:]
	}
	for _, p := range posts {
		if _, m, _, _, err := l.read(p.off); err == nil && m.Nonce != "" {
			l.remember(nonceKey{m.From, m.Nonce}, p.seq)
		}
	}
	return nil
}

func (l *Log) remember(k nonceKey, seq uint32) {
	if _, ok := l.nonces[k]; !ok {
		l.order = append(l.order, k)
	}
	l.nonces[k] = seq
	if len(l.order) > keepNonces {
		delete(l.nonces, l.order[0])
		l.order = l.order[1:]
	}
}

// read returns a record's op, meta, text, time, and where its text starts.
func (l *Log) read(off int64) (op byte, m meta, text string, at int64, err error) {
	var lenb [4]byte
	if _, err = l.f.ReadAt(lenb[:], off); err != nil {
		return
	}
	rec := make([]byte, binary.LittleEndian.Uint32(lenb[:]))
	if _, err = l.f.ReadAt(rec, off+4); err != nil {
		return
	}
	op, at = rec[0], int64(binary.LittleEndian.Uint64(rec[5:13]))
	ml := int(binary.LittleEndian.Uint16(rec[13:15]))
	if 15+ml+4 > len(rec) {
		err = errors.New("chat: bad record")
		return
	}
	if ml > 0 {
		_ = json.Unmarshal(rec[15:15+ml], &m)
	}
	tl := int(binary.LittleEndian.Uint32(rec[15+ml:]))
	if 19+ml+tl > len(rec) {
		err = errors.New("chat: bad record")
		return
	}
	text = string(rec[19+ml : 19+ml+tl])
	return
}

// textSpan is where a record's text sits in the file.
func (l *Log) textSpan(off int64) (int64, int, error) {
	var b [19]byte
	if _, err := l.f.ReadAt(b[:], off); err != nil {
		return 0, 0, err
	}
	ml := int64(binary.LittleEndian.Uint16(b[17:19]))
	var tb [4]byte
	if _, err := l.f.ReadAt(tb[:], off+19+ml); err != nil {
		return 0, 0, err
	}
	return off + 23 + ml, int(binary.LittleEndian.Uint32(tb[:])), nil
}

// scrub overwrites the text of the record at off with zero bytes.
func (l *Log) scrub(off int64) error {
	start, n, err := l.textSpan(off)
	if err != nil || n == 0 {
		return err
	}
	_, err = l.f.WriteAt(make([]byte, n), start)
	return err
}

func (l *Log) append(op byte, seq uint32, at int64, m meta, text string) (int64, error) {
	mb := []byte{}
	if m != (meta{}) {
		mb, _ = json.Marshal(m)
	}
	n := 1 + 4 + 8 + 2 + len(mb) + 4 + len(text)
	rec := make([]byte, 4+n)
	binary.LittleEndian.PutUint32(rec[0:], uint32(n))
	rec[4] = op
	binary.LittleEndian.PutUint32(rec[5:], seq)
	binary.LittleEndian.PutUint64(rec[9:], uint64(at))
	binary.LittleEndian.PutUint16(rec[17:], uint16(len(mb)))
	copy(rec[19:], mb)
	binary.LittleEndian.PutUint32(rec[19+len(mb):], uint32(len(text)))
	copy(rec[23+len(mb):], text)
	off := l.size
	if _, err := l.f.WriteAt(rec, off); err != nil {
		return 0, err
	}
	l.size += int64(len(rec))
	l.dirty = true
	return off, nil
}

// Clean checks and tidies a message's text: no control characters but newlines and tabs, trimmed, at most MaxText
// characters.
func Clean(s string) (string, error) {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	s = strings.Map(func(c rune) rune {
		if (c < 0x20 && c != '\n' && c != '\t') || c == 0x7f {
			return -1
		}
		return c
	}, s)
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r", ""))
	if s == "" {
		return "", ErrEmpty
	}
	if utf8.RuneCountInString(s) > MaxText {
		return "", ErrTooLong
	}
	return s, nil
}

// Post adds a message. If this author already posted with this nonce, it returns that message and false.
func (l *Log) Post(from, name, badge, nonce, text string) (Msg, bool, error) {
	text, err := Clean(text)
	if err != nil {
		return Msg{}, false, err
	}
	if len(nonce) > 64 {
		nonce = nonce[:64]
	}
	if nonce != "" {
		if seq, ok := l.nonces[nonceKey{from, nonce}]; ok {
			m, err := l.Get(seq)
			if err == nil {
				m.Nonce = nonce
			}
			return m, false, err
		}
	}
	seq := l.last + 1
	at := l.now().UnixMilli()
	off, err := l.append(opPost, seq, at, meta{From: from, Name: name, Badge: badge, Nonce: nonce}, text)
	if err != nil {
		return Msg{}, false, err
	}
	l.last = seq
	l.byseq[seq] = len(l.entries)
	l.entries = append(l.entries, entry{seq: seq, post: off, cur: off})
	if nonce != "" {
		l.remember(nonceKey{from, nonce}, seq)
	}
	return Msg{Seq: seq, From: from, Name: name, Badge: badge, Text: text, At: at, Nonce: nonce}, true, nil
}

// Get returns one message as it stands.
func (l *Log) Get(seq uint32) (Msg, error) {
	i, ok := l.byseq[seq]
	if !ok || l.entries[i].deleted {
		return Msg{}, ErrNoMessage
	}
	e := l.entries[i]
	_, m, text, at, err := l.read(e.post)
	if err != nil {
		return Msg{}, err
	}
	msg := Msg{Seq: seq, From: m.From, Name: m.Name, Badge: m.Badge, Text: text, At: at}
	if e.cur != e.post {
		_, _, text, edited, err := l.read(e.cur)
		if err != nil {
			return Msg{}, err
		}
		msg.Text, msg.Edited = text, edited
	}
	return msg, nil
}

// Author is who posted a message.
func (l *Log) Author(seq uint32) (string, error) {
	i, ok := l.byseq[seq]
	if !ok || l.entries[i].deleted {
		return "", ErrNoMessage
	}
	_, m, _, _, err := l.read(l.entries[i].post)
	return m.From, err
}

// Edit replaces the text of the author's own message, and wipes the old text from the file.
func (l *Log) Edit(seq uint32, from, text string) (Msg, error) {
	author, err := l.Author(seq)
	if err != nil {
		return Msg{}, err
	}
	if author != from {
		return Msg{}, ErrNotYours
	}
	text, err = Clean(text)
	if err != nil {
		return Msg{}, err
	}
	i := l.byseq[seq]
	prev := l.entries[i].cur
	off, err := l.append(opEdit, seq, l.now().UnixMilli(), meta{}, text)
	if err != nil {
		return Msg{}, err
	}
	l.entries[i].cur = off
	if err := l.scrub(prev); err != nil {
		return Msg{}, err
	}
	return l.Get(seq)
}

// Delete removes a message, wiping its text (and any earlier versions) from the file. mod marks a moderator's
// delete of someone else's message.
func (l *Log) Delete(seq uint32, by string, mod bool) error {
	i, ok := l.byseq[seq]
	if !ok || l.entries[i].deleted {
		return ErrNoMessage
	}
	e := l.entries[i]
	if _, err := l.append(opDelete, seq, l.now().UnixMilli(), meta{By: by, Mod: mod}, ""); err != nil {
		return err
	}
	l.entries[i].deleted = true
	if err := l.scrub(e.post); err != nil {
		return err
	}
	if e.cur != e.post {
		return l.scrub(e.cur)
	}
	return nil
}

// Page returns up to limit messages before seq `before` (0: the latest), oldest first, and whether there are older.
func (l *Log) Page(before uint32, limit int) ([]Msg, bool) {
	if limit < 1 || limit > PageSize {
		limit = PageSize
	}
	end := len(l.entries)
	if before > 0 {
		end = sort.Search(len(l.entries), func(i int) bool { return l.entries[i].seq >= before })
	}
	var out []Msg
	i := end - 1
	for ; i >= 0 && len(out) < limit; i-- {
		if l.entries[i].deleted {
			continue
		}
		if m, err := l.Get(l.entries[i].seq); err == nil {
			out = append(out, m)
		}
	}
	more := false
	for ; i >= 0; i-- {
		if !l.entries[i].deleted {
			more = true
			break
		}
	}
	for a, b := 0, len(out)-1; a < b; a, b = a+1, b-1 {
		out[a], out[b] = out[b], out[a]
	}
	return out, more
}

// Last is the newest seq handed out.
func (l *Log) Last() uint32 { return l.last }

// Count is how many messages stand (not deleted).
func (l *Log) Count() int {
	n := 0
	for _, e := range l.entries {
		if !e.deleted {
			n++
		}
	}
	return n
}

// Flush syncs the file if it changed. Writes go straight to the file, so a crash loses at most what the kernel
// hadn't written; sync makes it durable.
func (l *Log) Flush(sync bool) error {
	if !l.dirty || !sync {
		return nil
	}
	l.dirty = false
	return l.f.Sync()
}

// Close syncs and closes the file.
func (l *Log) Close() error {
	_ = l.f.Sync()
	return l.f.Close()
}
