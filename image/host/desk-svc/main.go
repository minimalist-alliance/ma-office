// desk-svc: process 1 of one service's own sandbox on a shared host (ADR 0072 section 2, WALL-06). The host image's
// (image/host/), from the wall test's run 2. desk-host makes the sandbox (runc create, its mounts, runc start) once per
// desk start and never takes a request from a desk; this supervises the one service inside it, as its systemd unit would:
//
//	desk-svc [-restart always|on-failure|no] [-restart-sec N] [-restart-max-sec N] [-restart-steps N] [-healthy-sec N] [-stop-timeout N] [-prevent 78,...] [-ctl <socket> [-on-demand]] -- argv...
//	desk-svc -accept <socket> [-accept-mode 0660] [-max-conn 24] [-peer-uid 1100] -- argv...
//
// -accept is systemd's Accept=yes socket (desk-data.socket, WALL-06): it listens on <socket> and starts argv once per
// connection, the connection as its stdin, and refuses a peer whose uid isn't -peer-uid (the helper checks it again).
//
// It starts argv in a process group of its own and restarts it as the unit says. The wait before a restart grows as systemd's
// RestartSteps= does, from -restart-sec to -restart-max-sec (300) in -restart-steps (8) restarts in a row, and starts over once
// a run has lasted -healthy-sec (120) or somebody starts it; it never gives up (reliability audit S1). SIGTERM (runc kill) stops it: SIGTERM to
// the group, -stop-timeout seconds, then SIGKILL, then exit 0. With -ctl it listens on a Unix socket for "start", "stop"
// and "status" from uid 0 of the desk only (SO_PEERCRED; desk-init's units.sock hands deskd's requests on), and with
// -on-demand it waits for "start" (desk-stream). It reaps every child, as process 1 must.
// The sandbox's seccomp filter (runc's, from the spec) is the unit filter here: no namespaces, no setns, clone3 ENOSYS.
//
//	desk-svc check <item>...   the in-sandbox checks (the host's proofs), for roots with no Python: status, ls:<dir>,
//	                            write:<path>, read:<path>, pids, x11:<path or @abstract>, unix:<path>, tcp:<host:port>,
//	                            rpc:<socket>:<line>, ns
package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type svc struct {
	argv        []string
	restart     string
	restartSec  time.Duration
	restartMax  time.Duration // the cap of the back-off
	restartStep int           // steps from restartSec to restartMax
	healthy     time.Duration // a run this long without a break starts the back-off over
	streak      int           // restarts in a row since a healthy run or a manual start
	startedAt   time.Time
	stopTimeout time.Duration
	prevent     map[int]bool
	mu          sync.Mutex
	cmd         *exec.Cmd
	wanted      bool
	stopping    bool
	exited      chan struct{}
}

func logf(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "[desk-svc %s] %s\n", time.Now().UTC().Format("15:04:05"), fmt.Sprintf(f, a...))
}

func (s *svc) start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return errors.New("stopping")
	}
	s.wanted = true
	if s.cmd != nil {
		return nil
	}
	s.streak = 0 // a start somebody asked for begins the back-off over, as systemctl start does
	return s.spawnLocked()
}

func (s *svc) spawnLocked() error {
	c := exec.Command(s.argv[0], s.argv[1:]...)
	c.Stdin, c.Stdout, c.Stderr = nil, os.Stdout, os.Stderr
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := c.Start(); err != nil {
		logf("start %s: %v", s.argv[0], err)
		return err
	}
	s.cmd = c
	s.startedAt = time.Now()
	s.exited = make(chan struct{})
	logf("started %s pid %d", s.argv[0], c.Process.Pid)
	return nil
}

// backoff is systemd's RestartSteps=/RestartMaxDelaySec= for the n-th restart in a row (n from 1): base for the first, then
// base * (max/base)^((n-1)/steps), never more than max. With no steps or max at or under base it is base, as it was.
func backoff(base, max time.Duration, steps, n int) time.Duration {
	if steps <= 0 || max <= base || n <= 1 {
		return base
	}
	if n-1 >= steps {
		return max
	}
	return time.Duration(float64(base) * math.Pow(float64(max)/float64(base), float64(n-1)/float64(steps)))
}

// reap collects every child (process 1 must), and handles the service's own exit: never exec.Cmd.Wait, so no race.
func (s *svc) reap() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, 0, nil)
		if err != nil {
			if err == syscall.EINTR {
				continue
			}
			time.Sleep(200 * time.Millisecond) // ECHILD: nothing running yet
			continue
		}
		s.mu.Lock()
		if s.cmd == nil || s.cmd.Process.Pid != pid {
			s.mu.Unlock()
			continue
		}
		rc := ws.ExitStatus()
		if ws.Signaled() {
			rc = 128 + int(ws.Signal())
		}
		close(s.exited)
		s.cmd = nil
		again := s.wanted && !s.stopping && (s.restart == "always" || (s.restart == "on-failure" && rc != 0 && !s.prevent[rc]))
		if !again {
			s.wanted = false
		}
		if time.Since(s.startedAt) >= s.healthy {
			s.streak = 0 // it ran well: the back-off starts over
		}
		s.streak++
		streak := s.streak
		wait := backoff(s.restartSec, s.restartMax, s.restartStep, streak)
		s.mu.Unlock()
		logf("exited %d%s", rc, map[bool]string{true: fmt.Sprintf(", restarting in %.1f s (restart %d in a row)", wait.Seconds(), streak), false: ""}[again])
		if again {
			go func() {
				time.Sleep(wait)
				s.mu.Lock()
				if s.wanted && !s.stopping && s.cmd == nil {
					_ = s.spawnLocked()
				}
				s.mu.Unlock()
			}()
		}
	}
}

func (s *svc) stop() {
	s.mu.Lock()
	s.wanted = false
	c, done := s.cmd, s.exited
	s.mu.Unlock()
	if c == nil {
		return
	}
	_ = syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(s.stopTimeout):
		logf("did not stop in %s, SIGKILL", s.stopTimeout)
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		<-done
	}
	logf("stopped")
}

// ---- -accept: one process per connection (systemd's Accept=yes), for desk-data
type acceptor struct {
	argv    []string
	peerUID int
	max     int
	mu      sync.Mutex
	live    map[int]bool
}

func (a *acceptor) serve(path string, mode os.FileMode) {
	_ = os.Remove(path)
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		logf("accept %s: %v", path, err)
		os.Exit(1)
	}
	_ = os.Chmod(path, mode)
	logf("accepting on %s (mode %o, peer uid %d, at most %d)", path, mode, a.peerUID, a.max)
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			continue
		}
		a.one(c)
	}
}

func (a *acceptor) one(c *net.UnixConn) {
	defer c.Close()
	f, err := c.File()
	if err != nil {
		return
	}
	defer f.Close()
	cred, err := syscall.GetsockoptUcred(int(f.Fd()), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	if err != nil || (a.peerUID >= 0 && int(cred.Uid) != a.peerUID) {
		fmt.Fprintf(c, "err denied\n")
		return
	}
	a.mu.Lock()
	n := len(a.live)
	a.mu.Unlock()
	if n >= a.max {
		fmt.Fprintf(c, "err busy\n")
		return
	}
	cmd := exec.Command(a.argv[0], a.argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = f, os.Stderr, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		logf("accept: start %s: %v", a.argv[0], err)
		return
	}
	a.mu.Lock()
	a.live[cmd.Process.Pid] = true
	a.mu.Unlock()
}

func (a *acceptor) reap() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, 0, nil)
		if err != nil {
			if err != syscall.EINTR {
				time.Sleep(200 * time.Millisecond)
			}
			continue
		}
		a.mu.Lock()
		delete(a.live, pid)
		a.mu.Unlock()
	}
}

func accept(args []string) {
	fs := flag.NewFlagSet("desk-svc", flag.ExitOnError)
	path := fs.String("accept", "", "socket")
	mode := fs.String("accept-mode", "0660", "socket mode")
	max := fs.Int("max-conn", 24, "")
	peer := fs.Int("peer-uid", 1100, "the only uid served (-1: any)")
	_ = fs.Parse(args)
	m, err := strconv.ParseUint(*mode, 8, 32)
	if err != nil || fs.NArg() == 0 || *path == "" {
		fmt.Fprintln(os.Stderr, "usage: desk-svc -accept <socket> [-accept-mode 0660] [-max-conn 24] [-peer-uid 1100] -- argv...")
		os.Exit(2)
	}
	a := &acceptor{argv: fs.Args(), peerUID: *peer, max: *max, live: map[int]bool{}}
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go a.reap()
	go a.serve(*path, os.FileMode(m))
	<-sig
	a.mu.Lock()
	for pid := range a.live {
		_ = syscall.Kill(-pid, syscall.SIGTERM)
	}
	a.mu.Unlock()
	logf("SIGTERM: stopped accepting")
	os.Exit(0)
}

func (s *svc) serve(path string) {
	_ = os.Remove(path)
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		logf("ctl %s: %v", path, err)
		return
	}
	_ = os.Chmod(path, 0o600)
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			continue
		}
		go s.handle(c)
	}
}

func (s *svc) handle(c *net.UnixConn) {
	defer c.Close()
	f, err := c.File()
	if err != nil {
		return
	}
	cred, err := syscall.GetsockoptUcred(int(f.Fd()), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	f.Close()
	if err != nil || cred.Uid != 0 {
		fmt.Fprintf(c, "err denied\n")
		return
	}
	_ = c.SetDeadline(time.Now().Add(40 * time.Second))
	line, _ := bufio.NewReader(c).ReadString('\n')
	switch strings.TrimSpace(line) {
	case "start":
		if err := s.start(); err != nil {
			fmt.Fprintf(c, "err %v\n", err)
			return
		}
		fmt.Fprintf(c, "ok\n")
	case "stop":
		s.stop()
		fmt.Fprintf(c, "ok\n")
	case "status":
		s.mu.Lock()
		fmt.Fprintf(c, "ok running=%v wanted=%v\n", s.cmd != nil, s.wanted)
		s.mu.Unlock()
	default:
		fmt.Fprintf(c, "err bad_request\n")
	}
}

func supervise(args []string) {
	fs := flag.NewFlagSet("desk-svc", flag.ExitOnError)
	restart := fs.String("restart", "always", "always|on-failure|no")
	restartSec := fs.Float64("restart-sec", 3, "")
	restartMax := fs.Float64("restart-max-sec", 300, "the back-off's cap; with -restart-steps 0 or the same as -restart-sec the wait stays flat")
	restartSteps := fs.Int("restart-steps", 8, "restarts in a row from -restart-sec to -restart-max-sec")
	healthy := fs.Float64("healthy-sec", 120, "a run this long, unbroken, starts the back-off over")
	stopTimeout := fs.Float64("stop-timeout", 30, "")
	prevent := fs.String("prevent", "", "exit codes that don't restart")
	ctl := fs.String("ctl", "", "control socket")
	onDemand := fs.Bool("on-demand", false, "wait for start on -ctl")
	_ = fs.Parse(args)
	if fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: desk-svc [flags] -- argv...")
		os.Exit(2)
	}
	s := &svc{argv: fs.Args(), restart: *restart, restartSec: time.Duration(*restartSec * float64(time.Second)),
		restartMax: time.Duration(*restartMax * float64(time.Second)), restartStep: *restartSteps, healthy: time.Duration(*healthy * float64(time.Second)),
		stopTimeout: time.Duration(*stopTimeout * float64(time.Second)), prevent: map[int]bool{}}
	for _, p := range strings.Split(*prevent, ",") {
		if n, err := strconv.Atoi(p); err == nil {
			s.prevent[n] = true
		}
	}
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go s.reap()
	if *ctl != "" {
		go s.serve(*ctl)
	}
	if !*onDemand {
		_ = s.start()
	}
	<-sig
	s.mu.Lock()
	s.stopping = true
	s.mu.Unlock()
	logf("SIGTERM: stopping %s", s.argv[0])
	s.stop()
	os.Exit(0)
}

// ---- checks (proofs.sh, through runc exec in a sandbox whose root has no Python)

func errName(err error) string {
	var en syscall.Errno
	if errors.As(err, &en) {
		return strings.ToUpper(errnoNames[en])
	}
	return err.Error()
}

var errnoNames = map[syscall.Errno]string{syscall.EPERM: "eperm", syscall.ENOENT: "enoent", syscall.EACCES: "eacces",
	syscall.EROFS: "erofs", syscall.ECONNREFUSED: "econnrefused", syscall.ENETUNREACH: "enetunreach", syscall.ELOOP: "eloop",
	syscall.ENOSYS: "enosys", syscall.ETIMEDOUT: "etimedout", syscall.EHOSTUNREACH: "ehostunreach", syscall.ENOTDIR: "enotdir",
	syscall.EINVAL: "einval", syscall.EAFNOSUPPORT: "eafnosupport", syscall.EEXIST: "eexist", syscall.EOVERFLOW: "eoverflow"}

func x11(where string) string {
	addr := &net.UnixAddr{Name: where, Net: "unix"}
	if strings.HasPrefix(where, "@") {
		addr.Name = "\x00" + where[1:]
	}
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return errName(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: addr.Name}); err != nil {
		return errName(err)
	}
	req := []byte{'l', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.LittleEndian.PutUint16(req[2:], 11)
	if _, err := syscall.Write(fd, req); err != nil {
		return errName(err)
	}
	tv := syscall.Timeval{Sec: 5}
	_ = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv)
	b := make([]byte, 8)
	n, err := syscall.Read(fd, b)
	if err != nil || n == 0 {
		return "closed"
	}
	return map[byte]string{0: "refused", 1: "connected", 2: "authenticate"}[b[0]]
}

func check(items []string) {
	for _, it := range items {
		k, v, _ := strings.Cut(it, ":")
		switch k {
		case "status":
			st, _ := os.ReadFile("/proc/self/status")
			for _, l := range strings.Split(string(st), "\n") {
				for _, p := range []string{"Uid:", "CapEff:", "CapAmb:", "Seccomp:", "Seccomp_filters:", "NoNewPrivs:"} {
					if strings.HasPrefix(l, p) {
						fmt.Println(strings.Join(strings.Fields(l), " "))
					}
				}
			}
			aa, _ := os.ReadFile("/proc/self/attr/current")
			fmt.Printf("apparmor: %s\n", strings.TrimSpace(string(aa)))
		case "ls":
			ents, err := os.ReadDir(v)
			if err != nil {
				fmt.Printf("ls %s: %s\n", v, errName(err))
				continue
			}
			names := []string{}
			for _, e := range ents {
				names = append(names, e.Name())
			}
			fmt.Printf("ls %s: [%s]\n", v, strings.Join(names, " "))
		case "write":
			f, err := os.OpenFile(v, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				fmt.Printf("write %s: %s\n", v, errName(err))
				continue
			}
			f.Close()
			os.Remove(v)
			fmt.Printf("write %s: ok\n", v)
		case "read":
			f, err := os.Open(v)
			if err != nil {
				fmt.Printf("read %s: %s\n", v, errName(err))
				continue
			}
			f.Close()
			fmt.Printf("read %s: ok\n", v)
		case "pids":
			ents, _ := os.ReadDir("/proc")
			n := 0
			for _, e := range ents {
				if _, err := strconv.Atoi(e.Name()); err == nil {
					n++
				}
			}
			fmt.Printf("processes visible: %d\n", n)
		case "x11":
			fmt.Printf("x11 %s: %s\n", v, x11(v))
		case "unix":
			fd, _ := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
			err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: v})
			syscall.Close(fd)
			if err != nil {
				fmt.Printf("unix %s: %s\n", v, errName(err))
			} else {
				fmt.Printf("unix %s: connected\n", v)
			}
		case "tcp":
			c, err := net.DialTimeout("tcp", v, 4*time.Second)
			if err != nil {
				var oe *net.OpError
				if errors.As(err, &oe) && oe.Timeout() {
					fmt.Printf("tcp %s: timed out\n", v)
				} else {
					fmt.Printf("tcp %s: %s\n", v, errName(err))
				}
				continue
			}
			c.Close()
			fmt.Printf("tcp %s: connected\n", v)
		case "rpc": // rpc:<socket>:<one request line>: what the helper answers first (desk-data, WALL-06)
			sock, req, _ := strings.Cut(v, ":")
			fd, _ := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
			if err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: sock}); err != nil {
				fmt.Printf("rpc %s: %s\n", sock, errName(err))
				syscall.Close(fd)
				continue
			}
			tv := syscall.Timeval{Sec: 10}
			_ = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv)
			_, _ = syscall.Write(fd, []byte(req+"\n"))
			b := make([]byte, 600)
			n, _ := syscall.Read(fd, b)
			syscall.Close(fd)
			if n < 0 {
				n = 0
			}
			fmt.Printf("rpc %s: %q\n", sock, strings.ToValidUTF8(string(b[:n]), "?"))
		case "ns":
			_, _, e := syscall.RawSyscall(syscall.SYS_UNSHARE, syscall.CLONE_NEWUSER, 0, 0)
			fmt.Printf("unshare(CLONE_NEWUSER): %s\n", map[bool]string{true: "ok", false: errName(e)}[e == 0])
			_, _, e = syscall.RawSyscall(syscall.SYS_UNSHARE, syscall.CLONE_NEWNS, 0, 0)
			fmt.Printf("unshare(CLONE_NEWNS): %s\n", map[bool]string{true: "ok", false: errName(e)}[e == 0])
			_, _, e = syscall.RawSyscall(435, 0, 0, 0) // clone3
			fmt.Printf("clone3(): %s\n", errName(e))
			_, _, e = syscall.RawSyscall(syscall.SYS_MOUNT, 0, 0, 0)
			fmt.Printf("mount(): %s\n", errName(e))
		default:
			fmt.Printf("%s: unknown check\n", it)
		}
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "check" {
		check(os.Args[2:])
		return
	}
	for _, a := range os.Args[1:] {
		if a == "-accept" || a == "--accept" {
			accept(os.Args[1:])
			return
		}
		if a == "--" {
			break
		}
	}
	supervise(os.Args[1:])
}
