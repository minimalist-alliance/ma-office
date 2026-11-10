#!/usr/bin/python3 -I
"""desk-batch on temporary directories, a fake ma-update, fake apt and a fake clock. No root. Real openssl, real P-256 keys
made per run. python3 -I image/tests/test_desk_batch.py

The helper is loaded as a module and its paths and commands are pointed into a temporary directory. The fake ma-update
keeps current, previous and prepared links as the real one does (its own behaviour is test_ma_update.py's), logs each
call, and fails a step when the test leaves a file saying so."""
import base64
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
HELPER = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "usr" / "local" / "lib" / "ma" / "desk-batch"
T0 = 1_794_000_000.0   # 2026-11-08, a fixed start for the fake clock

FAKE_MA_UPDATE = r"""#!/bin/bash
# The fake: artifacts are files whose content is the version. Fail hooks: $FAKE/fail-<verb>-<component>.
echo "$*" >> "$FAKE/calls"
comp=$1 d=$MA_ROOT/$1
case "$2" in
  --prepare)
    [ -e "$FAKE/fail-prepare-$comp" ] && { echo "ma-update: ERROR: sha256 mismatch" >&2; exit 2; }
    f=${3#file://}; [ "$(sha256sum "$f" | cut -c1-64)" = "$4" ] || { echo "ma-update: ERROR: sha256 mismatch" >&2; exit 2; }
    v=$(cat "$f"); mkdir -p "$d/releases/$v"; echo "$4" > "$d/releases/$v/artifact.sha256"; ln -sfn "$d/releases/$v" "$d/prepared" ;;
  --activate)
    [ "$(readlink "$d/prepared")" = "$d/releases/$3" ] || { echo "ma-update: ERROR: not prepared" >&2; exit 2; }
    rm -f "$d/prepared"
    [ -e "$FAKE/fail-activate-$comp" ] && { echo "ma-update: smoke test FAILED: rolling back" >&2; exit 1; }
    c=$(readlink "$d/current"); [ -z "$c" ] || ln -sfn "$c" "$d/previous"; ln -sfn "$d/releases/$3" "$d/current" ;;
  --rollback)
    [ -e "$FAKE/fail-rollback-$comp" ] && exit 1
    c=$(readlink "$d/current"); p=$(readlink "$d/previous"); ln -sfn "$p" "$d/current"; ln -sfn "$c" "$d/previous" ;;
  --unprepare) rm -f "$d/prepared" ;;
  *) exit 2 ;;
esac
"""
FAKE_LOG = r"""#!/bin/bash
echo "$(basename "$0") $*" >> "$FAKE/apt"
[ ! -e "$FAKE/fail-$(basename "$0")" ]
"""


def load():
    loader = importlib.machinery.SourceFileLoader("desk_batch", str(HELPER))
    spec = importlib.util.spec_from_loader("desk_batch", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def keypair(dirpath, name, curve="prime256v1"):
    key, pub = dirpath / f"{name}.key", dirpath / f"{name}.pem"
    if curve == "rsa":
        subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:1024", "-out", str(key)],
                       check=True, capture_output=True)
    else:
        subprocess.run(["openssl", "ecparam", "-name", curve, "-genkey", "-noout", "-out", str(key)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(pub)], check=True, capture_output=True)
    return key, pub


def sign(key, data):
    return subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(key)], input=data, check=True, capture_output=True).stdout


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.umask(0o022)
        cls.keys_tmp = tempfile.TemporaryDirectory()
        k = pathlib.Path(cls.keys_tmp.name)
        cls.key, cls.pub = keypair(k, "good")
        cls.other_key, cls.other_pub = keypair(k, "other")
        cls.p384_key, cls.p384_pub = keypair(k, "p384", "secp384r1")

    @classmethod
    def tearDownClass(cls):
        cls.keys_tmp.cleanup()

    def setUp(self):
        # The helper skips keys anyone but their owner can write, so a umask of 002 (some build boxes) would skip them all.
        self.umask = os.umask(0o022)
        self.tmp = tempfile.TemporaryDirectory()
        t = self.t = pathlib.Path(self.tmp.name)
        self.db = db = load()
        self.clock = [T0]
        db.NOW = lambda: self.clock[0]
        db.SLEEP = lambda s: self.clock.__setitem__(0, self.clock[0] + s)
        db.STATE_DIR = str(t / "state")
        self.image_keys, self.dropin = t / "batch-keys", t / "batch-keys.d"
        for d in (self.image_keys, self.dropin):
            d.mkdir(mode=0o755)
        shutil.copy(self.pub, self.dropin / "dev.pem")
        db.KEY_DIRS = (str(self.image_keys), str(self.dropin))
        db.KEY_OWNER = os.getuid()
        db.IDLE_UID = os.getuid()
        db.IDLE_FILE = str(t / "idle.json")
        db.BASELINE = str(t / "baseline")
        db.MA_ROOT = str(t / "opt-ma")
        (t / "opt-ma").mkdir()
        db.RELEASE_FILE = str(t / "ma-release")
        (t / "ma-release").write_text("version=0.3.2\n")
        self.fake = t / "fake"
        self.fake.mkdir()
        bin_ = t / "bin"
        bin_.mkdir()
        for name, body in (("ma-update", FAKE_MA_UPDATE), ("apt-get", FAKE_LOG), ("unattended-upgrade", FAKE_LOG),
                           ("smoke", "#!/bin/sh\n[ ! -e \"$FAKE/unhealthy\" ]\n"), ("dpkg-query", "#!/bin/sh\necho -n 156.0.8078.79-1~deb13u1\n")):
            (bin_ / name).write_text(body)
            (bin_ / name).chmod(0o755)
        os.environ["FAKE"], os.environ["MA_ROOT"] = str(self.fake), db.MA_ROOT
        db.MA_UPDATE = str(bin_ / "ma-update")
        db.SMOKE_TEST = str(bin_ / "smoke")
        db.DPKG_QUERY = str(bin_ / "dpkg-query")
        db.LOW, db.PREPARE_PRIORITY = [], []
        db.APT_UPDATE = [str(bin_ / "apt-get"), "update"]
        db.APT_UPGRADE = [str(bin_ / "unattended-upgrade")]
        db.APT_CLEAN = [str(bin_ / "apt-get"), "clean"]
        db.APT_ENV = {**db.APT_ENV, "FAKE": str(self.fake)}
        db.BROWSER_CGROUP = str(t / "cgroup")
        db.BOOT_DIR = str(t / "boot")
        (t / "boot").mkdir()
        (t / "boot" / f"vmlinuz-{os.uname().release}").touch()
        db.REBOOT_REQUIRED = str(t / "reboot-required")
        self.art = t / "art"
        self.art.mkdir()
        self.log_lines = []
        db.log = self.log_lines.append

    def tearDown(self):
        self.tmp.cleanup()
        os.umask(self.umask)

    # ---- helpers
    def now(self, dt=0.0):
        self.clock[0] += dt
        return self.clock[0]

    def artifact(self, name, version):
        f = self.art / f"{name}-{version}"
        f.write_text(version)
        import hashlib
        return f"file://{f}", hashlib.sha256(f.read_bytes()).hexdigest()

    def install(self, name, version):
        """A release the desk already runs, as current."""
        _, sha = self.artifact(name, version)
        d = pathlib.Path(self.db.MA_ROOT) / name
        (d / "releases" / version).mkdir(parents=True)
        (d / "releases" / version / "artifact.sha256").write_text(sha + "\n")
        os.symlink(d / "releases" / version, d / "current")

    def manifest(self, seq, comps, **kw):
        m = {"format": "ma-desk-batch/1", "seq": seq, "id": kw.pop("id", f"b{seq}"), "created": "2026-11-09T18:00:00Z",
             "urgent": kw.pop("urgent", False)}
        if "image" in kw:
            m["image"] = kw.pop("image")
        m["components"] = [{"name": n, "version": v, "sha256": self.artifact(n, v)[1]} for n, v in comps]
        m["note"] = kw.pop("note", "")
        m.update(kw)
        return json.dumps(m, indent=1).encode()

    def urls(self, comps, expires=None):
        out = {"components": {n: self.artifact(n, v)[0] for n, v in comps}}
        if expires is not None:
            out["expiresAt"] = expires
        return out

    def offer(self, seq, comps, key=None, **kw):
        m = self.manifest(seq, comps, **kw)
        return self.db.offer(m, sign(key or self.key, m), self.urls(comps))

    def refused(self, code, fn, *a, **kw):
        with self.assertRaises(self.db.Refused) as cm:
            fn(*a, **kw)
        self.assertEqual(cm.exception.code, code, cm.exception.text)
        return cm.exception.text

    def idle(self, idle_for=1200, sessions=0, agent=0, exports=0, downloads=0, stop=None, at=None, **extra):
        d = {"at": self.db.utc(self.clock[0] if at is None else at), "sessions": sessions, "agentTasks": agent,
             "exports": exports, "downloads": downloads,
             "idleSince": self.db.utc(self.clock[0] - idle_for) if idle_for is not None else None}
        if stop is not None:
            d["idleStopSeconds"] = stop
        d.update(extra)
        pathlib.Path(self.db.IDLE_FILE).write_text(json.dumps(d))

    def state(self):
        return self.db.load()

    def calls(self):
        p = self.fake / "calls"
        return [line.split(" ", 2)[:2] for line in p.read_text().splitlines()] if p.exists() else []

    def link(self, name, which):
        p = pathlib.Path(self.db.MA_ROOT) / name / which
        return os.path.basename(os.readlink(p)) if p.is_symlink() else None


class OfferTest(Base):
    def test_a_signed_batch_is_taken_as_pending(self):
        p = self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d2")], note="Faster sign-in.")
        self.assertEqual((p["seq"], p["id"]), (5, "b5"))
        st = self.state()
        self.assertEqual(st["phase"], "pending")
        self.assertEqual([c["name"] for c in st["pending"]["components"]], ["desk-rtc", "deskd"])
        self.assertEqual(st["pending"]["note"], "Faster sign-in.")
        d = pathlib.Path(self.db.STATE_DIR) / "pending" / "5"
        self.assertEqual(oct(d.stat().st_mode & 0o777), "0o700")
        self.assertEqual(oct((d / "urls.json").stat().st_mode & 0o777), "0o600")
        self.assertNotIn("file://", (pathlib.Path(self.db.STATE_DIR) / "state.json").read_text(), "no URL in the state")
        self.assertEqual(oct(os.stat(self.db.state_path()).st_mode & 0o777), "0o644")

    def test_signatures(self):
        comps = [("desk-rtc", "0.4.0")]
        m = self.manifest(5, comps)
        self.refused("untrusted", self.db.offer, m, sign(self.other_key, m), self.urls(comps))
        self.refused("untrusted", self.db.offer, m.replace(b'"b5"', b'"b6"'), sign(self.key, m), self.urls(comps))   # a byte changed
        self.refused("bad_request", self.db.offer, m, b"not a signature", self.urls(comps))
        self.db.offer(m, base64.b64encode(sign(self.key, m)), self.urls(comps))                        # base64 is fine
        self.assertEqual(self.state()["pending"]["seq"], 5)

    def test_no_key_refuses_every_batch(self):
        (self.dropin / "dev.pem").unlink()
        text = self.refused("untrusted", self.offer, 5, [("desk-rtc", "0.4.0")])
        self.assertIn("no trusted key", text)
        self.assertEqual(self.state()["phase"], "none")

    def test_the_image_key_and_the_drop_in_both_count(self):
        shutil.copy(self.other_pub, self.image_keys / "release.pem")
        self.offer(5, [("desk-rtc", "0.4.0")], key=self.other_key)
        self.offer(6, [("desk-rtc", "0.4.1")], key=self.key)

    def test_keys_others_could_write_or_of_another_curve_are_skipped(self):
        os.chmod(self.dropin, 0o775)
        self.refused("untrusted", self.offer, 5, [("desk-rtc", "0.4.0")])
        os.chmod(self.dropin, 0o755)
        os.chmod(self.dropin / "dev.pem", 0o666)
        self.refused("untrusted", self.offer, 5, [("desk-rtc", "0.4.0")])
        os.chmod(self.dropin / "dev.pem", 0o644)
        (self.dropin / "dev.pem").unlink()
        os.symlink(self.pub, self.dropin / "dev.pem")
        self.refused("untrusted", self.offer, 5, [("desk-rtc", "0.4.0")])
        (self.dropin / "dev.pem").unlink()
        shutil.copy(self.p384_pub, self.dropin / "p384.pem")
        self.refused("untrusted", self.offer, 5, [("desk-rtc", "0.4.0")], key=self.p384_key)
        shutil.copy(self.pub, self.dropin / "dev.txt")   # not *.pem
        self.refused("untrusted", self.offer, 5, [("desk-rtc", "0.4.0")])

    def test_sequence_numbers(self):
        self.offer(5, [("desk-rtc", "0.4.0")])
        self.refused("seq", self.offer, 4, [("desk-rtc", "0.4.1")])                    # below the pending one
        self.refused("conflict", self.offer, 5, [("desk-rtc", "0.4.1")])                # same seq, other bytes
        comps = [("desk-rtc", "0.4.0")]
        m = (pathlib.Path(self.db.STATE_DIR) / "pending" / "5" / "manifest.json").read_bytes()
        self.db.offer(m, sign(self.key, m), self.urls(comps, expires="2026-11-09T19:00:00Z"))   # new URLs for the same batch
        self.assertEqual(self.state()["pending"]["urlsExpireAt"], "2026-11-09T19:00:00Z")
        self.offer(7, [("desk-rtc", "0.4.1")])                                          # a newer one replaces it
        self.assertEqual(os.listdir(pathlib.Path(self.db.STATE_DIR) / "pending"), ["7"])
        st = self.state()
        st["appliedSeq"], st["pending"], st["phase"] = 7, None, "applied"
        self.db.save(st)
        self.refused("seq", self.offer, 7, [("desk-rtc", "0.4.1")])                    # applied: never again
        self.refused("seq", self.offer, 6, [("desk-rtc", "0.4.1")])
        st["failedSeq"] = 9
        self.db.save(st)
        self.refused("seq", self.offer, 9, [("desk-rtc", "0.4.1")])                    # failed: never again
        self.offer(10, [("desk-rtc", "0.4.0")])                                         # a rollback batch: higher seq, older version

    def test_the_images_baseline(self):
        pathlib.Path(self.db.BASELINE).write_text('{"seq": 12}\n')
        self.refused("seq", self.offer, 12, [("desk-rtc", "0.4.0")])
        self.offer(13, [("desk-rtc", "0.4.0")])
        pathlib.Path(self.db.BASELINE).write_text("garbage")
        self.refused("seq", self.offer, 14, [("desk-rtc", "0.4.0")])                    # unreadable: refuse everything

    def test_manifests_that_are_refused(self):
        comps = [("desk-rtc", "0.4.0")]
        good = json.loads(self.manifest(5, comps))
        bad = [
            ({**good, "format": "ma-desk-batch/2"}, "format"),
            ({**good, "seq": True}, "seq"), ({**good, "seq": 0}, "seq"), ({**good, "seq": 1.5}, "seq"),
            ({**good, "id": "a b"}, "id"), ({**good, "created": "2026-11-09 18:00"}, "created"),
            ({**good, "urgent": "no"}, "urgent"), ({**good, "image": "../x"}, "image"),
            ({**good, "note": "bell\x07"}, "note"), ({**good, "note": "x" * 2001}, "note"),
            ({**good, "components": []}, "components"),
            ({**good, "components": good["components"] * 2}, "twice"),
            ({**good, "components": [{**good["components"][0], "name": "bin"}]}, "name"),
            ({**good, "components": [{**good["components"][0], "name": "Desk"}]}, "name"),
            ({**good, "components": [{**good["components"][0], "sha256": "AB" * 32}]}, "sha256"),
            ({**good, "components": [{**good["components"][0], "version": "a/b"}]}, "version"),
        ]
        for m, what in bad:
            with self.subTest(what=what):
                data = json.dumps(m).encode()
                self.refused("bad_request", self.db.offer, data, sign(self.key, data), self.urls(comps))
        for data in (b'{"format": "ma-desk-batch/1", "seq": 5, "seq": 6}', b'{"seq": NaN}', b"[]", b"\xff"):
            with self.subTest(data=data):
                self.refused("bad_request", self.db.offer, data, sign(self.key, data), self.urls(comps))
        data = json.dumps({**good, "later": {"field": 1}}).encode()   # unknown fields are ignored
        self.db.offer(data, sign(self.key, data), self.urls(comps))

    def test_urls_that_are_refused(self):
        comps = [("desk-rtc", "0.4.0"), ("deskd", "d2")]
        m = self.manifest(5, comps)
        s = sign(self.key, m)
        u = self.urls(comps)
        for bad in ({"components": {"desk-rtc": u["components"]["desk-rtc"]}},
                    {"components": {**u["components"], "desk-stream": "https://x/y"}},
                    {"components": {**u["components"], "deskd": "http://x/y"}},
                    {"components": {**u["components"], "deskd": "https://x/y z"}},
                    {**u, "expiresAt": "soon"}, [], {"components": []}):
            with self.subTest(urls=bad):
                self.refused("bad_request", self.db.offer, m, s, bad)

    def test_an_offer_while_applying_is_busy(self):
        self.offer(5, [("desk-rtc", "0.4.0")])
        st = self.state()
        st["phase"], st["progress"] = "activating", {"seq": 5, "toSwitch": ["desk-rtc"], "switched": []}
        self.db.save(st)
        self.refused("busy", self.offer, 6, [("desk-rtc", "0.4.1")])


class IdleTest(Base):
    def test_fails_closed(self):
        self.assertEqual(self.db.idle_now(), (False, "no idle.json"))
        self.idle(at=self.clock[0] - 61)
        self.assertFalse(self.db.idle_now()[0])
        self.idle(at=self.clock[0] + 120)
        self.assertFalse(self.db.idle_now()[0])
        pathlib.Path(self.db.IDLE_FILE).write_text("{not json")
        self.assertFalse(self.db.idle_now()[0])
        pathlib.Path(self.db.IDLE_FILE).write_text(json.dumps({"at": self.db.utc(self.clock[0])}))
        self.assertFalse(self.db.idle_now()[0])
        self.idle()
        self.assertTrue(self.db.idle_now()[0])
        self.db.IDLE_UID = os.getuid() + 1   # not deskd's
        self.assertFalse(self.db.idle_now()[0])
        self.db.IDLE_UID = os.getuid()
        os.unlink(self.db.IDLE_FILE)
        os.symlink(self.t / "elsewhere.json", self.db.IDLE_FILE)
        self.idle_target = self.t / "elsewhere.json"
        self.idle_target.write_text("{}")
        self.assertFalse(self.db.idle_now()[0])

    def test_anything_running_is_not_idle(self):
        for kw in ({"sessions": 1}, {"agent": 1}, {"exports": 1}, {"idle_for": None}):
            with self.subTest(**kw):
                self.idle(**kw)
                self.assertFalse(self.db.idle_now()[0])
        self.idle(downloads=2)   # a download holds a Chromium close or a root swap, not a service batch
        self.assertTrue(self.db.idle_now()[0])

    def test_how_long_counts(self):
        cases = [(599, None, False), (600, None, True),           # deskd says no idle-stop time: 10 minutes
                 (599, 1200, False), (600, 1200, True),           # half the idle-stop time
                 (3599, 86400, False), (3600, 86400, True)]       # at most an hour
        for idle_for, stop, want in cases:
            with self.subTest(idle_for=idle_for, stop=stop):
                self.idle(idle_for=idle_for, stop=stop)
                self.assertEqual(self.db.idle_now()[0], want)
        self.idle(stop=0)
        self.assertFalse(self.db.idle_now()[0])

    def test_an_urgent_batch_relaxes_after_a_day_then_three(self):
        p = {"urgent": True, "offeredAt": self.db.utc(self.clock[0])}
        self.idle(sessions=1, idle_for=None, lastInputAt=self.db.utc(self.clock[0] - 900))
        self.assertFalse(self.db.idle_now(p)[0])
        self.now(24 * 3600)
        self.idle(sessions=1, idle_for=None, lastInputAt=self.db.utc(self.clock[0] - 899))
        self.assertFalse(self.db.idle_now(p)[0])
        self.idle(sessions=1, idle_for=None, lastInputAt=self.db.utc(self.clock[0] - 900))
        self.assertTrue(self.db.idle_now(p)[0])
        self.assertFalse(self.db.idle_now({**p, "urgent": False})[0])
        self.idle(sessions=1, idle_for=None)                 # no lastInputAt, a session: can't tell
        self.assertFalse(self.db.idle_now(p)[0])
        self.now(48 * 3600)
        self.idle(sessions=2, agent=1, idle_for=None, lastInputAt=self.db.utc(self.clock[0] - 60))
        self.assertTrue(self.db.idle_now(p)[0])
        self.idle(sessions=2, idle_for=None, lastInputAt=self.db.utc(self.clock[0] - 59))
        self.assertFalse(self.db.idle_now(p)[0])


class ApplyTest(Base):
    def setUp(self):
        super().setUp()
        self.install("desk-rtc", "0.4.1")
        self.install("deskd", "d1")

    def tick(self):
        self.assertEqual(self.db.tick(), 0)
        return self.state()

    def test_not_idle_applies_nothing(self):
        self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d0")])
        st = self.tick()
        self.assertEqual(self.calls(), [])
        self.assertEqual(st["phase"], "pending")
        self.idle(at=self.clock[0] - 120)   # stale
        st = self.tick()
        self.assertEqual(self.calls(), [])
        self.assertIn("old", st["idle"]["reason"])

    def test_idle_prepares_everything_then_activates_in_order(self):
        self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d0")], note="Back to last week's.")
        self.idle()
        st = self.tick()
        self.assertEqual(self.calls(), [["desk-rtc", "--prepare"], ["deskd", "--prepare"],
                                        ["desk-rtc", "--activate"], ["deskd", "--activate"]])
        self.assertEqual((st["phase"], st["appliedSeq"], st["pending"], st["holdUntil"]), ("applied", 5, None, None))
        self.assertEqual(st["applied"]["note"], "Back to last week's.")
        self.assertEqual(st["lastBatch"]["switched"], ["desk-rtc", "deskd"])
        self.assertEqual((self.link("desk-rtc", "current"), self.link("desk-rtc", "previous")), ("0.4.0", "0.4.1"))
        self.assertEqual(os.listdir(pathlib.Path(self.db.STATE_DIR) / "pending"), [])
        self.assertFalse(any("apt" in c[0] for c in self.calls()))
        self.refused("seq", self.offer, 5, [("desk-rtc", "0.4.0")])
        # forward again, a higher seq
        self.offer(6, [("desk-rtc", "0.4.1"), ("deskd", "d1")])
        st = self.tick()
        self.assertEqual((st["phase"], st["appliedSeq"]), ("applied", 6))
        self.assertEqual(self.link("desk-rtc", "current"), "0.4.1")

    def test_components_already_current_are_left_alone(self):
        self.offer(5, [("desk-rtc", "0.4.1"), ("deskd", "d0")])
        self.idle()
        self.tick()
        self.assertEqual(self.calls(), [["deskd", "--prepare"], ["deskd", "--activate"]])
        self.offer(6, [("desk-rtc", "0.4.1"), ("deskd", "d0")])
        st = self.tick()
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual((st["phase"], st["appliedSeq"]), ("applied", 6))

    def test_a_prepare_that_fails_switches_nothing_and_gives_up_after_three(self):
        self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d0")])
        (self.fake / "fail-prepare-deskd").touch()
        self.idle()
        st = self.tick()
        self.assertEqual(self.calls(), [["desk-rtc", "--prepare"], ["deskd", "--prepare"]])
        self.assertEqual((st["phase"], st["pending"]["attempts"], st["pending"]["urlsWanted"]), ("pending", 1, True))
        self.assertEqual(st["lastError"]["code"], "prepare")
        self.assertEqual((self.link("desk-rtc", "current"), self.link("deskd", "current")), ("0.4.1", "d1"))
        self.tick()
        self.assertEqual(len(self.calls()), 2, "it waits for new URLs")
        for attempt in (2, 3):
            m = (pathlib.Path(self.db.STATE_DIR) / "pending" / "5" / "manifest.json").read_bytes()
            self.db.offer(m, sign(self.key, m), self.urls([("desk-rtc", "0.4.0"), ("deskd", "d0")]))
            self.tick()
            self.assertEqual(len(self.calls()), 2 * attempt - 2, "and an hour between tries")
            self.now(3601)
            self.idle()
            st = self.tick()
        self.assertEqual((st["phase"], st["failedSeq"], st["pending"]), ("failed", 5, None))
        self.assertIn(["desk-rtc", "--unprepare"], self.calls())
        self.assertNotIn("--activate", [c[1] for c in self.calls()])
        self.refused("seq", self.offer, 5, [("desk-rtc", "0.4.0"), ("deskd", "d0")])

    def test_an_activate_that_fails_rolls_back_what_was_switched_and_never_retries(self):
        self.install("desk-stream", "s1")
        self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d0"), ("desk-stream", "s0")])
        (self.fake / "fail-activate-deskd").touch()
        self.idle()
        st = self.tick()
        self.assertEqual(self.calls(), [["desk-rtc", "--prepare"], ["deskd", "--prepare"], ["desk-stream", "--prepare"],
                                        ["desk-rtc", "--activate"], ["deskd", "--activate"], ["desk-rtc", "--rollback"],
                                        ["deskd", "--unprepare"], ["desk-stream", "--unprepare"]])
        self.assertEqual((st["phase"], st["failedSeq"], st["appliedSeq"], st["pending"]), ("rolled-back", 5, 0, None))
        self.assertIn("rolled back desk-rtc", st["lastError"]["text"])
        self.assertEqual([self.link(n, "current") for n in ("desk-rtc", "deskd", "desk-stream")], ["0.4.1", "d1", "s1"])
        self.tick()
        self.assertEqual(len(self.calls()), 8, "never tried again")
        self.refused("seq", self.offer, 5, [("desk-rtc", "0.4.0")])
        self.offer(6, [("desk-rtc", "0.4.0")])

    def test_prepared_then_not_idle_waits_and_activates_at_the_next_idle(self):
        self.offer(5, [("desk-rtc", "0.4.0")])
        self.idle()
        real = self.db.idle_now
        answers = iter([(True, "idle"), (False, "1 sessions")])
        self.db.idle_now = lambda p=None: next(answers)
        st = self.tick()
        self.db.idle_now = real
        self.assertEqual(st["phase"], "prepared")
        self.assertEqual(self.calls(), [["desk-rtc", "--prepare"]])
        self.assertEqual(self.link("desk-rtc", "current"), "0.4.1")
        self.now(7200)   # the URLs may have run out by now: a prepared batch needs none
        pending = self.state()["pending"]
        pending["urlsExpireAt"] = self.db.utc(self.clock[0] - 1)
        st = self.state()
        st["pending"] = pending
        self.db.save(st)
        self.idle()
        st = self.tick()
        self.assertEqual(st["phase"], "applied")
        self.assertEqual(self.calls()[-1], ["desk-rtc", "--activate"])

    def test_urls_about_to_expire_are_asked_for_again(self):
        comps = [("desk-rtc", "0.4.0")]
        m = self.manifest(5, comps)
        self.db.offer(m, sign(self.key, m), self.urls(comps, expires=self.db.utc(self.clock[0] + 300)))
        self.idle()
        st = self.tick()
        self.assertTrue(st["pending"]["urlsWanted"])
        self.assertEqual(self.calls(), [])
        self.db.offer(m, sign(self.key, m), self.urls(comps, expires=self.db.utc(self.clock[0] + 3600)))
        st = self.tick()
        self.assertEqual(st["phase"], "applied")

    def test_an_image_left_to_swap_is_root_pending(self):
        self.offer(5, [("desk-rtc", "0.4.0")], image="0.3.3")
        self.idle()
        st = self.tick()
        self.assertEqual((st["phase"], st["rootPending"], st["appliedSeq"]), ("root-pending", {"seq": 5, "image": "0.3.3"}, 5))
        self.offer(6, [("desk-rtc", "0.4.1")], image="0.3.2")   # the image this desk runs: nothing to swap
        st = self.tick()
        self.assertEqual((st["phase"], st["rootPending"]), ("applied", None))

    def test_a_cut_off_activate_finishes_without_waiting_for_idle(self):
        self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d0")])
        self.idle()
        real = self.db.activate
        self.db.activate = lambda *a, **k: None   # the tick dies after the prepare
        self.tick()
        self.db.activate = real
        st = self.state()
        self.assertEqual(st["phase"], "prepared")
        # it switched desk-rtc, then died mid-activate
        subprocess.run([self.db.MA_UPDATE, "desk-rtc", "--activate", "0.4.0"], check=True)
        st["phase"], st["progress"] = "activating", {"seq": 5, "toSwitch": ["desk-rtc", "deskd"], "switched": [],
                                                     "startedAt": self.db.utc(self.clock[0])}
        self.db.save(st)
        os.unlink(self.db.IDLE_FILE)   # not idle: it finishes anyway
        st = self.tick()
        self.assertEqual(st["phase"], "applied")
        self.assertEqual(self.calls()[-1], ["deskd", "--activate"])
        self.assertEqual([c for c in self.calls() if c == ["desk-rtc", "--activate"]], [["desk-rtc", "--activate"]])

    def test_a_cut_off_activate_that_left_the_desk_unhealthy_is_put_back(self):
        self.offer(5, [("desk-rtc", "0.4.0"), ("deskd", "d0")])
        for n, v in (("desk-rtc", "0.4.0"), ("deskd", "d0")):
            url, sha = self.artifact(n, v)
            subprocess.run([self.db.MA_UPDATE, n, "--prepare", url, sha], check=True)
        subprocess.run([self.db.MA_UPDATE, "desk-rtc", "--activate", "0.4.0"], check=True)
        st = self.state()
        st["phase"], st["progress"] = "activating", {"seq": 5, "toSwitch": ["desk-rtc", "deskd"], "switched": ["desk-rtc"],
                                                     "startedAt": self.db.utc(self.clock[0])}
        self.db.save(st)
        (self.fake / "unhealthy").touch()
        st = self.tick()
        self.assertEqual((st["phase"], st["failedSeq"]), ("rolled-back", 5))
        self.assertEqual(self.link("desk-rtc", "current"), "0.4.1")
        self.assertIn(["desk-rtc", "--rollback"], self.calls())

    def test_a_cut_off_prepare_switched_nothing(self):
        self.offer(5, [("desk-rtc", "0.4.0")])
        st = self.state()
        st["phase"], st["progress"] = "preparing", {"seq": 5, "toSwitch": ["desk-rtc"], "switched": []}
        st["holdUntil"] = self.db.utc(self.clock[0] + 900)
        self.db.save(st)
        st = self.tick()
        self.assertEqual((st["phase"], st["holdUntil"]), ("pending", None))
        self.assertEqual(self.calls(), [])

    def test_a_hold_is_kept_while_working_and_cleared_after(self):
        self.offer(5, [("desk-rtc", "0.4.0")])
        self.idle()
        seen = []
        real = self.db.ma_update

        def watch(*a, **k):
            seen.append(self.state()["holdUntil"])
            return real(*a, **k)
        self.db.ma_update = watch
        st = self.tick()
        self.assertTrue(seen and all(h == self.db.utc(T0 + 900) for h in seen), seen)
        self.assertIsNone(st["holdUntil"])

    def test_a_superseded_batchs_prepared_release_is_dropped(self):
        self.install("desk-stream", "s1")
        url, sha = self.artifact("desk-stream", "s0")
        subprocess.run([self.db.MA_UPDATE, "desk-stream", "--prepare", url, sha], check=True)
        self.offer(5, [("desk-rtc", "0.4.0")])
        self.idle()
        self.tick()
        self.assertIn(["desk-stream", "--unprepare"], self.calls())
        self.assertIsNone(self.link("desk-stream", "prepared"))


class AptTest(Base):
    def apt(self):
        p = self.fake / "apt"
        return p.read_text().splitlines() if p.exists() else []

    def test_only_while_idle_or_after_three_days(self):
        self.db.tick()
        self.assertEqual(self.apt(), [])
        self.idle()
        self.db.tick()
        self.assertEqual(self.apt(), ["apt-get update", "unattended-upgrade ", "apt-get clean"])
        st = self.state()
        self.assertEqual((st["apt"]["lastResult"], st["apt"]["forced"]), ("ok", False))
        self.now(23 * 3600)
        self.idle()
        self.db.tick()
        self.assertEqual(len(self.apt()), 3, "once a day")
        self.now(3600)
        os.unlink(self.db.IDLE_FILE)
        self.db.tick()
        self.assertEqual(len(self.apt()), 3, "due, but not idle")
        self.now(48 * 3600 - 1)
        self.db.tick()
        self.assertEqual(len(self.apt()), 3)
        self.now(2)
        self.db.tick()
        self.assertEqual(len(self.apt()), 6, "72 hours with no idle")
        self.assertTrue(self.state()["apt"]["forced"])

    def test_a_new_desk_waits_for_idle_or_72_hours_from_its_first_tick(self):
        self.db.tick()
        self.now(72 * 3600 - 10)
        self.db.tick()
        self.assertEqual(self.apt(), [])
        self.now(20)
        self.db.tick()
        self.assertEqual(len(self.apt()), 3)

    def test_a_failure_is_tried_again_an_hour_later(self):
        (self.fake / "fail-unattended-upgrade").touch()
        self.idle()
        self.db.tick()
        self.assertEqual(self.state()["apt"]["lastResult"], "unattended-upgrade: exit 1")
        self.assertEqual(len(self.apt()), 2, "clean isn't run after a failure")
        self.now(1800)
        self.idle()
        self.db.tick()
        self.assertEqual(len(self.apt()), 2)
        self.now(1801)
        self.idle()
        (self.fake / "fail-unattended-upgrade").unlink()
        self.db.tick()
        self.assertEqual(self.state()["apt"]["lastResult"], "ok")

    def test_runs_at_the_lowest_priority(self):
        self.db.LOW = ["/usr/bin/env", "MA_LOW=1"]
        bin_ = pathlib.Path(self.db.APT_UPDATE[0]).parent
        (bin_ / "apt-get").write_text('#!/bin/bash\necho "apt-get $* low=${MA_LOW:-}" >> "$FAKE/apt"\n')
        self.idle()
        self.db.tick()
        self.assertEqual(self.apt()[0], "apt-get update low=1")
        self.assertEqual(load().LOW, ["/usr/bin/nice", "-n", "19", "/usr/bin/ionice", "-c3"])

    def test_not_on_a_tick_that_worked_on_a_batch(self):
        self.install("desk-rtc", "0.4.1")
        self.offer(5, [("desk-rtc", "0.4.0")])
        self.idle()
        self.db.tick()
        self.assertEqual(self.apt(), [])
        self.db.tick()
        self.assertEqual(len(self.apt()), 3)


class FactsTest(Base):
    def test_chromium_pending_when_its_binary_was_replaced_under_it(self):
        chromium = self.t / "chromium"
        chromium.mkdir()
        exe = chromium / "chromium"
        shutil.copy("/bin/sleep", exe)
        proc = subprocess.Popen([str(exe), "30"])
        try:
            cg = pathlib.Path(self.db.BROWSER_CGROUP)
            cg.mkdir()
            (cg / "cgroup.procs").write_text(f"{proc.pid}\n")
            self.db.CHROMIUM_DIR = str(chromium) + "/"
            for _ in range(100):
                if os.readlink(f"/proc/{proc.pid}/exe") == str(exe):
                    break
                time.sleep(0.01)
            self.assertEqual(self.db.chromium_facts(), {"installed": "156.0.8078.79-1~deb13u1", "running": True, "pending": False})
            exe.unlink()   # as dpkg does when it upgrades the package
            self.assertEqual(self.db.chromium_facts()["pending"], True)
        finally:
            proc.kill()
            proc.wait()
        self.assertEqual(self.db.chromium_facts()["running"], False)

    def test_reboot_pending_for_a_newer_kernel(self):
        self.assertFalse(self.db.reboot_facts()["pending"])
        (pathlib.Path(self.db.BOOT_DIR) / "vmlinuz-1.0.0-old").touch()
        self.assertFalse(self.db.reboot_facts()["pending"])
        (pathlib.Path(self.db.BOOT_DIR) / "vmlinuz-999.0.0-cloud-arm64").touch()
        self.assertEqual(self.db.reboot_facts(), {"running": os.uname().release, "installed": "999.0.0-cloud-arm64", "pending": True})
        (pathlib.Path(self.db.BOOT_DIR) / "vmlinuz-999.0.0-cloud-arm64").unlink()
        pathlib.Path(self.db.REBOOT_REQUIRED).touch()
        self.assertTrue(self.db.reboot_facts()["pending"])

    def test_the_tick_records_both(self):
        self.db.tick()
        st = self.state()
        self.assertEqual(st["chromium"]["installed"], "156.0.8078.79-1~deb13u1")
        self.assertFalse(st["reboot"]["pending"])

    def test_never_the_browser_profile(self):
        src = HELPER.read_text()
        code = src.split('"""', 2)[2]   # past the docstring
        self.assertNotIn("/data/browser", code)
        self.assertNotIn("reboot", [w for line in code.splitlines() if "subprocess" in line for w in line.split('"')])


class HoldAndSocketTest(Base):
    def test_hold(self):
        self.assertEqual(self.db.hold(15), self.db.utc(T0 + 900))
        self.refused("bad_request", self.db.hold, 16)
        self.assertEqual(self.db.status()["holdUntil"], self.db.utc(T0 + 900))
        self.now(901)
        self.assertIsNone(self.db.status()["holdUntil"])
        self.db.hold(5)
        self.assertIsNone(self.db.hold(0))

    def ask(self, line, uid=None):
        self.db.DESKD_UID = os.getuid() if uid is None else uid
        a, b = socket.socketpair()
        try:
            t = threading.Thread(target=self.db.serve, args=(b,))
            t.start()
            a.sendall(line)
            a.shutdown(socket.SHUT_WR)
            out = b""
            while True:
                chunk = a.recv(65536)
                if not chunk:
                    break
                out += chunk
                if out.endswith(b"\n"):
                    break
            t.join(10)
            return out.decode()
        finally:
            a.close()
            b.close()

    def test_the_socket(self):
        self.assertTrue(self.ask(b"status\n").startswith("ok {"))
        st = json.loads(self.ask(b"status\n")[3:])
        self.assertEqual((st["phase"], st["floorSeq"]), ("none", 0))
        self.assertEqual(self.ask(b"hold 10\n"), f'ok {{"holdUntil": "{self.db.utc(T0 + 600)}"}}\n')
        self.assertTrue(self.ask(b"hold 99\n").startswith("err bad_request"))
        comps = [("desk-rtc", "0.4.0")]
        m = self.manifest(5, comps)
        req = {"manifest": base64.b64encode(m).decode(), "signature": base64.b64encode(sign(self.key, m)).decode(),
               "urls": self.urls(comps)}
        self.assertEqual(self.ask(b"offer " + json.dumps(req).encode() + b"\n"), 'ok {"seq": 5, "id": "b5"}\n')
        self.assertTrue(self.ask(b"offer " + json.dumps(req).encode() + b"\n").startswith("ok"))   # same batch again is fine
        req["signature"] = base64.b64encode(sign(self.other_key, m)).decode()
        self.assertTrue(self.ask(b"offer " + json.dumps(req).encode() + b"\n").startswith("err untrusted"))
        self.assertTrue(self.ask(b"offer {}\n").startswith("err bad_request"))
        self.assertTrue(self.ask(b"reboot\n").startswith("err bad_request"))
        self.assertTrue(self.ask(b"status").startswith("err bad_request"), "no newline")
        self.assertTrue(self.ask(b"status\n", uid=os.getuid() + 1).startswith("err denied"))
        big = b"offer " + b"x" * (300 * 1024) + b"\n"
        self.assertTrue(self.ask(big).startswith("err bad_request"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
