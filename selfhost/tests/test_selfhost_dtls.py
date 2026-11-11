"""EXP-7: ma-selfhost-dtls, which runs as root, never acts on a name another user controls.

No root needed: the script's directories and its owner check are pointed at temporary ones the test owns.
Run: python3 -m unittest discover -s selfhost/tests
"""
import base64
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import stat
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DTLS = os.path.join(HERE, "..", "files", "usr", "local", "lib", "ma", "selfhost", "ma-selfhost-dtls")
SELFHOST = os.path.join(HERE, "..", "files", "usr", "local", "lib", "ma", "selfhost", "ma-selfhost")

DER = b"0\x82\x01\x00not a real certificate, only bytes to hash"
# desk-rtc's file holds its key's block before the certificate; another block stands in for it here.
PEM = ("-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n-----BEGIN CERTIFICATE-----\n"
       + base64.encodebytes(DER).decode() + "-----END CERTIFICATE-----\n")
FP = hashlib.sha256(DER).hexdigest()


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class DtlsWrite(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.m = load(DTLS, "ma_selfhost_dtls")
        self.src = os.path.join(t, "rtc")
        os.mkdir(self.src, 0o700)
        with open(os.path.join(self.src, "dtls-identity.pem"), "w") as f:
            f.write(PEM)
        self.out = os.path.join(t, "out")
        self.m.SRC_DIR, self.m.OUT_DIR, self.m.OUT_OWNER = self.src, self.out, os.getuid()
        # The names the script had before the fix, so these same tests show what it did then.
        self.m.SRC, self.m.OUT = os.path.join(self.src, "dtls-identity.pem"), os.path.join(self.out, "dtls.json")
        # A file root would never want touched: what a planted link names.
        self.victim = os.path.join(t, "victim")
        with open(self.victim, "w") as f:
            f.write("keep me\n")
        os.chmod(self.victim, 0o600)

    def tearDown(self):
        self.tmp.cleanup()

    def victim_untouched(self):
        with open(self.victim) as f:
            self.assertEqual(f.read(), "keep me\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.victim).st_mode), 0o600)

    def written(self):
        with open(os.path.join(self.out, "dtls.json")) as f:
            return json.load(f)

    def test_writes_the_fingerprint_into_a_directory_it_makes_for_root_alone(self):
        self.assertEqual(self.m.main([]), 0)
        self.assertEqual(self.written(), {"fingerprintsSha256": [FP]})
        st = os.lstat(self.out)
        self.assertTrue(stat.S_ISDIR(st.st_mode))
        self.assertEqual(stat.S_IMODE(st.st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.out, "dtls.json")).st_mode), 0o644)
        self.assertFalse(os.path.lexists(os.path.join(self.out, "dtls.json.new")))

    def test_a_link_at_the_temporary_name_is_not_followed(self):
        # Fails before EXP-7's fix: open(tmp, "w") truncated the link's target and chmod made it 0644.
        os.mkdir(self.out, 0o755)
        os.symlink(self.victim, os.path.join(self.out, "dtls.json.new"))
        self.assertEqual(self.m.main([]), 0)
        self.victim_untouched()
        self.assertEqual(self.written(), {"fingerprintsSha256": [FP]})

    def test_a_directory_another_user_can_write_is_refused(self):
        # The old OUT_DIR was ma-selfhost's own RuntimeDirectory. Writable by someone else means refused, nothing written.
        os.mkdir(self.out)
        os.chmod(self.out, 0o777)
        os.symlink(self.victim, os.path.join(self.out, "dtls.json.new"))
        os.symlink(self.victim, os.path.join(self.out, "dtls.json"))
        self.assertEqual(self.m.main([]), 1)
        self.victim_untouched()

    def test_a_directory_owned_by_someone_else_is_refused(self):
        os.mkdir(self.out, 0o755)
        self.m.OUT_OWNER = os.getuid() + 1
        self.assertEqual(self.m.main([]), 1)
        self.assertFalse(os.path.lexists(os.path.join(self.out, "dtls.json")))

    def test_an_output_directory_that_is_a_link_is_refused(self):
        elsewhere = os.path.join(self.tmp.name, "elsewhere")
        os.mkdir(elsewhere, 0o755)
        os.symlink(elsewhere, self.out)
        self.assertEqual(self.m.main([]), 1)
        self.assertEqual(os.listdir(elsewhere), [])


class DtlsRead(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.m = load(DTLS, "ma_selfhost_dtls_read")
        self.src = os.path.join(self.tmp.name, "rtc")
        os.mkdir(self.src, 0o700)
        self.m.SRC_DIR = self.src
        self.m.SRC = os.path.join(self.src, "dtls-identity.pem")  # its name before the fix
        self.other = os.path.join(self.tmp.name, "root-only.pem")
        with open(self.other, "w") as f:
            f.write(PEM)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_the_certificate_block_only(self):
        with open(os.path.join(self.src, "dtls-identity.pem"), "w") as f:
            f.write(PEM)
        self.assertEqual(self.m.fingerprint(), FP)

    def test_a_link_to_another_file_is_not_followed(self):
        # Fails before the fix: plain open() read through rtc's link, as root.
        os.symlink(self.other, os.path.join(self.src, "dtls-identity.pem"))
        self.assertIsNone(self.m.fingerprint())

    def test_the_directory_as_a_link_is_not_followed(self):
        real = os.path.join(self.tmp.name, "real")
        os.mkdir(real)
        with open(os.path.join(real, "dtls-identity.pem"), "w") as f:
            f.write(PEM)
        os.rmdir(self.src)
        os.symlink(real, self.src)
        self.assertIsNone(self.m.fingerprint())

    def test_a_fifo_does_not_hold_it(self):
        # Fails before the fix: open() of a FIFO blocks root's ExecStartPost until systemd's timeout.
        os.mkfifo(os.path.join(self.src, "dtls-identity.pem"))
        got = []
        t = threading.Thread(target=lambda: got.append(self.m.fingerprint()), daemon=True)
        t.start()
        t.join(3)
        self.assertFalse(t.is_alive(), "fingerprint() blocked on a FIFO")
        self.assertEqual(got, [None])

    def test_an_oversized_file_is_not_read(self):
        with open(os.path.join(self.src, "dtls-identity.pem"), "w") as f:
            f.write(PEM + "x" * (64 * 1024))
        self.assertIsNone(self.m.fingerprint())


class SelfhostReadsRootsFile(unittest.TestCase):
    def test_the_fingerprints_are_read_outside_the_services_own_directory(self):
        # Fails before the fix: DTLS_FILE was RUN/dtls.json, in the directory the selfhost user owns.
        with tempfile.TemporaryDirectory() as t:
            os.environ["MA_SELFHOST_STATE"] = t
            os.environ["MA_SELFHOST_RUN"] = os.path.join(t, "run")
            os.environ.pop("MA_SELFHOST_DTLS", None)
            m = load(SELFHOST, "ma_selfhost_dtls_path")
            self.assertEqual(m.DTLS_FILE, "/run/ma-selfhost-dtls/dtls.json")
            self.assertNotEqual(os.path.dirname(m.DTLS_FILE), m.RUN)

    def test_it_reads_what_ma_selfhost_dtls_writes(self):
        with tempfile.TemporaryDirectory() as t:
            out = os.path.join(t, "out")
            d = load(DTLS, "ma_selfhost_dtls_pair")
            d.OUT_DIR, d.OUT_OWNER = out, os.getuid()
            d.write_out(FP)
            os.environ["MA_SELFHOST_STATE"] = t
            os.environ["MA_SELFHOST_RUN"] = os.path.join(t, "run")
            os.environ["MA_SELFHOST_DTLS"] = os.path.join(out, "dtls.json")
            try:
                m = load(SELFHOST, "ma_selfhost_dtls_reader")
                self.assertEqual(m.read_dtls(), [FP])
            finally:
                os.environ.pop("MA_SELFHOST_DTLS", None)


if __name__ == "__main__":
    unittest.main()
