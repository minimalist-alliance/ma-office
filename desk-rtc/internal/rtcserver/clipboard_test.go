package rtcserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xclip"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xinput"
)

// clipDisplay names a private X server for the tests that need one. See internal/xclip/x_test.go.
func clipDisplay(t *testing.T) string {
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

func startClipServer(t *testing.T, display string) string {
	t.Helper()
	dir := shortDir(t)
	sock := filepath.Join(dir, "rtc.sock")
	srv, err := New(Config{
		SocketPath: sock,
		DataDir:    filepath.Join(dir, "rtc"),
		Bind:       "127.0.0.1",
		Port:       freePort(t),
		Version:    "test",
		Display:    display,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	return sock
}

// clipClient is deskd's end of the socket, with the clipboard's replies put back together.
type clipClient struct {
	t       *testing.T
	c       *rtcsock.Client
	replies chan *rtcsock.ClipReply
	changed chan struct{}
	other   chan *rtcsock.Message // everything that isn't the clipboard's
}

func dialClip(t *testing.T, sock string) *clipClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := rtcsock.DialRetry(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	cc := &clipClient{
		t: t, c: c, replies: make(chan *rtcsock.ClipReply, 64), changed: make(chan struct{}, 64),
		other: make(chan *rtcsock.Message, 64),
	}
	var j rtcsock.ClipJoiner
	go func() {
		_ = c.Run(func(m *rtcsock.Message) {
			if m.T == rtcsock.MsgClipChanged {
				cc.changed <- struct{}{}

				return
			}
			if !strings.HasPrefix(m.T, "clipboard.") {
				select {
				case cc.other <- m:
				default:
				}

				return
			}
			r, err := j.Add(m)
			if err != nil {
				t.Errorf("reply: %v", err)
			}
			if r != nil {
				cc.replies <- r
			}
		}, func(uint32, uint8, []byte) {})
	}()
	t.Cleanup(func() { _ = c.Close() })

	return cc
}

// alive shows the link is up, and that this is the connection desk-rtc is serving: stats.get gets its answer.
func (cc *clipClient) alive() {
	cc.t.Helper()
	if err := cc.c.Send(&rtcsock.Message{T: "stats.get"}); err != nil {
		cc.t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-cc.other:
			if m.T == "stats" {
				return
			}
		case <-deadline:
			cc.t.Fatal("no stats: the link is gone")
		}
	}
}

// raw sends one JSON envelope exactly as written.
func (cc *clipClient) raw(body string) {
	cc.t.Helper()
	b := make([]byte, 5, 5+len(body))
	binary.BigEndian.PutUint32(b, uint32(len(body)+1))
	b[4] = rtcsock.TypeJSON
	if err := cc.c.RawWrite(append(b, body...)); err != nil {
		cc.t.Fatal(err)
	}
}

func (cc *clipClient) noReply(wait time.Duration) {
	cc.t.Helper()
	select {
	case r := <-cc.replies:
		cc.t.Fatalf("unexpected reply to %d: ok=%v code=%q none=%v", r.ID, r.OK, r.Code, r.None)
	case <-time.After(wait):
	}
}

func (cc *clipClient) reply() *rtcsock.ClipReply {
	cc.t.Helper()
	select {
	case r := <-cc.replies:
		return r
	case <-time.After(5 * time.Second):
		cc.t.Fatal("no reply")

		return nil
	}
}

// With no display configured, the answer is no_display, and a set still waits for its last part to say so.
func TestClipboardWithNoDisplayConfigured(t *testing.T) {
	sock := startClipServer(t, "")
	cc := dialClip(t, sock)
	if err := cc.c.ClipboardGet(1, 100); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 1 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("get: %+v", r)
	}
	if err := cc.c.Send(rtcsock.ClipSet(2, 0, false, []byte("first"))); err != nil {
		t.Fatal(err)
	}
	if err := cc.c.Send(rtcsock.ClipSet(2, 1, true, []byte("last"))); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 2 || r.Code != rtcsock.ClipNoDisplay {
		t.Fatalf("set: %+v", r)
	}
	if err := cc.c.ClipboardWatch(true); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-cc.replies:
		t.Fatalf("unexpected %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
}

// The whole path through the socket, in parts, at the size that matters.
func TestClipboardOverTheSocket(t *testing.T) {
	display := clipDisplay(t)
	sock := startClipServer(t, display)
	cc := dialClip(t, sock)
	text := bytes.Repeat([]byte("héllo wörld ✓\n"), 1_000_000/17)[:1_000_000]

	if err := cc.c.ClipboardSet(1, text); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 1 || !r.OK {
		t.Fatalf("set: %+v", r.Code)
	}
	if err := cc.c.ClipboardGet(2, 1_000_000); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 2 || !bytes.Equal(r.Text, text) {
		t.Fatalf("get: %d bytes, code %q", len(r.Text), r.Code)
	}
	if err := cc.c.ClipboardGet(3, 999_999); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 3 || r.Code != rtcsock.ClipTooLarge {
		t.Fatalf("over: %+v", r.Code)
	}
}

// What goes down the socket when there's no text says none, last and part 0 out loud.
func TestClipboardNoneOnTheWire(t *testing.T) {
	display := clipDisplay(t)
	sock := startClipServer(t, display)
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	b, err := rtcsock.EncodeJSON(rtcsock.ClipGet(0, 100))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(b); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	typ, body, err := rtcsock.ReadEnvelope(bufio.NewReader(conn))
	if err != nil || typ != rtcsock.TypeJSON {
		t.Fatalf("%d %v", typ, err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"t": "clipboard.text", "id": 0.0, "part": 0.0, "last": true, "none": true}
	if len(got) != len(want) {
		t.Fatalf("got %s", body)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got %s", body)
		}
	}
}

// Watching belongs to a connection: a new deskd starts with it off, and a new desk-rtc sends a current deskd
// nothing it didn't ask for.
func TestClipboardWatchEndsWithTheConnection(t *testing.T) {
	display := clipDisplay(t)
	sock := startClipServer(t, display)

	x, err := xgb.NewConnDisplay(display)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(x.Close)
	clipboard, err := xproto.InternAtom(x, false, 9, "CLIPBOARD").Reply()
	if err != nil {
		t.Fatal(err)
	}
	win, err := xproto.NewWindowId(x)
	if err != nil {
		t.Fatal(err)
	}
	root := xproto.Setup(x).DefaultScreen(x).Root
	if err := xproto.CreateWindowChecked(x, 0, win, root, 0, 0, 1, 1, 0, xproto.WindowClassInputOnly, 0, 0, nil).Check(); err != nil {
		t.Fatal(err)
	}
	take := func() {
		t.Helper()
		if err := xproto.SetSelectionOwnerChecked(x, win, clipboard.Atom, xproto.TimeCurrentTime).Check(); err != nil {
			t.Fatal(err)
		}
	}

	first := dialClip(t, sock)
	// Off until asked.
	if err := first.c.ClipboardGet(1, 100); err != nil { // connects
		t.Fatal(err)
	}
	if r := first.reply(); r.ID != 1 {
		t.Fatalf("get: %+v", r)
	}
	take()
	select {
	case <-first.changed:
		t.Fatal("clipboard.changed before clipboard.watch")
	case <-time.After(400 * time.Millisecond):
	}
	if err := first.c.ClipboardWatch(true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	take()
	select {
	case <-first.changed:
	case <-time.After(5 * time.Second):
		t.Fatal("no clipboard.changed")
	}

	second := dialClip(t, sock)
	// The first connection is gone once the new one answers.
	if err := second.c.ClipboardGet(2, 100); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	take()
	select {
	case <-second.changed:
		t.Fatal("clipboard.changed on a new connection that never asked")
	case <-time.After(400 * time.Millisecond):
	}
	if err := second.c.ClipboardWatch(true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	take()
	select {
	case <-second.changed:
	case <-time.After(5 * time.Second):
		t.Fatal("no clipboard.changed after asking")
	}
}

// The injector and the clipboard each have a connection, and their setup touches xgb's process-wide tables. Dial
// them together again and again, with the X server sending both of them events. Run it with -race.
func TestInjectorAndClipboardDialTogether(t *testing.T) {
	display := clipDisplay(t)
	x, err := xgb.NewConnDisplay(display)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(x.Close)
	clipboard, err := xproto.InternAtom(x, false, 9, "CLIPBOARD").Reply()
	if err != nil {
		t.Fatal(err)
	}
	win, err := xproto.NewWindowId(x)
	if err != nil {
		t.Fatal(err)
	}
	root := xproto.Setup(x).DefaultScreen(x).Root
	if err := xproto.CreateWindowChecked(x, 0, win, root, 0, 0, 1, 1, 0, xproto.WindowClassInputOnly, 0, 0, nil).Check(); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			xproto.SetSelectionOwner(x, win, clipboard.Atom, xproto.TimeCurrentTime)
			time.Sleep(time.Millisecond)
		}
	}()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for range 10 {
		in := xinput.New(display, log)
		var changed atomic.Int64
		c := xclip.New(xclip.Config{Display: display, Log: log, Send: func(_ uint64, m *rtcsock.Message) bool {
			if m.T == rtcsock.MsgClipChanged {
				changed.Add(1)
			}

			return true
		}})
		in.Kick()
		c.Submit(rtcsock.ClipWatch(true))
		deadline := time.Now().Add(5 * time.Second)
		for changed.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		c.Close()
		in.Close()
		if changed.Load() == 0 {
			t.Error("the clipboard heard nothing")
		}
	}
	close(stop)
	wg.Wait()
}

// clipSend can't block, so what bounds the text is this count, of the clipboard's own queue.
func TestClipBacklogCounts(t *testing.T) {
	q := newOutQueue()
	if q.clipBacklog() != 0 {
		t.Fatal("not empty")
	}
	q.pushClip(make([]byte, 100))
	q.pushClip(make([]byte, 50))
	if got := q.clipBacklog(); got != 150 {
		t.Fatalf("got %d", got)
	}
	if _, ok := q.next(); !ok {
		t.Fatal("no next")
	}
	if got := q.clipBacklog(); got != 50 {
		t.Fatalf("got %d", got)
	}
	q.pushData(rtcsock.ChBulk, make([]byte, 999))
	q.pushCtrl(make([]byte, 999))
	if got := q.clipBacklog(); got != 50 {
		t.Fatalf("others counted: %d", got)
	}
}

// The clipboard's replies go after every session's data, bulk included, and in the order they came.
func TestClipboardQueuesBelowSessionData(t *testing.T) {
	q := newOutQueue()
	tag := func(s string) []byte { return []byte(s) }
	q.pushClip(tag("clip1"))
	q.pushData(rtcsock.ChBulk, tag("bulk"))
	q.pushClip(tag("clip2"))
	q.pushData(rtcsock.ChCtl, tag("ctl"))
	q.pushCtrl(tag("json"))
	q.pushData(rtcsock.ChRPC, tag("rpc"))
	var got []string
	for range 6 {
		b, ok := q.next()
		if !ok {
			t.Fatal("closed")
		}
		got = append(got, string(b))
	}
	want := []string{"json", "ctl", "rpc", "bulk", "clip1", "clip2"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if q.clipBacklog() != 0 {
		t.Fatalf("backlog %d", q.clipBacklog())
	}
}

// A steady stream of session data lets a waiting clipboard message through every clipShare bytes.
func TestClipboardIsNotStarvedBySessionData(t *testing.T) {
	q := newOutQueue()
	frame := make([]byte, rtcsock.MaxFrame)
	for range 2 * clipShare / len(frame) {
		q.pushData(rtcsock.ChBulk, frame)
	}
	q.pushClip([]byte("clip1"))
	q.pushClip([]byte("clip2"))
	var ahead []int
	n := 0
	for range 2*clipShare/len(frame) + 2 {
		b, _ := q.next()
		if string(b) == "clip1" || string(b) == "clip2" {
			ahead = append(ahead, n)
			n = 0

			continue
		}
		n += len(b)
	}
	if len(ahead) != 2 {
		t.Fatalf("clipboard messages out: %d", len(ahead))
	}
	for _, a := range ahead {
		if a < clipShare || a > clipShare+len(frame) {
			t.Fatalf("%d bytes of data went ahead, want about %d", a, clipShare)
		}
	}
	// With nothing of the clipboard's waiting, data counts for nothing against the next one.
	for range clipShare / len(frame) {
		q.pushData(rtcsock.ChBulk, frame)
	}
	for range clipShare / len(frame) {
		q.next()
	}
	q.pushData(rtcsock.ChBulk, frame)
	q.pushClip([]byte("clip3"))
	if b, _ := q.next(); len(b) != len(frame) {
		t.Fatal("the clipboard went ahead of data with none gone before it")
	}
}

func TestClipSendRefusesTextToAStuckLink(t *testing.T) {
	s := &Server{}
	if s.clipSend(0, rtcsock.ClipOK(1)) {
		t.Fatal("sent with no link")
	}
	l := &link{srv: s, out: newOutQueue(), clipLink: 3}
	s.cur = l
	text := []byte("x")
	if !s.clipSend(3, rtcsock.ClipText(1, 0, true, text)) {
		t.Fatal("refused with nothing waiting")
	}
	l.out.pushClip(make([]byte, clipBacklogLimit+1))
	if s.clipSend(3, rtcsock.ClipText(1, 0, true, text)) {
		t.Fatal("more text went onto a full backlog")
	}
	if !s.clipSend(3, rtcsock.ClipError(1, rtcsock.ClipInternal)) {
		t.Fatal("the error saying so was refused")
	}
}

// What the clipboard sends for one connection never goes to the next.
func TestClipSendDropsAnOldLinksReplies(t *testing.T) {
	s := &Server{}
	l := &link{srv: s, out: newOutQueue(), clipLink: 2}
	s.cur = l
	if s.clipSend(1, rtcsock.ClipOK(1)) {
		t.Fatal("an old link's reply went to the new one")
	}
	if l.out.clipBacklog() != 0 {
		t.Fatal("queued")
	}
	if !s.clipSend(2, rtcsock.ClipOK(1)) {
		t.Fatal("this link's reply was dropped")
	}
}

// A clipboard field of the wrong type gets internal, or nothing with no good id, and never closes the link: that
// would close every session with it.
func TestClipboardBadFieldKeepsTheLink(t *testing.T) {
	sock := startClipServer(t, "")
	cc := dialClip(t, sock)
	cc.raw(`{"t":"clipboard.get","id":-1,"maxBytes":100}`)
	cc.raw(`{"t":"clipboard.get","id":7,"maxBytes":1e6}`)
	cc.raw(`{"t":"clipboard.set","id":8,"part":0,"last":"yes","data":""}`)
	cc.raw(`{"t":"clipboard.watch","on":1}`)
	cc.raw(`{"t":"stats.get","id":"x"}`)
	for _, id := range []uint64{7, 8} {
		if r := cc.reply(); r.ID != id || r.Code != rtcsock.ClipInternal {
			t.Fatalf("want internal for %d, got %+v", id, r)
		}
	}
	cc.alive()
	cc.alive() // the stats.get with a bad id was answered too
	cc.noReply(100 * time.Millisecond)
}

// The same with the X side: a set with a bad part fails once, and its later parts are ignored; a bad part 0 starts
// a set of its own, which fails; and good ones go on working.
func TestClipboardBadFieldWithX(t *testing.T) {
	display := clipDisplay(t)
	sock := startClipServer(t, display)
	cc := dialClip(t, sock)
	if err := cc.c.ClipboardSet(1, []byte("before")); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 1 || !r.OK {
		t.Fatalf("set: %+v", r)
	}

	if err := cc.c.Send(rtcsock.ClipSet(9, 0, false, []byte("hal"))); err != nil {
		t.Fatal(err)
	}
	cc.raw(`{"t":"clipboard.set","id":9,"part":1,"last":false,"data":5}`)
	if err := cc.c.Send(rtcsock.ClipSet(9, 2, true, []byte("f"))); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 9 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("bad part: %+v", r)
	}
	cc.raw(`{"t":"clipboard.get","id":10,"maxBytes":1000000.0}`)
	if r := cc.reply(); r.ID != 10 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("bad get: %+v", r)
	}
	cc.raw(`{"t":"clipboard.set","id":9,"part":0,"last":"yes","data":""}`)
	if r := cc.reply(); r.ID != 9 || r.Code != rtcsock.ClipInternal {
		t.Fatalf("bad part 0: %+v", r)
	}
	cc.raw(`{"t":"clipboard.watch","on":"true"}`)
	cc.alive()
	cc.noReply(200 * time.Millisecond)

	// Nothing bad landed: the text is what the last good set left.
	if err := cc.c.ClipboardGet(11, 100); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 11 || string(r.Text) != "before" {
		t.Fatalf("get: %+v", r)
	}
	if err := cc.c.ClipboardSet(9, []byte("after")); err != nil {
		t.Fatal(err)
	}
	if r := cc.reply(); r.ID != 9 || !r.OK {
		t.Fatalf("set after: %+v", r)
	}
}

// A new deskd connects while desk-rtc is in the middle of an old one's set, waiting on the X server for the
// selection. The reply to that set, when it comes, must not reach the new deskd: it would take it as the answer
// to its own set of the same id, and send the paste key on someone else's text.
func TestClipboardReconnectInTheMiddleOfASet(t *testing.T) {
	display := clipDisplay(t)
	sock := startClipServer(t, display)
	first := dialClip(t, sock)
	if err := first.c.ClipboardSet(1, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if r := first.reply(); r.ID != 1 || !r.OK {
		t.Fatalf("set: %+v", r)
	}

	x, err := xgb.NewConnDisplay(display)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(x.Close)
	atom := func(name string) xproto.Atom {
		t.Helper()
		r, err := xproto.InternAtom(x, false, uint16(len(name)), name).Reply()
		if err != nil {
			t.Fatal(err)
		}

		return r.Atom
	}
	clipboard, timeProp := atom("CLIPBOARD"), atom("_MA_CLIP_TIME")
	o, err := xproto.GetSelectionOwner(x, clipboard).Reply()
	if err != nil {
		t.Fatal(err)
	}
	win := o.Owner // desk-rtc's own window
	roundTrip := func() {
		t.Helper()
		if _, err := xproto.GetInputFocus(x).Reply(); err != nil {
			t.Fatal(err)
		}
	}

	// Hold the X server for everyone but this client, so what desk-rtc asks of it waits.
	xproto.GrabServer(x)
	roundTrip()
	grabbed := true
	ungrab := func() {
		if grabbed {
			grabbed = false
			xproto.UngrabServer(x)
			roundTrip()
		}
	}
	t.Cleanup(ungrab)

	// A set whose request for the server's time now waits.
	if err := first.c.ClipboardSet(2, []byte("second")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	// Its time, forged, so desk-rtc goes on to take the selection, and waits on the server to say it has.
	ev := xproto.PropertyNotifyEvent{Window: win, Atom: timeProp, Time: xproto.TimeCurrentTime, State: xproto.PropertyNewValue}
	xproto.SendEvent(x, false, win, 0, string(ev.Bytes()))
	roundTrip()
	time.Sleep(200 * time.Millisecond)

	// The new deskd, while that's under way. alive shows desk-rtc is serving it.
	second := dialClip(t, sock)
	second.alive()
	ungrab()

	// Whatever comes of 2 was for the first deskd, and the second hears none of it.
	second.noReply(time.Second)
	if err := second.c.ClipboardSet(2, []byte("third")); err != nil {
		t.Fatal(err)
	}
	if r := second.reply(); r.ID != 2 || !r.OK {
		t.Fatalf("set: %+v", r)
	}
	if err := second.c.ClipboardGet(3, 100); err != nil {
		t.Fatal(err)
	}
	if r := second.reply(); r.ID != 3 || string(r.Text) != "third" {
		t.Fatalf("get: %+v", r)
	}
	second.noReply(200 * time.Millisecond)
}
