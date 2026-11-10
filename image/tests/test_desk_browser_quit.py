#!/usr/bin/python3 -I
"""desk-browser-quit (desk-browser-thaw.service's second ExecStop) with a stand-in for desk-browser-close, and the units'
settings it relies on. No root. python3 -I image/tests/test_desk_browser_quit.py
desk-browser-close --quit itself is tested in test_desk_browser_close.py."""
import fcntl
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
FILES = HERE.parent / "recipe" / "files"
HELPER = FILES / "usr" / "local" / "lib" / "ma" / "desk-browser-quit"
UNITS = FILES / "etc" / "systemd" / "system"


class DeskBrowserQuitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.log = t / "log"
        self.close = t / "desk-browser-close"
        self.close.write_text(f'#!/bin/sh\necho "close $*" >> {self.log}\necho "desk-browser-close --quit: quit=cdp"\n')
        self.close.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def run_helper(self, jobs):
        env = {"PATH": "/usr/bin:/bin", "MA_JOBS": jobs, "MA_BROWSER_CLOSE": str(self.close)}
        return subprocess.run(["/bin/bash", str(HELPER)], env=env, capture_output=True, text=True, timeout=30)

    def closes(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_a_queued_stop_or_restart_of_desk_browser_runs_the_close_in_quit_mode(self):
        for jobs in ("4711 desk-browser.service stop waiting", "4712 desk-browser.service restart waiting",
                     "4700 desk-xorg.service stop waiting\n4711 desk-browser.service stop waiting"):
            with self.subTest(jobs=jobs):
                self.log.unlink(missing_ok=True)
                r = self.run_helper(jobs)
                self.assertEqual(r.returncode, 0)
                self.assertEqual(self.closes(), ["close --quit"])

    def test_with_no_stop_of_desk_browser_queued_it_closes_nothing(self):
        for jobs in ("", "4713 desk-browser.service start waiting", "4714 desk-browser-thaw.service stop running",
                     "4715 desk-xorg.service stop waiting", "stop desk-browser.service"):
            with self.subTest(jobs=jobs):
                r = self.run_helper(jobs)
                self.assertEqual((r.returncode, r.stdout.strip()), (0, "desk-browser-quit: desk-browser isn't stopping"))
        self.assertEqual(self.closes(), [])

    def test_a_close_that_fails_never_fails_the_stop(self):
        self.close.write_text("#!/bin/sh\nexit 1\n")
        self.assertEqual(self.run_helper("4711 desk-browser.service stop waiting").returncode, 0)

    def test_the_thaw_unit_thaws_then_quits_as_root_with_time_for_the_lock_and_the_31_s_wait(self):
        thaw = (UNITS / "desk-browser-thaw.service").read_text()
        stops = [l for l in thaw.splitlines() if l.startswith("ExecStop=")]
        self.assertEqual(len(stops), 2)
        self.assertIn("cgroup.freeze", stops[0])
        self.assertTrue(stops[0].startswith("ExecStop=-"), "a thaw that fails must never skip the quit")
        self.assertEqual(stops[1], "ExecStop=-/usr/local/lib/ma/desk-browser-quit")
        self.assertNotIn("\nUser=", thaw)   # root, for port 9222
        for key in ("After", "PartOf", "WantedBy"):
            self.assertIn(f"\n{key}=desk-browser.service\n", thaw)
        lock = int(re.search(r"flock -w (\d+) ", stops[0]).group(1))
        # the lock, list-jobs in desk-browser-quit (5 s), about 11 s of asking CDP, then 31 s for Chromium to go
        self.assertGreaterEqual(int(re.search(r"\nTimeoutStopSec=(\d+)\n", thaw).group(1)), lock + 5 + 11 + 31)

    # ---- T46L-1: at a shutdown deskd stops first, and the thaw waits for a freeze already under way
    def test_the_thaw_unit_stops_after_deskd(self):
        # Before= on the start side is After= on the stop side: with both stopping (a shutdown), this one waits for deskd.
        thaw = (UNITS / "desk-browser-thaw.service").read_text()
        self.assertIn("\nBefore=deskd.service\n", thaw)
        self.assertNotRegex(thaw, r"\n(Wants|Requires|BindsTo|Requisite)=[^\n]*deskd", "ordering only: it must pull in nothing")
        deskd = (UNITS / "deskd.service").read_text()
        self.assertNotRegex(deskd, r"\n(Before|After)=[^\n]*desk-browser-thaw", "an opposite order would be a cycle")

    def test_the_thaw_locks_the_cgroup_desk_units_locks(self):
        stop = next(l for l in (UNITS / "desk-browser-thaw.service").read_text().splitlines() if l.startswith("ExecStop="))
        units = (FILES / "usr/local/lib/ma/desk-units").read_text()
        cgroup = re.search(r'\nBROWSER_CGROUP = "([^"]+)"\n', units).group(1)
        self.assertIn(f"d={cgroup};", stop)
        self.assertIn('flock -w 5 "$d" true', stop)
        self.assertIn("fcntl.flock(fd, fcntl.LOCK_EX", units)

    def thaw_cmd(self, cgroup):
        """desk-browser-thaw's first ExecStop as systemd runs it, on a stand-in cgroup directory."""
        line = next(l for l in (UNITS / "desk-browser-thaw.service").read_text().splitlines() if l.startswith("ExecStop="))
        argv = shlex.split(line[len("ExecStop=-"):])
        self.assertEqual(argv[:2], ["/bin/sh", "-c"])
        return argv[:2] + [argv[2].replace("/sys/fs/cgroup/system.slice/desk-browser.service", str(cgroup))]

    def fake_cgroup(self, value="1"):
        cg = pathlib.Path(self.tmp.name) / "desk-browser.service"
        cg.mkdir()
        (cg / "cgroup.freeze").write_text(value + "\n")
        return cg

    def test_the_thaw_waits_for_a_freeze_under_way_then_writes_0(self):
        cg = self.fake_cgroup("1")
        fd = os.open(cg, os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(fd, fcntl.LOCK_EX)   # a desk-units freeze between its first look and its answer
        try:
            p = subprocess.Popen(self.thaw_cmd(cg))
            time.sleep(0.5)
            self.assertIsNone(p.poll(), "it didn't wait for the lock")
            self.assertEqual((cg / "cgroup.freeze").read_text().strip(), "1")
        finally:
            os.close(fd)
        self.assertEqual(p.wait(timeout=3), 0)
        self.assertEqual((cg / "cgroup.freeze").read_text().strip(), "0")

    def test_the_thaw_writes_0_after_5_s_even_if_the_lock_is_still_held(self):
        cg = self.fake_cgroup("1")
        fd = os.open(cg, os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            t0 = time.monotonic()
            subprocess.run(self.thaw_cmd(cg), timeout=10)
            self.assertTrue(4.5 < time.monotonic() - t0 < 7, time.monotonic() - t0)
            self.assertEqual((cg / "cgroup.freeze").read_text().strip(), "0")
        finally:
            os.close(fd)

    def test_the_thaw_with_nothing_to_thaw_succeeds_at_once(self):
        cg = pathlib.Path(self.tmp.name) / "gone"
        r = subprocess.run(self.thaw_cmd(cg), capture_output=True, text=True, timeout=5)
        self.assertEqual((r.returncode, r.stderr), (0, ""))
        self.assertFalse(cg.exists())

    def test_chromium_is_kept_off_the_system_bus(self):
        # On it, Chromium takes logind's PrepareForShutdown and ends its session before desk-browser-thaw's quit can run.
        browser = (UNITS / "desk-browser.service").read_text()
        m = re.search(r"\nEnvironment=DBUS_SYSTEM_BUS_ADDRESS=unix:path=(\S+)\n", browser)
        self.assertIsNotNone(m)
        self.assertTrue(m.group(1).startswith("/dev/null/"), "a path no one can ever create a socket at")
        start = (FILES / "usr/local/lib/ma/desk-browser-start").read_text()
        self.assertNotIn("DBUS_SYSTEM_BUS_ADDRESS", start, "the wrapper must not put it back")

    def test_desk_browser_has_no_command_systemd_would_start_in_its_cgroup(self):
        browser = (UNITS / "desk-browser.service").read_text()
        for key in ("ExecStop=", "ExecStopPost=", "ExecReload="):
            self.assertNotIn("\n" + key, browser, "with the cgroup frozen, PID 1 would wait on it (vfork into a frozen cgroup)")

    def test_desk_units_waits_long_enough_for_the_quit_and_the_sigterm(self):
        thaw = int(re.search(r"\nTimeoutStopSec=(\d+)\n", (UNITS / "desk-browser-thaw.service").read_text()).group(1))
        browser = int(re.search(r"\nTimeoutStopSec=(\d+)\n", (UNITS / "desk-browser.service").read_text()).group(1))
        units = int(re.search(r"\nSYSTEMCTL_TIMEOUT_S = (\d+)\n", (FILES / "usr/local/lib/ma/desk-units").read_text()).group(1))
        start = int(re.search(r"\nTimeoutStartSec=(\d+)\n", (UNITS / "desk-units@.service").read_text()).group(1))
        self.assertGreaterEqual(units, thaw + browser)
        self.assertGreater(start, units + 5)


if __name__ == "__main__":
    unittest.main(verbosity=1)
