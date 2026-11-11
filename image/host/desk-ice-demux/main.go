// Command desk-ice-demux is a shared desk host's TCP 443 under one public IPv4 for the whole host (the owner's choice B;
// ADR 0072 section 6 and its 2026-11-10 note; image/host/README.md, "One address per host"). Every slot's desk-rtc offers
// a passive ICE-TCP candidate on the host's address, port 443; this reads each connection's first RFC 4571 frame, a STUN
// binding request, takes the slot from the tag its USERNAME's ufrag starts with ("s<kk>", desk-rtc's rtcserver/shared.go),
// and hands the connection whole to that slot's desk-rtc on 10.98.<k>.2:443 with the client's own address and port as the
// source (IP_TRANSPARENT; desk-host's ruleset brings the replies back to this socket), so desk-rtc's gate counts the real
// client. Anything else closes at once; silence closes after 5 s (3 s under pressure); a slot with no running desk, or
// none at all, is refused. Places are counted per client network (gate.go). It runs in the host's own network namespace as
// its own user with CAP_NET_BIND_SERVICE and CAP_NET_RAW (for IP_TRANSPARENT) and nothing else, under systemd's sandbox and
// its own seccomp filter, which takes socket() for IPv4 TCP only (seccomp_linux.go), so the raw capability opens nothing.
// It logs no address.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
)

var version = "dev"

func main() {
	var (
		listen  = flag.String("listen", "", "the host's own private IPv4 and port 443, as ip:port (desk-host-boot writes it)")
		slots   = flag.Int("slots", 0, "the host's SlotsPerHost, 1 to 29")
		slotDir = flag.String("slot-dir", "/run/desk-dmx/slots", "where desk-host marks each running slot")
		showVer = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()
	if *showVer {
		fmt.Println(version)

		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *slots < 1 || *slots > 29 {
		log.Error("--slots: want 1 to 29", "slots", *slots)
		os.Exit(2)
	}
	ap, err := net.ResolveTCPAddr("tcp4", *listen)
	if err != nil || ap.IP.To4() == nil || ap.IP.IsUnspecified() || ap.IP.IsLoopback() {
		log.Error("--listen: want the host's own IPv4 address and port, never 0.0.0.0", "err", err)
		os.Exit(2)
	}
	if err := restrictSockets(); err != nil {
		log.Error("seccomp filter not installed: refusing to run", "err", err)
		os.Exit(1)
	}
	ln, err := net.ListenTCP("tcp4", ap)
	if err != nil {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	d := newDemux(*slots, *slotDir, transparentDial, limitsFor(*slots), log)
	log.Info("desk-ice-demux listening", "version", version, "port", ap.Port, "slots", *slots, "waitingPlaces", d.g.lim.total,
		"perNetwork", d.g.lim.perNet, "wait", d.g.lim.wait.String())
	if err := d.serve(ctx, ln); err != nil {
		log.Error("stopped", "err", err)
		os.Exit(1)
	}
}
