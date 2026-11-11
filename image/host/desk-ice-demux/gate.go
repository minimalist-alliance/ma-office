package main

import (
	"net"
	"net/netip"
	"sync"
	"time"
)

// The places a connection waits in until its first frame has come, counted per client network as desk-rtc's own gate
// counts them (desk-rtc/internal/rtcserver/tcpgate.go, "The ICE-TCP gate" in its README), so silent connections from a
// few networks can't keep a member out of the host's TCP 443, the only way in for a network that blocks UDP while there's
// no TURN. A network is an IPv4 /24 (an IPv6 /64: the listener is IPv4 today). Every number is several times desk-rtc's,
// since one host's 443 is every slot's:
//   - per network, perNet places (48: four desks' worth of a household's 12 at once);
//   - in all, total places (64 a slot, desk-rtc's own total for one desk; 384 on a 6-slot host);
//   - past a network's places, its address holding the most gives up its oldest when the newcomer's address holds at
//     least two fewer (one address can't hold its whole /24), else the newcomer is closed;
//   - with every place taken, the network holding the most gives up its oldest when it holds at least two more than the
//     newcomer's, else the newcomer is closed. So any network that wants places gets its fair share, and only as many
//     networks as there are places, each holding one, can keep a new one out;
//   - a place lasts wait (5 s), or pressureWait (3 s, still desk-rtc's full wait) once half are taken: a browser sends
//     its first check as soon as it's connected, so its place lasts about a round trip.
// Counted after the handshake (the kernel hands Accept only finished ones), so forged SYNs never count; a SYN flood as
// such is the kernel's (SYN cookies).
//
// Past the first frame a connection is handed to its slot's desk-rtc, whose own gate checks the frame's MESSAGE-INTEGRITY
// with the session's password and closes it at once if it's wrong, so a handed connection lives only as long as its
// slot's desk-rtc keeps it. The demux still bounds them: handedPerNet per network and handedTotal in all, refused past
// either. Never an address in a log.

type limits struct {
	perNet, total             int
	wait, pressureWait        time.Duration
	handedPerNet, handedTotal int
}

func limitsFor(slots int) limits {
	return limits{
		perNet: 48, total: 64 * slots,
		wait: 5 * time.Second, pressureWait: 3 * time.Second,
		handedPerNet: 192, handedTotal: 192 * slots,
	}
}

type place struct {
	c       net.Conn
	addr    netip.Addr
	network netip.Prefix
	seq     uint64
	wait    time.Duration
	gone    bool // taken by a newer connection, or left; gate.mu
}

type netPlaces struct{ places []*place } // oldest first

type gate struct {
	lim     limits
	mu      sync.Mutex
	byNet   map[netip.Prefix]*netPlaces
	waiting int
	seq     uint64
	handed  map[netip.Prefix]int
	nHanded int
	st      *stats
}

func newGate(lim limits, st *stats) *gate {
	return &gate{lim: lim, byNet: map[netip.Prefix]*netPlaces{}, handed: map[netip.Prefix]int{}, st: st}
}

func addrOf(c net.Conn) netip.Addr {
	if ta, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		return ta.AddrPort().Addr().Unmap()
	}

	return netip.Addr{}
}

func networkOf(a netip.Addr) netip.Prefix {
	bits := 24
	if a.Is6() {
		bits = 64
	}
	p, err := a.Prefix(bits)
	if err != nil {
		return netip.Prefix{}
	}

	return p
}

// admit takes a waiting place for c, or nil (c is the caller's to close). A place taken from another connection is
// closed here.
func (g *gate) admit(c net.Conn) *place {
	p := &place{c: c, addr: addrOf(c)}
	p.network = networkOf(p.addr)
	g.mu.Lock()
	n := g.byNet[p.network]
	have := 0
	if n != nil {
		have = len(n.places)
	}
	var taken *place
	switch {
	case have >= g.lim.perNet:
		if taken = g.takeFromBiggestAddrLocked(n, p.addr); taken == nil {
			g.mu.Unlock()
			g.st.refusedPerNet.Add(1)

			return nil
		}
	case g.waiting >= g.lim.total:
		big := g.largestLocked()
		if big == nil || len(big.places) < have+2 {
			g.mu.Unlock()
			g.st.refusedFull.Add(1)

			return nil
		}
		taken = big.places[0]
		g.removeLocked(taken)
	}
	if n = g.byNet[p.network]; n == nil {
		n = &netPlaces{}
		g.byNet[p.network] = n
	}
	g.seq++
	p.seq, p.wait = g.seq, g.lim.wait
	if g.waiting*2 >= g.lim.total {
		p.wait = g.lim.pressureWait
	}
	n.places = append(n.places, p)
	g.waiting++
	g.mu.Unlock()
	if taken != nil {
		g.st.evicted.Add(1)
		abort(taken.c)
	}

	return p
}

func (g *gate) takeFromBiggestAddrLocked(n *netPlaces, addr netip.Addr) *place {
	if n == nil {
		return nil
	}
	count := map[netip.Addr]int{}
	for _, q := range n.places {
		count[q.addr]++
	}
	var big netip.Addr
	most := 0
	for _, q := range n.places {
		if count[q.addr] > most {
			big, most = q.addr, count[q.addr]
		}
	}
	if most < count[addr]+2 {
		return nil
	}
	for _, q := range n.places {
		if q.addr == big {
			g.removeLocked(q)

			return q
		}
	}

	return nil
}

func (g *gate) largestLocked() *netPlaces {
	var big *netPlaces
	for _, n := range g.byNet {
		if big == nil || len(n.places) > len(big.places) || len(n.places) == len(big.places) && n.places[0].seq < big.places[0].seq {
			big = n
		}
	}

	return big
}

func (g *gate) removeLocked(p *place) {
	p.gone = true
	g.waiting--
	n := g.byNet[p.network]
	if n == nil {
		return
	}
	for i, q := range n.places {
		if q == p {
			n.places = append(n.places[:i], n.places[i+1:]...)

			break
		}
	}
	if len(n.places) == 0 {
		delete(g.byNet, p.network)
	}
}

// leave gives p's place back; false when a newer connection took it first (and closed it).
func (g *gate) leave(p *place) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if p.gone {
		return false
	}
	g.removeLocked(p)

	return true
}

// hand counts a connection handed to a slot under its network; release gives the count back. False: refused.
func (g *gate) hand(n netip.Prefix) (release func(), ok bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handed[n] >= g.lim.handedPerNet || g.nHanded >= g.lim.handedTotal {
		return nil, false
	}
	g.handed[n]++
	g.nHanded++
	var once sync.Once

	return func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			if g.handed[n]--; g.handed[n] <= 0 {
				delete(g.handed, n)
			}
			g.nHanded--
		})
	}, true
}

func (g *gate) counts() (waiting, networks, handed int) {
	g.mu.Lock()
	defer g.mu.Unlock()

	return g.waiting, len(g.byNet), g.nHanded
}

// abort closes c at once with a reset, so nothing lingers in FIN_WAIT for a connection that was refused.
func abort(c net.Conn) {
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetLinger(0)
	}
	_ = c.Close()
}
