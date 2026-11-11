#!/usr/bin/python3 -I
"""A shared host's slot init (desk-init.py, the desk's root inside its slot) never acts on a name inside a directory a desk user owns:
EXP-7's class (the desk image's desk-datadirs, 3db49997) on a shared host (docs/sub-status/slot-datadirs.md). Each case plants a link
(or a FIFO) where that user could, and each fails on the desk-init before the fix:
- datadirs(): a link the Browser's user put at /data/browser/home (or downloads, profile) was followed by root's makedirs, chown and
  chmod at the slot's next start, which gave kiosk the directory it named; deskd's copy of the volume record was installed as root
  into deskd's /data/desk, its owner and mode set by name.
- units.sock in the slot's /run/desk (rtc:desk 0770): bound as root, then chowned and chmodded by name, so deskd, desk-data or
  desk-rtc could swap the socket for a link in between and have root chown what it named.
- desk-audio's RuntimeDirectory /run/desk-audio/pulse, in desk-snd's share: removed as root, then made, chowned and chmodded by name,
  so desk-snd, putting a link there after the removal, had root chown what it named.
- exit_type(): the profile's Preferences read by name, so a FIFO there held the desk's stop and a link was read through.

No root (mocks record what root does by name):  python3 -I image/tests/test_host_slot_links.py
Against another desk-init (the old one fails):  DESK_INIT=/tmp/old-desk-init.py python3 -I image/tests/test_host_slot_links.py
   where git show b7cb1421:image/host/recipe/files/usr/local/lib/desk-host/desk/desk-init.py > /tmp/old-desk-init.py
As root, real users, chown and setpriv, in a throwaway container only (it adds users and writes /data, /run and /victim*):
   docker run --rm --network none --tmpfs /data --tmpfs /run -e SLOT_LINKS_ROOT=1 -v "$PWD:/src:ro" <Debian 13 with python3> \
     python3 -I /src/image/tests/test_host_slot_links.py
"""
import ast
import errno
import grp
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
DESK_INIT = os.environ.get("DESK_INIT") or str(IMAGE / "host/recipe/files/usr/local/lib/desk-host/desk/desk-init.py")
SRC = pathlib.Path(DESK_INIT).read_text()
AS_ROOT = os.environ.get("SLOT_LINKS_ROOT") == "1" and os.getuid() == 0 and os.path.exists("/.dockerenv")


def top_names(node):
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, ast.Assign):
        return {e.id for t in node.targets for e in (t.elts if isinstance(t, ast.Tuple) else [t]) if isinstance(e, ast.Name)}
    return set()


def load(names, root="", **over):
    """desk-init.py's named top-level statements (defs, classes, assignments; one the file hasn't is skipped), its "/data and "/run
    paths moved under root, run in a namespace of their own with the standard modules and the overrides."""
    lines = SRC.splitlines(keepends=True)
    parts = ["".join(lines[n.lineno - 1:n.end_lineno]) for n in ast.parse(SRC).body if top_names(n) & set(names)]
    code = "\n".join(parts)
    if root:
        for p in ('"/data', '"/run', '"/var/tmp"', '"/root"'):
            code = code.replace(p, 'ROOT + ' + p)
    g = {"__name__": "desk_init_part", "ROOT": root, "os": os, "re": re, "stat": stat, "errno": errno, "grp": grp, "pwd": pwd,
         "socket": socket, "subprocess": subprocess, "threading": threading, "time": time, "sys": sys}
    g.update(over)
    exec(compile(code, DESK_INIT, "exec"), g)
    return g


class Recorder:
    """What root does by name: chown, chmod and mkdir on paths, install run as root; as_user calls kept apart."""

    def __init__(self):
        self.root_acts, self.as_user = [], []

    def mkdir(self, path, user, group, mode):
        os.makedirs(path, exist_ok=True)   # what root's makedirs does to the tree; the chown and chmod are only recorded
        self.root_acts.append(("mkdir", path, os.path.islink(path)))

    def run_helper(self, argv, **kw):
        if argv[:1] != ["/usr/bin/setpriv"]:
            self.root_acts.append(("run", " ".join(argv), False))
        return subprocess.CompletedProcess(argv, 0, "", "")

    def as_user_fn(self, user, argv, group=None, **kw):
        self.as_user.append((user, argv))
        return subprocess.CompletedProcess(argv, 0, "", "")

    def in_dirs(self, d):
        """Root's acts on a name inside directory d (not on d itself)."""
        return [a for a in self.root_acts if a[1].startswith(d + "/") or (" " + d + "/") in a[1]]


class DataDirs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for d in ("data/browser", "data/desk", "victim"):
            os.makedirs(f"{self.tmp}/{d}")
        self.r = Recorder()
        self.logged = []
        self.g = load(["datadirs", "as_user"], self.tmp, mkdir=self.r.mkdir, run_helper=self.r.run_helper, log=self.logged.append)
        if "as_user" in self.g:
            self.g["as_user"] = self.r.as_user_fn

    def test_root_never_acts_on_a_name_in_the_browsers_folder(self):
        os.symlink(f"{self.tmp}/victim", f"{self.tmp}/data/browser/home")   # the Browser's user, before the slot's next start
        self.g["datadirs"]()
        bad = self.r.in_dirs(f"{self.tmp}/data/browser")
        self.assertEqual(bad, [], "root made, chowned or chmodded a name inside kiosk's /data/browser (home was a link to the desk's root's directory)")
        self.assertIn(("kiosk", ["install", "-d", "-m", "0700", f"{self.tmp}/data/browser/home"]), self.r.as_user)
        self.assertIn(("kiosk", ["install", "-d", "-m", "0750", f"{self.tmp}/data/browser/downloads"]), self.r.as_user)
        self.assertIn(("kiosk", ["install", "-d", "-m", "0700", f"{self.tmp}/data/browser/profile"]), self.r.as_user)
        self.assertTrue(any(a[1] == f"{self.tmp}/data/browser" for a in self.r.root_acts), "/data/browser itself (a name in /data) is root's to make")

    def test_deskds_copy_of_the_volume_record_is_written_as_desk(self):
        self.g["datadirs"]()
        self.assertEqual(self.r.in_dirs(f"{self.tmp}/data/desk"), [], "root installed into deskd's /data/desk by name")
        self.assertIn(("desk", ["install", "-m", "0644", f"{self.tmp}/data/.ma-volume", f"{self.tmp}/data/desk/volume.json"]), self.r.as_user)

    def test_a_folder_kiosk_cant_make_is_said_and_the_rest_still_made(self):
        if "as_user" not in self.g:
            self.fail("no as_user: everything inside kiosk's folder is made as root")
        self.g["as_user"] = lambda user, argv, group=None, **kw: subprocess.CompletedProcess(argv, 1 if argv[-1].endswith("/home") else 0, "", "")
        self.g["datadirs"]()
        self.assertTrue(any("could not make /data/browser/home as kiosk" in x for x in self.logged), self.logged)
        self.assertTrue(any(a[1] == f"{self.tmp}/data/agent" for a in self.r.root_acts), "the folders after it are still made")


class ExitType(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.d = f"{self.tmp}/data/browser/profile/Default"
        os.makedirs(self.d)
        self.g = load(["exit_type", "BROWSER_DIR", "PREFS_MAX"], self.tmp)

    def run_it(self, timeout=3):
        out = []
        t = threading.Thread(target=lambda: out.append(self.g["exit_type"]()), daemon=True)
        t.start()
        t.join(timeout)
        return out[0] if out else "BLOCKED"

    def test_a_regular_preferences_file(self):
        pathlib.Path(self.d, "Preferences").write_text('{"profile":{"exit_type":"Crashed"}}')
        self.assertEqual(self.run_it(), "Crashed")

    def test_a_fifo_at_preferences_doesnt_hold_the_stop(self):
        os.mkfifo(f"{self.d}/Preferences")
        self.assertEqual(self.run_it(), "none", "the read blocked on a FIFO kiosk put there (the desk's stop waits on it)")

    def test_a_link_at_preferences_or_on_the_way_isnt_followed(self):
        os.makedirs(f"{self.tmp}/elsewhere/Default")
        pathlib.Path(self.tmp, "elsewhere/Default/Preferences").write_text('{"exit_type":"Crashed"}')
        pathlib.Path(self.tmp, "secret").write_text('{"exit_type":"Secret"}')
        os.symlink(f"{self.tmp}/secret", f"{self.d}/Preferences")
        self.assertEqual(self.run_it(), "none", "root read a file through a link at Preferences")
        os.unlink(f"{self.d}/Preferences")
        shutil.rmtree(f"{self.tmp}/data/browser/profile")
        os.symlink(f"{self.tmp}/elsewhere", f"{self.tmp}/data/browser/profile")
        self.assertEqual(self.run_it(), "none", "root read through a link at the profile")


class FakeLibc:
    """setfsuid and setfsgid as the kernel answers them (the old value; -1 asks), the value kept per thread."""

    def __init__(self):
        self.t = threading.local()

    def _get(self, k):
        return getattr(self.t, k, 0)

    def setfsuid(self, v):
        old = self._get("u")
        if v != -1:
            self.t.u = v
        return old

    def setfsgid(self, v):
        old = self._get("g")
        if v != -1:
            self.t.g = v
        return old


class Stop(Exception):
    pass


class UnitsSock(unittest.TestCase):
    """units.sock's bind, with the race a service in /run/desk could run: the socket swapped for a link right after the bind."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(f"{self.tmp}/run/desk")
        self.path = f"{self.tmp}/run/desk/units.sock"
        pathlib.Path(self.tmp, "victim").write_text("root's\n")
        self.named, self.at_bind = [], {}
        libc = FakeLibc()
        test = self

        class Sock(socket.socket):
            def bind(self, p):
                test.at_bind = {"fsuid": libc.setfsuid(-1), "fsgid": libc.setfsgid(-1)}
                super().bind(p)
                os.rename(p, p + ".real")                  # deskd, between root's bind and anything after it
                os.symlink(f"{test.tmp}/victim", p)

            def accept(self):
                self.close()
                raise Stop

        fos = types.SimpleNamespace(**{k: getattr(os, k) for k in dir(os) if not k.startswith("__")})
        fos.chown = lambda p, *a, **kw: test.named.append(("chown", p))
        fos.chmod = lambda p, *a, **kw: test.named.append(("chmod", p))
        fos.path = os.path
        fsock = types.SimpleNamespace(socket=Sock, AF_UNIX=socket.AF_UNIX, SOCK_STREAM=socket.SOCK_STREAM)
        fgrp = types.SimpleNamespace(getgrnam=lambda n: types.SimpleNamespace(gr_gid=1100))
        self.g = load(["serve_units", "bind_as", "UNITS_SOCK", "DESKD_UID"], self.tmp, os=fos, socket=fsock, grp=fgrp, _LIBC=libc)

    def test_root_never_chowns_or_chmods_the_name(self):
        with self.assertRaises(Stop):
            self.g["serve_units"]()
        self.assertEqual(self.named, [], "root chowned or chmodded units.sock by name (a link deskd put there is followed)")
        self.assertEqual(self.at_bind, {"fsuid": 1100, "fsgid": 1100}, "the bind runs as desk")
        self.assertEqual(stat.S_IMODE(os.lstat(self.path + ".real").st_mode), 0o600, "the mode set on the socket before the bind")
        self.assertEqual(pathlib.Path(self.tmp, "victim").read_text(), "root's\n")


class RuntimeDirRace(unittest.TestCase):
    """desk-audio's /run/desk-audio/pulse, with desk-snd putting a link there right after the removal."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(f"{self.tmp}/run/desk-audio/pulse")
        os.makedirs(f"{self.tmp}/victim")
        if os.getuid() == 0:   # the share is desk-snd's (as root in the container: a uid of its own, not root's)
            os.chown(f"{self.tmp}/run/desk-audio", 1108, 1108)
        self.d = f"{self.tmp}/run/desk-audio/pulse"
        self.r = Recorder()
        test = self

        def run_helper(argv, **kw):
            plain = argv[argv.index("--") + 1:] if argv[:1] == ["/usr/bin/setpriv"] else argv
            if plain[:1] == ["rm"]:
                shutil.rmtree(test.d, ignore_errors=True)
                if os.path.islink(test.d):
                    os.unlink(test.d)
                os.symlink(f"{test.tmp}/victim", test.d)   # desk-snd, between the removal and the make
            if argv[:1] == ["/usr/bin/setpriv"]:
                test.r.as_user.append((argv[1], plain))
                return subprocess.CompletedProcess(argv, 1 if plain[:1] == ["install"] and os.path.islink(plain[-1]) else 0, "", "")
            test.r.root_acts.append(("run", " ".join(argv), False))
            return subprocess.CompletedProcess(argv, 0, "", "")

        class Popen:
            def __init__(self, *a, **kw):
                raise Stop

        fsub = types.SimpleNamespace(Popen=Popen, run=subprocess.run, DEVNULL=subprocess.DEVNULL, CompletedProcess=subprocess.CompletedProcess)
        self.logs = f"{self.tmp}/logs"
        os.makedirs(self.logs)
        self.g = load(["Unit", "Backoff", "backoff_delay", "RESTART_CAP", "RESTART_STEPS", "HEALTHY_SEC", "runtime_dir", "root_only", "as_user", "CG"],
                      self.tmp, mkdir=self.r.mkdir, run_helper=run_helper, subprocess=fsub, LOG_DIR=self.logs, log=lambda *a: None)
        self.unit = self.g["Unit"]("desk-audio", ["/usr/bin/pulseaudio"], "desk-snd", runtime_dirs=(self.d,))

    def test_root_never_makes_a_name_in_desk_snds_folder(self):
        try:
            self.unit._spawn()
        except Stop:
            pass
        bad = self.r.in_dirs(f"{self.tmp}/run/desk-audio")
        self.assertEqual(bad, [], "root removed or made /run/desk-audio/pulse by name, and followed the link desk-snd put there")
        self.assertTrue(os.path.islink(self.d) and os.listdir(f"{self.tmp}/victim") == [])

    def test_root_only(self):
        if "root_only" not in self.g:
            self.fail("no root_only: no runtime directory is told apart")
        ro = self.g["root_only"]
        self.assertTrue(ro("/"))
        self.assertFalse(ro("/tmp"), "others can write /tmp")
        self.assertFalse(ro(f"{self.tmp}/run/desk-audio"), "a user's directory")
        os.symlink("/", f"{self.tmp}/link")
        self.assertFalse(ro(f"{self.tmp}/link"), "a link is never root's directory")
        self.assertFalse(ro(f"{self.tmp}/missing"))


@unittest.skipUnless(AS_ROOT, "as root in a throwaway container only (SLOT_LINKS_ROOT=1)")
class AsRoot(unittest.TestCase):
    """The same plants with real users, chown and setpriv: what each would have given the user, on the desk-init under test."""
    USERS = {"desk": 1100, "rtc": 1101, "kiosk": 1102, "agent": 1103, "notebook": 1105, "desk-x": 1107, "desk-snd": 1108, "desk-data": 1112}

    @classmethod
    def setUpClass(cls):
        for n, u in cls.USERS.items():
            subprocess.run(["groupadd", "-f", "-g", str(u), n], check=True)
            if subprocess.run(["id", n], capture_output=True).returncode != 0:
                subprocess.run(["useradd", "-u", str(u), "-g", str(u), "-M", "-d", "/nonexistent", "-s", "/usr/sbin/nologin", n], check=True)
        subprocess.run(["groupadd", "-f", "-g", "1120", "desk-audio"], check=True)

    def own(self, p):
        st = os.lstat(p)
        return f"{pwd.getpwuid(st.st_uid).pw_name}:{grp.getgrgid(st.st_gid).gr_name} {stat.S_IMODE(st.st_mode):o}"

    def setUp(self):
        for p in ("/data", "/run"):
            for x in os.listdir(p):
                q = os.path.join(p, x)
                shutil.rmtree(q) if os.path.isdir(q) and not os.path.islink(q) else os.unlink(q)
        os.chmod("/data", 0o755)
        os.makedirs("/data/logs", mode=0o755, exist_ok=True)
        for v in ("/victim", "/victim2", "/victim-pulse"):
            shutil.rmtree(v, ignore_errors=True)
            os.mkdir(v, 0o755)
        pathlib.Path("/victim-file").write_text("root's\n")
        os.chmod("/victim-file", 0o600)
        self.logged = []
        self.m = load(["datadirs", "mkdir", "as_user", "run_helper", "root_only", "runtime_dir", "serve_units", "bind_as", "UNITS_SOCK", "DESKD_UID",
                       "exit_type", "BROWSER_DIR", "PREFS_MAX", "Unit", "Backoff", "backoff_delay", "RESTART_CAP", "RESTART_STEPS", "HEALTHY_SEC",
                       "CG", "_LIBC"], log=lambda *a: self.logged.append(" ".join(map(str, a))), ctypes=__import__("ctypes"), LOG_DIR="/data/logs")
        install = lambda p, u, g, mode: subprocess.run(["install", "-d", "-o", u, "-g", g, "-m", mode, p], check=True)   # noqa: E731
        install("/run/desk", "rtc", "desk", "0770")          # the slot's shares (wallspec.shares), as svc-spec.py makes them
        install("/run/desk-audio", "desk-snd", "desk-audio", "0750")

    def kiosk(self, *argv):
        subprocess.run(["setpriv", "--reuid=kiosk", "--regid=kiosk", "--clear-groups", *argv], check=True)

    def test_datadirs_a_link_at_the_browsers_home_gives_kiosk_nothing(self):
        self.m["datadirs"]()   # a fresh volume: the layout it always had
        self.assertEqual(self.own("/data/browser"), "kiosk:kiosk 750")
        self.assertEqual(self.own("/data/browser/profile"), "kiosk:kiosk 700")
        self.assertEqual(self.own("/data/browser/downloads"), "kiosk:kiosk 750")
        self.assertEqual(self.own("/data/browser/home"), "kiosk:kiosk 700")
        self.assertEqual(self.own("/data/desk/volume.json"), "desk:desk 644")
        self.assertEqual(pathlib.Path("/data/desk/volume.json").read_bytes(), pathlib.Path("/data/.ma-volume").read_bytes())
        self.kiosk("rmdir", "/data/browser/home", "/data/browser/downloads")
        self.kiosk("ln", "-s", "/victim", "/data/browser/home")
        self.kiosk("ln", "-s", "/victim2", "/data/browser/downloads")
        self.m["datadirs"]()   # the slot's next start
        self.assertEqual(self.own("/victim"), "root:root 755", "a link at /data/browser/home made root give kiosk what it named")
        self.assertEqual(self.own("/victim2"), "root:root 755", "a link at /data/browser/downloads made root give kiosk what it named")
        self.assertEqual(self.own("/data/browser/profile"), "kiosk:kiosk 700")

    def test_datadirs_a_link_at_volume_json_leaves_its_target_alone(self):
        self.m["datadirs"]()
        subprocess.run(["setpriv", "--reuid=desk", "--regid=desk", "--clear-groups", "sh", "-c", "rm -f /data/desk/volume.json; ln -s /victim-file /data/desk/volume.json"], check=True)
        self.m["datadirs"]()
        self.assertEqual(self.own("/victim-file"), "root:root 600")
        self.assertEqual(pathlib.Path("/victim-file").read_text(), "root's\n")
        self.assertEqual(self.own("/data/desk/volume.json"), "desk:desk 644")

    def test_units_sock_swapped_for_a_link_after_the_bind(self):
        test = self

        class Sock(socket.socket):
            def bind(self, p):
                super().bind(p)
                os.rename(p, p + ".real")   # deskd (group desk can write /run/desk), between the bind and what comes after
                os.symlink("/victim-file", p)

            def accept(self):
                self.close()
                raise Stop

        self.m["socket"] = types.SimpleNamespace(socket=Sock, AF_UNIX=socket.AF_UNIX, SOCK_STREAM=socket.SOCK_STREAM)
        with self.assertRaises(Stop):
            self.m["serve_units"]()
        self.assertEqual(self.own("/victim-file"), "root:root 600", "root chowned what the link at units.sock named to deskd")
        self.assertEqual(self.own("/run/desk/units.sock.real"), "desk:desk 600")
        self.assertTrue(stat.S_ISSOCK(os.lstat("/run/desk/units.sock.real").st_mode))
        del test

    def test_units_sock_as_bound(self):
        class Sock(socket.socket):
            def accept(self):
                self.close()
                raise Stop

        self.m["socket"] = types.SimpleNamespace(socket=Sock, AF_UNIX=socket.AF_UNIX, SOCK_STREAM=socket.SOCK_STREAM)
        with self.assertRaises(Stop):
            self.m["serve_units"]()
        self.assertEqual(self.own("/run/desk/units.sock"), "desk:desk 600")
        self.assertEqual(open("/proc/self/status").read().count("\t0\t0\t0\t0\n"), 2, "the thread's fsuid and fsgid are root's again")

    def test_runtime_dir_with_desk_snd_racing_the_removal(self):
        real = self.m["run_helper"]

        def run_helper(argv, **kw):
            r = real(argv, **kw)
            plain = argv[argv.index("--") + 1:] if argv[:1] == ["/usr/bin/setpriv"] else argv
            if plain[:1] == ["rm"]:   # desk-snd, between the removal and the make
                subprocess.run(["setpriv", "--reuid=desk-snd", "--regid=desk-snd", "--clear-groups", "ln", "-sfn", "/victim-pulse", "/run/desk-audio/pulse"], check=True)
            return r

        self.m["run_helper"] = run_helper
        os.makedirs("/run/desk-audio/pulse")
        shutil.chown("/run/desk-audio/pulse", "desk-snd", "desk-snd")

        class Popen:
            def __init__(self, *a, **kw):
                raise Stop

        self.m["subprocess"] = types.SimpleNamespace(Popen=Popen, run=subprocess.run, DEVNULL=subprocess.DEVNULL, CompletedProcess=subprocess.CompletedProcess)
        u = self.m["Unit"]("desk-audio", ["/usr/bin/pulseaudio"], "desk-snd", runtime_dirs=("/run/desk-audio/pulse",))
        try:
            u._spawn()
        except Stop:
            pass
        self.assertEqual(self.own("/victim-pulse"), "root:root 755", "root made /run/desk-audio/pulse by name and followed desk-snd's link")

    def test_runtime_dir_as_made(self):
        self.assertTrue(self.m["runtime_dir"]("/run/desk-audio/pulse", "desk-snd", "desk-snd", 0o755))
        self.assertEqual(self.own("/run/desk-audio/pulse"), "desk-snd:desk-snd 755")
        self.assertTrue(self.m["runtime_dir"]("/run/desk-xorg", "desk-x", "desk-x", 0o700, True))
        self.assertEqual(self.own("/run/desk-xorg"), "desk-x:desk-x 700")

    def test_exit_type_a_fifo_and_a_link(self):
        self.m["datadirs"]()
        self.kiosk("mkdir", "/data/browser/profile/Default")
        self.kiosk("mkfifo", "/data/browser/profile/Default/Preferences")
        out = []
        t = threading.Thread(target=lambda: out.append(self.m["exit_type"]()), daemon=True)
        t.start()
        t.join(3)
        self.assertEqual(out, ["none"], "a FIFO at Preferences held root's read (the desk's stop)")
        pathlib.Path("/victim-file").write_text('{"exit_type":"Secret"}')
        self.kiosk("sh", "-c", "rm /data/browser/profile/Default/Preferences; ln -s /victim-file /data/browser/profile/Default/Preferences")
        self.assertEqual(self.m["exit_type"](), "none", "root read a file of its own through kiosk's link")


if __name__ == "__main__":
    unittest.main(verbosity=2)
