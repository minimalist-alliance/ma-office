package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/move"
)

func TestTestSwitchIsOffUnlessSet(t *testing.T) {
	t.Setenv(testSwitch, "")
	env := move.Env{}
	on, err := testEnv(&env, t.TempDir())
	if on || err != nil || env.Systemd != nil {
		t.Fatalf("on=%v err=%v", on, err)
	}
}

func TestTestSwitchRefusesRootAndData(t *testing.T) {
	t.Setenv(testSwitch, "1")
	t.Setenv(testSwitch+"_DIR", t.TempDir())
	t.Setenv(testSwitch+"_CHROMIUM", "/bin/true")
	t.Setenv(testSwitch+"_CDP_PORT", "9")
	geteuid = func() int { return 0 }
	defer func() { geteuid = os.Geteuid }()
	if _, err := testEnv(&move.Env{}, t.TempDir()); err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("as root: %v", err)
	}
	geteuid = func() int { return 1000 }
	for _, root := range []string{"/data", "/data/", "/data/../data", ""} {
		if _, err := testEnv(&move.Env{}, root); err == nil {
			t.Fatalf("%q was taken", root)
		}
	}
}

func TestTestSwitchStandsInForSystemctlAndChown(t *testing.T) {
	dir := t.TempDir()
	units := filepath.Join(dir, "units")
	if err := os.MkdirAll(units, 0o700); err != nil {
		t.Fatal(err)
	}
	unit := "[Service]\nExecStart=/usr/bin/chromium --password-store=basic\n"
	must(t, os.WriteFile(filepath.Join(units, "desk-browser.service"), []byte(unit), 0o600))
	must(t, os.WriteFile(filepath.Join(units, "desk-browser.start"), []byte("#!/bin/sh\necho ran > \"$0.ran\"\n"), 0o700))
	t.Setenv(testSwitch, "1")
	t.Setenv(testSwitch+"_DIR", dir)
	t.Setenv(testSwitch+"_CHROMIUM", "/bin/true")
	t.Setenv(testSwitch+"_CDP_PORT", "9")
	geteuid = func() int { return 1000 }
	defer func() { geteuid = os.Geteuid }()
	env := move.Env{}
	on, err := testEnv(&env, t.TempDir())
	if !on || err != nil {
		t.Fatalf("on=%v err=%v", on, err)
	}
	if !env.Systemd.Exists("desk-browser") || env.Systemd.Exists("deskd") || env.Systemd.IsActive("desk-browser") {
		t.Fatal("units")
	}
	must(t, env.Systemd.Start("desk-browser"))
	if !env.Systemd.IsActive("desk-browser") {
		t.Fatal("not active after start")
	}
	if _, err := os.Stat(filepath.Join(units, "desk-browser.start.ran")); err != nil {
		t.Fatal("the start script didn't run")
	}
	must(t, env.Systemd.Stop("desk-browser", "deskd"))
	if env.Systemd.IsActive("desk-browser") {
		t.Fatal("active after stop")
	}
	text, err := env.BrowserLaunch()
	if err != nil || !strings.Contains(text, "--password-store=basic") {
		t.Fatalf("launch %q %v", text, err)
	}
	target := filepath.Join(dir, "x")
	must(t, os.WriteFile(target, nil, 0o600))
	must(t, env.Chown(target, 1102, 1102))
	if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o600 {
		t.Fatal("chown touched the file")
	}
	for name, want := range map[string]string{"systemctl.log": "start desk-browser\nstop desk-browser deskd\n", "chown.log": "1102:1102 " + target + "\n"} {
		b, _ := os.ReadFile(filepath.Join(dir, name))
		if string(b) != want {
			t.Fatalf("%s: %q", name, b)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
