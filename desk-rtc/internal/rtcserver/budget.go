package rtcserver

import (
	"sync"
	"sync/atomic"
)

// A Guild Desk's memory budget (the review of guild mode, M1). Hundreds of sessions each hold a little of what members
// and deskd send, and per-session limits alone don't add up to MemoryMax: 600 sessions with every queue full would be
// gigabytes. So desk-rtc counts what it holds for all of a Guild Desk's sessions together, each way, and acts before
// the total can grow past a limit:
//   - client to deskd (rx): frames read from a session's channels and waiting in outQueue for rtc.sock. Past rxMax a
//     reader waits, so the client's bytes back up in SCTP (whose window is small on a Guild Desk) and then at the client.
//     A slow deskd slows members down; it doesn't grow desk-rtc.
//   - deskd to client (tx): frames waiting in a session's scheduler, and frames written to SCTP that the client hasn't
//     acknowledged yet. Past txSoft, a session holding more than txWithholdFloor gets no credit back until the total
//     falls, so deskd stops sending to the slowest members first. deskd may still use the credit it has, so past
//     txMax the session holding the most is closed (over_budget). A slow member loses their own session; the desk
//     keeps the rest.
// Every frame is charged its bytes plus frameOverhead, so a flood of tiny frames can't fit many times its bytes under a
// limit. Other desks have no budget: four sessions of the owner's own fit as they are.

const (
	// frameOverhead is what a frame costs beyond its bytes: our slice headers and allocation rounding, and Pion's
	// structures for one message while it waits in SCTP (about 300 bytes measured for a 1-byte message).
	frameOverhead = 256

	// The defaults, and why, are the README's "Guild mode", "Memory".
	defaultGuildRxBudget = 24 << 20
	defaultGuildTxSoft   = 48 << 20
	defaultGuildTxBudget = 96 << 20
	// txWithholdFloor: past txSoft, only a session holding more than this loses its grants, so one with a click's
	// response waiting is never held back behind members pulling large items.
	txWithholdFloor = 128 << 10
)

// frameCharge is what n bytes cost the budget.
func frameCharge(n int) int64 { return int64(n) + frameOverhead }

// guildBudget is one desk-rtc's budget for its Guild Desk sessions.
type guildBudget struct {
	mu     sync.Mutex
	rxCond *sync.Cond
	rx     int64
	rxMax  int64
	rxWait int // readers waiting for room
	tx     int64
	txSoft int64
	txMax  int64
	owed   map[*txSched]struct{} // sessions whose grants wait for tx to fall
	// rxPeak and txPeak are the most each side has held since desk-rtc started, for stats.
	rxPeak, txPeak int64

	rxWaits, txWithheld, shed atomic.Uint64
}

func newGuildBudget(rxMax, txSoft, txMax int64) *guildBudget {
	if rxMax <= 0 {
		rxMax = defaultGuildRxBudget
	}
	if txMax <= 0 {
		txMax = defaultGuildTxBudget
	}
	if txSoft <= 0 || txSoft > txMax {
		txSoft = txMax / 2
	}
	b := &guildBudget{rxMax: rxMax, txSoft: txSoft, txMax: txMax, owed: map[*txSched]struct{}{}}
	b.rxCond = sync.NewCond(&b.mu)

	return b
}

// acquireRx takes n for a frame on its way to deskd, waiting while the budget is full. It gives up, false, once gone
// says the session is closing; teardown wakes it (wakeRx). A frame on its own always fits, so nothing waits for ever
// on a frame larger than what's free.
func (b *guildBudget) acquireRx(n int64, gone func() bool) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.rx+n > b.rxMax && b.rx > 0 {
		b.rxWaits.Add(1)
	}
	for b.rx+n > b.rxMax && b.rx > 0 && !gone() {
		b.rxWait++
		b.rxCond.Wait()
		b.rxWait--
	}
	if gone() {
		return false
	}
	b.rx += n
	b.rxPeak = max(b.rxPeak, b.rx)

	return true
}

// releaseRx gives back n once a frame has left for rtc.sock, or was dropped. Waiting readers are woken when a quarter
// of the budget is free, not at every frame: with hundreds waiting, waking them all per frame would cost more than
// the frames.
func (b *guildBudget) releaseRx(n int64) {
	b.mu.Lock()
	b.rx -= n
	if b.rxWait > 0 && b.rx <= b.rxMax*3/4 {
		b.rxCond.Broadcast()
	}
	b.mu.Unlock()
}

// wakeRx wakes waiting readers so a closing session's ones can leave.
func (b *guildBudget) wakeRx() {
	b.mu.Lock()
	if b.rxWait > 0 {
		b.rxCond.Broadcast()
	}
	b.mu.Unlock()
}

// addTx charges n for a frame from deskd and says whether the total is now past txMax.
func (b *guildBudget) addTx(n int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tx += n
	b.txPeak = max(b.txPeak, b.tx)

	return b.tx > b.txMax
}

// subTx gives back n, and returns the sessions whose withheld grants may go now that the total is well under txSoft.
// The caller flushes them with no lock held.
func (b *guildBudget) subTx(n int64) []*txSched {
	if n == 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tx -= n
	if len(b.owed) == 0 || b.tx > b.txSoft*3/4 {
		return nil
	}
	out := make([]*txSched, 0, len(b.owed))
	for t := range b.owed {
		out = append(out, t)
	}
	clear(b.owed)

	return out
}

func (b *guildBudget) overSoft() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.tx > b.txSoft
}

func (b *guildBudget) overMax() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.tx > b.txMax
}

// owe records that t holds back grants.
func (b *guildBudget) owe(t *txSched) {
	b.mu.Lock()
	b.owed[t] = struct{}{}
	b.mu.Unlock()
}

// forgive drops t from the sessions owed grants: it's closing, or flushing on its own.
func (b *guildBudget) forgive(t *txSched) {
	b.mu.Lock()
	delete(b.owed, t)
	b.mu.Unlock()
}

// usage is the budget's state for stats.
func (b *guildBudget) usage() (rx, tx int64) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.rx, b.tx
}

// peaks are the most each side has held since desk-rtc started.
func (b *guildBudget) peaks() (rx, tx int64) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.rxPeak, b.txPeak
}

// flushAll lets each session's withheld grants go.
func flushAll(ts []*txSched) {
	for _, t := range ts {
		t.flushOwed()
	}
}
