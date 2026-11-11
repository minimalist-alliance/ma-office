#!/usr/bin/python3 -I
"""desk-host prepare and the slot store's room, with no root and no AWS: python3 -I image/host/tests/test_prepare.py

Platform's reclaim wave (2026-11-11) filled two hosts' 36 GB stores: six prepares at once each copied a new root beside the slot's old
one, and a copy that failed left its partial behind. These tests run desk-host's own prepare functions, cut from the script as it is,
in bash over fake trees in a temporary directory, with the host's tools stubbed (chattr, lsattr, setquota, shift.py) and a tar wrapper
that looks at the store as each copy begins. Each fault:
- 1: the slot's old root is gone before its copy starts;
- 2: every copy holds the host's copy turn, and six prepares at once never copy at the same time;
- 3: a copy that fails (tar, shift.py, cp) or a prepare stopped by SIGTERM leaves no tree and lets the turn go;
- the room check: with no room a prepare refuses (75) before it makes anything; a tree a dead prepare left is removed in the turn.
- The wave itself on a size-capped store (a tmpfs in a user namespace; skipped where there is none): six at once with room for one root
  more all succeed; with three slots empty, the two that can't fit refuse cleanly and succeed one at a time once there's room; and with
  the three fixes taken out (0.1.11's prepare, verify-wave.sh's mutation) the same wave fails with ENOSPC and leaves partials.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.normpath(os.path.join(HERE, "../recipe/files/usr/local/lib/desk-host"))
SRC = open(os.path.join(LIB, "desk-host")).read()
GENS = "cur_gen()" in SRC   # the template generations (ADR 0077, main) or one template (the 0.1.11 line)
SVCS = ("deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream")
REAL = {c: shutil.which(c) for c in ("tar", "cp", "flock")}
# 0.1.11's prepare, as verify-wave.sh's mutation makes it on a host: the old root deleted after the rename, no copy turn and no room
# check, and the unfinished tree left where it is
MUTATION = 'prep_old_root() { :; }; prep_turn() { :; }; prep_drop() { exec 7>&-; PREP_NEW=""; }'


def fn(name):
    """desk-host's own function <name>, as written."""
    lines = SRC.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(f"{name}() {{"):
            if line.count("{") == line.count("}"):
                return line
            j = i + 1
            while lines[j] != "}":
                j += 1
            return "\n".join(lines[i:j + 1])
    raise KeyError(name)


FUNCS = ["lock_slot", "copy_turn", "copy_done", "prep_drop", "prep_old_root", "prep_turn", "prepare", "prepare_root"]
if GENS:
    FUNCS += ["gen_path", "gen_ok", "rr_drop"]   # the room check is desk-host-template room (templates.py prepare_room)
else:
    FUNCS += ["template_id", "prep_room"]


def stub(path, body):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, 0o755)


class Store:
    """A fake host under <root>: the store (template, releases, slots), records, /run, the stubs; and a harness that runs prepare <k>."""

    def __init__(self, root, tpl_files=4, file_kib=256):
        self.root = root
        self.dh = f"{root}/store"
        self.tpl = f"{self.dh}/templates/g1" if GENS else f"{self.dh}/template"
        self.s = f"{self.dh}/slots"
        self.rec = f"{root}/rec"
        self.run = f"{root}/run"
        self.lib = f"{root}/lib"
        self.bin = f"{root}/bin"
        self.tpl_files, self.file_kib = tpl_files, file_kib
        for d in (self.rec, self.run, self.lib, self.bin):
            os.makedirs(d, exist_ok=True)
        self._stubs()
        self._harness()

    def build(self):
        """The template, the release store and the slots' directory (inside the namespace, for a tmpfs store)."""
        os.makedirs(f"{self.tpl}/etc", exist_ok=True)
        os.makedirs(f"{self.tpl}/data", exist_ok=True)
        with open(f"{self.tpl}/etc/ma-release", "w") as f:
            f.write("version=0.1.11-test\n")
        for i in range(self.tpl_files):
            with open(f"{self.tpl}/data/f{i}", "wb") as f:
                f.write(os.urandom(self.file_kib * 1024))
        with open(f"{self.tpl}/.complete", "w") as f:
            f.write("gen=g1\n" if GENS else "tpl-test-1\n")
        for c in SVCS:
            d = f"{self.dh}/releases/{c}/v1"
            os.makedirs(d, exist_ok=True)
            with open(f"{d}/run", "wb") as f:
                f.write(os.urandom(32 * 1024))
            os.symlink("v1", f"{self.dh}/releases/{c}/current")
        with open(f"{self.dh}/releases/deskd/v1/lib", "wb") as f:   # hard links, as deskd's and desk-agent's releases have (116 each)
            f.write(os.urandom(1024 * 1024))
        for i in range(8):
            os.link(f"{self.dh}/releases/deskd/v1/lib", f"{self.dh}/releases/deskd/v1/lib.{i}")
        os.makedirs(self.s, exist_ok=True)

    def old_root(self, k):
        """Slot k's root as a desk left it, and its record."""
        d = f"{self.s}/{k}"
        os.makedirs(f"{d}/rootfs/data", exist_ok=True)
        os.makedirs(f"{d}/svc", exist_ok=True)
        for i in range(self.tpl_files):
            with open(f"{d}/rootfs/data/f{i}", "wb") as f:
                f.write(os.urandom(self.file_kib * 1024))
        with open(f"{d}/rootfs/OLD", "w") as f:
            f.write("the desk's old root\n")
        os.makedirs(f"{d}/rel", exist_ok=True)
        for c in SVCS:   # the release copies as a prepare made them (hard links kept)
            if not os.path.isdir(f"{d}/rel/{c}"):
                subprocess.run([REAL["cp"], "-a", f"{self.dh}/releases/{c}/current/.", f"{d}/rel/{c}"], check=True)
        with open(f"{self.rec}/{k}.json", "w") as f:
            json.dump({"slot": k, "state": "desk", "deskId": f"d-test{k:06d}", "template": "g1"}, f)

    def _stubs(self):
        stub(f"{self.bin}/chattr", f'#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -p ] && {{ echo "$2" > {self.root}/proj; shift; }}; shift; done\nexit 0\n')
        stub(f"{self.bin}/lsattr", f'#!/bin/sh\necho "$(cat {self.root}/proj) ---------- $2"\n')
        stub(f"{self.bin}/setquota", "#!/bin/sh\nexit 0\n")
        # the extract side of prepare's copy: the store as it begins, the copy turn's state, then the real tar (or a partial and a failure)
        stub(f"{self.bin}/tar", textwrap.dedent(f"""\
            #!/bin/bash
            case " $* " in *" -xpf "*) ;; *) exec {REAL['tar']} "$@" ;; esac
            lock=free; {REAL['flock']} -n {self.run}/lock/copy true || lock=held
            echo "$(date +%s.%N) start $$ lock=$lock store=[$(ls -A {self.s} | tr '\\n' ' ')]" >> {self.root}/copies.log
            if [ "${{FAKE_TAR_FAIL:-}}" = 1 ]; then head -c 65536 /dev/zero > "$2/partial"; echo "tar: write error: No space left on device" >&2; exit 2; fi
            {REAL['tar']} "$@"; rc=$?
            sleep "${{FAKE_TAR_HOLD:-0}}"
            echo "$(date +%s.%N) end $$ rc=$rc" >> {self.root}/copies.log
            exit $rc
            """))
        stub(f"{self.bin}/cp", f'#!/bin/sh\n[ "$FAKE_CP_FAIL" = 1 ] && {{ echo "cp: error writing: No space left on device" >&2; exit 1; }}\nexec {REAL["cp"]} "$@"\n')
        stub(f"{self.lib}/shift.py", '#!/usr/bin/python3\nimport os, sys\nsys.exit(1 if os.environ.get("FAKE_SHIFT_FAIL") == "1" else 0)\n')
        if GENS:
            # desk-host-template (python3 -I $TT ...): current, halted (none), and room as templates.py has it on this store;
            # desk-host-batch: record
            stub(f"{self.lib}/desk-host-template", textwrap.dedent(f"""\
                import subprocess, sys
                a = sys.argv[1:]
                if a[:1] == ["current"]:
                    print("g1"); sys.exit(0)
                if a[:1] == ["halted"]:
                    sys.exit(1)
                sys.exit(subprocess.run([sys.executable, "-I", {LIB + '/desk-host-template'!r}, *a]).returncode)
                """))
            stub(f"{self.lib}/desk-host-batch", "import sys\nsys.exit(0)\n")

    def _harness(self):
        head = textwrap.dedent(f"""\
            set -euo pipefail
            umask 022
            LIB={self.lib}; DH={self.dh}; S={self.s}; REC={self.rec}; RUN={self.run}
            {'TPL=$DH/templates; TT=$LIB/desk-host-template; BT=$LIB/desk-host-batch' if GENS else 'T=$DH/template'}
            QUOTA_HEAD_MB=1; QUOTA_HEAD_INODES=100; PREP_SPARE_MB=${{PREP_SPARE_MB:-1}}; TEST=0
            export PATH={self.bin}:$PATH DESK_HOST_STORE={self.dh} DESK_HOST_TEMPLATES={self.dh}/templates DESK_HOST_RECORDS={self.rec} \\
              DESK_HOST_RUN={self.run} DESK_HOST_TEMPLATES_VAR={self.root}/var DESK_HOST_LIB={LIB} DESK_HOST_TEMPLATES_TEST=1
            log() {{ echo "[desk-host] $*"; }}
            die() {{ echo "desk-host: $*" >&2; exit 1; }}
            leftovers() {{ :; }}
            cur_gen() {{ echo g1; }}
            write_record() {{ printf '{{"slot": %s, "state": "%s", "template": "g1"}}\\n' "$1" "$2" > "$REC/$1.json.tmp" && mv "$REC/$1.json.tmp" "$REC/$1.json"; }}
            """)
        body = "\n".join(fn(n) for n in FUNCS)
        tail = textwrap.dedent(f"""\
            PREP_NEW=""
            [ "${{MUTATE:-}}" = 1 ] && {{ {MUTATION}; }}
            K=$1
            lock_slot "$K"; trap prep_drop EXIT; trap 'exit 143' TERM INT HUP
            {'COPY_MODE=${HARNESS_COPY_MODE:-bg} ' if GENS else ''}prepare "$K"
            """)
        with open(f"{self.root}/prepare.sh", "w") as f:
            f.write(head + body + "\n" + tail)

    # ---- what a test reads
    def partials(self):
        return sorted(n for n in os.listdir(self.s) if re.match(r"^\.\d+\.(new|old)\.\d+$", n))

    def copies(self):
        rows = []
        try:
            with open(f"{self.root}/copies.log") as fh:
                for line in fh:
                    f = line.split()
                    rows.append((float(f[0]), f[1], f[2], " ".join(f[3:])))
        except OSError:
            pass
        return rows

    def prepare(self, k, env=None, **kw):
        return subprocess.run(["bash", f"{self.root}/prepare.sh", str(k)], capture_output=True, text=True, env={**os.environ, **(env or {})}, **kw)


class Prepare(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="prep-test-")
        self.st = Store(self.root)
        self.st.build()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def ok(self, r, k):
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.isfile(f"{self.st.s}/{k}/rootfs/etc/ma-release"))
        self.assertTrue(os.path.isdir(f"{self.st.s}/{k}/rel/deskd"))
        with open(f"{self.st.rec}/{k}.json") as f:
            self.assertEqual(json.load(f)["state"], "fresh")

    def turn_free(self):
        return subprocess.run([REAL["flock"], "-n", f"{self.st.run}/lock/copy", "true"]).returncode == 0

    def test_fault1_old_root_gone_before_the_copy(self):
        self.st.old_root(1)
        r = self.st.prepare(1)
        self.ok(r, 1)
        (start,) = [c for c in self.st.copies() if c[1] == "start"]
        seen = re.search(r"store=\[(.*)\]", start[3]).group(1).split()
        self.assertEqual([n for n in seen if not n.startswith(".1.new.")], [], "the old root (or its .old) was on the store as the copy began")
        self.assertFalse(os.path.exists(f"{self.st.s}/1/rootfs/OLD"))
        self.assertEqual(self.st.partials(), [])

    def test_fault2_copies_hold_the_turn_and_never_overlap(self):
        for k in range(1, 7):
            self.st.old_root(k)
        ps = [subprocess.Popen(["bash", f"{self.root}/prepare.sh", str(k)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               env={**os.environ, "FAKE_TAR_HOLD": "0.3"}) for k in range(1, 7)]
        outs = [p.communicate()[0] for p in ps]
        self.assertEqual([p.returncode for p in ps], [0] * 6, "\n".join(outs))
        rows = self.st.copies()
        starts = sorted(c for c in rows if c[1] == "start")
        ends = sorted(c for c in rows if c[1] == "end")
        self.assertEqual(len(starts), 6)
        self.assertTrue(all("lock=held" in c[3] for c in starts), starts)
        spans = sorted((s[0], next(e[0] for e in ends if e[2] == s[2])) for s in starts)
        for (a0, a1), (b0, _) in zip(spans, spans[1:]):
            self.assertGreaterEqual(b0, a1, f"two copies at once: {spans}")
        self.assertEqual(self.st.partials(), [])
        self.assertTrue(self.turn_free())

    def test_fault3_a_failed_copy_leaves_nothing(self):
        for knob in ("FAKE_TAR_FAIL", "FAKE_SHIFT_FAIL", "FAKE_CP_FAIL"):
            with self.subTest(knob=knob):
                self.st.old_root(2)
                r = self.st.prepare(2, {knob: "1"})
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn(r.returncode, (75, 143))
                self.assertEqual(self.st.partials(), [], r.stdout + r.stderr)
                self.assertFalse(os.path.exists(f"{self.st.s}/2"), "a root after a failed prepare")
                self.assertFalse(os.path.exists(f"{self.st.rec}/2.json"))
                self.assertTrue(self.turn_free(), "the copy turn is still held")
                self.ok(self.st.prepare(2), 2)   # and the next prepare of that slot works

    def test_fault3_sigterm_leaves_nothing(self):
        # SIGTERM to the prepare's process group, as main's copy turn takes the turn from a background holder
        self.st.old_root(3)
        p = subprocess.Popen(["bash", f"{self.root}/prepare.sh", "3"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env={**os.environ, "FAKE_TAR_HOLD": "30"}, start_new_session=True)
        for _ in range(200):
            if any(c[1] == "start" for c in self.st.copies()):
                break
            time.sleep(0.05)
        time.sleep(0.3)
        self.assertEqual(len(self.st.partials()), 1)   # the tree being made
        os.killpg(p.pid, 15)
        out = p.communicate(timeout=30)[0]
        self.assertEqual(p.returncode, 143, out)
        self.assertEqual(self.st.partials(), [], out)
        self.assertTrue(self.turn_free())

    def test_the_room_check_counts_a_root_as_the_copy_takes_it(self):
        # tar and cp -a keep hard links: a release with a 1 MiB file under nine names takes 1 MiB in the slot's rel/, not 9
        self.ok(self.st.prepare(1), 1)
        if GENS:
            with open(f"{self.st.run}/prepare-releases.json") as f:
                est = json.load(f)["bytes"]
            got = sum(int(subprocess.run(["du", "-s", "-B1", f"{self.st.s}/1/rel/{c}"], capture_output=True, text=True).stdout.split()[0]) for c in SVCS)
        else:
            with open(f"{self.st.run}/prepare-root.json") as f:
                est = json.load(f)["bytes"]
            got = sum(int(subprocess.run(["du", "-s", "-B1", d], capture_output=True, text=True).stdout.split()[0])
                      for d in [f"{self.st.s}/1/rootfs"] + [f"{self.st.s}/1/rel/{c}" for c in SVCS])
        self.assertLess(abs(est - got), 0.25 * got, f"estimate {est}, the copy took {got}")

    @unittest.skipUnless(GENS, "main's copy turn: a start (fg) takes it from a background prepare")
    def test_a_start_takes_the_turn_from_a_background_prepare(self):
        self.st.old_root(1)
        self.st.old_root(2)
        bg = subprocess.Popen(["bash", f"{self.root}/prepare.sh", "1"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                              env={**os.environ, "FAKE_TAR_HOLD": "30"}, start_new_session=True)
        for _ in range(200):
            if any(c[1] == "start" for c in self.st.copies()):
                break
            time.sleep(0.05)
        time.sleep(0.3)
        with open(f"{self.st.run}/copy.holder") as f:
            self.assertEqual(f.read().strip(), str(bg.pid), "the background prepare's own process group holds the turn")
        fg = self.st.prepare(2, {"HARNESS_COPY_MODE": "fg"}, timeout=60)
        out = bg.communicate(timeout=30)[0]
        self.ok(fg, 2)
        self.assertIn("taking the copy turn from a background copy", fg.stdout)
        self.assertEqual(bg.returncode, 143, out)
        self.assertEqual(self.st.partials(), [], out)
        self.assertFalse(os.path.exists(f"{self.st.run}/copy.holder"))
        self.assertTrue(self.turn_free())

    def test_no_room_refuses_before_anything(self):
        self.st.old_root(4)
        r = self.st.prepare(4, {"PREP_SPARE_MB": str(10 ** 9)})
        self.assertEqual(r.returncode, 75, r.stdout + r.stderr)
        self.assertIn("slot 4: refused for room: the store has", r.stderr)
        self.assertIn("nothing copied", r.stderr)
        self.assertEqual(self.st.copies(), [], "a copy began")
        self.assertEqual(self.st.partials(), [])
        self.assertTrue(self.turn_free())
        self.ok(self.st.prepare(4), 4)

    def test_a_dead_prepares_tree_is_removed_in_the_turn(self):
        dead = f"{self.st.s}/.3.new.{2 ** 22 + 7}"   # past pid_max's default, so no live process has it
        os.makedirs(f"{dead}/rootfs")
        live = subprocess.Popen(["sleep", "30"])
        busy = f"{self.st.s}/.4.old.{live.pid}"
        os.makedirs(f"{busy}/rootfs")
        try:
            self.ok(self.st.prepare(1), 1)
            self.assertFalse(os.path.exists(dead))
            self.assertTrue(os.path.exists(busy), "a live prepare's tree was removed")
        finally:
            live.kill()
            live.wait()


# ---- the wave on a size-capped store: a tmpfs in a user namespace (unshare -rm), all of it run inside by one driver
WAVE = r"""
set -u
R=$1 MODE=$2 MUT=$3
mount -t tmpfs -o size=64m tmpfs "$R/store"
PREP_TEST_INNER=1 python3 -I "$R/build.py" "$MODE" || exit 9
root=$(du -sk "$R/store/slots/1" | cut -f1)
free=$(df -k --output=avail "$R/store" | tail -1)
fallocate -l $((free - root - 1024 - 512))K "$R/store/.fill"   # room for one root, the spare (1 MiB) and half a MiB
echo "root $root KiB; free before the wave $(df -k --output=avail "$R/store" | tail -1) KiB"
( while :; do df -k --output=avail "$R/store" | tail -1 >> "$R/avail.log"; sleep 0.02; done ) & mon=$!
declare -A pid rc
for k in 1 2 3 4 5 6; do MUTATE=$MUT FAKE_TAR_HOLD=0.4 bash "$R/prepare.sh" $k > "$R/out.$k" 2>&1 & pid[$k]=$!; done
for k in 1 2 3 4 5 6; do wait ${pid[$k]}; rc[$k]=$?; echo "rc $k ${rc[$k]}"; done
kill $mon; wait $mon 2>/dev/null
echo "min avail $(sort -n "$R/avail.log" | head -1) KiB"
echo "partials [$(ls -A "$R/store/slots" | grep -E '^\.[0-9]+\.(new|old)\.' | tr '\n' ' ')]"
grep -l 'No space left' "$R"/out.* | sed 's/^/enospc /'
rm -f "$R/store/.fill"
for k in 1 2 3 4 5 6; do [ "${rc[$k]}" = 75 ] || continue; bash "$R/prepare.sh" $k > "$R/retry.$k" 2>&1; echo "retry $k $?"; done
echo "after [$(ls -A "$R/store/slots" | tr '\n' ' ')]"
"""


def userns():
    if os.environ.get("PREP_TEST_INNER") == "1":   # build.py, inside the namespace
        return False
    try:
        return subprocess.run(["unshare", "-rm", "sh", "-c", "mount -t tmpfs -o size=1m tmpfs /mnt"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


@unittest.skipUnless(userns(), "no unprivileged user namespace with a tmpfs here")
class Wave(unittest.TestCase):
    def wave(self, mode, mutate=False):
        root = tempfile.mkdtemp(prefix="prep-wave-")
        try:
            st = Store(root, tpl_files=8, file_kib=512)
            os.makedirs(st.dh)
            with open(f"{root}/build.py", "w") as f:   # the trees, inside the namespace, on the tmpfs
                f.write(f"import sys\nsys.path.insert(0, {HERE!r})\nsys.argv = [sys.argv[0]] + sys.argv[1:]\n"
                        f"import test_prepare as t\nst = t.Store.__new__(t.Store)\nst.__dict__.update({json.dumps({k: v for k, v in vars(st).items()})})\n"
                        "st.build()\nfor k in ((1, 2, 3, 4, 5, 6) if sys.argv[1] == 'all' else (1, 2, 3)):\n    st.old_root(k)\n")
            with open(f"{root}/wave.sh", "w") as f:
                f.write(WAVE)
            r = subprocess.run(["unshare", "-rm", "bash", f"{root}/wave.sh", root, mode, "1" if mutate else "0"], capture_output=True, text=True,
                               timeout=300, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            out = r.stdout + r.stderr
            rcs = {int(k): int(v) for k, v in re.findall(r"^rc (\d) (\d+)$", out, re.M)}
            retries = {int(k): int(v) for k, v in re.findall(r"^retry (\d) (\d+)$", out, re.M)}
            partials = re.search(r"^partials \[(.*)\]$", out, re.M).group(1).split()
            outs = {}
            for k in range(1, 7):
                with open(f"{root}/out.{k}") as f:
                    outs[k] = f.read()
            return rcs, retries, partials, "enospc " in out, out, outs
        finally:
            subprocess.run(["rm", "-rf", root])

    def test_wave_all_six_with_room_for_one(self):
        rcs, _, partials, enospc, out, outs = self.wave("all")
        self.assertEqual(rcs, {k: 0 for k in range(1, 7)}, out + json.dumps(outs, indent=1))
        self.assertEqual(partials, [], out)
        self.assertFalse(enospc, out)

    def test_wave_three_empty_slots_refuse_cleanly_then_succeed_one_at_a_time(self):
        rcs, retries, partials, enospc, out, outs = self.wave("half")
        self.assertEqual(sorted(rcs.values()), [0, 0, 0, 0, 75, 75], out + json.dumps(outs, indent=1))
        self.assertEqual(partials, [], out)
        self.assertFalse(enospc, out)
        refused = sorted(k for k, v in rcs.items() if v == 75)
        for k in refused:
            self.assertIn(f"slot {k}: refused for room", outs[k])
        self.assertEqual(retries, {k: 0 for k in refused}, out)   # one at a time, once there's room

    def test_the_mutation_fails_the_wave(self):
        rcs, _, partials, enospc, out, outs = self.wave("all", mutate=True)
        bad = [k for k, v in rcs.items() if v not in (0, 75)]
        self.assertTrue(bad and partials and enospc, "0.1.11's prepare passed the wave: " + out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
