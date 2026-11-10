package move

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fakedesk"
)

// walWriter is a program keeping a database open in WAL mode, as desk-agent keeps agent.db: its writes stay in the
// -wal, and the main file's size and mtime don't move until a checkpoint (about 4 MB) or the last connection closes.
const walWriter = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute("pragma journal_mode=wal")
db.execute("create table if not exists thread (id integer primary key, body text)")
print("ready", flush=True)
for line in sys.stdin:
    db.execute("insert into thread (body) values (?)", (line.strip(),))
    print("ok", flush=True)
`

const dbRead = `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
print(json.dumps({"integrity": db.execute("pragma integrity_check").fetchone()[0],
                  "rows": [r[0] for r in db.execute("select body from thread order by id")]}))
`

type writer struct {
	t   *testing.T
	in  io.WriteCloser
	out *bufio.Scanner
}

func startWriter(t *testing.T, python, db string) *writer {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(python, "-I", "-c", walWriter, db)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = in.Close()
		_ = cmd.Wait()
	})
	w := &writer{t: t, in: in, out: bufio.NewScanner(out)}
	if !w.out.Scan() || w.out.Text() != "ready" {
		t.Fatalf("the writer didn't start: %q", w.out.Text())
	}

	return w
}

func (w *writer) write(body string) {
	if _, err := io.WriteString(w.in, body+"\n"); err != nil {
		w.t.Error(err)

		return
	}
	if !w.out.Scan() || w.out.Text() != "ok" {
		w.t.Errorf("the writer didn't answer: %q", w.out.Text())
	}
}

// The real failure: real desk-data, a real WAL database with its writer still running, and a row written between
// the passes that shows in neither the main file's size nor its mtime. Then the database is opened on the target.
func TestRealHelperWALWriteBetweenPasses(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3, which desk-data needs")
	}
	if err := exec.Command(python, "-I", "-c", "import sqlite3").Run(); err != nil {
		t.Skip("python3 has no sqlite3, which desk-data needs")
	}
	for _, tc := range []struct {
		name  string
		crash bool
	}{{"in one run", false}, {"a rerun after a crash between the passes", true}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			if err := os.RemoveAll(filepath.Join(h.src, "desk/notebook")); err != nil { // fewer helper processes
				t.Fatal(err)
			}
			h.desk.Helper = &fakedesk.RealHelper{
				Python:  python,
				Runner:  "../../rehearsal/helper-run.py",
				Program: "../../../desk-data/desk-data",
				Root:    h.src,
				Logs:    t.TempDir(),
			}
			db := filepath.Join(h.src, "agent/agent.db")
			w := startWriter(t, python, db)
			w.write("before the first pass")
			source := snapshot(t, h.src, false)

			var main1, main2 os.FileInfo
			var wal1, wal2 os.FileInfo
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			h.desk.OnManifest = func(part string, n int) {
				if part != "agent" || n != 2 {
					return
				}
				var err1, err2, err3, err4 error
				main1, err1 = os.Stat(db)
				wal1, err2 = os.Stat(db + "-wal")
				w.write("between the passes")
				main2, err3 = os.Stat(db)
				wal2, err4 = os.Stat(db + "-wal")
				for _, err := range []error{err1, err2, err3, err4} {
					if err != nil {
						t.Error(err)
					}
				}
				if tc.crash {
					cancel()
				}
			}
			if tc.crash {
				if code := h.run(ctx); code != ExitFailed {
					t.Fatalf("first run: exit %d\n%s", code, h.out.String())
				}
				if _, err := os.Stat(filepath.Join(h.dst, "agent/agent.db")); err == nil {
					t.Fatal("the cut-short run changed this desk's data")
				}
				h.desk.OnManifest = nil
			}
			if code := h.run(context.Background()); code != ExitDone {
				t.Fatalf("exit %d\n%s", code, h.out.String())
			}

			// What makes this the failure: the row is in the -wal, and the main file shows nothing.
			if main1 == nil || main2 == nil || wal1 == nil || wal2 == nil {
				t.Fatal("the write between the passes didn't happen")
			}
			if main1.Size() != main2.Size() || !main1.ModTime().Equal(main2.ModTime()) {
				t.Errorf("the write moved the main file: %d %v, then %d %v", main1.Size(), main1.ModTime(), main2.Size(), main2.ModTime())
			}
			if wal2.Size() <= wal1.Size() {
				t.Errorf("the -wal didn't grow: %d, then %d", wal1.Size(), wal2.Size())
			}

			// The journal holds the manifest's size, and what was read: a copy with the -wal in it is bigger.
			mv := filepath.Join(h.dst, ".ma-move/mv-test1")
			je, ok := readJournal(filepath.Join(mv, "journal.jsonl")).get("agent", "agent.db")
			if !ok || je.Size != main1.Size() || je.Bytes == je.Size {
				t.Errorf("journal: %+v (ok %v), main file %d", je, ok, main1.Size())
			}

			// One whole file, nothing beside it, with the row in it.
			target := filepath.Join(h.dst, "agent/agent.db")
			for _, sib := range []string{"-wal", "-journal", "-shm"} {
				if _, err := os.Lstat(target + sib); err == nil {
					t.Errorf("%s came across", sib)
				}
			}
			out, err := exec.Command(python, "-I", "-c", dbRead, target).Output()
			if err != nil {
				t.Fatal(err)
			}
			var got struct {
				Integrity string   `json:"integrity"`
				Rows      []string `json:"rows"`
			}
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if got.Integrity != "ok" || !slices.Equal(got.Rows, []string{"before the first pass", "between the passes"}) {
				t.Errorf("the moved database: %+v", got)
			}

			// The cloud desk: nothing changed but the writer's own -wal and -shm, and the helper's scratch.
			after := snapshot(t, h.src, false)
			for _, tree := range []map[string]node{source, after} {
				for k := range tree {
					if strings.HasPrefix(k, ".ma-export-tmp") || k == "agent/agent.db-wal" || k == "agent/agent.db-shm" {
						delete(tree, k)
					}
				}
			}
			sameTree(t, source, after)

			// A file that isn't SQLite, unchanged: one read, whichever run it was.
			if got := readsOf(h.desk.Stats(), "agent", "memory.json"); len(got) != 1 {
				t.Errorf("agent/memory.json was read %d times", len(got))
			}
		})
	}
}

// Names that aren't UTF-8, through the real desk-data: a file, a directory and a WAL database with its writer still
// running, each named with a byte that isn't UTF-8. They used to come across as U+FFFD, be not_found and count as
// gone, and the move said done without them. Now each arrives under its own name, and the database opens with its
// rows.
func TestRealHelperNamesThatArentUTF8(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3, which desk-data needs")
	}
	if err := exec.Command(python, "-I", "-c", "import sqlite3").Run(); err != nil {
		t.Skip("python3 has no sqlite3, which desk-data needs")
	}
	h := newHarness(t)
	if err := os.RemoveAll(filepath.Join(h.src, "desk/notebook")); err != nil { // fewer helper processes
		t.Fatal(err)
	}
	h.desk.Helper = &fakedesk.RealHelper{
		Python:  python,
		Runner:  "../../rehearsal/helper-run.py",
		Program: "../../../desk-data/desk-data",
		Root:    h.src,
		Logs:    t.TempDir(),
	}
	plain := map[string][]byte{
		"files/caf\xe9.txt":     []byte("a plain file"),
		"files/d\xff/in\x80.md": []byte("in a directory whose name isn't UTF-8"),
	}
	for rel, data := range plain {
		put(t, filepath.Join(h.src, rel), data, 0o600)
	}
	db := filepath.Join(h.src, "agent/th\xe9.db")
	w := startWriter(t, python, db)
	w.write("before the first pass")
	h.desk.OnManifest = func(part string, n int) {
		if part == "agent" && n == 2 {
			w.write("between the passes")
		}
	}
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	for rel := range plain {
		fileEq(t, filepath.Join(h.src, rel), filepath.Join(h.dst, rel))
	}
	out, err := exec.Command(python, "-I", "-c", dbRead, filepath.Join(h.dst, "agent/th\xe9.db")).Output()
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Integrity string   `json:"integrity"`
		Rows      []string `json:"rows"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Integrity != "ok" || !slices.Equal(got.Rows, []string{"before the first pass", "between the passes"}) {
		t.Errorf("the moved database: %+v", got)
	}
	if _, ok := readJournal(filepath.Join(h.dst, ".ma-move/mv-test1/journal.jsonl")).get("agent", "th\xe9.db"); !ok {
		t.Error("the database isn't in the journal under its own name")
	}
}
