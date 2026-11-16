#!/usr/bin/python3 -I
"""desk-host-warm (host 0.1.16), with no root and no AWS: python3 -I image/host/tests/test_warm.py

A new host's store read once at its first boot: every file of the current template generation and of the release store's current
copies, a large file in spans, its marker naming the store's serial; nothing on a store already read (the marker), on one a slot
has a record or a root on, or with WARM=off; links never followed; a desk's start stops it, and it says so.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.normpath(os.path.join(HERE, "../recipe/files/usr/local/lib/desk-host"))
WARM = os.path.join(LIB, "desk-host-warm")
ROOT = tempfile.mkdtemp(prefix="warm-test-")
COMPS = ("deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream")


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


class Warm(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(ROOT, ignore_errors=True)
        self.dh, self.var, self.cg = f"{ROOT}/store", f"{ROOT}/var", f"{ROOT}/cgroup"
        for d in (f"{self.dh}/slots", f"{self.dh}/templates/g1", f"{self.var}/slots", f"{self.var}/templates", self.cg):
            os.makedirs(d)
        write(f"{self.var}/store.serial", b"vol0123456789abcdef\n")
        self.conf = f"{ROOT}/desk-host.conf"
        write(self.conf, b"# defaults\n")
        g = f"{self.dh}/templates/g1"
        self.want = 0
        for i in range(40):   # a tree of small files, several levels deep
            data = os.urandom(1000 + 37 * i)
            write(f"{g}/usr/lib/d{i % 5}/sub{i % 3}/f{i}", data)
            self.want += len(data)
        big = os.urandom(9 * (1 << 20) + 12345)   # three spans and a bit
        write(f"{g}/usr/lib/chromium/chromium", big)
        self.want += len(big)
        write(f"{g}/empty", b"")
        write(f"{ROOT}/outside/huge", os.urandom(3 << 20))   # a link to it is never followed
        os.symlink(f"{ROOT}/outside/huge", f"{g}/usr/lib/link-out")
        os.symlink(f"{ROOT}/outside", f"{g}/usr/dir-out")
        write(f"{g}/.complete", b"g1\n")
        self.want += 3
        os.link(f"{g}/usr/lib/chromium/chromium", f"{g}/usr/lib/chromium/chromium-again")   # one inode, read once
        for c in COMPS:
            data = os.urandom(5000)
            write(f"{self.dh}/releases/{c}/1.0/rootfs/app/{c}.jar", data)
            write(f"{self.dh}/releases/{c}/0.9/rootfs/app/{c}.jar", os.urandom(7000))   # not current: not read
            os.symlink("1.0", f"{self.dh}/releases/{c}/current")
            self.want += len(data)
        write(f"{self.var}/templates/state.json", b'{"current": {"gen": "g1"}, "candidate": null, "previous": null, "halted": [], "maxGen": 1}\n')

    def run_warm(self, **env):
        e = dict(os.environ, DESK_HOST_STORE=self.dh, DESK_HOST_VAR=self.var, DESK_HOST_CGROUP=self.cg, DESK_HOST_CONF=self.conf,
                 DESK_HOST_TEMPLATES=f"{self.dh}/templates", DESK_HOST_TEMPLATES_VAR=f"{self.var}/templates", **env)
        r = subprocess.run([sys.executable, "-I", WARM], capture_output=True, text=True, env=e, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def marker(self):
        try:
            with open(f"{self.var}/warmed") as fh:
                return fh.read()
        except FileNotFoundError:
            return None

    def test_a_new_store_is_read_once_whole(self):
        out = self.run_warm()
        self.assertIn(f"({self.want} bytes)", out, "every file of g1 and of each release's current, the big one whole, no link followed")
        self.assertIn("6 trees", out)
        self.assertIn("whole", out)
        self.assertTrue(self.marker().startswith("vol0123456789abcdef "), self.marker())
        again = self.run_warm()
        self.assertIn("nothing to do", again)
        self.assertIn("was read at an earlier boot", again)

    def test_another_store_is_read_again(self):
        write(f"{self.var}/warmed", b"vol0000000000000000 2026-11-12T00:00:00Z ...\n")   # a marker from another volume (a restore)
        self.assertIn(f"({self.want} bytes)", self.run_warm())
        self.assertTrue(self.marker().startswith("vol0123456789abcdef "))

    def test_nothing_when_a_slot_has_a_record_or_a_root(self):
        write(f"{self.var}/slots/3.json", b"{}")
        self.assertIn("a slot has a record or a root", self.run_warm())
        self.assertIsNone(self.marker())
        os.unlink(f"{self.var}/slots/3.json")
        os.makedirs(f"{self.dh}/slots/.2.new.1234")   # a prepare's tree in flight
        self.assertIn("a slot has a record or a root", self.run_warm())
        self.assertIsNone(self.marker())

    def test_off_and_no_serial(self):
        write(self.conf, b"WARM=off\n")
        self.assertIn("off", self.run_warm())
        self.assertIsNone(self.marker())
        write(self.conf, b"")
        os.unlink(f"{self.var}/store.serial")
        self.assertIn("no store serial", self.run_warm())
        self.assertIsNone(self.marker())

    def test_a_desk_starting_stops_it(self):
        os.makedirs(f"{self.cg}/desk-1")
        out = self.run_warm()
        self.assertIn("stopped: a desk started", out)
        self.assertIn("stopped: a desk started", self.marker(), "the marker is written however it ends: it runs once for a store")

    def test_without_generations_the_single_template(self):
        # the 0.1.11 line: no templates state, one template at <store>/template
        shutil.rmtree(f"{self.var}/templates")
        os.rename(f"{self.dh}/templates/g1", f"{self.dh}/template")
        self.assertIn(f"({self.want} bytes)", self.run_warm())


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(ROOT, ignore_errors=True)
