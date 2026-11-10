package move

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/cdp"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/client"
	"github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/session"
)

// Systemctl runs systemctl directly, with no shell.
type Systemctl struct{}

func systemctl(args ...string) (string, error) {
	out, err := exec.Command("systemctl", args...).CombinedOutput()

	return strings.TrimSpace(string(out)), err
}

// Exists reports whether systemd knows the unit.
func (Systemctl) Exists(unit string) bool {
	out, err := systemctl("show", "-p", "LoadState", "--value", unit)

	return err == nil && out == "loaded"
}

// IsActive reports whether the unit is running.
func (Systemctl) IsActive(unit string) bool {
	_, err := systemctl("is-active", "--quiet", unit)

	return err == nil
}

// Stop stops units and waits for them.
func (Systemctl) Stop(units ...string) error {
	if out, err := systemctl(append([]string{"stop"}, units...)...); err != nil {
		return fmt.Errorf("%w: %s", err, out)
	}

	return nil
}

// Start starts a unit.
func (Systemctl) Start(unit string) error {
	if out, err := systemctl("start", unit); err != nil {
		return fmt.Errorf("%w: %s", err, out)
	}

	return nil
}

// Cat is systemctl cat.
func (Systemctl) Cat(unit string) (string, error) { return systemctl("cat", unit) }

// BrowserLaunch returns desk-browser's unit text and every script its ExecStart lines run, for the
// --password-store check.
func BrowserLaunch(sd Systemd) func() (string, error) {
	return func() (string, error) {
		unit, err := sd.Cat("desk-browser")
		if err != nil {
			return "", err
		}
		var b strings.Builder
		b.WriteString(unit)
		for _, line := range strings.Split(unit, "\n") {
			v, ok := strings.CutPrefix(strings.TrimSpace(line), "ExecStart=")
			if !ok {
				continue
			}
			fields := strings.Fields(v)
			if len(fields) == 0 {
				continue
			}
			cmd := strings.TrimLeft(fields[0], "@-:+!")
			if !strings.HasPrefix(cmd, "/") {
				continue
			}
			f, err := os.Open(cmd)
			if err != nil {
				continue
			}
			data, _ := io.ReadAll(io.LimitReader(f, 1<<20))
			_ = f.Close()
			if bytes.HasPrefix(data, []byte("\x7fELF")) {
				continue // Chromium itself, started with its flags on the ExecStart line
			}
			b.WriteString("\n")
			b.Write(data)
		}

		return b.String(), nil
	}
}

// ChromiumVersion reads the installed package's version, as desk-browser-start does, then falls back
// to chromium --version.
func ChromiumVersion() (string, error) {
	if out, err := exec.Command("dpkg-query", "-W", "-f=${Version}", "chromium").Output(); err == nil {
		if v := CleanChromiumVersion(string(out)); v != "" {
			return v, nil
		}
	}
	out, err := exec.Command("chromium", "--version").Output()
	if err != nil {
		return "", err
	}
	if v := CleanChromiumVersion(string(out)); v != "" {
		return v, nil
	}

	return "", errors.New("chromium --version printed no version")
}

// FreeBytes is what an unprivileged user could still write, which is what's safe to count on.
func FreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}

	return st.Bavail * uint64(st.Bsize), nil //nolint:gosec // Bsize is positive
}

// KioskUID is Chromium's user on every desk (desk-runtime.md section 1).
const KioskUID = 1102

// LocalCookies reads this desk's Chromium cookies as hashes. On a self-hosted desk only root and deskd may
// reach port 9222 (selfhost/files/etc/nftables.conf), so it reads them here, as root, and first makes sure
// the port is held by kiosk, as deskd does: anything else there isn't this desk's Browser.
func LocalCookies(ctx context.Context) ([]cdp.Item, error) {
	deadline := time.Now().Add(150 * time.Second)
	for {
		l, ok, err := cdp.ListenerOn(9222)
		if err != nil {
			return nil, err
		}
		if ok {
			if l.UID != KioskUID {
				return nil, fmt.Errorf("port 9222 is held by uid %d, not this desk's Browser", l.UID)
			}
			base := "http://127.0.0.1:9222"
			if l.IPv6 {
				base = "http://[::1]:9222"
			}

			return cdp.WaitAndRead(ctx, base, 30*time.Second)
		}
		if time.Now().After(deadline) {
			return nil, errors.New("this desk's Browser didn't open its debugging port")
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// PionDial opens sessions over WebRTC with one certificate for the whole move.
func PionDial(cert *webrtc.Certificate, transport string, log func(string, ...any)) DialFunc {
	return func(ctx context.Context, deskID string, connect client.ConnectFunc) (session.Transport, error) {
		return client.Dial(ctx, client.Options{Connect: connect, DeskID: deskID, Cert: cert, Transport: transport, Log: log})
	}
}
