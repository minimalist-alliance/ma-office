package rtcserver

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/frame"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/testrelay"
)

const docIP = "198.51.100.7"

type fixture struct {
	t    *testing.T
	srv  *Server
	sock string
	port int
}

func freePort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		l, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := l.Addr().(*net.TCPAddr).Port
		_ = l.Close()
		u, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
		if err == nil {
			_ = u.Close()

			return port
		}
	}
	t.Fatal("no free port")

	return 0
}

func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "drtc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	return dir
}

func startServer(t *testing.T, consent time.Duration) *fixture {
	t.Helper()

	return startServerWith(t, consent, nil)
}

// startServerWith lets a test change the Config before the server starts.
func startServerWith(t *testing.T, consent time.Duration, edit func(*Config)) *fixture {
	t.Helper()
	dir := shortDir(t)
	f := &fixture{t: t, sock: filepath.Join(dir, "rtc.sock"), port: freePort(t)}
	cfg := Config{
		SocketPath:     f.sock,
		DataDir:        filepath.Join(dir, "rtc"),
		Bind:           "127.0.0.1",
		Port:           f.port,
		ConsentTimeout: consent,
		Version:        "test",
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if edit != nil {
		edit(&cfg)
	}
	srv, err := New(cfg)
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

	return f
}

// fakeDeskd is a test's end of rtc.sock.
type fakeDeskd struct {
	t      *testing.T
	c      *rtcsock.Client
	msgs   chan *rtcsock.Message
	frames chan dataFrame
	ended  chan error
}

type dataFrame struct {
	handle  uint32
	channel uint8
	frame   []byte
}

func (f *fixture) deskd() *fakeDeskd {
	f.t.Helper()
	c, err := rtcsock.Dial(context.Background(), f.sock)
	if err != nil {
		f.t.Fatal(err)
	}
	d := &fakeDeskd{
		t: f.t, c: c,
		msgs:   make(chan *rtcsock.Message, 256),
		frames: make(chan dataFrame, 256),
		ended:  make(chan error, 1),
	}
	go func() {
		d.ended <- c.Run(func(m *rtcsock.Message) { d.msgs <- m }, func(h uint32, ch uint8, b []byte) {
			d.frames <- dataFrame{h, ch, append([]byte(nil), b...)}
			_ = c.Grant(h, ch, uint32(len(b)))
		})
	}()
	f.t.Cleanup(func() { _ = c.Close() })

	return d
}

func (d *fakeDeskd) send(m *rtcsock.Message) {
	d.t.Helper()
	if err := d.c.Send(m); err != nil {
		d.t.Fatal(err)
	}
}

// expect waits for a message of type t (any type when empty) on the session (any session when id is empty), skipping
// others.
func (d *fakeDeskd) expect(typ, id string, timeout time.Duration) *rtcsock.Message {
	d.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case m := <-d.msgs:
			if (typ == "" || m.T == typ) && (id == "" || m.SessionID == id) {
				return m
			}
		case <-deadline:
			d.t.Fatalf("no %s for %q within %v", typ, id, timeout)
		}
	}
}

func (d *fakeDeskd) configure(ip string, maxSessions int) *rtcsock.Message {
	d.t.Helper()
	d.send(&rtcsock.Message{T: "configure", PublicIPv4: ip, MaxSessions: maxSessions})

	return d.expect("configured", "", 3*time.Second)
}

// peer is a Pion client shaped like the Desk app.
type peer struct {
	t        *testing.T
	pc       *webrtc.PeerConnection
	channels [rtcsock.NumChannels]*webrtc.DataChannel
	allOpen  chan struct{}
	offer    string
	fp       string
	recv     chan dataFrame
}

type peerOpts struct {
	vp8Only bool
	// playoutDelay offers the playout-delay extension, as Chrome does.
	playoutDelay bool
	// dataOnly offers no audio or video section, as a Guild Desk's client may (guild.go).
	dataOnly bool
	// noRead is a client that never reads its channels, with a 64 KiB SCTP window: a member whose link or tab has
	// stalled, so what the desk sends it stays unacknowledged.
	noRead bool
	// tcpOnly is a client whose network blocks UDP: ICE over TCP only (shared_test.go).
	tcpOnly bool
}

func newPeer(t *testing.T, opts peerOpts) *peer {
	t.Helper()
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	if opts.tcpOnly {
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	}
	if opts.noRead {
		se.DetachDataChannels()
		se.SetSCTPMaxReceiveBufferSize(64 * 1024)
	}
	me := &webrtc.MediaEngine{}
	if opts.vp8Only {
		if err := me.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			PayloadType:        111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			t.Fatal(err)
		}
		if err := me.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
			PayloadType:        96,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			t.Fatal(err)
		}
	} else if err := me.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if opts.playoutDelay {
		if err := me.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: playoutDelayURI}, webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverDirectionRecvonly); err != nil {
			t.Fatal(err)
		}
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me)).NewPeerConnection(webrtc.Configuration{
		BundlePolicy: webrtc.BundlePolicyMaxBundle, RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	p := &peer{t: t, pc: pc, allOpen: make(chan struct{}), recv: make(chan dataFrame, 256)}
	var opened atomic.Int32
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if opts.dataOnly {
			break
		}
		if _, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
	}
	for i := range rtcsock.Channels {
		def := &rtcsock.Channels[i]
		negotiated, ordered, id := true, def.Ordered, uint16(def.ID)
		dc, err := pc.CreateDataChannel(def.Label, &webrtc.DataChannelInit{
			Ordered: &ordered, MaxRetransmits: def.MaxRetransmits, Negotiated: &negotiated, ID: &id,
		})
		if err != nil {
			t.Fatal(err)
		}
		p.channels[def.ID] = dc
		channel := def.ID
		if !opts.noRead {
			dc.OnMessage(func(m webrtc.DataChannelMessage) {
				select {
				case p.recv <- dataFrame{0, channel, m.Data}:
				default:
				}
			})
		}
		dc.OnOpen(func() {
			if opened.Add(1) == rtcsock.NumChannels {
				close(p.allOpen)
			}
		})
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	p.offer = offer.SDP
	for _, l := range strings.Split(offer.SDP, "\r\n") {
		if v, ok := strings.CutPrefix(l, "a=fingerprint:sha-256 "); ok {
			p.fp = strings.ToLower(strings.ReplaceAll(v, ":", ""))
		}
	}
	if len(p.fp) != 64 {
		t.Fatalf("no fingerprint in the offer: %q", p.fp)
	}

	return p
}

func (p *peer) answer(sdp string) {
	p.t.Helper()
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		p.t.Fatal(err)
	}
}

func (p *peer) waitOpen(timeout time.Duration) {
	p.t.Helper()
	select {
	case <-p.allOpen:
	case <-time.After(timeout):
		p.t.Fatalf("channels didn't open: ICE %s, connection %s", p.pc.ICEConnectionState(), p.pc.ConnectionState())
	}
}

func createMsg(id string, p *peer) *rtcsock.Message {
	return &rtcsock.Message{
		T: "session.create", SessionID: id, Offer: p.offer, ExpectedFingerprint: p.fp,
		Permissions: &rtcsock.Permissions{Video: true, Input: true},
	}
}

// connected creates a session and waits for its channels.
func connected(t *testing.T, d *fakeDeskd, id string) (*peer, *rtcsock.Message) {
	t.Helper()
	p := newPeer(t, peerOpts{})
	d.send(createMsg(id, p))
	ans := d.expect("session.answer", id, 5*time.Second)
	p.answer(ans.Answer)
	p.waitOpen(10 * time.Second)

	return p, ans
}

func TestNotConfigured(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	m := d.expect("session.error", "cs-a", 3*time.Second)
	if m.CodeString() != rtcsock.CodeNotConfigured {
		t.Fatalf("code %v", m.Code)
	}
}

func TestConfigured(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()

	d.send(&rtcsock.Message{T: "configure", PublicIPv4: "not an ip"})
	if m := d.expect("error", "", 3*time.Second); m.CodeString() != "bad_request" {
		t.Fatalf("code %v", m.Code)
	}

	m := d.configure(docIP, 4)
	if len(m.FingerprintsSha256) != 1 || m.FingerprintsSha256[0] != f.srv.Fingerprint() {
		t.Fatalf("fingerprints %v, want %s", m.FingerprintsSha256, f.srv.Fingerprint())
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(m.FingerprintsSha256[0]) {
		t.Fatalf("not 64 lowercase hex: %s", m.FingerprintsSha256[0])
	}
	if m.Version != "test" {
		t.Fatalf("version %q", m.Version)
	}
	if _, err := time.Parse(time.RFC3339, m.NotAfter); err != nil {
		t.Fatalf("notAfter %q: %v", m.NotAfter, err)
	}
}

func sectionsOf(sdp string) []string {
	parts := strings.Split(sdp, "\r\nm=")
	for i := 1; i < len(parts); i++ {
		parts[i] = "m=" + parts[i]
	}

	return parts
}

func TestAnswerShape(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure(docIP, 4)
	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	m := d.expect("session.answer", "cs-a", 5*time.Second)
	if m.Handle == 0 {
		t.Fatal("no handle")
	}

	sections := sectionsOf(m.Answer)
	session, audio, video, data := sections[0], sections[1], sections[2], sections[3]
	if !strings.Contains(session, "a=ice-lite") {
		t.Errorf("no a=ice-lite:\n%s", session)
	}
	if !strings.Contains(session, "a=group:BUNDLE 0 1 2") {
		t.Errorf("BUNDLE:\n%s", session)
	}
	for name, s := range map[string]string{"audio": audio, "video": video} {
		if !strings.Contains(s, "a=sendonly") {
			t.Errorf("%s isn't sendonly:\n%s", name, s)
		}
		if strings.HasPrefix(s, "m="+name+" 0 ") {
			t.Errorf("%s has port 0:\n%s", name, s)
		}
		if !strings.Contains(s, "a=msid:desk-"+name+" "+name) {
			t.Errorf("%s isn't track %s in stream desk-%s:\n%s", name, name, name, s)
		}
	}
	if !strings.Contains(data, "a=max-message-size:16384") {
		t.Errorf("max-message-size:\n%s", data)
	}

	var candidates []string
	for _, l := range strings.Split(m.Answer, "\r\n") {
		if strings.HasPrefix(l, "a=candidate:") {
			candidates = append(candidates, l)
		}
	}
	if len(candidates) != 2 {
		t.Fatalf("want exactly 2 candidates, got %d:\n%s", len(candidates), strings.Join(candidates, "\n"))
	}
	var sawUDP, sawTCP bool
	for _, c := range candidates {
		fields := strings.Fields(c)
		if fields[4] != docIP || fields[5] != strconv.Itoa(f.port) || fields[7] != "host" {
			t.Errorf("candidate %q: want host on %s:%d", c, docIP, f.port)
		}
		switch strings.ToLower(fields[2]) {
		case "udp":
			sawUDP = true
		case "tcp":
			sawTCP = strings.Contains(c, "tcptype passive")
		}
	}
	if !sawUDP || !sawTCP {
		t.Errorf("want one udp and one passive tcp candidate:\n%s", strings.Join(candidates, "\n"))
	}
}

func TestNoSharedVideoCodecRejectsVideoOnly(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p := newPeer(t, peerOpts{vp8Only: true})
	d.send(createMsg("cs-a", p))
	m := d.expect("session.answer", "cs-a", 5*time.Second)

	sections := sectionsOf(m.Answer)
	audio, video := sections[1], sections[2]
	if !strings.HasPrefix(video, "m=video 0 ") {
		t.Errorf("video isn't rejected:\n%s", video)
	}
	if strings.HasPrefix(audio, "m=audio 0 ") || !strings.Contains(audio, "a=sendonly") {
		t.Errorf("audio must stay, sendonly:\n%s", audio)
	}
	if strings.Contains(strings.ToLower(m.Answer), "h264") {
		t.Errorf("answer names a codec the offer didn't:\n%s", m.Answer)
	}
	p.answer(m.Answer)
	p.waitOpen(10 * time.Second)
}

func TestSessionLimit(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 10) // clamped to the contract's 4
	for i := 0; i < 4; i++ {
		p := newPeer(t, peerOpts{})
		id := fmt.Sprintf("cs-%d", i)
		d.send(createMsg(id, p))
		d.expect("session.answer", id, 5*time.Second)
	}
	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-5th", p))
	if m := d.expect("session.error", "cs-5th", 3*time.Second); m.CodeString() != rtcsock.CodeSessionLimitReached {
		t.Fatalf("code %v", m.Code)
	}

	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-0", Reason: "closed_by_desk"})
	if m := d.expect("session.closed", "cs-0", 5*time.Second); m.Reason != "closed_by_desk" {
		t.Fatalf("reason %q", m.Reason)
	}
	d.send(createMsg("cs-5th", p))
	d.expect("session.answer", "cs-5th", 5*time.Second)
}

func TestIdentityMismatchAllocatesNothing(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 1)
	p := newPeer(t, peerOpts{})
	msg := createMsg("cs-a", p)
	msg.ExpectedFingerprint = strings.Repeat("ab", 32)
	d.send(msg)
	if m := d.expect("session.error", "cs-a", 3*time.Second); m.CodeString() != rtcsock.CodeIdentityMismatch {
		t.Fatalf("code %v", m.Code)
	}
	// With a limit of 1, the refused offer must not have taken the slot.
	d.send(createMsg("cs-b", p))
	d.expect("session.answer", "cs-b", 5*time.Second)
}

func TestDataBridgeBothWaysAndStats(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p, ans := connected(t, d, "cs-a")
	state := d.expect("session.state", "cs-a", 5*time.Second)
	if state.State != "connected" || state.Transport != "udp" {
		t.Fatalf("state %+v", state)
	}

	for _, ch := range []uint8{rtcsock.ChCtl, rtcsock.ChRPC, rtcsock.ChCollab, rtcsock.ChMdoc, rtcsock.ChBulk} {
		out := frame.Encode(frame.Req, 0, uint32(ch), 0, []byte("client-to-desk"))
		if err := p.channels[ch].Send(out); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-d.frames:
			if got.handle != ans.Handle || got.channel != ch || string(got.frame) != string(out) {
				t.Fatalf("channel %d: got %+v", ch, got)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("channel %d: nothing reached deskd", ch)
		}
	}
	for _, ch := range []uint8{rtcsock.ChCtl, rtcsock.ChRPC, rtcsock.ChEvents, rtcsock.ChCollab, rtcsock.ChMdoc, rtcsock.ChBulk} {
		out := frame.Encode(frame.Res, 0, uint32(ch), 0, []byte("desk-to-client"))
		if err := d.c.SendData(context.Background(), ans.Handle, ch, out); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-p.recv:
			if got.channel != ch || string(got.frame) != string(out) {
				t.Fatalf("channel %d: got %+v", ch, got)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("channel %d: nothing reached the client", ch)
		}
	}

	// events is desk to client only: a client's frame stops at desk-rtc.
	if err := p.channels[rtcsock.ChEvents].Send([]byte("wrong way")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-d.frames:
		t.Fatalf("events frame reached deskd: %+v", got)
	case <-time.After(200 * time.Millisecond):
	}

	// SCTP's round-trip estimate needs some traffic to settle.
	time.Sleep(200 * time.Millisecond)
	d.send(&rtcsock.Message{T: "stats.get"})
	m := d.expect("stats", "", 3*time.Second)
	if len(m.Sessions) != 1 || m.Sessions[0].SessionID != "cs-a" {
		t.Fatalf("sessions %+v", m.Sessions)
	}
	row := m.Sessions[0]
	if row.Transport != "udp" || row.BytesSent == 0 || row.BytesReceived == 0 {
		t.Fatalf("row %+v", row)
	}
	if row.RTTMs <= 0 || row.RTTMs > 1000 {
		t.Fatalf("rttMs %v", row.RTTMs)
	}
	if m.PeerBytesSent == nil || *m.PeerBytesSent != 0 {
		t.Fatalf("peerBytesSent %v", m.PeerBytesSent)
	}
}

func TestInputIsCountedAndNeverReachesDeskd(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p, _ := connected(t, d, "cs-a")

	send := func() {
		move := make([]byte, 16)
		move[0] = 1
		key := make([]byte, 16)
		key[0], key[1], key[15] = 4, 1, 'a'
		if err := p.channels[rtcsock.ChInput].Send(move); err != nil {
			t.Fatal(err)
		}
		if err := p.channels[rtcsock.ChKeys].Send(key); err != nil {
			t.Fatal(err)
		}
	}
	// A malformed event is dropped, and isn't activity.
	if err := p.channels[rtcsock.ChKeys].Send([]byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	// Neither is an event on the wrong channel.
	if err := p.channels[rtcsock.ChInput].Send(append([]byte{4}, make([]byte, 15)...)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	select {
	case m := <-d.msgs:
		if m.T == "input.activity" {
			t.Fatal("input.activity from a malformed event")
		}
	default:
	}
	send()
	if m := d.expect("input.activity", "cs-a", 3*time.Second); m.At == "" {
		t.Fatal("input.activity has no time")
	}
	// The limit is once a second, so a burst brings no second report.
	send()
	select {
	case m := <-d.msgs:
		if m.T == "input.activity" {
			t.Fatal("second input.activity inside a second")
		}
	case <-time.After(150 * time.Millisecond):
	}
	select {
	case got := <-d.frames:
		t.Fatalf("input reached deskd: %+v", got)
	default:
	}

	// session.permissions takes effect at once.
	no := false
	d.send(&rtcsock.Message{T: "session.permissions", SessionID: "cs-a", Input: &no})
	time.Sleep(1200 * time.Millisecond)
	for {
		select {
		case <-d.msgs:
			continue
		default:
		}

		break
	}
	send()
	deadline := time.After(300 * time.Millisecond)
	for {
		select {
		case m := <-d.msgs:
			if m.T == "input.activity" {
				t.Fatal("input.activity after input was revoked")
			}
		case <-deadline:
			d.send(&rtcsock.Message{T: "stats.get"})
			st := d.expect("stats", "", 3*time.Second)
			if st.Sessions[0].KeysDropped == 0 {
				t.Fatalf("keys not counted: %+v", st.Sessions[0])
			}

			return
		}
	}
}

func TestCloseDeliversAQueuedCtlFrameFirst(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p, ans := connected(t, d, "cs-a")

	closeFrame := frame.Encode(frame.Close, 0, 0, 0, []byte(`{"code":4401,"reason":"revoked"}`))
	if err := d.c.SendData(context.Background(), ans.Handle, rtcsock.ChCtl, closeFrame); err != nil {
		t.Fatal(err)
	}
	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a", Code: 4401, Reason: "revoked"})

	select {
	case got := <-p.recv:
		if string(got.frame) != string(closeFrame) {
			t.Fatalf("got %q", got.frame)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("CLOSE didn't reach the client")
	}
	if m := d.expect("session.closed", "cs-a", 5*time.Second); m.Reason != "revoked" {
		t.Fatalf("reason %q", m.Reason)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-gone", Reason: "closed_by_desk"})
	d.expect("session.closed", "cs-gone", 3*time.Second)
}

func TestCreditViolationClosesTheSession(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	// No client, so nothing drains: the window can only be overrun.
	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)

	big := make([]byte, rtcsock.MaxFrame)
	for i := 0; i <= rtcsock.InitialCredit/len(big); i++ {
		// Bypasses the client's own credit check on purpose.
		if err := d.c.RawWrite(rtcsock.EncodeData(ans.Handle, rtcsock.ChBulk, big)); err != nil {
			t.Fatal(err)
		}
	}
	if m := d.expect("session.closed", "cs-a", 5*time.Second); m.Reason != reasonCreditViolation {
		t.Fatalf("reason %q", m.Reason)
	}
}

func TestLinkDropClosesSessionsWithin5s(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p, _ := connected(t, d, "cs-a")

	closed := make(chan struct{})
	var once sync.Once
	p.pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateClosed || s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateDisconnected {
			once.Do(func() { close(closed) })
		}
	})
	start := time.Now()
	_ = d.c.Close()
	select {
	case <-closed:
		t.Logf("client saw the close after %v", time.Since(start))
	case <-time.After(5 * time.Second):
		t.Fatal("session still up 5 s after rtc.sock dropped")
	}

	// The server takes a new client and starts it unconfigured.
	d2 := f.deskd()
	p2 := newPeer(t, peerOpts{})
	d2.send(createMsg("cs-b", p2))
	if m := d2.expect("session.error", "cs-b", 3*time.Second); m.CodeString() != rtcsock.CodeNotConfigured {
		t.Fatalf("code %v", m.Code)
	}
}

func TestNewConnectionReplacesTheOld(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d1 := f.deskd()
	d1.configure("127.0.0.1", 4)
	p := newPeer(t, peerOpts{})
	d1.send(createMsg("cs-a", p))
	d1.expect("session.answer", "cs-a", 5*time.Second)

	d2 := f.deskd()
	select {
	case err := <-d1.ended:
		if err == nil {
			t.Fatal("want a read error on the replaced connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the old connection wasn't closed")
	}
	d2.configure("127.0.0.1", 1)
	// With a limit of 1, the old session must have been closed.
	d2.send(createMsg("cs-a", p))
	d2.expect("session.answer", "cs-a", 5*time.Second)
}

func TestConsentTimeoutClosesASilentClient(t *testing.T) {
	const consent = 3 * time.Second
	f := startServer(t, consent)
	d := f.deskd()
	d.configure("127.0.0.1", 4)

	relay, err := testrelay.New(&net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: f.port}, testrelay.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(relay.Close)

	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	p.answer(testrelay.RewriteAnswer(ans.Answer, relay.Port()))
	p.waitOpen(10 * time.Second)
	d.expect("session.state", "cs-a", 5*time.Second)

	// While the client answers, a session outlives the timeout.
	time.Sleep(consent + time.Second)
	d.send(&rtcsock.Message{T: "stats.get"})
	if st := d.expect("stats", "", 3*time.Second); len(st.Sessions) != 1 {
		t.Fatalf("live session was closed: %+v", st)
	}

	relay.Cut(true)
	start := time.Now()
	d.expect("session.state", "cs-a", consent+2*time.Second) // disconnected
	m := d.expect("session.closed", "cs-a", consent+5*time.Second)
	if m.Reason != reasonConsentTimeout {
		t.Fatalf("reason %q", m.Reason)
	}
	// The clock starts at the client's last packet, which can be up to its 2 s keepalive before the cut.
	took := time.Since(start)
	t.Logf("closed %v after the client went silent", took)
	if took > consent+time.Second {
		t.Fatalf("closed too late: %v", took)
	}
}

func stunRequest(t *testing.T, username string, password string) []byte {
	t.Helper()
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest,
		stun.NewUsername(username), stun.NewShortTermIntegrity(password), stun.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}

	return msg.Raw
}

func udpGetsReply(t *testing.T, port int, pkt []byte) bool {
	t.Helper()
	c, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write(pkt); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	buf := make([]byte, 1500)
	_, err = c.Read(buf)

	return err == nil
}

// tcpProbe sends one framed packet and reports what the desk does with it.
func tcpProbe(t *testing.T, port int, pkt []byte) (reply, closed bool) {
	t.Helper()
	c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	framed := append([]byte{byte(len(pkt) >> 8), byte(len(pkt))}, pkt...)
	if _, err := c.Write(framed); err != nil {
		return false, true
	}
	_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 1500)
	n, err := c.Read(buf)
	var ne net.Error
	switch {
	case n > 0:
		return true, false
	case errors.As(err, &ne) && ne.Timeout():
		return false, false
	default:
		return false, true
	}
}

func TestSTUNAnsweredOnlyForCreatedSessions(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)

	unknown := stunRequest(t, "nosuchufrag:client", "whatever")
	if udpGetsReply(t, f.port, unknown) {
		t.Fatal("UDP: answered STUN with no sessions at all")
	}
	if reply, closed := tcpProbe(t, f.port, unknown); reply || !closed {
		t.Fatalf("TCP: unknown ufrag: reply=%v closed=%v, want the connection dropped", reply, closed)
	}
	if reply, closed := tcpProbe(t, f.port, []byte("GET / HTTP/1.1\r\n\r\n")); reply || !closed {
		t.Fatalf("TCP: non-STUN: reply=%v closed=%v", reply, closed)
	}
	f.srv.tcpMux.mu.RLock()
	allocated := len(f.srv.tcpMux.ufrags)
	f.srv.tcpMux.mu.RUnlock()
	if allocated != 0 {
		t.Fatalf("%d ufrags registered with no sessions", allocated)
	}

	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)

	var ufrag, pwd string
	for _, l := range strings.Split(ans.Answer, "\r\n") {
		if v, ok := strings.CutPrefix(l, "a=ice-ufrag:"); ok {
			ufrag = v
		}
		if v, ok := strings.CutPrefix(l, "a=ice-pwd:"); ok {
			pwd = v
		}
	}
	remoteUfrag := ""
	for _, l := range strings.Split(p.offer, "\r\n") {
		if v, ok := strings.CutPrefix(l, "a=ice-ufrag:"); ok {
			remoteUfrag = v
		}
	}
	username := ufrag + ":" + remoteUfrag

	// A real ufrag with a wrong password: MESSAGE-INTEGRITY fails, so no answer.
	if udpGetsReply(t, f.port, stunRequest(t, username, "wrong-password-wrong-password-xx")) {
		t.Fatal("UDP: answered STUN with bad integrity")
	}
	// The control: the right password does get an answer, so the checks above can fail.
	if !udpGetsReply(t, f.port, withICEAttrs(t, username, pwd)) {
		t.Fatal("UDP: no answer to a correct binding request for a created session")
	}

	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a", Reason: "closed_by_desk"})
	d.expect("session.closed", "cs-a", 5*time.Second)
	if udpGetsReply(t, f.port, withICEAttrs(t, username, pwd)) {
		t.Fatal("UDP: still answering after the session closed")
	}
}

// withICEAttrs builds a binding request as a controlling ICE agent would.
func withICEAttrs(t *testing.T, username, pwd string) []byte {
	t.Helper()
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest,
		stun.NewUsername(username),
		ice.AttrControlling(1),
		ice.PriorityAttr(1<<24),
		stun.NewShortTermIntegrity(pwd),
		stun.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}

	return msg.Raw
}

type chunkReader struct {
	chunks [][]byte
	done   chan struct{}
}

func (r *chunkReader) Read(b []byte) (int, error) {
	if len(r.chunks) == 0 {
		<-r.done

		return 0, io.EOF
	}
	n := copy(b, r.chunks[0])
	r.chunks = r.chunks[1:]

	return n, nil
}

func TestOversizeClientFrameClosesTheSession(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	f.srv.mu.Lock()
	l := f.srv.cur
	f.srv.mu.Unlock()

	expected, _ := hex.DecodeString(strings.Repeat("ab", 32))
	s := newSession(l, "cs-big", 99, expected, rtcsock.Permissions{})
	l.mu.Lock()
	l.sessions[s.id] = s
	l.byHandle[s.handle] = s
	l.mu.Unlock()

	r := &chunkReader{chunks: [][]byte{make([]byte, rtcsock.MaxFrame+1)}, done: make(chan struct{})}
	defer close(r.done)
	go s.readChannel(rtcsock.ChRPC, r)
	if m := d.expect("session.closed", "cs-big", 3*time.Second); m.Reason != reasonFrameTooLarge {
		t.Fatalf("reason %q", m.Reason)
	}
}
