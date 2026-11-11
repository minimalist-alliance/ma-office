"""Unit tests for the template builder's own logic (image/host/template-builder/tb.py): no machine, no root, no AWS.
python3 -m unittest discover -s image/host/template-builder/tests"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "..", "tools", "template"))
import tb  # noqa: E402

E = lambda p, t="file", **kw: dict({"path": p, "type": t, "mode": 0o644, "uid": 0, "gid": 0}, **({"size": 1, "sha256": "a" * 64} if t == "file" else {}), **kw)  # noqa: E731

PLAN_OUT = """Reading package lists...
Building dependency tree...
Calculating upgrade...
The following packages have been kept back:
  libfoo1 libbar2
The following packages will be upgraded:
  chromium chromium-common netbase
3 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.
Inst chromium-common [156.0.8078.79-1~deb13u1] (157.0.1.2-1~deb13u1 Debian-Security:13/trixie-security [arm64])
Inst chromium [156.0.8078.79-1~deb13u1] (157.0.1.2-1~deb13u1 Debian-Security:13/trixie-security [arm64])
Inst netbase [6.5] (6.5+ma1 MA-Template-Test:trixie-security [all])
Inst apt [3.0.3] (3.0.4 Debian-Security:13/stable-security [arm64]) [apt-utils:arm64 ]
Inst vim [2:9.1.1230-2+deb13u1] (2:9.1.1230-2+deb13u2 Debian-Security:13/stable-security [arm64]) []
Conf chromium-common (157.0.1.2-1~deb13u1 Debian-Security:13/trixie-security [arm64])
"""


class PlanTest(unittest.TestCase):
    def test_parse(self):
        plan, kept, other = tb.parse_plan(PLAN_OUT)
        self.assertEqual(plan, [("apt", "3.0.3", "3.0.4"), ("chromium", "156.0.8078.79-1~deb13u1", "157.0.1.2-1~deb13u1"),
                                ("chromium-common", "156.0.8078.79-1~deb13u1", "157.0.1.2-1~deb13u1"), ("netbase", "6.5", "6.5+ma1"),
                                ("vim", "2:9.1.1230-2+deb13u1", "2:9.1.1230-2+deb13u2")])
        self.assertEqual(kept, ["libbar2", "libfoo1"])
        self.assertEqual(other, [])

    def test_new_or_removed_packages_are_reported(self):
        _, _, other = tb.parse_plan("Inst newpkg (1.0 Debian-Security:13/trixie-security [arm64])\nRemv oldpkg [1.0]\n")
        self.assertEqual(len(other), 2)

    def test_empty(self):
        self.assertEqual(tb.parse_plan("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n"), ([], [], []))

    def test_upstream(self):
        self.assertEqual(tb.upstream("1:156.0.8078.79-1~deb13u1"), "156.0.8078.79")
        self.assertEqual(tb.upstream("156.0.8078.79-1"), "156.0.8078.79")


class NothingElseTest(unittest.TestCase):
    def setUp(self):
        self.g1 = [E(".", "dir", mode=0o755), E("etc", "dir", mode=0o755), E("etc/ma", "dir", mode=0o755), E("etc/ma/egress.conf"),
                   E("etc/services"), E("etc/ld.so.cache"), E("usr", "dir", mode=0o755), E("usr/bin", "dir", mode=0o755), E("usr/bin/x"),
                   E("usr/local", "dir", mode=0o755), E("usr/local/lib", "dir", mode=0o755), E("usr/local/lib/ma", "dir", mode=0o755),
                   E("usr/local/lib/ma/gst-registry.bin"), E("var", "dir", mode=0o755), E("var/lib", "dir", mode=0o755),
                   E("var/lib/dpkg", "dir", mode=0o755), E("var/lib/dpkg/status")]

    def changed(self, path, **kw):
        return [dict(e, **kw) if e["path"] == path else e for e in self.g1]

    def test_package_and_dpkg_changes_pass(self):
        new = self.changed("etc/services", sha256="b" * 64)
        new = [dict(e, sha256="c" * 64) if e["path"] in ("var/lib/dpkg/status", "etc/ld.so.cache") else e for e in new]
        probs, rep = tb.nothing_else(self.g1, new, ["etc/services", "etc", "var/lib/dpkg/status", "etc/ld.so.cache", "."], {"etc/services", "etc"})
        self.assertEqual(probs, [])

    def test_a_write_to_etc_ma_fails(self):
        new = self.changed("etc/ma/egress.conf", sha256="b" * 64)
        probs, _ = tb.nothing_else(self.g1, new, ["etc/ma/egress.conf"], {"etc/services"})
        self.assertTrue(any("etc/ma/egress.conf" in p for p in probs), probs)

    def test_a_protected_path_fails_even_if_a_package_owns_it(self):
        new = self.changed("usr/local/lib/ma/gst-registry.bin", sha256="b" * 64)
        probs, _ = tb.nothing_else(self.g1, new, ["usr/local/lib/ma/gst-registry.bin"], {"usr/local/lib/ma/gst-registry.bin"})
        self.assertTrue(probs)
        probs, _ = tb.nothing_else(self.g1, new, ["usr/local/lib/ma/gst-registry.bin"], set(), gst_changed=True)
        self.assertEqual(probs, [], "the registry may change only when GStreamer did")

    def test_an_unowned_new_file_fails(self):
        new = sorted(self.g1 + [E("usr/bin/surprise")], key=lambda e: e["path"].encode())
        probs, _ = tb.nothing_else(self.g1, new, ["usr/bin/surprise", "usr/bin"], {"usr/bin"})
        self.assertTrue(any("added" in p and "usr/bin/surprise" in p for p in probs), probs)

    def test_a_ctime_change_alone_counts(self):
        probs, _ = tb.nothing_else(self.g1, self.g1, ["usr/bin/x"], set())
        self.assertTrue(any("ctime" in p for p in probs), probs)

    def test_conffiles_kept_are_reported_and_fail_under_protected_paths(self):
        new = sorted(self.g1 + [E("etc/services.dpkg-dist")], key=lambda e: e["path"].encode())
        probs, rep = tb.nothing_else(self.g1, new, ["etc/services.dpkg-dist", "etc"], {"etc"})
        self.assertEqual(probs, [])
        self.assertTrue(rep)
        new = sorted(self.g1 + [E("etc/ma/egress.conf.dpkg-dist")], key=lambda e: e["path"].encode())
        probs, _ = tb.nothing_else(self.g1, new, ["etc/ma/egress.conf.dpkg-dist", "etc/ma"], {"etc/ma"})
        self.assertTrue(probs)

    def test_the_seals_setid_clearing_alone_is_no_change(self):
        g1 = [dict(e, mode=0o4755) if e["path"] == "usr/bin/x" else e for e in self.g1]
        new = [dict(e, mode=0o755) if e["path"] == "usr/bin/x" else e for e in self.g1]
        probs, rep = tb.nothing_else(g1, new, ["usr/bin/x"], set(), setid_cleared=["usr/bin/x"])
        self.assertEqual(probs, [])
        probs, _ = tb.nothing_else(g1, new, ["usr/bin/x"], set())
        self.assertTrue(probs, "a ctime moved by anything but the seal still counts")

    def test_deb_systemd_helper_rewrites_only_when_unchanged(self):
        g1 = self.g1 + [E("var/lib/systemd", "dir", mode=0o755), E("var/lib/systemd/deb-systemd-helper-enabled", "dir", mode=0o755),
                        E("var/lib/systemd/deb-systemd-helper-enabled/apt-daily.timer.dsh-also")]
        g1.sort(key=lambda e: e["path"].encode())
        p = ["var/lib/systemd/deb-systemd-helper-enabled", "var/lib/systemd/deb-systemd-helper-enabled/apt-daily.timer.dsh-also"]
        probs, rep = tb.nothing_else(g1, g1, p, set())
        self.assertEqual(probs, [])
        new = [dict(e, sha256="d" * 64) if e["path"].endswith("dsh-also") else e for e in g1]
        probs, _ = tb.nothing_else(g1, new, p, set())
        self.assertTrue(probs)

    def test_allowed_paths(self):
        for p in ("var/lib/dpkg/info/x.list", "etc/alternatives/x", "usr/lib/python3/dist-packages/x/__pycache__/y.pyc",
                  "usr/share/icons/hicolor/icon-theme.cache", "usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache", "var/cache/fontconfig/x",
                  "var/cache/man/de/index.db", "var/cache/ldconfig/aux-cache"):
            self.assertTrue(tb.allowed(p), p)
        for p in ("etc/passwd", "usr/bin/x", "var/lib/systemd/state", "etc/ld.so.conf.d/x.conf"):
            self.assertFalse(tb.allowed(p), p)


class OwnedTest(unittest.TestCase):
    def test_lists_merged_usr_and_diversions(self):
        d = tempfile.mkdtemp()
        try:
            for t in ("g1", "new"):
                os.makedirs(f"{d}/{t}/var/lib/dpkg/info")
                open(f"{d}/{t}/var/lib/dpkg/info/vim-runtime.list", "w").write("/.\n/usr\n/usr/share/vim/vim91/doc/help.txt\n")
                open(f"{d}/{t}/var/lib/dpkg/info/libfoo:arm64.list", "w").write("/lib/aarch64-linux-gnu/libfoo.so.1\n")
                open(f"{d}/{t}/var/lib/dpkg/diversions", "w").write("/usr/share/vim/vim91/doc/help.txt\n/usr/share/vim/vim91/doc/help.txt.vim-tiny\nvim-runtime\n"
                                                                    "/usr/bin/other\n/usr/bin/other.real\nunrelated\n")
            o = tb.owned_paths(f"{d}/g1", f"{d}/new", {"vim-runtime", "libfoo"})
            self.assertIn("usr/share/vim/vim91/doc/help.txt.vim-tiny", o)
            self.assertIn("usr/lib/aarch64-linux-gnu/libfoo.so.1", o)
            self.assertIn(".", o)
            self.assertNotIn("usr/bin/other.real", o)
        finally:
            shutil.rmtree(d)


class UsersTest(unittest.TestCase):
    def test_host_ids_are_compared(self):
        d = tempfile.mkdtemp()
        try:
            for t in ("a", "b"):
                os.makedirs(f"{d}/{t}/etc")
                open(f"{d}/{t}/etc/passwd", "w").write("root:x:0:0::/root:/bin/sh\ndesk-x:x:1107:1107:shared host:/nonexistent:/usr/sbin/nologin\n")
                open(f"{d}/{t}/etc/group", "w").write("desk-audio:x:1111:kiosk,stream\n")
                open(f"{d}/{t}/etc/shadow", "w").write("desk-x:!:20000::::::\n")
            probs, _ = tb.nothing_else([], [], [], set(), g1_tree=f"{d}/a", new_tree=f"{d}/b")
            self.assertEqual(probs, [])
            open(f"{d}/b/etc/group", "w").write("desk-audio:x:1111:kiosk,stream,intruder\n")
            probs, _ = tb.nothing_else([], [], [], set(), g1_tree=f"{d}/a", new_tree=f"{d}/b")
            self.assertTrue(any("group" in p for p in probs), probs)
        finally:
            shutil.rmtree(d)


class TemplateAptTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.keyring = tb.keyring
        tb.keyring = lambda: "/usr/share/keyrings/debian-archive-keyring.gpg"
        self.conf = tb.CONF
        tb.CONF = self.d
        tb.state = lambda: {"source": "security"}
        tb.save_state = lambda s: None

    def tearDown(self):
        tb.keyring = self.keyring
        tb.CONF = self.conf
        shutil.rmtree(self.d)

    def test_clean_passes_and_each_mutation_fails(self):
        tb.write_apt_conf("security")
        ok, d = tb.check_template_apt(conf=self.d, source="security")
        self.assertTrue(ok, d)
        for m in ("stable-line", "no-kernel-pin"):
            tb.write_apt_conf("security", mutate=m)
            ok, d = tb.check_template_apt(conf=self.d, source="security")
            self.assertFalse(ok, m)

    def test_a_test_source_is_only_a_test_builds(self):
        tb.write_apt_conf("test")
        self.assertFalse(tb.check_template_apt(conf=self.d, source="security")[0])


if __name__ == "__main__":
    unittest.main()
