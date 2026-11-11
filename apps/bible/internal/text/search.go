package text

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
)

// Search (API.md, "How search matches"). The text is folded while it's scanned, word by word, so nothing but the
// mapped text and the verse tables is needed: no index to build or keep.

const (
	MaxQueryChars = 200
	MaxQueryWords = 12
)

var ErrQuery = errors.New("nothing to search for, or too long")

type term struct {
	w      []byte
	prefix bool
}

// group is one word, or words that must come next to each other in order.
type group []term

// Query is a parsed search.
type Query struct {
	groups []group
	Key    string   // the same for queries that match the same, for the cursor
	terms  [][]byte // every word's folded form, for the quick check
	ascii  bool     // every word is ASCII once folded
}

// quickCheck turns the ASCII quick check on; tests turn it off to compare.
var quickCheck = true

// lowerASCII appends b with its ASCII letters lower-cased, 8 bytes at a time where all 8 are ASCII; other bytes are
// copied as they are.
func lowerASCII(dst, b []byte) []byte {
	n := len(dst)
	dst = append(dst, b...)
	out := dst[n:]
	const ones, high = 0x0101010101010101, 0x8080808080808080
	i := 0
	for ; i+8 <= len(out); i += 8 {
		x := binary.LittleEndian.Uint64(out[i:])
		if x&high != 0 {
			for j := i; j < i+8; j++ {
				if c := out[j]; c >= 'A' && c <= 'Z' {
					out[j] = c + 0x20
				}
			}
			continue
		}
		// For bytes under 0x80: the high bit of (x + 0x3F) is set from 'A' up, of (x + 0x25) from '[' up.
		upper := (x + 0x3F*ones) &^ (x + 0x25*ones) & high
		binary.LittleEndian.PutUint64(out[i:], x|upper>>2)
	}
	for ; i < len(out); i++ {
		if c := out[i]; c >= 'A' && c <= 'Z' {
			out[i] = c + 0x20
		}
	}
	return dst
}

// mayMatch is the quick check for a verse whose letters and digits are all ASCII: its words fold to runs of
// lower-cased ASCII letters and digits found as they are in it, so each of the query's folded words must be a
// substring of it lower-cased, and a word that folds to anything else can't be in it. false means it can't match;
// true means fold it and see.
func (q *Query) mayMatch(text, buf []byte) ([]byte, bool) {
	if !q.ascii {
		return buf, false
	}
	buf = lowerASCII(buf[:0], text)
	for _, t := range q.terms {
		if !bytes.Contains(buf, t) {
			return buf, false
		}
	}
	return buf, true
}

// isJoiner is a character that splits a word into a phrase rather than into separate words: apostrophes and hyphens.
func isJoiner(r rune) bool {
	switch r {
	case '\'', '’', 'ʼ', '-', '‐', '‑':
		return true
	}
	return false
}

func isWordRune(r rune) bool {
	_, ok := foldRune(nil, r)
	return ok
}

// ParseQuery reads q. ErrQuery if it has nothing to search for, more than 200 characters or more than 12 words.
func ParseQuery(q string) (*Query, error) {
	if utf8.RuneCountInString(q) > MaxQueryChars {
		return nil, ErrQuery
	}
	rs := []rune(q)
	var groups []group
	seen := map[string]bool{}
	words := 0
	add := func(s string) {
		g := chunk(s)
		if len(g) == 0 {
			return
		}
		k := g.String()
		words += len(g)
		if !seen[k] {
			seen[k] = true
			groups = append(groups, g)
		}
	}
	for i := 0; i < len(rs); {
		r := rs[i]
		switch {
		case r == '"':
			j := i + 1
			for j < len(rs) && rs[j] != '"' {
				j++
			}
			add(string(rs[i+1 : j]))
			i = j + 1
		case isWordRune(r) || isJoiner(r) || r == '*':
			j := i
			for j < len(rs) && (isWordRune(rs[j]) || isJoiner(rs[j]) || rs[j] == '*') {
				j++
			}
			add(string(rs[i:j]))
			i = j
		default:
			i++
		}
	}
	if len(groups) == 0 || words > MaxQueryWords {
		return nil, ErrQuery
	}
	keys := make([]string, len(groups))
	parsed := &Query{groups: groups, ascii: true}
	for i, g := range groups {
		keys[i] = g.String()
		for _, t := range g {
			parsed.terms = append(parsed.terms, t.w)
			for _, c := range t.w {
				if c >= 0x80 {
					parsed.ascii = false
				}
			}
		}
	}
	sort.Strings(keys)
	parsed.Key = strings.Join(keys, "|")
	return parsed, nil
}

// chunk turns a run of the query into one group: its words, each a prefix if a '*' follows it.
func chunk(s string) group {
	b := []byte(s)
	ws, buf := splitWords(b, nil, nil)
	g := make(group, 0, len(ws))
	for _, w := range ws {
		g = append(g, term{w: append([]byte(nil), buf[w.fs:w.fe]...), prefix: w.e < len(b) && b[w.e] == '*'})
	}
	return g
}

func (g group) String() string {
	parts := make([]string, len(g))
	for i, t := range g {
		parts[i] = string(t.w)
		if t.prefix {
			parts[i] += "*"
		}
	}
	return strings.Join(parts, " ")
}

// at says whether g matches the words from i on.
func (g group) at(ws []word, buf []byte, i int) bool {
	if i+len(g) > len(ws) {
		return false
	}
	for k, t := range g {
		w := buf[ws[i+k].fs:ws[i+k].fe]
		if t.prefix {
			if !bytes.HasPrefix(w, t.w) {
				return false
			}
		} else if !bytes.Equal(w, t.w) {
			return false
		}
	}
	return true
}

func (q *Query) matches(ws []word, buf []byte) bool {
	for _, g := range q.groups {
		found := false
		for i := range ws {
			if g.at(ws, buf, i) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// Ranges are the matched words of text, as [start, end) in UTF-16 units, sorted and merged.
func (q *Query) Ranges(text string) [][2]int {
	b := []byte(text)
	ws, buf := splitWords(b, nil, nil)
	var spans [][2]int
	for _, g := range q.groups {
		for i := range ws {
			if g.at(ws, buf, i) {
				spans = append(spans, [2]int{ws[i].s, ws[i+len(g)-1].e})
			}
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i][0] < spans[j][0] })
	merged := [][2]int{}
	for _, s := range spans {
		if n := len(merged); n > 0 && s[0] <= merged[n-1][1] {
			merged[n-1][1] = max(merged[n-1][1], s[1])
		} else {
			merged = append(merged, s)
		}
	}
	// Bytes to UTF-16 units, in one pass: the offsets only grow.
	pos, units := 0, 0
	conv := func(at int) int {
		for pos < at {
			r, size := utf8.DecodeRune(b[pos:])
			units += utf16.RuneLen(r)
			pos += size
		}
		return units
	}
	for i := range merged {
		merged[i][0] = conv(merged[i][0])
		merged[i][1] = conv(merged[i][1])
	}
	return merged
}

// Key orders hits: canonical order, then the translations' order.
type Key struct {
	Book, Chapter, Verse, T int
}

func (a Key) Less(b Key) bool {
	if a.Book != b.Book {
		return a.Book < b.Book
	}
	if a.Chapter != b.Chapter {
		return a.Chapter < b.Chapter
	}
	if a.Verse != b.Verse {
		return a.Verse < b.Verse
	}
	return a.T < b.T
}

// Hit is one matching verse.
type Hit struct {
	Translation string   `json:"translation"`
	Book        string   `json:"book"`
	Chapter     int      `json:"chapter"`
	Verse       int      `json:"verse"`
	VerseEnd    int      `json:"verseEnd,omitempty"`
	Text        string   `json:"text"`
	Ranges      [][2]int `json:"ranges"`
}

// BookCount is how many verses of one book matched.
type BookCount struct {
	Book  string `json:"book"`
	Count int    `json:"count"`
}

// SearchParams is one search.
type SearchParams struct {
	Translations []*Translation // in their fixed order
	Scope        string         // "all", "ot", "nt" or a book id
	Query        *Query
	After        *Key // the cursor's place, or nil
	Limit        int
	MaxBytes     int // the hits' rough JSON size stays under this
}

// SearchResult is one page.
type SearchResult struct {
	Hits   []Hit
	Total  int
	Counts map[string]int
	ByBook []BookCount
	More   bool
	Last   Key // the last hit's key, for the next cursor
}

// ValidScope says whether s is a scope.
func ValidScope(s string) bool {
	if s == "all" || s == "ot" || s == "nt" {
		return true
	}
	_, ok := canon.Index(s)
	return ok
}

func (t *Translation) scope(s string) (lo, hi int) {
	switch s {
	case "all":
		return 0, len(t.verses)
	case "ot":
		return 0, t.otEnd
	case "nt":
		return t.otEnd, len(t.verses)
	}
	b := t.Book(s)
	if b == nil {
		return 0, 0
	}
	lo, hi = -1, 0
	for _, r := range b.chap {
		if r[1] > r[0] {
			if lo < 0 {
				lo = int(r[0])
			}
			hi = int(r[1])
		}
	}
	if lo < 0 {
		return 0, 0
	}
	return lo, hi
}

type cand struct {
	k Key
	t *Translation
	i int32
}

// Search runs one query over its translations and returns one page.
func Search(ctx context.Context, p SearchParams) (*SearchResult, error) {
	res := &SearchResult{Counts: map[string]int{}}
	var byBook [66]int
	var cands []cand
	after := 0
	ws, buf, low := make([]word, 0, 128), make([]byte, 0, 1024), make([]byte, 0, 1024)
	for _, t := range p.Translations {
		tOrder := canon.TranslationOrder(t.Code)
		lo, hi := t.scope(p.Scope)
		n, kept := 0, 0
		for i := lo; i < hi; i++ {
			if i&1023 == 0 && ctx.Err() != nil {
				return nil, ctx.Err()
			}
			v := &t.verses[i]
			if quickCheck && v.flags&flagASCII != 0 {
				var ok bool
				if low, ok = p.Query.mayMatch(t.words(v), low); !ok {
					continue
				}
			}
			ws, buf = splitWords(t.words(v), ws[:0], buf[:0])
			if !p.Query.matches(ws, buf) {
				continue
			}
			n++
			byBook[v.book]++
			k := Key{int(v.book), int(v.chapter), int(v.verse), tOrder}
			if p.After == nil || p.After.Less(k) {
				after++
				if kept < p.Limit {
					cands = append(cands, cand{k, t, int32(i)})
					kept++
				}
			}
		}
		res.Counts[t.Code] = n
		res.Total += n
	}
	for i, n := range byBook {
		if n > 0 {
			res.ByBook = append(res.ByBook, BookCount{Book: canon.Books[i].ID, Count: n})
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].k.Less(cands[j].k) })
	size := 0
	for _, c := range cands {
		if len(res.Hits) == p.Limit {
			break
		}
		v := &c.t.verses[c.i]
		text := string(c.t.words(v))
		h := Hit{Translation: c.t.Code, Book: canon.Books[v.book].ID, Chapter: int(v.chapter), Verse: int(v.verse),
			VerseEnd: int(v.verseEnd), Text: text, Ranges: p.Query.Ranges(text)}
		size += 120 + len(text) + strings.Count(text, `"`) + 14*len(h.Ranges)
		if p.MaxBytes > 0 && size > p.MaxBytes && len(res.Hits) > 0 {
			break
		}
		res.Hits = append(res.Hits, h)
		res.Last = c.k
	}
	res.More = after > len(res.Hits)
	return res, nil
}

// QueryHash is a short hash of a query's key, scope and translation, so a cursor can't be used for another search.
func QueryHash(translation, scope string, q *Query) string {
	s := sha256.Sum256([]byte(translation + "\x00" + scope + "\x00" + q.Key))
	return hex.EncodeToString(s[:6])
}
