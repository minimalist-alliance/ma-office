package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A shared host's slot (rtcserver/shared.go): desk-host writes port, tcp_port, slot and public_ipv4 in the slot's own file.
const sharedConf = "# desk-host, slot 4 of a shared host (SlotMode=port)\nport=4434\ntcp_port=443\nslot=4\npublic_ipv4=203.0.113.9\n"

func TestConfigReadsASharedSlot(t *testing.T) {
	c, err := loadConfig(writeConf(t, sharedConf))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 4434 || c.TCPPort != 443 || c.Slot != 4 || c.PublicIPv4 != "203.0.113.9" || len(c.Unknown) != 0 {
		t.Fatalf("config %+v", c)
	}
	if p := effectiveTCPPort(0, false, c, 4434); p != 443 {
		t.Fatalf("TCP port %d, want 443", p)
	}
	if p := effectiveTCPPort(5000, true, c, 4434); p != 5000 {
		t.Fatalf("--tcp-port didn't win: %d", p)
	}
	if p := effectiveTCPPort(0, false, deskConfig{Port: 4443}, 4443); p != 4443 {
		t.Fatalf("a self-hosted desk's TCP port %d, want its port", p)
	}
}

func TestBadSharedConfigsAreRefused(t *testing.T) {
	for body, says := range map[string]string{
		"slot=4\n":                                  "slot and public_ipv4 go together",
		"public_ipv4=203.0.113.9\n":                 "slot and public_ipv4 go together",
		"slot=0\npublic_ipv4=203.0.113.9\n":         `slot "0" isn't`,
		"slot=33\npublic_ipv4=203.0.113.9\n":        `slot "33" isn't`,
		"slot=04\npublic_ipv4=203.0.113.9\n":        `slot "04" isn't`,
		"slot=4\npublic_ipv4=203.0.113.09\n":        `public_ipv4 "203.0.113.09" isn't`,
		"slot=4\npublic_ipv4=0.0.0.0\n":             `public_ipv4 "0.0.0.0" isn't`,
		"slot=4\npublic_ipv4=2001:db8::1\n":         `public_ipv4 "2001:db8::1" isn't`,
		"tcp_port=0\n":                              `tcp_port "0" isn't`,
		"tcp_port=65536\n":                          `tcp_port "65536" isn't`,
		"slot=4\nslot=5\npublic_ipv4=203.0.113.9\n": "slot is set twice",
	} {
		_, err := loadConfig(writeConf(t, body))
		if err == nil || !strings.Contains(err.Error(), says) {
			t.Errorf("%q: err %v, want %q", body, err, says)
		}
	}
}

// release/health asks for both ports: UDP on the slot's, TCP on 443.
func TestPrintTCPPort(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shared := writeConf(t, sharedConf)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--print-tcp-port"}, "443"},
		{[]string{"--config", writeConf(t, "port=4443\n"), "--print-tcp-port"}, "4443"},
		{[]string{"--config", shared, "--print-tcp-port"}, "443"},
		{[]string{"--config", shared, "--print-port"}, "4434"},
		{[]string{"--config", shared, "--tcp-port", "8443", "--print-tcp-port"}, "8443"},
	} {
		cmd := exec.Command(self, c.args...)
		cmd.Env = append(os.Environ(), mainStandIn+"=1")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		if got := strings.TrimSpace(string(out)); got != c.want {
			t.Fatalf("%v: printed %q, want %q", c.args, got, c.want)
		}
	}
}

func TestReleaseHealthChecksBothPortsOfASharedSlot(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir, bin := t.TempDir(), t.TempDir()
	if err := os.Symlink(self, filepath.Join(dir, "desk-rtc")); err != nil {
		t.Fatal(err)
	}
	// ss -Hlnup / -Hlntp 'sport = :<port>': a listener line only for the port the stand-in holds on that protocol.
	ss := "#!/bin/sh\nif [ \"$1\" = -Hlnup ]; then p=$HELD_UDP; else p=$HELD_TCP; fi\n" +
		"[ \"$2\" = \"sport = :$p\" ] && echo \"X 0 0 10.98.4.2:$p 0.0.0.0:* users:((\\\"desk-rtc\\\",pid=1,fd=3))\"\nexit 0\n"
	for name, body := range map[string]string{"systemctl": "#!/bin/sh\nexit 0\n", "ss": ss} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	conf := writeConf(t, sharedConf)
	for _, c := range []struct {
		udp, tcp string
		ok       bool
		says     string
	}{
		{"4434", "443", true, ""},
		{"4434", "4434", false, "nothing holds TCP 443"},
		{"443", "443", false, "nothing holds UDP 4434"},
	} {
		cmd := exec.Command("../../release/health")
		cmd.Env = []string{"RELEASE_DIR=" + dir, mainStandIn + "=1", "PATH=" + bin + ":" + os.Getenv("PATH"),
			"DESK_RTC_CONF=" + conf, "HELD_UDP=" + c.udp, "HELD_TCP=" + c.tcp}
		out, err := cmd.CombinedOutput()
		if (err == nil) != c.ok || !strings.Contains(string(out), c.says) {
			t.Errorf("UDP %s, TCP %s held: ok %v %q, want ok %v saying %q", c.udp, c.tcp, err == nil, out, c.ok, c.says)
		}
	}
}
