#!/usr/bin/python3 -I
"""desk-init: one desk inside its walled container on a shared host, in place of systemd and desk-units (ADR 0072
section 2). The host's, read-only at /desk-host in every desk, so a desk's root can't change its own init (WALL-03). From
the wall test's desk-init (spikes/shared-host-wall/wall/desk-init.py, runs 1 and 2), as the shared-host image ships it:

- WALL-01: desk-init no longer runs as uid 0 without the unit filter. At start, before anything else runs, it forks the
  browser launcher: a small process that joins desk-browser's cgroup, drops to kiosk (Chromium's own uid and groups) and
  keeps the container's filter only, because Chromium's sandbox makes user, PID and network namespaces. Then desk-init puts
  the unit filter (no clone or unshare with a CLONE_NEW* flag, no setns, clone3 ENOSYS, native arm64 calls only) on itself,
  every thread at once (SECCOMP_FILTER_FLAG_TSYNC), so it and everything it starts carry it; a filter is inherited and kept
  across execve. The launcher takes one request, "start", over a socketpair only desk-init holds, with the log descriptor,
  and starts desk-browser-start as kiosk; it reports each child's exit. So the processes without the unit filter are
  docker-init (process 1: reaps and forwards signals), the launcher and Chromium's tree, all but docker-init as kiosk.
- WALL-01 (4): Xorg runs as desk-x (1107) with -auth (a cookie per start, 0600) and -nolisten local, admitting kiosk, rtc
  and stream by uid (DA-1); PulseAudio as desk-snd (1108), no anonymous clients, only group desk-audio, module loading off.
- WALL-02: the host's only stop is SIGTERM (runc kill), after deskd's sandbox has stopped: then the browser (thawed first,
  asked to quit over CDP, Browser.close, up to 31 s, then SIGTERM with 30 s, as desk-browser-close does: RC-05, T46L-2),
  then sync /data.
- WALL-06: deskd, desk-agent, desk-notebook, desk-rtc, desk-stream and desk-data run in sandboxes of their own (svc-spec.py).
  desk-stream stays on demand: units.sock's start and stop for it go to its sandbox's desk-svc over /run/desk-ctl. There is
  no mode with them as plain processes here. The Agent filter (uid 1106) and its stub resolver (desk-dns, 1109) run here.
- T46L-2 and ADR 0045 on a shared host: units.sock takes freeze and thaw for desk-browser, with desk-units' own freeze()
  and thaw() (the template's copy, /desk-host/desk-units.py, the host's): the browser's cgroup found from the launcher's
  pid, a freeze refused while the browser is stopping or the desk is, and every stop thaws before it quits.
- WR2-01: no CDP forward. A test host (only) mounts its tools at /desk-host-test and says so in /run/desk-host/test-cdp;
  then, and only then, this loads its forward, which listens on the desk's own address for the host's side of the veth alone.
Logs go to /data/logs/<unit>.log. `desk-init.py --exec-filtered <argv>`: the unit filter, then exec (the host's proofs).
"""
import array
import ctypes
import errno
import grp
import importlib.machinery
import importlib.util
import os
import pwd
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

# ---- WALL-01 (1): the unit filter, classic BPF over seccomp_data {int nr; u32 arch; u64 ip; u64 args[6]}
AUDIT_ARCH_AARCH64 = 0xC00000B7
NR = {"unshare": 97, "clone": 220, "setns": 268, "clone3": 435, "seccomp": 277}   # arm64's generic table
CLONE_NEW_ALL = 0x7E020000 | 0x80                                  # NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWUSER|NEWPID|NEWNET, NEWTIME
RET_ALLOW, RET_ERRNO = 0x7FFF0000, 0x00050000


def _bpf():
    ld, jeq, jset, ret = 0x20, 0x15, 0x45, 0x06   # BPF_LD|W|ABS, BPF_JMP|JEQ|K, BPF_JMP|JSET|K, BPF_RET|K
    return [(ld, 0, 0, 4),                                           # arch
            (jeq, 1, 0, AUDIT_ARCH_AARCH64), (ret, 0, 0, RET_ERRNO | errno.EPERM),   # no 32-bit compat calls at all
            (ld, 0, 0, 0),                                           # nr
            (jeq, 0, 1, NR["clone3"]), (ret, 0, 0, RET_ERRNO | errno.ENOSYS),
            (jeq, 0, 1, NR["setns"]), (ret, 0, 0, RET_ERRNO | errno.EPERM),
            (jeq, 1, 0, NR["clone"]), (jeq, 0, 3, NR["unshare"]),
            (ld, 0, 0, 16),                                          # args[0], low word (flags)
            (jset, 0, 1, CLONE_NEW_ALL), (ret, 0, 0, RET_ERRNO | errno.EPERM),
            (ret, 0, 0, RET_ALLOW)]


class _Insn(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]


class _Prog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(_Insn))]


_LIBC = ctypes.CDLL(None, use_errno=True)
_INSNS = (_Insn * len(_bpf()))(*[_Insn(*i) for i in _bpf()])
_PROG = _Prog(len(_INSNS), _INSNS)


def unit_filter():
    """Installs the filter on the calling thread (a child between fork and exec). no_new_privs is already set container-wide."""
    if _LIBC.prctl(38, 1, 0, 0, 0) != 0:   # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "no_new_privs")
    if _LIBC.prctl(22, 2, ctypes.byref(_PROG), 0, 0) != 0:   # PR_SET_SECCOMP, SECCOMP_MODE_FILTER
        raise OSError(ctypes.get_errno(), "seccomp")


def unit_filter_self():
    """The unit filter on desk-init itself, every thread (SECCOMP_SET_MODE_FILTER with SECCOMP_FILTER_FLAG_TSYNC)."""
    if _LIBC.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "no_new_privs")
    r = _LIBC.syscall(NR["seccomp"], 1, 1, ctypes.byref(_PROG))   # SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC
    if r != 0:
        raise OSError(ctypes.get_errno(), f"seccomp TSYNC ({r})")


def run_helper(argv, **kw):
    """Every helper (systemd's ExecStartPre=+ and friends) runs under the unit filter, inherited from desk-init."""
    return subprocess.run(argv, stdin=subprocess.DEVNULL, **kw)


LOG_DIR = "/data/logs"
CG = "/sys/fs/cgroup"
CGROUPS = {"desk-browser": (100, "2560M"), "desk-xorg": (100, "max"), "desk-audio": (100, "max"),
           "desk-agent-filter": (100, "96M"), "desk-dns": (100, "32M")}
DESKD_UID, KIOSK_UID = 1100, 1102
REQUEST = re.compile(r"\A(start|stop|freeze|thaw) ([a-z-]+)\n\Z")
SHUTTING_DOWN = threading.Event()
BROWSER_STOPPING = threading.Event()
XAUTH = "/run/desk-xorg/auth"
BROWSER_START = "/usr/local/lib/ma/desk-browser-start"
SLOT = os.environ.get("DESK_HOST_SLOT", "0")
TEST_DIR = "/desk-host-test"


def log(*a):
    print(f"[desk-init {time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def mkdir(path, user, group, mode):
    os.makedirs(path, exist_ok=True)
    os.chown(path, pwd.getpwnam(user).pw_uid if isinstance(user, str) else user, grp.getgrnam(group).gr_gid if isinstance(group, str) else group)
    os.chmod(path, mode)


class Unit:
    """One systemd service, as far as these units use systemd. Started by desk-init, so under the unit filter."""

    def __init__(self, name, argv, user, group=None, groups=(), env=None, cwd="/", restart="on-failure", restart_sec=2,
                 prevent=(), stop_timeout=30, post=None, runtime_dirs=(), umask=0o022, requires=(), wants=(), keep_runtime=False,
                 ambient_bind=False):
        self.name, self.argv, self.user, self.group, self.groups = name, argv, user, group or user, groups
        self.env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", **(env or {})}
        self.cwd, self.restart, self.restart_sec, self.prevent, self.stop_timeout = cwd, restart, restart_sec, set(prevent), stop_timeout
        self.post, self.runtime_dirs, self.umask, self.requires, self.wants, self.keep_runtime = post, runtime_dirs, umask, requires, wants, keep_runtime
        self.ambient_bind = ambient_bind
        self.proc = None
        self.wanted = False
        self.lock = threading.RLock()
        self.restarts = 0

    def _cgroup(self):
        try:
            with open(f"{CG}/{self.name}/cgroup.procs", "w") as fh:
                fh.write("0")
        except OSError:
            pass

    def _preexec(self):
        self._cgroup()
        uid = pwd.getpwnam(self.user).pw_uid if isinstance(self.user, str) else self.user
        gid = grp.getgrnam(self.group).gr_gid if isinstance(self.group, str) else self.group
        os.setgroups([grp.getgrnam(g).gr_gid for g in self.groups])
        os.setgid(gid)
        os.setuid(uid)
        os.umask(self.umask)
        os.setsid()

    def _spawn(self):
        if self.name == "desk-xorg":
            xauth_cookie()
        for d in self.runtime_dirs:
            if not self.keep_runtime and os.path.isdir(d):
                run_helper(["rm", "-rf", "--one-file-system", d])
            mkdir(d, self.user, self.group, 0o700 if d == "/run/desk-xorg" else 0o755)
        out = open(f"{LOG_DIR}/{self.name}.log", "ab", buffering=0)
        out.write(f"--- start {time.strftime('%F %T')}\n".encode())
        if self.ambient_bind:
            argv = ["/usr/bin/setpriv", f"--reuid={self.user}", f"--regid={self.group}", "--groups=" + ",".join(self.groups) if self.groups else "--clear-groups",
                    "--inh-caps=+net_bind_service", "--ambient-caps=+net_bind_service", "--no-new-privs", "--"] + self.argv
            self.proc = subprocess.Popen(argv, env=self.env, cwd=self.cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                         preexec_fn=lambda: (self._cgroup(), os.umask(self.umask), os.setsid()))
        else:
            self.proc = subprocess.Popen(self.argv, env=self.env, cwd=self.cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                         preexec_fn=self._preexec)
        out.close()
        log(f"{self.name} started pid {self.proc.pid}")
        threading.Thread(target=self._watch, args=(self.proc,), daemon=True).start()
        if self.post:
            r = subprocess.run(self.post, env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, preexec_fn=self._preexec)
            with open(f"{LOG_DIR}/{self.name}.log", "a") as fh:
                fh.write(f"--- post exit {r.returncode}\n{r.stdout}{r.stderr}")
            if r.returncode != 0:
                log(f"{self.name} ExecStartPost failed {r.returncode}")
                return False
        return True

    def _watch(self, proc):
        rc = proc.wait()
        with self.lock:
            if proc is not self.proc:
                return
            log(f"{self.name} exited {rc}")
            self.proc = None
            if not self.wanted:
                return
            again = self.restart == "always" or (self.restart == "on-failure" and rc != 0 and rc not in self.prevent)
            if not again:
                self.wanted = False
                return
        time.sleep(self.restart_sec)
        with self.lock:
            if self.wanted and self.proc is None and not SHUTTING_DOWN.is_set():
                self.restarts += 1
                self._spawn()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        if SHUTTING_DOWN.is_set():
            return False
        for dep in self.requires + self.wants:
            UNITS[dep].start()
        with self.lock:
            self.wanted = True
            if self.running():
                return True
            return self._spawn()

    def stop(self):
        for other in UNITS.values():  # stop what requires this unit first
            if self.name in getattr(other, "requires", ()) and other.running():
                other.stop()
        with self.lock:
            self.wanted = False
            p = self.proc
        if p is None:
            return True
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            p.wait(self.stop_timeout)
        except subprocess.TimeoutExpired:
            log(f"{self.name} did not stop in {self.stop_timeout} s, SIGKILL")
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.wait()
        log(f"{self.name} stopped")
        return True


# ---- the browser launcher (WALL-01): kiosk, in desk-browser's cgroup, the container's filter only
def _send_fd(sock, msg, fd):
    sock.sendmsg([msg], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])


def _recv_fd(sock):
    fds = array.array("i")
    msg, anc, _flags, _addr = sock.recvmsg(64, socket.CMSG_LEN(fds.itemsize))
    for level, typ, data in anc:
        if level == socket.SOL_SOCKET and typ == socket.SCM_RIGHTS:
            fds.frombytes(data[:len(data) - (len(data) % fds.itemsize)])
    return msg, (fds[0] if fds else None)


def launcher_main(sock, env):
    """The launcher: one request, "start" (with the log's descriptor), answered "pid <n>"; every exit reported "exit <pid> <rc>"."""
    children = set()
    while True:
        r, _, _ = select.select([sock], [], [], 0.5)
        while True:   # reap
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                break
            if pid in children:
                children.discard(pid)
                rc = os.waitstatus_to_exitcode(status)
                try:
                    sock.send(f"exit {pid} {rc if rc >= 0 else 128 - rc}".encode())
                except OSError:
                    os._exit(0)
        if not r:
            continue
        try:
            msg, fd = _recv_fd(sock)
        except OSError:
            os._exit(0)
        if not msg:
            os._exit(0)   # desk-init has gone: the desk is stopping
        if msg != b"start" or fd is None:
            if fd is not None:
                os.close(fd)
            sock.send(b"err bad_request")
            continue
        pid = os.fork()
        if pid == 0:
            try:
                os.dup2(fd, 1)
                os.dup2(fd, 2)
                null = os.open("/dev/null", os.O_RDONLY)
                os.dup2(null, 0)
                os.setsid()
                os.umask(0o022)
                os.execve(BROWSER_START, [BROWSER_START], env)
            finally:
                os._exit(127)
        os.close(fd)
        children.add(pid)
        sock.send(f"pid {pid}".encode())


def start_launcher(env):
    """Forked before desk-init's own filter, so it doesn't carry the unit filter; drops to kiosk before it serves anything."""
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    pid = os.fork()
    if pid == 0:
        try:
            parent.close()
            _LIBC.prctl(15, b"desk-launcher", 0, 0, 0)   # PR_SET_NAME: its comm, so the host's view names it
            with open(f"{CG}/desk-browser/cgroup.procs", "w") as fh:
                fh.write("0")
            keep = child.fileno()
            os.closerange(3, keep)
            os.closerange(keep + 1, 65536)
            kiosk = pwd.getpwnam("kiosk")
            os.setgroups([grp.getgrnam("desk-audio").gr_gid])
            os.setgid(kiosk.pw_gid)
            os.setuid(kiosk.pw_uid)
            os.chdir("/")
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            launcher_main(child, env)
        finally:
            os._exit(1)
    child.close()
    log(f"browser launcher pid {pid}: kiosk, desk-browser's cgroup, no unit filter (Chromium's sandbox)")
    return pid, parent


class BrowserUnit:
    """desk-browser, started through the launcher. desk-init can signal it (root) but not wait for it: the launcher reports."""

    def __init__(self, sock, launcher_pid):
        self.name, self.requires, self.wants = "desk-browser", ("desk-xorg", "desk-audio"), ()
        self.sock, self.launcher_pid = sock, launcher_pid
        self.pid, self.wanted, self.restarts = None, False, 0
        self.lock = threading.RLock()
        self.exited = {}
        self.cv = threading.Condition()
        self.replies = []
        self.restart_sec, self.prevent, self.stop_timeout = 3, {78}, 30
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                msg = self.sock.recv(64).decode()
            except OSError:
                return
            if not msg:
                log("browser launcher gone")
                return
            f = msg.split()
            with self.cv:
                if f[0] == "exit":
                    self.exited[int(f[1])] = int(f[2])
                else:
                    self.replies.append(msg)
                self.cv.notify_all()
            if f[0] == "exit":
                threading.Thread(target=self._on_exit, args=(int(f[1]), int(f[2])), daemon=True).start()

    def _on_exit(self, pid, rc):
        with self.lock:
            if pid != self.pid:
                return
            log(f"desk-browser exited {rc}")
            self.pid = None
            if not self.wanted:
                return
            if rc == 0 or rc in self.prevent:
                self.wanted = False
                return
        time.sleep(self.restart_sec)
        with self.lock:
            if self.wanted and self.pid is None and not SHUTTING_DOWN.is_set() and not BROWSER_STOPPING.is_set():
                self.restarts += 1
                self._spawn()

    def _spawn(self):
        out = os.open(f"{LOG_DIR}/desk-browser.log", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC, 0o640)
        os.write(out, f"--- start {time.strftime('%F %T')}\n".encode())
        with self.cv:
            self.replies.clear()
            _send_fd(self.sock, b"start", out)
            self.cv.wait_for(lambda: self.replies, timeout=10)
            reply = self.replies.pop(0) if self.replies else "none"
        os.close(out)
        if not reply.startswith("pid "):
            log(f"desk-browser: launcher said {reply}")
            return False
        self.pid = int(reply.split()[1])
        log(f"desk-browser started pid {self.pid} (through the launcher, without the unit filter: Chromium's sandbox)")
        return True

    def running(self):
        with self.cv:
            return self.pid is not None and self.pid not in self.exited

    def start(self):
        if SHUTTING_DOWN.is_set() or BROWSER_STOPPING.is_set():
            return False
        for dep in self.requires:
            UNITS[dep].start()
        with self.lock:
            self.wanted = True
            if self.running():
                return True
            return self._spawn()

    def wait(self, pid, timeout):
        with self.cv:
            return self.cv.wait_for(lambda: pid in self.exited, timeout=timeout)

    def stop(self):
        with self.lock:
            self.wanted = False
            pid = self.pid
        if pid is None or not self.running():
            return True
        thaw_browser()   # a frozen Chromium can't take a signal's handler (T46L-2)
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if not self.wait(pid, self.stop_timeout):
            log(f"desk-browser did not stop in {self.stop_timeout} s, SIGKILL")
            thaw_browser()
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.wait(pid, 10)
        log("desk-browser stopped")
        return True


PULSE_ENV = {"PULSE_RUNTIME_PATH": "/run/desk-audio/pulse", "HOME": "/run/desk-audio/pulse", "XDG_RUNTIME_DIR": "/run/desk-audio/pulse"}
UNITS = {
    "desk-agent-filter": Unit("desk-agent-filter", ["/opt/ma/desk-agent-filter/current/run"], "agent-filter",
                              env={"RELEASE_DIR": "/opt/ma/desk-agent-filter/current", "GOMEMLIMIT": "20MiB", "GOMAXPROCS": "2"},
                              restart="always", restart_sec=1, stop_timeout=5, umask=0o077),
    "desk-dns": Unit("desk-dns", ["/usr/bin/python3", "-I", "/desk-host/desk-dns.py"], "desk-dns", restart="always", restart_sec=1, ambient_bind=True),
    "desk-xorg": Unit("desk-xorg", ["/usr/lib/xorg/Xorg", ":99", "-config", "/etc/ma/xorg-dummy.conf", "-noreset", "-nolisten", "tcp",
                                    "-nolisten", "local", "-auth", XAUTH,
                                    "-logfile", "/run/desk-xorg/Xorg.99.log", "-novtswitch", "-sharevts"], "desk-x",
                      env={"DISPLAY": ":99", "XAUTHORITY": XAUTH}, runtime_dirs=("/run/desk-xorg",), keep_runtime=True,
                      post=["/bin/sh", "-c", "/usr/local/lib/ma/desk-xorg-ready && xhost +SI:localuser:kiosk"]),
    "desk-audio": Unit("desk-audio", ["/usr/bin/pulseaudio", "--daemonize=no", "--exit-idle-time=-1", "--log-target=stderr", "-n",
                                      "--disallow-module-loading=yes",
                                      "--load=module-null-sink sink_name=desk sink_properties=device.description=desk",
                                      "--load=module-native-protocol-unix socket=/run/desk-audio/native auth-anonymous=0 auth-cookie-enabled=0 "
                                      "auth-group=desk-audio auth-group-enable=1"], "desk-snd",
                       env=PULSE_ENV, runtime_dirs=("/run/desk-audio/pulse",),
                       post=["/bin/sh", "-c", "export PULSE_SERVER=unix:/run/desk-audio/native; for i in $(seq 1 40); do pactl info >/dev/null 2>&1 && exec pactl set-default-sink desk; sleep 0.5; done; exit 1"]),
}
ON_DEMAND = {"desk-xorg", "desk-audio", "desk-browser", "desk-stream"}


class RemoteUnit:
    """A unit whose process runs in its own sandbox, started and stopped there by desk-svc over its control socket."""

    def __init__(self, name, requires=(), wants=()):
        self.name, self.requires, self.wants, self.sock = name, requires, wants, f"/run/desk-ctl/{name}.sock"

    def _ask(self, verb):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(45)
        try:
            s.connect(self.sock)
            s.sendall(verb.encode() + b"\n")
            return s.recv(200).decode().strip()
        except OSError as e:
            return f"err {e}"
        finally:
            s.close()

    def start(self):
        if SHUTTING_DOWN.is_set():
            return False
        for dep in self.requires + self.wants:
            UNITS[dep].start()
        r = self._ask("start")
        log(f"{self.name} (sandbox): start -> {r}")
        return r.startswith("ok")

    def stop(self):
        r = self._ask("stop")
        log(f"{self.name} (sandbox): stop -> {r}")
        return r.startswith("ok")

    def running(self):
        return "running=true" in self._ask("status")


UNITS["desk-stream"] = RemoteUnit("desk-stream", requires=("desk-xorg",), wants=("desk-audio",))


def xauth_cookie():
    """DA-1: a fresh MIT-MAGIC-COOKIE-1 for display 99, 0600 desk-x, before every start of Xorg (desk-xauth's format)."""
    mkdir("/run/desk-xorg", "desk-x", "desk-x", 0o700)
    rec = struct.pack(">H", 0xFFFF) + b"".join(struct.pack(">H", len(f)) + f for f in (b"", b"99", b"MIT-MAGIC-COOKIE-1", os.urandom(16)))
    tmp = XAUTH + ".new"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.write(fd, rec)
    os.fchown(fd, pwd.getpwnam("desk-x").pw_uid, grp.getgrnam("desk-x").gr_gid)
    os.close(fd)
    os.rename(tmp, XAUTH)


def cdp_close():
    """RC-05: Browser.close over CDP as root on 127.0.0.1:9222 or [::1]:9222, as desk-browser-close does. True once sent."""
    import base64
    import json
    import urllib.parse
    import urllib.request
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for h in ("127.0.0.1", "[::1]"):
        try:
            ws = urllib.parse.urlsplit(json.load(op.open(f"http://{h}:9222/json/version", timeout=3))["webSocketDebuggerUrl"])
            s = socket.create_connection((ws.hostname, ws.port), timeout=5)
            s.sendall((f"GET {ws.path} HTTP/1.1\r\nHost: {ws.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            b = b""
            while b"\r\n\r\n" not in b:
                d = s.recv(4096)
                if not d:
                    raise EOFError
                b += d
            if b.split(b" ", 2)[1] != b"101":
                raise ConnectionError
            m = json.dumps({"id": 1, "method": "Browser.close"}).encode()
            k = os.urandom(4)
            s.sendall(b"\x81" + bytes([0x80 | len(m)]) + k + bytes(c ^ k[i % 4] for i, c in enumerate(m)))
            try:
                s.recv(4096)
            except OSError:
                pass
            s.close()
            return True
        except (OSError, ValueError, KeyError, IndexError, TypeError, EOFError):
            continue
    return False


# ---- freeze and thaw (ADR 0045 on a shared host, T46L-2): desk-units' own code, the template's copy, the host's file
DU = None


def browser_cgroup():
    """The browser's cgroup, from the launcher's pid (it lives in desk-browser's cgroup with Chromium), not a fixed path."""
    try:
        for line in open(f"/proc/{BROWSER.launcher_pid}/cgroup"):
            if line.startswith("0::"):
                return CG + line.strip()[3:]
    except OSError:
        pass
    return f"{CG}/desk-browser"


def load_desk_units():
    global DU
    path = "/desk-host/desk-units.py"
    loader = importlib.machinery.SourceFileLoader("desk_units", path)
    spec = importlib.util.spec_from_loader("desk_units", loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    m.BROWSER_CGROUP = browser_cgroup()
    m.DOWNLOADS = "/data/browser/downloads"
    # desk-units asks systemd whether desk-browser runs and whether a stop of it is queued; here desk-init knows both
    m.systemctl = lambda *a, timeout=5: subprocess.CompletedProcess(a, 0 if BROWSER.running() else 3, "", "")
    m.jobs_check = lambda: None
    m.stopping = lambda _proc: BROWSER_STOPPING.is_set() or SHUTTING_DOWN.is_set()
    m.reap = lambda _proc: None
    DU = m


def thaw_browser():
    """Thaws desk-browser under desk-units' lock (the one a freeze holds), so no freeze lands after it (T46L-1, T46L-2)."""
    if DU is None:
        return
    try:
        lock = DU.lock_browser()
    except OSError:
        lock = None
    try:
        DU.thaw_quietly()
    finally:
        if lock is not None:
            os.close(lock)


UNIT_LOCK = threading.Lock()   # one units.sock request at a time, so a stop can wait for one in flight


def browser_refusal():
    r = run_helper(["/usr/bin/setpriv", "--reuid=1102", "--regid=1102", "--clear-groups", BROWSER_START, "--check"],
                   capture_output=True, text=True, timeout=10)
    return " ".join((r.stderr or "").split())[:200] if r.returncode == 78 else None


def handle(conn):
    """desk-units, line for line in behaviour (image/recipe/files/usr/local/lib/ma/desk-units), freeze and thaw included."""
    with conn:
        uid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
        if uid != DESKD_UID:
            conn.sendall(b"err denied only deskd may use this socket\n")
            return
        conn.settimeout(5)
        data = b""
        try:
            while b"\n" not in data and len(data) <= 64:
                chunk = conn.recv(65 - len(data))
                if not chunk:
                    break
                data += chunk
        except OSError:
            return
        m = REQUEST.match(data.decode("ascii", "replace")) if len(data) <= 64 else None
        if m is None:
            conn.sendall(b"err bad_request expected: start|stop|freeze|thaw <unit>\n")
            return
        verb, unit = m.groups()
        if unit not in ON_DEMAND or (verb in ("freeze", "thaw") and unit != "desk-browser"):
            conn.sendall(b"err denied unit not allowed\n")
            return
        t0 = time.monotonic()
        if verb in ("freeze", "thaw"):
            if verb == "freeze" and (SHUTTING_DOWN.is_set() or BROWSER_STOPPING.is_set()):
                conn.sendall(b"err busy stopping\n")
                return
            try:
                DU.BROWSER_CGROUP = browser_cgroup()
                err = DU.freeze(unit) if verb == "freeze" else DU.thaw(unit)
            except OSError as e:
                err = ("failed", f"{verb} {unit}: {type(e).__name__}")
            log(f"units.sock: {verb} {unit}: {err[0] if err else 'ok'} in {round((time.monotonic() - t0) * 1000)} ms")
            conn.sendall(f"err {err[0]} {err[1]}\n".encode() if err else b"ok\n")
            return
        with UNIT_LOCK:
            if SHUTTING_DOWN.is_set() and verb == "start":
                conn.sendall(f"err failed start {unit}: the desk is stopping\n".encode())
                return
            if verb == "start" and unit == "desk-browser":
                refusal = browser_refusal()
                if refusal:
                    conn.sendall(f"err failed start desk-browser: {refusal}\n".encode())
                    return
            try:
                if unit in ("desk-browser", "desk-xorg", "desk-audio") and verb == "stop":
                    BROWSER_STOPPING.set()
                try:
                    ok = UNITS[unit].start() if verb == "start" else UNITS[unit].stop()
                finally:
                    BROWSER_STOPPING.clear()
            except Exception as e:  # noqa: BLE001 - reported to deskd like a failed systemctl
                log(f"{verb} {unit}: {e}")
                ok = False
        log(f"units.sock: {verb} {unit}: {'ok' if ok else 'failed'} in {round((time.monotonic() - t0) * 1000)} ms")
        conn.sendall(b"ok\n" if ok else f"err failed {verb} {unit}\n".encode())


def serve_units():
    path = "/run/desk/units.sock"
    if os.path.exists(path):
        os.unlink(path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chown(path, DESKD_UID, grp.getgrnam("desk").gr_gid)
    os.chmod(path, 0o600)
    s.listen(8)
    while True:
        c, _ = s.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()


def datadirs():
    """desk-datadirs and tmpfiles.d/ma.conf. A service directory the desk's root turned into a link is replaced (the host
    refused to mount it: mounts.py)."""
    for d in ("/data/desk", "/data/rtc", "/data/agent", "/data/notebook", "/data/browser", "/data/.ma-export-tmp"):
        if os.path.islink(d) or (os.path.lexists(d) and not os.path.isdir(d)):
            log(f"{d} isn't a directory (a link?): replaced by an empty one; the host refused to mount it")
            os.unlink(d)
    mkdir("/data/desk", "desk", "desk", 0o750)
    mkdir("/data/rtc", "rtc", "rtc", 0o700)
    mkdir("/data/browser", "kiosk", "kiosk", 0o750)
    mkdir("/data/browser/profile", "kiosk", "kiosk", 0o700)
    mkdir("/data/browser/downloads", "kiosk", "kiosk", 0o750)
    mkdir("/data/browser/home", "kiosk", "kiosk", 0o700)
    mkdir("/data/agent", "agent", "agent", 0o700)
    mkdir("/data/notebook", "notebook", "notebook", 0o700)
    mkdir("/data/.ma-export-tmp", "desk-data", "desk-data", 0o700)   # desk-data's scratch, its own uid (WALL-06)
    mkdir("/run/desk-audio", "desk-snd", "desk-audio", 0o750)
    mkdir("/var/tmp", 0, 0, 0o1777)
    mkdir("/root", 0, 0, 0o700)
    if not os.path.exists("/data/.ma-volume"):
        with open("/data/.ma-volume", "w") as fh:
            fh.write('{"volumeId":null,"formattedAt":null,"firstSeenAt":"%s"}\n' % time.strftime("%FT%TZ", time.gmtime()))
    run_helper(["install", "-o", "desk", "-g", "desk", "-m", "0644", "/data/.ma-volume", "/data/desk/volume.json"])


def cgroups():
    """Moves docker-init and this process into a leaf, turns on cpu, memory and pids for the children, then one child per unit."""
    os.makedirs(f"{CG}/init", exist_ok=True)
    for pid in ("1", str(os.getpid())):
        with open(f"{CG}/init/cgroup.procs", "w") as fh:
            fh.write(pid)
    with open(f"{CG}/cgroup.subtree_control", "w") as fh:
        fh.write("+cpu +memory +pids")
    for name, (weight, mmax) in CGROUPS.items():
        os.makedirs(f"{CG}/{name}", exist_ok=True)
        for f, v in (("cpu.weight", str(weight)), ("memory.max", mmax)):
            with open(f"{CG}/{name}/{f}", "w") as fh:
                fh.write(v)
    log("cgroups:", ", ".join(f"{n} {w}/{m}" for n, (w, m) in CGROUPS.items()))


def wait_network():
    for _ in range(300):
        if any(line.split()[1] == "00000000" for line in open("/proc/net/route").read().splitlines()[1:] if len(line.split()) > 1):
            return True
        time.sleep(0.2)
    log("no default route after 60 s")
    return False


def exit_type():
    try:
        m = re.search(r'"exit_type":"([A-Za-z]*)"', open("/data/browser/profile/Default/Preferences").read())
        return m.group(1) if m else "none"
    except OSError:
        return "none"


def shutdown(*_):
    """WALL-02: the host's only stop is SIGTERM (runc kill), after deskd's sandbox has stopped, so nothing can start Chromium
    again (a units.sock start in flight finishes first, later ones are refused). Then Chromium: thawed (T46L-2), asked to quit
    over CDP (Browser.close), which commits cookies the 30 s timer hasn't (RC-05), up to 31 s, then SIGTERM with 30 s; then
    sync /data before anything reports it stopped."""
    if SHUTTING_DOWN.is_set():
        return
    SHUTTING_DOWN.set()
    log("SIGTERM: closing the desk (the browser, then the rest)")
    br = UNITS["desk-browser"]
    before = "active" if br.running() else "inactive"
    quit_how = "none"
    with UNIT_LOCK:
        with br.lock:
            br.wanted = False
            pid = br.pid
        if pid is not None and br.running():
            thaw_browser()
            quit_how = "term"
            if cdp_close():
                if br.wait(pid, 31):
                    quit_how = "cdp"
            else:
                time.sleep(31)
        br.stop()
    after = "active" if br.running() else "inactive"
    synced = "ok" if run_helper(["sync", "-f", "/data"]).returncode == 0 else "failed"
    log(f"desk-browser-close: browser={before}->{after} exit_type={exit_type()} deskd=inactive quit={quit_how} sync={synced}")
    for name in ("desk-stream", "desk-audio", "desk-xorg", "desk-agent-filter", "desk-dns"):
        try:
            UNITS[name].stop()
        except Exception as e:  # noqa: BLE001
            log(f"stop {name}: {e}")
    log("stopped")
    os._exit(0)


def test_tools():
    """A test host's CDP forward (WR2-01): only with the host's own flag in /run/desk-host and its file in /desk-host-test."""
    if os.path.exists("/run/desk-host/test-cdp") and os.path.isfile(f"{TEST_DIR}/cdp_forward.py"):
        loader = importlib.machinery.SourceFileLoader("cdp_forward", f"{TEST_DIR}/cdp_forward.py")
        spec = importlib.util.spec_from_loader("cdp_forward", loader)
        m = importlib.util.module_from_spec(spec)
        loader.exec_module(m)
        threading.Thread(target=m.serve, args=(int(SLOT), log), daemon=True).start()
        log("TEST HOST: the CDP forward is on (the host's side of the veth only)")


BROWSER = None


def main():
    global BROWSER
    os.makedirs(LOG_DIR, exist_ok=True)
    cgroups()
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "DISPLAY": ":99",
           "HOME": "/data/browser/home", "PULSE_SERVER": "unix:/run/desk-audio/native"}
    if os.path.exists("/run/desk-host/test-probe") and os.path.isfile(f"{TEST_DIR}/wall01probe.so"):
        env["LD_PRELOAD"] = f"{TEST_DIR}/wall01probe.so"   # a test host's probe inside Chromium (WALL-01's proof)
        env["WALL01_PROBE_SLOT"] = SLOT
    launcher_pid, sock = start_launcher(env)
    unit_filter_self()   # from here desk-init and all it starts carry the unit filter (WALL-01)
    log("desk-init: unit filter on (every thread); the launcher and Chromium's tree are the only ones without it")
    BROWSER = BrowserUnit(sock, launcher_pid)
    UNITS["desk-browser"] = BROWSER
    load_desk_units()
    signal.signal(signal.SIGTERM, lambda *a: threading.Thread(target=shutdown).start())
    signal.signal(signal.SIGINT, lambda *a: threading.Thread(target=shutdown).start())
    datadirs()
    threading.Thread(target=serve_units, daemon=True).start()
    wait_network()
    test_tools()
    for name in ("desk-dns", "desk-agent-filter"):
        UNITS[name].start()
    log("up: the Agent filter and its resolver started here; deskd, desk-agent, desk-notebook, desk-rtc and desk-data run in their "
        "own sandboxes, desk-stream's waits for units.sock; on-demand units wait for units.sock")
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--exec-filtered":
        unit_filter()
        os.execvp(sys.argv[2], sys.argv[2:])
    main()
