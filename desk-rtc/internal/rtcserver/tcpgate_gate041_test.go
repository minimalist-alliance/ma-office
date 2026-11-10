package rtcserver

import (
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/stun/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// desk-rtc 0.4.2: Security's GATE041-1 (the gate's shared places could still be held against a member's own network)
// and GATE041-2 (connections past the gate were never capped, checked or timed out). Real loopback TCP, each client
// network a source address in its own 127.0.N.0/24, as tcpgate_test.go.

const gateTestPwd = "the-session-ice-password"

// framedSigned is an RFC 4571 frame holding a binding request to ufrag signed with pwd.
func framedSigned(t testing.TB, ufrag, pwd string) []byte {
	t.Helper()
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest, stun.NewUsername(ufrag+":client"),
		stun.NewShortTermIntegrity(pwd), stun.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}

	return append([]byte{byte(len(msg.Raw) >> 8), byte(len(msg.Raw))}, msg.Raw...)
}

func verifyWith(pwds map[string]string) func(string, *stun.Message) bool {
	return func(u string, m *stun.Message) bool {
		p, ok := pwds[u]

		return ok && stun.NewShortTermIntegrity(p).Check(m) == nil
	}
}

// GATE041-1, second half: one address inside the member's own /24 holds the network's 16 places with silent
// connections. The member, on another address of the /24, gets in all the same; 0.4.1 refused it ("not passed on").
func TestGateOneAddressCannotHoldItsWholeNetwork(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	for range 16 {
		c, err := r.dial("127.0.40.1")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
	}
	r.waitHeld(16, 2*time.Second)
	// Its 17th stays refused: the address has nothing to give to itself.
	extra, err := r.dial("127.0.40.1")
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	_ = extra.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, err := extra.Read(make([]byte, 1)); err == nil {
		t.Fatal("read data from a refused connection")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("the same address's 17th wasn't closed at once")
	}

	for i := range 30 {
		if err := r.member("127.0.40."+strconv.Itoa(2+i%5), 2*time.Second); err != nil {
			t.Fatalf("member on the same /24, try %d: %v", i, err)
		}
	}
	if r.maxPerNet.Load() > gatePerNet {
		t.Fatalf("the network held %d places", r.maxPerNet.Load())
	}
}

// GATE041-1, first half: one silent place from each of 64 networks fills the gate. A network a live session is expected
// from keeps its reserved places, outside the shared count; a network nobody is expected from still waits for the
// gate's fair share (nothing in it, with one each).
func TestGateReservedPlacesSurviveSixtyFourNetworksHoldingOneEach(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	for i := range memberGateLimits.total {
		c, err := r.dial("127.0." + strconv.Itoa(100+i) + ".1")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
	}
	r.waitHeld(memberGateLimits.total, 3*time.Second)

	if err := r.member("127.0.40.1", 600*time.Millisecond); err == nil {
		t.Fatal("a network nobody is expected from got in with every shared place held one each")
	}
	r.gate.setHints(gateKnownUfrag, []netip.Prefix{netOf("127.0.41.1")})
	for i := range 30 {
		if err := r.member("127.0.41."+strconv.Itoa(1+i), 2*time.Second); err != nil {
			t.Fatalf("the expected network, try %d: %v", i, err)
		}
	}
	// A household of 12 from the expected network, together (4 a session is the reserve for one session; 12 asks for
	// the shared cap's room too, which is all held: the reserve alone gives it 4 at once, the rest as places clear).
	if w, _ := r.held(); w > memberGateLimits.total {
		t.Fatalf("the shared count went past its total: %d", w)
	}
	r.gate.mu.Lock()
	res := r.gate.resWaiting
	r.gate.mu.Unlock()
	if res != 0 {
		t.Fatalf("reserved places still held after the members sent: %d", res)
	}
	// With the session gone its hints are gone (the networks it sent from are remembered as known ones, below).
	r.gate.dropHints(gateKnownUfrag)
	r.gate.mu.Lock()
	left := len(r.gate.hintCount)
	r.gate.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d hinted networks after the session went", left)
	}
}

// Hints are bounded: a session names at most gateMaxHints networks, each adds gateReservePerSession places for as long
// as the session lives, never past a network's cap, and a ufrag's replacement or drop gives them back.
func TestGateHintsAreBounded(t *testing.T) {
	g := newGateListener(nil, nil)
	var many []netip.Prefix
	for i := range 10 {
		many = append(many, netOf("198.51.100."+strconv.Itoa(1))) // the same one
		many = append(many, netOf("203.0."+strconv.Itoa(i)+".1"))
	}
	g.setHints("a", many)
	if got := g.hintsOf("a"); len(got) != gateMaxHints {
		t.Fatalf("a session named %d networks, want at most %d", len(got), gateMaxHints)
	}
	g.addHint("a", netOf("192.0.2.1"))
	if got := g.hintsOf("a"); len(got) != gateMaxHints {
		t.Fatalf("a verified frame added past the limit: %d", len(got))
	}
	g.setHints("b", []netip.Prefix{netOf("198.51.100.77")})
	g.mu.Lock()
	cap2 := g.reserveCapLocked(netOf("198.51.100.1"))
	g.mu.Unlock()
	if cap2 != 2*gateReservePerSession {
		t.Fatalf("two sessions from one network: reserve %d, want %d", cap2, 2*gateReservePerSession)
	}
	for i := range 40 { // 40 sessions can't take more than a network's places
		g.setHints("s"+strconv.Itoa(i), []netip.Prefix{netOf("198.51.100.1")})
	}
	g.mu.Lock()
	cap3 := g.reserveCapLocked(netOf("198.51.100.1"))
	g.mu.Unlock()
	if cap3 != gatePerNet {
		t.Fatalf("reserve %d, want the network's cap %d", cap3, gatePerNet)
	}
	g.setHints("a", nil)
	g.dropHints("b")
	for i := range 40 {
		g.dropHints("s" + strconv.Itoa(i))
	}
	g.mu.Lock()
	left := len(g.hintCount) + len(g.hints)
	g.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d hint entries left after every session went", left)
	}
}

func TestOfferNetworks(t *testing.T) {
	offer := "v=0\r\na=candidate:1 1 udp 2113937151 abcd-1234.local 5000 typ host\r\n" +
		"a=candidate:2 1 udp 2113937151 192.168.1.20 5000 typ host\r\n" +
		"a=candidate:3 1 udp 1677729535 203.0.113.9 5000 typ srflx raddr 0.0.0.0 rport 0\r\n" +
		"a=candidate:4 1 tcp 1518280447 198.51.100.4 9 typ host tcptype active\r\n" +
		"a=candidate:5 1 udp 41885439 192.0.2.77 5000 typ relay raddr 0.0.0.0 rport 0\r\n" +
		"a=candidate:6 1 udp 1 100.64.1.1 5000 typ host\r\n" +
		"a=candidate:7 1 udp 1 203.0.113.200 5000 typ srflx\r\n" +
		"a=candidate:8 1 udp 1 127.0.0.1 5000 typ host\r\n"
	got := offerNetworks(offer, false)
	want := []netip.Prefix{netOf("203.0.113.9"), netOf("198.51.100.4")}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("offerNetworks = %v, want %v (mDNS, private, CGNAT, relay and loopback say nothing; the same /24 once; two at most)", got, want)
	}
	if lo := offerNetworks("a=candidate:8 1 udp 1 127.0.0.1 5000 typ host\r\n", true); len(lo) != 1 {
		t.Fatalf("loopback allowed: %v", lo)
	}
	u, p := iceCredentials("v=0\r\nm=application\r\na=ice-ufrag:abc\r\na=ice-pwd:secretpassword\r\nm=audio\r\na=ice-ufrag:zzz\r\n")
	if u != "abc" || p != "secretpassword" {
		t.Fatalf("iceCredentials = %q %q", u, p)
	}
}

// GATE041-2: connections past the gate. Many connections naming a live session's ufrag, each with a valid first frame
// (the member has the password of its own session), are capped per session; they free their count when closed.
func TestGateCapsConnectionsPerSession(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	r.gate.handedPerUfrag, r.gate.handedPerNet = gateHandedPerUfrag, gateHandedPerNetFactor
	r.gate.verify = verifyWith(map[string]string{gateKnownUfrag: gateTestPwd})
	frame := framedSigned(t, gateKnownUfrag, gateTestPwd)

	var open []net.Conn
	for i := range 40 {
		c, err := r.dial("127.0.50." + strconv.Itoa(1+i%3))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		if _, err := c.Write(frame); err != nil {
			t.Fatal(err)
		}
		open = append(open, c)
		time.Sleep(3 * time.Millisecond)
	}
	var passed []net.Conn
	end := time.After(500 * time.Millisecond)
collect:
	for {
		select {
		case c := <-r.passed:
			passed = append(passed, c)
		case <-end:
			break collect
		}
	}
	if len(passed) != gateHandedPerUfrag {
		t.Fatalf("%d connections went past the gate on one session's ufrag, want %d", len(passed), gateHandedPerUfrag)
	}
	if r.gate.refusedHanded.Load() != uint64(40-gateHandedPerUfrag) {
		t.Fatalf("refusedHanded %d, want %d", r.gate.refusedHanded.Load(), 40-gateHandedPerUfrag)
	}
	// The cap counts what's open: closing one lets another in.
	_ = passed[0].Close()
	c, err := r.dial("127.0.50.9")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write(frame)
	select {
	case got := <-r.passed:
		_ = got.Close()
	case <-time.After(time.Second):
		t.Fatal("a closed connection didn't give its count back")
	}
	for _, p := range passed[1:] {
		_ = p.Close()
	}
	r.gate.mu.Lock()
	h, hn := len(r.gate.handed), len(r.gate.handedNet)
	r.gate.mu.Unlock()
	if h != 0 || hn != 0 {
		t.Fatalf("counts left after everything closed: %d sessions, %d networks", h, hn)
	}
}

// One network can't take more than its share of the connections past the gate however many sessions it names.
func TestGateCapsConnectionsPerNetwork(t *testing.T) {
	lim := gateLimits{total: 64, perNet: 4, firstPacket: 2 * time.Second}
	r := startGate(t, lim, nil)
	r.gate.handedPerUfrag, r.gate.handedPerNet = 100, 2 // 2 x perNet 4 = 8 for the network
	r.gate.allow = func(string) bool { return true }
	passedCount := 0
	for i := range 20 {
		c, err := r.dial("127.0.51.1")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		if _, err := c.Write(framedBinding(t, "u"+strconv.Itoa(i))); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	end := time.After(400 * time.Millisecond)
collect:
	for {
		select {
		case <-r.passed:
			passedCount++
		case <-end:
			break collect
		}
	}
	if passedCount != 8 {
		t.Fatalf("%d connections past the gate from one network, want 8", passedCount)
	}
}

// The first frame must be signed with the session's ICE password: a ufrag alone allocates nothing in Pion.
func TestGateChecksMessageIntegrity(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	r.gate.verify = verifyWith(map[string]string{gateKnownUfrag: gateTestPwd})

	bad, err := r.dial("127.0.52.1")
	if err != nil {
		t.Fatal(err)
	}
	defer bad.Close()
	if _, err := bad.Write(framedSigned(t, gateKnownUfrag, "a-guess")); err != nil {
		t.Fatal(err)
	}
	unsigned := framedBinding(t, gateKnownUfrag) // signed with "pwd"
	bad2, err := r.dial("127.0.52.2")
	if err != nil {
		t.Fatal(err)
	}
	defer bad2.Close()
	_, _ = bad2.Write(unsigned)
	select {
	case <-r.passed:
		t.Fatal("a connection with the wrong password went past the gate")
	case <-time.After(300 * time.Millisecond):
	}
	if r.gate.refusedAuth.Load() != 2 {
		t.Fatalf("refusedAuth %d, want 2", r.gate.refusedAuth.Load())
	}
	for _, c := range []net.Conn{bad, bad2} {
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := c.Read(make([]byte, 1)); err == nil {
			t.Fatal("data from a refused connection")
		} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Fatal("a refused connection was left open")
		}
	}
	// And the real password gets through.
	good, err := r.dial("127.0.52.3")
	if err != nil {
		t.Fatal(err)
	}
	defer good.Close()
	_, _ = good.Write(framedSigned(t, gateKnownUfrag, gateTestPwd))
	select {
	case c := <-r.passed:
		_ = c.Close()
	case <-time.After(time.Second):
		t.Fatal("the right password didn't get through")
	}
	// A gated mux knows nothing of a ufrag whose password isn't recorded yet.
	m := &gatedTCPMux{ufrags: map[string]struct{}{"x": {}}}
	msg := &stun.Message{Raw: framedSigned(t, "x", "p")[2:]}
	if err := msg.Decode(); err != nil {
		t.Fatal(err)
	}
	if m.verify("x", msg) {
		t.Fatal("verified without a password")
	}
	m.setPassword("x", "p")
	if !m.verify("x", msg) {
		t.Fatal("rejected the right password")
	}
	m.setPassword("never-registered", "p")
	if _, ok := m.pwds["never-registered"]; ok {
		t.Fatal("kept a password for a ufrag no agent asked for")
	}
}

// A connection past the gate that goes silent is closed: it can't sit for ever.
func TestGateHandedConnectionTimesOutWhenSilent(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	r.gate.handedIdle = 150 * time.Millisecond
	c, err := r.dial("127.0.53.1")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write(framedBinding(t, gateKnownUfrag)); err != nil {
		t.Fatal(err)
	}
	var got net.Conn
	select {
	case got = <-r.passed:
	case <-time.After(time.Second):
		t.Fatal("not passed on")
	}
	defer got.Close()
	buf := make([]byte, 512)
	n, err := got.Read(buf) // the replayed first frame
	if err != nil || n == 0 {
		t.Fatalf("first frame: %d, %v", n, err)
	}
	// Pion clears the read deadline after the first packet; that must not lift the idle limit.
	_ = got.SetReadDeadline(time.Time{})
	res := make(chan error, 1)
	start := time.Now()
	go func() { _, err := got.Read(buf); res <- err }()
	select {
	case err = <-res:
	case <-time.After(2 * time.Second):
		t.Fatal("a silent connection past the gate was still open after 2 s")
	}
	if !errors.Is(err, net.ErrClosed) {
		t.Fatalf("a silent connection past the gate: %v, want it closed (Pion treats net.ErrClosed as a closure, not an error)", err)
	}
	if d := time.Since(start); d < 100*time.Millisecond || d > 600*time.Millisecond {
		t.Fatalf("closed after %v, want about 150 ms", d)
	}
}

// While half the shared places are held, a silent connection's place lasts half as long; below that, the full time.
func TestGatePressureShortensTheWait(t *testing.T) {
	lim := gateLimits{total: 8, perNet: 8, firstPacket: 800 * time.Millisecond}
	g := newGateListener(nil, nil)
	g.setLimits(lim)
	var places []*gatePlace
	for i := range 6 {
		a, b := net.Pipe()
		_ = b.Close()
		p := g.admit(&closeTracker{Conn: a, addr: &net.TCPAddr{IP: net.ParseIP("192.0.2." + strconv.Itoa(i+1)), Port: 1}, closed: &atomic.Bool{}})
		if p == nil {
			t.Fatal("refused")
		}
		places = append(places, p)
	}
	for i, p := range places {
		want := lim.firstPacket
		if i >= 4 { // taken with 4 or more of 8 already held
			want /= 2
		}
		if p.wait != want {
			t.Fatalf("place %d waits %v, want %v", i, p.wait, want)
		}
	}
}

// The same through the real server and a real session (GATE041-2): a connection naming the session's ufrag with a wrong
// password is closed before Pion has it; with the right one it's kept, up to the session's cap; the network of a
// verified frame becomes one the session is expected from.
func TestServerGateChecksPasswordAndCapsASession(t *testing.T) {
	f := startServer(t, 30*time.Second)
	d := f.deskd()
	d.configure("127.0.0.1", 4)
	p := newPeer(t, peerOpts{})
	d.send(createMsg("cs-a", p))
	ans := d.expect("session.answer", "cs-a", 5*time.Second)
	ufrag, pwd := iceCredentials(ans.Answer)
	remote, _ := iceCredentials(p.offer)
	username := ufrag + ":" + remote

	if reply, closed := tcpProbe(t, f.port, withICEAttrs(t, username, "wrong-password-wrong-password-xx")); reply || !closed {
		t.Fatalf("wrong password: reply=%v closed=%v, want the connection dropped", reply, closed)
	}
	if f.srv.gate.refusedAuth.Load() != 1 {
		t.Fatalf("refusedAuth %d, want 1", f.srv.gate.refusedAuth.Load())
	}
	if reply, _ := tcpProbe(t, f.port, withICEAttrs(t, username, pwd)); !reply {
		t.Fatal("the right password got no answer over TCP")
	}
	if got := f.srv.gate.hintsOf(ufrag); len(got) == 0 || got[0] != netOf("127.0.0.1") {
		t.Fatalf("hints %v, want the loopback network a verified frame came from", got)
	}

	good := framedFrom(withICEAttrs(t, username, pwd))
	var kept, dropped int
	var conns []net.Conn
	for range 20 {
		c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.port)))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_, _ = c.Write(good)
		conns = append(conns, c)
	}
	time.Sleep(400 * time.Millisecond)
	for _, c := range conns {
		// Pion answers a kept connection's check with a binding response; a refused one is closed with nothing.
		_ = c.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, err := c.Read(make([]byte, 1500))
		if n > 0 {
			kept++
		} else if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				kept++
			} else {
				dropped++
			}
		}
	}
	if kept != gateHandedPerUfrag || dropped != 20-gateHandedPerUfrag {
		t.Fatalf("%d kept, %d dropped of 20 connections on one session, want %d and %d", kept, dropped, gateHandedPerUfrag, 20-gateHandedPerUfrag)
	}

	d.send(&rtcsock.Message{T: "session.close", SessionID: "cs-a", Reason: "closed_by_desk"})
	d.expect("session.closed", "cs-a", 5*time.Second)
	if got := f.srv.gate.hintsOf(ufrag); len(got) != 0 {
		t.Fatalf("hints %v left after the session closed", got)
	}
}

func framedFrom(pkt []byte) []byte {
	return append([]byte{byte(len(pkt) >> 8), byte(len(pkt))}, pkt...)
}

// The same, with no hint from any offer (a browser's offer carries no candidates today): a network a verified frame
// came from once is remembered, so a returning member keeps getting in while 64 networks each hold a place.
func TestGateKnownNetworkKeepsItsReserve(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	if err := r.member("127.0.42.1", 2*time.Second); err != nil { // the member's first visit, the gate quiet
		t.Fatal(err)
	}
	for i := range memberGateLimits.total {
		c, err := r.dial("127.0." + strconv.Itoa(100+i) + ".1")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
	}
	r.waitHeld(memberGateLimits.total, 3*time.Second)
	for i := range 30 {
		if err := r.member("127.0.42."+strconv.Itoa(1+i), 2*time.Second); err != nil {
			t.Fatalf("returning member, try %d: %v", i, err)
		}
	}
	if err := r.member("127.0.43.1", 600*time.Millisecond); err == nil {
		t.Fatal("a network never seen before got in with every shared place held one each")
	}
}

func TestGateKnownNetworksAreBounded(t *testing.T) {
	g := newGateListener(nil, nil)
	for i := range 500 {
		g.learnKnown(netOf("10." + strconv.Itoa(i/250) + "." + strconv.Itoa(i%250) + ".1"))
	}
	g.mu.Lock()
	n := len(g.known)
	_, oldest := g.known[netOf("10.0.0.1")]
	_, newest := g.known[netOf("10.1.249.1")]
	g.mu.Unlock()
	if n != gateKnownMin || oldest || !newest {
		t.Fatalf("%d known networks (want %d), oldest kept %v, newest kept %v", n, gateKnownMin, oldest, newest)
	}
}
