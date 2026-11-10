package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeConf(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "desk-rtc.conf")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	return p
}

// A cloud desk has no /etc/ma/desk-rtc.conf: it keeps port 443, as before the setting existed.
func TestNoConfigKeepsTheDefaults(t *testing.T) {
	for _, path := range []string{"", filepath.Join(t.TempDir(), "absent.conf")} {
		c, err := loadConfig(path)
		if err != nil {
			t.Fatalf("%q: %v", path, err)
		}
		if !reflect.DeepEqual(c, deskConfig{}) {
			t.Fatalf("%q: config %+v, want empty", path, c)
		}
		if p := effectivePort(443, false, c); p != 443 {
			t.Fatalf("%q: port %d, want 443", path, p)
		}
	}
}

func TestConfigSetsThePort(t *testing.T) {
	for _, body := range []string{
		"port=4443\n",
		"port=4443",
		"# written by install.sh\n\n  port = 4443  \n",
		"port=4443\r\n",
	} {
		c, err := loadConfig(writeConf(t, body))
		if err != nil {
			t.Fatalf("%q: %v", body, err)
		}
		if c.Port != 4443 || len(c.Unknown) != 0 {
			t.Fatalf("%q: config %+v, want port 4443", body, c)
		}
		if p := effectivePort(443, false, c); p != 4443 {
			t.Fatalf("%q: port %d, want 4443", body, p)
		}
	}
}

// --port on the command line wins over the file, as a dev run or a unit's own flag expects.
func TestThePortFlagWins(t *testing.T) {
	c := deskConfig{Port: 4443}
	if p := effectivePort(5000, true, c); p != 5000 {
		t.Fatalf("port %d, want the flag's 5000", p)
	}
	if p := effectivePort(443, true, c); p != 443 {
		t.Fatalf("port %d, want the flag's 443 even when it's the default value", p)
	}
}

func TestAFileWithoutAPortKeepsTheDefault(t *testing.T) {
	c, err := loadConfig(writeConf(t, "# nothing here yet\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if p := effectivePort(443, false, c); p != 443 {
		t.Fatalf("port %d, want 443", p)
	}
}

// A key from a later desk-rtc is skipped, so a rollback still starts.
func TestUnknownKeysAreSkipped(t *testing.T) {
	c, err := loadConfig(writeConf(t, "candidates=home,vpn\nport=4443\nfuture = x\n"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 4443 || !reflect.DeepEqual(c.Unknown, []string{"candidates", "future"}) {
		t.Fatalf("config %+v", c)
	}
}

func TestBadConfigsAreRefused(t *testing.T) {
	for body, want := range map[string]string{
		"port=":             `port "" isn't a port number`,
		"port=0":            `port "0" isn't a port number`,
		"port=65536":        `port "65536" isn't a port number`,
		"port=99999":        `port "99999" isn't a port number`,
		"port=abc":          `port "abc" isn't a port number`,
		"port=+443":         `port "+443" isn't a port number`,
		"port=-1":           `port "-1" isn't a port number`,
		"port=0443":         `port "0443" isn't a port number`,
		"port=44 3":         `port "44 3" isn't a port number`,
		"port=4443 # home":  `port "4443 # home" isn't a port number`,
		"port":              "line 1: want key=value",
		"# ok\n=4443":       "line 2: want key=value",
		"port=4443\nport=5": "line 2: port is set twice",
	} {
		_, err := loadConfig(writeConf(t, body))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: error %v, want %q", body, err, want)
		}
	}
}

// A file that's there but can't be read is an error, not the defaults: a self-hosted desk would otherwise listen on
// 443, where its firewall is closed and Chrome won't connect.
func TestAnUnreadableConfigIsAnError(t *testing.T) {
	if _, err := loadConfig(t.TempDir()); err == nil {
		t.Fatal("a directory read as the config gave no error")
	}
}

// release/health asks desk-rtc for the port, so it checks the one run listens on.
func TestPrintPort(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	conf := writeConf(t, "port=4443\n")
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--config", filepath.Join(t.TempDir(), "absent.conf"), "--print-port"}, "443"},
		{[]string{"--print-port"}, "443"},
		{[]string{"--config", conf, "--print-port"}, "4443"},
		{[]string{"--config", conf, "--port", "5000", "--print-port"}, "5000"},
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
	cmd := exec.Command(self, "--config", writeConf(t, "port=http\n"), "--print-port")
	cmd.Env = append(os.Environ(), mainStandIn+"=1")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), `port "http" isn't a port number`) {
		t.Fatalf("a bad config: err %v, output %q", err, out)
	}
}

// guild_max_sessions is a Guild Desk's ceiling on sessions at once (rtcserver/guild.go). Other desks never read it.
func TestConfigSetsTheGuildCeiling(t *testing.T) {
	c, err := loadConfig(writeConf(t, "port=4443\nguild_max_sessions = 900\n"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 4443 || c.GuildMaxSessions != 900 || len(c.Unknown) != 0 {
		t.Fatalf("config %+v", c)
	}
	if g := effectiveGuildMaxSessions(0, false, c); g != 900 {
		t.Fatalf("ceiling %d, want the file's 900", g)
	}
	if g := effectiveGuildMaxSessions(300, true, c); g != 300 {
		t.Fatalf("ceiling %d, want the flag's 300", g)
	}
	if g := effectiveGuildMaxSessions(0, false, deskConfig{}); g != 0 {
		t.Fatalf("ceiling %d, want 0 (rtcserver's 600)", g)
	}
	for _, bad := range []string{"0", "-1", "10001", "1e3", "600.0", "six hundred", "", "0600"} {
		if _, err := loadConfig(writeConf(t, "guild_max_sessions="+bad+"\n")); err == nil || !strings.Contains(err.Error(), "guild_max_sessions") {
			t.Fatalf("%q: err %v", bad, err)
		}
	}
}
