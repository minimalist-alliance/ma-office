#!/usr/bin/python3 -I
"""ADR 0078 section 7: a shared host's copy of desk-batch's checks (image/host/.../batchsig.py) and desk-batch's own
(image/recipe/.../desk-batch) take the same test vectors to the same verdict, so the two can't drift. No root; real openssl and P-256
keys made per run. python3 -I image/tests/test_batch_parity.py"""
import base64
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parent.parent
DESK_BATCH = ROOT / "recipe/files/usr/local/lib/ma/desk-batch"
HOST_LIB = ROOT / "host/recipe/files/usr/local/lib/desk-host"


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def keypair(d, name, curve="prime256v1"):
    key, pub = d / f"{name}.key", d / f"{name}.pem"
    subprocess.run(["openssl", "ecparam", "-name", curve, "-genkey", "-noout", "-out", str(key)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(pub)], check=True, capture_output=True)
    return key, pub


def sign(key, data):
    return subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(key)], input=data, check=True, capture_output=True).stdout


GOOD = {"format": "ma-desk-batch/1", "seq": 5, "id": "b-5", "created": "2026-11-11T00:00:00Z", "urgent": False,
        "components": [{"name": "deskd", "version": "2026.11.10-ff58751", "sha256": "a" * 64}], "note": "a fix"}


def manifests():
    """(label, bytes) for every vector: good ones, every field desk-batch refuses, and the JSON it won't read."""
    g = GOOD
    c0 = g["components"][0]
    out = [("good", json.dumps(g).encode()), ("unknown field", json.dumps({**g, "later": {"x": 1}}).encode()),
           ("arch amd64", json.dumps({**g, "arch": "amd64"}).encode()), ("image", json.dumps({**g, "image": "0.3.4"}).encode())]
    bad = [({**g, "format": "ma-desk-batch/2"}, "format"), ({**g, "seq": True}, "seq bool"), ({**g, "seq": 0}, "seq 0"),
           ({**g, "seq": 1.5}, "seq float"), ({**g, "seq": 2 ** 53 + 1}, "seq big"), ({**g, "id": "a b"}, "id"),
           ({**g, "created": "2026-11-09 18:00"}, "created"), ({**g, "urgent": "no"}, "urgent"), ({**g, "image": "../x"}, "image"),
           ({**g, "arch": "riscv64"}, "arch"), ({**g, "note": "bell\x07"}, "note"), ({**g, "note": "x" * 2001}, "note long"),
           ({**g, "components": []}, "components none"), ({**g, "components": [c0] * 17}, "components 17"),
           ({**g, "components": [c0, c0]}, "twice"), ({**g, "components": [{**c0, "name": "bin"}]}, "reserved"),
           ({**g, "components": [{**c0, "name": "Desk"}]}, "name"), ({**g, "components": [{**c0, "sha256": "AB" * 32}]}, "sha256"),
           ({**g, "components": [{**c0, "version": "a/b"}]}, "version"), ({**g, "components": ["deskd"]}, "component string")]
    out += [(f"bad {what}", json.dumps(m).encode()) for m, what in bad]
    out += [("repeated key", b'{"format": "ma-desk-batch/1", "seq": 5, "seq": 6}'), ("NaN", b'{"seq": NaN}'), ("array", b"[]"),
            ("not utf-8", b"\xff"), ("huge", b'{"note": "' + b"x" * (64 * 1024) + b'"}')]
    return out


class Parity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.umask(0o022)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.t = pathlib.Path(cls.tmp.name)
        cls.key, cls.pub = keypair(cls.t, "good")
        cls.other_key, cls.other_pub = keypair(cls.t, "other")
        cls.p384_key, cls.p384_pub = keypair(cls.t, "p384", "secp384r1")
        cls.db = load(DESK_BATCH, "desk_batch_parity")
        sys.path.insert(0, str(HOST_LIB))
        cls.bs = load(HOST_LIB / "batchsig.py", "batchsig_parity")
        for m in (cls.db, cls.bs):
            m.KEY_OWNER = os.getuid()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def verdict(self, mod, fn, *a):
        try:
            r = fn(*a)
            return ("ok", json.dumps(r, sort_keys=True, default=str) if not isinstance(r, str) else os.path.basename(r))
        except mod.Refused as e:
            return ("refused", e.code)

    def test_manifests(self):
        n = 0
        for label, data in manifests():
            with self.subTest(label=label):
                self.assertEqual(self.verdict(self.db, self.db.check_manifest, data), self.verdict(self.bs, self.bs.check_manifest, data))
                n += 1
        self.assertGreater(n, 25)
        self.assertEqual(self.verdict(self.bs, self.bs.check_manifest, manifests()[0][1])[0], "ok")

    def test_signatures(self):
        data = json.dumps(GOOD).encode()
        der = sign(self.key, data)
        vectors = [("der", der), ("base64", base64.b64encode(der)), ("base64 with newline", base64.b64encode(der) + b"\n"),
                   ("garbage", b"not a signature"), ("short", b"\x30\x01"), ("too long", b"\x30" + b"\x00" * 600),
                   ("other key", sign(self.other_key, data)), ("another body", sign(self.key, data + b" "))]
        keydir = self.t / "keys"
        keydir.mkdir(exist_ok=True)
        shutil.copy(self.pub, keydir / "good.pem")
        shutil.copy(self.p384_pub, keydir / "p384.pem")
        for d in (self.db, self.bs):
            self.assertEqual([os.path.basename(k) for k in d.trusted_keys([str(keydir)])], ["good.pem"], "a P-384 key is skipped by both")
        for label, sig in vectors:
            with self.subTest(label=label):
                a = self.verdict(self.db, lambda s: self.db.verify_signature(data, self.db.decode_signature(s), self.db.trusted_keys([str(keydir)])), sig)
                b = self.verdict(self.bs, lambda s: self.bs.verify_signature(data, self.bs.decode_signature(s), self.bs.trusted_keys([str(keydir)])), sig)
                self.assertEqual(a, b)
        for d in (self.db, self.bs):
            with self.assertRaises(d.Refused) as c:
                d.verify_signature(data, der, [])
            self.assertEqual(c.exception.code, "untrusted")

    def test_key_directories_others_could_write(self):
        d = self.t / "loose"
        d.mkdir(exist_ok=True)
        shutil.copy(self.pub, d / "good.pem")
        os.chmod(d, 0o777)
        self.assertEqual(self.db.trusted_keys([str(d)]), self.bs.trusted_keys([str(d)]))
        self.assertEqual(self.bs.trusted_keys([str(d)]), [])
        os.chmod(d, 0o755)
        os.chmod(d / "good.pem", 0o666)
        self.assertEqual(self.db.trusted_keys([str(d)]), self.bs.trusted_keys([str(d)]))
        self.assertEqual(self.bs.trusted_keys([str(d)]), [])

    def test_baselines(self):
        cases = [("absent", None), ("object", b'{"seq": 42}'), ("number", b"7"), ("negative", b'{"seq": -1}'), ("not json", b"x"),
                 ("too big", b'{"seq": ' + str(2 ** 53 + 1).encode() + b"}")]
        for label, body in cases:
            with self.subTest(label=label):
                p = self.t / f"baseline-{label.replace(' ', '-')}"
                if body is not None:
                    p.write_bytes(body)
                self.db.BASELINE = str(p)
                self.assertEqual(self.db.baseline(), self.bs.baseline(str(p)))

    def test_the_host_verifies_signature_first_then_the_fields(self):
        """batchsig.verify: the signature over the exact bytes before anything reads them (1.3 step 1); then desk-batch's fields."""
        keydir = self.t / "keys2"
        keydir.mkdir(exist_ok=True)
        shutil.copy(self.pub, keydir / "good.pem")
        keys = self.bs.trusted_keys([str(keydir)])
        bad = json.dumps({**GOOD, "format": "x"}).encode()
        with self.assertRaises(self.bs.Refused) as c:
            self.bs.verify(bad, sign(self.other_key, bad), keys)
        self.assertEqual(c.exception.code, "untrusted", "a bad manifest with a bad signature is refused for its signature")
        with self.assertRaises(self.bs.Refused) as c:
            self.bs.verify(bad, sign(self.key, bad), keys)
        self.assertEqual(c.exception.code, "bad_request")
        m, k = self.bs.verify(json.dumps(GOOD).encode(), sign(self.key, json.dumps(GOOD).encode()), keys)
        self.assertEqual((m["seq"], os.path.basename(k)), (5, "good.pem"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
