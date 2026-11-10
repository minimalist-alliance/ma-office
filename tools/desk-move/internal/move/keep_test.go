package move

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// Security's NE-2: after the move's last pass, the cloud desk's Chromium started again on the same cookies, so a site
// that rotates its sign-in tokens could sign the member out on this desk. The hold is now kept on the cloud desk until
// the member starts its Browser there again, and the done line says so.

func readLocalReport(t *testing.T, h *harness) LocalReport {
	t.Helper()
	var rep LocalReport
	b, err := os.ReadFile(filepath.Join(h.dst, ".ma-move", "mv-test1", "report.json"))
	if err != nil || json.Unmarshal(b, &rep) != nil {
		t.Fatalf("report.json: %s %v", b, err)
	}

	return rep
}

func TestMoveKeepsTheCloudDesksBrowserHeld(t *testing.T) {
	h := newHarness(t)
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	st := h.desk.Stats()
	if !st.Kept || st.Keeps != 1 || st.Restarts != 0 {
		t.Errorf("kept %v, keeps %d, Chromium started again %d times on the cloud desk", st.Kept, st.Keeps, st.Restarts)
	}
	// The keep came from the session that held it, and only once its pass was done.
	if !st.HeldOnRead || st.UnheldBrowserReads != 0 {
		t.Errorf("read held %v, unheld %d", st.HeldOnRead, st.UnheldBrowserReads)
	}
	out := h.out.String()
	if !strings.Contains(out, "Your desk is moved.") || !strings.Contains(out, keptLine) || strings.Contains(out, "Your cloud desk is unchanged") {
		t.Errorf("the done line doesn't say the cloud desk's Browser stays stopped:\n%s", out)
	}
	if strings.Contains(out, "starts again after") {
		t.Errorf("the member was told the cloud desk's Browser starts again:\n%s", out)
	}
	if rep := readLocalReport(t, h); rep.BrowserKept != KeptHeld {
		t.Errorf("report.json browserKept %q", rep.BrowserKept)
	}
}

func TestAnOlderDeskdThatCantKeepSaysTheBrowserStartedAgain(t *testing.T) {
	h := newHarness(t)
	h.desk.NoKeep = true
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	st := h.desk.Stats()
	if st.Kept || st.Restarts != 1 {
		t.Errorf("kept %v, restarts %d", st.Kept, st.Restarts)
	}
	out := h.out.String()
	if !strings.Contains(out, "its Browser started again there: use the Browser on one desk only") || strings.Contains(out, keptLine) {
		t.Errorf("what the member read:\n%s", out)
	}
	if rep := readLocalReport(t, h); rep.BrowserKept != KeptUnsupported {
		t.Errorf("report.json browserKept %q", rep.BrowserKept)
	}
}

func TestAKeepTheCloudDeskCantRecordSaysTheBrowserStartedAgain(t *testing.T) {
	h := newHarness(t)
	h.desk.RefuseKeep = func(int) (string, string) { return "unavailable", "disk" }
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if st := h.desk.Stats(); st.Kept || st.Keeps != 1 {
		t.Errorf("kept %v, keeps %d", st.Kept, st.Keeps)
	}
	if out := h.out.String(); !strings.Contains(out, "its Browser started again there") {
		t.Errorf("what the member read:\n%s", out)
	}
	if rep := readLocalReport(t, h); rep.BrowserKept != KeptFailed {
		t.Errorf("report.json browserKept %q", rep.BrowserKept)
	}
}

// The session drops as the keep comes, before deskd kept anything. deskd lets go, Chromium starts and writes a file
// the pass had copied; the reconnect holds again, copies what changed, and keeps that.
func TestAKeepLostWithTheSessionCopiesAgainAndKeeps(t *testing.T) {
	h := newHarness(t)
	listings := countListings(h.desk)
	var changed atomic.Bool
	h.desk.DropOnKeep = func(n int) bool { return n == 1 }
	h.desk.OnHoldLost = func() { changePreferences(t, h.src, &changed) }
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if !changed.Load() {
		t.Fatal("the hold was never lost")
	}
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/Preferences"), filepath.Join(h.dst, "browser/profile/Default/Preferences"))
	st := h.desk.Stats()
	if !st.Kept || st.Keeps != 2 || st.HoldsLost != 1 || st.UnheldBrowserReads != 0 {
		t.Errorf("kept %v, keeps %d, holds lost %d, unheld reads %d", st.Kept, st.Keeps, st.HoldsLost, st.UnheldBrowserReads)
	}
	if n := listings("browser"); n != 3 {
		t.Errorf("the Browser was listed %d times, want 3", n)
	}
	if !strings.Contains(h.out.String(), keptLine) {
		t.Errorf("what the member read:\n%s", h.out.String())
	}
}

// deskd may have kept it before the session dropped. The next pass holds over the kept hold and keeps again, which is
// the same keep, and nothing started Chromium in between.
func TestAKeepWhoseReplyWasLostIsKeptAgain(t *testing.T) {
	h := newHarness(t)
	h.desk.DropOnKeep = func(n int) bool { return n == 1 }
	h.desk.DropKeeps = true
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if st := h.desk.Stats(); !st.Kept || st.Keeps != 2 || st.Restarts != 0 {
		t.Errorf("kept %v, keeps %d, restarts %d", st.Kept, st.Keeps, st.Restarts)
	}
}

// A move that stops after its last pass leaves the cloud desk's Browser kept, so the member is told where it went.
func TestAMoveRefusedAfterTheKeepSaysTheCloudBrowserStaysStopped(t *testing.T) {
	h := newHarness(t)
	h.desk.CorruptRead = func(_, rel string, _ int) bool { return rel == "profile/Default/History" }
	if code := h.run(context.Background()); code != ExitRefused {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	out := h.out.String()
	if !h.desk.Stats().Kept || !strings.Contains(out, "couldn't be checked") || !strings.Contains(out, keptLine) {
		t.Errorf("kept %v, what the member read:\n%s", h.desk.Stats().Kept, out)
	}
}

// deskd's record of a move is the cloud desk's own: brought here it would keep this desk's Browser stopped. This desk
// keeps its own, if it has one.
func TestTheCloudDesksMovedRecordNeverComesAcross(t *testing.T) {
	h := newHarness(t)
	put(t, filepath.Join(h.src, "desk", browserMovedFile), []byte(`{"since":"2026-11-01T00:00:00Z"}`), 0o600)
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if _, err := os.Lstat(filepath.Join(h.dst, "desk", browserMovedFile)); err == nil {
		t.Error("the cloud desk's browser-moved.json came across")
	}
	for _, r := range h.desk.Stats().Reads {
		if r.Part == "desk" && r.Path == browserMovedFile {
			t.Error("browser-moved.json was read")
		}
	}

	h2 := newHarness(t)
	put(t, filepath.Join(h2.src, "desk", browserMovedFile), []byte(`{"since":"2026-11-01T00:00:00Z"}`), 0o600)
	put(t, filepath.Join(h2.dst, "desk", browserMovedFile), []byte(`{"since":"2026-10-01T00:00:00Z"}`), 0o600)
	if code := h2.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h2.out.String())
	}
	if b, _ := os.ReadFile(filepath.Join(h2.dst, "desk", browserMovedFile)); !strings.Contains(string(b), "2026-10-01") {
		t.Errorf("this desk's own record: %s", b)
	}
}
