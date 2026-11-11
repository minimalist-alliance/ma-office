package text

import (
	"strings"
	"unicode"

	"github.com/minimalist-alliance/ma-desk/apps/bible/internal/canon"
)

// Reading a reference as a member types it (API.md, "Reading a reference").

// abbrevs are the common short names, without the number of a numbered book. A numbered book's names need its number.
var abbrevs = map[string][]string{
	"GEN": {"ge", "gn"}, "EXO": {"ex", "exod"}, "LEV": {"le", "lv"}, "NUM": {"nu", "nm", "nb"},
	"DEU": {"deut", "de", "dt"}, "JOS": {"josh", "jsh"}, "JDG": {"judg", "jg", "jdgs"}, "RUT": {"rth", "ru"},
	"1SA": {"sam", "sa", "sm", "samuel"}, "2SA": {"sam", "sa", "sm", "samuel"},
	"1KI": {"kgs", "ki", "kin", "kings", "kngs"}, "2KI": {"kgs", "ki", "kin", "kings", "kngs"},
	"1CH": {"chr", "ch", "chron", "chronicles"}, "2CH": {"chr", "ch", "chron", "chronicles"},
	"EZR": {"ezr"}, "NEH": {"ne"}, "EST": {"esth", "es"}, "JOB": {"jb"},
	"PSA": {"ps", "psalm", "pss", "psm", "pslm"}, "PRO": {"prov", "pr", "prv"},
	"ECC": {"eccl", "ec", "eccles", "qoh", "qoheleth"},
	"SNG": {"song", "sos", "so", "songofsongs", "songofsolomon", "canticles", "cant", "ss"},
	"ISA": {"is"}, "JER": {"je", "jr"}, "LAM": {"la"}, "EZK": {"ezek", "eze"}, "DAN": {"da", "dn"},
	"HOS": {"ho"}, "JOL": {"jl"}, "AMO": {"am"}, "OBA": {"obad", "ob"}, "JON": {"jnh"}, "MIC": {"mc"},
	"NAM": {"nah", "na"}, "HAB": {"hb"}, "ZEP": {"zeph", "zp"}, "HAG": {"hg"}, "ZEC": {"zech", "zc"}, "MAL": {"ml"},
	"MAT": {"matt", "mt"}, "MRK": {"mk", "mr"}, "LUK": {"lk"}, "JHN": {"jn", "joh"}, "ACT": {"ac"},
	"ROM": {"ro", "rm"}, "1CO": {"cor", "co", "corinthians"}, "2CO": {"cor", "co", "corinthians"}, "GAL": {"ga"},
	"EPH": {"ephes"}, "PHP": {"phil", "pp"}, "COL": {}, "1TH": {"thess", "th", "thes", "thessalonians"},
	"2TH": {"thess", "th", "thes", "thessalonians"}, "1TI": {"tim", "ti", "tm", "timothy"},
	"2TI": {"tim", "ti", "tm", "timothy"}, "TIT": {}, "PHM": {"philem", "phlm", "pm"}, "HEB": {"he"},
	"JAS": {"jm", "jam"}, "1PE": {"pet", "pe", "pt", "p", "peter"}, "2PE": {"pet", "pe", "pt", "p", "peter"},
	"1JN": {"john", "jn", "jhn", "jo", "j"}, "2JN": {"john", "jn", "jhn", "jo", "j"}, "3JN": {"john", "jn", "jhn", "jo", "j"},
	"JUD": {"jd"}, "REV": {"re", "rv", "revelations"},
}

// names maps a compact key (the number, if any, then letters only) to a canon index; full holds the full names.
var names, full = func() (map[string]int, map[string]int) {
	n, f := map[string]int{}, map[string]int{}
	for i, b := range canon.Books {
		num := ""
		if b.ID[0] >= '1' && b.ID[0] <= '3' {
			num = b.ID[:1]
		}
		f[compact(b.Name)] = i
		n[compact(b.Name)] = i
		n[strings.ToLower(b.ID)] = i
		short := strings.ToLower(b.ID)
		if num != "" {
			short = short[1:]
		}
		n[num+short] = i
		for _, a := range abbrevs[b.ID] {
			n[num+a] = i
		}
	}
	return n, f
}()

// compact lower-cases and keeps only letters and digits: "1 Corinthians" -> "1corinthians".
func compact(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// parsed is a reference as typed, before it's checked against a translation.
type parsed struct {
	book                int // canon index
	fullName            bool
	hasNumber, hasVerse bool
	chapter, verse      int
	end, endChapter     int // 0 if not given
	chapterEnd          int // "John 3-4": 4; in a one-chapter book, the end of a verse range
}

var numberWords = map[string]string{"1": "1", "2": "2", "3": "3", "i": "1", "ii": "2", "iii": "3", "first": "1",
	"second": "2", "third": "3", "1st": "1", "2nd": "2", "3rd": "3"}

// parseRef reads q, or returns false if it isn't a reference. extra are this translation's own book names.
func parseRef(q string, extra map[string]int) (parsed, bool) {
	s := []rune(strings.TrimSpace(strings.ToLower(q)))
	i := 0
	skip := func() {
		for i < len(s) && (s[i] == ' ' || s[i] == '.' || s[i] == '\t') {
			i++
		}
	}
	// The book's number: "1", "1st", "i", "first" ... before a space, or a digit right before a letter ("1cor").
	num := ""
	j := i
	for j < len(s) && (unicode.IsLetter(s[j]) || unicode.IsDigit(s[j])) {
		j++
	}
	if w, ok := numberWords[string(s[i:j])]; ok && j < len(s) && (s[j] == ' ' || s[j] == '.') {
		num, i = w, j
		skip()
	} else if i < len(s) && s[i] >= '1' && s[i] <= '3' && i+1 < len(s) && unicode.IsLetter(s[i+1]) {
		num, i = string(s[i]), i+1
	}
	// The name: letters, spaces and full stops, up to the first digit.
	var name strings.Builder
	for i < len(s) && !unicode.IsDigit(s[i]) {
		r := s[i]
		switch {
		case unicode.IsLetter(r):
			b, _ := foldRune(nil, r)
			name.Write(b)
		case r == ' ' || r == '.' || r == '\t':
		default:
			return parsed{}, false
		}
		i++
	}
	key := num + name.String()
	if name.Len() == 0 {
		return parsed{}, false
	}
	p := parsed{book: -1}
	if b, ok := names[key]; ok {
		p.book = b
	} else if b, ok := extra[key]; ok {
		p.book = b
	} else if len(name.String()) >= 3 {
		// A start of exactly one book's full name: "deuter", "ecclesi".
		for k, b := range full {
			if strings.HasPrefix(k, key) {
				if p.book >= 0 && p.book != b {
					return parsed{}, false
				}
				p.book = b
			}
		}
	}
	if p.book < 0 {
		return parsed{}, false
	}
	_, p.fullName = full[key]
	if _, ok := extra[key]; ok {
		p.fullName = true
	}
	// Numbers: chapter [sep verse [dash end [sep verse2]]], or with one chapter and a dash, a chapter range.
	number := func() int {
		skipSpace(s, &i)
		n, k := 0, i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' && i-k < 4 {
			n = n*10 + int(s[i]-'0')
			i++
		}
		if i == k {
			return -1
		}
		return n
	}
	sep := func(set string) bool {
		skipSpace(s, &i)
		if i < len(s) && strings.ContainsRune(set, s[i]) {
			i++
			return true
		}
		return false
	}
	if i == len(s) {
		return p, true
	}
	p.hasNumber = true
	if p.chapter = number(); p.chapter < 0 {
		return parsed{}, false
	}
	if sep(":.") {
		if p.verse = number(); p.verse < 0 {
			return parsed{}, false
		}
		p.hasVerse = true
		if sep("-–—") {
			if a := number(); a >= 0 {
				if sep(":.") {
					if b := number(); b >= 0 {
						p.endChapter, p.end = a, b
					}
				} else {
					p.end = a
				}
			}
		}
	} else if sep("-–—") {
		p.chapterEnd = max(number(), 0) // a chapter range goes to its start
	}
	skipSpace(s, &i)
	if i < len(s) {
		return parsed{}, false
	}
	return p, true
}

func skipSpace(s []rune, i *int) {
	for *i < len(s) && s[*i] == ' ' {
		*i++
	}
}

// bookNames are a translation's own names as extra keys, so its spelling ("Song of Songs") is always read.
func (t *Translation) bookNames() map[string]int {
	m := make(map[string]int, len(t.books))
	for _, b := range t.books {
		m[compact(b.Name)] = b.Canon
	}
	return m
}

// Lookup reads q as a reference and clamps it to this translation. false if it isn't one, or names a book this
// translation doesn't have.
func (t *Translation) Lookup(q string) (Ref, bool) {
	p, ok := parseRef(q, t.bookNames())
	if !ok {
		return Ref{}, false
	}
	return t.clamp(p)
}

// LookupStrict is Lookup for search: only a reference with a chapter number, or a book's full name alone.
func (t *Translation) LookupStrict(q string) (Ref, bool) {
	p, ok := parseRef(q, t.bookNames())
	if !ok || (!p.hasNumber && !p.fullName) {
		return Ref{}, false
	}
	return t.clamp(p)
}

func (t *Translation) clamp(p parsed) (Ref, bool) {
	b := t.byCanon[p.book]
	if b == nil {
		return Ref{}, false
	}
	ch, v, end, hasVerse := p.chapter, p.verse, p.end, p.hasVerse
	if canon.Books[p.book].Chapters == 1 && p.hasNumber && !p.hasVerse {
		// One chapter: "Jude 5" is verse 5, "Jude 3-5" verses 3 to 5.
		ch, v, end, hasVerse = 1, p.chapter, p.chapterEnd, true
	}
	if p.endChapter > 0 {
		if p.endChapter > ch {
			end = b.MaxVerse(clampInt(ch, 1, b.Chapters))
		} else if p.endChapter < ch {
			end = 0
		}
	}
	ch = clampInt(ch, 1, b.Chapters)
	r := Ref{Book: b.ID, Chapter: ch}
	if hasVerse {
		mv := b.MaxVerse(ch)
		if mv == 0 {
			return r, true
		}
		r.Verse = clampInt(v, 1, mv)
		if end > r.Verse {
			r.VerseEnd = clampInt(end, 1, mv)
			if r.VerseEnd <= r.Verse {
				r.VerseEnd = 0
			}
		}
	}
	return r, true
}

func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}
