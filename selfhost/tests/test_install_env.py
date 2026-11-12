"""install.sh pairs with prod, the office, unless --env says otherwise (Nov 12). No root, no network:
`python3 -m unittest discover -s selfhost/tests`.

Release 1 (2026.11.11-377c648) defaulted to staging, so a member who followed the guide got a pairing link their account
can't use. Each test here fails on that installer. The settings tests run install.sh's own lines, from its options to its
first step, with its /etc and /data paths moved into a temporary folder and the root-only calls stood in for.
"""
import importlib.machinery
import importlib.util
import os
import re
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SELFHOST = os.path.abspath(os.path.join(HERE, ".."))
INSTALL = os.path.join(SELFHOST, "install.sh")
README = os.path.join(SELFHOST, "README.md")
CLIENT = os.path.join(SELFHOST, "files", "usr", "local", "lib", "ma", "selfhost", "ma-selfhost")
PROD_LINK = "https://platform.minimalistalliance.com/self-hosted?code="


def read(path):
    with open(path) as f:
        return f.read()


class Settings(unittest.TestCase):
    """install.sh's options and an installed desk's saved settings, resolved as install.sh resolves them."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        os.makedirs(os.path.join(self.root, "etc", "ma"))
        os.makedirs(os.path.join(self.root, "data", "selfhost"))
        src = read(INSTALL)
        start, end = src.index("# Empty: not given."), src.index('step "checks"')
        self.part = self.moved(src[start:end])
        # The block that writes /etc/ma/selfhost.conf, so an update reads what this installer wrote.
        m = re.search(r'\{\n  echo "# ma-selfhost \(selfhost/README.md\).*?\n\} > /etc/ma/selfhost.conf\n', src, re.S)
        self.assertIsNotNone(m, "install.sh's selfhost.conf block")
        self.write_block = self.moved(m.group(0))

    def tearDown(self):
        self.tmp.cleanup()

    def moved(self, text):
        for p in ("/etc/ma/", "/etc/nftables.conf", "/data/selfhost/"):
            text = text.replace(p, self.root + p)
        return text

    def run_part(self, *args, mounted=True, write=False):
        shims = (f'HERE={SELFHOST}\ndie() {{ echo "die: $*"; exit 1; }}\n'
                 f'mountpoint() {{ [ {1 if mounted else 0} = 1 ]; }}\n'
                 'id() { return 0; }\nas_selfhost() { "$@"; }\n')
        out = 'printf "%s\\n" "env=$ENV" "chosen=$ENV_CHOSEN" "note=$ENV_NOTE" "address=$ADDRESS" "port=$PORT"\n'
        script = "set -euo pipefail\n" + shims + self.part + (self.write_block if write else "") + out
        r = subprocess.run(["bash", "-c", script, "install.sh", *args], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)

    def saved(self, text):
        with open(os.path.join(self.root, "etc", "ma", "selfhost.conf"), "w") as f:
            f.write(text)

    def paired(self):
        with open(os.path.join(self.root, "data", "selfhost", "desk.json"), "w") as f:
            f.write('{"deskId": "d-test", "env": "staging"}\n')

    # ---- a fresh install

    def test_a_fresh_install_pairs_with_prod(self):
        s = self.run_part("--bundle", "./bundle")
        self.assertEqual((s["env"], s["chosen"], s["note"]), ("prod", "0", ""))
        self.assertEqual((s["address"], s["port"]), ("auto", "4443"))

    def test_env_staging_stays_for_testers(self):
        s = self.run_part("--bundle", "./bundle", "--env", "staging")
        self.assertEqual((s["env"], s["chosen"], s["note"]), ("staging", "1", ""))

    # ---- a desk from release 1: staging by its default, nothing recording whether --env chose it

    def test_release_1s_staging_desk_that_never_paired_moves_to_prod_and_says_so(self):
        self.saved("env=staging\naddress=auto\nkeep_ssh=0\nallow_home_network=0\n")
        s = self.run_part("--bundle", "./bundle")
        self.assertEqual((s["env"], s["chosen"]), ("prod", "0"))
        self.assertIn("hasn't paired yet, so it now pairs with your office (prod)", s["note"])
        self.assertIn("--env staging", s["note"])

    def test_release_1s_staging_desk_that_paired_keeps_staging(self):
        self.saved("env=staging\naddress=auto\nkeep_ssh=0\nallow_home_network=0\n")
        self.paired()
        s = self.run_part("--bundle", "./bundle")
        self.assertEqual((s["env"], s["note"]), ("staging", ""))

    def test_a_staging_desk_whose_data_disk_isnt_mounted_keeps_staging_and_says_why(self):
        self.saved("env=staging\naddress=auto\n")
        s = self.run_part("--bundle", "./bundle", mounted=False)
        self.assertEqual(s["env"], "staging")
        self.assertIn("isn't mounted", s["note"])
        self.assertIn("--env prod", s["note"])

    def test_env_given_wins_over_the_move(self):
        self.saved("env=staging\naddress=auto\n")
        s = self.run_part("--bundle", "./bundle", "--env", "staging")
        self.assertEqual((s["env"], s["chosen"], s["note"]), ("staging", "1", ""))
        s = self.run_part("--bundle", "./bundle", "--env", "prod")
        self.assertEqual((s["env"], s["note"]), ("prod", ""))

    # ---- what this installer saves, read back by the next update

    def test_a_desk_put_on_staging_with_env_keeps_it_through_an_update_before_pairing(self):
        s = self.run_part("--bundle", "./bundle", "--env", "staging", write=True)
        self.assertEqual(s["env"], "staging")
        conf = read(os.path.join(self.root, "etc", "ma", "selfhost.conf"))
        self.assertIn("\nenv=staging\n", conf)
        self.assertIn("\nenv_chosen=1\n", conf)
        s = self.run_part("--bundle", "./bundle")
        self.assertEqual((s["env"], s["chosen"], s["note"]), ("staging", "1", ""))

    def test_a_prod_desk_stays_on_prod(self):
        self.run_part("--bundle", "./bundle", write=True)
        self.assertIn("\nenv_chosen=0\n", read(os.path.join(self.root, "etc", "ma", "selfhost.conf")))
        s = self.run_part("--bundle", "./bundle")
        self.assertEqual((s["env"], s["note"]), ("prod", ""))

    def test_the_other_saved_settings_are_kept_as_before(self):
        self.saved("env=prod\naddress=192.0.2.10\nkeep_ssh=1\nallow_home_network=1\n")
        with open(os.path.join(self.root, "etc", "ma", "desk-rtc.conf"), "w") as f:
            f.write("port=5000\n")
        s = self.run_part("--bundle", "./bundle")
        self.assertEqual((s["env"], s["address"], s["port"]), ("prod", "192.0.2.10", "5000"))


class Wiring(unittest.TestCase):
    def setUp(self):
        self.install = read(INSTALL)

    def test_no_line_says_prod_isnt_open_or_defaults_to_staging(self):
        self.assertNotIn("prod isn't open", self.install)
        self.assertNotIn("ENV=${ENV:-staging}", self.install)
        self.assertNotIn("default staging", self.install)

    def test_whether_the_desk_paired_is_looked_for_as_selfhost(self):
        """EXP-7: /data/selfhost is that user's folder, so root never acts on a name in it."""
        self.assertIn("as_selfhost test -e /data/selfhost/desk.json", self.install)
        self.assertNotRegex(self.install, r"(?m)^[^#]*(?<!as_selfhost )test -e /data/selfhost/")

    def test_the_settings_are_decided_and_said_before_the_first_change(self):
        first_change = self.install.index('step "users')
        self.assertLess(self.install.index('choose_env "$ENV" "$had_env" "$had_env_chosen" "$had_paired"'), first_change)
        self.assertLess(self.install.index('[ -z "$ENV_NOTE" ] || echo "note: $ENV_NOTE"'), first_change)

    def test_help_shows_the_whole_header_and_the_default(self):
        r = subprocess.run(["bash", INSTALL, "--help"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        header = self.install.split("\nset -euo pipefail\n", 1)[0].splitlines()[1:]
        self.assertEqual(r.stdout.splitlines(), header)
        self.assertIn("prod, your office (the default), or staging, our test platform", r.stdout)


class Client(unittest.TestCase):
    def test_ma_selfhost_with_no_env_in_its_conf_pairs_with_prod(self):
        with tempfile.TemporaryDirectory() as t:
            conf = os.path.join(t, "selfhost.conf")
            with open(conf, "w") as f:
                f.write("address=auto\n")
            old = {k: os.environ.get(k) for k in ("MA_SELFHOST_CONF", "MA_SELFHOST_STATE", "MA_SELFHOST_RUN")}
            os.environ.update(MA_SELFHOST_CONF=conf, MA_SELFHOST_STATE=t, MA_SELFHOST_RUN=os.path.join(t, "run"))
            try:
                loader = importlib.machinery.SourceFileLoader("ma_selfhost_env", CLIENT)
                spec = importlib.util.spec_from_loader("ma_selfhost_env", loader)
                m = importlib.util.module_from_spec(spec)
                loader.exec_module(m)
                c = m.load_conf()
            finally:
                for k, v in old.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
        self.assertEqual((c["env"], c["api"]), ("prod", "https://api.minimalistalliance.com"))


class Guide(unittest.TestCase):
    """The member's guide, which the launch FAQ points to."""

    def assertIn(self, member, container, msg=None):  # a short failure, not the whole guide
        self.assertTrue(member in container, msg or f"{member!r} isn't in the guide")

    def assertNotIn(self, member, container, msg=None):
        self.assertFalse(member in container, msg or f"{member!r} is still in the guide")

    def setUp(self):
        self.readme = read(README)
        self.member = self.readme.split("\n## For the team", 1)[0]

    def test_the_code_screen_shows_the_offices_link(self):
        self.assertIn(PROD_LINK + "ABCDEFGH", self.member)
        self.assertNotIn("platform.staging.", self.member)

    def test_it_says_its_available_now(self):
        self.assertNotIn("test platform only", self.readme)

    def test_the_privacy_line_is_the_privacy_pages(self):
        line3 = self.readme.splitlines()[2]
        self.assertIn("what you do on it goes straight between your browser and that computer, so our services don't see "
                      "it in normal operation.", line3)
        self.assertNotIn("never through us", self.readme)

    def test_staging_is_only_a_testers_option(self):
        lines = [ln for ln in self.member.splitlines() if "--env staging" in ln]
        self.assertTrue(lines)
        self.assertTrue(all("tester" in ln for ln in lines), lines)

    def test_release_1_installs_are_told_to_run_the_new_installer_before_pairing(self):
        self.assertIn("2026.11.11-377c648", self.member)
        self.assertIn("--env prod", self.member)


if __name__ == "__main__":
    unittest.main()
