#!/usr/bin/python3 -I
"""The shared host's slot byte counters (image/host/, ADR 0072 section 8): desk-host-check's `counters` on fake `nft` output, the ruleset
file's shape, and the pre-read's path rules. No root, no host. python3 -I image/tests/test_host_counters.py"""
import importlib.util
import os
import pathlib
import re
import shutil
import sys
import tempfile
import types
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
FILES = IMAGE / "host" / "recipe" / "files"
LIB = FILES / "usr/local/lib/desk-host"


def load_check():
    src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
    m = types.ModuleType("desk_host_check")
    m.__dict__["__name__"] = "desk_host_check"
    sys.path.insert(0, str(LIB))   # its modules (templates.py, ADR 0077) beside it
    exec(compile(src, "desk-host-check", "exec"), m.__dict__)
    return m


FORWARD = """table inet host {
	chain forward {
		type filter hook forward priority filter; policy drop;
		iifname "dhv*" meta nfproto ipv6 counter packets 0 bytes 0 drop
		oifname "dhv*" meta nfproto ipv6 counter packets 0 bytes 0 drop
		ct state { established, related } jump desk_est
		ct state { established, related } accept
		jump desk_fwd
	}
}
"""
SLOT = 'iifname "dhv1" oifname "ens5" counter name "out_1"'
OUT = '\t\tip daddr 169.254.169.253 meta l4proto { tcp, udp } th dport 53 counter name "out_1" accept\n\t\toifname "ens5" counter name "out_1" accept\n'
EST = '\t\tiifname "dhv1" oifname "ens5" counter name "out_1"\n\t\tiifname "ens5" oifname "dhv1" counter name "rx_1"\n'
DEST = '\t\tiifname "dhv1" jump est_1\n\t\toifname "dhv1" jump est_1\n'


class Fake:
    def __init__(self, forward=FORWARD, desk_est="ok", slots=(1,), out=OUT, est=EST, dest=DEST):
        self.forward, self.desk_est, self.slots, self.out, self.est, self.dest = forward, desk_est, slots, out, est, dest

    def __call__(self, *a, **kw):
        a = list(a)
        r = types.SimpleNamespace(returncode=0, stdout="", stderr="")
        if a[:4] == ["nft", "list", "chain", "inet"]:
            name = a[5]
            if name == "forward":
                r.stdout = self.forward
            elif name == "desk_est":
                r.stdout = self.dest if self.desk_est == "ok" else ""
                r.returncode = 0 if self.desk_est == "ok" else 1
            elif name.startswith("slot_"):
                r.stdout = self.out
            elif name.startswith("est_"):
                r.stdout = self.est
        elif a[:4] == ["nft", "list", "table", "inet"]:
            r.stdout = "table inet host {\n" + "".join(f"\tchain slot_{k} {{\n\t}}\n" for k in self.slots) + "}\n"
        return r


class Counters(unittest.TestCase):
    def run_check(self, **kw):
        m = load_check()
        m.sh = Fake(**kw)
        return m.c_counters()

    def test_the_good_ruleset_passes(self):
        ok, why = self.run_check()
        self.assertTrue(ok, why)

    def test_no_slots_still_checks_the_forward_chain(self):
        ok, why = self.run_check(slots=())
        self.assertTrue(ok, why)
        ok, why = self.run_check(slots=(), forward=FORWARD.replace("\t\tct state { established, related } jump desk_est\n", ""))
        self.assertFalse(ok)

    def test_a_missing_count_before_the_accept_fails(self):
        ok, why = self.run_check(forward=FORWARD.replace("\t\tct state { established, related } jump desk_est\n", ""))
        self.assertFalse(ok)
        self.assertIn("jump desk_est", why)

    def test_the_accept_before_the_count_fails(self):
        a = "\t\tct state { established, related } accept\n"
        j = "\t\tct state { established, related } jump desk_est\n"
        ok, why = self.run_check(forward=FORWARD.replace(j + a, a + j))
        self.assertFalse(ok)
        self.assertIn("before the count", why)

    def test_a_slot_that_misses_replies_fails(self):
        # the slot's rx counter gone, or the out counter on the wrong interface, or the chain not reached
        ok, why = self.run_check(est=EST.split("\n")[0] + "\n")
        self.assertFalse(ok)
        self.assertIn("rx_1", why)
        ok, why = self.run_check(est=EST.replace('oifname "ens5" counter name "out_1"', 'oifname "ens6" counter name "out_1"'))
        self.assertFalse(ok)
        ok, why = self.run_check(dest='\t\tiifname "dhv1" jump est_1\n')
        self.assertFalse(ok)

    def test_the_ruleset_file_has_the_count_before_the_accept(self):
        text = (FILES / "etc/nftables.conf").read_text()
        fwd = text[text.index("chain forward"):text.index("chain desk_est")]
        self.assertLess(fwd.index("jump desk_est"), fwd.index("ct state established,related accept"))
        self.assertIn("chain desk_est { }", text)

    def test_desk_host_counts_both_ways_and_resets_each_start(self):
        # on the slot's own interface ($ifc: the slots' interface under PF-03, the default route's in port mode)
        s = (LIB / "desk-host").read_text()
        self.assertIn('iifname "dhv$k" oifname "$ifc" counter name out_$k', s)
        self.assertIn('iifname "$ifc" oifname "dhv$k" counter name rx_$k', s)
        self.assertRegex(s, r'nft reset counter inet host \$n')
        self.assertIn('"bytesIn"', s)

    def test_slot_names_dont_match_by_prefix(self):
        # `jump slot_1` must not be taken for `jump slot_10` when slot 1 starts after slot 10
        s = (LIB / "desk-host").read_text()
        self.assertNotIn('grep -q "jump slot_$k"', s)
        self.assertIn(r'grep -qE "jump slot_$k\$"', s)


class Preread(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        spec = importlib.util.spec_from_file_location("preread_walk", LIB / "preread.py")
        src = (LIB / "preread.py").read_text().replace("sys.exit(main(sys.argv[1:]))", "")
        self.m = types.ModuleType("preread")
        self.m.__dict__["__file__"] = str(LIB / "preread.py")
        exec(compile(src, "preread.py", "exec"), self.m.__dict__)
        (self.tmp / "rootfs/usr/lib/chromium").mkdir(parents=True)
        (self.tmp / "rootfs/usr/lib/chromium/chrome").write_bytes(b"x" * 1000)
        (self.tmp / "outside").write_bytes(b"secret")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_walk_reads_regular_files_inside_only(self):
        root = os.path.realpath(self.tmp / "rootfs")
        os.symlink(self.tmp / "outside", self.tmp / "rootfs/usr/lib/chromium/link-out")      # an absolute link out of the root
        os.symlink("chrome", self.tmp / "rootfs/usr/lib/chromium/link-in")                    # a link inside: a link is never followed
        os.link(self.tmp / "outside", self.tmp / "rootfs/usr/lib/chromium/hard")              # a hard link is a file of the root
        got = sorted(os.path.basename(p) for p in self.m.walk(root + "/usr/lib/chromium", root))
        self.assertEqual(got, ["chrome", "hard"])

    def test_a_directory_link_out_isnt_entered(self):
        root = os.path.realpath(self.tmp / "rootfs")
        os.mkdir(self.tmp / "outdir")
        (self.tmp / "outdir/f").write_bytes(b"z")
        os.symlink(self.tmp / "outdir", self.tmp / "rootfs/usr/lib/escape")
        self.assertEqual(list(self.m.walk(root + "/usr/lib/escape", root)), [])
        self.assertEqual([os.path.basename(p) for p in self.m.walk(root + "/usr/lib", root)], ["chrome"])

    def test_list_ignores_dotdot_comments_and_other_roots(self):
        self.m.LIST = str(self.tmp / "list")
        (self.tmp / "list").write_text("# c\nrootfs/usr/lib/chromium  # trailing\n../etc/shadow\nrootfs/../etc/shadow\netc/passwd\n\nrel/deskd/x\n---\nrootfs/opt/x\n")
        self.assertEqual(self.m.listed("/s"), [("/s/rootfs/usr/lib/chromium", 1, None), ("/s/rel/deskd/x", 1, None), ("/s/rootfs/opt/x", 2, None)])
        (self.tmp / "list").write_text("rootfs/a 0+4096,8192+100\nrootfs/b 1+x\nrootfs/c 1+2 extra\n")
        self.assertEqual(self.m.listed("/s"), [("/s/rootfs/a", 1, [(0, 4096), (8192, 100)])])

    def test_the_shipped_list_has_a_gate_and_stays_inside(self):
        lines = [l.split("#")[0].strip() for l in (FILES / "etc/desk-host/preread.list").read_text().splitlines()]
        lines = [l for l in lines if l]
        self.assertEqual(lines.count("---"), 1)
        for l in lines:
            self.assertTrue(l == "---" or (l.split()[0].split("/")[0] in ("rootfs", "rel") and ".." not in l.split()[0].split("/")), l)
        self.assertEqual(lines[0].split("/")[:2], ["rel", "deskd"])      # the hello waits for deskd first


if __name__ == "__main__":
    unittest.main()
