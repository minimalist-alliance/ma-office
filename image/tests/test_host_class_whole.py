#!/usr/bin/python3 -I
"""`desk-host class <k> --whole`, the host link's set_class (S-119, contract shared-host.md 0.3.46; ADR 0072 section 16): a running
desk's class changed in place, and a raise the host has no room for changes nothing at all. Plain `desk-host class` keeps its
behaviour (CPU and pids at once, memory waiting as pending, exit 75), which the contract would count as done ("+pending"), so the
link uses --whole and is told 75 with nothing applied; nothing changes either while the host is stopping (stop-all's mark).

The real desk-host and classes.py run here as root in a user, mount and network namespace of their own (unshare), as
test_host_stop_all.py does: tmpfs on /run, /var/lib, /var/log, /srv and /sys/fs/cgroup (desk-1's cgroup is plain files holding a
free desk's values; desk-2 to desk-7 are six standard desks' memory, so a raise doesn't fit DesksPerHost 6), overlays on /etc and
/usr/local/lib (the image's classes.conf and desk-host's library), and a fake runc. No root, no host, no AWS. Skipped where
unprivileged user namespaces are off. python3 -I image/tests/test_host_class_whole.py"""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
LIB = IMAGE / "host" / "recipe" / "files" / "usr/local/lib/desk-host"
CLASSES = IMAGE / "host" / "recipe" / "files" / "etc/desk-host/classes.conf"
FAKE_RUNC = r"""#!/bin/bash
d=${FAKE_RUNC_DIR:?}
case "$1" in
list) for f in "$d"/*; do [ -f "$f" ] && basename "$f"; done; exit 0 ;;
state) [ -f "$d/$2" ] || { echo "container does not exist" >&2; exit 1; }; printf '{"id":"%s","pid":4242,"status":"%s"}\n' "$2" "$(cat "$d/$2")" ;;
*) echo "fake runc: $*" >&2; exit 1 ;;
esac
"""
FILES = ("cpu.idle", "cpu.weight", "memory.max", "memory.swap.max", "memory.zswap.max", "memory.zswap.writeback", "pids.max", "io.max")


def userns_ok():
    if not shutil.which("unshare"):
        return False
    with tempfile.TemporaryDirectory() as t:
        os.mkdir(f"{t}/u")
        os.mkdir(f"{t}/w")
        r = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "--net", "sh", "-c",
                            f"mount -t tmpfs t /sys/fs/cgroup && mount -t overlay o -o lowerdir=/usr/local/lib,upperdir={t}/u,workdir={t}/w /usr/local/lib && id -u"],
                           capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == "0"


@unittest.skipUnless(userns_ok(), "unprivileged user namespaces are off here")
class ClassWhole(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="dh-class-whole-"))
        (self.tmp / "bin").mkdir()
        (self.tmp / "bin" / "runc").write_text(FAKE_RUNC)
        (self.tmp / "bin" / "runc").chmod(0o755)
        for d in ("ctr", "etc-u", "etc-w", "lib-u", "lib-w", "out"):
            (self.tmp / d).mkdir()

    def tearDown(self):
        for w in ("etc-w", "lib-w"):   # an overlay's work directory is left mode 000
            for d, _, _ in os.walk(self.tmp / w):
                os.chmod(d, 0o700)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_host(self, script, full=True):
        """script runs as root in the namespace with DH (the desk-host under test) and slot 1 running a free desk; `full`: desk-2 to
        desk-7 hold six standard desks' memory. Each file of desk-1's cgroup and its class.json are copied to out/<when>/."""
        t = self.tmp
        pre = textwrap.dedent(f"""\
            set -u
            mount -t tmpfs t /run && mount -t tmpfs t /var/lib && mount -t tmpfs t /var/log || exit 99
            mount -t overlay overlay -o lowerdir=/etc,upperdir={t}/etc-u,workdir={t}/etc-w /etc || exit 99
            mount -t overlay overlay -o lowerdir=/usr/local/lib,upperdir={t}/lib-u,workdir={t}/lib-w /usr/local/lib || exit 99
            mount -t tmpfs t /sys/fs/cgroup && mount -t tmpfs t /srv && mkdir /srv/desk-host && mount -t tmpfs t /srv/desk-host || exit 99
            mkdir -p /var/lib/desk-host /run/desk-host/1 /etc/desk-host /usr/local/lib/desk-host /sys/fs/cgroup/desk-host/desk-1
            cp {LIB}/*.py {LIB}/desk-host {LIB}/desk-host-check /usr/local/lib/desk-host/ && chmod 755 /usr/local/lib/desk-host/desk-host
            cp {CLASSES} /etc/desk-host/classes.conf && : > /etc/desk-host/desk-host.conf
            echo '{{"desksPerHost": 6, "slotsPerHost": 6, "hostingVersion": "test", "slotMode": "port"}}' > /var/lib/desk-host/hosting.json
            export PATH="{t}/bin:$PATH" FAKE_RUNC_DIR="{t}/ctr"
            DH=/usr/local/lib/desk-host/desk-host; L=/usr/local/lib/desk-host; cg=/sys/fs/cgroup/desk-host/desk-1
            echo running > $FAKE_RUNC_DIR/dh-desk-1
            store=$(findmnt -no MAJ:MIN /srv/desk-host)
            read -r w m sw zw p rrb rri rwb rwi vrb vri vwb vwi <<<"$(python3 -I $L/classes.py values free unknown)"
            echo 1 > $cg/cpu.idle; echo 1 > $cg/cpu.weight; echo $m > $cg/memory.max; echo $sw > $cg/memory.swap.max
            echo $zw > $cg/memory.zswap.max; echo 0 > $cg/memory.zswap.writeback; echo $p > $cg/pids.max; echo 104857600 > $cg/memory.current
            printf '%s rbps=%s wbps=%s riops=%s wiops=%s\\n259:9 rbps=%s wbps=%s riops=%s wiops=%s\\n' $store $rrb $rwb $rri $rwi $vrb $vwb $vri $vwi > $cg/io.max
            python3 -I -c 'import json, sys; v = json.loads(sys.argv[1]); v["pending"] = None; json.dump(v, open("/run/desk-host/1/class.json", "w"))' "$(python3 -I $L/classes.py json free unknown)"
            echo '{{"slot":1,"deskId":"d-testwholeaaa","epoch":1}}' > /run/desk-host/1/slot.json
            echo '{{"device":"/dev/nonexistent-volume","refused":[]}}' > /run/desk-host/1.mounts.json
            if [ {int(full)} = 1 ]; then
              sm=$(python3 -I $L/classes.py values standard unknown | cut -d' ' -f2)
              for j in 2 3 4 5 6 7; do mkdir /sys/fs/cgroup/desk-host/desk-$j; echo $sm > /sys/fs/cgroup/desk-host/desk-$j/memory.max; done
            fi
            snap() {{ mkdir -p {t}/out/$1; for f in {' '.join(FILES)}; do cp $cg/$f {t}/out/$1/$f; done; cp /run/desk-host/1/class.json {t}/out/$1/class.json; }}
            python3 -I $L/classes.py json standard unknown > {t}/out/standard.json   # what standard is here, for the test
            snap before
            """)
        r = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "--net", "--propagation", "private", "bash", "-c",
                            pre + script + "\nsnap after\n"], capture_output=True, text=True, timeout=120)
        self.assertNotEqual(r.returncode, 99, r.stderr)
        return r

    def files(self, when):
        return {f: (self.tmp / "out" / when / f).read_text() for f in FILES + ("class.json",)}

    def test_whole_with_no_room_changes_nothing(self):
        r = self.run_host('"$DH" class 1 standard --whole; echo "rc=$?"')
        self.assertIn("rc=75", r.stdout, r.stderr)
        self.assertIn("Refused whole: nothing changed", r.stderr)
        self.assertEqual(self.files("before"), self.files("after"), "a refused --whole raise changed desk-1's cgroup or its record")

    def test_plain_class_with_no_room_still_applies_cpu_and_waits(self):
        """Plain `class` as before (verify.sh's 4b): CPU and pids at once, memory.max kept and pending, 75."""
        r = self.run_host('"$DH" class 1 standard; echo "rc=$?"')
        self.assertIn("rc=75", r.stdout, r.stderr)
        b, a = self.files("before"), self.files("after")
        self.assertEqual((a["cpu.idle"].strip(), a["cpu.weight"].strip(), a["pids.max"].strip()), ("0", "100", "8192"))
        self.assertEqual(a["memory.max"], b["memory.max"])
        rec = json.loads(a["class.json"])
        self.assertEqual(rec["class"], "standard")
        self.assertIsNotNone(rec["pending"])

    def test_whole_on_a_stopping_host_changes_nothing(self):
        r = self.run_host(': > /run/desk-host/halt; "$DH" class 1 standard --whole; echo "rc=$?"', full=False)
        self.assertIn("rc=1", r.stdout, r.stderr)
        self.assertIn("the host is stopping every desk", r.stderr)
        self.assertEqual(self.files("before"), self.files("after"))

    def test_whole_with_room_is_the_class_in_place(self):
        r = self.run_host('"$DH" class 1 standard --whole; echo "rc=$?"', full=False)
        self.assertIn("rc=0", r.stdout, r.stderr)
        a = self.files("after")
        std = json.loads((self.tmp / "out" / "standard.json").read_text())
        self.assertEqual((a["cpu.idle"].strip(), a["cpu.weight"].strip(), a["pids.max"].strip()), ("0", "100", "8192"))
        self.assertEqual(int(a["memory.max"]), std["memory.max"])
        self.assertEqual(int(a["memory.zswap.max"]), std["memory.zswap.max"])
        rec = json.loads(a["class.json"])
        self.assertEqual((rec["class"], rec["pending"]), ("standard", None))
        self.assertIn("is standard now, in place", r.stdout)

    def test_whole_anywhere_and_no_other_word(self):
        """--whole before or after the class; no other word is taken."""
        r = self.run_host('"$DH" class --whole 1 standard; echo "rc=$?"; "$DH" class 1 standard --whole extra; echo "rc2=$?"', full=False)
        self.assertIn("rc=0", r.stdout, r.stderr)
        self.assertIn("rc2=1", r.stdout)
        self.assertIn("usage: desk-host class <k> [<class>] [--whole]", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
