package rtcserver

import (
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/stun/v4"
)

// Why this file exists: ice.TCPMuxDefault allocates a connection for any STUN binding request, even
// one naming an unknown ufrag (handleConn, createConn with fromStun). desk-endpoint.md section 3
// says to drop those before allocating state. So the listener vets each new connection first and
// hands only known ufrags to the mux. UDP needs no gate: ice.UDPMuxDefault already drops packets
// whose ufrag has no connection.

// The waiting places (desk-rtc 0.4.1; Security's NET031-3 and the guild review's TCP gate Medium). A connection waits in
// the gate from the moment the kernel hands it over until its first frame is read, and the gate has only so many places:
// before 0.4.1 anyone could hold all 64 with silent connections and shut every member out of the ICE-TCP fallback. Now:
//   - Places are counted per client network, an IPv4 /24 or an IPv6 /64 (clientNetwork, as the voice relay counts), and
//     only for connections Accept returned. The kernel returns a connection only after its three-way handshake, so a
//     forged SYN never takes a place: its sender never sees the SYN-ACK. (The image's nftables limits counted SYNs, so
//     forged ones could shut a member's network out; they're removed.)
//   - One network holds at most perNet of the total; past that its new connections are closed at once.
//   - When every place is taken, a connection from a network holding fewer places than the network holding the most,
//     by two or more, takes that network's oldest place, which is closed. So floods from a few networks can't keep a
//     newcomer out: only one place each held from as many networks as there are places can.
//   - A place lasts firstPacket at most. A real ICE-TCP client sends its binding request as soon as it's connected, so
//     its place lasts about one round trip.
// Every desk but a Guild Desk takes memberGateLimits. A Guild Desk's scale with its members (guildGateLimits), since a
// whole office of members can share one address there.

const (
	// gateFirstPacketTimeout is how long a new connection has to send its first frame: a lost first segment's
	// retransmission on a 500 ms round trip (RFC 6298's timeout from the handshake's sample, about 1.5 s) still arrives,
	// with room for a browser that pings its candidate pairs one at a time. It was 5 s before 0.4.1.
	gateFirstPacketTimeout = 3 * time.Second
	gateMaxFirstPacket     = 2048
	tcpSendBuffer          = 256 * 1024
	// guildTCPSendBuffer is a Guild Desk's: cgroup v2 charges socket buffers to desk-rtc's unit, and hundreds of
	// members on ICE-TCP at 256 KiB each would be most of MemoryMax (the review's L5). The kernel doubles it.
	guildTCPSendBuffer = 64 * 1024

	// gatePerNet is one network's places on a member's desk: the desk takes 4 sessions, and a browser opens a TCP 443
	// connection a session for each of its interfaces, 1 to 3, so a whole household or office behind one address
	// brings at most 12 at once. 16 leaves room for a reconnect overlapping the old connections.
	gatePerNet = 16
	// gateNetsToFill is how many networks at their cap fill the gate: the total is gatePerNet times this, so three
	// flooding networks leave a quarter of the places, enough for a household's 12 at once, with no eviction needed.
	gateNetsToFill = 4
	// gatePlacesPerMember sizes a Guild Desk's per-network cap, as desk-net-031 sized its nftables burst: 2 a member at
	// once, so the guild's whole tier behind one office address fits.
	gatePlacesPerMember = 2
	// gateMaxMembers caps the members a Guild Desk's gate is sized for: maxGuildMembers, the gateway's ceiling.
	gateMaxMembers = 200
	// gateLogEvery spaces the log line about connections the gate turned away.
	gateLogEvery = time.Minute

	// gateReservePerSession is what a live session adds to the reserved places of the network it is expected from
	// (desk-rtc 0.4.2): one TCP 443 connection per interface, 1 to 3, and one more for a reconnect beside them.
	gateReservePerSession = 4
	// gateKnownMin is how many client networks the gate remembers having verified (a quarter of the places, at least
	// this many): the usual networks of the desk's members, who keep a session's worth of reserved places in each.
	gateKnownMin = 32
	// gateMaxHints is how many client networks one session may name (its offer's, plus the ones its own checks came
	// from), so a session can't ask for reserved places all over the internet.
	gateMaxHints = 2
	// gateHandedPerUfrag and gateHandedPerNetFactor bound the connections past the gate (desk-rtc 0.4.2, GATE041-2):
	// Pion keeps each with a goroutine and buffers for as long as it lives. 6 is three interfaces and an ICE restart's
	// overlap; a network may hold 3 times its waiting places' cap.
	gateHandedPerUfrag     = 6
	gateHandedPerNetFactor = 3
	// gateHandedIdle is how long a connection past the gate may go without a byte from the client: a live session's
	// consent checks come every few seconds, and past the session's consent timeout it would be failed anyway.
	gateHandedIdle = 30 * time.Second
)

// gateLimits are the gate's waiting places: in all, for one network, and how long one lasts.
type gateLimits struct {
	total, perNet int
	firstPacket   time.Duration
}

// memberGateLimits are every desk's but a Guild Desk's: 64 places, 16 a network, 3 s each.
var memberGateLimits = gateLimits{total: gatePerNet * gateNetsToFill, perNet: gatePerNet, firstPacket: gateFirstPacketTimeout}

// guildGateLimits are a Guild Desk's, from configure's limits as they took effect: members are its sessions over a
// member's (deskd sends 600 and 3, so 200), 2 places each a network, and four networks' worth in all. At 200 members
// that's 400 a network and 1,600 in all; never under a member's desk's.
func guildGateLimits(maxSessions, perMember int) gateLimits {
	members := 1
	if perMember > 0 && maxSessions > 0 {
		members = (maxSessions + perMember - 1) / perMember
	}
	members = min(max(members, 1), gateMaxMembers)
	perNet := max(gatePerNet, gatePlacesPerMember*members)

	return gateLimits{total: perNet * gateNetsToFill, perNet: perNet, firstPacket: gateFirstPacketTimeout}
}

// gatedTCPMux records which ufrags the ICE agents have asked for.
type gatedTCPMux struct {
	*ice.TCPMuxDefault
	mu     sync.RWMutex
	ufrags map[string]struct{}
	// pwds are the sessions' ICE passwords by desk ufrag, set when the answer is made; the first frame of a connection
	// must be signed with one (MESSAGE-INTEGRITY). In memory only.
	pwds map[string]string
	// gate forgets a session's networks when its ufrag goes.
	gate *gateListener
}

// GetConnByUfrag implements ice.TCPMux.
func (m *gatedTCPMux) GetConnByUfrag(ufrag string, isIPv6 bool, local net.IP) (net.PacketConn, error) {
	m.mu.Lock()
	m.ufrags[ufrag] = struct{}{}
	m.mu.Unlock()

	return m.TCPMuxDefault.GetConnByUfrag(ufrag, isIPv6, local)
}

// RemoveConnByUfrag implements ice.TCPMux.
func (m *gatedTCPMux) RemoveConnByUfrag(ufrag string) {
	m.mu.Lock()
	delete(m.ufrags, ufrag)
	delete(m.pwds, ufrag)
	m.mu.Unlock()
	if m.gate != nil {
		m.gate.dropHints(ufrag)
	}
	m.TCPMuxDefault.RemoveConnByUfrag(ufrag)
}

// setPassword records the ICE password of the session whose desk-side ufrag is ufrag.
func (m *gatedTCPMux) setPassword(ufrag, pwd string) {
	m.mu.Lock()
	if _, live := m.ufrags[ufrag]; live {
		if m.pwds == nil {
			m.pwds = map[string]string{}
		}
		m.pwds[ufrag] = pwd
	}
	m.mu.Unlock()
}

// verify is true when msg is signed with the password of the session behind ufrag. A ufrag whose password isn't
// recorded yet (a session still being set up) verifies nothing.
func (m *gatedTCPMux) verify(ufrag string, msg *stun.Message) bool {
	m.mu.RLock()
	pwd, ok := m.pwds[ufrag]
	m.mu.RUnlock()

	return ok && stun.NewShortTermIntegrity(pwd).Check(msg) == nil
}

func (m *gatedTCPMux) known(ufrag string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.ufrags[ufrag]

	return ok
}

// gateListener is what the mux accepts from.
type gateListener struct {
	inner net.Listener
	allow func(ufrag string) bool
	// relay may take a connection allow refused: a Guild Desk's voice relay (voicerelay.go). True means it took it.
	relay func(c net.Conn, first []byte, ufrag string) bool
	// sendBuffer is the kernel send buffer for a connection it passes on: tcpSendBuffer, or a Guild Desk's.
	sendBuffer func() int
	log        *slog.Logger
	out        chan net.Conn
	done       chan struct{}
	once       sync.Once

	// verify checks the first frame's MESSAGE-INTEGRITY against the session's ICE password (nil: no check).
	verify func(ufrag string, msg *stun.Message) bool
	// handedIdle is how long a connection past the gate may be silent before its read fails.
	handedIdle time.Duration
	// handedPerUfrag and handedPerNet are the caps past the gate: connections a session may have, and a network (times
	// the waiting places' cap). The constants unless a test sets them.
	handedPerUfrag, handedPerNet int

	mu      sync.Mutex
	lim     gateLimits
	waiting int
	byNet   map[netip.Prefix]*gateNet
	seq     uint64

	// The reserved places (GATE041-1): outside waiting and byNet, for connections from a network a live session is
	// expected from. hints maps a session's ufrag to those networks and hintCount counts sessions a network is named
	// by. In memory only, never logged.
	resNet     map[netip.Prefix]*gateNet
	resWaiting int
	hints      map[string][]netip.Prefix
	hintCount  map[netip.Prefix]int
	// known are networks a session has connected from or a verified first frame came from, the most recent
	// gateKnownMin or more of them; each keeps one session's reserved places while it's remembered. In memory only.
	known map[netip.Prefix]uint64

	// Connections past the gate (GATE041-2), by session ufrag and by network.
	handed    map[string]int
	handedNet map[netip.Prefix]int

	// refusedNet counts connections closed for their network's cap, refusedFull those closed with every place taken
	// and none to take, and evicted the places taken from the network holding the most.
	refusedNet, refusedFull, evicted atomic.Uint64
	// refusedHanded counts connections closed for a session's or network's cap past the gate, refusedAuth those whose
	// first frame failed MESSAGE-INTEGRITY.
	refusedHanded, refusedAuth atomic.Uint64
	lastLog                    atomic.Int64 // unix ns
}

// gateNet is one client network's waiting places, oldest first.
type gateNet struct {
	places []*gatePlace
}

// gatePlace is one connection waiting for its first frame.
type gatePlace struct {
	c        net.Conn
	network  netip.Prefix
	addr     netip.Addr
	seq      uint64
	wait     time.Duration
	reserved bool // in the reserved places, not the shared ones
	gone     bool // it left, or a newer connection took its place; gateListener.mu
}

func newGateListener(inner net.Listener, log *slog.Logger) *gateListener {
	l := &gateListener{
		inner:      inner,
		log:        log,
		out:        make(chan net.Conn),
		done:       make(chan struct{}),
		allow:      func(string) bool { return false },
		sendBuffer: func() int { return tcpSendBuffer },
		lim:        memberGateLimits,
		byNet:      map[netip.Prefix]*gateNet{},
		resNet:     map[netip.Prefix]*gateNet{},
		hints:      map[string][]netip.Prefix{},
		hintCount:  map[netip.Prefix]int{},
		known:      map[netip.Prefix]uint64{},
		handed:     map[string]int{},
		handedNet:  map[netip.Prefix]int{},
		handedIdle: gateHandedIdle,

		handedPerUfrag: gateHandedPerUfrag,
		handedPerNet:   gateHandedPerNetFactor,
	}

	return l
}

// setLimits changes the places from the next connection on. Connections already waiting keep theirs until they leave.
func (l *gateListener) setLimits(lim gateLimits) {
	l.mu.Lock()
	l.lim = lim
	l.mu.Unlock()
}

func (l *gateListener) limits() gateLimits {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.lim
}

func (l *gateListener) serve() {
	for {
		c, err := l.inner.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			l.log.Warn("ICE-TCP accept failed", "err", err)
			time.Sleep(50 * time.Millisecond)

			continue
		}
		p := l.admit(c)
		if p == nil {
			// No place for it: closed at once rather than queueing work for strangers.
			_ = c.Close()
			l.noteTurnedAway()

			continue
		}
		go l.vet(c, p)
	}
}

// remoteAddr is the address c came from; the zero Addr when it can't be read.
func remoteAddr(c net.Conn) netip.Addr {
	ra := c.RemoteAddr()
	if ra == nil {
		return netip.Addr{}
	}
	var a netip.Addr
	if ta, ok := ra.(*net.TCPAddr); ok {
		a = ta.AddrPort().Addr()
	} else if ap, err := netip.ParseAddrPort(ra.String()); err == nil {
		a = ap.Addr()
	}

	return a.Unmap()
}

// remoteNetwork is the client network c is counted under. An address it can't read counts as one network of its own.
func remoteNetwork(c net.Conn) netip.Prefix {
	return clientNetwork(remoteAddr(c))
}

// reserveCapLocked is how many reserved places a network has: gateReservePerSession for each live session expected
// from it, at most a network's places. Zero for a network no session is expected from.
func (l *gateListener) reserveCapLocked(n netip.Prefix) int {
	c := gateReservePerSession * l.hintCount[n]
	if _, ok := l.known[n]; ok {
		c = max(c, gateReservePerSession)
	}

	return min(c, l.lim.perNet)
}

// learnKnown remembers a network a verified client came from, forgetting the least recently seen when there are more
// than gateKnownMin or a quarter of the total places.
func (l *gateListener) learnKnown(n netip.Prefix) {
	if !n.IsValid() {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	l.known[n] = l.seq
	limit := max(gateKnownMin, l.lim.total/4)
	for len(l.known) > limit {
		var old netip.Prefix
		var oldSeq uint64
		for k, v := range l.known {
			if oldSeq == 0 || v < oldSeq {
				old, oldSeq = k, v
			}
		}
		delete(l.known, old)
	}
}

// admit takes a waiting place for c, or returns nil when there's none for it. Only connections the kernel has
// finished the handshake for get here, so the source address is one that answered.
//
// A connection takes a shared place if its network and the gate allow one. If they don't, and a live session is
// expected from its network (hints), it takes one of that network's reserved places, which the shared count never
// touches: 64 networks each holding one shared place can't shut it out (GATE041-1). Within one network, in either
// pool, an address holding at least two fewer places than the address holding the most takes that address's oldest,
// so one address inside a member's own /24 can't hold the whole network's places (GATE041-1's second half).
func (l *gateListener) admit(c net.Conn) *gatePlace {
	p := &gatePlace{c: c, addr: remoteAddr(c)}
	p.network = clientNetwork(p.addr)
	l.mu.Lock()
	taken, ok, full := l.admitSharedLocked(p)
	if !ok && l.reserveCapLocked(p.network) > 0 {
		var rok bool
		if taken, rok = l.admitReservedLocked(p); rok {
			ok = true
		}
	}
	l.mu.Unlock()
	if !ok {
		if full {
			l.refusedFull.Add(1)
		} else {
			l.refusedNet.Add(1)
		}

		return nil
	}
	if taken != nil {
		l.evicted.Add(1)
		_ = taken.c.Close()
		l.noteTurnedAway()
	}

	return p
}

// admitSharedLocked is the shared places' rule. full says a refusal was for the whole gate, not the network.
func (l *gateListener) admitSharedLocked(p *gatePlace) (taken *gatePlace, ok, full bool) {
	n := l.byNet[p.network]
	have := 0
	if n != nil {
		have = len(n.places)
	}
	switch {
	case have >= l.lim.perNet:
		if taken = l.takeFromBiggestAddrLocked(n, p.addr); taken == nil {
			return nil, false, false
		}
	case l.waiting >= l.lim.total:
		// Full: the network holding the most gives up its oldest place, if it holds at least two more than this one
		// would. One more would only swap the two, and two networks could then take places from each other forever.
		big := l.largestLocked()
		if big == nil || len(big.places) < have+2 {
			return nil, false, true
		}
		taken = big.places[0]
		l.removeLocked(taken)
	}
	if taken != nil {
		n = l.byNet[p.network] // removeLocked may have dropped an empty network, never this one (it held more)
	}
	if n == nil {
		n = &gateNet{}
		l.byNet[p.network] = n
	}
	l.seq++
	p.seq, p.wait = l.seq, l.lim.firstPacket
	if l.waiting*2 >= l.lim.total {
		// Half the shared places taken: someone is holding them, so a silent connection gets half the time. An honest
		// one sends within a round trip; this only matters while the gate is under pressure.
		p.wait = l.lim.firstPacket / 2
	}
	n.places = append(n.places, p)
	l.waiting++

	return taken, true, false
}

// admitReservedLocked is the reserved places' rule, for a network some session is expected from.
func (l *gateListener) admitReservedLocked(p *gatePlace) (taken *gatePlace, ok bool) {
	n := l.resNet[p.network]
	have := 0
	if n != nil {
		have = len(n.places)
	}
	switch {
	case have >= l.reserveCapLocked(p.network):
		if taken = l.takeFromBiggestAddrLocked(n, p.addr); taken == nil {
			return nil, false
		}
		n = l.resNet[p.network]
	case l.resWaiting >= l.lim.total:
		return nil, false
	}
	if n == nil {
		n = &gateNet{}
		l.resNet[p.network] = n
	}
	l.seq++
	p.seq, p.wait, p.reserved = l.seq, l.lim.firstPacket, true
	n.places = append(n.places, p)
	l.resWaiting++

	return taken, true
}

// takeFromBiggestAddrLocked gives up the oldest place of the address holding the most in n, when it holds at least two
// more than addr does, and returns it (closing is the caller's job). Nil when no address qualifies.
func (l *gateListener) takeFromBiggestAddrLocked(n *gateNet, addr netip.Addr) *gatePlace {
	if n == nil {
		return nil
	}
	count := map[netip.Addr]int{}
	for _, q := range n.places {
		count[q.addr]++
	}
	var big netip.Addr
	most := 0
	for _, q := range n.places { // oldest first, so a tie goes to the address whose place is oldest
		if count[q.addr] > most {
			big, most = q.addr, count[q.addr]
		}
	}
	if most < count[addr]+2 {
		return nil
	}
	for _, q := range n.places {
		if q.addr == big {
			l.removeLocked(q)

			return q
		}
	}

	return nil
}

// largestLocked is the network holding the most places; between equals, the one whose oldest place is oldest.
func (l *gateListener) largestLocked() *gateNet {
	var big *gateNet
	for _, n := range l.byNet {
		if big == nil || len(n.places) > len(big.places) ||
			len(n.places) == len(big.places) && n.places[0].seq < big.places[0].seq {
			big = n
		}
	}

	return big
}

func (l *gateListener) removeLocked(p *gatePlace) {
	p.gone = true
	pool, waiting := l.byNet, &l.waiting
	if p.reserved {
		pool, waiting = l.resNet, &l.resWaiting
	}
	*waiting--
	n := pool[p.network]
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
		delete(pool, p.network)
	}
}

// leave gives p's place back. False means a newer network's connection took it first, and closed the connection.
func (l *gateListener) leave(p *gatePlace) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if p.gone {
		return false
	}
	l.removeLocked(p)

	return true
}

// noteTurnedAway logs, at most once a minute, how many connections the gate has turned away since desk-rtc started.
// No addresses: the counts say whether it's happening, and the desk's logs never hold members' addresses.
func (l *gateListener) noteTurnedAway() {
	now, last := time.Now().UnixNano(), l.lastLog.Load()
	if last != 0 && now-last < int64(gateLogEvery) || !l.lastLog.CompareAndSwap(last, now) {
		return
	}
	l.mu.Lock()
	lim, waiting, nets := l.lim, l.waiting, len(l.byNet)
	l.mu.Unlock()
	l.log.Warn("ICE-TCP gate turning connections away", "refusedPerNetwork", l.refusedNet.Load(),
		"refusedFull", l.refusedFull.Load(), "evicted", l.evicted.Load(), "refusedPastGate", l.refusedHanded.Load(),
		"refusedPassword", l.refusedAuth.Load(), "waiting", waiting, "networks", nets,
		"places", lim.total, "perNetwork", lim.perNet)
}

// setHints records the client networks a session (named by the desk's ICE ufrag) is expected from, replacing what it
// had. At most gateMaxHints; each adds gateReservePerSession reserved places to its network while the session lives.
func (l *gateListener) setHints(ufrag string, nets []netip.Prefix) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.dropHintsLocked(ufrag)
	var kept []netip.Prefix
	for _, n := range nets {
		if len(kept) >= gateMaxHints || !n.IsValid() || slicesContains(kept, n) {
			continue
		}
		kept = append(kept, n)
		l.hintCount[n]++
	}
	if len(kept) > 0 {
		l.hints[ufrag] = kept
	}
}

// addHint adds a network a session's verified first frame came from, if the session has room for another.
func (l *gateListener) addHint(ufrag string, n netip.Prefix) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cur := l.hints[ufrag]
	if !n.IsValid() || len(cur) >= gateMaxHints || slicesContains(cur, n) {
		return
	}
	l.hints[ufrag] = append(cur, n)
	l.hintCount[n]++
}

// hintsOf returns a copy of what a session is expected from.
func (l *gateListener) hintsOf(ufrag string) []netip.Prefix {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]netip.Prefix(nil), l.hints[ufrag]...)
}

// dropHints forgets a session's networks, when its ufrag goes away. Reserved places already held stay until they leave.
func (l *gateListener) dropHints(ufrag string) {
	l.mu.Lock()
	l.dropHintsLocked(ufrag)
	l.mu.Unlock()
}

func (l *gateListener) dropHintsLocked(ufrag string) {
	for _, n := range l.hints[ufrag] {
		if l.hintCount[n]--; l.hintCount[n] <= 0 {
			delete(l.hintCount, n)
		}
	}
	delete(l.hints, ufrag)
}

func slicesContains(s []netip.Prefix, n netip.Prefix) bool {
	for _, x := range s {
		if x == n {
			return true
		}
	}

	return false
}

// claimHanded counts a connection about to go past the gate against its session and its network. The returned func
// gives it back, once.
func (l *gateListener) claimHanded(ufrag string, n netip.Prefix) (func(), bool) {
	l.mu.Lock()
	if l.handed[ufrag] >= l.handedPerUfrag || l.handedNet[n] >= l.handedPerNet*l.lim.perNet {
		l.mu.Unlock()

		return nil, false
	}
	l.handed[ufrag]++
	l.handedNet[n]++
	l.mu.Unlock()
	var once sync.Once

	return func() {
		once.Do(func() {
			l.mu.Lock()
			if l.handed[ufrag]--; l.handed[ufrag] <= 0 {
				delete(l.handed, ufrag)
			}
			if l.handedNet[n]--; l.handedNet[n] <= 0 {
				delete(l.handedNet, n)
			}
			l.mu.Unlock()
		})
	}, true
}

// vet reads the first RFC 4571 frame and passes the connection on only for a known ufrag whose session's ICE password
// signed it (MESSAGE-INTEGRITY), and only while that session and the connection's network are under their caps. One no
// session knows goes to the voice relay, which on a Guild Desk takes Commons' ufrags and otherwise refuses, so it's
// closed as before. The connection's place is given back once the frame is read, before it's handed on.
func (l *gateListener) vet(c net.Conn, p *gatePlace) {
	first, msg, ufrag, ok := readFirstPacket(c, p.wait)
	if held := l.leave(p); !held || !ok {
		_ = c.Close()

		return
	}
	if !l.allow(ufrag) {
		if l.relay == nil || !l.relay(c, first, ufrag) {
			_ = c.Close()
		}

		return
	}
	if l.verify != nil && !l.verify(ufrag, msg) {
		// Someone who knows a session's ufrag but not its password; nothing is allocated for it.
		l.refusedAuth.Add(1)
		_ = c.Close()

		return
	}
	release, ok := l.claimHanded(ufrag, p.network)
	if !ok {
		l.refusedHanded.Add(1)
		_ = c.Close()
		l.noteTurnedAway()

		return
	}
	l.addHint(ufrag, p.network)
	l.learnKnown(p.network)
	if tc, isTCP := c.(*net.TCPConn); isTCP {
		_ = tc.SetNoDelay(true)
		// A shallow kernel buffer keeps ctl from waiting behind queued bulk on ICE-TCP too.
		_ = tc.SetWriteBuffer(l.sendBuffer())
	}
	out := &primedConn{Conn: c, prefix: first, release: release, idle: l.handedIdle}
	select {
	case l.out <- out:
	case <-l.done:
		_ = out.Close()
	}
}

// readFirstPacket reads the first RFC 4571 frame, which must be a STUN binding request with a USERNAME, and returns
// it framed, decoded, and with the receiver's ufrag from it.
func readFirstPacket(c net.Conn, wait time.Duration) ([]byte, *stun.Message, string, bool) {
	if err := c.SetReadDeadline(time.Now().Add(wait)); err != nil {
		return nil, nil, "", false
	}
	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return nil, nil, "", false
	}
	n := int(binary.BigEndian.Uint16(hdr[:]))
	if n == 0 || n > gateMaxFirstPacket {
		return nil, nil, "", false
	}
	framed := make([]byte, 2+n)
	copy(framed, hdr[:])
	if _, err := io.ReadFull(c, framed[2:]); err != nil {
		return nil, nil, "", false
	}
	if err := c.SetReadDeadline(time.Time{}); err != nil {
		return nil, nil, "", false
	}

	msg := &stun.Message{Raw: append([]byte(nil), framed[2:]...)}
	if err := msg.Decode(); err != nil {
		return nil, nil, "", false
	}
	if msg.Type.Method != stun.MethodBinding || msg.Type.Class != stun.ClassRequest {
		return nil, nil, "", false
	}
	username, err := msg.Get(stun.AttrUsername)
	if err != nil {
		return nil, nil, "", false
	}
	ufrag, _, _ := strings.Cut(string(username), ":")

	return framed, msg, ufrag, true
}

// Accept implements net.Listener.
func (l *gateListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.out:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

// Close implements net.Listener.
func (l *gateListener) Close() error {
	l.once.Do(func() { close(l.done) })

	return l.inner.Close()
}

// Addr implements net.Listener.
func (l *gateListener) Addr() net.Addr { return l.inner.Addr() }

// primedConn replays the first packet the gate consumed. It gives its session's and network's count back when it
// closes, and fails a read after idle without a byte, so a connection past the gate can't sit for ever.
type primedConn struct {
	net.Conn
	prefix  []byte
	release func()
	idle    time.Duration
}

func (c *primedConn) Read(b []byte) (int, error) {
	if len(c.prefix) > 0 {
		n := copy(b, c.prefix)
		c.prefix = c.prefix[n:]

		return n, nil
	}
	if c.idle > 0 {
		_ = c.Conn.SetReadDeadline(time.Now().Add(c.idle))
	}
	n, err := c.Conn.Read(b)
	var ne net.Error
	if c.idle > 0 && errors.As(err, &ne) && ne.Timeout() {
		// Closed, not timed out: Pion's TCP mux passes any other read error on a session's candidate up to its ICE
		// agent, which stops reading from that candidate altogether, while it drops a closed connection quietly.
		_ = c.Conn.Close()

		return n, net.ErrClosed
	}

	return n, err
}

// SetReadDeadline is ignored: Pion clears the deadline after its first read, and the idle limit is the gate's.
func (c *primedConn) SetReadDeadline(t time.Time) error {
	if c.idle > 0 {
		return nil
	}

	return c.Conn.SetReadDeadline(t)
}

func (c *primedConn) Close() error {
	if c.release != nil {
		c.release()
	}

	return c.Conn.Close()
}
