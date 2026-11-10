package rtcserver

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// Send queue limits of design 4.2.6.
const (
	sctpHighWater = 64 * 1024
	sctpLowWater  = 32 * 1024

	// bulkCapWhileViewing is design 4.2.6's "about 2 Mbps", in bytes per second.
	bulkCapWhileViewing = 250_000
	// bulkBurst is the token bucket's depth: two full frames.
	bulkBurst = 32 * 1024
	// ackPoll is how often a Guild Desk session with frames in flight checks what the client has acknowledged, when
	// nothing else wakes its scheduler, so the budget learns of it (budget.go).
	ackPoll = 100 * time.Millisecond
)

// sink is where the scheduler writes one channel's frames: an open data channel, or a fake in tests.
type sink interface {
	Write(frame []byte) (int, error)
	BufferedAmount() uint64
}

var (
	errCreditViolation = errors.New("deskd sent more than its credit")
	// errOverBudget: the frame is queued, and the Guild Desk's budget is past txMax, so the caller sheds a session.
	errOverBudget = errors.New("the Guild Desk's budget is full")
)

type txChan struct {
	id        uint8
	sink      sink
	queue     [][]byte
	credit    int64 // what deskd may still send, as desk-rtc counts it
	ungranted int64 // drained, not yet granted back
	// flight is a Guild Desk session's frames written to SCTP and not yet acknowledged, oldest first, by length, and
	// flightBytes their sum. The budget charges them until the client acknowledges them (budget.go).
	flight      []int
	flightBytes int64
}

// txSched is one session's desk-to-client scheduler (design 4.2.6). Frames wait here until the
// highest-priority channel that has any also has room in SCTP's send queue, which it keeps at
// 64 KiB per channel, so a large download adds at most about 64 KiB ahead of a click's response.
//
// While the session views, bulk is also held to bulkCapWhileViewing (design 4.2.6), because video has
// to share the link with it and video is what the member is watching.
type txSched struct {
	mu        sync.Mutex
	chans     [rtcsock.NumBridged]*txChan
	bulkRate  float64 // bytes per second, 0 for no cap
	tokens    float64
	refilled  time.Time
	retryIn   time.Duration // set by next when only the cap holds bulk back
	wake      chan struct{}
	stopped   chan struct{}
	stopOnce  sync.Once
	onDrained func(channel uint8, n uint32)

	// budget is a Guild Desk session's (budget.go): nil on every other desk, and once the session is shed or stops.
	// charged is this session's part of budget.tx, and owed says it holds back grants until the total falls.
	budget  *guildBudget
	charged atomic.Int64
	owed    bool
}

// useBudget makes this a Guild Desk session's scheduler, with deskd's credit per channel. Call before run.
func (t *txSched) useBudget(b *guildBudget, credit int64) {
	t.mu.Lock()
	t.budget = b
	for _, c := range t.chans {
		c.credit = credit
	}
	t.mu.Unlock()
}

func newTxSched(onDrained func(channel uint8, n uint32)) *txSched {
	t := &txSched{
		wake:      make(chan struct{}, 1),
		stopped:   make(chan struct{}),
		onDrained: onDrained,
	}
	for i := range t.chans {
		t.chans[i] = &txChan{id: uint8(i), credit: rtcsock.InitialCredit}
	}

	return t
}

func (t *txSched) notify() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (t *txSched) stop() {
	t.stopOnce.Do(func() { close(t.stopped) })
	t.dropBudget()
}

// dropBudget gives back everything this session is charged for, and stops charging it: at stop, or when the budget
// sheds it. Withheld grants it was owed no longer matter.
func (t *txSched) dropBudget() bool {
	t.mu.Lock()
	b := t.budget
	t.budget = nil
	n := t.charged.Swap(0)
	owed := t.owed
	t.owed = false
	t.mu.Unlock()
	if b == nil {
		return false
	}
	if owed {
		b.forgive(t)
	}
	flushAll(b.subTx(n))

	return true
}

// setSink marks a channel open. Frames queued before that start flowing now.
func (t *txSched) setSink(channel uint8, s sink) {
	t.mu.Lock()
	t.chans[channel].sink = s
	t.mu.Unlock()
	t.notify()
}

// enqueue takes ownership of frame. It never blocks, so the socket reader never waits on one
// session or channel; credit is what bounds the queue.
func (t *txSched) enqueue(channel uint8, frame []byte) error {
	t.mu.Lock()
	c := t.chans[channel]
	if int64(len(frame)) > c.credit {
		t.mu.Unlock()

		return errCreditViolation
	}
	c.credit -= int64(len(frame))
	c.queue = append(c.queue, frame)
	over := false
	if t.budget != nil {
		n := frameCharge(len(frame))
		t.charged.Add(n)
		over = t.budget.addTx(n)
	}
	t.mu.Unlock()
	t.notify()
	if over {
		return errOverBudget
	}

	return nil
}

// setBulkCap sets bulk's rate in bytes per second, 0 for none.
func (t *txSched) setBulkCap(rate float64) {
	t.mu.Lock()
	if t.bulkRate != rate {
		t.bulkRate = rate
		t.tokens = bulkBurst
		t.refilled = time.Now()
	}
	t.mu.Unlock()
	t.notify()
}

// bulkAllowed refills the bucket and says whether a frame of n bytes may go. Caller holds mu.
func (t *txSched) bulkAllowed(n int) bool {
	now := time.Now()
	t.tokens += now.Sub(t.refilled).Seconds() * t.bulkRate
	t.refilled = now
	if t.tokens > bulkBurst {
		t.tokens = bulkBurst
	}
	if t.tokens < float64(n) {
		t.retryIn = time.Duration((float64(n) - t.tokens) / t.bulkRate * float64(time.Second))

		return false
	}
	t.tokens -= float64(n)

	return true
}

// next pops the frame to send now, or returns nil when nothing may go. On a Guild Desk it also returns the sessions
// whose withheld grants may go, now that acknowledged frames left the budget; the caller flushes them.
func (t *txSched) next() (*txChan, []byte, []*txSched) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.retryIn = 0
	var flush []*txSched
	if t.budget != nil {
		flush = t.ackedLocked()
	}
	for _, id := range rtcsock.SendPriority {
		c := t.chans[id]
		if c.sink == nil || len(c.queue) == 0 {
			continue
		}
		frame := c.queue[0]
		if c.sink.BufferedAmount()+uint64(len(frame)) > sctpHighWater {
			continue
		}
		if id == rtcsock.ChBulk && t.bulkRate > 0 && !t.bulkAllowed(len(frame)) {
			continue
		}
		c.queue[0] = nil
		c.queue = c.queue[1:]

		return c, frame, flush
	}

	return nil, nil, flush
}

// ackedLocked lets go of the frames the client has acknowledged: SCTP's BufferedAmount counts a channel's bytes until
// they are, so whatever of the flight is past it has gone, oldest first. Caller holds mu, and t.budget is set.
func (t *txSched) ackedLocked() []*txSched {
	var freed int64
	for _, c := range t.chans {
		if len(c.flight) == 0 || c.sink == nil {
			continue
		}
		left := int64(c.sink.BufferedAmount())
		for c.flightBytes > left && len(c.flight) > 0 {
			n := c.flight[0]
			c.flight = c.flight[1:]
			c.flightBytes -= int64(n)
			freed += frameCharge(n)
		}
		if len(c.flight) == 0 {
			c.flight = nil // let the backing array go
		}
	}
	if freed == 0 {
		return nil
	}
	t.charged.Add(-freed)
	flush := t.budget.subTx(freed)
	if t.owed && t.charged.Load() <= txWithholdFloor {
		// Its own backlog has gone: its grants needn't wait for the desk's.
		t.budget.forgive(t)
		flush = append(flush, t)
	}

	return flush
}

// inFlightLocked says whether a Guild Desk session has frames the client hasn't acknowledged. Caller holds mu.
func (t *txSched) inFlightLocked() bool {
	if t.budget == nil {
		return false
	}
	for _, c := range t.chans {
		if len(c.flight) > 0 {
			return true
		}
	}

	return false
}

// run sends until stop. onErr hears about a write failure once per failed frame.
func (t *txSched) run(onErr func(channel uint8, err error)) {
	for {
		c, frame, flush := t.next()
		flushAll(flush)
		if c == nil {
			var refill <-chan time.Time
			t.mu.Lock()
			switch {
			case t.retryIn > 0:
				refill = time.After(t.retryIn)
			case t.inFlightLocked():
				refill = time.After(ackPoll)
			}
			t.mu.Unlock()
			select {
			case <-t.wake:
				continue
			case <-refill:
				continue
			case <-t.stopped:
				return
			}
		}
		select {
		case <-t.stopped:
			return
		default:
		}
		_, err := c.sink.Write(frame)
		if err != nil {
			onErr(c.id, err)
		}
		t.drained(c, len(frame), err == nil)
	}
}

// drained grants deskd credit back for a frame that has left the queue. On a Guild Desk the frame stays charged until
// the client acknowledges it, and past the budget's txSoft a session holding a lot keeps its grants until it falls.
func (t *txSched) drained(c *txChan, n int, written bool) {
	t.mu.Lock()
	var flush []*txSched
	if t.budget != nil {
		if written {
			c.flight = append(c.flight, n)
			c.flightBytes += int64(n)
		} else {
			t.charged.Add(-frameCharge(n))
			flush = t.budget.subTx(frameCharge(n))
		}
	}
	c.ungranted += int64(n)
	var grant int64
	if c.ungranted >= rtcsock.CreditGrantStep {
		if t.budget != nil && t.charged.Load() > txWithholdFloor && t.budget.overSoft() {
			if !t.owed {
				t.owed = true
				t.budget.owe(t)
			}
			t.budget.txWithheld.Add(1)
		} else {
			grant = c.ungranted
			c.ungranted = 0
			c.credit += grant
		}
	}
	t.mu.Unlock()
	flushAll(flush)
	if grant > 0 {
		t.onDrained(c.id, uint32(grant))
	}
}

// flushOwed lets go the grants a Guild Desk session held back past txSoft.
func (t *txSched) flushOwed() {
	var grants [rtcsock.NumBridged]int64
	t.mu.Lock()
	t.owed = false
	for i, c := range t.chans {
		if c.ungranted >= rtcsock.CreditGrantStep {
			grants[i] = c.ungranted
			c.credit += c.ungranted
			c.ungranted = 0
		}
	}
	t.mu.Unlock()
	select {
	case <-t.stopped:
		return // the session is gone: deskd no longer counts its credit
	default:
	}
	for i, g := range grants {
		if g > 0 {
			t.onDrained(uint8(i), uint32(g))
		}
	}
}

// flushCtl waits for ctl to drain and be acknowledged, so a CLOSE deskd sent just before
// session.close reaches the client. It gives up after timeout.
func (t *txSched) flushCtl(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		t.mu.Lock()
		c := t.chans[rtcsock.ChCtl]
		empty := len(c.queue) == 0
		idle := c.sink == nil || c.sink.BufferedAmount() == 0
		t.mu.Unlock()
		if empty && idle {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// creditGate is desk-rtc's budget for sending one channel's client frames to deskd. Waiting here
// stops that channel's reader, so the client's bytes back up in SCTP and in the end at the client.
type creditGate struct {
	mu     sync.Mutex
	cond   *sync.Cond
	n      int64
	closed bool
}

func newCreditGate() *creditGate {
	g := &creditGate{n: rtcsock.InitialCredit}
	g.cond = sync.NewCond(&g.mu)

	return g
}

func (g *creditGate) acquire(n int) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for g.n < int64(n) && !g.closed {
		g.cond.Wait()
	}
	if g.closed {
		return false
	}
	g.n -= int64(n)

	return true
}

func (g *creditGate) grant(n uint32) {
	g.mu.Lock()
	g.n += int64(n)
	g.cond.Broadcast()
	g.mu.Unlock()
}

func (g *creditGate) close() {
	g.mu.Lock()
	g.closed = true
	g.cond.Broadcast()
	g.mu.Unlock()
}

// clipShare is the most session data that goes ahead of a clipboard message that's waiting. Sessions come
// first, but a steady upload can't hold a paste up for ever: past this, one clipboard message goes, at most 64 KiB.
const clipShare = 256 * 1024

// outQueue is the strict-priority writer of the shared socket: JSON and CREDIT first, then DATA by
// channel priority across all sessions, then the clipboard's replies, up to 2 MiB of text as base64, which would
// otherwise hold every session up behind them.
type outQueue struct {
	mu   sync.Mutex
	cond *sync.Cond
	ctrl [][]byte
	data [rtcsock.NumBridged][]outData
	clip [][]byte
	// clipBytes is what's waiting in clip, and dataAhead the session data that has gone ahead of its first.
	clipBytes int
	dataAhead int
	closed    bool
}

// outData is one session's DATA envelope for deskd, and the Guild Desk budget it's charged to, if any (budget.go).
type outData struct {
	b      []byte
	budget *guildBudget
}

func newOutQueue() *outQueue {
	q := &outQueue{}
	q.cond = sync.NewCond(&q.mu)

	return q
}

func (q *outQueue) pushCtrl(b []byte) {
	q.mu.Lock()
	if !q.closed {
		q.ctrl = append(q.ctrl, b)
		q.cond.Signal()
	}
	q.mu.Unlock()
}

// pushClip queues one of the clipboard's messages.
func (q *outQueue) pushClip(b []byte) {
	q.mu.Lock()
	if !q.closed {
		q.clip = append(q.clip, b)
		q.clipBytes += len(b)
		q.cond.Signal()
	}
	q.mu.Unlock()
}

// clipBacklog is how many bytes of the clipboard's are waiting for the socket.
func (q *outQueue) clipBacklog() int {
	q.mu.Lock()
	defer q.mu.Unlock()

	return q.clipBytes
}

func (q *outQueue) pushData(channel uint8, b []byte) { q.pushCharged(channel, b, nil) }

// pushCharged queues a DATA envelope that budget has been charged frameCharge(len(b)) for; the charge is given back
// when it leaves for rtc.sock, or the queue closes.
func (q *outQueue) pushCharged(channel uint8, b []byte, budget *guildBudget) {
	q.mu.Lock()
	if !q.closed {
		q.data[channel] = append(q.data[channel], outData{b: b, budget: budget})
		q.cond.Signal()
		q.mu.Unlock()

		return
	}
	q.mu.Unlock()
	if budget != nil {
		budget.releaseRx(frameCharge(len(b)))
	}
}

func (q *outQueue) next() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for {
		if q.closed {
			return nil, false
		}
		if len(q.ctrl) > 0 {
			b := q.ctrl[0]
			q.ctrl[0] = nil
			q.ctrl = q.ctrl[1:]

			return b, true
		}
		if len(q.clip) == 0 || q.dataAhead < clipShare {
			for _, id := range rtcsock.SendPriority {
				if len(q.data[id]) > 0 {
					e := q.data[id][0]
					q.data[id][0] = outData{}
					q.data[id] = q.data[id][1:]
					if len(q.clip) > 0 {
						q.dataAhead += len(e.b)
					}
					if e.budget != nil {
						e.budget.releaseRx(frameCharge(len(e.b)))
					}

					return e.b, true
				}
			}
		}
		if len(q.clip) > 0 {
			b := q.clip[0]
			q.clip[0] = nil
			q.clip = q.clip[1:]
			q.clipBytes -= len(b)
			q.dataAhead = 0

			return b, true
		}
		q.cond.Wait()
	}
}

func (q *outQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	var left []outData
	for id := range q.data {
		left = append(left, q.data[id]...)
		q.data[id] = nil
	}
	q.mu.Unlock()
	for _, e := range left {
		if e.budget != nil {
			e.budget.releaseRx(frameCharge(len(e.b)))
		}
	}
}
