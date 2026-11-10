package voice

import (
	"net"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// freePort finds a port free for both UDP and TCP on loopback.
func freePort(t *testing.T) string {
	t.Helper()
	for i := 0; i < 20; i++ {
		u, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := u.LocalAddr().(*net.UDPAddr).Port
		l, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		u.Close()
		if err == nil {
			l.Close()
			return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
		}
	}
	t.Fatal("no free port")
	return ""
}

func newSFU(t *testing.T, advertise string, relay bool) (*SFU, string) {
	t.Helper()
	cfg := Config{UDP: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, Slots: 2, Sockets: 1, Advertise: advertise, RelayPort: 443}
	relayAddr := ""
	if relay {
		relayAddr = freePort(t)
		cfg.RelayUDP, cfg.RelayTCP = relayAddr, relayAddr
	}
	s, err := New(cfg, Events{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, relayAddr
}

// client is a member's browser: one sendrecv and one recvonly audio line, all candidates in the offer.
func client(t *testing.T, networks ...webrtc.NetworkType) (*webrtc.PeerConnection, string) {
	t.Helper()
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetNetworkTypes(networks)
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se), webrtc.WithMediaEngine(me)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "member")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv}); err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-done
	return pc, pc.LocalDescription().SDP
}

var candRe = regexp.MustCompile(`(?m)^a=candidate:\S+ \d+ (\w+) (\d+) (\S+) (\d+) typ host(.*)$`)

func TestAnswerUfragAndCandidates(t *testing.T) {
	s, _ := newSFU(t, "203.0.113.9", true)
	_, offer := client(t, webrtc.NetworkTypeUDP4)
	answer, _, err := s.Answer("r", 1, offer, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range regexp.MustCompile(`(?m)^a=ice-ufrag:(\S+)`).FindAllStringSubmatch(answer, -1) {
		if !strings.HasPrefix(m[1], UfragPrefix) {
			t.Fatalf("ufrag %q doesn't start with %q", m[1], UfragPrefix)
		}
	}
	direct := s.muxes[0].(*ice.UDPMuxDefault).LocalAddr().(*net.UDPAddr).Port
	prio := map[string]int{}
	for _, m := range candRe.FindAllStringSubmatch(answer, -1) {
		if m[3] != "203.0.113.9" {
			t.Fatalf("a member would see %s", m[0])
		}
		p, _ := strconv.Atoi(m[2])
		key := strings.ToLower(m[1]) + ":" + m[4]
		if _, dup := prio[key]; dup {
			t.Fatalf("named twice: %s", key)
		}
		prio[key] = p
		if strings.ToLower(m[1]) == "tcp" && !strings.Contains(m[5], "tcptype passive") {
			t.Fatalf("a TCP candidate that isn't passive: %s", m[0])
		}
	}
	d, u, tc := prio["udp:"+strconv.Itoa(direct)], prio["udp:443"], prio["tcp:443"]
	if d == 0 || u == 0 || tc == 0 || len(prio) != 3 {
		t.Fatalf("candidates: %v (direct port %d)", prio, direct)
	}
	if !(d > u && u > tc) {
		t.Fatalf("priorities: direct %d, UDP 443 %d, TCP 443 %d", d, u, tc)
	}
	// A second connection gets its own ufrag.
	_, offer2 := client(t, webrtc.NetworkTypeUDP4)
	answer2, _, _ := s.Answer("r", 2, offer2, false)
	u1 := regexp.MustCompile(`a=ice-ufrag:(\S+)`).FindStringSubmatch(answer)[1]
	u2 := regexp.MustCompile(`a=ice-ufrag:(\S+)`).FindStringSubmatch(answer2)[1]
	if u1 == u2 {
		t.Fatal("two connections share a ufrag")
	}
}

// keepOnly drops every candidate in an answer but those on port.
func keepOnly(answer string, transport string, port string) string {
	var out []string
	for _, l := range strings.Split(answer, "\r\n") {
		if m := candRe.FindStringSubmatch(l); m != nil && (strings.ToLower(m[1]) != transport || m[4] != port) {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\r\n")
}

func connectThrough(t *testing.T, transport string, networks ...webrtc.NetworkType) {
	s, relay := newSFU(t, "", true)
	_, port, _ := net.SplitHostPort(relay)
	pc, offer := client(t, networks...)
	answer, _, err := s.Answer("r", 7, offer, false)
	if err != nil {
		t.Fatal(err)
	}
	// As a member whose network blocks the direct port: only the relay listener is left, as desk-rtc would hand it on.
	answer = keepOnly(answer, transport, port)
	if !strings.Contains(answer, " "+port+" typ host") {
		t.Fatalf("no %s candidate on the relay port %s in:\n%s", transport, port, answer)
	}
	connected := make(chan struct{})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			select {
			case <-connected:
			default:
				close(connected)
			}
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatalf("no connection through the %s relay listener", transport)
	}
	pair, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		t.Fatalf("no selected pair: %v", err)
	}
	if strconv.Itoa(int(pair.Remote.Port)) != port || !strings.EqualFold(pair.Remote.Protocol.String(), transport) {
		t.Fatalf("connected through %s, not the %s relay listener on %s", pair.Remote, transport, port)
	}
}

func TestRelayedICEOverLoopbackUDP(t *testing.T) {
	connectThrough(t, "udp", webrtc.NetworkTypeUDP4)
}

func TestRelayedICEOverLoopbackTCP(t *testing.T) {
	connectThrough(t, "tcp", webrtc.NetworkTypeTCP4)
}
