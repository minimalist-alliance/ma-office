package xclip

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// deskd stands in for the far end of Send: it collects what the clipboard sends.
type deskd struct {
	t       *testing.T
	msgs    chan *rtcsock.Message
	replies chan *rtcsock.ClipReply
	changed chan time.Time
	refuse  atomic.Bool
	joiner  rtcsock.ClipJoiner
	// With strict set, send acts as the server's clipSend does, and drops what isn't for link.
	strict atomic.Bool
	link   atomic.Uint64
	stale  atomic.Int64
}

func newDeskd(t *testing.T) *deskd {
	t.Helper()
	d := &deskd{
		t:       t,
		msgs:    make(chan *rtcsock.Message, 4096),
		replies: make(chan *rtcsock.ClipReply, 4096),
		changed: make(chan time.Time, 4096),
	}

	return d
}

// send has the same contract as the real one: it never blocks.
func (d *deskd) send(link uint64, m *rtcsock.Message) bool {
	if d.strict.Load() && link != d.link.Load() {
		d.stale.Add(1)

		return false
	}
	if m.Data != "" && d.refuse.Load() {
		return false
	}
	if m.T == rtcsock.MsgClipChanged {
		d.changed <- time.Now()

		return true
	}
	r, err := d.joiner.Add(m)
	if err != nil {
		d.t.Errorf("reply: %v", err)
	}
	if r != nil {
		d.replies <- r
	}

	return true
}

func (d *deskd) reply(timeout time.Duration) *rtcsock.ClipReply {
	d.t.Helper()
	select {
	case r := <-d.replies:
		return r
	case <-time.After(timeout):
		d.t.Fatalf("no reply in %v", timeout)

		return nil
	}
}

func (d *deskd) noReply(wait time.Duration) {
	d.t.Helper()
	select {
	case r := <-d.replies:
		d.t.Fatalf("unexpected reply to %d: ok=%v code=%q none=%v", r.ID, r.OK, r.Code, r.None)
	case <-time.After(wait):
	}
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func start(t *testing.T, display string) (*Clipboard, *deskd) {
	t.Helper()
	d := newDeskd(t)
	c := New(Config{Display: display, Log: quietLog(), Send: d.send})
	t.Cleanup(c.Close)

	return c, d
}

func submitSet(c *Clipboard, id uint64, text []byte) {
	rtcsock.ClipEachPart(text, func(part int, last bool, chunk []byte) bool {
		c.Submit(rtcsock.ClipSet(id, part, last, chunk))

		return true
	})
}

// A display that can't exist, so these tests touch no X server at all.
func noDisplay(t *testing.T) string { return filepath.Join(t.TempDir(), "none") + ":0" }

func TestSocketPath(t *testing.T) {
	good := map[string]string{
		":99":            "/tmp/.X11-unix/X99",
		":99.0":          "/tmp/.X11-unix/X99",
		"unix:173":       "/tmp/.X11-unix/X173",
		"/run/x/sock:12": "/run/x/sock:12",
	}
	for in, want := range good {
		if got, err := socketPath(in); err != nil || got != want {
			t.Errorf("%q: got %q, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "nothing", ":", ":x", "host:0", "tcp/host:1"} {
		if got, err := socketPath(in); err == nil {
			t.Errorf("%q: got %q", in, got)
		}
	}
}

// Nothing here may fall back to $DISPLAY, which is what xgb does with an empty name.
func TestEmptyDisplayNeverDials(t *testing.T) {
	t.Setenv("DISPLAY", "/nonexistent/should-not-be-read:1")
	if _, err := dial("", quietLog()); err == nil || !strings.Contains(err.Error(), "no display") {
		t.Fatalf("got %v", err)
	}
}

func TestNoDisplay(t *testing.T) {
	c, d := start(t, noDisplay(t))
	submitSet(c, 1, []byte("hello"))
	if r := d.reply(time.Second); r.ID != 1 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("set: %+v", r)
	}
	c.Submit(rtcsock.ClipGet(2, 100))
	if r := d.reply(time.Second); r.ID != 2 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("get: %+v", r)
	}
	c.Submit(rtcsock.ClipWatch(true))
	d.noReply(100 * time.Millisecond)
}

// These fail before anything could reach X, so they need none.
func TestAssemblyErrors(t *testing.T) {
	c, d := start(t, noDisplay(t))

	// A part out of order, with nothing assembling.
	c.Submit(rtcsock.ClipSet(1, 3, false, []byte("x")))
	if r := d.reply(time.Second); r.ID != 1 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("out of order: %+v", r)
	}
	// Later parts of that same set stay quiet: one reply per id.
	c.Submit(rtcsock.ClipSet(1, 4, false, []byte("x")))
	c.Submit(rtcsock.ClipSet(1, 5, true, []byte("x")))
	d.noReply(100 * time.Millisecond)

	// A gap in the middle.
	c.Submit(rtcsock.ClipSet(2, 0, false, []byte("x")))
	c.Submit(rtcsock.ClipSet(2, 2, false, []byte("x")))
	if r := d.reply(time.Second); r.ID != 2 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("gap: %+v", r)
	}

	// Not base64.
	bad := rtcsock.ClipSet(3, 0, true, nil)
	bad.Data = "!!! not base64 !!!"
	c.Submit(bad)
	if r := d.reply(time.Second); r.ID != 3 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("base64: %+v", r)
	}

	// A part of another id doesn't kill the one assembling: its parts carry on to no_display, here.
	c.Submit(rtcsock.ClipSet(4, 0, false, []byte("x")))
	c.Submit(rtcsock.ClipSet(5, 1, false, []byte("x")))
	if r := d.reply(time.Second); r.ID != 5 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("other id: %+v", r)
	}
	c.Submit(rtcsock.ClipSet(4, 1, true, []byte("x")))
	if r := d.reply(time.Second); r.ID != 4 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("still assembling: %+v", r)
	}

	// A new id replaces an unfinished one, which gets no reply, and its later parts are out of order.
	c.Submit(rtcsock.ClipSet(6, 0, false, []byte("x")))
	c.Submit(rtcsock.ClipSet(7, 0, true, []byte("x")))
	if r := d.reply(time.Second); r.ID != 7 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("replaced: %+v", r)
	}
	d.noReply(100 * time.Millisecond)
	c.Submit(rtcsock.ClipSet(6, 1, true, []byte("x")))
	if r := d.reply(time.Second); r.ID != 6 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("late part of the replaced one: %+v", r)
	}
}

// Over 2 MiB is too_large, on the last part and once, and what was collected is gone by then.
func TestSetOverHardLimit(t *testing.T) {
	c, d := start(t, noDisplay(t))
	big := bytes.Repeat([]byte("a"), hardLimit+1)
	submitSet(c, 9, big)
	if r := d.reply(5 * time.Second); r.ID != 9 || r.Code != rtcsock.ClipTooLarge {
		t.Fatalf("got %+v", r)
	}
	d.noReply(100 * time.Millisecond)

	// Exactly at the limit gets as far as asking for X.
	exact := bytes.Repeat([]byte("a"), hardLimit)
	submitSet(c, 10, exact)
	if r := d.reply(5 * time.Second); r.ID != 10 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("got %+v", r)
	}
}

// hungX accepts connections and never says a word: the X server that's up and stuck.
func hungX(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hung")
	ln, err := net.Listen("unix", path+":0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = conn.Close() })
		}
	}()

	return path + ":0"
}

// A server that accepts and then says nothing costs a bounded wait, and the socket's reader never waits: a full
// queue gets internal straight away.
func TestHungServerAndFullQueue(t *testing.T) {
	c, d := start(t, hungX(t))
	c.Submit(rtcsock.ClipGet(1, 100)) // the worker is now stuck in the dial
	time.Sleep(50 * time.Millisecond)

	before := time.Now()
	for id := uint64(2); id < msgQueue+10; id++ {
		c.Submit(rtcsock.ClipGet(id, 100))
	}
	if took := time.Since(before); took > 500*time.Millisecond {
		t.Fatalf("Submit waited %v", took)
	}
	// 72 messages into a queue of 64, with nothing taking them out.
	for range 8 {
		r := d.reply(time.Second)
		if r.Code != rtcsock.ClipInternal {
			t.Fatalf("expected the overflow first, got %+v", r)
		}
	}
	// The dial gives up within its bound, and the first get hears about it.
	r := d.reply(serverTimeout + 2*time.Second)
	if r.ID != 1 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("got %+v", r)
	}
	// It doesn't try that again straight away, so what's queued isn't made to wait 5 s each.
	began := time.Now()
	for range msgQueue {
		if r := d.reply(time.Second); r.Code != rtcsock.ClipNoDisplay && r.Code != rtcsock.ClipInternal {
			t.Fatalf("got %+v", r)
		}
	}
	if took := time.Since(began); took > time.Second {
		t.Fatalf("the rest took %v", took)
	}
}

// Text past what a stalled deskd can take gets an error in place of the rest, and the client is told.
func TestSendTextStopsWhenDeskdIsBehind(t *testing.T) {
	c, d := start(t, noDisplay(t))
	d.refuse.Store(true)
	c.sendText(5, bytes.Repeat([]byte("x"), 100))
	if r := d.reply(time.Second); r.ID != 5 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("got %+v", r)
	}
}

func TestPartsOfAnAnswerAreBase64OfAtMost45KiB(t *testing.T) {
	var parts []*rtcsock.Message
	c := New(Config{Display: noDisplay(t), Log: quietLog(), Send: func(_ uint64, m *rtcsock.Message) bool {
		parts = append(parts, m)

		return true
	}})
	defer c.Close()
	c.sendText(1, bytes.Repeat([]byte("y"), 100*1024))
	if len(parts) != 3 {
		t.Fatalf("%d parts", len(parts))
	}
	for i, p := range parts {
		b, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil || len(b) > rtcsock.ClipPartMax {
			t.Fatalf("part %d: %d bytes, %v", i, len(b), err)
		}
		if *p.Part != i || *p.Last != (i == 2) {
			t.Fatalf("part %d: part=%d last=%v", i, *p.Part, *p.Last)
		}
	}
}

func decode(t *testing.T, s string) *rtcsock.Message {
	t.Helper()
	var m rtcsock.Message
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}

	return &m
}

// A message with a field of the wrong type gets internal, and a set it's part of ends the way it does for a part
// out of order: once, with its later parts ignored. A bad part 0 starts a set of its own, which fails.
func TestBadFields(t *testing.T) {
	c, d := start(t, noDisplay(t))
	c.Submit(rtcsock.ClipSet(9, 0, false, []byte("hal")))
	c.Submit(decode(t, `{"t":"clipboard.set","id":9,"part":1,"last":false,"data":5}`))
	c.Submit(rtcsock.ClipSet(9, 2, true, []byte("f")))
	if r := d.reply(time.Second); r.ID != 9 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("bad part: %s", describe(r))
	}
	c.Submit(decode(t, `{"t":"clipboard.set","id":9,"part":0,"last":"yes"}`))
	if r := d.reply(time.Second); r.ID != 9 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("bad part 0: %s", describe(r))
	}
	c.Submit(decode(t, `{"t":"clipboard.get","id":10,"maxBytes":1e6}`))
	if r := d.reply(time.Second); r.ID != 10 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("bad get: %s", describe(r))
	}
	c.Submit(decode(t, `{"t":"clipboard.get","id":-1}`))
	c.Submit(decode(t, `{"t":"clipboard.watch","on":1}`))
	d.noReply(200 * time.Millisecond)
	if c.watchOn.Load() {
		t.Fatal("a bad watch turned watching on")
	}
	// Good ones still work: with no X here, that's no_display.
	c.Submit(rtcsock.ClipGet(11, 100))
	if r := d.reply(testWait); r.ID != 11 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("get: %s", describe(r))
	}
}

// Every reply names the link it answers, which is how the server keeps one deskd's replies from the next.
func TestRepliesNameTheirLink(t *testing.T) {
	c, d := start(t, noDisplay(t))
	d.strict.Store(true)
	d.link.Store(c.ResetLink())
	c.Submit(rtcsock.ClipGet(1, 100))
	if r := d.reply(testWait); r.ID != 1 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("first link: %s", describe(r))
	}
	old := d.link.Load()
	if d.link.Store(c.ResetLink()); d.link.Load() == old {
		t.Fatal("a new link has the old one's name")
	}
	c.Submit(rtcsock.ClipGet(2, 100))
	if r := d.reply(testWait); r.ID != 2 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("second link: %s", describe(r))
	}
	if n := d.stale.Load(); n != 0 {
		t.Fatalf("%d replies named the wrong link", n)
	}
}
