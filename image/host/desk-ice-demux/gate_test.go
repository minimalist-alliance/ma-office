package main

import (
	"net"
	"net/netip"
	"testing"
	"time"
)

// fakeConn is a connection from an address, for the gate's arithmetic alone.
type fakeConn struct {
	net.Conn
	remote *net.TCPAddr
	closed bool
}

func (c *fakeConn) RemoteAddr() net.Addr { return c.remote }
func (c *fakeConn) Close() error         { c.closed = true; return nil }

func from(ip string) *fakeConn {
	return &fakeConn{remote: &net.TCPAddr{IP: net.ParseIP(ip), Port: 40000}}
}

func testLimits() limits {
	return limits{perNet: 4, total: 12, wait: 5 * time.Second, pressureWait: 3 * time.Second, handedPerNet: 3, handedTotal: 5}
}

func TestOneNetworkHoldsAtMostItsPlaces(t *testing.T) {
	g := newGate(testLimits(), &stats{})
	for i := range 4 {
		if g.admit(from("192.0.2.1")) == nil {
			t.Fatalf("place %d refused", i)
		}
	}
	if g.admit(from("192.0.2.1")) != nil {
		t.Fatal("a fifth place for the same address")
	}
	// another address of the same /24 holding none takes the holder's oldest (one address can't hold its /24)
	old := g.byNet[networkOf(netip.MustParseAddr("192.0.2.1"))].places[0]
	if g.admit(from("192.0.2.77")) == nil || !old.gone || !old.c.(*fakeConn).closed {
		t.Fatal("a sibling address was shut out by one address holding the whole network")
	}
	if g.admit(from("198.51.100.1")) == nil {
		t.Fatal("another network refused")
	}
	if g.st.refusedPerNet.Load() != 1 || g.st.evicted.Load() != 1 {
		t.Fatalf("refusedPerNet %d, evicted %d", g.st.refusedPerNet.Load(), g.st.evicted.Load())
	}
}

func TestAFullGateSharesItsPlacesFairly(t *testing.T) {
	g := newGate(testLimits(), &stats{})
	for _, ip := range []string{"192.0.2.1", "192.0.2.2", "198.51.100.1", "198.51.100.2", "203.0.113.1", "203.0.113.2"} {
		for range 2 {
			if g.admit(from(ip)) == nil {
				t.Fatal("refused before full")
			}
		}
	}
	if w, nets, _ := g.counts(); w != 12 || nets != 3 {
		t.Fatalf("waiting %d in %d networks", w, nets)
	}
	// full: a new network takes the oldest place of the network holding the most
	if g.admit(from("100.64.0.1")) == nil {
		t.Fatal("a newcomer was shut out of a full gate held by three networks")
	}
	// the three hold 4, 4, 3 and the newcomer 1: a second newcomer network still gets in (4 >= 0 + 2)
	if g.admit(from("100.65.0.1")) == nil {
		t.Fatal("a second newcomer shut out")
	}
	// fill with one place per network: nobody holds two more than anyone, so the next network waits
	g2 := newGate(testLimits(), &stats{})
	for i := range 12 {
		if g2.admit(from(netip.AddrFrom4([4]byte{10, byte(i), 0, 1}).String())) == nil {
			t.Fatal("refused before full")
		}
	}
	if g2.admit(from("10.200.0.1")) != nil || g2.st.refusedFull.Load() != 1 {
		t.Fatal("twelve networks with one place each: a thirteenth should wait (the only way to keep one out)")
	}
}

func TestPressureShortensTheWait(t *testing.T) {
	g := newGate(testLimits(), &stats{})
	var waits []time.Duration
	for i := range 8 {
		p := g.admit(from(netip.AddrFrom4([4]byte{10, byte(i), 0, 1}).String()))
		waits = append(waits, p.wait)
	}
	for i, w := range waits {
		want := 5 * time.Second
		if i >= 6 {
			want = 3 * time.Second
		}
		if w != want {
			t.Fatalf("place %d waits %v, want %v", i, w, want)
		}
	}
}

func TestHandedConnectionsAreBounded(t *testing.T) {
	g := newGate(testLimits(), &stats{})
	n1, n2 := networkOf(netip.MustParseAddr("192.0.2.1")), networkOf(netip.MustParseAddr("198.51.100.1"))
	var rel []func()
	for range 3 {
		r, ok := g.hand(n1)
		if !ok {
			t.Fatal("refused under the network's cap")
		}
		rel = append(rel, r)
	}
	if _, ok := g.hand(n1); ok {
		t.Fatal("past the network's cap")
	}
	r, ok := g.hand(n2)
	r2, ok2 := g.hand(n2)
	if !ok || !ok2 {
		t.Fatal("another network refused")
	}
	if _, ok := g.hand(netip.MustParsePrefix("203.0.113.0/24")); ok {
		t.Fatal("past the total")
	}
	rel[0]()
	rel[0]() // twice is once
	if _, ok := g.hand(n1); !ok {
		t.Fatal("a released place wasn't given back")
	}
	r()
	r2()
	if _, _, h := g.counts(); h != 3 {
		t.Fatalf("handed %d, want 3", h)
	}
}
