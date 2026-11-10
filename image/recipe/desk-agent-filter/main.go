// desk-agent-filter holds desk-agent (uid 1103) to the providers' names (ADR 0070, image/README.md).
//
// nftables redirects uid 1103's TCP 443 to the TLS port here and its DNS to the DNS port here, whatever address it aimed
// at. This process reads the name in each ClientHello, refuses any name that isn't exactly in /etc/ma/agent-egress.conf,
// resolves an allowed name itself, connects there and splices the two sockets. It never sees inside TLS and holds no keys.
// The DNS port answers listed names with a placeholder and forwards nothing.
//
// It runs as uid 1106 with no capabilities, and has no timers, so it does nothing while nothing connects.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/netip"
	"os"
	"sync"
	"syscall"
	"time"
)

const (
	confPath = "/etc/ma/agent-egress.conf"
	tlsPort  = "14443" // nftables.conf redirects to these two, and lets only uid 1103 reach them
	dnsPort  = "14053"
	stubAddr = "127.0.0.53:53" // systemd-resolved's stub, which nftables lets uid 1106 reach

	// At most this many TLS connections at once, each holding at most twice the sum of the buffers below. desk-agent needs far
	// fewer, since each agent makes one call at a time, and a loop in it can't spend memory without end. 64 of them
	// with every buffer full fit in the unit's MemoryMax with room to spare (ADR 0070).
	maxConnections = 64

	// Each connection's kernel buffers are charged to this unit's memory cgroup, so they're set, not left to TCP's tuning,
	// which grows them to megabytes when one side sends faster than the other reads: in 0.1.0, 30 fast downloads at once
	// filled MemoryMax and the kernel killed the filter (ADR 0070). Set per direction, because uploads wait on the 100 Mbit/s
	// shaper whatever their buffers, while a download needs room to keep its speed. The kernel doubles each, within
	// net.core.[rw]mem_max, so a connection holds at most twice their sum.
	upstreamReadBuffer  = 256 << 10 // from the provider, about 1.5 ms from a cloud desk
	upstreamWriteBuffer = 64 << 10  // to the provider
	clientReadBuffer    = 16 << 10  // from desk-agent, over loopback
	clientWriteBuffer   = 256 << 10 // to desk-agent, over loopback
	dnsBuffer           = 16 << 10  // each way on a DNS connection over TCP

	maxDNSConns    = 32
	helloTimeout   = 5 * time.Second  // the whole hello, however it's split
	resolveBudget  = 5 * time.Second  // the stub's answer
	dialTimeout    = 3 * time.Second  // one address
	connectBudget  = 10 * time.Second // the stub and every address together
	dnsConnTimeout = 5 * time.Second  // one DNS connection over TCP, from accept to close
	halfClosed     = 10 * time.Minute // after one direction has ended; nothing here limits a connection otherwise
)

var keepAlive = net.KeepAliveConfig{Enable: true, Idle: 30 * time.Second, Interval: 15 * time.Second, Count: 4}

func main() {
	log.SetFlags(0) // journald stamps each line
	text, err := os.ReadFile(confPath)
	if err != nil {
		log.Printf("can't read %s (%v): every name is refused", confPath, err)
	}
	names := parseNames(string(text), log.Printf)
	if len(names) == 0 {
		log.Printf("no names in %s: desk-agent can reach no provider", confPath)
	}
	refusals := &refusalLog{printf: log.Printf}
	stub := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, stubAddr)
	}}
	s := &server{
		names:         names,
		slots:         make(chan struct{}, maxConnections),
		allowAddr:     providerAddress,
		upstreamPort:  443,
		helloTimeout:  helloTimeout,
		dialTimeout:   dialTimeout,
		connectBudget: connectBudget,
		halfClosed:    halfClosed,
		refusals:      refusals,
		resolve: func(ctx context.Context, network, name string) ([]netip.Addr, error) {
			ctx, cancel := context.WithTimeout(ctx, resolveBudget)
			defer cancel()
			return stub.LookupNetIP(ctx, network, name+".") // the dot: never a search domain
		},
	}
	d := &dnsServer{names: names, refusals: refusals, slots: make(chan struct{}, maxDNSConns), connTimeout: dnsConnTimeout}

	serve := func(what string, f func() error) {
		go func() { log.Fatalf("%s stopped: %v", what, f()) }()
	}
	lc := net.ListenConfig{KeepAliveConfig: keepAlive}
	for _, host := range []string{"127.0.0.1", "::1"} {
		tl, err := lc.Listen(context.Background(), "tcp", net.JoinHostPort(host, tlsPort))
		if err != nil {
			if host == "::1" && errors.Is(err, syscall.EADDRNOTAVAIL) {
				log.Printf("no ::1 on this machine: IPv4 only")
				continue
			}
			log.Fatalf("listen: %v", err)
		}
		dl, err := lc.Listen(context.Background(), "tcp", net.JoinHostPort(host, dnsPort))
		if err != nil {
			log.Fatalf("listen: %v", err)
		}
		pc, err := lc.ListenPacket(context.Background(), "udp", net.JoinHostPort(host, dnsPort))
		if err != nil {
			log.Fatalf("listen: %v", err)
		}
		serve("TLS", func() error { return s.serve(tl.(*net.TCPListener)) })
		serve("DNS over TCP", func() error { return d.serveTCP(dl.(*net.TCPListener)) })
		serve("DNS over UDP", func() error { return d.serveUDP(pc.(*net.UDPConn)) })
	}
	log.Printf("listening on loopback, TLS %s, DNS %s, %d names", tlsPort, dnsPort, len(names))
	select {}
}

// refusalLog writes refusals to the journal at a limited rate, with no timer: a burst of refused names can't fill the
// journal, and the next line after a quiet minute says how many went unlogged. Callers pass names, never contents.
type refusalLog struct {
	printf func(string, ...any)
	now    func() time.Time

	mu      sync.Mutex
	window  time.Time
	used    int
	dropped int
}

const refusalsPerMinute = 10

func (l *refusalLog) refused(format string, args ...any) {
	now := time.Now
	if l.now != nil {
		now = l.now
	}
	t := now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if t.Sub(l.window) >= time.Minute {
		if l.dropped > 0 {
			l.printf("%d more refusals not logged", l.dropped)
		}
		l.window, l.used, l.dropped = t, 0, 0
	}
	if l.used >= refusalsPerMinute {
		l.dropped++
		return
	}
	l.used++
	l.printf(format, args...)
}
