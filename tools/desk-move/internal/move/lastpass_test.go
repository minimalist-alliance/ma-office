package move

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// rewriteUnseen gives a file new bytes at the same size and mtime. To the manifest it hasn't changed, and to
// data.read it has: what a write to a database's -wal does.
func rewriteUnseen(t *testing.T, name string) {
	t.Helper()
	fi, err := os.Stat(name)
	if err != nil {
		t.Error(err)

		return
	}
	old, err := os.ReadFile(name)
	if err != nil {
		t.Error(err)

		return
	}
	head := min(len(sqliteMagic), len(old))
	fresh := append(append([]byte(nil), old[:head]...), random(len(old)-head)...)
	if err := os.WriteFile(name, fresh, fi.Mode()); err != nil {
		t.Error(err)

		return
	}
	if err := os.Chtimes(name, fi.ModTime(), fi.ModTime()); err != nil {
		t.Error(err)
	}
}

func offsetsOf(h *harness, part, rel string, from int) []int64 {
	var out []int64
	for _, r := range h.desk.Stats().Reads[from:] {
		if r.Part == part && r.Path == rel {
			out = append(out, r.Offset)
		}
	}

	return out
}

// Every SQLite file in every part is read again on the last pass, from 0, though the manifest shows no change.
// Everything else keeps the size and mtime check.
func TestLastPassRereadsSQLiteInEveryPart(t *testing.T) {
	h := newHarness(t)
	s := h.src
	dbs := []string{"agent/agent.db", "apps/notes/data/notes.db", "desk/chat.db", "desk/notebook/sync/pages.db"}
	for i := range 12 {
		dbs = append(dbs, fmt.Sprintf("desk/notebook/sync/%02d.db", i))
	}
	for _, rel := range dbs {
		put(t, filepath.Join(s, rel), sqlite(30000), 0o600)
	}
	page := filepath.Join(s, "desk/notebook/page-00.md")
	var pageBefore []byte
	h.desk.OnManifest = func(part string, n int) {
		if n != 2 {
			return
		}
		for _, rel := range dbs {
			if strings.HasPrefix(rel, part+"/") {
				rewriteUnseen(t, filepath.Join(s, rel))
			}
		}
		if part == "desk" {
			pageBefore, _ = os.ReadFile(page)
			rewriteUnseen(t, page)
		}
	}
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	for _, rel := range dbs {
		fileEq(t, filepath.Join(s, rel), filepath.Join(h.dst, rel))
		part, inPart, _ := strings.Cut(rel, "/")
		if got := offsetsOf(h, part, inPart, 0); !slices.Equal(got, []int64{0, 0}) {
			t.Errorf("%s: reads at offsets %v, want two from 0", rel, got)
		}
	}
	for _, rel := range []string{"desk/notebook/page-00.md", "desk/notebook/page-39.md", "agent/memory.json", "apps/notes/data/n.txt", "browser/downloads/report.pdf"} {
		part, inPart, _ := strings.Cut(rel, "/")
		if got := offsetsOf(h, part, inPart, 0); len(got) != 1 {
			t.Errorf("%s isn't SQLite and didn't change, and was read %d times", rel, len(got))
		}
	}
	if got, _ := os.ReadFile(filepath.Join(h.dst, "desk/notebook/page-00.md")); !bytes.Equal(got, pageBefore) {
		t.Error("a file that isn't SQLite was copied again though its size and mtime hadn't changed")
	}
	if st := h.desk.Stats(); st.MaxActive > 8 {
		t.Errorf("reads in flight peaked at %d", st.MaxActive)
	}
	last := h.api.reports[len(h.api.reports)-1]
	if last.State != "done" || last.Checks != (ReportChecks{Passed: 5}) {
		t.Errorf("done report: %+v", last)
	}
}

// A SQLite file the last pass can't read means no "done", whichever way the read fails, and a rerun that can
// read it finishes with the newer bytes.
func TestLastPassSQLiteReadFails(t *testing.T) {
	const rel = "chat.db"
	failing := func(n int) bool { return n >= 2 } // the first pass reads it once, and it works
	for _, tc := range []struct {
		name  string
		setup func(h *harness)
		clear func(h *harness)
	}{
		{"the helper fails part way", func(h *harness) {
			h.desk.FailRead = func(part, p string, n int) bool { return part == "desk" && p == rel && failing(n) }
		}, func(h *harness) { h.desk.FailRead = nil }},
		{"it arrives damaged", func(h *harness) {
			h.desk.CorruptRead = func(part, p string, n int) bool { return part == "desk" && p == rel && failing(n) }
		}, func(h *harness) { h.desk.CorruptRead = nil }},
		{"the helper refuses", func(h *harness) {
			h.desk.OnRead = func(part, p string, n int) string {
				if part == "desk" && p == rel && failing(n) {
					return "unavailable"
				}

				return ""
			}
		}, func(h *harness) { h.desk.OnRead = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			chat := filepath.Join(h.src, "desk", rel)
			h.desk.OnManifest = func(part string, n int) {
				if part == "desk" && n == 2 {
					rewriteUnseen(t, chat)
				}
			}
			tc.setup(h)
			before := snapshot(t, h.dst, true)
			if code := h.run(context.Background()); code != ExitRefused {
				t.Fatalf("exit %d\n%s", code, h.out.String())
			}
			out := h.out.String()
			if strings.Contains(out, "Your desk is moved") || !strings.Contains(out, "1 file couldn't be checked") {
				t.Errorf("output: %s", out)
			}
			if slices.Contains(h.api.states(), "done") {
				t.Errorf("reported done: %v", h.api.states())
			}
			if last := h.api.reports[len(h.api.reports)-1]; last.State != "failed" || last.Error != "checksum_mismatch" {
				t.Errorf("last report: %+v", last)
			}
			sameTree(t, before, snapshot(t, h.dst, true))
			if len(h.sd.list()) != 0 {
				t.Errorf("services were touched: %v", h.sd.list())
			}
			mv := filepath.Join(h.dst, ".ma-move/mv-test1")
			if _, ok := readJournal(filepath.Join(mv, "journal.jsonl")).get("desk", rel); ok {
				t.Error("the journal still vouches for a file the last pass couldn't read")
			}

			tc.clear(h)
			h.desk.OnManifest = nil
			h.out.Reset()
			if code := h.run(context.Background()); code != ExitDone {
				t.Fatalf("rerun: exit %d\n%s", code, h.out.String())
			}
			if h.api.claims != 1 {
				t.Errorf("claims: %d", h.api.claims)
			}
			fileEq(t, chat, filepath.Join(h.dst, "desk", rel))
		})
	}
}

// A crash between the passes: the rerun's first pass skips the database, and its last pass still reads it.
func TestRerunAfterCrashBetweenPasses(t *testing.T) {
	h := newHarness(t)
	chat := filepath.Join(h.src, "desk/chat.db")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.desk.OnManifest = func(part string, n int) {
		if part == "desk" && n == 2 {
			rewriteUnseen(t, chat)
			cancel()
		}
	}
	if code := h.run(ctx); code != ExitFailed {
		t.Fatalf("first run: exit %d\n%s", code, h.out.String())
	}
	if _, err := os.Stat(filepath.Join(h.dst, "desk/old.txt")); err != nil {
		t.Fatal("the cut-short run changed this desk's data")
	}
	h.desk.OnManifest = nil
	rewriteUnseen(t, chat) // and again while nothing's running
	from := len(h.desk.Stats().Reads)
	h.out.Reset()
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("rerun: exit %d\n%s", code, h.out.String())
	}
	if h.api.claims != 1 {
		t.Errorf("claims: %d", h.api.claims)
	}
	if got := offsetsOf(h, "desk", "chat.db", from); !slices.Equal(got, []int64{0}) {
		t.Errorf("the rerun read chat.db at offsets %v, want once from 0", got)
	}
	if got := offsetsOf(h, "desk", "notebook/page-00.md", from); len(got) != 0 {
		t.Errorf("the rerun read a journaled file that isn't SQLite: %v", got)
	}
	fileEq(t, chat, filepath.Join(h.dst, "desk/chat.db"))
}

// A crash part way through a forced read leaves part of one backup and no journal line. The rerun carries on from
// there against a newer backup: the trailer covers the whole file, so that can't pass, and it starts again from 0.
func TestCrashMidReadCannotSplice(t *testing.T) {
	h := newHarness(t)
	chat := filepath.Join(h.src, "desk/chat.db")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.desk.OnManifest = func(part string, n int) {
		if part == "desk" && n == 2 {
			cancel()
		}
	}
	if code := h.run(ctx); code != ExitFailed {
		t.Fatalf("first run: exit %d\n%s", code, h.out.String())
	}
	h.desk.OnManifest = nil

	// What the crash leaves: planJobs took the journal line away first, then the read got halfway.
	mv := filepath.Join(h.dst, ".ma-move/mv-test1")
	j, err := openJournal(filepath.Join(mv, "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if err := j.remove("desk", "chat.db"); err != nil {
		t.Fatal(err)
	}
	if err := j.close(); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(mv, "stage/desk/chat.db")
	fi, err := os.Stat(staged)
	if err != nil {
		t.Fatal(err)
	}
	half := fi.Size() / 2
	if err := os.Truncate(staged, half); err != nil {
		t.Fatal(err)
	}
	rewriteUnseen(t, chat)

	from := len(h.desk.Stats().Reads)
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("rerun: exit %d\n%s", code, h.out.String())
	}
	if got := offsetsOf(h, "desk", "chat.db", from); !slices.Equal(got, []int64{half, 0, 0}) {
		t.Errorf("reads at offsets %v, want %d (the first pass carrying on), 0 (its trailer failed), 0 (the last pass)", got, half)
	}
	fileEq(t, chat, filepath.Join(h.dst, "desk/chat.db"))
}

// The session drops part way through a forced read and the database changes: the new session's read carries on
// against a newer backup, which can't pass the trailer, and reads from 0.
func TestDropDuringForcedReadCannotSplice(t *testing.T) {
	h := newHarness(t)
	chat := filepath.Join(h.src, "desk/chat.db")
	put(t, chat, sqlite(3<<20), 0o600) // past the first 1 MiB of credit, so the drop comes after some of it was written
	h.desk.OnRead = func(part, rel string, n int) string {
		if part == "desk" && rel == "chat.db" && n == 2 {
			// This read's bytes are already taken. It sends those, then the session drops, and the next read gets new ones.
			h.desk.DropAfterBytes = 1500 * 1024
			rewriteUnseen(t, chat)
		}

		return ""
	}
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	got := offsetsOf(h, "desk", "chat.db", 0)
	if len(got) != 4 || got[0] != 0 || got[1] != 0 || got[2] <= 0 || got[3] != 0 {
		t.Errorf("reads at offsets %v, want 0, 0, then carrying on, then 0", got)
	}
	fileEq(t, chat, filepath.Join(h.dst, "desk/chat.db"))
}

// What a failed first pass left is part of an older backup. The last pass starts it from 0, not from there.
func TestForcedFileRestartsFromZero(t *testing.T) {
	h := newHarness(t)
	chat := filepath.Join(h.src, "desk/chat.db")
	h.desk.FailRead = func(part, rel string, n int) bool { return part == "desk" && rel == "chat.db" && n <= 4 }
	h.desk.OnManifest = func(part string, n int) {
		if part == "desk" && n == 2 {
			staged := filepath.Join(h.dst, ".ma-move/mv-test1/stage/desk/chat.db")
			if fi, err := os.Stat(staged); err != nil || fi.Size() == 0 {
				t.Errorf("the failed first pass left no part of the file: %v", err)
			}
			rewriteUnseen(t, chat)
		}
	}
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	got := offsetsOf(h, "desk", "chat.db", 0)
	if len(got) != 5 || got[4] != 0 {
		t.Errorf("reads at offsets %v, want the last pass's from 0", got)
	}
	fileEq(t, chat, filepath.Join(h.dst, "desk/chat.db"))
}

// A staged file that can't be read counts as SQLite: the cost is a read again, and the other way is a skip.
func TestIsSQLite(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "db"), sqlite(10), 0o600)
	put(t, filepath.Join(dir, "text"), bytes.Repeat([]byte("x"), 100), 0o600)
	put(t, filepath.Join(dir, "short"), []byte("SQLite"), 0o600)
	put(t, filepath.Join(dir, "empty"), nil, 0o600)
	for name, want := range map[string]bool{"db": true, "text": false, "short": false, "empty": false, "missing": true, ".": true} {
		if got := isSQLite(filepath.Join(dir, name)); got != want {
			t.Errorf("%s: %v, want %v", name, got, want)
		}
	}
}
