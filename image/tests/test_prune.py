#!/usr/bin/python3 -I
"""prune.sh's refusals, on a fake aws that plays the account and logs every call. No AWS. python3 -I image/tests/test_prune.py"""
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
PRUNE = pathlib.Path(__file__).resolve().parent.parent / "prune.sh"
AMI = "ami-0123456789abcdef0"

# Answers from files in $STUB: name, purpose, snaps, staging and prod (the settings' ami_id), instances (launched from the
# AMI), attached (instances with a volume from its snapshots). A file named <op>-fails makes that call fail.
FAKE_AWS = r"""#!/bin/bash
S=$STUB_DIR
echo "$*" >> "$S/log"
op=$2; q=""; t=""
while [ $# -gt 0 ]; do case "$1" in --query) q=$2; shift ;; --table-name) t=$2; shift ;; esac; shift; done
[ ! -f "$S/$op-fails" ] || { echo "An error occurred (AccessDenied)" >&2; exit 255; }
ans() { if [ -s "$S/$1" ]; then cat "$S/$1"; else echo "${2:-None}"; fi; }
case "$op" in
  describe-images)
    case "$q" in *Purpose*) ans purpose ;; *SnapshotId*) ans snaps ;; *Name*) ans name ;; esac ;;
  get-item)
    case "$t" in ma-staging-settings) ans staging ;; ma-prod-settings) ans prod ;; *) exit 254 ;; esac ;;
  describe-instances) ans instances "" ;;
  describe-volumes) ans attached "" ;;
  deregister-image | delete-snapshot) ;;
  *) echo "unexpected: $op" >&2; exit 99 ;;
esac
"""


class PruneTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.stub, self.bin = t / "stub", t / "bin"
        self.stub.mkdir()
        self.bin.mkdir()
        (self.bin / "aws").write_text(FAKE_AWS)
        (self.bin / "aws").chmod(0o755)
        self.set("name", "ma-desk-test-fixes-1")
        self.set("purpose", "desk-image-build")
        self.set("snaps", "snap-0aaaaaaaaaaaaaaa1")
        self.set("staging", "ami-0ffffffffffffffff")
        self.set("prod", "ami-0ffffffffffffffff")

    def tearDown(self):
        self.tmp.cleanup()

    def set(self, name, value):
        (self.stub / name).write_text(value + "\n")

    def prune(self, *args):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "STUB_DIR": str(self.stub)}
        return subprocess.run(["bash", str(PRUNE), *args], env=env, capture_output=True, text=True, timeout=30)

    def calls(self):
        log = self.stub / "log"
        return log.read_text().splitlines() if log.exists() else []

    def writes(self):
        return [c for c in self.calls() if c.split()[1] in ("deregister-image", "delete-snapshot")]

    def refused(self, *args, why):
        r = self.prune(*args)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("refusing to delete", r.stderr)
        self.assertIn(why, r.stderr)
        self.assertEqual(self.writes(), [])
        return r

    def test_a_test_bake_nobody_uses_is_deleted_with_its_snapshot(self):
        r = self.prune("delete", AMI)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.writes(), [f"ec2 deregister-image --image-id {AMI}", "ec2 delete-snapshot --snapshot-id snap-0aaaaaaaaaaaaaaa1"])
        # Every read before the first write.
        self.assertTrue(all(c.split()[1] not in ("deregister-image", "delete-snapshot") for c in self.calls()[:-2]))

    def test_staging_or_prod_desk_image_current_is_refused(self):
        for env in ("staging", "prod"):
            with self.subTest(env):
                self.set(env, AMI)
                self.refused("delete", AMI, why=f"it's {env}'s desk_image#current")
                self.refused("delete", AMI, "--release", why=f"it's {env}'s desk_image#current")
                self.set(env, "ami-0ffffffffffffffff")

    def test_a_setting_it_cant_read_is_a_refusal(self):
        self.set("get-item-fails", "")
        self.refused("delete", AMI, why="can't read staging's desk_image#current")

    def test_an_env_with_no_row_is_no_refusal(self):
        self.set("prod", "None")
        self.assertEqual(self.prune("delete", AMI).returncode, 0)

    def test_an_instance_launched_from_it_is_a_refusal(self):
        self.set("instances", "i-0bbbbbbbbbbbbbbb1")
        r = self.refused("delete", AMI, "--release", why="instance(s) i-0bbbbbbbbbbbbbbb1 use it")
        self.assertIn("Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped", " ".join(self.calls()))

    def test_a_root_swapped_to_it_is_a_refusal(self):
        self.set("attached", "i-0ccccccccccccccc1")
        self.refused("delete", AMI, why="instance(s) i-0ccccccccccccccc1 use it")
        self.assertIn("Name=snapshot-id,Values=snap-0aaaaaaaaaaaaaaa1", " ".join(self.calls()))

    def test_a_listing_it_cant_read_is_a_refusal(self):
        for op in ("describe-instances", "describe-volumes"):
            with self.subTest(op):
                self.set(f"{op}-fails", "")
                self.refused("delete", AMI, why="can't list")
                (self.stub / f"{op}-fails").unlink()

    def test_a_release_needs_the_flag(self):
        self.set("name", "ma-desk-0.2.9")
        self.refused("delete", AMI, why="it's ma-desk-0.2.9, not a test bake")
        r = self.prune("delete", AMI, "--release")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.writes()), 2)

    def test_an_ami_not_tagged_for_image_builds_is_still_refused(self):
        self.set("purpose", "something-else")
        r = self.prune("delete", AMI)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.writes(), [])

    def test_keep_is_gone(self):
        for args in (("keep",), ("keep", "2")):
            with self.subTest(args):
                r = self.prune(*args)
                self.assertEqual(r.returncode, 1)
                self.assertIn("prune.sh keep is gone", r.stderr)
                self.assertEqual(self.calls(), [])

    def test_bad_arguments(self):
        for args in ((), ("delete",), ("delete", "ami-xyz"), ("delete", AMI, "--force"), ("delete", AMI, "--release", "x")):
            with self.subTest(args):
                self.assertEqual(self.prune(*args).returncode, 1)
                self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
