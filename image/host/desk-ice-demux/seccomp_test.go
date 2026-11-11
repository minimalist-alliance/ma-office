package main

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
)

// The filter, in a child process (it can't be taken off again): IPv4 TCP sockets only.
func TestSocketFilter(t *testing.T) {
	if os.Getenv("DMX_SECCOMP_CHILD") == "1" {
		seccompChild()

		return
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self, "-test.run", "^TestSocketFilter$")
	cmd.Env = append(os.Environ(), "DMX_SECCOMP_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "FILTER OK") {
		t.Fatalf("child: %v\n%s", err, out)
	}
}

func seccompChild() {
	fail := func(msg string, a ...any) {
		os.Stdout.WriteString("FAIL " + msg + "\n")
		os.Exit(3)
	}
	// before the filter, a UDP socket opens
	if fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, 0); err != nil {
		fail("UDP before the filter")
	} else {
		_ = syscall.Close(fd)
	}
	if err := restrictSockets(); err != nil {
		fail("install: " + err.Error())
	}
	for _, c := range []struct {
		name               string
		family, typ, proto int
	}{
		{"UDP", syscall.AF_INET, syscall.SOCK_DGRAM, 0},
		{"raw", syscall.AF_INET, syscall.SOCK_RAW, syscall.IPPROTO_RAW},
		{"packet", syscall.AF_PACKET, syscall.SOCK_RAW, 0},
		{"IPv6 TCP", syscall.AF_INET6, syscall.SOCK_STREAM, 0},
		{"Unix", syscall.AF_UNIX, syscall.SOCK_STREAM, 0},
		{"netlink", syscall.AF_NETLINK, syscall.SOCK_RAW, 0},
		{"UDP, nonblocking", syscall.AF_INET, syscall.SOCK_DGRAM | syscall.SOCK_NONBLOCK | syscall.SOCK_CLOEXEC, 0},
	} {
		fd, err := syscall.Socket(c.family, c.typ, c.proto)
		if err == nil {
			_ = syscall.Close(fd)
			fail(c.name + " opened under the filter")
		}
		if !errors.Is(err, syscall.EPERM) {
			fail(c.name + ": " + err.Error())
		}
	}
	// TCP over IPv4, as the demux needs, from another goroutine (and so most likely another thread: TSYNC)
	done := make(chan error)
	go func() {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			done <- err

			return
		}
		c, err := net.Dial("tcp4", ln.Addr().String())
		if err == nil {
			_ = c.Close()
		}
		_ = ln.Close()
		done <- err
	}()
	if err := <-done; err != nil {
		fail("TCP: " + err.Error())
	}
	os.Stdout.WriteString("FILTER OK\n")
	os.Exit(0)
}
