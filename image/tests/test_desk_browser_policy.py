#!/usr/bin/python3 -I
"""desk-browser-policy on temporary directories. No root, no /etc, no /data. python3 -I image/tests/test_desk_browser_policy.py"""
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import re
import signal
import socket
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock

sys.dont_write_bytecode = True
RECIPE = pathlib.Path(__file__).resolve().parent.parent / "recipe"
FILES = RECIPE / "files"
HELPER = FILES / "usr/local/lib/ma/desk-browser-policy"
SHIPPED = FILES / "etc/ma/chromium-teen.json"
MA_JSON = FILES / "etc/chromium/policies/managed/ma.json"
UNIT = FILES / "etc/systemd/system/desk-browser.service"
loader = importlib.machinery.SourceFileLoader("desk_browser_policy", str(HELPER))
spec = importlib.util.spec_from_loader("desk_browser_policy", loader)
P = importlib.util.module_from_spec(spec)
loader.exec_module(P)

POLICY_TEXT = b'{"ProxyMode": "direct"}\n'


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.band_dir = self.root / "data/desk"
        self.band_dir.mkdir(parents=True)
        self.band = self.band_dir / "age-band"
        self.managed = self.root / "managed"
        self.managed.mkdir()
        self.lock = self.managed / "ma-teen.json"
        self.temp = self.managed / ".ma-teen.json.tmp"
        self.policy = self.root / "chromium-teen.json"
        self.policy.write_bytes(POLICY_TEXT)
        self.policy.chmod(0o644)
        for name, value in (("BAND_DIR", str(self.band_dir)), ("LOCK", str(self.lock)), ("POLICY", str(self.policy)),
                            ("OWNER", (os.getuid(), os.getgid()))):
            patcher = mock.patch.object(P, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # A band that blocks the helper fails the test, instead of hanging the suite.
        signal.signal(signal.SIGALRM, self.hung)
        signal.alarm(20)
        self.addCleanup(signal.alarm, 0)

    @staticmethod
    def hung(*_):
        raise AssertionError("the helper hung")

    def run_helper(self):
        err = io.StringIO()
        with redirect_stderr(err):
            rc = P.main()
        self.log = err.getvalue()
        return rc

    def assert_locked(self, reason=None):
        rc = self.run_helper()
        self.assertEqual(rc, 0, self.log)
        self.assertTrue(self.lock.is_file() and not self.lock.is_symlink())
        self.assertEqual(self.lock.read_bytes(), POLICY_TEXT)
        self.assertEqual(stat.S_IMODE(self.lock.stat().st_mode), 0o644)
        self.assertEqual((self.lock.stat().st_uid, self.lock.stat().st_gid), (os.getuid(), os.getgid()))
        self.assertFalse(os.path.lexists(self.temp))
        self.assertIn("locked:", self.log)
        if reason:
            self.assertIn(reason, self.log)

    def assert_not_locked(self):
        rc = self.run_helper()
        self.assertEqual(rc, 0, self.log)
        self.assertFalse(os.path.lexists(self.lock))
        self.assertFalse(os.path.lexists(self.temp))
        self.assertIn("not locked: band adult", self.log)

    def start_unlocked(self):
        self.assertFalse(os.path.lexists(self.lock))


class Bands(Case):
    def test_adult_removes_the_lock(self):
        self.lock.write_bytes(POLICY_TEXT)
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()

    def test_adult_with_no_lock_does_nothing(self):
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.assert_not_locked()

    def test_teen_installs(self):
        self.band.write_bytes(b"teen\n")
        self.assert_locked("band teen")

    def test_teen_twice_is_the_same(self):
        self.band.write_bytes(b"teen\n")
        self.assert_locked()
        self.assert_locked()
        self.assertEqual(sorted(p.name for p in self.managed.iterdir()), ["ma-teen.json"])

    def test_teen_replaces_a_lock_changed_since(self):
        self.lock.write_bytes(b"{}")
        self.lock.chmod(0o666)
        self.band.write_bytes(b"teen\n")
        self.assert_locked()

    def test_moving_between_bands(self):
        self.band.write_bytes(b"teen\n")
        self.assert_locked()
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.band.write_bytes(b"teen\n")
        self.assert_locked()


class FailsClosed(Case):
    """Every one of these leaves the desk locked, starting from no lock."""

    def locked_from_adult_state(self, reason=None):
        self.start_unlocked()
        self.assert_locked(reason)

    def test_missing_file(self):
        self.locked_from_adult_state("can't open the band")

    def test_missing_directory(self):
        self.band_dir.rmdir()
        self.locked_from_adult_state("no band directory")

    def test_no_data_at_all(self):
        with mock.patch.object(P, "BAND_DIR", str(self.root / "nothing/desk")):
            self.locked_from_adult_state("no band directory")

    def test_band_dir_is_a_symlink_to_a_directory_saying_adult(self):
        other = self.root / "other"
        other.mkdir()
        (other / "age-band").write_bytes(b"adult\n")
        self.band_dir.rmdir()
        self.band_dir.symlink_to(other)
        self.locked_from_adult_state("no band directory")

    def test_band_dir_is_a_file(self):
        self.band_dir.rmdir()
        self.band_dir.write_bytes(b"adult\n")
        self.locked_from_adult_state("no band directory")

    def test_symlink_to_a_file_saying_adult(self):
        other = self.root / "other"
        other.write_bytes(b"adult\n")
        self.band.symlink_to(other)
        self.locked_from_adult_state("can't open the band")

    def test_dangling_symlink(self):
        self.band.symlink_to(self.root / "nowhere")
        self.locked_from_adult_state("can't open the band")

    def test_fifo_with_no_writer_does_not_hang(self):
        os.mkfifo(self.band)
        self.locked_from_adult_state("isn't a regular file")

    def test_fifo_with_a_writer_saying_adult(self):
        os.mkfifo(self.band)
        reader = os.open(self.band, os.O_RDONLY | os.O_NONBLOCK)
        writer = os.open(self.band, os.O_WRONLY)
        self.addCleanup(os.close, reader)
        self.addCleanup(os.close, writer)
        os.write(writer, b"adult\n")
        self.locked_from_adult_state("isn't a regular file")

    def test_directory(self):
        self.band.mkdir()
        self.locked_from_adult_state("isn't a regular file")

    def test_socket(self):
        s = socket.socket(socket.AF_UNIX)
        self.addCleanup(s.close)
        cwd = os.getcwd()   # a temporary path can be too long for bind
        os.chdir(self.band_dir)
        self.addCleanup(os.chdir, cwd)
        s.bind("age-band")
        self.locked_from_adult_state("can't open the band")

    def test_unreadable_file(self):
        if os.getuid() == 0:
            self.skipTest("root reads anything")
        self.band.write_bytes(b"adult\n")
        self.band.chmod(0)
        self.locked_from_adult_state("can't open the band")

    def test_unreadable_directory(self):
        if os.getuid() == 0:
            self.skipTest("root reads anything")
        self.band.write_bytes(b"adult\n")
        self.band_dir.chmod(0)
        self.addCleanup(self.band_dir.chmod, 0o755)
        self.locked_from_adult_state("no band directory")

    def test_oversized_file_starting_right(self):
        self.band.write_bytes(b"adult\n" + b"x" * (1 << 20))
        self.locked_from_adult_state("too large")

    def test_one_byte_over_the_limit(self):
        self.band.write_bytes(b"adult\n" + b"\n" * (P.MAX_BAND - 5))
        self.locked_from_adult_state("too large")

    def test_a_huge_sparse_file_is_not_read(self):
        with open(self.band, "wb") as f:
            f.truncate(1 << 40)
        self.locked_from_adult_state("too large")

    def test_near_misses(self):
        for data in (b"ADULT\n", b"Adult\n", b"adult", b"adult ", b"adult \n", b" adult\n", b"adult\n\n", b"\nadult\n",
                     b"adult\r\n", b"adult\0\n", b"\0adult\n", b"adults\n", b"TEEN\n", b"teen", b"teen\n\n", b"", b"\n",
                     b"\xff\xfe", "adult​\n".encode(), b"child\n", b"1\n", b"adult\nteen\n"):
            with self.subTest(data=data):
                if self.lock.exists():
                    self.lock.unlink()
                self.band.write_bytes(data)
                self.assert_locked()

    def test_the_log_never_holds_the_band(self):
        self.band.write_bytes(b"SECRET1\n")
        self.assert_locked()
        self.assertNotIn("SECRET1", self.log)
        self.assertEqual(self.log.count("\n"), 1)


class LockFailures(Case):
    def assert_refused(self, text=None):
        rc = self.run_helper()
        self.assertEqual(rc, 1, self.log)
        self.assertIn("LOCK NOT IN PLACE", self.log)
        if text:
            self.assertIn(text, self.log)

    def test_no_policy_file(self):
        self.policy.unlink()
        self.band.write_bytes(b"teen\n")
        self.assert_refused()
        self.assertFalse(self.lock.exists())

    def test_policy_is_a_symlink(self):
        other = self.root / "elsewhere.json"
        other.write_bytes(POLICY_TEXT)
        self.policy.unlink()
        self.policy.symlink_to(other)
        self.assert_refused()

    def test_policy_writable_by_others(self):
        for mode in (0o666, 0o664, 0o646):
            with self.subTest(mode=oct(mode)):
                self.policy.chmod(mode)
                self.assert_refused("only root can write")

    def test_policy_owned_by_someone_else(self):
        with mock.patch.object(P, "OWNER", (os.getuid() + 1, os.getgid())):
            self.assert_refused("only root can write")

    def test_policy_is_a_fifo_with_no_writer(self):
        self.policy.unlink()
        os.mkfifo(self.policy)
        self.assert_refused("only root can write")

    def test_policy_is_not_json(self):
        self.policy.write_bytes(b"{ not json")
        self.assert_refused("isn't JSON")

    def test_policy_is_empty_or_no_object(self):
        for data in (b"", b"{}", b"[]", b"1"):
            with self.subTest(data=data):
                self.policy.write_bytes(data)
                self.assert_refused()

    def test_policy_too_large(self):
        self.policy.write_bytes(b" " * (P.MAX_POLICY + 1))
        self.assert_refused("only root can write")

    def test_no_managed_directory(self):
        self.managed.rmdir()
        self.assert_refused()

    def test_managed_directory_not_writable(self):
        if os.getuid() == 0:
            self.skipTest("root writes anything")
        self.managed.chmod(0o555)
        self.addCleanup(self.managed.chmod, 0o755)
        self.assert_refused()

    def test_rename_fails_and_leaves_no_lock(self):
        self.band.write_bytes(b"teen\n")
        with mock.patch.object(P.os, "rename", side_effect=OSError(30, "Read-only file system")):
            self.assert_refused("Read-only file system")
        self.assertFalse(self.lock.exists())

    def test_lock_is_a_directory(self):
        self.lock.mkdir()
        self.assert_refused()

    def test_a_refusal_never_logs_the_policy(self):
        self.policy.write_bytes(b"SECRET2 not json")
        self.assert_refused()
        self.assertNotIn("SECRET2", self.log)

    def test_process_exit_code(self):
        self.policy.unlink()
        with mock.patch.object(sys, "exit") as ex, redirect_stderr(io.StringIO()):
            ex.side_effect = SystemExit
            with self.assertRaises(SystemExit):
                sys.exit(P.main())
            ex.assert_called_once_with(1)


class Leftovers(Case):
    def test_a_temp_left_by_a_killed_run_goes(self):
        self.temp.write_bytes(b"partial")
        self.assert_locked()

    def test_a_temp_that_is_a_symlink_is_not_followed(self):
        victim = self.root / "victim"
        victim.write_bytes(b"keep")
        self.temp.symlink_to(victim)
        self.assert_locked()
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_adult_also_clears_a_temp(self):
        self.temp.write_bytes(b"partial")
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()

    def test_lock_that_is_a_symlink_is_replaced_not_followed(self):
        victim = self.root / "victim"
        victim.write_bytes(b"keep")
        self.lock.symlink_to(victim)
        self.assert_locked()
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_adult_removes_a_symlink_not_its_target(self):
        victim = self.root / "victim"
        victim.write_bytes(b"keep")
        self.lock.symlink_to(victim)
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.assertEqual(victim.read_bytes(), b"keep")


class AdultRemovalFails(Case):
    def test_starts_anyway_and_says_so(self):
        self.lock.mkdir()   # unlink() refuses a directory
        self.band.write_bytes(b"adult\n")
        rc = self.run_helper()
        self.assertEqual(rc, 0)
        self.assertIn("may still be locked", self.log)
        self.assertNotIn("not locked", self.log)

    def test_a_policy_problem_does_not_touch_an_adult(self):
        self.policy.unlink()
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()


class Shipped(unittest.TestCase):
    DRAFT = {
        "DnsOverHttpsMode": "secure",
        "DnsOverHttpsTemplates": "https://family.cloudflare-dns.com/dns-query",
        "ForceGoogleSafeSearch": True,
        "ForceYouTubeRestrict": 1,
        "ProxyMode": "direct",
        "ExtensionInstallBlocklist": ["*"],
        "ExtensionInstallAllowlist": [],
    }

    def test_the_policy_is_the_drafts(self):
        self.assertEqual(json.loads(SHIPPED.read_text()), self.DRAFT)

    def test_no_keys_shared_with_ma_json(self):
        self.assertEqual(sorted(set(json.loads(SHIPPED.read_text())) & set(json.loads(MA_JSON.read_text()))), [])

    def test_shipped_policy_installs(self):
        with mock.patch.object(P, "POLICY", str(SHIPPED)), mock.patch.object(P, "OWNER", (SHIPPED.stat().st_uid, SHIPPED.stat().st_gid)):
            if SHIPPED.stat().st_mode & 0o022:
                self.skipTest("this checkout's umask leaves the file group-writable; build.sh sets 0644")
            self.assertEqual(json.loads(P.read_policy()), self.DRAFT)

    def test_helper_is_executable_and_isolated(self):
        self.assertTrue(HELPER.stat().st_mode & 0o100)
        self.assertEqual(HELPER.read_text().split("\n", 1)[0], "#!/usr/bin/python3 -I")

    def test_paths_are_the_real_ones(self):
        self.assertEqual(P.BAND_DIR, "/data/desk")
        self.assertEqual(P.BAND_FILE, "age-band")
        self.assertEqual(P.POLICY, "/etc/ma/chromium-teen.json")
        self.assertEqual(P.LOCK, "/etc/chromium/policies/managed/ma-teen.json")
        self.assertEqual(P.OWNER, (0, 0))

    def test_the_unit_runs_it_as_root_before_chromium(self):
        lines = UNIT.read_text().splitlines()
        pre = lines.index("ExecStartPre=+/usr/local/lib/ma/desk-browser-policy")
        start = next(i for i, l in enumerate(lines) if l.startswith("ExecStart="))
        self.assertLess(pre, start)
        self.assertEqual(lines.count("User=kiosk"), 1)

    def test_the_unit_needs_data_first(self):
        text = UNIT.read_text()
        self.assertRegex(text, r"(?m)^Requires=.*\bdesk-datadirs\.service\b")
        self.assertRegex(text, r"(?m)^After=.*\bdesk-datadirs\.service\b")

    def test_the_image_ships_no_lock(self):
        self.assertFalse((MA_JSON.parent / "ma-teen.json").exists())

    def test_the_read_list_trace_leaves_no_lock(self):
        text = (RECIPE / "first-open/trace").read_text()
        self.assertTrue(re.search(r'(?m)^LOCK = "/etc/chromium/policies/managed/ma-teen\.json"$', text))
        self.assertTrue(re.search(r"for path in \(SOCK, LOCK\):\n\s+try:\n\s+os\.unlink\(path\)", text))


if __name__ == "__main__":
    unittest.main(verbosity=1)
