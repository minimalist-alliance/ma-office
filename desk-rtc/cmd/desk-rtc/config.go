package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// The desk's settings for desk-rtc: release/run and release/health pass --config /etc/ma/desk-rtc.conf. A cloud desk
// has no such file, so it keeps every default (port 443). A self-hosted desk's installer writes port=4443 there,
// because Chrome drops a home-network ICE candidate on a port below 1024 (selfhost/README.md, "The port").
//
// The format is the one /etc/ma/selfhost.conf uses: one key=value per line, # starts a comment line, blank lines and
// spaces around the key and value are ignored. A key this version doesn't know is skipped with a warning, so a file
// written for a later desk-rtc doesn't stop this one after a rollback. A value it can't use is an error: desk-rtc refuses to start, and
// health fails, rather than listen somewhere the desk's firewall and its member don't expect.

// A shared desk host with one public IPv4 for the whole host (rtcserver/shared.go) adds three keys, which desk-host writes in
// the slot's own file: tcp_port (443: the passive ICE-TCP listener, when it isn't port's), slot (1 to 32: the local ICE
// ufrags start s<kk>) and public_ipv4 (the host's address, which the candidates name). slot and public_ipv4 go together.

// deskConfig is what the file set. A zero field means the file didn't set it.
type deskConfig struct {
	Port int
	// TCPPort is tcp_port: the passive ICE-TCP listener's port when it isn't Port's. 0 means Port.
	TCPPort int
	// Slot is slot: the shared host's slot this desk runs on, 1 to 32. 0 means a desk of its own.
	Slot int
	// PublicIPv4 is public_ipv4: the shared host's own public address, which the candidates name in place of configure's.
	PublicIPv4 string
	// GuildMaxSessions is guild_max_sessions: the most sessions a Guild Desk takes at once (rtcserver/guild.go), 1 to
	// 10000. Only a Guild Desk reads it, and it's only needed to go past maxGuildMembers x 3 (600).
	GuildMaxSessions int
	Unknown          []string // keys this version doesn't know, in file order
}

var (
	portValue  = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
	countValue = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
	slotValue  = regexp.MustCompile(`^[1-9][0-9]?$`)
	ipv4Value  = regexp.MustCompile(`^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$`)
)

// maxSlot is the highest slot of a shared host (UDP 4430+32 = 4462), as rtcserver.MaxSharedSlot.
const maxSlot = 32

// maxGuildSessionsSetting bounds guild_max_sessions: well past 200 members' 600, and short of what one process can hold.
const maxGuildSessionsSetting = 10000

// loadConfig reads path. An empty path, or no file there, gives an empty config: every flag keeps its default.
func loadConfig(path string) (deskConfig, error) {
	if path == "" {
		return deskConfig{}, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return deskConfig{}, nil
	}
	if err != nil {
		return deskConfig{}, err
	}
	defer f.Close()

	return parseConfig(f, path)
}

func parseConfig(r io.Reader, name string) (deskConfig, error) {
	var c deskConfig
	seen := map[string]bool{}
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if !ok || k == "" {
			return deskConfig{}, fmt.Errorf("%s line %d: want key=value", name, n)
		}
		if seen[k] {
			return deskConfig{}, fmt.Errorf("%s line %d: %s is set twice", name, n, k)
		}
		seen[k] = true
		switch k {
		case "port":
			p, err := strconv.Atoi(v)
			if !portValue.MatchString(v) || err != nil || p > 65535 {
				return deskConfig{}, fmt.Errorf("%s line %d: port %q isn't a port number (1 to 65535)", name, n, v)
			}
			c.Port = p
		case "tcp_port":
			p, err := strconv.Atoi(v)
			if !portValue.MatchString(v) || err != nil || p > 65535 {
				return deskConfig{}, fmt.Errorf("%s line %d: tcp_port %q isn't a port number (1 to 65535)", name, n, v)
			}
			c.TCPPort = p
		case "slot":
			k, err := strconv.Atoi(v)
			if !slotValue.MatchString(v) || err != nil || k > maxSlot {
				return deskConfig{}, fmt.Errorf("%s line %d: slot %q isn't a shared host's slot (1 to %d)", name, n, v, maxSlot)
			}
			c.Slot = k
		case "public_ipv4":
			if !ipv4Value.MatchString(v) || v == "0.0.0.0" {
				return deskConfig{}, fmt.Errorf("%s line %d: public_ipv4 %q isn't an IPv4 address", name, n, v)
			}
			c.PublicIPv4 = v
		case "guild_max_sessions":
			g, err := strconv.Atoi(v)
			if !countValue.MatchString(v) || err != nil || g > maxGuildSessionsSetting {
				return deskConfig{}, fmt.Errorf("%s line %d: guild_max_sessions %q isn't a count (1 to %d)", name, n, v, maxGuildSessionsSetting)
			}
			c.GuildMaxSessions = g
		default:
			c.Unknown = append(c.Unknown, k)
		}
	}
	if err := sc.Err(); err != nil {
		return deskConfig{}, fmt.Errorf("%s: %w", name, err)
	}
	if (c.Slot > 0) != (c.PublicIPv4 != "") {
		return deskConfig{}, fmt.Errorf("%s: slot and public_ipv4 go together (a shared host's slot names both)", name)
	}

	return c, nil
}

// effectiveTCPPort is the passive ICE-TCP listener's port: --tcp-port when given, else the file's tcp_port, else the
// UDP port (every desk but a shared host's slot).
func effectiveTCPPort(flagPort int, flagGiven bool, c deskConfig, udpPort int) int {
	if flagGiven && flagPort > 0 {
		return flagPort
	}
	if c.TCPPort > 0 {
		return c.TCPPort
	}

	return udpPort
}

// effectiveGuildMaxSessions is --guild-max-sessions when it was given, else the file's; 0 means rtcserver's default.
func effectiveGuildMaxSessions(flagValue int, flagGiven bool, c deskConfig) int {
	if flagGiven {
		return flagValue
	}

	return c.GuildMaxSessions
}

// effectivePort is the port desk-rtc listens on: --port when it was given on the command line, else the file's, else
// the flag's default (443).
func effectivePort(flagPort int, flagGiven bool, c deskConfig) int {
	if flagGiven || c.Port == 0 {
		return flagPort
	}

	return c.Port
}
