#!/usr/bin/python3 -I
"""ISS-96: Chromium's histogram directory on a tmpfs in every shared-host slot (mounts.py vol's step 1b;
docs/sub-status/browser-metrics-tmpfs.md). On a free desk's first Chromium start the component updater's writes took the desk's
volume past its dirty limit at 1 MB/s, and the browser UI thread sat in the kernel's dirty throttle on a store to its histogram file
(BrowserMetrics/*.pma, a shared mapping) for up to 91 s, so keys and clicks waited. The host now puts a 32 MiB tmpfs, kiosk's, 0700,
nosuid,nodev,noexec, over /data/browser/profile/BrowserMetrics before any desk process runs. Root acts there only through
descriptors: browser, profile and BrowserMetrics opened one at a time with openat2's no-links rule, each checked (a directory of
kiosk's) on its descriptor, a missing one made by mkdirat on the checked parent as kiosk alone, and the tmpfs attached to the checked
descriptor (move_mount, MOVE_MOUNT_T_EMPTY_PATH). Anything that doesn't check out is no mount, one line and nothing more there.

No root (a real tree and real openat2; the mount calls recorded):  python3 -I image/tests/test_host_metrics_tmpfs.py
Against another mounts.py (today's has no step 1b and fails):    MOUNTS=/tmp/old-mounts.py python3 -I image/tests/test_host_metrics_tmpfs.py
   where git show 20facb47:image/host/recipe/files/usr/local/lib/desk-host/mounts.py > /tmp/old-mounts.py
As root, real mounts, a real kiosk uid and the clone vol makes, in a throwaway container only (it mounts and chowns under /work):
   docker run --rm --network none --cap-add SYS_ADMIN --security-opt apparmor=unconfined --tmpfs /work -e METRICS_TMPFS_ROOT=1 \
     -v "$PWD:/src:ro" <Debian 13 with python3 and util-linux> python3 -I /src/image/tests/test_host_metrics_tmpfs.py
"""
import ast
import ctypes
import errno
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
MOUNTS = os.environ.get("MOUNTS") or str(IMAGE / "host/recipe/files/usr/local/lib/desk-host/mounts.py")
AS_ROOT = os.environ.get("METRICS_TMPFS_ROOT") == "1" and os.getuid() == 0 and os.path.exists("/.dockerenv")
CALLS = ("fsopen", "fsconfig", "fsmount", "move_mount")


def load():
    spec = importlib.util.spec_from_file_location("mounts_metrics", MOUNTS)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fd_path(fd):
    return os.readlink(f"/proc/self/fd/{fd}")


def listing(top):
    """Every name under top with its type, owner and mode (links not followed), to show nothing was made, changed or followed."""
    out = []
    for d, dirs, files in os.walk(top):
        for n in sorted(dirs + files):
            p = os.path.join(d, n)
            st = os.lstat(p)
            out.append((os.path.relpath(p, top), stat.S_IFMT(st.st_mode), st.st_uid, stat.S_IMODE(st.st_mode)))
    return sorted(out)


class Walk(unittest.TestCase):
    """Step 1b on a real tree with real openat2, as this user (kiosk is this uid). The mount calls are recorded, not made; the
    make-as-kiosk child is replaced by an in-process mkdirat on the same descriptor (the real child runs in AsRoot)."""

    def setUp(self):
        self.m = load()
        if not hasattr(self.m, "metrics_tmpfs"):
            self.fail("this mounts.py puts no tmpfs over BrowserMetrics (ISS-96): it has no step 1b")
        self.top = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.top, True)
        self.vol, self.out = self.top / "vol", self.top / "outside"
        (self.vol / "browser/profile/BrowserMetrics").mkdir(parents=True)
        (self.vol / "browser/profile/BrowserMetrics/BrowserMetrics-1.pma").write_bytes(b"histograms")
        (self.out / "profile/BrowserMetrics").mkdir(parents=True)   # what a link would lead to
        self.kiosk = os.getuid()
        self.calls, self.made, self.open_fds = [], [], []
        real = self.m.sysc

        def sysc(name, *a):
            if name not in CALLS:
                return real(name, *a)
            if self.fail_at == name:
                raise OSError(errno.EPERM, f"{name}: EPERM")
            rec = [name, *a]
            if name == "move_mount":
                rec.append(fd_path(a[2]))   # the target, by its descriptor
            self.calls.append(rec)
            if name in ("fsopen", "fsmount"):
                fd = os.open("/dev/null", os.O_RDONLY | os.O_CLOEXEC)
                self.open_fds.append(fd)
                return fd
            return 0
        self.fail_at = None
        self.m.sysc = sysc

    def make(self, parent, name):
        self.made.append((fd_path(parent), name))
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            return 0
        except OSError as e:
            return e.errno

    def run_it(self, **kw):
        root = os.open(self.vol, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        self.addCleanup(os.close, root)
        before = set(os.listdir("/proc/self/fd"))
        r = self.m.metrics_tmpfs(root, kw.pop("kiosk", self.kiosk), make=kw.pop("make", self.make), switch=kw.pop("switch", "on"))
        leaked = set(os.listdir("/proc/self/fd")) - before
        self.assertEqual(leaked, set(), "every descriptor the step opened is closed")
        for fd in self.open_fds:   # the recorded fsopen/fsmount stand-ins were closed by the step
            with self.assertRaises(OSError):
                os.fstat(fd)
        return r

    def names(self):
        return [c[0] for c in self.calls]

    def test_the_mount_is_made_on_the_checked_directory_with_the_right_owner_mode_flags_and_size(self):
        before = listing(self.vol)
        self.assertEqual(self.run_it(), "tmpfs")
        self.assertEqual(self.names(), ["fsopen"] + ["fsconfig"] * 6 + ["fsmount", "move_mount"])
        self.assertEqual(self.calls[0][1:], [b"tmpfs", 1])
        conf = {c[3]: c[4] for c in self.calls if c[0] == "fsconfig" and c[2] == self.m.FSCONFIG_SET_STRING}
        self.assertEqual(conf, {b"source": b"desk-metrics", b"size": b"32m", b"mode": b"0700",
                                b"uid": str(self.kiosk).encode(), b"gid": str(self.kiosk).encode()})
        self.assertEqual([c[2] for c in self.calls if c[0] == "fsconfig"][-1], self.m.FSCONFIG_CMD_CREATE, "created last")
        fsmount = self.calls[-2]
        self.assertEqual(fsmount[3], self.m.MOUNT_ATTR_NOSUID | self.m.MOUNT_ATTR_NODEV | self.m.MOUNT_ATTR_NOEXEC)
        mv = self.calls[-1]
        self.assertEqual((mv[2], mv[4], mv[5]), (b"", b"", self.m.MOVE_MOUNT_F_EMPTY_PATH | self.m.MOVE_MOUNT_T_EMPTY_PATH),
                         "attached to the descriptor itself, never a path")
        self.assertEqual(mv[-1], str(self.vol / "browser/profile/BrowserMetrics"))
        self.assertEqual(self.made, [])
        self.assertEqual(listing(self.vol), before, "nothing on the volume read, removed or changed: the old file stays under it")

    def test_a_link_at_browser_profile_or_BrowserMetrics_is_refused_with_no_mount_and_nothing_made(self):
        for at, target in (("browser", self.out), ("browser/profile", self.out / "profile"),
                           ("browser/profile/BrowserMetrics", self.out / "profile/BrowserMetrics"),
                           ("browser/profile/BrowserMetrics", self.top / "nothing-there")):   # dangling: not "missing"
            with self.subTest(link=at, to=target.name):
                self.setUp()
                p = self.vol / at
                shutil.rmtree(p)
                p.symlink_to(target)
                before, outside = listing(self.vol), listing(self.out)
                r = self.run_it()
                self.assertTrue(r.startswith("refused: "), r)
                self.assertIn(p.name, r)
                self.assertEqual(self.calls, [], "no mount call at all")
                self.assertEqual(self.made, [], "nothing made")
                self.assertEqual((listing(self.vol), listing(self.out)), (before, outside))
                self.assertFalse((self.top / "nothing-there").exists())

    def test_the_wrong_owner_is_refused_at_each_step(self):
        real_fstat = os.fstat
        for at in ("browser", "profile", "BrowserMetrics"):
            with self.subTest(owner_wrong_at=at):
                self.setUp()

                def fstat(fd, at=at):
                    st = real_fstat(fd)
                    if os.path.basename(fd_path(fd)) == at:
                        return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, st.st_uid + 1) + tuple(st)[5:])
                    return st
                self.m.os = type("OsProxy", (), {"__getattr__": lambda _s, n: getattr(os, n), "fstat": staticmethod(fstat)})()
                try:
                    r = self.run_it()
                finally:
                    self.m.os = os
                self.assertTrue(r.startswith(f"refused: {at}: uid "), r)
                self.assertEqual((self.calls, self.made), ([], []))
        with self.subTest(owner_wrong_everywhere="kiosk is another uid"):
            self.setUp()
            r = self.run_it(kiosk=self.kiosk + 1)
            self.assertTrue(r.startswith("refused: browser: uid "), r)
            self.assertEqual((self.calls, self.made), ([], []))

    def test_the_wrong_type_is_refused(self):
        for at, kind in (("browser/profile/BrowserMetrics", "file"), ("browser/profile/BrowserMetrics", "fifo"),
                         ("browser/profile", "file"), ("browser", "fifo")):
            with self.subTest(at=at, kind=kind):
                self.setUp()
                p = self.vol / at
                shutil.rmtree(p)
                if kind == "file":
                    p.write_bytes(b"x")
                else:
                    os.mkfifo(p)   # O_PATH never blocks on it
                before = listing(self.vol)
                r = self.run_it()
                self.assertTrue(r.startswith(f"refused: {p.name}: openat2"), r)
                self.assertIn("ENOTDIR", r)
                self.assertEqual((self.calls, self.made), ([], []))
                self.assertEqual(listing(self.vol), before)

    def test_a_missing_BrowserMetrics_is_made_on_the_checked_parent_then_mounted(self):
        shutil.rmtree(self.vol / "browser/profile/BrowserMetrics")
        self.assertEqual(self.run_it(), "tmpfs")
        self.assertEqual(self.made, [(str(self.vol / "browser/profile"), "BrowserMetrics")], "made by name only through the parent's descriptor")
        self.assertEqual(self.calls[-1][-1], str(self.vol / "browser/profile/BrowserMetrics"))

    def test_a_missing_profile_is_made_too_but_never_browser(self):
        shutil.rmtree(self.vol / "browser/profile")
        self.assertEqual(self.run_it(), "tmpfs")
        self.assertEqual(self.made, [(str(self.vol / "browser"), "profile"), (str(self.vol / "browser/profile"), "BrowserMetrics")])
        self.setUp()
        shutil.rmtree(self.vol / "browser")
        r = self.run_it()
        self.assertTrue(r.startswith("refused: browser: openat2"), r)
        self.assertIn("ENOENT", r)
        self.assertEqual((self.calls, self.made), ([], []), "browser, in the desk's root's /data, is never made here")
        self.assertFalse((self.vol / "browser").exists())

    def test_a_make_that_fails_is_no_mount(self):
        shutil.rmtree(self.vol / "browser/profile/BrowserMetrics")
        r = self.run_it(make=lambda parent, name: errno.EACCES)
        self.assertEqual(r, "refused: BrowserMetrics: mkdirat as kiosk EACCES")
        self.assertEqual(self.calls, [])

    def test_a_mount_error_is_no_mount_and_every_descriptor_closed(self):
        for at in ("fsopen", "fsconfig", "fsmount", "move_mount"):
            with self.subTest(fails=at):
                self.setUp()
                self.fail_at = at
                r = self.run_it()
                self.assertTrue(r.startswith("refused: the mount"), r)
                self.assertNotIn("move_mount", self.names())

    def test_the_kill_switch(self):
        before = listing(self.vol)
        self.assertEqual(self.run_it(switch="off"), "off")
        self.assertEqual((self.calls, self.made, listing(self.vol)), ([], [], before))
        conf = self.top / "desk-host.conf"
        conf.write_text("# x\nMETRICS_TMPFS=on\nMETRICS_TMPFS=off\n")
        self.assertEqual(self.m.conf_value("METRICS_TMPFS", "on", path=str(conf)), "off", "the last line wins, as desk-host's conf()")
        self.assertEqual(self.m.conf_value("METRICS_TMPFS", "on", path=str(self.top / "none")), "on")

    def test_vol_makes_it_before_the_desks_clone_and_records_it(self):
        fn = next(n for n in ast.parse(pathlib.Path(MOUNTS).read_text()).body if isinstance(n, ast.FunctionDef) and n.name == "vol")
        src = ast.get_source_segment(pathlib.Path(MOUNTS).read_text(), fn)
        step = src.find("metrics_tmpfs(root, base_id(k) + KIOSK)")
        self.assertGreater(step, 0, "vol runs step 1b with the slot's kiosk uid")
        self.assertLess(step, src.find("whole = sysc(\"open_tree\""), "before the desk's recursive clone, which carries it into the desk")
        self.assertLess(src.find("os.open(priv"), step, "on the volume's own root descriptor")
        self.assertIn('"metrics": metrics', src)
        self.assertEqual(self.m.DIRS["browser"], (1102, 1102, 0o750), "a blank volume gets browser as datadirs() makes it")
        self.assertEqual(self.m.base_id(1) + self.m.KIOSK, 100000 + 65536 + 1102)


def isolated(fn):
    """fn() in a forked child with a private mount namespace of its own (its mounts go with it); fn's JSON result."""
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.unshare(0x20000) != 0 or libc.mount(b"none", b"/", None, 0x4000 | (1 << 18), None) != 0:
                raise OSError(ctypes.get_errno(), "unshare/make-rprivate")
            out = {"ok": fn()}
        except BaseException as e:  # noqa: BLE001
            out = {"error": f"{type(e).__name__}: {e}"}
        os.write(w, json.dumps(out).encode())
        os._exit(0)
    os.close(w)
    data = b""
    while True:
        chunk = os.read(r, 65536)
        if not chunk:
            break
        data += chunk
    os.close(r)
    os.waitpid(pid, 0)
    res = json.loads(data)
    if "error" in res:
        raise AssertionError(res["error"])
    return res["ok"]


def mounts_under(top):
    return [l.split() for l in open("/proc/self/mountinfo") if l.split()[4].startswith(str(top) + "/")]


@unittest.skipUnless(AS_ROOT, "as root in a throwaway container only (METRICS_TMPFS_ROOT=1)")
class AsRoot(unittest.TestCase):
    """Real mounts, real owners (slot 1's kiosk, 166638 on the host) and the real make-as-kiosk child."""

    def setUp(self):
        self.m = load()
        if not hasattr(self.m, "metrics_tmpfs"):
            self.fail("this mounts.py puts no tmpfs over BrowserMetrics (ISS-96): it has no step 1b")
        self.K = 100000 + 65536 + 1102
        self.top = pathlib.Path(tempfile.mkdtemp(dir="/work"))
        self.addCleanup(shutil.rmtree, self.top, True)
        os.chmod(self.top, 0o755)
        self.vol, self.out = self.top / "vol", self.top / "outside"
        self.vol.mkdir(mode=0o755)
        for p, mode in (("browser", 0o750), ("browser/profile", 0o700), ("browser/profile/BrowserMetrics", 0o700)):
            (self.vol / p).mkdir(mode=mode)
            os.chown(self.vol / p, self.K, self.K)
            os.chmod(self.vol / p, mode)
        old = self.vol / "browser/profile/BrowserMetrics/BrowserMetrics-1.pma"
        old.write_bytes(b"histograms")
        os.chown(old, self.K, self.K)
        for p in ("", "profile", "profile/BrowserMetrics"):   # a kiosk-owned tree elsewhere, where a followed link would lead
            (self.out / p).mkdir(exist_ok=True)
            os.chown(self.out / p, self.K, self.K)

    def step(self, extra=None):
        """Step 1b in a private namespace; what it said, the mounts under top, the target's stat and what's under it."""
        def fn():
            root = os.open(self.vol, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            res = self.m.metrics_tmpfs(root, self.K, switch="on")
            out = {"res": res, "mounts": mounts_under(self.top)}
            t = self.vol / "browser/profile/BrowserMetrics"
            if t.is_dir() and not t.is_symlink():
                st, vfs = os.stat(t), os.statvfs(t)
                out["target"] = [st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode), vfs.f_blocks * vfs.f_frsize]
                fm = subprocess.run(["findmnt", "-J", "-o", "TARGET,SOURCE,FSTYPE,VFS-OPTIONS,FS-OPTIONS", str(t)], capture_output=True, text=True)
                out["findmnt"] = json.loads(fm.stdout)["filesystems"] if fm.returncode == 0 else []
            if extra:
                out["extra"] = extra(root)
            os.close(root)
            if res == "tmpfs":   # what's under it, as it was: unmount in this namespace only and look
                if ctypes.CDLL(None, use_errno=True).umount2(str(t).encode(), 0) != 0:
                    raise OSError(ctypes.get_errno(), "umount2")
                st = os.lstat(t)
                out["under"] = [st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode), sorted(os.listdir(t))]
            return out
        return isolated(fn)

    def test_the_mount_is_kiosks_0700_nosuid_nodev_noexec_32_mib(self):
        out = self.step()
        self.assertEqual(out["res"], "tmpfs")
        self.assertEqual(len(out["mounts"]), 1)
        self.assertEqual(out["target"], [self.K, self.K, 0o700, 32 << 20])
        fs = out["findmnt"][0]
        self.assertEqual((fs["source"], fs["fstype"]), ("desk-metrics", "tmpfs"))
        self.assertTrue({"nosuid", "nodev", "noexec", "rw"} <= set(fs["vfs-options"].split(",")), fs)
        self.assertTrue({"size=32768k", "mode=700", f"uid={self.K}", f"gid={self.K}"} <= set(fs["fs-options"].split(",")), fs)
        self.assertEqual(out["under"], [self.K, self.K, 0o700, ["BrowserMetrics-1.pma"]], "the volume's file stays under it, untouched")

    def test_kiosk_writes_there_and_no_other_uid_reads_it(self):
        def probe(_root):
            t = str(self.vol / "browser/profile/BrowserMetrics")
            res = {}
            for uid in (self.K, self.K + 1):
                pid = os.fork()
                if pid == 0:
                    try:
                        os.setgroups([])
                        os.setresgid(uid, uid, uid)
                        os.setresuid(uid, uid, uid)
                        with open(os.path.join(t, "BrowserMetrics-2.pma"), "wb") as fh:
                            fh.write(b"x" * 4096)
                        os._exit(0)
                    except OSError as e:
                        os._exit(e.errno)
                _, status = os.waitpid(pid, 0)
                res[str(uid)] = os.waitstatus_to_exitcode(status)
            return res
        out = self.step(extra=probe)
        self.assertEqual(out["extra"], {str(self.K): 0, str(self.K + 1): errno.EACCES})
        self.assertEqual(out["under"][3], ["BrowserMetrics-1.pma"], "kiosk's file went to the tmpfs, not the volume")

    def test_a_missing_BrowserMetrics_is_made_as_kiosk(self):
        shutil.rmtree(self.vol / "browser/profile/BrowserMetrics")
        out = self.step()
        self.assertEqual(out["res"], "tmpfs")
        self.assertEqual(out["under"], [self.K, self.K, 0o700, []], "kiosk's own directory, from its first moment")

    def test_a_missing_profile_and_BrowserMetrics_are_made_as_kiosk(self):
        shutil.rmtree(self.vol / "browser/profile")
        out = self.step()
        self.assertEqual(out["res"], "tmpfs")
        st = os.lstat(self.vol / "browser/profile")
        self.assertEqual((st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)), (self.K, self.K, 0o700))
        self.assertEqual(out["under"][:3], [self.K, self.K, 0o700])

    def test_the_make_runs_as_kiosk_not_root(self):
        """profile kiosk's but 0500: kiosk can't make a name in it, root could. Refused, nothing made."""
        shutil.rmtree(self.vol / "browser/profile/BrowserMetrics")
        os.chmod(self.vol / "browser/profile", 0o500)
        out = self.step()
        self.assertEqual(out["res"], "refused: BrowserMetrics: mkdirat as kiosk EACCES")
        self.assertEqual(out["mounts"], [])
        self.assertEqual(os.listdir(self.vol / "browser/profile"), [])

    def test_a_link_anywhere_is_refused_with_no_mount_and_nothing_made(self):
        for at, target in (("browser", self.out), ("browser/profile", self.out / "profile"),
                           ("browser/profile/BrowserMetrics", self.out / "profile/BrowserMetrics")):
            with self.subTest(link=at):
                self.setUp()
                p = self.vol / at
                shutil.rmtree(p)
                p.symlink_to(target)
                os.lchown(p, self.K, self.K)   # kiosk's link, as Chromium could put it
                before, outside = listing(self.vol), listing(self.out)
                out = self.step()
                self.assertTrue(out["res"].startswith(f"refused: {p.name}: openat2"), out["res"])
                self.assertEqual(out["mounts"], [], "no mount anywhere, the link's target included")
                self.assertEqual((listing(self.vol), listing(self.out)), (before, outside))

    def test_the_wrong_owner_is_refused(self):
        for at, uid in (("browser", 0), ("browser/profile", self.K + 1), ("browser/profile/BrowserMetrics", 0),
                        ("browser/profile/BrowserMetrics", 100000 + 65536 + 1100)):
            with self.subTest(at=at, uid=uid):
                self.setUp()
                os.chown(self.vol / at, uid, uid)
                out = self.step()
                self.assertEqual(out["res"], f"refused: {os.path.basename(at)}: uid {uid}'s, not kiosk's ({self.K})")
                self.assertEqual(out["mounts"], [])

    def test_the_wrong_type_is_refused(self):
        for kind in ("file", "fifo"):
            with self.subTest(kind=kind):
                self.setUp()
                p = self.vol / "browser/profile/BrowserMetrics"
                shutil.rmtree(p)
                p.write_bytes(b"x") if kind == "file" else os.mkfifo(p)
                os.lchown(p, self.K, self.K)
                out = self.step()
                self.assertEqual(out["res"], "refused: BrowserMetrics: openat2(RESOLVE_IN_ROOT|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV) ENOTDIR")
                self.assertEqual(out["mounts"], [])

    def test_the_desks_recursive_clone_carries_it_and_desk_datas_doesnt(self):
        """vol's order: step 1b on the volume's root, then open_tree(OPEN_TREE_CLONE|AT_RECURSIVE) for the desk and a plain clone for
        desk-data, each moved elsewhere. Here the 'volume' is a tmpfs at top/priv (vol's is the idmapped ext4)."""
        m = self.m
        priv, desk, data = self.top / "priv", self.top / "desk", self.top / "data"

        def fn():
            libc = ctypes.CDLL(None, use_errno=True)
            for d in (priv, desk, data):
                d.mkdir()
            if libc.mount(b"vol", str(priv).encode(), b"tmpfs", 0, b"mode=755") != 0:
                raise OSError(ctypes.get_errno(), "mount")
            for p, mode in (("browser", 0o750), ("browser/profile", 0o700)):
                (priv / p).mkdir(mode=mode)
                os.chown(priv / p, self.K, self.K)
            root = os.open(priv, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            res = m.metrics_tmpfs(root, self.K, switch="on")
            whole = m.sysc("open_tree", root, b"", m.OPEN_TREE_CLONE | m.OPEN_TREE_CLOEXEC | m.AT_EMPTY_PATH | m.AT_RECURSIVE)
            plain = m.sysc("open_tree", root, b"", m.OPEN_TREE_CLONE | m.OPEN_TREE_CLOEXEC | m.AT_EMPTY_PATH)
            for tree, at in ((whole, desk), (plain, data)):
                m.sysc("move_mount", tree, b"", -100, str(at).encode(), m.MOVE_MOUNT_F_EMPTY_PATH)
            got = {}
            for name, at in (("desk", desk), ("data", data)):
                t = at / "browser/profile/BrowserMetrics"
                fm = subprocess.run(["findmnt", "-n", "-o", "FSTYPE,SOURCE,FS-OPTIONS", "--mountpoint", str(t)], capture_output=True, text=True)
                got[name] = fm.stdout.split()
            return {"res": res, "got": got}
        out = isolated(fn)
        self.assertEqual(out["res"], "tmpfs")
        self.assertEqual(out["got"]["desk"][:2], ["tmpfs", "desk-metrics"])
        self.assertIn(f"uid={self.K}", out["got"]["desk"][2])
        self.assertEqual(out["got"]["data"], [], "desk-data's read-only clone of the volume isn't recursive: no tmpfs there")


if __name__ == "__main__":
    unittest.main(verbosity=2)
