"""EXP-9: the desk's own networks, whatever their addresses, are refused to the Browser and to desk-agent-filter.

ma-selfhost-net's choice of prefixes from `ip -j route`, what it writes, and nftables.conf's rules, read as text. No root.
selfhost/tests/firewall.sh loads the same rules into a network namespace and tries real connections (root, its header).
Run: python3 -m unittest discover -s selfhost/tests
"""
import fnmatch
import importlib.machinery
import importlib.util
import ipaddress
import os
import re
import stat
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
NET = os.path.join(HERE, "..", "files", "usr", "local", "lib", "ma", "selfhost", "ma-selfhost-net")
CONF = os.path.join(HERE, "..", "files", "etc", "nftables.conf")
UNIT = os.path.join(HERE, "..", "files", "etc", "systemd", "system", "ma-selfhost-net.service")


def load():
    loader = importlib.machinery.SourceFileLoader("ma_selfhost_net", NET)
    spec = importlib.util.spec_from_loader("ma_selfhost_net", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


# What `ip -j -4 route show table all` and `ip -j -6 ...` print on a dual-stack home desk with a VPN, trimmed.
# Addresses: documentation ranges, whole private ranges and CGNAT, so nothing here names a real network.
ROUTES4 = [
    {"dst": "default", "gateway": "192.0.2.1", "dev": "eth0", "protocol": "dhcp", "metric": 100, "flags": []},
    {"dst": "192.0.2.0/24", "dev": "eth0", "protocol": "kernel", "scope": "link", "flags": []},          # the home LAN
    {"dst": "192.168.1.0/24", "dev": "eth2", "protocol": "kernel", "scope": "link", "flags": []},        # a private one
    {"dst": "203.0.113.0/29", "dev": "eth1", "protocol": "kernel", "scope": "link", "flags": []},       # a LAN on public IPv4
    {"dst": "100.64.0.5", "dev": "wg0", "scope": "link", "flags": []},                                 # a host route, no length
    {"dst": "0.0.0.0/1", "dev": "tun0", "scope": "link", "flags": []},                                 # a VPN's half of everything
    {"dst": "128.0.0.0/1", "dev": "tun0", "scope": "link", "flags": []},
    {"dst": "198.51.100.0/24", "gateway": "192.0.2.254", "dev": "eth0", "protocol": "static", "flags": []},
    {"dst": "198.18.0.0/15", "nexthops": [{"gateway": "192.0.2.2", "dev": "eth0"}], "flags": []},
    {"dst": "default", "dev": "wg0", "table": "51820", "scope": "link", "flags": []},
    {"dst": "172.17.0.0/16", "dev": "docker0", "protocol": "kernel", "scope": "link", "flags": ["linkdown"]},
    {"type": "local", "dst": "127.0.0.0/8", "table": "local", "dev": "lo", "protocol": "kernel", "scope": "host"},
    {"type": "local", "dst": "192.0.2.10", "table": "local", "dev": "eth0", "protocol": "kernel", "scope": "host"},
    {"type": "broadcast", "dst": "192.0.2.255", "table": "local", "dev": "eth0", "protocol": "kernel", "scope": "link"},
    {"type": "unreachable", "dst": "203.0.113.128/25", "flags": []},
    {"dst": "169.254.169.254", "dev": "lo", "scope": "link", "flags": []},
]
ROUTES6 = [
    {"dst": "2001:db8:5f::/64", "dev": "eth0", "protocol": "ra", "metric": 100, "flags": [], "pref": "medium"},
    {"dst": "2001:db8:5f::/64", "dev": "eth0", "protocol": "kernel", "metric": 256, "flags": [], "pref": "medium"},
    {"dst": "2001:db8:77::/48", "gateway": "fe80::1", "dev": "eth0", "protocol": "ra", "flags": [], "pref": "medium"},
    {"dst": "fd12:3456:789a::/64", "dev": "eth0", "protocol": "ra", "flags": [], "pref": "medium"},
    {"dst": "fe80::/64", "dev": "eth0", "protocol": "kernel", "metric": 256, "flags": [], "pref": "medium"},
    {"dst": "default", "gateway": "fe80::1", "dev": "eth0", "protocol": "ra", "metric": 1024, "flags": [], "pref": "medium"},
    {"dst": "2000::/3", "dev": "tun0", "metric": 1024, "flags": [], "pref": "medium"},             # a VPN's whole internet
    {"dst": "2001:db8:cafe::/48", "gateway": "2001:db8:5f::fe", "dev": "eth0", "protocol": "static", "flags": []},
    {"type": "local", "dst": "::1", "table": "local", "dev": "lo", "protocol": "kernel", "flags": []},
    {"type": "local", "dst": "2001:db8:5f::10", "table": "local", "dev": "eth0", "protocol": "kernel", "flags": []},
    {"type": "multicast", "dst": "ff00::/8", "table": "local", "dev": "eth0", "protocol": "kernel", "flags": []},
    {"type": "anycast", "dst": "2001:db8:5f::", "table": "local", "dev": "eth0", "protocol": "kernel", "flags": []},
]


class Prefixes(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_ipv6_on_link_and_router_announced_ones_and_nothing_else(self):
        got = [str(n) for n in self.m.home_prefixes(ROUTES6, 6)]
        # fd12:..:/64 and fe80::/64 are in nftables.conf's ranges too; listing them again is harmless.
        self.assertEqual(got, ["2001:db8:5f::/64", "2001:db8:77::/48", "fd12:3456:789a::/64", "fe80::/64"])

    def test_ipv4_on_link_ones_whatever_their_addresses(self):
        got = [str(n) for n in self.m.home_prefixes(ROUTES4, 4)]
        self.assertEqual(got, ["100.64.0.5/32", "172.17.0.0/16", "192.0.2.0/24", "192.168.1.0/24", "203.0.113.0/29"])

    def test_never_a_default_route_a_vpns_halves_loopback_or_the_local_table(self):
        everything = [str(n) for n in self.m.home_prefixes(ROUTES4, 4) + self.m.home_prefixes(ROUTES6, 6)]
        for bad in ("0.0.0.0/1", "128.0.0.0/1", "2000::/3", "127.0.0.0/8", "169.254.169.254/32", "::1/128", "ff00::/8",
                    "198.51.100.0/24", "198.18.0.0/15", "2001:db8:cafe::/48"):
            self.assertNotIn(bad, everything)

    def test_overlapping_prefixes_collapse(self):
        rs = [{"dst": "2001:db8::/56", "dev": "a"}, {"dst": "2001:db8::/64", "dev": "b"}, {"dst": "2001:db8:0:100::/56", "dev": "c"}]
        self.assertEqual([str(n) for n in self.m.home_prefixes(rs, 6)], ["2001:db8::/55"])

    def test_junk_is_skipped(self):
        rs = [None, "x", {"dst": 5, "dev": "a"}, {"dst": "not an address", "dev": "a"}, {"dst": "10.0.0.0/8", "dev": "a"}]
        self.assertEqual(self.m.home_prefixes(rs, 6), [])
        self.assertEqual([str(n) for n in self.m.home_prefixes(rs, 4)], ["10.0.0.0/8"])


class Render(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_flushes_then_adds_both_sets(self):
        p4 = [ipaddress.ip_network("203.0.113.0/29")]
        p6 = [ipaddress.ip_network("2001:db8:5f::/64"), ipaddress.ip_network("2001:db8:77::/48")]
        lines = [l for l in self.m.render(p4, p6).splitlines() if not l.startswith("#")]
        self.assertEqual(lines, ["flush set inet ma home4", "flush set inet ma home6",
                                 "add element inet ma home4 { 203.0.113.0/29 }",
                                 "add element inet ma home6 { 2001:db8:5f::/64, 2001:db8:77::/48 }"])

    def test_empty_sets_add_nothing(self):
        lines = [l for l in self.m.render([], []).splitlines() if not l.startswith("#")]
        self.assertEqual(lines, ["flush set inet ma home4", "flush set inet ma home6"])

    def fake_nft(self, t, rc=0):
        """An nft that keeps a copy of the file it was asked to load, and exits with rc."""
        p = os.path.join(t, "nft")
        with open(p, "w") as f:
            f.write(f'#!/bin/sh\n[ "$1" = -f ] && cat "$2" > "{t}/loaded"\nexit {rc}\n')
        os.chmod(p, stat.S_IRWXU)
        return p

    def test_fill_writes_the_include_and_loads_it(self):
        with tempfile.TemporaryDirectory() as t:
            self.m.OUT_DIR = os.path.join(t, "net")
            self.m.NFT = self.fake_nft(t)
            self.m.routes = lambda fam: ROUTES4 if fam == 4 else ROUTES6
            text = self.m.fill()
            with open(os.path.join(t, "net", "home.nft")) as f:
                self.assertEqual(f.read(), text)
            self.assertIn("2001:db8:5f::/64", text)
            self.assertEqual(oct(os.stat(os.path.join(t, "net", "home.nft")).st_mode & 0o777), "0o644")
            # What it loads is the list and ipv6_ok, in one file, so in one transaction.
            with open(os.path.join(t, "loaded")) as f:
                self.assertEqual(f.read(), text + "flush set inet ma ipv6_ok\nadd element inet ma ipv6_ok { 1102, 1106 }\n")


class FailsClosed(unittest.TestCase):
    """Nov 11: if ma-selfhost-net stops, hangs or fails, the Browser's and desk-agent-filter's IPv6 beyond loopback is
    refused within ipv6_ok's timeout, and IPv4 keeps home4's last list."""

    def setUp(self):
        self.m = load()
        with open(CONF) as f:
            self.conf = f.read()
        self.lines = [l.strip() for l in self.conf.splitlines()]

    def test_the_include_never_marks_a_list_current(self):
        # A reload of the firewall loads home.nft: a list that's hours old mustn't open IPv6 again.
        self.assertNotIn("ipv6_ok", self.m.render([ipaddress.ip_network("203.0.113.0/29")],
                                                      [ipaddress.ip_network("2001:db8:5f::/64")]))
        pattern = os.path.basename(re.search(r'include "([^"]+)"', self.conf).group(1))
        self.assertTrue(fnmatch.fnmatch(self.m.OUT_NAME, pattern))
        self.assertFalse(fnmatch.fnmatch(self.m.LOAD_NAME, pattern))
        self.assertFalse(fnmatch.fnmatch("." + self.m.LOAD_NAME + ".new", pattern))

    def test_the_mark_lapses_and_is_renewed_well_before(self):
        m = re.search(r"set ipv6_ok \{ typeof meta skuid; flags timeout; timeout (\d+)([smh]); \}", self.conf)
        self.assertIsNotNone(m, "ipv6_ok has no timeout of its own")
        timeout = int(m.group(1)) * {"s": 1, "m": 60, "h": 3600}[m.group(2)]
        self.assertEqual(timeout, 180)
        self.assertLessEqual(self.m.REFRESH_S * 3, timeout)  # two renewals can be missed before it lapses

    def test_a_load_that_fails_renews_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            self.m.OUT_DIR = os.path.join(t, "net")
            self.m.NFT = "/bin/false"
            self.m.routes = lambda fam: ROUTES4 if fam == 4 else ROUTES6
            self.assertEqual(self.m.fill("before"), "before")

    def test_the_browser_gets_no_ipv6_beyond_loopback_without_it(self):
        for rule in ("meta skuid 1102 ip6 daddr != ::1 meta skuid != @ipv6_ok tcp flags & (syn | ack) == syn "
                     "reject with tcp reset #HOME",
                     "meta skuid 1102 ip6 daddr != ::1 meta skuid != @ipv6_ok "
                     "reject with icmpv6 type admin-prohibited #HOME"):
            self.assertIn(rule, self.lines)

    def test_desk_agent_filter_dials_ipv6_only_with_it(self):
        r6 = [l for l in self.lines if l.startswith("meta skuid 1106") and "ip6 daddr" in l and " accept" in l
              and "saddr" not in l]
        self.assertEqual(len(r6), 1)
        self.assertIn("meta skuid @ipv6_ok", r6[0])
        r4 = [l for l in self.lines if l.startswith("meta skuid 1106") and "ip daddr !=" in l and " accept" in l]
        self.assertNotIn("ipv6_ok", r4[0])  # IPv4 keeps home4's last list

    def test_the_helper_comes_back_for_as_long_as_it_takes(self):
        with open(UNIT) as f:
            lines = [l.strip() for l in f if not l.lstrip().startswith("#")]
        self.assertIn("Restart=always", lines)
        self.assertIn("StartLimitIntervalSec=0", lines)
        self.assertEqual(self.m.REFRESH_S, 60)
        self.assertEqual(self.m.IPV6_OK, (1102, 1106))


class Rules(unittest.TestCase):
    """nftables.conf as text. Fails before EXP-9's fix: the Browser was refused ranges only."""

    def setUp(self):
        with open(CONF) as f:
            self.conf = f.read()
        self.lines = [l.strip() for l in self.conf.splitlines()]

    def test_the_sets_are_in_the_table(self):
        self.assertRegex(self.conf, r"set home4 \{ type ipv4_addr; flags interval; auto-merge; \}")
        self.assertRegex(self.conf, r"set home6 \{ type ipv6_addr; flags interval; auto-merge; \}")

    def test_the_browser_is_refused_both_and_the_home_network_switch_lifts_it(self):
        for rule in ("meta skuid 1102 ip daddr @home4 reject with icmp type admin-prohibited #HOME",
                     "meta skuid 1102 ip6 daddr @home6 reject with icmpv6 type admin-prohibited #HOME"):
            self.assertIn(rule, self.lines)

    def test_nothing_accepts_the_browser_first(self):
        self.assertEqual([l for l in self.lines if "skuid 1102" in l and " accept" in l], [])

    def test_desk_agent_filter_is_held_off_them_too(self):
        r4 = [l for l in self.lines if l.startswith("meta skuid 1106") and "ip daddr !=" in l and "tcp dport 443 accept" in l]
        r6 = [l for l in self.lines if l.startswith("meta skuid 1106") and "ip6 daddr !=" in l and "tcp dport 443 accept" in l]
        self.assertEqual(len(r4), 1)
        self.assertEqual(len(r6), 1)
        self.assertIn("ip daddr != @home4", r4[0])
        self.assertIn("ip6 daddr != @home6", r6[0])

    def test_the_include_is_last_and_a_pattern(self):
        inc = [l for l in self.lines if l.startswith("include ")]
        self.assertEqual(inc, ['include "/run/ma-selfhost-net/*.nft"'])
        self.assertEqual([l for l in self.lines if l and not l.startswith("#")][-1], inc[0])

    def test_ma_selfhost_net_writes_where_the_include_reads(self):
        m = load()
        pattern = re.search(r'include "([^"]+)"', self.conf).group(1)
        self.assertEqual(os.path.dirname(pattern), m.OUT_DIR)
        self.assertTrue(m.OUT_NAME.endswith(".nft"))


if __name__ == "__main__":
    unittest.main()
