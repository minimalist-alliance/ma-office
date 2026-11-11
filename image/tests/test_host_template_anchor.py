#!/usr/bin/python3 -I
"""The template signing key's trust anchor (ADR 0077 PU-9; the Security Analyst's Medium on the ADR 0077/0078 read, 2026-11-11: the host
recipe pinned whatever .pem was staged). image/host/recipe/template-keys.sha256 is committed; recipe/template-key-check holds a keys
directory to it (build.sh, staged and installed; bake.sh before launching, with KMS's public half); verify-template-anchor.sh holds a
booted host's pin to it. Temporary trees owned by the test's own user, a fake `aws` and a fake desk-host-check; no root, no AWS, no host.
python3 -I image/tests/test_host_template_anchor.py"""
import base64
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
HOST = IMAGE / "host"
RECIPE = HOST / "recipe"
CHECK = RECIPE / "template-key-check"
ANCHOR = RECIPE / "template-keys.sha256"
KEYS = RECIPE / "files/etc/desk-host/template-keys"
KEY = "ma-host-template-2026-11.pem"
OPENSSL = "/usr/bin/openssl"


def sh(*args, **kw):
    return subprocess.run(list(args), capture_output=True, text=True, timeout=60, **kw)


def new_key(path, curve="prime256v1"):
    """The public half of a fresh key on this curve, written to path."""
    priv = sh(OPENSSL, "ecparam", "-name", curve, "-genkey", "-noout").stdout
    pub = subprocess.run([OPENSSL, "ec", "-pubout"], input=priv.encode(), capture_output=True, check=True).stdout
    pathlib.Path(path).write_bytes(pub)
    return priv


def der(path):
    return subprocess.run([OPENSSL, "pkey", "-pubin", "-in", str(path), "-outform", "DER"], capture_output=True, check=True).stdout


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


class Committed(unittest.TestCase):
    """What's in the repo: the anchor names exactly the committed key, which is a P-256 public key."""

    def test_anchor_is_the_committed_key(self):
        self.assertEqual(ANCHOR.read_text(), f"{sha(KEYS / KEY)}  {KEY}\n")
        self.assertEqual(sorted(os.listdir(KEYS)), [KEY])
        self.assertTrue(ANCHOR.read_text().startswith("d8929c31") and ANCHOR.read_text().split()[0].endswith("c0ec"))

    def test_committed_dir_passes(self):
        r = sh(sys.executable, "-I", str(CHECK), str(KEYS), str(ANCHOR))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("exactly the anchor's, P-256", r.stdout)


class BuildCheck(unittest.TestCase):
    """template-key-check on a fake staged directory: the right key passes; a wrong key, an extra file, a missing file, a link and
    the rest each fail, with the reason named."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.d = self.tmp / "template-keys"
        self.d.mkdir()
        shutil.copy2(KEYS / KEY, self.d / KEY)
        self.anchor = self.tmp / "template-keys.sha256"
        shutil.copy2(ANCHOR, self.anchor)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_check(self, *extra, d=None, anchor=None):
        return sh(sys.executable, "-I", str(CHECK), str(d or self.d), str(anchor or self.anchor), *extra)

    def refused(self, why, **kw):
        r = self.run_check(**kw)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn(why, r.stderr)
        return r

    def test_right_key_passes(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"{KEY} (d8929c31…c0ec)", r.stdout)

    def test_wrong_key_fails(self):   # another P-256 key under the anchored name: the substitution the finding names
        new_key(self.d / KEY)
        self.refused(f"{KEY}: SHA-256")

    def test_extra_file_fails(self):
        new_key(self.d / "ma-host-template-2027-01.pem")
        self.refused("ma-host-template-2027-01.pem: not in the anchor")

    def test_extra_non_pem_and_dot_file_fail(self):
        (self.d / ".hidden.pem").write_bytes((KEYS / KEY).read_bytes())
        self.refused(".hidden.pem: not in the anchor")
        (self.d / ".hidden.pem").unlink()
        (self.d / "README").write_text("x")
        self.refused("README: not in the anchor")

    def test_extra_directory_fails(self):   # a drop-in directory inside
        (self.d / "more.d").mkdir()
        self.refused("more.d: not a regular file")

    def test_missing_file_fails(self):   # no key: a bake with no template key fails now (the old "none until PU-9" path)
        (self.d / KEY).unlink()
        self.refused(f"{KEY}: missing")

    def test_missing_directory_fails(self):
        shutil.rmtree(self.d)
        self.refused("a bake needs the template key")

    def test_link_fails(self):   # the anchored name as a link to the right bytes
        real = self.tmp / "elsewhere.pem"
        shutil.move(self.d / KEY, real)
        (self.d / KEY).symlink_to(real)
        self.refused(f"{KEY}: a link")

    def test_linked_directory_fails(self):
        other = self.tmp / "real-keys"
        shutil.move(self.d, other)
        self.d.symlink_to(other)
        self.refused("isn't a directory (a link)")

    def test_not_p256_fails(self):   # a P-384 key and a private key, each with an anchor naming its own hash
        new_key(self.d / KEY, curve="secp384r1")
        self.anchor.write_text(f"{sha(self.d / KEY)}  {KEY}\n")
        self.refused(f"{KEY}: not a P-256 public key")
        priv = new_key(self.d / KEY)
        (self.d / KEY).write_text(priv)
        self.anchor.write_text(f"{sha(self.d / KEY)}  {KEY}\n")
        self.refused(f"{KEY}: not a P-256 public key")

    def test_empty_anchor_fails(self):
        self.anchor.write_text("")
        self.refused("names no key")

    def test_bad_anchor_lines_fail(self):
        for text in (f"# a comment\n{sha(self.d / KEY)}  {KEY}\n", f"{sha(self.d / KEY)} {KEY}\n", f"{sha(self.d / KEY).upper()}  {KEY}\n",
                     f"{sha(self.d / KEY)}  ../{KEY}\n", f"{sha(self.d / KEY)}  {KEY}\n{sha(self.d / KEY)}  {KEY}\n"):
            self.anchor.write_text(text)
            r = self.run_check()
            self.assertEqual(r.returncode, 1, text)

    def test_missing_anchor_fails(self):
        self.anchor.unlink()
        self.refused("no anchor")

    def test_kms_der_matching_passes(self):
        k = self.tmp / "kms.der"
        k.write_bytes(der(KEYS / KEY))
        r = self.run_check("--kms-der", str(k))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"KMS's public key is {KEY}", r.stdout)

    def test_kms_der_other_key_fails(self):
        new_key(self.tmp / "other.pem")
        k = self.tmp / "kms.der"
        k.write_bytes(der(self.tmp / "other.pem"))
        r = self.run_check("--kms-der", str(k))
        self.assertEqual(r.returncode, 1)
        self.assertIn("isn't the KMS key's public half", r.stderr)


class BuildScript(unittest.TestCase):
    """recipe/build.sh runs the check on the staged files/ before it makes anything and on the installed directory before it pins,
    stops on either, and the pin is the anchor; the old path that baked with no key is gone."""

    def setUp(self):
        self.b = (RECIPE / "build.sh").read_text()

    def test_checked_before_anything_is_made(self):
        staged = self.b.index('template-key-check" "$HERE/files/etc/desk-host/template-keys" "$TK_ANCHOR"')
        self.assertLess(staged, self.b.index("mkfs.ext4"))
        self.assertIn("|| die \"the staged template keys aren't exactly the committed anchor", self.b[staged:staged + 300])

    def test_installed_checked_then_the_anchor_is_the_pin(self):
        inst = self.b.index('template-key-check" /etc/desk-host/template-keys "$TK_ANCHOR"')
        pin = self.b.index('install -m 644 "$TK_ANCHOR" $LIB/template-keys.sha256')
        self.assertLess(self.b.index("tar -C / -xf -"), inst)
        self.assertLess(inst, pin)
        self.assertLess(pin, self.b.index("desk-host-check --only"))
        self.assertIn("|| die", self.b[inst:pin])

    def test_no_bake_without_a_key(self):
        self.assertNotIn("none until", self.b)
        self.assertNotIn("template-keys/* 2>/dev/null || true", self.b)
        self.assertNotIn('for f in *.pem; do [ -f "$f" ] && echo "$(sha256sum "$f" | cut -d\' \' -f1)  $f"; done; true) > $LIB/template-keys', self.b)


class BakeKms(unittest.TestCase):
    """bake.sh's KMS step, run alone with a fake `aws` on PATH: alias/ma-host-template's public half matching the committed key goes
    on; another key stops the bake; AccessDenied skips only the KMS half, loudly, naming the permission; any other error stops it."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        b = (HOST / "bake.sh").read_text().splitlines()
        start = next(i for i, l in enumerate(b) if l.startswith("# ADR 0077 PU-9: the template signing key, before anything"))
        end = next(i for i in range(start, len(b)) if b[i] == 'rm -f "$TK_DER" "$TK_ERR"')
        self.block = self.tmp / "block.sh"
        self.block.write_text("\n".join(b[start:end + 1]) + "\n")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def fake_aws(self, out="", err="", rc=0):
        (self.tmp / "out").write_text(out)
        (self.tmp / "err").write_text(err)
        a = self.bin / "aws"
        a.write_text(f"#!/bin/bash\n[ \"$1 $2\" = 'kms get-public-key' ] || exit 99\ncat '{self.tmp}/out'; cat '{self.tmp}/err' >&2; exit {rc}\n")
        a.chmod(0o755)

    def bake(self, here=HOST):
        script = f'set -euo pipefail; HERE="{here}"; . "{IMAGE}/lib.sh"; . "{self.block}"; echo CONTINUED'
        return sh("bash", "-c", script, env=dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}"))

    def test_kms_matches(self):
        self.fake_aws(base64.b64encode(der(KEYS / KEY)).decode() + "\n")
        r = self.bake()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("CONTINUED", r.stdout)
        self.assertIn(f"KMS's public key is {KEY}", r.stderr)

    def test_kms_differs_stops(self):
        new_key(self.tmp / "other.pem")
        self.fake_aws(base64.b64encode(der(self.tmp / "other.pem")).decode() + "\n")
        r = self.bake()
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("CONTINUED", r.stdout)
        self.assertIn("isn't alias/ma-host-template's public half", r.stderr)

    def test_access_denied_skips_loudly(self):
        self.fake_aws(err="An error occurred (AccessDeniedException) when calling the GetPublicKey operation: not authorized\n", rc=254)
        r = self.bake()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("CONTINUED", r.stdout)
        self.assertIn("WARNING", r.stderr)
        self.assertIn("lacks kms:GetPublicKey on alias/ma-host-template", r.stderr)

    def test_other_error_stops(self):
        self.fake_aws(err="An error occurred (NotFoundException) when calling the GetPublicKey operation: Alias not found\n", rc=254)
        r = self.bake()
        self.assertEqual(r.returncode, 1)
        self.assertIn("(NotFoundException): no bake", r.stderr)

    def test_committed_key_off_anchor_stops_before_kms(self):   # the anchor check comes first; aws is never asked
        here = self.tmp / "host"
        shutil.copytree(RECIPE, here / "recipe", ignore=shutil.ignore_patterns("releases", "__pycache__"))
        new_key(here / "recipe/files/etc/desk-host/template-keys" / KEY)
        self.fake_aws(rc=99)
        r = self.bake(here)
        self.assertEqual(r.returncode, 1)
        self.assertIn("isn't exactly its anchor", r.stderr)


class VerifyStep(unittest.TestCase):
    """verify-template-anchor.sh on fake hosts (its paths pointed at a temporary tree) with a fake desk-host-check whose template-sig,
    like the real one, compares the keys directory only with the host's own pin."""

    FAKE_CHECK = r'''#!/bin/bash
L=$(dirname "$0"); D=$DESK_HOST_TEMPLATE_KEYS
have=$(cd "$D" 2>/dev/null && LC_ALL=C ls -A | while read -r f; do echo "$(sha256sum < "$f" | cut -d' ' -f1)  $f"; done)
if [ -f "$L/template-keys.sha256" ] && [ "$have" = "$(cat "$L/template-keys.sha256")" ]; then
  echo "PASS host template-sig: $(echo "$have" | grep -c .) pinned key(s)"; else echo "FAIL host template-sig: keys aren't the pinned"; exit 1; fi
'''

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.lib = self.tmp / "lib"
        self.keys = self.tmp / "template-keys"
        self.lib.mkdir()
        (self.lib / "desk-host-check").write_text(self.FAKE_CHECK)
        (self.lib / "desk-host-check").chmod(0o755)
        self.b64 = base64.b64encode(ANCHOR.read_bytes()).decode()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def host(self, shape):
        """0.1.13's shape (the committed key, pinned), 0.1.12's (the template path, no key pinned), 0.1.11's (no template path)."""
        if shape in ("0.1.13", "0.1.12"):
            (self.lib / "desk-host-template").write_text("#!/bin/sh\n")
            self.keys.mkdir()
        if shape == "0.1.13":
            shutil.copy2(KEYS / KEY, self.keys / KEY)
            shutil.copy2(ANCHOR, self.lib / "template-keys.sha256")
        if shape == "0.1.12":
            (self.lib / "template-keys.sha256").write_text("")

    def run_step(self, mode):
        env = dict(os.environ, DESK_HOST_LIB=str(self.lib), DESK_HOST_TEMPLATE_KEYS=str(self.keys), VTA_WORK=str(self.tmp / "w"))
        r = sh("bash", str(HOST / "verify-template-anchor.sh"), mode, self.b64, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout.splitlines()

    def test_anchored_host_passes(self):
        self.host("0.1.13")
        out = self.run_step("check")
        self.assertIn("ANCHOR PASS", out)

    def test_host_with_no_key_pinned_fails(self):   # 0.1.12: right to fail, it trusts no template key at all
        self.host("0.1.12")
        out = self.run_step("check")
        self.assertIn("ANCHOR FAIL", out)

    def test_host_with_no_template_path_is_a_skip(self):   # 0.1.11
        self.host("0.1.11")
        out = self.run_step("check")
        self.assertIn("ANCHOR NOT APPLICABLE", out)
        self.assertNotIn("ANCHOR PASS", out)
        self.assertNotIn("ANCHOR FAIL", out)

    def test_substituted_key_baked_in_fails(self):   # a bake that pinned whatever was staged: template-sig passes, the anchor doesn't
        self.host("0.1.13")
        new_key(self.keys / KEY)
        (self.lib / "template-keys.sha256").write_text(f"{sha(self.keys / KEY)}  {KEY}\n")
        out = self.run_step("check")
        self.assertTrue(any(l.startswith("template-sig: PASS") for l in out), out)
        self.assertIn("ANCHOR FAIL", out)

    def test_mutation_fails_then_restores(self):
        self.host("0.1.13")
        before = {p.name: p.read_bytes() for p in (self.keys / KEY, self.lib / "template-keys.sha256")}
        out = self.run_step("mutation")
        self.assertIn("MUTATED ANCHOR FAIL", out)
        self.assertTrue(any(l.startswith("template-sig on it: PASS") for l in out), out)   # the gap only the anchor closes
        self.assertIn("RESTORE PASS", out)
        self.assertEqual(before, {p.name: p.read_bytes() for p in (self.keys / KEY, self.lib / "template-keys.sha256")})
        self.assertFalse((self.tmp / "w").exists())

    def test_mutation_refuses_an_unanchored_host(self):
        self.host("0.1.12")
        env = dict(os.environ, DESK_HOST_LIB=str(self.lib), DESK_HOST_TEMPLATE_KEYS=str(self.keys), VTA_WORK=str(self.tmp / "w"))
        r = sh("bash", str(HOST / "verify-template-anchor.sh"), "mutation", self.b64, env=env)
        self.assertEqual(r.returncode, 2)
        self.assertNotIn("RESTORE PASS", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
