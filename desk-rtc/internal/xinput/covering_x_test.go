package xinput

import (
	"os"
	"testing"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

// Covering and KioskFocused on a real X server of the test's own (XINPUT_TEST_DISPLAY, or XCLIP_TEST_DISPLAY as in
// README.md, "Test"). A screen-sized window with the kiosk's WM_CLASS and WM_WINDOW_ROLE stands for the kiosk's, as
// Chromium sets them on image 0.2.9; others stand for what a page can open over it (Security's T47S-1).
func TestCoveringOnARealServer(t *testing.T) {
	name := os.Getenv("XINPUT_TEST_DISPLAY")
	if name == "" {
		name = os.Getenv("XCLIP_TEST_DISPLAY")
	}
	if name == "" {
		t.Skip("needs a test X server: XINPUT_TEST_DISPLAY=:173")
	}
	c, err := xgb.NewConnDisplay(name)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	scr := xproto.Setup(c).DefaultScreen(c)
	sw, sh := int(scr.WidthInPixels), int(scr.HeightInPixels)
	roleAtom, err := xproto.InternAtom(c, false, uint16(len("WM_WINDOW_ROLE")), "WM_WINDOW_ROLE").Reply()
	if err != nil {
		t.Fatal(err)
	}
	set := func(w xproto.Window, prop xproto.Atom, v string) {
		if err := xproto.ChangePropertyChecked(c, xproto.PropModeReplace, w, prop, xproto.AtomString, 8, uint32(len(v)), []byte(v)).Check(); err != nil {
			t.Fatal(err)
		}
	}
	// window makes a top-level window; class and role are set before it's mapped, as Chromium does, unless empty.
	window := func(x, y, w, h int, override bool, class, role string) xproto.Window {
		id, err := xproto.NewWindowId(c)
		if err != nil {
			t.Fatal(err)
		}
		var mask uint32
		var vals []uint32
		if override {
			mask, vals = xproto.CwOverrideRedirect, []uint32{1}
		}
		if err := xproto.CreateWindowChecked(c, scr.RootDepth, id, scr.Root, int16(x), int16(y), uint16(w), uint16(h), 0,
			xproto.WindowClassInputOutput, scr.RootVisual, mask, vals).Check(); err != nil {
			t.Fatal(err)
		}
		if class != "" {
			set(id, xproto.AtomWmClass, "chromium (/data/browser/profile)\x00"+class+"\x00")
		}
		if role != "" {
			set(id, roleAtom.Atom, role)
		}
		if err := xproto.MapWindowChecked(c, id).Check(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = xproto.DestroyWindowChecked(c, id).Check() })
		time.Sleep(50 * time.Millisecond)

		return id
	}
	unmap := func(w xproto.Window) {
		if err := xproto.UnmapWindowChecked(c, w).Check(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	focus := func(w xproto.Window) {
		if err := xproto.SetInputFocusChecked(c, xproto.InputFocusPointerRoot, w, xproto.TimeCurrentTime).Check(); err != nil {
			t.Fatal(err)
		}
	}
	x := &x11{c: c, root: scr.Root}
	island := Rect{X: sw / 4, Y: sh / 4, W: sw / 2, H: sh / 2}
	mid := func() bool { return x.Covering(sw/2, sh/2, island) }
	edge := func() bool { return x.Covering(island.X+5, island.Y+5, island) }

	if mid() || x.KioskFocused() {
		t.Fatal("the kiosk's window found with no window at all")
	}
	// A screen-sized window that isn't the kiosk's (no role, or another class) isn't the page.
	other := window(0, 0, sw, sh, false, "Chromium", "")
	if mid() {
		t.Fatal("a window with no role counted as the kiosk's")
	}
	unmap(other)
	kiosk := window(0, 0, sw, sh, false, "Chromium", "browser")
	if !mid() || !edge() {
		t.Fatal("the kiosk's own window doesn't count as the page")
	}
	focus(kiosk)
	if !x.KioskFocused() {
		t.Fatal("focus on the kiosk's window doesn't count")
	}

	// A small popup over the middle of the island: refused on it, and beside it in the island too.
	popup := window(sw/2-50, sh/2-50, 100, 100, true, "Chromium", "")
	if mid() || edge() {
		t.Fatal("a press counted as the page with a popup over the island")
	}
	if !x.Covering(5, 5, Rect{X: 0, Y: 0, W: 64, H: 64}) {
		t.Fatal("a popup elsewhere blocks an island it doesn't cross")
	}
	unmap(popup)
	if !mid() {
		t.Fatal("an unmapped popup still blocks")
	}

	// A popup bigger than the island, holding all of it: the press that 0.3.6 let through.
	big := window(island.X-10, island.Y-10, island.W+20, island.H+20, true, "Chromium", "")
	if mid() || edge() {
		t.Fatal("a popup bigger than the island counted as the page")
	}
	unmap(big)

	// A screen-sized window.open (role pop-up), mapped above the kiosk's and given the focus.
	opened := window(0, 0, sw, sh, false, "Chromium", "pop-up")
	focus(opened)
	if mid() || edge() {
		t.Fatal("a screen-sized window.open over the island counted as the page")
	}
	if x.KioskFocused() {
		t.Fatal("keys allowed with the focus on another window")
	}
	// Even a second window with the kiosk's own role, opened later, sits above it, and the lowest is the kiosk's.
	second := window(0, 0, sw, sh, false, "Chromium", "browser")
	if mid() {
		t.Fatal("a later browser window over the kiosk's counted as the page")
	}
	unmap(second)
	unmap(opened)
	focus(kiosk)
	if !mid() || !x.KioskFocused() {
		t.Fatal("the island didn't come back after the windows over it went")
	}
	// The focus back on the root, as when a window.open window closes on :99: keys go to the window under the pointer, so
	// they count only while that's the kiosk's.
	warp := func(px, py int) {
		if err := xproto.WarpPointerChecked(c, xproto.WindowNone, scr.Root, 0, 0, 0, 0, int16(px), int16(py)).Check(); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []xproto.Window{scr.Root, xproto.Window(xproto.InputFocusPointerRoot)} {
		focus(f)
		warp(sw/2, sh/2)
		if !x.KioskFocused() {
			t.Fatalf("focus %#x with the pointer on the kiosk's window doesn't count", f)
		}
		over := window(sw/2-50, sh/2-50, 100, 100, true, "Chromium", "")
		if x.KioskFocused() {
			t.Fatalf("focus %#x with the pointer on a popup counted as the kiosk's", f)
		}
		unmap(over)
	}
	focus(xproto.WindowNone)
	if x.KioskFocused() {
		t.Fatal("no focus at all counted as the kiosk's")
	}
}
