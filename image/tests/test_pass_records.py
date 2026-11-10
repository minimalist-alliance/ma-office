"""bake.sh's pass records (lib.sh pass_records): passed-test.json for every component, passed-guild.json only for a guild-only one."""
import subprocess, unittest, pathlib
LIB = pathlib.Path(__file__).resolve().parents[1] / "lib.sh"
BAKE = pathlib.Path(__file__).resolve().parents[1] / "bake.sh"

def records(comp):
    out = subprocess.run(["bash", "-c", f'. "{LIB}"; pass_records "$1"', "x", comp], capture_output=True, text=True, check=True)
    return out.stdout.split()

class PassRecords(unittest.TestCase):
    def test_commons_server_takes_either(self):
        self.assertEqual(records("commons-server"), ["passed-test.json", "passed-guild.json"])
    def test_every_other_component_needs_passed_test(self):
        for c in ["deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream", "desk-agent-filter", "commons-server-x", "xcommons-server", ""]:
            self.assertEqual(records(c), ["passed-test.json"], c)
    def test_bake_uses_the_function_and_syntax_ok(self):
        src = BAKE.read_text()
        self.assertIn('pass_records "$comp"', src)
        self.assertNotIn('--key "desk/$comp/$ver/passed-test.json"', src)
        subprocess.run(["bash", "-n", str(BAKE)], check=True)
if __name__ == "__main__":
    unittest.main()
