package xclip

import (
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/xext"
)

func init() {
	// xgb logs "Could not get authority info" on every connect. Access comes from xhost
	// (SI:localuser:rtc), so that's normal here.
	xgb.Logger = stdlog.New(io.Discard, "", 0)
}

// atoms this package uses. timeProp and dataProp are its own, on its own windows.
type atoms struct {
	clipboard, utf8, textPlain, targets, timestamp, incr, timeProp, dataProp xproto.Atom
}

// xconn is one connection to the X server, with its one window.
//
// Everything hostile about X arrives through here, so its rules are few. The worker is the only one that makes
// requests. pump is the only one that takes events, so xgb's reader can never be stuck behind a full event queue
// while the worker waits on a reply from it. And kill closes the socket, because a server that has stopped
// reading, or is grabbed, blocks xgb's writes and replies forever and its own Close waits for a round trip.
type xconn struct {
	nc   net.Conn
	c    *xgb.Conn
	log  *slog.Logger
	root xproto.Window
	win  xproto.Window
	a    atoms
	// chunk is the most text to put in one ChangeProperty: below this, one property; above, INCR.
	chunk int

	// events keeps the X server's order, which matters: a requestor's delete of the last transfer's property
	// comes before its next request, and taken the other way round it reads as the start of the new transfer.
	// A full queue drops the event: the other side then times out, and nothing here waits.
	events chan xgb.Event
	// sig says a flag below is set. These two can't be lost to a full queue.
	sig     chan struct{}
	cleared atomic.Bool
	changed atomic.Bool

	dead     chan struct{} // closed when the connection is gone
	killOnce sync.Once
}

const (
	eventQueue = 1024
	// requestRoom is as much of the queue as SelectionRequests can take up, so a flood of them can't crowd out
	// what the worker is waiting for.
	requestRoom = 256
)

// socketPath finds a local display's socket. The display is always named by the caller: nothing here reads
// $DISPLAY, which is what xgb would do with an empty string.
func socketPath(display string) (string, error) {
	i := strings.LastIndexByte(display, ':')
	if i < 0 {
		return "", fmt.Errorf("bad display %q", display)
	}
	host, rest := display[:i], display[i+1:]
	num, _, _ := strings.Cut(rest, ".")
	if n, err := strconv.Atoi(num); err != nil || n < 0 {
		return "", fmt.Errorf("bad display %q", display)
	}
	switch {
	case host == "" || host == "unix":
		return "/tmp/.X11-unix/X" + num, nil
	case strings.HasPrefix(host, "/"):
		return host + ":" + num, nil
	}

	return "", fmt.Errorf("display %q isn't a local socket", display)
}

// dial connects and sets everything up, or gives up after serverTimeout, even if the server accepts the
// connection and then says nothing. It doesn't use xgb.NewConnDisplay because that keeps the socket to itself.
//
// This can't start the X server: on a desk nothing listens on the socket until deskd has started desk-xorg, so
// the connect just fails. xgb.NewConnNet doesn't look up a cookie for the display, and a desk doesn't use one:
// access comes from xhost.
func dial(display string, log *slog.Logger) (*xconn, error) {
	if display == "" {
		return nil, errors.New("no display")
	}
	path, err := socketPath(display)
	if err != nil {
		return nil, err
	}
	nd := net.Dialer{Timeout: serverTimeout}
	nc, err := nd.Dial("unix", path)
	if err != nil {
		return nil, err
	}
	if err := nc.SetDeadline(time.Now().Add(serverTimeout)); err != nil {
		_ = nc.Close()

		return nil, err
	}
	c, err := xgb.NewConnNet(nc)
	if err != nil {
		_ = nc.Close()

		return nil, err
	}
	x := &xconn{
		nc:     nc,
		c:      c,
		log:    log,
		events: make(chan xgb.Event, eventQueue),
		sig:    make(chan struct{}, 1),
		dead:   make(chan struct{}),
	}
	if err := x.setup(); err != nil {
		_ = nc.Close()

		return nil, err
	}
	if err := nc.SetDeadline(time.Time{}); err != nil {
		_ = nc.Close()

		return nil, err
	}
	go x.pump()

	return x, nil
}

func (x *xconn) setup() error {
	if err := xext.InitXFixes(x.c); err != nil {
		return err
	}
	if _, err := xfixes.QueryVersion(x.c, 5, 0).Reply(); err != nil {
		return fmt.Errorf("XFIXES version: %w", err)
	}
	if err := x.internAtoms(); err != nil {
		return err
	}
	setup := xproto.Setup(x.c)
	x.root = setup.DefaultScreen(x.c).Root
	// A request's length field counts 4-byte units, and xgb's ChangeProperty only has the 16-bit form of it.
	x.chunk = min(incrChunk, int(setup.MaximumRequestLength)*4-changePropertyHeader)

	win, err := xproto.NewWindowId(x.c)
	if err != nil {
		return err
	}
	x.win = win
	if err := x.newWindow(win).Check(); err != nil {
		return fmt.Errorf("window: %w", err)
	}
	err = xfixes.SelectSelectionInputChecked(x.c, win, x.a.clipboard, xfixes.SelectionEventMaskSetSelectionOwner).Check()
	if err != nil {
		return fmt.Errorf("selection events: %w", err)
	}

	return nil
}

func (x *xconn) internAtoms() error {
	names := []struct {
		name string
		atom *xproto.Atom
	}{
		{"CLIPBOARD", &x.a.clipboard},
		{"UTF8_STRING", &x.a.utf8},
		{"text/plain;charset=utf-8", &x.a.textPlain},
		{"TARGETS", &x.a.targets},
		{"TIMESTAMP", &x.a.timestamp},
		{"INCR", &x.a.incr},
		{"_MA_CLIP_TIME", &x.a.timeProp},
		{"_MA_CLIP_DATA", &x.a.dataProp},
	}
	cookies := make([]xproto.InternAtomCookie, len(names))
	for i, n := range names {
		cookies[i] = xproto.InternAtom(x.c, false, uint16(len(n.name)), n.name)
	}
	for i, n := range names {
		r, err := cookies[i].Reply()
		if err != nil {
			return fmt.Errorf("atom %s: %w", n.name, err)
		}
		*n.atom = r.Atom
	}

	return nil
}

// newWindow makes an unmapped window that hears about its own property changes. It's checked, so the worker can
// use it for setup and ignore the error for later ones.
func (x *xconn) newWindow(id xproto.Window) xproto.CreateWindowCookie {
	return xproto.CreateWindowChecked(x.c, 0, id, x.root, 0, 0, 1, 1, 0, xproto.WindowClassInputOnly, 0,
		xproto.CwEventMask, []uint32{xproto.EventMaskPropertyChange})
}

// kill drops the connection at once, whatever state the server is in. Every blocked xgb call then returns, and
// the server takes the selection away from the closed client.
func (x *xconn) kill() {
	x.killOnce.Do(func() { _ = x.nc.Close() })
}

func (x *xconn) push(ev xgb.Event) {
	select {
	case x.events <- ev:
	default:
	}
}

func (x *xconn) signal() {
	select {
	case x.sig <- struct{}{}:
	default:
	}
}

// pump takes every event. Only the connection really being gone ends it: X errors are normal here, because a
// requestor can vanish at any moment and leave our next request to it with BadWindow.
func (x *xconn) pump() {
	defer close(x.dead)
	for {
		ev, xerr := x.c.WaitForEvent()
		if ev == nil && xerr == nil {
			return
		}
		if xerr != nil {
			x.log.Debug("X error", "err", xerr)

			continue
		}
		switch e := ev.(type) {
		case xproto.SelectionClearEvent:
			if e.Selection == x.a.clipboard {
				x.cleared.Store(true)
				x.signal()
			}
		case xfixes.SelectionNotifyEvent:
			if e.Selection == x.a.clipboard && e.Owner != x.win && e.Owner != xproto.WindowNone {
				x.changed.Store(true)
				x.signal()
			}
		case xproto.SelectionRequestEvent:
			if len(x.events) < requestRoom {
				x.push(ev)
			}
		case xproto.PropertyNotifyEvent, xproto.SelectionNotifyEvent, xproto.DestroyNotifyEvent:
			x.push(ev)
		}
	}
}
