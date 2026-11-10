"""Unit tests for ma-selfhost's own logic (no network, no root): `python3 -m unittest discover -s selfhost/tests`."""
import contextlib
import importlib.machinery
import importlib.util
import io
import os
import tempfile
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


if __name__ == "__main__":
    unittest.main()
