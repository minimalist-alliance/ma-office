package voice

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const ms = int64(time.Millisecond)

func testPolicer() *policer { return newPolicer(Police{}.withDefaults(), 0) }

// Real Opus voice is never dropped: 20 ms frames at 32 to 64 kbit/s, with DTX gaps and FEC-sized frames, for ten
// minutes, and the connection is never called abusive.
func TestPoliceNormalOpusNeverDropped(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	for i := 0; i < 30000; i++ { // 10 min at 20 ms
		now += 20 * ms
		size := 12 + 8 + 80 // header, audio-level extension, 32 kbit/s frame
		switch {
		case i%500 < 200:
			size = 12 + 8 + 3 // DTX silence: tiny packets (every 400 ms in real DTX; every 20 ms is worse)
		case i%7 == 0:
			size = 12 + 8 + 160 + 80 // 64 kbit/s with FEC piggyback
		}
		if ok, ab := p.allow(size, now); !ok || ab {
			t.Fatalf("packet %d (%d bytes) dropped=%v abusive=%v", i, size, !ok, ab)
		}
	}
}

// A talker at the cap's own rate (128 kbit/s, 50 packets of 320 bytes) is still within it.
func TestPoliceAtTheLimit(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	for i := 0; i < 5000; i++ {
		now += 20 * ms
		if ok, ab := p.allow(320, now); !ok || ab {
			t.Fatalf("packet %d dropped at 128 kbit/s", i)
		}
	}
}

// A network stall delivers up to half a second of voice at once; none is dropped, and the talker isn't abusive.
func TestPoliceBurstAfterStall(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	for i := 0; i < 100; i++ {
		now += 20 * ms
		p.allow(100, now)
	}
	now += 500 * ms // stall, then 25 queued frames arrive together, then the stream goes on
	for i := 0; i < 25; i++ {
		if ok, _ := p.allow(100, now); !ok {
			t.Fatalf("burst packet %d dropped", i)
		}
	}
	for i := 0; i < 500; i++ {
		now += 20 * ms
		if ok, ab := p.allow(100, now); !ok || ab {
			t.Fatalf("packet %d after the burst dropped=%v abusive=%v", i, !ok, ab)
		}
	}
}

// Packets over 400 bytes are dropped, whatever the rate; a stray one never closes anything.
func TestPoliceOversize(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	for i := 0; i < 1000; i++ {
		now += 20 * ms
		if i%250 == 0 {
			if ok, _ := p.allow(401, now); ok {
				t.Fatal("a 401-byte packet got through")
			}
			continue
		}
		if ok, ab := p.allow(100, now); !ok || ab {
			t.Fatalf("packet %d dropped=%v abusive=%v", i, !ok, ab)
		}
	}
	if ok, _ := p.allow(400, now+20*ms); !ok {
		t.Fatal("a 400-byte packet is allowed")
	}
}

// A client that sends only oversize packets is dropped throughout and is abusive after the abuse time.
func TestPoliceOversizeFloodCloses(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	var closedAt int64 = -1
	for i := 0; i < 1000 && closedAt < 0; i++ {
		now += 20 * ms
		ok, ab := p.allow(900, now)
		if ok {
			t.Fatal("an oversize packet got through")
		}
		if ab {
			closedAt = now
		}
	}
	if closedAt < 0 || closedAt < 5000*ms || closedAt > 8000*ms {
		t.Fatalf("closed at %d ms; want after about 5 to 7 s", closedAt/ms)
	}
}

// A flood of small packets (1000 a second) is cut to the packet cap and then closed; what gets through is bounded.
func TestPolicePacketFlood(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	passed, closedAt := 0, int64(-1)
	for i := 0; i < 20000 && closedAt < 0; i++ {
		now += ms
		ok, ab := p.allow(60, now)
		if ok {
			passed++
		}
		if ab {
			closedAt = now
		}
	}
	if closedAt < 0 {
		t.Fatal("a flood was never closed")
	}
	// 100/s for about 6 s plus the 50-packet burst.
	if limit := int(closedAt/int64(time.Second))*100 + 150; passed > limit {
		t.Fatalf("%d packets passed before the close (limit %d)", passed, limit)
	}
}

// A flood of big packets under the size cap (400 bytes at 100 a second = 320 kbit/s) is cut to 128 kbit/s.
func TestPoliceByteFlood(t *testing.T) {
	p := testPolicer()
	now, bytes := int64(0), 0
	for i := 0; i < 400; i++ { // 4 s at 100/s
		now += 10 * ms
		if ok, _ := p.allow(400, now); ok {
			bytes += 400
		}
	}
	// 16,000 bytes/s for 4 s plus the 8,000-byte burst.
	if bytes > 4*16000+8000+400 {
		t.Fatalf("%d bytes passed in 4 s", bytes)
	}
	if bytes < 4*16000 {
		t.Fatalf("only %d bytes passed: the cap is too tight", bytes)
	}
}

// Sustained abuse that pauses for a whole second starts over.
func TestPoliceOnOffAbuseResets(t *testing.T) {
	p := testPolicer()
	now := int64(0)
	for round := 0; round < 10; round++ {
		for i := 0; i < 200; i++ { // 2 s of flood
			now += 10 * ms
			if _, ab := p.allow(900, now); ab {
				t.Fatalf("closed in round %d", round)
			}
		}
		now += 2 * int64(time.Second) // quiet
	}
}

// Off: nothing is dropped.
func TestPoliceOff(t *testing.T) {
	p := newPolicer(Police{Kbps: -1}.withDefaults(), 0)
	if ok, ab := p.allow(1400, 0); !ok || ab {
		t.Fatal("policing off still dropped")
	}
}

// End to end: Ana floods oversize packets; Ben, who listens, is sent none of them and his usage doesn't grow; Ana's
// voice connection is closed with Policed (not Down). Then a well-behaved Cy talks and Ben hears and is charged.
func TestSFUPolicesAFlooder(t *testing.T) {
	var mu sync.Mutex
	var policed []uint16
	var downs atomic.Int32
	usage := map[uint16]uint64{}
	ev := Events{
		Policed: func(m uint16) { mu.Lock(); policed = append(policed, m); mu.Unlock() },
		Down:    func(uint16) { downs.Add(1) },
		Usage:   func(m uint16, n uint64, _ bool) { mu.Lock(); usage[m] = n; mu.Unlock() },
	}
	old := UsageEvery
	UsageEvery = 200 * time.Millisecond
	t.Cleanup(func() { UsageEvery = old })
	s, err := New(Config{UDP: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, Slots: 2, Sockets: 1,
		Police: Police{AbuseSecs: 2}}, ev)
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
			t.Fatalf("member %d didn't connect", idx)
		}
		return pc
	}
	talk := func(pc *webrtc.PeerConnection, size int, every time.Duration, stop <-chan struct{}) {
		mic := pc.GetTransceivers()[0].Sender().Track().(*webrtc.TrackLocalStaticRTP)
		seq, ts := uint16(1), uint32(0)
		tk := time.NewTicker(every)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
			}
			_ = mic.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: ts, SSRC: 77}, Payload: make([]byte, size)})
			seq++
			ts += 960
		}
	}
	ana, _, cy := connect(1), connect(2), connect(3)
	stop := make(chan struct{})
	defer close(stop)
	go talk(ana, 900, 10*time.Millisecond, stop)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(policed)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	if len(policed) != 1 || policed[0] != 1 {
		t.Fatalf("policed = %v, want [1]", policed)
	}
	benBytes := usage[2]
	mu.Unlock()
	if downs.Load() != 0 {
		t.Fatal("a policed close also sent Down")
	}
	if benBytes != 0 {
		t.Fatalf("Ben was charged %d bytes for a flooder's dropped packets", benBytes)
	}
	if s.C.PolicedPackets.Load() == 0 || s.C.PolicedCloses.Load() != 1 || s.C.PacketsOut.Load() != 0 {
		t.Fatalf("counters: policed %d, closes %d, out %d", s.C.PolicedPackets.Load(), s.C.PolicedCloses.Load(), s.C.PacketsOut.Load())
	}
	if s.Peers() != 2 {
		t.Fatalf("%d peers after the close, want 2", s.Peers())
	}
	// Cy talks like a person and is heard and counted.
	go talk(cy, 80, 20*time.Millisecond, stop)
	time.Sleep(1500 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if usage[2] < 30*92 {
		t.Fatalf("Ben was sent only %d bytes of Cy's voice", usage[2])
	}
	if s.C.PolicedCloses.Load() != 1 {
		t.Fatal("normal voice was policed")
	}
}
