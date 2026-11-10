// Package xclip is desk-rtc's side of the desk's clipboard: the X CLIPBOARD selection, both ways, text only, for
// deskd over rtc.sock. Never PRIMARY.
//
// It has its own X connection, window and goroutine, apart from the injector's, so serving 1 MB can't delay XTEST
// or the cursor. It treats every other X client as hostile, since Chromium's user has X access and a page can
// drive Chromium: nothing another client does can hang the worker, leak state or grow memory past the cap.
//
// The worker never waits for another client. Everything that depends on one (a requestor deleting a property, an
// owner answering) is a state machine driven by events, with a deadline per step and one per transfer. The worker
// only waits for the X server itself, and if that doesn't answer in serverTimeout, the guard drops the connection.
//
// The text is never logged, nor its length, nor a data field, at any level. It stays in memory only.
package xclip

import (
	"encoding/base64"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

const (
	// hardLimit is this side's cap on the text, both ways. deskd is the real gate, at 1,000,000 bytes.
	hardLimit = 2 << 20

	// stepTimeout is how long an owner or a requestor gets to answer, per step.
	stepTimeout = 3 * time.Second
	// transferTimeout bounds one whole transfer, however steadily it's moving.
	transferTimeout = 15 * time.Second
	// serverTimeout is how long the X server itself gets. It's over stepTimeout, so a stuck server shows up
	// as timeout on the steps that are waiting, before the connection goes.
	serverTimeout = 5 * time.Second
	// dialEvery matches the injector.
	dialEvery = 500 * time.Millisecond
	// changedEvery makes clipboard.changed at most 4 a second.
	changedEvery = 250 * time.Millisecond

	// msgQueue holds a whole 2 MiB set (46 parts) while the worker is busy.
	msgQueue = 64
	// maxServes bounds requestors in the middle of an INCR. Over it, a large request is refused.
	maxServes = 8
	// maxPendingSets and maxPendingReads bound what waits on the X server or on one read at a time.
	maxPendingSets  = 4
	maxPendingReads = 8

	// incrChunk is the most text in one ChangeProperty. The protocol allows about 256 KiB, but a smaller
	// request holds up the X server, and so XTEST and the video, for less time.
	incrChunk = 64 * 1024
	// changePropertyHeader is ChangeProperty's fixed part, in bytes.
	changePropertyHeader = 24
)

// Config configures a Clipboard.
type Config struct {
	// Display is the X display, such as ":99". It's never taken from the environment.
	Display string
	Log     *slog.Logger
	// Send gives a message to deskd, and must not block. link is the ResetLink that the message answers to:
	// Send drops it unless that's still the connection, so nothing meant for one deskd reaches the next. False
	// means it went nowhere, or deskd is too far behind to take this much more.
	Send func(link uint64, m *rtcsock.Message) bool
}

// Clipboard is the worker and its way in. Submit, ResetLink and Close are safe from any goroutine.
type Clipboard struct {
	cfg Config
	log *slog.Logger

	q    chan item
	wake chan struct{}
	stop chan struct{}
	done chan struct{}
	once sync.Once

	gen     atomic.Uint64
	watchOn atomic.Bool
	cur     atomic.Pointer[xconn] // what the guard kills
	guard   *time.Timer

	// activeServes is for tests: how many INCR transfers are running.
	activeServes atomic.Int32

	// Only the worker touches these.
	seenGen  uint64
	x        *xconn
	nextDial time.Time

	asm       assembly
	failed    uint64 // the last set told it failed, so its later parts stay quiet
	hasFailed bool
	sets      []*setOp

	owned   bool
	text    []byte
	selTime xproto.Timestamp
	serves  map[serveKey]*serve

	read  *readOp
	readQ []pendingRead

	watching    bool
	lastChanged time.Time
	changedDue  time.Time
	changedWait bool
}

type item struct {
	gen uint64
	m   *rtcsock.Message
}

// New starts the worker. It connects to X only when something needs it.
func New(cfg Config) *Clipboard {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	c := &Clipboard{
		cfg:    cfg,
		log:    cfg.Log,
		q:      make(chan item, msgQueue),
		wake:   make(chan struct{}, 1),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
		serves: map[serveKey]*serve{},
	}
	c.guard = time.AfterFunc(time.Hour, c.killCurrent)
	c.guard.Stop()
	go c.run()

	return c
}

// Submit hands over one message from deskd and never blocks. If the queue is full, the set or get gets
// clipboard.error with internal. A clipboard.watch with on of the wrong type changes nothing.
func (c *Clipboard) Submit(m *rtcsock.Message) {
	if m.T == rtcsock.MsgClipWatch {
		if m.ClipBad {
			c.log.Warn("ignoring a clipboard.watch with a field of the wrong type")

			return
		}
		c.watchOn.Store(m.On != nil && *m.On)
		c.signal()

		return
	}
	link := c.gen.Load()
	select {
	case c.q <- item{link, m}:
	default:
		if m.ID != nil {
			c.cfg.Send(link, rtcsock.ClipError(*m.ID, rtcsock.ClipInternal))
		}
	}
}

// ResetLink is for a new deskd connection, and returns the link that Send names for it. Call it before the
// connection's first message, and before Send can reach it. Watching goes back to off, and what the old one had
// under way ends without a reply. The clipboard's own text stays: it's what the member copied, and the desk still
// has it.
func (c *Clipboard) ResetLink() uint64 {
	c.watchOn.Store(false) // first, so a worker that sees the new link can't see the old one's watching
	link := c.gen.Add(1)
	c.signal()

	return link
}

// Close stops the worker and drops the connection, which takes the selection and the text with it.
func (c *Clipboard) Close() {
	c.once.Do(func() { close(c.stop) })
	if x := c.cur.Load(); x != nil {
		x.kill() // or a worker waiting on a stuck server would hold this up until the guard fires
	}
	<-c.done
}

func (c *Clipboard) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *Clipboard) killCurrent() {
	if x := c.cur.Load(); x != nil {
		c.log.Warn("the X server isn't answering: dropping the clipboard's connection")
		x.kill()
	}
}

func (c *Clipboard) run() {
	defer close(c.done)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	defer c.guard.Stop()
	defer func() {
		if c.x != nil {
			c.x.kill()
		}
	}()
	for {
		var events <-chan xgb.Event
		var sig, dead <-chan struct{}
		if x := c.x; x != nil {
			events, sig, dead = x.events, x.sig, x.dead
		}
		if at, ok := c.nextDeadline(); ok {
			timer.Reset(time.Until(at))
		} else {
			timer.Stop()
		}

		// The guard covers the handling, not the waiting, so what a handler can wait for is bounded. Every
		// handler starts from the current link, so an event never finishes what an old deskd started.
		select {
		case <-c.stop:
			return
		case it := <-c.q:
			c.begin()
			if it.gen == c.seenGen {
				c.onMessage(it.m)
			}
		case ev := <-events:
			c.begin()
			c.onEvent(ev)
		case <-sig:
			c.begin()
			c.onFlags()
		case <-dead:
			c.begin()
			c.lostConn()
		case <-c.wake:
			c.begin()
		case <-timer.C:
			c.begin()
			c.onDeadlines(time.Now())
		}
		c.settle()
		c.guard.Stop()
	}
}

// begin comes first in every handler.
func (c *Clipboard) begin() {
	c.guard.Reset(serverTimeout)
	c.sync()
}

// settle does what doesn't belong to any one event: a new link, watching changing, the next read.
func (c *Clipboard) settle() {
	c.sync()
	// Watching is what makes this dial with nothing asked of it, so changes are heard once X comes up.
	if c.watching && c.x == nil {
		c.conn()
	}
	c.startReads()
}

// sync catches up with ResetLink and clipboard.watch, in that order, since a reset turns watching off.
func (c *Clipboard) sync() {
	c.syncLink()
	if on := c.watchOn.Load(); on != c.watching {
		c.watching = on
		c.changedWait = false
	}
}

// syncLink has to run before a new link's first message, or the reset would throw that message away. The link
// can still change while a handler runs, which is why every reply names the link it's for.
func (c *Clipboard) syncLink() {
	if g := c.gen.Load(); g != c.seenGen {
		c.seenGen = g
		c.resetLink()
	}
}

// conn returns a live connection, or nil, and dials when it's allowed to.
func (c *Clipboard) conn() *xconn {
	if c.x != nil {
		select {
		case <-c.x.dead:
			c.lostConn()
		default:
			return c.x
		}
	}
	began := time.Now()
	if began.Before(c.nextDial) {
		return nil
	}
	x, err := dial(c.cfg.Display, c.log)
	now := time.Now()
	c.nextDial = now.Add(dialEvery)
	if err != nil {
		c.log.Debug("no X display yet", "err", err)
		// A server that accepted and then said nothing cost this goroutine the whole wait. If that's still
		// so, give what's queued a chance at a quick no_display before paying it again.
		if now.Sub(began) >= serverTimeout/2 {
			c.nextDial = now.Add(serverTimeout)
		}

		return nil
	}
	c.log.Info("connected to the X display")
	c.x = x
	c.cur.Store(x)
	c.guard.Reset(serverTimeout) // the dial used up some of it

	return x
}

// lostConn drops what went with the connection: the X server has forgotten the selection, so no text is kept.
func (c *Clipboard) lostConn() {
	if c.x == nil {
		return
	}
	c.log.Info("lost the X display")
	c.x.kill()
	c.x = nil
	c.cur.Store(nil)
	for _, s := range c.sets {
		clear(s.text)
		c.reply(rtcsock.ClipError(s.id, rtcsock.ClipNoDisplay))
	}
	c.sets = nil
	if r := c.read; r != nil {
		clear(r.buf)
		c.read = nil
		c.reply(rtcsock.ClipError(r.id, rtcsock.ClipNoDisplay))
	}
	for _, r := range c.readQ {
		c.reply(rtcsock.ClipError(r.id, rtcsock.ClipNoDisplay))
	}
	c.readQ = nil
	clear(c.serves)
	c.activeServes.Store(0)
	c.owned = false
	clear(c.text)
	c.text = nil
}

// resetLink abandons what the old deskd had under way. Nobody is left to tell.
func (c *Clipboard) resetLink() {
	c.dropAssembly()
	c.hasFailed = false
	for _, s := range c.sets {
		clear(s.text)
	}
	c.sets = nil
	if c.read != nil {
		c.abortRead()
	}
	c.readQ = nil
	c.changedWait = false
}

// send gives deskd a reply, for the link the worker has caught up with. Whatever the worker has under way belongs
// to that link, since a new one throws the rest away.
func (c *Clipboard) send(m *rtcsock.Message) bool { return c.cfg.Send(c.seenGen, m) }

func (c *Clipboard) reply(m *rtcsock.Message) { c.send(m) }

func (c *Clipboard) onMessage(m *rtcsock.Message) {
	if m.ID == nil {
		c.log.Warn("clipboard message without a good id", "t", m.T)

		return
	}
	if m.ClipBad {
		c.onBad(m)

		return
	}
	switch m.T {
	case rtcsock.MsgClipSet:
		c.onSetPart(m)
	case rtcsock.MsgClipGet:
		c.onGet(*m.ID, m.MaxBytes)
	}
}

// assembly is the one set being put together. A set that passes the limit keeps counting parts with no bytes, so
// the reply still comes on its last part.
type assembly struct {
	active bool
	id     uint64
	next   int
	buf    []byte
	over   bool
}

func (c *Clipboard) dropAssembly() {
	clear(c.asm.buf)
	c.asm = assembly{}
}

// onBad answers a message with a field of the wrong type with internal. A set it's part of ends, the way it does
// for a part out of order: once, and its later parts are ignored.
func (c *Clipboard) onBad(m *rtcsock.Message) {
	c.log.Warn("clipboard message with a field of the wrong type", "t", m.T)
	id := *m.ID
	switch m.T {
	case rtcsock.MsgClipSet:
		if m.Part != nil && *m.Part == 0 {
			// It starts a new set, as part 0 always does, and that set fails.
			c.dropAssembly()
			c.hasFailed = false
		} else if c.asm.active && c.asm.id == id {
			c.dropAssembly()
		}
		c.failSet(id)
	case rtcsock.MsgClipGet:
		c.reply(rtcsock.ClipError(id, rtcsock.ClipInternal))
	}
}

func (c *Clipboard) failSet(id uint64) {
	if c.hasFailed && c.failed == id {
		return
	}
	c.failed, c.hasFailed = id, true
	c.reply(rtcsock.ClipError(id, rtcsock.ClipInternal))
}

func (c *Clipboard) onSetPart(m *rtcsock.Message) {
	id, part := *m.ID, -1
	if m.Part != nil {
		part = *m.Part
	}
	a := &c.asm
	switch {
	case part == 0:
		// Whatever was unfinished, from this id or another, is replaced, and gets no reply: its last part
		// will never come.
		c.dropAssembly()
		c.hasFailed = false
		a.active, a.id = true, id
	case a.active && a.id == id && part == a.next:
	case a.active && a.id == id:
		c.dropAssembly()
		c.failSet(id)

		return
	default:
		c.failSet(id)

		return
	}
	a.next++
	if !a.over {
		if !c.appendPart(m.Data) {
			c.dropAssembly()
			c.failSet(id)

			return
		}
	}
	if m.Last == nil || !*m.Last {
		return
	}
	text, over := a.buf, a.over
	*a = assembly{}
	if over {
		c.reply(rtcsock.ClipError(id, rtcsock.ClipTooLarge))

		return
	}
	c.startSet(id, text)
}

// appendPart decodes one part into the assembly, and says false if it isn't base64.
func (c *Clipboard) appendPart(data string) bool {
	a := &c.asm
	if len(a.buf)+base64.StdEncoding.DecodedLen(len(data)) > hardLimit+3 {
		clear(a.buf)
		a.buf, a.over = nil, true

		return true
	}
	buf, err := base64.StdEncoding.AppendDecode(a.buf, []byte(data))
	if err != nil {
		return false
	}
	a.buf = buf
	if len(a.buf) > hardLimit {
		clear(a.buf)
		a.buf, a.over = nil, true
	}

	return true
}

// A set takes the selection in two steps: ask the X server for its time, by changing a property on our own
// window and reading the time off the PropertyNotify, then own the selection at that time. ICCCM says not to use
// CurrentTime for this, because the selection's timestamp is how late requests get refused.
type setOp struct {
	id       uint64
	text     []byte
	deadline time.Time
}

func (c *Clipboard) startSet(id uint64, text []byte) {
	x := c.conn()
	if x == nil {
		clear(text)
		c.reply(rtcsock.ClipError(id, rtcsock.ClipNoDisplay))

		return
	}
	if len(c.sets) >= maxPendingSets {
		clear(text)
		c.reply(rtcsock.ClipError(id, rtcsock.ClipInternal))

		return
	}
	c.sets = append(c.sets, &setOp{id: id, text: text, deadline: time.Now().Add(stepTimeout)})
	x.touchTime(x.win)
}

// touchTime makes the X server send a PropertyNotify for win, with its time, by writing nothing. It replaces rather
// than appends, as ICCCM's example does, because any client can write this property: an append to one left in
// another format is BadMatch, with no PropertyNotify, and every set after it would time out.
func (x *xconn) touchTime(win xproto.Window) {
	xproto.ChangeProperty(x.c, xproto.PropModeReplace, win, x.a.timeProp, x.a.timeProp, 8, 0, nil)
}

// onSetTime finishes the oldest set. ok goes out only after a round trip shows the X server has this window as
// owner, because the client sends its paste key on that reply.
func (c *Clipboard) onSetTime(x *xconn, at xproto.Timestamp) {
	if len(c.sets) == 0 {
		return
	}
	op := c.sets[0]
	c.sets = c.sets[1:]
	xproto.SetSelectionOwner(x.c, x.win, x.a.clipboard, at)
	r, err := xproto.GetSelectionOwner(x.c, x.a.clipboard).Reply()
	if err != nil || r == nil {
		clear(op.text)
		c.reply(rtcsock.ClipError(op.id, rtcsock.ClipNoDisplay))

		return
	}
	if r.Owner != x.win {
		// A later owner beat this one to it.
		clear(op.text)
		c.reply(rtcsock.ClipError(op.id, rtcsock.ClipInternal))

		return
	}
	// A transfer of the old text keeps its own reference and finishes on it.
	c.owned, c.text, c.selTime = true, op.text, at
	c.reply(rtcsock.ClipOK(op.id))
}

// onFlags handles the two things pump can't lose.
func (c *Clipboard) onFlags() {
	x := c.x
	if x == nil {
		return
	}
	if x.cleared.Swap(false) {
		c.onSelectionClear(x)
	}
	if x.changed.Swap(false) {
		c.onChanged(time.Now())
	}
}

// onSelectionClear goes by what the server says now. The event may be old, from before a set that has since taken
// the selection back, or a forgery through SendEvent, which xgb's decoding doesn't let us tell apart.
func (c *Clipboard) onSelectionClear(x *xconn) {
	if !c.owned {
		return
	}
	r, err := xproto.GetSelectionOwner(x.c, x.a.clipboard).Reply()
	if err != nil || r == nil || r.Owner == x.win {
		return
	}
	c.endAllServes(x)
	c.owned = false
	clear(c.text)
	c.text = nil
}

func (c *Clipboard) onChanged(now time.Time) {
	if !c.watching {
		return
	}
	if now.Sub(c.lastChanged) >= changedEvery {
		c.lastChanged = now
		c.reply(rtcsock.ClipChanged())

		return
	}
	c.changedDue, c.changedWait = c.lastChanged.Add(changedEvery), true
}

func (c *Clipboard) onEvent(ev xgb.Event) {
	x := c.x
	if x == nil {
		return
	}
	switch e := ev.(type) {
	case xproto.SelectionRequestEvent:
		c.onRequest(x, e)
	case xproto.PropertyNotifyEvent:
		switch {
		case e.Window == x.win:
			if e.Atom == x.a.timeProp && e.State == xproto.PropertyNewValue {
				c.onSetTime(x, e.Time)
			}
		case c.read != nil && e.Window == c.read.win:
			c.onReadProperty(x, e)
		default:
			c.onServeProperty(x, e)
		}
	case xproto.SelectionNotifyEvent:
		c.onReadNotify(x, e)
	case xproto.DestroyNotifyEvent:
		c.onRequestorGone(e.Window)
	}
}

// nextDeadline is the earliest time something here needs a look with no event to prompt it.
func (c *Clipboard) nextDeadline() (time.Time, bool) {
	var at time.Time
	take := func(t time.Time) {
		if at.IsZero() || t.Before(at) {
			at = t
		}
	}
	if len(c.sets) > 0 {
		take(c.sets[0].deadline)
	}
	if c.read != nil {
		take(c.read.step)
		take(c.read.overall)
	}
	for _, s := range c.serves {
		take(s.step)
		take(s.overall)
	}
	if c.changedWait {
		take(c.changedDue)
	}
	if c.watching && c.x == nil {
		take(c.nextDial)
	}

	return at, !at.IsZero()
}

func (c *Clipboard) onDeadlines(now time.Time) {
	for len(c.sets) > 0 && !c.sets[0].deadline.After(now) {
		op := c.sets[0]
		c.sets = c.sets[1:]
		clear(op.text)
		c.reply(rtcsock.ClipError(op.id, rtcsock.ClipTimeout))
	}
	if r := c.read; r != nil && (!r.step.After(now) || !r.overall.After(now)) {
		c.finishRead(readDone{code: rtcsock.ClipTimeout})
	}
	if x := c.x; x != nil {
		for k, s := range c.serves {
			if !s.step.After(now) || !s.overall.After(now) {
				c.endServe(x, k)
			}
		}
	}
	if c.changedWait && !c.changedDue.After(now) {
		c.changedWait = false
		c.lastChanged = now
		if c.watching {
			c.reply(rtcsock.ClipChanged())
		}
	}
}
