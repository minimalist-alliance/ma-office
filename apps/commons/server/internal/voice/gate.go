package voice

// The gate in front of the relay listeners on 127.0.0.1:8799. desk-rtc passes them whatever reaches the guild desk's
// port 443 with a `cmns` ufrag, so anyone can reach them. The gate lets through only what belongs to one of Commons'
// own live voice connections: a STUN binding request whose USERNAME names that connection's ufrag and whose
// MESSAGE-INTEGRITY is right for its password. Everything else is dropped before Pion sees it, and nothing is kept for
// it. Each connection gets at most a few relayed addresses (UDP) and connections (TCP), as desk-rtc caps its side.
//
// A check is good for one address only (Security's GDN-2). Someone who can watch a member's traffic could otherwise
// replay a captured check from addresses of their own, each one signed right, and fill that connection's few places so
// the member's own new address (a network change, a NAT rebinding) gets none. A replay carries the check's transaction
// ID, which the signature covers, so a transaction ID that already let one address or connection in lets in no other.

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v4"
)

// Caps and timing on the relay listeners. Vars so tests can shorten them.
var (
	// gateUDPPerUfrag is how many relayed client addresses one voice connection may have: desk-rtc gives each client
	// address its own loopback port, and caps its mappings at 4 a ufrag.
	gateUDPPerUfrag = 4
	// gateTCPPerUfrag is how many relayed TCP connections one voice connection may have (desk-rtc: 2).
	gateTCPPerUfrag = 2
	// gateTCPPending is how many TCP connections may be waiting for their first frame at once (desk-rtc: 64).
	gateTCPPending = 64
	// gateFirstFrame is how long a TCP connection has to send its first frame.
	gateFirstFrame = 5 * time.Second
	// gateIdle forgets a UDP address after this long with no packet.
	gateIdle = 60 * time.Second
	// gateChecks is how many of one connection's checks that let something in the gate remembers, newest kept (GDN-2).
	gateChecks = 64
)

// gateMaxFrame caps the first TCP frame: a binding request is a few hundred bytes.
const gateMaxFrame = 2048

// GateRefused counts what the gate refused, for /stats.
var GateRefused atomic.Uint64

// credentials is the SFU's registry of live voice connections' ICE credentials, and of the checks that let an address
// or a connection in for each, so none of them can let in another (GDN-2).
type credentials struct {
	mu   sync.RWMutex
	pwd  map[string]string      // ufrag → password
	used map[string][]usedCheck // ufrag → its checks that let something in, oldest first, at most gateChecks
}

// usedCheck is a check's transaction ID and the address it let in.
type usedCheck struct {
	id   [stun.TransactionIDSize]byte
	from string
}

func (c *credentials) add(ufrag, pwd string) {
	c.mu.Lock()
	c.pwd[ufrag] = pwd
	c.mu.Unlock()
}

func (c *credentials) remove(ufrag string) {
	c.mu.Lock()
	delete(c.pwd, ufrag)
	delete(c.used, ufrag)
	c.mu.Unlock()
}

// claim says whether check id, from address from, may let it in: no other address has been let in by it (GDN-2). The
// same address may come again with it, as a retransmission does. It keeps nothing for a connection that has ended.
func (c *credentials) claim(ufrag string, id [stun.TransactionIDSize]byte, from string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.pwd[ufrag]; !ok {
		return false
	}
	if c.used == nil {
		c.used = map[string][]usedCheck{}
	}
	list := c.used[ufrag]
	for _, u := range list {
		if u.id == id {
			return u.from == from
		}
	}
	if len(list) >= gateChecks {
		list = append(list[:0:0], list[len(list)-gateChecks+1:]...)
	}
	c.used[ufrag] = append(list, usedCheck{id: id, from: from})
	return true
}

func (c *credentials) password(ufrag string) (string, bool) {
	c.mu.RLock()
	p, ok := c.pwd[ufrag]
	c.mu.RUnlock()
	return p, ok
}

func (c *credentials) live(ufrag string) bool {
	_, ok := c.password(ufrag)
	return ok
}

// admitBinding returns the local ufrag and the transaction ID of a STUN binding request that names one of Commons'
// live connections and is signed with its password. It never changes b.
func (c *credentials) admitBinding(b []byte) (string, [stun.TransactionIDSize]byte, bool) {
	var none [stun.TransactionIDSize]byte
	if !stun.IsMessage(b) {
		return "", none, false
	}
	m := &stun.Message{Raw: append([]byte(nil), b...)}
	if m.Decode() != nil || m.Type != stun.BindingRequest {
		return "", none, false
	}
	var u stun.Username
	if u.GetFrom(m) != nil {
		return "", none, false
	}
	local, _, ok := strings.Cut(u.String(), ":")
	if !ok || !strings.HasPrefix(local, UfragPrefix) {
		return "", none, false
	}
	pwd, ok := c.password(local)
	if !ok || stun.NewShortTermIntegrity(pwd).Check(m) != nil {
		return "", none, false
	}
	return local, m.TransactionID, true
}

// ---------------------------------------------------------------- UDP

type gateEntry struct {
	ufrag string
	last  atomic.Int64 // unix nanoseconds of the last packet
}

// gatedPacketConn is the relay UDP socket as Pion's mux sees it: only admitted addresses' packets come through.
type gatedPacketConn struct {
	net.PacketConn
	creds *credentials

	mu       sync.Mutex
	allowed  map[netip.AddrPort]*gateEntry
	perUfrag map[string]int
	swept    time.Time
}

func newGatedPacketConn(pc net.PacketConn, c *credentials) *gatedPacketConn {
	return &gatedPacketConn{PacketConn: pc, creds: c, allowed: map[netip.AddrPort]*gateEntry{}, perUfrag: map[string]int{}}
}

func (g *gatedPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		n, addr, err := g.PacketConn.ReadFrom(p)
		if err != nil {
			return n, addr, err
		}
		if g.admit(p[:n], addr) {
			return n, addr, nil
		}
		GateRefused.Add(1)
	}
}

func (g *gatedPacketConn) admit(b []byte, addr net.Addr) bool {
	ua, ok := addr.(*net.UDPAddr)
	if !ok {
		return false
	}
	key := ua.AddrPort()
	now := time.Now()
	g.mu.Lock()
	e := g.allowed[key]
	if e != nil && !g.creds.live(e.ufrag) {
		g.drop(key, e)
		e = nil
	}
	g.mu.Unlock()
	if e != nil {
		e.last.Store(now.UnixNano())
		return true
	}
	// A new address: only a signed binding request for a live connection, under its cap, that let no other in.
	ufrag, id, ok := g.creds.admitBinding(b)
	if !ok {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if now.Sub(g.swept) > 10*time.Second {
		g.sweep(now)
	}
	if g.perUfrag[ufrag] >= gateUDPPerUfrag || !g.creds.claim(ufrag, id, "udp "+key.String()) {
		return false
	}
	e = &gateEntry{ufrag: ufrag}
	e.last.Store(now.UnixNano())
	g.allowed[key] = e
	g.perUfrag[ufrag]++
	return true
}

// drop forgets an address. Call with g.mu held.
func (g *gatedPacketConn) drop(key netip.AddrPort, e *gateEntry) {
	delete(g.allowed, key)
	if g.perUfrag[e.ufrag]--; g.perUfrag[e.ufrag] <= 0 {
		delete(g.perUfrag, e.ufrag)
	}
}

// sweep forgets addresses whose connection ended or that went quiet. Call with g.mu held.
func (g *gatedPacketConn) sweep(now time.Time) {
	g.swept = now
	for k, e := range g.allowed {
		if !g.creds.live(e.ufrag) || now.UnixNano()-e.last.Load() > int64(gateIdle) {
			g.drop(k, e)
		}
	}
}

// addresses is how many addresses are let through, for tests.
func (g *gatedPacketConn) addresses() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.allowed)
}

// ---------------------------------------------------------------- TCP

// gatedListener is the relay TCP listener as Pion's TCP mux sees it: it hands on a connection only once its first
// RFC 4571 frame is a signed binding request for a live connection under that connection's cap, with the frame put
// back in front so Pion reads it as it would have.
type gatedListener struct {
	net.Listener
	creds   *credentials
	out     chan net.Conn
	pending chan struct{}
	done    chan struct{}
	once    sync.Once
	err     error

	mu       sync.Mutex
	perUfrag map[string]int
}

func newGatedListener(l net.Listener, c *credentials) *gatedListener {
	g := &gatedListener{Listener: l, creds: c, out: make(chan net.Conn), pending: make(chan struct{}, gateTCPPending),
		done: make(chan struct{}), perUfrag: map[string]int{}}
	go g.loop()
	return g
}

func (g *gatedListener) loop() {
	for {
		c, err := g.Listener.Accept()
		if err != nil {
			g.shut(err)
			return
		}
		select {
		case g.pending <- struct{}{}:
			go func() {
				defer func() { <-g.pending }()
				g.vet(c)
			}()
		default:
			GateRefused.Add(1)
			c.Close()
		}
	}
}

func (g *gatedListener) vet(c net.Conn) {
	_ = c.SetReadDeadline(time.Now().Add(gateFirstFrame))
	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		GateRefused.Add(1)
		c.Close()
		return
	}
	n := int(binary.BigEndian.Uint16(hdr[:]))
	if n < 20 || n > gateMaxFrame {
		GateRefused.Add(1)
		c.Close()
		return
	}
	frame := make([]byte, 2+n)
	copy(frame, hdr[:])
	if _, err := io.ReadFull(c, frame[2:]); err != nil {
		GateRefused.Add(1)
		c.Close()
		return
	}
	ufrag, id, ok := g.creds.admitBinding(frame[2:])
	if ok {
		g.mu.Lock()
		// A TCP connection's first check is its own: one another connection already sent is a replay (GDN-2).
		if g.perUfrag[ufrag] >= gateTCPPerUfrag || !g.creds.claim(ufrag, id, "tcp "+c.RemoteAddr().String()) {
			ok = false
		} else {
			g.perUfrag[ufrag]++
		}
		g.mu.Unlock()
	}
	if !ok {
		GateRefused.Add(1)
		c.Close()
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	gc := &gatedConn{Conn: c, first: bytes.NewReader(frame), release: func() {
		g.mu.Lock()
		if g.perUfrag[ufrag]--; g.perUfrag[ufrag] <= 0 {
			delete(g.perUfrag, ufrag)
		}
		g.mu.Unlock()
	}}
	select {
	case g.out <- gc:
	case <-g.done:
		gc.Close()
	}
}

// Accept returns the next admitted connection.
func (g *gatedListener) Accept() (net.Conn, error) {
	select {
	case c := <-g.out:
		return c, nil
	case <-g.done:
		return nil, g.err // written before done closed
	}
}

func (g *gatedListener) Close() error { return g.shut(net.ErrClosed) }

// shut stops the gate once, with the error Accept returns from then on.
func (g *gatedListener) shut(why error) error {
	var err error
	g.once.Do(func() {
		g.err = why
		close(g.done)
		err = g.Listener.Close()
	})
	return err
}

// gatedConn replays the first frame the gate read, then reads on.
type gatedConn struct {
	net.Conn
	first   *bytes.Reader
	once    sync.Once
	release func()
}

func (c *gatedConn) Read(p []byte) (int, error) {
	if c.first != nil && c.first.Len() > 0 {
		return c.first.Read(p)
	}
	return c.Conn.Read(p)
}

func (c *gatedConn) Close() error {
	c.once.Do(c.release)
	return c.Conn.Close()
}
