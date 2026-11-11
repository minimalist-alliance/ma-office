// Package text reads the package's translations, renders chapters, reads references and searches.
//
// A translation's text is memory-mapped, read-only, and the Go heap keeps only where each verse is (about 20 bytes a
// verse), so four translations cost a few MiB of heap; the text itself is the kernel's page cache, which it can drop.
package text

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
)

// Info is what the menu shows of a translation.
type Info struct {
	Code         string `json:"code"`
	Name         string `json:"name"`
	Abbreviation string `json:"abbreviation"`
	Edition      string `json:"edition"`
	PublicDomain bool   `json:"publicDomain"`
	Default      bool   `json:"default"`
	SourceURL    string `json:"-"` // the publisher's page for the edition, for the About sheet
}

// The four at launch, from apps/bible/texts/README.md and each SOURCE.md: check them when the texts change. Edition
// is the year the menu shows: the BSB's current text has no year of its own, so it shows the year it became public
// domain.
var infos = map[string]Info{
	"bsb": {Code: "bsb", Name: "Berean Standard Bible", Abbreviation: "BSB", Edition: "2023", PublicDomain: true, Default: true,
		SourceURL: "https://berean.bible/terms.htm"},
	"web": {Code: "web", Name: "World English Bible", Abbreviation: "WEB", Edition: "2020", PublicDomain: true,
		SourceURL: "https://ebible.org/find/details.php?id=eng-web"},
	"kjv": {Code: "kjv", Name: "King James Version", Abbreviation: "KJV", Edition: "1769", PublicDomain: true,
		SourceURL: "https://ebible.org/find/details.php?id=eng-kjv2006"},
	"asv": {Code: "asv", Name: "American Standard Version", Abbreviation: "ASV", Edition: "1901", PublicDomain: true,
		SourceURL: "https://ebible.org/find/details.php?id=eng-asv"},
}

// DefaultCode is the translation the app opens in.
const DefaultCode = "bsb"

var (
	ErrUnknown    = errors.New("no such translation in the package")
	ErrUnreadable = errors.New("translation can't be read")
)

// Library is the package's translations, each read on first use.
type Library struct {
	dir     string
	present []string          // codes whose text is in the package, in canon.Translations order
	sums    map[string]string // package path -> SHA-256, from ma-app.json; nil if there's none
	mu      sync.Mutex
	loaded  map[string]*slot
}

type slot struct {
	once sync.Once
	t    *Translation
	err  error
}

// NewLibrary looks at what's in textsDir, without reading any text. manifest is the package's ma-app.json, or "".
func NewLibrary(textsDir, manifest string) *Library {
	l := &Library{dir: textsDir, loaded: map[string]*slot{}}
	for _, c := range canon.Translations {
		if fi, err := os.Stat(filepath.Join(textsDir, c, c+".tsv")); err == nil && fi.Mode().IsRegular() {
			l.present = append(l.present, c)
		}
	}
	if manifest != "" {
		if b, err := os.ReadFile(manifest); err == nil {
			var m struct {
				Files map[string]struct {
					SHA256 string `json:"sha256"`
				} `json:"files"`
			}
			if json.Unmarshal(b, &m) == nil && len(m.Files) > 0 {
				l.sums = map[string]string{}
				for p, f := range m.Files {
					l.sums[p] = f.SHA256
				}
			}
		}
	}
	return l
}

// Codes are the translations in the package, in their fixed order.
func (l *Library) Codes() []string { return l.present }

// Has says whether code is in the package.
func (l *Library) Has(code string) bool {
	for _, c := range l.present {
		if c == code {
			return true
		}
	}
	return false
}

// Info returns a translation's menu entry.
func (l *Library) Info(code string) Info { return infos[code] }

// Get reads a translation the first time it's asked for. ErrUnknown if it isn't in the package, ErrUnreadable if its
// files are missing, malformed or fail their check. Either answer is kept.
func (l *Library) Get(code string) (*Translation, error) {
	if !l.Has(code) {
		return nil, ErrUnknown
	}
	l.mu.Lock()
	s := l.loaded[code]
	if s == nil {
		s = &slot{}
		l.loaded[code] = s
	}
	l.mu.Unlock()
	s.once.Do(func() {
		s.t, s.err = l.open(code)
		if s.err != nil {
			s.err = fmt.Errorf("%w: %s: %v", ErrUnreadable, code, s.err)
		}
	})
	return s.t, s.err
}

// File reads one of a translation's small files (STATEMENT.txt, SOURCE.md), checked like the text.
func (l *Library) File(code, name string) (string, error) {
	if !l.Has(code) {
		return "", ErrUnknown
	}
	b, err := os.ReadFile(filepath.Join(l.dir, code, name))
	if err == nil {
		err = l.check("texts/"+code+"/"+name, b)
	}
	if err != nil {
		return "", fmt.Errorf("%w: %s: %v", ErrUnreadable, code, err)
	}
	return string(b), nil
}

func (l *Library) check(path string, b []byte) error {
	want, ok := l.sums[path]
	if !ok {
		return nil
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != want {
		return fmt.Errorf("%s doesn't match the package's SHA-256", path)
	}
	return nil
}

// Translation is one translation, read.
type Translation struct {
	Info
	data    []byte // the .tsv, memory-mapped read-only
	books   []*Book
	byCanon [66]*Book
	verses  []verseRec
	otEnd   int // verses[:otEnd] are the Old Testament's
}

// Book is a book as this translation has it.
type Book struct {
	Canon    int
	ID       string
	Name     string
	Chapters int
	chap     [][2]int32 // per chapter, its verses' range in Translation.verses (empty if it has none)
	maxVerse []uint8    // per chapter, the highest verse number
}

// verseRec is where one verse is in the mapped text: its block (the headings before it, its V line, the poetry and
// footnote lines after it) and its words.
type verseRec struct {
	blockStart, blockEnd uint32
	textOff              uint32
	textLen              uint16
	book                 uint8 // canon index
	chapter              uint8
	verse, verseEnd      uint8 // verseEnd 0 unless joined
	flags                uint8
}

// Format is the version of the texts' format this reads (apps/bible/texts/README.md); any other is refused.
const Format = "2"

const (
	flagP = 1 << iota
	flagB
	flagQ
	flagASCII // every letter and digit of the verse is ASCII (its other characters break words): the quick check applies
)

func (v *verseRec) last() int {
	if v.verseEnd > 0 {
		return int(v.verseEnd)
	}
	return int(v.verse)
}

func (l *Library) open(code string) (*Translation, error) {
	dir := filepath.Join(l.dir, code)
	bb, err := os.ReadFile(filepath.Join(dir, "books.tsv"))
	if err != nil {
		return nil, err
	}
	if err := l.check("texts/"+code+"/books.tsv", bb); err != nil {
		return nil, err
	}
	t := &Translation{Info: infos[code]}
	if err := t.readBooks(bb); err != nil {
		return nil, fmt.Errorf("books.tsv: %v", err)
	}
	data, err := mmap(filepath.Join(dir, code+".tsv"))
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Translation, error) {
		_ = syscall.Munmap(data)
		return nil, err
	}
	if err := l.check("texts/"+code+"/"+code+".tsv", data); err != nil {
		return fail(err)
	}
	if !utf8.Valid(data) {
		return fail(errors.New("not UTF-8"))
	}
	t.data = data
	if err := t.parse(code); err != nil {
		return fail(fmt.Errorf("%s.tsv: %v", code, err))
	}
	return t, nil
}

func mmap(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() == 0 || fi.Size() >= 1<<32 {
		return nil, errors.New("empty or too big")
	}
	return syscall.Mmap(int(f.Fd()), 0, int(fi.Size()), syscall.PROT_READ, syscall.MAP_SHARED)
}

func (t *Translation) readBooks(b []byte) error {
	for n, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" || line[0] == '#' {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 3 {
			return fmt.Errorf("line %d: want BOOK, NAME, CHAPTERS", n+1)
		}
		ci, ok := canon.Index(f[0])
		ch, err := strconv.Atoi(f[2])
		if !ok || err != nil || ch < 1 || ch > 255 || f[1] == "" || t.byCanon[ci] != nil {
			return fmt.Errorf("line %d: bad or repeated book", n+1)
		}
		if len(t.books) > 0 && t.books[len(t.books)-1].Canon > ci {
			return fmt.Errorf("line %d: not in canonical order", n+1)
		}
		bk := &Book{Canon: ci, ID: f[0], Name: f[1], Chapters: ch, chap: make([][2]int32, ch), maxVerse: make([]uint8, ch)}
		t.books = append(t.books, bk)
		t.byCanon[ci] = bk
	}
	if len(t.books) == 0 {
		return errors.New("no books")
	}
	return nil
}

// nextLine returns the line at pos without its line end, and where the next one starts.
func nextLine(data []byte, pos int) ([]byte, int) {
	end := bytes.IndexByte(data[pos:], '\n')
	next := len(data)
	if end < 0 {
		end = len(data)
	} else {
		end += pos
		next = end + 1
	}
	line := data[pos:end]
	if n := len(line); n > 0 && line[n-1] == '\r' {
		line = line[:n-1]
	}
	return line, next
}

// fields splits a line on tabs into exactly n fields, the last taking the rest.
func fields(line []byte, n int) ([][]byte, bool) {
	out := make([][]byte, 0, n)
	for i := 0; i < n-1; i++ {
		j := bytes.IndexByte(line, '\t')
		if j < 0 {
			return nil, false
		}
		out = append(out, line[:j])
		line = line[j+1:]
	}
	return append(out, line), true
}

func atoi(b []byte) int {
	if len(b) == 0 || len(b) > 4 {
		return -1
	}
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// verseNumbers reads "N" or "N-M".
func verseNumbers(b []byte) (v, end int, ok bool) {
	if i := bytes.IndexByte(b, '-'); i >= 0 {
		v, end = atoi(b[:i]), atoi(b[i+1:])
		return v, end, v >= 1 && v <= 255 && end > v && end <= 255
	}
	v = atoi(b)
	return v, 0, v >= 1 && v <= 255
}

func (t *Translation) parse(code string) error {
	data := t.data
	head, pos := nextLine(data, 0)
	if f := strings.Fields(string(head)); len(f) != 4 || f[0] != "#" || f[1] != "ma-bible-text" || f[2] != Format || f[3] != code {
		return errors.New("first line isn't # ma-bible-text " + Format + " " + code)
	}
	pending := -1    // where headings waiting for the next verse start
	var place []byte // the current verse's BOOK, CHAPTER and VERSE fields, as written
	var last byte    // the kind of the line before
	type at struct{ book, chapter int }
	cur := at{-1, 0}
	seen := map[at]bool{}
	for lineNo := 2; pos < len(data); lineNo++ {
		start := pos
		var line []byte
		line, pos = nextLine(data, pos)
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		if len(line) < 2 || line[1] != '\t' {
			return fmt.Errorf("line %d: no kind", lineNo)
		}
		kind := line[0]
		switch kind {
		case 'H':
			f, ok := fields(line, 6)
			if !ok {
				return fmt.Errorf("line %d: want H, BOOK, CHAPTER, VERSE, LEVEL, TEXT", lineNo)
			}
			// A heading inside the current verse (its place) or an end note after a book's last verse stays in that
			// verse's block; any other heading starts the next verse's.
			inside := pending < 0 && len(t.verses) > 0 && (string(f[4]) == "e" || bytes.Equal(placeOf(f), place))
			if !inside && pending < 0 {
				pending = start
			}
		case 'G':
			if last != 'H' && last != 'G' {
				return fmt.Errorf("line %d: a G line belongs right after its heading", lineNo)
			}
		case 'V':
			f, ok := fields(line, 6)
			if !ok {
				return fmt.Errorf("line %d: want V, BOOK, CHAPTER, VERSE, FLAGS, TEXT", lineNo)
			}
			ci, ok := canon.Index(string(f[1]))
			bk := t.byCanonOrNil(ci, ok)
			ch := atoi(f[2])
			v, ve, vok := verseNumbers(f[3])
			if bk == nil || ch < 1 || ch > bk.Chapters || !vok {
				return fmt.Errorf("line %d: bad book, chapter or verse", lineNo)
			}
			if here := (at{ci, ch}); here != cur {
				if seen[here] || ci < cur.book || (ci == cur.book && ch < cur.chapter) {
					return fmt.Errorf("line %d: out of order", lineNo)
				}
				seen[here], cur = true, here
				bk.chap[ch-1] = [2]int32{int32(len(t.verses)), int32(len(t.verses))}
			}
			text := f[5]
			if len(text) > 0xFFFF {
				return fmt.Errorf("line %d: verse too long", lineNo)
			}
			var flags uint8
			for _, c := range f[4] {
				switch c {
				case 'p':
					flags |= flagP
				case 'b':
					flags |= flagB
				case 'q':
					flags |= flagQ
				}
			}
			if asciiWords(text) {
				flags |= flagASCII
			}
			blockStart := start
			if pending >= 0 {
				blockStart, pending = pending, -1
			}
			if n := len(t.verses); n > 0 {
				t.verses[n-1].blockEnd = uint32(blockStart)
			}
			place = placeOf(f)
			t.verses = append(t.verses, verseRec{
				blockStart: uint32(blockStart), textOff: uint32(start + len(line) - len(text)),
				textLen: uint16(len(text)), book: uint8(ci), chapter: uint8(ch), verse: uint8(v), verseEnd: uint8(ve), flags: flags,
			})
			bk.chap[ch-1][1] = int32(len(t.verses))
			if last := max(v, ve); last > int(bk.maxVerse[ch-1]) {
				bk.maxVerse[ch-1] = uint8(last)
			}
		case 'Q', 'F':
			if len(t.verses) == 0 || pending >= 0 {
				return fmt.Errorf("line %d: a Q or F line belongs to the verse above it", lineNo)
			}
		default:
			return fmt.Errorf("line %d: unknown kind", lineNo)
		}
		last = kind
	}
	if len(t.verses) == 0 {
		return errors.New("no verses")
	}
	end := len(data)
	if pending >= 0 {
		end = pending
	}
	t.verses[len(t.verses)-1].blockEnd = uint32(end)
	for i, v := range t.verses {
		if canon.Books[v.book].Testament == "nt" {
			t.otEnd = i
			break
		}
		t.otEnd = i + 1
	}
	return nil
}

// asciiWords says whether every character of b that's part of a word is ASCII: curly quotes and dashes may be there,
// since they break words, but no accented letter or dropped mark, which fold.
func asciiWords(b []byte) bool {
	for i := 0; i < len(b); {
		if b[i] < 0x80 {
			i++
			continue
		}
		r, size := utf8.DecodeRune(b[i:])
		if _, word := foldRune(nil, r); word {
			return false
		}
		i += size
	}
	return true
}

// placeOf is a line's BOOK, CHAPTER and VERSE fields as written, for comparing places.
func placeOf(f [][]byte) []byte {
	return bytes.Join([][]byte{f[1], f[2], f[3]}, []byte{'\t'})
}

func (t *Translation) byCanonOrNil(ci int, ok bool) *Book {
	if !ok {
		return nil
	}
	return t.byCanon[ci]
}

// Book returns this translation's book with that USFM id, or nil.
func (t *Translation) Book(id string) *Book {
	ci, ok := canon.Index(id)
	return t.byCanonOrNil(ci, ok)
}

// Books are this translation's books in canonical order.
func (t *Translation) Books() []*Book { return t.books }

// Verses is the highest verse number of each chapter, 0 for a chapter the text doesn't have.
func (b *Book) Verses() []int {
	out := make([]int, len(b.maxVerse))
	for i, n := range b.maxVerse {
		out[i] = int(n)
	}
	return out
}

// HasChapter says whether the text has any verse of that chapter.
func (b *Book) HasChapter(ch int) bool {
	return ch >= 1 && ch <= b.Chapters && b.chap[ch-1][1] > b.chap[ch-1][0]
}

// MaxVerse is the highest verse number in a chapter, 0 if there's none.
func (b *Book) MaxVerse(ch int) int {
	if ch < 1 || ch > b.Chapters {
		return 0
	}
	return int(b.maxVerse[ch-1])
}

func (t *Translation) words(v *verseRec) []byte {
	return t.data[v.textOff : v.textOff+uint32(v.textLen)]
}

// VerseText returns the words of the verse that holds verse number n, or false.
func (t *Translation) VerseText(book string, ch, n int) (string, bool) {
	b := t.Book(book)
	if b == nil || !b.HasChapter(ch) {
		return "", false
	}
	r := b.chap[ch-1]
	for i := r[0]; i < r[1]; i++ {
		v := &t.verses[i]
		if int(v.verse) <= n && n <= v.last() {
			return string(t.words(v)), true
		}
	}
	return "", false
}

// Item is one entry of a chapter (API.md, "Data shapes").
type Item struct {
	Kind     string    `json:"kind"`
	Level    string    `json:"level,omitempty"`
	Verse    int       `json:"verse,omitempty"`
	VerseEnd int       `json:"verseEnd,omitempty"`
	Text     string    `json:"text"`
	P        bool      `json:"p,omitempty"`
	B        bool      `json:"b,omitempty"`
	Q        bool      `json:"q,omitempty"`
	Segments []Segment `json:"segments,omitempty"`
	Notes    []Note    `json:"notes,omitempty"`
}

// Segment is a part of a verse in reading order: prose, a poetry line, an indented paragraph, a title, or a heading
// inside the verse. At is where it starts in the verse's text, in UTF-16 units; a heading's is where it falls.
type Segment struct {
	Kind  string `json:"kind"`
	Level any    `json:"level,omitempty"` // 1 to 4 for poetry; a heading's level ("1", "2", "d", "r")
	P     bool   `json:"p,omitempty"`
	B     bool   `json:"b,omitempty"`
	At    int    `json:"at"`
	Text  string `json:"text"`
	Notes []Note `json:"notes,omitempty"`
}

// Note is a footnote: At is a UTF-16 offset into its verse's or heading's text.
type Note struct {
	At   int    `json:"at"`
	Text string `json:"text"`
}

// segmentKind reads a Q line's KIND: an optional p, b or pb (a stanza break, then a paragraph), then 0 (prose), 1 to 4
// (poetry), i (indented prose) or d (a title inside the verse).
func segmentKind(k []byte) (Segment, bool) {
	var sg Segment
	if len(k) >= 2 && k[0] == 'p' {
		sg.P, k = true, k[1:]
		if len(k) >= 2 && k[0] == 'b' {
			sg.B, k = true, k[1:]
		}
	} else if len(k) >= 2 && k[0] == 'b' {
		sg.B, k = true, k[1:]
	}
	if len(k) != 1 {
		return sg, false
	}
	switch c := k[0]; {
	case c == '0':
		sg.Kind = "prose"
	case c >= '1' && c <= '4':
		sg.Kind, sg.Level = "poetry", int(c-'0')
	case c == 'i':
		sg.Kind = "indent"
	case c == 'd':
		sg.Kind = "title"
	default:
		return sg, false
	}
	return sg, true
}

// Chapter renders one chapter's items. ok is false if the text has no such chapter.
func (t *Translation) Chapter(b *Book, ch int) ([]Item, bool) {
	if !b.HasChapter(ch) {
		return nil, false
	}
	r := b.chap[ch-1]
	items := []Item{}
	for i := r[0]; i < r[1]; i++ {
		v := &t.verses[i]
		items = t.renderBlock(v, items)
	}
	return items, true
}

// renderBlock appends one verse's block: its headings, the verse with its segments and notes, and end notes.
func (t *Translation) renderBlock(v *verseRec, items []Item) []Item {
	block := t.data[v.blockStart:v.blockEnd]
	vi := -1         // the verse's item
	var after []Item // end notes after the verse
	var notes *[]Note
	var noteText string
	pos := 0 // bytes of the verse's text the segments have covered
	for p := 0; p < len(block); {
		var line []byte
		line, p = nextLine(block, p)
		f, ok := fields(line, 6)
		if !ok || len(f[0]) != 1 {
			continue
		}
		switch f[0][0] {
		case 'H':
			h := Item{Kind: "heading", Level: string(f[4]), Text: string(f[5])}
			switch {
			case vi < 0:
				items = append(items, h)
				notes, noteText = &items[len(items)-1].Notes, h.Text
			case h.Level == "e":
				after = append(after, h)
				notes, noteText = &after[len(after)-1].Notes, h.Text
			default:
				segs := &items[vi].Segments
				*segs = append(*segs, Segment{Kind: "heading", Level: h.Level, At: -1, Text: h.Text})
				notes, noteText = &(*segs)[len(*segs)-1].Notes, h.Text
			}
		case 'G':
			if notes != nil {
				*notes = append(*notes, Note{At: utf16At(noteText, atoi(f[4])), Text: string(f[5])})
			}
		case 'V':
			text := string(t.words(v))
			items = append(items, Item{Kind: "verse", Verse: int(v.verse), VerseEnd: int(v.verseEnd), Text: text,
				P: v.flags&flagP != 0, B: v.flags&flagB != 0, Q: v.flags&flagQ != 0})
			vi = len(items) - 1
			notes = nil
		case 'Q':
			if vi < 0 {
				continue
			}
			sg, ok := segmentKind(f[4])
			if !ok {
				sg = Segment{Kind: "prose"}
			}
			text, seg := items[vi].Text, string(f[5])
			start := pos
			switch {
			case strings.HasPrefix(text[pos:], seg):
			case pos < len(text) && text[pos] == ' ' && strings.HasPrefix(text[pos+1:], seg):
				start = pos + 1
			default:
				if k := strings.Index(text[pos:], seg); k >= 0 {
					start = pos + k
				}
			}
			pos = min(start+len(seg), len(text))
			sg.At, sg.Text = utf16Len(text[:start]), seg
			items[vi].Segments = append(items[vi].Segments, sg)
			notes = nil
		case 'F':
			if vi >= 0 {
				items[vi].Notes = append(items[vi].Notes, Note{At: utf16At(items[vi].Text, atoi(f[4])), Text: string(f[5])})
			}
			notes = nil
		}
	}
	if vi >= 0 {
		// A heading inside the verse sits where the next segment starts.
		segs := items[vi].Segments
		next := utf16Len(items[vi].Text)
		for k := len(segs) - 1; k >= 0; k-- {
			if segs[k].Kind == "heading" {
				segs[k].At = next
			} else {
				next = segs[k].At
			}
		}
	}
	return append(items, after...)
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// utf16At converts an offset in code points into s to UTF-16 units, clamped to s's end.
func utf16At(s string, cp int) int {
	n := 0
	for _, r := range s {
		if cp <= 0 {
			break
		}
		n += utf16.RuneLen(r)
		cp--
	}
	return n
}

// Neighbors are the chapters before and after, across books, skipping any the text doesn't have.
func (t *Translation) Neighbors(b *Book, ch int) (prev, next *Ref) {
	bi := 0
	for i, x := range t.books {
		if x == b {
			bi = i
		}
	}
	for i, c := bi, ch-1; i >= 0; i-- {
		x := t.books[i]
		if i != bi {
			c = x.Chapters
		}
		for ; c >= 1; c-- {
			if x.HasChapter(c) {
				prev = &Ref{Book: x.ID, Chapter: c}
				break
			}
		}
		if prev != nil {
			break
		}
	}
	for i, c := bi, ch+1; i < len(t.books); i++ {
		x := t.books[i]
		if i != bi {
			c = 1
		}
		for ; c <= x.Chapters; c++ {
			if x.HasChapter(c) {
				next = &Ref{Book: x.ID, Chapter: c}
				break
			}
		}
		if next != nil {
			break
		}
	}
	return prev, next
}

// Ref is a place in the text (API.md, "Data shapes").
type Ref struct {
	Book     string `json:"book"`
	Chapter  int    `json:"chapter"`
	Verse    int    `json:"verse,omitempty"`
	VerseEnd int    `json:"verseEnd,omitempty"`
}
