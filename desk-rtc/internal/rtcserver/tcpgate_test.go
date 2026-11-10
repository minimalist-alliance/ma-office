package rtcserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/stun/v4"
)

// The TCP gate's waiting places (tcpgate.go), against real loopback TCP. A client network is a source address in its
// own 127.0.N.0/24: Linux treats all of 127.0.0.0/8 as local, so a client can bind 127.0.N.x with no setup, and the
// gate sees the address the handshake came from. IPv6 networks are the same connections with their source address
// rewritten (sixListener), since a test can't bind distinct IPv6 addresses without root.

const gateKnownUfrag = "deskufrag"

type gateRig struct {
	t      *testing.T
	gate   *gateListener
	addr   *net.TCPAddr
	passed chan net.Conn // what the mux would get
	// maxPerNet and maxWaiting are the most the gate ever held, sampled every millisecond.
	maxPerNet, maxWaiting atomic.Int64
}

// startGate runs a gate on 127.0.0.1 with the given places. wrap, if set, wraps the real listener.
func startGate(t *testing.T, lim gateLimits, wrap func(net.Listener) net.Listener) *gateRig {
	t.Helper()
	ln, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	var inner net.Listener = ln
	if wrap != nil {
		inner = wrap(ln)
	}
	r := &gateRig{t: t, gate: newGateListener(inner, slog.New(slog.DiscardHandler)), addr: ln.Addr().(*net.TCPAddr),
		passed: make(chan net.Conn, 4096)}
	r.gate.allow = func(u string) bool { return u == gateKnownUfrag }
	// The caps past the gate have tests of their own; here every passed connection is read and closed at once, and
	// some tests pass dozens on the one ufrag.
	r.gate.handedPerUfrag, r.gate.handedPerNet = 1<<20, 1<<20
	r.gate.setLimits(lim)
	go r.gate.serve()
	go func() {
		for {
			c, err := r.gate.Accept()
			if err != nil {
				return
			}
			r.passed <- c
		}
	}()
	stop := make(chan struct{})
	go func() {
		tick := time.NewTicker(time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
			}
			r.gate.mu.Lock()
			w, most := r.gate.waiting, 0
			for _, n := range r.gate.byNet {
				most = max(most, len(n.places))
			}
			r.gate.mu.Unlock()
			if int64(w) > r.maxWaiting.Load() {
				r.maxWaiting.Store(int64(w))
			}
			if int64(most) > r.maxPerNet.Load() {
				r.maxPerNet.Store(int64(most))
			}
		}
	}()
	t.Cleanup(func() {
		close(stop)
		_ = r.gate.Close()
		for {
			select {
			case c := <-r.passed:
				_ = c.Close()
			default:
				return
			}
		}
	})

	return r
}

func (r *gateRig) held() (waiting int, perNet map[netip.Prefix]int) {
	r.gate.mu.Lock()
	defer r.gate.mu.Unlock()
	perNet = map[netip.Prefix]int{}
	for k, n := range r.gate.byNet {
		perNet[k] = len(n.places)
	}

	return r.gate.waiting, perNet
}

// waitHeld waits until the gate holds want places, or fails.
func (r *gateRig) waitHeld(want int, within time.Duration) {
	r.t.Helper()
	end := time.Now().Add(within)
	for {
		w, _ := r.held()
		if w == want {
			return
		}
		if time.Now().After(end) {
			r.t.Fatalf("the gate holds %d places, want %d", w, want)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (r *gateRig) dial(src string) (net.Conn, error) {
	d := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(src)}, Timeout: 2 * time.Second}

	return d.Dial("tcp4", r.addr.String())
}

// framedBinding is an RFC 4571 frame holding a binding request to ufrag, as a browser's first ICE-TCP check.
func framedBinding(t testing.TB, ufrag string) []byte {
	t.Helper()
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest, stun.NewUsername(ufrag+":client"),
		stun.NewShortTermIntegrity("pwd"), stun.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}

	return append([]byte{byte(len(msg.Raw) >> 8), byte(len(msg.Raw))}, msg.Raw...)
}

// member connects from src, sends its check, and reports whether the gate passed the connection on within d. The
// passed connection is read to its first frame, which must be the check.
func (r *gateRig) member(src string, d time.Duration) error {
	c, err := r.dial(src)
	if err != nil {
		return err
	}
	defer c.Close()
	want := framedBinding(r.t, gateKnownUfrag)
	if _, err := c.Write(want); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	local := c.LocalAddr().String()
	end := time.After(d)
	for {
		select {
		case got := <-r.passed:
			if origRemote(got) != local {
				r.passed <- got // another member's: put it back
				time.Sleep(time.Millisecond)

				continue
			}
			buf := make([]byte, len(want))
			_, err := io.ReadFull(got, buf)
			_ = got.Close()
			if err != nil || string(buf) != string(want) {
				return fmt.Errorf("passed on, but its first frame came out wrong: %v", err)
			}

			return nil
		case <-end:
			return errors.New("not passed on")
		}
	}
}

// flood keeps workers connections from src open and silent, or with send's bytes and nothing more, opening another
// as soon as the gate closes one, until ctx ends. It returns how many it opened.
func (r *gateRig) flood(ctx context.Context, wg *sync.WaitGroup, src string, workers int, send []byte) *atomic.Int64 {
	opened := &atomic.Int64{}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 64)
			for ctx.Err() == nil {
				c, err := r.dial(src)
				if err != nil {
					time.Sleep(5 * time.Millisecond)

					continue
				}
				opened.Add(1)
				if len(send) > 0 {
					_, _ = c.Write(send)
				}
				start := time.Now()
				for ctx.Err() == nil { // until the gate closes it, or the end
					_ = c.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
					_, err := c.Read(buf)
					var ne net.Error
					if err != nil && !(errors.As(err, &ne) && ne.Timeout()) {
						break
					}
				}
				_ = c.Close()
				if time.Since(start) < 20*time.Millisecond {
					time.Sleep(20 * time.Millisecond) // turned away at once: about 50 tries a second a worker
				}
			}
		}()
	}

	return opened
}

func netOf(s string) netip.Prefix { return clientNetwork(netip.MustParseAddr(s)) }

// Three networks flood the gate with silent connections, each trying to hold far more than its share. A fourth
// network's check gets through every time, and no network ever holds more than 16 places.
func TestGateFloodFromThreeNetworksLeavesAFourth(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	var opened []*atomic.Int64
	for _, src := range []string{"127.0.1.1", "127.0.2.1", "127.0.3.1"} {
		opened = append(opened, r.flood(ctx, &wg, src, 40, nil))
	}
	r.waitHeld(48, 5*time.Second)

	got := 0
	const tries = 30
	for i := range tries {
		if err := r.member("127.0.4."+strconv.Itoa(1+i%200), 2*time.Second); err != nil {
			t.Errorf("try %d: %v", i, err)
		} else {
			got++
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, perNet := r.held()
	cancel()
	wg.Wait()
	t.Logf("the 4th network got in %d of %d times; flooders opened %d, %d, %d connections; held %v; most a network ever held %d, most in all %d",
		got, tries, opened[0].Load(), opened[1].Load(), opened[2].Load(), perNet, r.maxPerNet.Load(), r.maxWaiting.Load())
	if r.maxPerNet.Load() > gatePerNet {
		t.Fatalf("a network held %d places, over %d", r.maxPerNet.Load(), gatePerNet)
	}
	if r.maxWaiting.Load() > int64(memberGateLimits.total) {
		t.Fatalf("the gate held %d places, over %d", r.maxWaiting.Load(), memberGateLimits.total)
	}
	if got != tries {
		t.Fatalf("the 4th network got in %d of %d times", got, tries)
	}
	if r.gate.refusedNet.Load() == 0 {
		t.Fatal("no connection was refused for its network's cap, so the flood never reached it")
	}
}

// Six networks flood: they can fill every place, 16 a network, and a newcomer still gets in, by taking a place from
// the network holding the most. The newcomer's place is never taken back while it waits.
func TestGateFloodFromSixNetworksStillLetsANewcomerIn(t *testing.T) {
	r := startGate(t, memberGateLimits, nil)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for n := 1; n <= 6; n++ {
		r.flood(ctx, &wg, "127.0."+strconv.Itoa(10+n)+".1", 30, nil)
	}
	r.waitHeld(memberGateLimits.total, 5*time.Second)

	got := 0
	const tries = 30
	for i := range tries {
		if err := r.member("127.0.20."+strconv.Itoa(1+i), 2*time.Second); err != nil {
			t.Errorf("try %d: %v", i, err)
		} else {
			got++
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A household's 12 together, each sending its check as it connects, as a browser does: all of them.
	var hwg sync.WaitGroup
	var household atomic.Int64
	for i := range 12 {
		hwg.Add(1)
		go func() {
			defer hwg.Done()
			if err := r.member("127.0.21."+strconv.Itoa(1+i%3), 3*time.Second); err != nil {
				t.Errorf("household connection %d: %v", i, err)
			} else {
				household.Add(1)
			}
		}()
	}
	hwg.Wait()

	cancel()
	wg.Wait()
	t.Logf("newcomer %d of %d; household %d of 12; evicted %d, refused full %d, refused per network %d",
		got, tries, household.Load(), r.gate.evicted.Load(), r.gate.refusedFull.Load(), r.gate.refusedNet.Load())
	if got != tries || household.Load() != 12 {
		t.Fatalf("newcomer %d of %d, household %d of 12", got, tries, household.Load())
	}
	if r.maxPerNet.Load() > gatePerNet || r.maxWaiting.Load() > int64(memberGateLimits.total) {
		t.Fatalf("held %d a network, %d in all", r.maxPerNet.Load(), r.maxWaiting.Load())
	}
}

// origRemote is the address a passed connection really came from, under sixListener's rewrite.
func origRemote(c net.Conn) string {
	if pc, ok := c.(*primedConn); ok {
		c = pc.Conn
	}
	if sc, ok := c.(*sixConn); ok {
		return sc.Conn.RemoteAddr().String()
	}

	return c.RemoteAddr().String()
}

// passAll sends each connection's check and counts those the gate passes on.
func passAll(t *testing.T, r *gateRig, conns []net.Conn) int {
	t.Helper()
	want := framedBinding(t, gateKnownUfrag)
	locals := map[string]bool{}
	for _, c := range conns {
		locals[c.LocalAddr().String()] = true
		if _, err := c.Write(want); err != nil {
			t.Errorf("write: %v", err)
		}
	}
	got := 0
	end := time.After(3 * time.Second)
	for got < len(conns) {
		select {
		case c := <-r.passed:
			if locals[origRemote(c)] {
				got++
			}
			_ = c.Close()
		case <-end:
			return got
		}
	}

	return got
}

// A slow-loris holds places without sending, or with a frame begun and never finished. It holds 16 at most, each for
// the first-packet deadline only; its 17th is closed at once; and another network gets in meanwhile.
func TestGateSlowLoris(t *testing.T) {
	lim := memberGateLimits
	lim.firstPacket = 500 * time.Millisecond
	r := startGate(t, lim, nil)

	sends := [][]byte{nil, {0x00}, {0x00, 0x40, 0x00, 0x01}} // nothing; half a length; a frame of 64 begun
	var conns []net.Conn
	opened := time.Now()
	for i := range 16 {
		c, err := r.dial("127.0.30.1")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		if s := sends[i%len(sends)]; len(s) > 0 {
			if _, err := c.Write(s); err != nil {
				t.Fatal(err)
			}
		}
		conns = append(conns, c)
	}
	r.waitHeld(16, 2*time.Second)

	// The 17th from the same network is closed at once.
	extra, err := r.dial("127.0.30.1")
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	_ = extra.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, err := extra.Read(make([]byte, 1)); !errors.Is(err, io.EOF) && !isReset(err) {
		t.Fatalf("the 17th connection from one network: %v, want it closed at once", err)
	}

	// Another network gets in while the loris holds its 16.
	if err := r.member("127.0.31.1", time.Second); err != nil {
		t.Fatalf("another network: %v", err)
	}

	// Every loris connection is closed at the deadline, and its places come back.
	var closedAt []time.Duration
	for _, c := range conns {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, err := c.Read(make([]byte, 1)); !errors.Is(err, io.EOF) && !isReset(err) {
			t.Fatalf("a silent connection: %v, want it closed by the gate", err)
		}
		closedAt = append(closedAt, time.Since(opened))
	}
	r.waitHeld(0, time.Second)
	last := closedAt[len(closedAt)-1]
	t.Logf("16 silent or half-sent connections closed by %v (deadline %v); refused per network %d", last, lim.firstPacket, r.gate.refusedNet.Load())
	if closedAt[0] < lim.firstPacket-50*time.Millisecond || last > lim.firstPacket+time.Second {
		t.Fatalf("closed between %v and %v, want at the %v deadline", closedAt[0], last, lim.firstPacket)
	}
	if r.gate.refusedNet.Load() < 1 {
		t.Fatal("the 17th wasn't counted")
	}
	// And the network can come back once they're gone.
	if err := r.member("127.0.30.3", time.Second); err != nil {
		t.Fatalf("the loris's network after its places came back: %v", err)
	}
}

func isReset(err error) bool {
	var ne *net.OpError

	return errors.As(err, &ne) && !ne.Timeout()
}

// A household or an office behind one address: 12 connections at once, all held in the gate at the same moment before
// any sends, all get through; and 40 in a row, more than its 16 places, since a place is given back at the first frame.
func TestGateHouseholdOfTwelve(t *testing.T) {
	for _, flooded := range []bool{false, true} {
		t.Run(map[bool]string{false: "quiet", true: "three networks flooding"}[flooded], func(t *testing.T) {
			r := startGate(t, memberGateLimits, nil)
			ctx, cancel := context.WithCancel(context.Background())
			var wg sync.WaitGroup
			defer func() { cancel(); wg.Wait() }()
			base := 0
			if flooded {
				for _, src := range []string{"127.0.41.1", "127.0.42.1", "127.0.43.1"} {
					r.flood(ctx, &wg, src, 40, nil)
				}
				r.waitHeld(48, 5*time.Second)
				base = 48
			}
			conns := make([]net.Conn, 0, 12)
			for range 12 {
				c, err := r.dial("127.0.50.9")
				if err != nil {
					t.Fatal(err)
				}
				defer c.Close()
				conns = append(conns, c)
			}
			r.waitHeld(base+12, 3*time.Second)
			if got := passAll(t, r, conns); got != 12 {
				t.Fatalf("%d of 12 at once got through", got)
			}
			for i := range 40 {
				if err := r.member("127.0.50.9", 2*time.Second); err != nil {
					t.Fatalf("one after another, number %d: %v", i+1, err)
				}
			}
		})
	}
}

// sixListener rewrites each connection's source address from 127.0.A.B to 2001:db8:0:A:B00::1, so A picks the /64 and
// B an address inside it that differs in the interface id's top bits: a household's devices on one /64.
type sixListener struct{ net.Listener }

type sixConn struct {
	net.Conn
	remote *net.TCPAddr
}

func (c *sixConn) RemoteAddr() net.Addr { return c.remote }

func sixOf(v4 net.IP) net.IP {
	v4 = v4.To4()
	ip := net.ParseIP("2001:db8::1")
	ip[7] = v4[2]
	ip[8] = v4[3]

	return ip
}

func (l sixListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	ra := c.RemoteAddr().(*net.TCPAddr)

	return &sixConn{Conn: c, remote: &net.TCPAddr{IP: sixOf(ra.IP), Port: ra.Port}}, nil
}

// IPv6: places count per /64. Addresses on one /64 share its 16, however they differ inside it; the next /64 over has
// its own 16; and IPv4-mapped addresses count as their IPv4 /24.
func TestGateIPv6CountsPer64(t *testing.T) {
	a, b := sixOf(net.IPv4(127, 0, 61, 1)), sixOf(net.IPv4(127, 0, 61, 2))
	if !netOf(a.String()).Contains(netip.MustParseAddr(b.String())) || netOf(a.String()).Bits() != 64 {
		t.Fatalf("%v and %v should share a /64: %v", a, b, netOf(a.String()))
	}
	if c := sixOf(net.IPv4(127, 0, 62, 1)); netOf(c.String()) == netOf(a.String()) {
		t.Fatalf("%v and %v are on different /64s", a, c)
	}
	if got := netOf("::ffff:198.51.100.7"); got != netip.MustParsePrefix("198.51.100.0/24") {
		t.Fatalf("an IPv4-mapped address counts as %v", got)
	}

	r := startGate(t, memberGateLimits, func(l net.Listener) net.Listener { return sixListener{l} })
	var conns []net.Conn
	for i := range 16 {
		c, err := r.dial("127.0.61." + strconv.Itoa(1+i%8)) // 8 addresses of one /64
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		conns = append(conns, c)
	}
	r.waitHeld(16, 2*time.Second)
	if _, perNet := r.held(); len(perNet) != 1 || perNet[netOf(a.String())] != 16 {
		t.Fatalf("held %v, want 16 on %v", perNet, netOf(a.String()))
	}
	// A 17th from yet another address on the /64 is closed at once.
	extra, err := r.dial("127.0.61.1")
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	_ = extra.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, err := extra.Read(make([]byte, 1)); !errors.Is(err, io.EOF) && !isReset(err) {
		t.Fatalf("a 17th on the /64: %v, want it closed", err)
	}
	// The next /64 has its own places: 16 at once.
	var next []net.Conn
	for range 16 {
		c, err := r.dial("127.0.62.1")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		next = append(next, c)
	}
	r.waitHeld(32, 2*time.Second)
	if got := passAll(t, r, next); got != 16 {
		t.Fatalf("the next /64 got %d of 16 through", got)
	}
	if got := passAll(t, r, conns); got != 16 {
		t.Fatalf("the first /64 got %d of 16 through", got)
	}
}

// The eviction rule, without a network: the full gate's largest network gives up its oldest place, but only to a
// network holding at least two fewer; equals never trade places.
func TestGateEvictionRule(t *testing.T) {
	g := newGateListener(nil, slog.New(slog.DiscardHandler))
	g.setLimits(gateLimits{total: 6, perNet: 4, firstPacket: time.Second})
	type fake struct {
		net.Conn
		addr   *net.TCPAddr
		closed atomic.Bool
	}
	var all []*fake
	conn := func(ip string) *fake {
		a, b := net.Pipe()
		_ = b.Close()
		f := &fake{Conn: a, addr: &net.TCPAddr{IP: net.ParseIP(ip), Port: 1000 + len(all)}}
		all = append(all, f)

		return f
	}
	admit := func(ip string) (*gatePlace, *fake) {
		f := conn(ip)
		return g.admit(&closeTracker{Conn: f, addr: f.addr, closed: &f.closed}), f
	}
	// A holds 4 (its cap), B 2: full.
	var aPlaces []*gatePlace
	for range 4 {
		p, _ := admit("192.0.2.1")
		aPlaces = append(aPlaces, p)
	}
	for range 2 {
		if p, _ := admit("198.51.100.1"); p == nil {
			t.Fatal("B refused before the gate was full")
		}
	}
	if p, _ := admit("192.0.2.1"); p != nil {
		t.Fatal("A's 5th admitted past its cap")
	}
	// C (0) takes A's oldest: 4 >= 0+2.
	if p, _ := admit("203.0.113.1"); p == nil {
		t.Fatal("C refused with A holding 4")
	}
	if !aPlaces[0].gone || !all[0].closed.Load() {
		t.Fatal("A's oldest place wasn't taken and closed")
	}
	// Now A 3, B 2, C 1. B (2) can't take from A (3): 3 < 2+2.
	if p, _ := admit("198.51.100.2"); p != nil {
		t.Fatal("B took a place from A, one more than B: they'd trade forever")
	}
	// C (1) takes A's next oldest: 3 >= 1+2.
	if p, _ := admit("203.0.113.2"); p == nil || !aPlaces[1].gone {
		t.Fatal("C couldn't take from A with 3 against 1")
	}
	// A 2, B 2, C 2: nobody takes from anybody, a fourth network included... unless it has 0: 2 >= 0+2.
	if p, _ := admit("192.0.2.2"); p != nil {
		t.Fatal("A took a place back from equals")
	}
	if p, _ := admit("233.252.0.1"); p == nil {
		t.Fatal("D (0) refused with three networks at 2")
	}
	// The oldest among the largest gave it up: B's first place was older than C's, and A's 3rd older than both.
	if !aPlaces[2].gone {
		t.Fatal("the oldest place among the largest networks wasn't the one taken")
	}
	// A place given back is counted once, and a taken place can't be given back.
	if g.leave(aPlaces[2]) {
		t.Fatal("a taken place was given back")
	}
	if !g.leave(aPlaces[3]) || g.leave(aPlaces[3]) {
		t.Fatal("leave isn't once only")
	}
	g.mu.Lock()
	w, nets := g.waiting, len(g.byNet)
	g.mu.Unlock()
	if w != 5 || nets != 3 {
		t.Fatalf("waiting %d in %d networks, want 5 in 3 (A's last place given back)", w, nets)
	}
	if g.evicted.Load() != 3 || g.refusedNet.Load() != 1 || g.refusedFull.Load() != 2 {
		t.Fatalf("evicted %d, refused per network %d, refused full %d", g.evicted.Load(), g.refusedNet.Load(), g.refusedFull.Load())
	}
}

type closeTracker struct {
	net.Conn
	addr   net.Addr
	closed *atomic.Bool
}

func (c *closeTracker) RemoteAddr() net.Addr { return c.addr }
func (c *closeTracker) Close() error         { c.closed.Store(true); return c.Conn.Close() }

// A Guild Desk's places scale with its members, 2 a member a network and four networks' worth in all, from configure's
// limits; never under a member's desk's, never past 200 members'.
func TestGuildGateLimits(t *testing.T) {
	cases := []struct{ max, per, perNet, total int }{
		{600, 3, 400, 1600}, // what deskd sends: 200 members
		{150, 3, 100, 400},  // 50 members, a t4g.medium's tier
		{75, 3, 50, 200},    // 25, a t4g.small's
		{74, 3, 50, 200},    // a member's last session rounds up
		{6, 3, 16, 64},      // 2 members: a member's desk's floor
		{10000, 3, 400, 1600},
		{600, 0, 16, 64},
		{0, 3, 16, 64},
	}
	for _, c := range cases {
		got := guildGateLimits(c.max, c.per)
		if got.perNet != c.perNet || got.total != c.total || got.firstPacket != gateFirstPacketTimeout {
			t.Errorf("guildGateLimits(%d, %d) = %+v, want %d a network, %d in all", c.max, c.per, got, c.perNet, c.total)
		}
	}
	if memberGateLimits.total != 64 || memberGateLimits.perNet != 16 || memberGateLimits.firstPacket != 3*time.Second {
		t.Fatalf("a member's desk's places are %+v", memberGateLimits)
	}
}

// An office of 100 behind one address on a 50-member Guild Desk's gate, all waiting at once while three other networks
// flood at their cap: all 100 get through.
func TestGuildGateOfficeBehindOneAddress(t *testing.T) {
	lim := guildGateLimits(150, 3) // 100 a network, 400 in all
	r := startGate(t, lim, nil)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	for _, src := range []string{"127.0.71.1", "127.0.72.1", "127.0.73.1"} {
		r.flood(ctx, &wg, src, 130, nil)
	}
	r.waitHeld(300, 10*time.Second)
	conns := make([]net.Conn, 0, 100)
	for range 100 {
		c, err := r.dial("127.0.80.80")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		conns = append(conns, c)
	}
	r.waitHeld(400, 5*time.Second)
	if got := passAll(t, r, conns); got != 100 {
		t.Fatalf("the office got %d of 100 through", got)
	}
	if r.maxPerNet.Load() > int64(lim.perNet) || r.maxWaiting.Load() > int64(lim.total) {
		t.Fatalf("held %d a network, %d in all, over %+v", r.maxPerNet.Load(), r.maxWaiting.Load(), lim)
	}
}

// configure sets the gate: a Guild Desk's places from its limits, any other kind a member's desk's, and a dropped link
// keeps the last.
func TestConfigureSetsTheGate(t *testing.T) {
	f := startServer(t, 30*time.Second)
	if got := f.srv.gate.limits(); got != memberGateLimits {
		t.Fatalf("before configure: %+v", got)
	}
	d := f.deskd()
	d.configureGuild(150, 3)
	if got, want := f.srv.gate.limits(), guildGateLimits(150, 3); got != want || got.perNet != 100 {
		t.Fatalf("a 50-member Guild Desk: %+v, want %+v", got, want)
	}
	d.configureGuild(0, 0)
	if got := f.srv.gate.limits(); got.perNet != 400 || got.total != 1600 {
		t.Fatalf("a Guild Desk at the ceiling: %+v", got)
	}
	d.configure("127.0.0.1", 4)
	if got := f.srv.gate.limits(); got != memberGateLimits {
		t.Fatalf("a member's desk after a Guild Desk's configure: %+v", got)
	}
}

// Max-min fairness, without timing: six networks flood a full gate round after round, then a household arrives with 12
// connections that stay silent, and the floods carry on. The household gets the fair share at once, 64 over 7 networks
// (9), taken from the floods, and keeps it; nobody ends below it. Nothing leaves in this test (no deadline), so this is
// the worst case for the household: real connections leave the gate in about a round trip, so a household's 12 rarely
// wait together (TestGateFloodFromSixNetworksStillLetsANewcomerIn).
func TestGateSharesFairlyUnderManyNetworks(t *testing.T) {
	g := newGateListener(nil, slog.New(slog.DiscardHandler))
	n := 0
	admit := func(ip string) *gatePlace {
		a, b := net.Pipe()
		_ = b.Close()
		n++
		var closed atomic.Bool

		return g.admit(&closeTracker{Conn: a, addr: &net.TCPAddr{IP: net.ParseIP(ip), Port: n}, closed: &closed})
	}
	floods := []string{"192.0.2.1", "198.51.100.1", "203.0.113.1", "100.64.1.1", "100.64.2.1", "100.64.3.1"}
	round := func() {
		for range 40 {
			for _, ip := range floods {
				admit(ip)
			}
		}
	}
	round()
	counts := func() map[netip.Prefix]int {
		g.mu.Lock()
		defer g.mu.Unlock()
		m := map[netip.Prefix]int{}
		for k, v := range g.byNet {
			m[k] = len(v.places)
		}

		return m
	}
	if c := counts(); len(c) != 6 || g.waiting != 64 {
		t.Fatalf("six floods: %v, %d waiting", c, g.waiting)
	}
	// Its first 9 at once take a place each from the largest flood; past its fair share it's refused, as anyone is.
	got := 0
	for range 12 {
		if admit("100.64.9.9") != nil {
			got++
		}
	}
	if got != 64/7 {
		t.Fatalf("the household got %d places at once in a gate held by six floods, want its fair share %d", got, 64/7)
	}
	round()
	round()
	c := counts()
	home := c[netOf("100.64.9.9")]
	t.Logf("after the floods carried on: %v; evicted %d, refused full %d", c, g.evicted.Load(), g.refusedFull.Load())
	if home < 64/7 {
		t.Fatalf("the household holds %d, under the fair share of %d", home, 64/7)
	}
	for k, v := range c {
		if v < 64/7 || v > 64/7+1 {
			t.Fatalf("%v holds %d, want %d or %d", k, v, 64/7, 64/7+1)
		}
	}
}
