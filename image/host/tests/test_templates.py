#!/usr/bin/python3 -I
"""A shared host's template generations (ADR 0077), with no root and no AWS: python3 -I image/host/tests/test_templates.py

- The manifest of a tree, and the walk against it (ctime after the seal, a byte changed, a path added or missing).
- The fetch end to end on temporary trees (templates.fetch) against a local HTTP server, with a throwaway P-256 key: sealed as
  the candidate; and every refusal, each with nothing written to the store and the current generation untouched: no signature, a
  key the host doesn't pin, one byte of the archive changed after signing, another host image's header, an older gen, a header
  that isn't the order's, a member the manifest doesn't list, a link out of the tree, a device file, no room.
- The choice of a slot's generation (section 2), the candidate, promote, halt and rollback (1.6).
- idlerule.py against desk-batch's own idle_now() on the same files (the rule is desk-batch's).
"""
import hashlib
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.normpath(os.path.join(HERE, "../recipe/files/usr/local/lib/desk-host"))
ROOT = tempfile.mkdtemp(prefix="tpl-test-")
for k, v in {"DESK_HOST_STORE": f"{ROOT}/store", "DESK_HOST_TEMPLATES": f"{ROOT}/store/templates", "DESK_HOST_TEMPLATES_VAR": f"{ROOT}/var",
             "DESK_HOST_TEMPLATES_DL": f"{ROOT}/dl", "DESK_HOST_RECORDS": f"{ROOT}/slots", "DESK_HOST_RUN": f"{ROOT}/run",
             "DESK_HOST_TEMPLATE_KEYS": f"{ROOT}/keys", "DESK_HOST_TEMPLATE_TEST_KEYS": f"{ROOT}/testkeys", "DESK_HOST_LIB": LIB,
             "DESK_HOST_TEMPLATES_TEST": "1", "DESK_HOST_TEMPLATE_CHECK": "/bin/true", "DESK_HOST_TEMPLATES_NO_ROOM_CHECK": "1",
             "DESK_HOST_SHARE": f"{ROOT}/share"}.items():
    os.environ[k] = v
sys.path.insert(0, LIB)
import idlerule  # noqa: E402
import templates as T  # noqa: E402

MAKE = os.path.join(HERE, "make_template_artifact.py")
STATUS = """Package: bash
Status: install ok installed
Version: 5.2.37-2

Package: chromium
Status: install ok installed
Version: {ch}
Description: the browser
 continued line
"""


def make_tree(d, ch="156.0.8078.79-1~deb13u1", extra=b"one"):
    os.makedirs(f"{d}/var/lib/dpkg", exist_ok=True)
    os.makedirs(f"{d}/usr/bin", exist_ok=True)
    os.makedirs(f"{d}/etc/alternatives", exist_ok=True)
    os.makedirs(f"{d}/tmp", exist_ok=True)
    os.chmod(f"{d}/tmp", 0o1777)
    open(f"{d}/var/lib/dpkg/status", "w").write(STATUS.format(ch=ch))
    open(f"{d}/usr/bin/tool", "wb").write(b"#!/bin/sh\necho " + extra + b"\n")
    os.chmod(f"{d}/usr/bin/tool", 0o755)
    open(f"{d}/usr/bin/big", "wb").write(os.urandom(300_000))
    if not os.path.lexists(f"{d}/usr/bin/tool2"):
        os.link(f"{d}/usr/bin/tool", f"{d}/usr/bin/tool2")
    for name, target in (("etc/alternatives/editor", "/usr/bin/tool"), ("usr/bin/rel", "tool"), ("lib", "usr/lib")):
        if not os.path.lexists(f"{d}/{name}"):
            os.symlink(target, f"{d}/{name}")
    os.makedirs(f"{d}/usr/lib", exist_ok=True)


class Server:
    """The artifact's files over http://127.0.0.1 (a test host's presigned URLs)."""

    def __init__(self, root):
        h = type("H", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None})
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **kw: h(*a, directory=root, **kw))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


def keypair(d, name):
    os.makedirs(d, exist_ok=True)
    priv = f"{d}/{name}.key"
    subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", priv], check=True, capture_output=True)
    subprocess.run(["openssl", "ec", "-in", priv, "-pubout", "-out", f"{d}/{name}.pem"], check=True, capture_output=True)
    os.chmod(f"{d}/{name}.pem", 0o644)
    return priv, f"{d}/{name}.pem"


class Base(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(ROOT, ignore_errors=True)
        for d in ("store/templates", "var", "dl", "slots", "run/lock", "keys", "art", "work", "share"):
            os.makedirs(f"{ROOT}/{d}", exist_ok=True)
        os.chmod(f"{ROOT}/keys", 0o755)
        g1 = T.gen_dir("g1")
        os.makedirs(g1)
        make_tree(g1)
        f = T.seal(g1, "g1", T.manifest_of(g1), {"host-version": "0.1.10", "host-template": T.utc()}, bind=False)
        T.save_state(dict(T.empty_state(), current={"gen": "g1", "chromium": f["chromium"], "sealedAt": f["host-template"], "target": None,
                                                    "currentSince": T.utc()}, maxGen=1))
        self.priv, pub = keypair(f"{ROOT}/work", "dev")
        shutil.copy(pub, f"{ROOT}/keys/dev.pem")
        self.srv = Server(f"{ROOT}/art")

    def tearDown(self):
        self.srv.stop()

    def artifact(self, gen="g2", ch="156.0.8078.80-1~deb13u1", host_image="0.1.10", key=None, tamper=None, extra=None, tree=None, out=None):
        t = tree or f"{ROOT}/work/tree-{gen}"
        if tree is None:
            shutil.rmtree(t, ignore_errors=True)
            shutil.copytree(T.gen_dir("g1"), t, symlinks=True)
            os.unlink(f"{t}/.complete")
            os.unlink(f"{t}/usr/bin/tool2")   # copytree doesn't keep hard links
            make_tree(t, ch=ch, extra=b"two")
        out = out or f"{ROOT}/art/{gen}"
        shutil.rmtree(out, ignore_errors=True)
        argv = [sys.executable, "-I", MAKE, "--tree", t, "--gen", gen, "--host-image", host_image, "--base", T.g1_manifest_sha(),
                "--key", key or self.priv, "--out", out, "--level", "3"]
        if tamper:
            argv += ["--tamper", tamper]
        if extra:
            argv += ["--extra", extra]
        r = subprocess.run(argv, capture_output=True, text=True, check=True)
        sha = r.stdout.strip().splitlines()[0]
        rel = os.path.relpath(out, f"{ROOT}/art")
        u = lambda n: f"{self.srv.base}/{rel}/{n}"  # noqa: E731
        return {"op": "template_target", "id": f"template_target:t-{gen}", "targetId": f"t-{gen}", "gen": gen, "hostImage": "0.1.10",
                "sha256": sha, "urgent": False, "expiresAt": T.utc(time.time() + 3600),
                "urls": {"header": u("header.json"), "signature": u("header.sig"), "manifest": u("manifest.json"), "plan": u("plan.txt"),
                         "archive": u("template.tar.zst")}}

    def assert_untouched(self):
        self.assertEqual(T.gens_on_store(), ["g1"])
        self.assertEqual([d for d in os.listdir(T.TPL) if d != "g1"], [], "nothing left on the store")
        self.assertEqual(os.listdir(T.DL), [], "the download removed")
        st = T.load_state()
        self.assertEqual(st["current"]["gen"], "g1")
        self.assertIsNone(st["candidate"])


class ManifestTest(Base):
    def test_a_tree_and_its_walk(self):
        g1 = T.gen_dir("g1")
        man = T.parse_manifest(open(f"{T.VAR}/g1.json", "rb").read(), refused=T.Failed)
        self.assertEqual(man["tmp"]["mode"], 0o1777)
        self.assertEqual(man["etc/alternatives/editor"], {"path": "etc/alternatives/editor", "type": "link", "mode": 0o777,
                                                          "uid": os.getuid(), "gid": os.getgid(), "target": "/usr/bin/tool"})
        self.assertEqual(man["usr/bin/tool2"]["sha256"], man["usr/bin/tool"]["sha256"])
        self.assertNotIn(".complete", man)
        sealed_at = T.parse_utc(T.read_complete(f"{g1}/.complete")["host-template"])
        self.assertEqual(T.walk_check(g1, man, sealed_at=sealed_at), [])
        self.assertTrue(T.sealed("g1"))
        time.sleep(2.2)
        with open(f"{g1}/usr/bin/big", "r+b") as f:   # one byte, the size kept
            old = f.read(1)
            f.seek(0)
            f.write(b"X" if old != b"X" else b"Y")
        self.assertTrue(any("changed after the seal" in p for p in T.walk_check(g1, man, sealed_at=sealed_at)))
        with open(f"{g1}/usr/bin/big", "r+b") as f:   # put back: its ctime moved, its content is the manifest's again
            f.write(old)
        self.assertEqual(T.walk_check(g1, man, sealed_at=sealed_at), [])
        open(f"{g1}/usr/bin/tmpfile", "w").close()
        os.unlink(f"{g1}/usr/bin/tmpfile")   # a directory's ctime moved, its entries are the manifest's
        self.assertEqual(T.walk_check(g1, man, sealed_at=sealed_at), [])
        open(f"{g1}/usr/bin/new", "w").write("x")
        self.assertTrue(any("not in the manifest" in p for p in T.walk_check(g1, man)))
        os.unlink(f"{g1}/usr/bin/rel")
        self.assertTrue(any("not in the tree" in p for p in T.walk_check(g1, man)))

    def test_a_re_roots_copy_is_the_tree(self):
        g1 = T.gen_dir("g1")
        os.chmod(f"{g1}/usr/bin", 0o2755)
        dst = f"{ROOT}/work/copy"
        os.mkdir(dst)
        T.PACE = 100_000   # the paced flushes, many times over
        try:
            self.assertGreater(T.copy_tree(g1, dst), 5)
        finally:
            T.PACE = 16 << 20
        self.assertEqual(T.manifest_of(dst), T.manifest_of(g1))
        self.assertFalse(os.path.exists(f"{dst}/.complete"))
        self.assertEqual(os.stat(f"{dst}/usr/bin/tool").st_ino, os.stat(f"{dst}/usr/bin/tool2").st_ino)
        self.assertEqual(os.stat(f"{dst}/usr/bin").st_mode & 0o7777, 0o2755)

    def test_versions(self):
        self.assertEqual(T.upstream("1:156.0.8078.79-1~deb13u1"), "156.0.8078.79")
        self.assertGreater(T.vkey("156.0.8078.80-1"), T.vkey("156.0.8078.79-1~deb13u1"))
        self.assertIsNone(T.vkey("abc"))
        self.assertEqual(T.chromium_of(T.gen_dir("g1")), "156.0.8078.79-1~deb13u1")

    def test_link_escapes(self):
        for rel, target, out in (("a/b", "../c", False), ("a/b", "../../c", True), ("a", "/etc/x", False), ("a", "..", True),
                                 ("a/b/c", "../../d/../e", False), ("a/b", "./../../x", True), ("x", "y/../../z", True)):
            with self.subTest(rel=rel, target=target):
                self.assertEqual(T.link_escapes(rel, target), out)


class FetchTest(Base):
    def test_fetch_check_and_seal(self):
        order = self.artifact()
        f = T.fetch(order)
        self.assertEqual(f["gen"], "g2")
        self.assertEqual(f["chromium"], "156.0.8078.80-1~deb13u1")
        st = T.load_state()
        self.assertEqual(st["candidate"]["gen"], "g2")
        self.assertEqual(st["current"]["gen"], "g1")
        self.assertEqual(st["maxGen"], 2)
        self.assertTrue(T.sealed("g2"))
        g2 = T.gen_dir("g2")
        self.assertEqual(oct(os.stat(f"{g2}/tmp").st_mode & 0o7777), oct(0o1777))
        self.assertEqual(os.readlink(f"{g2}/etc/alternatives/editor"), "/usr/bin/tool")
        self.assertEqual(os.stat(f"{g2}/usr/bin/tool").st_ino, os.stat(f"{g2}/usr/bin/tool2").st_ino)
        self.assertEqual(open(f"{g2}/usr/bin/tool", "rb").read(), b"#!/bin/sh\necho two\n")
        man = T.parse_manifest(open(f"{T.VAR}/g2.json", "rb").read(), refused=T.Failed)
        self.assertEqual(T.walk_check(g2, man, sealed_at=T.parse_utc(f["host-template"])), [])
        self.assertIn("usr/bin/tool", open(f"{T.VAR}/g2.changed").read().split())
        self.assertNotIn("usr/bin/rel", open(f"{T.VAR}/g2.changed").read().split())
        self.assertEqual(os.listdir(T.DL), [])
        self.assertEqual(T.read_fetch_status()["state"], "sealed")
        # the same artifact again: its gen isn't above every generation this host has had
        with self.assertRaises(T.Refused):
            T.fetch(order)

    def refused(self, order, step_word):
        with self.assertRaises(T.Refused) as cm:
            T.fetch(order)
        self.assertEqual(T.read_fetch_status()["state"], "refused")
        self.assertIn(step_word, str(cm.exception))
        self.assert_untouched()
        return str(cm.exception)

    def test_refused_unsigned(self):
        order = self.artifact()
        open(f"{ROOT}/art/g2/header.sig", "wb").close()
        self.refused(order, "signature")

    def test_refused_signed_by_a_key_the_host_doesnt_pin(self):
        other, _ = keypair(f"{ROOT}/work", "other")
        self.refused(self.artifact(key=other), "doesn't verify")

    def test_refused_with_no_key_at_all(self):
        os.unlink(f"{ROOT}/keys/dev.pem")
        self.refused(self.artifact(), "no template key")

    def test_refused_on_a_byte_of_the_archive(self):
        self.refused(self.artifact(tamper="archive"), "hash")

    def test_refused_on_its_header(self):
        self.refused(self.artifact(host_image="0.1.9"), "host image")
        o = self.artifact()
        o["sha256"] = "0" * 64
        self.refused(o, "order's")
        T.update_state(lambda s: s.__setitem__("maxGen", 5))
        self.refused(self.artifact(gen="g3"), "above every generation")

    def test_refused_at_unpack_a_member_not_in_the_manifest(self):
        self.refused(self.artifact(extra="stowaway"), "isn't in the manifest")

    def craft(self, members, man_entries):
        """An archive with hand-made members, its manifest and a valid signature (the unpack's own refusals)."""
        out = f"{ROOT}/art/g2"
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
            for ti, data in members:
                tf.addfile(ti, io.BytesIO(data) if data is not None else None)
        subprocess.run(["zstd", "-q", "-3", "-o", f"{out}/template.tar.zst"], input=buf.getvalue(), check=True)
        open(f"{out}/manifest.json", "wb").write(T.canonical({"format": T.MANIFEST_FORMAT, "entries": man_entries}))
        open(f"{out}/plan.txt", "wb").close()
        files = {n: {"size": os.path.getsize(f"{out}/{n}"), "sha256": T.sha256_file(f"{out}/{n}")} for n in T.FILES}
        hb = T.canonical({"format": T.FORMAT, "gen": "g2", "hostImage": "0.1.10", "created": T.utc(), "urgent": False,
                          "chromium": "156.0.8078.80-1", "base": T.g1_manifest_sha(), "files": files})
        open(f"{out}/header.json", "wb").write(hb)
        subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.priv, "-out", f"{out}/header.sig", f"{out}/header.json"], check=True)
        u = lambda n: f"{self.srv.base}/g2/{n}"  # noqa: E731
        return {"gen": "g2", "targetId": "t", "hostImage": "0.1.10", "sha256": T.sha256_bytes(hb), "expiresAt": T.utc(time.time() + 3600),
                "urls": {"header": u("header.json"), "signature": u("header.sig"), "manifest": u("manifest.json"), "plan": u("plan.txt"),
                         "archive": u("template.tar.zst")}}

    def ti(self, name, kind=tarfile.DIRTYPE, mode=0o755, link=""):
        t = tarfile.TarInfo(name)
        t.type, t.mode, t.uid, t.gid, t.linkname = kind, mode, os.getuid(), os.getgid(), link
        return t

    def test_refused_at_unpack_a_link_out_of_the_tree(self):
        me = {"uid": os.getuid(), "gid": os.getgid()}
        o = self.craft([(self.ti("."), None), (self.ti("./etc"), None), (self.ti("./etc/up", tarfile.SYMTYPE, 0o777, "../../outside"), None)],
                       [dict(path=".", type="dir", mode=0o755, **me), dict(path="etc", type="dir", mode=0o755, **me),
                        dict(path="etc/up", type="link", mode=0o777, target="../../outside", **me)])
        self.refused(o, "points out of the tree")

    def test_refused_at_unpack_a_device_file(self):
        me = {"uid": os.getuid(), "gid": os.getgid()}
        dev = self.ti("./dev-null", tarfile.CHRTYPE, 0o666)
        dev.devmajor, dev.devminor = 1, 3
        o = self.craft([(self.ti("."), None), (dev, None)], [dict(path=".", type="dir", mode=0o755, **me),
                                                            dict(path="dev-null", type="file", mode=0o666, size=0, sha256="0" * 64, **me)])
        self.refused(o, "device")

    def test_refused_at_unpack_set_id_bits_and_a_path_through_a_link(self):
        me = {"uid": os.getuid(), "gid": os.getgid()}
        f = self.ti("./x", tarfile.REGTYPE, 0o4755)
        f.size = 1
        o = self.craft([(self.ti("."), None), (f, b"x")], [dict(path=".", type="dir", mode=0o755, **me),
                                                          dict(path="x", type="file", mode=0o4755, size=1, sha256=hashlib.sha256(b"x").hexdigest(), **me)])
        self.refused(o, "set-id")
        f = self.ti("./l/x", tarfile.REGTYPE, 0o644)
        f.size = 1
        o = self.craft([(self.ti("."), None), (self.ti("./d"), None), (self.ti("./l", tarfile.SYMTYPE, 0o777, "d"), None), (f, b"x")],
                       [dict(path=".", type="dir", mode=0o755, **me), dict(path="d", type="dir", mode=0o755, **me),
                        dict(path="l", type="link", mode=0o777, target="d", **me),
                        dict(path="l/x", type="file", mode=0o644, size=1, sha256=hashlib.sha256(b"x").hexdigest(), **me)])
        with self.assertRaises(T.Failed):   # ELOOP: a member is never written through a link
            T.fetch(o)
        self.assert_untouched()

    def test_refused_when_older_chromium(self):
        self.refused(self.artifact(ch="156.0.8078.70-1"), "older than the current")

    def test_no_room_refuses_before_writing(self):
        os.environ.pop("DESK_HOST_TEMPLATES_NO_ROOM_CHECK")
        try:
            T.GROWTH = 10 ** 15
            with self.assertRaises(T.Failed) as cm:
                T.fetch(self.artifact())
            self.assertIn("no room", str(cm.exception))
            self.assertEqual(T.read_fetch_status()["state"], "failed")
            self.assertEqual(T.read_fetch_status()["step"], "admission")
            self.assert_untouched()
        finally:
            T.GROWTH = 300 * 10 ** 6
            os.environ["DESK_HOST_TEMPLATES_NO_ROOM_CHECK"] = "1"

    def test_urls_about_to_expire_are_asked_for_again(self):
        o = self.artifact()
        o["expiresAt"] = T.utc(time.time() + 120)
        with self.assertRaises(T.UrlsWanted):
            T.fetch(o)
        self.assertEqual(T.read_fetch_status()["state"], "urlsWanted")
        self.assert_untouched()


def st_with(**kw):
    s = T.empty_state()
    s.update(kw)
    return s


G = lambda g, ch, **kw: dict({"gen": g, "chromium": ch, "sealedAt": T.utc(time.time() - 7200)}, **kw)  # noqa: E731


class ChooseTest(unittest.TestCase):
    def test_the_rule(self):
        st = st_with(current=G("g2", "156.0.8078.80-1"), previous=G("g1", "156.0.8078.79-1"))
        self.assertEqual(T.choose(st, "g1", None)[0], "g2")                      # no profile: current
        self.assertEqual(T.choose(st, "g1", "156.0.8078.79")[0], "g2")           # forward
        self.assertEqual(T.choose(st, "g1", "unreadable")[0], "g1")              # unreadable: kept
        g, why, behind = T.choose(st, "g2", "157.0.1.1")                          # none new enough: current, chromiumBehind
        self.assertEqual((g, behind), ("g2", True))
        st["halted"] = [{"gen": "g2", "chromium": "156.0.8078.80-1", "reason": "rollback"}]
        st["current"], st["previous"] = G("g1", "156.0.8078.79-1"), None
        self.assertEqual(T.choose(st, "g2", "156.0.8078.80")[0], "g2")           # rolled back, but its Chromium ran: stays
        self.assertEqual(T.choose(st, "g2", "156.0.8078.79")[0], "g1")           # never ran it: back
        self.assertEqual(T.choose(st, "g2", None)[0], "g1")
        st["halted"] = [{"gen": "g2", "chromium": "156.0.8078.80-1", "reason": "start_failed"}]
        self.assertEqual(T.choose(st, "g2", "156.0.8078.80")[:2], ("g1", "no generation here is new enough"))

    def test_the_candidate_one_slot_at_a_time(self):
        st = st_with(current=G("g1", "156.0.8078.79-1"), candidate=G("g2", "156.0.8078.80-1", trialSlot=None, urgent=False))
        self.assertTrue(T.candidate_trial_ok(st, 1))
        self.assertFalse(T.candidate_trial_ok(st, 1, at_stop=True) and False)
        st["candidate"]["sealedAt"] = T.utc()
        self.assertFalse(T.candidate_trial_ok(st, 1, at_stop=True))             # at a stop only after the idle restarts' head start
        self.assertEqual(T.choose(st, "g1", None, "reroot", trial_ok=True)[0], "g2")
        self.assertEqual(T.choose(st, "g1", None, "new", trial_ok=True)[0], "g1")  # never at a start
        st["candidate"]["trialSlot"] = 2
        self.assertFalse(T.candidate_trial_ok(st, 1))


class StateTest(Base):
    def test_promote_needs_the_trial_and_the_order(self):
        T.fetch(self.artifact())
        self.assertTrue(T.promote("g2").startswith("promote ordered"))
        self.assertEqual(T.current_gen(), "g1")
        T.trial("g2", 1, "start")
        self.assertEqual(T.trial("g2", 1, "passed"), "passed and promoted")
        st = T.load_state()
        self.assertEqual((st["current"]["gen"], st["previous"]["gen"], st["candidate"]), ("g2", "g1", None))

    def test_a_failed_trial_halts_and_a_rollback_goes_back(self):
        T.fetch(self.artifact())
        T.trial("g2", 1, "start")
        self.assertTrue(T.trial("g2", 1, "failed").startswith("halted"))
        st = T.load_state()
        self.assertIsNone(st["candidate"])
        self.assertEqual(st["halted"][0]["gen"], "g2")
        with self.assertRaises(T.Refused):   # never again: its gen isn't above what this host has had
            T.fetch(self.artifact())

    def test_rollback_of_current(self):
        T.fetch(self.artifact())
        T.trial("g2", 1, "passed")
        T.promote("g2")
        self.assertEqual(T.current_gen(), "g2")
        self.assertEqual(T.halt("g2", "rollback"), "halted (rollback)")
        st = T.load_state()
        self.assertEqual((st["current"]["gen"], st["previous"]), ("g1", None))
        self.assertTrue(T.halt("g1", "rollback").startswith("refused"))


class ReportTest(unittest.TestCase):
    def test_behind_and_the_candidate(self):
        st = st_with(current=G("g2", "156.0.8078.80-1"), previous=G("g1", "156.0.8078.79-1"), candidate=G("g3", "156.0.8078.81-1"))
        self.assertTrue(T.report_slot(1, {"template": "g1", "lastVersion": "156.0.8078.79"}, st)["behind"])
        self.assertFalse(T.report_slot(1, {"template": "g2"}, st)["behind"])
        self.assertFalse(T.report_slot(1, {"template": "g3"}, st)["behind"], "on the candidate's trial")
        st = st_with(current=G("g1", "156.0.8078.79-1"), halted=[{"gen": "g2", "chromium": "156.0.8078.80-1", "reason": "rollback"}])
        r = T.report_slot(1, {"template": "g2", "lastVersion": "156.0.8078.80"}, st)
        self.assertFalse(r["behind"], "kept on a rolled-back generation its Chromium already ran")
        self.assertEqual((r["chromium"], r["lastVersion"], r["update"]), ("156.0.8078.80-1", "156.0.8078.80", {"holdUntil": None}))


class IdleParityTest(unittest.TestCase):
    """idlerule.rule() is desk-batch's idle_now() on the same idle.json (plus downloads, which a restart needs)."""

    @classmethod
    def setUpClass(cls):
        src = os.path.normpath(os.path.join(HERE, "../../recipe/files/usr/local/lib/ma/desk-batch"))
        loader = importlib.machinery.SourceFileLoader("desk_batch", src)
        spec = importlib.util.spec_from_loader("desk_batch", loader)
        cls.db = importlib.util.module_from_spec(spec)
        loader.exec_module(cls.db)
        cls.db.IDLE_UID = os.getuid()

    def test_same_verdicts(self):
        now = 1_800_000_000.0
        u = lambda dt: T.utc(now - dt)  # noqa: E731
        base = {"at": u(5), "sessions": 0, "agentTasks": 0, "exports": 0, "downloads": 0, "idleSince": u(4000), "idleStopSeconds": 1200}
        cases = [base, dict(base, sessions=1), dict(base, idleSince=u(500)), dict(base, idleSince=u(700), idleStopSeconds=None),
                 dict(base, at=u(90)), dict(base, idleStopSeconds=0), dict(base, idleSince="bad"), dict(base, agentTasks=2),
                 dict(base, exports=1), dict(base, idleSince=None), {"at": u(1)}, dict(base, idleStopSeconds=99999, idleSince=u(3000)),
                 dict(base, sessions=1, lastInputAt=u(1000)), dict(base, sessions=1, lastInputAt=u(100))]
        pend = [None, {"urgent": True, "offeredAt": u(25 * 3600)}, {"urgent": True, "offeredAt": u(80 * 3600)}, {"urgent": True, "offeredAt": u(3600)}]
        d = tempfile.mkdtemp()
        p = f"{d}/idle.json"
        self.db.IDLE_FILE = p
        self.db.NOW = lambda: now
        n = 0
        for c in cases:
            c = {k: v for k, v in c.items() if v is not None}
            open(p, "w").write(json.dumps(c))
            for pe in pend:
                with self.subTest(case=c, pending=pe):
                    self.assertEqual(idlerule.rule(c, pe, downloads=False, now=now)[0], self.db.idle_now(pe)[0])
                    n += 1
        self.assertEqual(idlerule.rule(dict(base, downloads=1), None, now=now)[0], False)
        self.assertGreater(n, 50)

    def test_the_slots_file_under_rc06(self):
        d = f"{ROOT}/share/3/desk"
        os.makedirs(d, exist_ok=True)
        now = time.time()
        open(f"{d}/idle.json", "w").write(json.dumps({"at": T.utc(now), "sessions": 0, "agentTasks": 0, "exports": 0, "downloads": 0,
                                                      "idleSince": T.utc(now - 4000)}))
        self.assertTrue(idlerule.slot_idle(3, owner=os.getuid())[0])
        self.assertIn("not the slot's deskd", idlerule.slot_idle(3, owner=os.getuid() + 1)[1])
        os.unlink(f"{d}/idle.json")
        os.symlink("/etc/passwd", f"{d}/idle.json")
        self.assertFalse(idlerule.slot_idle(3, owner=os.getuid())[0])
        os.unlink(f"{d}/idle.json")
        os.mkfifo(f"{d}/idle.json")
        t0 = time.monotonic()
        self.assertFalse(idlerule.slot_idle(3, owner=os.getuid())[0])
        self.assertLess(time.monotonic() - t0, 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
