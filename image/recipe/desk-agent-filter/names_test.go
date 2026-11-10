package main

import (
	"fmt"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestParseNames(t *testing.T) {
	var skipped []string
	got := parseNames(`# the providers
API.Anthropic.com
api.openai.com.   # a trailing dot is the same name
api.x.ai

*.wild.example.com
not a name
localhost
-bad.example.com
`, func(f string, a ...any) { skipped = append(skipped, f) })
	for _, want := range []string{"api.anthropic.com", "api.openai.com", "api.x.ai"} {
		if _, ok := got[want]; !ok {
			t.Errorf("%s isn't listed", want)
		}
	}
	if len(got) != 3 || len(skipped) != 4 {
		t.Errorf("got %v, skipped %d", got, len(skipped))
	}
}

func TestNamesMatchExactly(t *testing.T) {
	names := parseNames("api.openai.com\n", func(string, ...any) {})
	for name, want := range map[string]bool{
		"api.openai.com":          true,
		"openai.com":              false,
		"x.api.openai.com":        false,
		"api.openai.com.evil.com": false,
		"evil-api.openai.com":     false,
		"api.openai.co":           false,
		"xapi.openai.com":         false,
	} {
		if _, got := names[name]; got != want {
			t.Errorf("%s: %v", name, got)
		}
	}
}

func TestValidName(t *testing.T) {
	for name, want := range map[string]bool{
		"api.x.ai": true, "a-b.c1.io": true, "xn--bcher-kva.example": true, "1.2.3.4": true,
		"": false, "localhost": false, "api.x.ai.": false, ".api.x.ai": false, "api..x.ai": false, "-a.x.ai": false, "a-.x.ai": false,
		"API.x.ai": false, "a_b.x.ai": false, "api.x.ai\x00": false, "a b.x.ai": false, "é.x.ai": false, "*.x.ai": false,
		strings.Repeat("a", 64) + ".ai": false, strings.Repeat("a.", 127) + "ai": false,
	} {
		if got := validName(name); got != want {
			t.Errorf("%q: %v", name, got)
		}
	}
}

// The same rule as the Python provider_address this replaces (desk-agent-egress), and a little stricter on IPv6.
func TestProviderAddress(t *testing.T) {
	for addr, want := range map[string]bool{
		"162.159.140.245": true, "172.66.0.243": true, "8.8.8.8": true, "2606:4700::6810:84e5": true, "2600:1f18::1": true,
		"0.0.0.0": false, "10.1.2.3": false, "100.64.0.1": false, "127.0.0.1": false, "169.254.169.254": false, "169.254.169.253": false,
		"172.16.0.1": false, "172.31.255.255": false, "192.0.2.1": false, "192.168.1.1": false, "198.18.0.1": false, "198.51.100.1": false,
		"203.0.113.1": false, "224.0.0.1": false, "240.0.0.1": false, "255.255.255.255": false,
		"::": false, "::1": false, "fe80::1": false, "fc00::1": false, "fd00:ec2::254": false, "ff02::1": false,
		"2001:db8::1": false, "2001::1": false, "2002:a01:203::1": false, "3fff::1": false,
		// IPv4 inside IPv6: mapped, compatible, NAT64, Teredo, 6to4
		"::ffff:8.8.8.8": false, "::ffff:10.0.0.1": false, "::8.8.8.8": false, "64:ff9b::808:808": false, "64:ff9b::a00:1": false,
		"2001:0:4136:e378:8000:63bf:3fff:fdd2": false, "2002:808:808::1": false,
		"fe80::1%eth0": false,
	} {
		if got := providerAddress(netip.MustParseAddr(addr)); got != want {
			t.Errorf("%s: %v", addr, got)
		}
	}
}

func TestRefusalLogIsLimited(t *testing.T) {
	var lines []string
	now := time.Unix(1000, 0)
	l := &refusalLog{printf: func(f string, a ...any) { lines = append(lines, f) }, now: func() time.Time { return now }}
	for i := 0; i < 1000; i++ {
		l.refused("x")
	}
	if len(lines) != refusalsPerMinute {
		t.Fatalf("logged %d", len(lines))
	}
	now = now.Add(time.Minute)
	l.refused("x")
	if len(lines) != refusalsPerMinute+2 || !strings.Contains(lines[refusalsPerMinute], "not logged") {
		t.Fatalf("%v", lines[refusalsPerMinute:])
	}
}

func formatted(f string, a ...any) string { return fmt.Sprintf(f, a...) }
