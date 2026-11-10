package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"strconv"
	"syscall"
	"time"
)

// server is the TLS side.
type server struct {
	names         map[string]struct{}
	slots         chan struct{}                                                         // a slot for each connection, from accept to close
	resolve       func(ctx context.Context, network, name string) ([]netip.Addr, error) // network is ip4 or ip6
	allowAddr     func(netip.Addr) bool
	upstreamPort  int
	helloTimeout  time.Duration
	dialTimeout   time.Duration
	connectBudget time.Duration
	halfClosed    time.Duration // how long the other way may stay open after one way has ended
	refusals      *refusalLog
}

const maxAddressesTried = 8

var errNoGlobalAddress = errors.New("no global address")

func (s *server) serve(l *net.TCPListener) error {
	for {
		c, err := l.AcceptTCP()
		if errors.Is(err, net.ErrClosed) {
			return err
		}
		if err != nil { // out of descriptors or the like: don't spin on it
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case s.slots <- struct{}{}:
			go func() {
				defer func() { <-s.slots }()
				if err := bound(c, clientReadBuffer, clientWriteBuffer); err != nil {
					s.refusals.refused("refused: %v", err)
					c.Close()
					return
				}
				s.handle(c)
			}()
		default:
			s.refusals.refused("refused: %d connections are open", cap(s.slots))
			c.SetLinger(0)
			c.Close()
		}
	}
}

func (s *server) handle(c *net.TCPConn) {
	defer c.Close()
	raw, name, err := readHello(c, time.Now().Add(s.helloTimeout))
	if err != nil {
		s.refusals.refused("refused: %s", helloReason(err))
		return
	}
	if _, ok := s.names[name]; !ok {
		s.refusals.refused("refused: %s isn't on the list", name)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.connectBudget)
	up, err := s.connect(ctx, name)
	cancel()
	if err != nil {
		s.refusals.refused("can't reach %s: %v", name, err)
		return
	}
	defer up.Close()
	up.SetWriteDeadline(time.Now().Add(s.connectBudget))
	if _, err := up.Write(raw); err != nil {
		s.refusals.refused("can't reach %s: %v", name, err)
		return
	}
	up.SetWriteDeadline(time.Time{})
	raw = nil
	s.splice(c, up)
}

// helloReason is what a refusal says about a hello. Only fixed words, so nothing a client sent reaches the journal.
func helloReason(err error) string {
	switch {
	case errors.Is(err, errNoSNI):
		return "no SNI"
	case errors.Is(err, errECH):
		return "encrypted_client_hello"
	case errors.Is(err, errTooLong):
		return "hello too long"
	case errors.Is(err, errMalformed):
		return "malformed hello"
	case errors.Is(err, os.ErrDeadlineExceeded):
		return "no hello in time"
	}
	return "connection failed before the hello"
}

// connect resolves the name itself and ignores the address the client aimed at, so a client can't reach another site by
// aiming at its address while naming a listed host. IPv4, then IPv6 only if that didn't connect, each next address on
// failure. They're asked apart because a lookup of "ip" can't tell an IPv4 address from IPv4 inside IPv6: /etc/hosts gives
// Go's 16-byte form of plain IPv4. Asked for "ip4", it's IPv4 whichever form it comes in. Asked for "ip6", Go drops any answer
// holding IPv4, and providerAddress refuses any that gets through.
func (s *server) connect(ctx context.Context, name string) (*net.TCPConn, error) {
	d := net.Dialer{KeepAliveConfig: keepAlive, Timeout: s.dialTimeout, Control: boundControl(upstreamReadBuffer, upstreamWriteBuffer)}
	var last error
	refused, tried := false, 0
	for _, network := range []string{"ip4", "ip6"} {
		addrs, err := s.resolve(ctx, network, name)
		if err != nil {
			last = err
			continue
		}
		for _, a := range addrs {
			if network == "ip4" {
				a = a.Unmap()
			}
			if !s.allowAddr(a) {
				refused = true
				continue
			}
			if tried++; tried > maxAddressesTried {
				return nil, last
			}
			c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(a.String(), strconv.Itoa(s.upstreamPort)))
			if err == nil {
				return c.(*net.TCPConn), nil
			}
			last = err
		}
	}
	if tried == 0 && refused {
		return nil, errNoGlobalAddress
	}
	if last == nil {
		last = errNoGlobalAddress
	}
	return nil, last
}

// splice moves bytes both ways until both have ended, with no limit on how long that takes. A clean end of one direction
// passes on as a half-close, and the other keeps going for at most halfClosed, because a client that has gone looks the
// same until something is written back. An error on either side ends both. io.Copy between TCP conns uses splice(2).
func (s *server) splice(a, b *net.TCPConn) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.pass(a, b)
	}()
	s.pass(b, a)
	<-done
}

func (s *server) pass(dst, src *net.TCPConn) {
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		src.Close()
		return
	}
	dst.CloseWrite()
	dst.SetReadDeadline(time.Now().Add(s.halfClosed))
}

// bound sets a connection's receive and send buffers (the kernel doubles each), which also stops TCP growing them, so its
// memory is bounded whatever the far end does.
func bound(c *net.TCPConn, read, write int) error {
	if err := c.SetReadBuffer(read); err != nil {
		return err
	}
	return c.SetWriteBuffer(write)
}

// boundControl is bound for a dial, before it connects.
func boundControl(read, write int) func(network, address string, rc syscall.RawConn) error {
	return func(_, _ string, rc syscall.RawConn) error {
		var serr error
		if err := rc.Control(func(fd uintptr) {
			if serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, read); serr == nil {
				serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, write)
			}
		}); err != nil {
			return err
		}
		return serr
	}
}
