#!/usr/bin/python3 -I
"""Courier on a shared host (docs/sub-status/courier-slot.md): the slot half of the image change in docs/sub-status/mm-courier-parse.md
("The image change", item 4) and mm-courier-imap.md / mm-courier-keys.md's data directories and egress, without a box:
- wallspec: desk-parse-courier (root:desk 0750) then desk-parse-courier/sock (parse:desk 2750), both sandbox-only, so the desk's own
  container gets neither; make_shares gives them the slot's ids and no marker;
- svc-spec: desk-parse-courier exactly as desk-parse but for deskd (its own socket, peer uid 1100, 15 s, courier-parse.options, its own
  share only), on desk-agent's release root as uid 1113 with no capabilities, its own network and IPC, no /data or scratch, 160 MiB, 64
  tasks, +500; the template's tracker list read-only over the release's placeholder only when both are there (never through a link);
  deskd's spec: the share read-only at /run/desk-parse-courier and placeholders at /data/courier and /data/keys;
- desk-host: SVCS, and desk-parse-courier down and up with desk-agent (a live switch, a switch back, a resandbox); templates.py's trial;
- desk-host-check: the unit masked, SVC_ALL, OOM, courier-parse on a faked slot (passes as built, fails on each break) and courier-dirs
  (the volume's 1100:1100 0700, a skip said); parse's memory is svc-spec's 160 MiB;
- the host's smoke test for desk-agent needs desk-parse-courier where its share is;
- mounts.py and desk-init.py: /data/courier and /data/keys (1100:1100 0700), optional, never followed;
- the verify scripts: verify-courier.sh (its client against a stand-in desk-svc, its list check against courier-trackers.py's own first
  line), section 12 in both verify.sh and verify-port.sh, one mutation per desk-host-check check in both mutation passes, and every
  resandbox in verify-parse.sh and verify-courier.sh made with the host a test host for that call.
Each fails on main before this change. No root, no network: python3 -I image/tests/test_host_courier.py
"""
import ast
import copy
import errno
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import zipfile

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
REPO = IMAGE.parent
HOST = IMAGE / "host"
LIB = HOST / "recipe/files/usr/local/lib/desk-host"
NAME = "desk-parse-courier"
USERS = {"desk": 1100, "rtc": 1101, "kiosk": 1102, "agent": 1103, "stream": 1104, "notebook": 1105, "agent-filter": 1106,
         "desk-x": 1107, "desk-snd": 1108, "desk-dns": 1109, "desk-data": 1112, "parse": 1113}
DOCKER = {
    "process": {"capabilities": {k: ["CAP_CHOWN", "CAP_NET_RAW"] for k in ("bounding", "effective", "permitted")}}, "hooks": {}, "annotations": {},
    "root": {}, "mounts": [{"destination": d, "type": "x", "source": "x", "options": []} for d in ("/proc", "/dev", "/dev/pts", "/sys")],
    "linux": {"seccomp": {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": [], "architectures": []}, "maskedPaths": [], "resources": {"devices": []},
              "uidMappings": [], "gidMappings": [], "sysctl": {}},
}
COURIER_ARGS = ["-accept", "/run/desk-parse-courier/sock/parse.sock", "-accept-mode", "0660", "-peer-uid", "1100", "-max-conn", "1",
                "-deadline-sec", "15", "-conn-stdio", "-clean"]


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_check(name="desk_host_check_courier"):
    src = (LIB / "desk-host-check").read_text().replace("sys.exit(main())", "")
    m = types.ModuleType(name)
    sys.path.insert(0, str(LIB))   # its modules (templates.py, ADR 0077) beside it
    exec(compile(src, "desk-host-check", "exec"), m.__dict__)
    return m


class Slot:
    """A store with slot k's template generation g1 (the desk's users) and its record, as svc-spec.py reads them."""

    def __init__(self, case, k=1, trackers=True, placeholder=True):
        self.k, self.tmp = k, pathlib.Path(tempfile.mkdtemp())
        case.addCleanup(shutil.rmtree, self.tmp, True)
        self.tpl = self.tmp / "templates/g1"
        (self.tpl / "etc").mkdir(parents=True)
        (self.tpl / ".complete").write_text("gen=g1\n")
        (self.tpl / "etc/passwd").write_text("".join(f"{n}:x:{i}:{i}::/:/bin/false\n" for n, i in USERS.items()))
        (self.tpl / "etc/group").write_text("".join(f"{n}:x:{i}:\n" for n, i in dict(USERS, **{"desk-audio": 1111}).items()))
        (self.tpl / "etc/resolv.conf").write_text("nameserver 169.254.169.253\n")
        self.list = self.tpl / "usr/share/ma/adblock/courier-trackers.txt"
        if trackers:
            self.list.parent.mkdir(parents=True)
            self.list.write_text("# ADR 0076: uBlock Origin Lite 2026.1103.1743, sha256 ab; easyprivacy\nexample-tracker.com\n")
        self.root = self.tmp / f"slots/{k}/rel/desk-agent/rootfs"
        self.placeholder = self.root / "app/courier/trackers.txt"
        self.placeholder.parent.mkdir(parents=True)
        if placeholder:
            self.placeholder.write_text("")
        (self.tmp / "records").mkdir()
        (self.tmp / "records" / f"{k}.json").write_text(json.dumps({"slot": k, "state": "desk", "template": "g1"}))
        old = os.environ.get("DESK_HOST_RECORDS")
        os.environ["DESK_HOST_RECORDS"] = str(self.tmp / "records")
        case.addCleanup(lambda: os.environ.pop("DESK_HOST_RECORDS") if old is None else os.environ.__setitem__("DESK_HOST_RECORDS", old))
        sys.path.insert(0, str(LIB))
        case.addCleanup(sys.path.remove, str(LIB))
        sys.modules.pop("wallspec", None)
        import wallspec
        case.addCleanup(sys.modules.pop, "wallspec", None)
        wallspec.DH = str(self.tmp)
        wallspec.docker_spec = lambda: copy.deepcopy(DOCKER)
        wallspec.test_mode = lambda: False
        self.wallspec = wallspec
        self.svc = load_file("svc_spec_courier", LIB / "svc-spec.py")

    def spec(self, name):
        return self.svc.spec(self.k, name)


def dests(spec):
    return {m["destination"]: m for m in spec["mounts"]}


class Shares(unittest.TestCase):
    def setUp(self):
        self.s = Slot(self)

    def test_the_two_shares_in_order_with_their_owners_and_modes(self):
        sh = self.s.wallspec.shares(1)
        names = list(sh)
        self.assertLess(names.index(NAME), names.index(f"{NAME}/sock"))
        self.assertEqual(sh[NAME], ("/run/desk-parse-courier", 0, "desk", 0o750))
        self.assertEqual(sh[f"{NAME}/sock"], ("/run/desk-parse-courier/sock", "parse", "desk", 0o2750))
        self.assertIn(NAME, self.s.wallspec.SANDBOX_ONLY)
        self.assertIn(f"{NAME}/sock", self.s.wallspec.SANDBOX_ONLY)
        self.assertIn("desk-parse", self.s.wallspec.SANDBOX_ONLY, "desk-parse's stay sandbox-only")

    def test_make_shares_gives_them_the_slot_s_ids_and_no_marker(self):
        d = pathlib.Path(tempfile.mkdtemp(dir=self.s.tmp))
        chowns = []
        real = (os.chown, os.fchown)
        os.chown = lambda p, u, g: chowns.append((os.path.relpath(p, d), u, g))
        os.fchown = lambda fd, u, g: None   # desk-parse's marker, chowned by descriptor (needs root here)
        out = sys.stdout
        sys.stdout = open(os.devnull, "w")
        try:
            self.s.svc.make_shares(1, str(d))
        finally:
            sys.stdout.close()
            sys.stdout = out
            os.chown, os.fchown = real
        base = 100000 + 65536
        self.assertIn((NAME, base, base + 1100), chowns)
        self.assertIn((f"{NAME}/sock", base + 1113, base + 1100), chowns)
        self.assertEqual(stat.S_IMODE((d / NAME).stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE((d / NAME / "sock").stat().st_mode), 0o2750)
        self.assertEqual(sorted(os.listdir(d / NAME)), ["sock"], "no marker: deskd has no reader of its own to fence off")
        self.assertTrue((d / "desk-parse/required").exists(), "desk-parse's marker as before")

    def test_the_desk_s_own_container_gets_neither(self):
        bundle = self.s.tmp / "bundle"
        g = {"__name__": "__main__", "__file__": str(LIB / "desk-spec.py")}
        argv, out = sys.argv, sys.stdout
        sys.argv, sys.stdout = ["desk-spec.py", "1", str(bundle)], open(os.devnull, "w")
        try:
            exec(compile((LIB / "desk-spec.py").read_text(), "desk-spec.py", "exec"), g)
        finally:
            sys.stdout.close()
            sys.argv, sys.stdout = argv, out
        d = [m["destination"] for m in json.loads((bundle / "config.json").read_text())["mounts"]]
        self.assertFalse([x for x in d if x.startswith("/run/desk-parse")], d)
        self.assertIn("/run/desk", d, "the desk's other shares as before")


class Sandbox(unittest.TestCase):
    def test_the_reader_is_desk_parse_s_sandbox_for_deskd(self):
        s = Slot(self)
        sp, par = s.spec(NAME), s.spec("desk-parse")
        p = sp["process"]
        self.assertEqual(p["user"], {"uid": 1113, "gid": 1113})
        self.assertEqual({k: v for k, v in p["capabilities"].items() if v}, {})
        self.assertTrue(p["noNewPrivileges"])
        self.assertEqual((p["oomScoreAdj"], p["apparmorProfile"], p["cwd"]), (500, "desk-host-1", "/"))
        self.assertEqual(p["args"], ["/desk-host/desk-svc", *COURIER_ARGS, "--", "/opt/java/openjdk/bin/java", "@/app/courier-parse.options"])
        self.assertEqual(sorted(p["env"]), sorted(par["process"]["env"]), "the same empty environment as desk-parse")
        self.assertEqual(sp["root"], {"path": f"{s.tmp}/slots/1/rel/desk-agent/rootfs", "readonly": True}, "desk-agent's release copy")
        self.assertEqual(sp["root"], par["root"])
        ns = {n["type"]: n for n in sp["linux"]["namespaces"]}
        self.assertNotIn("path", ns["network"])
        self.assertNotIn("path", ns["ipc"])
        self.assertEqual(ns["user"]["path"], "/run/desk-host/ns/1/user")
        self.assertEqual(sp["linux"]["resources"]["unified"], {"memory.max": str(160 << 20), "memory.swap.max": "0", "pids.max": "64", "cpu.weight": "10"})
        self.assertEqual(sp["linux"]["cgroupsPath"], f"/desk-host/desk-1/svc-{NAME}")
        d = dests(sp)
        for gone in ("/data", "/tmp", "/dev/shm", "/run/desk", "/run/desk-agent", "/run/desk-parse", "/run/desk-parse/sock", "/run/desk-parse-courier"):
            self.assertNotIn(gone, d)
        self.assertFalse([x for x in d if x.startswith("/data")])
        self.assertEqual([x for x in d if x.startswith("/run/desk")], ["/run/desk-parse-courier/sock"])
        self.assertEqual(d["/run/desk-parse-courier/sock"]["source"], "/run/desk-host/share/1/desk-parse-courier/sock")
        self.assertIn("rw", d["/run/desk-parse-courier/sock"]["options"])
        self.assertIn("mode=755", d["/run"]["options"])
        self.assertIn("ro", d["/desk-host"]["options"])
        self.assertIn("/etc/resolv.conf", d, "a release root's resolver, as desk-parse's (it has no network to use it)")
        # everything else exactly desk-parse's: the same mounts but its own socket and the list
        self.assertEqual(sorted(set(d) - {"/run/desk-parse-courier/sock", "/app/courier/trackers.txt"}),
                         sorted(set(dests(par)) - {"/run/desk-parse/sock"}))

    def test_the_tracker_list_is_bound_read_only_over_the_placeholder(self):
        s = Slot(self)
        m = dests(s.spec(NAME))["/app/courier/trackers.txt"]
        self.assertEqual((m["type"], m["source"]), ("bind", f"{s.tpl}/usr/share/ma/adblock/courier-trackers.txt"))
        self.assertIn("ro", m["options"])
        self.assertIn("noexec", m["options"])
        self.assertNotIn("/app/courier/trackers.txt", dests(s.spec("desk-parse")))

    def test_no_list_in_the_template_keeps_the_placeholder(self):   # a desk image before 0.3.9
        self.assertNotIn("/app/courier/trackers.txt", dests(Slot(self, trackers=False).spec(NAME)))

    def test_no_placeholder_in_the_release_binds_nothing(self):   # a desk-agent before Courier's mode: no mount point is made in its root
        s = Slot(self, placeholder=False)
        self.assertNotIn("/app/courier/trackers.txt", dests(s.spec(NAME)))
        self.assertFalse(s.placeholder.exists())

    def test_a_link_at_either_is_never_followed(self):
        s = Slot(self, trackers=False)
        s.list.parent.mkdir(parents=True)
        (s.tmp / "elsewhere").write_text("x\n")
        os.symlink(s.tmp / "elsewhere", s.list)
        self.assertNotIn("/app/courier/trackers.txt", dests(s.spec(NAME)))
        s2 = Slot(self, placeholder=False)
        os.symlink(s2.tmp / "elsewhere-too", s2.placeholder)
        self.assertNotIn("/app/courier/trackers.txt", dests(s2.spec(NAME)))

    def test_deskd_has_the_share_read_only_and_its_two_data_directories(self):
        s = Slot(self)
        d = dests(s.spec("deskd"))
        self.assertEqual(d["/run/desk-parse-courier"]["source"], "/run/desk-host/share/1/desk-parse-courier")
        self.assertIn("ro", d["/run/desk-parse-courier"]["options"])
        self.assertNotIn("/run/desk-parse-courier/sock", d)
        for sub in ("courier", "keys"):
            self.assertEqual(d[f"/data/{sub}"]["type"], "tmpfs", "a placeholder mounts.py moves the volume's directory over")
            self.assertIn("mode=000", d[f"/data/{sub}"]["options"])
        self.assertIn("/run/desk-links", d, "deskd's other shares as before")

    def test_no_other_sandbox_has_the_share(self):
        s = Slot(self)
        for name in s.svc.SERVICES:
            if name in ("deskd", NAME):
                continue
            got = [x for x in dests(s.spec(name)) if x.startswith("/run/desk-parse-courier")]
            self.assertEqual(got, [], name)

    def test_it_is_a_service_of_the_slot(self):
        s = Slot(self)
        self.assertIn(NAME, s.svc.SERVICES)
        self.assertEqual(s.svc.SERVICES[:7], ("desk-rtc", "deskd", "desk-agent", "desk-notebook", "desk-stream", "desk-data", "desk-parse"))


class DeskHost(unittest.TestCase):
    def setUp(self):
        self.src = (LIB / "desk-host").read_text()

    def test_svcs_has_it_after_desk_agent(self):
        svcs = re.search(r'^SVCS="([^"]*)"', self.src, re.M).group(1).split()
        self.assertIn(NAME, svcs)
        self.assertGreater(svcs.index(NAME), svcs.index("desk-agent"))
        self.assertEqual(re.search(r'^AGENT_ROOTED="([^"]*)"', self.src, re.M).group(1).split(), ["desk-parse", NAME])

    def run_steps(self, calls, fail_up=""):
        a, b = self.src.index("svc_down() {"), self.src.index("svc_down_one() {")
        agent = re.search(r'^AGENT_ROOTED=.*$', self.src, re.M).group(0)
        with tempfile.TemporaryDirectory() as t:
            script = pathlib.Path(t) / "s.sh"
            script.write_text(f'{agent}\nsvc_down_one() {{ echo "down $2"; }}\n'
                              f'svc_up_one() {{ echo "up $2"; [ "$2" != "{fail_up}" ]; }}\n' + self.src[a:b] + calls)
            r = subprocess.run(["bash", str(script)], capture_output=True, text=True)
        return [l for l in r.stdout.split("\n") if l], r.stderr

    def test_it_goes_down_and_up_with_desk_agent_and_only_with_it(self):
        out, _ = self.run_steps("svc_down 1 desk-agent; svc_up 1 desk-agent; svc_down 1 deskd; svc_up 1 deskd\n")
        self.assertEqual(out, ["down desk-parse", f"down {NAME}", "down desk-agent", "up desk-agent", "down desk-parse", "up desk-parse",
                               f"down {NAME}", f"up {NAME}", "down deskd", "up deskd"])

    def test_a_reader_that_does_not_come_back_fails_the_switch(self):
        out, err = self.run_steps('svc_up 1 desk-agent; echo "rc $?"\n', fail_up=NAME)
        self.assertEqual(out[-1], "rc 1")
        self.assertIn(f"{NAME}'s sandbox didn't start on desk-agent's release", err)

    def test_the_trial_watches_it(self):
        t = (LIB / "templates.py").read_text()
        i = t.index("def trial_check(")
        self.assertIn(f'"{NAME}"', t[i:t.index("\ndef ", i + 10)])


class CheckLists(unittest.TestCase):
    def test_the_unit_is_masked_and_listed(self):
        b = (HOST / "recipe/build.sh").read_text()
        self.assertIn(f"{NAME}.service", re.search(r'DESK_UNITS="([^"]*)"', b, re.S).group(1).split())
        m = load_check()
        self.assertIn(f"{NAME}.service", m.DESK_UNITS)
        self.assertEqual(sorted(m.DESK_UNITS), sorted(re.search(r'DESK_UNITS="([^"]*)"', b, re.S).group(1).split()), "build.sh masks what the check reads")

    def test_svc_all_oom_and_checks(self):
        m = load_check()
        self.assertIn(NAME, m.SVC_ALL)
        self.assertNotIn(NAME, m.SVC_NET, "no network: no lookup from inside")
        self.assertEqual(m.OOM[NAME], 500)
        for c in ("courier-parse", "courier-dirs", "parse", "files"):
            self.assertIn(c, m.CHECKS)
        self.assertEqual(m.READER_MEM, 160 << 20)


def stat_of(mode, uid, gid, dev=0):
    return types.SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid, st_dev=dev, st_rdev=dev)


class ReaderWorld:
    """Slot 1 running with desk-parse-courier and deskd, faked at the host's side: the share, runc's state, config.json and /proc."""
    K, BASE, PID, DPID, APID, PPID = 1, 100000 + 65536, 700, 701, 702, 703

    def __init__(self, case):
        self.s = Slot(case)
        sh_ = f"/run/desk-host/share/{self.K}/{NAME}"
        b = self.BASE
        self.files = {sh_: stat_of(stat.S_IFDIR | 0o750, b, b + 1100), f"{sh_}/sock": stat_of(stat.S_IFDIR | 0o2750, b + 1113, b + 1100),
                      f"{sh_}/sock/parse.sock": stat_of(stat.S_IFSOCK | 0o660, b + 1113, b + 1100)}
        self.sock_dir = ["parse.sock"]
        self.cfg = self.s.spec(NAME)
        self.status = {"Uid": [str(b + 1113)] * 4, "CapEff": ["0000000000000000"], "NoNewPrivs": ["1"]}
        self.mem_uid = 0
        self.mounts = ["/", "/proc", "/dev", "/sys", "/run", "/run/desk-parse-courier/sock", "/desk-host", "/etc/resolv.conf", "/app/courier/trackers.txt"]
        self.devs = ["lo"]
        self.deskd_ro = True
        self.running = {f"dh-svc-{self.K}-{NAME}": self.PID, f"dh-svc-{self.K}-deskd": self.DPID}

    def install(self, m):
        w = self
        m.DH = str(self.s.tmp)
        m.running_slots = lambda: {self.K}
        m.slot_tree = lambda k: str(self.s.tpl)

        def sh(*a, **kw):
            if a[0] == m.RUNC and a[1] == "state" and a[2] in w.running:
                return subprocess.CompletedProcess(a, 0, json.dumps({"pid": w.running[a[2]], "bundle": f"/b/{a[2]}"}), "")
            return subprocess.CompletedProcess(a, 1, "", "no such container")
        m.sh = sh

        def lstat(p):
            if p in w.files:
                return w.files[p]
            raise FileNotFoundError(errno.ENOENT, p)

        def fstat(p):
            if p == f"/proc/{w.PID}/mem":
                return stat_of(stat.S_IFREG | 0o600, w.mem_uid, w.mem_uid)
            return os.stat(p)
        sh_sock = f"/run/desk-host/share/{self.K}/{NAME}/sock"
        path = types.SimpleNamespace(isdir=lambda p: p == sh_sock or os.path.isdir(p), isfile=os.path.isfile, islink=os.path.islink)
        m.os = types.SimpleNamespace(lstat=lstat, stat=fstat, listdir=lambda p: list(w.sock_dir) if p == sh_sock else os.listdir(p), path=path)
        real_open = open

        def fake_open(p, *a, **kw):
            p = str(p)
            if p == f"/b/dh-svc-{w.K}-{NAME}/config.json":
                return io.StringIO(json.dumps(w.cfg))
            if p == f"/proc/{w.PID}/status":
                return io.StringIO("".join(f"{k}:\t{chr(9).join(v)}\n" for k, v in w.status.items()))
            if p == f"/proc/{w.PID}/mountinfo":
                return io.StringIO("".join(f"{i} 1 0:1 / {d} rw,nosuid - tmpfs x rw\n" for i, d in enumerate(w.mounts)))
            if p == f"/proc/{w.PID}/net/dev":
                return io.StringIO("Inter-|\n face |\n" + "".join(f"  {d}: 0 0\n" for d in w.devs))
            if p == f"/proc/{w.DPID}/mountinfo":
                return io.StringIO(f"5 1 0:1 / /run/desk-parse-courier {'ro' if w.deskd_ro else 'rw'},nosuid - tmpfs x rw\n" if w.deskd_ro is not None else "")
            return real_open(p, *a, **kw)
        m.open = fake_open
        return m


class CourierParseCheck(unittest.TestCase):
    def check(self, change=None):
        w = ReaderWorld(self)
        if change:
            change(w)
        m = w.install(load_check())
        return m.c_courier_parse()

    def test_passes_as_built(self):
        ok, why = self.check()
        self.assertTrue(ok, why)
        self.assertIn("1 desk-parse-courier sandbox(es)", why)

    def test_each_break_fails(self):
        b = 100000 + 65536
        sock = f"/run/desk-host/share/1/{NAME}/sock/parse.sock"
        breaks = {
            "the socket 0666": lambda w: w.files.__setitem__(sock, stat_of(stat.S_IFSOCK | 0o666, b + 1113, b + 1100)),
            "the socket the agent's group": lambda w: w.files.__setitem__(sock, stat_of(stat.S_IFSOCK | 0o660, b + 1113, b + 1103)),
            "the directory 0755": lambda w: w.files.__setitem__(f"/run/desk-host/share/1/{NAME}", stat_of(stat.S_IFDIR | 0o755, b, b + 1100)),
            "no socket": lambda w: w.files.pop(sock),
            "something else in sock": lambda w: w.sock_dir.append("left"),
            "no sandbox": lambda w: w.running.pop(f"dh-svc-1-{NAME}"),
            "uid 1100": lambda w: w.cfg["process"].__setitem__("user", {"uid": 1100, "gid": 1100}),
            "a capability": lambda w: w.cfg["process"]["capabilities"].__setitem__("bounding", ["CAP_CHOWN"]),
            "another root": lambda w: w.cfg.__setitem__("root", {"path": "/elsewhere", "readonly": True}),
            "the desk's network": lambda w: [n.__setitem__("path", "/run/desk-host/ns/1/net") for n in w.cfg["linux"]["namespaces"] if n["type"] == "network"],
            "the desk's IPC": lambda w: [n.__setitem__("path", "/run/desk-host/ns/1/ipc") for n in w.cfg["linux"]["namespaces"] if n["type"] == "ipc"],
            "desk-parse's peer": lambda w: w.cfg["process"]["args"].__setitem__(6, "1103"),
            "35 s": lambda w: w.cfg["process"]["args"].__setitem__(10, "35"),
            "parse.options": lambda w: w.cfg["process"]["args"].__setitem__(-1, "@/app/parse.options"),
            "128 MiB": lambda w: w.cfg["linux"]["resources"]["unified"].__setitem__("memory.max", str(128 << 20)),
            "a /data mount": lambda w: w.cfg["mounts"].append({"destination": "/data/courier", "type": "bind", "source": "/x", "options": ["rbind", "rw"]}),
            "the desk's /run share": lambda w: w.cfg["mounts"].append({"destination": "/run/desk", "type": "bind", "source": "/x", "options": ["rbind", "rw"]}),
            "a /tmp": lambda w: w.cfg["mounts"].append({"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": []}),
            "the list writable": lambda w: [m_.__setitem__("options", ["rbind", "rw"]) for m_ in w.cfg["mounts"] if m_["destination"] == "/app/courier/trackers.txt"],
            "the list from elsewhere": lambda w: [m_.__setitem__("source", "/tmp/list") for m_ in w.cfg["mounts"] if m_["destination"] == "/app/courier/trackers.txt"],
            "the list not bound": lambda w: w.cfg.__setitem__("mounts", [m_ for m_ in w.cfg["mounts"] if m_["destination"] != "/app/courier/trackers.txt"]),
            "process 1 uid 1100": lambda w: w.status.__setitem__("Uid", [str(b + 1100)] * 4),
            "CapEff": lambda w: w.status.__setitem__("CapEff", ["0000000000000001"]),
            "no_new_privs off": lambda w: w.status.__setitem__("NoNewPrivs", ["0"]),
            "dumpable": lambda w: setattr(w, "mem_uid", b + 1113),
            "/data in its mount table": lambda w: w.mounts.append("/data"),
            "/dev/shm in its mount table": lambda w: w.mounts.append("/dev/shm"),
            "another /run/desk* in its mount table": lambda w: w.mounts.append("/run/desk-agent"),
            "eth0": lambda w: w.devs.append("eth0"),
            "deskd's share writable": lambda w: setattr(w, "deskd_ro", False),
            "deskd without the share": lambda w: setattr(w, "deskd_ro", None),
            "no deskd": lambda w: w.running.pop("dh-svc-1-deskd"),
        }
        for what, change in breaks.items():
            with self.subTest(what):
                ok, why = self.check(change)
                self.assertFalse(ok, f"{what}: {why}")

    def test_no_list_in_the_template_and_no_bind_passes(self):   # a desk image before 0.3.9: the placeholder stays, and that's right
        def change(w):
            w.s.list.unlink()
            w.cfg = w.s.spec(NAME)
        ok, why = self.check(change)
        self.assertTrue(ok, why)

    def test_a_bind_the_template_can_t_give_fails(self):
        def change(w):
            w.s.list.unlink()   # the spec was made with the list: now the template has none
        self.assertFalse(self.check(change)[0])

    def test_nothing_running(self):
        w = ReaderWorld(self)
        m = w.install(load_check())
        m.running_slots = lambda: set()
        self.assertTrue(m.c_courier_parse()[0])


class ParseCheckMemory(unittest.TestCase):
    """desk-host-check parse expected 128 MiB after svc-spec.py gave desk-parse 160 (aee7dc83): a live host's parse check would fail."""

    def test_parse_reads_svc_spec_s_160_mib(self):
        src = (LIB / "desk-host-check").read_text()
        a = src.index("def reader_problems(")
        self.assertIn('u.get("memory.max") != str(READER_MEM)', src[a:src.index("\ndef ", a + 10)])
        self.assertIn('mem="160M"', re.search(r'"desk-parse": dict\(.*?\)\s*,\n', (LIB / "svc-spec.py").read_text(), re.S).group(0))


class CourierDirsCheck(unittest.TestCase):
    """desk-host-check courier-dirs on one running slot (k=2), its deskd sandbox and volume faked, as test_host_files_slot's files check."""
    K, BASE, PID, VOL = 2, 100000 + 2 * 65536, 4343, os.makedev(259, 4)

    def setUp(self):
        self.m = load_check()
        self.mounts = {"refused": [], "skipped": {}, "device": "/dev/nvme4n1"}
        good = dict(mode=stat.S_IFDIR | 0o700, uid=self.BASE + 1100, gid=self.BASE + 1100, dev=self.VOL)
        self.dirs = {"courier": dict(good), "keys": dict(good)}
        self.m.running_slots = lambda: {self.K}
        self.m.rd = lambda p: json.dumps(self.mounts) if p == f"/run/desk-host/{self.K}.mounts.json" else None
        self.m.sh = lambda *a, **kw: subprocess.CompletedProcess(a, 0, json.dumps({"pid": self.PID}), "")

        def lstat(p):
            sub = p.rsplit("/", 1)[1]
            assert p == f"/proc/{self.PID}/root/data/{sub}" and sub in self.dirs, p
            f = self.dirs[sub]
            return types.SimpleNamespace(st_mode=f["mode"], st_uid=f["uid"], st_gid=f["gid"], st_dev=f["dev"])

        def stat_(p):
            assert p == "/dev/nvme4n1", p
            return types.SimpleNamespace(st_rdev=self.VOL)
        self.m.os = types.SimpleNamespace(lstat=lstat, stat=stat_, major=os.major, minor=os.minor)

    def test_the_volume_s_directories_pass(self):
        ok, why = self.m.c_courier_dirs()
        self.assertTrue(ok, why)
        self.assertIn("2 of deskd's /data/courier and /data/keys its volume's", why)

    def test_a_placeholder_fails(self):
        for sub in ("courier", "keys"):
            with self.subTest(sub):
                self.setUp()
                self.dirs[sub].update(mode=stat.S_IFDIR | 0o000, uid=self.BASE, gid=self.BASE, dev=os.makedev(0, 77))
                ok, why = self.m.c_courier_dirs()
                self.assertFalse(ok)
                self.assertIn(f"/data/{sub} is 0:0 0000", why)

    def test_a_tmpfs_that_isn_t_the_volume_fails(self):
        self.dirs["keys"].update(dev=os.makedev(0, 78))
        ok, why = self.m.c_courier_dirs()
        self.assertFalse(ok)
        self.assertIn("isn't on its volume", why)

    def test_the_wrong_owner_or_mode_fails(self):
        self.dirs["courier"].update(mode=stat.S_IFDIR | 0o750)
        self.assertFalse(self.m.c_courier_dirs()[0])
        self.setUp()
        self.dirs["keys"].update(uid=self.BASE + 1103)
        self.assertFalse(self.m.c_courier_dirs()[0])

    def test_a_skip_is_said_not_failed(self):   # a volume from before: the desk makes them, the next start mounts them
        self.mounts["skipped"] = {"deskd": {"courier": "ENOENT", "keys": "ELOOP"}}
        for sub in ("courier", "keys"):
            self.dirs[sub].update(mode=stat.S_IFDIR, uid=self.BASE, gid=self.BASE, dev=os.makedev(0, 77))
        ok, why = self.m.c_courier_dirs()
        self.assertTrue(ok, why)
        self.assertIn("the volume's courier ENOENT", why)
        self.assertIn("the volume's keys ELOOP", why)

    def test_nothing_running(self):
        self.m.running_slots = lambda: set()
        self.assertTrue(self.m.c_courier_dirs()[0])


class Smoke(unittest.TestCase):
    def test_desk_agent_s_smoke_test_needs_the_courier_reader_where_its_share_is(self):
        smoke = load_file("smoke_courier", LIB / "smoke.py")
        with tempfile.TemporaryDirectory() as t:
            proc = pathlib.Path(t) / "proc"
            for pid, ppid, comm in ((100, 1, "desk-svc"), (101, 100, "java"), (200, 1, "desk-svc"), (300, 1, "desk-svc")):
                (proc / str(pid)).mkdir(parents=True)
                (proc / str(pid) / "stat").write_text(f"{pid} ({comm}) S {ppid} 0 0\n")
            share = pathlib.Path(t) / "s"
            states = {"dh-svc-1-desk-agent": ("running", 100), "dh-svc-1-desk-parse": ("running", 200), f"dh-svc-1-{NAME}": ("running", 300)}
            runc = lambda n: states.get(n, (None, None))   # noqa: E731
            base = os.getuid() - 1113
            socks = []
            for reader in ("desk-parse", NAME):
                (share / f"1/{reader}/sock").mkdir(parents=True)
            s = socket.socket(socket.AF_UNIX)
            s.bind(str(share / "1/desk-parse/sock/parse.sock"))
            socks.append(s)
            self.addCleanup(lambda: [x.close() for x in socks])
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertFalse(ok)
            self.assertIn(f"{NAME} has no socket", why)
            s2 = socket.socket(socket.AF_UNIX)
            s2.bind(str(share / f"1/{NAME}/sock/parse.sock"))
            socks.append(s2)
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertTrue(ok, why)
            states[f"dh-svc-1-{NAME}"] = ("stopped", None)
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertFalse(ok)
            self.assertIn(f"{NAME}'s sandbox", why)
            shutil.rmtree(share / f"1/{NAME}")   # a slot without its share (a host before this): only desk-parse is looked at
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertTrue(ok, why)


class Volume(unittest.TestCase):
    def setUp(self):
        self.m = load_file("mounts_courier", LIB / "mounts.py")
        self.vol = {"desk": "dir", "files": "dir", "courier": "dir", "keys": "dir", "agent": "dir", "notebook": "dir", "rtc": "dir"}
        self.n = [100]

        def openat2(root, path, flags, resolve=self.m.RESOLVE):
            assert resolve == self.m.RESOLVE
            what = self.vol.get(path, "missing")
            if what == "missing":
                raise OSError(errno.ENOENT, "openat2")
            if what in ("link", "file"):
                raise OSError(errno.ENOTDIR if what == "file" else errno.ELOOP, "openat2")
            self.n[0] += 1
            return self.n[0]

        def sysc(name, *a):
            self.n[0] += 1
            return self.n[0]
        self.m.openat2, self.m.sysc = openat2, sysc
        self.m.os = types.SimpleNamespace(**{k: getattr(os, k) for k in ("O_PATH", "O_DIRECTORY", "O_NOFOLLOW")}, close=lambda fd: None)

    def test_a_blank_volume_gets_them_with_the_desk_s_owner(self):
        self.assertEqual(self.m.DIRS["courier"], (1100, 1100, 0o700))
        self.assertEqual(self.m.DIRS["keys"], (1100, 1100, 0o700))
        self.assertEqual(self.m.SERVICES["deskd"], ("desk", "files", "courier", "keys"))

    def test_deskd_gets_them_and_a_volume_without_them_still_starts_it(self):
        trees, refused, skipped = self.m.clone_dirs(1, self.m.SERVICES, lambda s: True)
        self.assertEqual([s for s, _ in trees["deskd"]], ["desk", "files", "courier", "keys"])
        self.assertEqual((refused, skipped), ([], {}))
        del self.vol["courier"]
        self.vol["keys"] = "link"
        trees, refused, skipped = self.m.clone_dirs(1, self.m.SERVICES, lambda s: True)
        self.assertEqual([s for s, _ in trees["deskd"]], ["desk", "files"])
        self.assertEqual((refused, skipped), ([], {"deskd": {"courier": "ENOENT", "keys": "ELOOP"}}))


class DataDirs(unittest.TestCase):
    """desk-init.py's datadirs() alone, its paths moved under a temporary directory (as test_host_files_slot does)."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        src = (LIB / "desk/desk-init.py").read_text()
        a = src.index("def datadirs():")
        body = src[a:src.index("\ndef ", a + 10)]
        for p in ("/data", "/run/desk-audio", "/var/tmp", "/root"):
            body = body.replace(f'"{p}', f'ROOT + "{p}')
        self.made, self.logged = {}, []
        g = {"os": os, "time": __import__("time"), "ROOT": str(self.tmp), "log": self.logged.append, "run_helper": lambda *a, **kw: None,
             "as_user": lambda *a, **kw: types.SimpleNamespace(returncode=0),
             "mkdir": lambda path, u, g_, mode: (os.makedirs(path, exist_ok=True), self.made.__setitem__(path[len(str(self.tmp)):], (u, g_, mode)))}
        exec(compile(body, "desk-init.py:datadirs", "exec"), g)
        self.datadirs = g["datadirs"]
        (self.tmp / "data").mkdir()

    def test_the_desk_makes_both(self):
        self.datadirs()
        self.assertEqual(self.made["/data/courier"], ("desk", "desk", 0o700))
        self.assertEqual(self.made["/data/keys"], ("desk", "desk", 0o700))

    def test_a_link_at_either_is_replaced_not_followed(self):
        (self.tmp / "data/agent").mkdir()
        (self.tmp / "data/agent/keys").write_text("an agent's")
        os.symlink("agent", self.tmp / "data/courier")
        os.symlink("agent/keys", self.tmp / "data/keys")
        self.datadirs()
        for sub in ("courier", "keys"):
            self.assertFalse((self.tmp / "data" / sub).is_symlink())
            self.assertTrue((self.tmp / "data" / sub).is_dir())
        self.assertEqual((self.tmp / "data/agent/keys").read_text(), "an agent's")


def shell_var(path, name, end):
    """A single-quoted multi-line shell variable of a verify script (NAME='...'), its value."""
    s = path.read_text()
    a = s.index(f"\n{name}='") + len(name) + 3
    return s[a:s.index(end, a) + len(end)]


class VerifyScripts(unittest.TestCase):
    V = HOST / "verify-courier.sh"

    def test_it_is_a_runnable_script(self):
        self.assertTrue(os.access(self.V, os.X_OK))
        self.assertEqual(subprocess.run(["bash", "-n", str(self.V)], capture_output=True).returncode, 0)
        for name, end in (("ASK", 'sys.stdout.write(out.decode("utf-8", "replace"))'), ("EG", "sys.exit(0 if ok else 1)")):
            compile(shell_var(self.V, name, end), f"verify-courier.sh:{name}", "exec")

    def test_its_message_is_the_brief_s(self):
        s = self.V.read_text()
        self.assertIn("printf 'courier1 message\\nFrom: v@example.com\\nSubject: v\\n\\n%s\\n' \"$WORD\"", s)
        self.assertIn("WORD=verify-courier;", s)
        for host, port in (("imap.gmail.com", 993), ("smtp.gmail.com", 465), ("smtp.gmail.com", 587)):
            self.assertIn(f'("{host}", {port})', s)

    def test_its_client_speaks_deskd_s_side_of_the_wire(self):   # against a stand-in desk-svc: the request, a half-close, the whole answer
        ask = shell_var(self.V, "ASK", 'sys.stdout.write(out.decode("utf-8", "replace"))')
        with tempfile.TemporaryDirectory() as t:
            path = os.path.join(t, "parse.sock")
            srv = socket.socket(socket.AF_UNIX)
            srv.bind(path)
            srv.listen(1)
            got = []

            def serve():
                c, _ = srv.accept()
                data = b""
                while True:
                    b = c.recv(65536)
                    if not b:
                        break
                    data += b
                got.append(data)
                c.sendall(b'OK\n{"v":1,"text":"verify-courier"}\n')
                c.close()
            th = threading.Thread(target=serve, daemon=True)
            th.start()
            msg = b"courier1 message\nFrom: v@example.com\nSubject: v\n\nverify-courier\n"
            r = subprocess.run([sys.executable, "-I", "-c", ask, path], input=msg, capture_output=True, timeout=30)
            th.join(5)
            srv.close()
        self.assertEqual(got, [msg], "everything it sent, then EOF (the worker reads to the end before it answers)")
        self.assertEqual(r.stdout.decode().splitlines()[0], "OK")
        self.assertIn("verify-courier", r.stdout.decode())
        r = subprocess.run([sys.executable, "-I", "-c", ask, "/nonexistent/parse.sock"], input=b"x", capture_output=True, timeout=30)
        self.assertEqual(r.returncode, 4)

    def test_its_list_check_matches_courier_trackers_py_s_first_line(self):
        gen = REPO / "services/courier-parse/scripts/courier-trackers.py"
        if not gen.exists():
            self.skipTest("no services/ in this copy")
        pat = re.search(r'grep -qE "(\^# ADR 0076: [^"]*)" <<<"\$first"', self.V.read_text()).group(1)
        with tempfile.TemporaryDirectory() as t:
            z = os.path.join(t, "uBOLite.zip")
            with zipfile.ZipFile(z, "w") as f:
                f.writestr("manifest.json", json.dumps({"version": "2026.1103.1743", "declarative_net_request": {
                    "rule_resources": [{"id": "easyprivacy", "path": "/rulesets/main/easyprivacy.json"}]}}))
                f.writestr("rulesets/main/easyprivacy.json", json.dumps([
                    {"id": 1, "action": {"type": "block"}, "condition": {"urlFilter": "||tracker.example^", "resourceTypes": ["image"]}}]))
            digest = hashlib.sha256(pathlib.Path(z).read_bytes()).hexdigest()
            out = os.path.join(t, "list.txt")
            subprocess.run([sys.executable, "-I", str(gen), z, out], check=True, capture_output=True)
            first = pathlib.Path(out).read_text().split("\n", 1)[0]
        good = pat.replace("$PIN", digest)
        self.assertTrue(re.search(good.replace("\\.", "\\."), first), (good, first))
        self.assertFalse(re.search(pat.replace("$PIN", "0" * 64), first), "another sha256 must fail it")

    def test_section_12_in_both_runs(self):
        for v in ("verify.sh", "verify-port.sh"):
            s = (HOST / v).read_text()
            with self.subTest(v):
                self.assertIn('PIN=$(sed -n \'s/^sha256=//p\' "$HERE/../recipe/adblock/blocker.pin")', s)
                self.assertEqual(s.count('< "$HERE/verify-courier.sh"'), 2)
                for line in ("grep -qx 'COURIER PASS'", "grep -qx 'EGRESS PASS'", "'^MUTATED SOCKET FAIL'", "'^MUTATED MOUNTS FAIL'",
                             "'^MUTATED NETWORK FAIL'", "'^MUTATED IDENTITY FAIL'", "'^MUTATED PARSE FAIL'", "'^MUTATED LIST FAIL'",
                             "grep -qx 'RESTORE PASS' $WORKDIR/c2", "'^MUTATED EGRESS FAIL'", "grep -qx 'EGRESS RESTORE PASS'"):
                    self.assertIn(line, s)
        c = self.V.read_text()
        for line in ('echo "COURIER PASS"', 'echo "EGRESS PASS"', 'echo "MUTATED SOCKET FAIL"', 'echo "MUTATED MOUNTS FAIL"',
                     'echo "MUTATED NETWORK FAIL"', 'echo "MUTATED IDENTITY FAIL"', 'echo "MUTATED PARSE FAIL"', 'echo "MUTATED LIST FAIL"',
                     'echo "MUTATED EGRESS FAIL"', 'echo "RESTORE PASS"', 'echo "EGRESS RESTORE PASS"'):
            self.assertIn(line, c)

    def test_every_check_has_its_mutation_in_both_passes(self):   # section 5 requires mutations == checks: parse had none, so it failed
        m = load_check()
        for v in ("verify.sh", "verify-port.sh"):
            s = (HOST / v).read_text()
            broken = re.findall(r"^m ([a-z-]+) ", s, re.M)
            with self.subTest(v):
                self.assertEqual(sorted(broken), sorted(m.CHECKS), "one m <check> line per desk-host-check check")
                self.assertIn('[ "$n" = "$all" ] || bad=1', s)

    def test_every_resandbox_runs_with_the_host_a_test_host(self):   # desk-host refuses resandbox on a host that isn't one
        dh = (LIB / "desk-host").read_text()
        self.assertIn('[ "$TEST" = 1 ] || die "resandbox: a test host\'s only"', dh)
        for v in ("verify-parse.sh", "verify-courier.sh"):
            s = (HOST / v).read_text()
            with self.subTest(v):
                body = s[s.index("resandbox() {"):]
                body = body[:body.index("\n}\n")]
                self.assertIn("touch /etc/desk-host/test.conf", body)
                self.assertIn("mkdir -p /var/lib/desk-host/test", body)
                self.assertIn("rm -f /etc/desk-host/test.conf", body)
                rest = s.replace(body, "")
                self.assertNotRegex(rest, r"(?m)^[^#]*desk-host resandbox", "every resandbox goes through the function")


if __name__ == "__main__":
    unittest.main(verbosity=1)
