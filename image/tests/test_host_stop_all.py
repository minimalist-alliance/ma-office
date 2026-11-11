#!/usr/bin/python3 -I
"""The shared host's stop (ADR 0072 section 7, IN-09, ADR 0035): `desk-host stop-all`, desk-host-shutdown.service's stop, leaves no
desk running, a desk whose start was still in flight included, and no desk starts after it until `desk-host resume`.

0.1.7 looked only for running containers. At a host stop the link stops first and KillMode=process leaves the `desk-host up` it
began running: stop-all skipped that slot (no container yet), the up finished after it, and the desk was killed with the host
instead of closed (verify-port.sh's run 5 on <ami>; the lab's repro in image/host/RELEASES.md, 0.1.8). The first
test fails on that desk-host.

The real desk-host runs here as root in a user and mount namespace of its own (unshare), with tmpfs on /run, /var/lib and /var/log
and an overlay on /etc (an empty desk-host.conf), and a fake runc (containers are files: created, running, stopped). nft, ip, conntrack and apparmor_parser are stubs that find
nothing. No root, no host, no AWS. Skipped where unprivileged user namespaces are off. python3 -I image/tests/test_host_stop_all.py"""
import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
DESK_HOST = IMAGE / "host" / "recipe" / "files" / "usr/local/lib/desk-host/desk-host"

FAKE_RUNC = r"""#!/bin/bash
# a fake runc: a container is a file in $FAKE_RUNC_DIR holding its status; every kill and delete is logged
d=${FAKE_RUNC_DIR:?}; log=$d/../runc.log
case "$1" in
list) [ "${2:-}" = -q ] || echo "ID PID STATUS"; for f in "$d"/*; do [ -f "$f" ] && basename "$f"; done; exit 0 ;;
state) [ -f "$d/$2" ] || { echo "container does not exist" >&2; exit 1; }; printf '{"id":"%s","pid":4242,"status":"%s"}\n' "$2" "$(cat "$d/$2")" ;;
kill) [ -f "$d/$2" ] || exit 1; echo "kill $2 $3 $(date +%s.%N)" >> "$log"; echo stopped > "$d/$2" ;;
delete) shift; [ "$1" = -f ] && shift; echo "delete $1" >> "$log"; rm -f "$d/$1" ;;
*) echo "fake runc: $*" >&2; exit 1 ;;
esac
"""
NOTHING = "#!/bin/sh\nexit 1\n"   # nft, ip, conntrack, apparmor_parser: nothing of a slot's outside its root, as on a clean slot


def userns_ok():
    if not shutil.which("unshare"):
        return False
    with tempfile.TemporaryDirectory() as t:
        os.mkdir(f"{t}/u")
        os.mkdir(f"{t}/w")
        r = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "sh", "-c",
                            f"mount -t tmpfs t /run && mount -t overlay o -o lowerdir=/etc,upperdir={t}/u,workdir={t}/w /etc && id -u"],
                           capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == "0"


@unittest.skipUnless(userns_ok(), "unprivileged user namespaces are off here")
class StopAll(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="dh-stop-all-"))
        b = self.tmp / "bin"
        b.mkdir()
        (b / "runc").write_text(FAKE_RUNC)
        for n in ("nft", "ip", "conntrack", "apparmor_parser"):
            (b / n).write_text(NOTHING)
        for f in b.iterdir():
            f.chmod(0o755)
        shutil.copy(DESK_HOST, self.tmp / "desk-host")
        (self.tmp / "desk-host").chmod(0o755)
        for d in ("ctr", "etc-u", "etc-w"):
            (self.tmp / d).mkdir()

    def tearDown(self):
        for d, _, _ in os.walk(self.tmp / "etc-w"):   # the overlay's work directory is left mode 000
            os.chmod(d, 0o700)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_host(self, script, timeout=120):
        """script runs as root in the namespace, with DH (the desk-host under test), ctr <id> <status> (a fake container) and
        a host of 3 slots"""
        pre = textwrap.dedent(f"""\
            set -u
            mount -t tmpfs t /run && mount -t tmpfs t /var/lib && mount -t tmpfs t /var/log || exit 99
            mount -t overlay overlay -o lowerdir=/etc,upperdir={self.tmp}/etc-u,workdir={self.tmp}/etc-w /etc || exit 99
            mkdir -p /var/lib/desk-host /run/desk-host /etc/desk-host && : > /etc/desk-host/desk-host.conf
            echo '{{"desksPerHost": 3, "slotsPerHost": 3, "hostingVersion": "test", "slotMode": "port"}}' > /var/lib/desk-host/hosting.json
            export PATH="{self.tmp}/bin:$PATH" FAKE_RUNC_DIR="{self.tmp}/ctr"
            DH="{self.tmp}/desk-host"
            ctr() {{ echo "$2" > "$FAKE_RUNC_DIR/$1"; }}
            desk() {{ ctr dh-desk-$1 "$2"; for s in desk-rtc deskd desk-agent desk-notebook desk-stream desk-data; do ctr dh-svc-$1-$s "$2"; done; }}
            """)
        r = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "--propagation", "private", "bash", "-c", pre + script],
                           capture_output=True, text=True, timeout=timeout)
        self.assertNotEqual(r.returncode, 99, r.stderr)
        return r

    def containers(self):
        return sorted(p.name for p in (self.tmp / "ctr").iterdir())

    def kills(self):
        p = self.tmp / "runc.log"
        return [(l.split() + [""])[:3] for l in p.read_text().splitlines()] if p.exists() else []

    def test_a_start_in_flight_is_stopped_not_left(self):
        """An up holds slot 2's lock, marked starting, and makes its containers after stop-all has looked (it was past its last
        check): stop-all waits for the lock and stops that desk. 0.1.7 returned at once and left it running."""
        r = self.run_host("""
            desk 1 running
            mkdir -p /run/desk-host/lock /run/desk-host/op
            ( exec 9>/run/desk-host/lock/2; flock 9; echo starting > /run/desk-host/op/2; : > /run/up-has-lock
              sleep 2; desk 2 running; rm -f /run/desk-host/op/2 ) &
            for i in $(seq 1 100); do [ -e /run/up-has-lock ] && break; sleep 0.05; done
            t0=$(date +%s.%N); "$DH" stop-all; echo "stop-all rc=$? in $(awk -v a=$t0 -v b=$(date +%s.%N) 'BEGIN{printf "%.1f", b-a}') s"
            wait
            echo "left: $(ls $FAKE_RUNC_DIR | tr '\\n' ' ')"
        """)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("stop-all rc=0", r.stdout)
        self.assertEqual(self.containers(), [], f"a desk survived stop-all: {self.containers()}\n{r.stdout}\n{r.stderr}")
        killed = {c for v, c, s in self.kills() if v == "kill" and s == "TERM"}
        self.assertIn("dh-desk-2", killed, r.stdout)
        self.assertIn("dh-desk-1", killed, r.stdout)

    def test_no_start_after_stop_all_until_resume(self):
        """stop-all marks the host halting: an up after it is refused (fault host_stopping, nothing made); resume ends it."""
        r = self.run_host("""
            "$DH" stop-all >/dev/null
            "$DH" up 3 d-stopalltest3 --public 192.0.2.10; echo "up rc=$?"
            echo "fault: $(cat /run/desk-host/fault/3 2>/dev/null || echo none)"
            echo "op: $(cat /run/desk-host/op/3 2>/dev/null || echo none)"
            "$DH" resume; echo "halt after resume: $([ -e /run/desk-host/halt ] && echo yes || echo no)"
        """)
        self.assertIn("up rc=1", r.stdout, r.stderr)
        self.assertIn("fault: host_stopping", r.stdout, r.stderr)
        self.assertIn("op: none", r.stdout)
        self.assertIn("halt after resume: no", r.stdout)
        self.assertIn("the host is stopping every desk", r.stderr)
        self.assertEqual(self.containers(), [])

    def test_order_and_every_running_desk(self):
        """Every running desk is stopped as a stop does: deskd's sandbox before the desk (its init closes Chromium), then the rest."""
        r = self.run_host("""
            desk 1 running; desk 3 running
            "$DH" stop-all
        """)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.containers(), [])
        for k in (1, 3):
            seq = [c for v, c, s in self.kills() if v == "kill" and s == "TERM" and c.startswith((f"dh-desk-{k}", f"dh-svc-{k}-"))]
            self.assertEqual(seq[:2], [f"dh-svc-{k}-deskd", f"dh-desk-{k}"], seq)
        self.assertIn("2 slot(s)", r.stdout)

    def test_the_run_directory_keeps_the_recipes_mode(self):
        """/run/desk-host stays 0711 (desk-host-check dirs) through a stop-all and its resume, and a resume puts a drifted mode back.
        0.1.13's stop-all ran `install -d -m 755` on it, which chmods a directory that exists: after verify.sh's boot mutation (a
        stop and start of desk-host-shutdown) it stayed 755, dirs failed, and desk-host up (its quick checks) refused every start."""
        r = self.run_host("""
            chmod 711 /run/desk-host   # as desk-host-boot makes it
            desk 1 running
            "$DH" stop-all >/dev/null; echo "after stop-all: $(stat -c %a /run/desk-host)"
            "$DH" resume >/dev/null; echo "after resume: $(stat -c %a /run/desk-host)"
            chmod 755 /run/desk-host   # a mode drifted (0.1.13's stop-all left this)
            "$DH" resume >/dev/null; echo "a drifted mode after resume: $(stat -c %a /run/desk-host)"
        """)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("after stop-all: 711", r.stdout, r.stderr)
        self.assertIn("after resume: 711", r.stdout, r.stderr)
        self.assertIn("a drifted mode after resume: 711", r.stdout, r.stderr)

    def test_a_prepare_does_not_hold_the_stop(self):
        """A slot's lock held with no start (a prepare: it starts no desk) isn't waited for, so a host stop isn't held by a copy."""
        r = self.run_host("""
            desk 1 running
            mkdir -p /run/desk-host/lock
            ( exec 9>/run/desk-host/lock/2; flock 9; : > /run/prep-has-lock; exec sleep 20 >/dev/null 2>&1 ) &
            for i in $(seq 1 100); do [ -e /run/prep-has-lock ] && break; sleep 0.05; done
            t0=$(date +%s); "$DH" stop-all >/dev/null; echo "stop-all took $(( $(date +%s) - t0 )) s"
            kill $! 2>/dev/null; wait
        """)
        took = int(r.stdout.split("stop-all took ")[1].split()[0])
        self.assertLess(took, 10, r.stdout)
        self.assertEqual(self.containers(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
