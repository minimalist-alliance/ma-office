#!/usr/bin/python3 -I
"""Reliability audit S1 (restart loops slow down, never stop) and S2 (a kill order under memory pressure), without a box.
python3 -I image/tests/test_restart_oom.py

The desk image: every unit that restarts itself has systemd's back-off and no start limit, the kill-order values are the table's
and in order, desk-restart-reset starts the back-off over only for a unit that has run well and is still running, and the
Docker-run units hand their container to desk-oom-container. The shared host: desk-init's Backoff (the same curve, reset after a
healthy run or a start somebody asked for), desk-svc's flags, svc-spec.py's oomScoreAdj per sandbox, and the host's own units
under -900. verify-restart.sh and desk-host-check oom read the real thing on a box; image/evidence/restart-oom-2026-11-10/.
"""
import importlib.machinery
import importlib.util
import pathlib
import re
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
UNITS = IMAGE / "recipe/files/etc/systemd/system"
MA = IMAGE / "recipe/files/usr/local/lib/ma"
HOSTLIB = IMAGE / "host/recipe/files/usr/local/lib/desk-host"
HOSTUNITS = IMAGE / "host/recipe/files/etc/systemd/system"

# unit -> (RestartMaxDelaySec, OOMScoreAdjust or None)
TABLE = {"deskd": (300, -500), "desk-rtc": (300, -500), "desk-notebook": (300, -200), "desk-agent": (300, 200), "desk-stream": (300, 100),
         "commons-server": (300, -200), "desk-agent-filter": (300, None), "desk-egress": (300, None),
         "desk-browser": (30, 0), "desk-xorg": (30, None), "desk-audio": (30, None)}
CONTAINERS = ("deskd", "desk-agent", "desk-notebook")


def props(path):
    out = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.startswith(("#", "[")):
            k, v = line.split("=", 1)
            out.setdefault(k, []).append(v)
    return out


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class DeskUnits(unittest.TestCase):
    def test_every_self_restarting_unit_backs_off_and_has_no_start_limit(self):
        seen = 0
        for f in sorted(UNITS.glob("*.service")):
            p = props(f)
            if p.get("Restart", ["no"])[0] in ("no",):
                continue
            seen += 1
            n = f.stem
            self.assertIn(n, TABLE, f"{n} restarts itself and isn't in the back-off table")
            cap, _ = TABLE[n]
            self.assertGreaterEqual(int(p["RestartSteps"][0]), 1, n)
            self.assertEqual(int(p["RestartMaxDelaySec"][0]), cap, n)
            self.assertEqual(p["StartLimitIntervalSec"], ["0"], f"{n}: a start limit would leave it down for good")
            self.assertNotIn("StartLimitBurst", p, n)
            self.assertGreater(cap, int(p["RestartSec"][0]), n)
        self.assertEqual(seen, len(TABLE), "a unit in the table no longer restarts itself")

    def test_kill_order(self):
        adj = {}
        for n, (_, want) in TABLE.items():
            got = props(UNITS / f"{n}.service").get("OOMScoreAdjust")
            self.assertEqual(got, None if want is None else [str(want)], n)
            if want is not None:
                adj[n] = want
        order = ["desk-agent", "desk-stream", "desk-browser", "desk-notebook", "desk-rtc"]
        vals = [adj[n] for n in order]
        self.assertEqual(vals, sorted(vals, reverse=True), "first killed to last")
        self.assertEqual(len(set(vals)), len(vals))
        self.assertEqual(adj["desk-rtc"], adj["deskd"])
        self.assertGreater(300, adj["desk-agent"])   # Chromium's renderers (300, its own) are first; measured on the lab box

    def test_docker_units_hand_their_container_to_the_helper(self):
        for n in CONTAINERS:
            p = props(UNITS / f"{n}.service")
            want = f"-/usr/local/lib/ma/desk-oom-container {n} {TABLE[n][1]}"
            self.assertIn(want, p["ExecStartPost"], n)   # the "-" keeps a start from failing on it

    def test_a_killed_renderer_does_not_stop_the_browser(self):
        self.assertEqual(props(UNITS / "desk-browser.service")["OOMPolicy"], ["continue"])

    def test_the_reset_timer_exists_and_is_enabled_by_the_recipe(self):
        self.assertIn("OnUnitInactiveSec=30s", (UNITS / "desk-restart-reset.timer").read_text())
        self.assertIn("systemctl enable desk-restart-reset.timer", (IMAGE / "recipe/build.sh").read_text())


class Reset(unittest.TestCase):
    def setUp(self):
        self.m = load(MA / "desk-restart-reset", "desk_restart_reset")

    def block(self, n, state="active", since=0):
        return {"Id": "deskd.service", "NRestarts": str(n), "ActiveState": state, "ActiveEnterTimestampMonotonic": str(since)}

    def test_only_a_unit_that_restarted_and_ran_well_is_reset(self):
        now = 1_000_000_000
        ok = now - 121 * 1_000_000
        self.assertTrue(self.m.due(self.block(3, since=ok), now))
        self.assertFalse(self.m.due(self.block(3, since=now - 119 * 1_000_000), now), "not yet two minutes")
        self.assertFalse(self.m.due(self.block(0, since=ok), now), "nothing to reset")
        self.assertFalse(self.m.due(self.block(3, state="activating", since=ok), now), "a loop keeps its back-off")
        self.assertFalse(self.m.due(self.block(3, state="failed", since=ok), now))
        self.assertFalse(self.m.due({"NRestarts": "x"}, now))

    def test_run_resets_through_systemctl_only_the_due_ones(self):
        with tempfile.TemporaryDirectory() as t:
            log = pathlib.Path(t) / "log"
            fake = pathlib.Path(t) / "systemctl"
            fake.write_text(f"""#!/bin/sh
echo "$@" >> {log}
if [ "$1" = show ]; then
cat <<'X'
Id=deskd.service
NRestarts=4
ActiveState=active
ActiveEnterTimestampMonotonic=1000000

Id=desk-rtc.service
NRestarts=2
ActiveState=activating
ActiveEnterTimestampMonotonic=1000000

Id=desk-agent.service
NRestarts=0
ActiveState=active
ActiveEnterTimestampMonotonic=1000000
X
fi
""")
            fake.chmod(0o755)
            done = self.m.run(systemctl=(str(fake),), now_us=500_000_000)
            self.assertEqual(done, ["deskd.service"])
            self.assertIn("reset-failed deskd.service", log.read_text())
            self.assertNotIn("reset-failed desk-rtc", log.read_text())
            self.assertNotIn("reset-failed desk-agent", log.read_text())


class HostSupervisor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = (HOSTLIB / "desk/desk-init.py").read_text()
        # only the back-off's code: desk-init as a whole starts a desk when it runs
        a = src.index("RESTART_CAP, RESTART_STEPS")
        b = src.index("def log(")
        ns = {"time": __import__("time")}
        exec(src[a:b], ns)   # noqa: S102 - our own file, up to its first function after the helpers
        cls.ns = ns

    def test_curve_is_systemds_and_capped(self):
        f = self.ns["backoff_delay"]
        got = [round(f(3, n), 1) for n in range(1, 11)]
        self.assertEqual(got[0], 3)
        self.assertEqual(got[:4], [3, 5.3, 9.5, 16.9])
        self.assertEqual(got[-1], 300)
        self.assertEqual(sorted(got), got)
        self.assertEqual(f(3, 1000), 300)
        self.assertEqual(round(f(3, 5, cap=30, steps=4), 1), 30.0)   # the Browser's: 3 s to 30 s in 4 restarts
        self.assertEqual(f(3, 50, cap=30, steps=4), 30)

    def test_streak_grows_then_a_healthy_run_resets_it(self):
        t = [0.0]
        b = self.ns["Backoff"](3, clock=lambda: t[0])
        waits = []
        for _ in range(5):
            b.started_now()
            t[0] += 1            # dies a second after it starts
            waits.append(b.next_delay())
            t[0] += waits[-1]
        self.assertEqual([round(w, 1) for w in waits], [3, 5.3, 9.5, 16.9, 30.0])
        b.started_now()
        t[0] += 121              # runs well
        self.assertEqual(round(b.next_delay(), 1), 3, "the back-off starts over")
        b.started_now()
        t[0] += 1
        self.assertEqual(round(b.next_delay(), 1), 5.3, "and grows again from there")
        b.reset()                # somebody started it
        b.started_now()
        t[0] += 1
        self.assertEqual(round(b.next_delay(), 1), 3)

    def test_no_unit_gives_up(self):
        src = (HOSTLIB / "desk/desk-init.py").read_text()
        self.assertEqual(len(re.findall(r"time\.sleep\(wait\)", src)), 2, "both the Unit and the Browser wait their back-off")
        self.assertNotIn("time.sleep(self.restart_sec)", src)

    def test_desk_svc_has_the_back_off_flags_and_a_test(self):
        go = (IMAGE / "host/desk-svc/main.go").read_text()
        for flag in ("restart-max-sec", "restart-steps", "healthy-sec"):
            self.assertIn(f'"{flag}"', go)
        self.assertIn("s.streak = 0", go)
        self.assertTrue((IMAGE / "host/desk-svc/main_test.go").exists())


class HostOrder(unittest.TestCase):
    def test_svc_spec_sets_the_order_per_sandbox(self):
        src = (HOSTLIB / "svc-spec.py").read_text()
        want = {"deskd": -500, "desk-rtc": -500, "desk-notebook": -200, "desk-agent": 200, "desk-stream": 100}
        for n, v in want.items():
            self.assertRegex(src, rf'"{n}": dict\(oom={v}, ')
        self.assertIn('p["oomScoreAdj"] = S["oom"]', src)

    def test_the_hosts_own_units_are_far_below_any_desk(self):
        for n in ("desk-host-link", "desk-ice-demux", "desk-host-shutdown"):
            self.assertEqual(props(HOSTUNITS / f"{n}.service")["OOMScoreAdjust"], ["-900"], n)


if __name__ == "__main__":
    unittest.main()
