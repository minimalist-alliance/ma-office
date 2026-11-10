package cdp

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Listener is who holds a loopback TCP port in LISTEN.
type Listener struct {
	UID  int
	IPv6 bool // on ::1, as Chromium does when something took 127.0.0.1's port first
}

// ListenerOn finds the LISTEN socket on 127.0.0.1:port or [::1]:port in /proc/net/tcp and tcp6, as deskd
// does before it trusts the debugging port (desk-runtime.md section 1).
func ListenerOn(port int) (Listener, bool, error) {
	for _, f := range []struct {
		name string
		v6   bool
	}{{"/proc/net/tcp", false}, {"/proc/net/tcp6", true}} {
		fh, err := os.Open(f.name)
		if err != nil {
			continue
		}
		uid, ok, err := findListener(fh, port, f.v6)
		_ = fh.Close()
		if err != nil {
			return Listener{}, false, err
		}
		if ok {
			return Listener{UID: uid, IPv6: f.v6}, true, nil
		}
	}

	return Listener{}, false, nil
}

const (
	loopback4   = "0100007F"
	loopback6   = "00000000000000000000000001000000"
	stateListen = "0A"
)

// findListener reads one /proc/net/tcp{,6} table.
func findListener(r io.Reader, port int, v6 bool) (int, bool, error) {
	want := fmt.Sprintf("%s:%04X", loopback4, port)
	if v6 {
		want = fmt.Sprintf("%s:%04X", loopback6, port)
	}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
		if len(f) < 8 || !strings.EqualFold(f[1], want) || f[3] != stateListen {
			continue
		}
		uid, err := strconv.Atoi(f[7])
		if err != nil {
			return 0, false, err
		}

		return uid, true, nil
	}

	return 0, false, sc.Err()
}
