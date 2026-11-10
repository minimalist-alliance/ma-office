#!/usr/bin/python3 -I
"""count-address.sh's verdict, on two counts (fixtures copied from real ones, with IDs made up) and on copies of one with a single thing broken. No AWS: --judge only
reads a file. python3 -I image/tests/test_count_address.py"""
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = IMAGE / "count-address.sh"
FIXTURES = IMAGE / "tests" / "fixtures"
CLEAN = FIXTURES / "count-clean.txt"   # 0.2.9: control 4, every count 0
DIRTY = FIXTURES / "count-dirty.txt"   # 0.2.2: 9, all in the builder's journal directory


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clean = CLEAN.read_text()

    def tearDown(self):
        self.tmp.cleanup()

    def judge(self, text=None, path=None):
        if path is None:
            path = pathlib.Path(self.tmp.name) / "count.txt"
            path.write_text(text)
        return subprocess.run(["bash", str(SCRIPT), "--judge", str(path)], capture_output=True, text=True, timeout=30)

    def broken(self, old, new):
        self.assertEqual(self.clean.count(old), 1, old)
        r = self.judge(self.clean.replace(old, new))
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertTrue(r.stdout.startswith("VERDICT: FAIL"), r.stdout)
        return r.stdout

    def test_a_clean_count_passes(self):
        r = self.judge(path=CLEAN)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout, "VERDICT: pass, control 4 and every count 0\n")

    def test_the_clean_count_passes_and_0_2_2_fails(self):
        for f in sorted(FIXTURES.glob("count-*.txt")):
            with self.subTest(f.name):
                self.assertEqual(self.judge(path=f).returncode, 1 if f == DIRTY else 0)
        out = self.judge(path=DIRTY).stdout
        self.assertIn("address count 9 in the files", out)
        self.assertIn("the raw partition, free blocks included: 9", out)

    def test_a_control_of_0_fails(self):
        self.assertIn("the control is '0'", self.broken("(must be above 0): 4", "(must be above 0): 0"))

    def test_no_control_fails(self):
        self.assertIn("the control is 'missing'", self.broken("control, the reader's own journal", "kontrol, the reader's own journal"))

    def test_any_count_above_0_fails(self):
        for line in ("  /etc: 0", "  /var/lib, without cloud-init: 0", "  the whole root filesystem: 0",
                     "  the raw partition, free blocks included: 0"):
            with self.subTest(line):
                self.assertIn(line[2:-1] + "1", self.broken(line + "\n", line[:-1] + "1\n"))

    def test_a_count_only_among_sshd_sources_fails(self):
        self.broken("this workstation's among them 0", "this workstation's among them 1")

    def test_a_count_only_in_journalctl_text_fails(self):
        self.broken("and 0 in journalctl's text", "and 2 in journalctl's text")

    def test_a_failed_grep_fails(self):
        self.assertIn("/root: ERROR", self.broken("  /root: 0\n", "  /root: ERROR\n"))

    def test_a_count_cut_off_before_its_end_fails(self):
        self.assertIn("didn't reach its last step", self.broken("  the raw partition, free blocks included: 0\n", ""))

    def test_a_bad_line_fails(self):
        self.assertIn("BAD: can't mount", self.broken("image: version=0.2.9", "BAD: can't mount the box's root\nimage: version=0.2.9"))

    def test_no_file_fails(self):
        r = self.judge(path=pathlib.Path(self.tmp.name) / "none.txt")
        self.assertEqual(r.returncode, 1)


class CountTest(unittest.TestCase):
    """The reader's n(), taken from the script's own text and run here on a temporary tree, with a made-up pattern."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        text = SCRIPT.read_text()
        start = text.index("\nn() {\n") + 1
        self.fn = text[start:text.index("\n}\n", start) + 3]
        self.pat = t / "pat"
        self.pat.write_text("198.51.100.7\n")   # TEST-NET-2, documentation only
        self.tree = t / "tree"
        (self.tree / "a").mkdir(parents=True)
        (self.tree / "a" / "f").write_text("x 198.51.100.7 y 198.51.100.7\n")
        (self.tree / "b").mkdir()
        (self.tree / "b" / "g").write_text("198.51.100.7\n")
        self.cwd = t / "cwd"
        self.cwd.mkdir()
        (self.cwd / "decoy").write_text("198.51.100.7\n")

    def tearDown(self):
        for p in self.tree.rglob("*"):
            p.chmod(0o755)
        self.tmp.cleanup()

    def n(self, *args):
        script = f'PAT={self.pat}\n{self.fn}\nn "$@"\n'
        r = subprocess.run(["bash", "-c", script, "n", *args], cwd=self.cwd, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_counts_every_occurrence(self):
        self.assertEqual(self.n(str(self.tree)), "3")
        self.assertEqual(self.n("--exclude-dir=b", str(self.tree)), "2")

    def test_a_path_that_isnt_there_is_left_out(self):
        self.assertEqual(self.n(str(self.tree / "a"), str(self.tree / "none")), "2")

    def test_no_path_left_is_0_and_never_the_current_directory(self):
        self.assertEqual(self.n(str(self.tree / "none")), "0")
        self.assertEqual(self.n("--exclude-dir=journal", str(self.tree / "none")), "0")

    @unittest.skipIf(__import__("os").geteuid() == 0, "root reads everything")
    def test_a_grep_that_fails_is_error_not_0(self):
        (self.tree / "b").chmod(0)
        self.assertEqual(self.n(str(self.tree)), "ERROR")


if __name__ == "__main__":
    unittest.main(verbosity=2)
