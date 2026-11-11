"""EXP-10: install.sh installs only a bundle, and an installer, that the self-hosted release key signed (ma-selfhost-bundle).

A fake installer folder and bundle, signed with throwaway P-256 keys made here by openssl: one as the release key, one as
the update batch key, which must never vouch for a bundle (Nov 11 follow-up). No root, no network; pin-release-key.sh runs
against a stand-in for aws. Run: python3 -m unittest discover -s selfhost/tests
"""
import hashlib
import importlib.machinery
import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CHECK = os.path.join(HERE, "..", "files", "usr", "local", "lib", "ma", "selfhost", "ma-selfhost-bundle")
INSTALL = os.path.join(HERE, "..", "install.sh")
BUILD = os.path.join(HERE, "..", "build-bundle.sh")
PIN_KEY = os.path.join(HERE, "..", "pin-release-key.sh")
DESK_BATCH = os.path.join(REPO, "image", "recipe", "files", "usr", "local", "lib", "ma", "desk-batch")
BATCH_KEYS = "image/recipe/files/opt/ma/etc/batch-keys"
KEYS = "selfhost/files/opt/ma/etc/selfhost-release-keys"
ANCHOR = "selfhost/release-keys.sha256"
KEY_NAME = "ma-selfhost-release-2026-11.pem"
OPENSSL = "/usr/bin/openssl"


def load():
    loader = importlib.machinery.SourceFileLoader("ma_selfhost_bundle", CHECK)
    spec = importlib.util.spec_from_loader("ma_selfhost_bundle", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def sh(*args):
    subprocess.run(args, check=True, capture_output=True)


def keypair(d, name, curve="prime256v1"):
    priv, pub = os.path.join(d, name + ".key"), os.path.join(d, name + ".pem")
    sh(OPENSSL, "ecparam", "-name", curve, "-genkey", "-noout", "-out", priv)
    sh(OPENSSL, "ec", "-in", priv, "-pubout", "-out", pub)
    return priv, pub


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class Bundle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.priv, cls.pub = keypair(cls.keys.name, "release")
        cls.other_priv, cls.other_pub = keypair(cls.keys.name, "other")
        cls.batch_priv, cls.batch_pub = keypair(cls.keys.name, "batch")
        cls.p384_priv, cls.p384_pub = keypair(cls.keys.name, "p384", "secp384r1")

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.m = load()
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.folder = os.path.join(t, "folder")
        self.bundle = os.path.join(self.folder, "bundle")
        f = self.folder
        write(f"{f}/selfhost/install.sh", "#!/bin/bash\necho install\n")
        write(f"{f}/selfhost/README.md", "guide\n")
        write(f"{f}/selfhost/files/etc/nftables.conf", "flush ruleset\n")
        write(f"{f}/selfhost/files/usr/local/lib/ma/selfhost/ma-selfhost-bundle", "#!/usr/bin/python3\n")
        write(f"{f}/selfhost/e2e/selfhost.spec.ts", "// not installed\n")
        write(f"{f}/image/recipe/build.sh", "#!/bin/bash\n")
        write(f"{f}/image/recipe/files/etc/systemd/system/deskd.service", "[Unit]\n")
        os.makedirs(f"{f}/{BATCH_KEYS}")
        shutil.copy(self.batch_pub, f"{f}/{BATCH_KEYS}/ma-desk-batch-2026-11.pem")   # the batch key rides along, as in the real one
        self.pin_key(self.pub)
        self.arts = {"desk-rtc": ("0.5.0", "desk-rtc-0.5.0-amd64.tgz"), "desk-stream": ("0.3.3", "desk-stream-0.3.3.tgz"),
                     "deskd": ("2026.11.10-ff58751", "deskd-2026.11.10-ff58751-amd64.tgz"),
                     "desk-agent-filter": ("0.1.1", "desk-agent-filter-0.1.1-amd64.tgz")}
        for name, (_, fn) in self.arts.items():
            write(f"{self.bundle}/{fn}", os.urandom(512))
        # The installed desk, for updates: its release key folder, which the test owns in place of root.
        self.installed = os.path.join(t, "installed-keys")
        os.makedirs(self.installed, 0o755)
        os.chmod(self.installed, 0o755)
        shutil.copy(self.pub, f"{self.installed}/{KEY_NAME}")
        os.chmod(f"{self.installed}/{KEY_NAME}", 0o644)
        self.m.INSTALLED_KEYS, self.m.KEY_OWNER = self.installed, os.getuid()
        self.make()

    def tearDown(self):
        self.tmp.cleanup()

    def pin_key(self, pub, name=KEY_NAME):
        """The installer's release key folder holding pub alone, and its anchor, as pin-release-key.sh writes them."""
        d = f"{self.folder}/{KEYS}"
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        shutil.copy(pub, f"{d}/{name}")
        write(f"{self.folder}/{ANCHOR}", f"{sha(pub)}  {name}\n")

    def manifest(self):
        lines = []
        for top in ("selfhost", "image/recipe"):
            for dp, _, fns in os.walk(os.path.join(self.folder, top)):
                for fn in fns:
                    rel = os.path.relpath(os.path.join(dp, fn), self.folder)
                    if re.match(r"selfhost/(e2e|lab|tests)/", rel):
                        continue
                    lines.append(f"{sha(os.path.join(self.folder, rel))}  {rel}")
        lines.sort(key=lambda l: l.split("  ", 1)[1].encode())
        write(f"{self.bundle}/installer.sha256", "\n".join(lines) + "\n")

    def make(self, priv=None, extra_lines=(), baseline=None, sign=True):
        """installer.sha256, bundle.pin (as build-bundle.sh writes them) and its signature."""
        self.manifest()
        pin = ["# ma-selfhost-bundle/1", "# amd64 releases for a self-hosted desk", "# bundle abc1234"]
        for name, (ver, fn) in self.arts.items():
            pin.append(f"{name:<14} {ver:<20} {sha(os.path.join(self.bundle, fn))}")
        pin.append(f"installer      abc1234              {sha(os.path.join(self.bundle, 'installer.sha256'))}")
        if baseline is not None:
            write(f"{self.bundle}/batch-baseline", '{"seq": %d}\n' % baseline)
            pin.append(f"batch-baseline {baseline:<20} {sha(os.path.join(self.bundle, 'batch-baseline'))}")
        pin.extend(extra_lines)
        write(f"{self.bundle}/bundle.pin", "\n".join(pin) + "\n")
        self.sign(priv)
        if not sign:
            os.unlink(f"{self.bundle}/bundle.pin.sig")

    def sign(self, priv=None):
        sh(OPENSSL, "dgst", "-sha256", "-sign", priv or self.priv, "-out", f"{self.bundle}/bundle.pin.sig",
           f"{self.bundle}/bundle.pin")

    def ok(self, installed=False):
        return self.m.verify(self.folder, self.bundle, installed)

    def refused(self, words, installed=False):
        with self.assertRaises(self.m.Refused) as cm:
            self.m.verify(self.folder, self.bundle, installed)
        self.assertIn(words, str(cm.exception))

    # ---- what passes
    def test_a_signed_bundle_passes_a_first_install_and_names_the_key(self):
        out = self.ok()
        self.assertIn(hashlib.sha256(open(self.pub, "rb").read()).hexdigest(), out)
        self.assertIn("compare its sha256 with the guide", out)
        self.assertIn("desk-rtc 0.5.0", out)

    def test_it_passes_an_update_with_the_key_the_desk_holds(self):
        self.assertIn("the release key this desk already holds", self.ok(installed=True))

    def test_files_install_sh_never_reads_are_left_alone(self):
        write(f"{self.folder}/selfhost/e2e/node_modules/x.js", "x")
        write(f"{self.folder}/selfhost/lab/notes", "x")
        write(f"{self.folder}/notes.txt", "x")
        self.ok()

    def test_a_signed_baseline_passes(self):
        self.make(baseline=8501)
        self.assertIn("batch baseline 8501", self.ok())

    # ---- the pin and its signature. Each fails before EXP-10: install.sh checked artifacts against an unsigned pin.
    def test_an_unsigned_bundle_is_refused(self):
        self.make(sign=False)
        self.refused("isn't signed")

    def test_a_swapped_release_with_its_line_changed_to_match_is_refused(self):
        fn = os.path.join(self.bundle, self.arts["deskd"][1])
        old = sha(fn)
        write(fn, b"someone else's deskd")
        with open(f"{self.bundle}/bundle.pin") as f:
            text = f.read().replace(old, sha(fn))
        write(f"{self.bundle}/bundle.pin", text)
        self.refused("signature doesn't verify")

    def test_a_pin_signed_by_another_key_is_refused(self):
        self.sign(self.other_priv)
        self.refused("signature doesn't verify")
        self.refused("signature doesn't verify", installed=True)

    def test_an_update_never_takes_another_release_key_even_when_the_installer_brings_it_anchored(self):
        self.pin_key(self.other_pub)          # the folder's key and its anchor agree: only the desk's key can refuse it
        self.make(priv=self.other_priv)
        self.ok()  # a first install trusts the folder: that's what the member checks by hand (README)
        self.refused("isn't the one this desk holds", installed=True)

    def test_an_update_refuses_the_same_key_under_another_name(self):
        self.pin_key(self.pub, "ma-selfhost-release-2026-12.pem")
        self.make()
        self.ok()
        self.refused("isn't the one this desk holds", installed=True)

    def test_a_second_pem_in_the_release_key_folder_is_refused(self):
        shutil.copy(self.other_pub, f"{self.folder}/{KEYS}/ma-selfhost-release-2026-12.pem")
        self.make()
        self.refused("holds ma-selfhost-release-2026-12.pem beside")
        self.refused("holds ma-selfhost-release-2026-12.pem beside", installed=True)

    def test_anything_else_in_the_release_key_folder_is_refused(self):
        write(f"{self.folder}/{KEYS}/.hidden", "x")
        self.make()
        self.refused("holds .hidden beside")

    # ---- the release key, not the batch key (Nov 11 follow-up). Each fails on 5cd021fb, which trusted batch-keys/.
    def test_a_pin_signed_by_the_batch_key_is_refused(self):
        self.sign(self.batch_priv)
        self.refused("signature doesn't verify with the release key in this installer")
        self.refused("signature doesn't verify with the release key this desk already holds", installed=True)

    def test_the_batch_key_folder_never_vouches_even_holding_the_signer(self):
        shutil.copy(self.other_pub, f"{self.folder}/{BATCH_KEYS}/ma-desk-batch-2026-12.pem")
        self.make(priv=self.other_priv)
        self.refused("signature doesn't verify")
        # nor the desk's: the checker reads only the release key folders, never /opt/ma/etc/batch-keys/
        self.assertNotIn("batch-keys", self.m.INSTALLED_KEYS + self.m.FOLDER_KEYS)
        with open(CHECK) as f:
            code = f.read().split('"""', 2)[2]   # past the docstring, which names batch-keys/ to say it isn't read
        self.assertNotIn("batch-keys", code)

    def test_the_release_key_passes_both_ways_and_names_its_folder(self):
        out = self.ok()
        self.assertIn(f"signed by {KEY_NAME}, key sha256 {sha(self.pub)} (the release key in this installer", out)
        self.assertIn(f"signed by {KEY_NAME}, key sha256 {sha(self.pub)} (the release key this desk already holds)",
                      self.ok(installed=True))

    # ---- the anchor
    def test_an_anchor_with_another_sha256_is_refused(self):
        write(f"{self.folder}/{ANCHOR}", f"{sha(self.other_pub)}  {KEY_NAME}\n")
        self.make()
        self.refused("isn't the key selfhost/release-keys.sha256 names (its sha256 differs)")
        self.refused("its sha256 differs", installed=True)

    def test_a_key_swapped_under_its_anchor_is_refused(self):
        shutil.copy(self.other_pub, f"{self.folder}/{KEYS}/{KEY_NAME}")
        self.make(priv=self.other_priv)
        self.refused("its sha256 differs")

    def test_an_anchor_naming_another_file_is_refused(self):
        write(f"{self.folder}/{ANCHOR}", f"{sha(self.pub)}  ma-selfhost-release-2026-12.pem\n")
        self.make()
        self.refused("has no selfhost/files/opt/ma/etc/selfhost-release-keys/ma-selfhost-release-2026-12.pem")

    def test_an_anchor_of_two_lines_or_none_is_refused(self):
        write(f"{self.folder}/{ANCHOR}", f"{sha(self.pub)}  {KEY_NAME}\n{sha(self.other_pub)}  b.pem\n")
        self.make()
        self.refused("isn't one line")
        write(f"{self.folder}/{ANCHOR}", "")
        self.make()
        self.refused("isn't one line")
        os.unlink(f"{self.folder}/{ANCHOR}")
        self.make()
        self.refused("has no selfhost/release-keys.sha256")

    def test_an_anchor_or_key_folder_that_is_a_link_is_refused(self):
        d = f"{self.folder}/{KEYS}"
        os.rename(d, d + ".real")
        os.symlink(os.path.basename(d) + ".real", d)
        self.refused("isn't a folder")

    def test_an_anchored_key_that_isnt_p256_is_refused(self):
        self.pin_key(self.p384_pub)
        self.make()
        self.refused("isn't a P-256 public key")

    def test_an_installer_without_the_release_key_folder_is_refused(self):
        shutil.rmtree(f"{self.folder}/{KEYS}")
        self.make()
        self.refused("has no selfhost/files/opt/ma/etc/selfhost-release-keys/")

    # ---- a desk with no release key (one from a bundle the batch key signed, like the internal test bundle A)
    def test_an_update_onto_a_desk_without_the_release_key_folder_is_refused_saying_why(self):
        shutil.rmtree(self.installed)
        self.refused("this desk holds no release key", installed=True)
        self.refused("Moving a desk to the release key isn't built", installed=True)
        self.ok()  # the folder itself is fine

    def test_an_update_onto_a_desk_with_an_empty_release_key_folder_is_refused(self):
        os.unlink(f"{self.installed}/{KEY_NAME}")
        self.refused("this desk holds no release key", installed=True)

    def test_an_installed_folder_holding_anything_but_keys_is_refused(self):
        write(f"{self.installed}/notes.txt", "x")
        os.chmod(f"{self.installed}/notes.txt", 0o644)
        self.refused("holds nothing else", installed=True)

    def test_an_update_refuses_a_second_key_beside_the_one_it_holds(self):
        shutil.copy(self.other_pub, f"{self.installed}/ma-selfhost-release-2026-12.pem")
        os.chmod(f"{self.installed}/ma-selfhost-release-2026-12.pem", 0o644)
        self.refused("isn't the one this desk holds", installed=True)

    def test_keys_prints_the_anchored_key_and_its_sha256(self):
        r = subprocess.run(["python3", "-I", CHECK, "keys", self.folder], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"{KEYS}/{KEY_NAME}, sha256 {sha(self.pub)}", r.stdout)
        write(f"{self.folder}/{ANCHOR}", f"{sha(self.other_pub)}  {KEY_NAME}\n")
        r = subprocess.run(["python3", "-I", CHECK, "keys", self.folder], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("REFUSED", r.stderr)

    def test_an_update_refuses_a_key_folder_others_can_write(self):
        os.chmod(self.installed, 0o777)
        self.refused("only root can change", installed=True)

    def test_a_signed_batch_manifest_is_not_a_pin(self):
        write(f"{self.bundle}/bundle.pin", '{"format": "ma-desk-batch/1", "seq": 9, "components": []}\n')
        self.sign()
        self.refused("doesn't start with")

    def test_a_signed_pin_is_not_a_batch(self):
        r = subprocess.run(["python3", "-I", DESK_BATCH, "verify", f"{self.bundle}/bundle.pin", f"{self.bundle}/bundle.pin.sig",
                            self.pub], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_a_line_no_installer_takes_is_refused_even_signed(self):
        self.make(extra_lines=["evil           1.0                  " + "0" * 64])
        self.refused("names evil")

    def test_a_release_named_twice_is_refused(self):
        self.make(extra_lines=[f"deskd          2026.11.10-ff58751   {'1' * 64}"])
        self.refused("names deskd twice")

    def test_a_pin_over_4096_bytes_is_refused(self):
        self.make(extra_lines=["# " + "x" * 4100])
        self.refused("4096")

    def test_a_pin_without_an_installer_line_is_refused(self):
        with open(f"{self.bundle}/bundle.pin") as f:
            text = "".join(l for l in f if not l.startswith("installer"))
        write(f"{self.bundle}/bundle.pin", text)
        self.sign()
        self.refused("has no installer")

    # ---- the releases
    def test_a_release_changed_under_a_signed_pin_is_refused(self):
        write(os.path.join(self.bundle, self.arts["desk-rtc"][1]), b"changed")
        self.refused("isn't the file bundle.pin names")

    def test_a_release_that_is_a_link_is_refused(self):
        fn = os.path.join(self.bundle, self.arts["desk-rtc"][1])
        os.rename(fn, fn + ".real")
        os.symlink(fn + ".real", fn)
        self.refused("isn't a plain file")

    def test_a_missing_release_is_refused(self):
        os.unlink(os.path.join(self.bundle, self.arts["desk-stream"][1]))
        self.refused("has no desk-stream-0.3.3 file")

    # ---- the installer's own files
    def test_a_changed_installer_file_is_refused(self):
        write(f"{self.folder}/image/recipe/files/etc/systemd/system/deskd.service", "[Unit]\nExecStartPre=+/tmp/x\n")
        self.refused("deskd.service isn't the one this bundle was signed with")

    def test_an_added_file_where_install_sh_copies_everything_is_refused(self):
        write(f"{self.folder}/image/recipe/files/etc/systemd/system/extra.service", "[Unit]\n")
        self.refused("wasn't signed with: image/recipe/files/etc/systemd/system/extra.service")
        os.unlink(f"{self.folder}/image/recipe/files/etc/systemd/system/extra.service")
        write(f"{self.folder}/selfhost/files/etc/cron.d/extra", "* * * * * root true\n")
        self.refused("wasn't signed with: selfhost/files/etc/cron.d/extra")

    def test_a_missing_installer_file_is_refused(self):
        os.unlink(f"{self.folder}/image/recipe/build.sh")
        self.refused("has no image/recipe/build.sh")

    def test_an_installer_file_as_a_link_is_refused(self):
        p = f"{self.folder}/selfhost/files/etc/nftables.conf"
        os.rename(p, p + ".real")
        os.symlink(p + ".real", p)
        self.refused("isn't a plain file")

    def test_a_folder_of_the_installer_as_a_link_is_refused(self):
        d = f"{self.folder}/image/recipe/files/etc/systemd"
        os.rename(d, d + ".real")
        os.symlink(os.path.basename(d) + ".real", d)
        self.refused("isn't a folder")

    def test_a_changed_installer_list_is_refused(self):
        with open(f"{self.bundle}/installer.sha256", "a") as f:
            f.write(f"{'2' * 64}  selfhost/extra\n")
        self.refused("installer.sha256 isn't the one bundle.pin names")

    def test_the_installer_list_cant_reach_outside_the_installer(self):
        write(f"{self.folder}/etc-passwd", "x")
        with open(f"{self.bundle}/installer.sha256", "a") as f:
            f.write(f"{sha(self.folder + '/etc-passwd')}  selfhost/../etc-passwd\n")
        with open(f"{self.bundle}/bundle.pin") as f:
            text = re.sub(r"(installer +abc1234 +)[0-9a-f]{64}", lambda m: m.group(1) + sha(f"{self.bundle}/installer.sha256"), f.read())
        write(f"{self.bundle}/bundle.pin", text)
        self.sign()
        self.refused("outside the installer")

    # ---- the baseline
    def test_a_baseline_the_pin_doesnt_name_is_refused(self):
        write(f"{self.bundle}/batch-baseline", '{"seq": 99999}\n')
        self.refused("don't agree")

    def test_a_changed_baseline_is_refused(self):
        self.make(baseline=8501)
        write(f"{self.bundle}/batch-baseline", '{"seq": 99999}\n')
        self.refused("batch-baseline isn't the one bundle.pin names")


class Wiring(unittest.TestCase):
    """install.sh and build-bundle.sh use the check as described. Fails before EXP-10: neither had one."""

    def setUp(self):
        with open(INSTALL) as f:
            self.install = f.read()

    def test_install_sh_checks_before_its_first_change(self):
        first_change = self.install.index('step "users')
        checks = [m.start() for m in re.finditer(r'python3 -I "\$CHECK" verify "\$TREE" --bundle "\$BUNDLE"', self.install)]
        self.assertEqual(len(checks), 2)
        self.assertTrue(all(c < first_change for c in checks))
        self.assertIn("--installed", self.install[checks[0]:checks[0] + 120])

    def test_an_update_prefers_the_desks_own_checker(self):
        self.assertIn("CHECK=/usr/local/lib/ma/selfhost/ma-selfhost-bundle", self.install)

    def test_an_update_onto_a_desk_without_the_release_key_stops_saying_why_before_any_check(self):
        """Its older checker would only say the signature doesn't verify. Fails on 5cd021fb, which fell back to the folder's key."""
        first_change = self.install.index('step "users')
        stop = self.install.index('[ -d /opt/ma/etc/selfhost-release-keys ] || die "this desk holds no release key')
        self.assertLess(stop, self.install.index('--installed \\'))
        self.assertLess(stop, first_change)
        self.assertNotIn("trusts the installer's key, as a first install does", self.install)
        block = self.install[self.install.index('if [ "$UPGRADE" = 1 ]; then\n  # A desk installed'):first_change]
        self.assertNotIn("batch-keys", block.split("fi\n")[0])

    def test_install_sh_installs_the_release_key_folder_root_s_and_exactly(self):
        self.assertIn("RELEASE_KEYS=/opt/ma/etc/selfhost-release-keys", self.install)
        self.assertIn('install -d -o root -g root -m 0755 "$RELEASE_KEYS.new"', self.install)
        self.assertIn('install -o root -g root -m 0644 "$HERE/files$RELEASE_KEYS"/*.pem "$RELEASE_KEYS.new/"', self.install)
        self.assertIn('chmod 0755 "$RELEASE_KEYS"; chmod 0644 "$RELEASE_KEYS"/*.pem', self.install)

    def test_build_bundle_signs_with_the_release_key_and_never_the_batch_key(self):
        with open(BUILD) as f:
            build = f.read()
        self.assertIn("BUNDLE_KMS_KEY_ID=${BUNDLE_KMS_KEY_ID:-alias/ma-selfhost-release}", build)
        self.assertIn('[ "$BUNDLE_KMS_KEY_ID" != alias/ma-desk-batch ] || die', build)
        self.assertIn("KEYS_DIR=selfhost/files/opt/ma/etc/selfhost-release-keys", build)
        self.assertIn('ma-selfhost-bundle" keys "$t/folder"', build)
        self.assertNotIn("BUNDLE_KMS_KEY_ID=alias/ma-desk-batch", build)

    def test_the_pins_own_parse_skips_what_the_check_covers(self):
        self.assertIn("''|'#'*|installer|batch-baseline) continue ;;", self.install)

    def test_build_bundle_writes_the_first_line_the_check_wants(self):
        with open(BUILD) as f:
            build = f.read()
        self.assertIn("MAGIC='# ma-selfhost-bundle/1'", build)
        self.assertEqual(load().MAGIC, "# ma-selfhost-bundle/1")

    @unittest.skipUnless(os.path.isdir(os.path.join(REPO, ".git")) or os.path.isfile(os.path.join(REPO, ".git")),
                         "not a git checkout")
    def test_build_bundles_installer_list_passes_the_check_on_this_commits_tree(self):
        with tempfile.TemporaryDirectory() as t:
            fn = subprocess.run(["sed", "-n", "/^installer_manifest() {/,/^}/p", BUILD], capture_output=True, text=True).stdout
            r = subprocess.run(["bash", "-c", f"set -euo pipefail; die() {{ echo \"$*\" >&2; exit 1; }}; REPO={REPO}; {fn}\n"
                                "installer_manifest HEAD"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            folder = os.path.join(t, "folder")
            os.makedirs(folder)
            subprocess.run(f"git -C {REPO} archive --format=tar HEAD selfhost image/recipe | tar -x -C {folder}", shell=True,
                           check=True)
            m = load()
            n = m.check_installer(folder, r.stdout.encode())
            self.assertGreater(n, 100)
            self.assertIn("  selfhost/install.sh\n", r.stdout)
            self.assertNotIn("selfhost/tests/", r.stdout)
            # The committed release key passes its anchor in this commit's tree, and both are signed files.
            self.assertEqual(len(m.folder_keys(folder)), 1)
            self.assertIn(f"  {ANCHOR}\n", r.stdout)
            self.assertRegex(r.stdout, r"  selfhost/files/opt/ma/etc/selfhost-release-keys/[^/\n]+\.pem\n")


class Committed(unittest.TestCase):
    """The keys as committed: the release key is anchored and apart from the batch key, which still alone signs batches."""

    def test_the_release_key_matches_its_anchor_alone_in_its_folder(self):
        k = load().folder_keys(REPO)
        self.assertEqual(len(k), 1)
        with open(os.path.join(REPO, ANCHOR)) as f:
            want, name = f.read().split()
        self.assertEqual((sha(k[0]), os.path.basename(k[0])), (want, name))

    def test_the_release_key_is_not_the_batch_key_and_never_in_batch_keys(self):
        release = sha(load().folder_keys(REPO)[0])
        batch_dir = os.path.join(REPO, BATCH_KEYS)
        self.assertEqual(os.listdir(batch_dir), ["ma-desk-batch-2026-11.pem"])
        self.assertNotEqual(release, sha(os.path.join(batch_dir, "ma-desk-batch-2026-11.pem")))
        for dp, _, fns in os.walk(os.path.join(REPO, "image")):
            for fn in fns:
                if fn.endswith(".pem"):
                    self.assertNotEqual(sha(os.path.join(dp, fn)), release, os.path.join(dp, fn))

    def test_desk_batch_and_the_recipe_trust_only_batch_keys(self):
        with open(DESK_BATCH) as f:
            batch = f.read()
        self.assertIn('KEY_DIRS = ("/opt/ma/etc/batch-keys", "/etc/ma/batch-keys.d")', batch)
        self.assertNotIn("selfhost-release", batch)
        with open(os.path.join(REPO, "image", "recipe", "build.sh")) as f:
            recipe = f.read()
        self.assertIn('chk test "$(ls -A /opt/ma/etc/batch-keys)" = ma-desk-batch-2026-11.pem', recipe)
        self.assertNotIn("selfhost-release", recipe)


class Pin(unittest.TestCase):
    """pin-release-key.sh, against a stand-in for aws that answers GetPublicKey as KMS does (base64 of the key's DER)."""

    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.pub = keypair(cls.keys.name, "kms")[1]
        cls.other = keypair(cls.keys.name, "kms2")[1]

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.sh = os.path.join(t, "repo", "selfhost")
        os.makedirs(os.path.join(self.sh, "files", "usr", "local", "lib", "ma", "selfhost"))
        shutil.copy(PIN_KEY, self.sh)
        shutil.copy(CHECK, os.path.join(self.sh, "files", "usr", "local", "lib", "ma", "selfhost"))
        self.bin = os.path.join(t, "bin")
        os.makedirs(self.bin)
        self.answer(self.pub)

    def tearDown(self):
        self.tmp.cleanup()

    def answer(self, pub, spec="ECC_NIST_P256", algs='["ECDSA_SHA_256"]', usage="SIGN_VERIFY"):
        der = subprocess.run([OPENSSL, "pkey", "-pubin", "-in", pub, "-outform", "DER"], capture_output=True, check=True).stdout
        import base64, json
        body = json.dumps({"KeyId": "stand-in", "PublicKey": base64.b64encode(der).decode(), "KeySpec": spec,
                           "KeyUsage": usage, "SigningAlgorithms": json.loads(algs)})
        write(os.path.join(self.bin, "aws"), "#!/bin/sh\n"
              '[ "$1 $2 $3 $4" = "kms get-public-key --key-id alias/ma-selfhost-release" ] || exit 3\n'
              f"cat <<'EOF'\n{body}\nEOF\n")
        os.chmod(os.path.join(self.bin, "aws"), 0o755)

    def pin(self, *args):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"])
        return subprocess.run(["bash", os.path.join(self.sh, "pin-release-key.sh"), *args], capture_output=True, text=True,
                              env=env)

    def pinned(self):
        d = os.path.join(self.sh, "files", "opt", "ma", "etc", "selfhost-release-keys")
        names = os.listdir(d)
        with open(os.path.join(self.sh, "release-keys.sha256")) as f:
            return names, os.path.join(d, names[0]), f.read()

    def test_it_writes_the_pem_as_openssl_writes_it_from_kms_der_and_the_anchor(self):
        r = self.pin("alias/ma-selfhost-release")
        self.assertEqual(r.returncode, 0, r.stderr)
        names, k, anchor = self.pinned()
        self.assertEqual(len(names), 1)
        self.assertRegex(names[0], r"^ma-selfhost-release-\d{4}-\d{2}\.pem$")
        der = subprocess.run([OPENSSL, "pkey", "-pubin", "-in", self.pub, "-outform", "DER"], capture_output=True).stdout
        want = subprocess.run([OPENSSL, "pkey", "-pubin", "-inform", "DER", "-outform", "PEM"], input=der,
                              capture_output=True).stdout
        with open(k, "rb") as f:
            self.assertEqual(f.read(), want)
        self.assertEqual(anchor, f"{sha(k)}  {names[0]}\n")
        self.assertEqual(stat_mode(k), 0o644)
        self.assertIn("exactly what selfhost/release-keys.sha256 names", r.stdout)

    def test_the_same_key_again_changes_nothing_and_keeps_its_name(self):
        self.assertEqual(self.pin().returncode, 0)
        names, k, _ = self.pinned()
        old = os.path.join(os.path.dirname(k), "ma-selfhost-release-2026-01.pem")   # pinned in an earlier month
        os.rename(k, old)
        write(os.path.join(self.sh, "release-keys.sha256"), f"{sha(old)}  ma-selfhost-release-2026-01.pem\n")
        r = self.pin()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.pinned()[0], ["ma-selfhost-release-2026-01.pem"])
        self.assertEqual(self.pinned()[2], f"{sha(old)}  ma-selfhost-release-2026-01.pem\n")

    def test_another_key_needs_replace(self):
        self.assertEqual(self.pin().returncode, 0)
        self.answer(self.other)
        r = self.pin()
        self.assertEqual(r.returncode, 1)
        self.assertIn("--replace", r.stderr)
        r = self.pin("--replace")
        self.assertEqual(r.returncode, 0, r.stderr)
        names, k, anchor = self.pinned()
        self.assertEqual(len(names), 1)
        self.assertEqual(sha(k), anchor.split()[0])

    def test_it_refuses_anything_but_p256_with_ecdsa_sha_256_alone(self):
        for kw, words in (({"spec": "ECC_NIST_P384"}, "not ECC_NIST_P256"), ({"spec": "RSA_2048"}, "not ECC_NIST_P256"),
                          ({"algs": '["ECDSA_SHA_256", "ECDSA_SHA_384"]'}, "not ECDSA_SHA_256 alone"),
                          ({"usage": "ENCRYPT_DECRYPT"}, "not SIGN_VERIFY")):
            self.answer(self.pub, **kw)
            r = self.pin()
            self.assertEqual(r.returncode, 1, kw)
            self.assertIn(words, r.stderr)
            self.assertFalse(os.path.exists(os.path.join(self.sh, "release-keys.sha256")))

    def test_it_takes_an_alias_only(self):
        r = self.pin("1234abcd-12ab-34cd-56ef-1234567890ab")
        self.assertEqual(r.returncode, 1)
        self.assertIn("an alias only", r.stderr)


def stat_mode(path):
    return os.stat(path).st_mode & 0o777


if __name__ == "__main__":
    unittest.main()
