// Package store keeps the member's marks and prefs in the app's data folder (API.md, "On disk"): a journal of JSON
// lines, appended and synced before each reply, and a state file replaced whole when the journal grows. A kill at any
// moment leaves the old or the new data, and a torn last line is dropped.
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
	"time"
	"unicode/utf8"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
)

const (
	Version     = 1
	MaxMarks    = 20_000
	MaxBytes    = 8 << 20
	MaxLabel    = 80
	MaxNote     = 10_000
	stateFile   = "state.jsonl"
	journalFile = "journal.jsonl"

	compactFloor = 64 << 10
	compactCap   = 4 << 20
	idemKeep     = 1000
	idemMax      = 10_000
	idemAge      = 24 * time.Hour
	// A reply over this is kept on disk only (its journal or state line) and read back for a replay, so a member
	// saving a long note as they type doesn't keep 1,000 copies of it in memory.
	smallReply = 1 << 10
	timeFormat = "2006-01-02T15:04:05.000Z"
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

// Mark is a bookmark, highlight or note (API.md, "Data shapes").
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

var kindOrder = map[string]int{"bookmark": 0, "highlight": 1, "note": 2}

// Options are for tests; zero values take the API's limits.
type Options struct {
	MaxMarks     int
	MaxBytes     int64
	Now          func() time.Time
	Translations func(code string) bool // whether a place may name it; nil allows the four
}

type idemRec struct {
	Key  string          `json:"key"`
	M    string          `json:"m"`
	At   string          `json:"at"`
	Res  json.RawMessage `json:"res"`
	at   time.Time
	file string // where a reply that isn't kept in memory is: stateFile or journalFile, at off
	off  int64
	size int // the reply's size, kept or not
}

type chapKey struct {
	book    string
	chapter int
}

type verseKey struct {
	book           string
	chapter, verse int
}

// Store is the member's data, in memory and on disk.
type Store struct {
	dir string
	opt Options

	mu          sync.Mutex
	marks       map[string]*Mark
	size        map[string]int // each mark's stored line
	byChapter   map[chapKey]map[string]*Mark
	bookmarkAt  map[verseKey]*Mark
	highlightAt map[verseKey]*Mark
	prefs       Prefs
	prefsSize   int
	liveBytes   int64 // marks and prefs, as stored
	idem        map[string]*idemRec
	idemOrder   []*idemRec
	idemBytes   int64
	seq, rev    uint64
	journal     *os.File
	journalSize int64
}

// entry is one journal line: what a mutation changed, and the reply it got.
type entry struct {
	Seq    uint64          `json:"seq"`
	At     string          `json:"at"`
	M      string          `json:"m"`
	Idem   string          `json:"idem,omitempty"`
	Rev    uint64          `json:"rev,omitempty"`
	Put    []*Mark         `json:"put,omitempty"`
	Remove []string        `json:"remove,omitempty"`
	Prefs  *Prefs          `json:"prefs,omitempty"`
	Res    json.RawMessage `json:"res"`
}

type header struct {
	Format  string `json:"format"`
	Version int    `json:"version"`
	Seq     uint64 `json:"seq,omitempty"`
	Rev     uint64 `json:"rev,omitempty"`
	SavedAt string `json:"savedAt,omitempty"`
}

type stateLine struct {
	Mark  *Mark    `json:"mark,omitempty"`
	Prefs *Prefs   `json:"prefs,omitempty"`
	Idem  *idemRec `json:"idem,omitempty"`
}

// CheckFormat reads only the files' headers: ErrNewerFormat if either was written by a newer version. It's quick,
// so the app runs it before it answers HELLO.
func CheckFormat(dir string) error {
	for _, name := range []string{stateFile, journalFile} {
		f, err := os.Open(filepath.Join(dir, name))
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
	if opt.Now == nil {
		opt.Now = time.Now
	}
	s := &Store{dir: dir, opt: opt, marks: map[string]*Mark{}, size: map[string]int{}, byChapter: map[chapKey]map[string]*Mark{},
		bookmarkAt: map[verseKey]*Mark{}, highlightAt: map[verseKey]*Mark{}, idem: map[string]*idemRec{}}
	s.setPrefs(DefaultPrefs())
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
	s.pruneIdem()
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

func (s *Store) loadState() error {
	f, err := os.Open(filepath.Join(s.dir, stateFile))
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
		at := off
		off += int64(len(line))
		if len(bytes.TrimSpace(line)) > 0 {
			if first {
				var h header
				if json.Unmarshal(line, &h) != nil || h.Format != "ma-bible-state" {
					return fmt.Errorf("%s: no header", stateFile)
				}
				s.seq, s.rev, first = h.Seq, h.Rev, false
			} else {
				var l stateLine
				if json.Unmarshal(line, &l) != nil {
					log.Printf("%s line %d doesn't parse; skipped", stateFile, n)
				} else if l.Mark != nil && l.Mark.ID != "" {
					s.putLocked(l.Mark)
				} else if l.Prefs != nil {
					s.setPrefs(fixPrefs(*l.Prefs))
				} else if l.Idem != nil {
					l.Idem.file, l.Idem.off = stateFile, at
					s.addIdem(l.Idem)
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
	b, err := os.ReadFile(path)
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
			if err := json.Unmarshal(line, &e); err != nil {
				if next >= len(b) {
					log.Printf("%s: a last line that doesn't parse; dropped", journalFile)
					break
				}
				log.Printf("%s line %d doesn't parse; skipped", journalFile, n)
			} else if e.Seq > s.seq {
				s.applyLocked(&e, int64(pos))
			}
		}
		pos, good = next, next
	}
	if good == 0 {
		return s.newJournal()
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0o600)
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
	f, err := os.OpenFile(path, os.O_WRONLY, 0o600)
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
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
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

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// ---- in memory

func (s *Store) setPrefs(p Prefs) {
	b, _ := json.Marshal(stateLine{Prefs: &p})
	s.liveBytes += int64(len(b)+1) - int64(s.prefsSize)
	s.prefs, s.prefsSize = p, len(b)+1
}

func lineSize(m *Mark) int {
	b, _ := json.Marshal(stateLine{Mark: m})
	return len(b) + 1
}

func (s *Store) putLocked(m *Mark) {
	if old := s.marks[m.ID]; old != nil {
		s.removeLocked(m.ID)
	}
	s.marks[m.ID] = m
	n := lineSize(m)
	s.size[m.ID] = n
	s.liveBytes += int64(n)
	ck := chapKey{m.Book, m.Chapter}
	if s.byChapter[ck] == nil {
		s.byChapter[ck] = map[string]*Mark{}
	}
	s.byChapter[ck][m.ID] = m
	vk := verseKey{m.Book, m.Chapter, m.Verse}
	switch m.Kind {
	case "bookmark":
		s.bookmarkAt[vk] = m
	case "highlight":
		s.highlightAt[vk] = m
	}
}

func (s *Store) removeLocked(id string) {
	m := s.marks[id]
	if m == nil {
		return
	}
	delete(s.marks, id)
	s.liveBytes -= int64(s.size[id])
	delete(s.size, id)
	ck := chapKey{m.Book, m.Chapter}
	delete(s.byChapter[ck], id)
	if len(s.byChapter[ck]) == 0 {
		delete(s.byChapter, ck)
	}
	vk := verseKey{m.Book, m.Chapter, m.Verse}
	if m.Kind == "bookmark" && s.bookmarkAt[vk] == m {
		delete(s.bookmarkAt, vk)
	}
	if m.Kind == "highlight" && s.highlightAt[vk] == m {
		delete(s.highlightAt, vk)
	}
}

// applyLocked applies a journal entry; off is where its line starts in the journal.
func (s *Store) applyLocked(e *entry, off int64) {
	for _, id := range e.Remove {
		s.removeLocked(id)
	}
	for _, m := range e.Put {
		if m != nil && m.ID != "" {
			s.putLocked(m)
		}
	}
	if e.Prefs != nil {
		s.setPrefs(fixPrefs(*e.Prefs))
	}
	if e.Rev > s.rev {
		s.rev = e.Rev
	}
	s.seq = e.Seq
	if e.Idem != "" {
		s.addIdem(&idemRec{Key: e.Idem, M: e.M, At: e.At, Res: e.Res, file: journalFile, off: off})
	}
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

func (s *Store) addIdem(r *idemRec) {
	if old := s.idem[r.Key]; old != nil {
		return
	}
	r.at, _ = time.Parse(timeFormat, r.At)
	r.size = len(r.Res)
	if r.size > smallReply {
		r.Res = nil
	}
	s.idem[r.Key] = r
	s.idemOrder = append(s.idemOrder, r)
	s.idemBytes += int64(r.size + len(r.Key) + 80)
}

// reply is a kept key's reply: from memory, or read back from its line on disk.
func (s *Store) reply(r *idemRec) (json.RawMessage, error) {
	if r.Res != nil {
		return r.Res, nil
	}
	f, err := os.Open(filepath.Join(s.dir, r.file))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	line, err := bufio.NewReader(io.NewSectionReader(f, r.off, 1<<30)).ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var res json.RawMessage
	var key string
	if r.file == journalFile {
		var e entry
		err = json.Unmarshal(line, &e)
		res, key = e.Res, e.Idem
	} else {
		var l stateLine
		if err = json.Unmarshal(line, &l); err == nil && l.Idem != nil {
			res, key = l.Idem.Res, l.Idem.Key
		}
	}
	if err != nil || key != r.Key || len(res) == 0 {
		return nil, fmt.Errorf("the reply for a kept key isn't where it was")
	}
	return res, nil
}

// pruneIdem drops a key once it's over 24 hours old and not among the newest 1,000, and keeps at most 10,000.
func (s *Store) pruneIdem() {
	now := s.opt.Now()
	drop := 0
	for drop < len(s.idemOrder) {
		left := len(s.idemOrder) - drop
		r := s.idemOrder[drop]
		if left > idemMax || (left > idemKeep && now.Sub(r.at) > idemAge) {
			delete(s.idem, r.Key)
			s.idemBytes -= int64(r.size + len(r.Key) + 80)
			drop++
			continue
		}
		break
	}
	if drop > 0 {
		s.idemOrder = append([]*idemRec(nil), s.idemOrder[drop:]...)
	}
}

// ---- reads

// Rev is the marks' revision: it grows on every change to any mark.
func (s *Store) Rev() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rev
}

// Prefs returns the prefs.
func (s *Store) Prefs() Prefs {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.prefs
	if p.Place != nil {
		pl := *p.Place
		p.Place = &pl
	}
	return p
}

// Count is how many marks there are, and their stored size.
func (s *Store) Count() (int, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.marks), s.liveBytes
}

func canonLess(a, b *Mark) bool {
	ai, _ := canon.Index(a.Book)
	bi, _ := canon.Index(b.Book)
	switch {
	case ai != bi:
		return ai < bi
	case a.Chapter != b.Chapter:
		return a.Chapter < b.Chapter
	case a.Verse != b.Verse:
		return a.Verse < b.Verse
	case a.VerseEnd != b.VerseEnd:
		return a.VerseEnd < b.VerseEnd
	case a.Kind != b.Kind:
		return kindOrder[a.Kind] < kindOrder[b.Kind]
	case a.CreatedAt != b.CreatedAt:
		return a.CreatedAt < b.CreatedAt
	}
	return a.ID < b.ID
}

func recentLess(a, b *Mark) bool {
	if a.UpdatedAt != b.UpdatedAt {
		return a.UpdatedAt > b.UpdatedAt
	}
	return a.ID > b.ID
}

// Chapter returns a chapter's marks in reading order.
func (s *Store) Chapter(book string, chapter int) []Mark {
	s.mu.Lock()
	defer s.mu.Unlock()
	ms := make([]*Mark, 0, len(s.byChapter[chapKey{book, chapter}]))
	for _, m := range s.byChapter[chapKey{book, chapter}] {
		ms = append(ms, m)
	}
	sort.Slice(ms, func(i, j int) bool { return canonLess(ms[i], ms[j]) })
	out := make([]Mark, len(ms))
	for i, m := range ms {
		out[i] = *m
	}
	return out
}

// Cursor is where a list page ended: the last mark's sort fields, so a page never shifts when marks change.
type Cursor struct {
	Order string `json:"o"`
	Kind  string `json:"k"`
	Mark  Mark   `json:"m"`
}

// List returns one page of marks: kind "" for all, order "canon" or "recent".
func (s *Store) List(kind, order string, after *Cursor, limit int) (marks []Mark, total int, next *Cursor) {
	less := canonLess
	if order == "recent" {
		less = recentLess
	}
	s.mu.Lock()
	ms := make([]*Mark, 0, len(s.marks))
	for _, m := range s.marks {
		if kind == "" || m.Kind == kind {
			ms = append(ms, m)
		}
	}
	total = len(ms)
	var page []*Mark
	if after != nil {
		cut := ms[:0]
		for _, m := range ms {
			if less(&after.Mark, m) {
				cut = append(cut, m)
			}
		}
		ms = cut
	}
	sort.Slice(ms, func(i, j int) bool { return less(ms[i], ms[j]) })
	page = ms
	if len(page) > limit {
		page = page[:limit]
	}
	marks = make([]Mark, len(page))
	for i, m := range page {
		marks[i] = *m
	}
	s.mu.Unlock()
	if len(ms) > limit {
		next = &Cursor{Order: order, Kind: kind, Mark: marks[len(marks)-1]}
	}
	return marks, total, next
}

// ---- mutations

// change is what one mutation does, before it's applied.
type change struct {
	put    []*Mark
	remove []string
	prefs  *Prefs
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
	return "m" + hex.EncodeToString(b[:])
}

// mutate runs one mutation: the same idem key replays its first reply; otherwise f decides the change, the caps are
// checked, the journal entry is synced, and only then does memory change.
func (s *Store) mutate(method, idem string, f func() (change, any, error)) (res json.RawMessage, marksChanged bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if idem != "" {
		if r := s.idem[idem]; r != nil {
			if r.M != method {
				return nil, false, ErrIdem
			}
			res, err := s.reply(r)
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
	c, reply, err := f()
	if err != nil {
		return nil, false, err
	}
	if err := s.checkCaps(c); err != nil {
		return nil, false, err
	}
	res, err = json.Marshal(reply)
	if err != nil {
		return nil, false, err
	}
	e := &entry{Seq: s.seq + 1, At: s.now(), M: method, Idem: idem, Put: c.put, Remove: c.remove, Prefs: c.prefs, Res: res}
	marksChanged = len(c.put) > 0 || len(c.remove) > 0
	if marksChanged {
		e.Rev = s.rev + 1
	}
	line, err := json.Marshal(e)
	if err != nil {
		return nil, false, err
	}
	line = append(line, '\n')
	off := s.journalSize
	if err := s.appendLocked(line); err != nil {
		log.Printf("journal: %v", err)
		return nil, false, ErrDisk
	}
	s.applyLocked(e, off)
	s.pruneIdem()
	s.maybeCompactLocked()
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

func (s *Store) checkCaps(c change) error {
	count, bytes := len(s.marks), s.liveBytes
	for _, id := range c.remove {
		if s.marks[id] != nil {
			count--
			bytes -= int64(s.size[id])
		}
	}
	for _, m := range c.put {
		if s.marks[m.ID] == nil {
			count++
		} else {
			bytes -= int64(s.size[m.ID])
		}
		bytes += int64(lineSize(m))
	}
	if c.prefs != nil {
		b, _ := json.Marshal(stateLine{Prefs: c.prefs})
		bytes += int64(len(b)+1) - int64(s.prefsSize)
	}
	if (count > s.opt.MaxMarks && count > len(s.marks)) || (bytes > s.opt.MaxBytes && bytes > s.liveBytes) {
		return ErrFull
	}
	return nil
}

// maybeCompactLocked writes a new state and an empty journal once the journal is over 64 KiB and more than twice
// the state's size or over 4 MiB. A failure leaves the journal as it was, which is still whole.
func (s *Store) maybeCompactLocked() {
	state := s.liveBytes + s.idemBytes
	if s.journalSize <= compactFloor || (s.journalSize <= 2*state && s.journalSize <= compactCap) {
		return
	}
	if err := s.compactLocked(); err != nil {
		log.Printf("compaction: %v", err)
	}
}

// countWriter counts what goes through it, for the offsets of the state's lines.
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
	// Replies kept on disk are read back from the old files, which stay whole until the new state is in place.
	offs := make([]int64, len(s.idemOrder))
	err := writeAtomic(filepath.Join(s.dir, stateFile), func(w io.Writer) error {
		cw := &countWriter{w: w}
		enc := json.NewEncoder(cw)
		if err := enc.Encode(header{Format: "ma-bible-state", Version: Version, Seq: s.seq, Rev: s.rev, SavedAt: s.now()}); err != nil {
			return err
		}
		ids := make([]string, 0, len(s.marks))
		for id := range s.marks {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if err := enc.Encode(stateLine{Mark: s.marks[id]}); err != nil {
				return err
			}
		}
		p := s.prefs
		if err := enc.Encode(stateLine{Prefs: &p}); err != nil {
			return err
		}
		for i, r := range s.idemOrder {
			res, err := s.reply(r)
			if err != nil {
				offs[i] = -1 // lost: the key is dropped, and a retry with it runs again
				continue
			}
			offs[i] = cw.n
			if err := enc.Encode(stateLine{Idem: &idemRec{Key: r.Key, M: r.M, At: r.At, Res: res}}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	kept := s.idemOrder[:0]
	for i, r := range s.idemOrder {
		if offs[i] < 0 {
			delete(s.idem, r.Key)
			s.idemBytes -= int64(r.size + len(r.Key) + 80)
			continue
		}
		r.file, r.off = stateFile, offs[i]
		kept = append(kept, r)
	}
	s.idemOrder = kept
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

// PutMark is bible.mark.put.
func (s *Store) PutMark(idem string, in MarkInput) (json.RawMessage, bool, error) {
	return s.mutate("bible.mark.put", idem, func() (change, any, error) {
		now := s.now()
		var c change
		if in.ID != "" {
			old := s.marks[in.ID]
			if old == nil {
				return c, nil, &NotFound{"mark"}
			}
			if err := checkContent(old.Kind, in); err != nil {
				return c, nil, err
			}
			m := *old
			setContent(&m, in)
			m.UpdatedAt = now
			c.put = []*Mark{&m}
			s.rememberColor(&c, m.Kind, m.Color)
			return c, PutResult{Mark: &m}, nil
		}
		if _, ok := kindOrder[in.Kind]; !ok {
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
		fresh := func(verse, verseEnd int) *Mark {
			return &Mark{ID: newID(s.opt.Now()), Kind: in.Kind, Book: in.Book, Chapter: in.Chapter, Verse: verse, VerseEnd: verseEnd,
				CreatedAt: now, UpdatedAt: now}
		}
		switch in.Kind {
		case "bookmark":
			m := fresh(in.Verse, 0)
			if old := s.bookmarkAt[verseKey{in.Book, in.Chapter, in.Verse}]; old != nil {
				cp := *old
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
				if old := s.highlightAt[verseKey{in.Book, in.Chapter, v}]; old != nil {
					cp := *old
					cp.UpdatedAt = now
					m = &cp
				}
				setContent(m, in)
				c.put = append(c.put, m)
			}
			s.rememberColor(&c, "highlight", in.Color)
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
func (s *Store) rememberColor(c *change, kind, color string) {
	if kind == "highlight" && s.prefs.HighlightColor != color {
		p := s.prefs
		p.HighlightColor = color
		c.prefs = &p
	}
}

// RemoveMark is bible.mark.remove.
func (s *Store) RemoveMark(idem, id string) (json.RawMessage, bool, error) {
	return s.mutate("bible.mark.remove", idem, func() (change, any, error) {
		if s.marks[id] == nil {
			return change{}, nil, &NotFound{"mark"}
		}
		return change{remove: []string{id}}, struct{}{}, nil
	})
}

// ClearHighlights is bible.highlight.clear.
func (s *Store) ClearHighlights(idem, book string, chapter, verse, verseEnd int) (json.RawMessage, bool, error) {
	return s.mutate("bible.highlight.clear", idem, func() (change, any, error) {
		if verseEnd == verse {
			verseEnd = 0
		}
		if err := checkVerses(book, chapter, verse, verseEnd); err != nil {
			return change{}, nil, err
		}
		var c change
		for v := verse; v <= max(verse, verseEnd); v++ {
			if m := s.highlightAt[verseKey{book, chapter, v}]; m != nil {
				c.remove = append(c.remove, m.ID)
			}
		}
		return c, map[string]int{"removed": len(c.remove)}, nil
	})
}

// SetPrefs is bible.prefs.set: the keys given, each checked, then the whole prefs.
func (s *Store) SetPrefs(idem string, patch map[string]json.RawMessage) (json.RawMessage, error) {
	res, _, err := s.mutate("bible.prefs.set", idem, func() (change, any, error) {
		p := s.prefs
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
