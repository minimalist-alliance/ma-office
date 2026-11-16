#!/usr/bin/python3 -I
"""ADR 0097, the Agent's attachment reader in a sandbox of its own (desk-parse, uid 1113), without a box, in all three places:
- the desk image: the user, the unit (PartOf desk-agent, its back-off, +500), desk-parse-run's exact docker argv and its refusal of an
  image id that isn't sha256:<64 hex>, the tmpfiles lines, desk-agent's Wants= (not Requires=), the firewall line at the top of the
  output chain, the smoke test's check, desk-svc built by bake.sh and installed by build.sh with its hash, desk-parse-ask against a
  real desk-svc (the Go build of image/host/desk-svc) with a stand-in worker;
- the shared host: wallspec's two shares (and the desk's own container left without them), make_shares' marker, svc-spec's sandbox
  (uid 1113, no capabilities, desk-agent's release root, its own network and IPC, no /data, /tmp or /dev/shm, the flags and limits)
  and desk-agent's read-only /run/desk-parse, desk-host's lists and that desk-parse goes down and up with desk-agent, desk-host-check's
  lists and its parse check, the host's smoke test for desk-agent, the trial's sandbox list;
- self-hosted: the user, the firewall line, desk-svc from the bundle (required, in install.sh and ma-selfhost-bundle).
Each fails on the tree before ADR 0097's build. No root, no network: python3 -I image/tests/test_desk_parse.py
"""
import copy
import importlib.machinery
import importlib.util
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
import time
import unittest

sys.dont_write_bytecode = True
IMAGE = pathlib.Path(__file__).resolve().parent.parent
REPO = IMAGE.parent
F = IMAGE / "recipe/files"
UNITS = F / "etc/systemd/system"
MA = F / "usr/local/lib/ma"
HOSTLIB = IMAGE / "host/recipe/files/usr/local/lib/desk-host"
SELF = REPO / "selfhost"
GO = shutil.which("go") or str(pathlib.Path.home() / ".local/go/bin/go")


def props(path):
    out = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.startswith(("#", "[")):
            k, v = line.split("=", 1)
            out.setdefault(k, []).append(v)
    return out


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class DeskImage(unittest.TestCase):
    def test_the_user_is_1113_in_the_image_and_on_a_self_hosted_desk(self):
        for f in (IMAGE / "recipe/build.sh", SELF / "install.sh"):
            loop = [l for l in f.read_text().splitlines() if l.startswith("for spec in desk:1100")]
            self.assertEqual(len(loop), 1, f)
            self.assertIn(" parse:1113;", loop[0], f)
            self.assertNotRegex(loop[0], r":1113.*:1113", f)

    def test_tmpfiles_lines(self):
        lines = [l for l in (F / "etc/tmpfiles.d/desk-parse.conf").read_text().splitlines() if l and not l.startswith("#")]
        self.assertEqual(lines, ["d /run/desk-parse 0750 root agent -", "f /run/desk-parse/required 0444 root root - 1",
                                 "d /run/desk-parse/sock 2750 parse agent -"])

    def test_the_unit(self):
        text = (UNITS / "desk-parse.service").read_text()
        p = props(UNITS / "desk-parse.service")
        self.assertEqual(p["PartOf"], ["desk-agent.service"])
        self.assertEqual(p["ConditionPathExists"], ["/opt/ma/desk-agent/current/image-id"])
        self.assertEqual(p["Requires"], ["docker.service"])
        self.assertEqual(p["Environment"], ["RELEASE_DIR=/opt/ma/desk-agent/current"])
        self.assertEqual(p["ExecStart"], ["/usr/local/lib/ma/desk-parse-run"])
        self.assertIn("-/usr/bin/docker rm -f desk-parse", p["ExecStartPre"])
        self.assertEqual(p["ExecStop"], ["/usr/bin/docker stop -t 5 desk-parse"])
        self.assertEqual((p["Restart"], p["RestartSteps"], p["RestartMaxDelaySec"], p["StartLimitIntervalSec"], p["OOMScoreAdjust"]),
                         (["always"], ["8"], ["300"], ["0"], ["500"]))
        self.assertNotIn("[Install]", text, "desk-agent pulls it in; it isn't enabled on its own")

    def test_desk_agent_wants_it_and_doesnt_require_it(self):
        p = props(UNITS / "desk-agent.service")
        self.assertIn("desk-parse.service", p.get("Wants", []))
        self.assertNotIn("desk-parse.service", " ".join(p.get("Requires", []) + p.get("After", [])))

    def run_script(self, image_id):
        with tempfile.TemporaryDirectory() as t:
            rel = pathlib.Path(t) / "rel"; rel.mkdir()
            (rel / "image-id").write_text(image_id)
            fake = pathlib.Path(t) / "docker"
            fake.write_text(f"#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > {t}/argv\n")
            fake.chmod(0o755)
            script = pathlib.Path(t) / "run"
            script.write_text((MA / "desk-parse-run").read_text().replace("/usr/bin/docker", str(fake)))
            r = subprocess.run(["sh", str(script)], env={"RELEASE_DIR": str(rel), "PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
            argv = (pathlib.Path(t) / "argv").read_text().splitlines() if (pathlib.Path(t) / "argv").exists() else None
            return r.returncode, argv

    def test_run_is_adr_0097s_command_on_desk_agents_image(self):
        iid = "sha256:" + "ab" * 32
        rc, argv = self.run_script(iid + "\n")
        self.assertEqual(rc, 0)
        self.assertEqual(argv, ["run", "--rm", "--name", "desk-parse", "--network", "none", "--ipc", "none", "--user", "1113:1113", "--read-only",
                                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-driver", "journald", "--log-opt", "tag=desk-parse",
                                "--memory", "160m", "--memory-swap", "160m", "--pids-limit", "64", "--cpu-shares", "256", "--ulimit", "core=0",
                                "--oom-score-adj", "500", "-v", "/run/desk-parse/sock:/run/desk-parse/sock", "-v", "/usr/local/lib/ma/desk-svc:/desk-svc:ro",
                                "--entrypoint", "/desk-svc", iid,
                                "-accept", "/run/desk-parse/sock/parse.sock", "-accept-mode", "0660", "-peer-uid", "1103", "-max-conn", "1",
                                "-deadline-sec", "35", "-conn-stdio", "-clean", "--", "/opt/java/openjdk/bin/java", "@/app/parse.options"])

    def test_run_refuses_an_image_id_that_isnt_one(self):
        for bad in ("", "sha256:" + "ab" * 31 + "a", "sha256:" + "AB" * 32, "ma/desk-agent:latest", "sha256:" + "ab" * 32 + "0",
                    "sha256:" + "ab" * 31 + "a;", "--privileged"):
            rc, argv = self.run_script(bad)
            self.assertNotEqual(rc, 0, bad)
            self.assertIsNone(argv, f"docker ran for {bad!r}")

    def test_the_firewall_refuses_uid_1113_first(self):
        for f in (F / "etc/nftables.conf", SELF / "files/etc/nftables.conf"):
            chain = f.read_text().split("  chain output {", 1)[1]
            rules = [l.strip() for l in chain.splitlines() if l.strip() and not l.strip().startswith(("#", "type "))]
            self.assertEqual(rules[0], "meta skuid 1113 reject", f)

    def test_the_smoke_test_parses_as_uid_1103_where_the_marker_is(self):
        s = (F / "opt/ma/smoke-test").read_text()
        self.assertIn("[ -e /run/desk-parse/required ]", s)
        self.assertIn("setpriv --reuid 1103 --regid 1103 --clear-groups --no-new-privs /usr/local/lib/ma/desk-parse-ask text 1000 1", s)
        self.assertIn('[ "$way" != sidecar ]', s)

    def test_desk_svc_is_built_by_the_bake_and_installed_by_its_hash(self):
        b = (IMAGE / "bake.sh").read_text()
        self.assertIn('GOARCH=arm64 "$GO" build -trimpath', b)
        self.assertIn('"$STAGE/desk-svc/desk-svc"', b)
        self.assertIn('"$GO" test -count=1', b)
        h = (IMAGE / "host/bake.sh").read_text()
        self.assertIn('"$STAGE/ma-recipe/desk-svc/"', h, "the host bake runs the desk recipe too")
        r = (IMAGE / "recipe/build.sh").read_text()
        self.assertIn('install -o root -g root -m 0755 "$HERE/desk-svc/desk-svc" /usr/local/lib/ma/desk-svc', r)
        self.assertIn("desk-svc isn't the binary bake.sh built", r)

    def test_restart_reset_and_verify_restart_know_it(self):
        self.assertIn('"desk-parse"', (MA / "desk-restart-reset").read_text())
        self.assertIn("desk-parse:500:300", (IMAGE / "verify-restart.sh").read_text())


class Courier(unittest.TestCase):
    """Courier's mail reader for deskd (desk-parse-courier, docs/sub-status/mm-courier-parse.md "The image change"), the desk image's
    and self-hosted half: the unit, desk-parse-courier-run's argv with and without the tracker list, the tmpfiles lines, deskd's and
    desk-agent's Wants=, /data/courier and /data/keys in desk-datadirs, the tracker list built at bake from blocker.pin's release with
    bake.sh's copy of courier-trackers.py, desk-data as tools/desk-data, the checks, and install.sh's lines."""
    def test_the_unit(self):
        text = (UNITS / "desk-parse-courier.service").read_text()
        p = props(UNITS / "desk-parse-courier.service")
        self.assertEqual(p["PartOf"], ["desk-agent.service"])
        self.assertEqual(p["ConditionPathExists"], ["/opt/ma/desk-agent/current/image-id"])
        self.assertEqual(p["Requires"], ["docker.service"])
        self.assertEqual(p["Environment"], ["RELEASE_DIR=/opt/ma/desk-agent/current"])
        self.assertEqual(p["ExecStart"], ["/usr/local/lib/ma/desk-parse-courier-run"])
        self.assertIn("-/usr/bin/docker rm -f desk-parse-courier", p["ExecStartPre"])
        self.assertEqual(p["ExecStop"], ["/usr/bin/docker stop -t 5 desk-parse-courier"])
        self.assertEqual((p["Restart"], p["RestartSteps"], p["RestartMaxDelaySec"], p["StartLimitIntervalSec"], p["OOMScoreAdjust"]),
                         (["always"], ["8"], ["300"], ["0"], ["500"]))
        self.assertNotIn("[Install]", text)

    def test_deskd_and_desk_agent_want_it_and_neither_requires_it(self):
        for u in ("deskd", "desk-agent"):
            p = props(UNITS / f"{u}.service")
            self.assertIn("desk-parse-courier.service", p.get("Wants", []), u)
            self.assertNotIn("desk-parse-courier.service", " ".join(p.get("Requires", []) + p.get("After", [])), u)

    def test_tmpfiles_lines(self):
        lines = [l for l in (F / "etc/tmpfiles.d/desk-parse-courier.conf").read_text().splitlines() if l and not l.startswith("#")]
        self.assertEqual(lines, ["d /run/desk-parse-courier 0750 root desk -", "d /run/desk-parse-courier/sock 2750 parse desk -"])

    def run_script(self, image_id, with_list):
        with tempfile.TemporaryDirectory() as t:
            rel = pathlib.Path(t) / "rel"; rel.mkdir()
            (rel / "image-id").write_text(image_id)
            lst = pathlib.Path(t) / "trackers.txt"
            if with_list:
                lst.write_text("# list\nexample.com\n")
            fake = pathlib.Path(t) / "docker"
            fake.write_text(f"#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > {t}/argv\n")
            fake.chmod(0o755)
            script = pathlib.Path(t) / "run"
            src = (MA / "desk-parse-courier-run").read_text()
            self.assertEqual(src.count("LIST=/usr/share/ma/adblock/courier-trackers.txt"), 1)
            script.write_text(src.replace("/usr/bin/docker", str(fake)).replace("LIST=/usr/share/ma/adblock/courier-trackers.txt", f"LIST={lst}"))
            r = subprocess.run(["sh", str(script)], env={"RELEASE_DIR": str(rel), "PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
            argv = (pathlib.Path(t) / "argv").read_text().splitlines() if (pathlib.Path(t) / "argv").exists() else None
            return r.returncode, argv, str(lst)

    def test_run_is_desk_parses_command_for_deskd(self):
        iid = "sha256:" + "cd" * 32
        head = ["run", "--rm", "--name", "desk-parse-courier", "--network", "none", "--ipc", "none", "--user", "1113:1113", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-driver", "journald", "--log-opt", "tag=desk-parse-courier",
                "--memory", "160m", "--memory-swap", "160m", "--pids-limit", "64", "--cpu-shares", "256", "--ulimit", "core=0",
                "--oom-score-adj", "500", "-v", "/run/desk-parse-courier/sock:/run/desk-parse-courier/sock",
                "-v", "/usr/local/lib/ma/desk-svc:/desk-svc:ro"]
        tail = ["--entrypoint", "/desk-svc", iid,
                "-accept", "/run/desk-parse-courier/sock/parse.sock", "-accept-mode", "0660", "-peer-uid", "1100", "-max-conn", "1",
                "-deadline-sec", "15", "-conn-stdio", "-clean", "--", "/opt/java/openjdk/bin/java", "@/app/courier-parse.options"]
        rc, argv, lst = self.run_script(iid + "\n", True)
        self.assertEqual(rc, 0)
        self.assertEqual(argv, head + ["-v", f"{lst}:/app/courier/trackers.txt:ro"] + tail)
        rc, argv, _ = self.run_script(iid, False)
        self.assertEqual(rc, 0)
        self.assertEqual(argv, head + tail, "no list: the image's empty placeholder stays")

    def test_run_refuses_an_image_id_that_isnt_one(self):
        for bad in ("", "sha256:" + "ab" * 31 + "a", "sha256:" + "AB" * 32, "ma/desk-agent:latest", "sha256:" + "ab" * 32 + "0", "--privileged"):
            rc, argv, _ = self.run_script(bad, True)
            self.assertNotEqual(rc, 0, bad)
            self.assertIsNone(argv, f"docker ran for {bad!r}")

    def test_datadirs_make_courier_and_keys_for_deskd(self):
        d = (MA / "desk-datadirs").read_text()
        self.assertIn("\nmk /data/courier desk   desk   0700\n", d)
        self.assertIn("\nmk /data/keys    desk   desk   0700\n", d)

    def test_the_tracker_list_is_built_at_bake_from_the_pinned_release(self):
        b = (IMAGE / "recipe/build.sh").read_text()
        self.assertIn('python3 -I "$HERE/adblock/build-blocker.py" build /usr/share/ma/adblock --zip "$BLOCKER_ZIP"', b)
        self.assertIn('python3 -I "$HERE/adblock/courier-trackers.py" "$BLOCKER_ZIP" /usr/share/ma/adblock/courier-trackers.txt', b)
        self.assertIn('echo "$BLOCKER_SHA  $BLOCKER_ZIP" | sha256sum -c --status', b)
        self.assertLess(b.index("courier-trackers.txt || die"), b.index("chmod 0644 /usr/share/ma/adblock/*"))
        self.assertEqual((IMAGE / "recipe/adblock/courier-trackers.py").read_bytes(),
                         (REPO / "services/courier-parse/scripts/courier-trackers.py").read_bytes(), "bake.sh refuses a copy that differs")
        self.assertIn('"$REPO/services/courier-parse/scripts/courier-trackers.py" "$HERE/recipe/adblock/courier-trackers.py"', (IMAGE / "bake.sh").read_text())
        i = (SELF / "install.sh").read_text()
        self.assertIn('python3 -I "$RECIPE/adblock/courier-trackers.py" "$BLOCKER_ZIP" /usr/share/ma/adblock/courier-trackers.txt', i)

    def test_courier_trackers_on_a_small_release(self):
        mod = load(IMAGE / "recipe/adblock/courier-trackers.py", "courier_trackers")
        import zipfile
        with tempfile.TemporaryDirectory() as t:
            z = pathlib.Path(t) / "r.zip"
            rules = [{"action": {"type": "block"}, "condition": {"requestDomains": ["Track.Example.com"]}},
                     {"action": {"type": "block"}, "condition": {"urlFilter": "||pixel.example.net^", "resourceTypes": ["image"]}},
                     {"action": {"type": "block"}, "condition": {"urlFilter": "||ads.example.org/p/", "resourceTypes": ["ping"]}},
                     {"action": {"type": "allow"}, "condition": {"requestDomains": ["ok.example.com"]}},
                     {"action": {"type": "block"}, "condition": {"requestDomains": ["css.example.com"], "resourceTypes": ["stylesheet"]}}]
            with zipfile.ZipFile(z, "w") as f:
                f.writestr("manifest.json", json.dumps({"version": "1.2.3", "declarative_net_request": {"rule_resources": [
                    {"id": "easyprivacy", "path": "/rulesets/ep.json"}, {"id": "easylist", "path": "/rulesets/el.json"}]}}))
                f.writestr("rulesets/ep.json", json.dumps(rules))
                f.writestr("rulesets/el.json", json.dumps([{"action": {"type": "block"}, "condition": {"requestDomains": ["el.example.com"]}}]))
            out = pathlib.Path(t) / "out.txt"
            mod.main(str(z), str(out))
            lines = out.read_text().splitlines()
            import hashlib
            self.assertRegex(lines[0], r"^# ADR 0076: uBlock Origin Lite 1\.2\.3, sha256 " + hashlib.sha256(z.read_bytes()).hexdigest() + "; easyprivacy: ")
            self.assertEqual(lines[1:], ["ads.example.org/p/", "pixel.example.net", "track.example.com"])

    def test_desk_data_is_tools_desk_data(self):
        self.assertEqual((MA / "desk-data").read_bytes(), (REPO / "tools/desk-data/desk-data").read_bytes())
        self.assertIn('return comps[0] == "keys"', (MA / "desk-data").read_text())

    def test_restart_reset_verify_restart_and_build_know_it(self):
        self.assertIn('"desk-parse-courier"', (MA / "desk-restart-reset").read_text())
        self.assertIn("desk-parse-courier:500:300", (IMAGE / "verify-restart.sh").read_text())
        b = (IMAGE / "recipe/build.sh").read_text()
        self.assertIn("/usr/local/lib/ma/desk-parse-courier-run", b.split('step "service configuration"')[0])
        self.assertIn("chk grep -qx 'Wants=desk-parse-courier.service' /etc/systemd/system/deskd.service", b)

    def test_verify_runs_every_part_with_the_pin(self):
        v = (IMAGE / "verify.sh").read_text()
        self.assertIn("for p in static wall socket parse list follow dirs egress mutations; do", v)
        self.assertIn('R "sudo bash -s -- $p $BLOCKER_SHA" < "$HERE/verify-courier.sh"', v)
        c = (IMAGE / "verify-courier.sh").read_text()
        for part in ("static)", "wall)", "socket)", "parse)", "list)", "follow)", "dirs)", "egress)", "mutations)"):
            self.assertIn("\n" + part + "\n", c, part)
        r = subprocess.run(["bash", "-n", str(IMAGE / "verify-courier.sh")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_self_hosted_installs_it(self):
        i = (SELF / "install.sh").read_text()
        self.assertIn("/usr/local/lib/ma/desk-parse-courier-run", i)
        self.assertIn("systemd-tmpfiles --create /etc/tmpfiles.d/desk-parse-courier.conf", i)
        self.assertIn("systemctl restart desk-parse-courier.service", i)


@unittest.skipUnless(os.path.exists(GO), "no Go")
class Ask(unittest.TestCase):
    """desk-parse-ask against the real desk-svc (this tree's Go build), its worker a shell stand-in: the request as desk-agent sends
    it, and each exit."""
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.bin = os.path.join(cls.tmp, "desk-svc")
        subprocess.run([GO, "build", "-o", cls.bin, "."], cwd=IMAGE / "host/desk-svc", check=True, env={**os.environ, "CGO_ENABLED": "0"},
                       capture_output=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def serve(self, worker, peer=None):
        d = tempfile.mkdtemp(dir=self.tmp)
        sock = os.path.join(d, "p.sock")
        p = subprocess.Popen([self.bin, "-accept", sock, "-peer-uid", str(os.getuid() if peer is None else peer), "-max-conn", "1",
                              "-conn-stdio", "-deadline-sec", "5", "--", "/bin/sh", "-c", worker], stderr=subprocess.DEVNULL)
        self.addCleanup(p.kill)
        for _ in range(100):
            if os.path.exists(sock):
                break
            time.sleep(0.05)
        return sock

    def ask(self, sock, data=b"the bytes\n", kind="text"):
        r = subprocess.run([sys.executable, "-I", str(MA / "desk-parse-ask"), kind, "1000", "1", sock], input=data, capture_output=True, timeout=30)
        return r.returncode, r.stdout

    def test_the_request_and_an_answer(self):
        sock = self.serve('read -r h; case "$h" in "parse1 text 1000 1") echo OK; cat ;; *) echo "ERR bad_request" ;; esac')
        self.assertEqual(self.ask(sock), (0, b"OK\nthe bytes\n"))

    def test_err_lines_and_failures(self):
        self.assertEqual(self.ask(self.serve('read -r h; echo "ERR encrypted"')), (0, b"ERR encrypted\n"))
        self.assertEqual(self.ask(self.serve("echo OK", peer=os.getuid() + 4242)), (3, b"err denied\n"))
        self.assertEqual(self.ask(self.serve("exit 0")), (5, b""))
        self.assertEqual(self.ask(os.path.join(self.tmp, "nothing.sock"))[0], 4)
        self.assertEqual(subprocess.run([sys.executable, "-I", str(MA / "desk-parse-ask"), "exe", "1", "1"], capture_output=True).returncode, 2)


DOCKER = {"process": {}, "hooks": {}, "annotations": {}, "root": {},
          "mounts": [{"destination": d, "type": "x", "source": "x", "options": []} for d in ("/proc", "/dev", "/dev/pts", "/sys", "/dev/mqueue")],
          "linux": {"seccomp": {"syscalls": [], "architectures": []}, "maskedPaths": [], "resources": {"devices": []},
                    "uidMappings": [], "gidMappings": [], "sysctl": {}}}


class Host(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        t = pathlib.Path(self.tmp) / "templates/g1/etc"
        t.mkdir(parents=True)
        (t.parent / ".complete").write_text("gen=g1\n")
        (pathlib.Path(self.tmp) / "slots").mkdir()
        (pathlib.Path(self.tmp) / "slots/1.json").write_text('{"slot": 1, "state": "desk", "template": "g1"}')
        os.environ["DESK_HOST_RECORDS"] = str(pathlib.Path(self.tmp) / "slots")
        users = {"desk": 1100, "rtc": 1101, "kiosk": 1102, "agent": 1103, "stream": 1104, "notebook": 1105, "desk-snd": 1108, "desk-x": 1107,
                 "desk-dns": 1109, "desk-data": 1112, "parse": 1113}
        (t / "passwd").write_text("".join(f"{n}:x:{u}:{u}::/:/bin/false\n" for n, u in users.items()))
        (t / "group").write_text("".join(f"{n}:x:{u}:\n" for n, u in {**users, "desk-audio": 1111}.items()))
        sys.path.insert(0, str(HOSTLIB))
        for m in ("wallspec", "svc_spec"):
            sys.modules.pop(m, None)
        import wallspec
        wallspec.DH = self.tmp
        wallspec.docker_spec = lambda: copy.deepcopy(DOCKER)
        self.wallspec = wallspec
        self.mod = load(HOSTLIB / "svc-spec.py", "svc_spec")

    def test_shares_in_order_and_kept_from_the_desks_own_container(self):
        sh = self.wallspec.shares(1)
        names = list(sh)
        self.assertLess(names.index("desk-parse"), names.index("desk-parse/sock"))
        self.assertEqual(sh["desk-parse"], ("/run/desk-parse", 0, "agent", 0o750))
        self.assertEqual(sh["desk-parse/sock"], ("/run/desk-parse/sock", "parse", "agent", 0o2750))
        self.assertEqual(self.wallspec.SANDBOX_ONLY, ("desk-parse", "desk-parse/sock", "desk-parse-courier", "desk-parse-courier/sock"))
        self.assertIn("if name in wallspec.SANDBOX_ONLY:", (HOSTLIB / "desk-spec.py").read_text())

    def test_make_shares_writes_the_marker_root_owned_0444(self):
        d = tempfile.mkdtemp(dir=self.tmp)
        chowns, fchowns = [], []
        self.mod.os.chown = lambda p, u, g: chowns.append((os.path.relpath(p, d), u, g))
        real_fchown = self.mod.os.fchown
        self.mod.os.fchown = lambda fd, u, g: fchowns.append((u, g))
        try:
            self.mod.make_shares(1, d)
        finally:
            self.mod.os.chown = os.chown
            self.mod.os.fchown = real_fchown
        base = 100000 + 65536
        self.assertIn(("desk-parse", base, base + 1103), chowns)
        self.assertIn(("desk-parse/sock", base + 1113, base + 1103), chowns)
        m = os.path.join(d, "desk-parse/required")
        self.assertEqual(open(m).read(), "1")
        self.assertEqual(stat.S_IMODE(os.lstat(m).st_mode), 0o444)
        self.assertEqual(fchowns, [(base, base)])
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(d, "desk-parse/sock")).st_mode), 0o2750)
        self.assertEqual(os.listdir(os.path.join(d, "desk-parse/sock")), [])

    def test_the_sandbox(self):
        sp = self.mod.spec(1, "desk-parse")
        p = sp["process"]
        self.assertEqual(p["user"], {"uid": 1113, "gid": 1113})
        self.assertEqual({k: v for k, v in p["capabilities"].items() if v}, {})
        self.assertTrue(p["noNewPrivileges"])
        self.assertEqual(p["oomScoreAdj"], 500)
        self.assertEqual(p["apparmorProfile"], "desk-host-1")
        self.assertEqual(p["args"], ["/desk-host/desk-svc", "-accept", "/run/desk-parse/sock/parse.sock", "-accept-mode", "0660", "-peer-uid", "1103",
                                     "-max-conn", "1", "-deadline-sec", "35", "-conn-stdio", "-clean", "--", "/opt/java/openjdk/bin/java", "@/app/parse.options"])
        self.assertEqual(sp["root"], {"path": f"{self.tmp}/slots/1/rel/desk-agent/rootfs", "readonly": True})
        ns = {n["type"]: n for n in sp["linux"]["namespaces"]}
        self.assertNotIn("path", ns["network"])
        self.assertNotIn("path", ns["ipc"])
        self.assertEqual(ns["user"]["path"], "/run/desk-host/ns/1/user")
        self.assertEqual(sp["linux"]["resources"]["unified"], {"memory.max": str(160 << 20), "memory.swap.max": "0", "pids.max": "64", "cpu.weight": "10"})
        dests = {m["destination"]: m for m in sp["mounts"]}
        for gone in ("/data", "/tmp", "/dev/shm", "/run/desk-agent", "/run/desk", "/run/desk-parse"):
            self.assertNotIn(gone, dests)
        self.assertFalse([d for d in dests if d.startswith("/data")])
        self.assertEqual(dests["/run/desk-parse/sock"]["source"], "/run/desk-host/share/1/desk-parse/sock")
        self.assertIn("rw", dests["/run/desk-parse/sock"]["options"])
        self.assertIn("mode=755", dests["/run"]["options"])
        self.assertNotIn("mode=1777", " ".join(o for m in sp["mounts"] for o in m["options"]))
        self.assertIn("ro", dests["/desk-host"]["options"])

    def test_desk_agent_has_desk_parse_read_only_and_the_others_unchanged(self):
        dests = {m["destination"]: m for m in self.mod.spec(1, "desk-agent")["mounts"]}
        self.assertEqual(dests["/run/desk-parse"]["source"], "/run/desk-host/share/1/desk-parse")
        self.assertIn("ro", dests["/run/desk-parse"]["options"])
        for name in ("deskd", "desk-notebook", "desk-rtc", "desk-stream", "desk-data"):
            d = [m["destination"] for m in self.mod.spec(1, name)["mounts"]]
            self.assertFalse([x for x in d if x == "/run/desk-parse" or x.startswith("/run/desk-parse/")], name)
            self.assertIn("/tmp", d, name)

    def test_desk_host_runs_it_and_takes_it_down_and_up_with_desk_agent(self):
        src = (HOSTLIB / "desk-host").read_text()
        svcs = re.search(r'^SVCS="([^"]*)"', src, re.M).group(1).split()
        self.assertIn("desk-parse", svcs)
        self.assertGreater(svcs.index("desk-parse"), svcs.index("desk-agent"))
        a, b = src.index("svc_down() {"), src.index("svc_down_one() {")
        with tempfile.TemporaryDirectory() as t:
            script = pathlib.Path(t) / "s.sh"
            script.write_text(re.search(r'^AGENT_ROOTED=.*$', src, re.M).group(0) + "\n" +
                              "svc_down_one() { echo \"down $2\"; }\nsvc_up_one() { echo \"up $2\"; }\n" + src[a:b] +
                              "svc_down 1 desk-agent; svc_up 1 desk-agent; svc_down 1 deskd; svc_up 1 deskd\n")
            out = subprocess.run(["bash", str(script)], capture_output=True, text=True).stdout.split("\n")
        self.assertEqual([l for l in out if l], ["down desk-parse", "down desk-parse-courier", "down desk-agent", "up desk-agent",
                                                 "down desk-parse", "up desk-parse", "down desk-parse-courier", "up desk-parse-courier",
                                                 "down deskd", "up deskd"])
        self.assertIn('"desk-parse")]', (HOSTLIB / "templates.py").read_text().replace('"desk-data", "desk-parse")]', '"desk-parse")]'))
        self.assertIn("desk-parse", self.mod.SERVICES)

    def test_host_build_and_check_lists(self):
        b = (IMAGE / "host/recipe/build.sh").read_text()
        self.assertRegex(b, r'DESK_USERS="[^"]* parse"')
        self.assertIn("desk-parse.service", re.search(r'DESK_UNITS="([^"]*)"', b, re.S).group(1))
        c = (HOSTLIB / "desk-host-check").read_text()
        self.assertIn("DESK_UIDS = range(1100, 1114)", c)
        self.assertIn('"desk-parse.service").split()', c)
        self.assertIn('("parse", 1113)', c)
        self.assertRegex(c, r'SVC_ALL = \([^)]*"desk-parse"\)')
        self.assertIn('"desk-parse": 500}', c)
        self.assertIn('"parse": c_parse}', c)

    def test_the_hosts_smoke_test_for_desk_agent_needs_desk_parse(self):
        smoke = load(HOSTLIB / "smoke.py", "smoke")
        with tempfile.TemporaryDirectory() as t:
            proc = pathlib.Path(t) / "proc"
            for pid, ppid, comm in ((100, 1, "desk-svc"), (101, 100, "java"), (200, 1, "desk-svc")):
                (proc / str(pid)).mkdir(parents=True)
                (proc / str(pid) / "stat").write_text(f"{pid} ({comm}) S {ppid} 0 0\n")
            share = pathlib.Path(t) / "s"
            (share / "1/desk-parse/sock").mkdir(parents=True)
            states = {"dh-svc-1-desk-agent": ("running", 100), "dh-svc-1-desk-parse": ("running", 200)}
            runc = lambda n: states.get(n, (None, None))   # noqa: E731
            base = os.getuid() - 1113
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertFalse(ok, "no socket yet")
            self.assertIn("no socket", why)
            s = socket.socket(socket.AF_UNIX)
            s.bind(str(share / "1/desk-parse/sock/parse.sock"))
            self.addCleanup(s.close)
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertTrue(ok, why)
            states["dh-svc-1-desk-parse"] = ("stopped", None)
            ok, why, _ = smoke.probe(1, "desk-agent", 0, base, str(proc), runc, str(share))
            self.assertFalse(ok)
            self.assertIn("desk-parse's sandbox", why)
            ok, why, _ = smoke.probe(1, "desk-notebook", 0, base, str(proc), lambda n: ("running", 100), str(share))
            self.assertTrue(ok, "only desk-agent's test looks at desk-parse")


class SelfHosted(unittest.TestCase):
    def test_desk_svc_is_a_file_of_the_signed_installer_and_is_required(self):
        # From self-hosted bundle 3 (2026.11.12-01f9000) desk-svc is no release line: build-bundle.sh builds it for amd64 from the
        # installer's commit and puts it in files/ before installer.sha256 is made, so the installer's signature covers it.
        i = (SELF / "install.sh").read_text()
        self.assertIn('[ -f "$HERE/files/usr/local/lib/ma/desk-svc" ] || die "this installer carries no desk-svc"', i)
        self.assertIn("chown root:root /usr/local/lib/ma/desk-svc; chmod 0755 /usr/local/lib/ma/desk-svc", i)
        self.assertIn("systemd-tmpfiles --create /etc/tmpfiles.d/desk-parse.conf", i)
        self.assertIn("systemctl restart desk-parse.service", i)
        self.assertNotIn("desk-svc", re.search(r"^for c in desk-rtc [^;]*;", i, re.M).group(0), "not a bundle.pin line any more")
        bb = (SELF / "build-bundle.sh").read_text()
        self.assertIn("DESK_SVC_REL=selfhost/files/usr/local/lib/ma/desk-svc", bb)
        self.assertIn("go test -count=1 ./... && go build -trimpath", bb)


if __name__ == "__main__":
    unittest.main()
