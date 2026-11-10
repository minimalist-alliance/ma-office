package move

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/cdp"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/session"
)

func TestMoveEndToEnd(t *testing.T) {
	h := newHarness(t)
	selfhost := snapshot(t, filepath.Join(h.dst, "selfhost"), false)
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	s, d := h.src, h.dst
	out := h.out.String()
	for _, want := range []string{"Your desk is moved. 4 parts, 51 files", "every file checked.", "2 of 2 sign-in cookies work here.", "Your cloud desk's files are unchanged. Your cloud desk's Browser stays stopped", "2 shortcuts that pointed outside their folder were left out."} {
		if !strings.Contains(out, want) {
			t.Errorf("summary lacks %q:\n%s", want, out)
		}
	}

	// Every file came across, byte for byte.
	for _, rel := range []string{"browser/profile/Default/History", "browser/profile/Default/Cookies", "browser/profile/Last Version",
		"browser/profile/Default/Local Storage/leveldb/000003.log", "browser/downloads/report.pdf", "desk/notebook/page-39.md",
		"desk/chat.db", "agent/memory.json", "apps/notes/data/n.txt"} {
		fileEq(t, filepath.Join(s, rel), filepath.Join(d, rel))
	}
	if fi, err := os.Stat(filepath.Join(d, "browser/downloads/report.pdf")); err != nil || fi.Mode().Perm() != 0o640 {
		t.Errorf("report.pdf mode: %v %v", fi.Mode(), err)
	}
	// Links as links; absolute or escaping ones refused.
	if tgt, err := os.Readlink(filepath.Join(d, "browser/profile/Default/prefs-link")); err != nil || tgt != "Preferences" {
		t.Errorf("prefs-link: %q %v", tgt, err)
	}
	for _, rel := range []string{"browser/profile/Default/abs-link", "browser/profile/Default/escape-link", "browser/profile/Cache", "browser-readable"} {
		if _, err := os.Lstat(filepath.Join(d, rel)); err == nil {
			t.Errorf("%s shouldn't be here", rel)
		}
	}

	// This desk's own data went to before/, and its machine files stayed.
	mv := filepath.Join(d, ".ma-move", "mv-test1")
	if b, _ := os.ReadFile(filepath.Join(mv, "before/desk/old.txt")); string(b) != "this desk's own" {
		t.Errorf("before/desk/old.txt: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(mv, "before/browser/profile/Default/Cookies")); string(b) != "old cookies" {
		t.Errorf("before/ lost this desk's old Cookies: %q", b)
	}
	if _, err := os.Stat(filepath.Join(d, "desk/old.txt")); err == nil {
		t.Error("desk/old.txt is still live; it should be in before/")
	}
	if b, _ := os.ReadFile(filepath.Join(d, "desk/volume.json")); string(b) != `{"volumeId":"vol-target"}` {
		t.Errorf("desk/volume.json isn't this desk's: %s", b)
	}
	if b, _ := os.ReadFile(filepath.Join(d, "apps/registry.json")); !strings.Contains(string(b), "2001") {
		t.Errorf("apps/registry.json isn't this desk's: %s", b)
	}
	if b, _ := os.ReadFile(filepath.Join(d, "apps/notes/releases/2.0/bin")); string(b) != "installed app" {
		t.Errorf("this desk's installed app is gone: %q", b)
	}
	if tgt, _ := os.Readlink(filepath.Join(d, "apps/notes/current")); tgt != "releases/2.0" {
		t.Errorf("apps/notes/current: %q", tgt)
	}
	if _, err := os.Stat(filepath.Join(d, "apps/notes/releases/1.0")); err == nil {
		t.Error("the cloud desk's app release came across")
	}
	sameTree(t, selfhost, snapshot(t, filepath.Join(h.dst, "selfhost"), false))
	for _, r := range h.desk.Stats().Reads {
		if r.Part == "selfhost" {
			t.Errorf("read the cloud desk's selfhost/%s", r.Path)
		}
	}
	for rel, mode := range map[string]os.FileMode{"browser": 0o750, "browser/profile": 0o700, "browser/downloads": 0o750, "desk": 0o750} {
		if fi, err := os.Stat(filepath.Join(d, rel)); err != nil || fi.Mode().Perm() != mode {
			t.Errorf("%s: mode %v, want %v (%v)", rel, fi.Mode().Perm(), mode, err)
		}
	}
	for rel, want := range map[string]string{"rtc/key": "target key", "desk-egress/state.json": `{"t":1}`, ".ma-volume": `{"volumeId":"vol-target"}`, "files/kept.txt": "a part only this desk has"} {
		if b, _ := os.ReadFile(filepath.Join(d, rel)); string(b) != want {
			t.Errorf("%s changed: %q", rel, b)
		}
	}

	// Owners by part, through the injected chown.
	for rel, uid := range map[string]int{
		"browser": 1102, "browser/profile/Default/History": 1102, "browser/profile/Default/prefs-link": 1102,
		"desk": 1100, "desk/notebook/page-00.md": 1100, "agent/memory.json": 1103,
		"apps/notes/data": 2001, "apps/notes/data/n.txt": 2001, "apps": os.Getuid(),
	} {
		if got, ok := h.owners[rel]; !ok || got != uid {
			t.Errorf("owner of %s: %d (set %v), want %d", rel, got, ok, uid)
		}
	}
	if got := h.owners["desk/volume.json"]; got == 1100 {
		t.Error("desk/volume.json was given to desk; it keeps this desk's owner")
	}
	for rel := range h.owners {
		if strings.HasPrefix(rel, "rtc") || strings.HasPrefix(rel, "desk-egress") || strings.HasPrefix(rel, ".ma-volume") || strings.HasPrefix(rel, "files") || strings.HasPrefix(rel, "selfhost") {
			t.Errorf("chown touched %s", rel)
		}
	}

	// Services: one stop as task 31 asks, deskd started (it starts the rest), desk-agent again, then the
	// Browser for the proof.
	if ops := strings.Join(h.sd.list(), ","); ops != "stop deskd desk-browser desk-stream desk-agent,start deskd,start desk-agent,start desk-browser" {
		t.Errorf("systemd: %s", ops)
	}

	// The cloud desk: held once for the last pass, released, browser files read while held.
	st := h.desk.Stats()
	if st.Holds != 1 || st.Releases != 1 || st.Held || st.NoIdem != 0 {
		t.Errorf("holds %d releases %d held %v, refused for want of idem %d", st.Holds, st.Releases, st.Held, st.NoIdem)
	}
	if !st.HeldOnRead {
		t.Error("nothing in the Browser was read while it was held")
	}
	if st.MaxActive < 2 || st.MaxActive > 8 {
		t.Errorf("reads in flight peaked at %d", st.MaxActive)
	}

	// The platform heard counts only.
	if got := strings.Join(h.api.states(), ","); got != "copying,checking,done" {
		t.Errorf("reports: %s", got)
	}
	assertCountsOnly(t, h)
	last := h.api.reports[len(h.api.reports)-1]
	if last.Parts != 4 || last.Files != 51 || last.Bytes == 0 || last.Checks != (ReportChecks{Passed: 5}) || last.Error != "" {
		t.Errorf("done report: %+v", last)
	}

	// And on this desk.
	var rep LocalReport
	b, err := os.ReadFile(filepath.Join(mv, "report.json"))
	if err != nil || json.Unmarshal(b, &rep) != nil || rep.State != "done" || rep.Cookies.Readable != 2 || rep.LinksLeftOut != 2 {
		t.Errorf("report.json: %s %v", b, err)
	}
	if fi, err := os.Stat(filepath.Join(mv, "state.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("state.json mode: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mv, "stage")); err == nil {
		if des, _ := os.ReadDir(filepath.Join(mv, "stage")); len(des) != 0 {
			t.Errorf("parts left in stage/: %d", len(des))
		}
	}
}

// assertCountsOnly holds every report to what the platform's parseReport takes (ma-platform
// services/desks/src/moves.ts): six fields, counts, checks as {passed, failed}, an error from its list and
// only with failed, and nothing that names a file.
func assertCountsOnly(t *testing.T, h *harness) {
	t.Helper()
	names := []string{"browser", "desk", "agent", "apps", "History", "Cookies", "notebook", "page-", "memory", "notes", "/"}
	for _, raw := range h.api.rawBodies {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		for k := range m {
			switch k {
			case "state", "parts", "files", "bytes", "checks", "error":
			default:
				t.Errorf("report has %q: %s", k, raw)
			}
		}
		c, ok := m["checks"].(map[string]any)
		if !ok || len(c) != 2 {
			t.Errorf("checks isn't {passed, failed}: %s", raw)
		}
		for _, k := range []string{"passed", "failed"} {
			if v, ok := c[k].(float64); !ok || v < 0 || v != float64(int(v)) {
				t.Errorf("checks.%s: %s", k, raw)
			}
		}
		if e, ok := m["error"]; ok {
			if m["state"] != "failed" || !contains(ReportErrors, e.(string)) {
				t.Errorf("error %v isn't the platform's, with failed: %s", e, raw)
			}
		}
		for _, n := range names {
			if strings.Contains(string(raw), n) {
				t.Errorf("report body carries %q: %s", n, raw)
			}
		}
	}
}

// The Notebook's service has its own part and its own unit (S-13). It's moved, given uid 1105 and started again.
func TestNotebookPartAndUnit(t *testing.T) {
	h := newHarness(t)
	put(t, filepath.Join(h.src, "notebook/notebook.db"), sqlite(50000), 0o640)
	put(t, filepath.Join(h.src, "notebook/readable/Work/General/Plan.md"), []byte("# Plan\n"), 0o640)
	h.sd.units["desk-notebook"] = true
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	for _, rel := range []string{"notebook/notebook.db", "notebook/readable/Work/General/Plan.md"} {
		fileEq(t, filepath.Join(h.src, rel), filepath.Join(h.dst, rel))
		if got, ok := h.owners[rel]; !ok || got != 1105 {
			t.Errorf("owner of %s: %d (set %v), want 1105", rel, got, ok)
		}
	}
	if got, ok := h.owners["notebook"]; !ok || got != 1105 {
		t.Errorf("owner of notebook: %d (set %v), want 1105", got, ok)
	}
	if fi, err := os.Stat(filepath.Join(h.dst, "notebook")); err != nil || fi.Mode().Perm() != 0o750 {
		t.Errorf("notebook's mode: %v %v", fi.Mode().Perm(), err)
	}
	if ops := strings.Join(h.sd.list(), ","); ops != "stop deskd desk-browser desk-stream desk-agent desk-notebook,start deskd,start desk-agent,start desk-notebook,start desk-browser" {
		t.Errorf("systemd: %s", ops)
	}
}

// A desk-notebook that wasn't running stays stopped, and a desk without the unit doesn't mind.
func TestNotebookUnitNotRunning(t *testing.T) {
	h := newHarness(t)
	h.sd.units["desk-notebook"] = false
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if ops := strings.Join(h.sd.list(), ","); ops != "stop deskd desk-browser desk-stream desk-agent desk-notebook,start deskd,start desk-agent,start desk-browser" {
		t.Errorf("systemd: %s", ops)
	}
}

func TestTrailerMismatchRereads(t *testing.T) {
	h := newHarness(t)
	h.desk.CorruptRead = func(part, rel string, n int) bool { return rel == "profile/Default/History" && n == 1 }
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/History"), filepath.Join(h.dst, "browser/profile/Default/History"))
	reads := readsOf(h.desk.Stats(), "browser", "profile/Default/History")
	// First pass: the damaged read and its read again from 0; last pass: once more, as SQLite.
	if len(reads) != 3 || reads[0].Offset != 0 || reads[1].Offset != 0 {
		t.Fatalf("History reads: %+v", reads)
	}
}

func TestResumeMidFileAfterDrop(t *testing.T) {
	h := newHarness(t)
	h.desk.DropAfterBytes = 1500 * 1024
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	st := h.desk.Stats()
	if st.Sessions < 2 {
		t.Fatalf("sessions: %d", st.Sessions)
	}
	var resumed bool
	for _, r := range readsOf(st, "browser", "profile/Default/History") {
		if r.Session == 2 && r.Offset > 0 {
			resumed = true
		}
	}
	if !resumed {
		t.Fatalf("History wasn't carried on from its offset in the new session: %+v", readsOf(st, "browser", "profile/Default/History"))
	}
	for _, rel := range []string{"browser/profile/Default/History", "desk/chat.db", "desk/notebook/page-10.md"} {
		fileEq(t, filepath.Join(h.src, rel), filepath.Join(h.dst, rel))
	}
}

// A run cut short after copying leaves a journal; the rerun reads only what changed (and the SQLite
// files, which every last pass reads again).
func TestJournalSkipOnRerun(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	h.api.onReport = func(r PlatformReport) {
		if r.State == "checking" {
			cancel()
		}
	}
	if code := h.run(ctx); code != ExitFailed {
		t.Fatalf("first run: exit %d\n%s", code, h.out.String())
	}
	if _, err := os.Stat(filepath.Join(h.dst, "desk/old.txt")); err != nil {
		t.Fatal("the cut-short run changed this desk's data")
	}
	h.api.onReport = nil
	before := len(h.desk.Stats().Reads)
	sessions := h.desk.Stats().Sessions
	put(t, filepath.Join(h.src, "desk/notebook/page-03.md"), []byte("edited since"), 0o640)
	h.out.Reset()
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("rerun: exit %d\n%s", code, h.out.String())
	}
	if h.api.claims != 1 {
		t.Errorf("the rerun asked for a new code: %d claims", h.api.claims)
	}
	if !strings.Contains(h.out.String(), "Carrying on with the move") {
		t.Errorf("rerun output: %s", h.out.String())
	}
	got := map[string]int{}
	for _, r := range h.desk.Stats().Reads[before:] {
		if r.Session > sessions {
			got[r.Part+"/"+r.Path]++
		}
	}
	want := map[string]int{
		"desk/notebook/page-03.md": 1, "desk/chat.db": 1, "browser/profile/Last Version": 1,
		"browser/profile/Default/Cookies": 1, "browser/profile/Default/History": 1,
	}
	if len(got) != len(want) {
		t.Fatalf("rerun read %v, want %v", got, want)
	}
	for k, n := range want {
		if got[k] != n {
			t.Fatalf("rerun read %v, want %v", got, want)
		}
	}
	fileEq(t, filepath.Join(h.src, "desk/notebook/page-03.md"), filepath.Join(h.dst, "desk/notebook/page-03.md"))
}

// The held last pass fetches what changed and what's new, and drops what went.
func TestLastPassDelta(t *testing.T) {
	h := newHarness(t)
	s := h.src
	h.desk.OnHold = func() {
		put(t, filepath.Join(s, "browser/profile/Default/Preferences"), []byte(`{"v":2,"changed":"at stop"}`), 0o600)
		put(t, filepath.Join(s, "browser/profile/Default/Sessions/Session_1"), random(30000), 0o600)
		if err := os.Remove(filepath.Join(s, "browser/profile/Default/Old")); err != nil {
			t.Error(err)
		}
	}
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	fileEq(t, filepath.Join(s, "browser/profile/Default/Preferences"), filepath.Join(h.dst, "browser/profile/Default/Preferences"))
	fileEq(t, filepath.Join(s, "browser/profile/Default/Sessions/Session_1"), filepath.Join(h.dst, "browser/profile/Default/Sessions/Session_1"))
	if _, err := os.Lstat(filepath.Join(h.dst, "browser/profile/Default/Old")); err == nil {
		t.Error("a file removed on the cloud desk came across")
	}
	j := readJournal(filepath.Join(h.dst, ".ma-move/mv-test1/journal.jsonl"))
	if _, ok := j.get("browser", "profile/Default/Old"); ok {
		t.Error("the journal still has the removed file")
	}
	if e, ok := j.get("browser", "profile/Default/Sessions/Session_1"); !ok || e.Bytes != 30000 {
		t.Errorf("the journal lacks the new file: %+v", e)
	}
}

func TestRefusals(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(h *harness)
		message string
		claims  int
		whole   bool   // the whole data root is untouched, .ma-move included
		code    string // the platform's error code
	}{
		{"older chromium", func(h *harness) {
			h.env.ChromiumVersion = func() (string, error) { return "Chromium 150.0.7000.1 built on Debian", nil }
		}, "older than the one your cloud desk's Browser last ran", 1, true, "chromium_older"},
		{"no basic password store", func(h *harness) {
			h.env.BrowserLaunch = func() (string, error) { return goodUnit + "\nexec /usr/bin/chromium --kiosk\n", nil }
		}, "--password-store=basic", 0, true, ""},
		{"a keyring password store", func(h *harness) {
			h.env.BrowserLaunch = func() (string, error) {
				return goodUnit + "\n# --password-store=basic is what cloud desks use\nexec chromium --password-store=gnome-libsecret\n", nil
			}
		}, "--password-store=basic", 0, true, ""},
		{"low space", func(h *harness) {
			h.env.FreeBytes = func(string) (uint64, error) { return 1 << 30, nil }
		}, "needs 2.2 GB free for the move and has 1.1 GB", 1, true, "disk_full"},
		{"unverified file", func(h *harness) {
			h.desk.CorruptRead = func(_, rel string, _ int) bool { return rel == "profile/Default/History" }
		}, "1 file couldn't be checked", 1, false, "checksum_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			tc.setup(h)
			before := snapshot(t, h.dst, !tc.whole)
			if code := h.run(context.Background()); code != ExitRefused {
				t.Fatalf("exit %d\n%s", code, h.out.String())
			}
			if !strings.Contains(h.out.String(), tc.message) || !strings.Contains(strings.ToLower(h.out.String()), "nothing on this desk was changed") {
				t.Errorf("message: %s", h.out.String())
			}
			sameTree(t, before, snapshot(t, h.dst, !tc.whole))
			if h.api.claims != tc.claims {
				t.Errorf("claims: %d", h.api.claims)
			}
			if len(h.sd.list()) != 0 {
				t.Errorf("services were touched: %v", h.sd.list())
			}
			if tc.claims > 0 {
				states := h.api.states()
				last := h.api.reports[len(h.api.reports)-1]
				if len(states) == 0 || states[len(states)-1] != "failed" || last.Error != tc.code || last.Checks.Failed != 1 {
					t.Errorf("reports: %+v", h.api.reports)
				}
			}
			assertCountsOnly(t, h)
		})
	}
}

func TestDryRunChangesNothing(t *testing.T) {
	h := newHarness(t)
	before := snapshot(t, h.dst, false)
	code := Run(context.Background(), h.env, Options{TargetDesk: targetDesk, DryRun: true, Code: func() (string, error) { return testCode, nil }})
	if code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	sameTree(t, before, snapshot(t, h.dst, false))
	if len(h.api.reports) != 0 || h.desk.Stats().Holds != 0 {
		t.Errorf("dry run reported %d times, held %d", len(h.api.reports), h.desk.Stats().Holds)
	}
	if !strings.Contains(h.out.String(), "Browser: 8 files") || !strings.Contains(h.out.String(), "nothing was changed on either desk") {
		t.Errorf("dry run output: %s", h.out.String())
	}
}

// A rerun whose move token has run out takes a new code and keeps what's copied.
func TestNewCodeAdoptsEarlierCopy(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	h.api.onReport = func(r PlatformReport) {
		if r.State == "checking" {
			cancel()
		}
	}
	if code := h.run(ctx); code != ExitFailed {
		t.Fatalf("first run: exit %d", code)
	}
	h.api.onReport = nil
	h.api.ended["mv-test1"] = true
	h.api.moveID = "mv-test2"
	before := len(h.desk.Stats().Reads)
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("rerun: exit %d\n%s", code, h.out.String())
	}
	if h.api.claims != 2 {
		t.Errorf("claims: %d", h.api.claims)
	}
	if n := len(h.desk.Stats().Reads) - before; n > 4 {
		t.Errorf("the new move read %d files again; the earlier copy should have been kept", n)
	}
	var old State
	b, _ := os.ReadFile(filepath.Join(h.dst, ".ma-move/mv-test1/state.json"))
	if json.Unmarshal(b, &old) != nil || old.Phase != PhaseSuperseded {
		t.Errorf("the earlier move's state: %s", b)
	}
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/History"), filepath.Join(h.dst, "browser/profile/Default/History"))
}

// A crash in the middle of the swap: the rerun finishes it without the cloud desk.
func TestRerunFinishesASwap(t *testing.T) {
	h := newHarness(t)
	h.sd.failOn = "desk-browser" // the proof can't start the Browser on the first run
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if !strings.Contains(h.out.String(), "Your sign-ins couldn't be checked here: this desk's Browser didn't start") {
		t.Errorf("summary: %s", h.out.String())
	}
	// Now pretend the first run stopped right after putting desk in place.
	h2 := newHarness(t)
	h2.desk.Root = h.src
	m := &mover{env: h2.env, failed: map[string]bool{}, gone: map[string]bool{}, refusedLinks: map[string]bool{}}
	m.env.defaults()
	m.st = &State{MoveID: "mv-crash", MoveToken: "tok-mv-crash", SourceDeskID: sourceDesk, TargetDeskID: targetDesk,
		Phase: PhaseSwapping, Parts: []string{"agent", "desk"}, Totals: []PartSummary{{Part: "agent", Files: 1, Bytes: 8}, {Part: "desk", Files: 1, Bytes: 3}}, StartedAt: "x"}
	m.dir = moveDir(h2.dst, "mv-crash")
	put(t, filepath.Join(m.dir, "stage/agent/memory.json"), []byte("new agent"), 0o600)
	put(t, filepath.Join(m.dir, "stage/desk/n.md"), []byte("new"), 0o600)
	if err := m.save(); err != nil {
		t.Fatal(err)
	}
	if err := m.swapPart("desk"); err != nil {
		t.Fatal(err)
	}
	m.st.Swapped = []string{"desk"}
	if err := m.save(); err != nil {
		t.Fatal(err)
	}
	if code := h2.run(context.Background()); code != ExitDone {
		t.Fatalf("rerun: exit %d\n%s", code, h2.out.String())
	}
	if h2.api.claims != 0 {
		t.Error("finishing a swap asked for a code")
	}
	if b, _ := os.ReadFile(filepath.Join(h2.dst, "agent/memory.json")); string(b) != "new agent" {
		t.Errorf("agent wasn't swapped in: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(h2.dst, "desk/n.md")); string(b) != "new" {
		t.Errorf("desk was lost: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(m.dir, "before/desk/old.txt")); string(b) != "this desk's own" {
		t.Errorf("before/desk: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(h2.dst, "desk/volume.json")); string(b) != `{"volumeId":"vol-target"}` {
		t.Errorf("volume.json: %s", b)
	}
	if !strings.Contains(h2.out.String(), "Your desk is moved. 2 parts, 2 files") {
		t.Errorf("summary: %s", h2.out.String())
	}
}

func TestCompareCookies(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	past, future := int64(1_900_000_000), int64(2_100_000_000)
	src := []SourceCookie{
		{K: "a", V: "1", E: -1},     // a session cookie, readable
		{K: "b", V: "2", E: future}, // missing here
		{K: "c", V: "3", E: future}, // a different value: didn't decrypt
		{K: "d", V: "4", E: future}, // expired here since
		{K: "e", V: "5", E: past},   // expired at the source
		{K: "f", V: "6", E: future}, // readable
		{K: "g", V: "7"},            // a deskd that sends no e: counts, readable
		{K: "a", V: "1", E: -1},     // a repeat counts once
	}
	local := []cdp.Item{{K: "a", V: "1", E: -1}, {K: "c", V: "x", E: future}, {K: "d", V: "4", E: past}, {K: "f", V: "6", E: future}, {K: "g", V: "7", E: future}, {K: "z", V: "9", E: -1}}
	r := compareCookies(src, local, now)
	if r.Readable != 3 || r.Total != 5 || r.Missing != 1 || r.Different != 1 {
		t.Fatalf("%+v", r)
	}
	if s := summary(1, 1, 1, r, 0, "", ""); !strings.Contains(s, "3 of 5 sign-in cookies work here; the sites of the other 2 (1 not found, 1 unreadable) will ask you to sign in again.") {
		t.Fatal(s)
	}
}

func TestNormalizeCode(t *testing.T) {
	for in, want := range map[string]string{"abcd-efgh-jkmn": "ABCD-EFGH-JKMN", " ABCDEFGHJKMN\n": "ABCD-EFGH-JKMN", "o1il-0000-zzzz": "0111-0000-ZZZZ"} {
		if got, err := NormalizeCode(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"ABCD-EFGH-JKM", "ABCD-EFGH-JKMNP", "ABCD-EFGH-JKMU"} {
		if _, err := NormalizeCode(in); err == nil {
			t.Errorf("%q was accepted", in)
		}
	}
}

func TestVersionsAndChecks(t *testing.T) {
	ok := [][2]string{{"156.0.8078.79", "156.0.8078.79"}, {"156.0.8078.100", "156.0.8078.99"}, {"1:157.0.1.2-1~deb13u1", "156.0.8078.79"}, {"Chromium 156.0.8078.79 built on Debian", "156.0.8078.79"}}
	for _, c := range ok {
		if err := checkChromium(c[0], []byte(c[1]+"\n")); err != nil {
			t.Errorf("%v: %v", c, err)
		}
	}
	for _, c := range [][2]string{{"156.0.8078.78", "156.0.8078.79"}, {"", "156.0.8078.79"}, {"156.0.1.1", "garbage"}} {
		if err := checkChromium(c[0], []byte(c[1])); err == nil {
			t.Errorf("%v passed", c)
		}
	}
	if err := checkChromium("", nil); err != nil {
		t.Errorf("a profile with no Last Version: %v", err)
	}
	if err := checkPasswordStore(`ExecStart=/usr/bin/chromium "--password-store=basic" --kiosk`); err != nil {
		t.Error(err)
	}
	if err := checkSpace(3<<30, 1<<30); err != nil {
		t.Error(err)
	}
	if err := checkSpace(3<<30, 1<<30+1); err == nil {
		t.Error("one byte short passed")
	}
}

func TestPathsAndLinks(t *testing.T) {
	for _, p := range []string{"a", "a/b", "Local Storage/leveldb/000003.log"} {
		if !validRel(p) {
			t.Errorf("%q refused", p)
		}
	}
	for _, p := range []string{"", ".", "..", "../a", "a/../b", "/etc/passwd", "a//b", "a/", "./a"} {
		if validRel(p) {
			t.Errorf("%q accepted", p)
		}
	}
	for rel, target := range map[string]string{"a/l": "b", "a/b/l": "../c", "l": "x/y"} {
		if !linkInside(rel, target) {
			t.Errorf("%s -> %s refused", rel, target)
		}
	}
	for _, c := range [][2]string{{"l", "../x"}, {"a/l", "../../x"}, {"a/l", "/etc"}, {"b", ""}, {"c/d", ".."}, {"c/d", "../.."}} {
		if linkInside(c[0], c[1]) {
			t.Errorf("%s -> %s accepted", c[0], c[1])
		}
	}
	for _, p := range []string{"rtc", "desk-egress", ".ma-volume", "browser-readable", "lost+found", ".ma-move", "a/b", ".."} {
		if movablePart(p) {
			t.Errorf("part %q would move", p)
		}
	}
	dir := t.TempDir()
	for name, body := range map[string]string{
		"a.json": `{"apps":{"notes":{"uid":2001}}}`, "b.json": `{"apps":[{"id":"notes","uid":2001}]}`, "c.json": `{"notes":{"uid":2001,"version":"1"}}`,
	} {
		put(t, filepath.Join(dir, name), []byte(body), 0o644)
		if got := appUIDs(filepath.Join(dir, name)); got["notes"] != 2001 {
			t.Errorf("%s: %v", name, got)
		}
	}
}

func TestResolveTarget(t *testing.T) {
	dir := t.TempDir()
	if _, err := ResolveTarget(dir, ""); err == nil || !strings.Contains(err.Error(), "This computer isn't a desk in an office yet: run the install first") {
		t.Fatalf("no desk.json: %v", err)
	}
	put(t, filepath.Join(dir, "selfhost/desk.json"), []byte(`{"deskId":"d-abc123","userId":"u-1","env":"prod"}`), 0o640)
	d, err := ResolveTarget(dir, "")
	if err != nil || d.DeskID != "d-abc123" || d.Env != "prod" {
		t.Fatalf("%+v %v", d, err)
	}
	if _, err := ResolveTarget(dir, "d-abc123"); err != nil {
		t.Errorf("the same ID on the flag: %v", err)
	}
	var r *Refusal
	if _, err := ResolveTarget(dir, "d-other"); err == nil || !errors.As(err, &r) {
		t.Errorf("another ID on the flag: %v", err)
	}
	put(t, filepath.Join(dir, "selfhost/desk.json"), []byte(`{"env":"prod"}`), 0o640)
	if _, err := ResolveTarget(dir, ""); err == nil {
		t.Error("a desk.json with no deskId was taken")
	}
	for _, c := range []struct {
		api, env, want string
		staging        bool
	}{{"", "prod", ProdAPI, false}, {"", "staging", StagingAPI, false}, {"", "prod", StagingAPI, true}, {"http://x", "staging", "http://x", false}, {"", "", ProdAPI, false}} {
		if got := APIBase(c.api, c.staging, c.env); got != c.want {
			t.Errorf("%+v: %s", c, got)
		}
	}
}

// deskd's END with no trailer (its helper failed) means ask again: the next read carries on from what's
// written, and it isn't a checksum mismatch.
func TestEmptyEndCarriesOn(t *testing.T) {
	h := newHarness(t)
	h.desk.FailRead = func(_, rel string, n int) bool { return rel == "profile/Default/History" && n == 1 }
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/History"), filepath.Join(h.dst, "browser/profile/Default/History"))
	reads := readsOf(h.desk.Stats(), "browser", "profile/Default/History")
	if len(reads) != 3 || reads[0].Offset != 0 || reads[1].Offset == 0 || reads[2].Offset != 0 {
		t.Fatalf("History reads: %+v", reads)
	}
}

func TestReportErrorCodes(t *testing.T) {
	m := &mover{}
	for err, want := range map[error]string{
		helperError{}:                                    "helper_unavailable",
		fmt.Errorf("x: %w", syscall.ENOSPC):              "disk_full",
		fmt.Errorf("x: %w", session.ErrDisconnected):     "connection_lost",
		fmt.Errorf("x: %w: %w", errUnreachable, errCopy): "connection_lost",
		fmt.Errorf("x: %w", errCopy):                     "copy_failed",
		errors.New("anything else"):                      "other",
	} {
		if got := m.errorCode(err); got != want || !contains(ReportErrors, got) {
			t.Errorf("%v: %s, want %s", err, got, want)
		}
	}
	for _, code := range refusalError {
		if !contains(ReportErrors, code) {
			t.Errorf("%s isn't one of the platform's", code)
		}
	}
	m.st = &State{Phase: PhaseSwapping}
	if got := m.errorCode(errors.New("rename")); got != "swap_failed" {
		t.Errorf("during the swap: %s", got)
	}
	if r := platformReport("done", nil, map[string]bool{"a": true, "b": false}, "other"); r.Error != "" || r.Checks != (ReportChecks{Passed: 1, Failed: 1}) {
		t.Errorf("%+v", r)
	}
}

func TestMoveEndedOrNot(t *testing.T) {
	for _, c := range []struct {
		err              error
		ended, permanent bool
	}{
		{&APIError{Status: 401, Code: "unauthenticated"}, true, true},
		{&APIError{Status: 409, Code: "move_ended"}, true, true},
		{&APIError{Status: 409, Code: "invalid_state"}, false, false},
		{&APIError{Status: 429, Code: "rate_limited"}, false, false},
		{&APIError{Status: 503, Code: "unavailable"}, false, false},
		{&APIError{Status: 400, Code: "invalid"}, false, true},
	} {
		if moveEnded(c.err) != c.ended || permanentAPI(c.err) != c.permanent {
			t.Errorf("%v: ended %v permanent %v", c.err, moveEnded(c.err), permanentAPI(c.err))
		}
	}
}
