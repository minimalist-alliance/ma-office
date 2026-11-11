#!/usr/bin/python3 -I
"""Free walk H5: Files on a shared host's desk. Up to host image 0.1.10 a slot's deskd had only the volume's /data/desk in its
sandbox, whose /data is a small root-owned tmpfs, so deskd couldn't make /data/files and every files.* answered unavailable
{reason: "tree"}. Now the volume's own files directory (1100:1100 0700) is moved in too, as /data/desk is. No root, no host.

- mounts.py's clone_dirs: deskd's files is optional (missing, a link or a file skips only that mount, resolved without links,
  never followed, and deskd still starts); its desk is required, as before; the other services as before.
- svc-spec.py: deskd's sandbox has a placeholder at /data/files as at /data/desk; no other sandbox gets one.
- desk-init.py's datadirs(): the desk makes /data/files (desk:desk 0700) and replaces a link there, as for its other directories.
- desk-host-check's `files`: passes on the volume's directory as 1100:1100 0700, fails on 0.1.10's placeholder, on a tmpfs
  that isn't the volume, and on deskd's "the Files tree can't be used" since its last start; says (doesn't fail) a skip.

python3 -I image/tests/test_host_files_slot.py"""
import copy
import errno
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import types
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
LIB = IMAGE / "host" / "recipe" / "files" / "usr/local/lib/desk-host"


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ClonePolicy(unittest.TestCase):
    """mounts.py's step 2 with the volume faked: openat2 fails as the volume says, open_tree hands out numbers."""

    def setUp(self):
        self.m = load_file("mounts_h5", LIB / "mounts.py")
        self.vol = {"desk": "dir", "files": "dir", "agent": "dir", "notebook": "dir", "rtc": "dir"}
        self.link_errno = "ENOTDIR"
        self.opened, self.closed, self.n = [], [], [100]

        def openat2(root, path, flags, resolve=self.m.RESOLVE):
            self.opened.append((path, resolve))
            what = self.vol.get(path, "missing")
            if what == "missing":
                raise OSError(errno.ENOENT, "openat2")
            if what == "link":   # O_PATH|O_NOFOLLOW|O_DIRECTORY on a link: ENOTDIR (the lab's kernel); RESOLVE_NO_SYMLINKS: ELOOP
                raise OSError(errno.ENOTDIR if self.link_errno == "ENOTDIR" else errno.ELOOP, "openat2")
            if what == "file":
                raise OSError(errno.ENOTDIR, "openat2")
            self.n[0] += 1
            return self.n[0]

        def sysc(name, *a):
            assert name == "open_tree", name
            self.n[0] += 1
            return self.n[0]

        self.m.openat2, self.m.sysc = openat2, sysc
        self.m.os = types.SimpleNamespace(**{k: getattr(os, k) for k in ("O_PATH", "O_DIRECTORY", "O_NOFOLLOW")},
                                          close=lambda fd: self.closed.append(fd))

    def run_it(self):
        return self.m.clone_dirs(3, self.m.SERVICES, lambda svc: True)

    def test_deskd_gets_desk_and_files(self):
        trees, refused, skipped = self.run_it()
        self.assertEqual([s for s, _ in trees["deskd"]], ["desk", "files"])
        self.assertEqual((refused, skipped), ([], {}))
        self.assertTrue(all(r == self.m.RESOLVE for _p, r in self.opened), "every directory resolved in the volume's root, no links, no crossings")

    def test_a_volume_from_before_with_no_files_skips_only_that_mount(self):
        del self.vol["files"]
        trees, refused, skipped = self.run_it()
        self.assertEqual([s for s, _ in trees["deskd"]], ["desk"])
        self.assertNotIn("deskd", refused)
        self.assertEqual(skipped, {"deskd": {"files": "ENOENT"}})

    def test_a_link_or_a_file_at_files_is_never_followed_and_deskd_still_runs(self):
        for what, code, link_errno in (("link", "ENOTDIR", "ENOTDIR"), ("link", "ELOOP", "ELOOP"), ("file", "ENOTDIR", "ENOTDIR")):
            with self.subTest(what=what, errno=code):
                self.vol["files"], self.link_errno = what, link_errno
                trees, refused, skipped = self.run_it()
                self.assertEqual([s for s, _ in trees["deskd"]], ["desk"])
                self.assertEqual((refused, skipped), ([], {"deskd": {"files": code}}))

    def test_deskd_without_its_desk_is_refused_as_before(self):
        self.vol["desk"] = "link"
        trees, refused, skipped = self.run_it()
        self.assertNotIn("deskd", trees)
        self.assertEqual(refused, ["deskd"])
        self.assertNotIn("files", [p for p, _r in self.opened], "nothing more is opened for a refused service")

    def test_the_other_services_as_before(self):
        self.vol["agent"] = "link"
        del self.vol["rtc"]
        trees, refused, skipped = self.run_it()
        self.assertEqual(sorted(refused), ["desk-agent", "desk-rtc"])
        self.assertEqual(skipped, {})
        self.assertEqual([s for s, _ in trees["desk-notebook"]], ["notebook"])

    def test_a_blank_volume_gets_files_with_the_desk_s_owner(self):
        self.assertEqual(self.m.DIRS["files"], (1100, 1100, 0o700))


DOCKER = {
    "process": {}, "hooks": {}, "annotations": {}, "root": {},
    "mounts": [{"destination": d, "type": "x", "source": "x", "options": []} for d in ("/proc", "/dev", "/dev/pts", "/sys")],
    "linux": {"seccomp": {"syscalls": [], "architectures": []}, "maskedPaths": [], "resources": {"devices": []},
              "uidMappings": [], "gidMappings": [], "sysctl": {}},
}


class SpecPlaceholders(unittest.TestCase):
    def test_deskd_has_a_placeholder_at_data_files_and_no_one_else(self):
        tmp = tempfile.mkdtemp()
        t = pathlib.Path(tmp) / "templates" / "g1" / "etc"   # slot 2's own template generation (ADR 0077), as its record names it
        t.mkdir(parents=True)
        (t.parent / ".complete").write_text("gen=g1\n")
        (pathlib.Path(tmp) / "slots").mkdir()
        (pathlib.Path(tmp) / "slots" / "2.json").write_text('{"slot": 2, "state": "desk", "template": "g1"}')
        old_rec = os.environ.get("DESK_HOST_RECORDS")
        os.environ["DESK_HOST_RECORDS"] = str(pathlib.Path(tmp) / "slots")
        self.addCleanup(lambda: os.environ.pop("DESK_HOST_RECORDS") if old_rec is None else os.environ.__setitem__("DESK_HOST_RECORDS", old_rec))
        names = "rtc stream desk-snd desk-x desk-dns desk-data agent notebook deskd".split()
        (t / "passwd").write_text("".join(f"{n}:x:{1100 + i}:{1100 + i}::/:/bin/false\n" for i, n in enumerate(names)))
        (t / "group").write_text("".join(f"{n}:x:{1100 + i}:\n" for i, n in enumerate(names + ["desk", "desk-audio"])))
        sys.path.insert(0, str(LIB))
        for mod in ("wallspec",):
            sys.modules.pop(mod, None)
        import wallspec
        wallspec.DH = tmp
        wallspec.docker_spec = lambda: copy.deepcopy(DOCKER)
        m = load_file("svc_spec_h5", LIB / "svc-spec.py")
        placeholders = {}
        for svc in m.SERVICES:
            placeholders[svc] = sorted(x["destination"] for x in m.spec(2, svc)["mounts"]
                                       if x["destination"].startswith("/data/") and x["type"] == "tmpfs" and "mode=000" in x["options"])
        self.assertEqual(placeholders["deskd"], ["/data/desk", "/data/files"])
        self.assertEqual(placeholders["desk-agent"], ["/data/agent"])
        self.assertEqual(placeholders["desk-data"], [])
        self.assertFalse([s for s, p in placeholders.items() if s != "deskd" and "/data/files" in p])


class DataDirs(unittest.TestCase):
    """desk-init.py's datadirs() alone, its paths moved under a temporary directory: what it makes and what it replaces."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        src = (LIB / "desk/desk-init.py").read_text()
        a = src.index("def datadirs():")
        body = src[a:src.index("\ndef ", a + 10)]
        for p in ("/data", "/run/desk-audio", "/var/tmp", "/root"):
            body = body.replace(f'"{p}', f'ROOT + "{p}')
        self.made, self.logged = {}, []
        g = {"os": os, "time": __import__("time"), "ROOT": str(self.tmp), "log": self.logged.append,
             "run_helper": lambda *a, **kw: None, "as_user": lambda *a, **kw: types.SimpleNamespace(returncode=0),   # inside a user's folder (slot-datadirs)
             "mkdir": lambda path, u, g_, mode: (os.makedirs(path, exist_ok=True), self.made.__setitem__(path[len(str(self.tmp)):], (u, g_, mode)))}
        exec(compile(body, "desk-init.py:datadirs", "exec"), g)
        self.datadirs = g["datadirs"]
        (self.tmp / "data").mkdir()

    def test_the_desk_makes_its_files_directory(self):
        self.datadirs()
        self.assertEqual(self.made["/data/files"], ("desk", "desk", 0o700))
        self.assertEqual(self.made["/data/desk"], ("desk", "desk", 0o750))

    def test_a_link_at_data_files_is_replaced_not_followed(self):
        (self.tmp / "data" / "agent").mkdir()
        (self.tmp / "data" / "agent" / "keys").write_text("an agent's")
        os.symlink("agent", self.tmp / "data" / "files")
        self.datadirs()
        self.assertFalse((self.tmp / "data" / "files").is_symlink())
        self.assertTrue((self.tmp / "data" / "files").is_dir())
        self.assertEqual((self.tmp / "data" / "agent" / "keys").read_text(), "an agent's")
        self.assertTrue(any("/data/files isn't a directory" in x for x in self.logged), self.logged)


def load_check():
    src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
    m = types.ModuleType("desk_host_check_h5")
    sys.path.insert(0, str(LIB))   # its modules (templates.py, ADR 0077) beside it
    exec(compile(src, "desk-host-check", "exec"), m.__dict__)
    return m


class FilesCheck(unittest.TestCase):
    """desk-host-check's `files` on one running slot (k=2), its sandbox and volume faked."""
    K, BASE, PID, VOL = 2, 100000 + 2 * 65536, 4242, os.makedev(259, 3)

    def setUp(self):
        self.m = load_check()
        self.logs = tempfile.mkdtemp()
        self.m.SLOT_LOGS = self.logs
        self.mounts = {"refused": [], "skipped": {}, "device": "/dev/nvme3n1"}
        self.files = dict(mode=stat.S_IFDIR | 0o700, uid=self.BASE + 1100, gid=self.BASE + 1100, dev=self.VOL)
        self.log("[desk-svc 10:00:00] started /opt/java/openjdk/bin/java pid 77\n2026 INFO deskd ready in 900 ms\n")
        self.m.running_slots = lambda: {self.K}
        self.m.rd = lambda p: json.dumps(self.mounts) if p == f"/run/desk-host/{self.K}.mounts.json" else None
        self.m.sh = lambda *a, **kw: subprocess.CompletedProcess(a, 0, json.dumps({"pid": self.PID}), "")

        def lstat(p):
            assert p == f"/proc/{self.PID}/root/data/files", p
            f = self.files
            return types.SimpleNamespace(st_mode=f["mode"], st_uid=f["uid"], st_gid=f["gid"], st_dev=f["dev"])

        def stat_(p):
            assert p == "/dev/nvme3n1", p
            return types.SimpleNamespace(st_rdev=self.VOL)
        self.m.os = types.SimpleNamespace(lstat=lstat, stat=stat_, major=os.major, minor=os.minor)

    def log(self, text):
        with open(f"{self.logs}/svc-{self.K}-deskd.log", "a") as f:
            f.write(text)

    def test_the_volume_s_directory_passes(self):
        ok, why = self.m.c_files()
        self.assertTrue(ok, why)
        self.assertIn("1 with deskd's /data/files its volume's", why)

    def test_0_1_10_s_placeholder_fails(self):
        self.files.update(mode=stat.S_IFDIR | 0o000, uid=self.BASE, gid=self.BASE, dev=os.makedev(0, 77))
        ok, why = self.m.c_files()
        self.assertFalse(ok)
        self.assertIn("0:0 0000", why)

    def test_a_tmpfs_that_isn_t_the_volume_fails(self):
        self.files.update(dev=os.makedev(0, 78))
        ok, why = self.m.c_files()
        self.assertFalse(ok)
        self.assertIn("isn't on its volume", why)

    def test_deskd_saying_the_tree_can_t_be_used_since_its_start_fails_and_before_it_doesn_t(self):
        self.log("2026 WARN the Files tree can't be used: AccessDeniedException\n")
        self.assertFalse(self.m.c_files()[0])
        self.log("[desk-svc 10:05:00] started /opt/java/openjdk/bin/java pid 78\n")   # a restart since: that run's log
        self.assertTrue(self.m.c_files()[0])

    def test_a_skip_is_said_not_failed(self):
        self.mounts["skipped"] = {"deskd": {"files": "ENOENT"}}
        self.files.update(mode=stat.S_IFDIR, uid=self.BASE, gid=self.BASE, dev=os.makedev(0, 77))
        ok, why = self.m.c_files()
        self.assertTrue(ok, why)
        self.assertIn("the volume's files ENOENT", why)

    def test_nothing_running(self):
        self.m.running_slots = lambda: set()
        self.assertTrue(self.m.c_files()[0])


if __name__ == "__main__":
    unittest.main(verbosity=1)
