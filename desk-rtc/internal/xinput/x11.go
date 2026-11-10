package xinput

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	stdlog "log"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xext"
)

// maxCursorPNG keeps a CURSOR message inside one 16 KiB frame.
const maxCursorPNG = 16*1024 - 10

func init() {
	// xgb logs "Could not get authority info" on every connect. Access comes from xhost
	// (SI:localuser:rtc), so that's normal here.
	xgb.Logger = stdlog.New(io.Discard, "", 0)
}

type x11 struct {
	c    *xgb.Conn
	log  *slog.Logger
	root xproto.Window

	alive atomic.Bool

	mu   sync.Mutex
	w, h int

	// Only the injector's goroutine touches the keymap.
	perCode int
	minCode int
	maxCode int
	table   map[uint32]keyEntry
	spare   *sparePool

	onCursor   func(Cursor)
	lastSerial uint32
	haveSerial bool

	// WM_WINDOW_ROLE, interned on the injector's goroutine at the first island press or key.
	roleAtom xproto.Atom
}

type keyEntry struct {
	code  byte
	level int
	cased bool
}

func dialX(name string, log *slog.Logger, onCursor func(Cursor)) (display, error) {
	c, err := xgb.NewConnDisplay(name)
	if err != nil {
		return nil, err
	}
	x := &x11{c: c, log: log, onCursor: onCursor}
	if err := x.setup(); err != nil {
		c.Close()

		return nil, err
	}
	x.alive.Store(true)
	go x.events()
	go x.readCursor() // the shape in place now, before any change

	return x, nil
}

func (x *x11) setup() error {
	if err := xtest.Init(x.c); err != nil {
		return fmt.Errorf("XTEST: %w", err)
	}
	if err := xext.InitXFixes(x.c); err != nil {
		return fmt.Errorf("XFIXES: %w", err)
	}
	if _, err := xfixes.QueryVersion(x.c, 4, 0).Reply(); err != nil {
		return fmt.Errorf("XFIXES version: %w", err)
	}
	setup := xproto.Setup(x.c)
	screen := setup.DefaultScreen(x.c)
	x.root = screen.Root
	x.w, x.h = int(screen.WidthInPixels), int(screen.HeightInPixels)
	x.minCode, x.maxCode = int(setup.MinKeycode), int(setup.MaxKeycode)
	if err := x.loadKeymap(); err != nil {
		return fmt.Errorf("keymap: %w", err)
	}
	x.checkRules()
	// X's own auto-repeat off: the client repeats, so one that vanishes can't leave a key repeating.
	if err := xproto.ChangeKeyboardControlChecked(x.c, xproto.KbAutoRepeatMode,
		[]uint32{xproto.AutoRepeatModeOff}).Check(); err != nil {
		return fmt.Errorf("auto-repeat: %w", err)
	}
	if err := xproto.ChangeWindowAttributesChecked(x.c, x.root, xproto.CwEventMask,
		[]uint32{xproto.EventMaskStructureNotify}).Check(); err != nil {
		return fmt.Errorf("root events: %w", err)
	}
	if err := xfixes.SelectCursorInputChecked(x.c, x.root, xfixes.CursorNotifyMaskDisplayCursor).Check(); err != nil {
		return fmt.Errorf("cursor events: %w", err)
	}

	return nil
}

func (x *x11) loadKeymap() error {
	first := xproto.Keycode(x.minCode)
	count := byte(x.maxCode - x.minCode + 1)
	r, err := xproto.GetKeyboardMapping(x.c, first, count).Reply()
	if err != nil {
		return err
	}
	per := int(r.KeysymsPerKeycode)
	x.perCode = per
	x.table = map[uint32]keyEntry{}
	usable := map[byte]bool{}
	for i := range int(count) {
		code := byte(x.minCode + i)
		syms := r.Keysyms[i*per : (i+1)*per]
		if !slices.ContainsFunc(syms, func(s xproto.Keysym) bool { return s != 0 }) {
			usable[code] = true

			continue
		}
		// The X server outlives desk-rtc across an update, so these are ours from before: keep them, and
		// don't lose the code from the pool for good.
		if slices.Contains(chromiumFreeCodes, code) && ownSpare(syms) {
			usable[code] = true
			x.table[uint32(syms[0])] = keyEntry{code: code, level: -1}

			continue
		}
		base, shifted := uint32(0), uint32(0)
		if per > 0 {
			base = uint32(syms[0])
		}
		if per > 1 {
			shifted = uint32(syms[1])
		}
		cased := shifted != 0 && shifted != base
		if base != 0 {
			if _, dup := x.table[base]; !dup {
				x.table[base] = keyEntry{code, 0, cased}
			}
		}
		if cased {
			if e, dup := x.table[shifted]; !dup || e.level > 1 {
				x.table[shifted] = keyEntry{code, 1, cased}
			}
		}
	}
	x.spare = newSparePool(func(c byte) bool { return usable[c] })
	x.log.Info("keymap loaded", "keysyms", len(x.table), "spares", len(x.spare.codes))
	if len(x.spare.codes) == 0 {
		x.log.Warn("the keymap leaves no spare keycode Chromium ignores: keysyms missing from it won't type")
	}

	return nil
}

// ownSpare says whether a keycode's keysyms read back as what MapSpare leaves. It writes one keysym on
// every level, and X keeps the first four and returns the rest as zero. A keymap's own entry for such a code
// has NoSymbol on the second level.
func ownSpare(syms []xproto.Keysym) bool {
	if len(syms) < 2 || syms[0] == 0 || syms[1] != syms[0] {
		return false
	}

	return !slices.ContainsFunc(syms, func(s xproto.Keysym) bool { return s != 0 && s != syms[0] })
}

// checkRules says when X isn't using evdev keycodes, as an image before 0.2.2 doesn't: Chromium reads
// keycodes as evdev, so e.code is wrong on the keys where the two differ (arrows, Home, End, Delete).
func (x *x11) checkRules() {
	atom, err := xproto.InternAtom(x.c, true, uint16(len("_XKB_RULES_NAMES")), "_XKB_RULES_NAMES").Reply()
	if err != nil || atom.Atom == 0 {
		return
	}
	p, err := xproto.GetProperty(x.c, false, x.root, atom.Atom, xproto.GetPropertyTypeAny, 0, 64).Reply()
	if err != nil || p == nil {
		return
	}
	rules, _, _ := strings.Cut(string(p.Value), "\x00")
	if rules != "evdev" {
		x.log.Warn("X isn't using evdev keycodes: e.code will be wrong on some named keys", "rules", rules)
	}
}

func (x *x11) Size() (int, int) {
	x.mu.Lock()
	defer x.mu.Unlock()

	return x.w, x.h
}

func (x *x11) Motion(px, py int) {
	xtest.FakeInput(x.c, xproto.MotionNotify, 0, 0, x.root, int16(px), int16(py), 0)
}

func (x *x11) ButtonEvent(button byte, down bool) {
	t := byte(xproto.ButtonRelease)
	if down {
		t = xproto.ButtonPress
	}
	xtest.FakeInput(x.c, t, button, 0, xproto.WindowNone, 0, 0, 0)
}

func (x *x11) KeyEvent(code byte, down bool) {
	x.spare.touch(code, time.Now())
	t := byte(xproto.KeyRelease)
	if down {
		t = xproto.KeyPress
	}
	xtest.FakeInput(x.c, t, code, 0, xproto.WindowNone, 0, 0, 0)
}

// The kiosk's window (ADR 0075 decision 4, Security's T47S-1) is Chromium's normal browser window, found by what a page
// can't set: WM_CLASS's class Chromium and WM_WINDOW_ROLE browser, mapped and not override-redirect, the lowest such in
// the stacking order. A window.open popup is a window of its own with the role pop-up; menus, bubbles and a select's list
// are override-redirect. There's no window manager on :99 to restack, so anything opened later is mapped above it.
const (
	kioskClass = "Chromium"
	kioskRole  = "browser"
)

// kioskStack finds the kiosk's window among the root's children, bottom to top, and returns it with the windows stacked
// above it. Zero when there's none, or X can't say. The requests go out together and the replies are read after, so a
// press costs a few round trips' worth of time, not one per window.
func (x *x11) kioskStack() (xproto.Window, []xproto.Window) {
	if x.roleAtom == 0 {
		a, err := xproto.InternAtom(x.c, false, uint16(len("WM_WINDOW_ROLE")), "WM_WINDOW_ROLE").Reply()
		if err != nil {
			return 0, nil
		}
		x.roleAtom = a.Atom
	}
	tree, err := xproto.QueryTree(x.c, x.root).Reply()
	if err != nil {
		return 0, nil
	}
	attrs := make([]xproto.GetWindowAttributesCookie, len(tree.Children))
	for i, w := range tree.Children {
		attrs[i] = xproto.GetWindowAttributes(x.c, w)
	}
	type props struct{ class, role xproto.GetPropertyCookie }
	cand := map[int]props{}
	for i, w := range tree.Children {
		a, err := attrs[i].Reply()
		if err != nil || a.MapState != xproto.MapStateViewable || a.OverrideRedirect {
			continue
		}
		cand[i] = props{
			xproto.GetProperty(x.c, false, w, xproto.AtomWmClass, xproto.AtomString, 0, 256),
			xproto.GetProperty(x.c, false, w, x.roleAtom, xproto.AtomString, 0, 64),
		}
	}
	found := -1
	for i := range tree.Children {
		p, ok := cand[i]
		if !ok {
			continue
		}
		cls, err1 := p.class.Reply()
		role, err2 := p.role.Reply()
		if found >= 0 || err1 != nil || err2 != nil {
			continue // every reply is read, so none is left waiting
		}
		// WM_CLASS is the instance and the class, each ending in NUL.
		parts := strings.Split(string(cls.Value), "\x00")
		if len(parts) >= 2 && parts[1] == kioskClass && string(role.Value) == kioskRole {
			found = i
		}
	}
	if found < 0 {
		return 0, nil
	}

	return tree.Children[found], tree.Children[found+1:]
}

// Covering is true only when a press at (px, py) on island r goes to the page: the kiosk's own window is the top-level
// window there and holds all of r, and no mapped window stacked above it crosses r, however large it is (Security's
// T47S-1: a popup or a screen-sized window.open over a small island holds all of it too). False when X can't say.
func (x *x11) Covering(px, py int, r Rect) bool {
	kiosk, above := x.kioskStack()
	if kiosk == 0 {
		return false
	}
	under := xproto.TranslateCoordinates(x.c, x.root, x.root, int16(px), int16(py))
	kg := xproto.GetGeometry(x.c, xproto.Drawable(kiosk))
	as := make([]xproto.GetWindowAttributesCookie, len(above))
	gs := make([]xproto.GetGeometryCookie, len(above))
	for i, w := range above {
		as[i] = xproto.GetWindowAttributes(x.c, w)
		gs[i] = xproto.GetGeometry(x.c, xproto.Drawable(w))
	}
	ok := true
	for i := range above {
		a, err1 := as[i].Reply()
		g, err2 := gs[i].Reply()
		switch {
		case err1 != nil || err2 != nil:
			// A window that went away between the requests isn't over anything.
			if err1 == nil && a.MapState == xproto.MapStateViewable {
				ok = false
			}
		case a.MapState == xproto.MapStateViewable && windowRect(g).Crosses(r):
			ok = false
		}
	}
	tr, err1 := under.Reply()
	g, err2 := kg.Reply()
	if err1 != nil || err2 != nil || tr.Child != kiosk {
		return false
	}

	return ok && windowRect(g).Contains(r)
}

// KioskFocused is true when a key would reach the kiosk's window (Security's T47S-1: a popup that took the focus would get
// the island's keys). X sends a key to the focus window or one inside it; with the focus on the root or PointerRoot, to
// the window under the pointer. So: the focus in the kiosk's window, or on the root or PointerRoot with the kiosk's the
// top-level window under the pointer. With no window manager on :99, the focus falls back to the root when a window.open
// window closes, and Chromium doesn't take it back (measured on image 0.2.9). False when X can't say.
func (x *x11) KioskFocused() bool {
	kiosk, _ := x.kioskStack()
	if kiosk == 0 {
		return false
	}
	f, err := xproto.GetInputFocus(x.c).Reply()
	if err != nil || f.Focus == xproto.WindowNone {
		return false
	}
	if f.Focus == x.root || f.Focus == xproto.Window(xproto.InputFocusPointerRoot) {
		p, err := xproto.QueryPointer(x.c, x.root).Reply()

		return err == nil && p.SameScreen && p.Child == kiosk
	}
	for w := f.Focus; w != xproto.WindowNone && w != x.root; {
		if w == kiosk {
			return true
		}
		t, err := xproto.QueryTree(x.c, w).Reply()
		if err != nil {
			return false
		}
		w = t.Parent
	}

	return false
}

// windowRect is a window's outside edge, its border included.
func windowRect(g *xproto.GetGeometryReply) Rect {
	b := 2 * int(g.BorderWidth)

	return Rect{X: int(g.X), Y: int(g.Y), W: int(g.Width) + b, H: int(g.Height) + b}
}

func (x *x11) Lookup(sym uint32) (byte, int, bool, bool) {
	e, ok := x.table[sym]

	return e.code, e.level, e.cased, ok
}

// MapSpare puts a keysym on a spare keycode, on every level, so modifiers don't change it. X sends
// MappingNotify ahead of any key event that follows, but that doesn't help: see mapSettle, which holds up
// the key after a remap. It can also wait for reuseAfter, only when the pool has gone round inside that time.
func (x *x11) MapSpare(sym uint32, avoid map[byte]bool) (byte, error) {
	code, wait, ok := x.spare.pick(avoid, time.Now())
	if !ok {
		return 0, errors.New("every spare keycode is held")
	}
	if wait > 0 {
		time.Sleep(wait)
	}
	syms := make([]xproto.Keysym, x.perCode)
	for i := range syms {
		syms[i] = xproto.Keysym(sym)
	}
	if err := xproto.ChangeKeyboardMappingChecked(x.c, 1, xproto.Keycode(code), byte(x.perCode), syms).Check(); err != nil {
		return 0, err
	}
	for s, e := range x.table {
		if e.code == code {
			delete(x.table, s)
		}
	}
	x.table[sym] = keyEntry{code: code, level: -1}
	x.spare.touch(code, time.Now())
	time.Sleep(mapSettle)

	return code, nil
}

func (x *x11) Alive() bool { return x.alive.Load() }

func (x *x11) Close() { x.c.Close() }

func (x *x11) events() {
	for {
		ev, err := x.c.WaitForEvent()
		if ev == nil && err == nil {
			x.alive.Store(false)

			return
		}
		if err != nil {
			x.log.Debug("X error", "err", err)

			continue
		}
		switch e := ev.(type) {
		case xproto.ConfigureNotifyEvent:
			if e.Window == x.root {
				x.mu.Lock()
				x.w, x.h = int(e.Width), int(e.Height)
				x.mu.Unlock()
			}
		case xfixes.CursorNotifyEvent:
			x.readCursor()
		}
	}
}

func (x *x11) readCursor() {
	r, err := xfixes.GetCursorImage(x.c).Reply()
	if err != nil || r == nil {
		return
	}
	x.mu.Lock()
	same := x.haveSerial && x.lastSerial == r.CursorSerial
	x.lastSerial, x.haveSerial = r.CursorSerial, true
	x.mu.Unlock()
	if same {
		return
	}
	x.onCursor(encodeCursor(int(r.Width), int(r.Height), r.Xhot, r.Yhot, r.CursorImage))
}

// encodeCursor turns XFIXES' premultiplied ARGB into a PNG. A fully transparent image is hidden. One
// too big for a frame falls back to the browser's default.
func encodeCursor(w, h int, hotX, hotY uint16, argb []uint32) Cursor {
	hidden := Cursor{}
	if w == 0 || h == 0 || len(argb) < w*h {
		return hidden
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var any uint32
	for i := range w * h {
		p := argb[i]
		any |= p >> 24
		o := img.PixOffset(i%w, i/w)
		img.Pix[o+0] = byte(p >> 16)
		img.Pix[o+1] = byte(p >> 8)
		img.Pix[o+2] = byte(p)
		img.Pix[o+3] = byte(p >> 24)
	}
	if any == 0 {
		return hidden
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, img); err != nil || buf.Len() > maxCursorPNG {
		return Cursor{HotX: hotX, HotY: hotY, Width: uint16(w), Height: uint16(h)}
	}

	return Cursor{HotX: hotX, HotY: hotY, Width: uint16(w), Height: uint16(h), PNG: buf.Bytes()}
}

// CursorMessage is the section 8.6 CURSOR message for c.
func CursorMessage(c Cursor) []byte {
	b := make([]byte, 10, 10+len(c.PNG))
	b[0] = 0x81
	put := func(at int, v uint16) { b[at], b[at+1] = byte(v>>8), byte(v) }
	put(2, c.HotX)
	put(4, c.HotY)
	put(6, c.Width)
	put(8, c.Height)

	return append(b, c.PNG...)
}
