"""Unit tests for ma-selfhost's own logic (no network, no root): `python3 -m unittest discover -s selfhost/tests`."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

PATH = os.path.join(os.path.dirname(__file__), "..", "files", "usr", "local", "lib", "ma", "selfhost", "ma-selfhost")


def load(state):
    os.environ["MA_SELFHOST_STATE"] = state
    os.environ["MA_SELFHOST_RUN"] = os.path.join(state, "run")
    loader = importlib.machinery.SourceFileLoader("ma_selfhost", PATH)
    spec = importlib.util.spec_from_loader("ma_selfhost", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


CONF = {"env": "staging", "api": "https://api.example.test", "address": "auto"}


class ConfirmAtTheDesk(unittest.TestCase):
    """EXP-8: pairing waits for someone at the computer to say the office shown is theirs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.m = load(self.tmp.name)
        os.makedirs(self.tmp.name, exist_ok=True)
        self.answer = {"deskId": "d-1", "userId": "u-1", "env": "staging", "deskName": "Home", "accountName": "Test Member",
                       "accountEmail": "member@example.org"}

    def tearDown(self):
        self.tmp.cleanup()

    def pair_fresh(self, **over):
        return self.m.record_paired(CONF, dict(self.answer, **over))

    def test_masks_name_and_address_partly(self):
        self.assertEqual(self.m.mask_account("Test Member", "member@example.org"), "T*** M***, m***@e***.org")
        self.assertEqual(self.m.mask_account(None, None), None)
        self.assertNotIn("Member", self.m.mask_account("Test Member", None))

    def test_the_platforms_own_hint_wins_and_a_fresh_pairing_waits(self):
        d = self.pair_fresh(accountHint="T*** M***")
        self.assertTrue(d["pendingConfirm"])
        self.assertEqual(d["accountHint"], "T*** M***")

    def test_an_older_platform_with_nothing_to_show_does_not_wait(self):
        d = self.pair_fresh(accountName=None, accountEmail=None)
        self.assertNotIn("pendingConfirm", d)

    def test_an_already_paired_desk_is_never_held_again(self):
        self.m.write_json(os.path.join(self.tmp.name, "desk.json"), {"deskId": "d-1", "userId": "u-1", "env": "staging"})
        self.assertNotIn("pendingConfirm", self.pair_fresh())

    def test_yes_confirms_without_asking_and_never_prints_the_full_name(self):
        self.pair_fresh()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertTrue(self.m.confirm_pairing(CONF, True))
        self.assertNotIn("pendingConfirm", self.m.read_desk())
        self.assertIn("T*** M***", out.getvalue())
        self.assertNotIn("Member", out.getvalue())
        self.assertNotIn("example.org", out.getvalue())

    def test_n_and_enter_decline_and_forget(self):
        for typed in ("n", ""):
            self.pair_fresh() if self.m.read_desk() is None else None
            with mock.patch("sys.stdin.isatty", return_value=True), mock.patch("builtins.input", return_value=typed), \
                    mock.patch.object(self.m, "load_key", return_value=None), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(self.m.confirm_pairing(CONF, False))
            self.assertIsNone(self.m.read_desk())

    def test_y_confirms(self):
        self.pair_fresh()
        with mock.patch("sys.stdin.isatty", return_value=True), mock.patch("builtins.input", return_value="Y"), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(self.m.confirm_pairing(CONF, False))
        self.assertNotIn("pendingConfirm", self.m.read_desk())

    def test_nobody_to_ask_leaves_it_waiting(self):
        self.pair_fresh()
        err = io.StringIO()
        with mock.patch("sys.stdin.isatty", return_value=False), contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(self.m.confirm_pairing(CONF, False))
        self.assertTrue(self.m.read_desk()["pendingConfirm"])
        self.assertIn("--yes", err.getvalue())

    def test_declining_asks_the_platform_to_take_the_desk_out(self):
        self.pair_fresh()
        k = self.m.Ed25519PrivateKey.generate()
        sent = []
        with mock.patch.object(self.m, "load_key", return_value=k), \
                mock.patch.object(self.m, "post", side_effect=lambda c, path, body: sent.append((path, body["sig"] != "")) or (200, {})), \
                contextlib.redirect_stdout(io.StringIO()):
            self.m.decline(CONF)
        self.assertEqual(sent, [("/v1/self-hosted/decline", True)])


UNIT = os.path.join(os.path.dirname(__file__), "..", "files", "etc", "systemd", "system", "ma-selfhost.service")


class ThePairingCodeStaysPrivate(unittest.TestCase):
    """EXP-8: status.json holds the live code, so only this user and root may read it, from its first byte."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.m = load(self.tmp.name)
        self.run_dir = os.path.join(self.tmp.name, "run")
        os.makedirs(self.run_dir)
        self.status = os.path.join(self.run_dir, "status.json")
        self.st = self.m.State()
        self.st.status, self.st.code, self.st.claim_url = "pending", "ABCD-EFGH", "https://platform.example.test/self-hosted"
        self.umask = os.umask(0)  # the loosest umask: the mode must not depend on it

    def tearDown(self):
        os.umask(self.umask)
        self.tmp.cleanup()

    def mode(self, p):
        return os.stat(p).st_mode & 0o777

    def test_status_json_is_0640(self):
        self.m.write_status(self.st)
        self.assertEqual(self.mode(self.status), 0o640)
        with open(self.status) as f:
            self.assertEqual(json.load(f)["code"], "ABCD-EFGH")

    def test_an_older_world_readable_file_is_replaced_and_a_leftover_never_reused(self):
        for p in (self.status, self.status + ".new"):
            with open(p, "w") as f:
                f.write("{}")
            os.chmod(p, 0o644)
        self.m.write_status(self.st)
        self.assertEqual(self.mode(self.status), 0o640)

    def test_never_wider_than_0640_while_it_is_written(self):
        seen = []
        real = json.dump

        def spy(obj, f, *a, **k):
            seen.append(os.fstat(f.fileno()).st_mode & 0o777)
            return real(obj, f, *a, **k)
        with mock.patch.object(self.m.json, "dump", side_effect=spy):
            self.m.write_status(self.st)
        self.assertEqual(seen, [0o640])
        self.assertEqual([n for n in os.listdir(self.run_dir) if n != "status.json"], [])

    def test_a_link_at_the_old_temp_name_is_never_followed(self):
        victim = os.path.join(self.tmp.name, "victim")
        with open(victim, "w") as f:
            f.write("untouched")
        os.symlink(victim, self.status + ".new")
        self.m.write_status(self.st)
        with open(victim) as f:
            self.assertEqual(f.read(), "untouched")

    def test_a_failed_write_leaves_no_temp_file(self):
        with mock.patch.object(self.m.json, "dump", side_effect=ValueError("no")):
            with self.assertRaises(ValueError):
                self.m.write_json(self.status, {})
        self.assertEqual(os.listdir(self.run_dir), [])

    def test_its_readers_as_this_user_still_read_it(self):
        self.m.write_status(self.st)
        self.assertEqual(self.m.service_status()["code"], "ABCD-EFGH")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.m.cmd_status(CONF)
        self.assertIn("ABCD-EFGH", out.getvalue())

    def test_the_service_closes_its_run_directory_to_other_users(self):
        with open(UNIT) as f:
            lines = [ln.strip() for ln in f if not ln.lstrip().startswith("#")]
        self.assertIn("RuntimeDirectory=ma-selfhost", lines)
        self.assertIn("RuntimeDirectoryMode=0750", lines)
        self.assertIn("User=selfhost", lines)
        self.assertIn("Group=selfhost", lines)


class BrowserSignInsGoWithTheDesk(unittest.TestCase):
    """EXP-8: `pair` and `forget` say plainly that whoever's office the desk joins gets the Browser's sign-ins, and ask."""

    CODE = {"status": "pending", "code": "ABCD-EFGH", "claimUrl": "https://platform.example.test/self-hosted"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.m = load(self.tmp.name)
        self.key = os.path.join(self.tmp.name, "key.pem")
        self.desk = os.path.join(self.tmp.name, "desk.json")

    def tearDown(self):
        os.environ.pop("MA_SELFHOST_BROWSER", None)
        self.tmp.cleanup()

    def browser(self, v):
        os.environ["MA_SELFHOST_BROWSER"] = v

    def pair(self, tty, typed=None, yes=False, wait=False):
        """cmd_pair with the service already showing a code, and the platform never called. (rc, stdout, stderr, asked)"""
        out, err = io.StringIO(), io.StringIO()
        asked = []

        def answer(prompt):
            asked.append(prompt)
            if typed is None:
                raise AssertionError("asked a question with --yes")
            return typed
        with mock.patch("sys.stdin.isatty", return_value=tty), mock.patch("builtins.input", side_effect=answer), \
                mock.patch.object(self.m, "service_status", return_value=dict(self.CODE)), \
                mock.patch.object(self.m, "post", side_effect=AssertionError("called the platform")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = self.m.cmd_pair(CONF, wait, yes)
        return rc, out.getvalue(), err.getvalue(), asked

    def forget(self, tty, typed=None, args=()):
        for p in (self.key, self.desk):
            with open(p, "w") as f:
                f.write("{}")
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdin.isatty", return_value=tty), mock.patch("builtins.input", return_value=typed), \
                mock.patch.object(self.m, "load_conf", return_value=CONF), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = self.m.main(["forget", *args])
        kept = os.path.exists(self.key) and os.path.exists(self.desk)
        return rc, kept, out.getvalue(), err.getvalue()

    def test_only_none_from_the_wrapper_means_no_profile(self):
        os.environ.pop("MA_SELFHOST_BROWSER", None)
        self.assertTrue(self.m.browser_profile())
        self.browser("profile")
        self.assertTrue(self.m.browser_profile())
        self.browser("none")
        self.assertFalse(self.m.browser_profile())

    def test_pair_with_a_profile_and_no_terminal_refuses_and_shows_no_code(self):
        self.browser("profile")
        rc, out, err, asked = self.pair(tty=False, typed="y")
        self.assertEqual(rc, 1)
        self.assertNotIn("ABCD-EFGH", out)
        self.assertIn("signed in", out)
        self.assertIn("--yes", err)
        self.assertEqual(asked, [])

    def test_pair_with_a_profile_asks_and_enter_is_no(self):
        self.browser("profile")
        for typed in ("", "n", "no thanks"):
            rc, out, _, asked = self.pair(tty=True, typed=typed)
            self.assertEqual(rc, 1)
            self.assertNotIn("ABCD-EFGH", out)
            self.assertIn("Not paired.", out)
            self.assertEqual(len(asked), 1)
            self.assertIn("[y/N]", asked[0])

    def test_pair_with_a_profile_and_y_shows_the_code(self):
        self.browser("profile")
        rc, out, _, asked = self.pair(tty=True, typed="y")
        self.assertEqual(rc, 0)
        self.assertIn("Whoever's office this desk joins gets that Browser, signed in.", out)
        self.assertLess(out.index("signed in."), out.index("ABCD-EFGH"))
        self.assertEqual(len(asked), 1)

    def test_pair_yes_says_it_then_goes_on_with_no_terminal(self):
        self.browser("profile")
        rc, out, _, asked = self.pair(tty=False, yes=True)
        self.assertEqual(rc, 0)
        self.assertIn("signed in.", out)
        self.assertIn("ABCD-EFGH", out)
        self.assertEqual(asked, [])

    def test_pair_without_a_profile_asks_nothing(self):
        self.browser("none")
        rc, out, _, asked = self.pair(tty=False)
        self.assertEqual(rc, 0)
        self.assertIn("ABCD-EFGH", out)
        self.assertNotIn("Browser", out)
        self.assertEqual(asked, [])

    def test_an_already_paired_desk_is_not_asked(self):
        self.browser("profile")
        self.m.write_json(self.desk, {"deskId": "d-1", "userId": "u-1", "env": "staging", "deskName": "Home"})
        rc, out, _, asked = self.pair(tty=False)
        self.assertEqual(rc, 0)
        self.assertIn("already the desk", out)
        self.assertNotIn("Browser", out)
        self.assertEqual(asked, [])

    def test_confirming_says_what_that_office_gets(self):
        answer = {"deskId": "d-1", "userId": "u-1", "env": "staging", "accountHint": "T*** M***"}
        for b, says in (("profile", True), ("none", False)):
            self.browser(b)
            self.m.record_paired(CONF, answer)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertTrue(self.m.confirm_pairing(CONF, True))
            self.assertEqual("Whoever's office this desk joins gets that Browser, signed in." in out.getvalue(), says)
            self.assertIn("T*** M***", out.getvalue())
            os.remove(self.desk)

    def test_the_e2e_and_install_yes_still_confirm_with_no_terminal(self):
        self.browser("profile")
        self.m.record_paired(CONF, {"deskId": "d-1", "userId": "u-1", "env": "staging", "accountHint": "T*** M***"})
        rc, out, _, asked = self.pair(tty=False, yes=True)
        self.assertEqual(rc, 0)
        self.assertNotIn("pendingConfirm", self.m.read_desk())
        self.assertEqual(asked, [])

    def test_declining_a_pairing_forgets_without_a_second_question(self):
        self.browser("profile")
        self.m.record_paired(CONF, {"deskId": "d-1", "userId": "u-1", "env": "staging", "accountHint": "T*** M***"})
        with mock.patch("sys.stdin.isatty", return_value=True), mock.patch("builtins.input", return_value="n") as inp, \
                mock.patch.object(self.m, "load_key", return_value=None), contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(self.m.confirm_pairing(CONF, False))
        self.assertEqual(inp.call_count, 1)
        self.assertIsNone(self.m.read_desk())

    def test_forget_with_a_profile_and_no_terminal_keeps_everything(self):
        self.browser("profile")
        rc, kept, out, err = self.forget(tty=False)
        self.assertEqual((rc, kept), (1, True))
        self.assertIn("next office", out)
        self.assertIn("--yes", err)

    def test_forget_with_a_profile_asks_and_no_keeps_everything(self):
        self.browser("profile")
        for typed in ("", "n"):
            rc, kept, out, _ = self.forget(tty=True, typed=typed)
            self.assertEqual((rc, kept), (1, True))
            self.assertIn("Kept this desk's key and pairing.", out)

    def test_forget_with_a_profile_and_y_or_yes_forgets(self):
        self.browser("profile")
        rc, kept, out, _ = self.forget(tty=True, typed="y")
        self.assertEqual((rc, kept), (0, False))
        rc, kept, out, _ = self.forget(tty=False, args=("--yes",))
        self.assertEqual((rc, kept), (0, False))
        self.assertIn("next office", out)

    def test_forget_without_a_profile_needs_no_terminal(self):
        self.browser("none")
        rc, kept, out, _ = self.forget(tty=False)
        self.assertEqual((rc, kept), (0, False))
        self.assertNotIn("Browser", out)


class NobodyTracesThePairingClient(unittest.TestCase):
    """Security's ptrace note (Nov 11): `sudo ma-selfhost pair --wait` runs the client as selfhost on the admin's terminal.
    No other process of that user may trace it, or read its memory or open files through /proc: the client makes itself
    non-dumpable before it reads anything, and every unit that runs as selfhost refuses @debug (ptrace and the like)."""

    UNIT_DIRS = (os.path.join(os.path.dirname(__file__), "..", "files", "etc", "systemd", "system"),
                 os.path.join(os.path.dirname(__file__), "..", "..", "image", "recipe", "files", "etc", "systemd", "system"))

    @staticmethod
    def settings(path):
        with open(path) as f:
            return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]

    def test_every_unit_that_runs_as_selfhost_refuses_tracing(self):
        found = []
        for d in self.UNIT_DIRS:
            for name in sorted(os.listdir(d)):
                p = os.path.join(d, name)
                if not os.path.isfile(p):
                    continue
                lines = self.settings(p)
                if "User=selfhost" not in lines and "User=1110" not in lines:
                    continue
                found.append(name)
                filters = [ln.split("=", 1)[1] for ln in lines if ln.startswith("SystemCallFilter=")]
                self.assertTrue(any(f.startswith("~") and "@debug" in f[1:].split() for f in filters),
                                f"{name} doesn't refuse @debug: {filters}")
                self.assertIn("SystemCallArchitectures=native", lines, name)
        # The one long-running process of this user today. A new one must refuse @debug too (above).
        self.assertIn("ma-selfhost.service", found)

    def test_it_is_made_non_dumpable_before_anything_is_read(self):
        with open(PATH) as f:
            src = f.read()
        self.assertLess(src.index(".prctl(PR_SET_DUMPABLE, 0"), src.index("from cryptography"))
        self.assertLess(src.index(".prctl(PR_SET_DUMPABLE, 0"), src.index("def main("))

    @unittest.skipIf(os.getuid() == 0, "as root every process's /proc files are root's anyway")
    def test_a_waiting_pair_client_is_not_dumpable(self):
        """The client as `pair --wait` runs it, waiting on the service: the kernel gives a non-dumpable process's /proc files
        to root, so another process of its user can't open them, nor ptrace it."""
        with tempfile.TemporaryDirectory() as t:
            run = os.path.join(t, "run")
            os.makedirs(run)
            with open(os.path.join(run, "status.json"), "w") as f:
                json.dump({"status": "starting"}, f)  # a running service with no code yet: pair waits on it, offline
            env = dict(os.environ, MA_SELFHOST_STATE=os.path.join(t, "state"), MA_SELFHOST_RUN=run,
                       MA_SELFHOST_CONF=os.path.join(t, "none.conf"), MA_SELFHOST_BROWSER="none")
            p = subprocess.Popen([sys.executable, "-I", PATH, "pair", "--wait"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                owner, deadline = None, time.monotonic() + 10
                while time.monotonic() < deadline and p.poll() is None:
                    owner = os.stat(f"/proc/{p.pid}/fd").st_uid
                    if owner == 0:
                        break
                    time.sleep(0.05)
                self.assertIsNone(p.poll(), "the client stopped instead of waiting")
                self.assertEqual(owner, 0, "the waiting client's /proc files are still its own user's: it's dumpable")
            finally:
                p.kill()
                p.wait()
                p.stderr.close()


if __name__ == "__main__":
    unittest.main()
