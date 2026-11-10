package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/cdp"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/move"
)

// The rehearsal's switch (tools/desk-move/rehearsal): MA_DESK_MOVE_TEST=1 runs the whole move as an ordinary
// user against a temporary --data-root, with systemctl, chown, the Chromium version and this desk's cookies
// stood in for. It's refused as root and on /data, so it can never change a real desk.
//
//	MA_DESK_MOVE_TEST_DIR       units/<unit>.service is what `systemctl cat` gives, and a unit exists if it's
//	                            there; units/<unit>.start and .stop run, if there, on start and stop. Every
//	                            systemctl call and every chown it would have made go to systemctl.log and chown.log
//	MA_DESK_MOVE_TEST_CHROMIUM  the Chromium whose --version is this desk's
//	MA_DESK_MOVE_TEST_CDP_PORT  this desk's Chromium's debugging port, which must be held by this user
const testSwitch = "MA_DESK_MOVE_TEST"

var geteuid = os.Geteuid

// testEnv swaps the privileged parts of env for the rehearsal's. ok is false when the switch is off.
func testEnv(env *move.Env, dataRoot string) (ok bool, err error) {
	if os.Getenv(testSwitch) != "1" {
		return false, nil
	}
	if geteuid() == 0 {
		return true, errors.New(testSwitch + " is refused as root: it's for an ordinary user and a temporary --data-root")
	}
	if root, _ := filepath.Abs(dataRoot); root == "/data" || dataRoot == "" {
		return true, errors.New(testSwitch + " needs a temporary --data-root, never /data")
	}
	dir := os.Getenv(testSwitch + "_DIR")
	chromium := os.Getenv(testSwitch + "_CHROMIUM")
	port, perr := strconv.Atoi(os.Getenv(testSwitch + "_CDP_PORT"))
	if dir == "" || chromium == "" || perr != nil || port <= 0 || port > 65535 {
		return true, errors.New(testSwitch + " needs " + testSwitch + "_DIR, _CHROMIUM and _CDP_PORT")
	}
	sd := &testSystemd{dir: dir}
	env.Systemd = sd
	env.SignClaim = nil // the rehearsal's target tree has no desk key, and its stand-in platform checks none
	env.BrowserLaunch = move.BrowserLaunch(sd)
	env.Chown = func(name string, uid, gid int) error {
		return appendLine(filepath.Join(dir, "chown.log"), fmt.Sprintf("%d:%d %s", uid, gid, name))
	}
	env.ChromiumVersion = func() (string, error) {
		out, err := exec.Command(chromium, "--version").Output()
		if err != nil {
			return "", err
		}

		return move.CleanChromiumVersion(string(out)), nil
	}
	env.LocalCookies = func(ctx context.Context) ([]cdp.Item, error) { return testCookies(ctx, port) }

	return true, nil
}

// testCookies is move.LocalCookies with this user in kiosk's place and the rehearsal's port in 9222's.
func testCookies(ctx context.Context, port int) ([]cdp.Item, error) {
	deadline := time.Now().Add(150 * time.Second)
	for {
		l, ok, err := cdp.ListenerOn(port)
		if err != nil {
			return nil, err
		}
		if ok {
			if l.UID != os.Getuid() {
				return nil, fmt.Errorf("port %d is held by uid %d, not this user", port, l.UID)
			}

			return cdp.WaitAndRead(ctx, fmt.Sprintf("http://127.0.0.1:%d", port), 30*time.Second)
		}
		if time.Now().After(deadline) {
			return nil, errors.New("the rehearsal's Chromium didn't open its debugging port")
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// testSystemd stands in for systemctl: unit files in a directory, start and stop scripts, and a log.
type testSystemd struct {
	dir string
	mu  sync.Mutex
}

func (s *testSystemd) unit(name, ext string) string { return filepath.Join(s.dir, "units", name+ext) }

func (s *testSystemd) log(line string) { _ = appendLine(filepath.Join(s.dir, "systemctl.log"), line) }

func (s *testSystemd) Exists(unit string) bool {
	_, err := os.Stat(s.unit(unit, ".service"))

	return err == nil
}

func (s *testSystemd) IsActive(unit string) bool {
	_, err := os.Stat(s.unit(unit, ".active"))

	return err == nil
}

func (s *testSystemd) run(verb, unit string) error {
	script := s.unit(unit, "."+verb)
	if _, err := os.Stat(script); err == nil {
		if out, err := exec.Command(script).CombinedOutput(); err != nil {
			return fmt.Errorf("%s %s: %w: %s", verb, unit, err, strings.TrimSpace(string(out)))
		}
	}
	if verb == "start" {
		return os.WriteFile(s.unit(unit, ".active"), nil, 0o600)
	}
	if err := os.Remove(s.unit(unit, ".active")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	return nil
}

func (s *testSystemd) Stop(units ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log("stop " + strings.Join(units, " "))
	var errs []error
	for _, u := range units {
		errs = append(errs, s.run("stop", u))
	}

	return errors.Join(errs...)
}

func (s *testSystemd) Start(unit string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log("start " + unit)

	return s.run("start", unit)
}

func (s *testSystemd) Cat(unit string) (string, error) {
	b, err := os.ReadFile(s.unit(unit, ".service"))

	return string(b), err
}

func appendLine(name, line string) error {
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(f, line)
	if cerr := f.Close(); err == nil {
		err = cerr
	}

	return err
}
