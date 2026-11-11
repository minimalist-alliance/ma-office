#!/usr/bin/python3 -I
"""The image's side of links out (runtime spec section 8.11) and JPEG XL off, on this checkout: no root, no Chromium.
python3 -I image/tests/test_links_out.py"""
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
FILES = IMAGE / "recipe/files"
TOOLS = IMAGE.parent / "services/deskd/desk-tools"
STAND_IN = FILES / "usr/local/bin/xdg-open"


class Recipe(unittest.TestCase):
    def test_the_stand_in_is_deskds(self):
        self.assertEqual(STAND_IN.read_bytes(), (TOOLS / "xdg-open").read_bytes(), "bake.sh would copy deskd's over it: commit the copy")
        self.assertTrue(STAND_IN.stat().st_mode & 0o111)

    def test_xdg_email_is_the_same_program_made_by_build_sh(self):
        self.assertIn("ln -sfn xdg-open /usr/local/bin/xdg-email", (IMAGE / "recipe/build.sh").read_text())
        self.assertIn("ln -sfn xdg-open /usr/local/bin/xdg-email", (IMAGE.parent / "selfhost/install.sh").read_text())

    def test_the_recipe_holds_no_link(self):
        # selfhost/build-bundle.sh refuses an installer with a link in image/recipe (installer.sha256 can't name one)
        links = [str(p) for p in (IMAGE / "recipe").rglob("*") if p.is_symlink()]
        self.assertEqual(links, [])

    def test_the_socket_directory_line_is_deskds(self):
        self.assertEqual((FILES / "etc/tmpfiles.d/desk-links.conf").read_bytes(), (TOOLS / "desk-links.tmpfiles").read_bytes())
        lines = [l for l in (FILES / "etc/tmpfiles.d/desk-links.conf").read_text().splitlines() if l and not l.startswith("#")]
        self.assertEqual(lines, ["d /run/desk-links 2750 desk kiosk -"])

    def test_build_sh_diverts_xdg_utils_two_and_checks_it(self):
        build = (IMAGE / "recipe/build.sh").read_text()
        self.assertIn("for f in xdg-open xdg-email; do dpkg-divert --local --rename --divert /usr/share/ma/xdg-utils/$f --add /usr/bin/$f; done", build)
        self.assertIn("chk test ! -e /usr/bin/xdg-open", build)
        self.assertIn("chk test ! -e /usr/bin/xdg-email", build)
        self.assertNotRegex(build, r"apt-get install[^\n]*\bxdg-utils\b")

    def test_bake_sh_copies_deskds_files_in(self):
        bake = (IMAGE / "bake.sh").read_text()
        self.assertIn("xdg-open:usr/local/bin/xdg-open desk-links.tmpfiles:etc/tmpfiles.d/desk-links.conf", bake)

    def test_jpeg_xl_is_off_in_the_one_disable_features(self):
        start = (FILES / "usr/local/lib/ma/desk-browser-start").read_text()
        switches = re.findall(r"--disable-features=(\S+)", start)
        self.assertEqual(len(switches), 1, "Chromium reads only the last --disable-features")
        self.assertIn("JXLImageFormat", switches[0].split(","))


class StandIn(unittest.TestCase):
    """The program Chromium runs, as the image ships it, against a stand-in for deskd's socket (MA_LINKS_SOCKET)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sock = os.path.join(self.tmp.name, "links.sock")
        self.got = []

    def serve(self, reply):
        srv = socket.socket(socket.AF_UNIX)
        srv.bind(self.sock)
        srv.listen(1)
        self.addCleanup(srv.close)

        def one():
            c, _ = srv.accept()
            with c:
                self.got.append(c.makefile("rb").readline(1 << 16))
                c.sendall(reply)
        t = threading.Thread(target=one, daemon=True)
        t.start()
        return t

    def run_it(self, *args, name="xdg-open"):
        # As xdg-email, the same program by the link build.sh makes (it doesn't look at its name).
        link = os.path.join(self.tmp.name, name)
        os.symlink(STAND_IN, link) if not os.path.lexists(link) else None
        return subprocess.run([link, *args], env={"MA_LINKS_SOCKET": self.sock, "PATH": "/usr/bin:/bin"},
                              capture_output=True, timeout=10)

    def test_a_link_is_handed_on(self):
        t = self.serve(b"ok\n")
        r = self.run_it("tel:+15550100")
        t.join(5)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.got, [b"open tel:+15550100\n"])
        self.assertNotIn(b"5550100", r.stderr + r.stdout)

    def test_xdg_email_hands_on_mailto(self):
        t = self.serve(b"ok\n")
        r = self.run_it("mailto:a@example.invalid?subject=hi", name="xdg-email")
        t.join(5)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.got, [b"open mailto:a@example.invalid?subject=hi\n"])

    def test_dropped_is_exit_4(self):
        t = self.serve(b"dropped scheme\n")
        r = self.run_it("ssh://example.invalid")
        t.join(5)
        self.assertEqual(r.returncode, 4)

    def test_no_deskd_is_exit_3(self):
        self.assertEqual(self.run_it("tel:+15550100").returncode, 3)

    def test_not_one_url_is_exit_1(self):
        for args in ((), ("a", "b"), ("--help",), ("tel:1\nopen evil:",)):
            with self.subTest(args=args):
                self.assertEqual(self.run_it(*args).returncode, 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
