package text

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"
)

const fixtures = "../../server/testdata/texts"

func lib(t *testing.T) *Library {
	t.Helper()
	return NewLibrary(fixtures, "")
}

func get(t *testing.T, l *Library, code string) *Translation {
	t.Helper()
	tr, err := l.Get(code)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

// u16 is the UTF-16 offset of the first occurrence of sub in s, at or after from.
func u16(s, sub string, from int) [2]int {
	i := strings.Index(s[from:], sub) + from
	return [2]int{len(utf16.Encode([]rune(s[:i]))), len(utf16.Encode([]rune(s[:i+len(sub)])))}
}

func TestFold(t *testing.T) {
	cases := map[string][]string{
		"LORD’S":            {"lord", "s"},
		"Lord's":            {"lord", "s"},
		"café naïve Élan":   {"cafe", "naive", "elan"},
		"Beth-el — beth‑el": {"beth", "el", "beth", "el"},
		"Æsop Straße Œuvre": {"aesop", "strasse", "oeuvre"},
		"“light,” and":      {"light", "and"},
		"éte Naʿaman":      {"ete", "naaman"},
		"x 𐤀 10,000":        {"x", "𐤀", "10", "000"},
		"Łódź Ğ":            {"lodz", "g"},
		" ... ":             {},
	}
	for in, want := range cases {
		if got := Fold(in); !reflect.DeepEqual(got, want) && !(len(got) == 0 && len(want) == 0) {
			t.Errorf("Fold(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLibrary(t *testing.T) {
	l := lib(t)
	if got := l.Codes(); !reflect.DeepEqual(got, []string{"bsb", "web", "kjv", "asv"}) {
		t.Fatalf("codes %v", got)
	}
	if _, err := l.Get("niv"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("niv: %v", err)
	}
	s, err := l.File("bsb", "STATEMENT.txt")
	if err != nil || !strings.HasPrefix(s, "Fixture") {
		t.Fatalf("statement %q %v", s, err)
	}
}

func TestBrokenAndChecked(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []string{"bsb", "kjv"} {
		_ = os.MkdirAll(filepath.Join(dir, c), 0o755)
		for _, f := range []string{c + ".tsv", "books.tsv", "STATEMENT.txt", "SOURCE.md"} {
			b, _ := os.ReadFile(filepath.Join(fixtures, c, f))
			_ = os.WriteFile(filepath.Join(dir, c, f), b, 0o644)
		}
	}
	// A wrong header makes kjv unreadable; bsb still works.
	_ = os.WriteFile(filepath.Join(dir, "kjv", "kjv.tsv"), []byte("# ma-bible-text 3 kjv\nV\tGEN\t1\t1\tp\tx\n"), 0o644)
	// A manifest whose hash for bsb's text is wrong.
	man := filepath.Join(dir, "ma-app.json")
	_ = os.WriteFile(man, []byte(`{"files":{"texts/bsb/bsb.tsv":{"sha256":"`+strings.Repeat("0", 64)+`","size":1,"mode":"0644"}}}`), 0o644)
	l := NewLibrary(dir, man)
	if _, err := l.Get("kjv"); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("kjv: %v", err)
	}
	if _, err := l.Get("bsb"); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("bsb with a wrong hash: %v", err)
	}
	if l2 := NewLibrary(dir, ""); l2 != nil {
		if _, err := l2.Get("bsb"); err != nil {
			t.Fatalf("bsb unchecked: %v", err)
		}
	}
}

func TestChapter(t *testing.T) {
	tr := get(t, lib(t), "bsb")
	b := tr.Book("GEN")
	items, ok := tr.Chapter(b, 1)
	if !ok {
		t.Fatal("no GEN 1")
	}
	kinds := []string{}
	for _, it := range items {
		k := it.Kind
		if k == "heading" {
			k += ":" + it.Level
		}
		kinds = append(kinds, k)
	}
	if want := "heading:1 heading:r verse verse heading:2 verse verse"; strings.Join(kinds, " ") != want {
		t.Fatalf("items %v", kinds)
	}
	if v := items[2]; v.Verse != 1 || !v.P || len(v.Notes) != 1 || v.Notes[0].At != 3 || v.Notes[0].Text != "Or “When God began to create”" {
		t.Fatalf("verse 1 %+v", v)
	}
	if v := items[6]; v.Verse != 4 || v.VerseEnd != 5 {
		t.Fatalf("joined verse %+v", v)
	}
	if got := b.Verses(); !reflect.DeepEqual(got, []int{5, 4}) {
		t.Fatalf("GEN verses %v", got)
	}
	prev, next := tr.Neighbors(b, 1)
	if prev != nil || next == nil || *next != (Ref{Book: "GEN", Chapter: 2}) {
		t.Fatalf("GEN 1 neighbors %v %v", prev, next)
	}
	prev, next = tr.Neighbors(tr.Book("JHN"), 3)
	if *prev != (Ref{Book: "SNG", Chapter: 2}) || *next != (Ref{Book: "1CO", Chapter: 13}) {
		t.Fatalf("JHN 3 neighbors %v %v", prev, next)
	}
	if _, next = tr.Neighbors(tr.Book("REV"), 22); next != nil {
		t.Fatalf("after Revelation 22: %v", next)
	}

	if h := items[4]; len(h.Notes) != 1 || h.Notes[0] != (Note{At: 4, Text: "Or “The Day One”"}) {
		t.Fatalf("a heading's note %+v", h)
	}
	if v := items[5]; len(v.Segments) != 2 || !reflect.DeepEqual(v.Segments[0], Segment{Kind: "prose", At: 0, Text: "And God said, “"}) ||
		v.Segments[1].Kind != "poetry" || v.Segments[1].Level != 1 || v.Segments[1].At != 15 {
		t.Fatalf("a boundary with no space %+v", v.Segments)
	}
	g2, _ := tr.Chapter(b, 2)
	if sg := g2[1].Segments; len(sg) != 2 || sg[1].Kind != "indent" || !sg[1].P || sg[1].At != 68 {
		t.Fatalf("an indented paragraph %+v", sg)
	}

	ps, _ := tr.Chapter(tr.Book("PSA"), 23)
	if ps[0].Level != "1" || ps[1].Level != "d" || ps[1].Text != "A Psalm of David." {
		t.Fatalf("psalm headings %+v", ps[:2])
	}
	v1, v3 := ps[2], ps[4]
	if !v1.Q || !v1.P || len(v1.Segments) != 2 || !reflect.DeepEqual(v1.Segments[1], Segment{Kind: "poetry", Level: 2, At: 25, Text: "I shall not want."}) {
		t.Fatalf("psalm 23:1 %+v", v1)
	}
	if !v3.B || !v3.Segments[0].B || v3.Segments[2].Kind != "prose" || len(v3.Notes) != 1 || v3.Notes[0].At != 52 {
		t.Fatalf("psalm 23:3 %+v", v3)
	}
	sng, _ := tr.Chapter(tr.Book("SNG"), 2)
	if sg := sng[0].Segments; len(sg) != 3 || sg[1].Kind != "heading" || sg[1].Level != "2" || sg[1].At != 23 ||
		len(sg[1].Notes) != 1 || sg[1].Notes[0].At != 4 || !sg[2].B || sg[2].At != 23 {
		t.Fatalf("a heading inside a verse %+v", sg)
	}
	rev, _ := tr.Chapter(tr.Book("REV"), 22)
	if len(rev) != 2 || rev[0].Segments[1].Kind != "title" || rev[1].Kind != "heading" || rev[1].Level != "e" ||
		rev[1].Notes[0].At != 8 {
		t.Fatalf("an end note after the last verse %+v", rev)
	}
	kjv := get(t, lib(t), "kjv")
	co, _ := kjv.Chapter(kjv.Book("1CO"), 13)
	if len(co) != 2 || co[1].Level != "e" {
		t.Fatalf("a subscription %+v", co)
	}
	for _, it := range append(append(items, ps...), sng...) {
		checkSegments(t, it)
	}
	if _, ok := tr.Chapter(tr.Book("JHN"), 1); ok {
		t.Fatal("JHN 1 isn't in the fixture")
	}
	if s, ok := tr.VerseText("GEN", 1, 5); !ok || !strings.HasPrefix(s, "And God saw") {
		t.Fatalf("verse 5 is in the joined 4-5: %q", s)
	}
}

// checkSegments: a verse's segments, other than headings, partition its text in order, with zero or one space between.
func checkSegments(t *testing.T, it Item) {
	t.Helper()
	if it.Kind != "verse" || len(it.Segments) == 0 {
		return
	}
	u := utf16.Encode([]rune(it.Text))
	pos := 0
	for _, sg := range it.Segments {
		if sg.Kind == "heading" {
			continue
		}
		n := len(utf16.Encode([]rune(sg.Text)))
		if sg.At != pos && !(sg.At == pos+1 && u[pos] == ' ') {
			t.Fatalf("%d: segment at %d after %d", it.Verse, sg.At, pos)
		}
		if string(utf16.Decode(u[sg.At:sg.At+n])) != sg.Text {
			t.Fatalf("%d: segment %q isn't at %d", it.Verse, sg.Text, sg.At)
		}
		pos = sg.At + n
	}
	if pos != len(u) {
		t.Fatalf("%d: segments end at %d of %d", it.Verse, pos, len(u))
	}
}

func TestFormatRefusals(t *testing.T) {
	cases := map[string]string{
		"format 1":         "# ma-bible-text 1 bsb\nV\tGEN\t1\t1\tp\tx\n",
		"G without H":      "# ma-bible-text 2 bsb\nV\tGEN\t1\t1\tp\tx\nG\tGEN\t1\t1\t0\tn\n",
		"Q before a verse": "# ma-bible-text 2 bsb\nQ\tGEN\t1\t1\t1\tx\nV\tGEN\t1\t1\tp\tx\n",
		"unknown kind":     "# ma-bible-text 2 bsb\nV\tGEN\t1\t1\tp\tx\nX\tGEN\t1\t1\t1\tx\n",
		"out of order":     "# ma-bible-text 2 bsb\nV\tGEN\t2\t1\tp\tx\nV\tGEN\t1\t1\tp\tx\n",
		"another code":     "# ma-bible-text 2 kjv\nV\tGEN\t1\t1\tp\tx\n",
	}
	for name, body := range cases {
		dir := t.TempDir()
		_ = os.MkdirAll(filepath.Join(dir, "bsb"), 0o755)
		_ = os.WriteFile(filepath.Join(dir, "bsb", "books.tsv"), []byte("GEN\tGenesis\t2\n"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, "bsb", "bsb.tsv"), []byte(body), 0o644)
		if _, err := NewLibrary(dir, "").Get("bsb"); !errors.Is(err, ErrUnreadable) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestNoteOffsetsAreUTF16(t *testing.T) {
	if got := utf16At("a𐤀b", 2); got != 3 {
		t.Fatalf("after a non-BMP character: %d", got)
	}
	if got := utf16At("ab", 9); got != 2 {
		t.Fatalf("clamped: %d", got)
	}
}

func TestLookup(t *testing.T) {
	tr := get(t, lib(t), "bsb")
	cases := map[string]string{
		"jn 3:16":                 "JHN 3:16",
		"John 3":                  "JHN 3",
		"john":                    "JHN 1",
		"1 Cor 13:4-7":            "1CO 13:4-7",
		"1cor13":                  "1CO 13",
		"First Corinthians 13:13": "1CO 13:13",
		"Ps 23":                   "PSA 23",
		"psalm 23:1":              "PSA 23:1",
		"song 2":                  "SNG 2",
		"Song of Songs 2:1":       "SNG 2:1",
		"Song of Solomon 2":       "SNG 2",
		"I John 4:8":              "1JN 4:8",
		"1st jn 4.8":              "1JN 4:8",
		"rev22":                   "REV 22",
		"Rev. 22:21":              "REV 22:21",
		"Gen. 1.1":                "GEN 1:1",
		"Gen 1:1-2:3":             "GEN 1:1-5",
		"Gen 1:3–4":               "GEN 1:3-4",
		"gen 9":                   "GEN 2",
		"John 3:99":               "JHN 3:17",
		"John 3:0":                "JHN 3:1",
		"John 3:17-16":            "JHN 3:17",
		"John 3-4":                "JHN 3",
		"Jude 5":                  "JUD 1:5",
		"Jude 3-5":                "JUD 1:3-5",
		"genes 1":                 "GEN 1",
		"  JHN 3 : 16 ":           "JHN 3:16",
	}
	for q, want := range cases {
		r, ok := tr.Lookup(q)
		got := "-"
		if ok {
			got = refString(r)
		}
		if got != want {
			t.Errorf("Lookup(%q) = %s, want %s", q, got, want)
		}
	}
	for _, q := range []string{"love", "jo 3", "deut 1", "3:16", "John 3:16 x", "phi 1", "", "\"in the beginning\"", "bless*"} {
		if r, ok := tr.Lookup(q); ok {
			t.Errorf("Lookup(%q) = %v, want none", q, r)
		}
	}
	strict := map[string]string{"john": "JHN 1", "jn 3": "JHN 3", "jn": "-", "love": "-", "is": "-", "Song of Songs": "SNG 1"}
	for q, want := range strict {
		r, ok := tr.LookupStrict(q)
		got := "-"
		if ok {
			got = refString(r)
		}
		if got != want {
			t.Errorf("LookupStrict(%q) = %s, want %s", q, got, want)
		}
	}
}

func refString(r Ref) string {
	s := r.Book + " " + itoa(r.Chapter)
	if r.Verse > 0 {
		s += ":" + itoa(r.Verse)
	}
	if r.VerseEnd > 0 {
		s += "-" + itoa(r.VerseEnd)
	}
	return s
}

func itoa(n int) string { return strconv.Itoa(n) }

func search(t *testing.T, l *Library, codes []string, q, scope string, after *Key, limit int) *SearchResult {
	t.Helper()
	query, err := ParseQuery(q)
	if err != nil {
		t.Fatalf("%q: %v", q, err)
	}
	var trs []*Translation
	for _, c := range codes {
		trs = append(trs, get(t, l, c))
	}
	res, err := Search(context.Background(), SearchParams{Translations: trs, Scope: scope, Query: query, After: after, Limit: limit, MaxBytes: 240 << 10})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func refsOf(res *SearchResult) []string {
	out := []string{}
	for _, h := range res.Hits {
		r := h.Book + " " + itoa(h.Chapter) + ":" + itoa(h.Verse)
		if h.VerseEnd > 0 {
			r += "-" + itoa(h.VerseEnd)
		}
		out = append(out, h.Translation+" "+r)
	}
	return out
}

func TestSearchSemantics(t *testing.T) {
	l := lib(t)
	bsb := []string{"bsb"}
	cases := []struct {
		q, scope string
		want     []string
	}{
		{"love", "all", []string{"bsb 1CO 13:4", "bsb 1CO 13:6", "bsb 1CO 13:13", "bsb 1JN 4:8"}},
		{"LOVE", "all", []string{"bsb 1CO 13:4", "bsb 1CO 13:6", "bsb 1CO 13:13", "bsb 1JN 4:8"}},
		{"loved", "all", []string{"bsb JHN 3:16"}},
		{"lov*", "all", []string{"bsb JHN 3:16", "bsb 1CO 13:4", "bsb 1CO 13:6", "bsb 1CO 13:13", "bsb 1JN 4:8"}},
		{"love", "ot", []string{}},
		{"love", "nt", []string{"bsb 1CO 13:4", "bsb 1CO 13:6", "bsb 1CO 13:13", "bsb 1JN 4:8"}},
		{"love", "1JN", []string{"bsb 1JN 4:8"}},
		{`"in the beginning"`, "all", []string{"bsb GEN 1:1"}},
		{`"the beginning in"`, "all", []string{}},
		{`"in the begin*"`, "all", []string{"bsb GEN 1:1"}},
		{"faith hope", "all", []string{"bsb 1CO 13:13"}},
		{"hope faith", "all", []string{"bsb 1CO 13:13"}},
		{"faith egypt", "all", []string{}},
		{"faith,hope", "all", []string{"bsb 1CO 13:13"}},
		{"darkness", "all", []string{"bsb GEN 1:2", "bsb GEN 1:4-5"}},
		{"CAFÉ", "all", []string{"bsb GEN 2:4"}},
		{"naive elan", "all", []string{"bsb GEN 2:4"}},
		{"lord's", "all", []string{"bsb GEN 2:4"}},
		{"beth-el", "all", []string{"bsb GEN 2:4"}},
		{"bethel", "all", []string{}},
		{"“light,”", "all", []string{"bsb GEN 1:3", "bsb GEN 1:4-5"}},
		{"𐤀", "all", []string{"bsb GEN 2:4"}},
		{"shepherd", "all", []string{"bsb PSA 23:1"}},
	}
	for _, c := range cases {
		got := refsOf(search(t, l, bsb, c.q, c.scope, nil, 50))
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q in %s: %v, want %v", c.q, c.scope, got, c.want)
		}
	}
}

func TestSearchRanges(t *testing.T) {
	l := lib(t)
	res := search(t, l, []string{"bsb"}, "love", "1CO", nil, 50)
	h := res.Hits[0]
	if !reflect.DeepEqual(h.Ranges, [][2]int{{0, 4}, {17, 21}}) {
		t.Fatalf("love ranges %v in %q", h.Ranges, h.Text)
	}
	res = search(t, l, []string{"bsb"}, "lord's quoted beth-el 𐤀 cafe", "all", nil, 50)
	h = res.Hits[0]
	s := h.Text
	want := [][2]int{u16(s, "café", 0), u16(s, "𐤀", 0), u16(s, "LORD’S", 0), u16(s, "quoted", 0), u16(s, "Beth-el", 0),
		u16(s, "beth el", 0), u16(s, "Lord’s", 0)}
	if !reflect.DeepEqual(h.Ranges, want) {
		t.Fatalf("ranges %v, want %v in %q", h.Ranges, want, s)
	}
	// The non-BMP letter takes two UTF-16 units, so everything after it is one further than its code points.
	if want[2][0] != len([]rune(s[:strings.Index(s, "LORD")]))+1 {
		t.Fatalf("UTF-16 offsets don't count the surrogate pair: %v", want[2])
	}
	res = search(t, l, []string{"bsb"}, `bless* "the lord"`, "all", nil, 50)
	if len(res.Hits) != 1 || !reflect.DeepEqual(res.Hits[0].Ranges, [][2]int{u16(s, "the LORD", 0), u16(s, "the Lord", 0), u16(s, "blessing", 0)}) {
		t.Fatalf("prefix and phrase ranges %v", res.Hits)
	}
}

func TestSearchAllAndCursor(t *testing.T) {
	l := lib(t)
	all := []string{"bsb", "web", "kjv", "asv"}
	res := search(t, l, all, "love", "all", nil, 50)
	want := []string{"bsb 1CO 13:4", "bsb 1CO 13:6", "bsb 1CO 13:13", "bsb 1JN 4:8", "web 1JN 4:8", "kjv 1JN 4:8"}
	if got := refsOf(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("all: %v", got)
	}
	if res.Total != 6 || !reflect.DeepEqual(res.Counts, map[string]int{"bsb": 4, "web": 1, "kjv": 1, "asv": 0}) || res.More {
		t.Fatalf("total %d counts %v more %v", res.Total, res.Counts, res.More)
	}
	if !reflect.DeepEqual(res.ByBook, []BookCount{{"1CO", 3}, {"1JN", 3}}) {
		t.Fatalf("byBook %v", res.ByBook)
	}
	// Pages of 4, then 2: the same hits in the same order, and no more.
	var pages []string
	var after *Key
	for i := 0; i < 5; i++ {
		res = search(t, l, all, "love", "all", after, 4)
		pages = append(pages, refsOf(res)...)
		if res.Total != 6 {
			t.Fatalf("total on page %d: %d", i, res.Total)
		}
		if !res.More {
			break
		}
		k := res.Last
		after = &k
	}
	if !reflect.DeepEqual(pages, want) {
		t.Fatalf("paged: %v", pages)
	}
	// "God" is everywhere: limit 1, every page one hit, never a repeat.
	res = search(t, l, all, "god", "all", nil, 1)
	seen := map[string]bool{}
	n := 0
	for {
		for _, r := range refsOf(res) {
			if seen[r] {
				t.Fatalf("%s twice", r)
			}
			seen[r] = true
			n++
		}
		if !res.More {
			break
		}
		k := res.Last
		res = search(t, l, all, "god", "all", &k, 1)
	}
	if n != res.Total {
		t.Fatalf("paged %d of %d", n, res.Total)
	}
}

func TestQueryLimits(t *testing.T) {
	for _, q := range []string{"", "   ", "***", "\"", "!!", strings.Repeat("a ", 13), strings.Repeat("x", 201)} {
		if _, err := ParseQuery(q); err == nil {
			t.Errorf("%q: no error", q)
		}
	}
	for _, q := range []string{strings.Repeat("a ", 12), strings.Repeat("x", 200), "love love love"} {
		if _, err := ParseQuery(q); err != nil {
			t.Errorf("%q: %v", q, err)
		}
	}
	a, _ := ParseQuery("hope faith")
	b, _ := ParseQuery("Faith  HOPE")
	if a.Key != b.Key {
		t.Fatalf("keys %q %q", a.Key, b.Key)
	}
}

func TestLowerASCII(t *testing.T) {
	var all []byte
	for c := 0; c < 0x80; c++ {
		all = append(all, byte(c))
	}
	all = append(all, "“Ab” — ’Q’ É"...)
	for n := 0; n <= len(all); n++ {
		got := lowerASCII(nil, all[:n])
		want := []byte(string(all[:n]))
		for i, c := range want {
			if c >= 'A' && c <= 'Z' {
				want[i] = c + 0x20
			}
		}
		if string(got) != string(want) {
			t.Fatalf("%d bytes: %q", n, got)
		}
	}
}

// sameWithAndWithoutQuickCheck searches each query with the ASCII quick check and without it: everything must match.
func sameWithAndWithoutQuickCheck(t *testing.T, l *Library, queries []string) {
	t.Helper()
	var trs []*Translation
	for _, c := range l.Codes() {
		trs = append(trs, get(t, l, c))
	}
	defer func() { quickCheck = true }()
	for _, q := range queries {
		query, err := ParseQuery(q)
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		var res [2]*SearchResult
		for i, on := range []bool{true, false} {
			quickCheck = on
			res[i], err = Search(context.Background(), SearchParams{Translations: trs, Scope: "all", Query: query, Limit: 200, MaxBytes: 240 << 10})
			if err != nil {
				t.Fatal(err)
			}
		}
		if !reflect.DeepEqual(res[0], res[1]) {
			t.Errorf("%q: %d hits with the quick check, %d without (%v / %v)", q, res[0].Total, res[1].Total, res[0].Counts, res[1].Counts)
		}
	}
}

var quickQueries = []string{"love", "LOVE", "lov*", "CAFÉ", "café", "naïve élan", "Élan", "“light,”", "‘light’", "lord's", "LORD’S",
	"lord’s", "beth-el", "beth—el", "𐤀", "Æsop", "ætas", "straße", `"in the beginning"`, `"in the begin*"`, "faith hope", "bless*",
	"god", "the", "a", "selah", "egypt", "Égypte", "10", "x*", "naïve*", "ﬁre", "Ǆ"}

func TestQuickCheckChangesNothing(t *testing.T) {
	sameWithAndWithoutQuickCheck(t, lib(t), quickQueries)
}

func TestQuickCheckChangesNothingOnRealTexts(t *testing.T) {
	sameWithAndWithoutQuickCheck(t, realLib(t), append(quickQueries, "he’s", "o’er", "Jehovah", "LORD", "naaman", "Sela", "amen*",
		"Bethel", "Beth-el", "Mahershalalhashbaz", "Maher-shalal-hash-baz", "ÉLOÏ", "eloi", "Abba"))
}
