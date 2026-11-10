#!/usr/bin/python3 -I
"""The shared host's size classes (image/host/.../classes.py, ADR 0072 section 16) on temporary files and fake cgroup trees.
No root, no host. python3 -I image/tests/test_host_classes.py"""
import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
FILES = IMAGE / "host" / "recipe" / "files"
MEM_TOTAL = 16061644 * 1024          # an m7g.xlarge's MemTotal as the host image reads it (15,685 MiB)
STORE = "259:1"


def load():
    spec = importlib.util.spec_from_file_location("desk_host_classes", FILES / "usr/local/lib/desk-host/classes.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.c = c = load()
        # the tests' own table, so they don't move when the shipped `free` is measured again (Shipped tests that one)
        (self.tmp / "classes.conf").write_text("standard 1 1 1 1 1 1 1\nfree 0.1 0.45 1 0.5 0.45 0.5 0.5\n")
        shutil.copy(FILES / "etc/desk-host/desk-host.conf", self.tmp / "desk-host.conf")
        (self.tmp / "hosting.json").write_text('{"desksPerHost": 6}')
        (self.tmp / "cg").mkdir(); (self.tmp / "run").mkdir()
        c.TABLE, c.CONF, c.HOSTING = str(self.tmp / "classes.conf"), str(self.tmp / "desk-host.conf"), str(self.tmp / "hosting.json")
        c.CGR, c.RUN = str(self.tmp / "cg"), str(self.tmp / "run")
        c.mem_total = lambda: MEM_TOTAL
        c.store_dev = lambda: STORE

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def table(self, body):
        p = self.tmp / "t.conf"
        p.write_text(body)
        return self.c.load(str(p))

    def desk(self, k, name, ty="m7g.xlarge", memory_of=None, io_of=None, pending=None, **over):
        """A fake running desk's cgroup and record, as desk-host writes them."""
        v, vm, vi = (self.c.values(n, ty) for n in (name, memory_of or name, io_of or name))
        d = self.tmp / "cg" / f"desk-{k}"
        d.mkdir(exist_ok=True)
        vals = {"cpu.idle": v["cpu.idle"], "cpu.weight": v["cpu.weight"], "memory.max": vm["memory.max"] // 4096 * 4096, "memory.swap.max": v["memory.swap.max"],
                "memory.zswap.max": v["memory.zswap.max"], "memory.zswap.writeback": 0, "pids.max": v["pids.max"], **over}
        for f, x in vals.items():
            (d / f).write_text(f"{x}\n")
        rrb, rri, rwb, rwi, vrb, vri, vwb, vwi = vi["io"]
        (d / "io.max").write_text(f"{STORE} rbps={rrb} wbps={rwb} riops={rri} wiops={rwi}\n259:{10 + k} rbps={vrb} wbps={vwb} riops={vri} wiops={vwi}\n")
        (self.tmp / "run" / str(k)).mkdir(exist_ok=True)
        (self.tmp / "run" / str(k) / "class.json").write_text(json.dumps({"class": name, "pending": {"memory.max": pending} if pending else None}))


class Standard(Base):
    def test_standard_is_014s_share_to_the_byte(self):
        """0.1.4's desk-host: memcap (MemTotal - 640 MiB) / N in bash, io_shares' float formula, 2G, 1000M, 100, 8192."""
        for ty, (mbps, iops) in (("m7g.xlarge", (156.25, 6000)), ("c7g.2xlarge", (312.5, 12000)), ("c7g.4xlarge", (625, 20000)), ("unknown", (156.25, 6000))):
            for n in (4, 6):
                (self.tmp / "hosting.json").write_text(json.dumps({"desksPerHost": n}))
                v = self.c.values("standard", ty)
                bps, io = mbps * 1e6 * 0.8 / n, iops * 0.8 / n
                old_io = [x for f in (0.40, 0.10, 0.25, 0.25) for x in (max(1, int(bps * f)), max(1, int(io * f)))]
                self.assertEqual(v["memory.max"], (MEM_TOTAL - 640 * 1048576) // n, (ty, n))
                self.assertEqual(v["io"], old_io, (ty, n))
                self.assertEqual((v["memory.swap.max"], v["memory.zswap.max"], v["cpu.weight"], v["pids.max"]), (2 << 30, 1000 << 20, 100, 8192))

    def test_free_is_smaller_in_everything_it_shares(self):
        f, s = self.c.values("free", "m7g.xlarge"), self.c.values("standard", "m7g.xlarge")
        self.assertLess(f["memory.max"], s["memory.max"]); self.assertLess(f["cpu.weight"], s["cpu.weight"])
        self.assertLessEqual(f["pids.max"], s["pids.max"]); self.assertTrue(all(a <= b for a, b in zip(f["io"], s["io"])))


class Table(Base):
    def bad(self, body, why):
        probs = self.table(body)[1]
        self.assertTrue(any(why in p for p in probs), probs)

    def test_refusals(self):
        self.bad("free 0.1 0.5 1 1 1 1 1\n", "no standard class")
        self.bad("standard 1 1 1 1 1 1 0.9\n", "isn't all 1s")
        self.bad("standard 1 1 1 1 1 1 1\nfree 0.005 0.5 1 1 1 1 1\n", "outside 0.01")
        self.bad("standard 1 1 1 1 1 1 1\nfree 0 0 1 1 1 1 1\n", "free memory 0 is outside 0.01")   # only cpu may be 0
        self.bad("standard 1 1 1 1 1 1 1\nfree 0.1 4.5 1 1 1 1 1\n", "outside 0.01")
        self.bad("standard 1 1 1 1 1 1 1\nfree 0.1 0.5 1 1 1 1\n", "7 fields")
        self.bad("standard 1 1 1 1 1 1 1\nFree 0.1 0.5 1 1 1 1 1\n", "bad class name")
        self.bad("standard 1 1 1 1 1 1 1\nx 1e2 1 1 1 1 1 1\n", "isn't a decimal")
        self.bad("standard 1 1 1 1 1 1 1\nfree 0.1 0.5 1 1 1 1 1\nfree 0.1 0.5 1 1 1 1 1\n", "twice")
        self.bad("standard 1 1 1 1 1 1 1\nx 0.1234 1 1 1 1 1 1\n", "isn't a decimal")

    def test_comments_and_blank_lines(self):
        t, probs = self.table("# a comment\n\nstandard 1 1 1 1 1 1 1   # standard\nbig 10 1 1 1 1 1 1\n")
        self.assertEqual(probs, []); self.assertEqual(list(t), ["standard", "big"])


class Tag(Base):
    def test_forms(self):
        p = self.c.parse_tag
        d, v, ip, a = "d-abcdef12", "vol-0123456789abcdef0", "10.0.1.5", "eipalloc-0123456789abcdef0"
        self.assertEqual(p(f"{d}/{v}"), (d, v, "standard"))                       # 0.1.4's
        self.assertEqual(p(f"{d}/{v}/{ip}/{a}/3"), (d, v, "standard"))            # the contract's 5 fields
        self.assertEqual(p(f"{d}/{v}/{ip}/{a}/3/free"), (d, v, "free"))           # the proposed 6th
        self.assertEqual(p(f"-/-/{ip}/{a}/3"), ("-", "-", "standard"))            # an empty slot
        for bad in (f"-/{v}/{ip}/{a}/3", f"{d}/{v}/{ip}/{a}/3/Free", f"{d}/{v}/{ip}/eipalloc-01/3/free", f"{d}/{v}/x",
                    f"{d}/{v}/{ip}/{a}/3/free/x", f"{d}/{v}/999.0.0.1/{a}/3", f"{d}/{v}/{ip}/{a}/-1", "", f"{d}"):
            self.assertIsNone(p(bad), bad)


class Admission(Base):
    def test_two_paid_and_eight_free_fit_and_a_ninth_doesnt(self):
        for k in (1, 2):
            self.desk(k, "standard")
        for k in range(3, 11):
            self.desk(k, "free")
        ok, why = self.c.applied("m7g.xlarge")
        self.assertTrue(ok, why)
        self.assertFalse(self.c.admit(11, "free", "m7g.xlarge")[0])
        self.assertFalse(self.c.admit(11, "standard", "m7g.xlarge")[0])
        self.assertFalse(self.c.admit(3, "standard", "m7g.xlarge")[0])     # the raise past 6 units
        self.assertTrue(self.c.admit(3, "free", "m7g.xlarge")[0])          # its own size again

    def test_six_standard_fill_a_host_exactly(self):
        for k in range(1, 6):
            self.desk(k, "standard")
        self.assertTrue(self.c.admit(6, "standard", "m7g.xlarge")[0])
        self.desk(6, "standard")
        self.assertFalse(self.c.admit(7, "free", "m7g.xlarge")[0])

    def test_a_cgroup_without_limits_counts_as_full(self):
        (self.tmp / "cg" / "desk-9").mkdir()
        (self.tmp / "cg" / "desk-9" / "memory.max").write_text("max\n")
        self.assertFalse(self.c.admit(1, "free", "m7g.xlarge")[0])


class Idle(Base):
    """A class's cpu 0 is cpu.idle: desk-host writes cpu.idle 1 and no weight; the kernel then shows cpu.weight 1."""
    def setUp(self):
        super().setUp()
        (self.tmp / "classes.conf").write_text("standard 1 1 1 1 1 1 1\nfree 0 0.4 1 0.5 0.4 0.5 0.5\n")

    def test_cpu_zero_is_cpu_idle(self):
        f, s = self.c.values("free", "m7g.xlarge"), self.c.values("standard", "m7g.xlarge")
        self.assertEqual((f["cpu.idle"], f["cpu.weight"], s["cpu.idle"], s["cpu.weight"]), (1, 1, 0, 100))
        self.assertEqual(self.c.order(f).split()[0], "0"); self.assertEqual(self.c.order(s).split()[0], "100")

    def test_applied_reads_cpu_idle(self):
        self.desk(1, "standard"); self.desk(2, "free")
        ok, why = self.c.applied("m7g.xlarge")
        self.assertTrue(ok, why)
        self.desk(2, "free", **{"cpu.idle": 0, "cpu.weight": 100})       # a free desk at a paid desk's CPU
        ok, why = self.c.applied("m7g.xlarge")
        self.assertFalse(ok); self.assertIn("desk-2 (free) cpu.idle 0, not 1", why)
        self.desk(2, "free"); self.desk(1, "standard", **{"cpu.idle": 1, "cpu.weight": 1})   # a paid desk left idle
        ok, why = self.c.applied("m7g.xlarge")
        self.assertFalse(ok); self.assertIn("desk-1 (standard) cpu.idle 1, not 0", why)


class Applied(Base):
    def test_a_tampered_value_fails(self):
        self.desk(1, "standard"); self.desk(2, "free", **{"cpu.weight": 100})
        ok, why = self.c.applied("m7g.xlarge")
        self.assertFalse(ok); self.assertIn("desk-2 (free) cpu.weight 100", why)

    def test_a_desk_without_a_record_fails(self):
        (self.tmp / "cg" / "desk-29").mkdir()
        ok, why = self.c.applied("m7g.xlarge")
        self.assertFalse(ok); self.assertIn("no class record", why)

    def test_a_lower_cap_waiting_passes(self):
        free = self.c.values("free", "m7g.xlarge")["memory.max"]
        self.desk(1, "free", memory_of="standard", pending=free)       # downgraded, its standard cap kept until the next start
        ok, why = self.c.applied("m7g.xlarge")
        self.assertTrue(ok, why)

    def test_a_raise_waiting_passes_and_counts_what_it_holds(self):
        for k in (1, 2):
            self.desk(k, "standard")
        for k in range(4, 11):
            self.desk(k, "free")
        std = self.c.values("standard", "m7g.xlarge")["memory.max"]
        self.desk(3, "standard", memory_of="free", io_of="free", pending=std)   # upgraded, memory and disk waiting for room
        ok, why = self.c.applied("m7g.xlarge")
        self.assertTrue(ok, why); self.assertIn("3:standard(waiting)", why); self.assertIn("memory 5.60", why)

    def test_a_pending_value_that_isnt_the_class_fails(self):
        self.desk(1, "free", memory_of="standard", pending=12345)
        self.assertFalse(self.c.applied("m7g.xlarge")[0])


class Shipped(Base):
    """The table the image ships (/etc/desk-host/classes.conf), as measured (spikes/host-size-classes/README.md)."""
    def setUp(self):
        super().setUp()
        shutil.copy(FILES / "etc/desk-host/classes.conf", self.tmp / "classes.conf")

    def test_valid_with_standard_and_free(self):
        t, probs = self.c.load()
        self.assertEqual(probs, [])
        self.assertEqual(set(t), {"standard", "free"})

    def test_free_is_the_measured_row(self):
        t, _ = self.c.load()
        self.assertEqual({f: float(v) for f, v in t["free"].items() if f != "split"},
                         {"cpu": 0.0, "memory": 0.4, "swap": 1.0, "zswap": 0.5, "disk": 0.4, "pids": 0.5, "egress": 0.5})
        self.assertEqual(self.c.values("free", "m7g.xlarge")["cpu.idle"], 1)
        self.assertEqual(t["free"]["split"], [0.7, 0.05, 0.125, 0.125])      # root reads 70% of its share: the cold wake

    def test_two_paid_and_ten_free_fill_an_m7g_xlarge(self):
        for k in (1, 2):
            self.desk(k, "standard")
        for k in range(3, 12):
            self.desk(k, "free")
        self.assertTrue(self.c.admit(12, "free", "m7g.xlarge")[0])
        self.desk(12, "free")
        self.assertTrue(self.c.applied("m7g.xlarge")[0])
        self.assertFalse(self.c.admit(13, "free", "m7g.xlarge")[0])


class Split(Base):
    """A class's own IO_SPLIT (the table's optional 8th column): the same disk share, divided another way."""
    def setUp(self):
        super().setUp()
        (self.tmp / "classes.conf").write_text("standard 1 1 1 1 1 1 1\nfree 0 0.4 1 0.5 0.4 0.5 0.5 70,5,12.5,12.5\n")

    def test_parse(self):
        t, probs = self.c.load()
        self.assertEqual(probs, [])
        self.assertEqual(t["free"]["split"], [0.7, 0.05, 0.125, 0.125])
        self.assertNotIn("split", t["standard"])

    def test_bad_splits_are_problems(self):
        for bad in ("70,5,12.5", "70,5,12.5,13", "99,0,0.5,0.5", "a,b,c,d", "70,5,12.123,12.877"):
            (self.tmp / "classes.conf").write_text(f"standard 1 1 1 1 1 1 1\nfree 0 0.4 1 0.5 0.4 0.5 0.5 {bad}\n")
            t, probs = self.c.load()
            self.assertTrue(probs, bad)
            self.assertNotIn("free", t)

    def test_same_total_other_division(self):
        free = self.c.values("free", "m7g.xlarge")
        std = self.c.values("standard", "m7g.xlarge")
        self.assertEqual(self.c.disk_bps(std), sum(std["io"][i] for i in (0, 2, 4, 6)))
        self.assertAlmostEqual(self.c.disk_bps(free) / self.c.disk_bps(std), 0.4, places=4)
        self.assertAlmostEqual(free["io"][0] / self.c.disk_bps(free), 0.7, places=4)       # root reads 70% of its share
        self.assertAlmostEqual(std["io"][0] / self.c.disk_bps(std), 0.4, places=4)         # standard keeps the host's 40

    def test_admission_counts_the_whole_share(self):
        for k in (1, 2):
            self.desk(k, "standard")
        for k in range(3, 13):
            self.desk(k, "free")
        self.assertTrue(self.c.applied("m7g.xlarge")[0])
        self.assertFalse(self.c.admit(13, "free", "m7g.xlarge")[0])


class Recipe(unittest.TestCase):
    def test_the_host_recipe_ships_both_files(self):
        self.assertTrue((FILES / "etc/desk-host/classes.conf").is_file())
        self.assertTrue(os.access(FILES / "usr/local/lib/desk-host/classes.py", os.R_OK))
        build = (IMAGE / "host" / "recipe" / "build.sh").read_text()
        self.assertIn("apparmor,classes", build)   # the build's own check of the table


if __name__ == "__main__":
    unittest.main()
