"""Unit tests for tools/template (ADR 0077 1.1's artifact): no machine, no root, no AWS. python3 -m unittest discover -s tools/template/tests"""
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
import tmpl  # noqa: E402

SHA0 = "0" * 64


def _write(path, mode, data):
    with open(path, mode) as f:
        f.write(data)


def _read(path):
    with open(path, "rb") as f:
        return f.read()


def tree(root):
    """A small tree with what a template has: nested directories, a sticky 1777 directory, a group-writable setgid one, a
    set-uid file, a relative and an absolute link (both inside), a hard link and an empty file."""
    os.makedirs(f"{root}/etc/ma")
    os.makedirs(f"{root}/usr/bin")
    os.makedirs(f"{root}/tmp")
    os.makedirs(f"{root}/var/mail")
    _write(f"{root}/etc/passwd", "w", "root:x:0:0::/root:/bin/sh\n")
    open(f"{root}/etc/ma/empty", "w").close()
    _write(f"{root}/usr/bin/tool", "w", "#!/bin/sh\necho hi\n")
    os.chmod(f"{root}/usr/bin/tool", 0o4755)
    os.link(f"{root}/usr/bin/tool", f"{root}/usr/bin/tool2")
    os.symlink("usr/bin", f"{root}/bin")
    os.symlink("/run/desk-host/desk-rtc.conf", f"{root}/etc/ma/desk-rtc.conf")
    os.chmod(f"{root}/tmp", 0o1777)
    os.chmod(f"{root}/var/mail", 0o2775)
    _write(f"{root}/.complete", "w", "host-template=x\n")


def zst(tar_bytes, out):
    with open(out, "wb") as f:
        subprocess.run(["zstd", "-q", "-c"], input=tar_bytes, stdout=f, check=True)


def keypair(d, name, curve="prime256v1"):
    k = os.path.join(d, f"{name}.pem")
    subprocess.run(["openssl", "ecparam", "-name", curve, "-genkey", "-noout", "-out", k], check=True, capture_output=True)
    p = os.path.join(d, f"{name}.pub.pem")
    tmpl.public_pem(k, p)
    return k, p


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="tmpl-test-")
        self.src = os.path.join(self.d, "src")
        os.mkdir(self.src)
        tree(self.src)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)


class ManifestTest(Base):
    def test_walk_records_the_tree_as_it_is_and_clear_setid_clears(self):
        es = tmpl.walk(self.src)
        by = {e["path"]: e for e in es}
        self.assertEqual(es[0]["path"], ".")
        self.assertNotIn(".complete", by)
        self.assertEqual(by["usr/bin/tool"]["mode"], 0o4755)       # as on disk (g1's own manifest keeps them)
        self.assertEqual(by["tmp"]["mode"], 0o1777)                # sticky kept
        self.assertEqual(by["bin"], {"path": "bin", "type": "link", "mode": 0o777, "uid": os.getuid(), "gid": os.getgid(), "target": "usr/bin"})
        self.assertEqual(by["usr/bin/tool"]["sha256"], by["usr/bin/tool2"]["sha256"])
        self.assertEqual(by["etc/ma/empty"]["size"], 0)
        self.assertEqual(sorted(tmpl.clear_setid(self.src)), ["usr/bin/tool", "usr/bin/tool2", "var/mail"])   # each name of an inode with the bit
        by = {e["path"]: e for e in tmpl.walk(self.src)}
        self.assertEqual((by["usr/bin/tool"]["mode"], by["usr/bin/tool2"]["mode"], by["var/mail"]["mode"], by["tmp"]["mode"]), (0o755, 0o755, 0o775, 0o1777))

    def test_order_is_depth_first_by_name(self):
        for n in ("a-c", "a/b"):
            os.makedirs(os.path.join(self.src, n))
        paths = [e["path"] for e in tmpl.walk(self.src)]
        self.assertLess(paths.index("a"), paths.index("a/b"))
        self.assertLess(paths.index("a/b"), paths.index("a-c"))   # a byte sort would put a-c first

    def test_canonical_bytes_parse_back(self):
        es = tmpl.walk(self.src)
        tmpl.clear_setid(self.src)
        es = tmpl.walk(self.src)
        data = tmpl.manifest_bytes(es)
        self.assertTrue(data.endswith(b"\n") and b"\n" not in data[:-1] and b": " not in data)
        self.assertTrue(data.startswith(b'{"entries":[{"gid":'))
        got, by = tmpl.parse_manifest(data)
        self.assertEqual(got, es)
        self.assertEqual(tmpl.manifest_bytes(got), data)

    def test_parse_refuses_bad_manifests(self):
        tmpl.clear_setid(self.src)
        es = tmpl.walk(self.src)
        good = json.loads(tmpl.manifest_bytes(es))

        def bad(mut, why):
            m = json.loads(json.dumps(good))
            mut(m)
            with self.assertRaises(tmpl.Refused, msg=why):
                tmpl.parse_manifest(json.dumps(m).encode())
        bad(lambda m: m["entries"][3].__setitem__("mode", 0o4755), "a set-id bit")
        bad(lambda m: m["entries"][3].__setitem__("mode", "0755"), "a mode that isn't an integer")
        bad(lambda m: m["entries"].reverse(), "out of order")
        bad(lambda m: m["entries"].append(dict(m["entries"][-1])), "a repeated path")
        bad(lambda m: m["entries"].append({"path": "zz/../../x", "type": "dir", "mode": 0o755, "uid": 0, "gid": 0}), "a path with ..")
        bad(lambda m: m["entries"].append({"path": "zz/nodir", "type": "dir", "mode": 0o755, "uid": 0, "gid": 0}), "no directory above")
        bad(lambda m: m["entries"].append({"path": "zzz", "type": "fifo", "mode": 0o644, "uid": 0, "gid": 0}), "a FIFO")
        bad(lambda m: m["entries"].append({"path": "zzz", "type": "symlink", "mode": 0o777, "uid": 0, "gid": 0, "target": "x"}), "a type the host half doesn't know")
        bad(lambda m: m["entries"][1].__setitem__("extra", 1), "an unknown field")
        bad(lambda m: m.__setitem__("format", "other/1"), "the format")
        with self.assertRaises(tmpl.Refused):
            tmpl.parse_manifest(b'{"format":"ma-host-template-manifest/1","format":"x","entries":[]}')

    def test_walk_refuses_a_fifo(self):
        os.mkfifo(os.path.join(self.src, "etc", "fifo"))
        with self.assertRaises(tmpl.Refused):
            tmpl.walk(self.src)

    def test_compare_names_each_difference(self):
        a = tmpl.walk(self.src)
        open(f"{self.src}/etc/passwd", "a").write("x\n")
        os.unlink(f"{self.src}/etc/ma/empty")
        open(f"{self.src}/etc/new", "w").close()
        d = "\n".join(tmpl.compare(a, tmpl.walk(self.src)))
        self.assertIn("differs etc/passwd", d)
        self.assertIn("missing etc/ma/empty", d)
        self.assertIn("not in the manifest etc/new", d)


class PackUnpackTest(Base):
    def packed(self):
        tmpl.clear_setid(self.src)
        es = tmpl.walk(self.src)
        arc = os.path.join(self.d, "t.tar.zst")
        tmpl.pack(self.src, arc, level=3)
        return es, arc

    def test_round_trip_equals_the_manifest(self):
        es, arc = self.packed()
        out = os.path.join(self.d, "out")
        n = tmpl.unpack(arc, out, es)
        self.assertEqual(n, len(es))
        self.assertEqual(tmpl.compare(es, tmpl.walk(out)), [])
        self.assertFalse(os.path.exists(os.path.join(out, ".complete")))
        self.assertEqual(oct(os.stat(os.path.join(out, "tmp")).st_mode & 0o7777), "0o1777")
        self.assertEqual(os.stat(os.path.join(out, "usr/bin/tool")).st_ino, os.stat(os.path.join(out, "usr/bin/tool2")).st_ino)
        with tarfile.open(fileobj=io.BytesIO(subprocess.run(["zstd", "-dc", arc], capture_output=True, check=True).stdout)) as tf:
            self.assertFalse([m.name for m in tf.getmembers() if m.mode & tmpl.SETID], "nothing packed with a set-id bit")

    def test_refuses_a_member_the_manifest_lacks(self):
        es, arc = self.packed()
        es = [e for e in es if e["path"] != "etc/passwd"]
        with self.assertRaisesRegex(tmpl.Refused, "isn't in the manifest"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es)

    def test_refuses_a_missing_entry(self):
        es, arc = self.packed()
        es = es + [{"path": "zzz", "type": "dir", "mode": 0o755, "uid": os.getuid(), "gid": os.getgid()}]
        with self.assertRaisesRegex(tmpl.Refused, "aren't in the archive"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es)

    def test_refuses_changed_bytes(self):
        es, arc = self.packed()
        for e in es:
            if e["path"] == "etc/passwd":
                e["sha256"] = SHA0
        with self.assertRaisesRegex(tmpl.Refused, "don't hash"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es)

    def test_refuses_a_corrupt_archive(self):
        es, arc = self.packed()
        b = bytearray(_read(arc))
        b[len(b) // 2] ^= 0xFF
        _write(arc, "wb", bytes(b))
        with self.assertRaises(tmpl.Refused):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es)

    def handmade(self, members, extra_entries=()):
        """An archive of hand-made members, and a manifest listing them, to reach refusals a real tree can't make."""
        buf = io.BytesIO()
        es = [{"path": ".", "type": "dir", "mode": 0o755, "uid": 0, "gid": 0}]
        with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
            d = tarfile.TarInfo("./")
            d.type, d.mode = tarfile.DIRTYPE, 0o755
            tf.addfile(d)
            for ti, data, e in members:
                tf.addfile(ti, io.BytesIO(data) if data is not None else None)
                es.append(e)
        arc = os.path.join(self.d, "h.tar.zst")
        zst(buf.getvalue(), arc)
        es += list(extra_entries)
        return arc, es

    def test_refuses_a_link_out_of_the_tree(self):
        ti = tarfile.TarInfo("./evil")
        ti.type, ti.linkname, ti.mode = tarfile.SYMTYPE, "../../etc/shadow", 0o777
        arc, es = self.handmade([(ti, None, {"path": "evil", "type": "link", "mode": 0o777, "uid": 0, "gid": 0, "target": "../../etc/shadow"})])
        with self.assertRaisesRegex(tmpl.Refused, "points out of the tree"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es, as_root=False)

    def test_refuses_a_device(self):
        ti = tarfile.TarInfo("./dev-null")
        ti.type, ti.mode, ti.devmajor, ti.devminor = tarfile.CHRTYPE, 0o666, 1, 3
        arc, es = self.handmade([(ti, None, {"path": "dev-null", "type": "file", "mode": 0o666, "uid": 0, "gid": 0, "size": 0, "sha256": SHA0})])
        with self.assertRaisesRegex(tmpl.Refused, "device"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es, as_root=False)

    def test_refuses_a_path_outside(self):
        ti = tarfile.TarInfo("../outside")
        ti.size, ti.mode = 1, 0o644
        arc, es = self.handmade([(ti, b"x", {"path": "../outside", "type": "file", "mode": 0o644, "uid": 0, "gid": 0, "size": 1, "sha256": SHA0})])
        with self.assertRaises(tmpl.Refused):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es, as_root=False)
        self.assertFalse(os.path.exists(os.path.join(self.d, "outside")))

    def test_refuses_other_xattrs(self):
        ti = tarfile.TarInfo("./f")
        ti.size, ti.mode = 1, 0o644
        ti.pax_headers = {"SCHILY.xattr.user.evil": "1"}
        arc, es = self.handmade([(ti, b"x", {"path": "f", "type": "file", "mode": 0o644, "uid": 0, "gid": 0, "size": 1, "sha256": tmpl.sha256_bytes(b"x")})])
        with self.assertRaisesRegex(tmpl.Refused, "extended attributes"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es, as_root=False)

    def test_refuses_a_setid_member(self):
        ti = tarfile.TarInfo("./f")
        ti.size, ti.mode = 1, 0o4755
        arc, es = self.handmade([(ti, b"x", {"path": "f", "type": "file", "mode": 0o755, "uid": 0, "gid": 0, "size": 1, "sha256": tmpl.sha256_bytes(b"x")})])
        with self.assertRaisesRegex(tmpl.Refused, "mode"):
            tmpl.unpack(arc, os.path.join(self.d, "out"), es, as_root=False)


def header(**kw):
    files = {n: (10, SHA0) for n in tmpl.FILES}
    args = dict(gen="g2", host_image="0.1.10", chromium="156.0.8078.79-1~deb13u1", base=SHA0, files=files, created="2026-11-11T18:00:00Z")
    args.update(kw)
    return tmpl.make_header(**args)


class HeaderTest(unittest.TestCase):
    def test_good(self):
        h = tmpl.parse_header(header(), host_image="0.1.10", gens_had=["g1"], order_sha256=tmpl.sha256_bytes(header()))
        self.assertEqual((h["format"], h["gen"], h["urgent"]), (tmpl.FORMAT, "g2", False))

    def test_refusals(self):
        with self.assertRaisesRegex(tmpl.Refused, "host image"):
            tmpl.parse_header(header(), host_image="0.1.9")
        with self.assertRaisesRegex(tmpl.Refused, "above every"):
            tmpl.parse_header(header(), gens_had=["g1", "g2"])
        with self.assertRaisesRegex(tmpl.Refused, "order"):
            tmpl.parse_header(header(), order_sha256=SHA0)
        with self.assertRaisesRegex(tmpl.Refused, "g2 or later"):
            header(gen="g1")
        h = json.loads(header())
        h["files"].pop(tmpl.PLAN)
        with self.assertRaises(tmpl.Refused):
            tmpl.parse_header(json.dumps(h).encode())
        with self.assertRaisesRegex(tmpl.Refused, "twice"):
            tmpl.parse_header(header()[:-3] + b',\n "gen": "g9"\n}\n')
        with self.assertRaisesRegex(tmpl.Refused, "over 4096"):
            tmpl.parse_header(header() + b" " * 4096)

    def test_pass_record(self):
        hb = header()
        p = {"format": tmpl.PASS_FORMAT, "gen": "g2", "hostImage": "0.1.10", "header": tmpl.sha256_bytes(hb), "result": "pass",
             "checks": [{"name": "a", "result": "pass"}, {"name": "b", "result": "skip"}]}
        tmpl.check_pass(json.dumps(p).encode(), hb)
        for mut in ({"result": "fail"}, {"header": SHA0}, {"checks": [{"name": "a", "result": "fail"}]}, {"gen": "g3"}):
            with self.assertRaises(tmpl.Refused):
                tmpl.check_pass(json.dumps(dict(p, **mut)).encode(), hb)


class SignatureTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="tmpl-sig-")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_sign_and_verify(self):
        k, p = keypair(self.d, "dev")
        _, other = keypair(self.d, "other")
        _, p384 = keypair(self.d, "p384", "secp384r1")
        data = header()
        sig = tmpl.sign_with_key(data, k)
        self.assertEqual(tmpl.verify_sig(data, sig, [other, p]), p)
        with self.assertRaises(tmpl.Refused):
            tmpl.verify_sig(data, sig, [other])
        with self.assertRaises(tmpl.Refused):
            tmpl.verify_sig(data + b" ", sig, [p])
        with self.assertRaisesRegex(tmpl.Refused, "no trusted"):
            tmpl.verify_sig(data, sig, [p384])
        with self.assertRaises(tmpl.Refused):
            tmpl.verify_sig(data, b"", [p])


class VerifyCliTest(Base):
    """template-verify on a local artifact made from the test tree, signed with a dev key."""

    def artifact(self):
        a = os.path.join(self.d, "art")
        os.mkdir(a)
        tmpl.clear_setid(self.src)
        es = tmpl.walk(self.src)
        _write(f"{a}/{tmpl.MANIFEST}", "wb", tmpl.manifest_bytes(es))
        _write(f"{a}/{tmpl.PLAN}", "w", "netbase=6.5+ma1\n")
        tmpl.pack(self.src, f"{a}/{tmpl.ARCHIVE}", level=3)
        files = {n: tmpl.sha256_file(f"{a}/{n}") for n in tmpl.FILES}
        hb = tmpl.make_header("g2", "0.1.10", "156.0.8078.79-1~deb13u1", SHA0, files)
        _write(f"{a}/{tmpl.HEADER}", "wb", hb)
        k, p = keypair(self.d, "dev")
        _write(f"{a}/{tmpl.SIG}", "wb", tmpl.sign_with_key(hb, k))
        return a, p

    def run_cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(TOOLS, "template-verify"), *args], capture_output=True, text=True)

    def test_cli(self):
        a, p = self.artifact()
        r = self.run_cli(a, "--pubkey", p, "--host-image", "0.1.10", "--had", "g1", "--unpack", os.path.join(self.d, "u"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["gen"], "g2")
        self.assertEqual(self.run_cli(a, "--pubkey", p, "--host-image", "0.1.9").returncode, 1)
        self.assertEqual(self.run_cli(a, "--pubkey", p, "--had", "g1,g2").returncode, 1)
        _, other = keypair(self.d, "other")
        r = self.run_cli(a, "--pubkey", other)
        self.assertEqual(r.returncode, 1)
        self.assertIn("signature", r.stderr)
        b = bytearray(_read(f"{a}/{tmpl.ARCHIVE}"))
        b[-5] ^= 1
        _write(f"{a}/{tmpl.ARCHIVE}", "wb", bytes(b))
        r = self.run_cli(a, "--pubkey", p)
        self.assertEqual(r.returncode, 1)
        self.assertIn(tmpl.ARCHIVE, r.stderr)
        self.assertEqual(self.run_cli(a).returncode, 2)


class PresignTest(unittest.TestCase):
    def test_url_signs_the_checksum_header(self):
        import datetime
        creds = {"AccessKeyId": "AKIDEXAMPLE", "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}
        now = datetime.datetime(2026, 11, 11, 18, 0, 0, tzinfo=datetime.timezone.utc)
        u1, h1 = tmpl.presign_put("bucket", "desk/host-template-test/0.1.10/g2/template.tar.zst", "ab" * 32, creds, now=now)
        u2, h2 = tmpl.presign_put("bucket", "desk/host-template-test/0.1.10/g2/template.tar.zst", "cd" * 32, creds, now=now)
        self.assertIn("X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256", u1)
        self.assertTrue(u1.startswith("https://bucket.s3.us-east-1.amazonaws.com/desk/host-template-test/0.1.10/g2/template.tar.zst?"))
        self.assertNotEqual(u1.split("X-Amz-Signature=")[1], u2.split("X-Amz-Signature=")[1])
        self.assertEqual(h1, "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=")


if __name__ == "__main__":
    unittest.main()
