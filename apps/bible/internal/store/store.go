// Package store keeps the members' marks and prefs in the app's data folder (API.md, "On disk"): a journal of JSON
// lines, appended and synced before each reply, and a state file replaced whole when the journal grows. A kill at any
// moment leaves the old or the new data, and a torn last line is dropped.
//
// Data is kept per caller (API.md, "Guild Desks"): the owner's bucket on a member's own desk, or one bucket per
// member pseudonym on a Guild Desk. One caller never sees, counts or changes another's. Memory holds a small index of
// each mark; a note's words and every kept idem reply stay on disk, where they're read back when asked for, so a desk
// with many members stays small.
package store

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
)

const (
	Version = 1
	// Per caller.
	MaxMarks = 20_000
	MaxBytes = 8 << 20
	// For the whole desk, whatever the number of members: memory (marks) and disk (bytes).
	DeskMaxMarks = 30_000
	DeskMaxBytes = 32 << 20
	MaxLabel     = 80
	MaxNote      = 10_000

	// Owner is the bucket of a member's own desk; Desk holds deskd's own calls' idem keys.
	Owner = "owner"
	Desk  = "desk"

	stateFile   = "state.jsonl"
	journalFile = "journal.jsonl"

	compactFloor = 64 << 10
	compactCap   = 4 << 20
	idemKeep     = 1000
	idemMax      = 10_000
	idemDeskMax  = 10_000
	idemAge      = 24 * time.Hour
	timeFormat   = "2006-01-02T15:04:05.000Z"
)

var (
	ErrFull        = errors.New("full")
	ErrNewerFormat = errors.New("data written by a newer version of the app")
	ErrDisk        = errors.New("couldn't write the data")
	ErrIdem        = errors.New("idem key used for another method")
)

// Invalid is a param that's wrong: bad_request with Reason.
type Invalid struct{ Reason string }

func (e *Invalid) Error() string { return "bad " + e.Reason }

// NotFound is a mark that isn't there.
type NotFound struct{ Reason string }

func (e *NotFound) Error() string { return "no such " + e.Reason }

// Mark is a bookmark, highlight or note as the API and the files have it (API.md, "Data shapes").
type Mark struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Book        string `json:"book"`
	Chapter     int    `json:"chapter"`
	Verse       int    `json:"verse"`
	VerseEnd    int    `json:"verseEnd,omitempty"`
	Translation string `json:"translation,omitempty"`
	Label       string `json:"label,omitempty"`
	Color       string `json:"color,omitempty"`
	Text        string `json:"text,omitempty"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// Place is where the member is reading: the verse at the top of the column.
type Place struct {
	Translation string `json:"translation"`
	Book        string `json:"book"`
	Chapter     int    `json:"chapter"`
	Verse       int    `json:"verse"`
}

// Prefs are the window's settings and place.
type Prefs struct {
	TextSize        int    `json:"textSize"`
	OneVersePerLine bool   `json:"oneVersePerLine"`
	Footnotes       bool   `json:"footnotes"`
	HighlightColor  string `json:"highlightColor"`
	Place           *Place `json:"place"`
}

// DefaultPrefs are a new member's.
func DefaultPrefs() Prefs {
	return Prefs{TextSize: 18, Footnotes: true, HighlightColor: "amber"}
}

var textSizes = map[int]bool{16: true, 18: true, 20: true, 22: true, 24: true}

var kinds = []string{"bookmark", "highlight", "note"}

const (
	kindBookmark = iota
	kindHighlight
	kindNote
)

func kindIndex(k string) int {
	for i, x := range kinds {
		if x == k {
			return i
		}
	}
	return -1
}

// Options are for tests; zero values take the API's limits.
type Options struct {
	MaxMarks     int
	MaxBytes     int64
	DeskMaxMarks int
	DeskMaxBytes int64
	Now          func() time.Time
	Translations func(code string) bool // whether a place may name it; nil allows the four
}

// where a line is on disk: a note's words or a kept reply are read back from it.
type where struct {
	off  int64
	n    int32
	file uint8 // fileState or fileJournal
}

const (
	fileState = iota + 1
	fileJournal
)

// mem is a mark in memory: about 80 bytes, with a note's words left on disk.
type mem struct {
	id                  [12]byte
	created, updated    int64 // Unix milliseconds
	label               string
	body                where // a note's line
	size                int32 // the mark's stored line, counted against the caps
	kind, book          uint8
	chapter, verse      uint8
	verseEnd, color, tr uint8 // color and tr: 1 + the index in canon's lists, 0 for none
}

func (m *mem) last() int {
	if m.verseEnd > 0 {
		return int(m.verseEnd)
	}
	return int(m.verse)
}

func chapKey(book, chapter int) uint16 { return uint16(book)<<8 | uint16(chapter) }
func verseKey(book, ch, v int) uint32  { return uint32(book)<<16 | uint32(ch)<<8 | uint32(v) }
func (m *mem) chapKey() uint16         { return chapKey(int(m.book), int(m.chapter)) }
func (m *mem) verseKey() uint32        { return verseKey(int(m.book), int(m.chapter), int(m.verse)) }
func idString(id [12]byte) string      { return "m" + hex.EncodeToString(id[:]) }
func msString(ms int64) string         { return time.UnixMilli(ms).UTC().Format(timeFormat) }
func indexOf(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

func parseID(s string) ([12]byte, bool) {
	var id [12]byte
	if len(s) != 25 || s[0] != 'm' {
		return id, false
	}
	_, err := hex.Decode(id[:], []byte(s[1:]))
	return id, err == nil
}

// toMem makes a mark's index from its full form; ok is false for one that can't be read.
func toMem(m *Mark) (*mem, bool) {
	id, ok := parseID(m.ID)
	bi, bok := canon.Index(m.Book)
	k := kindIndex(m.Kind)
	if !ok || !bok || k < 0 || m.Chapter < 1 || m.Chapter > 255 || m.Verse < 1 || m.Verse > 255 || m.VerseEnd < 0 || m.VerseEnd > 255 {
		return nil, false
	}
	c, _ := time.Parse(timeFormat, m.CreatedAt)
	u, _ := time.Parse(timeFormat, m.UpdatedAt)
	x := &mem{id: id, created: c.UnixMilli(), updated: u.UnixMilli(), kind: uint8(k), book: uint8(bi), chapter: uint8(m.Chapter),
		verse: uint8(m.Verse), verseEnd: uint8(m.VerseEnd), color: uint8(indexOf(canon.Colors, m.Color) + 1),
		tr: uint8(indexOf(canon.Translations, m.Translation) + 1), size: int32(lineSize(m))}
	if k == kindBookmark {
		x.label = m.Label
	}
	return x, true
}

// toMark is the full form, with text the note's words if it's a note.
func (m *mem) toMark(text string) Mark {
	out := Mark{ID: idString(m.id), Kind: kinds[m.kind], Book: canon.Books[m.book].ID, Chapter: int(m.chapter), Verse: int(m.verse),
		VerseEnd: int(m.verseEnd), Label: m.label, CreatedAt: msString(m.created), UpdatedAt: msString(m.updated)}
	if m.color > 0 {
		out.Color = canon.Colors[m.color-1]
	}
	if m.tr > 0 {
		out.Translation = canon.Translations[m.tr-1]
	}
	if m.kind == kindNote {
		out.Text = text
	}
	return out
}

type idemRec struct {
	key string
	m   string
	at  int64
	res where // the reply's line on disk
}

// bucket is one caller's data.
type bucket struct {
	key         string
	marks       map[[12]byte]*mem
	byChapter   map[uint16][]*mem
	bookmarkAt  map[uint32]*mem
	highlightAt map[uint32]*mem
	prefs       Prefs
	prefsSize   int
	live        int64 // marks and prefs, as stored
	rev         uint64
	idem        map[string]*idemRec
	idemOrder   []*idemRec
}

func newBucket(key string) *bucket {
	b := &bucket{key: key, marks: map[[12]byte]*mem{}, byChapter: map[uint16][]*mem{}, bookmarkAt: map[uint32]*mem{},
		highlightAt: map[uint32]*mem{}, idem: map[string]*idemRec{}}
	b.setPrefs(DefaultPrefs())
	return b
}

// Store is every caller's data, in memory and on disk.
type Store struct {
	dir string
	opt Options

	mu          sync.Mutex
	buckets     map[string]*bucket
	totalMarks  int
	totalLive   int64
	totalIdem   int
	idemBytes   int64 // the kept replies' size on disk, for compaction
	seq         uint64
	journal     *os.File
	journalSize int64
	dropped     bool // a retain was replayed at load: its members' lines may still be in the files
	stale       bool // the journal has lines the state already holds: a compaction a kill cut short
	noPurge     bool // tests: stop where a kill after a retain's journal entry would
}

// entry is one journal line: what a mutation changed, and the reply it got.
type entry struct {
	Seq    uint64          `json:"seq"`
	At     string          `json:"at"`
	M      string          `json:"m"`
	Caller string          `json:"caller"`
	Idem   string          `json:"idem,omitempty"`
	Rev    uint64          `json:"rev,omitempty"`
	Put    []*Mark         `json:"put,omitempty"`
	Remove []string        `json:"remove,omitempty"`
	Prefs  *Prefs          `json:"prefs,omitempty"`
	Drop   []string        `json:"drop,omitempty"`
	Res    json.RawMessage `json:"res"`
}

type header struct {
	Format  string `json:"format"`
	Version int    `json:"version"`
	Seq     uint64 `json:"seq,omitempty"`
	SavedAt string `json:"savedAt,omitempty"`
}

type idemLine struct {
	Key string          `json:"key"`
	M   string          `json:"m"`
	At  string          `json:"at"`
	Res json.RawMessage `json:"res"`
}

type stateLine struct {
	Caller string    `json:"caller"`
	Rev    *uint64   `json:"rev,omitempty"`
	Mark   *Mark     `json:"mark,omitempty"`
	Prefs  *Prefs    `json:"prefs,omitempty"`
	Idem   *idemLine `json:"idem,omitempty"`
}

// CheckFormat reads only the files' headers: ErrNewerFormat if either was written by a newer version. It's quick,
// so the app runs it before it answers HELLO.
func CheckFormat(dir string) error {
	for _, name := range []string{stateFile, journalFile} {
		f, err := openFile(filepath.Join(dir, name), os.O_RDONLY, 0)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		line, _ := bufio.NewReader(f).ReadBytes('\n')
		f.Close()
		var h header
		if json.Unmarshal(line, &h) == nil && h.Version > Version {
			return ErrNewerFormat
		}
	}
	return nil
}

// Open loads the data in dir, making the folder and an empty journal if there are none.
func Open(dir string, opt Options) (*Store, error) {
	if opt.MaxMarks == 0 {
		opt.MaxMarks = MaxMarks
	}
	if opt.MaxBytes == 0 {
		opt.MaxBytes = MaxBytes
	}
	if opt.DeskMaxMarks == 0 {
		opt.DeskMaxMarks = DeskMaxMarks
	}
	if opt.DeskMaxBytes == 0 {
		opt.DeskMaxBytes = DeskMaxBytes
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	s := &Store{dir: dir, opt: opt, buckets: map[string]*bucket{}}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := CheckFormat(dir); err != nil {
		return nil, err
	}
	for _, tmp := range []string{stateFile + ".tmp", journalFile + ".tmp"} {
		_ = os.Remove(filepath.Join(dir, tmp)) // a write a kill cut short; the file it would have replaced is whole
	}
	if err := s.loadState(); err != nil {
		return nil, err
	}
	if err := s.loadJournal(); err != nil {
		return nil, err
	}
	for _, b := range s.buckets {
		s.pruneIdem(b)
	}
	s.pruneDeskIdem()
	if s.dropped || s.stale {
		// A retain or a compaction a kill cut short: lines nothing reads, a removed member's among them, may still be
		// in the files. Finish it.
		s.dropped, s.stale = false, false
		if err := s.compactLocked(); err != nil {
			log.Printf("compaction at start: %v", err)
		}
	}
	return s, nil
}

// Close lets go of the journal. Every reply's change is already on disk.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.journal == nil {
		return nil
	}
	err := s.journal.Close()
	s.journal = nil
	return err
}

func (s *Store) bucket(key string) *bucket {
	b := s.buckets[key]
	if b == nil {
		b = newBucket(key)
		s.buckets[key] = b
		s.totalLive += int64(b.prefsSize)
	}
	return b
}

func (s *Store) loadState() error {
	f, err := openFile(filepath.Join(s.dir, stateFile), os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 256<<10)
	first := true
	var off int64
	for n := 1; ; n++ {
		line, err := r.ReadBytes('\n')
		at := where{off: off, n: int32(len(line)), file: fileState}
		off += int64(len(line))
		if len(bytes.TrimSpace(line)) > 0 {
			if first {
				var h header
				if json.Unmarshal(line, &h) != nil || h.Format != "ma-bible-state" {
					return fmt.Errorf("%s: no header", stateFile)
				}
				s.seq, first = h.Seq, false
			} else {
				var l stateLine
				if json.Unmarshal(line, &l) != nil || l.Caller == "" {
					log.Printf("%s line %d doesn't parse; skipped", stateFile, n)
				} else {
					b := s.bucket(l.Caller)
					switch {
					case l.Rev != nil:
						b.rev = *l.Rev
					case l.Mark != nil:
						if m, ok := toMem(l.Mark); ok {
							m.body = at
							s.putLocked(b, m)
						}
					case l.Prefs != nil:
						s.setPrefs(b, fixPrefs(*l.Prefs))
					case l.Idem != nil:
						s.addIdem(b, l.Idem.Key, l.Idem.M, l.Idem.At, at, len(l.Idem.Res))
					}
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (s *Store) loadJournal() error {
	path := filepath.Join(s.dir, journalFile)
	b, err := readFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s.newJournal()
	}
	if err != nil {
		return err
	}
	good := 0 // the end of the last whole line
	for pos, n := 0, 1; pos < len(b); n++ {
		end := bytes.IndexByte(b[pos:], '\n')
		if end < 0 {
			log.Printf("%s: a last line without its end, from a write a kill cut short; dropped", journalFile)
			break
		}
		line := b[pos : pos+end]
		next := pos + end + 1
		if n == 1 {
			var h header
			if json.Unmarshal(line, &h) != nil || h.Format != "ma-bible-journal" {
				return fmt.Errorf("%s: no header", journalFile)
			}
		} else if len(bytes.TrimSpace(line)) > 0 {
			var e entry
			if err := json.Unmarshal(line, &e); err != nil || e.Caller == "" {
				if next >= len(b) {
					log.Printf("%s: a last line that doesn't parse; dropped", journalFile)
					break
				}
				log.Printf("%s line %d doesn't parse; skipped", journalFile, n)
			} else if e.Seq > s.seq {
				s.applyLocked(&e, where{off: int64(pos), n: int32(next - pos), file: fileJournal})
			} else {
				s.stale = true
			}
		}
		pos, good = next, next
	}
	if good == 0 {
		return s.newJournal()
	}
	f, err := openFile(path, os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if good < len(b) {
		if err := f.Truncate(int64(good)); err != nil {
			f.Close()
			return err
		}
		_ = f.Sync()
	}
	if _, err := f.Seek(int64(good), io.SeekStart); err != nil {
		f.Close()
		return err
	}
	s.journal, s.journalSize = f, int64(good)
	return nil
}

// newJournal replaces the journal with an empty one, atomically.
func (s *Store) newJournal() error {
	h, _ := json.Marshal(header{Format: "ma-bible-journal", Version: Version})
	h = append(h, '\n')
	path := filepath.Join(s.dir, journalFile)
	if err := writeAtomic(path, func(w io.Writer) error { _, err := w.Write(h); return err }); err != nil {
		return err
	}
	f, err := openFile(path, os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return err
	}
	if s.journal != nil {
		s.journal.Close()
	}
	s.journal, s.journalSize = f, int64(len(h))
	return nil
}

// writeAtomic writes path.tmp, syncs it, renames it over path and syncs the folder.
func writeAtomic(path string, fill func(io.Writer) error) error {
	tmp := path + ".tmp"
	f, err := openFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 256<<10)
	err = fill(w)
	if err == nil {
		err = w.Flush()
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(filepath.Dir(path))
}

// openFile never follows a link: the data folder is the app's own, and a link in it is refused (ELOOP).
func openFile(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag|syscall.O_NOFOLLOW, perm)
}

func readFile(path string) ([]byte, error) {
	f, err := openFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// ---- reading lines back

// lines reads lines back from the two files, opening each once.
type lines struct {
	dir   string
	files [3]*os.File
}

func (l *lines) close() {
	for _, f := range l.files {
		if f != nil {
			f.Close()
		}
	}
}

func (l *lines) read(w where) ([]byte, error) {
	if w.file != fileState && w.file != fileJournal {
		return nil, errors.New("nowhere")
	}
	if l.files[w.file] == nil {
		name := stateFile
		if w.file == fileJournal {
			name = journalFile
		}
		f, err := openFile(filepath.Join(l.dir, name), os.O_RDONLY, 0)
		if err != nil {
			return nil, err
		}
		l.files[w.file] = f
	}
	buf := make([]byte, w.n)
	if _, err := l.files[w.file].ReadAt(buf, w.off); err != nil {
		return nil, err
	}
	return buf, nil
}

// body reads a note's words back from its line.
func (l *lines) body(m *mem) (string, error) {
	line, err := l.read(m.body)
	if err != nil {
		return "", err
	}
	id := idString(m.id)
	if m.body.file == fileJournal {
		var e entry
		if err := json.Unmarshal(line, &e); err == nil {
			for _, x := range e.Put {
				if x != nil && x.ID == id {
					return x.Text, nil
				}
			}
		}
	} else {
		var sl stateLine
		if err := json.Unmarshal(line, &sl); err == nil && sl.Mark != nil && sl.Mark.ID == id {
			return sl.Mark.Text, nil
		}
	}
	return "", fmt.Errorf("a note's words aren't where they were")
}

// reply reads a kept key's reply back from its line.
func (l *lines) reply(r *idemRec) (json.RawMessage, error) {
	line, err := l.read(r.res)
	if err != nil {
		return nil, err
	}
	if r.res.file == fileJournal {
		var e entry
		if err := json.Unmarshal(line, &e); err == nil && e.Idem == r.key && len(e.Res) > 0 {
			return e.Res, nil
		}
	} else {
		var sl stateLine
		if err := json.Unmarshal(line, &sl); err == nil && sl.Idem != nil && sl.Idem.Key == r.key && len(sl.Idem.Res) > 0 {
			return sl.Idem.Res, nil
		}
	}
	return nil, fmt.Errorf("the reply for a kept key isn't where it was")
}

// ---- in memory

func (b *bucket) setPrefs(p Prefs) int64 {
	line, _ := json.Marshal(stateLine{Caller: b.key, Prefs: &p})
	delta := int64(len(line)+1) - int64(b.prefsSize)
	b.live += delta
	b.prefs, b.prefsSize = p, len(line)+1
	return delta
}

func (s *Store) setPrefs(b *bucket, p Prefs) {
	s.totalLive += b.setPrefs(p)
}

func lineSize(m *Mark) int {
	b, _ := json.Marshal(stateLine{Caller: "p-0123456789012345678901", Mark: m}) // a member's key, the longest
	return len(b) + 1
}

func (s *Store) putLocked(b *bucket, m *mem) {
	if b.marks[m.id] != nil {
		s.removeLocked(b, m.id)
	}
	b.marks[m.id] = m
	b.live += int64(m.size)
	s.totalMarks++
	s.totalLive += int64(m.size)
	ck := m.chapKey()
	b.byChapter[ck] = append(b.byChapter[ck], m)
	switch m.kind {
	case kindBookmark:
		b.bookmarkAt[m.verseKey()] = m
	case kindHighlight:
		b.highlightAt[m.verseKey()] = m
	}
}

func (s *Store) removeLocked(b *bucket, id [12]byte) {
	m := b.marks[id]
	if m == nil {
		return
	}
	delete(b.marks, id)
	b.live -= int64(m.size)
	s.totalMarks--
	s.totalLive -= int64(m.size)
	ck := m.chapKey()
	list := b.byChapter[ck]
	for i, x := range list {
		if x == m {
			list[i] = list[len(list)-1]
			list = list[:len(list)-1]
			break
		}
	}
	if len(list) == 0 {
		delete(b.byChapter, ck)
	} else {
		b.byChapter[ck] = list
	}
	vk := m.verseKey()
	if m.kind == kindBookmark && b.bookmarkAt[vk] == m {
		delete(b.bookmarkAt, vk)
	}
	if m.kind == kindHighlight && b.highlightAt[vk] == m {
		delete(b.highlightAt, vk)
	}
}

func (s *Store) dropBucket(key string) bool {
	b := s.buckets[key]
	if b == nil {
		return false
	}
	s.totalMarks -= len(b.marks)
	s.totalLive -= b.live
	s.totalIdem -= len(b.idemOrder)
	delete(s.buckets, key)
	return true
}

func (s *Store) applyLocked(e *entry, at where) {
	for _, key := range e.Drop {
		if s.dropBucket(key) {
			s.dropped = true
		}
	}
	if len(e.Put) > 0 || len(e.Remove) > 0 || e.Prefs != nil || e.Idem != "" || e.Rev > 0 {
		b := s.bucket(e.Caller)
		for _, id := range e.Remove {
			if x, ok := parseID(id); ok {
				s.removeLocked(b, x)
			}
		}
		for _, mk := range e.Put {
			if mk == nil {
				continue
			}
			if m, ok := toMem(mk); ok {
				m.body = at
				s.putLocked(b, m)
			}
		}
		if e.Prefs != nil {
			s.setPrefs(b, fixPrefs(*e.Prefs))
		}
		if e.Rev > b.rev {
			b.rev = e.Rev
		}
		if e.Idem != "" {
			s.addIdem(b, e.Idem, e.M, e.At, at, len(e.Res))
		}
	}
	s.seq = e.Seq
}

// fixPrefs fills what an older or damaged line leaves out with the defaults.
func fixPrefs(p Prefs) Prefs {
	d := DefaultPrefs()
	if !textSizes[p.TextSize] {
		p.TextSize = d.TextSize
	}
	if !canon.ValidColor(p.HighlightColor) {
		p.HighlightColor = d.HighlightColor
	}
	return p
}

var methods = func() map[string]string {
	m := map[string]string{}
	for _, x := range []string{"bible.mark.put", "bible.mark.remove", "bible.highlight.clear", "bible.prefs.set", "app.members.retain"} {
		m[x] = x
	}
	return m
}()

// intern keeps one copy of each method name across every kept key.
func intern(m string) string {
	if v, ok := methods[m]; ok {
		return v
	}
	return m
}

func (s *Store) addIdem(b *bucket, key, method, at string, res where, size int) {
	if key == "" || b.idem[key] != nil {
		return
	}
	t, _ := time.Parse(timeFormat, at)
	r := &idemRec{key: key, m: intern(method), at: t.UnixMilli(), res: res}
	b.idem[key] = r
	b.idemOrder = append(b.idemOrder, r)
	s.totalIdem++
	s.idemBytes += int64(size)
}

// pruneIdem drops a caller's key once it's over 24 hours old and not among their newest 1,000, and keeps at most
// 10,000 of theirs.
func (s *Store) pruneIdem(b *bucket) {
	now := s.opt.Now().UnixMilli()
	drop := 0
	for drop < len(b.idemOrder) {
		left := len(b.idemOrder) - drop
		r := b.idemOrder[drop]
		if left > idemMax || (left > idemKeep && now-r.at > idemAge.Milliseconds()) {
			delete(b.idem, r.key)
			drop++
			continue
		}
		break
	}
	if drop > 0 {
		b.idemOrder = append([]*idemRec(nil), b.idemOrder[drop:]...)
		s.totalIdem -= drop
	}
}

// pruneDeskIdem keeps at most 10,000 keys on the whole desk, dropping the oldest first, whoever's they are.
func (s *Store) pruneDeskIdem() {
	for s.totalIdem > idemDeskMax {
		var oldest *bucket
		for _, b := range s.buckets {
			if len(b.idemOrder) > 0 && (oldest == nil || b.idemOrder[0].at < oldest.idemOrder[0].at) {
				oldest = b
			}
		}
		if oldest == nil {
			return
		}
		delete(oldest.idem, oldest.idemOrder[0].key)
		oldest.idemOrder = oldest.idemOrder[1:]
		s.totalIdem--
	}
}

// ---- reads

// Rev is a caller's marks' revision: it grows on every change to any of their marks.
func (s *Store) Rev(caller string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.buckets[caller]; b != nil {
		return b.rev
	}
	return 0
}

// Prefs returns a caller's prefs.
func (s *Store) Prefs(caller string) Prefs {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buckets[caller]
	if b == nil {
		return DefaultPrefs()
	}
	p := b.prefs
	if p.Place != nil {
		pl := *p.Place
		p.Place = &pl
	}
	return p
}

// Count is how many marks a caller has, and their stored size.
func (s *Store) Count(caller string) (int, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.buckets[caller]; b != nil {
		return len(b.marks), b.live
	}
	return 0, 0
}

// Totals is the whole desk's marks, their stored size, and the callers with data.
func (s *Store) Totals() (marks int, bytes int64, callers []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.buckets {
		callers = append(callers, k)
	}
	sort.Strings(callers)
	return s.totalMarks, s.totalLive, callers
}

func canonLess(a, b *mem) bool {
	switch {
	case a.book != b.book:
		return a.book < b.book
	case a.chapter != b.chapter:
		return a.chapter < b.chapter
	case a.verse != b.verse:
		return a.verse < b.verse
	case a.verseEnd != b.verseEnd:
		return a.verseEnd < b.verseEnd
	case a.kind != b.kind:
		return a.kind < b.kind
	case a.created != b.created:
		return a.created < b.created
	}
	return bytes.Compare(a.id[:], b.id[:]) < 0
}

func recentLess(a, b *mem) bool {
	if a.updated != b.updated {
		return a.updated > b.updated
	}
	return bytes.Compare(a.id[:], b.id[:]) > 0
}

// full makes marks' full forms, reading notes' words back from disk.
func (s *Store) full(ms []*mem) ([]Mark, error) {
	l := &lines{dir: s.dir}
	defer l.close()
	out := make([]Mark, len(ms))
	for i, m := range ms {
		text := ""
		if m.kind == kindNote {
			var err error
			if text, err = l.body(m); err != nil {
				return nil, err
			}
		}
		out[i] = m.toMark(text)
	}
	return out, nil
}

// Chapter returns a caller's marks in a chapter, in reading order.
func (s *Store) Chapter(caller, book string, chapter int) ([]Mark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bi, ok := canon.Index(book)
	b := s.buckets[caller]
	if !ok || b == nil {
		return []Mark{}, nil
	}
	ms := append([]*mem(nil), b.byChapter[chapKey(bi, chapter)]...)
	sort.Slice(ms, func(i, j int) bool { return canonLess(ms[i], ms[j]) })
	return s.full(ms)
}

// Cursor is where a list page ended: the last mark's sort fields, so a page never shifts when marks change.
type Cursor struct {
	Order string   `json:"o"`
	Kind  string   `json:"k"`
	Pos   [7]int64 `json:"p"` // book, chapter, verse, verseEnd, kind, created, updated
	ID    string   `json:"i"`
}

func cursorOf(order, kind string, m *mem) *Cursor {
	return &Cursor{Order: order, Kind: kind, ID: idString(m.id),
		Pos: [7]int64{int64(m.book), int64(m.chapter), int64(m.verse), int64(m.verseEnd), int64(m.kind), m.created, m.updated}}
}

func (c *Cursor) mem() (*mem, bool) {
	id, ok := parseID(c.ID)
	p := c.Pos
	for _, v := range p[:5] {
		if v < 0 || v > 255 {
			return nil, false
		}
	}
	return &mem{id: id, book: uint8(p[0]), chapter: uint8(p[1]), verse: uint8(p[2]), verseEnd: uint8(p[3]), kind: uint8(p[4]),
		created: p[5], updated: p[6]}, ok
}

// List returns one page of a caller's marks: kind "" for all, order "canon" or "recent".
func (s *Store) List(caller, kind, order string, after *Cursor, limit int) (marks []Mark, total int, next *Cursor, err error) {
	less := canonLess
	if order == "recent" {
		less = recentLess
	}
	k := kindIndex(kind)
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buckets[caller]
	if b == nil {
		return []Mark{}, 0, nil, nil
	}
	var from *mem
	if after != nil {
		var ok bool
		if from, ok = after.mem(); !ok {
			return nil, 0, nil, &Invalid{"cursor"}
		}
	}
	ms := make([]*mem, 0, len(b.marks))
	for _, m := range b.marks {
		if kind != "" && int(m.kind) != k {
			continue
		}
		total++
		if from == nil || less(from, m) {
			ms = append(ms, m)
		}
	}
	sort.Slice(ms, func(i, j int) bool { return less(ms[i], ms[j]) })
	if len(ms) > limit {
		next = cursorOf(order, kind, ms[limit-1])
		ms = ms[:limit]
	}
	marks, err = s.full(ms)
	return marks, total, next, err
}

// ---- mutations

// change is what one mutation does, before it's applied.
type change struct {
	put    []*Mark
	remove []string
	prefs  *Prefs
	drop   []string
}

func (s *Store) now() string { return s.opt.Now().UTC().Format(timeFormat) }

func newID(now time.Time) string {
	var b [12]byte
	ms := uint64(now.UnixMilli())
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	_, _ = rand.Read(b[6:])
	return idString(b)
}

// mutate runs one mutation for a caller: the same idem key replays its first reply; otherwise f decides the change
// from the caller's bucket (nil if they have no data yet), the caps are checked, the journal entry is synced, and only
// then does memory change.
func (s *Store) mutate(caller, method, idem string, f func(b *bucket) (change, any, error)) (res json.RawMessage, marksChanged bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buckets[caller]
	if idem != "" && b != nil {
		if r := b.idem[idem]; r != nil {
			if r.m != method {
				return nil, false, ErrIdem
			}
			l := &lines{dir: s.dir}
			defer l.close()
			res, err := l.reply(r)
			if err != nil {
				log.Printf("replay: %v", err)
				return nil, false, ErrDisk
			}
			return res, false, nil
		}
	}
	if s.journal == nil {
		return nil, false, ErrDisk
	}
	view := b
	if view == nil {
		view = newBucket(caller)
	}
	c, reply, err := f(view)
	if err != nil {
		return nil, false, err
	}
	if err := s.checkCaps(b, c); err != nil {
		return nil, false, err
	}
	res, err = json.Marshal(reply)
	if err != nil {
		return nil, false, err
	}
	e := &entry{Seq: s.seq + 1, At: s.now(), M: method, Caller: caller, Idem: idem, Put: c.put, Remove: c.remove, Prefs: c.prefs,
		Drop: c.drop, Res: res}
	marksChanged = len(c.put) > 0 || len(c.remove) > 0
	if marksChanged {
		e.Rev = view.rev + 1
	}
	line, err := json.Marshal(e)
	if err != nil {
		return nil, false, err
	}
	line = append(line, '\n')
	at := where{off: s.journalSize, n: int32(len(line)), file: fileJournal}
	if err := s.appendLocked(line); err != nil {
		log.Printf("journal: %v", err)
		return nil, false, ErrDisk
	}
	s.applyLocked(e, at)
	if nb := s.buckets[caller]; nb != nil {
		s.pruneIdem(nb)
	}
	s.pruneDeskIdem()
	s.dropped = false
	if len(c.drop) > 0 && !s.noPurge {
		// A member's data that's gone is gone from the files too, not only from memory.
		if err := s.compactLocked(); err != nil {
			log.Printf("compaction after a retain: %v", err)
		}
	} else {
		s.maybeCompactLocked()
	}
	return res, marksChanged, nil
}

func (s *Store) appendLocked(line []byte) error {
	n, err := s.journal.Write(line)
	if err == nil && n < len(line) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = s.journal.Sync()
	}
	if err != nil {
		// Leave no torn line for the next append to follow.
		if terr := s.journal.Truncate(s.journalSize); terr == nil {
			_, _ = s.journal.Seek(s.journalSize, io.SeekStart)
		}
		return err
	}
	s.journalSize += int64(len(line))
	return nil
}

func (s *Store) checkCaps(b *bucket, c change) error {
	if len(c.put) == 0 && c.prefs == nil {
		return nil // removing never fills anything
	}
	view := b
	if view == nil {
		view = newBucket("")
	}
	count, live := len(view.marks), view.live
	if b == nil {
		live = 0
	}
	before, beforeLive := count, live
	for _, id := range c.remove {
		if x, ok := parseID(id); ok && view.marks[x] != nil {
			count--
			live -= int64(view.marks[x].size)
		}
	}
	for _, m := range c.put {
		x, _ := parseID(m.ID)
		if old := view.marks[x]; old == nil {
			count++
		} else {
			live -= int64(old.size)
		}
		live += int64(lineSize(m))
	}
	if c.prefs != nil {
		line, _ := json.Marshal(stateLine{Caller: view.key, Prefs: c.prefs})
		live += int64(len(line)+1) - int64(view.prefsSize)
	}
	deskCount, deskLive := s.totalMarks+count-before, s.totalLive+live-beforeLive
	if (count > s.opt.MaxMarks && count > before) || (live > s.opt.MaxBytes && live > beforeLive) ||
		(deskCount > s.opt.DeskMaxMarks && deskCount > s.totalMarks) || (deskLive > s.opt.DeskMaxBytes && deskLive > s.totalLive) {
		return ErrFull
	}
	return nil
}

// maybeCompactLocked writes a new state and an empty journal once the journal is over 64 KiB and more than twice
// the state's size or over 4 MiB. A failure leaves the journal as it was, which is still whole.
func (s *Store) maybeCompactLocked() {
	state := s.totalLive + s.idemBytes
	if s.journalSize <= compactFloor || (s.journalSize <= 2*state && s.journalSize <= compactCap) {
		return
	}
	if err := s.compactLocked(); err != nil {
		log.Printf("compaction: %v", err)
	}
}

// countWriter counts what goes through it, for where the state's lines are.
type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

func (s *Store) compactLocked() error {
	// Notes' words and kept replies are read back from the old files, which stay whole until the new state is in
	// place; where each line lands is noted, and memory points there once the rename is done.
	l := &lines{dir: s.dir}
	defer l.close()
	type moved struct {
		body  *mem
		reply *idemRec
		at    where
	}
	var moves []moved
	var lost []*idemRec
	keys := make([]string, 0, len(s.buckets))
	for k := range s.buckets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	err := writeAtomic(filepath.Join(s.dir, stateFile), func(w io.Writer) error {
		cw := &countWriter{w: w}
		enc := json.NewEncoder(cw)
		put := func(v any) (where, error) {
			at := cw.n
			err := enc.Encode(v)
			return where{off: at, n: int32(cw.n - at), file: fileState}, err
		}
		if _, err := put(header{Format: "ma-bible-state", Version: Version, Seq: s.seq, SavedAt: s.now()}); err != nil {
			return err
		}
		for _, k := range keys {
			b := s.buckets[k]
			rev := b.rev
			if _, err := put(stateLine{Caller: k, Rev: &rev}); err != nil {
				return err
			}
			ids := make([]*mem, 0, len(b.marks))
			for _, m := range b.marks {
				ids = append(ids, m)
			}
			sort.Slice(ids, func(i, j int) bool { return bytes.Compare(ids[i].id[:], ids[j].id[:]) < 0 })
			for _, m := range ids {
				text := ""
				if m.kind == kindNote {
					var err error
					if text, err = l.body(m); err != nil {
						return err // a note that can't be read back: keep the old files
					}
				}
				mk := m.toMark(text)
				at, err := put(stateLine{Caller: k, Mark: &mk})
				if err != nil {
					return err
				}
				if m.kind == kindNote {
					moves = append(moves, moved{body: m, at: at})
				}
			}
			p := b.prefs
			if _, err := put(stateLine{Caller: k, Prefs: &p}); err != nil {
				return err
			}
			for _, r := range b.idemOrder {
				res, err := l.reply(r)
				if err != nil {
					lost = append(lost, r) // dropped: a retry with that key runs again
					continue
				}
				at, err := put(stateLine{Caller: k, Idem: &idemLine{Key: r.key, M: r.m, At: msString(r.at), Res: res}})
				if err != nil {
					return err
				}
				moves = append(moves, moved{reply: r, at: at})
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.idemBytes = 0
	for _, mv := range moves {
		if mv.body != nil {
			mv.body.body = mv.at
		} else {
			mv.reply.res = mv.at
			s.idemBytes += int64(mv.at.n)
		}
	}
	for _, r := range lost {
		for _, b := range s.buckets {
			if b.idem[r.key] == r {
				delete(b.idem, r.key)
				for i, x := range b.idemOrder {
					if x == r {
						b.idemOrder = append(b.idemOrder[:i], b.idemOrder[i+1:]...)
						break
					}
				}
				s.totalIdem--
			}
		}
	}
	// The state now holds everything up to seq; the old journal's lines are all at or below it, so a kill before the
	// next step only leaves lines that are skipped.
	return s.newJournal()
}

// Compact writes the state now, for tests and a clean stop.
func (s *Store) Compact() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.compactLocked()
}

// ---- the methods

// MarkInput is bible.mark.put's mark.
type MarkInput struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Book        string  `json:"book"`
	Chapter     int     `json:"chapter"`
	Verse       int     `json:"verse"`
	VerseEnd    int     `json:"verseEnd"`
	Translation string  `json:"translation"`
	Label       *string `json:"label"`
	Color       string  `json:"color"`
	Text        *string `json:"text"`
}

// PutResult is bible.mark.put's reply.
type PutResult struct {
	Mark  *Mark   `json:"mark"`
	Marks []*Mark `json:"marks,omitempty"`
}

func validTranslation(code string) bool { return canon.TranslationOrder(code) >= 0 }

func checkVerses(book string, chapter, verse, verseEnd int) error {
	ci, ok := canon.Index(book)
	switch {
	case !ok:
		return &Invalid{"book"}
	case chapter < 1 || chapter > canon.Books[ci].Chapters:
		return &Invalid{"chapter"}
	case verse < 1 || verse > canon.MaxVerse:
		return &Invalid{"verse"}
	case verseEnd != 0 && (verseEnd < verse || verseEnd > canon.MaxVerse):
		return &Invalid{"verseEnd"}
	}
	return nil
}

func checkContent(kind string, in MarkInput) error {
	switch kind {
	case "bookmark":
		if in.Label != nil && utf8.RuneCountInString(*in.Label) > MaxLabel {
			return &Invalid{"label"}
		}
	case "highlight":
		if !canon.ValidColor(in.Color) {
			return &Invalid{"color"}
		}
	case "note":
		if in.Text == nil || *in.Text == "" || utf8.RuneCountInString(*in.Text) > MaxNote {
			return &Invalid{"text"}
		}
	}
	if in.Translation != "" && !validTranslation(in.Translation) {
		return &Invalid{"translation"}
	}
	return nil
}

func setContent(m *Mark, in MarkInput) {
	switch m.Kind {
	case "bookmark":
		m.Label = ""
		if in.Label != nil {
			m.Label = *in.Label
		}
	case "highlight":
		m.Color = in.Color
	case "note":
		m.Text = *in.Text
	}
	if in.Translation != "" {
		m.Translation = in.Translation
	}
}

// PutMark is bible.mark.put for a caller.
func (s *Store) PutMark(caller, idem string, in MarkInput) (json.RawMessage, bool, error) {
	return s.mutate(caller, "bible.mark.put", idem, func(b *bucket) (change, any, error) {
		now := s.now()
		var c change
		if in.ID != "" {
			id, ok := parseID(in.ID)
			old := b.marks[id]
			if !ok || old == nil {
				return c, nil, &NotFound{"mark"}
			}
			if err := checkContent(kinds[old.kind], in); err != nil {
				return c, nil, err
			}
			m := old.toMark("") // a note's words are replaced whole
			setContent(&m, in)
			m.UpdatedAt = now
			c.put = []*Mark{&m}
			s.rememberColor(b, &c, m.Kind, m.Color)
			return c, PutResult{Mark: &m}, nil
		}
		if kindIndex(in.Kind) < 0 {
			return c, nil, &Invalid{"kind"}
		}
		end := in.VerseEnd
		if end == in.Verse {
			end = 0
		}
		if err := checkVerses(in.Book, in.Chapter, in.Verse, end); err != nil {
			return c, nil, err
		}
		if in.Kind == "bookmark" && end != 0 {
			return c, nil, &Invalid{"verseEnd"}
		}
		if err := checkContent(in.Kind, in); err != nil {
			return c, nil, err
		}
		bi, _ := canon.Index(in.Book)
		fresh := func(verse, verseEnd int) *Mark {
			return &Mark{ID: newID(s.opt.Now()), Kind: in.Kind, Book: in.Book, Chapter: in.Chapter, Verse: verse, VerseEnd: verseEnd,
				CreatedAt: now, UpdatedAt: now}
		}
		switch in.Kind {
		case "bookmark":
			m := fresh(in.Verse, 0)
			if old := b.bookmarkAt[verseKey(bi, in.Chapter, in.Verse)]; old != nil {
				cp := old.toMark("")
				cp.UpdatedAt = now
				m = &cp
			}
			setContent(m, in)
			c.put = []*Mark{m}
			return c, PutResult{Mark: m}, nil
		case "highlight":
			last := max(end, in.Verse)
			for v := in.Verse; v <= last; v++ {
				m := fresh(v, 0)
				if old := b.highlightAt[verseKey(bi, in.Chapter, v)]; old != nil {
					cp := old.toMark("")
					cp.UpdatedAt = now
					m = &cp
				}
				setContent(m, in)
				c.put = append(c.put, m)
			}
			s.rememberColor(b, &c, "highlight", in.Color)
			res := PutResult{Mark: c.put[0]}
			if len(c.put) > 1 {
				res.Marks = c.put
			}
			return c, res, nil
		default:
			m := fresh(in.Verse, end)
			setContent(m, in)
			c.put = []*Mark{m}
			return c, PutResult{Mark: m}, nil
		}
	})
}

// rememberColor makes a highlight's color the bar's next one.
func (s *Store) rememberColor(b *bucket, c *change, kind, color string) {
	if kind == "highlight" && b.prefs.HighlightColor != color {
		p := b.prefs
		p.HighlightColor = color
		c.prefs = &p
	}
}

// RemoveMark is bible.mark.remove for a caller.
func (s *Store) RemoveMark(caller, idem, id string) (json.RawMessage, bool, error) {
	return s.mutate(caller, "bible.mark.remove", idem, func(b *bucket) (change, any, error) {
		x, ok := parseID(id)
		if !ok || b.marks[x] == nil {
			return change{}, nil, &NotFound{"mark"}
		}
		return change{remove: []string{id}}, struct{}{}, nil
	})
}

// ClearHighlights is bible.highlight.clear for a caller.
func (s *Store) ClearHighlights(caller, idem, book string, chapter, verse, verseEnd int) (json.RawMessage, bool, error) {
	return s.mutate(caller, "bible.highlight.clear", idem, func(b *bucket) (change, any, error) {
		if verseEnd == verse {
			verseEnd = 0
		}
		if err := checkVerses(book, chapter, verse, verseEnd); err != nil {
			return change{}, nil, err
		}
		bi, _ := canon.Index(book)
		var c change
		for v := verse; v <= max(verse, verseEnd); v++ {
			if m := b.highlightAt[verseKey(bi, chapter, v)]; m != nil {
				c.remove = append(c.remove, idString(m.id))
			}
		}
		return c, map[string]int{"removed": len(c.remove)}, nil
	})
}

// SetPrefs is bible.prefs.set for a caller: the keys given, each checked, then the whole prefs.
func (s *Store) SetPrefs(caller, idem string, patch map[string]json.RawMessage) (json.RawMessage, error) {
	res, _, err := s.mutate(caller, "bible.prefs.set", idem, func(b *bucket) (change, any, error) {
		p := b.prefs
		if p.Place != nil {
			pl := *p.Place
			p.Place = &pl
		}
		if raw, ok := patch["textSize"]; ok {
			var n int
			if json.Unmarshal(raw, &n) != nil || !textSizes[n] {
				return change{}, nil, &Invalid{"textSize"}
			}
			p.TextSize = n
		}
		for key, dst := range map[string]*bool{"oneVersePerLine": &p.OneVersePerLine, "footnotes": &p.Footnotes} {
			if raw, ok := patch[key]; ok {
				if json.Unmarshal(raw, dst) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
					return change{}, nil, &Invalid{key}
				}
			}
		}
		if raw, ok := patch["highlightColor"]; ok {
			var c string
			if json.Unmarshal(raw, &c) != nil || !canon.ValidColor(c) {
				return change{}, nil, &Invalid{"highlightColor"}
			}
			p.HighlightColor = c
		}
		if raw, ok := patch["place"]; ok {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				p.Place = nil
			} else {
				var pl Place
				ok := s.opt.Translations
				if ok == nil {
					ok = validTranslation
				}
				if json.Unmarshal(raw, &pl) != nil || !ok(pl.Translation) || checkVerses(pl.Book, pl.Chapter, pl.Verse, 0) != nil {
					return change{}, nil, &Invalid{"place"}
				}
				p.Place = &pl
			}
		}
		return change{prefs: &p}, p, nil
	})
	return res, err
}

// Retain is deskd's app.members.retain: every member's bucket not in members goes, marks, prefs and kept keys, from
// memory and from the files. The owner's bucket is never touched. An empty list is refused (Invalid "empty") unless
// all says to remove every member's bucket, so a roster that lost its members by mistake never wipes everyone; all
// with a list is refused too (Invalid "all"). removed is how many buckets went.
func (s *Store) Retain(idem string, members []string, all bool) (json.RawMessage, error) {
	switch {
	case all && len(members) > 0:
		return nil, &Invalid{"all"}
	case !all && len(members) == 0:
		return nil, &Invalid{"empty"}
	}
	keep := map[string]bool{}
	for _, m := range members {
		keep[m] = true
	}
	res, _, err := s.mutate(Desk, "app.members.retain", idem, func(*bucket) (change, any, error) {
		var c change
		for k := range s.buckets {
			if k != Owner && k != Desk && !keep[k] {
				c.drop = append(c.drop, k)
			}
		}
		sort.Strings(c.drop)
		return c, map[string]int{"removed": len(c.drop)}, nil
	})
	return res, err
}
