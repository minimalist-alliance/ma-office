package rtcserver

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/stun/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// fakeCommons stands in for Commons' relayed-ICE listener: UDP and TCP on one loopback port. It reports every packet.
// While answer is set it answers as Commons' gate does for a live ufrag: a binding request gets a binding success with
// its transaction id, and anything else "ack:" and the packet. While it isn't, it sends nothing, as Commons does for
// a ufrag that isn't live.
type fakeCommons struct {
	t      *testing.T
	addr   string
	udp    *net.UDPConn
	tcp    net.Listener
	answer atomic.Bool
	// live, once set, is the only ufrags answered, as Commons' gate answers only its live connections.
	live atomic.Pointer[map[string]bool]
	got  chan commonsPacket
}

// answers says whether Commons answers data now.
func (c *fakeCommons) answers(data []byte) bool {
	if !c.answer.Load() {
		return false
	}
	live := c.live.Load()
	if live == nil {
		return true
	}
	ufrag, ok := voiceUfrag(data)

	return ok && (*live)[ufrag]
}

type commonsPacket struct {
	from string
	tcp  bool
	data []byte
}

// commonsReply is what the fake Commons sends back for a packet.
func commonsReply(data []byte) []byte {
	m := &stun.Message{Raw: append([]byte(nil), data...)}
	if stun.IsMessage(data) && m.Decode() == nil && m.Type == stun.BindingRequest {
		res, err := stun.Build(stun.NewTransactionIDSetter(m.TransactionID), stun.BindingSuccess, stun.Fingerprint)
		if err == nil {
			return res.Raw
		}
	}

	return append([]byte("ack:"), data...)
}

// isAnswerTo says b is Commons' binding success for the request req.
func isAnswerTo(b, req []byte) bool {
	got, ok := bindingSuccessID(b)
	_, want, isReq := voiceRequest(req)

	return ok && isReq && got == want
}

func startCommons(t *testing.T) *fakeCommons {
	t.Helper()
	port := freePort(t)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	u, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp4", addr)
	if err != nil {
		t.Fatal(err)
	}
	c := &fakeCommons{t: t, addr: addr, udp: u, tcp: l, got: make(chan commonsPacket, 4096)}
	c.answer.Store(true)
	t.Cleanup(func() { _ = u.Close(); _ = l.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, from, err := u.ReadFromUDP(buf)
			if err != nil {
				return
			}
			data := append([]byte(nil), buf[:n]...)
			select {
			case c.got <- commonsPacket{from: from.String(), data: data}:
			default:
			}
			if c.answers(data) {
				_, _ = u.WriteToUDP(commonsReply(data), from)
			}
		}
	}()
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			// Closed when the relay closes its end, at the latest when the test's desk-rtc stops.
			go func() {
				defer conn.Close()
				for {
					var hdr [2]byte
					if _, err := io.ReadFull(conn, hdr[:]); err != nil {
						return
					}
					data := make([]byte, binary.BigEndian.Uint16(hdr[:]))
					if _, err := io.ReadFull(conn, data); err != nil {
						return
					}
					select {
					case c.got <- commonsPacket{from: conn.RemoteAddr().String(), tcp: true, data: data}:
					default:
					}
					if c.answers(data) {
						_, _ = conn.Write(frame4571(commonsReply(data)))
					}
				}
			}()
		}
	}()

	return c
}

func frame4571(b []byte) []byte { return append([]byte{byte(len(b) >> 8), byte(len(b))}, b...) }

// next waits for Commons' next packet, or says there was none.
func (c *fakeCommons) next(wait time.Duration) (commonsPacket, bool) {
	select {
	case p := <-c.got:
		return p, true
	case <-time.After(wait):
		return commonsPacket{}, false
	}
}

func (c *fakeCommons) expect(want []byte, tcp bool) commonsPacket {
	c.t.Helper()
	p, ok := c.next(3 * time.Second)
	if !ok {
		c.t.Fatalf("nothing reached Commons, want %q", want)
	}
	if !bytes.Equal(p.data, want) || p.tcp != tcp {
		c.t.Fatalf("Commons got %q (tcp %v), want %q (tcp %v)", p.data, p.tcp, want, tcp)
	}

	return p
}

func (c *fakeCommons) expectNothing(wait time.Duration) {
	c.t.Helper()
	if p, ok := c.next(wait); ok {
		c.t.Fatalf("Commons got %q from %s", p.data, p.from)
	}
}

var testVoiceLimits = defaultVoiceLimits

func startRelay(t *testing.T, lim voiceLimits) (*fixture, *fakeCommons) {
	t.Helper()
	c := startCommons(t)
	f := startServerWith(t, 30*time.Second, func(cfg *Config) {
		cfg.VoiceRelayAddr = c.addr
		cfg.voiceLimits = lim
	})

	return f, c
}

func udpClient(t *testing.T, port int) *net.UDPConn {
	t.Helper()
	u, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = u.Close() })

	return u
}

func readWithin(t *testing.T, c net.Conn, wait time.Duration) ([]byte, bool) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(wait))
	buf := make([]byte, 2048)
	n, err := c.Read(buf)
	if err != nil {
		return nil, false
	}

	return buf[:n], true
}

func TestVoiceRelayUDPBothWays(t *testing.T) {
	f, commons := startRelay(t, testVoiceLimits)
	d := f.deskd()
	d.configureGuild(0, 0)

	u := udpClient(t, f.port)
	req := stunRequest(t, "cmnsVoiceA:browser1", "pw")
	if _, err := u.Write(req); err != nil {
		t.Fatal(err)
	}
	first := commons.expect(req, false)
	if got, ok := readWithin(t, u, 3*time.Second); !ok || !isAnswerTo(got, req) {
		t.Fatalf("the client got %q", got)
	}
	// Later packets from that address follow the mapping, STUN or not, from the same loopback socket.
	rtp := []byte{0x80, 0x6f, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 'v', 'o', 'i', 'c', 'e'}
	if _, err := u.Write(rtp); err != nil {
		t.Fatal(err)
	}
	if p := commons.expect(rtp, false); p.from != first.from {
		t.Fatalf("from %s, then %s", first.from, p.from)
	}
	if got, ok := readWithin(t, u, 3*time.Second); !ok || !bytes.Equal(got, append([]byte("ack:"), rtp...)) {
		t.Fatalf("the client got %q", got)
	}
	// Another client is another mapping, with a socket of its own.
	u2 := udpClient(t, f.port)
	req2 := stunRequest(t, "cmnsVoiceB:browser2", "pw")
	_, _ = u2.Write(req2)
	if p := commons.expect(req2, false); p.from == first.from {
		t.Fatal("two clients shared one loopback socket")
	}
	if _, ok := readWithin(t, u2, 3*time.Second); !ok {
		t.Fatal("the second client got no answer")
	}
	if m := d.stats(); m.VoiceRelay == nil || m.VoiceRelay.UDPMappings != 2 || m.VoiceRelay.UDPPending != 0 || m.VoiceRelay.Refused != 0 {
		t.Fatalf("voiceRelay %+v", m.VoiceRelay)
	}
}

func TestVoiceRelayTCPBothWays(t *testing.T) {
	f, commons := startRelay(t, testVoiceLimits)
	d := f.deskd()
	d.configureGuild(0, 0)

	c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req := stunRequest(t, "cmnsVoiceT:browser", "pw")
	if _, err := c.Write(frame4571(req)); err != nil {
		t.Fatal(err)
	}
	commons.expect(req, true)
	if got, ok := readWithin(t, c, 3*time.Second); !ok || len(got) < 2 || !isAnswerTo(got[2:], req) {
		t.Fatalf("the client got %q", got)
	}
	more := []byte("rtp over ice-tcp")
	if _, err := c.Write(frame4571(more)); err != nil {
		t.Fatal(err)
	}
	commons.expect(more, true)
	if got, ok := readWithin(t, c, 3*time.Second); !ok || !bytes.Equal(got, frame4571(append([]byte("ack:"), more...))) {
		t.Fatalf("the client got %q", got)
	}
	if m := d.stats(); m.VoiceRelay == nil || m.VoiceRelay.TCPConnections != 1 {
		t.Fatalf("voiceRelay %+v", m.VoiceRelay)
	}
}

// Everything that isn't Commons' on a Guild Desk, and everything on any other desk, goes as it always has.
func TestVoiceRelayLeavesEverythingElseAlone(t *testing.T) {
	f, commons := startRelay(t, testVoiceLimits)
	d := f.deskd()

	// Not a Guild Desk: Commons' ufrags are unknown ufrags, dropped and closed.
	d.configure("127.0.0.1", 4)
	cmns := stunRequest(t, "cmnsVoiceA:browser", "pw")
	if udpGetsReply(t, f.port, cmns) {
		t.Fatal("UDP: a reply on a desk that isn't a Guild Desk")
	}
	if reply, closed := tcpProbe(t, f.port, cmns); reply || !closed {
		t.Fatalf("TCP on a desk that isn't a Guild Desk: reply %v, closed %v", reply, closed)
	}
	commons.expectNothing(300 * time.Millisecond)
	if st := f.srv.voice.stats(); st.UDPMappings+st.UDPPending+st.TCPConnections+st.TCPPending != 0 {
		t.Fatalf("relay %+v", st)
	}

	// A Guild Desk: another unknown ufrag is still dropped and closed, and Commons hears nothing.
	d.configureGuild(0, 0)
	other := stunRequest(t, "zzzzunknown:browser", "pw")
	if udpGetsReply(t, f.port, other) {
		t.Fatal("UDP: a reply to an unknown ufrag")
	}
	if reply, closed := tcpProbe(t, f.port, other); reply || !closed {
		t.Fatalf("TCP unknown ufrag: reply %v, closed %v", reply, closed)
	}
	for _, junk := range [][]byte{[]byte("not stun"), cmns[:10]} {
		if udpGetsReply(t, f.port, junk) {
			t.Fatalf("UDP: a reply to %q", junk)
		}
	}
	commons.expectNothing(300 * time.Millisecond)

	// desk-rtc's own sessions connect and carry data while the relay runs.
	p, ans := guildConnected(t, d, "cs-a", "gm-a", peerOpts{dataOnly: true})
	if err := p.channels[rtcsock.ChCtl].Send([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-d.frames:
		if got.handle != ans.Handle {
			t.Fatalf("got %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the session's frame didn't reach deskd")
	}
	commons.expectNothing(200 * time.Millisecond)

	// A configure for another kind of desk turns it off and ends what it had.
	u := udpClient(t, f.port)
	_, _ = u.Write(cmns)
	commons.expect(cmns, false)
	if _, ok := readWithin(t, u, 3*time.Second); !ok {
		t.Fatal("no answer")
	}
	d.configure("127.0.0.1", 4)
	if st := f.srv.voice.stats(); st.UDPMappings+st.UDPPending != 0 {
		t.Fatalf("%+v after a desk's configure", st)
	}
	_, _ = u.Write([]byte("after"))
	commons.expectNothing(300 * time.Millisecond)
}

// A mapping is only ever what Commons' answer made: a request it doesn't answer stays pending, and goes; one it
// answers is a mapping, within the caps per Commons ufrag and in all.
func TestVoiceRelayCaps(t *testing.T) {
	lim := testVoiceLimits
	lim.udpPerUfrag, lim.udpTotal = 2, 3
	lim.tcpPerUfrag, lim.tcpTotal = 1, 2
	f, commons := startRelay(t, lim)
	d := f.deskd()
	d.configureGuild(0, 0)

	// Two client addresses per ufrag: a third's request reaches Commons, and its answer is dropped.
	for i := 0; i < 3; i++ {
		u := udpClient(t, f.port)
		req := stunRequest(t, "cmnsSame:browser"+strconv.Itoa(i), "pw")
		_, _ = u.Write(req)
		commons.expect(req, false)
		got, ok := readWithin(t, u, time.Second)
		if i < 2 && (!ok || !isAnswerTo(got, req)) {
			t.Fatalf("client %d got %q", i, got)
		}
		if i == 2 && ok {
			t.Fatal("a third address for one ufrag was answered")
		}
	}
	// In all: the third mapping fits, a fourth doesn't.
	for i, want := range []bool{true, false} {
		u := udpClient(t, f.port)
		req := stunRequest(t, "cmnsOther"+strconv.Itoa(i)+":x", "pw")
		_, _ = u.Write(req)
		commons.expect(req, false)
		if _, ok := readWithin(t, u, time.Second); ok != want {
			t.Fatalf("mapping %d: answered %v", 3+i, ok)
		}
	}
	if st := f.srv.voice.stats(); st.UDPMappings != 3 || st.UDPPending != 0 || st.Refused != 2 {
		t.Fatalf("relay %+v", st)
	}

	// TCP: one connection per ufrag, two in all.
	dialTCP := func(ufrag string) net.Conn {
		c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.port)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		_, _ = c.Write(frame4571(stunRequest(t, ufrag+":browser", "pw")))

		return c
	}
	for i, c := range []struct {
		ufrag string
		want  bool
	}{{"cmnsTcpA", true}, {"cmnsTcpA", false}, {"cmnsTcpB", true}, {"cmnsTcpC", false}} {
		conn := dialTCP(c.ufrag)
		if _, ok := readWithin(t, conn, time.Second); ok != c.want {
			t.Fatalf("TCP %d (%s): answered %v", i, c.ufrag, ok)
		}
	}
	if st := f.srv.voice.stats(); st.TCPConnections != 2 {
		t.Fatalf("relay %+v", st)
	}
}

// Security's GDS-1: a stranger's requests for ufrags Commons never answers can't lock members out. They're pending
// for at most pendingTTL, a few per client network, and a full table gives way to the newest, so a member's own request
// only needs its place for the moment Commons takes to answer. Packets come from many networks here, so this calls
// the relay as Pion's mux would.
func TestVoiceRelayFloodFromManyNetworks(t *testing.T) {
	commons := startCommons(t)
	commons.answer.Store(false)
	lim := testVoiceLimits
	lim.udpPending, lim.udpPendingPerNet = 64, 2
	r, err := newVoiceRelay(commons.addr, lim, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.close)
	out, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = out.Close() })
	r.out = out
	r.setEnabled(true)
	go r.sweep()

	// 3000 spoofed sources, 2 from each of 1500 /24s, each a fake ufrag. Commons never answers any.
	for i := 0; i < 3000; i++ {
		from := netip.AddrPortFrom(netip.AddrFrom4([4]byte{10, byte(i / 2 >> 8), byte(i / 2), byte(1 + i%2)}), 40000)
		r.onUDP(stunRequest(t, fmt.Sprintf("cmnsFake%d:x", i), "pw"), from)
	}
	// A third from a network that has two pending is refused, not pending.
	r.onUDP(stunRequest(t, "cmnsFakeMore:x", "pw"), netip.AddrPortFrom(netip.AddrFrom4([4]byte{10, 1499 >> 8, 1499 & 0xff, 9}), 1))
	st := r.stats()
	if st.UDPPending != 64 || st.UDPMappings != 0 || st.Evicted != 3000-64 || st.Refused != 1 {
		t.Fatalf("after the flood: %+v", st)
	}

	// A member's request in the middle of a flood: Commons answers it, and it's a mapping.
	commons.live.Store(&map[string]bool{"cmnsMember": true})
	commons.answer.Store(true)
	stop, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			from := netip.AddrPortFrom(netip.AddrFrom4([4]byte{11, byte(i >> 8), byte(i), 1}), uint16(1024+i%60000))
			r.onUDP(stunRequest(t, fmt.Sprintf("cmnsFlood%d:x", i), "pw"), from)
		}
	}()
	member := netip.MustParseAddrPort("198.51.100.7:5000")
	deadline := time.Now().Add(5 * time.Second)
	for {
		r.onUDP(stunRequest(t, "cmnsMember:browser", "pw"), member)
		time.Sleep(20 * time.Millisecond)
		r.mu.Lock()
		m := r.byAddr[member]
		ok := m != nil && m.confirmed
		r.mu.Unlock()
		if ok {
			break
		}
		if time.Now().After(deadline) {
			close(stop)
			t.Fatalf("the member's request never became a mapping: %+v", r.stats())
		}
	}
	close(stop)
	<-stopped

	// A fake ufrag Commons never answers: pending, then gone after pendingTTL, with nothing left.
	commons.answer.Store(false)
	r.closeAll()
	r.onUDP(stunRequest(t, "cmnsNobody:x", "pw"), netip.MustParseAddrPort("203.0.113.5:9"))
	if st := r.stats(); st.UDPPending != 1 {
		t.Fatalf("%+v", st)
	}
	time.Sleep(lim.pendingTTL + 2*voiceSweepEvery)
	if st := r.stats(); st.UDPPending != 0 || st.UDPMappings != 0 {
		t.Fatalf("after pendingTTL: %+v", st)
	}
	r.mu.Lock()
	left := len(r.byAddr) + len(r.udpByNet) + len(r.udpByUfrag)
	r.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d entries left", left)
	}
}

// Pending ICE-TCP connections are capped per client network, and a full table gives way to the newest.
func TestVoiceRelayTCPPendingPerNetworkAndEviction(t *testing.T) {
	lim := testVoiceLimits
	lim.tcpPendingPerNet, lim.tcpPending = 2, 2
	f, commons := startRelay(t, lim)
	d := f.deskd()
	d.configureGuild(0, 0)
	commons.answer.Store(false)
	dial := func(ufrag string) net.Conn {
		c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.port)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		_, _ = c.Write(frame4571(stunRequest(t, ufrag+":x", "pw")))

		return c
	}
	// Loopback is one network: two pending, the third refused.
	c0, c1 := dial("cmnsPend0"), dial("cmnsPend1")
	<-commons.got
	<-commons.got
	c2 := dial("cmnsPend2")
	commons.expectNothing(300 * time.Millisecond)
	if _, ok := readWithin(t, c2, 300*time.Millisecond); ok {
		t.Fatal("the third was relayed")
	}
	if st := f.srv.voice.stats(); st.TCPPending != 2 || st.Refused != 1 {
		t.Fatalf("relay %+v", st)
	}
	// Once Commons answers one, it's no longer pending, and the network has room again.
	commons.answer.Store(true)
	_, _ = c0.Write(frame4571([]byte("again")))
	commons.expect([]byte("again"), true)
	if _, ok := readWithin(t, c0, 2*time.Second); !ok {
		t.Fatal("no answer")
	}
	c3 := dial("cmnsPend3")
	if _, ok := readWithin(t, c3, 2*time.Second); !ok {
		t.Fatal("no room after an answer")
	}
	_ = c1
	if st := f.srv.voice.stats(); st.TCPConnections != 2 || st.TCPPending != 1 {
		t.Fatalf("relay %+v", st)
	}
}

// When every pending place is taken by networks of their own, a new connection pushes out the oldest.
func TestVoiceRelayTCPEvictsTheOldestPending(t *testing.T) {
	commons := startCommons(t)
	commons.answer.Store(false)
	lim := testVoiceLimits
	lim.tcpPending = 2
	r, err := newVoiceRelay(commons.addr, lim, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.close)
	r.setEnabled(true)
	conns := make([]net.Conn, 3)
	for i := range conns {
		a, b := net.Pipe()
		t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
		conns[i] = b
		fc := &fakeRemote{Conn: a, ip: netip.AddrFrom4([4]byte{10, byte(i), 0, 1})}
		if !r.takeTCP(fc, frame4571(stunRequest(t, fmt.Sprintf("cmnsT%d:x", i), "pw")), fmt.Sprintf("cmnsT%d", i)) {
			t.Fatalf("connection %d refused", i)
		}
	}
	// The first was pushed out: its client end sees the close.
	_ = conns[0].SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conns[0].Read(make([]byte, 1)); err == nil || isTimeout(err) {
		t.Fatalf("the oldest pending connection stayed: %v", err)
	}
	if st := r.stats(); st.Evicted != 1 || st.TCPPending != 2 {
		t.Fatalf("%+v", st)
	}
}

// fakeRemote is a connection from a client address of the test's choosing.
type fakeRemote struct {
	net.Conn
	ip netip.Addr
}

func (c *fakeRemote) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: c.ip.AsSlice(), Port: 40000}
}

func TestVoiceRelayExpiry(t *testing.T) {
	lim := testVoiceLimits
	lim.pendingTTL, lim.idleTTL = 300*time.Millisecond, 1500*time.Millisecond
	f, commons := startRelay(t, lim)
	d := f.deskd()
	d.configureGuild(0, 0)
	count := func() (int, int) {
		st := f.srv.voice.stats()

		return st.UDPMappings + st.UDPPending, st.TCPConnections + st.TCPPending
	}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				udp, tcp := count()
				t.Fatalf("%s: still %d UDP, %d TCP", what, udp, tcp)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}

	// Pending: Commons never answers, so the mapping goes, and the address's next packet goes nowhere.
	commons.answer.Store(false)
	u := udpClient(t, f.port)
	req := stunRequest(t, "cmnsNever:x", "pw")
	_, _ = u.Write(req)
	commons.expect(req, false)
	waitFor("pending mapping", func() bool { udp, _ := count(); return udp == 0 })
	_, _ = u.Write([]byte("rtp"))
	commons.expectNothing(300 * time.Millisecond)

	// Confirmed, then idle: it lasts while packets flow, then goes.
	commons.answer.Store(true)
	u2 := udpClient(t, f.port)
	req2 := stunRequest(t, "cmnsIdle:x", "pw")
	_, _ = u2.Write(req2)
	commons.expect(req2, false)
	if _, ok := readWithin(t, u2, 2*time.Second); !ok {
		t.Fatal("no answer")
	}
	for i := 0; i < 4; i++ { // 2 s of traffic, past the idle time
		time.Sleep(500 * time.Millisecond)
		_, _ = u2.Write([]byte("keep"))
		commons.expect([]byte("keep"), false)
	}
	waitFor("idle mapping", func() bool { udp, _ := count(); return udp == 0 })
	_, _ = u2.Write([]byte("late"))
	commons.expectNothing(300 * time.Millisecond)

	// TCP: Commons silent past the pending time ends the connection.
	commons.answer.Store(false)
	c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(f.port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write(frame4571(stunRequest(t, "cmnsTcpNever:x", "pw")))
	<-commons.got
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(make([]byte, 16)); err == nil || isTimeout(err) {
		t.Fatalf("the relayed connection outlived Commons' silence: %v", err)
	}
	waitFor("TCP splice", func() bool { _, tcp := count(); return tcp == 0 })
}

func isTimeout(err error) bool {
	var ne net.Error

	return errors.As(err, &ne) && ne.Timeout()
}

func TestVoiceRelayStaysOnLoopback(t *testing.T) {
	for _, bad := range []string{"10.0.0.1:8799", "0.0.0.0:8799", "127.0.0.1:0", "localhost:8799", "[::1]:8799", "8799"} {
		_, err := New(Config{
			SocketPath: t.TempDir() + "/s", DataDir: t.TempDir(), Bind: "127.0.0.1", Port: freePort(t),
			VoiceRelayAddr: bad, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		if err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
