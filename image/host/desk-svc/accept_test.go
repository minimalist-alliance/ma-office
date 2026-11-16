package main

// desk-parse's flags (ADR 0097 section 1): -conn-stdio, -deadline-sec and -clean. The in-process tests run the acceptor's own
// code with -clean's step 1 stood in for (only process 1 of a PID namespace may kill(-1)); TestCleanAsProcess1 runs the real
// binary as process 1 of a new user and PID namespace (unshare), and runs each case again without -clean, which must fail it.

import (
	"bufio"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func newAcceptor(t *testing.T, clean bool, argv ...string) *acceptor {
	t.Helper()
	d := filepath.Join(t.TempDir(), "sock")
	if err := os.Mkdir(d, 0o750); err != nil {
		t.Fatal(err)
	}
	a := &acceptor{argv: argv, peerUID: -1, max: 1, stdio: true, clean: clean, path: filepath.Join(d, "parse.sock"),
		mode: 0o660, live: map[int]bool{}, killAll: func() int { return 0 }}
	if err := a.listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.listener().Close() })
	return a
}

// ask: one request as desk-agent sends it (the header line and the bytes, then a half-close), and the whole answer.
func ask(t *testing.T, path, req string, within time.Duration) (string, time.Duration) {
	t.Helper()
	c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	defer c.Close()
	t0 := time.Now()
	_ = c.SetDeadline(t0.Add(within))
	_, _ = c.Write([]byte(req))
	_ = c.CloseWrite()
	b, _ := io.ReadAll(c)
	return string(b), time.Since(t0)
}

func TestConnStdioIsTheConnectionWithNoEnvironmentAndNoStderr(t *testing.T) {
	t.Setenv("DESK_SVC_TEST_SECRET", "leaked")
	a := newAcceptor(t, false, "/bin/sh", "-c",
		`read -r h; echo "OK env=${DESK_SVC_TEST_SECRET:-none} head=$h"; echo "on stderr" >&2; cat`)
	go a.serve()
	got, _ := ask(t, a.path, "parse1 text 100 1\nthe file's bytes", 5*time.Second)
	if got != "OK env=none head=parse1 text 100 1\nthe file's bytes" {
		t.Fatalf("answer %q: the connection must be stdin and stdout, stderr /dev/null and the environment empty", got)
	}
}

func TestDeadlineKillsTheWorkersGroup(t *testing.T) {
	a := newAcceptor(t, false, "/bin/sh", "-c", `sleep 30 & echo "bg $!"; sleep 30; echo late`)
	a.deadline = 700 * time.Millisecond
	go a.serve()
	got, took := ask(t, a.path, "parse1 text 1 1\n", 10*time.Second)
	if strings.Contains(got, "late") || took > 5*time.Second {
		t.Fatalf("answer %q after %s: the deadline should have ended it in about 0.7 s", got, took)
	}
	f := strings.Fields(got)
	if len(f) != 2 || f[0] != "bg" {
		t.Fatalf("answer %q: no background pid", got)
	}
	bg, _ := strconv.Atoi(f[1])
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if syscall.Kill(bg, 0) == syscall.ESRCH || zombie(bg) {
			return
		}
	}
	t.Fatalf("the worker's background process %d outlived the deadline", bg)
}

func zombie(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	return i > 0 && len(s) > i+2 && s[i+2] == 'Z'
}

func TestPeerOtherThanTheOneUidIsDenied(t *testing.T) {
	a := newAcceptor(t, true, "/bin/echo", "OK")
	a.peerUID = os.Getuid() + 4242
	go a.serveClean(make(chan *net.UnixConn))
	if got, _ := ask(t, a.path, "parse1 text 1 1\n", 5*time.Second); got != "err denied\n" {
		t.Fatalf("answer %q, want err denied", got)
	}
}

func TestCleanServesOneAtATimeAndSaysBusy(t *testing.T) {
	a := newAcceptor(t, true, "/bin/sh", "-c", `sleep 1; echo OK`)
	go a.serveClean(make(chan *net.UnixConn))
	first := make(chan string, 1)
	go func() { s, _ := ask(t, a.path, "parse1 text 1 1\n", 5*time.Second); first <- s }()
	time.Sleep(300 * time.Millisecond)
	if got, _ := ask(t, a.path, "parse1 text 1 1\n", 5*time.Second); got != "err busy\n" {
		t.Fatalf("second connection while the first runs: %q, want err busy", got)
	}
	if got := <-first; got != "OK\n" {
		t.Fatalf("first: %q", got)
	}
	if got, _ := ask(t, a.path, "parse1 text 1 1\n", 5*time.Second); got != "OK\n" {
		t.Fatalf("after the first ended and the sandbox was cleaned: %q, want OK", got)
	}
}

// The sweep and the listener check, with step 1 stood in for by a count: a worker that leaves files and a directory beside the
// socket, then one that puts a file where the socket was. After each, the next connection is served by this listener.
func TestCleanEmptiesTheSocketsDirectoryAndRebinds(t *testing.T) {
	kills := 0
	dir := ""
	a := newAcceptor(t, true, "/bin/sh", "-c", `read -r cmd; d=$0
case $cmd in
  drop) touch "$d/left"; mkdir "$d/sub"; touch "$d/sub/x"; ln -s / "$d/root"; echo OK ;;
  swap) rm -f "$d/parse.sock"; echo stand-in > "$d/parse.sock"; echo OK ;;
  *) echo "OK $(ls -A "$d" | tr '\n' ' ')" ;;
esac`)
	dir = filepath.Dir(a.path)
	a.argv = append(a.argv, dir)
	a.killAll = func() int { kills++; return 0 }
	go a.serveClean(make(chan *net.UnixConn))
	for _, step := range []struct{ req, want string }{
		{"drop\n", "OK\n"},
		{"list\n", "OK parse.sock \n"},
		{"swap\n", "OK\n"},
		{"list\n", "OK parse.sock \n"},
	} {
		if got, _ := ask(t, a.path, step.req, 5*time.Second); got != step.want {
			t.Fatalf("%q: answer %q, want %q", strings.TrimSpace(step.req), got, step.want)
		}
	}
	if kills != 4 {
		t.Fatalf("step 1 ran %d times for 4 connections", kills)
	}
	if !a.ownsPath() {
		t.Fatal("the socket's path isn't this listener's after the rebind")
	}
	if _, err := os.Stat("/"); err != nil {
		t.Fatal("the sweep followed a link")
	}
}

// A worker that can't be started: one "ERR unavailable" line, the worker's own form, so desk-agent says "unavailable" and not
// "too_complex" (a stream that ends before a line). Both modes.
func TestAWorkerThatCantStartAnswersUnavailable(t *testing.T) {
	a := newAcceptor(t, true, "/nonexistent/worker")
	go a.serveClean(make(chan *net.UnixConn))
	if got, _ := ask(t, a.path, "parse1 text 1 1\n", 5*time.Second); got != "ERR unavailable\n" {
		t.Fatalf("-clean: answer %q, want ERR unavailable", got)
	}
	b := newAcceptor(t, false, "/nonexistent/worker")
	go b.serve()
	if got, _ := ask(t, b.path, "parse1 text 1 1\n", 5*time.Second); got != "ERR unavailable\n" {
		t.Fatalf("without -clean: answer %q, want ERR unavailable", got)
	}
	c := newAcceptor(t, false, "/nonexistent/worker") // desk-data's mode: no stdio, so no line of ADR 0097's form
	c.stdio = false
	go c.serve()
	if got, _ := ask(t, c.path, "x\n", 5*time.Second); got != "" {
		t.Fatalf("without -conn-stdio: answer %q, want the connection closed", got)
	}
}

// desk-agent sends a message's next file as soon as the last one's answer ends: with -clean that's never "err busy".
func TestCleanBackToBackFilesAreNeverBusy(t *testing.T) {
	a := newAcceptor(t, true, "/bin/sh", "-c", `read -r h; echo "OK $h"`)
	go a.serveClean(make(chan *net.UnixConn))
	for i := 0; i < 25; i++ {
		req := "parse1 text " + strconv.Itoa(i+1) + " 1\n"
		if got, _ := ask(t, a.path, req, 5*time.Second); got != "OK "+req {
			t.Fatalf("file %d straight after the last: %q", i+1, got)
		}
	}
}

// The worker's stderr goes nowhere: not into the connection (above) and not into desk-svc's own stderr, which a unit's
// journal keeps. Its command has a nil Stderr (os/exec's /dev/null) and an empty, non-nil environment.
func TestWorkerStderrAndEnvironment(t *testing.T) {
	a := newAcceptor(t, true, "/bin/true")
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cmd := a.command(f)
	if cmd.Stderr != nil || cmd.Env == nil || len(cmd.Env) != 0 || cmd.Stdout != f || cmd.Stdin != f {
		t.Fatalf("stdio %v, stderr %v, env %v", cmd.Stdin == f && cmd.Stdout == f, cmd.Stderr, cmd.Env)
	}
}

func TestCleanRefusedButAsProcess1(t *testing.T) {
	bin := buildSvc(t)
	out, err := exec.Command(bin, "-accept", filepath.Join(t.TempDir(), "p.sock"), "-max-conn", "1", "-clean", "--", "/bin/true").CombinedOutput()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 2 || !strings.Contains(string(out), "process 1") {
		t.Fatalf("-clean outside process 1: %v %q, want exit 2", err, out)
	}
}

func buildSvc(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "desk-svc")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

// TestCleanAsProcess1: the real binary as process 1 of its own PID namespace, as in desk-parse's sandbox. Each case runs with
// -clean, and again without it (the mutation), which must fail the same check.
func TestCleanAsProcess1(t *testing.T) {
	if _, err := exec.LookPath("unshare"); err != nil {
		t.Skip("no unshare")
	}
	if out, err := exec.Command("unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "/bin/true").CombinedOutput(); err != nil {
		t.Skipf("no unprivileged user and PID namespaces here: %v %s", err, out)
	}
	bin := buildSvc(t)
	worker := `read -r cmd arg; d=$0
case $cmd in
  spawn) sleep 300 & echo "bg $!" ;;
  probe) if kill -0 "$arg" 2>/dev/null; then echo alive; else echo gone; fi ;;
  steal) "$1" -accept "$d/parse.sock" -peer-uid -1 -max-conn 1 -conn-stdio -- /bin/echo stolen </dev/null >/dev/null 2>&1 & sleep 0.5; echo OK ;;
  drop) touch "$d/left"; echo OK ;;
  noisy) echo "worker-stderr-$arg" >&2; echo OK ;;
  look) if [ -e "$d/left" ]; then echo left; else echo none; fi ;;
  hang) sleep 300 ;;
  *) echo OK ;;
esac`
	var logMu sync.Mutex
	var svcLog strings.Builder
	run := func(t *testing.T, clean bool) (string, func(req string, within time.Duration) (string, time.Duration)) {
		d := filepath.Join(t.TempDir(), "sock")
		_ = os.Mkdir(d, 0o750)
		path := filepath.Join(d, "parse.sock")
		args := []string{"--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--kill-child", bin, "-accept", path, "-peer-uid", "-1",
			"-max-conn", "1", "-conn-stdio", "-deadline-sec", "2"}
		if clean {
			args = append(args, "-clean")
		}
		args = append(args, "--", "/bin/sh", "-c", worker, d, bin)
		cmd := exec.Command("unshare", args...)
		stderr, _ := cmd.StderrPipe()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		ready := make(chan struct{})
		go func() {
			sc := bufio.NewScanner(stderr)
			once := false
			for sc.Scan() {
				logMu.Lock()
				svcLog.WriteString(sc.Text() + "\n")
				logMu.Unlock()
				if !once && strings.Contains(sc.Text(), "accepting on") {
					once = true
					close(ready)
				}
			}
		}()
		select {
		case <-ready:
		case <-time.After(10 * time.Second):
			t.Fatal("desk-svc never listened")
		}
		return path, func(req string, within time.Duration) (string, time.Duration) { return ask(t, path, req, within) }
	}
	cases := []struct {
		name  string
		check func(t *testing.T, q func(string, time.Duration) (string, time.Duration)) string // "" passes
	}{
		{"a process a worker leaves is killed", func(t *testing.T, q func(string, time.Duration) (string, time.Duration)) string {
			got, _ := q("spawn\n", 5*time.Second)
			f := strings.Fields(got)
			if len(f) != 2 {
				return "spawn answered " + got
			}
			if got, _ := q("probe "+f[1]+"\n", 5*time.Second); got != "gone\n" {
				return "the left process is " + strings.TrimSpace(got)
			}
			return ""
		}},
		{"a stand-in listener at the socket's path is killed and the path bound again", func(t *testing.T, q func(string, time.Duration) (string, time.Duration)) string {
			if got, _ := q("steal\n", 5*time.Second); got != "OK\n" {
				return "steal answered " + got
			}
			if got, _ := q("hello\n", 5*time.Second); got != "OK\n" {
				return "the next connection reached " + strings.TrimSpace(got)
			}
			return ""
		}},
		{"a file a worker leaves beside the socket is removed", func(t *testing.T, q func(string, time.Duration) (string, time.Duration)) string {
			_, _ = q("drop\n", 5*time.Second)
			if got, _ := q("look\n", 5*time.Second); got != "none\n" {
				return "the next worker found " + strings.TrimSpace(got)
			}
			return ""
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, q := run(t, true)
			if why := c.check(t, q); why != "" {
				t.Fatalf("with -clean: %s", why)
			}
			_, q = run(t, false)
			if why := c.check(t, q); why == "" {
				t.Fatal("without -clean the check still passed: it doesn't test -clean")
			}
		})
	}
	t.Run("a worker's stderr reaches neither the answer nor desk-svc's own log", func(t *testing.T) {
		_, q := run(t, true)
		if got, _ := q("noisy 7Q\n", 5*time.Second); got != "OK\n" {
			t.Fatalf("noisy: %q", got)
		}
		time.Sleep(200 * time.Millisecond)
		logMu.Lock()
		defer logMu.Unlock()
		if strings.Contains(svcLog.String(), "worker-stderr-7Q") {
			t.Fatal("the worker's stderr is in desk-svc's own stderr")
		}
	})
	t.Run("a worker past its deadline is killed", func(t *testing.T) {
		_, q := run(t, true)
		got, took := q("hang\n", 15*time.Second)
		if got != "" || took > 6*time.Second || took < 1500*time.Millisecond {
			t.Fatalf("hang: %q after %s, want nothing after about 2 s", got, took)
		}
		if got, _ := q("hello\n", 5*time.Second); got != "OK\n" {
			t.Fatalf("after the deadline: %q", got)
		}
	})
}

func TestMakeNonDumpableReportsAFailure(t *testing.T) {
	if err := makeNonDumpable(func() error { return errors.New("EPERM") }); err == nil {
		t.Fatal("a failed prctl was swallowed")
	}
	if err := makeNonDumpable(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
}

// TestCleanProcess1IsNotDumpable (PARSE-L1): the worker is the same uid as process 1, so process 1's /proc/1/mem must not be
// the worker's. Run as uid 1113 in its own user and PID namespaces (no capabilities after the exec, as in the sandbox):
// /proc/1/mem is owned by 1113 while process 1 is dumpable, and by the unmapped root (65534 inside) once it isn't. Without
// -clean it stays 1113, so the check tells the two apart.
func TestCleanProcess1IsNotDumpable(t *testing.T) {
	if _, err := exec.LookPath("unshare"); err != nil {
		t.Skip("no unshare")
	}
	if out, err := exec.Command("unshare", "--user", "--map-user=1113", "--pid", "--fork", "--mount-proc", "/bin/true").CombinedOutput(); err != nil {
		t.Skipf("no unprivileged user and PID namespaces here: %v %s", err, out)
	}
	bin := buildSvc(t)
	owner := func(clean bool) string {
		d := filepath.Join(t.TempDir(), "sock")
		_ = os.Mkdir(d, 0o750)
		path := filepath.Join(d, "parse.sock")
		args := []string{"--user", "--map-user=1113", "--pid", "--fork", "--mount-proc", "--kill-child", bin, "-accept", path, "-peer-uid", "-1",
			"-max-conn", "1", "-conn-stdio", "-deadline-sec", "2"}
		if clean {
			args = append(args, "-clean")
		}
		args = append(args, "--", "/bin/sh", "-c", `stat -c %u /proc/1/mem`)
		cmd := exec.Command("unshare", args...)
		stderr, _ := cmd.StderrPipe()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		ready := make(chan struct{})
		go func() {
			sc := bufio.NewScanner(stderr)
			once := false
			for sc.Scan() {
				if !once && strings.Contains(sc.Text(), "accepting on") {
					once = true
					close(ready)
				}
			}
		}()
		select {
		case <-ready:
		case <-time.After(10 * time.Second):
			t.Fatal("desk-svc never listened")
		}
		got, _ := ask(t, path, "x\n", 5*time.Second)
		return strings.TrimSpace(got)
	}
	if got := owner(true); got == "1113" || got == "" {
		t.Fatalf("with -clean, /proc/1/mem is owned by %q: process 1 is dumpable", got)
	}
	if got := owner(false); got != "1113" {
		t.Fatalf("without -clean the owner is %q, want 1113: the check doesn't tell the two apart", got)
	}
}
