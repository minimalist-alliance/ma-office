package voice

import (
	"encoding/binary"
	"io"
	"net"
	"regexp"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

var (
	ufragRe = regexp.MustCompile(`a=ice-ufrag:(\S+)`)
	pwdRe   = regexp.MustCompile(`a=ice-pwd:(\S+)`)
)

// live is one voice connection's credentials, as a member's browser would check with them.
type live struct {
	ufrag, pwd, remote string
}

func liveConn(t *testing.T, s *SFU, idx uint16) live {
	t.Helper()
	_, offer := client(t, webrtc.NetworkTypeUDP4)
	answer, _, err := s.Answer("r", idx, offer, false)
	if err != nil {
		t.Fatal(err)
	}
	return live{ufrag: ufragRe.FindStringSubmatch(answer)[1], pwd: pwdRe.FindStringSubmatch(answer)[1], remote: ufragRe.FindStringSubmatch(offer)[1]}
}

// binding is a browser's connectivity check: USERNAME "theirs:mine", signed with the receiver's password. No
// USE-CANDIDATE, so the server doesn't start DTLS towards the test's sockets.
func binding(t *testing.T, ufrag, remote, pwd string) []byte {
	t.Helper()
	m, err := stun.Build(stun.TransactionID, stun.BindingRequest, stun.NewUsername(ufrag+":"+remote),
		ice.PriorityAttr(1845501695), ice.AttrControlling(42), stun.NewShortTermIntegrity(pwd), stun.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	return m.Raw
}

func isSuccess(b []byte) bool {
	m := &stun.Message{Raw: b}
	return m.Decode() == nil && m.Type == stun.BindingSuccess
}

// udpAsk sends one datagram from c and says whether a binding success came back. Any other reply fails the test: a
// refused check must get nothing at all (Security's GDS-3).
func udpAsk(t *testing.T, c net.PacketConn, to net.Addr, b []byte) bool {
	t.Helper()
	if _, err := c.WriteTo(b, to); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1500)
	_ = c.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
	for {
		n, _, err := c.ReadFrom(buf)
		if err != nil {
			return false
		}
		if !stun.IsMessage(buf[:n]) {
			continue // DTLS or media on an address whose check succeeded earlier: not an answer to this one
		}
		if !isSuccess(buf[:n]) {
			t.Fatalf("a STUN reply that isn't a binding success: % x", buf[:min(n, 32)])
		}
		return true
	}
}

func TestGateUDP(t *testing.T) {
	s, relay := newSFU(t, "", true)
	to, _ := net.ResolveUDPAddr("udp4", relay)
	l := liveConn(t, s, 1)
	sock := func() net.PacketConn {
		c, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	before := GateRefused.Load()
	a := sock()
	if udpAsk(t, a, to, binding(t, "cmnsNotAConnection", l.remote, l.pwd)) {
		t.Fatal("an unknown ufrag got an answer")
	}
	if udpAsk(t, a, to, binding(t, l.ufrag, l.remote, "the-wrong-password-for-it")) {
		t.Fatal("the wrong password got an answer")
	}
	if udpAsk(t, a, to, []byte("not a stun message at all, just bytes")) {
		t.Fatal("junk got an answer")
	}
	if got := GateRefused.Load() - before; got != 3 {
		t.Fatalf("refused %d, want 3", got)
	}
	if n := s.gateU.addresses(); n != 0 {
		t.Fatalf("the gate kept %d addresses for what it refused", n)
	}
	// The connection's own, signed: answered. Then up to the cap of addresses, and no more.
	if !udpAsk(t, a, to, binding(t, l.ufrag, l.remote, l.pwd)) {
		t.Fatal("the live connection's own check got no answer")
	}
	for i := 1; i < gateUDPPerUfrag; i++ {
		if !udpAsk(t, sock(), to, binding(t, l.ufrag, l.remote, l.pwd)) {
			t.Fatalf("address %d of %d got no answer", i+1, gateUDPPerUfrag)
		}
	}
	if udpAsk(t, sock(), to, binding(t, l.ufrag, l.remote, l.pwd)) {
		t.Fatal("one address past the cap got an answer")
	}
	if n := s.gateU.addresses(); n != gateUDPPerUfrag {
		t.Fatalf("%d addresses let through, want %d", n, gateUDPPerUfrag)
	}
	// The connection ends: its addresses get nothing more in, and are forgotten.
	s.Remove(1)
	if udpAsk(t, a, to, binding(t, l.ufrag, l.remote, l.pwd)) {
		t.Fatal("a check for an ended connection got an answer")
	}
	if n := s.gateU.addresses(); n != gateUDPPerUfrag-1 {
		t.Fatalf("%d addresses after the end, want %d", n, gateUDPPerUfrag-1)
	}
}

// tcpAsk opens a relayed TCP connection, sends one RFC 4571 frame, and says whether a binding success came back and
// whether the connection stays open after it.
func tcpAsk(t *testing.T, relay string, frame []byte) (answered bool, c net.Conn) {
	t.Helper()
	c, err := net.Dial("tcp4", relay)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if frame != nil {
		out := make([]byte, 2+len(frame))
		binary.BigEndian.PutUint16(out, uint16(len(frame)))
		copy(out[2:], frame)
		if _, err := c.Write(out); err != nil {
			return false, c
		}
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	var hdr [2]byte
	if n, err := io.ReadFull(c, hdr[:]); err != nil {
		if n > 0 {
			t.Fatalf("a refused connection got %d bytes back", n)
		}
		return false, c
	}
	body := make([]byte, binary.BigEndian.Uint16(hdr[:]))
	if _, err := io.ReadFull(c, body); err != nil {
		return false, c
	}
	if !isSuccess(body) {
		t.Fatalf("a reply that isn't a binding success: % x", body[:min(len(body), 32)])
	}
	return true, c
}

// closedSoon says whether the server closed c within d.
func closedSoon(c net.Conn, d time.Duration) bool {
	_ = c.SetReadDeadline(time.Now().Add(d))
	_, err := c.Read(make([]byte, 1))
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		return false
	}
	return err != nil
}

func TestGateTCP(t *testing.T) {
	old := gateFirstFrame
	gateFirstFrame = 300 * time.Millisecond
	t.Cleanup(func() { gateFirstFrame = old })
	s, relay := newSFU(t, "", true)
	l := liveConn(t, s, 1)
	before := GateRefused.Load()

	for name, frame := range map[string][]byte{
		"an unknown ufrag":   binding(t, "cmnsNotAConnection", l.remote, l.pwd),
		"the wrong password": binding(t, l.ufrag, l.remote, "the-wrong-password-for-it"),
		"junk":               []byte("GET / HTTP/1.1\r\nHost: commons\r\n\r\n"),
	} {
		ok, c := tcpAsk(t, relay, frame)
		if ok || !closedSoon(c, time.Second) {
			t.Fatalf("%s: answered %v, or the connection stayed open", name, ok)
		}
	}
	// Silence, and a length past the cap: closed too.
	_, c := tcpAsk(t, relay, nil)
	if !closedSoon(c, 2*time.Second) {
		t.Fatal("a connection that sent nothing stayed open past the first-frame time")
	}
	c, err := net.Dial("tcp4", relay)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte{0xff, 0xff})
	if !closedSoon(c, time.Second) {
		t.Fatal("a 64 KiB first frame wasn't refused at once")
	}
	if got := GateRefused.Load() - before; got != 5 {
		t.Fatalf("refused %d, want 5", got)
	}

	// The connection's own: answered, and kept, up to the cap.
	for i := 0; i < gateTCPPerUfrag; i++ {
		ok, c := tcpAsk(t, relay, binding(t, l.ufrag, l.remote, l.pwd))
		if !ok || closedSoon(c, 200*time.Millisecond) {
			t.Fatalf("connection %d of %d: answered %v, or closed", i+1, gateTCPPerUfrag, ok)
		}
	}
	ok, c2 := tcpAsk(t, relay, binding(t, l.ufrag, l.remote, l.pwd))
	if ok || !closedSoon(c2, time.Second) {
		t.Fatal("one connection past the cap was let through")
	}
	// Another live connection has its own allowance.
	l2 := liveConn(t, s, 2)
	if ok, _ := tcpAsk(t, relay, binding(t, l2.ufrag, l2.remote, l2.pwd)); !ok {
		t.Fatal("a second live connection got no answer")
	}
}

// Security's GDN-2: a check someone watching the member's traffic captured and replays from their own addresses is
// right in every byte, but it lets in only the address it came from. The connection's places stay for the member.
func TestGateReplayedCheckLetsNoOtherIn(t *testing.T) {
	old := gateFirstFrame
	gateFirstFrame = 300 * time.Millisecond
	t.Cleanup(func() { gateFirstFrame = old })
	s, relay := newSFU(t, "", true)
	to, _ := net.ResolveUDPAddr("udp4", relay)
	l := liveConn(t, s, 1)
	sock := func() net.PacketConn {
		c, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}

	// The member's check, from the member's address: in.
	check := binding(t, l.ufrag, l.remote, l.pwd)
	member := sock()
	if !udpAsk(t, member, to, check) {
		t.Fatal("the member's own check got no answer")
	}
	// The same bytes from every other address there are places for: nothing, and no place taken.
	for i := 1; i < gateUDPPerUfrag; i++ {
		if udpAsk(t, sock(), to, check) {
			t.Fatalf("replay %d of the member's check from another address got an answer", i)
		}
	}
	if n := s.gateU.addresses(); n != 1 {
		t.Fatalf("%d addresses let through after the replays, want 1", n)
	}
	// Over TCP too.
	if ok, c := tcpAsk(t, relay, check); ok || !closedSoon(c, time.Second) {
		t.Fatal("the member's UDP check replayed on a TCP connection was let through")
	}
	// The member's retransmission from their own address still goes, and their next checks from new addresses
	// (a network change) find every place the replays didn't take.
	if !udpAsk(t, member, to, check) {
		t.Fatal("the member's retransmission got no answer")
	}
	for i := 1; i < gateUDPPerUfrag; i++ {
		if !udpAsk(t, sock(), to, binding(t, l.ufrag, l.remote, l.pwd)) {
			t.Fatalf("the member's new address %d got no answer", i)
		}
	}

	// A TCP connection's first check, replayed on another connection: refused, and the member's next is in.
	tcpCheck := binding(t, l.ufrag, l.remote, l.pwd)
	if ok, _ := tcpAsk(t, relay, tcpCheck); !ok {
		t.Fatal("the member's TCP check got no answer")
	}
	if ok, c := tcpAsk(t, relay, tcpCheck); ok || !closedSoon(c, time.Second) {
		t.Fatal("a replay of the member's TCP check on another connection was let through")
	}
	if ok, _ := tcpAsk(t, relay, binding(t, l.ufrag, l.remote, l.pwd)); !ok {
		t.Fatal("the member's second TCP connection got no answer")
	}

	// What's kept is the connection's own, and goes with it.
	s.Remove(1)
	s.creds.mu.RLock()
	kept := len(s.creds.used)
	s.creds.mu.RUnlock()
	if kept != 0 {
		t.Fatalf("checks kept for %d ended connections", kept)
	}
}

// The gate remembers a connection's last gateChecks checks that let something in, and no more.
func TestGateRemembersABoundedNumberOfChecks(t *testing.T) {
	c := &credentials{pwd: map[string]string{"cmnsA": "p"}}
	var first [12]byte
	first[0] = 1
	if !c.claim("cmnsA", first, "udp 1") {
		t.Fatal("a first check was refused")
	}
	for i := 0; i < gateChecks*3; i++ {
		var id [12]byte
		binary.BigEndian.PutUint32(id[4:], uint32(i+2))
		if !c.claim("cmnsA", id, "udp 2") {
			t.Fatalf("check %d was refused", i)
		}
	}
	if n := len(c.used["cmnsA"]); n != gateChecks {
		t.Fatalf("%d checks kept, want %d", n, gateChecks)
	}
	if c.claim("cmnsGone", first, "udp 1") || len(c.used["cmnsGone"]) != 0 {
		t.Fatal("a check for a connection that isn't live was taken, or kept")
	}
}
