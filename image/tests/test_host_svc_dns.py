#!/usr/bin/python3 -I
"""desk-host-check's `svc-dns` (Bug 8, the staging soak), on fake command output: it passes when every running slot's sandboxes see
the desk's resolver and a lookup of a public name from inside deskd, desk-rtc and desk-agent behaves, and it fails on 0.1.8's
state (the release's empty /etc/resolv.conf in deskd's sandbox) and on each other break here. No root, no host.
python3 -I image/tests/test_host_svc_dns.py"""
import builtins
import json
import sys
import pathlib
import subprocess
import types
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
LIB = IMAGE / "host" / "recipe" / "files" / "usr" / "local" / "lib" / "desk-host"
RESOLV = "nameserver 169.254.169.253"
NAME = "sts.us-east-1.amazonaws.com"
PIDS = {"desk-rtc": 500, "deskd": 501, "desk-agent": 502, "desk-notebook": 503, "desk-stream": 504, "desk-data": 505}
UIDS = {500: 1101, 501: 1100, 502: 1103, 503: 1105, 504: 1104, 505: 1112}


def load_check():
    src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
    m = types.ModuleType("desk_host_check")
    m.__dict__["__name__"] = "desk_host_check"
    sys.path.insert(0, str(LIB))   # its modules (templates.py, ADR 0077) beside it
    exec(compile(src, "desk-host-check", "exec"), m.__dict__)
    return m


class World:
    """One running slot (k=1) with six sandboxes; `resolv` and `lookup` are what the breaks change."""
    def __init__(self):
        self.resolv = {svc: RESOLV for svc in PIDS}
        self.lookup = {"deskd": "54.1.2.3\n", "desk-rtc": "54.1.2.3\n", "desk-agent": ""}
        self.region = "us-east-1"
        self.sandboxes = set(PIDS)

    def install(self, m):
        pid_svc = {p: s for s, p in PIDS.items()}

        def sh(*a, **kw):
            R = lambda out="", rc=0: subprocess.CompletedProcess(a, rc, out, "")   # noqa: E731
            if a[0] == m.RUNC and a[1] == "state":
                svc = a[2].removeprefix("dh-svc-1-")
                return R(json.dumps({"pid": PIDS[svc]}), 0) if svc in self.sandboxes else R("", 1)
            if a[0] == "nsenter":
                pid = int(a[2])
                assert a[a.index("-S") + 1] == str(UIDS[pid] - 0), a   # the service's own uid, inside
                assert a[-2:] == ("ahostsv4", NAME), a
                out = self.lookup.get(pid_svc[pid], "")
                if out == "TIMEOUT":
                    raise subprocess.TimeoutExpired(a, 15)
                return R("".join(f"{x.strip()} STREAM {NAME}\n" for x in out.split() if x))
            raise AssertionError(a)

        def rd(p):
            p = str(p)
            if p == f"{m.T}/etc/resolv.conf":
                return RESOLV
            for pid, svc in pid_svc.items():
                if p == f"/proc/{pid}/root/etc/resolv.conf":
                    return self.resolv[svc]
            return None

        real_open = builtins.open
        status = {f"/proc/{p}/status": f"Name:\tx\nUid:\t{100000 + 65536 + UIDS[p]}\t1\t1\t1\n" for p in UIDS}

        def fake_open(path, *a, **kw):
            if str(path) in status:
                import io
                return io.StringIO(status[str(path)])
            return real_open(path, *a, **kw)

        m.sh, m.rd, m.imds = sh, rd, lambda path: self.region if path == "placement/region" else None
        m.running_slots = lambda: {1}
        m.open = fake_open


class SvcDns(unittest.TestCase):
    def run_check(self, mutate=None):
        m = load_check()
        w = World()
        if mutate:
            mutate(w)
        w.install(m)
        return m.c_svc_dns()

    def test_passes_as_built(self):
        ok, detail = self.run_check()
        self.assertTrue(ok, detail)
        self.assertIn("6 sandbox(es)", detail)
        self.assertIn("3 lookups", detail)

    def test_fails_on_0_1_8_empty_resolv_conf_in_deskd(self):   # the bug: the release's empty file, and so no lookup
        def b(w):
            w.resolv["deskd"] = ""
            w.lookup["deskd"] = ""
        ok, detail = self.run_check(b)
        self.assertFalse(ok)
        self.assertIn("deskd", detail)

    def test_fails_when_only_the_lookup_fails(self):
        ok, detail = self.run_check(lambda w: w.lookup.update(deskd=""))
        self.assertFalse(ok)
        self.assertIn("did not resolve", detail)

    def test_fails_on_the_placeholder_for_deskd(self):
        self.assertFalse(self.run_check(lambda w: w.lookup.update(deskd="192.0.2.1"))[0])

    def test_fails_when_desk_notebook_has_the_empty_file(self):   # no network there, so only the file shows it
        self.assertFalse(self.run_check(lambda w: w.resolv.update({"desk-notebook": ""}))[0])

    def test_fails_when_a_sandbox_is_missing(self):
        self.assertFalse(self.run_check(lambda w: w.sandboxes.discard("desk-data"))[0])

    def test_agent_may_get_the_placeholder_or_nothing_never_a_real_address(self):
        self.assertTrue(self.run_check(lambda w: w.lookup.update({"desk-agent": "192.0.2.1"}))[0])
        self.assertTrue(self.run_check(lambda w: w.lookup.update({"desk-agent": "TIMEOUT"}))[0])
        ok, detail = self.run_check(lambda w: w.lookup.update({"desk-agent": "54.1.2.3"}))
        self.assertFalse(ok)
        self.assertIn("not through the filter", detail)

    def test_a_lookup_that_times_out_in_deskd_fails(self):
        self.assertFalse(self.run_check(lambda w: w.lookup.update(deskd="TIMEOUT"))[0])

    def test_no_region_is_a_failure(self):
        self.assertFalse(self.run_check(lambda w: setattr(w, "region", None))[0])

    def test_nothing_running_passes(self):
        m = load_check()
        w = World()
        w.install(m)
        m.running_slots = lambda: set()
        self.assertTrue(m.c_svc_dns()[0])


if __name__ == "__main__":
    unittest.main()
