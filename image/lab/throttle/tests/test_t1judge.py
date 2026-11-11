#!/usr/bin/python3 -I
"""The judge for ADR 0036 test 1 on a desk of its own (../real/t1judge.py): a steady row passes, and each way of failing fails."""
import copy
import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location("t1judge", os.path.join(os.path.dirname(__file__), "..", "real", "t1judge.py"))
t1judge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t1judge)

BASE = {"scroll_kiosk_raf": 59.95, "video_kiosk_presented": 59.91, "lat_idle_cb_p50": 40.9, "lat_idle_cb_p95": 53.2, "lat_load_cb_p50": 59.9,
        "lat_load_cb_p95": 74.9, "b13_cb_p50": 41.1, "b13_cb_p95": 44.7, "scroll_stream_cpu": 44.8, "video_stream_cpu": 56.6, "scroll_cpu": 47.8,
        "video_cpu": 53.6, "tc_drops_1_10_all": [None, None, None], "rtp_dropped_all": [{"max": 0, "rows": 44}] * 3}
for k in ("scroll_kiosk_raf", "video_kiosk_presented", "lat_idle_cb_p50", "lat_load_cb_p50"):
    BASE[k + "_all"] = [BASE[k]] * 3
ROW = dict(copy.deepcopy(BASE), tc_drops_1_10_all=[0, 0, 0])


def failed(**over):
    r = copy.deepcopy(ROW)
    r.update(over)
    return [v["rule"] for v in t1judge.judge(r, BASE) if not v["pass"]]


class Judge(unittest.TestCase):
    def test_a_row_like_the_baseline_passes(self):
        self.assertEqual(failed(), [])

    def test_page_fps_half_a_frame_down_fails(self):
        self.assertIn("video page presented fps within 0.5 of no shaper", failed(video_kiosk_presented=59.3))

    def test_b12_more_than_3_ms_later_fails(self):
        self.assertIn("B12 idle p50 within 3 ms of no shaper", failed(lat_idle_cb_p50=44.0))

    def test_b13_over_300_fails(self):
        self.assertIn("B13 warm to live p95 <= 300 ms", failed(b13_cb_p95=301))

    def test_a_drop_on_1_10_or_rtp_fails_and_missing_counts_fail(self):
        self.assertIn("no drop on 1:10", failed(tc_drops_1_10_all=[0, 1, 0]))
        self.assertIn("no drop on 1:10", failed(tc_drops_1_10_all=[]))
        self.assertIn("rtpDropped 0", failed(rtp_dropped_all=[{"max": 2, "rows": 40}]))
        self.assertIn("rtpDropped 0", failed(rtp_dropped_all=[{"max": 0, "rows": 0}]))

    def test_desk_stream_cpu_more_than_a_point_up_fails(self):
        self.assertEqual(failed(video_stream_cpu=57.6), [])
        self.assertIn("desk-stream CPU within 1 point of no shaper, video", failed(video_stream_cpu=59.0))


if __name__ == "__main__":
    unittest.main()
