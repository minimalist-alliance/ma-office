#!/usr/bin/python3 -I
"""desk-adblock and build-blocker.py on temporary directories. No root, no /etc, no /data, no Chromium, no network.
python3 -I image/tests/test_desk_adblock.py"""
import hashlib
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
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr
from unittest import mock

sys.dont_write_bytecode = True
RECIPE = pathlib.Path(__file__).resolve().parent.parent / "recipe"
FILES = RECIPE / "files"
HELPER = FILES / "usr/local/lib/ma/desk-adblock"
BUILDER = RECIPE / "adblock/build-blocker.py"
WORKER = RECIPE / "adblock/worker.js"
TEMPLATE = FILES / "etc/ma/chromium-adblock.json"
MA_JSON = FILES / "etc/chromium/policies/managed/ma.json"
TEEN = FILES / "etc/ma/chromium-teen.json"
BROWSER_UNIT = FILES / "etc/systemd/system/desk-browser.service"
UNIT = FILES / "etc/systemd/system/desk-adblock.service"
UNITS_HELPER = FILES / "usr/local/lib/ma/desk-units"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(mod)
    return mod


A = load("desk_adblock", HELPER)
B = load("build_blocker", BUILDER)
ID = "abcdefghijklmnopabcdefghijklmnop"   # what build.sh writes in place of __BLOCKER_ID__


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.data = self.root / "data"
        self.list_dir = self.data / "desk"
        self.list_dir.mkdir(parents=True)
        self.list = self.list_dir / "adblock-off"
        self.kill = self.data / ".ma-adblock-off"
        self.profile = self.root / "Extensions"
        self.profile.mkdir()
        self.managed = self.root / "managed"
        self.managed.mkdir()
        self.policy = self.managed / "ma-adblock.json"
        self.temp = self.managed / ".ma-adblock.json.tmp"
        self.template = self.root / "chromium-adblock.json"
        self.template.write_bytes(TEMPLATE.read_bytes().replace(b"__BLOCKER_ID__", ID.encode()))
        self.template.chmod(0o644)
        # A closed port: no Chromium here.
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        closed = s.getsockname()[1]
        s.close()
        for name, value in (("LIST_DIR", str(self.list_dir)), ("KILL_DIR", str(self.data)), ("POLICY", str(self.policy)),
                            ("TEMPLATE", str(self.template)), ("PROFILE_EXTENSIONS", str(self.profile)),
                            ("OWNER", (os.getuid(), os.getgid())), ("POLICY_GID", os.getgid()), ("KILL_OWNER", os.getuid()),
                            ("CDP", f"http://127.0.0.1:{closed}")):
            patcher = mock.patch.object(A, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        signal.signal(signal.SIGALRM, self.hung)
        signal.alarm(20)
        self.addCleanup(signal.alarm, 0)

    @staticmethod
    def hung(*_):
        raise AssertionError("the helper hung")

    def run_main(self, *args):
        err = io.StringIO()
        with redirect_stderr(err):
            rc = A.main(["desk-adblock", *args])
        self.log = err.getvalue()
        return rc

    def written(self):
        self.assertTrue(self.policy.is_file() and not self.policy.is_symlink())
        self.assertEqual(stat.S_IMODE(self.policy.stat().st_mode), 0o640, "root:kiosk 0640: Chromium's group alone reads it")
        self.assertEqual((self.policy.stat().st_uid, self.policy.stat().st_gid), (os.getuid(), os.getgid()))
        self.assertFalse(os.path.lexists(self.temp))
        return json.loads(self.policy.read_bytes())

    def off(self):
        return self.written()["3rdparty"]["extensions"][ID]["noFiltering"]

    def killed(self):
        return self.written()["3rdparty"]["extensions"][ID]["off"]


class ParseSites(Case):
    def test_good_lines_in_order_without_repeats(self):
        self.assertEqual(A.parse_sites(b"cnn.com\nwww.allrecipes.com\ncnn.com\nxn--bcher-kva.example\na.ma-verify.localhost\n"),
                         (["cnn.com", "www.allrecipes.com", "xn--bcher-kva.example", "a.ma-verify.localhost"], 0))

    def test_empty(self):
        self.assertEqual(A.parse_sites(b""), ([], 0))
        self.assertEqual(A.parse_sites(b"\n\n"), ([], 0))

    def test_each_bad_line_is_dropped_alone(self):
        bad = [b"CNN.com", b"cnn.com.", b"cnn.com:443", b"https://cnn.com", b"cnn.com/news", b"*.cnn.com", b"cnn", b"10.0.0.1",
               b"localhost", b"-cnn.com", b"cnn-.com", b"cnn..com", b" cnn.com", b"cnn.com ", b"cnn.com\r",
               b"b\xc3\xbccher.example", b"a" * 64 + b".com", (b"a" * 62 + b".") * 4 + b"com", b"#cnn.com", b"cnn_com.com"]
        for line in bad:
            with self.subTest(line=line):
                self.assertEqual(A.parse_sites(b"ok.example\n" + line + b"\n"), (["ok.example"], 1))

    def test_a_label_of_63_and_a_name_of_253_are_fine(self):
        name = ".".join(["a" * 63] * 3 + ["b" * 61])
        self.assertEqual(len(name), 253)
        self.assertEqual(A.parse_sites(name.encode() + b"\n"), ([name], 0))

    def test_no_final_newline_drops_the_last_line(self):
        self.assertEqual(A.parse_sites(b"cnn.com\nfoxnews.com"), (["cnn.com"], 1))

    def test_the_cap(self):
        data = b"".join(b"s%d.example\n" % i for i in range(A.MAX_SITES + 5))
        sites, dropped = A.parse_sites(data)
        self.assertEqual(len(sites), A.MAX_SITES)
        self.assertEqual(sites[-1], "s%d.example" % (A.MAX_SITES - 1))
        self.assertEqual(dropped, 5)


class ReadList(Case):
    def test_missing_is_an_empty_list(self):
        self.assertEqual(A.read_list(), (b"", "no list"))

    def test_regular_file(self):
        self.list.write_bytes(b"cnn.com\n")
        self.assertEqual(A.read_list()[0], b"cnn.com\n")

    def test_refused(self):
        target = self.root / "elsewhere"
        target.write_bytes(b"cnn.com\n")
        cases = {
            "symlink": lambda: self.list.symlink_to(target),
            "fifo": lambda: os.mkfifo(self.list),
            "directory": lambda: self.list.mkdir(),
            "too large": lambda: self.list.write_bytes(b"cnn.com\n" * (A.MAX_LIST // 8 + 1)),
        }
        for what, make in cases.items():
            with self.subTest(what=what):
                make()
                data, why = A.read_list()
                self.assertIsNone(data, why)
                if self.list.is_dir() and not self.list.is_symlink():
                    self.list.rmdir()
                else:
                    self.list.unlink()

    def test_list_directory_a_symlink_or_missing(self):
        real = self.root / "real"
        real.mkdir()
        (real / "adblock-off").write_bytes(b"cnn.com\n")
        self.list_dir.rmdir()
        self.list_dir.symlink_to(real)
        self.assertIsNone(A.read_list()[0])
        self.list_dir.unlink()
        self.assertIsNone(A.read_list()[0])


class Render(Case):
    def test_policy_is_the_template_with_the_list(self):
        self.list.write_bytes(b"cnn.com\nfoxnews.com\n")
        self.assertEqual(self.run_main("render"), 0, self.log)
        got = self.written()
        want = json.loads(self.template.read_bytes())
        want["3rdparty"]["extensions"][ID].update(noFiltering=["cnn.com", "foxnews.com"], off=False)
        self.assertEqual(got, want)
        self.assertIn("blocking off on 2 site(s)", self.log)

    def test_no_list_blocks_everywhere(self):
        self.assertEqual(self.run_main("render"), 0, self.log)
        self.assertEqual(self.off(), [])
        self.assertIs(self.killed(), False)

    def test_an_emptied_list_drops_every_site(self):
        self.list.write_bytes(b"cnn.com\n")
        self.run_main("render")
        self.list.write_bytes(b"")   # deskd's clear of history
        self.assertEqual(self.run_main("render"), 0, self.log)
        self.assertEqual(self.off(), [])

    def test_an_unreadable_list_blocks_everywhere(self):
        self.list.mkdir()
        self.assertEqual(self.run_main("render"), 0, self.log)
        self.assertEqual(self.off(), [])
        self.assertIn("blocking on everywhere", self.log)

    def test_the_log_never_holds_a_site(self):
        self.list.write_bytes(b"secret-site.example\nBAD-SECRET.example\n")
        self.run_main("render")
        self.assertNotIn("secret", self.log.lower())
        self.assertIn("1 line(s) dropped", self.log)

    def test_rewrites_and_leaves_no_temp(self):
        self.list.write_bytes(b"cnn.com\n")
        self.run_main("render")
        self.temp.write_bytes(b"left by a killed run")
        self.list.write_bytes(b"")
        self.assertEqual(self.run_main("render"), 0, self.log)
        self.assertEqual(self.off(), [])

    def test_a_bad_template_leaves_the_policy_there(self):
        self.list.write_bytes(b"cnn.com\n")
        self.run_main("render")
        before = self.policy.read_bytes()
        good = self.template.read_bytes()
        t = json.loads(good)
        def variant(f):
            v = json.loads(good)
            f(v)
            return json.dumps(v).encode()
        bad = {
            "not JSON": lambda: self.template.write_bytes(b"{"),
            "not an object": lambda: self.template.write_bytes(b"[]"),
            "no force-install": lambda: self.template.write_bytes(variant(lambda v: v.pop("ExtensionSettings"))),
            "two extensions": lambda: self.template.write_bytes(variant(lambda v: v["ExtensionSettings"].update({"b" * 32: v["ExtensionSettings"][ID]}))),
            "the placeholder": lambda: self.template.write_bytes(TEMPLATE.read_bytes()),
            "from the Web Store": lambda: self.template.write_bytes(variant(lambda v: v["ExtensionSettings"][ID].update(update_url="https://clients2.google.com/service/update2/crx"))),
            "updates from its own manifest": lambda: self.template.write_bytes(variant(lambda v: v["ExtensionSettings"][ID].pop("override_update_url"))),
            "only allowed, not forced": lambda: self.template.write_bytes(variant(lambda v: v["ExtensionSettings"][ID].update(installation_mode="allowed"))),
            "no settings": lambda: self.template.write_bytes(variant(lambda v: v.pop("3rdparty"))),
            "group-writable": lambda: self.template.chmod(0o664),
            "a symlink": lambda: (self.template.unlink(), self.template.symlink_to(TEMPLATE)),
        }
        for what, make in bad.items():
            with self.subTest(what=what):
                self.list.write_bytes(b"other.example\n")
                make()
                self.assertEqual(self.run_main("render"), 1, self.log)
                self.assertIn("POLICY NOT WRITTEN", self.log)
                self.assertEqual(self.policy.read_bytes(), before)
                if self.template.is_symlink():
                    self.template.unlink()
                self.template.write_bytes(good)
                self.template.chmod(0o644)

    def test_someone_elses_template_is_refused(self):
        with mock.patch.object(A, "OWNER", (os.getuid() + 1, os.getgid())):
            self.assertEqual(self.run_main("render"), 1)
        self.assertFalse(self.policy.exists())


class KillSwitch(Case):
    def test_a_root_file_turns_blocking_off_and_keeps_the_list(self):
        self.list.write_bytes(b"cnn.com\n")
        self.kill.write_bytes(b"")
        self.assertEqual(self.run_main("render"), 0, self.log)
        self.assertIs(self.killed(), True)
        self.assertEqual(self.off(), ["cnn.com"])
        self.assertIn("KILL SWITCH SET", self.log)
        self.kill.unlink()
        self.run_main("render")
        self.assertIs(self.killed(), False)

    def test_only_a_regular_file_root_owns(self):
        target = self.root / "elsewhere"
        target.write_bytes(b"")
        for what, make, undo in (("a symlink", lambda: self.kill.symlink_to(target), self.kill.unlink),
                                 ("a directory", self.kill.mkdir, self.kill.rmdir)):
            with self.subTest(what=what):
                make()
                self.run_main("render")
                self.assertIs(self.killed(), False)
                undo()
        self.kill.write_bytes(b"")
        with mock.patch.object(A, "KILL_OWNER", os.getuid() + 1):   # a file someone else owns
            self.run_main("render")
        self.assertIs(self.killed(), False)
        self.assertIn("isn't a regular file root owns", self.log)


class Apply(Case):
    def test_not_installed_yet_writes_and_says_so(self):
        self.list.write_bytes(b"cnn.com\n")
        with mock.patch.object(A, "become_desk"):
            self.assertEqual(self.run_main("apply"), 0, self.log)
        self.assertEqual(self.off(), ["cnn.com"])
        self.assertIn("isn't installed yet", self.log)

    def test_no_chromium_writes_and_says_so(self):
        (self.profile / ID).mkdir()
        self.list.write_bytes(b"cnn.com\n")
        with mock.patch.object(A, "become_desk") as become:
            rc = self.run_main("apply")
        self.assertEqual(rc, 0, self.log)
        self.assertEqual(self.off(), ["cnn.com"])
        self.assertIn("Chromium isn't running", self.log)
        self.assertEqual(become.call_count, 1 if os.geteuid() == 0 else 0)

    def test_a_bad_template_is_exit_1_before_anything_else(self):
        self.template.write_bytes(b"{")
        with mock.patch.object(A, "apply_live") as live:
            self.assertEqual(self.run_main("apply"), 1)
        live.assert_not_called()

    def test_what_apply_live_is_given(self):
        (self.profile / ID).mkdir()
        self.list.write_bytes(b"cnn.com\nfoxnews.com\n")
        self.run_main("render")
        self.list.write_bytes(b"foxnews.com\nyahoo.com\n")
        self.kill.write_bytes(b"")
        with mock.patch.object(A, "apply_live", return_value=0) as live, mock.patch.object(A, "become_desk"):
            self.assertEqual(self.run_main("apply"), 0)
        live.assert_called_once_with(ID, ["foxnews.com", "yahoo.com"], True, ["cnn.com"])

    def test_in_effect(self):
        all_ = ["easylist", "easyprivacy"]
        def st(**k):
            v = {"given": ["a.example"], "killed": False, "applied": {"sites": ["a.example"], "off": False},
                 "through": ["a.example"], "enabled": all_, "all": all_}
            v.update(k)
            return v
        self.assertTrue(A.in_effect(st(), ["a.example"], False))
        self.assertFalse(A.in_effect(None, ["a.example"], False))
        self.assertFalse(A.in_effect(st(through=["a.example", "b.example"]), ["a.example"], False), "a removed site still let through")
        self.assertFalse(A.in_effect(st(given=[]), ["a.example"], False), "Chromium hasn't given it the list yet")
        self.assertFalse(A.in_effect(st(applied={"sites": [], "off": False}), ["a.example"], False), "not applied yet")
        self.assertFalse(A.in_effect(st(enabled=["easylist"]), ["a.example"], False), "a list is off")
        self.assertFalse(A.in_effect(st(), ["a.example"], True), "the kill switch isn't in effect")
        self.assertTrue(A.in_effect(st(killed=True, applied={"sites": ["a.example"], "off": True}, enabled=[]), ["a.example"], True))
        self.assertFalse(A.in_effect(st(killed=True, applied={"sites": ["a.example"], "off": True}, enabled=["easylist"]), ["a.example"], True))

    def test_usage(self):
        self.assertEqual(self.run_main(), 64)
        self.assertEqual(self.run_main("nonsense"), 64)
        self.assertEqual(self.run_main("settle"), 64)


class Live(unittest.TestCase):
    """apply_live's loop, with CDP stood in for: a call that times out costs a new connection, not the apply."""
    GOOD = {"given": ["a.example"], "killed": False, "applied": {"sites": ["a.example"], "off": False},
            "through": ["a.example"], "enabled": ["x"], "all": ["x"]}
    STALE = {"given": [], "killed": False, "applied": {"sites": [], "off": False}, "through": [], "enabled": ["x"], "all": ["x"]}

    def run_live(self, states, seconds=2, then=None):
        calls = {"browser": 0, "asked": 0, "opened": [], "closed": []}
        seq = iter(states)
        then = then if then is not None else self.STALE

        class Conn:
            def close(self):
                pass

        def browser(deadline):
            calls["browser"] += 1
            return Conn()

        def open_page(b, opened, url):
            tid = f"page{len(calls['opened'])}"
            calls["opened"].append(tid)
            opened.append(tid)
            return "s-" + tid

        def close_tabs(opened):
            calls["closed"].extend(opened)
            opened.clear()

        def state(b, ext_id):
            x = next(seq, then)
            if isinstance(x, BaseException):
                raise x
            return x

        def reload_policies(b, pol):
            calls["asked"] += 1

        err = io.StringIO()
        with mock.patch.object(A, "browser", browser), mock.patch.object(A, "open_page", open_page), \
                mock.patch.object(A, "close_tabs", close_tabs), mock.patch.object(A, "blocker_state", state), \
                mock.patch.object(A, "reload_policies", reload_policies), mock.patch.object(A, "wake"), \
                mock.patch.object(A, "APPLY_SECONDS", seconds), mock.patch.object(A, "RELOAD_EVERY", 0.05), \
                mock.patch.object(A, "STEADY_SECONDS", 0.05), mock.patch.object(A.time, "sleep"), redirect_stderr(err):
            rc = A.apply_live(ID, ["a.example"], False, [])
        return rc, calls, err.getvalue()

    def test_in_effect_and_steady(self):
        rc, calls, log = self.run_live([], then=self.GOOD)
        self.assertEqual(rc, 0, log)
        self.assertGreaterEqual(calls["asked"], 1)

    def test_an_unanswered_call_is_retried_on_a_new_connection(self):
        rc, calls, log = self.run_live([TimeoutError("timed out"), self.STALE], then=self.GOOD)
        self.assertEqual(rc, 0, log)
        self.assertEqual(calls["browser"], 2)
        self.assertIn("1 retried call(s)", log)
        self.assertEqual(sorted(calls["closed"]), sorted(calls["opened"]), "a page left behind would be the member's to see")

    def test_a_flip_back_restarts_the_steady_wait(self):
        rc, calls, log = self.run_live([self.GOOD, self.STALE], then=self.GOOD)
        self.assertEqual(rc, 0, log)

    def test_never_in_effect_is_exit_2(self):
        rc, calls, log = self.run_live([], seconds=0.3)
        self.assertEqual(rc, 2, log)
        self.assertIn("NOT CONFIRMED", log)
        self.assertGreater(calls["asked"], 1, "Chromium is asked to read its policy again while it isn't in effect")

    def test_closes_only_its_own_pages(self):
        closed = []

        class R(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen(url, timeout=None):
            if url.endswith("/json/list"):
                return R(json.dumps([{"id": "someone-elses", "type": "page", "url": "chrome://policy/"}]).encode())
            closed.append(url.rsplit("/", 1)[1])
            return R(b"")
        with mock.patch.object(A.urllib.request, "urlopen", urlopen):
            A.close_tabs(["mine", "mine-too"])
        self.assertEqual(sorted(closed), ["mine", "mine-too"])


class Builder(unittest.TestCase):
    """build-blocker.py on a stand-in release: only block and allow rules, only two permissions, a CRX3 Chromium can check."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = pathlib.Path(self.tmp.name)
        rules = [{"id": 1, "action": {"type": "block"}, "condition": {"urlFilter": "/ad.js"}},
                 {"id": 2, "action": {"type": "allow"}, "condition": {"urlFilter": "/ok.js"}},
                 {"id": 3, "action": {"type": "redirect", "redirect": {"extensionPath": "/noop.js"}}, "condition": {"urlFilter": "/ga.js"}},
                 {"id": 4, "action": {"type": "modifyHeaders", "responseHeaders": [{"header": "set-cookie", "operation": "remove"}]},
                  "condition": {"urlFilter": "x"}}]
        manifest = {"version": "2026.1.1", "minimum_chrome_version": "122", "declarative_net_request": {"rule_resources": [
            {"id": "easylist", "enabled": True, "path": "/rulesets/main/easylist.json"},
            {"id": "annoyances-cookies", "enabled": False, "path": "/rulesets/main/annoyances-cookies.json"}]}}
        self.zip = d / "release.zip"
        with zipfile.ZipFile(self.zip, "w") as z:
            z.writestr("manifest.json", json.dumps(manifest))
            z.writestr("rulesets/main/easylist.json", json.dumps(rules))
            z.writestr("rulesets/main/annoyances-cookies.json", json.dumps(rules))
            z.writestr("rulesets/scripting/scriptlet/main/easylist.js", "/* a scriptlet */")
        self.pin = {"version": "2026.1.1", "url": "https://example.invalid/x.zip", "sha256": hashlib.sha256(self.zip.read_bytes()).hexdigest()}
        self.out = d / "out"

    def build(self):
        with mock.patch.object(B, "pin", return_value=self.pin), redirect_stderr(io.StringIO()), \
                mock.patch("sys.stdout", new=io.StringIO()):
            B.build(str(self.out), str(self.zip))

    def test_the_download_is_retried_and_gives_up(self):
        calls = []

        class R:
            def read(self):
                return b"zip"

        def urlopen(url, timeout=None):
            calls.append(url)
            if len(calls) < 3:
                raise B.urllib.error.HTTPError(url, 504, "Gateway Time-out", {}, None)
            return R()
        with mock.patch.object(B.urllib.request, "urlopen", urlopen), mock.patch.object(B.time, "sleep"), redirect_stderr(io.StringIO()):
            self.assertEqual(B.fetch("https://example.invalid/x.zip"), b"zip")
        self.assertEqual(len(calls), 3)

        def always(url, timeout=None):
            raise B.urllib.error.URLError("down")
        with mock.patch.object(B.urllib.request, "urlopen", always), mock.patch.object(B.time, "sleep"), redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            B.fetch("https://example.invalid/x.zip", tries=2)

    def test_refuses_a_release_that_isnt_the_pinned_one(self):
        self.pin["sha256"] = "0" * 64
        with self.assertRaises(SystemExit):
            self.build()

    def test_the_extension(self):
        self.build()
        crx = (self.out / "ma-blocker.crx").read_bytes()
        self.assertEqual(crx[:4], b"Cr24")
        version, hlen = struct.unpack("<II", crx[4:12])
        self.assertEqual(version, 3)
        z = zipfile.ZipFile(io.BytesIO(crx[12 + hlen:]))
        m = json.loads(z.read("manifest.json"))
        self.assertEqual(m["permissions"], ["declarativeNetRequest", "storage"])
        for k in ("host_permissions", "optional_host_permissions", "content_scripts", "optional_permissions"):
            self.assertNotIn(k, m)
        self.assertEqual([r["id"] for r in m["declarative_net_request"]["rule_resources"]], ["easylist", "ma-site-allow"], "the default lists, and our site exceptions")
        kept = json.loads(z.read("rules/easylist.json"))
        self.assertEqual(sorted(r["action"]["type"] for r in kept), ["allow", "block"], "no redirect, no modifyHeaders")
        site = json.loads(z.read("rules/ma-site-allow.json"))
        self.assertTrue(site and {r["action"]["type"] for r in site} == {"allow"}, "our own rules only allow")
        self.assertTrue(all(r["priority"] > 40 and r["condition"]["initiatorDomains"] and r["condition"]["urlFilter"].startswith("||") for r in site),
                        "above every block rule, for named sites, for a named request")
        self.assertFalse([n for n in z.namelist() if n.endswith(".js") and n != "worker.js"], "no script but its own worker")
        self.assertEqual(z.read("worker.js"), WORKER.read_bytes())
        info = json.loads((self.out / "blocker.json").read_text())
        ext_id = (self.out / "blocker-id").read_text().strip()
        self.assertRegex(ext_id, r"^[a-p]{32}$")
        self.assertEqual(info["id"], ext_id)
        self.assertEqual(info["dropped"], {"redirect": 1, "modifyHeaders": 1})
        # The id is the public key's, as Chromium works it out, and the header holds that key.
        pub = __import__("base64").b64decode(info["public_key"])
        self.assertEqual(ext_id, "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(pub).hexdigest()[:32]))
        self.assertIn(pub, crx[12:12 + hlen])
        self.assertIn("appid='%s'" % ext_id, (self.out / "update.xml").read_text())
        self.assertIn("codebase='file:///usr/share/ma/adblock/ma-blocker.crx' version='2026.1.1'", (self.out / "update.xml").read_text())

    def entry(self, **kw):
        e = {"sites": ["example.com"], "urlFilter": "||ads.example.net/tag/js/lib.js", "why": "its bait"}
        e.update(kw)
        d = pathlib.Path(self.tmp.name) / "site-allow-test.json"
        d.write_text(json.dumps([e]))
        with redirect_stderr(io.StringIO()):
            return B.site_allow_rules(str(d))

    def test_site_allow_turns_an_entry_into_one_allow_rule(self):
        r = self.entry()
        self.assertEqual(r, [{"id": 1, "priority": B.ALLOW_PRIORITY, "action": {"type": "allow"},
                              "condition": {"urlFilter": "||ads.example.net/tag/js/lib.js", "initiatorDomains": ["example.com"]}}])

    def test_site_allow_refuses_anything_looser_than_an_exact_request_for_named_sites(self):
        for bad in ({"urlFilter": "||ads.example.net"}, {"urlFilter": "||ads.example.net/"}, {"urlFilter": "||ads.example.net/*/x.js"},
                    {"urlFilter": "||ads.example.net/a.js^"}, {"urlFilter": "/gpt.js"}, {"urlFilter": "||*.example.net/a.js"},
                    {"sites": []}, {"sites": ["*.example.com"]}, {"sites": ["com"]}, {"sites": ["example.com/x"]}, {"why": " "},
                    {"redirect": {"extensionPath": "/x.js"}}):
            with self.subTest(bad=bad), self.assertRaises(SystemExit):
                self.entry(**bad)

    def test_the_shipped_site_allow_file_builds_and_each_entry_says_why(self):
        rules = B.site_allow_rules()
        self.assertTrue(rules)
        self.assertEqual(len(json.load(open(RECIPE / "adblock/site-allow.json"))), len(rules))

    def test_no_key_is_left(self):
        before = set(pathlib.Path(tempfile.gettempdir()).glob("ma-blocker-*"))
        self.build()
        self.assertEqual(set(pathlib.Path(tempfile.gettempdir()).glob("ma-blocker-*")), before)
        self.assertFalse(list(self.out.glob("*.pem")))

    def test_each_build_has_its_own_id(self):
        self.build()
        a = (self.out / "blocker-id").read_text()
        self.build()
        self.assertNotEqual(a, (self.out / "blocker-id").read_text())


class Shipped(unittest.TestCase):
    def test_template_force_installs_the_image_blocker_with_an_empty_list(self):
        t = json.loads(TEMPLATE.read_bytes())
        self.assertEqual(t["ExtensionSettings"], {"__BLOCKER_ID__": {
            "installation_mode": "force_installed", "update_url": "file:///usr/share/ma/adblock/update.xml", "override_update_url": True}})
        self.assertEqual(t["DeveloperToolsAvailability"], 1)
        self.assertEqual(t["3rdparty"]["extensions"]["__BLOCKER_ID__"], {"noFiltering": [], "off": False})
        self.assertNotIn("ExtensionInstallForcelist", t)

    def test_no_key_in_two_managed_files(self):
        files = {p.name: set(json.loads(p.read_bytes())) for p in (MA_JSON, TEEN, TEMPLATE)}
        names = sorted(files)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                self.assertEqual(files[a] & files[b], set(), f"{a} and {b}")

    def test_browser_unit_renders_before_every_start_without_stopping_it(self):
        text = BROWSER_UNIT.read_text()
        pre = re.findall(r"(?m)^ExecStartPre=(.*)$", text)
        self.assertEqual(pre, ["+/usr/local/lib/ma/desk-browser-policy", "-+/usr/local/lib/ma/desk-adblock render"])
        self.assertNotIn("ExecStartPost=", text)

    def test_apply_unit(self):
        text = UNIT.read_text()
        self.assertIn("\nType=oneshot\n", text)
        self.assertIn("\nExecStart=/usr/local/lib/ma/desk-adblock apply\n", text)
        self.assertIn("\nReadWritePaths=/etc/chromium/policies/managed\n", text)
        self.assertNotIn("RemainAfterExit=yes", text)  # each start has to run it again
        self.assertNotIn("\nUser=", text)  # root writes the policy, then the helper drops to uid 1100 itself

    def test_no_settle_unit(self):
        self.assertFalse((FILES / "etc/systemd/system/desk-adblock-settle.service").exists())

    def test_units_sock_allows_it(self):
        self.assertRegex(UNITS_HELPER.read_text(), r'UNITS = \{[^}]*"desk-adblock"')

    def test_worker_keeps_to_managed_storage_and_its_rules(self):
        w = WORKER.read_text()
        for word in ("fetch(", "XMLHttpRequest", "chrome.scripting", "chrome.cookies", "chrome.tabs", "eval(", "importScripts"):
            self.assertNotIn(word, w)
        self.assertIn("chrome.storage.onChanged.addListener", w)

    def test_executable(self):
        self.assertTrue(os.access(HELPER, os.X_OK))
        self.assertTrue(os.access(BUILDER, os.X_OK))


if __name__ == "__main__":
    unittest.main(verbosity=1)
