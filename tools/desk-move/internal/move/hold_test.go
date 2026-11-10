package move

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/fakedesk"
)

// lastReport is the last report the platform heard.
func (h *harness) lastReport() PlatformReport {
	h.api.mu.Lock()
	defer h.api.mu.Unlock()
	if len(h.api.reports) == 0 {
		return PlatformReport{}
	}

	return h.api.reports[len(h.api.reports)-1]
}

// countListings counts each part's data.manifest listings.
func countListings(d *fakedesk.Desk) func(part string) int {
	var mu sync.Mutex
	n := map[string]int{}
	d.OnManifest = func(part string, _ int) {
		mu.Lock()
		n[part]++
		mu.Unlock()
	}

	return func(part string) int {
		mu.Lock()
		defer mu.Unlock()

		return n[part]
	}
}

// changePreferences is Chromium writing its Preferences while nothing holds it. It runs on the desk's goroutine.
func changePreferences(t *testing.T, src string, done *atomic.Bool) {
	name := filepath.Join(src, "browser/profile/Default/Preferences")
	if err := os.WriteFile(name, []byte(`{"v":2,"written while the Browser wasn't held"}`), 0o600); err != nil {
		t.Error(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(name, later, later); err != nil {
		t.Error(err)
	}
	done.Store(true)
}

// A hold the cloud desk refuses used to be logged, and the Browser copied unheld, with the move saying done. Now
// it's asked for again, and after HoldTries refusals the move stops with nothing here changed.
func TestHoldRefusedStopsTheMove(t *testing.T) {
	h := newHarness(t)
	h.desk.RefuseHold = func(int) string { return "unavailable" }
	before := snapshot(t, h.dst, true)
	if code := h.run(context.Background()); code != ExitFailed {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	sameTree(t, before, snapshot(t, h.dst, true))
	st := h.desk.Stats()
	if st.Holds != 4 {
		t.Errorf("asked for the hold %d times, want 4", st.Holds)
	}
	if st.HeldOnRead || st.UnheldBrowserReads != 0 {
		t.Errorf("the Browser was read after the hold was refused: held %v, unheld %d", st.HeldOnRead, st.UnheldBrowserReads)
	}
	if out := h.out.String(); !strings.Contains(out, "Browser couldn't be paused") || strings.Contains(out, "Your desk is moved") {
		t.Errorf("what the member read:\n%s", out)
	}
	if r := h.lastReport(); r.State != "failed" || r.Error != "copy_failed" {
		t.Errorf("last report %+v", r)
	}
	for _, s := range h.api.states() {
		if s == "done" {
			t.Error("reported done")
		}
	}
}

func TestHoldRefusedOnceThenHeld(t *testing.T) {
	h := newHarness(t)
	h.desk.RefuseHold = func(n int) string {
		if n == 1 {
			return "unavailable"
		}

		return ""
	}
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	st := h.desk.Stats()
	if st.Holds != 2 || st.Releases != 1 || st.Held || !st.HeldOnRead || st.UnheldBrowserReads != 0 {
		t.Errorf("holds %d releases %d held %v, read held %v, read unheld %d", st.Holds, st.Releases, st.Held, st.HeldOnRead, st.UnheldBrowserReads)
	}
}

// The session drops during the held pass. deskd lets go of the hold, Chromium starts and writes a file the pass
// had already found unchanged, and the reconnect holds again. That file used to stay as the first hold found it,
// beside databases read after the restart, and the move said done. Now the profile is listed again under the new
// hold and the file comes across as it is.
func TestHoldLostWithTheSessionListsAgain(t *testing.T) {
	h := newHarness(t)
	listings := countListings(h.desk)
	var changed atomic.Bool
	h.desk.DropOnRead = func(part, rel string, n int) bool {
		return part == "browser" && rel == "profile/Default/History" && n == 2 // its read in the held pass
	}
	h.desk.OnHoldLost = func() { changePreferences(t, h.src, &changed) }
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if !changed.Load() {
		t.Fatal("the hold was never lost")
	}
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/Preferences"), filepath.Join(h.dst, "browser/profile/Default/Preferences"))
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/History"), filepath.Join(h.dst, "browser/profile/Default/History"))
	st := h.desk.Stats()
	if st.HoldsLost != 1 || st.Holds != 2 || st.UnheldBrowserReads != 0 || st.Held {
		t.Errorf("holds %d, lost %d, held %v, browser reads unheld %d", st.Holds, st.HoldsLost, st.Held, st.UnheldBrowserReads)
	}
	if n := listings("browser"); n != 3 {
		t.Errorf("the Browser was listed %d times, want 3: the first pass, the lost hold's and the new one's", n)
	}
}

// slowHeldReads makes each read of the held pass take a while, so the hold is renewed during it.
func slowHeldReads(d *fakedesk.Desk) {
	d.OnRead = func(part, _ string, n int) string {
		if part == "browser" && n >= 2 {
			time.Sleep(40 * time.Millisecond)
		}

		return ""
	}
}

// A hold lasts 30 minutes, and a Browser pass can take longer: it's renewed on the same session while it runs, and
// a renewal doesn't make the pass start again.
func TestHoldRenewedDuringThePass(t *testing.T) {
	h := newHarness(t)
	h.env.HoldRenew = 15 * time.Millisecond
	listings := countListings(h.desk)
	slowHeldReads(h.desk)
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	st := h.desk.Stats()
	if st.Holds < 2 || st.HoldsLost != 0 || st.UnheldBrowserReads != 0 {
		t.Fatalf("holds %d (renewals %d), lost %d, unheld reads %d", st.Holds, st.Holds-1, st.HoldsLost, st.UnheldBrowserReads)
	}
	for _, s := range st.HoldsBy {
		if s != st.HoldsBy[0] {
			t.Errorf("held from sessions %v: a renewal is on the same one", st.HoldsBy)
		}
	}
	if n := listings("browser"); n != 2 {
		t.Errorf("the Browser was listed %d times, want 2", n)
	}
}

// A renewal deskd refuses means it let go of the hold, and Chromium may run: the pass is done again under a new one.
func TestHoldRenewalRefusedListsAgain(t *testing.T) {
	h := newHarness(t)
	h.env.HoldRenew = 15 * time.Millisecond
	listings := countListings(h.desk)
	slowHeldReads(h.desk)
	h.desk.RefuseHold = func(n int) string {
		if n == 2 { // the first renewal
			return "unavailable"
		}

		return ""
	}
	var changed atomic.Bool
	h.desk.OnHoldLost = func() { changePreferences(t, h.src, &changed) }
	if code := h.run(context.Background()); code != ExitDone {
		t.Fatalf("exit %d\n%s", code, h.out.String())
	}
	if !changed.Load() {
		t.Fatal("the renewal was never refused")
	}
	fileEq(t, filepath.Join(h.src, "browser/profile/Default/Preferences"), filepath.Join(h.dst, "browser/profile/Default/Preferences"))
	// Reads go on until the pass ends, unheld once the renewal was refused; the pass after it is what counts.
	st := h.desk.Stats()
	if st.HoldsLost != 1 || st.Held {
		t.Errorf("lost %d, held %v", st.HoldsLost, st.Held)
	}
	if n := listings("browser"); n < 3 {
		t.Errorf("the Browser was listed %d times, want 3 or more", n)
	}
}
