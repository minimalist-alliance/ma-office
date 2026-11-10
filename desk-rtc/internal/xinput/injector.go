package xinput

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// keyQueue bounds keys, buttons and wheel while X is busy. Past it they're dropped and counted, so
	// a stuck X server can't stall SCTP's shared receive window.
	keyQueue    = 512
	dialEvery   = 500 * time.Millisecond
	wheelNotch  = 120 // CSS pixels per X wheel click, measured on the kiosk Chromium at scale 1
	maxPerEvent = 20  // X wheel clicks from one event

	// Chromium caps one scroll update at the scroller's visible size (1065 px here, 1080 less the 15 px
	// scrollbar), and it can merge clicks sent together into one update: 10 clicks scrolled 1200 or 1064.
	// So a big event goes out in batches below that, far enough apart not to merge.
	wheelBatch = 8
	wheelGap   = 25 * time.Millisecond

	keysymShiftL = 0xffe1
	keysymShiftR = 0xffe2
)

// Cursor is the remote pointer's shape. Width and Height are 0 when it's hidden.
type Cursor struct {
	HotX, HotY    uint16
	Width, Height uint16
	PNG           []byte
}

// display is the X connection as the injector sees it, so tests can run without X.
type display interface {
	Size() (w, h int)
	Motion(x, y int)
	ButtonEvent(button byte, down bool)
	KeyEvent(code byte, down bool)
	// Covering is true when a press at (x, y) on island r goes to the page: the kiosk's own window is under it and holds
	// all of r, and no mapped window stacked above the kiosk's crosses r (ADR 0075 decision 4). False when it can't tell.
	Covering(x, y int, r Rect) bool
	// KioskFocused is true when X's keyboard focus is in the kiosk's window, so an island's key reaches the page and not
	// a popup that took the focus (ADR 0075 decision 3). False when it can't tell.
	KioskFocused() bool
	// Lookup finds a keysym in the keymap: its keycode and level (0 or 1), and whether its other level
	// has a different symbol.
	Lookup(keysym uint32) (code byte, level int, cased bool, ok bool)
	// MapSpare puts keysym on a keycode Chromium ignores and returns it, never one in the avoid set.
	MapSpare(keysym uint32, avoid map[byte]bool) (byte, error)
	Alive() bool
	Close()
}

type queued struct {
	owner uint32
	ev    Event
}

type owner struct {
	haveSeq bool
	seq     uint32
	keys    map[uint32]byte
	buttons map[byte]bool
	remX    int
	remY    int
}

// Injector is the one writer to the X display. Sessions are owners: each has its own held keys, so
// closing a session releases what it held and nothing else.
type Injector struct {
	log  *slog.Logger
	dial func() (display, error)

	q     chan queued
	wake  chan struct{}
	stop  chan struct{}
	done  chan struct{}
	once  sync.Once
	moveM sync.Mutex
	move  *queued
	kick  atomic.Bool

	dropped atomic.Uint64

	// The island in effect (island.go), or nil for the whole screen. Read when an event is applied, so an event queued for
	// an island that has since changed is checked against the new one, and dropped.
	island    atomic.Pointer[Island]
	stale     atomic.Uint64 // events dropped because they were for another island, or for the whole screen during one
	blocked   atomic.Uint64 // presses with something else over the island, and keys with the focus outside the kiosk's window
	onBlocked func(epoch uint8)

	// Only the run goroutine touches these.
	conn     display
	lastDial time.Time
	owners   map[uint32]*owner
	release  chan uint32

	cursorMu sync.Mutex
	cursor   *Cursor
	onCursor func(Cursor)
}

// New starts an injector for an X display such as ":99". It connects when first needed, and again
// after the X server restarts, so desk-rtc can start long before desk-xorg.
func New(displayName string, log *slog.Logger) *Injector {
	in := newInjector(log, nil)
	in.dial = func() (display, error) { return dialX(displayName, log, in.setCursor) }
	go in.run()

	return in
}

func newInjector(log *slog.Logger, dial func() (display, error)) *Injector {
	return &Injector{
		log:     log,
		dial:    dial,
		q:       make(chan queued, keyQueue),
		wake:    make(chan struct{}, 1),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		owners:  map[uint32]*owner{},
		release: make(chan uint32, 64),
	}
}

// OnCursor sets who hears about shape changes. Call it before any input arrives.
func (in *Injector) OnCursor(f func(Cursor)) {
	in.cursorMu.Lock()
	in.onCursor = f
	in.cursorMu.Unlock()
}

// CurrentCursor is the last shape seen, or nil.
func (in *Injector) CurrentCursor() *Cursor {
	in.cursorMu.Lock()
	defer in.cursorMu.Unlock()

	return in.cursor
}

func (in *Injector) setCursor(c Cursor) {
	in.cursorMu.Lock()
	in.cursor = &c
	f := in.onCursor
	in.cursorMu.Unlock()
	if f != nil {
		f(c)
	}
}

// Submit hands over one event and never blocks. False means it was dropped.
func (in *Injector) Submit(ownerID uint32, ev Event) bool {
	if ev.Kind == Move {
		in.moveM.Lock()
		in.move = &queued{ownerID, ev}
		in.moveM.Unlock()
		in.notify()

		return true
	}
	select {
	case in.q <- queued{ownerID, ev}:
		return true
	default:
		in.dropped.Add(1)

		return false
	}
}

// Release lets go of everything an owner holds, when its session closes or loses input.
func (in *Injector) Release(ownerID uint32) {
	select {
	case in.release <- ownerID:
		in.notify()
	default:
		in.Submit(ownerID, Event{Kind: ReleaseAll})
	}
}

// Kick connects to X now if it can, so the cursor shape is known before the first input.
func (in *Injector) Kick() {
	in.kick.Store(true)
	in.notify()
}

// Dropped counts events lost to a full queue or a missing X server.
func (in *Injector) Dropped() uint64 { return in.dropped.Load() }

// SetIsland puts an island in effect, or the whole screen for nil. It takes effect for every event applied after it,
// including ones already queued.
func (in *Injector) SetIsland(isl *Island) {
	if isl != nil {
		c := *isl
		isl = &c
	}
	in.island.Store(isl)
}

// OnBlocked sets who hears about a press dropped because something else was over the island. Call it before any input.
func (in *Injector) OnBlocked(f func(epoch uint8)) { in.onBlocked = f }

// IslandDrops counts events dropped by the island's rules: for another island or the whole screen; and presses with
// something else over the island, or keys with X's focus outside the kiosk's window.
func (in *Injector) IslandDrops() (stale, blocked uint64) { return in.stale.Load(), in.blocked.Load() }

// Close stops the injector and releases everything held.
func (in *Injector) Close() {
	in.once.Do(func() { close(in.stop) })
	<-in.done
}

func (in *Injector) notify() {
	select {
	case in.wake <- struct{}{}:
	default:
	}
}

func (in *Injector) run() {
	defer close(in.done)
	for {
		select {
		case <-in.stop:
			in.releaseEverything()
			if in.conn != nil {
				in.conn.Close()
			}

			return
		case q := <-in.q:
			in.apply(q)
		case id := <-in.release:
			in.releaseOwner(id)
			delete(in.owners, id)
		case <-in.wake:
			if in.kick.Swap(false) {
				in.ensureConn()
			}
			in.moveM.Lock()
			m := in.move
			in.move = nil
			in.moveM.Unlock()
			if m != nil {
				in.apply(*m)
			}
		}
	}
}

// ensureConn returns a live connection, or nil. A dead one means the X server went away, and held
// keys went with it.
func (in *Injector) ensureConn() display {
	if in.conn != nil && !in.conn.Alive() {
		in.conn.Close()
		in.conn = nil
		for _, o := range in.owners {
			o.keys, o.buttons = nil, nil
		}
	}
	if in.conn != nil {
		return in.conn
	}
	if time.Since(in.lastDial) < dialEvery {
		return nil
	}
	in.lastDial = time.Now()
	c, err := in.dial()
	if err != nil {
		in.log.Debug("no X display yet", "err", err)

		return nil
	}
	in.log.Info("connected to the X display")
	in.conn = c

	return c
}

func (in *Injector) ownerOf(id uint32) *owner {
	o := in.owners[id]
	if o == nil {
		o = &owner{}
		in.owners[id] = o
	}
	if o.keys == nil {
		o.keys = map[uint32]byte{}
		o.buttons = map[byte]bool{}
	}

	return o
}

func (in *Injector) apply(q queued) {
	o := in.ownerOf(q.owner)
	ev := q.ev
	if ev.Kind == Move && o.haveSeq && !newerSeq(ev.Seq, o.seq) {
		return // a late move can't undo a later click
	}
	if !o.haveSeq || newerSeq(ev.Seq, o.seq) {
		o.seq, o.haveSeq = ev.Seq, true
	}
	c := in.ensureConn()
	if c == nil {
		in.dropped.Add(1)

		return
	}
	isl := in.island.Load()
	want := uint8(0)
	if isl != nil {
		want = isl.Epoch
	}
	current := ev.Island == want
	// A release of what this owner holds always goes, so nothing stays down when an island ends or the page's focus leaves
	// it: where the event says if it's for the picture in effect, else where the pointer is. Everything else must be for
	// the picture in effect.
	_, keyHeld := o.keys[ev.Keysym]
	release := (ev.Kind == Button && !ev.Down && o.buttons[ev.Button]) || (ev.Kind == Key && !ev.Down && keyHeld)
	if ev.Kind != ReleaseAll && !release && (!current || (ev.Kind == Key && isl != nil && !isl.Keys)) {
		in.stale.Add(1)

		return
	}
	switch ev.Kind {
	case Move:
		in.moveTo(c, ev.X, ev.Y, isl)
	case Button:
		code := ev.Button
		if !ev.Down {
			if isl != nil && !release {
				return // on an island, an up for a press that never went (blocked or stale) goes nowhere
			}
			if current {
				in.moveTo(c, ev.X, ev.Y, isl)
			}
			delete(o.buttons, code)
			c.ButtonEvent(code, false)

			return
		}
		px, py, r := in.moveTo(c, ev.X, ev.Y, isl)
		if isl != nil && !c.Covering(px, py, r) {
			in.blockedOn(isl)

			return
		}
		o.buttons[code] = true
		c.ButtonEvent(code, true)
	case Wheel:
		in.moveTo(c, ev.X, ev.Y, isl)
		wheel(c, o, ev.DX, ev.DY)
	case Key:
		if isl != nil && ev.Down && !c.KioskFocused() {
			in.blockedOn(isl) // only a press: a held key's release isn't Down, so it still goes

			return
		}
		in.key(c, o, ev.Keysym, ev.Down)
	case ReleaseAll:
		in.releaseHeld(c, o)
	}
}

// blockedOn counts an island's press or key that X says would reach something other than the page, and tells deskd.
func (in *Injector) blockedOn(isl *Island) {
	in.blocked.Add(1)
	if in.onBlocked != nil {
		in.onBlocked(isl.Epoch)
	}
}

// moveTo puts the pointer at a normalized point of the picture: the whole screen, or the island's rectangle as
// desk-stream crops it. It returns the pixel and the rectangle.
func (in *Injector) moveTo(c display, x, y uint16, isl *Island) (int, int, Rect) {
	w, h := c.Size()
	r := Rect{W: w, H: h}
	if isl != nil {
		r = ClipCrop(isl.Rect, w, h)
	}
	px, py := r.X+scale(x, r.W), r.Y+scale(y, r.H)
	c.Motion(px, py)

	return px, py, r
}

// scale maps 0-65535 onto 0..size-1, rounding.
func scale(v uint16, size int) int {
	if size <= 1 {
		return 0
	}

	return (int(v)*(size-1) + 32767) / 65535
}

func wheel(c display, o *owner, dx, dy int16) {
	o.remX += int(dx)
	o.remY += int(dy)
	clicks := func(rem *int, neg, pos byte) {
		n := *rem / wheelNotch
		*rem -= n * wheelNotch
		b := pos
		if n < 0 {
			n, b = -n, neg
		}
		if n > maxPerEvent {
			n = maxPerEvent
		}
		for i := range n {
			if i > 0 && i%wheelBatch == 0 {
				time.Sleep(wheelGap)
			}
			c.ButtonEvent(b, true)
			c.ButtonEvent(b, false)
		}
	}
	clicks(&o.remY, 4, 5)
	clicks(&o.remX, 6, 7)
}

// shiftsHeld lists the Shift keycodes any owner holds.
func (in *Injector) shiftsHeld() []byte {
	var out []byte
	for _, o := range in.owners {
		for _, sym := range []uint32{keysymShiftL, keysymShiftR} {
			if code, ok := o.keys[sym]; ok {
				out = append(out, code)
			}
		}
	}

	return out
}

func (in *Injector) heldCodes() map[byte]bool {
	m := map[byte]bool{}
	for _, o := range in.owners {
		for _, code := range o.keys {
			m[code] = true
		}
	}

	return m
}

func (in *Injector) key(c display, o *owner, sym uint32, down bool) {
	code, held := o.keys[sym]
	if !down {
		if held {
			c.KeyEvent(code, false)
			delete(o.keys, sym)
		}

		return
	}
	if held {
		c.KeyEvent(code, false) // a repeat: X ignores a press of a key that's already down
	}
	level, cased := -1, false
	if !held {
		var ok bool
		code, level, cased, ok = c.Lookup(sym)
		if !ok {
			var err error
			if code, err = c.MapSpare(sym, in.heldCodes()); err != nil {
				in.log.Warn("no spare keycode", "keysym", sym, "err", err)
				in.dropped.Add(1)

				return
			}
		}
		o.keys[sym] = code
	} else {
		_, level, cased, _ = c.Lookup(sym)
	}

	shifts := in.shiftsHeld()
	isShift := sym == keysymShiftL || sym == keysymShiftR
	printable := sym < 0x100 || sym >= 0x01000000
	switch {
	case isShift:
		c.KeyEvent(code, true)
	case level == 1 && len(shifts) == 0:
		shiftCode, _, _, ok := c.Lookup(keysymShiftL)
		if !ok {
			c.KeyEvent(code, true)

			return
		}
		c.KeyEvent(shiftCode, true)
		c.KeyEvent(code, true)
		c.KeyEvent(shiftCode, false)
	case level == 0 && len(shifts) > 0 && printable && cased:
		for _, s := range shifts {
			c.KeyEvent(s, false)
		}
		c.KeyEvent(code, true)
		for _, s := range shifts {
			c.KeyEvent(s, true)
		}
	default:
		c.KeyEvent(code, true)
	}
}

func (in *Injector) releaseHeld(c display, o *owner) {
	for sym, code := range o.keys {
		c.KeyEvent(code, false)
		delete(o.keys, sym)
	}
	for b := range o.buttons {
		c.ButtonEvent(b, false)
		delete(o.buttons, b)
	}
	o.remX, o.remY = 0, 0
}

func (in *Injector) releaseOwner(id uint32) {
	o := in.owners[id]
	if o == nil {
		return
	}
	if in.conn != nil && in.conn.Alive() {
		in.releaseHeld(in.conn, o)
	}
}

func (in *Injector) releaseEverything() {
	for id := range in.owners {
		in.releaseOwner(id)
	}
}
