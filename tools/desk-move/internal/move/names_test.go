package move

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// escape is the JSON escape desk-data sends for a byte that isn't UTF-8, such as escape("dce9") for 0xe9.
func escape(unit string) []byte { return []byte("\\" + "u" + unit) }

// Names that aren't UTF-8 came across as desk-data's \udcXX escapes, which Go's JSON read as U+FFFD: data.read of
// that name was not_found, the file counted as gone, and the move said done without it, a database included.
func TestNamesThatArentUTF8(t *testing.T) {
	h := newHarness(t)
	h.desk.PageSize = 2 // so the cursor lands on names that aren't UTF-8 too
	files := map[string][]byte{
		"files/caf\xe9.txt":         random(3000),
		"files/x\xe9":               []byte("a name with the byte 0xe9"),
		"files/x\xef\xbf\xbd":       []byte("a name with a real U+FFFD, which the other used to read as"),
		"files/d\xff\xfe/in\x80.md": random(100),
		"agent/r\xe9sum\xe9.db":     sqlite(50000),
	}
	for rel, data := range files {
		put(t, filepath.Join(h.src, rel), data, 0o600)
	}
	link(t, "caf\xe9.txt", filepath.Join(h.src, "files/l\xe9"))
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	for rel := range files {
		fileEq(t, filepath.Join(h.src, rel), filepath.Join(h.dst, rel))
	}
	if target, err := os.Readlink(filepath.Join(h.dst, "files/l\xe9")); err != nil || target != "caf\xe9.txt" {
		t.Errorf("the link: %q, %v", target, err)
	}
	// The journal reads each name back as itself, so a rerun skips what's done and the check finds it.
	j := readJournal(filepath.Join(h.dst, ".ma-move/mv-test1/journal.jsonl"))
	for rel, data := range files {
		part, path, _ := strings.Cut(rel, "/")
		if je, ok := j.get(part, path); !ok || je.Bytes != int64(len(data)) {
			t.Errorf("journal for %q: %+v %v", rel, je, ok)
		}
	}
	// The database is read again in the last pass, by its own name.
	if got := readsOf(h.desk.Stats(), "agent", "r\xe9sum\xe9.db"); len(got) != 2 {
		t.Errorf("the database was read %d times, want 2", len(got))
	}
	for _, r := range h.desk.Stats().Reads {
		if strings.Contains(r.Path, "\xef\xbf\xbd") && r.Path != "x\xef\xbf\xbd" {
			t.Errorf("a read of a name with U+FFFD in it: %q", r.Path)
		}
	}
}

// A name the mover can't make exactly stops the move with nothing here changed: it's never skipped.
func TestNameThatCantBeCarriedStopsTheMove(t *testing.T) {
	h := newHarness(t)
	put(t, filepath.Join(h.src, "files/caf\xe9.txt"), []byte("x"), 0o600)
	h.desk.EditManifest = func(part string, page []byte) []byte {
		return bytes.ReplaceAll(page, escape("dce9"), escape("dc01")) // a lone surrogate desk-data never sends
	}
	before := snapshot(t, h.dst, true)
	if code := h.run(context.Background()); code != ExitFailed {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	sameTree(t, before, snapshot(t, h.dst, true))
	if out := h.out.String(); !strings.Contains(out, "whose name this desk can't carry") {
		t.Errorf("what the member read:\n%s", out)
	}
	if r := h.lastReport(); r.State != "failed" || r.Error != "copy_failed" {
		t.Errorf("last report %+v", r)
	}
}
