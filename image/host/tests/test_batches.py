#!/usr/bin/python3 -I
"""ADR 0078 on a shared host, no root: batches.py's fetch (verify before any download, the floor, the version conflict, downloads hashed
as they arrive, desk-host-release's streamed unpack, the candidate), promote, halt, the canary, a slot's plan and its record, retention,
the report's fields; desk-host-release's streamed unpack of a docker-save image (whiteouts, links, digests) and its refusals; smoke.py
on fake /proc trees. Real openssl and P-256 keys made per run; artifacts served on the loopback.
python3 -I image/host/tests/test_batches.py"""
import base64
import gzip
import hashlib
import http.server
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
LIB = HERE.parent / "recipe/files/usr/local/lib/desk-host"
TMP = tempfile.TemporaryDirectory(prefix="desk-host-batches-")
T0 = pathlib.Path(TMP.name)
ENV = {"DESK_HOST_STORE": T0 / "srv", "DESK_HOST_RELEASES": T0 / "srv/releases", "DESK_HOST_SLOTS": T0 / "srv/slots",
       "DESK_HOST_TEMPLATES": T0 / "srv/templates", "DESK_HOST_TEMPLATES_VAR": T0 / "var/templates", "DESK_HOST_TEMPLATES_DL": T0 / "var/dl",
       "DESK_HOST_RECORDS": T0 / "var/slots", "DESK_HOST_RUN": T0 / "run", "DESK_HOST_LIB": LIB, "DESK_HOST_BATCH_VAR": T0 / "var/batch",
       "DESK_HOST_BATCH_KEYS": T0 / "etc/batch-keys", "DESK_HOST_BATCH_TEST_KEYS": T0 / "var/test/batch-keys",
       "DESK_HOST_BATCH_PINS": T0 / "lib/batch-keys.sha256", "DESK_HOST_BATCH_BASELINE": T0 / "etc/batch-baseline",
       "DESK_HOST_RELEASE_PIN": T0 / "etc/releases.pin", "DESK_HOST_UPDATES": T0 / "run/link/updates.json",
       "DESK_HOST_RELEASE_STAGE": T0 / "var/dl", "DESK_HOST_UPD_CGROUP": T0 / "upd", "DESK_HOST_PRE_CGROUP": T0 / "pre",
       "DESK_HOST_TEMPLATES_TEST": "1", "DESK_HOST_BATCH_TEST": "1", "DESK_HOST_TEMPLATES_NO_ROOM_CHECK": "1",
       "DESK_HOST_SHARE": T0 / "run/share"}
os.environ.update({k: str(v) for k, v in ENV.items()})
os.umask(0o022)
sys.path.insert(0, str(LIB))
import batches as BT  # noqa: E402
import batchsig as B  # noqa: E402
import smoke  # noqa: E402
import templates as T  # noqa: E402

COMPS = ("deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream")


def keypair(d, name):
    key, pub = d / f"{name}.key", d / f"{name}.pem"
    subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(key)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(pub)], check=True, capture_output=True)
    return key, pub


def sign(key, data):
    return subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(key)], input=data, check=True, capture_output=True).stdout


def tar_bytes(entries, gz=False):
    """entries: [(name, kind, data/target, mode)] kind file|dir|sym|link."""
    bio = io.BytesIO()
    with tarfile.open(fileobj=bio, mode="w") as tf:
        for name, kind, data, mode in entries:
            ti = tarfile.TarInfo(name)
            ti.mode = mode
            if kind == "file":
                ti.size = len(data)
                tf.addfile(ti, io.BytesIO(data))
            elif kind == "dir":
                ti.type = tarfile.DIRTYPE
                tf.addfile(ti)
            elif kind == "sym":
                ti.type, ti.linkname = tarfile.SYMTYPE, data
                tf.addfile(ti)
            elif kind == "link":
                ti.type, ti.linkname = tarfile.LNKTYPE, data
                tf.addfile(ti)
    b = bio.getvalue()
    return gzip.compress(b) if gz else b


def image_tar(layers, env=("JAVA_HOME=/opt/java/openjdk", "SECRET=no")):
    """docker save's layout: manifest.json, the config blob, each layer as blobs/sha256/<its own digest>."""
    cfg = json.dumps({"config": {"Env": list(env)}}).encode()
    blobs = {hashlib.sha256(cfg).hexdigest(): cfg}
    names = []
    for l in layers:
        d = hashlib.sha256(l).hexdigest()
        blobs[d] = l
        names.append(f"blobs/sha256/{d}")
    man = json.dumps([{"Config": f"blobs/sha256/{hashlib.sha256(cfg).hexdigest()}", "RepoTags": ["x"], "Layers": names}]).encode()
    return tar_bytes([("manifest.json", "file", man, 0o644)] + [(f"blobs/sha256/{d}", "file", b, 0o644) for d, b in blobs.items()])


def native_tgz(path, comp, ver, extra=b""):
    data = tar_bytes([("./", "dir", None, 0o755), ("./run", "file", b"#!/bin/sh\nexec ./" + comp.encode() + b"\n" + extra, 0o755),
                      (f"./{comp}", "file", f"{comp} {ver}\n".encode() * 50, 0o755)], gz=True)
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def image_tgz(path, layers, extra_members=()):
    data = tar_bytes([("./", "dir", None, 0o755), ("./image.tar", "file", image_tar(layers), 0o644), ("./jvm.options", "file", b"-Xmx64m\n", 0o644),
                      *extra_members], gz=True)
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


class Server:
    def __init__(self, root):
        root = str(root)

        class H(http.server.SimpleHTTPRequestHandler):
            def __init__(s, *a, **kw):
                super().__init__(*a, directory=root, **kw)

            def log_message(s, *a):
                pass
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def url(self, name):
        return f"http://127.0.0.1:{self.port}/{name}"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        B.machine_arch = lambda: "arm64"   # a cloud host's, whatever runs the tests
        cls.keys = T0 / "keys-made"
        cls.keys.mkdir(exist_ok=True)
        cls.key, cls.pub = keypair(cls.keys, "dev")
        cls.other_key, cls.other_pub = keypair(cls.keys, "other")
        cls.art = T0 / "art"
        cls.art.mkdir(exist_ok=True)
        cls.srv = Server(cls.art)

    def setUp(self):
        for d in ("srv", "var", "run", "etc", "lib", "upd", "pre"):
            shutil.rmtree(T0 / d, ignore_errors=True)
        for d in ("srv/releases", "srv/slots", "srv/templates", "var/templates", "var/dl", "var/slots", "var/batch", "run/link", "run/share",
                  "etc/batch-keys", "var/test/batch-keys", "lib", "upd", "pre"):
            (T0 / d).mkdir(parents=True, exist_ok=True)
        shutil.copy(self.pub, T0 / "etc/batch-keys/dev.pem")
        os.chmod(T0 / "etc/batch-keys/dev.pem", 0o644)
        (T0 / "lib/batch-keys.sha256").write_text(f"{hashlib.sha256(self.pub.read_bytes()).hexdigest()}  dev.pem\n")
        # the image's releases: what the bake installed (the pin), each current
        pin = []
        for c in COMPS:
            v = "1.0"
            tgz = self.art / f"{c}-{v}.tgz"
            sha = native_tgz(tgz, c, v) if c in ("desk-rtc", "desk-stream") else image_tgz(tgz, [tar_bytes([("app", "dir", None, 0o755), ("app/x", "file", c.encode() + b" 1.0", 0o644)])])
            pin.append(f"{c} {v} {sha}")
        (T0 / "etc/releases.pin").write_text("\n".join(pin) + "\n")
        for c in COMPS:
            r = self.release("install", str(self.art / f"{c}-1.0.tgz"))
            self.assertEqual(r.returncode, 0, r.stderr)
        self.seq = 10

    def release(self, *a):
        return subprocess.run([sys.executable, "-I", str(LIB / "desk-host-release"), *a], capture_output=True, text=True, timeout=120)

    def batch(self, comps, seq=None, key=None, fmt="ma-desk-batch/1", image=None, urgent=False, extra=None):
        """A signed batch: comps [(name, version, tgz path or sha)]; returns the order."""
        seq = seq or self.seq
        cs = []
        urls = {}
        for name, ver, x in comps:
            sha = x if isinstance(x, str) else hashlib.sha256(x.read_bytes()).hexdigest()
            cs.append({"name": name, "version": ver, "sha256": sha})
            if not isinstance(x, str):
                urls[name] = self.srv.url(x.name)
        m = {"format": fmt, "seq": seq, "id": f"b-{seq}", "created": "2026-11-11T00:00:00Z", "urgent": urgent, "components": cs, "note": ""}
        if image:
            m["image"] = image
        m.update(extra or {})
        mb = json.dumps(m).encode()
        sig = sign(key or self.key, mb)
        return {"op": "batch_target", "id": f"batch_target:t-{seq}", "targetId": f"t-{seq}", "seq": seq, "sha256": hashlib.sha256(mb).hexdigest(),
                "manifest": base64.b64encode(mb).decode(), "signature": base64.b64encode(sig).decode(), "urls": urls,
                "expiresAt": "2099-01-01T00:00:00Z", "urgent": urgent}

    def fetch(self, order):
        try:
            BT.fetch(order)
            return "installed"
        except B.Refused as e:
            return f"refused {e.code}"
        except BT.Failed as e:
            return f"failed {e}"

    def store(self, c):
        return sorted(os.listdir(T0 / "srv/releases" / c))

    def links(self, c):
        return {n: BT.link(c, n) for n in BT.LINKS if BT.link(c, n)}

    def rec(self, k, **kw):
        r = {"slot": k, "state": "desk", "deskId": f"d-lab{k}desk", "template": "g1", "at": "x"}
        r.update(kw)
        (T0 / f"var/slots/{k}.json").write_text(json.dumps(r))
        (T0 / f"srv/slots/{k}/rel").mkdir(parents=True, exist_ok=True)


class Fetch(Base):
    def test_a_signed_batch_installs_as_the_candidate_and_touches_nothing_else(self):
        tgz = self.art / "desk-rtc-2.0.tgz"
        native_tgz(tgz, "desk-rtc", "2.0")
        self.rec(1)
        before = (T0 / "var/slots/1.json").read_text()
        self.assertEqual(self.fetch(self.batch([("desk-rtc", "2.0", tgz)])), "installed")
        self.assertEqual(self.links("desk-rtc"), {"current": "1.0", "candidate": "2.0"})
        self.assertEqual(self.links("deskd"), {"current": "1.0", "candidate": "1.0"})
        st = BT.load_state()
        self.assertEqual(st["candidate"]["seq"], 10)
        self.assertIsNone(st["current"])
        self.assertEqual(st["candidate"]["components"]["desk-rtc"]["version"], "2.0")
        self.assertEqual(st["candidate"]["components"]["deskd"]["version"], "1.0", "a batch is cumulative over the host's current")
        self.assertTrue((T0 / "var/batch/10.json").exists() and (T0 / "var/batch/10.sig").exists())
        self.assertEqual((T0 / "var/slots/1.json").read_text(), before, "no slot is touched")
        self.assertEqual(os.listdir(T0 / "var/dl"), [], "the download is gone")
        self.assertEqual(BT.read_fetch_status()["state"], "installed")
        r = self.release("verify")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_refused_before_any_download(self):
        tgz = self.art / "desk-rtc-2.0.tgz"
        native_tgz(tgz, "desk-rtc", "2.0")
        good = self.batch([("desk-rtc", "2.0", tgz)])
        nosig = dict(good, signature="")
        other = self.batch([("desk-rtc", "2.0", tgz)], key=self.other_key)
        tmpl = self.batch([("desk-rtc", "2.0", tgz)], fmt="ma-host-template/1")
        tmpl_header = json.dumps({"format": "ma-host-template/1", "gen": "g2", "hostImage": "0.1.10"}).encode()
        as_batch = dict(good, manifest=base64.b64encode(tmpl_header).decode(), signature=base64.b64encode(sign(self.key, tmpl_header)).decode(),
                        sha256=hashlib.sha256(tmpl_header).hexdigest())
        wrong_sha = dict(good, sha256="b" * 64)
        for label, o, code in (("no signature", nosig, "bad_request"), ("another key", other, "untrusted"), ("another format", tmpl, "bad_request"),
                               ("a template header as a batch", as_batch, "bad_request"), ("the order's sha256", wrong_sha, "bad_request")):
            with self.subTest(label=label):
                self.assertEqual(self.fetch(o), f"refused {code}")
                self.assertEqual(self.store("desk-rtc"), ["1.0", "current"], "nothing installed")
                self.assertEqual(os.listdir(T0 / "var/dl"), [])
                self.assertIsNone(BT.load_state()["candidate"])
                self.assertEqual(BT.floor(), 0, "a refusal before the signature verified never raises the floor")
        BT.update_state(lambda s: s.__setitem__("floor", 10))
        self.assertEqual(self.fetch(good), "refused seq", "at the floor")
        (T0 / "etc/batch-baseline").write_text('{"seq": 20}')
        self.assertEqual(self.fetch(self.batch([("desk-rtc", "2.0", tgz)], seq=15)), "refused seq", "below the image's baseline")
        self.assertEqual(self.fetch(self.batch([("desk-rtc", "2.0", tgz)], seq=21)), "installed")

    def test_refused_on_its_bytes(self):
        tgz = self.art / "desk-rtc-2.0.tgz"
        native_tgz(tgz, "desk-rtc", "2.0")
        o = self.batch([("desk-rtc", "2.0", tgz)])
        data = tgz.read_bytes()
        tgz.write_bytes(data[:100] + bytes([data[100] ^ 1]) + data[101:])   # one byte changed after signing
        self.assertEqual(self.fetch(o), "refused hash", "refused before it's opened")
        self.assertEqual(self.store("desk-rtc"), ["1.0", "current"])
        self.assertEqual(os.listdir(T0 / "var/dl"), [])
        # the same version from another artifact: refused, never replaced
        other = self.art / "desk-rtc-1.0-other.tgz"
        native_tgz(other, "desk-rtc", "1.0", extra=b"# another build\n")
        osha = hashlib.sha256(other.read_bytes()).hexdigest()
        o2 = self.batch([("desk-rtc", "1.0", osha)], seq=11)
        o2["urls"] = {"desk-rtc": self.srv.url("desk-rtc-1.0-other.tgz")}
        self.assertEqual(self.fetch(o2), "refused conflict")
        self.assertEqual(BT.artifact_sha("desk-rtc", "1.0"), hashlib.sha256((self.art / "desk-rtc-1.0.tgz").read_bytes()).hexdigest())
        self.assertGreaterEqual(BT.floor(), 11, "a signed batch refused for its content raises the floor")
        # desk-host-release itself never replaces one either
        mb = json.dumps({"format": "ma-desk-batch/1", "seq": 12, "id": "x", "created": "2026-11-11T00:00:00Z", "urgent": False,
                         "components": [{"name": "desk-rtc", "version": "1.0", "sha256": osha}]}).encode()
        (T0 / "m.json").write_bytes(mb)
        (T0 / "m.sig").write_bytes(sign(self.key, mb))
        named = T0 / "rtc" / "desk-rtc-1.0.tgz"
        named.parent.mkdir(exist_ok=True)
        shutil.copy(other, named)
        r = self.release("install", "--manifest", str(T0 / "m.json"), "--signature", str(T0 / "m.sig"), str(named))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("never replaced", r.stderr)

    def test_what_a_host_cant_apply(self):
        tgz = self.art / "desk-rtc-2.0.tgz"
        native_tgz(tgz, "desk-rtc", "2.0")
        o = self.batch([("desk-rtc", "2.0", tgz), ("desk-agent-filter", "0.2.0", "c" * 64), ("desk-egress", "0.3.0", "d" * 64),
                        ("commons-server", "0.2.1", "e" * 64)], image="0.3.4")
        self.assertEqual(self.fetch(o), "installed")
        rep = BT.report_host()
        self.assertEqual(rep["templatePending"], [{"name": "desk-agent-filter", "version": "0.2.0"}])
        self.assertEqual(rep["imagePending"], {"seq": 10, "image": "0.3.4"})
        self.assertNotIn("desk-egress", BT.load_state()["candidate"]["components"])

    def test_a_batch_for_another_machine(self):
        tgz = self.art / "desk-rtc-2.0.tgz"
        native_tgz(tgz, "desk-rtc", "2.0")
        self.assertEqual(self.fetch(self.batch([("desk-rtc", "2.0", tgz)], extra={"arch": "amd64"})), "refused arch")

    def test_expiring_urls_are_asked_for_again(self):
        tgz = self.art / "desk-rtc-2.0.tgz"
        native_tgz(tgz, "desk-rtc", "2.0")
        o = dict(self.batch([("desk-rtc", "2.0", tgz)]), expiresAt=T.utc(time.time() + 60))
        with self.assertRaises(BT.UrlsWanted):
            BT.fetch(o)
        self.assertEqual(BT.read_fetch_status()["state"], "urlsWanted")
        self.assertIsNone(BT.load_state()["pending"])


class StoreAndCanary(Base):
    def install_candidate(self, seq=10, ver="2.0", comps=("desk-rtc",)):
        items = []
        for c in comps:
            tgz = self.art / f"{c}-{ver}.tgz"
            native_tgz(tgz, c, ver)
            items.append((c, ver, tgz))
        self.assertEqual(self.fetch(self.batch(items, seq=seq)), "installed")

    def test_the_canary_then_the_promote(self):
        self.rec(1)
        self.rec(2)
        self.rec(3, state="fresh", deskId=None)
        self.install_candidate()
        self.assertIsNone(BT.plan(3), "a fresh root never trials a candidate")
        p1 = BT.plan(1)
        self.assertEqual((p1["role"], p1["seq"], [c["name"] for c in p1["components"]]), ("candidate", 10, ["desk-rtc"]))
        self.assertEqual(p1["components"][0], {"name": "desk-rtc", "from": "1.0", "to": "2.0"})
        self.assertIsNone(BT.plan(2), "only one slot goes first")
        self.assertEqual(BT.promote(10), "promote ordered; waiting for the canary's smoke test")
        self.assertEqual(self.links("desk-rtc"), {"current": "1.0", "candidate": "2.0"})
        self.assertEqual(BT.finish(1, p1), "passed and promoted")
        self.assertEqual(self.links("desk-rtc"), {"current": "2.0", "previous": "1.0"})
        self.assertEqual(BT.load_state()["current"]["seq"], 10)
        self.assertEqual((BT.load_state()["previous"]["id"], BT.load_state()["previous"]["components"]["desk-rtc"]["version"]), ("image", "1.0"),
                         "the first promote's previous is the image's pinned set, which verify then holds the previous links to")
        p2 = BT.plan(2)
        self.assertEqual((p2["role"], p2["components"]), ("current", [{"name": "desk-rtc", "from": "1.0", "to": "2.0"}]))
        self.assertEqual(BT.plan(3)["role"], "current", "a fresh root follows current after a promote")
        self.assertIsNone(BT.plan(1), "the canary is on it")
        r = self.release("verify")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("1.0", self.store("desk-rtc"), "previous is kept for a rollback")
        BT.gc()
        self.assertIn("1.0", self.store("desk-rtc"))

    def test_a_rollback_halts_the_batch_on_the_host(self):
        self.rec(1)
        self.rec(2)
        self.install_candidate()
        p1 = BT.plan(1)
        BT.rolled_back(1, p1, "desk-rtc failed its smoke test")
        st = BT.load_state()
        self.assertIsNone(st["candidate"])
        self.assertEqual([h["seq"] for h in st["halted"]], [10])
        self.assertEqual(BT.promote(10), "not the candidate")
        self.assertIsNone(BT.plan(2), "no other slot starts it")
        r = BT.record(1)
        self.assertEqual((r["batch"]["state"], r["batch"]["tried"], r["rolledBack"], r["releases"]["desk-rtc"]), ("rolled-back", 10, [10], "1.0"))
        self.assertEqual(self.links("desk-rtc"), {"current": "1.0"})
        BT.gc()
        self.assertEqual(self.store("desk-rtc"), ["1.0", "current"], "the halted release goes once nothing names it")
        self.assertEqual(self.fetch(self.batch([("desk-rtc", "2.0", self.art / "desk-rtc-2.0.tgz")], seq=10)), "refused seq", "never again")
        self.assertEqual(BT.report_slot(1, BT.record(1))["batch"], {"seq": 10, "state": "rolled-back"})
        self.assertIsNone(BT.plan(1), "and nothing is due: the slot is back on the set it had")

    def test_a_stop_paths_rollback_at_the_wake_names_the_set_it_had(self):
        self.rec(1)
        self.install_candidate()
        p = BT.plan(1)
        BT.record_update(1, lambda r: r.update(releases=dict(BT.rec_releases(r), **{"desk-rtc": "2.0"}),
                                               batch={"seq": 10, "state": "verify", "fromSeq": 0}, verify=dict(p, phase="swapped")))
        BT.rolled_back(1, p, "desk-rtc failed its smoke test at the wake")
        r = BT.record(1)
        self.assertEqual((r["batch"]["seq"], r["batch"]["tried"], r["releases"]["desk-rtc"], r.get("verify")), (0, 10, "1.0", None))
        self.assertEqual(BT.report_slot(1, r)["batch"], {"seq": 10, "state": "rolled-back"})

    def test_batch_halt_from_platform(self):
        self.rec(1)
        self.install_candidate()
        self.assertEqual(BT.halt(10, "batch_halt"), "halted (the candidate)")
        self.assertIsNone(BT.plan(1))

    def test_a_promoted_batch_and_then_a_rollback_batch(self):
        self.rec(1)
        self.install_candidate()
        BT.finish(1, BT.plan(1))
        self.assertEqual(BT.promote(10), "promoted")
        # 3.5: going back is a higher seq naming the older versions; the store has them as previous: nothing downloaded
        o = self.batch([("desk-rtc", "1.0", self.art / "desk-rtc-1.0.tgz")], seq=11)
        os.unlink(self.art / "desk-rtc-1.0.tgz")   # nothing to download: it's in the store
        self.assertEqual(self.fetch(o), "installed")
        self.assertEqual(self.links("desk-rtc"), {"current": "2.0", "previous": "1.0", "candidate": "1.0"})
        p = BT.plan(1)
        self.assertEqual(p["components"], [{"name": "desk-rtc", "from": "2.0", "to": "1.0"}])

    def test_copies_given_up_after_three_tries(self):
        self.rec(1)
        self.install_candidate()
        p = BT.plan(1)
        self.assertTrue(BT.copy_may(1, p))
        BT.copy_failed(1, p, "x")
        self.assertFalse(BT.copy_may(1, p), "an hour apart")
        r = BT.record(1)
        r["batchTries"]["last"] = "2026-01-01T00:00:00Z"
        (T0 / "var/slots/1.json").write_text(json.dumps(r))
        self.assertTrue(BT.copy_may(1, p))
        BT.copy_failed(1, p, "x")
        BT.copy_failed(1, p, "x")
        self.assertFalse(BT.copy_may(1, p))
        self.assertEqual(BT.record(1)["batch"]["state"], "failed")

    def test_the_copy_into_a_slots_rel(self):
        self.rec(1)
        (T0 / "srv/templates/g1/etc").mkdir(parents=True)
        (T0 / "srv/templates/g1/etc/ma-release").write_text("version=0.3.3\n")
        n, _ = BT.copy_release(1, "deskd", "1.0", "g1")
        d = T0 / "srv/slots/1/rel/.new-deskd"
        self.assertGreater(n, 3)
        self.assertEqual((d / "version.env").read_text(), "DESKD_IMAGE_VERSION=0.3.3\n")
        self.assertEqual(BT.rel_tree_hash(str(d)), (T0 / "srv/releases/deskd/1.0/tree.sha256").read_text().strip())

    def test_records_from_before_batches(self):
        self.rec(1)
        self.assertEqual(BT.rec_releases(BT.record(1)), {c: "1.0" for c in COMPS})
        self.assertEqual(BT.report_slot(1, BT.record(1)), {"batch": {"seq": 0, "state": "current"}, "releases": {c: "1.0" for c in COMPS}})

    def test_the_report(self):
        self.rec(1)
        self.install_candidate()
        rep = BT.report_host()
        self.assertEqual(rep["batches"]["candidate"]["seq"], 10)
        self.assertEqual(rep["batches"]["current"], {"seq": 0, "id": "image", "at": None})
        self.assertEqual(rep["batches"]["floor"]["seq"], 10)
        self.assertEqual(rep["batchFetch"]["state"], "installed")
        self.assertEqual(BT.report_slot(1, BT.record(1))["batch"]["state"], "behind")
        (T0 / "run/batch").mkdir()
        (T0 / "run/batch/1.copying").touch()
        self.assertEqual(BT.report_slot(1, BT.record(1))["batch"]["state"], "copying")

    def test_no_switch_without_room_in_the_desk(self):
        cg = T0 / "cg"
        (T0 / "run/1").mkdir(parents=True, exist_ok=True)
        def put(cur, mx, pc, pm, pending=None):
            cg.mkdir(exist_ok=True)
            for f, v in (("memory.current", cur), ("memory.max", mx), ("pids.current", pc), ("pids.max", pm)):
                (cg / f).write_text(f"{v}\n")
            (T0 / "run/1/class.json").write_text(json.dumps({"class": "free", "pending": pending}))
        put(500 << 20, 1 << 30, 100, 512)
        self.assertIsNone(BT.desk_room(1, str(cg), str(T0 / "run")))
        put(1000 << 20, 1 << 30, 100, 512)
        self.assertIn("under its memory.max", BT.desk_room(1, str(cg), str(T0 / "run")))
        put(500 << 20, 1 << 30, 500, 512)
        self.assertIn("under its pids.max", BT.desk_room(1, str(cg), str(T0 / "run")))
        put(500 << 20, "max", 10, "max", pending={"memory.max": 1 << 29})
        self.assertIn("pending", BT.desk_room(1, str(cg), str(T0 / "run")))

    def test_switches_default_live_off(self):
        self.assertEqual(BT.switches(), {"batches": True, "liveSwitches": False})
        (T0 / "run/link/updates.json").write_text('{"batches": true, "liveSwitches": true}')
        self.assertEqual(BT.switches(), {"batches": True, "liveSwitches": True})
        (T0 / "run/link/updates.json").write_text('{"batches": false, "liveSwitches": "yes"}')
        self.assertEqual(BT.switches(), {"batches": False, "liveSwitches": False})


class Unpack(Base):
    """desk-host-release's streamed unpack of a docker-save image."""

    def layered(self):
        l1 = tar_bytes([("app", "dir", None, 0o755), ("app/deskd.jar", "file", b"jar" * 1000, 0o644), ("usr", "dir", None, 0o755),
                        ("usr/lib", "dir", None, 0o755), ("usr/lib/gone", "file", b"x", 0o644), ("usr/lib/opq", "dir", None, 0o755),
                        ("usr/lib/opq/a", "file", b"a", 0o644), ("tmp", "dir", None, 0o1777), ("bin", "dir", None, 0o755),
                        ("bin/su", "file", b"su", 0o4755)])
        l2 = tar_bytes([("usr/lib/.wh.gone", "file", b"", 0o644), ("usr/lib/opq/.wh..wh..opq", "file", b"", 0o644), ("usr/lib/opq/b", "file", b"b", 0o644),
                        ("app/link", "sym", "/app/deskd.jar", 0o777), ("app/hard", "link", "app/deskd.jar", 0o644)], gz=True)
        return l1, l2

    def manifest_for(self, comp, ver, tgz, key=None):
        m = {"format": "ma-desk-batch/1", "seq": 30, "id": "u", "created": "2026-11-11T00:00:00Z", "urgent": False,
             "components": [{"name": comp, "version": ver, "sha256": hashlib.sha256(tgz.read_bytes()).hexdigest()}]}
        mb = json.dumps(m).encode()
        (T0 / "m.json").write_bytes(mb)
        (T0 / "m.sig").write_bytes(sign(key or self.key, mb))

    def test_layers_whiteouts_links_and_owners(self):
        tgz = self.art / "deskd-3.0.tgz"
        image_tgz(tgz, list(self.layered()))
        self.manifest_for("deskd", "3.0", tgz)
        r = self.release("install", "--manifest", str(T0 / "m.json"), "--signature", str(T0 / "m.sig"), str(tgz))
        self.assertEqual(r.returncode, 0, r.stderr)
        root = T0 / "srv/releases/deskd/3.0/rootfs"
        self.assertEqual((root / "app/deskd.jar").read_bytes(), b"jar" * 1000)
        self.assertFalse((root / "usr/lib/gone").exists(), "the whiteout removed it")
        self.assertEqual(sorted(os.listdir(root / "usr/lib/opq")), ["b"], "the opaque whiteout emptied the directory first")
        self.assertEqual(os.readlink(root / "app/link"), "/app/deskd.jar")
        self.assertEqual(os.stat(root / "app/hard").st_ino, os.stat(root / "app/deskd.jar").st_ino)
        self.assertEqual(os.stat(root / "bin/su").st_mode & 0o7777, 0o755, "no set-id bits")
        for d in ("data", "run", "tmp", "proc", "sys", "dev", "desk-host"):
            self.assertTrue((root / d).is_dir())
        rel = T0 / "srv/releases/deskd/3.0"
        self.assertTrue((rel / "image-id").read_text().startswith("sha256:"))
        self.assertEqual((rel / "image.env").read_text(), "JAVA_HOME=/opt/java/openjdk\n", "only the keys a sandbox takes")
        self.assertFalse((rel / "image.tar").exists(), "the image tar never lands on the store")
        self.assertEqual(os.listdir(T0 / "var/dl"), [], "nor stays on the host's root")
        self.assertEqual(BT.link("deskd", "current"), "1.0", "a batch's install moves no link")

    def test_the_whole_read_mutation_gives_the_same_tree(self):
        tgz = self.art / "deskd-3.0.tgz"
        image_tgz(tgz, list(self.layered()))
        self.manifest_for("deskd", "3.0", tgz)
        r = self.release("install", "--manifest", str(T0 / "m.json"), "--signature", str(T0 / "m.sig"), str(tgz))
        a = (T0 / "srv/releases/deskd/3.0/tree.sha256").read_text()
        shutil.rmtree(T0 / "srv/releases/deskd/3.0")
        r = subprocess.run([sys.executable, "-I", str(LIB / "desk-host-release"), "install", "--manifest", str(T0 / "m.json"), "--signature",
                            str(T0 / "m.sig"), str(tgz)], capture_output=True, text=True, env=dict(os.environ, DESK_HOST_RELEASE_WHOLE_READ="1"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((T0 / "srv/releases/deskd/3.0/tree.sha256").read_text(), a)

    def test_refusals(self):
        l1, l2 = self.layered()
        cases = {
            "a layer that isn't its digest": lambda: self.corrupt_layer(l1, l2),
            "a member outside the root": lambda: image_tgz(self.art / "deskd-3.0.tgz", [tar_bytes([("../evil", "file", b"x", 0o644)])]),
            "a device in the artifact": lambda: self.device_tgz(),
            "a hard link outside": lambda: image_tgz(self.art / "deskd-3.0.tgz", [tar_bytes([("a", "link", "../../etc/passwd", 0o644)])]),
        }
        for label, make in cases.items():
            with self.subTest(label=label):
                shutil.rmtree(T0 / "srv/releases/deskd/3.0", ignore_errors=True)
                make()
                tgz = self.art / "deskd-3.0.tgz"
                self.manifest_for("deskd", "3.0", tgz)
                r = self.release("install", "--manifest", str(T0 / "m.json"), "--signature", str(T0 / "m.sig"), str(tgz))
                self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
                self.assertNotIn("3.0", os.listdir(T0 / "srv/releases/deskd"))
        tgz = self.art / "deskd-3.0.tgz"
        image_tgz(tgz, [l1])
        self.manifest_for("deskd", "3.0", tgz, key=self.other_key)
        r = self.release("install", "--manifest", str(T0 / "m.json"), "--signature", str(T0 / "m.sig"), str(tgz))
        self.assertEqual(r.returncode, 3, "the signature is checked again here")
        self.manifest_for("deskd", "3.1", tgz)
        r = self.release("install", "--manifest", str(T0 / "m.json"), "--signature", str(T0 / "m.sig"), str(tgz))
        self.assertEqual(r.returncode, 3, "the file's version isn't the manifest's")

    def corrupt_layer(self, l1, l2):
        img = image_tar([l1, l2])
        bio = io.BytesIO(img)
        out = io.BytesIO()
        with tarfile.open(fileobj=bio) as src, tarfile.open(fileobj=out, mode="w") as dst:
            for m in src.getmembers():
                data = src.extractfile(m).read() if m.isfile() else None
                if m.name.startswith("blobs/") and data and data[:2] == b"\x1f\x8b":
                    data = gzip.compress(gzip.decompress(data) + b"\0" * 512)   # the same files, another digest
                    m.size = len(data)
                dst.addfile(m, io.BytesIO(data) if data is not None else None)
        data = tar_bytes([("./image.tar", "file", out.getvalue(), 0o644)], gz=True)
        (self.art / "deskd-3.0.tgz").write_bytes(data)

    def device_tgz(self):
        bio = io.BytesIO()
        with tarfile.open(fileobj=bio, mode="w:gz") as tf:
            ti = tarfile.TarInfo("./null")
            ti.type = tarfile.CHRTYPE
            tf.addfile(ti)
        (self.art / "deskd-3.0.tgz").write_bytes(bio.getvalue())


class Smoke(unittest.TestCase):
    """smoke.py on fake /proc trees and a fake runc."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = pathlib.Path(self.tmp.name) / "proc"
        self.share = pathlib.Path(self.tmp.name) / "share"
        self.p.mkdir()
        self.state = {"status": "running", "pid": 100}
        self.clock = [1000.0]

    def proc(self, pid, ppid, st="S"):
        d = self.p / str(pid)
        d.mkdir(exist_ok=True)
        (d / "stat").write_text(f"{pid} (java) {st} {ppid} 1 1 0 -1\n")
        return d

    def net(self, pid, udp=(), tcp=(), uid=0):
        d = self.p / str(pid) / "net"
        d.mkdir(exist_ok=True)
        head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        (d / "udp").write_text(head + "".join(f"   0: 00000000:{p:04X} 00000000:0000 07 00000000:00000000 00:00000000 00000000 {uid} 0 1\n" for p in udp))
        (d / "tcp").write_text(head + "".join(f"   0: 00000000:{p:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 {uid} 0 1\n" for p in tcp))

    def run_check(self, svc, timeout=90, since=0.0, mutate=None):
        def sleep(s):
            self.clock[0] += s
            if mutate:
                mutate(self.clock[0])
        return smoke.check(1, svc, since, timeout, base=100000, proc=str(self.p), runc=lambda n: (self.state["status"], self.state["pid"]),
                           share=str(self.share), rtc_ports=(4431, 443), now=lambda: self.clock[0], sleep=sleep)

    def test_a_service_that_stays_up_passes(self):
        self.proc(100, 1)
        self.proc(101, 100)
        ok, why = self.run_check("desk-agent")
        self.assertTrue(ok, why)
        self.assertLess(self.clock[0] - 1000, 30)

    def test_a_crashing_service_fails(self):
        self.proc(100, 1)
        n = [101]

        def crash(t):   # desk-svc restarts it every 3 s: a new pid each time
            shutil.rmtree(self.p / str(n[0]), ignore_errors=True)
            if int(t) % 3 == 0:
                n[0] += 1
                self.proc(n[0], 100)
        self.proc(101, 100)
        ok, why = self.run_check("desk-agent", mutate=crash)
        self.assertFalse(ok)
        self.assertGreaterEqual(self.clock[0] - 1000, 90)

    def test_a_sandbox_that_stopped_fails(self):
        self.state["status"] = "stopped"
        ok, why = self.run_check("desk-notebook", timeout=10)
        self.assertFalse(ok)
        self.assertIn("stopped", why)

    def test_deskd_needs_a_fresh_idle_json_of_its_own(self):
        self.proc(100, 1)
        self.proc(101, 100)
        (self.share / "1/desk").mkdir(parents=True)
        f = self.share / "1/desk/idle.json"
        f.write_text("{}")
        os.utime(f, (500, 500))
        ok, why = self.run_check("deskd", timeout=10, since=900)
        self.assertFalse(ok)
        self.assertIn("not deskd's", why, "another uid's file")
        uid = os.getuid()
        ok, why = smoke.check(1, "deskd", 900, 10, base=uid - 1100, proc=str(self.p), runc=lambda n: ("running", 100), share=str(self.share),
                              now=lambda: self.clock[0], sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s))
        self.assertFalse(ok)
        self.assertIn("from before the switch", why)
        os.utime(f, (950, 950))
        ok, why = smoke.check(1, "deskd", 900, 30, base=uid - 1100, proc=str(self.p), runc=lambda n: ("running", 100), share=str(self.share),
                              now=lambda: self.clock[0], sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s))
        self.assertTrue(ok, why)

    def test_desk_rtc_needs_its_listeners(self):
        self.proc(100, 1)
        self.proc(101, 100)
        self.net(101, udp=(4431,), tcp=(), uid=100000 + 1101)
        ok, why = self.run_check("desk-rtc", timeout=10)
        self.assertFalse(ok)
        self.assertIn("tcp", why)
        self.net(101, udp=(4431,), tcp=(443,), uid=100000 + 1101)
        ok, why = self.run_check("desk-rtc")
        self.assertTrue(ok, why)
        self.net(101, udp=(4431,), tcp=(443,), uid=4242)
        ok, why = self.run_check("desk-rtc", timeout=10)
        self.assertFalse(ok, "another uid's sockets aren't desk-rtc's")

    def test_desk_stream_waiting_is_healthy(self):
        self.proc(100, 1)
        ok, why = self.run_check("desk-stream")
        self.assertTrue(ok, why)

    def test_a_frozen_check_doesnt_count_the_freeze(self):
        self.proc(100, 1)
        self.proc(101, 100)
        jumps = [True]

        def freeze(t):
            if jumps[0]:
                jumps[0] = False
                self.clock[0] += 120   # frozen for two minutes (a pre-read)
        ok, why = self.run_check("desk-agent", mutate=freeze)
        self.assertTrue(ok, why)

    def test_the_windows_and_ports(self):
        run = pathlib.Path(self.tmp.name) / "run"
        (run / "1").mkdir(parents=True)
        (run / "1/desk-rtc.conf").write_text("port=4431\ntcp_port=443\nslot=1\n")
        self.assertEqual(smoke.rtc_ports(1, str(run)), (4431, 443))
        self.assertEqual(smoke.rtc_ports(2, str(run)), (443, 443))
        (run / "1/class.json").write_text('{"class": "free"}')
        self.assertEqual(smoke.window(1, str(run)), 180)
        self.assertEqual(smoke.window(2, str(run)), 90)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=1)
    finally:
        TMP.cleanup()
