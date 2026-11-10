package xclip

import (
	"bytes"
	"encoding/base64"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.b.Write(p)
}

func (l *lockedBuffer) Bytes() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()

	return bytes.Clone(l.b.Bytes())
}

// The text, its length and a data field never reach the log, at any level, whichever way the text goes and
// whatever goes wrong.
func TestNothingAboutTheTextIsLogged(t *testing.T) {
	display := xdisplay(t)
	var logged lockedBuffer
	d := newDeskd(t)
	log := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))
	c := New(Config{Display: display, Log: log, Send: d.send})
	t.Cleanup(c.Close)
	o := newOther(t, display)

	const size = 123_457
	secret := bytes.Repeat([]byte("SECRETS3CR3T"), size/12+1)[:size]
	stop := make(chan struct{})

	// Both ways, through INCR, with a transfer that dies, a refusal, and an error from X.
	submitSet(c, 1, secret)
	mustOK(t, d, 1)
	if got := o.readText(o.utf8); !bytes.Equal(got, secret) {
		t.Fatal("read back wrong")
	}
	o.convert(o.clipboard, o.bogus, xproto.TimeCurrentTime)
	ours := o.owner(o.clipboard)
	req := xproto.SelectionRequestEvent{
		Time: xproto.TimeCurrentTime, Owner: ours, Requestor: 0x7f000123, Selection: o.clipboard, Target: o.utf8, Property: o.prop,
	}
	o.forge(ours, req.Bytes())
	o.takeSelection(o.clipboard)
	o.serve(secret, 4096, stop)
	c.Submit(rtcsock.ClipGet(2, size))
	if r := d.reply(testWait); !bytes.Equal(r.Text, secret) {
		t.Fatal("read wrong")
	}
	c.Submit(rtcsock.ClipGet(3, size-1))
	if r := d.reply(testWait); r.Code != rtcsock.ClipTooLarge {
		t.Fatal("not too_large")
	}
	close(stop)
	bad := rtcsock.ClipSet(4, 0, true, nil)
	bad.Data = "SECRETS3CR3T!" // not base64, and it's still not logged
	c.Submit(bad)
	if r := d.reply(testWait); r.Code != rtcsock.ClipInternal {
		t.Fatal("not internal")
	}
	submitSet(c, 5, secret)
	mustOK(t, d, 5)
	xproto.KillClient(o.c, uint32(o.owner(o.clipboard)))
	waitFor(t, testWait, "the connection going", func() bool { return c.cur.Load() == nil || o.owner(o.clipboard) == xproto.WindowNone })
	time.Sleep(100 * time.Millisecond)

	out := logged.Bytes()
	if len(out) == 0 {
		t.Fatal("nothing was logged, so this proved nothing")
	}
	for _, needle := range []string{
		"SECRET", "S3CR3T",
		base64.StdEncoding.EncodeToString(secret[:45]),
		strconv.Itoa(size), strconv.Itoa(size - 1),
	} {
		if bytes.Contains(out, []byte(needle)) {
			t.Fatalf("the log has %q:\n%s", needle, out)
		}
	}
}

// Any client can write our properties. One that leaves the time property in another format must not stop sets.
func TestSomeoneElseWritesOurTimeProperty(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	submitSet(c, 1, []byte("mine"))
	mustOK(t, d, 1)
	ours := o.owner(o.clipboard)
	prop := o.atom("_MA_CLIP_TIME")
	xproto.ChangeProperty(o.c, xproto.PropModeReplace, ours, prop, xproto.AtomAtom, 32, 1, []byte{1, 0, 0, 0})
	if _, err := xproto.GetInputFocus(o.c).Reply(); err != nil {
		t.Fatal(err)
	}
	submitSet(c, 2, []byte("still mine"))
	mustOK(t, d, 2)
	if got := o.readText(o.utf8); string(got) != "still mine" {
		t.Fatalf("got %q", got)
	}
}

// Serving a million bytes over and over must not hold up the X server for another client, which is the point of
// small chunks and its own connection: this stands in for XTEST and the cursor.
func TestServingDoesNotHoldUpOtherClients(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	probe := newOther(t, display)
	text := testText(1_000_000)
	submitSet(c, 1, text)
	mustOK(t, d, 1)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	var served atomic.Int64
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if got := o.readText(o.utf8); len(got) != len(text) {
				t.Errorf("read %d bytes", len(got))

				return
			}
			served.Add(1)
		}
	}()
	var trips []time.Duration
	until := time.Now().Add(2 * time.Second)
	for time.Now().Before(until) {
		began := time.Now()
		if _, err := xproto.GetInputFocus(probe.c).Reply(); err != nil {
			t.Fatal(err)
		}
		trips = append(trips, time.Since(began))
		time.Sleep(time.Millisecond)
	}
	close(stop)
	wg.Wait()
	slices.Sort(trips)
	p50, p99, worst := trips[len(trips)/2], trips[len(trips)*99/100], trips[len(trips)-1]
	t.Logf("%d full reads of 1 MB in 2 s; another client's round trip: p50 %v, p99 %v, worst %v (%d trips)",
		served.Load(), p50, p99, worst, len(trips))
	if served.Load() == 0 {
		t.Fatal("nothing was served, so this proved nothing")
	}
	// This machine is shared, so the limit is well above what it measures, only there to catch a real stall.
	if p99 > 50*time.Millisecond {
		t.Fatalf("p99 %v", p99)
	}
}

// An owner with nothing usable gives none, whether it refuses, answers with something else, or has empty text.
func TestOwnerWithNoText(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)
	o := newOther(t, display)
	o.takeSelection(o.clipboard)
	answers := []struct {
		name   string
		answer func(e xproto.SelectionRequestEvent)
	}{
		{"refuses", func(e xproto.SelectionRequestEvent) { o.notify(e, xproto.AtomNone) }},
		{"another type", func(e xproto.SelectionRequestEvent) {
			xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, xproto.AtomString, 8, 4, []byte("text"))
			o.notify(e, e.Property)
		}},
		{"another format", func(e xproto.SelectionRequestEvent) {
			xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.utf8, 32, 1, []byte("text"))
			o.notify(e, e.Property)
		}},
		{"empty", func(e xproto.SelectionRequestEvent) {
			xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, e.Property, o.utf8, 8, 0, nil)
			o.notify(e, e.Property)
		}},
		{"says it's on a property it never wrote", func(e xproto.SelectionRequestEvent) { o.notify(e, e.Property) }},
		{"another property", func(e xproto.SelectionRequestEvent) {
			xproto.ChangeProperty(o.c, xproto.PropModeReplace, e.Requestor, o.bogus, o.utf8, 8, 4, []byte("text"))
			o.notify(e, o.bogus)
		}},
	}
	for i, a := range answers {
		id := uint64(i + 1)
		c.Submit(rtcsock.ClipGet(id, 100))
		e := waitEvent(o, testWait, func(e xproto.SelectionRequestEvent) bool { return e.Selection == o.clipboard })
		if e.Target != o.utf8 {
			t.Fatalf("%s: it asked for target %d", a.name, e.Target)
		}
		a.answer(e)
		if r := d.reply(testWait); r.ID != id || !r.None {
			t.Fatalf("%s: got %s", a.name, describe(r))
		}
	}
}

// An owner and a requestor each moving just fast enough to beat the step's deadline still meet the transfer's.
func TestTransfersHaveAnOverallBound(t *testing.T) {
	display := xdisplay(t)
	c, d := start(t, display)

	// The slow requestor, on our text.
	slow := newOther(t, display)
	submitSet(c, 1, testText(2_000_000))
	mustOK(t, d, 1)
	if n := slow.convert(slow.clipboard, slow.utf8, xproto.TimeCurrentTime); n.Property == xproto.AtomNone {
		t.Fatal("refused")
	}
	began := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for c.activeServes.Load() > 0 || time.Since(began) < time.Second {
			xproto.DeleteProperty(slow.c, slow.win, slow.prop)
			time.Sleep(stepTimeout / 3)
		}
	}()
	<-done
	took := time.Since(began)
	if took < transferTimeout-2*time.Second || took > transferTimeout+2*time.Second {
		t.Fatalf("the slow requestor was let go after %v", took)
	}

	// The slow owner.
	owner := newOther(t, display)
	owner.takeSelection(owner.clipboard)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		var e xproto.SelectionRequestEvent
		for {
			select {
			case <-stop:
				return
			case ev := <-owner.events:
				if r, ok := ev.(xproto.SelectionRequestEvent); ok {
					e = r
					size := make([]byte, 4)
					xgb.Put32(size, 10)
					xproto.ChangeProperty(owner.c, xproto.PropModeReplace, e.Requestor, e.Property, owner.incr, 32, 1, size)
					owner.notify(e, e.Property)
				}
			case <-time.After(stepTimeout / 3):
				if e.Requestor != 0 {
					xproto.ChangeProperty(owner.c, xproto.PropModeReplace, e.Requestor, e.Property, owner.utf8, 8, 1, []byte("x"))
				}
			}
		}
	}()
	began = time.Now()
	c.Submit(rtcsock.ClipGet(2, 1000))
	r := d.reply(transferTimeout + 3*time.Second)
	took = time.Since(began)
	if r.ID != 2 || r.Code != rtcsock.ClipTimeout {
		t.Fatalf("got %s", describe(r))
	}
	if took < transferTimeout-2*time.Second {
		t.Fatalf("the slow owner was let go after only %v", took)
	}
}
