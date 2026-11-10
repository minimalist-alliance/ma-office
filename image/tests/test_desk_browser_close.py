#!/usr/bin/python3 -I
"""desk-browser-close on a fake systemctl and a temporary profile. No root. python3 -I image/tests/test_desk_browser_close.py"""
import base64
import hashlib
import json
import os
import pathlib
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

sys.dont_write_bytecode = True
HELPER = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "usr" / "local" / "lib" / "ma" / "desk-browser-close"

# Plays systemd and, for desk-browser, Chromium: a stop of a running desk-browser writes the exit_type that `on-stop` names
# into the profile's Preferences, as Chromium does on SIGTERM (or leaves Crashed, as a SIGKILL does). Every call is logged.
FAKE_SYSTEMCTL = r"""#!/bin/bash
S=$STUB_DIR
echo "$*" >> "$S/log"
case "$1" in
  is-active)
    st=$(cat "$S/$2.state" 2>/dev/null || echo inactive); echo "$st"; [ "$st" = active ] ;;
  stop)
    if [ "$2" = desk-browser ] && [ "$(cat "$S/desk-browser.state" 2>/dev/null)" = active ]; then
      [ -f "$S/stuck" ] && exit 1
      printf '{"profile":{"exit_type":"%s","exited_cleanly":true}}' "$(cat "$S/on-stop")" > "$PROFILE/Default/Preferences"
    fi
    echo inactive > "$S/$2.state" ;;
  show) [ "$*" = "show -p MainPID --value desk-browser" ] && cat "$S/mainpid" 2>/dev/null ;;
  list-units)
    n=$(cat "$S/units-busy" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo "desk-units@0-1100.service loaded active running units"; echo $((n - 1)) > "$S/units-busy"; fi ;;
esac
"""


class FakeCdp:
    """Chromium's CDP on a loopback port: /json/version, then a WebSocket on the browser target. On Browser.close it logs
    `cdp Browser.close` into the stub log and, when `quits`, does what Chromium's own Exit does: the unit goes inactive and
    the profile says Normal. When not, it answers and keeps running, as a wedged Chromium would."""

    def __init__(self, stub, profile, quits=True):
        self.stub, self.profile, self.quits = stub, profile, quits
        self.ln = socket.create_server(("127.0.0.1", 0))
        self.port = self.ln.getsockname()[1]
        self.got = []
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                c, _ = self.ln.accept()
            except OSError:
                return
            with c:
                b = b""
                while b"\r\n\r\n" not in b:
                    d = c.recv(4096)
                    if not d:
                        break
                    b += d
                head = b.split(b"\r\n\r\n", 1)[0].decode()
                path = head.split(" ")[1]
                if path == "/json/version":
                    body = json.dumps({"webSocketDebuggerUrl": f"ws://127.0.0.1:{self.port}/devtools/browser/fake"}).encode()
                    c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
                    continue
                key = next(l.split(":", 1)[1].strip() for l in head.split("\r\n") if l.lower().startswith("sec-websocket-key"))
                acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                c.sendall(f"HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {acc}\r\n\r\n".encode())
                h = c.recv(2)
                n, mask = h[1] & 0x7F, c.recv(4)
                msg = json.loads(bytes(x ^ mask[i % 4] for i, x in enumerate(c.recv(n))))
                self.got.append((path, msg))
                with open(self.stub / "log", "a") as f:
                    f.write(f"cdp {msg['method']}\n")
                if msg["method"] == "Browser.close" and self.quits:
                    (self.stub / "desk-browser.state").write_text("inactive")
                    (self.profile / "Default" / "Preferences").write_text('{"profile":{"exit_type":"Normal","exited_cleanly":true}}')
                r = json.dumps({"id": msg["id"], "result": {}}).encode()
                c.sendall(b"\x81" + bytes([len(r)]) + r)

    def close(self):
        self.ln.close()


class DeskBrowserCloseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.stub, self.bin, self.profile = t / "stub", t / "bin", t / "profile"
        for d in (self.stub, self.bin, self.profile / "Default"):
            d.mkdir(parents=True)
        fake = self.bin / "systemctl"
        fake.write_text(FAKE_SYSTEMCTL)
        fake.chmod(0o755)
        # Every sleep is logged, apart from the other calls, so a wait shows without slowing the test.
        sleep = self.bin / "sleep"
        # With a `refreeze` file, each sleep also notes what desk-browser's cgroup.freeze held when it began, then writes 1
        # into it: a freeze landing during every second of the wait (T46L-1).
        sleep.write_text('#!/bin/sh\necho "$*" >> "$STUB_DIR/sleeps"\n'
                         'if [ -f "$STUB_DIR/refreeze" ]; then cat "$CG/cgroup.freeze" >> "$STUB_DIR/at-sleep"; echo 1 > "$CG/cgroup.freeze"; fi\n')
        sleep.chmod(0o755)
        # desk-browser's cgroup: none unless a test makes one, so nothing here can touch this machine's /sys.
        self.cg = t / "cgroup"
        # No CDP unless a test starts one: a port bound and held but not listening, so a connection is refused at once and
        # nothing here can reach a real Chromium on this machine's 9222.
        self.refuser = socket.socket()
        self.refuser.bind(("127.0.0.1", 0))
        self.cdp_port = self.refuser.getsockname()[1]
        self.cdp = None
        # sync is logged in the same list as systemctl, so its place in the order shows. A `sync-fails` file makes it fail.
        self.data = t / "data"
        self.data.mkdir()
        sync = self.bin / "sync"
        sync.write_text('#!/bin/sh\necho "sync $*" >> "$STUB_DIR/log"\n[ ! -f "$STUB_DIR/sync-fails" ]\n')
        sync.chmod(0o755)
        # While Chromium runs, its Preferences say Crashed: that's how a killed one is told from a stopped one.
        (self.profile / "Default" / "Preferences").write_text('{"profile":{"exit_type":"Crashed","exited_cleanly":false}}')
        self.state("deskd", "active")
        self.state("desk-browser", "active")
        (self.stub / "on-stop").write_text("SessionEnded")

    def tearDown(self):
        if self.cdp:
            self.cdp.close()
        self.refuser.close()
        self.tmp.cleanup()

    def start_cdp(self, quits=True):
        self.cdp = FakeCdp(self.stub, self.profile, quits)
        self.cdp_port = self.cdp.port

    def sleeps(self):
        f = self.stub / "sleeps"
        return f.read_text().splitlines() if f.exists() else []

    def state(self, unit, value):
        (self.stub / f"{unit}.state").write_text(value)

    def run_helper(self, settle="5"):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "STUB_DIR": str(self.stub), "PROFILE": str(self.profile),
               "MA_BROWSER_PROFILE": str(self.profile), "MA_CLOSE_SETTLE": settle, "MA_DATA": str(self.data),
               "MA_CDP_HOSTS": "127.0.0.1", "MA_CDP_PORT": str(self.cdp_port), "MA_COMMIT_WAIT": "31",
               "MA_BROWSER_CGROUP": str(self.cg), "CG": str(self.cg)}
        return subprocess.run(["/bin/bash", str(HELPER)], env=env, capture_output=True, text=True, timeout=30)

    def calls(self):
        return (self.stub / "log").read_text().splitlines()

    def test_deskd_stops_first_then_chromium_and_a_clean_exit_passes(self):
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("browser=active->inactive exit_type=SessionEnded deskd=inactive", r.stdout)
        stops = [c for c in self.calls() if c.startswith("stop ")]
        self.assertEqual(stops, ["stop deskd", "stop desk-browser"])

    def test_chromium_is_asked_to_quit_over_cdp_after_deskd_and_before_the_stop(self):
        self.start_cdp()
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("browser=active->inactive exit_type=Normal deskd=inactive quit=cdp sync=ok", r.stdout)
        self.assertEqual(self.cdp.got, [("/devtools/browser/fake", {"id": 1, "method": "Browser.close"})])
        calls = self.calls()
        self.assertLess(calls.index("stop deskd"), calls.index("cdp Browser.close"))
        # The stop still runs, a no-op here: it would cancel a restart if Chromium's exit had counted as a failure.
        self.assertLess(calls.index("cdp Browser.close"), calls.index("stop desk-browser"))
        self.assertLess(calls.index("stop desk-browser"), calls.index(f"sync -f {self.data}"))
        self.assertNotIn("31", self.sleeps())
        self.assertEqual(r.stderr, "")

    # ---- --quit: the same quit inside a stop of desk-browser that's already queued (desk-browser-thaw's ExecStop)
    def run_quit(self):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "STUB_DIR": str(self.stub), "PROFILE": str(self.profile),
               "MA_BROWSER_PROFILE": str(self.profile), "MA_CLOSE_SETTLE": "5", "MA_DATA": str(self.data),
               "MA_CDP_HOSTS": "127.0.0.1", "MA_CDP_PORT": str(self.cdp_port), "MA_COMMIT_WAIT": "31",
               "MA_BROWSER_CGROUP": str(self.cg), "CG": str(self.cg)}
        return subprocess.run(["/bin/bash", str(HELPER), "--quit"], env=env, capture_output=True, text=True, timeout=30)

    def test_quit_asks_chromium_over_cdp_and_leaves_deskd_and_systemd_alone(self):
        self.start_cdp()
        r = self.run_quit()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("desk-browser-close --quit: browser=active->inactive exit_type=Normal deskd=left quit=cdp sync=ok", r.stdout)
        self.assertEqual(self.cdp.got, [("/devtools/browser/fake", {"id": 1, "method": "Browser.close"})])
        calls = self.calls()
        self.assertNotIn("stop deskd", calls)
        self.assertNotIn("stop desk-browser", calls, "the stop is already queued: asking for it again would wait on itself")
        self.assertIn(f"sync -f {self.data}", calls)
        self.assertEqual(r.stderr, "")

    def test_quit_with_no_cdp_waits_out_the_cookie_commit_and_still_exits_0(self):
        r = self.run_quit()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("quit=term", r.stdout)
        self.assertEqual(self.sleeps(), ["1"] * 31)
        self.assertNotIn("stop desk-browser", self.calls())

    # ---- T46L-1: a freeze that lands during the quit is undone within a second
    def frozen_cgroup(self):
        self.cg.mkdir()
        (self.cg / "cgroup.freeze").write_text("1\n")
        (self.stub / "refreeze").touch()

    def at_sleep(self):
        return (self.stub / "at-sleep").read_text().split()

    def test_quit_thaws_before_the_quit_and_on_every_pass_of_the_wait(self):
        self.frozen_cgroup()
        self.start_cdp(quits=False)
        r = self.run_quit()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.sleeps().count("1"), 31)
        self.assertEqual(self.at_sleep(), ["0"] * 31, "a freeze that landed during a second of the wait was still there at the next")
        self.assertEqual(r.stderr, "")

    def test_quit_with_no_cdp_thaws_on_every_pass_too(self):
        # Chromium frozen then can't answer CDP; thawed, it commits its cookies itself within the 31 s.
        self.frozen_cgroup()
        r = self.run_quit()
        self.assertIn("quit=term", r.stdout)
        self.assertEqual(self.at_sleep(), ["0"] * 31)

    def test_the_close_before_a_root_swap_thaws_on_every_pass_too(self):
        self.frozen_cgroup()
        self.start_cdp(quits=False)
        r = self.run_helper()
        self.assertEqual(self.at_sleep(), ["0"] * 31)
        self.assertIn("quit=term", r.stdout)

    def test_the_fake_would_show_a_wait_that_thaws_only_once(self):
        # The same wait with the thaw only before it, as before T46L-1: every second after the first finds it frozen.
        self.frozen_cgroup()
        self.start_cdp(quits=False)
        helper = HELPER.read_text().replace("      thaw\n      if up;", "      if up;", 1)
        self.assertNotEqual(helper, HELPER.read_text())
        once = self.stub / "close-thaw-once"
        once.write_text(helper)
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "STUB_DIR": str(self.stub), "PROFILE": str(self.profile),
               "MA_BROWSER_PROFILE": str(self.profile), "MA_CLOSE_SETTLE": "5", "MA_DATA": str(self.data), "MA_CDP_HOSTS": "127.0.0.1",
               "MA_CDP_PORT": str(self.cdp_port), "MA_COMMIT_WAIT": "31", "MA_BROWSER_CGROUP": str(self.cg), "CG": str(self.cg)}
        subprocess.run(["/bin/bash", str(once), "--quit"], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(self.at_sleep(), ["0"] + ["1"] * 30)

    def test_quit_gives_a_chromium_that_ignores_browser_close_31_s_and_never_fails_the_stop(self):
        self.start_cdp(quits=False)
        r = self.run_quit()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("browser=active->active", r.stdout)
        self.assertEqual(self.sleeps().count("1"), 31)
        self.assertNotIn("stop desk-browser", self.calls())

    def test_quit_follows_the_chromium_it_quit_by_pid_not_the_unit(self):
        # A start queued behind the stop brings a new Chromium up as soon as this one goes, so the unit reads active again:
        # the wait must end when the old main process has gone, not run its 31 s. Here it's gone, and the unit stays active.
        main = subprocess.Popen(["sleep", "60"])
        (self.stub / "mainpid").write_text(str(main.pid))
        self.start_cdp(quits=False)
        main.kill()
        main.wait()
        r = self.run_quit()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("browser=active->active", r.stdout)
        self.assertIn("quit=cdp", r.stdout)
        self.assertEqual(self.sleeps(), [])

    def test_quit_waits_while_that_pid_is_there(self):
        main = subprocess.Popen(["sleep", "60"])
        try:
            (self.stub / "mainpid").write_text(str(main.pid))
            self.start_cdp(quits=True)   # the unit goes inactive, but the process it was doesn't: wait for the process
            r = self.run_quit()
            self.assertIn("quit=term", r.stdout)
            self.assertEqual(self.sleeps().count("1"), 31)
        finally:
            main.kill()
            main.wait()

    def test_quit_of_a_browser_that_isnt_running_sends_nothing(self):
        self.start_cdp()
        self.state("desk-browser", "inactive")
        r = self.run_quit()
        self.assertEqual(r.returncode, 0)
        self.assertIn("quit=none", r.stdout)
        self.assertEqual(self.cdp.got, [])

    def test_no_cdp_waits_out_the_cookie_commit_then_stops(self):
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("exit_type=SessionEnded deskd=inactive quit=term sync=ok", r.stdout)
        self.assertEqual(self.sleeps(), ["1"] * 31)
        self.assertIn("stop desk-browser", self.calls())
        self.assertEqual(r.stderr, "")

    def test_a_chromium_that_ignores_browser_close_gets_the_wait_then_the_stop(self):
        self.start_cdp(quits=False)
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("exit_type=SessionEnded deskd=inactive quit=term sync=ok", r.stdout)
        self.assertEqual(self.sleeps().count("1"), 31)
        calls = self.calls()
        self.assertLess(calls.index("cdp Browser.close"), calls.index("stop desk-browser"))

    def test_not_running_sends_nothing_over_cdp(self):
        self.start_cdp()
        self.state("desk-browser", "inactive")
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("quit=none", r.stdout)
        self.assertEqual(self.cdp.got, [])
        self.assertEqual(self.sleeps(), [])

    def test_data_is_synced_after_chromium_stops_and_before_the_report(self):
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sync=ok", r.stdout)
        calls = self.calls()
        self.assertEqual(calls.count(f"sync -f {self.data}"), 1)
        self.assertLess(calls.index("stop desk-browser"), calls.index(f"sync -f {self.data}"))
        # The report reads deskd's state after the sync, so the sync came before the line was printed.
        self.assertLess(calls.index(f"sync -f {self.data}"), len(calls) - 1)
        self.assertEqual(calls[-1], "is-active deskd")

    def test_a_failed_sync_fails_even_a_clean_close(self):
        (self.stub / "sync-fails").write_text("")
        r = self.run_helper()
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("exit_type=SessionEnded", r.stdout)
        self.assertIn("sync=failed", r.stdout)

    def test_a_failed_sync_fails_when_chromium_was_not_running(self):
        self.state("desk-browser", "inactive")
        (self.stub / "sync-fails").write_text("")
        r = self.run_helper()
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("sync=failed", r.stdout)

    def test_the_real_sync_on_a_real_directory(self):
        (self.bin / "sync").unlink()
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sync=ok", r.stdout)
        self.assertEqual(r.stderr, "")

    def test_normal_is_clean_too(self):
        (self.stub / "on-stop").write_text("Normal")
        self.assertEqual(self.run_helper().returncode, 0)

    def test_a_chromium_that_had_to_be_killed_fails(self):
        (self.stub / "on-stop").write_text("Crashed")
        r = self.run_helper()
        self.assertEqual(r.returncode, 1)
        self.assertIn("exit_type=Crashed", r.stdout)

    def test_a_chromium_still_running_fails(self):
        (self.stub / "stuck").write_text("")
        r = self.run_helper()
        self.assertEqual(r.returncode, 1)
        self.assertIn("browser=active->active", r.stdout)

    def test_not_running_is_nothing_to_close_whatever_the_last_exit_said(self):
        self.state("desk-browser", "inactive")
        r = self.run_helper()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("browser=inactive->inactive exit_type=Crashed", r.stdout)
        self.state("desk-browser", "failed")
        self.assertEqual(self.run_helper().returncode, 0)

    def test_a_start_desk_units_is_running_finishes_before_the_stop(self):
        (self.stub / "units-busy").write_text("2")
        r = self.run_helper()
        self.assertEqual(r.returncode, 0)
        calls = self.calls()
        lists = [i for i, c in enumerate(calls) if c.startswith("list-units")]
        self.assertEqual(len(lists), 3)
        self.assertLess(calls.index("stop deskd"), lists[0])
        self.assertLess(lists[-1], calls.index("stop desk-browser"))

    def test_it_never_writes_the_profile(self):
        # Read-only from here on: only the fake Chromium's own stop may write, and here it's already stopped.
        self.state("desk-browser", "inactive")
        prefs = self.profile / "Default" / "Preferences"
        before = prefs.read_bytes()
        for p in (prefs, prefs.parent, self.profile):
            p.chmod(p.stat().st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
        try:
            r = self.run_helper()
        finally:
            for p in (self.profile, prefs.parent, prefs):
                p.chmod(p.stat().st_mode | stat.S_IWUSR)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(prefs.read_bytes(), before)
        self.assertEqual(r.stderr, "")
        self.assertEqual(sorted(os.listdir(self.profile)), ["Default"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
