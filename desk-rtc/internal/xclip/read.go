package xclip

import (
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

type readStage int

const (
	readWaitTime   readStage = iota // for the server's time, off our new window
	readWaitNotify                  // for the owner's SelectionNotify
	readIncr                        // for the owner's next INCR chunk
)

// readOp is the one read under way. It has a window of its own, destroyed when it ends, so an owner still writing
// from a read we gave up on gets BadWindow, not a place in the next one.
type readOp struct {
	id            uint64
	max           int
	win           xproto.Window
	stage         readStage
	buf           []byte
	step, overall time.Time
}

type pendingRead struct {
	id  uint64
	max int
}

// readDone is how a read ended: text, none (empty text), or a code.
type readDone struct {
	text []byte
	code string
}

func (c *Clipboard) onGet(id uint64, maxBytes int) {
	if maxBytes <= 0 || maxBytes > hardLimit {
		maxBytes = hardLimit
	}
	if len(c.readQ) >= maxPendingReads {
		c.reply(rtcsock.ClipError(id, rtcsock.ClipInternal))

		return
	}
	c.readQ = append(c.readQ, pendingRead{id, maxBytes})
}

// startReads starts what's queued, one at a time. A read waits for sets ahead of it, so a get after a set sees it.
func (c *Clipboard) startReads() {
	for c.read == nil && len(c.sets) == 0 && len(c.readQ) > 0 {
		r := c.readQ[0]
		c.readQ = c.readQ[1:]
		c.startRead(r.id, r.max)
	}
}

func (c *Clipboard) startRead(id uint64, maxBytes int) {
	x := c.conn()
	if x == nil {
		c.reply(rtcsock.ClipError(id, rtcsock.ClipNoDisplay))

		return
	}
	r, err := xproto.GetSelectionOwner(x.c, x.a.clipboard).Reply()
	if err != nil || r == nil {
		c.reply(rtcsock.ClipError(id, rtcsock.ClipNoDisplay))

		return
	}
	switch r.Owner {
	case xproto.WindowNone:
		c.reply(rtcsock.ClipNone(id))

		return
	case x.win:
		c.replyOwn(id, maxBytes)

		return
	}
	win, err := xproto.NewWindowId(x.c)
	if err != nil {
		// xgb has run out of ids for this connection, which only a new one fixes.
		c.log.Warn("no more X ids on the clipboard's connection")
		x.kill()
		c.reply(rtcsock.ClipError(id, rtcsock.ClipNoDisplay))

		return
	}
	x.newWindow(win)
	now := time.Now()
	c.read = &readOp{
		id:      id,
		max:     maxBytes,
		win:     win,
		stage:   readWaitTime,
		step:    now.Add(stepTimeout),
		overall: now.Add(transferTimeout),
	}
	x.touchTime(win)
}

// replyOwn answers from what we hold, with no trip through the X server for text that's already here.
func (c *Clipboard) replyOwn(id uint64, maxBytes int) {
	switch {
	case !c.owned || len(c.text) == 0:
		c.reply(rtcsock.ClipNone(id))
	case len(c.text) > maxBytes:
		c.reply(rtcsock.ClipError(id, rtcsock.ClipTooLarge))
	default:
		c.sendText(id, c.text)
	}
}

// sendText sends text in parts. If deskd is too far behind to take them, it gets an error in place of the rest.
func (c *Clipboard) sendText(id uint64, text []byte) {
	rtcsock.ClipEachPart(text, func(part int, last bool, chunk []byte) bool {
		if !c.send(rtcsock.ClipText(id, part, last, chunk)) {
			c.reply(rtcsock.ClipError(id, rtcsock.ClipInternal))

			return false
		}

		return true
	})
}

func (c *Clipboard) onReadProperty(x *xconn, e xproto.PropertyNotifyEvent) {
	r := c.read
	if e.State != xproto.PropertyNewValue {
		return
	}
	switch {
	case r.stage == readWaitTime && e.Atom == x.a.timeProp:
		r.stage = readWaitNotify
		r.step = time.Now().Add(stepTimeout)
		xproto.ConvertSelection(x.c, r.win, x.a.clipboard, x.a.utf8, x.a.dataProp, e.Time)
	case r.stage == readIncr && e.Atom == x.a.dataProp:
		c.readChunk(x)
	}
}

func (c *Clipboard) onReadNotify(x *xconn, e xproto.SelectionNotifyEvent) {
	r := c.read
	if r == nil || r.stage != readWaitNotify || e.Requestor != r.win {
		return
	}
	if e.Selection != x.a.clipboard || e.Property != x.a.dataProp {
		// A refusal, or no owner when the request reached the server.
		c.finishRead(readDone{})

		return
	}
	p, ok := c.getProperty(x, r.max+1)
	if !ok {
		return
	}
	switch {
	case p.Type == x.a.incr:
		// The delete in getProperty is what tells the owner to start. Its size is a lower bound, so one
		// that's over already can stop here.
		if len(p.Value) >= 4 && int64(xgb.Get32(p.Value)) > int64(r.max) {
			c.finishRead(readDone{code: rtcsock.ClipTooLarge})

			return
		}
		r.stage = readIncr
		r.step = time.Now().Add(stepTimeout)
	case p.Type != x.a.utf8 || p.Format != 8:
		c.finishRead(readDone{}) // not the text it was asked for, or the property is gone
	case p.BytesAfter > 0 || len(p.Value) > r.max:
		c.finishRead(readDone{code: rtcsock.ClipTooLarge})
	default:
		c.finishRead(readDone{text: p.Value})
	}
}

// readChunk takes one INCR chunk. Reading stops at the cap, so an owner with endless data costs no more than one
// honest one, and what it had sent is dropped, never handed over as a cut piece.
func (c *Clipboard) readChunk(x *xconn) {
	r := c.read
	p, ok := c.getProperty(x, r.max-len(r.buf)+1)
	if !ok {
		return
	}
	switch {
	case p.Type == xproto.AtomNone:
		// A NewValue we've already read: an append can leave one behind. It isn't progress.
	case p.Type != x.a.utf8 || p.Format != 8:
		c.finishRead(readDone{}) // the owner changed its mind about what it's sending
	case p.BytesAfter > 0 || len(r.buf)+len(p.Value) > r.max:
		c.finishRead(readDone{code: rtcsock.ClipTooLarge})
	case len(p.Value) == 0:
		c.finishRead(readDone{text: r.buf})
	default:
		r.buf = append(r.buf, p.Value...)
		r.step = time.Now().Add(stepTimeout)
	}
}

// getProperty reads up to about limit bytes of the read's data property, deleting it if that's all of it. The
// server answers this, not the owner, and the limit is what keeps a huge property out of memory.
func (c *Clipboard) getProperty(x *xconn, limit int) (*xproto.GetPropertyReply, bool) {
	r := c.read
	p, err := xproto.GetProperty(x.c, true, r.win, x.a.dataProp, xproto.GetPropertyTypeAny, 0, uint32(limit+3)/4).Reply()
	if err != nil || p == nil {
		// Our own window on our own connection, so the connection is what's in trouble.
		c.finishRead(readDone{code: rtcsock.ClipNoDisplay})

		return nil, false
	}

	return p, true
}

// finishRead ends the read under way and sends its reply.
func (c *Clipboard) finishRead(d readDone) {
	r := c.read
	c.endRead()
	switch {
	case d.code != "":
		c.reply(rtcsock.ClipError(r.id, d.code))
	case len(d.text) == 0:
		c.reply(rtcsock.ClipNone(r.id))
	default:
		c.sendText(r.id, d.text)
	}
	clear(d.text)
	clear(r.buf)
}

// abortRead ends the read under way with no reply.
func (c *Clipboard) abortRead() {
	r := c.read
	c.endRead()
	clear(r.buf)
}

func (c *Clipboard) endRead() {
	r := c.read
	c.read = nil
	if c.x != nil {
		xproto.DestroyWindow(c.x.c, r.win)
	}
}
