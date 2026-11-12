#!/usr/bin/python3 -I
"""A shared host's slot does what desk image 0.3.5 does through its units (sub/host-parity-035). A slot's root is the template, the
desk image's own root, but systemd doesn't run there: desk-init.py and svc-spec.py start everything, so what 0.3.5 does in a unit
file has to be done the slot's way. No root, no host:

- Links out (desk-runtime.md section 8.11): the template's tmpfiles line, d /run/desk-links 2750 desk kiosk, is a share of the slot
  (wallspec.py), made by the host before any desk process with the slot's ids, bound into the desk (where Chromium's xdg-open
  stand-in runs as kiosk) and into deskd's sandbox alone (where deskd binds links.sock). Up to host 0.1.14 neither had it, so the
  stand-in exited 3 and links out did nothing on a shared host.
- The Browser's policy: desk-browser.service's ExecStartPre=+ desk-browser-policy (a teen's lock, an adult's allowlist of the three
  password managers) runs before every start of Chromium in a slot, crash restarts included, as the desk's root; a helper that fails
  (exit 1, can't run, doesn't end) is no start, and the start is tried again after the back-off's wait, as Restart= does. Up to
  0.1.14 desk-init never ran it: a teen's slot had no lock and an adult's no allowlist.
- JPEG XL off and the Agent's egress come with the template; these only confirm it (they pass on 0.1.14 too).

python3 -I image/tests/test_host_slot_parity.py
Against another host tree (0.1.14's fails the links and policy tests):
  HOST_LIB=<dir with desk-init.py under desk/, wallspec.py, svc-spec.py, desk-spec.py> python3 -I image/tests/test_host_slot_parity.py
  where the dir is `git archive 950995e2 image/host/recipe/files/usr/local/lib/desk-host` unpacked.
"""
import array
import ast
import copy
import errno
import grp
import importlib.util
import json
import os
import pathlib
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
LIB = pathlib.Path(os.environ.get("HOST_LIB") or IMAGE / "host/recipe/files/usr/local/lib/desk-host")
DESK = IMAGE / "recipe/files"   # the desk image's recipe: the template's own files
DOCKER = {
    "process": {"capabilities": {k: ["CAP_CHOWN", "CAP_NET_RAW"] for k in ("bounding", "effective", "permitted")}}, "hooks": {}, "annotations": {}, "root": {},
    "mounts": [{"destination": d, "type": "x", "source": "x", "options": []} for d in ("/proc", "/dev", "/dev/pts", "/sys")],
    "linux": {"seccomp": {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": [], "architectures": []}, "maskedPaths": [], "resources": {"devices": []},
              "uidMappings": [], "gidMappings": [], "sysctl": {}},
}
USERS = {"desk": 1100, "rtc": 1101, "kiosk": 1102, "agent": 1103, "stream": 1104, "notebook": 1105, "agent-filter": 1106,
         "desk-x": 1107, "desk-snd": 1108, "desk-dns": 1109, "desk-data": 1112}
GROUPS = dict(USERS, **{"desk-audio": 1111})


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Template:
    """A slot's template generation as svc-spec.py reads it: /srv/desk-host/templates/g1 with the desk's users, a record for slot k."""

    def __init__(self, case, k=3):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        case.addCleanup(shutil.rmtree, self.tmp, True)
        t = self.tmp / "templates/g1/etc"
        t.mkdir(parents=True)
        (t.parent / ".complete").write_text("gen=g1\n")
        (t / "passwd").write_text("".join(f"{n}:x:{i}:{i}::/:/bin/false\n" for n, i in USERS.items()))
        (t / "group").write_text("".join(f"{n}:x:{i}:\n" for n, i in GROUPS.items()))
        (self.tmp / "slots").mkdir()
        (self.tmp / "slots" / f"{k}.json").write_text(json.dumps({"slot": k, "state": "desk", "template": "g1"}))
        old = os.environ.get("DESK_HOST_RECORDS")
        os.environ["DESK_HOST_RECORDS"] = str(self.tmp / "slots")
        case.addCleanup(lambda: os.environ.pop("DESK_HOST_RECORDS") if old is None else os.environ.__setitem__("DESK_HOST_RECORDS", old))
        sys.path.insert(0, str(LIB))
        case.addCleanup(sys.path.remove, str(LIB))
        sys.modules.pop("wallspec", None)
        import wallspec
        case.addCleanup(sys.modules.pop, "wallspec", None)
        wallspec.DH = str(self.tmp)
        wallspec.docker_spec = lambda: copy.deepcopy(DOCKER)
        wallspec.test_mode = lambda: False
        self.wallspec = wallspec
        self.svc = load_file("svc_spec_parity", LIB / "svc-spec.py")


def binds_at(spec, inside):
    return [m for m in spec["mounts"] if m["destination"] == inside]


class LinksShare(unittest.TestCase):
    K = 3

    def setUp(self):
        self.t = Template(self, self.K)

    def test_desk_links_is_a_share_as_the_template_s_tmpfiles_line_says(self):
        shares = self.t.wallspec.shares(self.K)
        self.assertIn("desk-links", shares, "no /run/desk-links share: the slot's deskd can't listen and the stand-in exits 3 (links out do nothing)")
        line = [l.split() for l in (DESK / "etc/tmpfiles.d/desk-links.conf").read_text().splitlines() if l.strip() and not l.startswith("#")][0]
        self.assertEqual(line[:5], ["d", "/run/desk-links", "2750", "desk", "kiosk"], "the desk image's own line changed")
        self.assertEqual(shares["desk-links"], ("/run/desk-links", "desk", "kiosk", 0o2750))

    def test_the_host_makes_it_with_the_slot_s_ids_and_the_setgid_bit(self):
        self.assertIn("desk-links", self.t.wallspec.shares(self.K))
        d = self.t.tmp / "share"
        d.mkdir()
        made = {}
        real_chown = os.chown
        os.chown = lambda p, u, g: made.__setitem__(os.path.basename(p), (u, g))
        self.addCleanup(setattr, os, "chown", real_chown)
        out = sys.stdout
        sys.stdout = open(os.devnull, "w")
        try:
            self.t.svc.make_shares(self.K, str(d))
        finally:
            sys.stdout.close()
            sys.stdout = out
        base = 100000 + self.K * 65536
        self.assertEqual(made["desk-links"], (base + USERS["desk"], base + GROUPS["kiosk"]))
        self.assertEqual(stat.S_IMODE(os.stat(d / "desk-links").st_mode), 0o2750)

    def test_deskd_s_sandbox_binds_it_and_no_other_sandbox(self):
        src = f"/run/desk-host/share/{self.K}/desk-links"
        for svc in self.t.svc.SERVICES:
            got = binds_at(self.t.svc.spec(self.K, svc), "/run/desk-links")
            if svc == "deskd":
                self.assertEqual(len(got), 1, "deskd's sandbox has no /run/desk-links: deskd doesn't listen (its run mounts it only when it exists)")
                self.assertEqual((got[0]["type"], got[0]["source"]), ("bind", src))
                self.assertIn("rw", got[0]["options"])
                self.assertIn("noexec", got[0]["options"])
            else:
                self.assertEqual(got, [], f"{svc} has no business with links.sock")

    def test_the_desk_container_binds_it_where_chromium_s_stand_in_looks(self):
        bundle = self.t.tmp / "bundle"
        g = {"__name__": "__main__", "__file__": str(LIB / "desk-spec.py")}
        argv = sys.argv
        sys.argv = ["desk-spec.py", str(self.K), str(bundle)]
        self.addCleanup(setattr, sys, "argv", argv)
        out = sys.stdout
        sys.stdout = open(os.devnull, "w")
        try:
            exec(compile((LIB / "desk-spec.py").read_text(), "desk-spec.py", "exec"), g)
        finally:
            sys.stdout.close()
            sys.stdout = out
        spec = json.loads((bundle / "config.json").read_text())
        got = binds_at(spec, "/run/desk-links")
        self.assertEqual(len(got), 1, "the desk has no /run/desk-links: Chromium's xdg-open stand-in can't reach deskd")
        self.assertEqual(got[0]["source"], f"/run/desk-host/share/{self.K}/desk-links")
        self.assertIn("rw", got[0]["options"])

    def test_the_stand_in_s_socket_path_is_the_share_s(self):
        self.assertIn('"/run/desk-links/links.sock"', (DESK / "usr/local/bin/xdg-open").read_text())


# ---- desk-init.py's Browser: its named top-level statements, run in a namespace of their own (desk-init as a whole starts a desk)
def top_names(node):
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, ast.Assign):
        return {e.id for t in node.targets for e in (t.elts if isinstance(t, ast.Tuple) else [t]) if isinstance(e, ast.Name)}
    return set()


def load_init(names, **over):
    path = LIB / "desk/desk-init.py"
    src = path.read_text()
    lines = src.splitlines(keepends=True)
    code = "\n".join("".join(lines[n.lineno - 1:n.end_lineno]) for n in ast.parse(src).body if top_names(n) & set(names))
    g = {"__name__": "desk_init_part", "os": os, "re": re, "stat": stat, "errno": errno, "grp": grp, "pwd": pwd, "socket": socket,
         "subprocess": subprocess, "threading": threading, "time": time, "sys": sys, "array": array}
    g.update(over)
    exec(compile(code, str(path), "exec"), g)
    for k, v in over.items():   # the file's own assignments don't win over the test's
        g[k] = v
    return g


class FakeLauncher:
    """The launcher's end of the socketpair: answers "start" with a pid, records each start, sends an exit when asked."""

    def __init__(self, sock):
        self.sock, self.starts, self.pid = sock, [], 4000
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            fds = array.array("i")
            try:
                msg, anc, _f, _a = self.sock.recvmsg(64, socket.CMSG_LEN(fds.itemsize))
            except OSError:
                return
            if not msg:
                return
            for level, typ, data in anc:
                if level == socket.SOL_SOCKET and typ == socket.SCM_RIGHTS:
                    fds.frombytes(data[:len(data) - (len(data) % fds.itemsize)])
            for fd in fds:
                os.close(fd)
            if msg == b"start":
                self.pid += 1
                self.starts.append((self.pid, time.monotonic()))
                self.sock.send(f"pid {self.pid}".encode())

    def exit(self, pid, rc):
        self.sock.send(f"exit {pid} {rc}".encode())


class BrowserPolicy(unittest.TestCase):
    NAMES = ["RESTART_CAP", "backoff_delay", "Backoff", "_send_fd", "BrowserUnit", "browser_policy", "BROWSER_POLICY", "POLICY_TIMEOUT"]

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.calls, self.events, self.rc = [], [], [0]
        self.logged = []

        def run_helper(argv, **kw):
            self.calls.append((argv, kw))
            self.events.append(("policy", time.monotonic()))
            rc = self.rc[0]
            if isinstance(rc, BaseException):
                raise rc
            return subprocess.CompletedProcess(argv, rc, None, None)

        dep = types.SimpleNamespace(start=lambda: True, running=lambda: True)
        self.g = load_init(self.NAMES, LOG_DIR=self.tmp, run_helper=run_helper, log=self.logged.append,
                           SHUTTING_DOWN=threading.Event(), BROWSER_STOPPING=threading.Event(),
                           UNITS={"desk-xorg": dep, "desk-audio": dep}, thaw_browser=lambda: None)
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        self.launcher = FakeLauncher(b)
        self.unit = self.g["BrowserUnit"](a, 99)
        self.unit.backoff = self.g["Backoff"](0.05, 0.2, 4)   # the Browser's curve, 60 times faster

    def wait_for(self, cond, secs=5):
        end = time.monotonic() + secs
        while time.monotonic() < end:
            if cond():
                return True
            time.sleep(0.01)
        return cond()

    def policy_argvs(self):
        return [c[0] for c in self.calls if c[0] and str(c[0][-1]).endswith("desk-browser-policy")]

    def test_the_helper_runs_as_the_desk_s_root_before_chromium_starts(self):
        self.assertTrue(self.unit.start())
        self.assertEqual(self.policy_argvs(), [["/usr/local/lib/ma/desk-browser-policy"]],
                         "desk-init started Chromium without desk-browser-policy: no teen lock, no adult allowlist in a slot")
        self.assertEqual(len(self.launcher.starts), 1)
        self.assertLess(self.events[0][1], self.launcher.starts[0][1], "the policy goes on before Chromium starts")
        argv, kw = self.calls[0]
        self.assertNotIn("setpriv", " ".join(argv), "as the desk's root (ExecStartPre=+), not a desk user")
        log = pathlib.Path(self.tmp, "desk-browser.log")
        self.assertTrue(isinstance(kw.get("stdout"), int) and kw.get("stdout") == kw.get("stderr"), "its lines go to the Browser's log")
        self.assertIn("--- start", log.read_text())
        self.assertEqual(kw.get("timeout"), 30)

    def test_every_crash_restart_runs_it_again_first(self):
        self.assertTrue(self.unit.start())
        pid = self.launcher.starts[-1][0]
        self.launcher.exit(pid, 1)   # Chromium died: Restart=on-failure
        self.assertTrue(self.wait_for(lambda: len(self.launcher.starts) == 2), "the Browser didn't come back after a crash")
        self.assertEqual(len(self.policy_argvs()), 2, "a crash restart started Chromium without running the policy again")
        self.assertLess(self.events[1][1], self.launcher.starts[1][1])

    def test_a_helper_that_fails_is_no_start_and_the_start_is_tried_again(self):
        self.rc[0] = 1   # LOCK NOT IN PLACE, or ALLOWLIST NOT REMOVED
        self.assertFalse(self.unit.start(), "deskd must hear the start failed")
        time.sleep(0.15)
        self.assertEqual(self.launcher.starts, [], "Chromium started though the lock couldn't go on")
        self.assertGreaterEqual(len(self.policy_argvs()), 2, "a failed policy wasn't tried again (Restart= after a failed ExecStartPre)")
        self.assertIn("exited 1: Chromium not started", pathlib.Path(self.tmp, "desk-browser.log").read_text())
        self.rc[0] = 0   # the lock can go on now (the template's file put right)
        self.assertTrue(self.wait_for(lambda: len(self.launcher.starts) == 1), "it never cleared by itself")
        self.assertTrue(self.unit.running())

    def test_waits_grow_as_the_unit_s_do(self):
        self.rc[0] = 1
        self.unit.start()
        self.assertTrue(self.wait_for(lambda: len(self.policy_argvs()) >= 5, 10))
        times = [t for e, t in self.events if e == "policy"][:5]
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertGreater(gaps[-1], gaps[0] * 1.5, f"no back-off between tries: {gaps}")
        self.assertTrue(any("tried again in" in line for line in self.logged))

    def test_a_helper_that_can_t_run_or_doesn_t_end_is_no_start(self):
        for err in (FileNotFoundError(errno.ENOENT, "no helper"), subprocess.TimeoutExpired(["x"], 30), PermissionError(errno.EACCES, "x")):
            self.rc[0] = err
            self.assertFalse(self.unit.start())
            self.unit.stop()
        time.sleep(0.1)
        self.assertEqual(self.launcher.starts, [])
        self.assertIn("didn't run", pathlib.Path(self.tmp, "desk-browser.log").read_text())

    def test_a_stop_while_it_waits_to_try_again_starts_nothing(self):
        self.rc[0] = 1
        self.assertFalse(self.unit.start())
        self.unit.stop()
        self.rc[0] = 0
        time.sleep(0.4)
        self.assertEqual(self.launcher.starts, [], "a Browser deskd stopped came back")

    def test_a_shutdown_while_it_waits_starts_nothing(self):
        self.rc[0] = 1
        self.assertFalse(self.unit.start())
        self.g["SHUTTING_DOWN"].set()
        self.rc[0] = 0
        time.sleep(0.4)
        self.assertEqual(self.launcher.starts, [])


class FromTheTemplate(unittest.TestCase):
    """Confirmed, not changed: these come with the template (the desk image's root), and the slot's way of starting things keeps them."""

    def test_the_launcher_runs_the_template_s_start_script_with_jpeg_xl_off(self):
        src = (LIB / "desk/desk-init.py").read_text()
        self.assertIn('BROWSER_START = "/usr/local/lib/ma/desk-browser-start"', src)
        self.assertIn("os.execve(BROWSER_START, [BROWSER_START], env)", src)
        start = (DESK / "usr/local/lib/ma/desk-browser-start").read_text()
        exec_line = start[start.index("exec /usr/bin/chromium"):]
        switches = re.findall(r"--disable-features=(\S+)", exec_line)
        self.assertEqual(switches, ["JXLImageFormat"], "Chromium reads only the last --disable-features: it must name JXLImageFormat")

    def test_chromium_s_path_finds_the_stand_in_first_and_it_has_no_session_bus(self):
        src = (LIB / "desk/desk-init.py").read_text()
        main = src[src.index("def main():"):]
        env = main[main.index("env = {"):main.index("}", main.index("env = {")) + 1]
        path = re.search(r'"PATH": "([^"]+)"', env).group(1).split(":")
        self.assertLess(path.index("/usr/local/bin"), path.index("/usr/bin"))
        self.assertNotIn("DBUS_SESSION_BUS_ADDRESS", env)
        self.assertTrue((DESK / "usr/local/bin/xdg-open").exists())

    def test_the_agent_s_egress_names_openrouter(self):
        names = [l.strip() for l in (DESK / "etc/ma/agent-egress.conf").read_text().splitlines() if l.strip() and not l.startswith("#")]
        self.assertIn("openrouter.ai", names)
        build = (IMAGE / "host/recipe/build.sh").read_text()
        self.assertNotRegex(build, r"--exclude=\./etc/ma\b", "the template copy must keep /etc/ma")


if __name__ == "__main__":
    unittest.main(verbosity=2)
