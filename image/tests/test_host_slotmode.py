#!/usr/bin/python3 -I
"""The shared host under SlotMode=port, one public IPv4 for the host (ADR 0072 section 6's 2026-11-10 note): desk-host-check's
`slotmode`, `addresses`, `demux`, `ports` and the demux's half of `counters` and `inbound`, on fake command output. Each
check passes on the host as built and fails on every break here (the unit tests' mutation pass; image/host/verify.sh breaks
them again on a booted host). No root, no host. python3 -I image/tests/test_host_slotmode.py"""
import copy
import hashlib
import json
import sys
import os
import pathlib
import shutil
import tempfile
import types
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
LIB = IMAGE / "host" / "recipe" / "files" / "usr/local/lib/desk-host"
NFT_CONF = IMAGE / "host" / "recipe" / "files" / "etc/nftables.conf"


def load_check():
    src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
    m = types.ModuleType("desk_host_check")
    m.__dict__["__name__"] = "desk_host_check"
    sys.path.insert(0, str(LIB))   # its modules (templates.py, ADR 0077) beside it
    exec(compile(src, "desk-host-check", "exec"), m.__dict__)
    return m


DEV, ADDR, PUB, MAC = "ens5", "10.20.1.10", "198.51.100.1", "0a:00:00:00:00:01"


def host_state():
    """A SlotMode=port host as desk-host-boot and two running slots' desk-host up leave it, as nft and ip print it."""
    chains = {
        ("inet", "host", "divert"): ['iifname "dhv*" tcp sport 443 socket transparent 1 meta mark set 0x00004430'],
        ("inet", "host", "input"): ['iifname "dhv*" meta nfproto ipv6 counter drop', 'iif "lo" accept', 'iifname "dhv*" jump desk_src',
                                    "meta mark 0x00004430 jump desk_dmx", "ct state established,related accept", "ct state invalid drop",
                                    'iifname "dhv*" jump desk_in', "jump host_in", "udp sport 67 udp dport 68 accept"],
        ("inet", "host", "host_in"): [f'iifname "{DEV}" ip daddr {ADDR} tcp dport 443 accept'],
        ("inet", "host", "output"): ['oifname "dhv*" jump desk_dmxo', "ip daddr 169.254.169.254 meta skuid 0 accept"],
        ("inet", "host", "forward"): ['iifname "dhv*" meta nfproto ipv6 counter drop', 'iifname "dhv*" jump desk_src',
                                      "ct state established,related jump desk_est", "ct state established,related accept", "jump desk_fwd"],
        ("inet", "host", "desk_est"): ['iifname "dhv1" jump est_1', 'oifname "dhv1" jump est_1', 'iifname "dhv2" jump est_2', 'oifname "dhv2" jump est_2'],
        ("inet", "host", "desk_dmx"): ['iifname "dhv1" jump dmxi_1', 'iifname "dhv2" jump dmxi_2'],
        ("inet", "host", "desk_dmxo"): ['oifname "dhv1" jump dmxo_1', 'oifname "dhv2" jump dmxo_2'],
    }
    for k, (lo, hi) in ((1, (10000, 18332)), (2, (18333, 26665))):
        chains[("ip", "host_nat", f"pre_{k}")] = [f'iifname "{DEV}" ip daddr {ADDR} udp dport {4430 + k} dnat to 10.98.{k}.2',
                                                  f'iifname "dhv{k}" ip saddr 10.98.{k}.2 ip daddr 169.254.169.254 tcp dport 80 dnat to 10.98.{k}.1:9254']
        chains[("inet", "host", f"fwdin_{k}")] = ["meta nfproto ipv6 counter drop", f'ip daddr 10.98.{k}.2 udp dport {4430 + k} counter name "rx_{k}" accept', "counter drop"]
        chains[("ip", "host_nat", f"post_{k}")] = [f'ip saddr 10.98.{k}.2 oifname "{DEV}" meta l4proto {{ tcp, udp }} snat to {ADDR}:{lo}-{hi}',
                                                   f'ip saddr 10.98.{k}.2 oifname "{DEV}" snat to {ADDR}']
        chains[("inet", "host", f"slot_{k}")] = [f'oifname "{DEV}" counter name "out_{k}" accept', "counter drop"]
        chains[("inet", "host", f"est_{k}")] = [f'iifname "dhv{k}" oifname "{DEV}" counter name "out_{k}"', f'iifname "{DEV}" oifname "dhv{k}" counter name "rx_{k}"']
        chains[("inet", "host", f"dmxi_{k}")] = [f'ip saddr 10.98.{k}.2 tcp sport 443 counter packets 9 bytes 900 counter name "out_{k}"']
        chains[("inet", "host", f"dmxo_{k}")] = [f'ip daddr 10.98.{k}.2 tcp dport 443 counter packets 9 bytes 900 counter name "rx_{k}"']
    return {
        "chains": chains,
        "rules": "0:\tfrom all lookup local\n90:\tfrom all fwmark 0x4430 lookup 4430\n32766:\tfrom all lookup main\n",
        "table4430": "local default dev lo scope host\n",
        "routes": [{"dst": "default", "gateway": "10.20.0.1", "dev": DEV, "metric": 100}],
        "addrs": [{"ifname": "lo", "addr_info": [{"family": "inet", "local": "127.0.0.1", "prefixlen": 8}]},
                  {"ifname": DEV, "addr_info": [{"family": "inet", "local": ADDR, "prefixlen": 20}]},
                  {"ifname": "dhv1", "addr_info": [{"family": "inet", "local": "10.98.1.1", "prefixlen": 30}]},
                  {"ifname": "dhv2", "addr_info": [{"family": "inet", "local": "10.98.2.1", "prefixlen": 30}]}],
        "imds": {"network/interfaces/macs/": f"{MAC}/", "local-ipv4": ADDR, "public-ipv4": PUB,
                 f"network/interfaces/macs/{MAC}/local-ipv4s": ADDR, f"network/interfaces/macs/{MAC}/ipv4-associations/": PUB,
                 f"network/interfaces/macs/{MAC}/ipv4-associations/{PUB}": ADDR},
        "demux_active": "active", "pid": "4242",
        "status": "Uid:\t998\t998\t998\t998\nCapEff:\t0000000000002400\nCapBnd:\t0000000000002400\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t3\n",
        "ss": f"LISTEN 0 4096 {ADDR}:443 0.0.0.0:* users:((\"desk-ice-demux\",pid=4242,fd=3))\n",
        "running": ["dh-desk-1", "dh-desk-2", "dh-svc-1-deskd"],
        "env": f"DMX_LISTEN={ADDR}:443\nDMX_SLOTS=6",
        "marked": ["1", "2"],
    }


BASE = {"input": "\t\ttype filter hook input priority filter; policy drop;\n", "forward": "\t\ttype filter hook forward priority filter; policy drop;\n",
        "output": "\t\ttype filter hook output priority filter; policy accept;\n",
        "divert": "\t\ttype filter hook prerouting priority mangle; policy accept;\n"}


class Fake:
    def __init__(self, st):
        self.st = st

    def __call__(self, *a, **kw):
        a = list(a)
        st = self.st
        r = types.SimpleNamespace(returncode=0, stdout="", stderr="")
        if a[:3] == ["nft", "list", "chain"]:
            key = (a[3], a[4], a[5])
            if key not in st["chains"]:
                r.returncode = 1
            else:
                r.stdout = f"table {a[3]} {a[4]} {{\n\tchain {a[5]} {{\n" + BASE.get(a[5], "") + "".join(f"\t\t{x}\n" for x in st["chains"][key]) + "\t}\n}\n"
        elif a[:3] == ["nft", "list", "table"]:
            r.stdout = f"table {a[3]} {a[4]} {{\n" + "".join(f"\tchain {c} {{\n\t}}\n" for (f, t, c) in st["chains"] if (f, t) == (a[3], a[4])) + "}\n"
        elif a[:2] == ["nft", "list"]:
            r.stdout = ""
        elif a == ["ip", "rule", "show"]:
            r.stdout = st["rules"]
        elif a == ["ip", "route", "show", "table", "4430"]:
            r.stdout = st["table4430"]
        elif a == ["ip", "-4", "-j", "route", "show", "default"]:
            r.stdout = json.dumps(st["routes"])
        elif a[:5] == ["ip", "-4", "-j", "addr", "show"]:
            only = a[6] if len(a) > 6 else None
            r.stdout = json.dumps([l for l in st["addrs"] if only in (None, l["ifname"])])
        elif a[:2] == ["systemctl", "show"]:
            r.stdout = f"ActiveState={st['demux_active']}\nMainPID={st['pid'] if st['demux_active'] == 'active' else '0'}\n"
        elif a == ["ss", "-Hltnp"]:
            r.stdout = st["ss"]
        elif a == ["id", "-u", "desk-dmx"]:
            r.stdout = "998\n"
        elif a[1:] == ["list", "-q"]:
            r.stdout = "\n".join(st["running"])
        else:
            raise AssertionError(a)
        return r


class SlotModePortTest(unittest.TestCase):
    def setUp(self):
        self.m = load_check()
        self.tmp = tempfile.mkdtemp(prefix="slotmode-")
        self.m.LIB = os.path.join(self.tmp, "lib")
        self.m.DMX = os.path.join(self.tmp, "dmx")
        os.makedirs(self.m.LIB)
        os.makedirs(os.path.join(self.m.DMX, "slots"))
        with open(os.path.join(self.m.LIB, "desk-ice-demux"), "wb") as f:
            f.write(b"the demux bake.sh built")
        with open(os.path.join(self.m.LIB, "desk-ice-demux.sha256"), "w") as f:
            f.write(hashlib.sha256(b"the demux bake.sh built").hexdigest() + "  desk-ice-demux\n")
        self.st = host_state()
        self.mode = "port"
        self.m.slot_mode = lambda: self.mode
        self.m.slots = lambda: 6
        self.m.sh = Fake(self.st)
        self.m.imds = lambda p: self.st["imds"].get(p)
        real_rd = self.m.rd
        self.m.rd = lambda p: (self.st["env"] if p == f"{self.m.DMX}/env" else self.st["status"] if p == f"/proc/{self.st['pid']}/status" else real_rd(p))
        self.sync()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def sync(self):
        d = os.path.join(self.m.DMX, "slots")
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        for k in self.st["marked"]:
            open(os.path.join(d, k), "w").close()

    def check(self, name):
        self.sync()
        return {"slotmode": self.m.c_slotmode, "addresses": self.m.c_addresses, "demux": self.m.c_demux, "ports": self.m.c_ports,
                "counters": self.m.c_counters, "inbound": self.m.c_inbound}[name]()

    def test_the_host_as_built_passes(self):
        for name in ("slotmode", "addresses", "demux", "ports", "counters", "inbound"):
            with self.subTest(check=name):
                ok, detail = self.check(name)
                self.assertTrue(ok, f"{name}: {detail}")

    def broken(self, name, edit):
        """edit breaks the host; the check must fail, and pass again once it's put back."""
        saved = copy.deepcopy(self.st)
        edit(self.st)
        ok, detail = self.check(name)
        self.assertFalse(ok, f"{name} passed a broken host: {detail}")
        self.st.clear()
        self.st.update(saved)
        ok, detail = self.check(name)
        self.assertTrue(ok, f"{name} after the restore: {detail}")

    def test_slotmode_fails_on_each_break(self):
        c = ("inet", "host", "host_in")
        for why, edit in {
            "no divert": lambda s: s["chains"].pop(("inet", "host", "divert")),
            "a divert for any port": lambda s: s["chains"].__setitem__(("inet", "host", "divert"), ['iifname "dhv*" socket transparent 1 meta mark set 0x00004430']),
            "the demux open on every address": lambda s: s["chains"].__setitem__(c, ["tcp dport 443 accept"]),
            "a second accept (SSH)": lambda s: s["chains"][c].append("tcp dport 22 accept"),
            "the demux open from a desk": lambda s: s["chains"][("inet", "host", "input")].insert(2, "jump host_in"),
            "no source check in input": lambda s: s["chains"][("inet", "host", "input")].remove('iifname "dhv*" jump desk_src'),
            "the demux count after the accept": lambda s: s["chains"][("inet", "host", "input")].append("meta mark 0x00004430 jump desk_dmx")
            or s["chains"][("inet", "host", "input")].remove("meta mark 0x00004430 jump desk_dmx"),
            "no fwmark rule": lambda s: s.__setitem__("rules", "0:\tfrom all lookup local\n"),
            "a table that routes elsewhere": lambda s: s.__setitem__("table4430", "default via 10.20.0.1 dev ens5\n"),
            "the env on another address": lambda s: s.__setitem__("env", "DMX_LISTEN=0.0.0.0:443\nDMX_SLOTS=6"),
        }.items():
            with self.subTest(why=why):
                self.broken("slotmode", edit)
        # SlotMode=address with the demux's ground left
        self.mode = "address"
        self.assertFalse(self.check("slotmode")[0])
        self.st["chains"][c] = []
        self.st["rules"], self.st["table4430"], self.st["env"] = "0:\tfrom all lookup local\n", "", None
        self.assertTrue(self.check("slotmode")[0], self.check("slotmode")[1])
        self.mode = "guess"
        self.assertFalse(self.check("slotmode")[0])

    def test_addresses_fail_on_anything_beyond_the_hosts_own(self):
        im = f"network/interfaces/macs/{MAC}"
        for why, edit in {
            "a secondary private address (IMDS)": lambda s: s["imds"].__setitem__(f"{im}/local-ipv4s", f"{ADDR}\n10.20.1.57"),
            "an Elastic IP beside it": lambda s: s["imds"].__setitem__(f"{im}/ipv4-associations/", f"{PUB}\n203.0.113.5"),
            "a second interface": lambda s: s["imds"].__setitem__("network/interfaces/macs/", f"{MAC}/\n0a:00:00:00:00:02/"),
            "a secondary address in the OS": lambda s: s["addrs"][1]["addr_info"].append({"family": "inet", "local": "10.20.1.57", "prefixlen": 20}),
            "a veth with another address": lambda s: s["addrs"][2]["addr_info"].append({"family": "inet", "local": "192.0.2.1", "prefixlen": 24}),
            "the public address on nothing": lambda s: s["imds"].__setitem__(f"{im}/ipv4-associations/{PUB}", "10.20.1.57"),
        }.items():
            with self.subTest(why=why):
                self.broken("addresses", edit)

    def test_demux_fails_unless_sandboxed_alone_on_the_hosts_address(self):
        for why, edit in {
            "not running": lambda s: s.__setitem__("demux_active", "inactive"),
            "as root": lambda s: s.__setitem__("status", s["status"].replace("Uid:\t998\t998\t998\t998", "Uid:\t0\t0\t0\t0")),
            "with CAP_SYS_ADMIN": lambda s: s.__setitem__("status", s["status"].replace("CapEff:\t0000000000002400", "CapEff:\t0000000000202400")),
            "without its seccomp filter": lambda s: s.__setitem__("status", s["status"].replace("Seccomp:\t2", "Seccomp:\t0")),
            "with only systemd's filter": lambda s: s.__setitem__("status", s["status"].replace("Seccomp_filters:\t3", "Seccomp_filters:\t1")),
            "on every address": lambda s: s.__setitem__("ss", s["ss"].replace(f"{ADDR}:443", "0.0.0.0:443")),
            "something else on a slot's side": lambda s: s.__setitem__("ss", s["ss"] + "LISTEN 0 5 10.98.1.1:443 0.0.0.0:* users:((\"python3\",pid=7,fd=3))\n"),
        }.items():
            with self.subTest(why=why):
                self.broken("demux", edit)
        with open(os.path.join(self.m.LIB, "desk-ice-demux"), "ab") as f:
            f.write(b" changed")
        self.assertFalse(self.check("demux")[0])

    def test_demux_under_address_must_not_run(self):
        self.mode = "address"
        self.assertFalse(self.check("demux")[0])   # still running, still on 443
        self.st["demux_active"], self.st["ss"] = "inactive", ""
        self.assertTrue(self.check("demux")[0], self.check("demux")[1])

    def test_ports_fail_on_each_break(self):
        pre1, fin1, post2 = ("ip", "host_nat", "pre_1"), ("inet", "host", "fwdin_1"), ("ip", "host_nat", "post_2")
        for why, edit in {
            "TCP DNATed too": lambda s: s["chains"][pre1].insert(0, f'iifname "{DEV}" ip daddr {ADDR} tcp dport 4431 dnat to 10.98.1.2'),
            "a DNAT from a desk's side as well": lambda s: s["chains"].__setitem__(pre1, [f'ip daddr {ADDR} udp dport 4431 dnat to 10.98.1.2']),
            "another slot's port": lambda s: s["chains"].__setitem__(pre1, [f'iifname "{DEV}" ip daddr {ADDR} udp dport 4432 dnat to 10.98.1.2']),
            "TCP let in": lambda s: s["chains"][fin1].insert(1, 'ip daddr 10.98.1.2 tcp dport 4431 counter name "rx_1" accept'),
            "overlapping port blocks": lambda s: s["chains"].__setitem__(post2, [f'ip saddr 10.98.2.2 oifname "{DEV}" meta l4proto {{ tcp, udp }} snat to {ADDR}:18000-26665']),
            "a block past 59999": lambda s: s["chains"].__setitem__(post2, [f'ip saddr 10.98.2.2 oifname "{DEV}" meta l4proto {{ tcp, udp }} snat to {ADDR}:18333-61000']),
            "a stopped slot marked for the demux": lambda s: s["marked"].append("3"),
            "a running slot not marked": lambda s: s["marked"].remove("2"),
        }.items():
            with self.subTest(why=why):
                self.broken("ports", edit)

    def test_counters_fail_without_the_demuxs_half(self):
        for why, edit in {
            "no dmxi count": lambda s: s["chains"].__setitem__(("inet", "host", "dmxi_1"), []),
            "no dmxo count": lambda s: s["chains"].__setitem__(("inet", "host", "dmxo_2"), ['ip daddr 10.98.2.2 tcp dport 443 counter packets 9 bytes 900 counter name "rx_1"']),
            "no jump to dmxi": lambda s: s["chains"].__setitem__(("inet", "host", "desk_dmx"), ['iifname "dhv2" jump dmxi_2']),
            "output doesn't count": lambda s: s["chains"][("inet", "host", "output")].pop(0),
            "input counts after its accept": lambda s: s["chains"][("inet", "host", "input")].remove("meta mark 0x00004430 jump desk_dmx"),
        }.items():
            with self.subTest(why=why):
                self.broken("counters", edit)

    def test_the_rulesets_file_has_the_demuxs_chains(self):
        t = NFT_CONF.read_text()
        for want in ('iifname "dhv*" tcp sport 443 socket transparent 1 meta mark set 0x00004430',
                     'iifname "dhv*" jump desk_src\n    meta mark 0x00004430 jump desk_dmx\n    ct state established,related accept',
                     'iifname "dhv*" jump desk_in\n    jump host_in', "chain host_in { }", "chain desk_dmx { }", "chain desk_dmxo { }",
                     'oifname "dhv*" jump desk_dmxo'):
            self.assertIn(want, t)


if __name__ == "__main__":
    unittest.main(verbosity=1)
