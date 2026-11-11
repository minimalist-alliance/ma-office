#!/usr/bin/python3 -I
"""desk-host-check's `dirs` (sub/host-dir-modes): every directory desk-host and runc need has the owner, group and mode the recipe sets.
A temporary tree owned by the test's own user; no root, no host. python3 -I image/tests/test_host_dirs.py"""
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest

LIB = pathlib.Path(__file__).resolve().parent.parent / "host" / "recipe" / "files" / "usr/local/lib/desk-host"


def load_check():
    src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
    m = types.ModuleType("desk_host_check")
    m.__dict__["__name__"] = "desk_host_check"
    sys.path.insert(0, str(LIB))
    exec(compile(src, "desk-host-check", "exec"), m.__dict__)
    return m


class Dirs(unittest.TestCase):
    def setUp(self):
        self.m = load_check()
        self.tmp = tempfile.mkdtemp()
        self.m.DIRS_PREFIX = self.tmp
        self.m.DIRS_UID, self.m.DIRS_GID = os.getuid(), os.getgid()
        self.m.gid_of = lambda name: os.getgid()
        self.old = os.umask(0)
        for p, mode, _g, req, _w in self.m.DIRS:
            if req:
                self.mk(p, mode)

    def tearDown(self):
        os.umask(self.old)
        shutil.rmtree(self.tmp)

    def path(self, p):
        return self.tmp + p

    def mk(self, p, mode):
        os.makedirs(self.path(p), exist_ok=True)
        os.chmod(self.path(p), mode)

    def run_check(self):
        return self.m.c_dirs()

    def test_clean_tree_passes(self):
        ok, detail = self.run_check()
        self.assertTrue(ok, detail)

    def test_store_700_fails_then_711_passes(self):
        os.chmod(self.path("/srv/desk-host"), 0o700)
        ok, detail = self.run_check()
        self.assertFalse(ok)
        self.assertIn("/srv/desk-host is", detail)
        self.assertIn("mode 700", detail)
        os.chmod(self.path("/srv/desk-host"), 0o711)
        self.assertTrue(self.run_check()[0])

    def test_every_required_directory_is_judged(self):
        for p, mode, _g, req, _w in self.m.DIRS:
            if not req:
                continue
            with self.subTest(p=p):
                os.chmod(self.path(p), mode ^ 0o044 if mode & 0o044 else mode | 0o044)
                ok, detail = self.run_check()
                self.assertFalse(ok)
                self.assertIn(p + " is", detail)
                os.chmod(self.path(p), mode)
                self.assertTrue(self.run_check()[0])

    def test_group_writable_and_wrong_owner_fail(self):
        os.chmod(self.path("/var/lib/desk-host"), 0o771)
        self.assertFalse(self.run_check()[0])
        os.chmod(self.path("/var/lib/desk-host"), 0o711)
        self.m.DIRS_UID = os.getuid() + 1
        self.assertFalse(self.run_check()[0])
        self.m.DIRS_UID = os.getuid()
        self.m.DIRS_GID = os.getgid() + 1
        self.m.gid_of = lambda name: os.getgid() + 1
        self.assertFalse(self.run_check()[0])

    def test_missing_required_fails_missing_optional_passes(self):
        self.assertFalse(os.path.exists(self.path("/run/desk-host/share")))
        self.assertTrue(self.run_check()[0])
        shutil.rmtree(self.path("/run/desk-host/lock"))
        ok, detail = self.run_check()
        self.assertFalse(ok)
        self.assertIn("/run/desk-host/lock is missing", detail)

    def test_optional_directory_judged_where_present(self):
        self.mk("/run/desk-host/ns", 0o755)
        self.assertFalse(self.run_check()[0])
        os.chmod(self.path("/run/desk-host/ns"), 0o700)
        self.assertTrue(self.run_check()[0])

    def test_slot_roots_judged_and_crashed_trees_ignored(self):
        self.mk("/srv/desk-host/slots/3", 0o711)
        self.mk("/srv/desk-host/slots/3/svc", 0o711)
        self.mk("/srv/desk-host/slots/.3.new.123", 0o700)
        self.assertTrue(self.run_check()[0])
        os.chmod(self.path("/srv/desk-host/slots/3"), 0o700)
        ok, detail = self.run_check()
        self.assertFalse(ok)
        self.assertIn("/srv/desk-host/slots/3 is", detail)

    def test_group_of_dmx_slots(self):
        self.mk("/run/desk-dmx", 0o755)
        self.mk("/run/desk-dmx/slots", 0o750)
        self.assertTrue(self.run_check()[0])
        os.chmod(self.path("/run/desk-dmx/slots"), 0o755)
        self.assertFalse(self.run_check()[0])

    def test_a_file_where_a_directory_belongs_fails(self):
        shutil.rmtree(self.path("/srv/desk-host/releases"))
        pathlib.Path(self.path("/srv/desk-host/releases")).write_text("x")
        ok, detail = self.run_check()
        self.assertFalse(ok)
        self.assertIn("isn't a directory", detail)

    def test_registered_and_quick(self):
        self.assertIn("dirs", self.m.CHECKS)
        self.assertIn("dirs", self.m.QUICK)


RECIPE = LIB.parent.parent.parent.parent.parent   # image/host/recipe
SCRIPTS = {"build.sh": RECIPE / "build.sh", "desk-host-boot": LIB / "desk-host-boot", "desk-host": LIB / "desk-host"}
SETS = re.compile(r"(?:install -d((?: -[mog] \S+)*)|chmod (\d{3,4})|mkdir -m (\d{3,4})|mkdir -p)((?: +[^\s;&|(){}<>#]+)+)")


def assignments(text):
    """NAME=/path and NAME=$OTHER/path assignments, the first of each name, expanded"""
    out = {}
    for name, val in re.findall(r"(?:^|[;\s])([A-Z][A-Z0-9_]*)=([/$][^\s;]*)", text, re.M):
        out.setdefault(name, val)
    for _ in range(5):
        out = {n: re.sub(r"\$\{?([A-Z][A-Z0-9_]*)\}?", lambda m: out.get(m.group(1), m.group(0)), v) for n, v in out.items()}
    return out


def mode_sets(script):
    """(path, mode, line number) for every install -d, chmod NNN, mkdir -m NNN and mkdir -p in a recipe script whose path is
    known (its variables expanded; a slot's $k as {k}). install -d without -m is 755, and mkdir -p's new directory 755 (umask 022)."""
    text = SCRIPTS[script].read_text()
    var = assignments(text)
    out = []
    for no, line in enumerate(text.splitlines(), 1):
        code = line.split(" # ")[0]
        for opts, ch, mk, words in SETS.findall(code):
            m = re.search(r"-m (\d+)", opts)
            mode = int(m.group(1) if m else ch or mk or "755", 8)
            for w in words.split():
                w = w.strip('"')
                if w.startswith("-"):
                    continue
                w = re.sub(r"\$\{?k\}?", "{k}", w)
                w = re.sub(r"\$\{?([A-Z][A-Z0-9_]*)\}?", lambda x: var.get(x.group(1), x.group(0)), w)
                if "$" not in w and w.startswith("/"):
                    out.append((w, mode, no))
    return out


class RecipeSetsTheModes(unittest.TestCase):
    """The recipe's own lines against DIRS (sub/host-dirs). 0.1.13's stop-all ran `install -d -m 755 /run/desk-host`, against DIRS's 711
    and desk-host-boot's own line: install -d sets the mode of a directory that exists, so the stop left it 755, and dirs failed."""

    def setUp(self):
        self.m = load_check()
        self.want = {p: m for p, m, _g, _r, _w in self.m.DIRS}
        self.want.update({p: m for p, m, _w in self.m.DIRS_SLOT})

    def test_every_line_that_sets_a_checked_directory_sets_its_mode(self):
        seen = 0
        for script in SCRIPTS:
            for path, mode, no in mode_sets(script):
                if path in self.want:
                    seen += 1
                    with self.subTest(script=script, line=no, path=path):
                        self.assertEqual(oct(mode), oct(self.want[path]), f"{script}:{no} sets {path} to {mode:o}; dirs wants {self.want[path]:o}")
        self.assertGreater(seen, 20)   # the parse found the recipe's lines

    def test_boot_puts_every_required_directory_right(self):
        """desk-host-boot sets each directory dirs requires to its mode, so a host whose mode drifted is put right by its boot"""
        boot = {}
        for path, mode, _no in mode_sets("desk-host-boot"):
            boot.setdefault(path, set()).add(mode)
        for p, mode, _g, req, _w in self.m.DIRS:
            if req:
                with self.subTest(p=p):
                    self.assertEqual(boot.get(p), {mode}, f"desk-host-boot doesn't set {p} to {mode:o}")

    def test_the_parse_sees_the_stop_alls_line(self):
        self.assertIn(("/run/desk-host", 0o711), [(p, m) for p, m, _ in mode_sets("desk-host")])
        self.assertIn(("/run/desk-host/share", 0o711), [(p, m) for p, m, _ in mode_sets("desk-host")])

    def test_install_d_sets_the_mode_of_a_directory_that_exists(self):
        """What the boot's put-right rests on (GNU coreutils): install -d -m changes an existing directory's mode; mkdir -p doesn't"""
        with tempfile.TemporaryDirectory() as t:
            d = os.path.join(t, "d")
            os.mkdir(d)
            os.chmod(d, 0o755)
            subprocess.run(["install", "-d", "-m", "711", d], check=True)
            self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o711)
            subprocess.run(["mkdir", "-p", d], check=True)
            self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o711)


if __name__ == "__main__":
    unittest.main()
