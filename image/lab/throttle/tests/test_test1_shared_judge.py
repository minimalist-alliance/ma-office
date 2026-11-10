#!/usr/bin/python3 -I
"""The judge for ADR 0036 test 1 on a shared host (../test1_shared_judge.py): a good flood row passes, and each way of failing fails."""
import copy
import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location("judge", os.path.join(os.path.dirname(__file__), "..", "test1_shared_judge.py"))
judge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(judge)

VIEWER = {"fps_avg": 59.6, "fps_p5": 58, "b12_p50_ms": 70, "b12_p95_ms": 110, "b13_p95_ms": 66, "rtp_dropped": 0, "tc_drops_1_10": 0, "stream_cpu_pct": 55}
FLOODER = {"bucket_gb": [3.7, 3.8, 3.7], "veth_tx_gb": 11.2, "guard_tx_gb": 11.25, "classes_mbps": {"10": 0, "15": 1.9, "20": 99.8}, "shaper_on": True}
R0 = {"name": "R0", "viewer": VIEWER, "flooders": {}, "host": {"nic_bucket_gb": [0.4]}}
R2 = {"name": "R2", "viewer": VIEWER, "flooders": {"D2": FLOODER}, "host": {"nic_bucket_gb": [4.2]}}


def failed(row):
    return [n for n, ok, _ in judge.judge_row(row, R0, 90.0, 150.0, 120.0) if not ok]


class Judge(unittest.TestCase):
    def test_a_held_flood_with_a_steady_viewer_passes(self):
        self.assertEqual(failed(R2), [])

    def _row(self, **over):
        r = copy.deepcopy(R2)
        for path, v in over.items():
            d = r
            keys = path.split("/")
            for k in keys[:-1]:
                d = d[k]
            d[keys[-1]] = v
        return r

    def test_each_viewer_loss_fails(self):
        self.assertIn("viewer fps within 0.5 of R0", failed(self._row(**{"viewer/fps_avg": 59.0})))
        self.assertIn("viewer fps_p5 at the 30 fps floor", failed(self._row(**{"viewer/fps_p5": 29})))
        self.assertIn("viewer B12 p50 within 3 ms of R0", failed(self._row(**{"viewer/b12_p50_ms": 74})))
        self.assertIn("viewer B13 p95 in budget", failed(self._row(**{"viewer/b13_p95_ms": 130})))
        self.assertIn("viewer rtpDropped 0 and no drops on 1:10", failed(self._row(**{"viewer/rtp_dropped": 1})))
        self.assertIn("viewer stream CPU within 1 point of R0", failed(self._row(**{"viewer/stream_cpu_pct": 57})))

    def test_a_flooder_past_its_ceiling_or_without_a_shaper_fails(self):
        self.assertTrue(any("every bucket" in n for n in failed(self._row(**{"flooders/D2/bucket_gb": [3.7, 7.4]}))))
        self.assertIn("D2 shaper on", failed(self._row(**{"flooders/D2/shaper_on": False})))
        self.assertTrue(any("class 1:20" in n for n in failed(self._row(**{"flooders/D2/classes_mbps": {"10": 0, "15": 2, "20": 140}}))))

    def test_the_guards_count_must_match_the_veth(self):
        self.assertIn("D2 guard count within 5% of the veth", failed(self._row(**{"flooders/D2/guard_tx_gb": 9.0})))

    def test_the_host_nic_bounded_by_the_flooders(self):
        self.assertTrue(any("host NIC" in n for n in failed(self._row(**{"host/nic_bucket_gb": [30.0]}))))


if __name__ == "__main__":
    unittest.main()
