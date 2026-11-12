package text

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// The package's real texts (apps/bible/texts/), when they're in the tree: every translation reads, every line is where
// the format says, and the joins and offsets hold for every verse.

const realTexts = "../../texts"

func realLib(t *testing.T) *Library {
	t.Helper()
	b, err := os.ReadFile(realTexts + "/bsb/bsb.tsv")
	if err != nil {
		t.Skip("the real texts aren't in this tree")
	}
	if !strings.HasPrefix(string(b), "# ma-bible-text "+Format+" ") {
		t.Skip("the real texts in this tree aren't format " + Format)
	}
	return NewLibrary(realTexts, "")
}

func TestRealTextsRead(t *testing.T) {
	l := realLib(t)
	want := map[string]int{"bsb": 31086, "web": 31098, "kjv": 31102, "asv": 31086}
	for _, code := range l.Codes() {
		t0 := time.Now()
		tr, err := l.Get(code)
		if err != nil {
			t.Fatalf("%s: %v", code, err)
		}
		took := time.Since(t0)
		if len(tr.verses) != want[code] || len(tr.books) != 66 {
			t.Errorf("%s: %d verses, %d books", code, len(tr.verses), len(tr.books))
		}
		segments, notes, inner, ends, headNotes, both := 0, 0, 0, 0, 0, 0
		for _, b := range tr.books {
			for ch := 1; ch <= b.Chapters; ch++ {
				items, ok := tr.Chapter(b, ch)
				if !ok {
					t.Fatalf("%s %s %d missing", code, b.ID, ch)
				}
				for _, it := range items {
					if it.Kind != "verse" {
						headNotes += len(it.Notes)
						if it.Level == "e" {
							ends++
						}
						continue
					}
					for _, sg := range it.Segments {
						if sg.Kind == "heading" {
							inner++
							headNotes += len(sg.Notes)
						}
						if sg.P && sg.B {
							both++
						}
					}
					checkSegments(t, it)
					segments += len(it.Segments)
					n := len(utf16.Encode([]rune(it.Text)))
					for _, f := range it.Notes {
						if f.At < 0 || f.At > n || f.Text == "" {
							t.Fatalf("%s %s %d:%d: note at %d of %d", code, b.ID, ch, it.Verse, f.At, n)
						}
					}
					notes += len(it.Notes)
				}
			}
		}
		t.Logf("%s: %d verses, %d segments (%d headings inside a verse, %d with pb), %d end notes, %d verse footnotes, %d heading footnotes, read in %v",
			code, len(tr.verses), segments, inner, both, ends, notes, headNotes, took.Round(time.Millisecond))
	}
}

func TestRealSearchAndLookup(t *testing.T) {
	l := realLib(t)
	bsb, _ := l.Get("bsb")
	for q, want := range map[string]string{"jn 3:16": "JHN 3:16", "Ps 23": "PSA 23", "song 2": "SNG 2", "I John 4:8": "1JN 4:8",
		"rev22": "REV 22", "1 Cor 13:4-7": "1CO 13:4-7", "Ps 119:200": "PSA 119:176", "Jude 25": "JUD 1:25", "obad 21": "OBA 1:21"} {
		r, ok := bsb.Lookup(q)
		if !ok || refString(r) != want {
			t.Errorf("Lookup(%q) = %v %v, want %s", q, r, ok, want)
		}
	}
	var trs []*Translation
	for _, c := range l.Codes() {
		tr, _ := l.Get(c)
		trs = append(trs, tr)
	}
	for _, c := range []struct {
		q    string
		min  int
		more string
	}{
		{"love", 280, ""}, {`"in the beginning"`, 2, ""}, {"bless*", 400, ""}, {"faith hope", 5, ""}, {"lord's", 100, ""},
	} {
		q, _ := ParseQuery(c.q)
		res, err := Search(context.Background(), SearchParams{Translations: trs[:1], Scope: "all", Query: q, Limit: 50, MaxBytes: 240 << 10})
		if err != nil || res.Total < c.min {
			t.Errorf("%q in bsb: %d hits (%v)", c.q, res.Total, err)
		}
	}
	q, _ := ParseQuery("god")
	res, _ := Search(context.Background(), SearchParams{Translations: trs, Scope: "all", Query: q, Limit: 200, MaxBytes: 240 << 10})
	if len(res.Hits) == 0 || res.Total < 10000 {
		t.Errorf("god in all: %d of %d", len(res.Hits), res.Total)
	}
	t.Logf("god in all four: %d verses (%v), a page of %d", res.Total, res.Counts, len(res.Hits))
}

// TestNotices: every translation's NOTICE.txt, what the About sheet shows, is only paragraphs found word for word in
// its STATEMENT.txt, one line each, a blank line between, LF, a newline at the end.
func TestNotices(t *testing.T) {
	for _, dir := range []string{realTexts, fixtures} {
		for _, code := range []string{"bsb", "web", "kjv", "asv"} {
			notice, err := os.ReadFile(dir + "/" + code + "/NOTICE.txt")
			if os.IsNotExist(err) && dir == realTexts {
				t.Skip("the real texts aren't in this tree")
			}
			statement, err2 := os.ReadFile(dir + "/" + code + "/STATEMENT.txt")
			if err != nil || err2 != nil {
				t.Fatalf("%s %s: %v %v", dir, code, err, err2)
			}
			n := string(notice)
			if strings.Contains(n, "\r") || !strings.HasSuffix(n, "\n") || strings.HasSuffix(n, "\n\n") || !utf8.ValidString(n) {
				t.Fatalf("%s %s: not UTF-8 with LF and one newline at the end", dir, code)
			}
			for i, p := range strings.Split(strings.TrimSuffix(n, "\n"), "\n\n") {
				if p == "" || strings.Contains(p, "\n") || p != strings.TrimSpace(p) {
					t.Fatalf("%s %s: paragraph %d isn't one line between single blank lines", dir, code, i+1)
				}
				if !strings.Contains(string(statement), p) {
					t.Fatalf("%s %s: paragraph %d isn't word for word in STATEMENT.txt: %q", dir, code, i+1, p)
				}
			}
		}
	}
}
