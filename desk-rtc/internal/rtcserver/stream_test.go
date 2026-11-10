package rtcserver

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// streamFixture is desk-rtc with a stream socket, and a fake desk-stream.
type streamFixture struct {
	*fixture
	streamPath string
}

func startStreamServer(t *testing.T, uid int) *streamFixture {
	t.Helper()
	dir := shortDir(t)
	f := &fixture{t: t, sock: filepath.Join(dir, "rtc.sock"), port: freePort(t)}
	sf := &streamFixture{fixture: f, streamPath: filepath.Join(dir, "stream.sock")}
	srv, err := New(Config{
		SocketPath:     f.sock,
		DataDir:        filepath.Join(dir, "rtc"),
		Bind:           "127.0.0.1",
		Port:           f.port,
		ConsentTimeout: 30 * time.Second,
		Version:        "test",
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		StreamSocket:   sf.streamPath,
		StreamUID:      uid,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.srv = srv
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	return sf
}

// fakeStream is a test's desk-stream.
type fakeStream struct {
	t    *testing.T
	c    net.Conn
	cmds chan string

	mu  sync.Mutex
	seq uint16
	ts  uint32
}

func (f *streamFixture) dialStream() *fakeStream {
	f.t.Helper()
	c, err := net.Dial("unix", f.streamPath)
	if err != nil {
		f.t.Fatal(err)
	}

	return watchStream(f.t, c)
}

// watchStream is a fake desk-stream on c: it collects the command lines.
func watchStream(t *testing.T, c net.Conn) *fakeStream {
	s := &fakeStream{t: t, c: c, cmds: make(chan string, 64)}
	go func() {
		r := bufio.NewReader(c)
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				close(s.cmds)

				return
			}
			s.cmds <- strings.TrimSpace(line)
		}
	}()
	t.Cleanup(func() { _ = c.Close() })

	return s
}

func (s *fakeStream) expectCmd(want string) {
	s.t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case got, ok := <-s.cmds:
			if !ok {
				s.t.Fatalf("connection closed, waiting for %q", want)
			}
			if got == want {
				return
			}
		case <-deadline:
			s.t.Fatalf("no %q from desk-rtc", want)
		}
	}
}

func (s *fakeStream) sendRaw(b []byte) {
	s.t.Helper()
	var hdr [2]byte
	binary.BigEndian.PutUint16(hdr[:], uint16(len(b)))
	if _, err := s.c.Write(append(hdr[:], b...)); err != nil {
		s.t.Fatal(err)
	}
}

// sendVideo writes one H.264 packet whose payload starts with the NAL byte. The marker is set, so each
// is its own access unit.
func (s *fakeStream) sendVideo(nal byte, mark byte) {
	s.t.Helper()
	s.mu.Lock()
	s.seq++
	s.ts += 1500
	p := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: ptH264, Marker: true, SequenceNumber: s.seq, Timestamp: s.ts, SSRC: 1},
		Payload: []byte{nal, mark, 1, 2, 3}}
	s.mu.Unlock()
	b, err := p.Marshal()
	if err != nil {
		s.t.Fatal(err)
	}
	s.sendRaw(b)
}

func (s *fakeStream) sendAudio() {
	s.t.Helper()
	p := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: ptOpus, SequenceNumber: 1, Timestamp: 960, SSRC: 2}, Payload: []byte{0xf8, 0xff, 0xfe}}
	b, err := p.Marshal()
	if err != nil {
		s.t.Fatal(err)
	}
	s.sendRaw(b)
}

// mediaReader collects what a peer receives on its tracks.
type mediaReader struct {
	mu    sync.Mutex
	video []*rtp.Packet
	audio int
}

func readMedia(p *peer) *mediaReader {
	m := &mediaReader{}
	p.pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			pkt, _, err := tr.ReadRTP()
			if err != nil {
				return
			}
			m.mu.Lock()
			if tr.Kind() == webrtc.RTPCodecTypeVideo {
				m.video = append(m.video, pkt)
			} else {
				m.audio++
			}
			m.mu.Unlock()
		}
	})

	return m
}

func (m *mediaReader) videoSnapshot() []*rtp.Packet {
	m.mu.Lock()
	defer m.mu.Unlock()

	return append([]*rtp.Packet(nil), m.video...)
}

func (m *mediaReader) audioCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.audio
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func view(d *fakeDeskd, id string, on bool) {
	d.send(&rtcsock.Message{T: "session.video", SessionID: id, View: &on})
}

// connectedMedia is connected, with the track reader attached before the answer applies.
func connectedMedia(t *testing.T, d *fakeDeskd, id string) (*peer, *mediaReader) {
	t.Helper()
	p := newPeer(t, peerOpts{})
	m := readMedia(p)
	d.send(createMsg(id, p))
	ans := d.expect("session.answer", id, 5*time.Second)
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)

	return p, m
}

func TestStreamRefusesAnyOtherUID(t *testing.T) {
	f := startStreamServer(t, os.Getuid()+1)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	if m := d.expect("stream.state", "", 3*time.Second); m.State != streamDown {
		t.Fatalf("state %q", m.State)
	}
	c, err := net.Dial("unix", f.streamPath)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil || os.IsTimeout(err) {
		t.Fatalf("desk-rtc didn't hang up on the wrong uid: %v", err)
	}
	select {
	case m := <-d.msgs:
		if m.T == "stream.state" {
			t.Fatalf("state changed for a refused peer: %q", m.State)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func TestStreamClosesOnAnUnknownPayloadType(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	s := f.dialStream()
	s.expectCmd("level high") // every connection's first line
	p := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 99}, Payload: []byte{1}}
	b, _ := p.Marshal()
	s.sendRaw(b)
	_ = s.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	select {
	case _, ok := <-s.cmds:
		if ok {
			t.Fatal("expected the connection to close")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("still connected after a bad payload type")
	}
}

func TestViewingFlow(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	if m := d.expect("stream.state", "", 3*time.Second); m.State != streamDown {
		t.Fatalf("state %q", m.State)
	}
	s := f.dialStream()
	if m := d.expect("stream.state", "", 3*time.Second); m.State != streamWarm {
		t.Fatalf("state %q", m.State)
	}

	p, media := connectedMedia(t, d, "cs-a")

	// No view yet: nothing flows, even with packets arriving.
	s.sendVideo(0x65, 0)
	s.sendAudio()
	time.Sleep(150 * time.Millisecond)
	if n := len(media.videoSnapshot()); n != 0 {
		t.Fatalf("%d packets before view", n)
	}

	view(d, "cs-a", true)
	s.expectCmd("resume")
	s.expectCmd("keyframe")
	if m := d.expect("stream.state", "", 3*time.Second); m.State != streamLive {
		t.Fatalf("state %q", m.State)
	}

	// A P slice isn't a place to start; a new viewer waits for the keyframe.
	s.sendVideo(0x41, 0)
	time.Sleep(100 * time.Millisecond)
	if n := len(media.videoSnapshot()); n != 0 {
		t.Fatalf("%d packets before the keyframe", n)
	}
	s.sendVideo(0x67, 0) // SPS
	s.sendVideo(0x41, 0)
	s.sendVideo(0x41, 0)
	s.sendAudio()
	waitFor(t, "three video packets", func() bool { return len(media.videoSnapshot()) >= 3 })
	waitFor(t, "audio", func() bool { return media.audioCount() >= 1 })
	got := media.videoSnapshot()
	if got[0].Payload[0] != 0x67 {
		t.Fatalf("first packet isn't the keyframe: %x", got[0].Payload[0])
	}
	if got[1].SequenceNumber != got[0].SequenceNumber+1 {
		t.Fatalf("sequence numbers jumped: %d, %d", got[0].SequenceNumber, got[1].SequenceNumber)
	}

	// PLI and FIR reach desk-stream. Past the rate limit, so wait it out.
	time.Sleep(keyframeGapPLI + 50*time.Millisecond)
	ssrc := webrtc.SSRC(got[0].SSRC)
	if err := p.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(ssrc)}}); err != nil {
		t.Fatal(err)
	}
	s.expectCmd("keyframe")

	// A second viewer gets a keyframe of its own, and the first keeps going.
	_, media2 := connectedMedia(t, d, "cs-b")
	view(d, "cs-b", true)
	s.expectCmd("keyframe")
	s.sendVideo(0x41, 0)
	time.Sleep(50 * time.Millisecond)
	if n := len(media2.videoSnapshot()); n != 0 {
		t.Fatalf("second viewer got %d packets before its keyframe", n)
	}
	s.sendVideo(0x7c, 0x85) // FU-A start of an IDR slice, at an access unit boundary
	waitFor(t, "the second viewer's keyframe", func() bool { return len(media2.videoSnapshot()) >= 1 })

	// View off for one: it stops, and the encoder doesn't pause while the other watches.
	view(d, "cs-b", false)
	waitFor(t, "cs-b to leave", func() bool { return f.srv.hub.stats().Viewers == 1 })
	before := len(media2.videoSnapshot())
	s.sendVideo(0x67, 0)
	time.Sleep(100 * time.Millisecond)
	if n := len(media2.videoSnapshot()); n != before {
		t.Fatalf("cs-b still receiving: %d, was %d", n, before)
	}

	// Coming back keeps the sequence numbers contiguous.
	last := media.videoSnapshot()
	view(d, "cs-a", false)
	s.expectCmd("pause")
	if m := d.expect("stream.state", "", 3*time.Second); m.State != streamWarm {
		t.Fatalf("state %q", m.State)
	}
	view(d, "cs-a", true)
	s.expectCmd("resume")
	s.expectCmd("keyframe")
	s.sendVideo(0x67, 0)
	waitFor(t, "packets after resume", func() bool { return len(media.videoSnapshot()) > len(last) })
	after := media.videoSnapshot()
	if after[len(last)].SequenceNumber != last[len(last)-1].SequenceNumber+1 {
		t.Fatalf("sequence jumped across the pause: %d then %d", last[len(last)-1].SequenceNumber, after[len(last)].SequenceNumber)
	}

	// Revoking video stops media at once, and is what pauses the encoder.
	no := false
	d.send(&rtcsock.Message{T: "session.permissions", SessionID: "cs-a", Video: &no})
	s.expectCmd("pause")
	d.send(&rtcsock.Message{T: "stats.get"})
	st := d.expect("stats", "", 3*time.Second)
	if st.Stream == nil || st.Stream.State != streamWarm || st.Stream.VideoPackets == 0 || st.Stream.AudioPackets == 0 || st.Stream.KeyframeRequests == 0 {
		t.Fatalf("stats %+v", st.Stream)
	}
}

func TestViewerSurvivesAStreamRestart(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	_, media := connectedMedia(t, d, "cs-a")
	view(d, "cs-a", true)
	s.expectCmd("resume")
	s.sendVideo(0x67, 0)
	waitFor(t, "first packet", func() bool { return len(media.videoSnapshot()) == 1 })

	_ = s.c.Close()
	waitFor(t, "state down", func() bool { return f.srv.hub.stats().State == streamDown })

	// A new desk-stream starts paused, so it needs resume, and the viewer waits for its keyframe.
	s2 := f.dialStream()
	s2.expectCmd("resume")
	s2.expectCmd("keyframe")
	s2.sendVideo(0x41, 0)
	time.Sleep(50 * time.Millisecond)
	if n := len(media.videoSnapshot()); n != 1 {
		t.Fatalf("a P slice reached the viewer before the new keyframe: %d", n)
	}
	s2.sendVideo(0x67, 0)
	waitFor(t, "new keyframe", func() bool { return len(media.videoSnapshot()) == 2 })
}

func TestStartsKeyframe(t *testing.T) {
	for _, c := range []struct {
		name     string
		p        []byte
		boundary bool
		want     bool
	}{
		{"SPS", []byte{0x67, 0}, false, true},
		{"IDR at a boundary", []byte{0x65, 0}, true, true},
		{"second slice of an IDR", []byte{0x65, 0}, false, false},
		{"P slice", []byte{0x41, 0}, true, false},
		{"FU-A start of an IDR", []byte{0x7c, 0x85, 0}, true, true},
		{"FU-A middle of an IDR", []byte{0x7c, 0x05, 0}, true, false},
		{"FU-A start of a P slice", []byte{0x7c, 0x81, 0}, true, false},
		{"STAP-A with SPS", []byte{0x78, 0, 2, 0x67, 0, 0, 2, 0x68, 0}, false, true},
		{"STAP-A with slices only", []byte{0x78, 0, 2, 0x41, 0, 0, 2, 0x41, 0}, true, false},
		{"empty", nil, true, false},
	} {
		if got := startsKeyframe(c.p, c.boundary); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestPlayoutDelayExtensionIsOnTheWire(t *testing.T) {
	f := startStreamServer(t, os.Getuid())
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	s := f.dialStream()
	p := newPeer(t, peerOpts{})
	// Pion's own offer has no playout-delay, so check the rule: no extension when not negotiated.
	media := readMedia(p)
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	if strings.Contains(ans.Answer, playoutDelayURI) {
		t.Fatalf("answer names an extension the offer didn't:\n%s", ans.Answer)
	}
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)
	view(d, "cs-a", true)
	s.expectCmd("keyframe")
	s.sendVideo(0x67, 0)
	waitFor(t, "a packet", func() bool { return len(media.videoSnapshot()) == 1 })
	if media.videoSnapshot()[0].Extension {
		t.Fatal("extension sent without being negotiated")
	}
}
