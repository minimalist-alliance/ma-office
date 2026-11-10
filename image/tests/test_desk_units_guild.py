#!/usr/bin/python3 -I
"""desk-units on a Guild Desk (image/README.md, "Guild Desk"), on test_desk_units.py's fakes. No root.
python3 -I image/tests/test_desk_units_guild.py

With desk-kind's flag there, every verb on every unit desk-units knows is refused with "err unsupported", and systemd is
never asked. Without it, desk-units does what it always did. The other refusals (uid, request, unit) come first either way.
"""
import importlib.util
import os
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("test_desk_units", HERE / "test_desk_units.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
B = base.DeskUnitsTest

UNITS = ["desk-xorg", "desk-audio", "desk-browser", "desk-stream", "desk-adblock"]


class GuildDeskUnitsTest(unittest.TestCase):
    # test_desk_units.py's fakes, without its tests
    setUp, tearDown = B.setUp, B.tearDown
    start_browser, write_dev, kernel, frozen, flag, ask, calls, systemctl_verbs = (
        B.start_browser, B.write_dev, B.kernel, B.frozen, B.flag, B.ask, B.calls, B.systemctl_verbs)

    def guild(self):
        d = pathlib.Path(self.tmp.name) / "run-ma"
        d.mkdir(exist_ok=True)
        (d / "guild").write_text("DeskKind=guild\n")
        self.m.GUILD_FLAG = str(d / "guild")

    def member(self):
        self.m.GUILD_FLAG = str(pathlib.Path(self.tmp.name) / "run-ma" / "guild")

    def test_every_browser_verb_is_refused_on_a_guild_desk_and_systemd_is_never_asked(self):
        self.guild()
        for verb in ("start", "stop"):
            for unit in UNITS:
                r = self.ask(f"{verb} {unit}\n")
                self.assertTrue(r.startswith("err unsupported guild "), (verb, unit, r))
                self.assertIn("refused", self.log_text)
        for verb in ("freeze", "thaw"):
            r = self.ask(f"{verb} desk-browser\n")
            self.assertTrue(r.startswith("err unsupported guild "), (verb, r))
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls("setpriv.log"), [])
        self.assertEqual(self.frozen(), "0")

    def test_the_other_refusals_come_first_on_a_guild_desk(self):
        self.guild()
        self.assertTrue(self.ask("restart desk-xorg\n").startswith("err bad_request"))
        self.assertTrue(self.ask("start desk-rtc\n").startswith("err denied"))
        self.assertTrue(self.ask("freeze desk-xorg\n").startswith("err denied"))
        self.m.DESKD_UID = os.getuid() + 1
        self.assertTrue(self.ask("start desk-browser\n").startswith("err denied"))
        self.assertEqual(self.calls(), [])

    def test_a_members_desk_is_unchanged(self):
        self.member()
        self.assertFalse(os.path.exists(self.m.GUILD_FLAG))
        self.assertEqual(self.ask("stop desk-browser\n"), "ok")
        self.assertEqual(self.ask("start desk-browser\n"), "ok")
        self.assertEqual(self.ask("start desk-stream\n"), "ok")
        self.assertIn("start desk-browser.service", self.calls())
        self.assertIn("start desk-stream.service", self.calls())

    def test_a_dangling_link_is_no_guild_desk_as_for_systemd(self):
        d = pathlib.Path(self.tmp.name) / "run-ma"
        d.mkdir()
        (d / "guild").symlink_to(d / "nothing")
        self.m.GUILD_FLAG = str(d / "guild")
        self.assertEqual(self.ask("start desk-xorg\n"), "ok")

    def test_the_flag_is_read_at_each_request(self):
        self.member()
        self.assertEqual(self.ask("start desk-xorg\n"), "ok")
        self.guild()
        self.assertTrue(self.ask("start desk-xorg\n").startswith("err unsupported"))
        os.unlink(self.m.GUILD_FLAG)
        self.assertEqual(self.ask("start desk-xorg\n"), "ok")

    def test_the_real_path_is_desk_kinds(self):
        self.assertEqual(base.load().GUILD_FLAG, "/run/ma/guild")


del B  # so unittest doesn't run test_desk_units.py's own tests here as well


if __name__ == "__main__":
    unittest.main(verbosity=1)
