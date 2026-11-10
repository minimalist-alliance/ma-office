#!/usr/bin/python3 -I
"""desk-units on a fake systemctl and setpriv, a fake cgroup and /proc, and a temporary downloads folder. No root.
python3 -I image/tests/test_desk_units.py

The helper is loaded as a module and its handle() is given one end of a socketpair, so SO_PEERCRED is this process's.
Its SLEEP plays the kernel: each call makes cgroup.events say what cgroup.freeze asks (unless the test holds it), and
adds the test's traffic to the interface counters. The fake systemctl plays systemd as measured on 257 with a freeze it
didn't make: a stop of desk-browser (or of desk-xorg or desk-audio, which it Requires=) goes ahead, and if Chromium's
cgroup is frozen then, Chromium can't take SIGTERM and is killed, which the tests must never see.
"""
import contextlib
import fcntl
import importlib.machinery
import importlib.util
import io
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
HELPER = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "usr" / "local" / "lib" / "ma" / "desk-units"
PID = "4242"

FAKE_SYSTEMCTL = r"""#!/bin/bash
S=$STUB_DIR CG=$CG_DIR
[ "$1" = --no-ask-password ] && shift
echo "$*" >> "$S/log"
u=${@: -1}; u=${u%.service}
case "$1" in
  is-active) [ -f "$S/is-active-hangs" ] && sleep 30; [ "$(cat "$S/$u.active" 2>/dev/null || echo inactive)" = active ] ;;
  start)
    echo active > "$S/$u.active"
    if [ "$u" = desk-browser ] && [ ! -d "$CG" ]; then
      mkdir -p "$CG"; echo 0 > "$CG/cgroup.freeze"; printf 'populated 1\nfrozen 0\n' > "$CG/cgroup.events"; echo 4242 > "$CG/cgroup.procs"
    fi ;;
  stop)
    case "$u" in desk-browser | desk-xorg | desk-audio)
      if [ -d "$CG" ]; then grep -q '^frozen 1' "$CG/cgroup.events" && echo "$*" >> "$S/killed"; rm -rf "$CG"; fi
      echo inactive > "$S/desk-browser.active" ;;
    esac
    echo inactive > "$S/$u.active" ;;
  list-jobs)
    # jobs.<n> answers the n-th list-jobs of a request, jobs any of them; list-jobs-fails[.<n>] fails it, list-jobs-hangs hangs
    n=$(( $(cat "$S/list-jobs-n" 2>/dev/null || echo 0) + 1 )); echo $n > "$S/list-jobs-n"
    [ -f "$S/list-jobs-hangs" ] && sleep 30
    [ -f "$S/list-jobs-fails" ] || [ -f "$S/list-jobs-fails.$n" ] && exit 1
    f="$S/jobs.$n"; [ -f "$f" ] || f="$S/jobs"; [ ! -f "$f" ] || cat "$f" ;;
  *) exit 2 ;;
esac
"""
# setpriv: logs its own options and runs the rest, as the real one does once it has changed uid.
FAKE_SETPRIV = r"""#!/bin/bash
opts=()
while [ "${1#--}" != "$1" ]; do opts+=("$1"); shift; done
echo "${opts[*]} $1" >> "$STUB_DIR/setpriv.log"
exec "$@"
"""
ROUTE = ("Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
         "ens5\t00000000\t01201FAC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
         "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n")
IPV6_ROUTE = ("00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 "
              "ffffffff 00000001 00000000 00200200       lo\n")


def load():
    loader = importlib.machinery.SourceFileLoader("desk_units", str(HELPER))
    spec = importlib.util.spec_from_loader("desk_units", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class DeskUnitsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.stub, self.bin, self.downloads, self.proc = t / "stub", t / "bin", t / "downloads", t / "proc"
        self.cg = t / "cgroup" / "desk-browser.service"
        for d in (self.stub, self.bin, self.downloads, self.proc / PID / "net"):
            d.mkdir(parents=True)
        for name, text in (("systemctl", FAKE_SYSTEMCTL), ("setpriv", FAKE_SETPRIV)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        (self.proc / PID / "net" / "route").write_text(ROUTE)
        (self.proc / PID / "net" / "ipv6_route").write_text(IPV6_ROUTE)
        self.counters = {"lo": [1000, 1000], "ens5": [5_000_000, 700_000], "docker0": [0, 0]}
        self.traffic = {}
        self.write_dev()
        self.m = load()
        self.real_cgroup = self.m.BROWSER_CGROUP
        self.m.DESKD_UID = os.getuid()
        self.m.SYSTEMCTL, self.m.SETPRIV = (str(self.bin / n) for n in ("systemctl", "setpriv"))
        self.m.DOWNLOADS = str(self.downloads)
        self.m.BROWSER_CGROUP = str(self.cg)
        self.m.PROC = str(self.proc)
        self.m.FREEZER_TIMEOUT_S = 1
        self.m.SLEEP = self.kernel
        self.slept = []
        self.seen_freeze = []   # what cgroup.freeze held each time the "kernel" looked
        self.lock_free = []     # whether desk-browser's cgroup directory could be flocked then
        os.environ["STUB_DIR"] = str(self.stub)
        os.environ["CG_DIR"] = str(self.cg)
        self.start_browser()

    def tearDown(self):
        self.tmp.cleanup()

    # ---- the fakes
    def start_browser(self):
        self.cg.mkdir(parents=True, exist_ok=True)
        (self.cg / "cgroup.freeze").write_text("0\n")
        (self.cg / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        (self.cg / "cgroup.procs").write_text(PID + "\n")
        (self.stub / "desk-browser.active").write_text("active")

    def write_dev(self):
        lines = ["Inter-|   Receive                                                |  Transmit",
                 " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed"]
        for name, (rx, tx) in self.counters.items():
            lines.append("%7s: %d 10 0 0 0 0 0 0 %d 10 0 0 0 0 0 0" % (name, rx, tx))
        (self.proc / PID / "net" / "dev").write_text("\n".join(lines) + "\n")

    def kernel(self, t):
        """The module's SLEEP: what the kernel would have done meanwhile."""
        self.slept.append(t)
        if (self.cg / "cgroup.freeze").is_file():
            self.seen_freeze.append((self.cg / "cgroup.freeze").read_text().strip())
            self.lock_free.append(self.try_lock())
        if (self.cg / "cgroup.freeze").is_file() and not (self.stub / "kernel-holds").exists():
            want = (self.cg / "cgroup.freeze").read_text().strip()
            (self.cg / "cgroup.events").write_text("populated 1\nfrozen %s\n" % want)
        for name, (rx, tx) in self.traffic.items():
            self.counters[name][0] += rx
            self.counters[name][1] += tx
        if self.traffic:
            self.write_dev()
        time.sleep(min(t, 0.002))

    def try_lock(self):
        """Whether desk-browser's cgroup directory can be flocked now, as desk-browser-thaw's first ExecStop does."""
        fd = os.open(self.cg, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
        finally:
            os.close(fd)

    def jobs(self, text, n=None):
        (self.stub / ("jobs" if n is None else f"jobs.{n}")).write_text(text + "\n")

    def frozen(self):
        for line in (self.cg / "cgroup.events").read_text().splitlines():
            if line.startswith("frozen "):
                return line.split()[1]

    def flag(self, name):
        (self.stub / name).touch()

    def ask(self, line):
        a, b = socket.socketpair()
        with a, b:
            b.sendall(line.encode())
            b.shutdown(socket.SHUT_WR)
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                self.m.handle(a)
            a.shutdown(socket.SHUT_RDWR)
            self.log_text = err.getvalue()
            return b.recv(400).decode().strip()

    def calls(self, name="log"):
        p = self.stub / name
        return p.read_text().splitlines() if p.exists() else []

    def systemctl_verbs(self):
        return [c.split()[0] for c in self.calls()]

    # ---- freeze and thaw, the plain way
    def test_a_quiet_running_browser_freezes_and_thaws(self):
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.assertEqual((self.cg / "cgroup.freeze").read_text().strip(), "1")
        self.assertEqual(self.frozen(), "1")
        self.assertEqual(self.ask("thaw desk-browser\n"), "ok")
        self.assertEqual(self.frozen(), "0")

    def test_systemd_is_never_asked_to_freeze_or_thaw(self):
        self.ask("freeze desk-browser\n")
        self.ask("thaw desk-browser\n")
        self.assertEqual(self.systemctl_verbs(), ["is-active", "list-jobs", "list-jobs"])

    def test_the_real_cgroup_is_desk_browsers(self):
        self.assertEqual(self.real_cgroup, "/sys/fs/cgroup/system.slice/desk-browser.service")

    def test_the_log_says_the_verb_and_ok(self):
        self.ask("freeze desk-browser\n")
        self.assertRegex(self.log_text, r"\Adesk-units: freeze desk-browser: ok in \d+ ms\n\Z")

    def test_a_browser_that_isnt_running_is_inactive_and_nothing_is_frozen(self):
        (self.stub / "desk-browser.active").write_text("inactive")
        self.assertEqual(self.ask("freeze desk-browser\n"), "err inactive desk-browser isn't running")
        self.assertEqual(self.frozen(), "0")

    def test_thaw_of_a_browser_that_isnt_running_is_ok(self):
        self.ask("stop desk-browser\n")
        self.assertFalse(self.cg.exists())
        self.assertEqual(self.ask("thaw desk-browser\n"), "ok")

    def test_thaw_of_a_browser_that_isnt_frozen_is_ok(self):
        self.assertEqual(self.ask("thaw desk-browser\n"), "ok")

    def test_an_is_active_that_hangs_is_a_timeout_and_nothing_is_frozen(self):
        self.flag("is-active-hangs")
        self.assertEqual(self.ask("freeze desk-browser\n"), "err timeout is-active desk-browser took over 1 s")
        self.assertEqual(self.frozen(), "0")

    # ---- a stop or a start of a frozen browser thaws it first
    def test_a_stop_of_a_frozen_browser_thaws_it_first(self):
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.assertEqual(self.ask("stop desk-browser\n"), "ok")
        self.assertEqual(self.calls("killed"), [])
        self.assertEqual(self.ask("freeze desk-browser\n"), "err inactive desk-browser isn't running")

    def test_a_stop_of_what_desk_browser_needs_thaws_it_first(self):
        for unit in ("desk-xorg", "desk-audio"):
            with self.subTest(unit=unit):
                self.start_browser()
                self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
                self.assertEqual(self.ask(f"stop {unit}\n"), "ok")
                self.assertEqual(self.calls("killed"), [])

    def test_a_stop_of_desk_stream_leaves_it_frozen(self):
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.assertEqual(self.ask("stop desk-stream\n"), "ok")
        self.assertEqual(self.frozen(), "1")

    def test_a_start_of_a_frozen_running_browser_thaws_it(self):
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.m.BROWSER_START = "/bin/true"
        self.assertEqual(self.ask("start desk-browser\n"), "ok")
        self.assertEqual(self.frozen(), "0")

    def test_a_start_of_desk_adblock_thaws_a_frozen_browser_first(self):
        # ADR 0076: desk-adblock confirms the list with Chromium over CDP, which a frozen Chromium can't answer.
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.assertEqual(self.ask("start desk-adblock\n"), "ok")
        self.assertEqual(self.frozen(), "0")
        self.assertEqual([c for c in self.calls() if c.startswith("start ")], ["start desk-adblock.service"])

    def test_desk_adblock_is_never_frozen_or_thawed_itself(self):
        for line in ("freeze desk-adblock\n", "thaw desk-adblock\n"):
            with self.subTest(line=line):
                self.assertEqual(self.ask(line), "err denied unit not allowed")
        self.assertEqual(self.calls(), [])

    def test_the_fake_does_kill_a_frozen_browser_on_a_stop_so_the_tests_above_can_fail(self):
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.m.STOPS_BROWSER = set()
        self.ask("stop desk-browser\n")
        self.assertEqual(self.calls("killed"), ["stop desk-browser.service"])

    # ---- sound is no refusal (dropped 2026-11-07): nothing here asks PulseAudio
    def test_nothing_asks_pulseaudio(self):
        self.assertFalse(hasattr(self.m, "PACTL") or hasattr(self.m, "sound_playing"))
        self.assertNotIn("pactl", HELPER.read_text())

    # ---- a download
    def crdownload(self, name, age):
        p = self.downloads / name
        p.write_bytes(b"x")
        t = time.time() - age
        os.utime(p, (t, t))
        return p

    def test_a_crdownload_written_a_moment_ago_is_busy_download(self):
        self.crdownload("Unconfirmed 1.crdownload", 0.5)
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy download")
        self.assertEqual(self.frozen(), "0")
        self.assertNotIn("download", self.log_text)

    def test_one_a_minute_old_isnt(self):
        self.crdownload("Unconfirmed 1.crdownload", 60)
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_a_fresh_file_that_isnt_a_crdownload_isnt(self):
        self.crdownload("report.pdf", 0)
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_no_downloads_folder_is_no_download(self):
        self.downloads.rmdir()
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_a_crdownload_in_a_subfolder_isnt_looked_for(self):
        (self.downloads / "sub").mkdir()
        p = self.downloads / "sub" / "a.crdownload"
        p.write_bytes(b"x")
        old = time.time() - 120
        os.utime(self.downloads / "sub", (old, old))
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_a_link_named_crdownload_is_judged_by_its_own_time_and_not_followed(self):
        target = self.crdownload("target.bin", 0)
        link = self.downloads / "x.crdownload"
        link.symlink_to(target)
        old = time.time() - 120
        os.utime(link, (old, old), follow_symlinks=False)
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_a_downloads_folder_that_is_a_link_cant_be_told_so_is_busy(self):
        real = pathlib.Path(self.tmp.name) / "elsewhere"
        real.mkdir()
        self.downloads.rmdir()
        self.downloads.symlink_to(real)
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy download")

    def test_a_folder_too_big_to_read_quickly_is_busy(self):
        for i in range(self.m.MAX_DOWNLOAD_ENTRIES + 1):
            (self.downloads / f"f{i}").touch()
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy download")

    @unittest.skipIf(os.getuid() == 0, "root reads a 000 folder")
    def test_a_folder_that_cant_be_read_is_busy(self):
        self.downloads.chmod(0)
        try:
            self.assertEqual(self.ask("freeze desk-browser\n"), "err busy download")
        finally:
            self.downloads.chmod(0o755)

    # ---- the network
    def test_an_idle_desk_isnt_busy(self):
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_more_than_16_KiB_over_the_window_on_the_outside_interface_is_busy_network(self):
        self.traffic = {"ens5": [12_000, 5_000]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")
        self.assertEqual(self.frozen(), "0")
        self.assertRegex(self.log_text, r"\Adesk-units: freeze desk-browser: busy in \d+ ms\n\Z")

    def test_an_upload_alone_is_busy_too(self):
        self.traffic = {"ens5": [0, 20_000]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")

    def test_16_KiB_or_less_isnt(self):
        self.traffic = {"ens5": [8_000, 8_384]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_the_window_is_waited_for_once(self):
        self.ask("freeze desk-browser\n")
        self.assertTrue(0.3 < self.slept[0] <= 0.5, self.slept)

    def test_traffic_on_loopback_or_an_interface_without_the_default_route_doesnt_count(self):
        self.traffic = {"lo": [500_000, 500_000], "docker0": [500_000, 500_000]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_with_no_default_route_every_interface_but_loopback_counts(self):
        (self.proc / PID / "net" / "route").write_text(ROUTE.splitlines()[0] + "\n")
        self.traffic = {"docker0": [20_000, 0]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")

    def test_with_no_default_route_loopback_still_doesnt_count(self):
        (self.proc / PID / "net" / "route").write_text(ROUTE.splitlines()[0] + "\n")
        self.traffic = {"lo": [500_000, 500_000]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")

    def test_an_ipv6_default_route_counts(self):
        (self.proc / PID / "net" / "route").write_text(ROUTE.splitlines()[0] + "\n")
        (self.proc / PID / "net" / "ipv6_route").write_text(IPV6_ROUTE + IPV6_ROUTE.replace("lo", "ens5").replace("00200200", "00000003"))
        self.traffic = {"docker0": [20_000, 0]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.traffic = {"ens5": [20_000, 0]}
        self.assertEqual(self.ask("thaw desk-browser\n"), "ok")
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")

    def test_no_process_to_find_the_namespace_by_cant_be_told_so_is_busy(self):
        (self.cg / "cgroup.procs").write_text("")
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")

    def test_counters_that_cant_be_read_cant_be_told_so_are_busy(self):
        (self.proc / PID / "net" / "dev").write_text("Inter-|\n face |\n  ens5: x y\n")
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")
        (self.proc / PID / "net" / "dev").unlink()
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")

    def test_counters_that_go_back_are_busy(self):
        self.traffic = {"ens5": [-1000, 0]}
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy network")

    def test_a_download_is_asked_before_the_window_is_waited_out(self):
        self.traffic = {"ens5": [50_000, 0]}
        self.crdownload("a.crdownload", 0)
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy download")
        self.assertEqual(self.slept, [])

    # ---- a freeze that doesn't work is thawed
    def test_a_freeze_the_kernel_doesnt_finish_is_a_timeout_and_is_thawed(self):
        self.flag("kernel-holds")
        self.assertEqual(self.ask("freeze desk-browser\n"), "err timeout freeze desk-browser took over 1 s")
        self.assertEqual((self.cg / "cgroup.freeze").read_text().strip(), "0")
        self.assertRegex(self.log_text, r"freeze desk-browser: timeout in \d+ ms")

    def test_a_cgroup_that_cant_be_written_is_failed(self):
        (self.cg / "cgroup.freeze").unlink()
        (self.cg / "cgroup.freeze").mkdir()
        self.assertEqual(self.ask("freeze desk-browser\n"), "err failed freeze desk-browser: IsADirectoryError, frozen 0")

    def test_a_thaw_the_kernel_doesnt_finish_is_failed(self):
        self.ask("freeze desk-browser\n")
        self.flag("kernel-holds")
        self.assertEqual(self.ask("thaw desk-browser\n"), "err failed thaw desk-browser: frozen 1")

    def test_a_link_at_cgroup_freeze_isnt_followed(self):
        target = pathlib.Path(self.tmp.name) / "elsewhere"
        target.write_text("0\n")
        (self.cg / "cgroup.freeze").unlink()
        (self.cg / "cgroup.freeze").symlink_to(target)
        self.assertTrue(self.ask("freeze desk-browser\n").startswith("err failed freeze desk-browser: OSError"))
        self.assertEqual(target.read_text(), "0\n")

    # ---- T46L-1: no freeze lands in a stop's quit (desk-browser is still active while desk-browser-thaw quits it)
    def test_a_stop_of_desk_browser_queued_or_running_is_busy_stopping_and_nothing_is_written(self):
        for jobs in ("4711 desk-browser.service      stop    waiting", "4711 desk-browser.service stop running",
                     "4712 desk-browser.service restart waiting", "4713 desk-browser.service try-restart waiting",
                     "4714 desk-browser-thaw.service stop running\n4711 desk-browser.service stop waiting",
                     "4714 desk-browser-thaw.service stop running", "4715 desk-browser-thaw.service restart waiting"):
            with self.subTest(jobs=jobs):
                self.jobs(jobs)
                (self.stub / "list-jobs-n").unlink(missing_ok=True)
                self.seen_freeze.clear()
                self.assertEqual(self.ask("freeze desk-browser\n"), "err busy stopping")
                self.assertEqual(self.frozen(), "0")
                self.assertNotIn("1", self.seen_freeze)
                self.assertEqual((self.cg / "cgroup.freeze").read_text().strip(), "0")
                self.assertRegex(self.log_text, r"\Adesk-units: freeze desk-browser: busy in \d+ ms\n\Z")   # never why

    def test_only_those_jobs_count(self):
        for jobs in ("4716 desk-browser.service start waiting", "4717 desk-browser-thaw.service start waiting",
                     "4718 desk-stream.service stop running", "4719 desk-browser.service verify-active waiting"):
            with self.subTest(jobs=jobs):
                self.jobs(jobs)
                self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
                self.assertEqual(self.ask("thaw desk-browser\n"), "ok")

    def test_the_jobs_asked_for_are_desk_browsers_and_desk_browser_thaws(self):
        self.ask("freeze desk-browser\n")
        self.assertEqual([c for c in self.calls() if c.startswith("list-jobs")],
                         ["list-jobs --no-legend desk-browser.service desk-browser-thaw.service"] * 2)

    def test_a_stop_queued_after_the_first_look_is_seen_after_the_write_and_undone(self):
        self.jobs("", 1)
        self.jobs("4711 desk-browser.service stop waiting", 2)
        self.assertEqual(self.ask("freeze desk-browser\n"), "err busy stopping")
        self.assertIn("1", self.seen_freeze, "the freeze was written before the second look")
        self.assertEqual((self.cg / "cgroup.freeze").read_text().strip(), "0")
        self.assertEqual(self.frozen(), "0")
        self.assertEqual(self.ask("stop desk-browser\n"), "ok")
        self.assertEqual(self.calls("killed"), [])

    def test_the_fake_does_kill_a_freeze_left_in_place_by_a_freeze_that_doesnt_look_again(self):
        # What the second look prevents: with it gone, the same order ends with a frozen Chromium at the stop.
        self.jobs("", 1)
        self.jobs("4711 desk-browser.service stop waiting", 2)
        self.m.STOP_JOBS = set()
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.m.STOPS_BROWSER = set()
        self.ask("stop desk-browser\n")
        self.assertEqual(self.calls("killed"), ["stop desk-browser.service"])

    def test_jobs_that_cant_be_listed_are_a_timeout_and_nothing_is_frozen(self):
        for flag in ("list-jobs-fails", "list-jobs-hangs"):
            with self.subTest(flag=flag):
                self.flag(flag)
                self.seen_freeze.clear()
                self.assertEqual(self.ask("freeze desk-browser\n"), "err timeout list-jobs took over 1 s, or failed")
                self.assertNotIn("1", self.seen_freeze)
                self.assertEqual(self.frozen(), "0")
                (self.stub / flag).unlink()

    def test_a_second_look_that_fails_undoes_the_freeze(self):
        (self.stub / "list-jobs-fails.2").touch()
        self.assertEqual(self.ask("freeze desk-browser\n"), "err timeout list-jobs took over 1 s, or failed")
        self.assertIn("1", self.seen_freeze)
        self.assertEqual((self.cg / "cgroup.freeze").read_text().strip(), "0")
        self.assertEqual(self.frozen(), "0")

    def test_a_second_look_that_cant_even_start_undoes_the_freeze(self):
        real, n = self.m.jobs_check, []
        def once():
            n.append(1)
            if len(n) == 2:
                raise PermissionError
            return real()
        self.m.jobs_check = once
        written, write = [], self.m.write_freeze
        self.m.write_freeze = lambda v: (written.append(v), write(v))
        self.assertEqual(self.ask("freeze desk-browser\n"), "err failed freeze desk-browser: list-jobs: PermissionError")
        self.assertEqual(written, ["1", "0"])
        self.assertEqual((self.cg / "cgroup.freeze").read_text().strip(), "0")

    def test_the_lock_on_desk_browsers_cgroup_is_held_from_the_first_look_to_the_answer(self):
        self.assertTrue(self.try_lock())
        self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        self.assertTrue(self.lock_free, "the kernel was never asked during the freeze")
        self.assertEqual(set(self.lock_free), {False}, "desk-browser-thaw could have thawed in the middle of the freeze")
        self.assertTrue(self.try_lock(), "let go after the answer")

    def test_a_freeze_waits_for_the_lock_and_gives_up_at_the_timeout(self):
        fd = os.open(self.cg, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            t0 = time.monotonic()
            self.assertEqual(self.ask("freeze desk-browser\n"), "err timeout freeze desk-browser waited over 1 s for its lock")
            self.assertGreaterEqual(time.monotonic() - t0, 1)
            self.assertEqual(self.frozen(), "0")
            self.assertEqual(self.systemctl_verbs(), ["is-active"])
            threading.Timer(0.3, os.close, (fd,)).start()   # desk-browser-thaw's thaw holds it only for a moment
            fd = None
            self.assertEqual(self.ask("freeze desk-browser\n"), "ok")
        finally:
            if fd is not None:
                os.close(fd)

    def test_a_cgroup_gone_since_is_active_is_inactive(self):
        for f in self.cg.iterdir():
            f.unlink()
        self.cg.rmdir()
        self.assertEqual(self.ask("freeze desk-browser\n"), "err inactive desk-browser isn't running")

    def test_a_thaw_takes_no_lock(self):
        # On the look path: a thaw never waits, whatever holds the lock.
        self.ask("freeze desk-browser\n")
        fd = os.open(self.cg, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            t0 = time.monotonic()
            self.assertEqual(self.ask("thaw desk-browser\n"), "ok")
            self.assertLess(time.monotonic() - t0, 0.5)
        finally:
            os.close(fd)

    # ---- what isn't allowed
    def test_freeze_and_thaw_are_only_for_desk_browser(self):
        for line in ("freeze desk-stream\n", "freeze desk-xorg\n", "freeze desk-audio\n", "thaw desk-stream\n", "thaw desk-xorg\n",
                     "freeze ssh\n", "thaw deskd\n", "freeze desk-rtc\n"):
            with self.subTest(line=line):
                self.assertEqual(self.ask(line), "err denied unit not allowed")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.frozen(), "0")

    def test_another_uid_is_denied(self):
        self.m.DESKD_UID = os.getuid() + 1
        self.assertEqual(self.ask("freeze desk-browser\n"), "err denied only deskd may use this socket")
        self.assertEqual(self.calls(), [])

    def test_anything_else_is_a_bad_request(self):
        for line in ("pause desk-browser\n", "freeze desk-browser;reboot\n", "freeze  desk-browser\n", "freeze desk-browser\nthaw desk-browser\n",
                     "FREEZE desk-browser\n", "freeze desk-browser", "freeze " + "a" * 70 + "\n"):
            with self.subTest(line=line):
                self.assertTrue(self.ask(line).startswith("err bad_request "))
        self.assertEqual(self.calls(), [])

    # ---- start and stop, otherwise unchanged
    def test_start_and_stop_still_work(self):
        self.assertEqual(self.ask("start desk-stream\n"), "ok")
        self.assertEqual(self.ask("stop desk-stream\n"), "ok")
        self.assertEqual(self.calls(), ["start desk-stream.service", "stop desk-stream.service"])

    def test_a_start_of_desk_browser_asks_its_wrapper_first_as_kiosk(self):
        self.m.BROWSER_START = str(self.bin / "refuse")
        (self.bin / "refuse").write_text("#!/bin/sh\necho 'desk-browser-start: REFUSING TO START, profile left untouched: x' >&2\nexit 78\n")
        (self.bin / "refuse").chmod(0o755)
        self.assertEqual(self.ask("start desk-browser\n"), "err failed start desk-browser: desk-browser-start: REFUSING TO START, profile left untouched: x")
        self.assertEqual(self.calls("setpriv.log"), [f"--reuid=1102 --regid=1102 --clear-groups {self.bin / 'refuse'}"])
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
