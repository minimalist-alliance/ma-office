#!/usr/bin/python3 -I
"""ma-update's refusal of desk-rtc 0.2.0 on images from 0.2.2, and its prepare, activate and unprepare (desk batches, S-96),
on a temporary MA_ROOT with fake docker and systemctl.

No root: each run is root only inside an unprivileged user and mount namespace (`unshare -rm`), with its own tmpfs on /run
for ma-update's lock. Skipped where unshare can't do that. python3 -I image/tests/test_ma_update.py"""
import hashlib
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
MA_UPDATE = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "opt" / "ma" / "bin" / "ma-update"
NS = ["unshare", "-rm", "sh", "-c", 'mount -t tmpfs tmpfs /run && exec "$@"', "sh"]


def userns_works():
    try:
        return subprocess.run(NS + ["true"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


@unittest.skipUnless(userns_works(), "unshare -rm isn't allowed here")
class RefuseDeskRtc020Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.root, self.bin, self.art = t / "opt-ma", t / "bin", t / "art"
        for d in (self.root, self.bin, self.art):
            d.mkdir()
        # No unit, so nothing is restarted; docker has no images to load or prune.
        for name, body in (("systemctl", "exit 1"), ("docker", "exit 0"), ("smoke", "exit 0")):
            f = self.bin / name
            f.write_text(f"#!/bin/sh\n{body}\n")
            f.chmod(0o755)
        self.release = t / "ma-release"

    def tearDown(self):
        self.tmp.cleanup()

    def image(self, version):
        if version is None:
            self.release.unlink(missing_ok=True)
        else:
            self.release.write_text(f"version={version}\nbuilt=2026-11-07T00:00:00Z\n")

    def artifact(self, version):
        tgz = self.art / f"{version}.tgz"
        if tgz.exists():
            return f"file://{tgz}", hashlib.sha256(tgz.read_bytes()).hexdigest()
        src = self.art / f"src-{version}"
        src.mkdir()
        (src / "VERSION").write_text(version + "\n")
        for name in ("run", "health"):
            (src / name).write_text("#!/bin/sh\nexit 0\n")
            (src / name).chmod(0o755)
        with tarfile.open(tgz, "w:gz") as tar:
            for p in sorted(src.iterdir()):
                tar.add(p, arcname=p.name)
        return f"file://{tgz}", hashlib.sha256(tgz.read_bytes()).hexdigest()

    def ma_update(self, *args):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "MA_ROOT": str(self.root), "MA_SMOKE_TEST": str(self.bin / "smoke"),
               "MA_SMOKE_WAIT": "0", "MA_RELEASE_FILE": str(self.release)}
        return subprocess.run(NS + ["bash", str(MA_UPDATE), *args], env=env, capture_output=True, text=True, timeout=60)

    def install(self, comp, version):
        return self.ma_update(comp, *self.artifact(version))

    def links(self, comp):
        d = self.root / comp
        return {n: (d / n).resolve().name if (d / n).is_symlink() else None for n in ("current", "previous")}

    def test_refused_on_a_release_image_and_nothing_changes(self):
        self.image("0.2.1")
        self.assertEqual(self.install("desk-rtc", "0.3.5").returncode, 0)
        self.image("0.2.9")
        r = self.install("desk-rtc", "0.2.0")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("desk-rtc 0.2.0 must never run on image 0.2.9", r.stderr)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.3.5", "previous": None})
        self.assertEqual(sorted(p.name for p in (self.root / "desk-rtc" / "releases").iterdir()), ["0.3.5"])

    def test_refused_on_0_2_2_and_on_images_with_no_number(self):
        # 0.2.2 is the first image it breaks; a test bake, a self-hosted desk and a missing file are all newer.
        for img in ("0.2.2", "0.2.10", "1.0.0", "test-fixes-1", "selfhost-1a2b3c4", "", None):
            with self.subTest(image=img):
                self.image(img)
                r = self.install("desk-rtc", "0.2.0")
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn("must never run", r.stderr)
                self.assertFalse((self.root / "desk-rtc" / "current").exists())

    def test_allowed_on_the_images_it_ran_on(self):
        for img in ("0.1.4", "0.2.0", "0.2.1"):
            with self.subTest(image=img):
                self.image(img)
                r = self.install("desk-rtc", "0.2.0")
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(self.links("desk-rtc")["current"], "0.2.0")
                subprocess.run(["rm", "-rf", str(self.root / "desk-rtc")], check=True)

    def test_only_desk_rtc_0_2_0(self):
        self.image("0.2.9")
        self.assertEqual(self.install("desk-rtc", "0.2.1").returncode, 0)
        self.assertEqual(self.install("deskd", "0.2.0").returncode, 0)
        self.assertEqual(self.links("deskd")["current"], "0.2.0")

    def test_a_rollback_to_0_2_0_is_refused_too(self):
        self.image("0.2.1")
        self.assertEqual(self.install("desk-rtc", "0.2.0").returncode, 0)
        self.assertEqual(self.install("desk-rtc", "0.3.5").returncode, 0)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.3.5", "previous": "0.2.0"})
        self.image("0.2.9")
        r = self.ma_update("desk-rtc", "--rollback")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("must never run", r.stderr)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.3.5", "previous": "0.2.0"})
        self.image("0.2.1")
        self.assertEqual(self.ma_update("desk-rtc", "--rollback").returncode, 0)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.2.0", "previous": "0.3.5"})


FAKE_DOCKER = r"""#!/bin/bash
# load -i <tar>: an image whose ID is the tar's hash; images -q --no-trunc; image inspect --format ... <ref>; rmi -f <id>
S=$STUB_DIR
case "$1" in
  load) id="sha256:$(sha256sum "$3" | cut -d' ' -f1)"; echo "$id" >> "$S/images"; echo "load $3" >> "$S/docker.log"
        echo "Loaded image ID: $id" ;;
  images) sort -u "$S/images" 2>/dev/null || true ;;
  image) echo "${@: -1}" ;;
  rmi) grep -vxF "$3" "$S/images" > "$S/images.new" || true; mv "$S/images.new" "$S/images"; echo "rmi $3" >> "$S/docker.log" ;;
  *) exit 1 ;;
esac
"""
# Units exist for the components the test names in $STUB_DIR/units; restarts are logged.
FAKE_SYSTEMCTL = r"""#!/bin/bash
S=$STUB_DIR
case "$1" in
  cat) [ -e "$S/units/$2" ] ;;
  reset-failed) exit 0 ;;
  restart|try-restart|stop) echo "$1 $2" >> "$S/systemctl.log" ;;
  *) exit 1 ;;
esac
"""
# The smoke test as /opt/ma/smoke-test runs it: every current/health under MA_ROOT.
FAKE_SMOKE = r"""#!/bin/bash
rc=0
for cur in "$MA_ROOT"/*/current; do [ -x "$cur/health" ] || continue; RELEASE_DIR=$cur "$cur/health" || rc=1; done
exit $rc
"""


@unittest.skipUnless(userns_works(), "unshare -rm isn't allowed here")
class PrepareActivateTest(unittest.TestCase):
    """--prepare, --activate and --unprepare, and that an install and a rollback still do what they did."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.root, self.bin, self.art, self.stub = t / "opt-ma", t / "bin", t / "art", t / "stub"
        for d in (self.root, self.bin, self.art, self.stub, self.stub / "units"):
            d.mkdir()
        for name, body in (("systemctl", FAKE_SYSTEMCTL), ("docker", FAKE_DOCKER), ("smoke", FAKE_SMOKE)):
            f = self.bin / name
            f.write_text(body)
            f.chmod(0o755)
        self.release = t / "ma-release"
        self.release.write_text("version=0.3.1\n")
        for comp in ("desk-rtc", "deskd"):
            (self.stub / "units" / f"{comp}.service").touch()

    def tearDown(self):
        self.tmp.cleanup()

    def artifact(self, comp, version, healthy=True, image=False, salt=""):
        tgz = self.art / f"{comp}-{version}{salt}.tgz"
        src = self.art / f"src-{comp}-{version}{salt}"
        src.mkdir()
        (src / "VERSION").write_text(version + "\n")
        (src / "run").write_text("#!/bin/sh\nexit 0\n")
        (src / "health").write_text(f"#!/bin/sh\nexit {0 if healthy else 1}\n")
        for name in ("run", "health"):
            (src / name).chmod(0o755)
        if image:
            (src / "image.tar").write_bytes(f"image of {comp} {version}{salt}".encode())
        with tarfile.open(tgz, "w:gz") as tar:
            for p in sorted(src.iterdir()):
                tar.add(p, arcname=p.name)
        return f"file://{tgz}", hashlib.sha256(tgz.read_bytes()).hexdigest()

    def ma_update(self, *args):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "MA_ROOT": str(self.root), "MA_SMOKE_TEST": str(self.bin / "smoke"),
               "MA_SMOKE_WAIT": "0", "MA_RELEASE_FILE": str(self.release), "STUB_DIR": str(self.stub)}
        return subprocess.run(NS + ["bash", str(MA_UPDATE), *args], env=env, capture_output=True, text=True, timeout=60)

    def ok(self, *args):
        r = self.ma_update(*args)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def links(self, comp):
        d = self.root / comp
        return {n: (d / n).resolve().name if (d / n).is_symlink() else None for n in ("current", "previous", "prepared")}

    def releases(self, comp):
        return sorted(p.name for p in (self.root / comp / "releases").iterdir())

    def log(self, name):
        p = self.stub / name
        return p.read_text().splitlines() if p.exists() else []

    def images(self):
        p = self.stub / "images"
        return set(p.read_text().split()) if p.exists() else set()

    def test_prepare_switches_nothing_and_activate_switches(self):
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        (self.stub / "systemctl.log").unlink()
        self.ok("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.4.0"))
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.1", "previous": None, "prepared": "0.4.0"})
        self.assertEqual(self.log("systemctl.log"), [], "a prepare restarts nothing")
        self.ok("desk-rtc", "--activate", "0.4.0")
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.0", "previous": "0.4.1", "prepared": None})
        self.assertEqual(self.log("systemctl.log"), ["restart desk-rtc.service"])

    def test_activate_that_fails_its_smoke_test_puts_the_old_pair_back(self):
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.0"))
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        self.ok("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.5.0", healthy=False))
        r = self.ma_update("desk-rtc", "--activate", "0.5.0")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.1", "previous": "0.4.0", "prepared": None})
        self.assertEqual(self.releases("desk-rtc"), ["0.4.0", "0.4.1"])

    def test_an_artifact_the_desk_has_needs_no_download(self):
        cur_url, cur_sha = self.artifact("desk-rtc", "0.4.0")
        self.ok("desk-rtc", cur_url, cur_sha)
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        gone = "file:///nonexistent/never-fetched.tgz"
        # previous: prepared from what's there, then an activate is a swap
        self.ok("desk-rtc", "--prepare", gone, cur_sha)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.1", "previous": "0.4.0", "prepared": "0.4.0"})
        self.ok("desk-rtc", "--prepare", gone, cur_sha)   # already prepared
        self.ok("desk-rtc", "--activate", "0.4.0")
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.0", "previous": "0.4.1", "prepared": None})
        # current: nothing to prepare
        r = self.ok("desk-rtc", "--prepare", gone, cur_sha)
        self.assertIn("already current", r.stderr)
        self.assertEqual(self.links("desk-rtc")["prepared"], None)

    def test_a_failed_activate_of_what_was_previous_keeps_it(self):
        good = self.artifact("desk-rtc", "0.4.1")
        self.ok("desk-rtc", *good)
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.2"))
        self.ok("desk-rtc", "--prepare", "file:///nonexistent", good[1])
        (self.root / "desk-rtc" / "releases" / "0.4.1" / "health").write_text("#!/bin/sh\nexit 1\n")
        r = self.ma_update("desk-rtc", "--activate", "0.4.1")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.2", "previous": "0.4.1", "prepared": None})
        self.assertEqual(self.releases("desk-rtc"), ["0.4.1", "0.4.2"])

    def test_refusals_change_nothing(self):
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        url, sha = self.artifact("desk-rtc", "0.4.0")
        before = self.links("desk-rtc")
        for args, why in (((url, "0" * 64), "sha256 mismatch"), ((url, "zz"), "bad sha256"), (("http://x/y.tgz", sha), "url must be")):
            with self.subTest(why=why):
                r = self.ma_update("desk-rtc", "--prepare", *args)
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn(why, r.stderr)
                self.assertEqual(self.links("desk-rtc"), before)
        r = self.ma_update("desk-rtc", "--activate", "0.4.0")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("isn't prepared", r.stderr)
        r = self.ma_update("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.4.1", salt="-other"))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("from another artifact", r.stderr)
        self.assertEqual(self.links("desk-rtc"), before)
        self.assertEqual(self.releases("desk-rtc"), ["0.4.1"])
        for bad in (["--prepare", url], ["--activate"], ["--activate", "../x"], ["--unprepare", "x"]):
            with self.subTest(args=bad):
                self.assertEqual(self.ma_update("desk-rtc", *bad).returncode, 2)

    def test_desk_rtc_0_2_0_is_refused_at_prepare_and_activate(self):
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        r = self.ma_update("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.2.0"))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("must never run", r.stderr)
        self.assertEqual(self.links("desk-rtc")["prepared"], None)

    def test_a_new_prepare_replaces_the_old_and_unprepare_drops_it(self):
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        self.ok("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.4.0"))
        self.ok("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.4.2"))
        self.assertEqual(self.links("desk-rtc")["prepared"], "0.4.2")
        self.assertEqual(self.releases("desk-rtc"), ["0.4.1", "0.4.2"])
        self.ok("desk-rtc", "--unprepare")
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.1", "previous": None, "prepared": None})
        self.assertEqual(self.releases("desk-rtc"), ["0.4.1"])
        self.ok("desk-rtc", "--unprepare")   # nothing prepared is fine

    def test_images_load_at_prepare_and_another_components_prepared_image_survives_a_prune(self):
        self.ok("deskd", *self.artifact("deskd", "a", image=True))
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        self.ok("deskd", "--prepare", *self.artifact("deskd", "b", image=True))
        rel = self.root / "deskd" / "releases" / "b"
        self.assertTrue((rel / "image-id").exists())
        self.assertFalse((rel / "image.tar").exists())
        prepared_image = (rel / "image-id").read_text().strip()
        self.assertIn(prepared_image, self.images())
        # desk-rtc's activate prunes: deskd's current and prepared images stay
        self.ok("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.4.0"))
        self.ok("desk-rtc", "--activate", "0.4.0")
        self.assertIn(prepared_image, self.images())
        self.assertIn((self.root / "deskd" / "current" / "image-id").read_text().strip(), self.images())
        self.ok("deskd", "--activate", "b")
        self.assertEqual(self.links("deskd"), {"current": "b", "previous": "a", "prepared": None})
        self.ok("deskd", "--unprepare")
        self.assertEqual(len(self.images()), 2)

    def test_install_and_rollback_still_work_beside_a_prepared_release(self):
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.0"))
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.1"))
        self.ok("desk-rtc", "--prepare", *self.artifact("desk-rtc", "0.4.2"))
        self.ok("desk-rtc", "--rollback")
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.0", "previous": "0.4.1", "prepared": "0.4.2"})
        # an install of the version a batch prepared replaces it, and the link goes
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.4.2", salt="-b"))
        self.assertEqual(self.links("desk-rtc"), {"current": "0.4.2", "previous": "0.4.0", "prepared": None})

    # ---- a rollout of a version the desk already holds (same artifact), found by hash with no download
    GONE = "file:///nonexistent/never-fetched.tgz"

    def baked(self, comp, version):
        """The image's layout: installed with MA_INSTALL_ONLY=1, as build.sh does, current and no previous."""
        url, sha = self.artifact(comp, version)
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "MA_ROOT": str(self.root), "MA_SMOKE_TEST": str(self.bin / "smoke"),
               "MA_SMOKE_WAIT": "0", "MA_RELEASE_FILE": str(self.release), "STUB_DIR": str(self.stub), "MA_INSTALL_ONLY": "1"}
        r = subprocess.run(NS + ["bash", str(MA_UPDATE), comp, url, sha], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return url, sha

    def test_a_rollout_to_previous_by_version_needs_no_download(self):
        old = self.artifact("deskd", "1.0")
        self.ok("deskd", *old)
        self.ok("deskd", *self.artifact("deskd", "1.1"))
        (self.stub / "systemctl.log").unlink(missing_ok=True)
        r = self.ok("deskd", self.GONE, old[1])
        self.assertIn("nothing downloaded", r.stderr)
        self.assertEqual(self.links("deskd"), {"current": "1.0", "previous": "1.1", "prepared": None})
        self.assertEqual(self.log("systemctl.log"), ["restart deskd.service"])
        self.assertEqual(self.releases("deskd"), ["1.0", "1.1"])

    def test_baked_then_one_rollout_then_the_baked_version_by_name_and_forward_again(self):
        baked = self.baked("deskd", "1.0")
        new = self.artifact("deskd", "1.1")
        self.ok("deskd", *new)
        self.assertEqual(self.links("deskd"), {"current": "1.1", "previous": "1.0", "prepared": None})
        r = self.ok("deskd", self.GONE, baked[1])           # back to the baked version, by name
        self.assertIn("nothing downloaded", r.stderr)
        self.assertEqual(self.links("deskd"), {"current": "1.0", "previous": "1.1", "prepared": None})
        self.ok("deskd", self.GONE, new[1])                  # and forward again
        self.assertEqual(self.links("deskd"), {"current": "1.1", "previous": "1.0", "prepared": None})
        self.assertEqual(self.log("docker.log"), [])

    def test_a_rollout_to_a_prepared_release_is_a_prepare_then_an_activate(self):
        self.ok("deskd", *self.artifact("deskd", "1.0"))
        prepared = self.artifact("deskd", "1.1")
        self.ok("deskd", "--prepare", *prepared)
        self.ok("deskd", self.GONE, prepared[1])
        self.assertEqual(self.links("deskd"), {"current": "1.1", "previous": "1.0", "prepared": None})

    def test_a_failing_switch_to_a_held_release_puts_the_pair_back(self):
        old = self.artifact("deskd", "1.0")
        self.ok("deskd", *old)
        self.ok("deskd", *self.artifact("deskd", "1.1"))
        (self.root / "deskd" / "releases" / "1.0" / "health").write_text("#!/bin/sh\nexit 1\n")
        r = self.ma_update("deskd", self.GONE, old[1])
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self.links("deskd"), {"current": "1.1", "previous": "1.0", "prepared": None})
        self.assertEqual(self.releases("deskd"), ["1.0", "1.1"])

    def test_the_same_version_from_a_different_artifact_is_still_refused_and_changes_nothing(self):
        baked = self.baked("deskd", "1.0")
        self.ok("deskd", *self.artifact("deskd", "1.1"))
        before = self.links("deskd")
        for version in ("1.0", "1.1"):   # previous and current
            with self.subTest(version=version):
                (self.root / "deskd" / "releases" / version / "run").stat()
                (self.stub / "systemctl.log").unlink(missing_ok=True)
                r = self.ma_update("deskd", *self.artifact("deskd", version, salt="-rebuilt"))
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn("from another artifact", r.stderr)
                self.assertEqual(self.links("deskd"), before)
                self.assertEqual(self.releases("deskd"), ["1.0", "1.1"])
                self.assertEqual(self.log("systemctl.log"), [])
        self.assertEqual((self.root / "deskd" / "releases" / "1.0" / "artifact.sha256").read_text().strip(),
                         baked[1])

    def test_desk_rtc_0_2_0_held_as_previous_is_still_refused_by_a_rollout(self):
        self.release.write_text("version=0.2.1\n")
        old = self.artifact("desk-rtc", "0.2.0")
        self.ok("desk-rtc", *old)
        self.ok("desk-rtc", *self.artifact("desk-rtc", "0.3.5"))
        self.release.write_text("version=0.3.3\n")
        r = self.ma_update("desk-rtc", self.GONE, old[1])
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("must never run", r.stderr)
        self.assertEqual(self.links("desk-rtc"), {"current": "0.3.5", "previous": "0.2.0", "prepared": None})


if __name__ == "__main__":
    unittest.main(verbosity=2)
