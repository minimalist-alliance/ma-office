package rtcserver

import (
	"encoding/binary"
	"math/big"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

func TestMonoTicksIsGStreamersScale(t *testing.T) {
	for _, d := range []time.Duration{0, 999_999_999, time.Second, 37*time.Hour + 123_456_789, 400 * 24 * time.Hour} {
		for _, rate := range []uint32{audioClock, videoClock} {
			want := new(big.Int).Mul(big.NewInt(int64(d)), big.NewInt(int64(rate)))
			want.Div(want, big.NewInt(int64(time.Second)))
			want.Mod(want, new(big.Int).Lsh(big.NewInt(1), 32))
			if got := monoTicks(d, rate); uint64(got) != want.Uint64() {
				t.Fatalf("monoTicks(%v, %d) = %d, want %d", d, rate, got, want.Uint64())
			}
		}
	}
}

func TestClockedTS(t *testing.T) {
	now := 3*24*time.Hour + 7*time.Second
	for _, c := range []struct {
		name string
		ts   uint32
		want bool
	}{
		{"captured 50 ms ago", monoTicks(now-50*time.Millisecond, videoClock), true},
		{"captured just now", monoTicks(now, videoClock), true},
		{"1.9 s ago", monoTicks(now-1900*time.Millisecond, videoClock), true},
		{"3 s ago", monoTicks(now-3*time.Second, videoClock), false},
		{"in the future", monoTicks(now+time.Second, videoClock), false},
		{"a random offset", monoTicks(now, videoClock) + 0x6000_0000, false},
	} {
		if got := clockedTS(c.ts, now, videoClock); got != c.want {
			t.Errorf("%s: clockedTS = %v, want %v", c.name, got, c.want)
		}
	}
	// Across the 32-bit wrap: now just past it, the capture just before.
	wrap := time.Duration(uint64(1<<32)*uint64(time.Second)/audioClock) + 10*time.Millisecond
	if !clockedTS(monoTicks(wrap-30*time.Millisecond, audioClock), wrap, audioClock) {
		t.Error("a capture just before the wrap isn't seen as clocked")
	}
}

func TestToNTP(t *testing.T) {
	at := time.Date(2026, 11, 6, 12, 0, 0, 500_000_000, time.UTC)
	n := toNTP(at)
	if sec := n >> 32; sec != uint64(at.Unix())+ntpEpochOffset {
		t.Fatalf("seconds %d", sec)
	}
	if frac := uint32(n); frac != 1<<31 {
		t.Fatalf("half a second is %#x", frac)
	}
}

// srWatch records, per kind, each RTP packet's timestamp with the wall time the fake desk-stream stamped it, and each sender
// report.
type srWatch struct {
	mu  sync.Mutex
	srs map[webrtc.RTPCodecType][]*rtcp.SenderReport
	ts  map[webrtc.RTPCodecType][]uint32
}

func watchReports(p *peer) *srWatch {
	w := &srWatch{srs: map[webrtc.RTPCodecType][]*rtcp.SenderReport{}, ts: map[webrtc.RTPCodecType][]uint32{}}
	p.pc.OnTrack(func(tr *webrtc.TrackRemote, recv *webrtc.RTPReceiver) {
		go func() {
			for {
				pkts, _, err := recv.ReadRTCP()
				if err != nil {
					return
				}
				for _, x := range pkts {
					if sr, ok := x.(*rtcp.SenderReport); ok {
						w.mu.Lock()
						w.srs[tr.Kind()] = append(w.srs[tr.Kind()], sr)
						w.mu.Unlock()
					}
				}
			}
		}()
		for {
			pkt, _, err := tr.ReadRTP()
			if err != nil {
				return
			}
			w.mu.Lock()
			w.ts[tr.Kind()] = append(w.ts[tr.Kind()], pkt.Timestamp)
			w.mu.Unlock()
		}
	})

	return w
}

func (w *srWatch) count(k webrtc.RTPCodecType) int {
	w.mu.Lock()
	defer w.mu.Unlock()

	return len(w.srs[k])
}

func ntpTime(n uint64) time.Time {
	sec := int64(n>>32) - ntpEpochOffset
	ns := int64((n & 0xffffffff) * uint64(time.Second) >> 32)

	return time.Unix(sec, ns)
}

type capture struct {
	ts   uint32
	wall time.Time
}

// Each kind reaches desk-rtc this long after its capture, as on a desk: audio waits for its Opus frame, video for its encode.
var sendLag = map[webrtc.RTPCodecType]time.Duration{webrtc.RTPCodecTypeVideo: 15 * time.Millisecond, webrtc.RTPCodecTypeAudio: 35 * time.Millisecond}

// sendClocked streams video and audio stamped as desk-stream stamps them, from CLOCK_MONOTONIC plus `offset` (0 for a clocked
// desk-stream), each captured sendLag before it's sent, until stop closes. It returns what it sent, per kind, with the wall
// time of each capture.
func sendClocked(s *fakeStream, stop chan struct{}, offset uint32) map[webrtc.RTPCodecType][]capture {
	sent := map[webrtc.RTPCodecType][]capture{}
	var seq uint16
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return sent
		case <-tick.C:
		}
		mono, wall := monoNow(), time.Now()
		vl, al := sendLag[webrtc.RTPCodecTypeVideo], sendLag[webrtc.RTPCodecTypeAudio]
		vts, ats := monoTicks(mono-vl, videoClock)+offset, monoTicks(mono-al, audioClock)+offset
		nal := byte(0x41)
		if seq == 0 {
			nal = 0x67
		}
		seq++
		for _, p := range []rtp.Packet{
			{Header: rtp.Header{Version: 2, PayloadType: ptH264, Marker: true, SequenceNumber: seq, Timestamp: vts, SSRC: 1}, Payload: []byte{nal, 0, 1, 2, 3}},
			{Header: rtp.Header{Version: 2, PayloadType: ptOpus, SequenceNumber: seq, Timestamp: ats, SSRC: 2}, Payload: []byte{0xf8, 0xff, 0xfe}},
		} {
			b, err := p.Marshal()
			if err != nil {
				s.t.Error(err)

				return sent
			}
			s.sendRaw(b)
		}
		sent[webrtc.RTPCodecTypeVideo] = append(sent[webrtc.RTPCodecTypeVideo], capture{vts, wall.Add(-vl)})
		sent[webrtc.RTPCodecTypeAudio] = append(sent[webrtc.RTPCodecTypeAudio], capture{ats, wall.Add(-al)})
	}
}

// reportsFor runs a session against a fake desk-stream stamping with `offset`, until both kinds have had `n` reports.
func reportsFor(t *testing.T, offset uint32, n int) (*srWatch, map[webrtc.RTPCodecType][]capture) {
	t.Helper()
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	p := newPeer(t, peerOpts{})
	w := watchReports(p)
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)
	view(d, "cs-a", true)
	s.expectCmd("resume")
	stop := make(chan struct{})
	done := make(chan map[webrtc.RTPCodecType][]capture)
	go func() { done <- sendClocked(s, stop, offset) }()
	deadline := time.Now().Add(10 * time.Second)
	for (w.count(webrtc.RTPCodecTypeVideo) < n || w.count(webrtc.RTPCodecTypeAudio) < n) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	close(stop)

	return w, <-done
}

// captureError is, for each packet the peer got, how far the last sender report puts its capture from the real one.
func captureError(t *testing.T, w *srWatch, sent map[webrtc.RTPCodecType][]capture, k webrtc.RTPCodecType) []time.Duration {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	got, srs, out := w.ts[k], w.srs[k], sent[k]
	if len(srs) < 2 || len(got) < 10 || len(got) > len(out) {
		t.Fatalf("%v: %d reports, %d packets received, %d sent", k, len(srs), len(got), len(out))
	}
	for i := range got {
		if got[i]-got[0] != out[i].ts-out[0].ts {
			t.Fatalf("%v: packet %d isn't the %dth sent: the timeline moved", k, i, i)
		}
	}
	rate := float64(videoClock)
	if k == webrtc.RTPCodecTypeAudio {
		rate = audioClock
	}
	sr := srs[len(srs)-1]
	var errs []time.Duration
	for i := range got {
		at := ntpTime(sr.NTPTime).Add(-time.Duration(float64(int32(sr.RTPTime-got[i])) / rate * float64(time.Second)))
		errs = append(errs, at.Sub(out[i].wall))
	}

	return errs
}

// TestSenderReportsAreOnTheCaptureClock: from a clocked desk-stream, the reports map each track's RTP time to the wall time it
// was captured, the same for sound and picture, so a browser can pair them. Pion's own reports said when desk-rtc sent it.
func TestSenderReportsAreOnTheCaptureClock(t *testing.T) {
	w, sent := reportsFor(t, 0, 2)
	for _, k := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		for i, e := range captureError(t, w, sent, k) {
			if e < -3*time.Millisecond || e > 3*time.Millisecond {
				t.Errorf("%v packet %d: the report puts its capture %v from the real one", k, i, e)
			}
		}
	}
}

// TestUnclockedSourceKeepsPionsReports: an older desk-stream's random offset gets Pion's send-time reports, as before. They
// map a packet to when it was sent, so each track is off by its own lag, and sound and picture by the difference: the error
// the clocked reports remove.
func TestUnclockedSourceKeepsPionsReports(t *testing.T) {
	w, sent := reportsFor(t, 0x5a5a_0000, 2)
	for _, k := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		errs := captureError(t, w, sent, k)
		last := errs[len(errs)-1]
		if lag := sendLag[k]; last < lag-10*time.Millisecond || last > lag+10*time.Millisecond {
			t.Errorf("%v: a send-time report should be off by about the lag, %v, got %v", k, lag, last)
		}
	}
}

func TestStaleTS(t *testing.T) {
	now := 5*24*time.Hour + 3*time.Second
	if !staleTS(monoTicks(now-3*time.Second, audioClock), now, audioClock) {
		t.Error("a capture from 3 s ago, as after a pause, isn't stale")
	}
	if staleTS(monoTicks(now-time.Second, audioClock), now, audioClock) || staleTS(monoTicks(now-2*time.Minute, audioClock), now, audioClock) {
		t.Error("stale outside 2 s to 1 min")
	}
}

// TestResumeKeepsAClockedTimelineOnWallPace: after a pause, a clocked desk-stream's first audio packet carries the time from
// before the pause (measured with GStreamer 1.26's opusenc and pulsesrc). It's dropped, so what the browser gets after the
// pause continues at the wall clock's pace, as with the old re-anchoring.
func TestResumeKeepsAClockedTimelineOnWallPace(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	p := newPeer(t, peerOpts{})
	w := watchReports(p)
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)
	audio := func(ts uint32, seq uint16) {
		pkt := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: ptOpus, SequenceNumber: seq, Timestamp: ts, SSRC: 2}, Payload: []byte{0xf8, 0xff, 0xfe}}
		b, err := pkt.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		s.sendRaw(b)
	}
	view(d, "cs-a", true)
	s.expectCmd("resume")
	var seq uint16
	for i := 0; i < 10; i++ {
		seq++
		audio(monoTicks(monoNow()-20*time.Millisecond, audioClock), seq)
		time.Sleep(20 * time.Millisecond)
	}
	waitFor(t, "audio before the pause", func() bool { w.mu.Lock(); defer w.mu.Unlock(); return len(w.ts[webrtc.RTPCodecTypeAudio]) >= 10 })
	pausedAt := monoNow()
	view(d, "cs-a", false)
	s.expectCmd("pause")
	time.Sleep(3 * time.Second)
	view(d, "cs-a", true)
	s.expectCmd("resume")
	seq++
	audio(monoTicks(pausedAt, audioClock), seq) // the stale one
	for i := 0; i < 5; i++ {
		seq++
		audio(monoTicks(monoNow()-20*time.Millisecond, audioClock), seq)
		time.Sleep(20 * time.Millisecond)
	}
	waitFor(t, "audio after the pause", func() bool { w.mu.Lock(); defer w.mu.Unlock(); return len(w.ts[webrtc.RTPCodecTypeAudio]) >= 15 })
	time.Sleep(100 * time.Millisecond)
	w.mu.Lock()
	defer w.mu.Unlock()
	got := w.ts[webrtc.RTPCodecTypeAudio]
	if len(got) != 15 {
		t.Fatalf("got %d audio packets, want 15: the stale one went through", len(got))
	}
	gap := time.Duration(float64(got[10]-got[9]) / audioClock * float64(time.Second))
	if gap < 2900*time.Millisecond || gap > 3400*time.Millisecond {
		t.Fatalf("the timeline moved %v across a 3 s pause", gap)
	}
}

func TestPlayoutDelayBytes(t *testing.T) {
	for _, c := range []struct {
		d    time.Duration
		want []byte
	}{
		{0, []byte{0, 0, 0}},
		{120 * time.Millisecond, []byte{0x00, 0xc0, 0x0c}},
		{500 * time.Millisecond, []byte{0x03, 0x20, 0x32}},
		{54 * time.Millisecond, []byte{0x00, 0x50, 0x05}},
	} {
		if got := playoutDelay(c.d); string(got) != string(c.want) {
			t.Errorf("playoutDelay(%v) = %x, want %x", c.d, got, c.want)
		}
	}
}

// TestHoldSetsThisSessionsPlayoutDelay: a HOLD on keys puts min and max of the playout-delay extension at the hold, capped at
// maxHold, on this session's video only, and 0 lets go.
func TestHoldSetsThisSessionsPlayoutDelay(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	p := newPeer(t, peerOpts{playoutDelay: true})
	var mu sync.Mutex
	var exts [][]byte
	p.pc.OnTrack(func(tr *webrtc.TrackRemote, recv *webrtc.RTPReceiver) {
		var id uint8
		for _, e := range recv.GetParameters().HeaderExtensions {
			if e.URI == playoutDelayURI {
				id = uint8(e.ID)
			}
		}
		for {
			pkt, _, err := tr.ReadRTP()
			if err != nil {
				return
			}
			if tr.Kind() == webrtc.RTPCodecTypeVideo && id != 0 {
				mu.Lock()
				exts = append(exts, append([]byte(nil), pkt.GetExtension(id)...))
				mu.Unlock()
			}
		}
	})
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	if !strings.Contains(ans.Answer, playoutDelayURI) {
		t.Fatal("the answer doesn't carry playout-delay")
	}
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)
	view(d, "cs-a", true)
	s.expectCmd("resume")
	hold := func(ms uint16) {
		b := make([]byte, 16)
		b[0] = 6
		binary.BigEndian.PutUint16(b[12:], ms)
		if err := p.channels[rtcsock.ChKeys].Send(b); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	got := func(n int) []byte {
		waitFor(t, "a video packet", func() bool { mu.Lock(); defer mu.Unlock(); return len(exts) >= n })
		mu.Lock()
		defer mu.Unlock()

		return exts[n-1]
	}
	s.sendVideo(0x67, 0)
	if e := got(1); string(e) != string(playoutDelay(0)) {
		t.Fatalf("no hold: %x", e)
	}
	hold(120)
	s.sendVideo(0x41, 0)
	if e := got(2); string(e) != string(playoutDelay(120*time.Millisecond)) {
		t.Fatalf("hold 120: %x", e)
	}
	hold(900)
	s.sendVideo(0x41, 0)
	if e := got(3); string(e) != string(playoutDelay(maxHold)) {
		t.Fatalf("hold 900 isn't capped: %x", e)
	}
	hold(0)
	s.sendVideo(0x41, 0)
	if e := got(4); string(e) != string(playoutDelay(0)) {
		t.Fatalf("let go: %x", e)
	}
}
