package main

import (
	"net/netip"
	"strings"
)

// parseNames reads agent-egress.conf: one name a line, # starts a comment, lowercased, without a trailing dot. No
// wildcards: a line that isn't a plain host name is skipped, and logged.
func parseNames(text string, logf func(string, ...any)) map[string]struct{} {
	names := map[string]struct{}{}
	for _, line := range strings.Split(text, "\n") {
		name, _, _ := strings.Cut(line, "#")
		name = strings.TrimRight(strings.ToLower(strings.TrimSpace(name)), ".")
		if name == "" {
			continue
		}
		if !validName(name) {
			logf("skipping %q in the list: not a host name", name)
			continue
		}
		names[name] = struct{}{}
	}
	return names
}

// validName: lowercase ASCII letters, digits and inner hyphens, at least two labels of 1 to 63, 253 at most, no trailing
// dot. Whatever fails this is neither listed nor logged as a name.
func validName(name string) bool {
	if len(name) == 0 || len(name) > 253 {
		return false
	}
	labels := 1
	start := 0
	for i := 0; i <= len(name); i++ {
		if i == len(name) || name[i] == '.' {
			n := i - start
			if n == 0 || n > 63 || name[start] == '-' || name[i-1] == '-' {
				return false
			}
			if i < len(name) {
				labels++
			}
			start = i + 1
			continue
		}
		c := name[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return labels >= 2
}

func prefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(list))
	for i, p := range list {
		out[i] = netip.MustParsePrefix(p)
	}
	return out
}

var (
	notGlobal4 = prefixes("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
		"224.0.0.0/4", "240.0.0.0/4")
	global6    = netip.MustParsePrefix("2000::/3")
	notGlobal6 = prefixes("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20") // 2001::/32 is Teredo, 2002::/16 is 6to4
)

// providerAddress: an answer the filter may connect to, global unicast only, and never IPv4 inside IPv6. So an answer
// naming a private, loopback or link-local address opens nothing. IPv6 is allowed only inside 2000::/3, which leaves out
// ::ffff:0:0/96, ::/96, 64:ff9b::/96, fc00::/7, fe80::/10 and ff00::/8 with no list of them.
func providerAddress(a netip.Addr) bool {
	if a.Is4In6() || a.Zone() != "" {
		return false
	}
	if a.Is4() {
		return !inAny(notGlobal4, a)
	}
	return a.Is6() && global6.Contains(a) && !inAny(notGlobal6, a)
}

func inAny(list []netip.Prefix, a netip.Addr) bool {
	for _, p := range list {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
