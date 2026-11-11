#!/usr/bin/python3 -I
"""Bug 8 (the staging soak, 2026-11-10): the shared host's service sandboxes on a release's own root (deskd, desk-agent,
desk-notebook) had the release's empty /etc/resolv.conf, so deskd could not look up the Platform API. svc-spec.py now binds the
desk's resolver (the host-owned template's file) over it, read-only, and widens nothing else. This builds each service's spec
from a fake template and checks that mount. No root, no host. python3 -I image/tests/test_host_svc_resolver.py"""
import copy
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest

IMAGE = pathlib.Path(__file__).resolve().parent.parent
LIB = IMAGE / "host" / "recipe" / "files" / "usr/local/lib/desk-host"
ROOTFS = ("deskd", "desk-agent", "desk-notebook")          # on a release's own root: the empty resolv.conf
TEMPLATE = ("desk-rtc", "desk-stream", "desk-data")        # on the template's root: its own resolv.conf already

DOCKER = {
    "process": {}, "hooks": {}, "annotations": {}, "root": {},
    "mounts": [{"destination": d, "type": "x", "source": "x", "options": []} for d in ("/proc", "/dev", "/dev/pts", "/sys", "/etc/resolv.conf", "/etc/hosts")],
    "linux": {"seccomp": {"syscalls": [], "architectures": []}, "maskedPaths": [], "resources": {"devices": []},
              "uidMappings": [], "gidMappings": [], "sysctl": {}},
}


def load(tmp):
    sys.path.insert(0, str(LIB))
    for m in ("wallspec", "svc_spec"):
        sys.modules.pop(m, None)
    import wallspec
    wallspec.DH = tmp
    wallspec.docker_spec = lambda: copy.deepcopy(DOCKER)
    spec = importlib.util.spec_from_file_location("svc_spec", LIB / "svc-spec.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Resolver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        t = pathlib.Path(self.tmp) / "templates" / "g1" / "etc"   # the slot's own template generation (ADR 0077), as its record names it
        t.mkdir(parents=True)
        (t.parent / ".complete").write_text("gen=g1\n")
        (pathlib.Path(self.tmp) / "slots").mkdir()
        (pathlib.Path(self.tmp) / "slots" / "1.json").write_text('{"slot": 1, "state": "desk", "template": "g1"}')
        os.environ["DESK_HOST_RECORDS"] = str(pathlib.Path(self.tmp) / "slots")
        names = "rtc stream desk-snd desk-x desk-dns desk-data agent notebook deskd".split()
        (t / "passwd").write_text("".join(f"{n}:x:{1100 + i}:{1100 + i}::/:/bin/false\n" for i, n in enumerate(names)))
        (t / "group").write_text("".join(f"{n}:x:{1100 + i}:\n" for i, n in enumerate(names + ["desk", "desk-audio"])))
        self.mod = load(self.tmp)

    def mounts(self, name):
        return self.mod.spec(1, name)["mounts"]

    def test_rootfs_services_get_the_desks_resolver_read_only(self):
        for name in ROOTFS:
            hits = [m for m in self.mounts(name) if m["destination"] == "/etc/resolv.conf"]
            self.assertEqual(len(hits), 1, name)
            m = hits[0]
            self.assertEqual(m["source"], f"{self.tmp}/templates/g1/etc/resolv.conf", name)   # the host-owned template's file
            self.assertEqual(m["type"], "bind")
            self.assertIn("ro", m["options"], name)
            self.assertNotIn("rw", m["options"], name)
            self.assertIn("noexec", m["options"], name)

    def test_template_services_have_it_from_their_root_and_no_second_mount(self):
        for name in TEMPLATE:
            sp = self.mod.spec(1, name)
            self.assertEqual(sp["root"]["path"], f"{self.tmp}/templates/g1", name)
            self.assertEqual([m for m in sp["mounts"] if m["destination"] == "/etc/resolv.conf"], [], name)

    def test_nothing_else_of_etc_is_mounted(self):
        for name in ROOTFS + TEMPLATE:
            etc = [m["destination"] for m in self.mounts(name) if m["destination"].startswith("/etc")]
            self.assertLessEqual(set(etc), {"/etc/resolv.conf"}, name)
            sp = self.mod.spec(1, name)
            self.assertTrue(sp["root"]["readonly"], name)

    def test_no_new_capability_or_namespace(self):
        for name in ROOTFS:
            sp = self.mod.spec(1, name)
            self.assertEqual(sp["process"]["capabilities"]["bounding"], [], name)
            self.assertTrue(sp["process"]["noNewPrivileges"], name)

    def test_the_spec_is_json(self):
        json.dumps(self.mod.spec(1, "deskd"))


if __name__ == "__main__":
    unittest.main()
