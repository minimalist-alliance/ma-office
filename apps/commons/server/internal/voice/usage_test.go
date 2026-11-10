package voice

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type usageRec struct {
	idx   uint16
	sent  uint64
	final bool
}

// TestUsageCountsWhatEachListenerIsSent: Ana talks, Ben listens; Ben's voice connection's bytes are reported as they
// grow, then once more, final, when it ends, and a new connection for him starts again at 0.
func TestUsageCountsWhatEachListenerIsSent(t *testing.T) {
	old := UsageEvery
	UsageEvery = 300 * time.Millisecond
	t.Cleanup(func() { UsageEvery = old })
	var mu sync.Mutex
	var got []usageRec
	ev := Events{Usage: func(idx uint16, sent uint64, final bool) {
		mu.Lock()
		got = append(got, usageRec{idx, sent, final})
		mu.Unlock()
	}}
	s, err := New(Config{UDP: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, Slots: 2, Sockets: 1}, ev)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)

	connect := func(idx uint16) *webrtc.PeerConnection {
		pc, offer := client(t, webrtc.NetworkTypeUDP4)
		answer, _, err := s.Answer("r", idx, offer, false)
		if err != nil {
			t.Fatal(err)
		}
		up := make(chan struct{})
		var once sync.Once
		pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
			if st == webrtc.PeerConnectionStateConnected {
				once.Do(func() { close(up) })
			}
		})
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-up:
		case <-time.After(10 * time.Second):
			t.Fatalf("member %d's voice didn't connect", idx)
		}
		return pc
	}
	ana := connect(1)
	connect(2)
	// Ana talks: 20 ms packets of 80 bytes for 1.5 s.
	mic := ana.GetTransceivers()[0].Sender().Track().(*webrtc.TrackLocalStaticRTP)
	stop := make(chan struct{})
	go func() {
		seq, ts := uint16(1), uint32(0)
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
			}
			_ = mic.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: ts, SSRC: 1234}, Payload: make([]byte, 80)})
			seq++
			ts += 960
		}
	}()
	time.Sleep(1500 * time.Millisecond)
	close(stop)
	time.Sleep(100 * time.Millisecond)
	s.Remove(2)

	mu.Lock()
	var ben []usageRec
	for _, u := range got {
		if u.idx == 2 {
			ben = append(ben, u)
		}
	}
	mu.Unlock()
	if len(ben) < 3 {
		t.Fatalf("Ben's reports: %v", ben)
	}
	last := ben[len(ben)-1]
	if !last.final {
		t.Fatalf("the last report isn't final: %v", ben)
	}
	for i := 1; i < len(ben); i++ {
		if ben[i].sent < ben[i-1].sent || ben[i-1].final {
			t.Fatalf("reports out of order, or one after the final: %v", ben)
		}
	}
	// About 75 packets of 80 bytes and a 12-byte header reached Ben.
	if last.sent < 40*92 || last.sent > 100*92 {
		t.Fatalf("Ben was sent %d bytes", last.sent)
	}
	// A new voice connection for Ben starts again at 0 (Ana is quiet now, so it stays there).
	n := len(ben)
	connect(2)
	time.Sleep(700 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	var again []usageRec
	for _, u := range got {
		if u.idx == 2 {
			again = append(again, u)
		}
	}
	if len(again) <= n || again[n].final || again[n].sent != 0 {
		t.Fatalf("a new connection's first report: %v", again[n-1:])
	}
}
