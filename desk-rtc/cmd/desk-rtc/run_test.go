package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"testing"
)

// standIn is set when this test binary runs as desk-rtc under release/run. It then prints the memory limit the Go
// runtime took from the environment, and its arguments, and exits.
const standIn = "DESK_RTC_RUN_STAND_IN"

// mainStandIn is set when this test binary runs as desk-rtc itself, for flags that exit at once (--print-port).
const mainStandIn = "DESK_RTC_MAIN_STAND_IN"

func TestMain(m *testing.M) {
	if os.Getenv(standIn) == "1" {
		fmt.Println(debug.SetMemoryLimit(-1))
		fmt.Println(strings.Join(os.Args[1:], " "))
		os.Exit(0)
	}
	if os.Getenv(mainStandIn) == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// release/run is what the unit starts. It sets a memory limit the Go runtime reads, under the unit's
// MemoryMax=128M, and passes the production flags.
func TestReleaseRunSetsTheMemoryLimit(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Symlink(self, filepath.Join(dir, "desk-rtc")); err != nil {
		t.Fatal(err)
	}
	run := func(env ...string) (string, string) {
		t.Helper()
		cmd := exec.Command("../../release/run")
		cmd.Env = append([]string{"RELEASE_DIR=" + dir, standIn + "=1", "PATH=" + os.Getenv("PATH")}, env...)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("run: %v", err)
		}
		limit, args, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")

		return limit, args
	}

	limit, args := run()
	if limit != strconv.Itoa(96<<20) {
		t.Fatalf("memory limit %s, want 96 MiB", limit)
	}
	if limit, _ := strconv.Atoi(limit); limit >= 128<<20 {
		t.Fatalf("memory limit %d isn't under MemoryMax", limit)
	}
	for _, want := range []string{"--socket /run/desk/rtc.sock", "--socket-group desk", "--display :99", "--config /etc/ma/desk-rtc.conf"} {
		if !strings.Contains(args, want) {
			t.Errorf("args %q lack %q", args, want)
		}
	}
	// The port comes from the desk's config, or desk-rtc's default 443: a --port here would win over the config.
	if strings.Contains(args, "--port") {
		t.Errorf("args %q pass --port, which would override the desk's config", args)
	}
	// The unit can set its own.
	if limit, _ := run("GOMEMLIMIT=64MiB"); limit != strconv.Itoa(64<<20) {
		t.Fatalf("memory limit %s with the unit's own, want 64 MiB", limit)
	}
}

// release/health checks the port desk-rtc says, from the same config run passes: 443 with no file, as on a cloud desk,
// or the file's. systemctl and ss are stand-ins that report desk-rtc active, holding UDP and TCP on HELD_PORT.
func TestReleaseHealthChecksTheConfiguredPort(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir, bin := t.TempDir(), t.TempDir()
	if err := os.Symlink(self, filepath.Join(dir, "desk-rtc")); err != nil {
		t.Fatal(err)
	}
	stubs := map[string]string{
		"systemctl": "#!/bin/sh\nexit 0\n",
		// ss -Hlnup 'sport = :<port>': a listener line only for the port the stand-in desk-rtc holds.
		"ss": "#!/bin/sh\n[ \"$2\" = \"sport = :$HELD_PORT\" ] && echo \"UNCONN 0 0 10.0.0.2:$HELD_PORT 0.0.0.0:* users:((\\\"desk-rtc\\\",pid=1,fd=3))\"\nexit 0\n",
	}
	for name, body := range stubs {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	confDir, n := t.TempDir(), 0
	conf := func(body string) string {
		n++
		p := filepath.Join(confDir, fmt.Sprintf("c%d.conf", n))
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}

		return p
	}
	health := func(confPath, held string) (bool, string) {
		t.Helper()
		cmd := exec.Command("../../release/health")
		cmd.Env = []string{"RELEASE_DIR=" + dir, mainStandIn + "=1", "PATH=" + bin + ":" + os.Getenv("PATH"),
			"DESK_RTC_CONF=" + confPath, "HELD_PORT=" + held}
		out, err := cmd.CombinedOutput()

		return err == nil, strings.TrimSpace(string(out))
	}
	absent := filepath.Join(confDir, "absent.conf")
	for _, c := range []struct {
		conf, held string
		ok         bool
		says       string
	}{
		{absent, "443", true, ""},
		{absent, "4443", false, "nothing holds UDP 443"},
		{conf("port=4443\n"), "4443", true, ""},
		{conf("port=4443\n"), "443", false, "nothing holds UDP 4443"},
		{conf("port=nope\n"), "443", false, `port "nope" isn't a port number`},
	} {
		ok, out := health(c.conf, c.held)
		if ok != c.ok || !strings.Contains(out, c.says) {
			t.Errorf("config %s, held %s: ok %v %q, want ok %v saying %q", filepath.Base(c.conf), c.held, ok, out, c.ok, c.says)
		}
	}
}
