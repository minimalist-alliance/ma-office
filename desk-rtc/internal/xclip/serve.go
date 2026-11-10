package xclip

import (
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

type serveKey struct {
	win  xproto.Window
	prop xproto.Atom
}

// serve is one INCR transfer to one requestor. It keeps its own reference to the text, so a later set doesn't
// change what it's halfway through sending.
type serve struct {
	data          []byte
	off           int
	typ           xproto.Atom
	step, overall time.Time
}

// onRequest answers one SelectionRequest. None of it waits for the requestor, and if its window is gone, the
// requests here just come back as BadWindow, which pump ignores.
func (c *Clipboard) onRequest(x *xconn, e xproto.SelectionRequestEvent) {
	// One of our own windows as the requestor could only be a forgery, and it would have us rewrite our own
	// event masks when the transfer ended. So no answer either: we'd be telling ourselves.
	if e.Requestor == x.win || (c.read != nil && e.Requestor == c.read.win) {
		return
	}
	// An obsolete client names no property, and ICCCM says to use the target's name.
	prop := e.Property
	if prop == xproto.AtomNone {
		prop = e.Target
	}
	if !c.owned || e.Selection != x.a.clipboard || e.Owner != x.win || c.beforeSelection(e.Time) {
		x.notify(e, xproto.AtomNone)

		return
	}
	switch e.Target {
	case x.a.targets:
		list := []xproto.Atom{x.a.targets, x.a.timestamp, x.a.utf8, x.a.textPlain}
		b := make([]byte, 4*len(list))
		for i, a := range list {
			xgb.Put32(b[i*4:], uint32(a))
		}
		xproto.ChangeProperty(x.c, xproto.PropModeReplace, e.Requestor, prop, xproto.AtomAtom, 32, uint32(len(list)), b)
		x.notify(e, prop)
	case x.a.timestamp:
		b := make([]byte, 4)
		xgb.Put32(b, uint32(c.selTime))
		xproto.ChangeProperty(x.c, xproto.PropModeReplace, e.Requestor, prop, xproto.AtomInteger, 32, 1, b)
		x.notify(e, prop)
	case x.a.utf8, x.a.textPlain:
		c.serveText(x, e, prop)
	default:
		x.notify(e, xproto.AtomNone)
	}
}

// beforeSelection compares X times, which are milliseconds in 32 bits and wrap. CurrentTime means now.
func (c *Clipboard) beforeSelection(t xproto.Timestamp) bool {
	return t != xproto.TimeCurrentTime && int32(uint32(t)-uint32(c.selTime)) < 0
}

func (c *Clipboard) serveText(x *xconn, e xproto.SelectionRequestEvent, prop xproto.Atom) {
	if len(c.text) <= x.chunk {
		xproto.ChangeProperty(x.c, xproto.PropModeReplace, e.Requestor, prop, e.Target, 8, uint32(len(c.text)), c.text)
		x.notify(e, prop)

		return
	}
	key := serveKey{e.Requestor, prop}
	if _, again := c.serves[key]; !again && len(c.serves) >= maxServes {
		x.notify(e, xproto.AtomNone)

		return
	}
	// The events go on before the requestor can hear anything, or its first delete could be missed. Destroy is
	// there so one that dies mid-transfer frees its slot now, not at the step's deadline.
	xproto.ChangeWindowAttributes(x.c, e.Requestor, xproto.CwEventMask,
		[]uint32{xproto.EventMaskPropertyChange | xproto.EventMaskStructureNotify})
	size := make([]byte, 4)
	xgb.Put32(size, uint32(len(c.text)))
	xproto.ChangeProperty(x.c, xproto.PropModeReplace, e.Requestor, prop, x.a.incr, 32, 1, size)
	x.notify(e, prop)
	now := time.Now()
	c.serves[key] = &serve{
		data:    c.text,
		typ:     e.Target,
		step:    now.Add(stepTimeout),
		overall: now.Add(transferTimeout),
	}
	c.activeServes.Store(int32(len(c.serves)))
}

func (x *xconn) notify(e xproto.SelectionRequestEvent, prop xproto.Atom) {
	n := xproto.SelectionNotifyEvent{
		Time:      e.Time,
		Requestor: e.Requestor,
		Selection: e.Selection,
		Target:    e.Target,
		Property:  prop,
	}
	xproto.SendEvent(x.c, false, e.Requestor, 0, string(n.Bytes()))
}

// onServeProperty moves a transfer along when its requestor deletes the property. Going fast only ends it sooner,
// and a requestor that stops running out of the text it asked for is done.
func (c *Clipboard) onServeProperty(x *xconn, e xproto.PropertyNotifyEvent) {
	if e.State != xproto.PropertyDelete {
		return
	}
	key := serveKey{e.Window, e.Atom}
	s := c.serves[key]
	if s == nil {
		return
	}
	if s.off >= len(s.data) {
		xproto.ChangeProperty(x.c, xproto.PropModeReplace, e.Window, e.Atom, s.typ, 8, 0, nil)
		c.endServe(x, key)

		return
	}
	n := min(len(s.data)-s.off, x.chunk)
	xproto.ChangeProperty(x.c, xproto.PropModeReplace, e.Window, e.Atom, s.typ, 8, uint32(n), s.data[s.off:s.off+n])
	s.off += n
	s.step = time.Now().Add(stepTimeout)
}

// endServe forgets a transfer, and stops listening to its window once no other transfer is using it.
func (c *Clipboard) endServe(x *xconn, key serveKey) {
	delete(c.serves, key)
	c.activeServes.Store(int32(len(c.serves)))
	for k := range c.serves {
		if k.win == key.win {
			return
		}
	}
	xproto.ChangeWindowAttributes(x.c, key.win, xproto.CwEventMask, []uint32{0})
}

func (c *Clipboard) onRequestorGone(win xproto.Window) {
	for k := range c.serves {
		if k.win == win {
			delete(c.serves, k)
		}
	}
	c.activeServes.Store(int32(len(c.serves)))
}

func (c *Clipboard) endAllServes(x *xconn) {
	for k := range c.serves {
		c.endServe(x, k)
	}
}
