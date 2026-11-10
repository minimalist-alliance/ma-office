package xinput

import (
	"sync/atomic"
	"testing"
)

// The same table as image/tests/test_desk_stream_islands.py's CLIP_CASES: desk-stream crops and desk-rtc maps input to one
// rectangle.
func TestClipCropMatchesDeskStream(t *testing.T) {
	for _, c := range []struct{ asked, want Rect }{
		{Rect{320, 180, 1280, 720}, Rect{320, 180, 1280, 720}},
		{Rect{321, 181, 1279, 719}, Rect{320, 180, 1280, 720}},
		{Rect{0, 0, 1920, 1080}, Rect{0, 0, 1920, 1080}},
		{Rect{1800, 1000, 640, 360}, Rect{1800, 1000, 120, 80}},
		{Rect{1910, 1070, 64, 64}, Rect{1888, 1048, 32, 32}},
		{Rect{5000, 5000, 64, 64}, Rect{1888, 1048, 32, 32}},
		{Rect{100, 100, 33, 33}, Rect{100, 100, 32, 32}},
	} {
		if got := ClipCrop(c.asked, 1920, 1080); got != c.want {
			t.Errorf("ClipCrop(%v) = %v, want %v", c.asked, got, c.want)
		}
	}
}

func TestParseReadsTheIslandEpoch(t *testing.T) {
	b := make([]byte, 16)
	b[0], b[3] = 1, 7
	if e, ok := Parse(b); !ok || e.Island != 7 {
		t.Fatalf("%+v %v", e, ok)
	}
}

func TestIslandMapsIntoTheCrop(t *testing.T) {
	in, d := rig(t)
	in.SetIsland(&Island{Epoch: 7, Rect: Rect{320, 180, 1280, 720}})
	seq := uint32(0)
	move := func(x, y uint16, epoch uint8) {
		seq++
		in.Submit(1, Event{Kind: Move, Seq: seq, X: x, Y: y, Island: epoch})
		settle(in)
	}
	move(0, 0, 7)
	move(65535, 65535, 7)
	move(32768, 32768, 7)
	if got := d.take(); got != "move 320,180; move 1599,899; move 960,540" {
		t.Fatalf("island moves: %s", got)
	}
	// The picture the client saw was another island, or the whole screen: dropped.
	move(0, 0, 6)
	move(0, 0, 0)
	if got := d.take(); got != "" {
		t.Fatalf("stale moves applied: %s", got)
	}
	if stale, _ := in.IslandDrops(); stale != 2 {
		t.Fatalf("stale %d", stale)
	}
	// Back to the whole screen: island events go nowhere, and plain ones map as ever.
	in.SetIsland(nil)
	move(0, 0, 7)
	move(65535, 65535, 0)
	if got := d.take(); got != "move 1919,1079" {
		t.Fatalf("after the island: %s", got)
	}
}

func TestIslandKeysOnlyWhileAllowed(t *testing.T) {
	in, d := rig(t)
	in.SetIsland(&Island{Epoch: 3, Rect: Rect{0, 0, 640, 360}})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 1, Keysym: 'a', Island: 3})
	settle(in)
	if got := d.take(); got != "" {
		t.Fatalf("a key went while the page's focus wasn't in the island: %s", got)
	}
	in.SetIsland(&Island{Epoch: 3, Rect: Rect{0, 0, 640, 360}, Keys: true})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 2, Keysym: 'a', Island: 3})
	settle(in)
	if got := d.take(); got != "key 38 true" {
		t.Fatalf("allowed key: %s", got)
	}
	// Focus leaves the island while the key is down: its release still goes, and nothing else does.
	in.SetIsland(&Island{Epoch: 3, Rect: Rect{0, 0, 640, 360}})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 3, Keysym: 0xff0d, Island: 3})
	in.Submit(1, Event{Kind: Key, Down: false, Seq: 4, Keysym: 'a', Island: 3})
	settle(in)
	if got := d.take(); got != "key 38 false" {
		t.Fatalf("after focus left: %s", got)
	}
}

func TestIslandPressBlockedByAWindowOverIt(t *testing.T) {
	in, d := rig(t)
	var heard atomic.Int32
	in.OnBlocked(func(epoch uint8) { heard.Store(int32(epoch)) })
	in.SetIsland(&Island{Epoch: 9, Rect: Rect{320, 180, 1280, 720}})
	d.mu.Lock()
	d.over = Rect{900, 500, 200, 100} // a popup the page opened, over the middle of the island
	d.mu.Unlock()
	in.Submit(1, Event{Kind: Button, Button: 1, Down: true, Seq: 1, X: 32768, Y: 32768, Island: 9})
	in.Submit(1, Event{Kind: Button, Button: 1, Down: false, Seq: 2, X: 32768, Y: 32768, Island: 9})
	settle(in)
	if got := d.take(); got != "move 960,540" { // the up goes nowhere: its press never did
		t.Fatalf("a press reached a popup over the island: %s", got)
	}
	if _, blocked := in.IslandDrops(); blocked != 1 || heard.Load() != 9 {
		t.Fatalf("blocked %d, heard %d", blocked, heard.Load())
	}
	// Beside the popup is refused too, while it crosses the island (T47S-1): the island is the page's only when nothing is
	// over any of it.
	in.Submit(1, Event{Kind: Button, Button: 1, Down: true, Seq: 3, X: 0, Y: 0, Island: 9})
	settle(in)
	if got := d.take(); got != "move 320,180" {
		t.Fatalf("a press beside a popup over the island went: %s", got)
	}
	// A window bigger than the whole island, as a screen-sized window.open or a bubble over a small island: refused.
	d.mu.Lock()
	d.over = Rect{0, 0, 1920, 1080}
	d.mu.Unlock()
	in.Submit(1, Event{Kind: Button, Button: 1, Down: true, Seq: 4, X: 100, Y: 100, Island: 9})
	settle(in)
	if got := d.take(); got != "move 322,181" {
		t.Fatalf("a press under a window bigger than the island went: %s", got)
	}
	if _, blocked := in.IslandDrops(); blocked != 3 {
		t.Fatalf("blocked %d, want 3", blocked)
	}
	// Nothing over it: the press and release go, at the island's pixels.
	d.mu.Lock()
	d.over = Rect{}
	d.mu.Unlock()
	in.Submit(1, Event{Kind: Button, Button: 1, Down: true, Seq: 5, X: 0, Y: 0, Island: 9})
	settle(in)
	if got := d.take(); got != "move 320,180; btn 1 true" {
		t.Fatalf("press: %s", got)
	}
	// The island ends with the button down: the release still goes, where the pointer is.
	in.SetIsland(nil)
	in.Submit(1, Event{Kind: Button, Button: 1, Down: false, Seq: 6, X: 0, Y: 0, Island: 9})
	settle(in)
	if got := d.take(); got != "btn 1 false" {
		t.Fatalf("release after the island: %s", got)
	}
}

func TestIslandKeysOnlyWithTheKioskFocused(t *testing.T) {
	in, d := rig(t)
	var heard atomic.Int32
	in.OnBlocked(func(epoch uint8) { heard.Store(int32(epoch)) })
	in.SetIsland(&Island{Epoch: 4, Rect: Rect{0, 0, 640, 360}, Keys: true})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 1, Keysym: 'a', Island: 4})
	settle(in)
	if got := d.take(); got != "key 38 true" {
		t.Fatalf("a key with the kiosk focused: %s", got)
	}
	// A popup took X's focus while the key was down (T47S-1): its release still goes, and no new key does.
	d.mu.Lock()
	d.focusAway = true
	d.mu.Unlock()
	in.Submit(1, Event{Kind: Key, Down: false, Seq: 2, Keysym: 'a', Island: 4})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 3, Keysym: 'a', Island: 4})
	settle(in)
	if got := d.take(); got != "key 38 false" {
		t.Fatalf("with the focus on a popup: %s", got)
	}
	if _, blocked := in.IslandDrops(); blocked != 1 || heard.Load() != 4 {
		t.Fatalf("blocked %d, heard %d", blocked, heard.Load())
	}
	// The whole screen has no such rule: the member sees what has the focus.
	in.SetIsland(nil)
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 4, Keysym: 'a'})
	settle(in)
	if got := d.take(); got != "key 38 true" {
		t.Fatalf("a key on the whole screen: %s", got)
	}
}

func TestWholeScreenUnchangedWithoutIslands(t *testing.T) {
	in, d := rig(t)
	// An up with nothing held still goes on the whole screen, with its position, as before islands.
	in.Submit(1, Event{Kind: Button, Button: 3, Down: false, Seq: 1, X: 65535, Y: 0})
	in.Submit(1, Event{Kind: Wheel, Seq: 2, X: 0, Y: 65535, DY: 120})
	in.Submit(1, Event{Kind: ReleaseAll, Seq: 3, Island: 200})
	settle(in)
	if got := d.take(); got != "move 1919,0; btn 3 false; move 0,1079; btn 5 true; btn 5 false" {
		t.Fatalf("%s", got)
	}
}
