#!/usr/bin/python3 -I
"""ADR 0036's outbound shaper per container on a shared host (ADR 0072 section 8, TD-223): egress.py (the desk's own desk-egress run
by the host for each slot), desk-host-check's `shaper`, the report's view, desk-host's hooks, desk-stream's profile mount and
desk-init's restart on a profile change. Fake tc, nft and systemctl; no root, no host. python3 -I image/tests/test_host_shaper.py"""
import copy
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import types
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
FILES = IMAGE / "host" / "recipe" / "files"
LIB = FILES / "usr/local/lib/desk-host"
GB = 10**9
DESK = "d-shapertestdeska"


def load(path, name):
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, str(path)))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


import importlib.machinery  # noqa: E402

DE = load(IMAGE / "recipe/desk-egress/desk-egress", "desk_egress")


def egress_mod(tmp):
    m = load(LIB / "egress.py", "egress_under_test")
    m.DE = DE
    m.RUN = f"{tmp}/run"
    m.STATE_DIR = f"{tmp}/state"
    m.CONF = f"{tmp}/egress.conf"
    m.OFF = f"{m.RUN}/shaper-off"
    return m


def proc(rc=0, out="", err=""):
    return types.SimpleNamespace(returncode=rc, stdout=out, stderr=err)


def htb_class(minor, mbps, nbytes=0, ceil=None, drops=0):
    b = int(mbps * 1e6) // 8
    return {"class": "htb", "handle": f"1:{minor}", "parent": "1:", "leaf": f"0x{minor}", "rate": b, "ceil": b if ceil is None else ceil,
            "stats": {"bytes": nbytes, "packets": nbytes // 1000, "drops": drops, "overlimits": 0}}


QDISCS = [{"kind": "htb", "handle": "1:", "root": True}, {"kind": "pfifo", "handle": "10:", "parent": "1:10"},
          {"kind": "fq_codel", "handle": "15:", "parent": "1:15"}, {"kind": "fq_codel", "handle": "20:", "parent": "1:20"}]
CLASSIFY = """table inet ma {
	chain classify {
		type filter hook output priority -150; policy accept;
		oif "lo" return
		meta skuid 1101 udp sport 443 meta priority set 1:10
		meta skuid 1101 tcp sport 443 meta priority set 1:10
		meta skuid { 0, 1100 } meta priority set 1:15
		meta skuid 1101 udp sport 4432 meta priority set 1:10
	}
}
"""


class FakeHost:
    """tc, nft and systemctl as a slot's namespace and the host answer them; argv recorded."""

    def __init__(self, classes=None, qdiscs=None, classify=CLASSIFY, active="active", tc_fails=False):
        self.classes = [htb_class("10", 60), htb_class("15", 2), htb_class("20", 100)] if classes is None else classes
        self.qdiscs = QDISCS if qdiscs is None else qdiscs
        self.classify, self.active, self.tc_fails, self.calls, self.stdin = classify, active, tc_fails, [], []

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))
        if kw.get("input"):
            self.stdin.append(kw["input"])
        a = list(argv)
        if a[0].endswith("nsenter"):
            assert a[1].startswith("--net=") and a[1].endswith("/net"), a
            a = a[2:]
        if a[0].endswith("tc"):
            if self.tc_fails:
                return proc(1, "", "Cannot find device \"eth0\"")
            if a[1:5] == ["-j", "-s", "class", "show"]:
                return proc(0, json.dumps(self.classes))
            if a[1:4] == ["-j", "qdisc", "show"]:
                return proc(0, json.dumps([q for q in self.qdiscs if ("root" not in a) or q.get("root")]))
            return proc(0)
        if a[0].endswith("nft"):
            return proc(0, self.classify)
        if a[0].endswith("systemctl"):
            return proc(0 if self.active == "active" else 3, self.active + "\n")
        raise AssertionError(f"unexpected {argv}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.eg = egress_mod(self.tmp)
        os.makedirs(f"{self.eg.RUN}/2/egress")
        os.makedirs(self.eg.STATE_DIR)
        self.slot(2, DESK, egress="1", boot="start-1")

    def slot(self, k, desk, egress="1", boot="start-1"):
        os.makedirs(f"{self.eg.RUN}/{k}", exist_ok=True)
        pathlib.Path(f"{self.eg.RUN}/{k}/slot.json").write_text(json.dumps({"slot": k, "deskId": desk, "epoch": 3}))
        pathlib.Path(f"{self.eg.RUN}/{k}/class.json").write_text(json.dumps({"class": "x", "units": {"egress": egress}}))
        pathlib.Path(f"{self.eg.RUN}/{k}/net.json").write_text(json.dumps({"bytesOut": 0, "bytesIn": 0, "boot": boot}))

    def conf(self, text):
        pathlib.Path(self.eg.CONF).write_text(text)


class Settings(Base):
    def test_defaults_are_a_desk_of_its_owns_on_eth0(self):
        c = self.eg.conf_for(2)
        for k, v in DE.DEFAULTS.items():
            self.assertEqual(c[k], "eth0" if k == "interface" else v, k)

    def test_the_shipped_file_is_the_desks_values(self):
        def vals(p):
            return {l.split("=")[0].strip(): l.split("=")[1].strip() for l in pathlib.Path(p).read_text().splitlines()
                    if "=" in l and not l.startswith("#")}
        host, desk = vals(FILES / "etc/desk-host/egress.conf"), vals(IMAGE / "recipe/files/etc/ma/egress.conf")
        desk.pop("interface")
        self.assertEqual(host, desk)

    def test_slot_section_only_for_its_slot_and_bad_values_ignored(self):
        self.conf("[egress]\nbucket_gb = 20\nother_mbps = nonsense\n[slot2]\nbucket_gb = 0.5\ntick_seconds = 10\ninterface = ens5\nroot_mbps = 0\n")
        c2, c3 = self.eg.conf_for(2), self.eg.conf_for(3)
        self.assertEqual((c2["bucket_gb"], c2["tick_seconds"], c2["interface"], c2["root_mbps"], c2["other_mbps"]), (0.5, 10, "eth0", 2.0, 100.0))
        self.assertTrue(c2["slot_override"])
        self.assertEqual((c3["bucket_gb"], c3["tick_seconds"]), (20, 60))
        self.assertFalse(c3["slot_override"])

    def test_the_class_multiplies_rates_only(self):
        c = self.eg.conf_for(2, 0.5)
        self.assertEqual((c["stream_mbps"], c["root_mbps"], c["other_mbps"], c["slowed_other_mbps"], c["clamped_stream_mbps"]), (30, 1, 50, 0.375, 0.5))
        self.assertEqual((c["bucket_gb"], c["capped_month_gb"]), (30, 100))

    def test_multiple_from_class_json(self):
        self.slot(2, DESK, egress="0.5")
        self.assertEqual(self.eg.egress_multiple(2), 0.5)
        for bad in ("x", "0", "9", None):
            self.slot(2, DESK, egress=bad)
            self.assertEqual(self.eg.egress_multiple(2), 1.0, bad)
        self.assertEqual(self.eg.egress_multiple(5), 1.0)   # no class.json

    def test_slot_desk_must_be_a_desk_id(self):
        self.assertEqual(self.eg.slot_desk(2)[0], DESK)
        self.assertTrue(self.eg.slot_desk(2)[1].endswith("/start-1"))
        self.slot(2, "../../etc/passwd")
        with self.assertRaises(SystemExit):
            self.eg.slot_desk(2)


class Classes(Base):
    def test_on_puts_the_htb_on_eth0_in_the_slots_namespace_at_the_class_rates(self):
        self.slot(2, DESK, egress="0.5")
        fake = FakeHost(classes=[], qdiscs=[])
        _, _, _, cfg, budget, _ = self.eg.setup(2)
        DE.Shaper(cfg, run=self.eg.ns_run(2, fake)).apply(budget.rates())
        self.assertTrue(all(c[0] == self.eg.NSENTER and c[1] == f"--net={self.eg.RUN}/ns/2/net" for c in fake.calls))
        batch = fake.stdin[-1]
        self.assertIn("qdisc replace dev eth0 root handle 1: htb default 20", batch)
        self.assertIn("class replace dev eth0 parent 1: classid 1:10 htb rate 30000000bit ceil 30000000bit burst 1mb cburst 1mb prio 0", batch)
        self.assertIn("classid 1:15 htb rate 1000000bit ceil 1000000bit", batch)
        self.assertIn("classid 1:20 htb rate 50000000bit ceil 50000000bit burst 256kb cburst 256kb prio 1", batch)
        self.assertIn("qdisc replace dev eth0 parent 1:10 handle 10: pfifo limit 1000", batch)
        self.assertNotIn("ens5", batch)

    def test_off_deletes_the_root_qdisc_in_the_namespace(self):
        fake = FakeHost()
        orig = self.eg.subprocess.run
        self.eg.subprocess.run = fake
        try:
            self.assertEqual(self.eg.cmd_off(2), 0)
        finally:
            self.eg.subprocess.run = orig
        self.assertEqual(fake.calls[-1][2:], [self.eg.TC, "qdisc", "del", "dev", "eth0", "root"])


class Budgets(Base):
    def test_bucket_empties_slows_1_20_and_1_15_then_reopens(self):
        self.conf("[slot2]\nbucket_gb = 0.5\nreopen_gb = 0.1\nrefill_mbps = 100\n")
        _, start, _, cfg, budget, _ = self.eg.setup(2, now=1000.0)
        fake = FakeHost(classes=[htb_class("10", 60, 0), htb_class("15", 2, 0), htb_class("20", 100, 0)])
        sh = DE.Shaper(cfg, run=self.eg.ns_run(2, fake))
        DE.baseline(budget, sh)
        fake.classes = [htb_class("10", 60, 10 * GB), htb_class("15", 2, 0), htb_class("20", 100, int(0.6 * GB))]
        self.assertEqual(self.eg.tick(budget, sh, 2, 0, 1001.0), 0)
        self.assertTrue(budget.slowed)
        self.assertEqual(budget.rates(), {"10": 60, "15": 0.25, "20": 0.75})
        self.assertIn("classid 1:20 htb rate 750000bit ceil 750000bit", fake.stdin[-1])
        self.assertNotIn("classid 1:10", fake.stdin[-1], "the stream's class is never touched by the bucket")
        # 100 Mbit of refill for 10 s is 0.125 GB: past reopen_gb, the classes go back
        fake.classes = [htb_class("10", 60, 10 * GB), htb_class("15", 2, 0), htb_class("20", 0.75, int(0.6 * GB))]
        self.eg.tick(budget, sh, 2, 0, 1011.0)
        self.assertFalse(budget.slowed)
        self.assertIn("classid 1:20 htb rate 100000000bit", fake.stdin[-1])

    def test_a_free_desk_is_slowed_at_its_classs_rates(self):
        self.slot(2, DESK, egress="0.5")
        self.conf("[slot2]\nbucket_gb = 0.1\n")
        _, _, _, cfg, budget, _ = self.eg.setup(2, now=1000.0)
        fake = FakeHost(classes=[htb_class("10", 30, 0), htb_class("15", 1, 0), htb_class("20", 50, 0)])
        sh = DE.Shaper(cfg, run=self.eg.ns_run(2, fake))
        DE.baseline(budget, sh)
        fake.classes = [htb_class("10", 30, 0), htb_class("15", 1, 0), htb_class("20", 50, int(0.2 * GB))]
        self.eg.tick(budget, sh, 2, 0, 1001.0)
        self.assertEqual(budget.rates(), {"10": 30, "15": 0.125, "20": 0.375})

    def test_profile_goes_to_the_hosts_file_and_never_to_systemctl(self):
        self.conf("[slot2]\ncapped_month_gb = 1\n")
        _, _, _, cfg, budget, _ = self.eg.setup(2, now=1000.0)
        fake = FakeHost(classes=[htb_class("10", 60, 0), htb_class("15", 2, 0), htb_class("20", 100, 0)])
        sh = DE.Shaper(cfg, run=self.eg.ns_run(2, fake))
        DE.baseline(budget, sh)
        self.assertTrue(self.eg.write_profile(2, budget.profile))
        fake.classes = [htb_class("10", 60, 2 * GB), htb_class("15", 2, 0), htb_class("20", 100, 0)]
        self.eg.tick(budget, sh, 2, 0, 1061.0)
        p = pathlib.Path(self.eg.profile_path(2))
        self.assertEqual(p.read_text(), "capped\n")
        self.assertEqual(p.stat().st_mode & 0o777, 0o644)
        self.assertFalse(self.eg.write_profile(2, "capped"))
        self.assertFalse([c for c in fake.calls if any("systemctl" in x for x in c)])

    def test_state_is_the_hosts_by_desk_id_and_a_new_start_starts_the_counters_over(self):
        _, start, _, cfg, budget, _ = self.eg.setup(2, now=1000.0)
        budget.last = {"10": 5 * GB, "15": 1, "20": 7}
        DE.save(budget, start, self.eg.state_path(DESK))
        self.assertEqual(self.eg.state_path(DESK), f"{self.eg.STATE_DIR}/{DESK}.json")
        self.assertEqual(os.stat(self.eg.state_path(DESK)).st_mode & 0o777, 0o600)
        again = self.eg.setup(2, now=1100.0)[4]
        self.assertEqual(again.last["10"], 5 * GB, "a restart in the same start keeps counting what it missed")
        self.slot(2, DESK, boot="start-2")
        fresh = self.eg.setup(2, now=1200.0)[4]
        self.assertEqual(fresh.last, {}, "a new start's qdisc counts from 0")

    def test_the_daemons_start_ticks_at_once_so_its_state_is_fresh_and_the_stopped_time_refills(self):
        # a desk slowed 2 hours ago (bucket empty), its unit started again now: the refill for those 2 hours lands at the start and
        # the state says now (desk-host-check shaper reads its age; the lab's first R5 restore failed it for a tick without this)
        self.conf("[slot2]\nreopen_gb = 0.5\n")
        _, start, _, cfg, budget, _ = self.eg.setup(2, now=1000.0)
        budget.slowed, budget.level = True, 0.0
        DE.save(budget, start, self.eg.state_path(DESK))
        fake = FakeHost(classes=[htb_class("10", 60, 0), htb_class("15", 0.25, 0), htb_class("20", 0.75, 0)])
        orig = self.eg.subprocess.run
        self.eg.subprocess.run = fake
        try:
            got = self.eg.begin(2, now=1000.0 + 7200)
        finally:
            self.eg.subprocess.run = orig
        st = json.loads(pathlib.Path(self.eg.state_path(DESK)).read_text())
        self.assertEqual(st["updated"], 8200.0)
        self.assertAlmostEqual(st["level"], 7200 * 125000, delta=1)   # 0.9 GB back at 1 Mbit
        self.assertFalse(st["slowed"])
        self.assertEqual(got[-1], 0)
        self.assertIn("classid 1:20 htb rate 100000000bit", fake.stdin[-1], "the classes go back at once, not a tick later")

    def test_ten_failed_ticks_lift_any_clamp(self):
        _, _, _, cfg, budget, _ = self.eg.setup(2, now=1000.0)
        fake = FakeHost(tc_fails=True)
        sh = DE.Shaper(cfg, run=self.eg.ns_run(2, fake))
        f = 0
        for i in range(10):
            f = self.eg.tick(budget, sh, 2, f, 1000.0 + i)
        self.assertEqual(f, 10)
        self.assertTrue(any("class replace dev eth0 parent 1: classid 1:10 htb rate 60000000bit" in s for s in fake.stdin))

    def test_prune_keeps_this_desk_and_recent_ones(self):
        for name, age in ((DESK, 99), ("d-oldoldoldold", 40), ("d-newnewnewnew", 2)):
            p = f"{self.eg.STATE_DIR}/{name}.json"
            pathlib.Path(p).write_text("{}")
            os.utime(p, (1e9 - age * 86400, 1e9 - age * 86400))
        self.assertEqual(self.eg.prune(DESK, now=1e9), 1)
        self.assertEqual(sorted(os.listdir(self.eg.STATE_DIR)), sorted([f"{DESK}.json", "d-newnewnewnew.json"]))


class Check(Base):
    def good_state(self, now=5000.0, start=None):
        start = start or self.eg.slot_desk(2)[1]
        st = {"v": 1, "boot": start, "updated": now - 30, "level": 29e9, "slowed": False, "month": "2026-11", "month_bytes": 3 * GB,
              "windows": [[now - 600, 2 * GB]], "clamped": False, "day_deep": False, "profile": "normal", "profile_since": 0, "last": {}}
        pathlib.Path(self.eg.state_path(DESK)).write_text(json.dumps(st))

    def test_a_shaped_ticking_slot_passes(self):
        self.good_state()
        self.assertEqual(self.eg.problems(2, "port", run=FakeHost(), now=5000.0), [])

    def test_each_break_fails(self):
        self.good_state()
        cases = {
            "no HTB 1:": dict(qdiscs=[{"kind": "noqueue", "handle": "0:", "root": True}], classes=[]),
            "no class 1:20": dict(classes=[htb_class("10", 60), htb_class("15", 2)]),
            "it would borrow": dict(classes=[htb_class("10", 60), htb_class("15", 2), htb_class("20", 100, ceil=10**9)]),
            "above its class's": dict(classes=[htb_class("10", 60), htb_class("15", 2), htb_class("20", 400)]),
            "1:10's leaf": dict(qdiscs=[q if q.get("parent") != "1:10" else {**q, "kind": "fq_codel"} for q in QDISCS]),
            "udp sport 4432": dict(classify=CLASSIFY.replace("\t\tmeta skuid 1101 udp sport 4432 meta priority set 1:10\n", "")),
            "desk-host-egress@2 is inactive": dict(active="inactive"),
            "no eth0": dict(tc_fails=True),
        }
        for want, kw in cases.items():
            got = self.eg.problems(2, "port", run=FakeHost(**kw), now=5000.0)
            self.assertTrue(any(want in p for p in got), f"{want}: {got}")

    def test_address_mode_needs_no_slot_port_rule(self):
        self.good_state()
        no_port = CLASSIFY.replace("\t\tmeta skuid 1101 udp sport 4432 meta priority set 1:10\n", "")
        self.assertEqual(self.eg.problems(2, "address", run=FakeHost(classify=no_port), now=5000.0), [])

    def test_off_marker_stale_state_and_another_start_fail(self):
        self.good_state(now=5000.0)
        self.assertTrue(any("last saved" in p for p in self.eg.problems(2, "port", run=FakeHost(), now=5000.0 + 400)))
        self.good_state(start="other-boot/start-0")
        self.assertTrue(any("another start" in p for p in self.eg.problems(2, "port", run=FakeHost(), now=5000.0)))
        os.remove(self.eg.state_path(DESK))
        self.assertTrue(any("no desk-egress state" in p for p in self.eg.problems(2, "port", run=FakeHost(), now=5000.0)))
        self.good_state()
        os.makedirs(self.eg.OFF)
        pathlib.Path(f"{self.eg.OFF}/2").write_text("2026-11-11T00:00:00Z\n")
        self.assertTrue(any("shaper off" in p for p in self.eg.problems(2, "port", run=FakeHost(), now=5000.0)))

    def test_a_lowered_rate_is_fine(self):
        self.good_state()
        slowed = [htb_class("10", 1), htb_class("15", 0.25), htb_class("20", 0.75)]
        self.assertEqual(self.eg.problems(2, "port", run=FakeHost(classes=slowed), now=5000.0), [])

    def test_desk_host_check_has_it_and_passes_with_nothing_running(self):
        src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
        m = types.ModuleType("desk_host_check")
        m.__dict__["__name__"] = "desk_host_check"
        sys.path.insert(0, str(LIB))   # its modules (templates.py, ADR 0077) beside it
        exec(compile(src, "desk-host-check", "exec"), m.__dict__)   # noqa: S102 - our own file
        self.assertIn("shaper", m.CHECKS)
        self.assertNotIn("shaper", m.QUICK, "a slot's shaper never keeps another desk from starting")
        m.running_slots = lambda: set()
        m.slot_mode = lambda: "port"
        m.egress = lambda: self.eg
        ok, why = m.c_shaper()
        self.assertTrue(ok, why)
        self.assertIn("0 running slot(s)", why)
        self.good_state(now=__import__("time").time())
        m.running_slots = lambda: {2}
        orig = self.eg.problems
        self.eg.problems = lambda k, mode, run=None: orig(k, mode, run=FakeHost())
        ok, why = m.c_shaper()
        self.assertTrue(ok, why)
        self.eg.problems = lambda k, mode, run=None: orig(k, mode, run=FakeHost(classes=[]))
        ok, why = m.c_shaper()
        self.assertFalse(ok)
        self.assertIn("no class 1:10", why)


class Report(Base):
    def test_show_carries_each_classs_rate_and_counters_and_the_budget(self):
        Check.good_state(self, now=5000.0)
        fake = FakeHost(classes=[htb_class("10", 60, 123, drops=0), htb_class("15", 2, 45), htb_class("20", 0.75, 6789, drops=3)])
        s = self.eg.show(2, run=fake, now=5000.0)
        self.assertTrue(s["on"])
        self.assertEqual(s["classes"]["20"], {"rateBits": 750000, "bytes": 6789, "packets": 6, "drops": 3, "overlimits": 0})
        self.assertEqual((s["profile"], s["slowed"], s["bucketGb"], s["dayGb"], s["monthGb"]), ("normal", False, 29.0, 2.0, 3.0))
        self.assertNotIn("off", s)
        s = self.eg.show(2, run=FakeHost(classes=[]), now=5000.0)
        self.assertFalse(s["on"])

    def test_report_adds_it_for_running_slots_only(self):
        src = (LIB / "report.py").read_text()
        self.assertIn("import egress", src)
        self.assertRegex(src, r'if e\["state"\] == "running":\n\s+try:\n\s+e\["shaper"\] = egress\.show\(k, e\["deskId"\]\)')
        self.assertIn("except Exception", src.split('e["shaper"] = egress.show')[1][:200])


class Hooks(unittest.TestCase):
    def setUp(self):
        self.src = (LIB / "desk-host").read_text()

    def fn(self, name):
        a = self.src.index(f"\n{name}() {{")
        return self.src[a:self.src.index("\n}\n\n", a)]

    def test_up_puts_the_classes_on_and_starts_the_budgets_before_the_desk_runs(self):
        up = self.fn("up_one")
        on, start, run = up.index("egress.py on"), up.index('systemctl start "desk-host-egress@$k.service"'), up.index("runc start dh-desk-$k")
        self.assertLess(up.index('$NS nft -f "$T/etc/nftables.conf"'), on, "after the template's classify chain is in the namespace")
        self.assertLess(on, start)
        self.assertLess(start, run)
        self.assertLess(up.index("install -d -m 755 -o root -g root $RUN/$k/egress"), up.index("svc-spec.py \"$k\" \"$svc\""), "the profile's directory before desk-stream's sandbox binds it")

    def test_reset_stops_the_budgets_before_the_namespace_goes(self):
        r = self.fn("reset_slot")
        self.assertLess(r.index('systemctl stop "desk-host-egress@$k.service"'), r.index("umount \"$f\""))
        self.assertIn('rm -f "${RUN:?}/shaper-off/${k:?}"', r)
        left = self.fn("leftovers")
        self.assertIn("desk-host-egress@$k.service", left)
        self.assertIn("shaper-off", left)

    def test_the_shaper_subcommand(self):
        a = self.src.index("\nshaper)")
        sub = self.src[a:self.src.index(";;\n  esac ;;", a)]
        for want in ("egress.py show", "egress.py off", "egress.py on", 'systemctl stop "desk-host-egress@$k.service"',
                     'systemctl restart "desk-host-egress@$k.service"', '"$RUN/shaper-off/$k"', "lock_slot"):
            self.assertIn(want, sub)

    def test_the_unit(self):
        u = (FILES / "etc/systemd/system/desk-host-egress@.service").read_text()
        self.assertIn("ExecStart=/usr/bin/python3 -I /usr/local/lib/desk-host/egress.py run %i", u)
        self.assertIn("ExecStopPost=-/usr/bin/python3 -I /usr/local/lib/desk-host/egress.py unclamp %i", u)
        self.assertIn("RestartPreventExitStatus=75", u)
        self.assertNotIn("[Install]", u, "started by desk-host up only")
        self.assertNotRegex(u, r"(?m)^(ProtectSystem|PrivateTmp|PrivateNetwork)=", "the host's own mount and network namespaces")

    def test_build_installs_the_templates_desk_egress(self):
        b = (IMAGE / "host/recipe/build.sh").read_text()
        self.assertIn('install -m 644 "$eg/desk-egress" $LIB/desk_egress.py', b)
        self.assertIn("readlink \"$T/opt/ma/desk-egress/current\"", b)
        self.assertIn("for c in python3 nft ip tc nsenter", b)
        self.assertNotIn("desk-host-egress", (LIB / "desk-host-check").read_text().split("DESK_UNITS = (")[1].split(")")[0])

    def test_desk_egress_unchanged_api(self):
        for name in ("Budget", "Shaper", "step", "baseline", "save", "normal_rates", "DEFAULTS", "CLASSES", "FAIL_OPEN_TICKS"):
            self.assertTrue(hasattr(DE, name), name)


class StreamProfile(unittest.TestCase):
    DOCKER = {
        "process": {}, "hooks": {}, "annotations": {}, "root": {},
        "mounts": [{"destination": d, "type": "x", "source": "x", "options": []} for d in ("/proc", "/dev", "/dev/pts", "/sys")],
        "linux": {"seccomp": {"syscalls": [], "architectures": []}, "maskedPaths": [], "resources": {"devices": []},
                  "uidMappings": [], "gidMappings": [], "sysctl": {}},
    }

    def test_desk_stream_and_desk_rtc_read_the_hosts_profile_read_only_and_nothing_else_does(self):
        """desk-stream picks its conf by the profile; desk-rtc 0.5.1 (S-29) reads it to say a member's level is held (ADR 0078's small item)."""
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        t = pathlib.Path(tmp) / "templates" / "g1" / "etc"   # slot 3's own template generation (ADR 0077), as its record names it
        t.mkdir(parents=True)
        (t.parent / ".complete").write_text("gen=g1\n")
        (pathlib.Path(tmp) / "slots").mkdir()
        (pathlib.Path(tmp) / "slots" / "3.json").write_text('{"slot": 3, "state": "desk", "template": "g1"}')
        old_rec = os.environ.get("DESK_HOST_RECORDS")
        os.environ["DESK_HOST_RECORDS"] = str(pathlib.Path(tmp) / "slots")
        self.addCleanup(lambda: os.environ.pop("DESK_HOST_RECORDS") if old_rec is None else os.environ.__setitem__("DESK_HOST_RECORDS", old_rec))
        names = "rtc stream desk-snd desk-x desk-dns desk-data agent notebook deskd".split()
        (t / "passwd").write_text("".join(f"{n}:x:{1100 + i}:{1100 + i}::/:/bin/false\n" for i, n in enumerate(names)))
        (t / "group").write_text("".join(f"{n}:x:{1100 + i}:\n" for i, n in enumerate(names + ["desk", "desk-audio"])))
        sys.path.insert(0, str(LIB))
        for m in ("wallspec", "svc_spec"):
            sys.modules.pop(m, None)
        import wallspec  # noqa: E402
        wallspec.DH = tmp
        wallspec.docker_spec = lambda: copy.deepcopy(self.DOCKER)
        mod = load(LIB / "svc-spec.py", "svc_spec")
        for name in mod.SERVICES:
            hits = [m for m in mod.spec(3, name)["mounts"] if m["destination"] == "/run/desk-egress"]
            if name not in ("desk-stream", "desk-rtc"):
                self.assertEqual(hits, [], name)
                continue
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0]["source"], "/run/desk-host/3/egress")
            self.assertIn("ro", hits[0]["options"])
            self.assertIn("noexec", hits[0]["options"])
        run = (IMAGE / "recipe/desk-stream/run").read_text()
        self.assertIn("/run/desk-egress/profile", run, "desk-stream's run reads the profile there")
        rtc = (IMAGE.parent / "desk-rtc/release/run").read_text()
        self.assertIn("--profile-file /run/desk-egress/profile", rtc, "desk-rtc's run reads it there too")

    def test_desk_init_restarts_a_running_desk_stream_on_a_change(self):
        src = (LIB / "desk/desk-init.py").read_text()
        a, b = src.index('EGRESS_PROFILE = "/run/desk-host/egress/profile"'), src.index("def xauth_cookie():")
        logs, sleeps = [], []
        ns = {"SHUTTING_DOWN": threading.Event(), "log": logs.append, "UNITS": {},
              "time": types.SimpleNamespace(sleep=sleeps.append)}
        exec(src[a:b], ns)   # noqa: S102 - our own file
        self.assertIn("threading.Thread(target=watch_egress_profile, daemon=True).start()", src)
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        p = pathlib.Path(tmp) / "profile"
        p.write_text("normal\n")

        class Unit:
            def __init__(self, running):
                self.r, self.verbs = running, []

            def running(self):
                return self.r

            def stop(self):
                self.verbs.append("stop")

            def start(self):
                self.verbs.append("start")

        u = Unit(True)
        seq = iter(["normal\n", "capped\n", "capped\n", "bogus\n"])
        ns["time"] = types.SimpleNamespace(sleep=lambda _s: p.write_text(next(seq)))
        ns["watch_egress_profile"](every=0, unit=u, path=str(p), rounds=4)
        self.assertEqual(u.verbs, ["stop", "start", "stop", "start"], "normal -> capped restarts it; capped -> unknown (normal) again")
        u2 = Unit(False)
        seq = iter(["deep\n"])
        p.write_text("normal\n")
        ns["watch_egress_profile"](every=0, unit=u2, path=str(p), rounds=1)
        self.assertEqual(u2.verbs, [], "a stopped desk-stream takes it at its next start")
        self.assertEqual(ns["egress_profile"](str(p) + ".missing"), "normal")


if __name__ == "__main__":
    unittest.main()
