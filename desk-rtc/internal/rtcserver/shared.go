package rtcserver

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// A desk on a shared desk host with one public IPv4 for the whole host (the owner's choice B, ADR 0072 section 6 and its
// 2026-11-10 note; ma-platform contract shared-host.md, SlotMode=port). desk-host writes the slot's /etc/ma/desk-rtc.conf
// (cmd/desk-rtc/config.go) with:
//   - port=4430+k: the slot's own UDP port, which the host DNATs from its address to this desk unchanged;
//   - tcp_port=443: the passive ICE-TCP listener, which the host's demux (image/host/desk-ice-demux) reaches through the
//     slot's veth with the client's own address as the source, so the gate below (tcpgate.go) counts real clients;
//   - slot=k: every local ICE ufrag starts s<kk>, the tag the demux reads in a connection's first STUN request;
//   - public_ipv4: the host's public IPv4 from the host's IMDS at this start, which both candidates name.
// The answer then carries <host address> 4430+k udp and <host address> 443 tcp passive, still exactly two candidates.
// A desk of its own or a self-hosted one sets none of these, so nothing here changes for it.

// MaxSharedSlot is the highest slot a shared host has: UDP 4430+32 = 4462 is the top of the slots' port range.
const MaxSharedSlot = 32

// SlotUfragPrefix is the tag every local ufrag of slot k starts with: "s" and two digits, s01 to s32.
func SlotUfragPrefix(k int) string {
	if k < 1 || k > MaxSharedSlot {
		return ""
	}

	return fmt.Sprintf("s%02d", k)
}

// SlotOfUfrag is the slot a ufrag's tag names, or 0 when it has none (the demux's rule, kept here beside the prefix).
func SlotOfUfrag(ufrag string) int {
	if len(ufrag) < 4 || ufrag[0] != 's' || ufrag[1] < '0' || ufrag[1] > '9' || ufrag[2] < '0' || ufrag[2] > '9' {
		return 0
	}
	k, err := strconv.Atoi(ufrag[1:3])
	if err != nil || k < 1 || k > MaxSharedSlot {
		return 0
	}

	return k
}

func (s *Server) ufragPrefix() string { return SlotUfragPrefix(s.cfg.SharedSlot) }

func (s *Server) tcpPort() int {
	if s.cfg.TCPPort > 0 {
		return s.cfg.TCPPort
	}

	return s.cfg.Port
}

// TCPAddr describes where the passive ICE-TCP listener is.
func (s *Server) TCPAddr() string {
	return net.JoinHostPort(s.bindIP.String(), strconv.Itoa(s.tcpPort()))
}

// candidateIP is the address the answer's candidates name: the shared host's own (PublicIPv4) when desk-host set it,
// else configure's. A difference is logged once per configure: deskd's comes from the slot's metadata stand-in, which
// Platform's slot session fills, and the host's IMDS is what the client can actually reach.
func (s *Server) candidateIP(configured net.IP) string {
	if s.cfg.PublicIPv4 == "" {
		return configured.String()
	}
	if !strings.EqualFold(s.cfg.PublicIPv4, configured.String()) {
		s.log.Warn("configure's publicIpv4 isn't the shared host's address from desk-host; the candidates name the host's",
			"configured", configured.String(), "host", s.cfg.PublicIPv4)
	}

	return s.cfg.PublicIPv4
}

// validateShared checks the shared-host settings New is given.
func validateShared(cfg Config) error {
	if cfg.SharedSlot < 0 || cfg.SharedSlot > MaxSharedSlot {
		return fmt.Errorf("shared host slot %d: want 1 to %d, or 0 for a desk of its own", cfg.SharedSlot, MaxSharedSlot)
	}
	if cfg.TCPPort < 0 || cfg.TCPPort > 65535 {
		return fmt.Errorf("TCP port %d: want 1 to 65535, or 0 for the UDP port", cfg.TCPPort)
	}
	if cfg.PublicIPv4 != "" {
		if ip := net.ParseIP(cfg.PublicIPv4).To4(); ip == nil || ip.IsUnspecified() || ip.String() != cfg.PublicIPv4 {
			return fmt.Errorf("public IPv4 %q: want one IPv4 address", cfg.PublicIPv4)
		}
	}
	if (cfg.SharedSlot > 0) != (cfg.PublicIPv4 != "") {
		return fmt.Errorf("a shared host's slot and its public IPv4 go together (slot %d, public IPv4 %q)", cfg.SharedSlot, cfg.PublicIPv4)
	}

	return nil
}
