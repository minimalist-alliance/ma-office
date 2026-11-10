#!/usr/bin/python3 -I
"""desk-stream's islands (ADR 0075, desk-runtime.md 8.2 and 8.8) in a real GStreamer: the real desk-stream, the real stream.conf,
its command(), on a socketpair as desk-rtc has it. The capture is a 1920x1080 videotestsrc ball, as in the levels test, whose
harness this reuses: it reads the RTP back, rebuilds the H.264 and reads each SPS.

  python3 -I image/tests/test_desk_stream_islands.py    # about 40 s; the GStreamer half is skipped where there's none

The pure functions (parse_crop, clip_crop, island_size) are checked against CASES, the same table desk-rtc's Go tests use
(internal/xinput/island_test.go), so both sides crop and map input to the same rectangle.
"""
import pathlib
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_desk_stream_levels as L  # noqa: E402

M = L.M if hasattr(getattr(L, "M", None), "parse_crop") else None
HAVE_GST = L.HAVE_GST

# (x, y, w, h) asked for, on a 1920x1080 screen -> what videocrop gets. Copied in desk-rtc/internal/rtcserver/crop_test.go.
CLIP_CASES = [
    ((320, 180, 1280, 720), (320, 180, 1280, 720)),   # inside, even: unchanged
    ((321, 181, 1279, 719), (320, 180, 1280, 720)),   # odd edges go to the even pixel below, and the far edge stays
    ((0, 0, 1920, 1080), (0, 0, 1920, 1080)),
    ((1800, 1000, 640, 360), (1800, 1000, 120, 80)),  # partly off the screen: its part on it
    ((1910, 1070, 64, 64), (1888, 1048, 32, 32)),     # under the least size at the edge: the least size, inside
    ((5000, 5000, 64, 64), (1888, 1048, 32, 32)),     # wholly off: the least size in the corner (deskd's bug, never streamed far off)
    ((100, 100, 33, 33), (100, 100, 32, 32)),
]
# (w, h, out_w, out_h, max_height) -> the island's picture
SIZE_CASES = [
    ((1280, 720, 640, 360, 0), (640, 360)),
    ((1280, 720, 960, 540, 0), (960, 540)),
    ((1280, 720, 640, 480, 0), (640, 360)),     # aspect kept: the narrower fit wins
    ((640, 360, 1280, 720, 0), (640, 360)),     # never up
    ((1280, 720, 1920, 1080, 540), (960, 540)),  # a level or step's lines cap it
    ((1281, 721, 1281, 721, 0), (1280, 720)),   # even
    ((40, 2000, 640, 360, 0), (32, 360)),       # a sliver keeps at least the least size where it has it
]


@unittest.skipUnless(M is not None, "desk-stream won't load here (no python3-gi)")
class Pure(unittest.TestCase):
    def test_1_parse(self):
        self.assertIsNone(M.parse_crop("none"))
        self.assertIsNone(M.parse_crop(" none "))
        self.assertEqual(M.parse_crop("320 180 1280 720 640 360"), (320, 180, 1280, 720, 640, 360))
        for bad in ("", "320 180 1280 720 640", "320 180 1280 720 640 360 1", "-1 0 64 64 64 64", "0 0 31 64 64 64",
                    "0 0 64 64 64 16385", "16384 0 64 64 64 64", "0 0 64 64 64 6x", "0 0 ６４ 64 64 64", "0x10 0 64 64 64 64"):
            with self.assertRaises(ValueError, msg=bad):
                M.parse_crop(bad)

    def test_2_clip(self):
        for asked, got in CLIP_CASES:
            self.assertEqual(M.clip_crop(*asked, 1920, 1080), got, asked)

    def test_3_size(self):
        for args, got in SIZE_CASES:
            self.assertEqual(M.island_size(*args), got, args)


def sps_after(rx, t, timeout=2.0):
    au, n = rx.first(t, lambda a: a["sps"] is not None, timeout)
    return (au["sps"] if au else None), n, au


@unittest.skipUnless(HAVE_GST, "needs GStreamer with x264enc (python3-gi, gstreamer1.0-plugins-ugly)")
class Live(unittest.TestCase):
    def test_1_island_sizes_moves_and_back(self):
        """A crop changes the picture in the running pipeline: one keyframe for a new size, none for a move, the same
        payloader (one SSRC, sequence numbers with no gap) throughout, and the whole screen again on none."""
        d = L.Desk(L.conf("stream.conf", L.BALL))
        rx = d.rx
        t = d.send("resume")
        self.assertEqual(sps_after(rx, t)[0], L.FULL)
        enc = d.stream.encoder
        timings = {}

        def change(cmd, size):
            t = d.send(cmd)
            if cmd.startswith("crop"):  # a crop's first keyframe is already the new size: the encoder isn't reopened ahead of it
                self.assertEqual(sps_after(rx, t)[0], size, cmd)
            au, n = rx.first(t, lambda a: a["idr"] and a["size"] == size)
            self.assertIsNotNone(au, f"{cmd}: no keyframe at {size}")
            self.assertLessEqual(n, 3, f"{cmd}: {n} frames to the new size")
            timings[cmd] = round((au["t1"] - t) * 1000, 1)
            time.sleep(0.5)
            later = rx.window(au["t1"] + 0.001, time.monotonic())
            self.assertGreater(len(later), 20, f"{cmd}: frames stopped")
            self.assertTrue(all(a["size"] == size for a in later), cmd)

        change("crop 320 180 1280 720 640 360", (640, 360))
        change("crop 320 180 1280 720 960 540", (960, 540))
        # A move with the same picture: frames go on with no new SPS or IDR.
        t = d.send("crop 0 0 1280 720 960 540")
        time.sleep(1.0)
        moved = rx.window(t, time.monotonic())
        self.assertGreater(len(moved), 40)
        self.assertFalse(any(a["sps"] or a["idr"] for a in moved), "a move cost a keyframe")
        self.assertEqual(d.stream.crop_el.get_property("left"), 0)
        self.assertEqual(d.stream.crop_el.get_property("right"), 640)
        # Bad lines change nothing.
        for bad in ("crop", "crop 1 2 3", "crop 0 0 10 10 10 10", "crop banana"):
            d.send(bad)
        time.sleep(0.3)
        self.assertEqual(d.stream.crop, (0, 0, 1280, 720, 960, 540))
        change("crop none", L.FULL)
        self.assertEqual([d.stream.crop_el.get_property(k) for k in ("left", "right", "top", "bottom")], [0, 0, 0, 0])
        # With a level that lowers the lines, an island is capped by them too, and none gives the level's own size back.
        change("level low", L.LOW)
        change("crop 0 0 960 1080 960 1080", (640, 720))
        change("crop none", L.LOW)
        self.assertIs(d.stream.encoder, enc, "the encoder was replaced")
        self.assertEqual(len(rx.ssrcs), 1, "the payloader was replaced")
        self.assertEqual(rx.seq_gaps, 0, "RTP sequence numbers jumped")
        print("\ncrop to the new size's keyframe at desk-rtc, ms:", timings)
        d.stop()

    def test_2_warm_island(self):
        """A crop sent while warm is the first picture on resume, and pause and resume keep it."""
        d = L.Desk(L.conf("stream.conf", L.BALL), before=("level high", "crop 320 180 1280 720 640 360"))
        rx = d.rx
        time.sleep(0.3)
        self.assertEqual(rx.aus, [], "frames while warm")
        t = d.send("resume")
        self.assertEqual(sps_after(rx, t)[0], (640, 360))
        d.send("pause")
        time.sleep(0.3)
        n = len(rx.aus)
        time.sleep(0.5)
        self.assertLessEqual(len(rx.aus) - n, 1, "frames while paused")
        d.send("crop 320 180 1280 720 960 540")
        t = d.send("resume")
        self.assertEqual(sps_after(rx, t)[0], (960, 540))
        d.stop()

    def test_3_capped_and_deep_confs_crop_too(self):
        for name in ("stream-capped.conf", "stream-deep.conf"):
            d = L.Desk(L.conf(name, L.BALL))
            t = d.send("resume")
            self.assertEqual(sps_after(d.rx, t)[0], L.FULL, name)
            t = d.send("crop 320 180 1280 720 640 360")
            self.assertEqual(sps_after(d.rx, t)[0], (640, 360), name)
            d.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)
