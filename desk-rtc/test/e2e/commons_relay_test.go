package e2e

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// The 443 voice relay against the real Commons (apps/commons/server, built here from the same tree): a member's voice
// connection reaches Commons only through desk-rtc's port, as when their network blocks UDP 8791 and up. Commons answers
// only its live ufrags with the right password (its gate, gate.go), and desk-rtc makes a mapping only on that answer
// (Security's GDS-1).

var (
	commonsOnce sync.Once
	commonsBin  string
	commonsErr  error
)

func buildCommons(t *testing.T) string {
	t.Helper()
	src, _ := filepath.Abs("../../../apps/commons/server")
	if _, err := os.Stat(filepath.Join(src, "go.mod")); err != nil {
		t.Skipf("no Commons source at %s", src)
	}
	commonsOnce.Do(func() {
		commonsBin = filepath.Join(binDir, "commons-server")
		cmd := exec.Command("go", "build", "-p", "1", "-o", commonsBin, "./cmd/commons-server")
		cmd.Dir = src
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			commonsErr = fmt.Errorf("build commons-server: %v\n%s", err, out)
		}
	})
	if commonsErr != nil {
		t.Fatal(commonsErr)
	}

	return commonsBin
}

// record is one of Commons' room-link records: [type u8][length u32 LE][payload]. Type 1 is JSON.
func ctrlRecord(v any) []byte {
	body, _ := json.Marshal(v)
	out := []byte{1, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(out[1:], uint32(len(body)))

	return append(out, body...)
}

// readCtrl waits for a JSON record with t == want on the room link.
func readCtrl(t *testing.T, ws *websocket.Conn, want string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for %s: %v", want, err)
		}
		for len(msg) >= 5 {
			n := int(binary.LittleEndian.Uint32(msg[1:5]))
			if 5+n > len(msg) {
				break
			}
			if msg[0] == 1 {
				var m map[string]any
				if json.Unmarshal(msg[5:5+n], &m) == nil {
					if m["t"] == want {
						return m
					}
					if m["t"] == "error" {
						t.Fatalf("Commons: %v", m)
					}
				}
			}
			msg = msg[5+n:]
		}
	}
}

var relayCandRe = regexp.MustCompile(`(?m)^a=candidate:\S+ \d+ (\w+) \d+ \S+ (\d+) typ host.*$`)

// onlyPort keeps the answer's candidates on one transport and port: the member's network blocks the rest.
func onlyPort(answer, transport string, port int) string {
	var out []string
	for _, l := range strings.Split(answer, "\r\n") {
		if m := relayCandRe.FindStringSubmatch(l); m != nil && (strings.ToLower(m[1]) != transport || m[2] != strconv.Itoa(port)) {
			continue
		}
		out = append(out, l)
	}

	return strings.Join(out, "\r\n")
}

func TestVoiceThroughDeskRtcToTheRealCommons(t *testing.T) {
	for _, transport := range []string{"udp", "tcp"} {
		t.Run(transport, func(t *testing.T) { voiceThroughRelay(t, transport) })
	}
}

func voiceThroughRelay(t *testing.T, transport string) {
	commons := buildCommons(t)
	dir := t.TempDir()
	s := &stack{t: t, logs: map[string]*lockedBuffer{}}
	rtcPort, relayPort, httpPort, voicePort := freePort(t), freePort(t), freePort(t), freePort(t)
	relay := net.JoinHostPort("127.0.0.1", strconv.Itoa(relayPort))
	sock := filepath.Join(dir, "rtc.sock")
	s.start("desk-rtc", "--socket", sock, "--data-dir", filepath.Join(dir, "rtc"), "--bind", "127.0.0.1",
		"--port", strconv.Itoa(rtcPort), "--guild-voice-relay", relay)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	deskd, err := rtcsock.DialRetry(ctx, sock)
	if err != nil {
		t.Fatal(err)
	}
	defer deskd.Close()
	msgs := make(chan *rtcsock.Message, 64)
	go func() { _ = deskd.Run(func(m *rtcsock.Message) { msgs <- m }, func(uint32, uint8, []byte) {}) }()
	expect := func(typ string) *rtcsock.Message {
		t.Helper()
		for {
			select {
			case m := <-msgs:
				if m.T == typ {
					return m
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("no %s", typ)
			}
		}
	}
	if err := deskd.Send(&rtcsock.Message{T: "configure", PublicIPv4: "127.0.0.1", DeskKind: rtcsock.DeskKindGuild}); err != nil {
		t.Fatal(err)
	}
	expect("configured")
	relayStats := func() *rtcsock.VoiceRelayStats {
		t.Helper()
		if err := deskd.Send(&rtcsock.Message{T: "stats.get"}); err != nil {
			t.Fatal(err)
		}
		m := expect("stats")
		if m.VoiceRelay == nil {
			t.Fatal("no voiceRelay in a Guild Desk's stats")
		}

		return m.VoiceRelay
	}

	data := filepath.Join(dir, "commons")
	_ = os.MkdirAll(data, 0o700)
	c := exec.Command(commons, "-dev", "-addr", net.JoinHostPort("127.0.0.1", strconv.Itoa(httpPort)), "-data", data,
		"-udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(voicePort)), "-advertise", "127.0.0.1", "-udp-sockets", "1",
		"-ice-relay", relay, "-ice-relay-port", strconv.Itoa(rtcPort), "-stats=false")
	log := &lockedBuffer{}
	c.Stdout, c.Stderr = log, log
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Process.Kill(); _ = c.Wait() })
	var ws *websocket.Conn
	for i := 0; ; i++ {
		ws, _, err = websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?name=Tester", httpPort), nil)
		if err == nil {
			break
		}
		if i > 100 {
			t.Fatalf("Commons didn't start: %v\n%s", err, log)
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer ws.CloseNow()
	ws.SetReadLimit(32 << 20)
	send := func(v any) {
		t.Helper()
		if err := ws.Write(ctx, websocket.MessageBinary, ctrlRecord(v)); err != nil {
			t.Fatal(err)
		}
	}
	send(map[string]any{"t": "hello", "v": 2, "name": "Tester"})
	readCtrl(t, ws, "welcome")
	send(map[string]any{"t": "join", "muted": true})

	// GDS-1 first: a stranger's request for a ufrag Commons doesn't have is never answered, and leaves nothing.
	if transport == "udp" {
		u, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: rtcPort})
		if err != nil {
			t.Fatal(err)
		}
		fake, _ := stun.Build(stun.TransactionID, stun.BindingRequest, stun.NewUsername("cmnsNotLive:x"),
			stun.NewShortTermIntegrity("guess"), stun.Fingerprint)
		_, _ = u.Write(fake.Raw)
		_ = u.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		if _, err := u.Read(make([]byte, 1500)); err == nil {
			t.Fatal("a fake ufrag got an answer")
		}
		_ = u.Close()
		if st := relayStats(); st.UDPMappings != 0 {
			t.Fatalf("a mapping for a fake ufrag: %+v", st)
		}
	}

	// A member's voice: the offer through the room link, the answer cut down to desk-rtc's port.
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	network := webrtc.NetworkTypeUDP4
	if transport == "tcp" {
		network = webrtc.NetworkTypeTCP4
	}
	se.SetNetworkTypes([]webrtc.NetworkType{network})
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	track, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "member")
	if _, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv}); err != nil {
		t.Fatal(err)
	}
	offer, _ := pc.CreateOffer(nil)
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	send(map[string]any{"t": "rtc-offer", "sdp": pc.LocalDescription().SDP})
	ans := readCtrl(t, ws, "rtc-answer")
	sdp, _ := ans["sdp"].(string)
	cut := onlyPort(sdp, transport, rtcPort)
	if !strings.Contains(cut, " "+strconv.Itoa(rtcPort)+" typ host") {
		t.Fatalf("Commons named no %s candidate on desk-rtc's port %d:\n%s", transport, rtcPort, sdp)
	}
	connected := make(chan struct{})
	var once sync.Once
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			once.Do(func() { close(connected) })
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: cut}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(15 * time.Second):
		t.Fatalf("voice didn't connect through desk-rtc's %s %d: ICE %s\ndesk-rtc:\n%s\nCommons:\n%s", transport, rtcPort,
			pc.ICEConnectionState(), s.logs["desk-rtc"], log)
	}
	pair, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || int(pair.Remote.Port) != rtcPort {
		t.Fatalf("selected pair %v: %v", pair, err)
	}
	// One mapping per client address Commons answered: the client checks from each of its host candidates (loopback
	// and the machine's own), up to the caps per ufrag.
	st := relayStats()
	if (transport == "udp" && (st.UDPMappings < 1 || st.UDPMappings > 4)) || (transport == "tcp" && (st.TCPConnections < 1 || st.TCPConnections > 2)) {
		t.Fatalf("relay %+v", st)
	}
	t.Logf("%s: connected through desk-rtc's port to the real Commons; relay %+v", transport, st)
}
