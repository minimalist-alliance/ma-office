// Package e2e runs the real binaries on loopback: gateway-shim, desk-rtc, fake-deskd, and a Pion client
// (deskctl, or the same client code in process).
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/client"
	"github.com/minimalist-alliance/ma-desk/desk-rtc/internal/testrelay"
)

const deskID = "d-dev0000000000"

var binDir string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "drtc-bin")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	binDir = dir
	for _, c := range []string{"desk-rtc", "gateway-shim", "fake-deskd", "deskctl"} {
		cmd := exec.Command("go", "build", "-p", "1", "-o", filepath.Join(dir, c), "github.com/minimalist-alliance/ma-desk/desk-rtc/cmd/"+c)
		if out, err := cmd.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "build %s: %v\n%s\n", c, err, out)
			os.Exit(1)
		}
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

type stack struct {
	t       *testing.T
	api     string
	gateway string
	rtcPort int
	logs    map[string]*lockedBuffer
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.b.String()
}

func freePort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		l, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := l.Addr().(*net.TCPAddr).Port
		_ = l.Close()
		u, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
		if err == nil {
			_ = u.Close()

			return port
		}
	}
	t.Fatal("no free port")

	return 0
}

func (s *stack) start(name string, args ...string) *exec.Cmd {
	s.t.Helper()
	log := &lockedBuffer{}
	s.logs[name] = log
	cmd := exec.Command(filepath.Join(binDir, name), args...)
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
		}
	})

	return cmd
}

type stackOpts struct {
	shimArgs  []string
	rtcArgs   []string
	deskdArgs []string
}

func startStack(t *testing.T, opts stackOpts) *stack {
	t.Helper()
	dir, err := os.MkdirTemp("", "drtc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	apiPort, rtcPort := freePort(t), freePort(t)
	s := &stack{
		t:       t,
		api:     "http://127.0.0.1:" + strconv.Itoa(apiPort),
		gateway: "ws://127.0.0.1:" + strconv.Itoa(apiPort) + "/v1",
		rtcPort: rtcPort,
		logs:    map[string]*lockedBuffer{},
	}
	sock := filepath.Join(dir, "rtc.sock")
	s.start("gateway-shim", append([]string{"--addr", "127.0.0.1:" + strconv.Itoa(apiPort)}, opts.shimArgs...)...)
	s.start("desk-rtc", append([]string{"--socket", sock, "--data-dir", filepath.Join(dir, "rtc"), "--bind", "127.0.0.1", "--port", strconv.Itoa(rtcPort)}, opts.rtcArgs...)...)
	s.start("fake-deskd", append([]string{"--rtc-sock", sock, "--api", s.api, "--public-ip", "127.0.0.1"}, opts.deskdArgs...)...)
	t.Cleanup(func() {
		if t.Failed() {
			for name, l := range s.logs {
				t.Logf("--- %s ---\n%s", name, l.String())
			}
		}
	})

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st := s.state(); st.Ready {
			return s
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the desk never reached ready")

	return nil
}

type devState struct {
	Ready    bool     `json:"ready"`
	Sessions []string `json:"sessions"`
}

func (s *stack) state() devState {
	var st devState
	resp, err := http.Get(s.api + "/dev/state")
	if err != nil {
		return st
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(&st)

	return st
}

func (s *stack) waitSessions(t *testing.T, n int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(s.state().Sessions) == n {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("want %d open sessions, have %v", n, s.state().Sessions)
}

func (s *stack) deskctl(args ...string) (string, string, error) {
	cmd := exec.Command(filepath.Join(binDir, "deskctl"), append([]string{"status", "--gateway", s.gateway, "--timeout", "15s"}, args...)...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()

	return out.String(), errOut.String(), err
}

func (s *stack) dial(t *testing.T, mod func(*client.Options)) *client.Conn {
	t.Helper()
	opts := client.Options{API: s.api, Gateway: s.gateway, DeskID: deskID, Transport: "udp", Log: t.Logf}
	if mod != nil {
		mod(&opts)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, err := client.Dial(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)

	return c
}

func callOK(t *testing.T, c *client.Conn, method string, params any) json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := c.Call(ctx, method, params)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}

	return out
}

func TestDeskctlStatus(t *testing.T) {
	s := startStack(t, stackOpts{})
	for _, transport := range []string{"udp", "tcp", "any"} {
		t.Run(transport, func(t *testing.T) {
			stdout, stderr, err := s.deskctl("--transport", transport, "--json")
			if err != nil {
				t.Fatalf("deskctl: %v\n%s", err, stderr)
			}
			var out struct {
				Status struct {
					DeskID       string `json:"deskId"`
					DeskdVersion string `json:"deskdVersion"`
					RTCVersion   string `json:"rtcVersion"`
					BootID       string `json:"bootId"`
					InstanceType string `json:"instanceType"`
				} `json:"status"`
				Transport string  `json:"transport"`
				RTTMs     float64 `json:"rttMs"`
			}
			if err := json.Unmarshal([]byte(stdout), &out); err != nil {
				t.Fatalf("%v\n%s", err, stdout)
			}
			if out.Status.DeskID != deskID || out.Status.DeskdVersion != "fake-deskd" || out.Status.RTCVersion == "" || out.Status.BootID == "" {
				t.Fatalf("status %+v", out.Status)
			}
			want := transport
			if want == "any" {
				want = "udp" // ICE prefers the direct UDP path
			}
			if out.Transport != want {
				t.Fatalf("transport %q, want %q", out.Transport, want)
			}
			if out.RTTMs <= 0 {
				t.Fatalf("rtt %v", out.RTTMs)
			}
			t.Logf("transport=%s rtt=%.2fms", out.Transport, out.RTTMs)
		})
	}
	s.waitSessions(t, 0, 5*time.Second)
}

func TestWrongFingerprintInTheToken(t *testing.T) {
	s := startStack(t, stackOpts{})
	_, stderr, err := s.deskctl("--bad-cnf")
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() == 0 {
		t.Fatalf("want a non-zero exit, got %v", err)
	}
	if !strings.Contains(stderr, "identity_mismatch") {
		t.Fatalf("stderr: %s", stderr)
	}
	s.waitSessions(t, 0, 5*time.Second)
}

// The offer repeats the token's fingerprint, so the SDP check passes, but the client's DTLS certificate
// is a different one. Only the DTLS handshake can catch this.
func TestWrongCertificateInDTLS(t *testing.T) {
	s := startStack(t, stackOpts{})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err := client.Dial(ctx, client.Options{
		API: s.api, Gateway: s.gateway, DeskID: deskID, Transport: "udp", BadCnf: true, LieInOffer: true, Log: t.Logf,
	})
	var refused *client.RefusedError
	if !errors.As(err, &refused) || refused.Code != "identity_mismatch" {
		t.Fatalf("want identity_mismatch, got %v", err)
	}
	s.waitSessions(t, 0, 5*time.Second)
}

func TestNoH264StillConnects(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := s.dial(t, func(o *client.Options) { o.VP8Only = true })
	callOK(t, c, "desk.status.get", nil)
}

func TestICERestartKeepsTheChannels(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := s.dial(t, nil)
	callOK(t, c, "desk.status.get", nil)
	before := c.LastAnswer()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := c.RestartICE(ctx); err != nil {
		t.Fatal(err)
	}
	if ufrag(before) == ufrag(c.LastAnswer()) {
		t.Fatal("the answer to an ICE restart must carry new credentials")
	}
	// Traffic keeps flowing on the same PeerConnection through the restart.
	time.Sleep(time.Second)
	callOK(t, c, "desk.status.get", nil)
	if st := c.ConnectionState(); st != webrtc.PeerConnectionStateConnected {
		t.Fatalf("connection %s", st)
	}
}

func ufrag(sdp string) string {
	for _, l := range strings.Split(sdp, "\r\n") {
		if v, ok := strings.CutPrefix(l, "a=ice-ufrag:"); ok {
			return v
		}
	}

	return ""
}

func TestStatsOverRPC(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := s.dial(t, nil)
	if err := c.SendInput(6, []byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := c.SendInput(7, []byte{1}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	var st struct {
		Sessions []struct {
			SessionID    string  `json:"sessionId"`
			Transport    string  `json:"transport"`
			RTTMs        float64 `json:"rttMs"`
			BytesSent    uint64  `json:"bytesSent"`
			InputDropped uint64  `json:"inputDropped"`
			KeysDropped  uint64  `json:"keysDropped"`
		} `json:"sessions"`
		PeerBytesSent *uint64 `json:"peerBytesSent"`
	}
	if err := json.Unmarshal(callOK(t, c, "test.rtc.stats", nil), &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Sessions) != 1 || st.Sessions[0].SessionID != c.SessionID || st.Sessions[0].Transport != "udp" ||
		st.Sessions[0].BytesSent == 0 || st.Sessions[0].RTTMs <= 0 || st.PeerBytesSent == nil {
		t.Fatalf("stats %+v", st)
	}
	if st.Sessions[0].InputDropped != 1 || st.Sessions[0].KeysDropped != 1 {
		t.Fatalf("channels 6 and 7 not counted: %+v", st.Sessions[0])
	}
}

// A live PeerConnection must outlive the gateway's connection limit (contract 0.3.3): both sides get
// 1001, reconnect, send ready and session.resume, and the data path never notices.
func TestPeerConnectionSurvivesGatewayMaxAge(t *testing.T) {
	s := startStack(t, stackOpts{shimArgs: []string{"--max-conn-age", "2s"}})
	c := s.dial(t, func(o *client.Options) { o.ResumeGateway = true })
	first := c.SessionID

	end := time.Now().Add(7 * time.Second)
	var calls int
	for time.Now().Before(end) {
		callOK(t, c, "desk.status.get", nil)
		calls++
		time.Sleep(100 * time.Millisecond)
	}
	if st := c.ConnectionState(); st != webrtc.PeerConnectionStateConnected {
		t.Fatalf("connection %s", st)
	}
	if c.Resumes.Load() == 0 {
		t.Fatal("the client's link never went through a resume")
	}
	if !strings.Contains(s.logs["gateway-shim"].String(), "closing connection at max age") {
		t.Fatal("the shim never closed at max age")
	}
	t.Logf("%d calls OK through %d resumes", calls, c.Resumes.Load())

	// Signaling works again through the new links, on the same session. Links keep cycling in this test,
	// so an attempt can land in the second or so a link is down, and it retries past that.
	deadline := time.Now().Add(20 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := c.RestartICE(ctx)
		cancel()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ICE restart after the reconnects: %v", err)
		}
		t.Logf("ICE restart retry: %v", err)
		time.Sleep(200 * time.Millisecond)
	}
	if !slices.Contains(s.state().Sessions, first) {
		t.Fatalf("session %s is gone: %v", first, s.state().Sessions)
	}
}

// slowLink returns a client through a rate-limited relay, with a queue deep enough that it isn't what
// bounds the latency.
func slowLink(t *testing.T, s *stack) *client.Conn {
	t.Helper()
	relay, err := testrelay.New(&net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: s.rtcPort}, testrelay.Config{
		Bps: 8_000_000, Delay: 10 * time.Millisecond, QueueBytes: 512 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(relay.Close)

	return s.dial(t, func(o *client.Options) {
		o.AnswerRewrite = func(sdp string) string { return testrelay.RewriteAnswer(sdp, relay.Port()) }
	})
}

type latency struct {
	p50, p95, max time.Duration
	n             int
}

func sample(t *testing.T, c *client.Conn, length time.Duration) latency {
	t.Helper()
	var all []time.Duration
	end := time.Now().Add(length)
	for time.Now().Before(end) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		d, err := c.Ping(ctx)
		cancel()
		if err != nil {
			t.Fatalf("ctl PING: %v", err)
		}
		all = append(all, d)
		time.Sleep(50 * time.Millisecond)
	}
	slices.Sort(all)

	return latency{p50: all[len(all)/2], p95: all[len(all)*95/100], max: all[len(all)-1], n: len(all)}
}

func (l latency) String() string {
	return fmt.Sprintf("p50=%v p95=%v max=%v n=%d", l.p50.Round(time.Millisecond), l.p95.Round(time.Millisecond), l.max.Round(time.Millisecond), l.n)
}

// ctlBudget is the most ctl may wait with a full bulk transfer running on this 8 Mbit/s link: the
// 20 ms round trip, 64 KiB of bulk ahead of it (about 66 ms), and room for a busy workstation. A queue
// as deep as rtc.sock's 256 KiB credit would alone cost about 260 ms and fail this.
const ctlBudget = 200 * time.Millisecond

func TestBulkDownloadDoesNotStallCtl(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := slowLink(t, s)
	base := sample(t, c, time.Second)

	callOK(t, c, "test.bulk.download", map[string]any{"bytes": 1 << 30})
	time.Sleep(500 * time.Millisecond) // let the transfer fill its queues
	start := c.BulkReceived.Load()
	began := time.Now()
	loaded := sample(t, c, 4*time.Second)
	moved := c.BulkReceived.Load() - start
	rate := float64(moved) * 8 / time.Since(began).Seconds() / 1e6
	t.Logf("ctl idle: %v", base)
	t.Logf("ctl during download: %v, bulk %.1f Mbit/s", loaded, rate)

	if moved < 1<<20 {
		t.Fatalf("bulk moved only %d bytes, so this proved nothing", moved)
	}
	if loaded.p95 > ctlBudget {
		t.Fatalf("ctl p95 %v over budget %v", loaded.p95, ctlBudget)
	}
}

func TestBulkUploadDoesNotStallCtl(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := slowLink(t, s)
	base := sample(t, c, time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.SendBulk(ctx, 1<<30) }()
	time.Sleep(500 * time.Millisecond)

	counters := func() int64 {
		var v struct {
			BulkIn int64 `json:"bulkIn"`
		}
		if err := json.Unmarshal(callOK(t, c, "test.counters", nil), &v); err != nil {
			t.Fatal(err)
		}

		return v.BulkIn
	}
	start := counters()
	began := time.Now()
	loaded := sample(t, c, 4*time.Second)
	moved := counters() - start
	rate := float64(moved) * 8 / time.Since(began).Seconds() / 1e6
	t.Logf("ctl idle: %v", base)
	t.Logf("ctl during upload: %v, bulk %.1f Mbit/s", loaded, rate)

	if moved < 1<<20 {
		t.Fatalf("bulk moved only %d bytes, so this proved nothing", moved)
	}
	if loaded.p95 > ctlBudget {
		t.Fatalf("ctl p95 %v over budget %v", loaded.p95, ctlBudget)
	}
}

// A deskd that stops draining bulk holds an upload back at its 256 KiB of rtc.sock credit, without
// holding up ctl, and the upload finishes once deskd drains again.
func TestStalledDeskdHoldsBulkNotCtl(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := slowLink(t, s)
	callOK(t, c, "test.bulk.stall", map[string]any{"on": true})

	// 1 MiB is the design's initial transfer window, the most a compliant client has in flight.
	const upload = 1 << 20
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sent := make(chan error, 1)
	go func() { sent <- c.SendBulk(ctx, upload) }()
	time.Sleep(2 * time.Second)

	bulkIn := func() int64 {
		var v struct {
			BulkIn int64 `json:"bulkIn"`
		}
		if err := json.Unmarshal(callOK(t, c, "test.counters", nil), &v); err != nil {
			t.Fatal(err)
		}

		return v.BulkIn
	}
	if got := bulkIn(); got == 0 || got > 256*1024 {
		t.Fatalf("deskd holds %d bytes of bulk, want 1 to 256 KiB", got)
	}
	loaded := sample(t, c, 2*time.Second)
	t.Logf("ctl with deskd stalled on bulk: %v", loaded)
	if loaded.p95 > ctlBudget {
		t.Fatalf("ctl p95 %v over budget %v", loaded.p95, ctlBudget)
	}

	callOK(t, c, "test.bulk.stall", map[string]any{"on": false})
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for bulkIn() < upload {
		if time.Now().After(deadline) {
			t.Fatalf("upload stuck at %d of %d", bulkIn(), upload)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// A whole download arrives intact over ICE-TCP, the other path.
func TestBulkDownloadOverTCP(t *testing.T) {
	s := startStack(t, stackOpts{})
	c := s.dial(t, func(o *client.Options) { o.Transport = "tcp" })
	if got := c.Transport(); got != "tcp" {
		t.Fatalf("transport %q", got)
	}
	const size = 8 << 20
	callOK(t, c, "test.bulk.download", map[string]any{"bytes": size})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := c.WaitBulkDone(ctx); err != nil {
		t.Fatalf("got %d of %d: %v", c.BulkReceived.Load(), size, err)
	}
	if got := c.BulkReceived.Load(); got != size {
		t.Fatalf("got %d, want %d", got, size)
	}
}

// stub writes a script on a test PATH.
func stub(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseRunScript(t *testing.T) {
	dir := t.TempDir()
	stub(t, dir, "desk-rtc", `printf '%s\n' "$@"`)
	cmd := exec.Command("sh", "../../release/run")
	cmd.Env = append(os.Environ(), "RELEASE_DIR="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	got := strings.Join(strings.Fields(string(out)), " ")
	// No --port: 443 is desk-rtc's default, and /etc/ma/desk-rtc.conf may set another (a self-hosted desk's 4443).
	want := "--socket /run/desk/rtc.sock --socket-group desk --data-dir /data/rtc --bind auto --config /etc/ma/desk-rtc.conf --stream-socket /run/desk-media/stream.sock --stream-user stream --profile-file /run/desk-egress/profile --display :99"
	if got != want {
		t.Fatalf("flags %q, want %q", got, want)
	}

	cmd = exec.Command("sh", "../../release/run")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	if err := cmd.Run(); err == nil {
		t.Fatal("run must refuse an unset RELEASE_DIR")
	}
}

func TestReleaseHealthScript(t *testing.T) {
	const (
		held  = `0 0 10.0.0.5:443 0.0.0.0:* users:(("desk-rtc",pid=1,fd=7))`
		other = `0 0 10.0.0.5:443 0.0.0.0:* users:(("nginx",pid=1,fd=7))`
	)
	// The release's desk-rtc says the port (--print-port); these stand-ins say 443, as with no desk config, or fail as a
	// bad config makes it.
	const port443, badConfig = "echo 443", "echo 'desk-rtc: config: bad port' >&2; exit 1"
	cases := []struct {
		name          string
		active        bool
		udp, tcp, uid string
		deskRTC       string
		healthy       bool
	}{
		{"healthy as root", true, held, held, "0", port443, true},
		{"unit inactive", false, held, held, "0", port443, false},
		{"no UDP", true, "", held, "0", port443, false},
		{"no TCP", true, held, "", "0", port443, false},
		{"port held by another process, as root", true, other, held, "0", port443, false},
		{"as another user only the ports are checked", true, "0 0 10.0.0.5:443 0.0.0.0:*", "0 0 10.0.0.5:443 0.0.0.0:*", "1101", port443, true},
		{"a config desk-rtc refuses", true, held, held, "0", badConfig, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir, rel := t.TempDir(), t.TempDir()
			exit := "1"
			if c.active {
				exit = "0"
			}
			stub(t, dir, "systemctl", "exit "+exit)
			stub(t, dir, "id", "echo "+c.uid)
			stub(t, dir, "ss", `case "$1" in -Hlnup) printf '%s' '`+c.udp+`' ;; -Hlntp) printf '%s' '`+c.tcp+`' ;; esac`)
			stub(t, rel, "desk-rtc", c.deskRTC)
			cmd := exec.Command("/bin/sh", "../../release/health")
			cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "RELEASE_DIR=" + rel}
			out, err := cmd.CombinedOutput()
			if c.healthy && err != nil {
				t.Fatalf("want healthy: %v %s", err, out)
			}
			if !c.healthy && err == nil {
				t.Fatal("want unhealthy")
			}
		})
	}
}

func TestClientGoneClosesTheSession(t *testing.T) {
	s := startStack(t, stackOpts{shimArgs: []string{"--resume-hold", "300ms"}})
	c := s.dial(t, nil)
	s.waitSessions(t, 1, 3*time.Second)
	c.Close()
	s.waitSessions(t, 0, 5*time.Second)
}
