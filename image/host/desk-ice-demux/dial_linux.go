package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"syscall"
)

// slotAddr is slot k's desk-rtc as the host reaches it: the desk's end of the slot's veth, the ICE-TCP port (desk-host).
func slotAddr(k int) string { return net.JoinHostPort(fmt.Sprintf("10.98.%d.2", k), strconv.Itoa(443)) }

// transparentDial connects to slot k from the client's own address and port (IP_TRANSPARENT lets a socket bind an address
// that isn't the host's), so desk-rtc's accepted connection names the real client. If that port is busy (a TIME_WAIT of an
// earlier connection from the same address and port), any port of the client's address: the gate counts addresses.
func transparentDial(ctx context.Context, client *net.TCPAddr, k int) (net.Conn, error) {
	if client == nil || client.IP.To4() == nil {
		return nil, errors.New("not an IPv4 client")
	}
	try := func(port int) (net.Conn, error) {
		d := net.Dialer{
			LocalAddr: &net.TCPAddr{IP: client.IP.To4(), Port: port},
			Control: func(_, _ string, rc syscall.RawConn) error {
				var serr error
				if err := rc.Control(func(fd uintptr) {
					serr = syscall.SetsockoptInt(int(fd), syscall.SOL_IP, syscall.IP_TRANSPARENT, 1)
				}); err != nil {
					return err
				}

				return serr
			},
		}

		return d.DialContext(ctx, "tcp4", slotAddr(k))
	}
	c, err := try(client.Port)
	if err != nil && (errors.Is(err, syscall.EADDRINUSE) || errors.Is(err, syscall.EADDRNOTAVAIL)) {
		c, err = try(0)
	}

	return c, err
}
