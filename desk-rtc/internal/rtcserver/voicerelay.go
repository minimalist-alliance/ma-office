package rtcserver

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/rtcsock"
)

// The Guild Desk's voice relay (task 48; the System Engineer's design, the owner's "UDP with TURN on 443 as
// fallback"). Commons' voice is its own Pion connection on UDP 8791 and up (ADR 0077 T8), which some members'
// networks block. desk-rtc already holds UDP and TCP 443 on every desk, so on a Guild Desk it passes Commons' own
// ICE through to Commons on loopback, unread:
//   - Commons' ICE ufrags all start with "cmns", and Commons listens for relayed ICE on 127.0.0.1:8799, TCP
//     (RFC 4571 framing, passive ICE-TCP) and UDP. Commons answers only a binding request for one of its live
//     connections, signed with that connection's password, and sends nothing at all otherwise (its gate, gate.go).
//   - UDP: a STUN binding request on 443 whose USERNAME's first ufrag starts with "cmns", and which no desk-rtc session
//     claims, opens a pending flow for that client address: a loopback socket of its own toward 8799, and the
//     request's transaction id. While pending, only binding requests go through, and nothing comes back. The flow
//     becomes a mapping only when Commons' binding success for one of those transaction ids comes back: from then on
//     every packet from that address goes through it, and what Commons sends to that socket goes out on 443 to the
//     address. A pending flow Commons hasn't answered within pendingTTL goes; a mapping after idleTTL without a packet.
//   - TCP: a connection whose first RFC 4571 frame is such a request, for a ufrag no session has, is spliced whole to
//     8799, the first frame included. It's pending until Commons first sends something, which it does only for a
//     signed request for a live connection, within pendingTTL; either side quiet for idleTTL ends it.
//   - Pending flows are what a stranger can make (Security's GDS-1): they're capped per client network (/24 for IPv4,
//     /64 for IPv6) and in total, and when the total is full a new one pushes out the oldest, so a flood can't hold
//     the places: a member's own request needs its place only for the millisecond Commons takes to answer. Mappings,
//     which only Commons' answer makes, are capped per Commons ufrag (one per member's voice connection) and in total.
//     Past a cap the packet is dropped, or the connection closed, as an unknown ufrag is today, and counted.
// Why a socket per pending flow, not one shared socket for every first request: Commons' Pion mux keeps the address a
// connection last answered, and sends whatever comes from that address on to that connection after (udp_mux.go's
// address map, and Commons' gate admits it). A shared socket's next request, for another member, would reach the first
// member's connection and fail. A socket that never carried an answer is never reused.
// Only while this desk-rtc's deskd link has configured a Guild Desk. Everything else on 443 is untouched: only
// packets Pion's mux already drops (no session's ufrag, no session's address) and connections the TCP gate already
// closes reach this, and on any other desk it returns at once. README, "Guild mode", has the contract.

const (
	voiceUfragPrefix = "cmns"
	// DefaultVoiceRelayAddr is where Commons listens for relayed ICE, TCP and UDP.
	DefaultVoiceRelayAddr = "127.0.0.1:8799"

	// voicePendingTTL is how long Commons has to answer. It's on loopback and answers in about a millisecond; a
	// client that missed it sends its check again.
	voicePendingTTL = 2 * time.Second
	voiceIdleTTL    = 30 * time.Second
	// voiceQueue is how many client-to-Commons packets wait per UDP mapping; past it they're dropped. 32 is 640 ms of
	// voice at 50 packets a second, and bounds 1024 mappings at 48 MB even if Commons stopped reading.
	voiceQueue      = 32
	voiceMaxPacket  = 1500
	voiceDialWait   = 2 * time.Second
	voiceSweepEvery = 250 * time.Millisecond
	// voiceTxIDs is how many of a pending flow's requests it remembers: a client resends its check every few hundred
	// milliseconds, and any of them answered confirms the flow.
	voiceTxIDs = 8
)

// voiceLimits are the relay's caps and timings. Tests change them; production takes defaultVoiceLimits.
type voiceLimits struct {
	udpTotal, udpPerUfrag, udpPending, udpPendingPerNet int
	tcpTotal, tcpPerUfrag, tcpPending, tcpPendingPerNet int
	pendingTTL, idleTTL                                 time.Duration
}

var defaultVoiceLimits = voiceLimits{
	// 200 members, a voice connection each, with a few candidate pairs and room for reconnects. A pending UDP flow is a
	// socket and a goroutine, about 12 KB, so 256 of them are 3 MB; a pending TCP one two connections and two.
	udpTotal: 1024, udpPerUfrag: 4, udpPending: 256, udpPendingPerNet: 4,
	tcpTotal: 512, tcpPerUfrag: 2, tcpPending: 64, tcpPendingPerNet: 4,
	pendingTTL: voicePendingTTL, idleTTL: voiceIdleTTL,
}

// voiceRelay is the relay itself, one per desk-rtc.
type voiceRelay struct {
	target  string
	udpAddr *net.UDPAddr
	lim     voiceLimits
	log     *slog.Logger
	enabled atomic.Bool
	out     *net.UDPConn // 443, for what Commons sends back

	mu          sync.Mutex
	byAddr      map[netip.AddrPort]*voiceMapping // pending and confirmed
	udpPending  []*voiceMapping                  // oldest first
	udpByNet    map[netip.Prefix]int             // pending, by client network
	udpByUfrag  map[string]int                   // confirmed, by Commons ufrag
	udpLive     int                              // confirmed
	tcpLive     map[*voiceSplice]struct{}        // pending and confirmed
	tcpPending  []*voiceSplice                   // oldest first
	tcpByNet    map[netip.Prefix]int             // pending
	tcpByUfrag  map[string]int                   // confirmed
	tcpConfirmd int

	refused atomic.Uint64 // packets and connections a cap or a dial turned away
	evicted atomic.Uint64 // pending flows a newer one pushed out
	stop    chan struct{}
	stopped sync.Once
}

// voiceMapping is one client address's UDP path to Commons: pending until Commons answers, then confirmed.
type voiceMapping struct {
	client    netip.AddrPort
	network   netip.Prefix
	ufrag     string
	conn      *net.UDPConn // a loopback socket of its own, connected to Commons
	in        chan []byte  // made when confirmed
	created   time.Time
	last      atomic.Int64                   // unix ns of the last packet either way
	txids     [][stun.TransactionIDSize]byte // pending: the requests sent, newest last; voiceRelay.mu
	confirmed bool                           // Commons has answered; voiceRelay.mu
	closed    bool                           // voiceRelay.mu
}

// voiceSplice is one relayed ICE-TCP connection. It's pending until Commons first answers.
type voiceSplice struct {
	ufrag   string
	network netip.Prefix
	client  net.Conn
	up      atomic.Pointer[net.Conn]
	// pending until Commons answers, then confirmed; evicted if a newer pending one pushed it out. voiceRelay.mu.
	pending, confirmed, evicted bool
}

// clientNetwork is the network a client address is counted under: its /24, or its /64 for IPv6.
func clientNetwork(a netip.Addr) netip.Prefix {
	a = a.Unmap()
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

// checkVoiceRelayAddr accepts only a loopback address: the relay must never reach past this machine.
func checkVoiceRelayAddr(addr string) (*net.UDPAddr, error) {
	ap, err := netip.ParseAddrPort(addr)
	if err != nil || !ap.Addr().IsLoopback() || !ap.Addr().Is4() || ap.Port() == 0 {
		return nil, fmt.Errorf("voice relay %q: want a loopback IPv4 address and port, such as %s", addr, DefaultVoiceRelayAddr)
	}

	return net.UDPAddrFromAddrPort(ap), nil
}

func newVoiceRelay(target string, lim voiceLimits, log *slog.Logger) (*voiceRelay, error) {
	if target == "" {
		target = DefaultVoiceRelayAddr
	}
	addr, err := checkVoiceRelayAddr(target)
	if err != nil {
		return nil, err
	}
	if lim == (voiceLimits{}) {
		lim = defaultVoiceLimits
	}

	return &voiceRelay{
		target: target, udpAddr: addr, lim: lim, log: log.With("part", "voice-relay"),
		byAddr: map[netip.AddrPort]*voiceMapping{}, udpByNet: map[netip.Prefix]int{}, udpByUfrag: map[string]int{},
		tcpLive: map[*voiceSplice]struct{}{}, tcpByNet: map[netip.Prefix]int{}, tcpByUfrag: map[string]int{},
		stop: make(chan struct{}),
	}, nil
}

// setEnabled turns the relay on for a Guild Desk's configure. Turned off, by another desk's configure, it closes
// whatever it had; a dropped deskd link only stops new mappings, so voice carries on while deskd reconnects.
func (r *voiceRelay) setEnabled(on bool) {
	was := r.enabled.Swap(on)
	if was && !on {
		r.closeAll()
	}
}

// pause stops new mappings and connections without closing live ones (a deskd link that dropped).
func (r *voiceRelay) pause() { r.enabled.Store(false) }

func isVoiceUfrag(ufrag string) bool { return strings.HasPrefix(ufrag, voiceUfragPrefix) }

// voiceRequest reads a STUN binding request: its USERNAME's first ufrag, the receiver's, and its transaction id. ok is
// false for anything else, or a ufrag that isn't Commons'.
func voiceRequest(b []byte) (ufrag string, txid [stun.TransactionIDSize]byte, ok bool) {
	if !stun.IsMessage(b) {
		return "", txid, false
	}
	msg := &stun.Message{Raw: append([]byte(nil), b...)}
	if err := msg.Decode(); err != nil {
		return "", txid, false
	}
	if msg.Type.Method != stun.MethodBinding || msg.Type.Class != stun.ClassRequest {
		return "", txid, false
	}
	username, err := msg.Get(stun.AttrUsername)
	if err != nil {
		return "", txid, false
	}
	ufrag, _, _ = strings.Cut(string(username), ":")

	return ufrag, msg.TransactionID, isVoiceUfrag(ufrag)
}

// voiceUfrag is voiceRequest's ufrag.
func voiceUfrag(b []byte) (string, bool) {
	ufrag, _, ok := voiceRequest(b)

	return ufrag, ok
}

// bindingSuccessID reads a STUN binding success response's transaction id. ok is false for anything else.
func bindingSuccessID(b []byte) (txid [stun.TransactionIDSize]byte, ok bool) {
	if !stun.IsMessage(b) {
		return txid, false
	}
	msg := &stun.Message{Raw: append([]byte(nil), b...)}
	if msg.Decode() != nil || msg.Type != stun.BindingSuccess {
		return txid, false
	}

	return msg.TransactionID, true
}

// onUDP is Pion's OnUnhandledPacket: a packet on 443 that no desk-rtc session took. Pion's one read goroutine calls
// it, and it must not block, so a mapping's packets go to its queue, and data is copied. A pending flow's requests are
// written straight to its loopback socket, which doesn't block either.
func (r *voiceRelay) onUDP(data []byte, from netip.AddrPort) {
	if !r.enabled.Load() {
		return // every desk but a Guild Desk: dropped, as before
	}
	r.mu.Lock()
	m := r.byAddr[from]
	if m != nil && m.confirmed {
		r.queueLocked(m, data)
		r.mu.Unlock()

		return
	}
	r.mu.Unlock()
	if len(data) > voiceMaxPacket {
		return
	}
	ufrag, txid, ok := voiceRequest(data)
	if !ok {
		return // pending or unknown: only Commons' binding requests go to it
	}
	if m == nil {
		var err error
		if m, err = r.openUDP(from, ufrag); err != nil {
			r.refused.Add(1)
			r.log.Debug("voice relay refused", "err", err)

			return
		}
	}
	r.mu.Lock()
	if m.closed || m.confirmed {
		// Closed meanwhile, or Commons answered in between: a confirmed one takes it as any packet.
		if m.confirmed && !m.closed {
			r.queueLocked(m, data)
		}
		r.mu.Unlock()

		return
	}
	if len(m.txids) == voiceTxIDs {
		copy(m.txids, m.txids[1:])
		m.txids = m.txids[:voiceTxIDs-1]
	}
	m.txids = append(m.txids, txid)
	m.last.Store(time.Now().UnixNano())
	r.mu.Unlock()
	_, _ = m.conn.Write(data)
}

func (r *voiceRelay) queueLocked(m *voiceMapping, data []byte) {
	if m.closed {
		return
	}
	m.last.Store(time.Now().UnixNano())
	select {
	case m.in <- append([]byte(nil), data...):
	default:
		r.refused.Add(1) // Commons isn't keeping up: drop, as a network would
	}
}

var errVoiceCap = errors.New("voice relay cap reached")

// openUDP makes a pending flow for a client address. Past the per-network cap it's refused; past the pending total, the
// oldest pending flow makes room.
func (r *voiceRelay) openUDP(from netip.AddrPort, ufrag string) (*voiceMapping, error) {
	network := clientNetwork(from.Addr())
	var evict *voiceMapping
	r.mu.Lock()
	if m := r.byAddr[from]; m != nil {
		r.mu.Unlock()

		return m, nil // another packet from the address made it meanwhile
	}
	if r.udpByNet[network] >= r.lim.udpPendingPerNet {
		r.mu.Unlock()

		return nil, fmt.Errorf("%w: %d pending from %s", errVoiceCap, r.lim.udpPendingPerNet, network)
	}
	if len(r.udpPending) >= r.lim.udpPending {
		evict = r.udpPending[0]
		r.unpendLocked(evict)
	}
	r.mu.Unlock()
	if evict != nil {
		r.evicted.Add(1)
		r.closeUDP(evict)
	}
	// A loopback socket and a connect: no network, and no lock held.
	conn, err := net.DialUDP("udp4", nil, r.udpAddr)
	if err != nil {
		return nil, err
	}
	m := &voiceMapping{client: from, network: network, ufrag: ufrag, conn: conn, created: time.Now()}
	m.last.Store(m.created.UnixNano())
	r.mu.Lock()
	if r.byAddr[from] != nil || r.udpByNet[network] >= r.lim.udpPendingPerNet {
		r.mu.Unlock()
		_ = conn.Close()

		return nil, fmt.Errorf("%w: lost a race for %s", errVoiceCap, from)
	}
	r.byAddr[from] = m
	r.udpPending = append(r.udpPending, m)
	r.udpByNet[network]++
	r.mu.Unlock()
	go r.fromCommons(m)

	return m, nil
}

// confirmLocked makes a pending flow a mapping, within the caps on mappings. False means it was refused, and the
// caller closes it.
func (r *voiceRelay) confirmLocked(m *voiceMapping) bool {
	if r.udpLive >= r.lim.udpTotal || r.udpByUfrag[m.ufrag] >= r.lim.udpPerUfrag {
		return false
	}
	r.unpendLocked(m)
	m.confirmed = true
	m.txids = nil
	m.in = make(chan []byte, voiceQueue)
	r.udpByUfrag[m.ufrag]++
	r.udpLive++
	go r.toCommons(m)

	return true
}

func (r *voiceRelay) toCommons(m *voiceMapping) {
	for b := range m.in {
		if _, err := m.conn.Write(b); err != nil {
			r.closeUDP(m)

			return
		}
	}
}

// fromCommons sends Commons' packets to the client from 443. While pending, only Commons' binding success for one of
// the flow's requests counts: it makes the flow a mapping, and goes on to the client. Anything else is dropped.
func (r *voiceRelay) fromCommons(m *voiceMapping) {
	buf := make([]byte, voiceMaxPacket+1)
	for {
		n, err := m.conn.Read(buf)
		if err != nil {
			r.closeUDP(m)

			return
		}
		if n > voiceMaxPacket {
			continue
		}
		r.mu.Lock()
		if m.closed {
			r.mu.Unlock()

			return
		}
		if !m.confirmed {
			txid, ok := bindingSuccessID(buf[:n])
			if !ok || !hasTxID(m.txids, txid) {
				r.mu.Unlock()

				continue
			}
			if !r.confirmLocked(m) {
				r.mu.Unlock()
				r.refused.Add(1)
				r.closeUDP(m)

				return
			}
		}
		r.mu.Unlock()
		m.last.Store(time.Now().UnixNano())
		if r.out != nil {
			_, _ = r.out.WriteToUDPAddrPort(buf[:n], m.client)
		}
	}
}

func hasTxID(ids [][stun.TransactionIDSize]byte, id [stun.TransactionIDSize]byte) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}

	return false
}

// unpendLocked takes a flow out of the pending counts, if it's there.
func (r *voiceRelay) unpendLocked(m *voiceMapping) {
	for i, p := range r.udpPending {
		if p == m {
			r.udpPending = append(r.udpPending[:i], r.udpPending[i+1:]...)
			if r.udpByNet[m.network]--; r.udpByNet[m.network] <= 0 {
				delete(r.udpByNet, m.network)
			}

			return
		}
	}
}

func (r *voiceRelay) closeUDP(m *voiceMapping) {
	r.mu.Lock()
	if m.closed {
		r.mu.Unlock()

		return
	}
	m.closed = true
	if r.byAddr[m.client] == m {
		delete(r.byAddr, m.client)
	}
	if m.confirmed {
		if r.udpByUfrag[m.ufrag]--; r.udpByUfrag[m.ufrag] <= 0 {
			delete(r.udpByUfrag, m.ufrag)
		}
		r.udpLive--
		close(m.in)
	} else {
		r.unpendLocked(m)
	}
	r.mu.Unlock()
	_ = m.conn.Close()
}

// sweep ends pending flows Commons never answered, and idle mappings.
func (r *voiceRelay) sweep() {
	tick := time.NewTicker(voiceSweepEvery)
	defer tick.Stop()
	for {
		select {
		case <-r.stop:
			return
		case now := <-tick.C:
			r.expire(now)
		}
	}
}

func (r *voiceRelay) expire(now time.Time) {
	r.mu.Lock()
	var old []*voiceMapping
	for _, m := range r.byAddr {
		idle := now.Sub(time.Unix(0, m.last.Load()))
		if (!m.confirmed && now.Sub(m.created) >= r.lim.pendingTTL) || idle >= r.lim.idleTTL {
			old = append(old, m)
		}
	}
	r.mu.Unlock()
	for _, m := range old {
		r.closeUDP(m)
	}
}

func (r *voiceRelay) closeAll() {
	r.mu.Lock()
	all := make([]*voiceMapping, 0, len(r.byAddr))
	for _, m := range r.byAddr {
		all = append(all, m)
	}
	splices := make([]*voiceSplice, 0, len(r.tcpLive))
	for sp := range r.tcpLive {
		splices = append(splices, sp)
	}
	r.mu.Unlock()
	for _, m := range all {
		r.closeUDP(m)
	}
	for _, sp := range splices {
		sp.closeConns()
	}
}

func (r *voiceRelay) close() {
	r.stopped.Do(func() { close(r.stop) })
	r.enabled.Store(false)
	r.closeAll()
}

// takeTCP is the TCP gate's offer of a connection no session's ufrag claimed: it's spliced to Commons when its first
// frame names a Commons ufrag, within the caps. True means the relay owns c now.
func (r *voiceRelay) takeTCP(c net.Conn, first []byte, ufrag string) bool {
	if !r.enabled.Load() || !isVoiceUfrag(ufrag) {
		return false
	}
	var ip netip.Addr
	if ta, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		ip = ta.AddrPort().Addr()
	}
	sp := &voiceSplice{ufrag: ufrag, network: clientNetwork(ip), client: c, pending: true}
	var evict *voiceSplice
	r.mu.Lock()
	if r.tcpByNet[sp.network] >= r.lim.tcpPendingPerNet || r.tcpConfirmd >= r.lim.tcpTotal {
		r.mu.Unlock()
		r.refused.Add(1)

		return false
	}
	if len(r.tcpPending) >= r.lim.tcpPending {
		evict = r.tcpPending[0]
		r.unpendTCPLocked(evict)
		evict.evicted = true
	}
	r.tcpLive[sp] = struct{}{}
	r.tcpPending = append(r.tcpPending, sp)
	r.tcpByNet[sp.network]++
	r.mu.Unlock()
	if evict != nil {
		r.evicted.Add(1)
		evict.closeConns()
	}
	go r.splice(c, first, sp)

	return true
}

// closeConns ends a splice from outside: both connections close, and its pipes return.
func (sp *voiceSplice) closeConns() {
	_ = sp.client.Close()
	if up := sp.up.Load(); up != nil {
		_ = (*up).Close()
	}
}

func (r *voiceRelay) splice(c net.Conn, first []byte, sp *voiceSplice) {
	defer func() {
		r.mu.Lock()
		delete(r.tcpLive, sp)
		r.unpendTCPLocked(sp)
		if sp.confirmed {
			sp.confirmed = false
			if r.tcpByUfrag[sp.ufrag]--; r.tcpByUfrag[sp.ufrag] <= 0 {
				delete(r.tcpByUfrag, sp.ufrag)
			}
			r.tcpConfirmd--
		}
		r.mu.Unlock()
	}()
	defer c.Close()
	up, err := net.DialTimeout("tcp4", r.target, voiceDialWait)
	if err != nil {
		r.refused.Add(1)
		r.log.Debug("voice relay: Commons isn't listening on TCP", "err", err)

		return
	}
	defer up.Close()
	sp.up.Store(&up)
	r.mu.Lock()
	evicted := sp.evicted
	r.mu.Unlock()
	if evicted {
		return // pushed out while it dialled
	}
	for _, x := range []net.Conn{c, up} {
		if tc, ok := x.(*net.TCPConn); ok {
			_ = tc.SetNoDelay(true)
		}
	}
	if _, err := up.Write(first); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	// Commons has pendingTTL to answer the first request; after that, each way may be quiet for idleTTL. ICE sends
	// consent checks both ways every few seconds, so a live connection is never that quiet.
	go func() { r.pipe(up, c, r.lim.idleTTL, r.lim.idleTTL, nil); done <- struct{}{} }()
	confirm := func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		if !sp.pending || sp.evicted {
			return false // pushed out meanwhile
		}
		if r.tcpByUfrag[sp.ufrag] >= r.lim.tcpPerUfrag || r.tcpConfirmd >= r.lim.tcpTotal {
			r.refused.Add(1)

			return false
		}
		r.unpendTCPLocked(sp)
		sp.confirmed = true
		r.tcpByUfrag[sp.ufrag]++
		r.tcpConfirmd++

		return true
	}
	go func() { r.pipe(c, up, r.lim.pendingTTL, r.lim.idleTTL, confirm); done <- struct{}{} }()
	<-done
	_ = c.Close()
	_ = up.Close()
	<-done
}

// unpendTCPLocked takes a splice out of the pending counts, if it's there.
func (r *voiceRelay) unpendTCPLocked(sp *voiceSplice) {
	if !sp.pending {
		return
	}
	sp.pending = false
	for i, p := range r.tcpPending {
		if p == sp {
			r.tcpPending = append(r.tcpPending[:i], r.tcpPending[i+1:]...)

			break
		}
	}
	if r.tcpByNet[sp.network]--; r.tcpByNet[sp.network] <= 0 {
		delete(r.tcpByNet, sp.network)
	}
}

// pipe copies src to dst until either fails or src is quiet too long: firstWait for the first read, then idle.
// first, if set, runs once at the first bytes, and false from it ends the pipe without writing them.
func (r *voiceRelay) pipe(dst io.Writer, src net.Conn, firstWait, idle time.Duration, first func() bool) {
	buf := make([]byte, 16*1024)
	wait := firstWait
	for {
		_ = src.SetReadDeadline(time.Now().Add(wait))
		n, err := src.Read(buf)
		if n > 0 {
			if first != nil {
				if !first() {
					return
				}
				first = nil
			}
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
			wait = idle
		}
		if err != nil {
			return
		}
	}
}

// stats is the relay's line in a Guild Desk's stats.
func (r *voiceRelay) stats() *rtcsock.VoiceRelayStats {
	r.mu.Lock()
	defer r.mu.Unlock()

	return &rtcsock.VoiceRelayStats{
		UDPMappings: r.udpLive, UDPPending: len(r.udpPending), TCPConnections: r.tcpConfirmd, TCPPending: len(r.tcpPending),
		Refused: r.refused.Load(), Evicted: r.evicted.Load(),
	}
}
