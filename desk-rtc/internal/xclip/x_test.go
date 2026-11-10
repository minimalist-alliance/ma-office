package xclip

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// The tests below need a real X server of their own. XCLIP_TEST_DISPLAY names one that you started for this and
// nothing else is on: they take its clipboard, and one of them grabs the whole server.
//
//	Xvfb :173 -screen 0 1280x800x24 -nolisten tcp -noreset &
//	XCLIP_TEST_DISPLAY=:173 go test -p 1 -parallel 1 ./internal/xclip/
//
// -noreset is what desk-xorg runs with. Without it, the server resets each time its last client leaves, and
// refuses whoever connects in the middle of that, which is what one test's end and the next one's start look like.
//
// XCLIP_TEST_XVFB also names the Xvfb binary, and XCLIP_TEST_XVFB_DISPLAY a free display for it, for the test that
// stops and restarts a server. That test starts its own, and kills only that one, by PID.
func xdisplay(t *testing.T) string {
	t.Helper()
	d := os.Getenv("XCLIP_TEST_DISPLAY")
	if d == "" {
		t.Skip("XCLIP_TEST_DISPLAY doesn't name a private X server")
	}
	if d == ":10" || d == ":0" {
		t.Fatalf("%s isn't a private display", d)
	}

	return d
}

const testWait = 5 * time.Second

// other is another X client, on its own connection, the way Chromium is one.
type other struct {
	t      *testing.T
	c      *xgb.Conn
	win    xproto.Window
	events chan xgb.Event
	errs   chan xgb.Error
	once   sync.Once

	clipboard, primary, utf8, textPlain, targets, timestamp, incr, prop, bogus xproto.Atom
}

func newOther(t *testing.T, display string) *other {
	t.Helper()
	c, err := xgb.NewConnDisplay(display)
	if err != nil {
		t.Fatalf("connect %s: %v", display, err)
	}
	o := &other{t: t, c: c, events: make(chan xgb.Event, 8192), errs: make(chan xgb.Error, 1024)}
	t.Cleanup(o.close)
	for name, a := range map[string]*xproto.Atom{
		"CLIPBOARD": &o.clipboard, "PRIMARY": &o.primary, "UTF8_STRING": &o.utf8,
		"text/plain;charset=utf-8": &o.textPlain, "TARGETS": &o.targets, "TIMESTAMP": &o.timestamp,
		"INCR": &o.incr, "OTHER_PROP": &o.prop, "BOGUS_TARGET": &o.bogus,
	} {
		*a = o.atom(name)
	}
	o.win = o.newWindow()
	go func() {
		for {
			ev, xerr := c.WaitForEvent()
			if ev == nil && xerr == nil {
				return
			}
			if xerr != nil {
				select {
				case o.errs <- xerr:
				default:
				}

				continue
			}
			select {
			case o.events <- ev:
			default:
			}
		}
	}()

	return o
}

func (o *other) close() { o.once.Do(o.c.Close) }

func (o *other) atom(name string) xproto.Atom {
	o.t.Helper()
	r, err := xproto.InternAtom(o.c, false, uint16(len(name)), name).Reply()
	if err != nil {
		o.t.Fatal(err)
	}

	return r.Atom
}

func (o *other) newWindow() xproto.Window {
	o.t.Helper()
	id, err := xproto.NewWindowId(o.c)
	if err != nil {
		o.t.Fatal(err)
	}
	root := xproto.Setup(o.c).DefaultScreen(o.c).Root
	if err := xproto.CreateWindowChecked(o.c, 0, id, root, 0, 0, 1, 1, 0, xproto.WindowClassInputOnly, 0,
		xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange}).Check(); err != nil {
		o.t.Fatal(err)
	}

	return id
}

func (o *other) owner(selection xproto.Atom) xproto.Window {
	o.t.Helper()
	r, err := xproto.GetSelectionOwner(o.c, selection).Reply()
	if err != nil {
		o.t.Fatal(err)
	}

	return r.Owner
}

// time asks the server for its time, the way the code under test does.
func (o *other) time() xproto.Timestamp {
	o.t.Helper()
	xproto.ChangeProperty(o.c, xproto.PropModeAppend, o.win, o.bogus, o.bogus, 8, 0, nil)
	e := waitEvent(o, testWait, func(e xproto.PropertyNotifyEvent) bool { return e.Window == o.win && e.Atom == o.bogus })

	return e.Time
}

// waitEvent waits for an event of type E that matches, and throws the rest away.
func waitEvent[E xgb.Event](o *other, wait time.Duration, match func(E) bool) E {
	o.t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case ev := <-o.events:
			if e, ok := ev.(E); ok && match(e) {
				return e
			}
		case <-deadline:
			var zero E
			o.t.Fatalf("no %T in %v", zero, wait)

			return zero
		}
	}
}

// convert is ConvertSelection and the answer to it.
func (o *other) convert(selection, target xproto.Atom, at xproto.Timestamp) xproto.SelectionNotifyEvent {
	o.t.Helper()
	xproto.ConvertSelection(o.c, o.win, selection, target, o.prop, at)

	return waitEvent(o, testWait, func(e xproto.SelectionNotifyEvent) bool {
		return e.Requestor == o.win && e.Selection == selection && e.Target == target
	})
}

func (o *other) getProp(del bool) *xproto.GetPropertyReply {
	o.t.Helper()
	r, err := xproto.GetProperty(o.c, del, o.win, o.prop, xproto.GetPropertyTypeAny, 0, 1<<24).Reply()
	if err != nil {
		o.t.Fatal(err)
	}

	return r
}

// readText reads CLIPBOARD as a text requestor, through INCR if the owner uses it.
func (o *other) readText(target xproto.Atom) []byte {
	o.t.Helper()
	n := o.convert(o.clipboard, target, xproto.TimeCurrentTime)
	if n.Property == xproto.AtomNone {
		o.t.Fatalf("refused")
	}
	p := o.getProp(true)
	if p.Type != o.incr {
		if p.Type != target || p.Format != 8 {
			o.t.Fatalf("type %d format %d", p.Type, p.Format)
		}

		return p.Value
	}
	var out []byte
	for {
		waitEvent(o, testWait, func(e xproto.PropertyNotifyEvent) bool {
			return e.Window == o.win && e.Atom == o.prop && e.State == xproto.PropertyNewValue
		})
		p := o.getProp(true)
		if p.Type != target {
			continue // the NewValue of one we've already read
		}
		if len(p.Value) == 0 {
			return out
		}
		out = append(out, p.Value...)
	}
}

// takeSelection makes this client CLIPBOARD's owner, at a real time, and returns that time.
func (o *other) takeSelection(selection xproto.Atom) xproto.Timestamp {
	o.t.Helper()
	at := o.time()
	xproto.SetSelectionOwner(o.c, o.win, selection, at)
	if o.owner(selection) != o.win {
		o.t.Fatal("couldn't take the selection")
	}

	return at
}

// serve answers SelectionRequests with text, the way a real owner does, using INCR past chunk, until stop closes.
func (o *other) serve(text []byte, chunk int, stop <-chan struct{}) {
	go func() {
		for {
			select {
			case <-stop:
				return
			case ev := <-o.events:
				e, ok := ev.(xproto.SelectionRequestEvent)
				if !ok {
					continue
				}
				if e.Target != o.utf8 {
					o.notify(e, xproto.AtomNone)

					continue
				}
				if len(text) <= chunk {
					xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.utf8, 8, uint32(len(text)), text)
					o.notify(e, e.Property)

					continue
				}
				o.serveIncr(e, text, chunk, stop)
			}
		}
	}()
}

func (o *other) serveIncr(e xproto.SelectionRequestEvent, text []byte, chunk int, stop <-chan struct{}) {
	xproto.ChangeWindowAttributes(o.c, e.Requestor, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange})
	size := make([]byte, 4)
	xgb.Put32(size, uint32(len(text)))
	xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.incr, 32, 1, size)
	o.notify(e, e.Property)
	for off := 0; ; {
		select {
		case <-stop:
			return
		case ev := <-o.events:
			p, ok := ev.(xproto.PropertyNotifyEvent)
			if !ok || p.Window != e.Requestor || p.Atom != e.Property || p.State != xproto.PropertyDelete {
				continue
			}
			n := min(len(text)-off, chunk)
			xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.utf8, 8, uint32(n), text[off:off+n])
			off += n
			if n == 0 {
				return
			}
		}
	}
}

func (o *other) notify(e xproto.SelectionRequestEvent, prop xproto.Atom) {
	n := xproto.SelectionNotifyEvent{Time: e.Time, Requestor: e.Requestor, Selection: e.Selection, Target: e.Target, Property: prop}
	xproto.SendEvent(o.c, false, e.Requestor, 0, string(n.Bytes()))
}

// forge sends an event straight to a window, the way any X client can.
func (o *other) forge(to xproto.Window, b []byte) {
	xproto.SendEvent(o.c, false, to, 0, string(b))
}

func mustOK(t *testing.T, d *deskd, id uint64) {
	t.Helper()
	r := d.reply(testWait)
	if r.ID != id || !r.OK {
		t.Fatalf("set %d: %+v", id, describe(r))
	}
}

func describe(r *rtcsock.ClipReply) string {
	return fmt.Sprintf("id=%d ok=%v code=%q none=%v bytes=%d", r.ID, r.OK, r.Code, r.None, len(r.Text))
}

func testText(n int) []byte {
	const line = "the quick brown fox héllo wörld ✓ jumps over the lazy dog\n"
	return bytes.Repeat([]byte(line), n/len(line)+1)[:n]
}

// waitFor polls something the worker publishes.
func waitFor(t *testing.T, wait time.Duration, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(wait)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not in %v", what, wait)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSetThenReadBack(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)

	before := o.time()
	text := []byte("héllo clipboard ✓")
	submitSet(c, 1, text)
	mustOK(t, d, 1)
	// The reply promises the server already says so, with no waiting.
	owner := o.owner(o.clipboard)
	if owner == xproto.WindowNone || owner == o.win {
		t.Fatalf("owner is %d after ok", owner)
	}
	for _, target := range []xproto.Atom{o.utf8, o.textPlain} {
		if got := o.readText(target); !bytes.Equal(got, text) {
			t.Fatalf("target %d: got %q", target, got)
		}
	}

	// TARGETS is what it serves and nothing else.
	n := o.convert(o.clipboard, o.targets, xproto.TimeCurrentTime)
	if n.Property == xproto.AtomNone {
		t.Fatal("TARGETS refused")
	}
	p := o.getProp(true)
	if p.Type != xproto.AtomAtom || p.Format != 32 {
		t.Fatalf("TARGETS type %d format %d", p.Type, p.Format)
	}
	got := map[xproto.Atom]bool{}
	for i := 0; i+4 <= len(p.Value); i += 4 {
		got[xproto.Atom(xgb.Get32(p.Value[i:]))] = true
	}
	want := []xproto.Atom{o.targets, o.timestamp, o.utf8, o.textPlain}
	if len(got) != len(want) {
		t.Fatalf("TARGETS has %d atoms", len(got))
	}
	for _, a := range want {
		if !got[a] {
			t.Fatalf("TARGETS is missing %d", a)
		}
	}

	// TIMESTAMP is the server's time, not CurrentTime, and later than a time taken before the set.
	n = o.convert(o.clipboard, o.timestamp, xproto.TimeCurrentTime)
	if n.Property == xproto.AtomNone {
		t.Fatal("TIMESTAMP refused")
	}
	p = o.getProp(true)
	if p.Type != xproto.AtomInteger || p.Format != 32 || len(p.Value) != 4 {
		t.Fatalf("TIMESTAMP type %d format %d", p.Type, p.Format)
	}
	at := xproto.Timestamp(xgb.Get32(p.Value))
	if at == xproto.TimeCurrentTime || int32(uint32(at)-uint32(before)) < 0 {
		t.Fatalf("TIMESTAMP %d, and before the set it was %d", at, before)
	}

	// A get on our own text answers without the X server, and the same text.
	c.Submit(rtcsock.ClipGet(2, 1000))
	if r := d.reply(testWait); r.ID != 2 || !bytes.Equal(r.Text, text) {
		t.Fatalf("own get: %s", describe(r))
	}
	c.Submit(rtcsock.ClipGet(3, 3))
	if r := d.reply(testWait); r.ID != 3 || r.Code != rtcsock.ClipTooLarge {
		t.Fatalf("own get over the cap: %s", describe(r))
	}
}

// A get right after a set sees the set, even though the set is still waiting on the server when the get arrives.
func TestGetAfterSetKeepsOrder(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	text := []byte("in order")
	for id := uint64(1); id <= 40; id += 2 {
		submitSet(c, id, text)
		c.Submit(rtcsock.ClipGet(id+1, 100))
		mustOK(t, d, id)
		if r := d.reply(testWait); r.ID != id+1 || !bytes.Equal(r.Text, text) {
			t.Fatalf("get %d: %s", id+1, describe(r))
		}
	}
}

func TestRefusals(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, []byte("secret"))
	mustOK(t, d, 1)

	// A target it doesn't serve, including text ones.
	for _, name := range []string{"BOGUS_TARGET", "STRING", "TEXT", "image/png", "MULTIPLE"} {
		if n := o.convert(o.clipboard, o.atom(name), xproto.TimeCurrentTime); n.Property != xproto.AtomNone {
			t.Fatalf("%s: served on property %d", name, n.Property)
		}
	}

	// PRIMARY: never taken, and a request for it is refused even when forged straight to our window.
	ours := o.owner(o.clipboard)
	if o.owner(o.primary) == ours {
		t.Fatal("it owns PRIMARY")
	}
	req := xproto.SelectionRequestEvent{
		Time: xproto.TimeCurrentTime, Owner: ours, Requestor: o.win, Selection: o.primary, Target: o.utf8, Property: o.prop,
	}
	o.forge(ours, req.Bytes())
	n := waitEvent(o, testWait, func(e xproto.SelectionNotifyEvent) bool { return e.Selection == o.primary })
	if n.Property != xproto.AtomNone {
		t.Fatalf("PRIMARY served on property %d", n.Property)
	}
	if p := o.getProp(false); len(p.Value) != 0 {
		t.Fatalf("PRIMARY put %d bytes on the property", len(p.Value))
	}

	// A request from before the selection's own time.
	if n := o.convert(o.clipboard, o.utf8, 1); n.Property != xproto.AtomNone {
		t.Fatalf("a request from time 1 was served on property %d", n.Property)
	}
	// One at a real, later time is fine.
	if n := o.convert(o.clipboard, o.utf8, o.time()); n.Property == xproto.AtomNone {
		t.Fatal("a request at the server's time was refused")
	}
	o.getProp(true)
}

// A get never reads PRIMARY: an owner of PRIMARY alone leaves CLIPBOARD with no text.
func TestGetIgnoresPrimary(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	stop := make(chan struct{})
	defer close(stop)

	// Make sure nothing holds CLIPBOARD, by taking it and giving it up.
	o.takeSelection(o.clipboard)
	xproto.SetSelectionOwner(o.c, xproto.WindowNone, o.clipboard, o.time())
	if o.owner(o.clipboard) != xproto.WindowNone {
		t.Fatal("CLIPBOARD still has an owner")
	}
	o.takeSelection(o.primary)
	o.serve([]byte("primary text"), 1<<20, stop)

	c.Submit(rtcsock.ClipGet(1, 100))
	if r := d.reply(testWait); r.ID != 1 || !r.None {
		t.Fatalf("got %s", describe(r))
	}
}

func TestIncrAMillionBytesBothWays(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	text := testText(1_000_000)

	// Owner: past incrChunk, this has to come through INCR.
	submitSet(c, 1, text)
	mustOK(t, d, 1)
	n := o.convert(o.clipboard, o.utf8, xproto.TimeCurrentTime)
	if p := o.getProp(false); n.Property == xproto.AtomNone || p.Type != o.incr {
		t.Fatalf("expected INCR, got type %d", p.Type)
	}
	o.getProp(true)
	var out []byte
	for {
		waitEvent(o, testWait, func(e xproto.PropertyNotifyEvent) bool {
			return e.Window == o.win && e.Atom == o.prop && e.State == xproto.PropertyNewValue
		})
		p := o.getProp(true)
		if p.Type != o.utf8 {
			continue
		}
		if len(p.Value) == 0 {
			break
		}
		if len(p.Value) > incrChunk {
			t.Fatalf("a chunk of %d", len(p.Value))
		}
		out = append(out, p.Value...)
	}
	if !bytes.Equal(out, text) {
		t.Fatalf("got %d bytes back that differ", len(out))
	}
	waitFor(t, testWait, "the transfer's slot", func() bool { return c.activeServes.Load() == 0 })

	// Reader: the other client owns it and serves through INCR.
	stop := make(chan struct{})
	defer close(stop)
	o.takeSelection(o.clipboard)
	o.serve(text, 4096, stop)
	c.Submit(rtcsock.ClipGet(2, 1_000_000))
	r := d.reply(testWait)
	if r.ID != 2 || !bytes.Equal(r.Text, text) {
		t.Fatalf("read: %s", describe(r))
	}
}

// One property holding all of it, as an owner with no need for INCR does.
func TestReadWholeProperty(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	stop := make(chan struct{})
	defer close(stop)
	text := testText(200_000)
	o.takeSelection(o.clipboard)
	o.serve(text, 1<<20, stop)
	c.Submit(rtcsock.ClipGet(1, 1_000_000))
	if r := d.reply(testWait); r.ID != 1 || !bytes.Equal(r.Text, text) {
		t.Fatalf("got %s", describe(r))
	}
}

func TestReadOverMaxBytes(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	stop := make(chan struct{})
	defer close(stop)
	text := testText(200_000)
	o.takeSelection(o.clipboard)

	// One property, one byte over, then exactly fitting.
	o.serve(text, 1<<20, stop)
	c.Submit(rtcsock.ClipGet(1, len(text)-1))
	if r := d.reply(testWait); r.ID != 1 || r.Code != rtcsock.ClipTooLarge {
		t.Fatalf("over: %s", describe(r))
	}
	c.Submit(rtcsock.ClipGet(2, len(text)))
	if r := d.reply(testWait); r.ID != 2 || !bytes.Equal(r.Text, text) {
		t.Fatalf("exact: %s", describe(r))
	}
}

func TestReadIncrOverMaxBytes(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	stop := make(chan struct{})
	defer close(stop)
	text := testText(200_000)
	o.takeSelection(o.clipboard)
	o.serve(text, 4096, stop)
	// The size it announces is enough to stop at.
	c.Submit(rtcsock.ClipGet(1, len(text)-1))
	if r := d.reply(testWait); r.ID != 1 || r.Code != rtcsock.ClipTooLarge {
		t.Fatalf("got %s", describe(r))
	}
}

// An owner that lies low in its announcement and sends far more is stopped at the cap, with no cut piece.
func TestEndlessOwner(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	o.takeSelection(o.clipboard)
	stop := make(chan struct{})
	defer close(stop)
	chunk := bytes.Repeat([]byte("e"), 32*1024)
	go func() {
		for {
			select {
			case <-stop:
				return
			case ev := <-o.events:
				switch e := ev.(type) {
				case xproto.SelectionRequestEvent:
					xproto.ChangeWindowAttributes(o.c, e.Requestor, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange})
					size := make([]byte, 4)
					xgb.Put32(size, 1)
					xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.incr, 32, 1, size)
					o.notify(e, e.Property)
				case xproto.PropertyNotifyEvent:
					if e.State == xproto.PropertyDelete && e.Window != o.win {
						xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Window, e.Atom, o.utf8, 8, uint32(len(chunk)), chunk)
					}
				}
			}
		}
	}()

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for id := uint64(1); id <= 5; id++ {
		c.Submit(rtcsock.ClipGet(id, 300_000))
		r := d.reply(testWait)
		if r.ID != id || r.Code != rtcsock.ClipTooLarge {
			t.Fatalf("got %s", describe(r))
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if grew := int64(after.HeapAlloc) - int64(before.HeapAlloc); grew > 4<<20 {
		t.Fatalf("heap grew by %d", grew)
	}
}

// An owner that never answers gets timeout at 3 s, and the next get after it's gone is fine.
func TestOwnerThatNeverAnswers(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	o.takeSelection(o.clipboard)

	began := time.Now()
	c.Submit(rtcsock.ClipGet(1, 1000))
	r := d.reply(stepTimeout + 2*time.Second)
	took := time.Since(began)
	if r.ID != 1 || r.Code != rtcsock.ClipTimeout {
		t.Fatalf("got %s", describe(r))
	}
	if took < stepTimeout-100*time.Millisecond {
		t.Fatalf("gave up after only %v", took)
	}
	o.close()
	waitOwnerGone(t, display)
	c.Submit(rtcsock.ClipGet(2, 1000))
	if r := d.reply(testWait); r.ID != 2 || !r.None {
		t.Fatalf("after: %s", describe(r))
	}
}

func waitOwnerGone(t *testing.T, display string) {
	t.Helper()
	q := newOther(t, display)
	defer q.close()
	waitFor(t, testWait, "the owner going", func() bool { return q.owner(q.clipboard) == xproto.WindowNone })
}

// Gets queue behind one that's stuck, and a set doesn't wait for it at all.
func TestSetDoesNotWaitForAStuckRead(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	o.takeSelection(o.clipboard)

	c.Submit(rtcsock.ClipGet(1, 1000))
	time.Sleep(50 * time.Millisecond)
	began := time.Now()
	submitSet(c, 2, []byte("mine"))
	mustOK(t, d, 2)
	if took := time.Since(began); took > time.Second {
		t.Fatalf("the set took %v behind a stuck read", took)
	}
	r := d.reply(stepTimeout + 2*time.Second)
	if r.ID != 1 || r.Code != rtcsock.ClipTimeout {
		t.Fatalf("the stuck get: %s", describe(r))
	}
}

func TestOwnerStallsMidIncr(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	o.takeSelection(o.clipboard)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		// INCR announced, one chunk, then silence.
		for {
			select {
			case <-stop:
				return
			case ev := <-o.events:
				switch e := ev.(type) {
				case xproto.SelectionRequestEvent:
					xproto.ChangeWindowAttributes(o.c, e.Requestor, xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange})
					size := make([]byte, 4)
					xgb.Put32(size, 100)
					xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.incr, 32, 1, size)
					o.notify(e, e.Property)
				case xproto.PropertyNotifyEvent:
					if e.State == xproto.PropertyDelete && e.Window != o.win {
						xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Window, e.Atom, o.utf8, 8, 5, []byte("start"))
						xproto.ChangeWindowAttributes(o.c, e.Window, xproto.CwEventMask, []uint32{0})
					}
				}
			}
		}
	}()
	c.Submit(rtcsock.ClipGet(1, 1000))
	if r := d.reply(stepTimeout + 2*time.Second); r.ID != 1 || r.Code != rtcsock.ClipTimeout {
		t.Fatalf("got %s", describe(r))
	}
}

// A requestor that stops reading, and the one that vanishes, both let go of their slots.
func TestRequestorStallsMidIncr(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, testText(500_000))
	mustOK(t, d, 1)

	n := o.convert(o.clipboard, o.utf8, xproto.TimeCurrentTime)
	if n.Property == xproto.AtomNone {
		t.Fatal("refused")
	}
	waitFor(t, testWait, "the transfer starting", func() bool { return c.activeServes.Load() == 1 })
	began := time.Now()
	// It never deletes the property.
	waitFor(t, stepTimeout+2*time.Second, "the stalled transfer ending", func() bool { return c.activeServes.Load() == 0 })
	if took := time.Since(began); took < stepTimeout-500*time.Millisecond {
		t.Fatalf("gave up after only %v", took)
	}
	// And it's still serving.
	q := newOther(t, display)
	if got := q.readText(q.utf8); len(got) != 500_000 {
		t.Fatalf("got %d bytes", len(got))
	}
}

func TestRequestorVanishesMidIncr(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	text := testText(500_000)
	submitSet(c, 1, text)
	mustOK(t, d, 1)

	if n := o.convert(o.clipboard, o.utf8, xproto.TimeCurrentTime); n.Property == xproto.AtomNone {
		t.Fatal("refused")
	}
	o.getProp(true) // the first chunk is on its way to a window about to go away
	waitFor(t, testWait, "the transfer starting", func() bool { return c.activeServes.Load() == 1 })
	o.close()
	// Destroy tells it at once, well before a step's deadline.
	waitFor(t, stepTimeout/2, "the slot freeing", func() bool { return c.activeServes.Load() == 0 })

	// None of that hurt the connection.
	q := newOther(t, display)
	if got := q.readText(q.utf8); !bytes.Equal(got, text) {
		t.Fatalf("got %d bytes", len(got))
	}
	mustNoLoss(t, d)
}

func mustNoLoss(t *testing.T, d *deskd) {
	t.Helper()
	d.noReply(50 * time.Millisecond)
}

// BadWindow on a transfer to a window that doesn't exist is normal, not the end of the loop.
func TestRequestorWithNoSuchWindow(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, testText(500_000))
	mustOK(t, d, 1)
	ours := o.owner(o.clipboard)
	conn := c.cur.Load()
	for i := range 50 {
		req := xproto.SelectionRequestEvent{
			Time:      xproto.TimeCurrentTime,
			Owner:     ours,
			Requestor: xproto.Window(0x7f000000 + i),
			Selection: o.clipboard,
			Target:    o.utf8,
			Property:  o.prop,
		}
		o.forge(ours, req.Bytes())
	}
	// The first ones take every slot, and with no window to die, they end at the step's deadline. Then a real
	// one is served.
	waitFor(t, testWait, "the slots filling", func() bool { return c.activeServes.Load() == maxServes })
	waitFor(t, stepTimeout+2*time.Second, "the slots freeing", func() bool { return c.activeServes.Load() == 0 })
	if got := o.readText(o.utf8); len(got) != 500_000 {
		t.Fatalf("got %d bytes", len(got))
	}
	if c.cur.Load() != conn {
		t.Fatal("the connection was lost under the BadWindows")
	}
}

// More requestors than slots: the extra ones are refused, and memory and state stay bounded.
func TestConcurrentRequestorsAreBounded(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, testText(500_000))
	mustOK(t, d, 1)

	var refused, started int
	for range maxServes + 4 {
		win := o.newWindow()
		xproto.ConvertSelection(o.c, win, o.clipboard, o.utf8, o.prop, xproto.TimeCurrentTime)
		n := waitEvent(o, testWait, func(e xproto.SelectionNotifyEvent) bool { return e.Requestor == win })
		if n.Property == xproto.AtomNone {
			refused++
		} else {
			started++
		}
	}
	if started != maxServes || refused != 4 {
		t.Fatalf("started %d, refused %d", started, refused)
	}
	if got := int(c.activeServes.Load()); got != maxServes {
		t.Fatalf("%d active", got)
	}
	// Small requests aren't held back by those slots.
	n := o.convert(o.clipboard, o.targets, xproto.TimeCurrentTime)
	if n.Property == xproto.AtomNone {
		t.Fatal("TARGETS refused while the slots are full")
	}
	waitFor(t, stepTimeout+2*time.Second, "the slots freeing", func() bool { return c.activeServes.Load() == 0 })
}

// A flood of requests can't hang the worker, take the connection down or grow memory, and deskd's commands still
// get through while it's going on.
func TestFloodOfRequests(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	text := testText(30_000)
	submitSet(c, 1, text)
	mustOK(t, d, 1)
	ours := o.owner(o.clipboard)
	conn := c.cur.Load()

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	var sent atomic.Int64
	wg.Add(1)
	go func() {
		defer wg.Done()
		req := xproto.SelectionRequestEvent{
			Time: xproto.TimeCurrentTime, Owner: ours, Requestor: o.win, Selection: o.clipboard, Target: o.utf8, Property: o.prop,
		}
		for {
			select {
			case <-stop:
				return
			default:
			}
			o.forge(ours, req.Bytes())
			xproto.ConvertSelection(o.c, o.win, o.clipboard, o.targets, o.prop, xproto.TimeCurrentTime)
			sent.Add(2)
		}
	}()

	// While it floods, for a few seconds: both commands keep working, in reasonable time. A set is always
	// allowed to take the selection, because nothing it waits for can be crowded out by requests.
	var worst time.Duration
	var rounds int
	floodUntil := time.Now().Add(3 * time.Second)
	for id := uint64(10); time.Now().Before(floodUntil); id += 2 {
		began := time.Now()
		submitSet(c, id, text)
		r := d.reply(testWait + stepTimeout)
		if r.ID != id || !r.OK {
			t.Fatalf("set %d: %s", id, describe(r))
		}
		c.Submit(rtcsock.ClipGet(id+1, len(text)))
		g := d.reply(testWait + stepTimeout)
		if g.ID != id+1 || !bytes.Equal(g.Text, text) {
			t.Fatalf("get %d: %s", id+1, describe(g))
		}
		worst = max(worst, time.Since(began))
		rounds++
	}
	close(stop)
	wg.Wait()
	if sent.Load() < 1000 {
		t.Fatalf("only %d requests: that's not a flood", sent.Load())
	}
	t.Logf("%d requests in 3 s, %d set+get rounds through it, the slowest %v", sent.Load(), rounds, worst)
	if worst > stepTimeout {
		t.Fatalf("a set and a get took %v under the flood", worst)
	}

	var after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&after)
	if grew := int64(after.HeapAlloc) - int64(before.HeapAlloc); grew > 32<<20 {
		t.Fatalf("heap grew by %d", grew)
	}

	// The connection never went: the same window still owns it, after a clean set.
	q := newOther(t, display)
	submitSet(c, 100, []byte("after the flood"))
	waitFor(t, testWait+stepTimeout, "a set after the flood", func() bool {
		select {
		case r := <-d.replies:
			return r.ID == 100 && r.OK
		default:
			return false
		}
	})
	if c.cur.Load() != conn {
		t.Fatal("the connection was lost under the flood")
	}
	if got := q.readText(q.utf8); string(got) != "after the flood" {
		t.Fatalf("got %q", got)
	}
}

// A real SelectionClear drops the text. A forged one, or a stale one from before a newer set, doesn't.
func TestSelectionClear(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, []byte("mine"))
	mustOK(t, d, 1)
	ours := o.owner(o.clipboard)

	clearEv := xproto.SelectionClearEvent{Time: o.time(), Owner: ours, Selection: o.clipboard}
	o.forge(ours, clearEv.Bytes())
	time.Sleep(100 * time.Millisecond)
	c.Submit(rtcsock.ClipGet(2, 100))
	if r := d.reply(testWait); r.ID != 2 || string(r.Text) != "mine" {
		t.Fatalf("after a forged clear: %s", describe(r))
	}

	// A real one: the other client takes it, and our answer to a read is what the new owner says.
	o.takeSelection(o.clipboard)
	time.Sleep(100 * time.Millisecond)
	if n := func() xproto.SelectionNotifyEvent {
		// We no longer own it, so a forged request straight to the old window must be refused.
		req := xproto.SelectionRequestEvent{
			Time: xproto.TimeCurrentTime, Owner: ours, Requestor: o.win, Selection: o.clipboard, Target: o.utf8, Property: o.prop,
		}
		o.forge(ours, req.Bytes())

		return waitEvent(o, testWait, func(e xproto.SelectionNotifyEvent) bool { return e.Requestor == o.win })
	}(); n.Property != xproto.AtomNone {
		t.Fatal("still served text after losing the selection")
	}

	// Set again: the text comes back, and a read from another client gets it.
	submitSet(c, 3, []byte("mine again"))
	mustOK(t, d, 3)
	q := newOther(t, display)
	if got := q.readText(q.utf8); string(got) != "mine again" {
		t.Fatalf("got %q", got)
	}
}

// Losing the selection mid-transfer ends the transfer: the text is dropped now, not when it finishes.
func TestSelectionClearEndsTransfers(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, testText(500_000))
	mustOK(t, d, 1)
	if n := o.convert(o.clipboard, o.utf8, xproto.TimeCurrentTime); n.Property == xproto.AtomNone {
		t.Fatal("refused")
	}
	waitFor(t, testWait, "the transfer starting", func() bool { return c.activeServes.Load() == 1 })
	q := newOther(t, display)
	q.takeSelection(q.clipboard)
	waitFor(t, testWait, "the transfer ending", func() bool { return c.activeServes.Load() == 0 })
}

func TestChanged(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)

	noChanged := func(what string) {
		t.Helper()
		select {
		case <-d.changed:
			t.Fatalf("clipboard.changed after %s", what)
		case <-time.After(400 * time.Millisecond):
		}
	}
	wantChanged := func(what string) {
		t.Helper()
		select {
		case <-d.changed:
		case <-time.After(testWait):
			t.Fatalf("no clipboard.changed after %s", what)
		}
	}

	// Off by default.
	o.takeSelection(o.clipboard)
	noChanged("another owner, with no watch")

	c.Submit(rtcsock.ClipWatch(true))
	// Watch has to reach the worker and connect before anything can fire.
	waitFor(t, testWait, "connecting", func() bool { return c.cur.Load() != nil })

	// Not for our own write.
	submitSet(c, 1, []byte("mine"))
	mustOK(t, d, 1)
	noChanged("our own set")

	// Fires for another owner.
	o.takeSelection(o.clipboard)
	wantChanged("another owner")

	// Not for going to no owner.
	xproto.SetSelectionOwner(o.c, xproto.WindowNone, o.clipboard, o.time())
	noChanged("no owner")

	// Stops when told.
	c.Submit(rtcsock.ClipWatch(false))
	time.Sleep(50 * time.Millisecond)
	o.takeSelection(o.clipboard)
	noChanged("watch off")
}

func TestChangedCoalesces(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	c.Submit(rtcsock.ClipWatch(true))
	waitFor(t, testWait, "connecting", func() bool { return c.cur.Load() != nil })
	time.Sleep(changedEvery + 50*time.Millisecond)

	// 200 changes in about a second. There's room for 5, or 6 at the edges.
	const changes = 200
	began := time.Now()
	var lastChange time.Time
	for range changes {
		lastChange = time.Now()
		o.takeSelection(o.clipboard)
		time.Sleep(5 * time.Millisecond)
	}
	took := time.Since(began)
	time.Sleep(2 * changedEvery)

	var got []time.Time
	for {
		select {
		case at := <-d.changed:
			got = append(got, at)

			continue
		default:
		}

		break
	}
	if len(got) < 2 {
		t.Fatalf("%d changes in %v", len(got), took)
	}
	if limit := int(took/changedEvery) + 2; len(got) > limit {
		t.Fatalf("%d in %v, over %d", len(got), took, limit)
	}
	for i := 1; i < len(got); i++ {
		if gap := got[i].Sub(got[i-1]); gap < changedEvery-20*time.Millisecond {
			t.Fatalf("two only %v apart", gap)
		}
	}
	// The last change is always reported: something arrives after it.
	if !got[len(got)-1].After(lastChange) {
		t.Fatalf("the last report came %v before the last change", lastChange.Sub(got[len(got)-1]))
	}

	// One alone, after quiet, goes straight out.
	time.Sleep(changedEvery)
	at := time.Now()
	o.takeSelection(o.clipboard)
	select {
	case fired := <-d.changed:
		if lag := fired.Sub(at); lag > changedEvery/2 {
			t.Fatalf("a lone change took %v", lag)
		}
	case <-time.After(testWait):
		t.Fatal("no report")
	}
}

// The connection dying: what it held is gone, and the next command dials again. KillClient is what the X server
// does to a client it's done with, and it works on our own display with no need to stop it.
func TestConnectionDiesAndComesBack(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, []byte("mine"))
	mustOK(t, d, 1)
	c.Submit(rtcsock.ClipWatch(true))
	ours := o.owner(o.clipboard)
	first := c.cur.Load()

	xproto.KillClient(o.c, uint32(ours))
	waitFor(t, testWait, "the selection going", func() bool { return o.owner(o.clipboard) == xproto.WindowNone })
	// By pointer: the server can hand a new client the same window id.
	waitFor(t, testWait, "noticing, and watching dialing again", func() bool {
		x := c.cur.Load()

		return x != nil && x != first
	})

	// Nothing is held any more.
	c.Submit(rtcsock.ClipGet(2, 100))
	if r := d.reply(testWait); r.ID != 2 || !r.None {
		t.Fatalf("after the kill: %s", describe(r))
	}
	// And it all works again, watching included.
	o.takeSelection(o.clipboard)
	select {
	case <-d.changed:
	case <-time.After(testWait):
		t.Fatal("no clipboard.changed on the new connection")
	}
	submitSet(c, 3, []byte("new"))
	mustOK(t, d, 3)
	q := newOther(t, display)
	if got := q.readText(q.utf8); string(got) != "new" {
		t.Fatalf("got %q", got)
	}
}

// A dying connection leaves no goroutines behind.
func TestKillCyclesLeakNothing(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)

	cycle := func(id uint64) {
		t.Helper()
		submitSet(c, id, []byte("x"))
		r := d.reply(testWait)
		if !r.OK {
			// The dial right after a kill is throttled.
			time.Sleep(dialEvery)
			submitSet(c, id, []byte("x"))
			mustOK(t, d, id)
		}
		ours := o.owner(o.clipboard)
		xproto.KillClient(o.c, uint32(ours))
		waitFor(t, testWait, "the selection going", func() bool { return o.owner(o.clipboard) == xproto.WindowNone })
		time.Sleep(50 * time.Millisecond)
	}
	cycle(1)
	cycle(2)
	time.Sleep(200 * time.Millisecond)
	base := runtime.NumGoroutine()
	for id := uint64(3); id < 13; id++ {
		cycle(id)
	}
	time.Sleep(300 * time.Millisecond)
	if now := runtime.NumGoroutine(); now > base+3 {
		t.Fatalf("%d goroutines, and it was %d", now, base)
	}
}

// A new deskd connection puts watching back to off, drops an unfinished set and abandons a read. The clipboard's
// own text stays.
func TestResetLink(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, []byte("mine"))
	mustOK(t, d, 1)
	c.Submit(rtcsock.ClipWatch(true))
	c.Submit(rtcsock.ClipSet(2, 0, false, []byte("half")))
	time.Sleep(50 * time.Millisecond)

	c.ResetLink()
	time.Sleep(50 * time.Millisecond)

	// The old set is forgotten: a later part of it is out of order.
	c.Submit(rtcsock.ClipSet(2, 1, true, []byte("rest")))
	if r := d.reply(testWait); r.ID != 2 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("got %s", describe(r))
	}
	// The text stays.
	if got := o.readText(o.utf8); string(got) != "mine" {
		t.Fatalf("got %q", got)
	}
	// Watching is off.
	o.takeSelection(o.clipboard)
	select {
	case <-d.changed:
		t.Fatal("clipboard.changed with watching reset")
	case <-time.After(400 * time.Millisecond):
	}

	// A read under way ends with no reply.
	c.Submit(rtcsock.ClipGet(3, 100))
	time.Sleep(50 * time.Millisecond)
	c.ResetLink()
	d.noReply(stepTimeout + time.Second)
}

// A grab stops the server answering everyone but the grabber. The guard drops the connection rather than hanging,
// and it all comes back after the grab.
func TestServerGrab(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, []byte("mine"))
	mustOK(t, d, 1)

	xproto.GrabServer(o.c)
	if _, err := xproto.GetInputFocus(o.c).Reply(); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	c.Submit(rtcsock.ClipGet(2, 100))
	r := d.reply(serverTimeout + 2*time.Second)
	if r.ID != 2 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("got %s after %v", describe(r), time.Since(began))
	}
	// Commands keep getting quick answers.
	time.Sleep(dialEvery)
	xproto.UngrabServer(o.c)
	if _, err := xproto.GetInputFocus(o.c).Reply(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*testWait, "working again", func() bool {
		submitSet(c, 3, []byte("back"))
		r := d.reply(2 * testWait)

		return r.ID == 3 && r.OK
	})
	if got := o.readText(o.utf8); string(got) != "back" {
		t.Fatalf("got %q", got)
	}
}

// The whole server going away and coming back, including a server stopped dead with SIGSTOP. It uses a server of
// its own, started here and killed here by PID.
func TestServerRestart(t *testing.T) {
	bin, display := os.Getenv("XCLIP_TEST_XVFB"), os.Getenv("XCLIP_TEST_XVFB_DISPLAY")
	if bin == "" || display == "" {
		t.Skip("XCLIP_TEST_XVFB and XCLIP_TEST_XVFB_DISPLAY aren't set")
	}
	if display == ":10" || display == ":0" {
		t.Fatalf("%s isn't a private display", display)
	}
	num, err := strconv.Atoi(display[1:])
	if err != nil {
		t.Fatal(err)
	}
	path := "/tmp/.X11-unix/X" + strconv.Itoa(num)
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("%s is already in use", display)
	}
	startX := func() *exec.Cmd {
		t.Helper()
		cmd := exec.Command(bin, display, "-screen", "0", "640x480x24", "-nolisten", "tcp", "-noreset")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			// SIGTERM, not a kill: it removes its own socket and lock on the way out.
			_ = cmd.Process.Signal(syscall.SIGCONT)
			_ = cmd.Process.Signal(syscall.SIGTERM)
			_ = cmd.Wait()
		})
		waitFor(t, testWait, "the X server", func() bool {
			_, err := os.Stat(path)

			return err == nil
		})

		return cmd
	}
	stopX := func(cmd *exec.Cmd) {
		t.Helper()
		_ = cmd.Process.Signal(syscall.SIGCONT)
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
		waitFor(t, testWait, "the socket going", func() bool {
			_, err := os.Stat(path)

			return err != nil
		})
	}

	// Asked before there's any X: no_display, and it doesn't start one.
	c, d := start(t, display)
	c.Submit(rtcsock.ClipGet(1, 100))
	if r := d.reply(testWait); r.ID != 1 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("no X yet: %s", describe(r))
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("an X server appeared")
	}

	// Watching dials by itself once it's there.
	c.Submit(rtcsock.ClipWatch(true))
	cmd := startX()
	waitFor(t, testWait, "watching connecting", func() bool { return c.cur.Load() != nil })
	o := newOther(t, display)
	o.takeSelection(o.clipboard)
	select {
	case <-d.changed:
	case <-time.After(testWait):
		t.Fatal("no clipboard.changed")
	}
	submitSet(c, 2, []byte("before the restart"))
	mustOK(t, d, 2)
	o.close()

	// Stopped dead: replies are bounded, and the connection goes, and this all returns.
	if err := cmd.Process.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	submitSet(c, 3, []byte("while stopped"))
	r := d.reply(stepTimeout + 2*time.Second)
	if r.ID != 3 || r.Code != rtcsock.ClipTimeout {
		t.Fatalf("while stopped: %s after %v", describe(r), time.Since(began))
	}
	c.Submit(rtcsock.ClipGet(4, 100))
	r = d.reply(2*serverTimeout + 2*time.Second)
	if r.ID != 4 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("get while stopped: %s after %v", describe(r), time.Since(began))
	}
	if err := cmd.Process.Signal(syscall.SIGCONT); err != nil {
		t.Fatal(err)
	}

	// Gone altogether: no_display, nothing kept.
	stopX(cmd)
	waitFor(t, testWait, "noticing", func() bool { return c.cur.Load() == nil })
	time.Sleep(dialEvery)
	c.Submit(rtcsock.ClipGet(5, 100))
	if r := d.reply(testWait); r.ID != 5 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("with X gone: %s", describe(r))
	}

	// Back: it reconnects by itself while watching, nothing's held, and it all works.
	startX()
	waitFor(t, 2*testWait, "reconnecting", func() bool { return c.cur.Load() != nil })
	c.Submit(rtcsock.ClipGet(6, 100))
	if r := d.reply(testWait); r.ID != 6 || !r.None {
		t.Fatalf("after the restart: %s", describe(r))
	}
	q := newOther(t, display)
	q.takeSelection(q.clipboard)
	select {
	case <-d.changed:
	case <-time.After(testWait):
		t.Fatal("no clipboard.changed after the restart")
	}
	submitSet(c, 7, []byte("after the restart"))
	mustOK(t, d, 7)
	if got := q.readText(q.utf8); string(got) != "after the restart" {
		t.Fatalf("got %q", got)
	}
}
