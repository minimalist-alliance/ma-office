#!/usr/bin/python3 -I
"""desk-host up on a slot with no record, and the host scripts' other reads that set -e could end with no message. No root, no AWS:
python3 -I image/host/tests/test_up_norecord.py

Host image 0.1.15's lab (docs/sub-status/host-0.1.15.md, "Found"): `desk-host up` on a slot with no record exited 1 with no message.
batch_cutoff (ADR 0078 3.4) read the record with `p=$(python3 ...)` and no fallback, so under `set -euo pipefail` the failed read ended
desk-host before up_one's own "preparing from <gen> first" path. A prepare refused for room (exit 75) removes the record first, so it
left a slot every later start failed on, silently. These tests cut desk-host's own functions from the script as written and run them in
bash with the host's tools stubbed, as test_prepare.py does:
- up on a slot with no record reaches its prepare; a prepare refused there says why on stderr (its own line and up's, with the 75);
- a record that can't be read is prepared again too, with a line; a wake on a good record still gets to its admission;
- a real cut-off (a switch stopped part way) is still put back by renames, and one that can't be put back refuses, saying why;
- reroot on a slot with no record logs and returns 0; conf() with no desk-host.conf gives the defaults (desk-host and desk-host-boot);
- desk-host-boot under SlotMode=port with no default route says so in its own line.
All but two (the wake and the whole cut-off, which pass on it too and guard the fix) fail on 0.1.15's scripts (5fd4f891's).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.normpath(os.path.join(HERE, "../recipe/files/usr/local/lib/desk-host"))
SRC = open(os.path.join(LIB, "desk-host")).read()
BOOT = open(os.path.join(LIB, "desk-host-boot")).read()
DESK = "d-testdesk0001"
VOL = "vol-0123456789abcdef0"


HEREDOC = re.compile(r"(?<![<])<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")


def fn(name, src=None):
    """desk-host's own function <name>, as written: to its closing "}" line, a here-document's lines skipped (up_one's nft rules have one)."""
    lines = (src or SRC).splitlines()
    for i, line in enumerate(lines):
        if line.startswith(f"{name}() {{"):
            if line.count("{") == line.count("}"):
                return line
            j, end = i + 1, None
            while True:
                if end is not None:
                    if lines[j] == end:
                        end = None
                elif lines[j] == "}":
                    break
                else:
                    m = HEREDOC.search(lines[j].replace("<<<", ""))
                    end = m.group(1) if m else None
                j += 1
            return "\n".join(lines[i:j + 1])
    raise KeyError(name)


def stub(path, body, mode=0o755):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, mode)


class Host:
    """A fake host under <root>: a store with template generation g1 and slot 1's tree, the records, /run, a log directory, and a lib of stubs
    (slotnet.py, classes.py, desk-host-check, preread.py, desk-host-template). run(<bash>) runs desk-host's cut functions, then <bash>."""

    FUNCS = ["halting", "fault", "record_desk", "record_state", "cur_gen", "gen_path", "gen_ok", "rec_field", "json_field", "abort_reroot",
             "lock_admit", "unlock_admit", "class_values", "pj", "rel_swap_back", "rel_tidy", "batch_cutoff", "up_one", "reroot"]

    def __init__(self, root, real_lib=False):
        self.root = root
        self.dh, self.rec, self.run_, self.log = f"{root}/store", f"{root}/rec", f"{root}/run", f"{root}/log"
        self.s = f"{self.dh}/slots"
        self.stubs = f"{root}/lib"
        for d in (self.rec, self.run_, self.log, self.stubs, f"{self.dh}/templates/g1/etc", f"{self.s}/1/rootfs", f"{self.s}/1/rel"):
            os.makedirs(d, exist_ok=True)
        with open(f"{self.dh}/templates/g1/.complete", "w") as f:
            f.write("gen=g1\n")
        stub(f"{self.stubs}/slotnet.py", f"import sys\nprint('1 {VOL} 192.0.2.5 ens5 - 0a:00:00:00:00:01 standard')\n")
        stub(f"{self.stubs}/classes.py", textwrap.dedent("""\
            import os, sys
            if sys.argv[1] == "values":
                print("100 2147483648 2147483648 1048576000 8192 8300000 320 2100000 80 5200000 200 5200000 200")
            elif sys.argv[1] == "admit":
                print("the test host is full"); sys.exit(1)
            """))
        stub(f"{self.stubs}/desk-host-check", "#!/bin/sh\nexit 0\n")
        stub(f"{self.stubs}/preread.py", "import sys\n")
        stub(f"{self.stubs}/templates.py", "def load_state():\n    return {}\n\n\ndef halted_gens(st):\n    return {}\n", 0o644)
        stub(f"{self.stubs}/desk-host-template", textwrap.dedent("""\
            import json, sys
            a = sys.argv[1:]
            if a[0] == "current": print("g1")
            elif a[0] == "choose": print(json.dumps({"gen": "g1", "reason": "the test's"}))
            elif a[0] in ("unhold", "trial", "hold"): pass
            elif a[0] == "halted": sys.exit(1)
            else: sys.exit(2)
            """))
        self.lib = LIB if real_lib else self.stubs
        self.env = {**os.environ, "DESK_HOST_STORE": self.dh, "DESK_HOST_SLOTS": self.s, "DESK_HOST_RECORDS": self.rec, "DESK_HOST_RUN": self.run_,
                    "DESK_HOST_RELEASES": f"{self.dh}/releases", "DESK_HOST_TEMPLATES": f"{self.dh}/templates", "DESK_HOST_LIB": LIB,
                    "DESK_HOST_TEMPLATES_VAR": f"{root}/var/templates", "DESK_HOST_BATCH_VAR": f"{root}/var/batch",
                    "DESK_HOST_BATCH_BASELINE": f"{root}/etc/batch-baseline", "DESK_HOST_RELEASE_PIN": f"{root}/etc/releases.pin",
                    "DESK_HOST_TEMPLATES_TEST": "1", "DESK_HOST_BATCH_TEST": "1", "PYTHONDONTWRITEBYTECODE": "1"}

    def record(self, k=1, **r):
        with open(f"{self.rec}/{k}.json", "w") as f:
            json.dump({"slot": k, **r}, f)

    def read_record(self, k=1):
        with open(f"{self.rec}/{k}.json") as f:
            return json.load(f)

    def run(self, body, src=None):
        funcs = "\n".join(fn(n, src) for n in self.FUNCS).replace("/var/log/desk-host", self.log)
        head = textwrap.dedent(f"""\
            set -euo pipefail
            umask 022
            LIB={self.lib}; DH={self.dh}; TPL=$DH/templates; S={self.s}; REC={self.rec}; RUN={self.run_}; CGR={self.root}/cg
            TT={self.stubs}/desk-host-template; BT={self.stubs}/desk-host-batch; TEST=0; SLOT_MODE=address; DMX={self.root}/dmx; HALT=$RUN/halt
            log() {{ echo "[desk-host] $*"; }}
            die() {{ echo "desk-host: $*" >&2; exit 1; }}
            """)
        stubs = textwrap.dedent("""\
            itype() { echo m7g.xlarge; }
            dev_for_vol() { echo /dev/nvme9n1; }
            leftovers() { :; }
            write_record() { printf '{"slot": %s, "state": "%s", "deskId": "%s", "template": "%s"}\\n' "$1" "$2" "$3" "$4" > "$REC/$1.json"; }
            prepare() {   # the test's: PREP_RC 75 is a refusal for room as prep_turn says it; anything else ends the run here (42)
              echo "PREPARE $*"
              if [ "${PREP_RC:-0}" = 75 ]; then echo "slot $1: refused for room: the store has 1.0 GB free; nothing copied" >&2; return 75; fi
              exit 42
            }
            """)
        with open(f"{self.root}/h.sh", "w") as f:
            f.write(head + funcs + "\n" + stubs + body + "\n")
        return subprocess.run(["bash", f"{self.root}/h.sh"], capture_output=True, text=True, env=self.env, timeout=60)


UP = f'up_one 1 {DESK} {VOL} 1.2.3.4 standard\necho "UP RETURNED $?"'


class UpNoRecord(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="up-norecord-")
        self.h = Host(self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_up_with_no_record_reaches_its_prepare(self):
        r = self.h.run(UP)
        self.assertEqual(r.returncode, 42, f"up ended before its prepare: rc {r.returncode}, stdout {r.stdout!r}, stderr {r.stderr!r}")
        self.assertIn("record is none none on -, starting d-testdesk0001: preparing from g1 first", r.stdout)
        self.assertIn("PREPARE 1 g1", r.stdout)

    def test_a_prepare_refused_for_room_says_why(self):
        # the state a refused prepare leaves (test_prepare.py's no-room test: no record), then a start: up's own line and the prepare's
        r = self.h.run("PREP_RC=75\n" + UP)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("PREPARE 1 g1", r.stdout)
        self.assertIn("slot 1: refused for room: the store has", r.stderr)
        self.assertIn("slot 1: prepare failed (exit 75, no room on the slot store), refused", r.stderr)

    def test_a_record_that_cant_be_read_is_prepared_again(self):
        with open(f"{self.h.rec}/1.json", "w") as f:
            f.write("{not json")
        r = self.h.run(UP)
        self.assertEqual(r.returncode, 42, r.stdout + r.stderr)
        self.assertIn("slot 1: its record can't be read: no cut-off to put back (the start prepares the slot again)", r.stdout)
        self.assertIn("PREPARE 1 g1", r.stdout)

    def test_a_wake_on_a_good_record_gets_to_its_admission(self):
        # a record with a desk, no cut-off: batch_cutoff passes it, the wake keeps the root, and the run stops at the stub's full host (75)
        self.h.record(state="desk", deskId=DESK, template="g1", releases={"deskd": "v1"})
        r = self.h.run(UP)
        self.assertEqual(r.returncode, 75, r.stdout + r.stderr)
        self.assertIn(f"slot 1: record names {DESK}, its root on g1 kept (a wake)", r.stdout)
        self.assertIn("slot 1: the host is full for a standard desk: the test host is full. Refused", r.stderr)
        self.assertNotIn("PREPARE", r.stdout)

    def test_reroot_with_no_record_logs_and_returns(self):
        r = self.h.run('reroot 1\necho "REROOT RETURNED $?"')
        self.assertEqual(r.returncode, 0, f"rc {r.returncode}, stdout {r.stdout!r}, stderr {r.stderr!r}")
        self.assertIn("slot 1: no root to re-root (record none)", r.stdout)
        self.assertIn("REROOT RETURNED 0", r.stdout)


class CutOff(unittest.TestCase):
    """batch_cutoff on a real cut-off, with batches.py's record_update (the real lib, its paths in the temp tree)."""
    PLAN = {"seq": 7, "role": "promote", "components": [{"name": "deskd", "from": "v1", "to": "v2"}, {"name": "desk-agent", "from": "a1", "to": "a2"}],
            "done": ["deskd"], "current": "desk-agent", "phase": "start", "at": "2026-11-11T00:00:00Z"}

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="up-cutoff-")
        self.h = Host(self.root, real_lib=True)
        rel = f"{self.h.s}/1/rel"
        for d, v in (("deskd", "v2"), (".old-deskd", "v1"), ("desk-agent", "a2"), (".old-desk-agent", "a1")):
            os.makedirs(f"{rel}/{d}")
            with open(f"{rel}/{d}/version", "w") as f:
                f.write(v + "\n")
        self.h.record(state="desk", deskId=DESK, template="g1", releases={"deskd": "v2", "desk-agent": "a2"},
                      batch={"seq": 6, "state": "switching", "at": "2026-11-11T00:00:00Z"}, switching=self.PLAN)

    def tearDown(self):
        subprocess.run(["chmod", "-R", "u+w", self.root])
        shutil.rmtree(self.root, ignore_errors=True)

    def version(self, svc):
        with open(f"{self.h.s}/1/rel/{svc}/version") as f:
            return f.read().strip()

    def test_a_cut_off_switch_is_put_back(self):
        r = self.h.run('batch_cutoff 1\necho "CUTOFF RETURNED $?"')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("was cut off at desk-agent (start): put back by renames", r.stdout)
        self.assertEqual((self.version("deskd"), self.version("desk-agent")), ("v1", "a1"))
        self.assertEqual(sorted(os.listdir(f"{self.h.s}/1/rel")), ["desk-agent", "deskd"])
        rec = self.h.read_record()
        self.assertNotIn("switching", rec)
        self.assertEqual(rec["releases"], {"deskd": "v1", "desk-agent": "a1"})
        self.assertEqual(rec["batch"]["state"], "behind")

    def test_a_switch_cut_off_between_its_two_renames_is_put_back(self):
        # rel_swap_in's rel/<svc> -> .old-<svc>, then .new-<svc> -> rel/<svc>: cut off between them, rel/desk-agent isn't there. Under set -e
        # 0.1.15's put-back ended on its first mv (rel/desk-agent to .bad-), with no message, so the slot never started again.
        rel = f"{self.h.s}/1/rel"
        os.rename(f"{rel}/desk-agent", f"{rel}/.new-desk-agent")
        self.h.record(state="desk", deskId=DESK, template="g1", releases={"deskd": "v2", "desk-agent": "a1"},
                      batch={"seq": 6, "state": "switching", "at": "2026-11-11T00:00:00Z"}, switching=dict(self.PLAN, phase="swap"))
        r = self.h.run('batch_cutoff 1\necho "CUTOFF RETURNED $?"')
        self.assertEqual(r.returncode, 0, f"rc {r.returncode}, stdout {r.stdout!r}, stderr {r.stderr!r}")
        self.assertEqual((self.version("deskd"), self.version("desk-agent")), ("v1", "a1"))
        self.assertEqual(sorted(os.listdir(rel)), ["desk-agent", "deskd"])
        self.assertNotIn("switching", self.h.read_record())

    @unittest.skipIf(os.geteuid() == 0, "root renames in a directory it can't write")
    def test_a_cut_off_that_cant_be_put_back_refuses_saying_why(self):
        os.chmod(f"{self.h.s}/1/rel", 0o555)
        r = self.h.run('batch_cutoff 1\necho "CUTOFF RETURNED $?"')
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("slot 1: a cut-off batch's deskd couldn't be put back to its old copy: refused", r.stderr)
        self.assertIn("switching", self.h.read_record(), "the record must still name the cut-off")


class Conf(unittest.TestCase):
    """conf() with no /etc/desk-host/desk-host.conf: every default, as desk-host-check, the link and preread.py read it."""

    @unittest.skipIf(os.path.exists("/etc/desk-host/desk-host.conf"), "this machine has a desk-host.conf")
    def test_no_conf_is_the_defaults(self):
        for name, src in (("desk-host", SRC), ("desk-host-boot", BOOT)):
            with self.subTest(script=name):
                body = "set -euo pipefail\n" + fn("conf", src) + '\nX=$(conf CT_DESK); X=${X:-4096}; echo "REACHED $X"\n'
                r = subprocess.run(["bash", "-c", body], capture_output=True, text=True)
                self.assertEqual((r.returncode, r.stdout.strip()), (0, "REACHED 4096"), r.stderr)


class BootPortNoRoute(unittest.TestCase):
    """desk-host-boot under SlotMode=port with no default route: its own line, not Python's traceback."""

    def test_no_default_route_says_so(self):
        lines = BOOT.splitlines()
        i = next(n for n, line in enumerate(lines) if line.startswith("  dev=$(ip -4 -j route show default"))
        j = next(n for n, line in enumerate(lines) if line.startswith('  [ -n "$dev" ] && [ -n "$addr" ]'))
        part = "\n".join(lines[i:j + 1])
        with tempfile.TemporaryDirectory(prefix="boot-port-") as t:
            # ip: no default route (EC2 before DHCP, say): an empty list; and no device by an empty name
            stub(f"{t}/ip", '#!/bin/sh\ncase "$*" in *"route show default"*) echo "[]" ;; *"addr show dev "*) echo "Device \\"\\" does not exist." >&2; exit 1 ;; esac\n')
            body = 'set -euo pipefail\nlog() { echo "desk-host-boot: $*"; }\n' + part + "\necho NOT REACHED\n"
            r = subprocess.run(["bash", "-c", body], capture_output=True, text=True, env={**os.environ, "PATH": f"{t}:{os.environ['PATH']}"})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("desk-host-boot: SlotMode=port: no address of the host's own (default route: none)", r.stdout)
        self.assertNotIn("Traceback", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
