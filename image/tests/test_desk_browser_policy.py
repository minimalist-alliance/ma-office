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
SHIPPED_ADULT = FILES / "etc/ma/chromium-adult.json"
ADBLOCK = FILES / "etc/ma/chromium-adblock.json"
MA_JSON = FILES / "etc/chromium/policies/managed/ma.json"
UNIT = FILES / "etc/systemd/system/desk-browser.service"
loader = importlib.machinery.SourceFileLoader("desk_browser_policy", str(HELPER))
spec = importlib.util.spec_from_loader("desk_browser_policy", loader)
P = importlib.util.module_from_spec(spec)
loader.exec_module(P)

POLICY_TEXT = b'{"ProxyMode": "direct"}\n'
ADULT_TEXT = b'{"ExtensionInstallAllowlist": ["nngceckbapebfimnlniiiahkandclblb"]}\n'


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
        self.adult = self.managed / "ma-adult.json"
        self.adult_temp = self.managed / ".ma-adult.json.tmp"
        self.adult_policy = self.root / "chromium-adult.json"
        self.adult_policy.write_bytes(ADULT_TEXT)
        self.adult_policy.chmod(0o644)
        for name, value in (("BAND_DIR", str(self.band_dir)), ("LOCK", str(self.lock)), ("POLICY", str(self.policy)),
                            ("ADULT", str(self.adult)), ("ADULT_POLICY", str(self.adult_policy)),
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
        self.assert_no_allowlist()

    def assert_no_allowlist(self):
        self.assertFalse(os.path.lexists(self.adult), "a desk that isn't adult has the password managers' allowlist")
        self.assertFalse(os.path.lexists(self.adult_temp))

    def assert_not_locked(self):
        rc = self.run_helper()
        self.assertEqual(rc, 0, self.log)
        self.assertFalse(os.path.lexists(self.lock))
        self.assertFalse(os.path.lexists(self.temp))
        self.assertIn("not locked: band adult", self.log)
        self.assertIn("sign-in extensions allowed", self.log)
        self.assertTrue(self.adult.is_file() and not self.adult.is_symlink())
        self.assertEqual(self.adult.read_bytes(), ADULT_TEXT)
        self.assertEqual(stat.S_IMODE(self.adult.stat().st_mode), 0o644)
        self.assertEqual((self.adult.stat().st_uid, self.adult.stat().st_gid), (os.getuid(), os.getgid()))
        self.assertFalse(os.path.lexists(self.adult_temp))

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
        self.adult.write_bytes(ADULT_TEXT)   # the adult state: the allowlist in place, which has to go
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
                self.adult.write_bytes(ADULT_TEXT)
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
        self.assert_no_allowlist()   # never both: still locked, so no allowlist either

    def test_a_stale_allowlist_beside_a_lock_that_stays_goes(self):
        self.lock.mkdir()
        self.adult.write_bytes(ADULT_TEXT)
        self.band.write_bytes(b"adult\n")
        self.assertEqual(self.run_helper(), 0)
        self.assert_no_allowlist()

    def test_a_policy_problem_does_not_touch_an_adult(self):
        self.policy.unlink()
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()


class Allowlist(Case):
    """ma-adult.json: exactly when the band is adult, never beside the lock, and failing closed."""

    def test_adult_puts_it_in_place(self):
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.assertEqual(sorted(p.name for p in self.managed.iterdir()), ["ma-adult.json"])

    def test_adult_twice_is_the_same(self):
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.assert_not_locked()

    def test_adult_replaces_an_allowlist_changed_since(self):
        self.adult.write_bytes(b'{"ExtensionInstallAllowlist": ["*"]}')
        self.adult.chmod(0o666)
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()

    def test_teen_takes_it_away(self):
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.band.write_bytes(b"teen\n")
        self.assert_locked("band teen")
        self.assertEqual(sorted(p.name for p in self.managed.iterdir()), ["ma-teen.json"])

    def test_never_both_in_any_order(self):
        for band in (b"teen\n", b"adult\n", b"adult\n", b"garbage\n", b"adult\n", b"teen\n", b"teen\n"):
            with self.subTest(band=band):
                self.band.write_bytes(band)
                self.run_helper()
                names = sorted(p.name for p in self.managed.iterdir())
                self.assertEqual(names, ["ma-adult.json"] if band == b"adult\n" else ["ma-teen.json"])

    def test_teen_removes_a_symlink_not_its_target(self):
        victim = self.root / "victim"
        victim.write_bytes(b"keep")
        self.adult.symlink_to(victim)
        self.band.write_bytes(b"teen\n")
        self.assert_locked()
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_adult_replaces_a_symlink_not_its_target(self):
        victim = self.root / "victim"
        victim.write_bytes(b"keep")
        self.adult.symlink_to(victim)
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_a_temp_left_by_a_killed_run_goes(self):
        self.adult_temp.write_bytes(b"partial")
        self.band.write_bytes(b"teen\n")
        self.assert_locked()
        self.adult_temp.write_bytes(b"partial")
        self.band.write_bytes(b"adult\n")
        self.assert_not_locked()

    def test_an_allowlist_that_wont_go_stops_chromium(self):
        self.adult.mkdir()   # unlink() refuses a directory
        for band in (b"teen\n", b"", b"ADULT\n"):
            with self.subTest(band=band):
                self.band.write_bytes(band)
                self.assertEqual(self.run_helper(), 1, self.log)
                self.assertIn("ALLOWLIST NOT REMOVED, Chromium won't start", self.log)

    def test_no_band_at_all_takes_it_away(self):
        self.adult.write_bytes(ADULT_TEXT)
        with mock.patch.object(P, "BAND_DIR", str(self.root / "nothing/desk")):
            self.assert_locked("no band directory")


class AllowlistFailures(Case):
    """An adult whose allowlist can't go on gets no extensions but the blocker, and still a Browser."""

    def assert_no_extensions(self, text=None):
        self.band.write_bytes(b"adult\n")
        self.lock.write_bytes(POLICY_TEXT)
        self.adult.write_bytes(ADULT_TEXT)   # an old one: it must go too, not stay as it was
        rc = self.run_helper()
        self.assertEqual(rc, 0, self.log)
        self.assertFalse(os.path.lexists(self.lock))
        self.assert_no_allowlist()
        self.assertIn("not locked: band adult; sign-in extensions not allowed", self.log)
        self.assertEqual(self.log.count("\n"), 1)
        if text:
            self.assertIn(text, self.log)

    def test_no_policy_file(self):
        self.adult_policy.unlink()
        self.assert_no_extensions()

    def test_policy_is_a_symlink(self):
        other = self.root / "elsewhere.json"
        other.write_bytes(ADULT_TEXT)
        self.adult_policy.unlink()
        self.adult_policy.symlink_to(other)
        self.assert_no_extensions()

    def test_policy_writable_by_others(self):
        self.adult_policy.chmod(0o666)
        self.assert_no_extensions("only root can write")

    def test_policy_owned_by_someone_else(self):
        with mock.patch.object(P, "OWNER", (os.getuid() + 1, os.getgid())):
            self.band.write_bytes(b"adult\n")
            self.assertEqual(self.run_helper(), 0)
        self.assertIn("only root can write", self.log)
        self.assert_no_allowlist()

    def test_policy_is_not_json_or_empty(self):
        for data in (b"{ not json", b"", b"{}", b"[]"):
            with self.subTest(data=data):
                self.adult_policy.write_bytes(data)
                self.assert_no_extensions()

    def test_rename_fails(self):
        with mock.patch.object(P.os, "rename", side_effect=OSError(30, "Read-only file system")):
            self.assert_no_extensions("Read-only file system")

    def test_a_refusal_never_logs_the_policy(self):
        self.adult_policy.write_bytes(b"SECRET3 not json")
        self.assert_no_extensions()
        self.assertNotIn("SECRET3", self.log)


class Shipped(unittest.TestCase):
    DRAFT = {
        "DnsOverHttpsMode": "secure",
        "DnsOverHttpsTemplates": "https://family.cloudflare-dns.com/dns-query",
        "ForceGoogleSafeSearch": True,
        "ForceYouTubeRestrict": 1,
        "ProxyMode": "direct",
    }
    # Bitwarden, 1Password and Proton Pass: deskd's PasswordManagers (docs/sub-status/desk-sign-ins.md, asks 2), each id read
    # from its Chrome Web Store page on the img035 lab box.
    ADULT_DRAFT = {"ExtensionInstallAllowlist": ["nngceckbapebfimnlniiiahkandclblb", "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
                                                 "ghmbeldphafepmbegfdlkpapadhbakde"]}

    def test_the_policy_is_the_drafts(self):
        self.assertEqual(json.loads(SHIPPED.read_text()), self.DRAFT)

    def test_no_keys_shared_with_ma_json(self):
        self.assertEqual(sorted(set(json.loads(SHIPPED.read_text())) & set(json.loads(MA_JSON.read_text()))), [])

    def test_the_allowlist_is_the_drafts(self):
        self.assertEqual(json.loads(SHIPPED_ADULT.read_text()), self.ADULT_DRAFT)

    def test_no_key_in_two_of_the_four_managed_files(self):
        files = {f.name: set(json.loads(f.read_text())) for f in (MA_JSON, SHIPPED, SHIPPED_ADULT, ADBLOCK)}
        names = sorted(files)
        shared = [(a, b, sorted(files[a] & files[b])) for i, a in enumerate(names) for b in names[i + 1:] if files[a] & files[b]]
        self.assertEqual(shared, [])

    def test_every_desk_blocks_extensions_but_what_a_policy_allows(self):
        ma = json.loads(MA_JSON.read_text())
        self.assertEqual(ma["ExtensionInstallBlocklist"], ["*"])
        self.assertEqual(ma["ExtensionAllowedTypes"], ["extension"])
        self.assertIs(ma["BlockExternalExtensions"], True)
        self.assertNotIn("ExtensionInstallAllowlist", json.loads(SHIPPED.read_text()))
        self.assertNotIn("ExtensionInstallForcelist", ma)

    def test_links_out_launch_only_the_six_schemes(self):
        got = json.loads(MA_JSON.read_text())["AutoLaunchProtocolsFromOrigins"]
        self.assertEqual(got, [{"protocol": p, "allowed_origins": ["*"]} for p in ("tel", "sms", "zoommtg", "msteams", "facetime", "webcal")])

    def test_shipped_policy_installs(self):
        with mock.patch.object(P, "POLICY", str(SHIPPED)), mock.patch.object(P, "OWNER", (SHIPPED.stat().st_uid, SHIPPED.stat().st_gid)):
            if SHIPPED.stat().st_mode & 0o022:
                self.skipTest("this checkout's umask leaves the file group-writable; build.sh sets 0644")
            self.assertEqual(json.loads(P.read_policy(str(SHIPPED))), self.DRAFT)

    def test_helper_is_executable_and_isolated(self):
        self.assertTrue(HELPER.stat().st_mode & 0o100)
        self.assertEqual(HELPER.read_text().split("\n", 1)[0], "#!/usr/bin/python3 -I")

    def test_paths_are_the_real_ones(self):
        self.assertEqual(P.BAND_DIR, "/data/desk")
        self.assertEqual(P.BAND_FILE, "age-band")
        self.assertEqual(P.POLICY, "/etc/ma/chromium-teen.json")
        self.assertEqual(P.LOCK, "/etc/chromium/policies/managed/ma-teen.json")
        self.assertEqual(P.ADULT_POLICY, "/etc/ma/chromium-adult.json")
        self.assertEqual(P.ADULT, "/etc/chromium/policies/managed/ma-adult.json")
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
        self.assertFalse((MA_JSON.parent / "ma-adult.json").exists())

    def test_the_read_list_trace_leaves_no_lock(self):
        text = (RECIPE / "first-open/trace").read_text()
        self.assertTrue(re.search(r'(?m)^LOCK = "/etc/chromium/policies/managed/ma-teen\.json"$', text))
        self.assertTrue(re.search(r"for path in \(SOCK, LOCK\):\n\s+try:\n\s+os\.unlink\(path\)", text))


if __name__ == "__main__":
    unittest.main(verbosity=1)
