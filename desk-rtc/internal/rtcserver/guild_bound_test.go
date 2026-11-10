package rtcserver

import (
	"context"
	"os"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// The review of guild mode (H1, M1, M2, L4): what a member's client, a slow member or a slow deskd can make desk-rtc
// hold, and the final bytes of a closed session.

// heapInUse is the Go heap after a full collection, in bytes.
func heapInUse() uint64 {
	runtime.GC()
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	return ms.HeapInuse
}

// floodCount is how many 1-byte messages the hostile client sends: GUILD_FLOOD, or 300,000 (60,000 under the race
// detector, which is ten times slower). The review measured +92 MiB at 300,000 before the fix.
func floodCount() int {
	if n, err := strconv.Atoi(os.Getenv("GUILD_FLOOD")); err == nil && n > 0 {
		return n
	}
	if raceEnabled {
		return 60_000
	}

	return 300_000
}

// flood sends n 1-byte messages on dc, never more than 256 KiB ahead of SCTP, so the client's own memory stays small
// and what grows is desk-rtc's.
func flood(t *testing.T, dc *webrtc.DataChannel, n int) {
	t.Helper()
	msg := []byte{0x42}
	for i := 0; i < n; i++ {
		for dc.BufferedAmount() > 256*1024 {
			if dc.ReadyState() != webrtc.DataChannelStateOpen {
				return
			}
			time.Sleep(time.Millisecond)
		}
		if err := dc.Send(msg); err != nil {
			return // the desk closed the session
		}
	}
}

// H1: a member's client floods keys and input, which a Guild Desk has no screen for. desk-rtc reads and drops it all,
// so its heap stays flat, and the session stays open. Before the fix: +92 MiB at 300,000 messages, +1.3 GiB when the
// window shut.
func TestGuildHostileClientOnKeysStaysBounded(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	p, _ := guildConnected(t, d, "cs-x", "gm-x", peerOpts{dataOnly: true})
	n := floodCount()
	base := heapInUse()
	began := time.Now()
	flood(t, p.channels[rtcsock.ChKeys], n)
	flood(t, p.channels[rtcsock.ChInput], n/10)
	deadline := time.Now().Add(60 * time.Second)
	var row rtcsock.SessionStats
	for {
		m := d.stats()
		if len(m.Sessions) != 1 {
			t.Fatalf("sessions %+v", m.Sessions)
		}
		row = m.Sessions[0]
		// input is unordered with no retransmits, so some may be lost on the way; keys is reliable.
		if row.KeysDropped == uint64(n) && row.InputDropped > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("desk-rtc read %d of %d on keys", row.KeysDropped, n)
		}
		time.Sleep(100 * time.Millisecond)
	}
	grew := int64(heapInUse()) - int64(base)
	t.Logf("%d messages on keys and %d on input in %v: heap %+.1f MiB", n, row.InputDropped, time.Since(began).Round(time.Millisecond), float64(grew)/(1<<20))
	if grew > 16<<20 {
		t.Fatalf("the heap grew %.1f MiB", float64(grew)/(1<<20))
	}
	if p.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("the session ended: %s", p.pc.ConnectionState())
	}
}

// H1: data on a stream that's none of the eight channels ends that member's session, protocol_error, so it can't
// park there; other members' sessions carry on.
func TestGuildUnknownStreamEndsTheSession(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	other, otherAns := guildConnected(t, d, "cs-ok", "gm-ok", peerOpts{dataOnly: true})
	p, _ := guildConnected(t, d, "cs-x", "gm-x", peerOpts{dataOnly: true})
	negotiated, id := true, uint16(20)
	dc, err := p.pc.CreateDataChannel("not-ours", &webrtc.DataChannelInit{Negotiated: &negotiated, ID: &id})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	<-opened
	go flood(t, dc, 100_000)
	if m := d.expect("session.closed", "cs-x", 10*time.Second); m.Reason != reasonProtocolError {
		t.Fatalf("reason %q", m.Reason)
	}
	if err := other.channels[rtcsock.ChCtl].Send([]byte("still here")); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case got := <-d.frames:
			if got.handle == otherAns.Handle {
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the other member's session stopped")
		}
	}
}

// deskdNoGrant is a deskd that reads every frame and never grants credit back: a deskd that has stopped draining.
func (f *fixture) deskdNoGrant(got *atomic.Int64) *fakeDeskd {
	f.t.Helper()
	c, err := rtcsock.Dial(context.Background(), f.sock)
	if err != nil {
		f.t.Fatal(err)
	}
	d := &fakeDeskd{t: f.t, c: c, msgs: make(chan *rtcsock.Message, 256), frames: make(chan dataFrame, 256), ended: make(chan error, 1)}
	go func() {
		d.ended <- c.Run(func(m *rtcsock.Message) { d.msgs <- m }, func(uint32, uint8, []byte) { got.Add(1) })
	}()
	f.t.Cleanup(func() { _ = c.Close() })

	return d
}

// H1: with deskd granting nothing, the reader of a channel stops at its credit, and the client's 1-byte messages pile
// up in SCTP. Pion's window counts only their bytes; the cap on each stream's chunks ends the session long before
// they cost much.
func TestGuildStalledChannelIsCappedInSCTP(t *testing.T) {
	f := startServer(t, 30*time.Second)
	var forwarded atomic.Int64
	d := f.deskdNoGrant(&forwarded)
	d.configureGuild(0, 0)
	p, _ := guildConnected(t, d, "cs-x", "gm-x", peerOpts{dataOnly: true})
	base := heapInUse()
	go flood(t, p.channels[rtcsock.ChCollab], guildRxCredit+100_000)
	m := d.expect("session.closed", "cs-x", 60*time.Second)
	grew := int64(heapInUse()) - int64(base)
	t.Logf("closed %q after %d frames reached deskd; heap %+.1f MiB", m.Reason, forwarded.Load(), float64(grew)/(1<<20))
	// Each frame is 1 byte of the channel's 128 KiB credit: the reader stops there at the latest, and SCTP's cap on the
	// stream's chunks ends the session. (A reader that falls behind the flood ends it sooner.)
	if m.Reason != reasonProtocolError || forwarded.Load() > guildRxCredit {
		t.Fatalf("closed %q after %d frames, want protocol_error after at most %d", m.Reason, forwarded.Load(), guildRxCredit)
	}
	if grew > 32<<20 {
		t.Fatalf("the heap grew %.1f MiB", float64(grew)/(1<<20))
	}
}

// M1: the budget's client-to-deskd side makes readers wait while it's full, and wakes them when a quarter is free.
func TestGuildBudgetRxWaitsAndWakes(t *testing.T) {
	b := newGuildBudget(1000, 0, 0)
	never := func() bool { return false }
	if !b.acquireRx(600, never) {
		t.Fatal("first")
	}
	got := make(chan bool, 1)
	go func() { got <- b.acquireRx(600, never) }()
	select {
	case <-got:
		t.Fatal("didn't wait")
	case <-time.After(100 * time.Millisecond):
	}
	b.releaseRx(600)
	if ok := <-got; !ok {
		t.Fatal("woke with false")
	}
	// A closing session's reader gives up.
	var gone atomic.Bool
	go func() { got <- b.acquireRx(600, gone.Load) }()
	time.Sleep(50 * time.Millisecond)
	gone.Store(true)
	b.wakeRx()
	if ok := <-got; ok {
		t.Fatal("a closing session's reader took room")
	}
	if rx, _ := b.usage(); rx != 600 {
		t.Fatalf("rx %d", rx)
	}
	// A frame on its own always fits.
	b.releaseRx(600)
	if !b.acquireRx(5000, never) {
		t.Fatal("a frame larger than the budget waited for ever")
	}
}

// M1: past txSoft, a session holding a lot gets no credit back, and gets it once the client's acknowledgements bring
// the desk's total down.
func TestGuildBudgetWithholdsGrantsPastSoft(t *testing.T) {
	f := newFixture(t)
	b := newGuildBudget(0, 100*1024, 10<<20)
	f.sched.useBudget(b, rtcsock.InitialCredit)
	frameBytes := make([]byte, 16*1024)
	for i := 0; i < 12; i++ { // 192 KiB on bulk
		if err := f.sched.enqueue(rtcsock.ChBulk, frameBytes); err != nil {
			t.Fatal(err)
		}
	}
	// SCTP takes 64 KiB (the sink's high water); nothing is acknowledged, so all 192 KiB stay charged.
	f.drainOnce()
	if g := f.grants[rtcsock.ChBulk]; g != 0 || b.txWithheld.Load() == 0 {
		t.Fatalf("granted %d past txSoft, withheld %d", g, b.txWithheld.Load())
	}
	if _, tx := b.usage(); tx != 12*frameCharge(16*1024) {
		t.Fatalf("tx %d", tx)
	}
	// The client acknowledges everything and SCTP takes the rest: the charge goes, and the grants follow.
	for i := 0; i < 4; i++ {
		f.sinks[rtcsock.ChBulk].drain()
		f.drainOnce()
	}
	f.sinks[rtcsock.ChBulk].drain()
	f.drainOnce()
	f.grantMu.Lock()
	g := f.grants[rtcsock.ChBulk]
	f.grantMu.Unlock()
	if g < 12*16*1024-rtcsock.CreditGrantStep { // what's under a grant step waits for more, as always
		t.Fatalf("granted %d of %d", g, 12*16*1024)
	}
	if _, tx := b.usage(); tx != 0 || f.sched.charged.Load() != 0 {
		t.Fatalf("tx %d, charged %d", tx, f.sched.charged.Load())
	}
	// Stopping gives back whatever is still charged.
	_ = f.sched.enqueue(rtcsock.ChCtl, frameBytes)
	f.sched.stop()
	if _, tx := b.usage(); tx != 0 {
		t.Fatalf("tx %d after stop", tx)
	}
}

// M1: a member whose client stops reading while deskd sends to them holds the budget, and past txMax their session is
// closed, over_budget; another member's session carries on, and the budget is given back.
func TestGuildShedsTheSessionHoldingTheMost(t *testing.T) {
	f := startServerWith(t, 30*time.Second, func(c *Config) { c.GuildTxBudget, c.GuildTxSoft = 640*1024, 600*1024 })
	d := f.deskd()
	d.configureGuild(0, 0)
	_, ok := guildConnected(t, d, "cs-ok", "gm-ok", peerOpts{dataOnly: true})
	slow := newPeer(t, peerOpts{dataOnly: true, noRead: true})
	d.send(guildCreate("cs-slow", "gm-slow", slow))
	ans := d.expect("session.answer", "cs-slow", 5*time.Second)
	slow.answer(ans.Answer)
	slow.waitOpen(10 * time.Second)

	payload := make([]byte, 16*1024-frame.HeaderSize)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() {
		for i := 0; ctx.Err() == nil; i++ {
			for _, ch := range []uint8{rtcsock.ChRPC, rtcsock.ChCollab, rtcsock.ChMdoc, rtcsock.ChBulk} {
				if d.c.SendData(ctx, ans.Handle, ch, frame.Encode(frame.Data, 0, 1, uint32(i), payload)) != nil {
					return
				}
			}
		}
	}()
	if m := d.expect("session.closed", "cs-slow", 20*time.Second); m.Reason != reasonOverBudget {
		t.Fatalf("reason %q", m.Reason)
	}
	cancel()
	if err := d.c.SendData(context.Background(), ok.Handle, rtcsock.ChCtl, frame.Encode(frame.Ping, 0, 0, 1, nil)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		m := d.stats()
		if m.Budget == nil {
			t.Fatal("no budget in stats")
		}
		if m.Budget.Shed == 1 && m.Budget.TxBytes < 64*1024 && len(m.Sessions) >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("budget %+v", m.Budget)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// M1: deskd may ask for less credit on a Guild Desk; configured says what's in effect, and desk-rtc holds deskd to it.
func TestGuildCreditFromConfigure(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	for _, c := range []struct{ ask, want int }{{0, 256 * 1024}, {1000, 256 * 1024}, {1 << 20, 256 * 1024}, {64 * 1024, 64 * 1024}} {
		d.send(&rtcsock.Message{T: "configure", PublicIPv4: "127.0.0.1", DeskKind: rtcsock.DeskKindGuild, Credit: c.ask})
		if m := d.expect("configured", "", 3*time.Second); m.Credit != c.want {
			t.Fatalf("asked %d: credit %d, want %d", c.ask, m.Credit, c.want)
		}
	}
	// A session whose client hasn't connected: nothing drains, so 64 KiB is all deskd may send.
	d.send(guildCreate("cs-a", "gm-a", newPeer(t, peerOpts{dataOnly: true})))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	payload := make([]byte, 16000)
	for i := 0; i < 5; i++ {
		if err := d.c.RawWrite(rtcsock.EncodeData(ans.Handle, rtcsock.ChBulk, payload)); err != nil {
			t.Fatal(err)
		}
	}
	if m := d.expect("session.closed", "cs-a", 5*time.Second); m.Reason != reasonCreditViolation {
		t.Fatalf("reason %q", m.Reason)
	}
}

// M2: a Guild Desk session's final bytes are in its session.closed and in a closed row of every stats until deskd
// acks it, also across a dropped rtc.sock, which loses the session.closed.
func TestGuildFinalBytesOutliveTheSession(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 0)
	p, a := guildConnected(t, d, "cs-a", "gm-a", peerOpts{dataOnly: true})
	if err := d.c.SendData(context.Background(), a.Handle, rtcsock.ChBulk, frame.Encode(frame.Data, 0, 1, 0, make([]byte, 8000))); err != nil {
		t.Fatal(err)
	}
	if err := p.channels[rtcsock.ChCollab].Send(make([]byte, 3000)); err != nil {
		t.Fatal(err)
	}
	<-d.frames
	time.Sleep(200 * time.Millisecond) // the client acknowledges
	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a", Reason: "closed_by_client"})
	closed := d.expect("session.closed", "cs-a", 5*time.Second)
	if closed.MemberID != "gm-a" || closed.BytesSent == nil || *closed.BytesSent < 8000 || closed.BytesReceived == nil || *closed.BytesReceived < 3000 {
		t.Fatalf("session.closed %+v", closed)
	}
	row := func(m *rtcsock.Message, id string) (rtcsock.SessionStats, bool) {
		for _, r := range m.Sessions {
			if r.SessionID == id {
				return r, true
			}
		}

		return rtcsock.SessionStats{}, false
	}
	m := d.stats()
	r, ok := row(m, "cs-a")
	if !ok || !r.Closed || r.MemberID != "gm-a" || r.BytesSent != *closed.BytesSent || r.BytesReceived != *closed.BytesReceived {
		t.Fatalf("closed row %+v (kept %v)", r, ok)
	}
	if len(m.Members) != 1 || m.Members[0].BytesSent != r.BytesSent || m.Members[0].Sessions != 0 {
		t.Fatalf("members %+v", m.Members)
	}
	if m.Budget == nil || m.Budget.ClosedKept != 1 {
		t.Fatalf("budget %+v", m.Budget)
	}
	// Still there for a session.close of the session that's gone.
	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a"})
	if again := d.expect("session.closed", "cs-a", 3*time.Second); again.BytesSent == nil || *again.BytesSent != r.BytesSent {
		t.Fatalf("again %+v", again)
	}
	// An ack, and it's gone.
	d.send(&rtcsock.Message{T: "stats.get", Ack: []string{"cs-a"}})
	if m := d.expect("stats", "", 3*time.Second); len(m.Sessions) != 0 {
		t.Fatalf("after the ack %+v", m.Sessions)
	}

	// A session that closes with the link: its session.closed never reaches deskd, and the next deskd finds its row.
	pb, b := guildConnected(t, d, "cs-b", "gm-b", peerOpts{dataOnly: true})
	if err := d.c.SendData(context.Background(), b.Handle, rtcsock.ChBulk, frame.Encode(frame.Data, 0, 1, 0, make([]byte, 5000))); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	_ = d.c.Close()
	d2 := f.deskd()
	d2.configureGuild(0, 0)
	deadline := time.Now().Add(6 * time.Second)
	for {
		m := d2.stats()
		if r, ok := row(m, "cs-b"); ok && r.Closed {
			if r.BytesSent < 5000 || r.MemberID != "gm-b" {
				t.Fatalf("row %+v", r)
			}

			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no closed row for cs-b: %+v", m.Sessions)
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = pb
}

// L4: member.close takes a member's sessions out of their count at once, and stops their frames to deskd, though each
// may take up to 500 ms to flush ctl.
func TestMemberCloseFreesTheMembersPlacesAtOnce(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configureGuild(0, 1)
	slow := newPeer(t, peerOpts{dataOnly: true, noRead: true})
	d.send(guildCreate("cs-a", "gm-a", slow))
	a := d.expect("session.answer", "cs-a", 5*time.Second)
	slow.answer(a.Answer)
	slow.waitOpen(10 * time.Second)
	// ctl the client never reads, so the close waits out its flush.
	for i := 0; i < 8; i++ {
		_ = d.c.SendData(context.Background(), a.Handle, rtcsock.ChCtl, frame.Encode(frame.Data, 0, 1, uint32(i), make([]byte, 16000)))
	}
	time.Sleep(100 * time.Millisecond)
	d.send(&rtcsock.Message{T: "member.close", MemberID: "gm-a", Reason: "role_changed"})
	time.Sleep(20 * time.Millisecond)
	_ = slow.channels[rtcsock.ChCollab].Send([]byte("after the close"))
	fresh := newPeer(t, peerOpts{dataOnly: true})
	d.send(guildCreate("cs-a2", "gm-a", fresh))
	d.expect("session.answer", "cs-a2", 5*time.Second)
	for {
		select {
		case got := <-d.frames:
			if got.handle == a.Handle {
				t.Fatalf("a frame from a closing session reached deskd: %q", got.frame)
			}
		case <-time.After(300 * time.Millisecond):
			d.expect("member.closed", "", 3*time.Second)

			return
		}
	}
}
