package xinput

import (
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jezek/xgb/xproto"
)

type fakeDisplay struct {
	mu    sync.Mutex
	calls []string
	spare byte
	// over is a window stacked over the page, in screen pixels: Covering is false for any island it crosses. Zero for none.
	over Rect
	// focusAway is X's focus on some window other than the kiosk's.
	focusAway bool
}

func (f *fakeDisplay) rec(s string, a ...any) {
	f.mu.Lock()
	f.calls = append(f.calls, fmt.Sprintf(s, a...))
	f.mu.Unlock()
}
func (f *fakeDisplay) Size() (int, int)           { return 1920, 1080 }
func (f *fakeDisplay) Motion(x, y int)            { f.rec("move %d,%d", x, y) }
func (f *fakeDisplay) ButtonEvent(b byte, d bool) { f.rec("btn %d %v", b, d) }
func (f *fakeDisplay) KeyEvent(c byte, d bool)    { f.rec("key %d %v", c, d) }
func (f *fakeDisplay) Alive() bool                { return true }
func (f *fakeDisplay) Covering(x, y int, r Rect) bool {
	f.mu.Lock()
	defer f.mu.Unlock()

	return !f.over.Crosses(r)
}
func (f *fakeDisplay) KioskFocused() bool {
	f.mu.Lock()
	defer f.mu.Unlock()

	return !f.focusAway
}
func (f *fakeDisplay) Close() {}
func (f *fakeDisplay) Lookup(sym uint32) (byte, int, bool, bool) {
	switch sym {
	case 'a':
		return 38, 0, true, true
	case 'A':
		return 38, 1, true, true
	case keysymShiftL:
		return 50, 0, false, true
	case 0xff0d: // Return: same on both levels
		return 36, 0, false, true
	}

	return 0, 0, false, false
}
func (f *fakeDisplay) MapSpare(sym uint32, avoid map[byte]bool) (byte, error) {
	f.spare++
	f.rec("map %x", sym)

	return 200 + f.spare, nil
}
func (f *fakeDisplay) take() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := strings.Join(f.calls, "; ")
	f.calls = nil

	return s
}

func rig(t *testing.T) (*Injector, *fakeDisplay) {
	t.Helper()
	d := &fakeDisplay{}
	in := newInjector(slog.New(slog.NewTextHandler(io.Discard, nil)), func() (display, error) { return d, nil })
	go in.run()
	t.Cleanup(in.Close)

	return in, d
}

// settle waits until the injector's queue is empty and its goroutine has acted on it.
func settle(in *Injector) {
	time.Sleep(30 * time.Millisecond)
}

func TestParse(t *testing.T) {
	b := make([]byte, 16)
	b[0], b[1] = 4, 1
	binary.BigEndian.PutUint32(b[4:], 7)
	binary.BigEndian.PutUint32(b[12:], 'a')
	e, ok := Parse(b)
	if !ok || e.Kind != Key || !e.Down || e.Seq != 7 || e.Keysym != 'a' {
		t.Fatalf("%+v %v", e, ok)
	}
	if _, ok := Parse(b[:15]); ok {
		t.Fatal("short message accepted")
	}
	b[0] = 9
	if _, ok := Parse(b); ok {
		t.Fatal("unknown type accepted")
	}
	b[0], b[2] = 2, 4
	if _, ok := Parse(b); ok {
		t.Fatal("button 4 is the wheel, not a BUTTON event")
	}
	w := make([]byte, 16)
	w[0] = 3
	binary.BigEndian.PutUint16(w[12:], 0xffff)
	binary.BigEndian.PutUint16(w[14:], 100)
	e, ok = Parse(w)
	if !ok || e.DX != -1 || e.DY != 100 {
		t.Fatalf("wheel %+v", e)
	}
	h := make([]byte, 16)
	h[0] = 6
	binary.BigEndian.PutUint16(h[12:], 140)
	if e, ok = Parse(h); !ok || e.Kind != Hold || e.HoldMs != 140 {
		t.Fatalf("hold %+v %v", e, ok)
	}
}

func TestScale(t *testing.T) {
	for _, c := range []struct {
		v    uint16
		size int
		want int
	}{{0, 1920, 0}, {65535, 1920, 1919}, {32768, 1920, 960}, {65535, 1080, 1079}} {
		if got := scale(c.v, c.size); got != c.want {
			t.Errorf("scale(%d,%d) = %d, want %d", c.v, c.size, got, c.want)
		}
	}
}

func TestLateMoveCantUndoAClick(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Button, Button: 1, Down: true, Seq: 10, X: 65535, Y: 65535})
	settle(in)
	d.take()
	in.Submit(1, Event{Kind: Move, Seq: 9, X: 0, Y: 0})
	settle(in)
	if got := d.take(); got != "" {
		t.Fatalf("late move applied: %s", got)
	}
	in.Submit(1, Event{Kind: Move, Seq: 11, X: 0, Y: 0})
	settle(in)
	if got := d.take(); got != "move 0,0" {
		t.Fatalf("newer move: %s", got)
	}
}

func TestSeqWraps(t *testing.T) {
	if !newerSeq(1, 0xffffffff) || newerSeq(0xffffffff, 1) || newerSeq(5, 5) {
		t.Fatal("wrapping compare is wrong")
	}
}

func TestKeyLevelsAndShift(t *testing.T) {
	in, d := rig(t)
	// 'A' with no Shift held: desk-rtc adds Shift around the press.
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 1, Keysym: 'A'})
	settle(in)
	if got := d.take(); got != "key 50 true; key 38 true; key 50 false" {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Key, Down: false, Seq: 2, Keysym: 'A'})
	settle(in)
	if got := d.take(); got != "key 38 false" {
		t.Fatal(got)
	}
	// 'A' with Shift held: nothing extra.
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 3, Keysym: keysymShiftL})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 4, Keysym: 'A'})
	settle(in)
	if got := d.take(); got != "key 50 true; key 38 true" {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Key, Down: false, Seq: 5, Keysym: 'A'})
	settle(in)
	d.take()
	// 'a' with Shift held (Caps Lock on the client): Shift lifts around the press.
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 6, Keysym: 'a'})
	settle(in)
	if got := d.take(); got != "key 50 false; key 38 true; key 50 true" {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Key, Down: false, Seq: 7, Keysym: 'a'})
	settle(in)
	d.take()
	// Shift+Enter keeps Shift.
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 8, Keysym: 0xff0d})
	settle(in)
	if got := d.take(); got != "key 36 true" {
		t.Fatal(got)
	}
}

func TestRepeatIsReleaseThenPress(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 1, Keysym: 'a'})
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 2, Keysym: 'a'})
	settle(in)
	if got := d.take(); got != "key 38 true; key 38 false; key 38 true" {
		t.Fatal(got)
	}
}

func TestKeysymNotInTheMapGetsASpareKeycode(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 1, Keysym: 0x010020ac})
	settle(in)
	if got := d.take(); got != "map 10020ac; key 201 true" {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Key, Down: false, Seq: 2, Keysym: 0x010020ac})
	settle(in)
	if got := d.take(); got != "key 201 false" {
		t.Fatal(got)
	}
}

func TestWheelKeepsTheRemainder(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Wheel, Seq: 1, DY: 100})
	settle(in)
	if got := d.take(); strings.Contains(got, "btn") {
		t.Fatalf("under a notch: %s", got)
	}
	in.Submit(1, Event{Kind: Wheel, Seq: 2, DY: 30}) // 130 in all: one click, 10 left
	settle(in)
	if got := d.take(); strings.Count(got, "btn 5 true; btn 5 false") != 1 {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Wheel, Seq: 3, DY: -250}) // -240 in all: two clicks up, nothing left
	settle(in)
	if got := d.take(); strings.Count(got, "btn 4 true") != 2 {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Wheel, Seq: 4, DY: 119}) // nothing was left, so still under a notch
	settle(in)
	if got := d.take(); strings.Contains(got, "btn") {
		t.Fatalf("a remainder survived: %s", got)
	}
}

func TestWheelSendsOneClickPerNotchInBothAxes(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Wheel, Seq: 1, DX: 530, DY: -530}) // 4 clicks each way, 50 left over in each
	settle(in)
	got := d.take()
	if strings.Count(got, "btn 7 true") != 4 || strings.Count(got, "btn 4 true") != 4 {
		t.Fatal(got)
	}
	in.Submit(1, Event{Kind: Wheel, Seq: 2, DX: 70, DY: -70}) // the remainders make one more each
	settle(in)
	got = d.take()
	if strings.Count(got, "btn 7 true") != 1 || strings.Count(got, "btn 4 true") != 1 {
		t.Fatal(got)
	}
}

func TestChromiumFreeCodesLeaveOutKeysWithAMeaning(t *testing.T) {
	// From the failures on the first real stream check, and the rest of evdev's named keys.
	for _, c := range []byte{
		9, 22, 23, 36, 37, 50, 62, 64, 66, 77, 78, // Escape, Backspace, Tab, Enter, modifiers
		92, 93, 97, 103, 104, 105, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, // AltGr, Lang5, keypad, arrows, Delete
		121, 122, 123, 124, 127, 133, 134, 135, // volume, power, Pause, Meta, ContextMenu
		136, 137, 139, 140, 141, 142, 143, 144, 145, 146, 148, 150, 151, 152, // Stop, Again, Undo..Help, Sleep
		163, 164, 166, 167, 169, 171, 172, 173, 174, 175, 176, 179, 180, 181, // Back, Forward, media, Home, Refresh
		191, 202, 212, 215, 225, 232, 233, 235, 237, 238, 239, 240, 241, // F13-F24, Search, brightness, mail
	} {
		if slices.Contains(chromiumFreeCodes, c) {
			t.Errorf("keycode %d has a meaning in Chromium", c)
		}
	}
	for _, c := range chromiumFreeCodes {
		if c < 8 {
			t.Errorf("keycode %d is not an X keycode", c)
		}
	}
}

func TestWheelCapsOneEventAndSendsTheRestInBatches(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Wheel, Seq: 1, DY: 32000}) // 266 clicks' worth: the cap, not a flood
	settle(in)
	time.Sleep(3 * wheelGap)
	if got := d.take(); strings.Count(got, "btn 5 true") != maxPerEvent || strings.Count(got, "btn 5 false") != maxPerEvent {
		t.Fatal(got)
	}
}

func TestOwnSpareRecognizesWhatMapSpareLeaves(t *testing.T) {
	for _, c := range []struct {
		syms []xproto.Keysym
		want bool
	}{
		{[]xproto.Keysym{0xe9, 0xe9, 0xe9, 0xe9, 0, 0, 0}, true}, // as X returns MapSpare's seven keysyms
		{[]xproto.Keysym{0xe9, 0xe9, 0xe9, 0xe9, 0xe9, 0xe9, 0xe9}, true},
		{[]xproto.Keysym{0x1008ff41, 0, 0x1008ff41, 0, 0, 0, 0}, false},                      // XF86Launch1, as the keymap has it
		{[]xproto.Keysym{0xffc8, 0xffc8, 0xffc8, 0xffc8, 0xffc8, 0xffc8, 0x1008fe0b}, false}, // F11
		{[]xproto.Keysym{0x61, 0x41, 0x61, 0x41, 0, 0, 0}, false},
		{[]xproto.Keysym{0, 0, 0, 0, 0, 0, 0}, false},
		{[]xproto.Keysym{0xe9}, false},
	} {
		if got := ownSpare(c.syms); got != c.want {
			t.Errorf("ownSpare(%x) = %v, want %v", c.syms, got, c.want)
		}
	}
}

func TestSparePoolKeepsOnlyUsableFreeCodes(t *testing.T) {
	p := newSparePool(func(c byte) bool { return c == 120 || c == 181 || c == 248 })
	if !slices.Equal(p.codes, []byte{120, 248}) {
		t.Fatalf("181 is BrowserRefresh and must not be used, and the rest aren't empty: %v", p.codes)
	}
	none := newSparePool(func(byte) bool { return false })
	if _, _, ok := none.pick(nil, time.Now()); ok {
		t.Fatal("picked from an empty pool")
	}
}

func TestSparePoolUsesEveryCodeBeforeReusingAny(t *testing.T) {
	p := newSparePool(func(byte) bool { return true })
	now := time.Unix(1000, 0)
	seen := map[byte]bool{}
	for range chromiumFreeCodes {
		c, wait, ok := p.pick(nil, now)
		if !ok || wait != 0 || seen[c] {
			t.Fatalf("code %d wait %v ok %v, seen %v", c, wait, ok, seen)
		}
		seen[c] = true
		p.touch(c, now)
		now = now.Add(time.Second)
	}
}

func TestSparePoolReusesTheOneIdleLongest(t *testing.T) {
	p := newSparePool(func(c byte) bool { return c == 120 || c == 126 || c == 138 })
	t0 := time.Unix(1000, 0)
	p.touch(120, t0)
	p.touch(126, t0.Add(time.Second))
	p.touch(138, t0.Add(2*time.Second))
	p.touch(120, t0.Add(3*time.Second)) // the first one typed again: it's now the newest
	c, wait, ok := p.pick(nil, t0.Add(10*time.Second))
	if !ok || c != 126 || wait != 0 {
		t.Fatalf("got %d, wait %v", c, wait)
	}
}

func TestSparePoolNeverTakesAHeldCode(t *testing.T) {
	p := newSparePool(func(c byte) bool { return c == 120 || c == 126 })
	now := time.Unix(1000, 0)
	p.touch(120, now)
	p.touch(126, now)
	c, _, ok := p.pick(map[byte]bool{120: true}, now.Add(time.Minute))
	if !ok || c != 126 {
		t.Fatalf("got %d %v", c, ok)
	}
	if _, _, ok := p.pick(map[byte]bool{120: true, 126: true}, now); ok {
		t.Fatal("every code is held")
	}
}

func TestSparePoolWaitsBeforeReusingARecentCode(t *testing.T) {
	p := newSparePool(func(c byte) bool { return c == 120 })
	t0 := time.Unix(1000, 0)
	if _, wait, _ := p.pick(nil, t0); wait != 0 {
		t.Fatalf("a never-used code waited %v", wait)
	}
	p.touch(120, t0)
	if _, wait, _ := p.pick(nil, t0.Add(100*time.Millisecond)); wait != reuseAfter-100*time.Millisecond {
		t.Fatalf("wait %v", wait)
	}
	if _, wait, _ := p.pick(nil, t0.Add(reuseAfter)); wait != 0 {
		t.Fatalf("wait %v after the rest", wait)
	}
	p.touch(99, t0) // not in the pool: ignored
	if _, in := p.last[99]; in {
		t.Fatal("a code outside the pool was recorded")
	}
}

func TestReleaseOnCloseAndReleaseAll(t *testing.T) {
	in, d := rig(t)
	in.Submit(1, Event{Kind: Key, Down: true, Seq: 1, Keysym: 'a'})
	in.Submit(2, Event{Kind: Button, Button: 1, Down: true, Seq: 1})
	settle(in)
	d.take()
	in.Release(1)
	settle(in)
	if got := d.take(); got != "key 38 false" {
		t.Fatalf("release of owner 1 touched more: %s", got)
	}
	in.Submit(2, Event{Kind: ReleaseAll, Seq: 2})
	settle(in)
	if got := d.take(); got != "btn 1 false" {
		t.Fatal(got)
	}
}

func TestCursorMessage(t *testing.T) {
	c := encodeCursor(2, 1, 1, 0, []uint32{0xff112233, 0x00000000})
	if c.Width != 2 || c.Height != 1 || c.HotX != 1 || len(c.PNG) == 0 {
		t.Fatalf("%+v", c)
	}
	m := CursorMessage(c)
	if m[0] != 0x81 || binary.BigEndian.Uint16(m[2:]) != 1 || binary.BigEndian.Uint16(m[6:]) != 2 ||
		string(m[11:14]) != "PNG" {
		t.Fatalf("% x", m[:16])
	}
	if h := encodeCursor(2, 1, 0, 0, []uint32{0, 0}); h.Width != 0 || h.PNG != nil {
		t.Fatalf("fully transparent should be hidden: %+v", h)
	}
}
