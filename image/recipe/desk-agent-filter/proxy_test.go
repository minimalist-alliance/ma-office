package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type context_ = context.Context

func testContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

var loopback = netip.MustParseAddr("127.0.0.1")

// rig is a filter on a real loopback socket, with a stand-in provider behind it. resolve and allowAddr are the only
// parts of the real thing it replaces, because the stand-in is on loopback.
type rig struct {
	s        *server
	addr     *net.TCPAddr
	upstream *net.TCPListener
	resolved atomic.Int32
	logged   []string
	logMu    sync.Mutex
	t        *testing.T
}

func newRig(t *testing.T, connections int, setup ...func(*rig)) *rig {
	t.Helper()
	r := &rig{t: t}
	up, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	r.upstream = up
	t.Cleanup(func() { up.Close() })
	r.s = &server{
		names:         map[string]struct{}{"api.x.ai": {}},
		slots:         make(chan struct{}, connections),
		allowAddr:     func(a netip.Addr) bool { return a == loopback || providerAddress(a) },
		upstreamPort:  up.Addr().(*net.TCPAddr).Port,
		helloTimeout:  2 * time.Second,
		dialTimeout:   time.Second,
		connectBudget: 3 * time.Second,
		halfClosed:    2 * time.Second,
		refusals: &refusalLog{printf: func(f string, a ...any) {
			r.logMu.Lock()
			defer r.logMu.Unlock()
			r.logged = append(r.logged, f)
		}},
		resolve: func(_ context.Context, network, _ string) ([]netip.Addr, error) {
			r.resolved.Add(1)
			if network == "ip4" {
				return []netip.Addr{loopback}, nil
			}
			return nil, nil
		},
	}
	for _, f := range setup {
		f(r)
	}
	l, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	r.addr = l.Addr().(*net.TCPAddr)
	go r.s.serve(l)
	return r
}

func (r *rig) dial() *net.TCPConn {
	r.t.Helper()
	c, err := net.DialTCP("tcp", nil, r.addr)
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(10 * time.Second))
	return c
}

// expectClosed: the filter ended this connection without a byte coming back.
func expectClosed(t *testing.T, c net.Conn) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	b, err := io.ReadAll(c)
	if len(b) != 0 {
		t.Fatalf("%d bytes came back", len(b))
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		t.Fatal("the filter didn't close it")
	}
}

func TestProxyForwardsEveryByteAndSplices(t *testing.T) {
	r := newRig(t, 4)
	raw := records(defaultSpec("api.x.ai").message(), 40)
	early := []byte{23, 3, 3, 0, 1, 0x55}
	response := bytes.Repeat([]byte("token "), 200000)
	got := make(chan []byte, 1)
	go func() {
		c, err := r.upstream.AcceptTCP()
		if err != nil {
			return
		}
		defer c.Close()
		b := make([]byte, len(raw)+len(early))
		io.ReadFull(c, b)
		got <- b
		c.Write(response)
	}()
	c := r.dial()
	c.Write(append(append([]byte{}, raw...), early...))
	back, err := io.ReadAll(c)
	if err != nil || !bytes.Equal(back, response) {
		t.Fatalf("%d bytes back of %d, %v", len(back), len(response), err)
	}
	if b := <-got; !bytes.Equal(b, append(append([]byte{}, raw...), early...)) {
		t.Fatalf("the provider got different bytes")
	}
}

func TestProxyRefusals(t *testing.T) {
	r := newRig(t, 16)
	spec := func(f func(*helloSpec)) []byte {
		h := defaultSpec("api.x.ai")
		f(&h)
		return record(h.message())
	}
	for name, raw := range map[string][]byte{
		"unlisted":  record(defaultSpec("www.cloudflare.com").message()),
		"subdomain": record(defaultSpec("x.api.x.ai").message()),
		"no SNI":    spec(func(h *helloSpec) { h.extensions = h.extensions[:1] }),
		"ECH":       spec(func(h *helloSpec) { h.extensions = append(h.extensions, ext{extECH, []byte{0}}) }),
		"garbage":   []byte("GET / HTTP/1.0\r\n\r\n"),
	} {
		c := r.dial()
		c.Write(raw)
		expectClosed(t, c)
		if r.resolved.Load() != 0 {
			t.Fatalf("%s: it resolved a name", name)
		}
	}
}

// ip returns a resolver that answers ip4 and ip6 with these lists.
func ip(v4, v6 []string) func(context.Context, string, string) ([]netip.Addr, error) {
	return func(_ context.Context, network, _ string) ([]netip.Addr, error) {
		list := v4
		if network == "ip6" {
			list = v6
		}
		var out []netip.Addr
		for _, a := range list {
			out = append(out, netip.MustParseAddr(a))
		}
		return out, nil
	}
}

func TestProxyConnectsOnlyToGlobalAddresses(t *testing.T) {
	r := newRig(t, 4, func(r *rig) {
		r.s.allowAddr = providerAddress // the real rule: the stand-in on loopback is out
		r.s.resolve = ip([]string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "::ffff:127.0.0.1"}, []string{"::1", "fe80::1", "::ffff:127.0.0.1"})
	})
	dialed := make(chan struct{}, 1)
	go func() {
		if c, err := r.upstream.AcceptTCP(); err == nil {
			dialed <- struct{}{}
			c.Close()
		}
	}()
	c := r.dial()
	c.Write(record(defaultSpec("api.x.ai").message()))
	expectClosed(t, c)
	select {
	case <-dialed:
		t.Fatal("it connected to a private address")
	case <-time.After(100 * time.Millisecond):
	}
	r.logMu.Lock()
	defer r.logMu.Unlock()
	if len(r.logged) != 1 {
		t.Fatalf("logged %v", r.logged)
	}
}

// Plain IPv4 in Go's 16-byte form, as /etc/hosts gives it, is still IPv4. Asked for ip4 it's used, and a global one passes.
func TestProxyAnIPv4AddressInEitherFormIsIPv4(t *testing.T) {
	var asked []netip.Addr
	s := &server{allowAddr: func(a netip.Addr) bool { asked = append(asked, a); return false }, resolve: ip([]string{"::ffff:8.8.8.8", "8.8.4.4"}, nil), upstreamPort: 443, dialTimeout: time.Second}
	if _, err := s.connect(context.Background(), "api.x.ai"); !errors.Is(err, errNoGlobalAddress) {
		t.Fatal(err)
	}
	if len(asked) != 2 || asked[0] != netip.MustParseAddr("8.8.8.8") || asked[1] != netip.MustParseAddr("8.8.4.4") {
		t.Fatalf("%v", asked)
	}
	if !providerAddress(asked[0]) {
		t.Fatal("8.8.8.8 is global")
	}
}

// What Go's resolver makes of a real stub's answers. An AAAA answer holding IPv4 must not come back as an address.
func TestResolverDropsIPv4InsideAnAAAAAnswer(t *testing.T) {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFromUDP(buf)
			if err != nil {
				return
			}
			q := buf[:n]
			end := headerLen
			for q[end] != 0 {
				end += 1 + int(q[end])
			}
			qtype := binary.BigEndian.Uint16(q[end+1:])
			answer := []byte{}
			if qtype == typeAAAA {
				answer = append([]byte{0xc0, headerLen, 0, typeAAAA, 0, classIN, 0, 0, 0, 60, 0, 16}, netip.MustParseAddr("::ffff:8.8.8.8").AsSlice()...)
			} else if qtype == typeA {
				answer = []byte{0xc0, headerLen, 0, typeA, 0, classIN, 0, 0, 0, 60, 0, 4, 8, 8, 4, 4}
			}
			r := append([]byte{q[0], q[1], 0x81, 0x80, 0, 1, 0, byte(len(answer) / max(len(answer), 1)), 0, 0, 0, 0}, q[headerLen:end+5]...)
			pc.WriteToUDP(append(r, answer...), from)
		}
	}()
	stub := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "udp", pc.LocalAddr().String())
	}}
	ctx, cancel := testContext()
	defer cancel()
	v4, err := stub.LookupNetIP(ctx, "ip4", "filter-test.example.")
	if err != nil || len(v4) != 1 || v4[0].Unmap() != netip.MustParseAddr("8.8.4.4") {
		t.Fatalf("ip4: %v, %v", v4, err)
	}
	v6, _ := stub.LookupNetIP(ctx, "ip6", "filter-test.example.")
	if len(v6) != 0 {
		t.Fatalf("ip6 gave IPv4 inside IPv6: %v", v6)
	}
}

func TestProxyTriesTheNextAddress(t *testing.T) {
	// Nothing listens on 127.0.0.2 at the stand-in's port, because the stand-in holds only 127.0.0.1.
	r := newRig(t, 4, func(r *rig) {
		r.s.allowAddr = func(netip.Addr) bool { return true }
		r.s.resolve = ip([]string{"127.0.0.2", "127.0.0.1"}, nil)
	})
	go func() {
		if c, err := r.upstream.AcceptTCP(); err == nil {
			c.Write([]byte("hi"))
			c.Close()
		}
	}()
	c := r.dial()
	c.Write(record(defaultSpec("api.x.ai").message()))
	if b, err := io.ReadAll(c); err != nil || string(b) != "hi" {
		t.Fatalf("%q, %v", b, err)
	}
}

// IPv6 is asked for only when IPv4 didn't connect.
func TestProxyFallsBackToIPv6(t *testing.T) {
	var rig6 *net.TCPListener
	r := newRig(t, 4, func(r *rig) {
		var err error
		rig6, err = net.ListenTCP("tcp6", &net.TCPAddr{IP: net.IPv6loopback, Port: r.s.upstreamPort})
		if err != nil {
			t.Skipf("no [::1] at this port: %v", err)
		}
		t.Cleanup(func() { rig6.Close() })
		r.s.allowAddr = func(netip.Addr) bool { return true }
		r.s.resolve = ip([]string{"127.0.0.2"}, []string{"::1"})
	})
	go func() {
		if c, err := rig6.AcceptTCP(); err == nil {
			c.Write([]byte("six"))
			c.Close()
		}
	}()
	c := r.dial()
	c.Write(record(defaultSpec("api.x.ai").message()))
	if b, err := io.ReadAll(c); err != nil || string(b) != "six" {
		t.Fatalf("%q, %v", b, err)
	}
}

func TestProxyCantResolve(t *testing.T) {
	r := newRig(t, 4, func(r *rig) {
		r.s.resolve = func(context.Context, string, string) ([]netip.Addr, error) { return nil, errors.New("no answer") }
	})
	c := r.dial()
	c.Write(record(defaultSpec("api.x.ai").message()))
	expectClosed(t, c)
}

// One way ending leaves the other open: the client sends its request and half-closes, and the answer still comes.
func TestProxyHalfCloseFromClient(t *testing.T) {
	r := newRig(t, 4)
	raw := record(defaultSpec("api.x.ai").message())
	go func() {
		u, err := r.upstream.AcceptTCP()
		if err != nil {
			return
		}
		defer u.Close()
		all, _ := io.ReadAll(u) // only ends when the client's FIN comes through
		time.Sleep(50 * time.Millisecond)
		u.Write([]byte(strings.Repeat("x", len(all)-len(raw))))
	}()
	c := r.dial()
	c.Write(append(append([]byte{}, raw...), "request"...))
	c.CloseWrite()
	b, err := io.ReadAll(c)
	if err != nil || len(b) != len("request") {
		t.Fatalf("%d bytes, %v", len(b), err)
	}
}

func TestProxyHalfCloseFromProvider(t *testing.T) {
	r := newRig(t, 4)
	raw := record(defaultSpec("api.x.ai").message())
	got := make(chan string, 1)
	go func() {
		u, err := r.upstream.AcceptTCP()
		if err != nil {
			return
		}
		defer u.Close()
		io.ReadFull(u, make([]byte, len(raw)))
		u.Write([]byte("bye"))
		u.CloseWrite()
		b, _ := io.ReadAll(u) // the client can still send
		got <- string(b)
	}()
	c := r.dial()
	c.Write(raw)
	b := make([]byte, 3)
	if _, err := io.ReadFull(c, b); err != nil {
		t.Fatal(err)
	}
	if n, err := c.Read(b); n != 0 || err != io.EOF {
		t.Fatalf("no EOF from the provider's half-close: %d, %v", n, err)
	}
	c.Write([]byte("late"))
	c.CloseWrite()
	if s := <-got; s != "late" {
		t.Fatalf("the provider got %q", s)
	}
}

func TestProxyResetEndsBoth(t *testing.T) {
	r := newRig(t, 4)
	raw := record(defaultSpec("api.x.ai").message())
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		u, err := r.upstream.AcceptTCP()
		if err != nil {
			return
		}
		defer u.Close()
		io.Copy(io.Discard, u) // ends when the filter closes its side
	}()
	c := r.dial()
	c.Write(raw)
	time.Sleep(50 * time.Millisecond)
	c.SetLinger(0)
	c.Close() // a reset
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("the provider's side stayed open")
	}
	waitSlots(t, r.s, 0)
}

func waitSlots(t *testing.T, s *server, want int) {
	t.Helper()
	for i := 0; i < 300; i++ {
		if len(s.slots) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%d slots in use, want %d", len(s.slots), want)
}

// A client gone for good looks the same as a half-close until something is written back, and a provider that says
// nothing more mustn't keep the slot for ever.
func TestHalfClosedIsBounded(t *testing.T) {
	r := newRig(t, 1, func(r *rig) { r.s.halfClosed = 100 * time.Millisecond })
	raw := record(defaultSpec("api.x.ai").message())
	go func() {
		if u, err := r.upstream.AcceptTCP(); err == nil {
			t.Cleanup(func() { u.Close() })
			io.Copy(io.Discard, u) // reads the FIN, and never answers or closes
			time.Sleep(time.Second)
		}
	}()
	c := r.dial()
	c.Write(raw)
	time.Sleep(50 * time.Millisecond)
	waitSlots(t, r.s, 1)
	c.Close()
	waitSlots(t, r.s, 0)
}

func TestConnectionCap(t *testing.T) {
	r := newRig(t, 2, func(r *rig) { r.s.halfClosed = 100 * time.Millisecond })
	raw := record(defaultSpec("api.x.ai").message())
	go func() {
		for {
			u, err := r.upstream.AcceptTCP()
			if err != nil {
				return
			}
			t.Cleanup(func() { u.Close() })
			io.CopyN(io.Discard, u, int64(len(raw)))
			u.Write([]byte("ok"))
		}
	}()
	held := []*net.TCPConn{r.dial(), r.dial()}
	for _, c := range held {
		c.Write(raw)
		if _, err := io.ReadFull(c, make([]byte, 2)); err != nil {
			t.Fatal(err)
		}
	}
	waitSlots(t, r.s, 2)
	// The third is refused at once, with no hello needed. The reset can come back before the dial has returned, and then
	// the dial reports it: that's the same refusal.
	if over, err := net.DialTCP("tcp", nil, r.addr); err == nil {
		t.Cleanup(func() { over.Close() })
		expectClosed(t, over)
	} else if !errors.Is(err, syscall.ECONNRESET) {
		t.Fatal(err)
	}
	r.logMu.Lock()
	logged := strings.Join(r.logged, "\n")
	r.logMu.Unlock()
	if !strings.Contains(logged, "connections are open") {
		t.Fatalf("not logged: %s", logged)
	}
	held[0].Close()
	waitSlots(t, r.s, 1)
	again := r.dial() // and a freed slot works again
	again.Write(raw)
	if _, err := io.ReadFull(again, make([]byte, 2)); err != nil {
		t.Fatal(err)
	}
}

// A connection that sends nothing, or a hello too slowly, holds its slot only until the deadline.
func TestIdleHelloFreesItsSlot(t *testing.T) {
	r := newRig(t, 1, func(r *rig) { r.s.helloTimeout = 150 * time.Millisecond })
	idle := r.dial()
	start := time.Now()
	expectClosed(t, idle)
	if d := time.Since(start); d > time.Second {
		t.Fatalf("closed after %v", d)
	}
	waitSlots(t, r.s, 0)
	slow := r.dial()
	slow.Write([]byte{recordHandshake})
	expectClosed(t, slow)
	waitSlots(t, r.s, 0)
}

func TestLogNeverHoldsContents(t *testing.T) {
	var lines []string
	r := newRig(t, 8, func(r *rig) {
		r.s.refusals.printf = func(f string, a ...any) {
			r.logMu.Lock()
			defer r.logMu.Unlock()
			lines = append(lines, formatted(f, a...))
		}
	})
	c := r.dial()
	c.Write([]byte("secret-marker garbage"))
	expectClosed(t, c)
	c = r.dial()
	c.Write(record(defaultSpec("www.cloudflare.com").message()))
	expectClosed(t, c)
	r.logMu.Lock()
	defer r.logMu.Unlock()
	all := strings.Join(lines, "\n")
	if strings.Contains(all, "secret-marker") || !strings.Contains(all, "www.cloudflare.com") || !strings.Contains(all, "malformed") {
		t.Fatalf("%s", all)
	}
}

// All the way through with real TLS on both ends: the filter doesn't touch it, so a certificate for the name verifies.
func TestRealTLSThroughTheFilter(t *testing.T) {
	r := newRig(t, 4)
	cert, roots := selfSigned(t, "api.x.ai")
	go func() {
		for {
			u, err := r.upstream.AcceptTCP()
			if err != nil {
				return
			}
			go func() {
				defer u.Close()
				s := tls.Server(u, &tls.Config{Certificates: []tls.Certificate{cert}})
				if s.Handshake() != nil {
					return
				}
				b := make([]byte, 5)
				io.ReadFull(s, b)
				s.Write(b)
				s.CloseWrite()
			}()
		}
	}()
	for _, cfg := range []*tls.Config{
		{ServerName: "api.x.ai", RootCAs: roots},
		{ServerName: "API.X.AI", RootCAs: roots},
		{ServerName: "api.x.ai", RootCAs: roots, MaxVersion: tls.VersionTLS12},
		{ServerName: "api.x.ai", RootCAs: roots, CurvePreferences: []tls.CurveID{tls.X25519MLKEM768}},
	} {
		c := tls.Client(r.dial(), cfg)
		if err := c.Handshake(); err != nil {
			t.Fatalf("%+v: %v", cfg.ServerName, err)
		}
		c.Write([]byte("hello"))
		if b, err := io.ReadAll(c); err != nil || string(b) != "hello" {
			t.Fatalf("%q, %v", b, err)
		}
		c.Close()
	}
	// The same server, with a client naming another site: refused before it gets there.
	c := tls.Client(r.dial(), &tls.Config{ServerName: "www.cloudflare.com", RootCAs: roots})
	if err := c.Handshake(); err == nil {
		t.Fatal("an unlisted name completed TLS")
	}
}

func selfSigned(t *testing.T, name string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pool
}

func sockopt(t *testing.T, c *net.TCPConn, opt int) int {
	t.Helper()
	rc, err := c.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var v int
	var gerr error
	rc.Control(func(fd uintptr) { v, gerr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, opt) })
	if gerr != nil {
		t.Fatal(gerr)
	}
	return v
}

// sysctlInt reads a number from /proc/sys.
func sysctlInt(t *testing.T, path string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// Both sides of a connection get fixed buffers, so TCP can't grow them into the unit's MemoryMax (ADR 0070). The kernel
// reports twice what was set, within net.core.[rw]mem_max: a desk's are 4 MiB, a stock Debian's 208 KiB.
func TestEachConnectionsBuffersAreBounded(t *testing.T) {
	rmax, wmax := sysctlInt(t, "/proc/sys/net/core/rmem_max"), sysctlInt(t, "/proc/sys/net/core/wmem_max")
	l, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	d := net.Dialer{Control: boundControl(upstreamReadBuffer, upstreamWriteBuffer)}
	up, err := d.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer up.Close()
	c, err := l.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := bound(c, clientReadBuffer, clientWriteBuffer); err != nil {
		t.Fatal(err)
	}
	for _, x := range []struct {
		name        string
		c           *net.TCPConn
		read, write int
	}{{"towards the provider", up.(*net.TCPConn), upstreamReadBuffer, upstreamWriteBuffer}, {"towards desk-agent", c, clientReadBuffer, clientWriteBuffer}} {
		wr, ws := 2*min(x.read, rmax), 2*min(x.write, wmax)
		if r, s := sockopt(t, x.c, syscall.SO_RCVBUF), sockopt(t, x.c, syscall.SO_SNDBUF); r != wr || s != ws {
			t.Fatalf("%s: SO_RCVBUF %d, SO_SNDBUF %d, want %d and %d", x.name, r, s, wr, ws)
		}
	}
}
