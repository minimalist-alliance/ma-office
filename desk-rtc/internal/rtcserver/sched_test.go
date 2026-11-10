package rtcserver

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// fakeSink records writes and lets a test control how full SCTP looks.
type fakeSink struct {
	mu       sync.Mutex
	channel  uint8
	buffered uint64
	log      *[]uint8
	logMu    *sync.Mutex
}

func (f *fakeSink) Write(b []byte) (int, error) {
	f.mu.Lock()
	f.buffered += uint64(len(b))
	f.mu.Unlock()
	f.logMu.Lock()
	*f.log = append(*f.log, f.channel)
	f.logMu.Unlock()

	return len(b), nil
}

func (f *fakeSink) BufferedAmount() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.buffered
}

func (f *fakeSink) drain() {
	f.mu.Lock()
	f.buffered = 0
	f.mu.Unlock()
}

type schedFixture struct {
	t     *testing.T
	sched *txSched
	sinks [rtcsock.NumBridged]*fakeSink
	log   []uint8
	logMu sync.Mutex

	grantMu sync.Mutex
	grants  map[uint8]uint32
}

func newFixture(t *testing.T) *schedFixture {
	t.Helper()
	f := &schedFixture{t: t, grants: map[uint8]uint32{}}
	f.sched = newTxSched(func(channel uint8, n uint32) {
		f.grantMu.Lock()
		f.grants[channel] += n
		f.grantMu.Unlock()
	})
	for i := range f.sinks {
		f.sinks[i] = &fakeSink{channel: uint8(i), log: &f.log, logMu: &f.logMu}
		f.sched.setSink(uint8(i), f.sinks[i])
	}

	return f
}

func (f *schedFixture) written() []uint8 {
	f.logMu.Lock()
	defer f.logMu.Unlock()

	return append([]uint8(nil), f.log...)
}

// drainOnce pops frames without the run goroutine, so order is exact.
func (f *schedFixture) drainOnce() {
	for {
		c, frame, _ := f.sched.next()
		if c == nil {
			return
		}
		if _, err := c.sink.Write(frame); err != nil {
			f.t.Fatal(err)
		}
		f.sched.drained(c, len(frame), true)
	}
}

func TestStrictPriorityOrder(t *testing.T) {
	f := newFixture(t)
	frame := make([]byte, 1000)
	// Queue in reverse priority, so FIFO would give the wrong answer.
	for _, ch := range []uint8{rtcsock.ChBulk, rtcsock.ChCollab, rtcsock.ChEvents, rtcsock.ChMdoc, rtcsock.ChRPC, rtcsock.ChCtl} {
		if err := f.sched.enqueue(ch, frame); err != nil {
			t.Fatal(err)
		}
	}
	f.drainOnce()
	want := []uint8{rtcsock.ChCtl, rtcsock.ChRPC, rtcsock.ChMdoc, rtcsock.ChEvents, rtcsock.ChCollab, rtcsock.ChBulk}
	got := f.written()
	if len(got) != len(want) {
		t.Fatalf("wrote %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order %v, want %v", got, want)
		}
	}
}

func TestHighPriorityPassesAFullBulkQueue(t *testing.T) {
	f := newFixture(t)
	frame := make([]byte, 16*1024)
	for i := 0; i < 8; i++ {
		if err := f.sched.enqueue(rtcsock.ChBulk, frame); err != nil {
			t.Fatal(err)
		}
	}
	f.drainOnce()
	if got := f.sinks[rtcsock.ChBulk].BufferedAmount(); got > sctpHighWater {
		t.Fatalf("bulk has %d bytes queued in SCTP, limit %d", got, sctpHighWater)
	}
	if n := len(f.written()); n != 4 {
		t.Fatalf("bulk wrote %d frames, want 4 (64 KiB of 16 KiB)", n)
	}

	// bulk is stuck at its limit with more waiting. ctl still goes out.
	if err := f.sched.enqueue(rtcsock.ChCtl, make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	f.drainOnce()
	got := f.written()
	if got[len(got)-1] != rtcsock.ChCtl {
		t.Fatalf("ctl didn't go out: %v", got)
	}

	// Once SCTP drains, bulk resumes.
	f.sinks[rtcsock.ChBulk].drain()
	f.drainOnce()
	if n := len(f.written()); n != 9 {
		t.Fatalf("after drain %d writes, want 9", n)
	}
}

func TestNothingFlowsBeforeTheChannelOpens(t *testing.T) {
	f := newFixture(t)
	f.sched.setSink(rtcsock.ChRPC, nil)
	if err := f.sched.enqueue(rtcsock.ChRPC, make([]byte, 10)); err != nil {
		t.Fatal(err)
	}
	f.drainOnce()
	if len(f.written()) != 0 {
		t.Fatal("wrote to a closed channel")
	}
	f.sched.setSink(rtcsock.ChRPC, f.sinks[rtcsock.ChRPC])
	f.drainOnce()
	if len(f.written()) != 1 {
		t.Fatal("queued frame didn't flow after open")
	}
}

func TestCreditIsEnforcedAndGrantedBack(t *testing.T) {
	f := newFixture(t)
	frame := make([]byte, 16*1024)
	// The window takes exactly 16 frames of 16 KiB.
	for i := 0; i < rtcsock.InitialCredit/len(frame); i++ {
		if err := f.sched.enqueue(rtcsock.ChBulk, frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	if err := f.sched.enqueue(rtcsock.ChBulk, []byte{1}); !errors.Is(err, errCreditViolation) {
		t.Fatalf("want a credit violation, got %v", err)
	}

	f.drainOnce()
	f.grantMu.Lock()
	granted := f.grants[rtcsock.ChBulk]
	f.grantMu.Unlock()
	// Four frames fit SCTP, and grants come in steps of at least 32 KiB.
	if granted != 64*1024 {
		t.Fatalf("granted %d, want 65536", granted)
	}
	if err := f.sched.enqueue(rtcsock.ChBulk, frame); err != nil {
		t.Fatalf("grant didn't reopen the window: %v", err)
	}
}

func TestRunStopsAndWakes(t *testing.T) {
	f := newFixture(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.sched.run(func(uint8, error) {})
	}()
	if err := f.sched.enqueue(rtcsock.ChCtl, make([]byte, 10)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(f.written()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("run didn't wake on enqueue")
		}
		time.Sleep(time.Millisecond)
	}
	f.sched.stop()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run didn't stop")
	}
}

func TestOutQueuePriority(t *testing.T) {
	q := newOutQueue()
	q.pushData(rtcsock.ChBulk, []byte("bulk"))
	q.pushData(rtcsock.ChEvents, []byte("events"))
	q.pushData(rtcsock.ChCtl, []byte("ctl"))
	q.pushCtrl([]byte("json"))
	for _, want := range []string{"json", "ctl", "events", "bulk"} {
		b, ok := q.next()
		if !ok || string(b) != want {
			t.Fatalf("got %q, want %q", b, want)
		}
	}
	q.close()
	if _, ok := q.next(); ok {
		t.Fatal("next after close")
	}
}

func TestCreditGate(t *testing.T) {
	g := newCreditGate()
	if !g.acquire(rtcsock.InitialCredit) {
		t.Fatal("initial window refused")
	}
	got := make(chan bool, 1)
	go func() { got <- g.acquire(10) }()
	select {
	case <-got:
		t.Fatal("acquire should wait with no credit")
	case <-time.After(50 * time.Millisecond):
	}
	g.grant(10)
	if !<-got {
		t.Fatal("grant should release acquire")
	}
	go func() { got <- g.acquire(10) }()
	g.close()
	if <-got {
		t.Fatal("close should fail a waiter")
	}
}

func TestBulkCapHoldsOnlyBulk(t *testing.T) {
	f := newFixture(t)
	f.sched.setBulkCap(100_000)
	frame := make([]byte, 16*1024)
	// The bucket starts with two frames' worth. The third has to wait, and ctl behind it doesn't.
	for range 3 {
		if err := f.sched.enqueue(rtcsock.ChBulk, frame); err != nil {
			t.Fatal(err)
		}
	}
	f.drainOnce()
	if got := f.written(); len(got) != 2 {
		t.Fatalf("wrote %v before the cap held", got)
	}
	if f.sched.retryIn <= 0 {
		t.Fatal("the scheduler has no time to retry at")
	}
	if err := f.sched.enqueue(rtcsock.ChCtl, make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	f.drainOnce()
	if got := f.written(); len(got) != 3 || got[2] != rtcsock.ChCtl {
		t.Fatalf("ctl was held up: %v", got)
	}
	// Taking the cap off lets it go at once.
	f.sched.setBulkCap(0)
	f.drainOnce()
	if got := f.written(); len(got) != 4 || got[3] != rtcsock.ChBulk {
		t.Fatalf("after the cap: %v", got)
	}
}

func TestBulkCapRate(t *testing.T) {
	sched := newTxSched(func(uint8, uint32) {})
	sink := &countingSink{}
	sched.setSink(rtcsock.ChBulk, sink)
	go sched.run(func(uint8, error) {})
	defer sched.stop()
	sched.setBulkCap(320_000) // 16 KiB frame per 50 ms, after the burst
	frame := make([]byte, 16*1024)
	start := time.Now()
	for range 6 {
		if err := sched.enqueue(rtcsock.ChBulk, frame); err != nil {
			t.Fatal(err)
		}
	}
	for {
		n := sink.n.Load()
		if n == 6 {
			break
		}
		if time.Since(start) > 3*time.Second {
			t.Fatalf("only %d frames in 3 s", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Two frames of burst, then four at 51 ms each.
	if d := time.Since(start); d < 180*time.Millisecond {
		t.Fatalf("6 frames took %v: the cap isn't holding", d)
	}
}

// countingSink always has room, so only the cap can hold frames back.
type countingSink struct{ n atomic.Int32 }

func (c *countingSink) Write(frame []byte) (int, error) { c.n.Add(1); return len(frame), nil }
func (c *countingSink) BufferedAmount() uint64          { return 0 }
