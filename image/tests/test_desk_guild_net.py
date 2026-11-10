#!/usr/bin/python3 -I
"""desk-guild-net on a fake nft and nproc, with a temporary flag. No root.
python3 -I image/tests/test_desk_guild_net.py

On a Guild Desk it puts exactly one voice rule in inet ma's input chain, UDP 8791 up to 8790 + cores, at most 8 ports, the
loopback refusals first in output and two voice labels in classify, in one nft transaction, however often it runs, and
nothing on TCP 443 (desk-net-031-sec: Security's NET031-3 took the per-network limits out). On any other desk it never
calls nft at all.
"""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HELPER = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "usr" / "local" / "lib" / "ma" / "desk-guild-net"

# The table as nft -a prints it. Rules live in $STATE/rules, one "chain<TAB>handle<TAB>text" a line; -f - applies a transaction.
FAKE_NFT = r"""#!/usr/bin/python3 -I
import os, re, sys
state = os.environ["STATE"]
rules_file = os.path.join(state, "rules")
rules = [l.split("\t", 2) for l in open(rules_file).read().splitlines() if l]
with open(os.path.join(state, "calls"), "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\n")
if sys.argv[1:] == ["-a", "list", "table", "inet", "ma"]:
    if os.path.exists(os.path.join(state, "no-table")):
        sys.exit("Error: No such file or directory")
    print("table inet ma { # handle 1")
    for i, chain in enumerate(("classify", "output", "input")):
        print("\tchain %s { # handle %d" % (chain, i + 2))
        print("\t\ttype filter hook %s priority filter; policy accept;" % ("input" if chain == "input" else "output"))
        for c, h, text in rules:
            if c == chain:
                print("\t\t%s # handle %s" % (text, h))
        print("\t}")
    print("}")
elif sys.argv[1:] == ["-f", "-"]:
    tx = sys.stdin.read()
    with open(os.path.join(state, "transactions"), "a") as f:
        f.write(tx + "--\n")
    nxt = max([int(h) for _, h, _ in rules] + [100]) + 1
    for line in tx.splitlines():
        m = re.fullmatch(r"delete rule inet ma (\w+) handle (\d+)", line)
        if m:
            if not any(c == m.group(1) and h == m.group(2) for c, h, _ in rules):
                sys.exit("Error: Could not process rule: No such file or directory")
            rules = [r for r in rules if not (r[0] == m.group(1) and r[1] == m.group(2))]
            continue
        m = re.fullmatch(r"(add|insert) rule inet ma (input|output|classify) (?:position (\d+) )?(.+)", line)
        if m:
            r = [m.group(2), str(nxt), m.group(4)]; nxt += 1
            if m.group(1) == "add":
                rules.append(r)
            elif m.group(3):
                i = next((k for k, x in enumerate(rules) if x[0] == m.group(2) and x[1] == m.group(3)), None)
                if i is None:
                    sys.exit("Error: Could not process rule: No such file or directory")
                rules.insert(i, r)
            else:
                i = next((k for k, x in enumerate(rules) if x[0] == m.group(2)), len(rules))
                rules.insert(i, r)
            continue
        sys.exit("Error: syntax error in: " + line)
    open(rules_file, "w").write("".join("%s\t%s\t%s\n" % tuple(r) for r in rules))
else:
    sys.exit("fake nft: unexpected " + repr(sys.argv[1:]))
"""
BASE_RULES = [("input", "10", 'iifname "lo" accept'), ("input", "11", "ct state established,related accept"),
              ("input", "12", "udp dport 443 accept"), ("input", "13", "tcp dport 443 accept"),
              ("output", "20", "ip daddr 169.254.169.254 meta skuid { 0, 1100 } accept"),
              ("output", "21", 'meta skuid 1103 oif "lo" accept'),
              ("classify", "5", 'oif "lo" return'), ("classify", "6", "meta skuid 1101 udp sport 443 meta priority set 1:10"),
              ("classify", "7", "meta skuid { 0, 1100 } meta priority set 1:15")]
CONF = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "files" / "etc" / "ma" / "guild.conf"


def classes(ports):
    return ['meta skuid 1110 udp sport %s meta priority set 1:30 comment "ma-guild-voice-class"' % ports,
            'meta skuid 1101 udp sport 443 @th,64,8 & 0xc0 == 0x80 meta priority set 1:30 comment "ma-guild-voice-class"']


LOCAL4 = ('ip daddr 127.0.0.1 tcp dport 8790 meta skuid != { 0, 1110 } tcp flags & (syn | ack) == syn reject with tcp reset '
          'comment "ma-guild-commons-local"')
LOCAL6 = LOCAL4.replace("ip daddr 127.0.0.1", "ip6 daddr ::1")
RELAY = ['%s %s dport 8799 meta skuid != 1101 %s comment "ma-guild-commons-relay"' % (a, p, v)
         for a in ("ip daddr 127.0.0.1", "ip6 daddr ::1")
         for p, v in (("tcp", "tcp flags & (syn | ack) == syn reject with tcp reset"), ("udp", "reject with icmpx type admin-prohibited"))]


class GuildNetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.state, self.bin = t / "state", t / "bin"
        self.state.mkdir()
        self.bin.mkdir()
        (self.bin / "nft").write_text(FAKE_NFT)
        (self.bin / "nft").chmod(0o755)
        self.flag = t / "run-ma" / "guild"
        self.set_rules(BASE_RULES)
        self.cores = 2

    def tearDown(self):
        self.tmp.cleanup()

    def set_rules(self, rules):
        (self.state / "rules").write_text("".join("%s\t%s\t%s\n" % r for r in rules))

    def rules(self, chain=None):
        rows = [l.split("\t", 2) for l in (self.state / "rules").read_text().splitlines() if l]
        return [t for c, _, t in rows if chain in (None, c)]

    def guild(self):
        self.flag.parent.mkdir(exist_ok=True)
        self.flag.write_text("DeskKind=guild\n")

    def run_it(self):
        nproc = self.bin / "nproc"
        nproc.write_text("#!/bin/sh\necho %s\n" % self.cores)
        nproc.chmod(0o755)
        env = {"PATH": "/usr/bin:/bin", "STATE": str(self.state), "MA_GUILD_FLAG": str(self.flag),
               "MA_NFT": str(self.bin / "nft"), "MA_NPROC": str(nproc)}
        return subprocess.run(["/bin/bash", str(HELPER)], env=env, capture_output=True, text=True, timeout=30)

    def calls(self):
        p = self.state / "calls"
        return p.read_text().splitlines() if p.exists() else []

    def voice(self):
        return [r for r in self.rules() if "ma-guild-commons-voice" in r]

    def test_a_members_desk_never_calls_nft(self):
        r = self.run_it()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.rules(), [t for _, _, t in BASE_RULES])
        self.assertIn("not a Guild Desk", r.stdout)

    def test_a_guild_desk_gets_one_rule_for_its_cores(self):
        self.guild()
        r = self.run_it()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.voice(), ['udp dport 8791-8792 accept comment "ma-guild-commons-voice"'])
        base_in = [t for c, _, t in BASE_RULES if c == "input"]
        base_out = [t for c, _, t in BASE_RULES if c == "output"]
        base_cl = [t for c, _, t in BASE_RULES if c == "classify"]
        # The voice port appended, nothing else touched: every desk's TCP 443 rule alone, with nothing before it.
        self.assertEqual(self.rules("input"), base_in + self.voice())
        self.assertEqual(self.rules("classify"), base_cl + classes("8791-8792"))
        # The loopback refusals come first in output, ahead of the chain's accept for uid 1103's loopback traffic: 8799 for
        # every uid but rtc, 8790 for every uid but root and commons.
        self.assertEqual(self.rules("output"), list(reversed(RELAY)) + [LOCAL6, LOCAL4] + base_out)
        self.assertEqual(self.calls(), ["-a list table inet ma", "-f -"])  # one transaction
        self.assertIn("UDP 8791-8792 open", r.stdout)
        self.assertNotIn("TCP 443", r.stdout)

    def test_running_again_keeps_exactly_one(self):
        self.guild()
        for _ in range(3):
            self.assertEqual(self.run_it().returncode, 0)
        self.assertEqual(len(self.voice()), 1)
        self.assertEqual(self.rules("output").count(LOCAL4), 1)
        self.assertEqual(self.rules("output").count(LOCAL6), 1)
        for r in RELAY:
            self.assertEqual(self.rules("output").count(r), 1)
        self.assertEqual(len(self.rules()), len(BASE_RULES) + 9)
        self.assertEqual([x for x in self.rules() if "tcp dport 443" in x], ["tcp dport 443 accept"])

    def test_stray_copies_are_replaced_in_the_same_transaction(self):
        self.guild()
        self.set_rules(BASE_RULES + [("input", "30", 'udp dport 8791-8799 accept comment "ma-guild-commons-voice"'),
                                     ("input", "31", 'udp dport 8791 accept comment "ma-guild-commons-voice"'),
                                     ("output", "32", 'tcp dport 8790 drop comment "ma-guild-commons-local"'),
                                     ("output", "33", 'udp dport 8799 drop comment "ma-guild-commons-relay"'),
                                     ("classify", "34", 'meta skuid 1110 meta priority set 1:20 comment "ma-guild-voice-class"'),
                                     # an earlier version's TCP 443 limit: deleted like any other copy, and not put back
                                     ("input", "35", 'tcp dport 443 drop comment "ma-guild-tcp-limits"')])
        self.assertEqual(self.run_it().returncode, 0)
        self.assertEqual(self.voice(), ['udp dport 8791-8792 accept comment "ma-guild-commons-voice"'])
        tx = (self.state / "transactions").read_text().split("--\n")[0].splitlines()
        self.assertEqual(tx[:6], ["delete rule inet ma classify handle 34", "delete rule inet ma output handle 32",
                                  "delete rule inet ma output handle 33", "delete rule inet ma input handle 30",
                                  "delete rule inet ma input handle 31", "delete rule inet ma input handle 35"])
        self.assertEqual(len(tx), 6 + 9)
        for stray in ("8791-8799", 'tcp dport 8790 drop', 'udp dport 8799 drop', "priority set 1:20", 'tcp dport 443 drop comment'):
            self.assertNotIn(stray, " ".join(self.rules()))

    def test_no_tcp443_rule_opens_nothing(self):
        """An nftables.conf that didn't open TCP 443 stays closed: the guild adds nothing for it, and the rest as usual."""
        self.guild()
        self.set_rules([r for r in BASE_RULES if r[2] != "tcp dport 443 accept"])
        r = self.run_it()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse([x for x in self.rules() if "tcp dport 443" in x])
        self.assertEqual(len(self.voice()), 1)
        self.assertEqual(len([x for x in self.rules("classify") if "ma-guild" in x]), 2)

    def test_nothing_on_tcp443_and_nothing_per_network(self):
        """Security's NET031-3: no per-network limit, set or count on TCP 443 on a Guild Desk, in the helper or what it adds."""
        self.guild()
        self.assertEqual(self.run_it().returncode, 0)
        added = [x for x in self.rules() if "ma-guild" in x]
        self.assertFalse([x for x in added if "tcp dport 443" in x or "limit rate" in x or "ct count" in x or "@tcp443" in x], added)
        text = HELPER.read_text()
        for gone in ("tcp443", "ct count", "limit rate", "MA_GUILD_CONF", "MA_PRODUCT"):
            self.assertNotIn(gone, text)

    def test_classes_follow_the_cores(self):
        self.guild()
        for cores, ports in ((1, "8791"), (4, "8791-8794"), (16, "8791-8798")):
            with self.subTest(cores=cores):
                self.cores = cores
                self.assertEqual(self.run_it().returncode, 0)
                self.assertEqual([r for r in self.rules("classify") if "ma-guild" in r], classes(ports))

    def test_the_shipped_conf_has_no_tcp443_section(self):
        """guild.conf is desk-egress's alone now: its tiers, and no [tcp443]."""
        import configparser
        p = configparser.ConfigParser()
        p.read(CONF)
        self.assertEqual({k: int(v) for k, v in p.items("tiers")}, {"t4g.small": 25, "t4g.medium": 50, "c7g.xlarge": 200, "default": 200})
        self.assertEqual(p.sections(), ["tiers", "egress"])

    def test_ports_follow_the_cores_up_to_eight(self):
        self.guild()
        for cores, want in ((1, "8791"), (4, "8791-8794"), (8, "8791-8798"), (16, "8791-8798"), (64, "8791-8798")):
            with self.subTest(cores=cores):
                self.cores = cores
                self.assertEqual(self.run_it().returncode, 0)
                self.assertEqual(self.voice(), ['udp dport %s accept comment "ma-guild-commons-voice"' % want])

    def test_a_core_count_it_cant_read_fails_without_touching_nft(self):
        self.guild()
        for bad in ("0", "", "two", "-1"):
            with self.subTest(bad=bad):
                self.cores = bad
                r = self.run_it()
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(self.calls(), [])

    def test_no_ruleset_fails_loudly(self):
        self.guild()
        (self.state / "no-table").touch()
        r = self.run_it()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.voice(), [])

    def test_every_desks_tcp443_is_0_3_0s(self):
        """nftables.conf, every desk: TCP 443 is one accept after the established rule, as in ma-desk-0.3.0, with no
        per-network set, rate or count (Security's NET031-3; the real fix counts after the handshake in desk-rtc)."""
        text = (HELPER.parents[4] / "etc" / "nftables.conf").read_text()
        chain = text[text.index("chain input"):text.index("chain forward")]
        rules = [l.strip() for l in chain.splitlines() if l.strip() and not l.strip().startswith("#")]
        self.assertEqual([r for r in rules if "tcp dport 443" in r], ["tcp dport 443 accept"])
        self.assertLess(rules.index("ct state established,related accept"), rules.index("tcp dport 443 accept"))
        for gone in ("tcp443_", "ct count", "limit rate", "flags dynamic"):
            self.assertNotIn(gone, text)

    def test_the_real_paths(self):
        text = HELPER.read_text()
        self.assertIn("FLAG=${MA_GUILD_FLAG:-/run/ma/guild}", text)
        self.assertIn("NFT=${MA_NFT:-/usr/sbin/nft}", text)


if __name__ == "__main__":
    unittest.main(verbosity=1)
