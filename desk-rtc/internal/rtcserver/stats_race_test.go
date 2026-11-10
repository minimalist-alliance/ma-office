package rtcserver

import (
	"context"
	"testing"
	"time"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// A stats that comes while a session is being torn down must count that session's bytes once: either as a live
// session or in the totals, never neither (deskd's RealDeskRtcIT.statsReportWhatTheSessionsSent saw bytesSent 0 in 2 of
// 4 runs, task 33 item 4) and never both. The hook puts the stats exactly in teardown's step from the table to the
// totals, so this fails every time without the fix, not one run in a few. Run it with -race.
func TestStatsReportWhatTheSessionsSentWhileOneCloses(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p, ans := connected(t, d, "cs-a")
	d.expect("session.state", "cs-a", 5*time.Second)

	// Some bytes each way, so the session has something to count.
	for i := 0; i < 20; i++ {
		out := frame.Encode(frame.Res, 0, uint32(rtcsock.ChRPC), 0, make([]byte, 1000))
		if err := d.c.SendData(context.Background(), ans.Handle, rtcsock.ChRPC, out); err != nil {
			t.Fatal(err)
		}
		<-p.recv
	}
	time.Sleep(200 * time.Millisecond)
	d.send(&rtcsock.Message{T: "stats.get"})
	before := d.expect("stats", "", 3*time.Second)
	if len(before.Sessions) != 1 || before.BytesSent == nil || *before.BytesSent == 0 {
		t.Fatalf("before the close: %+v", before)
	}
	sentBefore := *before.BytesSent

	// In teardown, between the session leaving the table and its bytes reaching the totals, ask for stats and hold
	// teardown until the answer has been read.
	read := make(chan struct{})
	asked := make(chan struct{})
	setAfterForgetHook(func() {
		_ = d.c.Send(&rtcsock.Message{T: "stats.get"})
		close(asked)
		select {
		case <-read:
		case <-time.After(5 * time.Second):
		}
	})
	t.Cleanup(func() { setAfterForgetHook(nil) })

	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a", Reason: "closed_by_desk"})
	select {
	case <-asked:
	case <-time.After(5 * time.Second):
		t.Fatal("teardown never reached the hook")
	}
	during := d.expect("stats", "", 5*time.Second)
	close(read)
	d.expect("session.closed", "cs-a", 5*time.Second)
	if len(during.Sessions) != 0 {
		t.Fatalf("the session is still listed during its teardown: %+v", during.Sessions)
	}
	if during.BytesSent == nil {
		t.Fatal("no bytesSent during the close")
	}
	if *during.BytesSent < sentBefore {
		t.Fatalf("bytesSent during the close fell from %d to %d: the closing session's bytes were in neither place", sentBefore, *during.BytesSent)
	}

	// Afterwards it's in the totals once: at least what it had, and not twice that.
	d.send(&rtcsock.Message{T: "stats.get"})
	after := d.expect("stats", "", 3*time.Second)
	if *after.BytesSent < sentBefore || *after.BytesSent >= 2*sentBefore {
		t.Fatalf("bytesSent after the close %d, before %d", *after.BytesSent, sentBefore)
	}
}
