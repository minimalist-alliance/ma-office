#!/usr/bin/python3 -I
"""desk-kind against a fake IMDS on loopback, writing to a temporary directory. No root, no network.
python3 -I image/tests/test_desk_kind.py

Only an exact DeskKind=guild makes a Guild Desk (/run/ma/desk-kind says guild and /run/ma/guild exists). Everything else
is a member's desk with no flag, and a flag left from an earlier answer is taken away: no tag, metadata tags off, other
values, IMDS errors, IMDS silent, a token refused, a write that fails.
"""
import contextlib
import http.server
import importlib.machinery
import importlib.util
import io
import os
import pathlib
import sys
import tempfile
import threading
import unittest

sys.dont_write_bytecode = True
HELPER = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "usr" / "local" / "lib" / "ma" / "desk-kind"


def load():
    loader = importlib.machinery.SourceFileLoader("desk_kind", str(HELPER))
    spec = importlib.util.spec_from_loader("desk_kind", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class FakeIMDS(http.server.BaseHTTPRequestHandler):
    """IMDSv2 as far as desk-kind uses it. The test sets the class's state."""
    tags = {}            # None: instance metadata tags are off
    token_status = 200
    tag_status = None    # force a status for the DeskKind read
    public_ip = None     # None: no public IPv4 (404)
    calls = []
    TOKEN = b"tok-123"

    def log_message(self, *a):
        pass

    def reply(self, status, body=b""):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        FakeIMDS.calls.append(("PUT", self.path, self.headers.get("X-aws-ec2-metadata-token-ttl-seconds")))
        if self.path != "/latest/api/token" or not self.headers.get("X-aws-ec2-metadata-token-ttl-seconds"):
            return self.reply(400)
        self.reply(self.token_status, self.TOKEN if self.token_status == 200 else b"")

    def do_GET(self):
        FakeIMDS.calls.append(("GET", self.path, self.headers.get("X-aws-ec2-metadata-token")))
        if self.headers.get("X-aws-ec2-metadata-token") != self.TOKEN.decode():
            return self.reply(401)
        if self.path == "/latest/meta-data/public-ipv4":
            return self.reply(404) if self.public_ip is None else self.reply(200, self.public_ip)
        if self.tags is None:
            return self.reply(404)
        if self.path == "/latest/meta-data/tags/instance":
            return self.reply(200, "\n".join(self.tags).encode())
        prefix = "/latest/meta-data/tags/instance/"
        if self.path.startswith(prefix):
            if self.tag_status is not None:
                return self.reply(self.tag_status)
            key = self.path[len(prefix):]
            if key in self.tags:
                return self.reply(200, self.tags[key])
        self.reply(404)


class DeskKindTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeIMDS)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name) / "run-ma"
        self.dir.mkdir()
        FakeIMDS.tags, FakeIMDS.token_status, FakeIMDS.tag_status, FakeIMDS.calls, FakeIMDS.public_ip = {}, 200, None, [], None
        self.m = load()
        self.m.IMDS = "http://127.0.0.1:%d/latest" % self.server.server_port
        self.m.OUT_DIR = str(self.dir)
        self.m.DEADLINE_S = 1.0
        self.m.RETRY_S = 0.05
        self.m.RETRY_MAX_S = 0.2
        self.m.TIMEOUT_S = 0.5

    def tearDown(self):
        self.tmp.cleanup()

    def run_it(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = self.m.main()
        self.log = err.getvalue()
        return rc

    def kind(self):
        return (self.dir / "desk-kind").read_text()

    def flag(self):
        return (self.dir / "guild").exists()

    def assert_member(self, reason_part, prio="<6>"):
        self.assertEqual(self.run_it(), 0)
        self.assertEqual(self.kind(), "member\n")
        self.assertFalse(self.flag())
        self.assertIn(reason_part, self.log)
        self.assertTrue(self.log.startswith(prio), self.log)
        self.assertEqual(oct((self.dir / "desk-kind").stat().st_mode & 0o777), "0o644")

    # ---- the one way to a Guild Desk
    def test_exactly_guild_is_a_guild_desk(self):
        FakeIMDS.tags = {"DeskKind": b"guild", "DeskId": b"d-x"}
        self.assertEqual(self.run_it(), 0)
        self.assertEqual(self.kind(), "guild\n")
        self.assertTrue(self.flag())
        self.assertEqual((self.dir / "guild").read_text(), "DeskKind=guild\n")
        self.assertEqual(oct((self.dir / "guild").stat().st_mode & 0o777), "0o644")
        self.assertTrue(self.log.startswith("<5>desk-kind: guild (DeskKind=guild) in "), self.log)
        # IMDSv2: a token first, sent on the read
        self.assertEqual(FakeIMDS.calls[0][:2], ("PUT", "/latest/api/token"))
        self.assertEqual(FakeIMDS.calls[1], ("GET", "/latest/meta-data/tags/instance/DeskKind", "tok-123"))
        self.assertEqual(sorted(os.listdir(self.dir)), ["desk-kind", "guild"])  # no temporary file left
        self.assertNotIn("public-ipv4", " ".join(c[1] for c in FakeIMDS.calls))  # only the tag is read

    # ---- every other answer is a member's desk
    def test_member_kinds_and_near_misses_are_members(self):
        for v in (b"personal", b"work", b"test", b"custom", b"Guild", b"GUILD", b" guild", b"guild ", b"guild\n",
                  b"guilds", b"guild\x00", b"", b"\xff\xfe", "guıld".encode()):
            with self.subTest(v=v):
                FakeIMDS.tags = {"DeskKind": v}
                self.assert_member("not exactly 'guild'")

    def test_no_tag_is_a_member(self):
        FakeIMDS.tags = {"DeskId": b"d-x"}
        self.assert_member("no DeskKind tag")

    def test_metadata_tags_off_is_a_member(self):
        FakeIMDS.tags = None
        self.assert_member("instance metadata tags are off")

    def test_a_huge_value_is_a_member(self):
        FakeIMDS.tags = {"DeskKind": b"guild" * 1000}
        self.assert_member("not exactly 'guild'")

    def test_imds_errors_until_the_deadline_are_a_member_with_a_warning(self):
        FakeIMDS.tags = {"DeskKind": b"guild"}
        FakeIMDS.tag_status = 500
        self.assert_member("no usable answer", prio="<4>")
        self.assertGreater(len(FakeIMDS.calls), 4)  # it asked again

    def test_a_refused_token_is_a_member_with_a_warning(self):
        FakeIMDS.tags = {"DeskKind": b"guild"}
        FakeIMDS.token_status = 403
        self.assert_member("token: HTTP 403", prio="<4>")

    def test_no_imds_at_all_is_a_member_with_a_warning(self):
        self.m.IMDS = "http://127.0.0.1:9/latest"  # nothing listens on discard
        self.assert_member("no answer from IMDS", prio="<4>")

    def test_a_silent_imds_gives_up_at_its_deadline(self):
        import socket, time
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(1)  # accepts into the backlog, never answers
        try:
            self.m.IMDS = "http://127.0.0.1:%d/latest" % s.getsockname()[1]
            t = time.monotonic()
            self.assert_member("no answer from IMDS", prio="<4>")
            self.assertLess(time.monotonic() - t, self.m.DEADLINE_S + self.m.TIMEOUT_S * 3 + 1)
        finally:
            s.close()

    def test_a_late_answer_within_the_deadline_still_counts(self):
        FakeIMDS.tags = {"DeskKind": b"guild"}
        FakeIMDS.tag_status = 503
        real = self.m.SLEEP

        def heal(t):
            FakeIMDS.tag_status = None
            real(t)
        self.m.SLEEP = heal
        self.assertEqual(self.run_it(), 0)
        self.assertEqual(self.kind(), "guild\n")

    # ---- the flag never outlives a member's answer
    def test_a_member_answer_takes_an_old_flag_away(self):
        FakeIMDS.tags = {"DeskKind": b"guild"}
        self.run_it()
        self.assertTrue(self.flag())
        FakeIMDS.tags = {"DeskKind": b"personal"}
        self.assert_member("not exactly")

    def test_an_unexpected_error_is_a_member(self):
        (self.dir / "guild").write_text("old\n")

        def boom():
            raise RuntimeError("x")
        self.m.read_once = boom
        self.assert_member("error reading the tag: RuntimeError", prio="<4>")

    def test_a_write_that_fails_leaves_no_flag(self):
        FakeIMDS.tags = {"DeskKind": b"guild"}
        real = self.m.write_atomic

        def fail_on_flag(path, text):
            if path.endswith("/guild"):
                raise OSError(28, "No space left on device")
            real(path, text)
        self.m.write_atomic = fail_on_flag
        self.assertEqual(self.run_it(), 1)
        self.assertFalse(self.flag())
        self.assertEqual(self.kind(), "member\n")
        self.assertIn("so a member's desk", self.log)

    def test_it_backs_off_and_gives_up_within_its_deadline(self):
        FakeIMDS.tags = {"DeskKind": b"guild"}
        FakeIMDS.tag_status = 500
        slept, real = [], self.m.SLEEP
        self.m.SLEEP = lambda t: (slept.append(t), real(t))
        self.m.DEADLINE_S = 2.0
        import time
        t = time.monotonic()
        self.assert_member("no usable answer in 2.0 s", prio="<4>")
        self.assertLess(time.monotonic() - t, 2.0 + 0.5)
        self.assertEqual(slept[:4], [0.05, 0.1, 0.2, 0.2])  # doubling, then held at the cap

    def test_the_real_timing(self):
        m = load()
        self.assertEqual((m.DEADLINE_S, m.RETRY_S, m.RETRY_MAX_S, m.TIMEOUT_S), (30, 0.5, 4, 2))

    def test_the_real_paths(self):
        m = load()
        self.assertEqual(m.IMDS, "http://169.254.169.254/latest")
        self.assertEqual(m.paths(), ("/run/ma/desk-kind", "/run/ma/guild"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
