package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T, dir string, opt Options) *Store {
	t.Helper()
	s, err := Open(dir, opt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func str(s string) *string { return &s }

func put(t *testing.T, s *Store, idem string, in MarkInput) PutResult {
	t.Helper()
	raw, _, err := s.PutMark(idem, in)
	if err != nil {
		t.Fatalf("put %+v: %v", in, err)
	}
	var r PutResult
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func reason(err error) string {
	var inv *Invalid
	if errors.As(err, &inv) {
		return inv.Reason
	}
	var nf *NotFound
	if errors.As(err, &nf) {
		return "not_found:" + nf.Reason
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestMarks(t *testing.T) {
	s := open(t, t.TempDir(), Options{})
	b1 := put(t, s, "k1", MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 16, Translation: "bsb"})
	b2 := put(t, s, "k2", MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 16, Label: str("Gospel")})
	if b1.Mark.ID != b2.Mark.ID || b2.Mark.Label != "Gospel" || b2.Mark.Translation != "bsb" || b2.Mark.CreatedAt != b1.Mark.CreatedAt {
		t.Fatalf("one bookmark per verse: %+v then %+v", b1.Mark, b2.Mark)
	}
	if !strings.HasPrefix(b1.Mark.ID, "m") || len(b1.Mark.ID) != 25 {
		t.Fatalf("id %q", b1.Mark.ID)
	}
	h := put(t, s, "k3", MarkInput{Kind: "highlight", Book: "JHN", Chapter: 3, Verse: 16, VerseEnd: 18, Color: "rose"})
	if len(h.Marks) != 3 || h.Mark.ID != h.Marks[0].ID || h.Marks[2].Verse != 18 || h.Marks[1].VerseEnd != 0 {
		t.Fatalf("highlight range %+v", h)
	}
	if s.Prefs().HighlightColor != "rose" {
		t.Fatalf("the last color isn't remembered: %v", s.Prefs().HighlightColor)
	}
	h2 := put(t, s, "k4", MarkInput{Kind: "highlight", Book: "JHN", Chapter: 3, Verse: 17, Color: "green"})
	if h2.Mark.ID != h.Marks[1].ID || h2.Mark.Color != "green" || h2.Marks != nil {
		t.Fatalf("recolor %+v", h2)
	}
	n1 := put(t, s, "k5", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 16, VerseEnd: 17, Text: str("first")})
	put(t, s, "k6", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 16, Text: str("second")})
	n3 := put(t, s, "k7", MarkInput{ID: n1.Mark.ID, Kind: "bookmark", Book: "GEN", Text: str("first, edited")})
	if n3.Mark.Kind != "note" || n3.Mark.Book != "JHN" || n3.Mark.VerseEnd != 17 || n3.Mark.Text != "first, edited" {
		t.Fatalf("a change keeps kind and verses: %+v", n3.Mark)
	}
	got := []string{}
	for _, m := range s.Chapter("JHN", 3) {
		got = append(got, m.Kind+":"+itoa(m.Verse)+"-"+itoa(m.VerseEnd))
	}
	want := []string{"bookmark:16-0", "highlight:16-0", "note:16-0", "note:16-17", "highlight:17-0", "highlight:18-0"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("chapter order %v", got)
	}
	raw, _, err := s.ClearHighlights("k8", "JHN", 3, 15, 17)
	if err != nil || string(raw) != `{"removed":2}` {
		t.Fatalf("clear %s %v", raw, err)
	}
	if _, _, err := s.RemoveMark("k9", "mnope"); reason(err) != "not_found:mark" {
		t.Fatalf("remove unknown: %v", err)
	}
	if _, _, err := s.RemoveMark("k10", b1.Mark.ID); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Count(); n != 3 {
		t.Fatalf("count %d", n)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestMarkValidation(t *testing.T) {
	s := open(t, t.TempDir(), Options{})
	cases := []struct {
		in   MarkInput
		want string
	}{
		{MarkInput{Kind: "star", Book: "JHN", Chapter: 3, Verse: 1}, "kind"},
		{MarkInput{Kind: "bookmark", Book: "XYZ", Chapter: 3, Verse: 1}, "book"},
		{MarkInput{Kind: "bookmark", Book: "JUD", Chapter: 2, Verse: 1}, "chapter"},
		{MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 0}, "verse"},
		{MarkInput{Kind: "bookmark", Book: "PSA", Chapter: 119, Verse: 177}, "verse"},
		{MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 1, VerseEnd: 2}, "verseEnd"},
		{MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 5, VerseEnd: 4, Text: str("x")}, "verseEnd"},
		{MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 1, Label: str(strings.Repeat("é", 81))}, "label"},
		{MarkInput{Kind: "highlight", Book: "JHN", Chapter: 3, Verse: 1, Color: "yellow"}, "color"},
		{MarkInput{Kind: "highlight", Book: "JHN", Chapter: 3, Verse: 1}, "color"},
		{MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 1}, "text"},
		{MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 1, Text: str("")}, "text"},
		{MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 1, Text: str(strings.Repeat("ü", 10001))}, "text"},
		{MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 1, Text: str("x"), Translation: "niv"}, "translation"},
		{MarkInput{ID: "mnope", Kind: "note", Text: str("x")}, "not_found:mark"},
	}
	for _, c := range cases {
		if _, _, err := s.PutMark("", c.in); reason(err) != c.want {
			t.Errorf("%+v: %v, want %s", c.in, err, c.want)
		}
	}
	put(t, s, "", MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 1, Label: str(strings.Repeat("é", 80))})
	put(t, s, "", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 1, Text: str(strings.Repeat("ü", 10000))})
	put(t, s, "", MarkInput{Kind: "bookmark", Book: "JHN", Chapter: 3, Verse: 2, VerseEnd: 2})
	if n, _ := s.Count(); n != 3 {
		t.Fatalf("count %d", n)
	}
}

func TestCaps(t *testing.T) {
	s := open(t, t.TempDir(), Options{MaxMarks: 3, MaxBytes: 4 << 10})
	put(t, s, "", MarkInput{Kind: "bookmark", Book: "GEN", Chapter: 1, Verse: 1})
	if _, _, err := s.PutMark("", MarkInput{Kind: "highlight", Book: "GEN", Chapter: 1, Verse: 1, VerseEnd: 3, Color: "blue"}); !errors.Is(err, ErrFull) {
		t.Fatalf("a range past the marks cap: %v", err)
	}
	h := put(t, s, "", MarkInput{Kind: "highlight", Book: "GEN", Chapter: 1, Verse: 1, VerseEnd: 2, Color: "blue"})
	if _, _, err := s.PutMark("", MarkInput{Kind: "note", Book: "GEN", Chapter: 1, Verse: 1, Text: str("x")}); !errors.Is(err, ErrFull) {
		t.Fatalf("the 4th mark: %v", err)
	}
	// Recoloring an existing highlight adds nothing, so it's allowed at the cap.
	put(t, s, "", MarkInput{Kind: "highlight", Book: "GEN", Chapter: 1, Verse: 2, Color: "amber"})
	if _, _, err := s.RemoveMark("", h.Mark.ID); err != nil {
		t.Fatalf("removing at the cap: %v", err)
	}
	if _, _, err := s.PutMark("", MarkInput{Kind: "note", Book: "GEN", Chapter: 1, Verse: 1, Text: str(strings.Repeat("x", 5000))}); !errors.Is(err, ErrFull) {
		t.Fatalf("past the bytes cap: %v", err)
	}
	put(t, s, "", MarkInput{Kind: "note", Book: "GEN", Chapter: 1, Verse: 1, Text: str("small")})
}

func TestIdemAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	a, _, err := s.PutMark("019a0000-0000-7000-8000-000000000001", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 16, Text: str("once")})
	if err != nil {
		t.Fatal(err)
	}
	b, changed, _ := s.PutMark("019a0000-0000-7000-8000-000000000001", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 16, Text: str("once")})
	if string(a) != string(b) || changed {
		t.Fatalf("replay %s / %s", a, b)
	}
	if _, _, err := s.RemoveMark("019a0000-0000-7000-8000-000000000001", "x"); !errors.Is(err, ErrIdem) {
		t.Fatalf("the key with another method: %v", err)
	}
	rev := s.Rev()
	s.Close()
	s2 := open(t, dir, Options{})
	c, _, err := s2.PutMark("019a0000-0000-7000-8000-000000000001", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 16, Text: str("once")})
	if err != nil || string(c) != string(a) {
		t.Fatalf("after a restart: %s %v", c, err)
	}
	if n, _ := s2.Count(); n != 1 || s2.Rev() != rev {
		t.Fatalf("count %d rev %d/%d", n, s2.Rev(), rev)
	}
	// And after a compaction, from the state file.
	if err := s2.Compact(); err != nil {
		t.Fatal(err)
	}
	s2.Close()
	s3 := open(t, dir, Options{})
	d, _, _ := s3.PutMark("019a0000-0000-7000-8000-000000000001", MarkInput{Kind: "note", Book: "JHN", Chapter: 3, Verse: 16, Text: str("once")})
	if string(d) != string(a) {
		t.Fatalf("after compaction: %s", d)
	}
	if n, _ := s3.Count(); n != 1 {
		t.Fatalf("count %d", n)
	}
}

func TestIdemRetention(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	s := open(t, t.TempDir(), Options{Now: func() time.Time { return now }})
	for i := 0; i < 1005; i++ {
		if _, err := s.SetPrefs("old-"+itoa(i), map[string]json.RawMessage{"footnotes": json.RawMessage(`false`)}); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.idem) != 1005 {
		t.Fatalf("within 24 h every key stays: %d", len(s.idem))
	}
	now = now.Add(25 * time.Hour)
	if _, err := s.SetPrefs("new", map[string]json.RawMessage{"footnotes": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	if len(s.idem) != 1000 || s.idem["new"] == nil || s.idem["old-1004"] == nil || s.idem["old-5"] != nil {
		t.Fatalf("after a day the newest 1,000 stay: %d", len(s.idem))
	}
}

func TestTornLastLine(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	put(t, s, "a", MarkInput{Kind: "bookmark", Book: "GEN", Chapter: 1, Verse: 1})
	s.Close()
	path := filepath.Join(dir, journalFile)
	whole, _ := os.ReadFile(path)
	for _, torn := range []string{`{"seq":2,"at":"2026-11-11T`, "garbage that isn't JSON\n"} {
		_ = os.WriteFile(path, append(append([]byte(nil), whole...), torn...), 0o600)
		s2, err := Open(dir, Options{})
		if err != nil {
			t.Fatal(err)
		}
		if n, _ := s2.Count(); n != 1 {
			t.Fatalf("%q: count %d", torn, n)
		}
		put(t, s2, "b", MarkInput{Kind: "bookmark", Book: "GEN", Chapter: 1, Verse: 2})
		s2.Close()
		s3 := open(t, dir, Options{})
		if n, _ := s3.Count(); n != 2 {
			t.Fatalf("%q: the append after the torn line was lost: %d", torn, n)
		}
		b, _ := os.ReadFile(path)
		if strings.Contains(string(b), "garbage") || strings.Contains(string(b), `"at":"2026-11-11T{`) {
			t.Fatalf("torn line kept:\n%s", b)
		}
		s3.Close()
		_ = os.WriteFile(path, whole, 0o600)
	}
}

func TestKillDuringCompaction(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	for v := 1; v <= 5; v++ {
		put(t, s, "", MarkInput{Kind: "highlight", Book: "GEN", Chapter: 1, Verse: v, Color: "blue"})
	}
	journal, _ := os.ReadFile(filepath.Join(dir, journalFile))
	rev := s.Rev()
	// A kill after the new state was renamed into place, before the journal was replaced: the old journal's lines
	// are all at or below the state's seq, so nothing applies twice.
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	s.Close()
	_ = os.WriteFile(filepath.Join(dir, journalFile), journal, 0o600)
	// And a kill between writing a temp file and renaming it: the temp file is ignored.
	_ = os.WriteFile(filepath.Join(dir, stateFile+".tmp"), []byte(`{"format":"ma-bible-state","version":1,"seq":99}`+"\n{\"mark\":{\"id\":\"mX\""), 0o600)
	s2 := open(t, dir, Options{})
	if n, _ := s2.Count(); n != 5 || s2.Rev() != rev {
		t.Fatalf("count %d rev %d/%d", n, s2.Rev(), rev)
	}
	if _, err := os.Stat(filepath.Join(dir, stateFile+".tmp")); !os.IsNotExist(err) {
		t.Fatal("the temp file is still there")
	}
	put(t, s2, "", MarkInput{Kind: "highlight", Book: "GEN", Chapter: 1, Verse: 6, Color: "blue"})
	s2.Close()
	s3 := open(t, dir, Options{})
	if n, _ := s3.Count(); n != 6 || s3.Rev() != rev+1 {
		t.Fatalf("after: count %d rev %d", n, s3.Rev())
	}
}

func TestAutoCompaction(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	n := put(t, s, "", MarkInput{Kind: "note", Book: "PSA", Chapter: 23, Verse: 1, Text: str("v0")})
	for i := 0; i < 400; i++ {
		put(t, s, "", MarkInput{ID: n.Mark.ID, Text: str(strings.Repeat("typing as I go ", 20) + itoa(i))})
	}
	if s.journalSize > compactFloor+4096 {
		t.Fatalf("the journal wasn't compacted: %d bytes", s.journalSize)
	}
	if _, err := os.Stat(filepath.Join(dir, stateFile)); err != nil {
		t.Fatal("no state file")
	}
	want := s.Chapter("PSA", 23)
	s.Close()
	s2 := open(t, dir, Options{})
	if got := s2.Chapter("PSA", 23); !reflect.DeepEqual(got, want) {
		t.Fatalf("after compaction: %+v", got)
	}
}

func TestPrefs(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{Translations: func(c string) bool { return c == "bsb" || c == "kjv" }})
	if p := s.Prefs(); !reflect.DeepEqual(p, DefaultPrefs()) {
		t.Fatalf("defaults %+v", p)
	}
	raw, err := s.SetPrefs("", map[string]json.RawMessage{"textSize": json.RawMessage(`22`), "unknown": json.RawMessage(`1`),
		"place": json.RawMessage(`{"translation":"kjv","book":"JHN","chapter":3,"verse":16}`)})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"textSize":22,"oneVersePerLine":false,"footnotes":true,"highlightColor":"amber","place":{"translation":"kjv","book":"JHN","chapter":3,"verse":16}}` {
		t.Fatalf("whole prefs: %s", raw)
	}
	bad := map[string]string{
		"textSize": `17`, "oneVersePerLine": `"yes"`, "footnotes": `null`, "highlightColor": `"yellow"`,
		"place": `{"translation":"web","book":"JHN","chapter":3,"verse":1}`,
	}
	for k, v := range bad {
		if _, err := s.SetPrefs("", map[string]json.RawMessage{k: json.RawMessage(v)}); reason(err) != k {
			t.Errorf("%s=%s: %v", k, v, err)
		}
	}
	for _, v := range []string{`{"translation":"bsb","book":"JHN","chapter":22,"verse":1}`, `{"translation":"bsb","book":"JHN","chapter":3}`, `[]`} {
		if _, err := s.SetPrefs("", map[string]json.RawMessage{"place": json.RawMessage(v)}); reason(err) != "place" {
			t.Errorf("place %s: %v", v, err)
		}
	}
	if p := s.Prefs(); p.TextSize != 22 || p.Place.Translation != "kjv" {
		t.Fatalf("a refused set changed something: %+v", p)
	}
	rev := s.Rev()
	if _, err := s.SetPrefs("", map[string]json.RawMessage{"place": json.RawMessage(`null`), "oneVersePerLine": json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	if s.Rev() != rev {
		t.Fatal("prefs moved the marks' rev")
	}
	s.Close()
	s2 := open(t, dir, Options{})
	if p := s2.Prefs(); p.Place != nil || !p.OneVersePerLine || p.TextSize != 22 {
		t.Fatalf("after a restart %+v", p)
	}
}

func TestList(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	s := open(t, t.TempDir(), Options{Now: func() time.Time { now = now.Add(time.Second); return now }})
	refs := [][3]int{{43, 3, 16}, {1, 1, 1}, {19, 23, 1}, {43, 3, 1}, {66, 22, 21}, {1, 1, 3}, {46, 13, 4}}
	books := map[int]string{1: "GEN", 19: "PSA", 43: "JHN", 46: "1CO", 66: "REV"}
	for _, r := range refs {
		put(t, s, "", MarkInput{Kind: "bookmark", Book: books[r[0]], Chapter: r[1], Verse: r[2]})
	}
	put(t, s, "", MarkInput{Kind: "note", Book: "GEN", Chapter: 1, Verse: 1, Text: str("n")})
	page := func(order, kind string, limit int) []string {
		var out []string
		var c *Cursor
		for {
			ms, total, next := s.List(kind, order, c, limit)
			if (kind == "" && total != 8) || (kind == "bookmark" && total != 7) {
				t.Fatalf("total %d", total)
			}
			for _, m := range ms {
				out = append(out, m.Book+itoa(m.Chapter)+":"+itoa(m.Verse)+m.Kind[:1])
			}
			if next == nil {
				return out
			}
			c = next
		}
	}
	canonWant := []string{"GEN1:1b", "GEN1:1n", "GEN1:3b", "PSA23:1b", "JHN3:1b", "JHN3:16b", "1CO13:4b", "REV22:21b"}
	if got := page("canon", "", 3); !reflect.DeepEqual(got, canonWant) {
		t.Fatalf("canon %v", got)
	}
	recentWant := []string{"GEN1:1n", "1CO13:4b", "GEN1:3b", "REV22:21b", "JHN3:1b", "PSA23:1b", "GEN1:1b", "JHN3:16b"}
	if got := page("recent", "", 2); !reflect.DeepEqual(got, recentWant) {
		t.Fatalf("recent %v", got)
	}
	if got := page("canon", "bookmark", 50); len(got) != 7 {
		t.Fatalf("bookmarks %v", got)
	}
	// A page doesn't shift when a mark before the cursor goes.
	ms, _, next := s.List("", "canon", nil, 3)
	_, _, _ = s.RemoveMark("", ms[0].ID)
	ms2, _, _ := s.List("", "canon", next, 3)
	if ms2[0].Book != "PSA" {
		t.Fatalf("shifted: %+v", ms2[0])
	}
}

func TestNewerFormat(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, journalFile), []byte(`{"format":"ma-bible-journal","version":2}`+"\n"), 0o600)
	if err := CheckFormat(dir); !errors.Is(err, ErrNewerFormat) {
		t.Fatalf("check: %v", err)
	}
	if _, err := Open(dir, Options{}); !errors.Is(err, ErrNewerFormat) {
		t.Fatalf("open: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, journalFile))
	if !strings.Contains(string(b), `"version":2`) {
		t.Fatal("a newer journal was touched")
	}
}

func TestRevGrows(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	r0 := s.Rev()
	m := put(t, s, "", MarkInput{Kind: "bookmark", Book: "GEN", Chapter: 1, Verse: 1})
	_, changed, _ := s.RemoveMark("", m.Mark.ID)
	if s.Rev() != r0+2 || !changed {
		t.Fatalf("rev %d", s.Rev())
	}
	_, changed, _ = s.ClearHighlights("", "GEN", 1, 1, 0)
	if changed || s.Rev() != r0+2 {
		t.Fatalf("clearing nothing moved rev: %d", s.Rev())
	}
}

// TestBigRepliesOnDisk: a reply over 1 KiB isn't kept in memory, and every replay of it, from the journal, after a
// restart, and from the state after one and two compactions, is the first reply byte for byte.
func TestBigRepliesOnDisk(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	long := strings.Repeat("A long note. ", 200)
	in := MarkInput{Kind: "note", Book: "ROM", Chapter: 8, Verse: 28, Text: &long}
	first, _, err := s.PutMark("big", in)
	if err != nil || len(first) <= smallReply {
		t.Fatalf("put: %d bytes, %v", len(first), err)
	}
	small, _, _ := s.PutMark("small", MarkInput{Kind: "bookmark", Book: "ROM", Chapter: 8, Verse: 1})
	if s.idem["big"].Res != nil || s.idem["small"].Res == nil {
		t.Fatal("the big reply is in memory, or the small one isn't")
	}
	check := func(s *Store, when string) {
		t.Helper()
		for key, want := range map[string]json.RawMessage{"big": first, "small": small} {
			in := in
			if key == "small" {
				in = MarkInput{Kind: "bookmark", Book: "ROM", Chapter: 8, Verse: 1}
			}
			got, changed, err := s.PutMark(key, in)
			if err != nil || changed || string(got) != string(want) {
				t.Fatalf("%s, %s: %v %v, %d bytes", when, key, err, changed, len(got))
			}
		}
		if n, _ := s.Count(); n != 2 {
			t.Fatalf("%s: %d marks", when, n)
		}
	}
	check(s, "from the journal")
	s.Close()
	s = open(t, dir, Options{})
	check(s, "after a restart")
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	check(s, "from the state")
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	check(s, "after a second compaction")
	s.Close()
	s = open(t, dir, Options{})
	check(s, "after a restart from the state")
}
