#!/usr/bin/python3 -I
"""desk-stream 0.3.0 (ADR 0073): deskcap on a real X server, and the contention control's decisions.

deskcap is built from recipe/desk-stream/src/deskcap.c into a temporary directory, run against an Xvfb of its own, and read
with appsink: a still screen sends only heartbeats, a refresh sends a frame at once, a drawn rectangle arrives in the next
frame and every pixel of that frame matches a whole-screen conversion, an identical redraw sends nothing, motion is held to
max-fps and max-fps changes while playing. The Adapter runs on counters it's handed, with no pipeline.

Needs Debian 13's GStreamer 1.26 and the build packages (as the image's build.sh installs for yuvconv), plus Xvfb:
  apt-get install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly \
    gcc libc6-dev pkg-config libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libyuv-dev libx11-dev libxext-dev \
    libxdamage-dev libxfixes-dev xvfb
  python3 -I image/tests/test_desk_stream_damage.py    # about 30 s; the X tests are skipped where any of that is missing
"""
import configparser
import ctypes
import importlib.machinery
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
RECIPE = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "desk-stream"
TMP = tempfile.mkdtemp(prefix="deskcap-test-")
BUILT = False
if shutil.which("gcc") and shutil.which("pkg-config"):
    cmd = (f"gcc -O2 -Wall -Wextra -Werror -Wno-unused-parameter -shared -fPIC -o {TMP}/libgstdeskcap.so {RECIPE}/src/deskcap.c "
           "$(pkg-config --cflags --libs gstreamer-video-1.0 gstreamer-base-1.0 x11 xext xdamage xfixes) -lyuv")
    BUILT = subprocess.run(cmd, shell=True).returncode == 0
    if BUILT:
        os.environ["GST_PLUGIN_PATH"] = TMP
try:
    loader = importlib.machinery.SourceFileLoader("desk_stream", str(RECIPE / "desk-stream"))
    spec = importlib.util.spec_from_loader("desk_stream", loader)
    M = importlib.util.module_from_spec(spec)
    loader.exec_module(M)
    from gi.repository import Gst
    Gst.init(None)
    HAVE_GST = True
except (ImportError, ValueError):
    HAVE_GST = False
M_LOG = []
if HAVE_GST:
    M.log = lambda *a: M_LOG.append(" ".join(str(x) for x in a))
HAVE_X = BUILT and HAVE_GST and shutil.which("Xvfb") is not None and Gst.ElementFactory.find("deskcap") is not None
W, H = 640, 480


# --- a little Xlib, to draw on the root window -----------------------------------------------------------------------------
class X:
    def __init__(self, display):
        self.lib = ctypes.CDLL("libX11.so.6")
        self.lib.XOpenDisplay.restype = ctypes.c_void_p
        self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.lib.XDefaultRootWindow.restype = ctypes.c_ulong
        self.lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.lib.XCreateGC.restype = ctypes.c_void_p
        self.lib.XCreateGC.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
        self.lib.XSetForeground.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        self.lib.XFillRectangle.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                            ctypes.c_uint, ctypes.c_uint]
        self.lib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.dpy = self.lib.XOpenDisplay(display.encode())
        assert self.dpy, "can't open the test display"
        self.root = self.lib.XDefaultRootWindow(self.dpy)
        self.gc = self.lib.XCreateGC(self.dpy, self.root, 0, None)

    def fill(self, rgb, x, y, w, h):
        self.lib.XSetForeground(self.dpy, self.gc, rgb)
        self.lib.XFillRectangle(self.dpy, self.root, self.gc, x, y, w, h)
        self.lib.XSync(self.dpy, 0)


def bt601(rgb):
    """libyuv's ARGBToNV12: BT.601 limited range, as integers."""
    r, g, b = (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255
    y = (66 * r + 129 * g + 25 * b + 0x1080) >> 8
    u = (112 * b - 74 * g - 38 * r + 0x8080) >> 8
    v = (112 * r - 94 * g - 18 * b + 0x8080) >> 8
    return y, u, v


class Capture:
    """deskcap ! appsink, with every frame's arrival time and bytes."""

    def __init__(self, display, props=""):
        self.frames = []
        self.pipe = Gst.parse_launch(f"deskcap name=src display-name={display} {props} ! appsink name=sink emit-signals=true sync=false")
        self.src = self.pipe.get_by_name("src")
        self.pipe.get_by_name("sink").connect("new-sample", self.on_sample)
        self.pipe.set_state(Gst.State.PLAYING)
        self.pipe.get_state(5 * Gst.SECOND)

    def on_sample(self, sink):
        s = sink.emit("pull-sample")
        b = s.get_buffer()
        ok, m = b.map(Gst.MapFlags.READ)
        self.frames.append((time.monotonic(), bytes(m.data), b.pts))
        b.unmap(m)
        return Gst.FlowReturn.OK

    def wait(self, n, timeout=2.0):
        end = time.monotonic() + timeout
        while len(self.frames) < n and time.monotonic() < end:
            time.sleep(0.005)
        return len(self.frames) >= n

    def stats(self):
        st = self.src.get_property("stats")
        return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


def pixel(frame, x, y):
    yp = frame[y * W + x]
    uv = W * H + (y // 2) * W + (x // 2) * 2
    return yp, frame[uv], frame[uv + 1]


@unittest.skipUnless(HAVE_X, "needs Xvfb, gcc, the GStreamer and X development packages and libyuv")
class Deskcap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.display = ":71"
        # On a desk Xorg runs as kiosk and desk-stream as stream: the X server must be able to attach deskcap's shared memory
        # without it being anyone's. Run as root, the test puts its X server under another user (nobody) to check that.
        user = ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups"] if os.geteuid() == 0 and shutil.which("setpriv") else []
        cls.xvfb = subprocess.Popen(user + ["Xvfb", cls.display, "-screen", "0", f"{W}x{H}x24", "-nolisten", "tcp"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)
        cls.x = X(cls.display)
        cls.x.fill(0x808080, 0, 0, W, H)

    @classmethod
    def tearDownClass(cls):
        cls.xvfb.terminate()
        cls.xvfb.wait(5)

    def test_1_first_frame_then_still(self):
        """A full picture at once, then nothing but heartbeats: at most one every 100 ms, at least one a second."""
        c = Capture(self.display)
        try:
            self.assertTrue(c.wait(1), "no first frame")
            self.assertTrue(all(abs(p - q) <= 2 for p, q in zip(pixel(c.frames[0][1], 10, 10), bt601(0x808080))))
            time.sleep(3.0)
            gaps = [b[0] - a[0] for a, b in zip(c.frames, c.frames[1:])]
            st = c.stats()
            self.assertEqual(st["changed"], 1, st)
            self.assertGreaterEqual(min(gaps), 0.099, gaps)
            self.assertLessEqual(max(gaps), 1.05, gaps)
            self.assertLessEqual(len(c.frames), 1 + 3.0 / 0.1)
            self.assertTrue(all(f[1] == c.frames[0][1] for f in c.frames), "a repeat isn't the same picture")
        finally:
            c.stop()

    def test_1b_shared_memory_is_only_ours_and_the_servers(self):
        """Each segment deskcap makes is 0660, owned by us, in the X server's group (0.2.4's ximagesrc made them 0777)."""
        c = Capture(self.display)
        try:
            c.wait(1)
            mine = [line.split() for line in open("/proc/sysvipc/shm").read().splitlines()[1:]]
            mine = [f for f in mine if int(f[7]) == os.geteuid() and int(f[3]) == W * H * 4]  # uid, size: one screen of BGRx
            self.assertGreaterEqual(len(mine), 2, mine)
            server_gid = os.stat(f"/proc/{self.xvfb.pid}").st_gid
            for f in mine:
                self.assertEqual(int(f[2], 8) & 0o777, 0o660, f)  # perms, in octal
                self.assertEqual(int(f[8]), server_gid, f)  # gid
        finally:
            c.stop()

    def test_2_refresh_sends_at_once(self):
        c = Capture(self.display, "heartbeat-max-ms=2000")
        try:
            c.wait(1)
            time.sleep(2.5)  # past the first heartbeats
            n = len(c.frames)
            t = time.monotonic()
            c.src.emit("refresh")
            self.assertTrue(c.wait(n + 1, 0.5))
            self.assertLess(c.frames[n][0] - t, 0.05, "refresh took over 50 ms")
            self.assertEqual(c.stats()["refreshes"], 1)
        finally:
            c.stop()

    def test_3_partial_update_is_exact(self):
        """Small rectangles arrive in the next frame, and the picture equals a fresh whole-screen conversion."""
        c = Capture(self.display)
        try:
            c.wait(1)
            time.sleep(0.3)
            colours = [(0xff0000, 13, 7, 50, 31), (0x00ff00, 600, 400, 40, 80), (0x2040c0, 301, 201, 3, 3), (0xffffff, 0, 479, 640, 1)]
            for rgb, x, y, w, h in colours:
                n = len(c.frames)
                t = time.monotonic()
                self.x.fill(rgb, x, y, w, h)
                self.assertTrue(c.wait(n + 1, 0.5), "no frame after a draw")
                self.assertLess(c.frames[-1][0] - t, 0.05, "a draw on a still screen took over 50 ms to come out")
                self.assertLessEqual(abs(pixel(c.frames[-1][1], x + w // 2, y + h // 2)[0] - bt601(rgb)[0]), 2)
            time.sleep(0.2)
            fresh = Capture(self.display)
            fresh.wait(1)
            fresh.stop()
            self.assertEqual(c.frames[-1][1], fresh.frames[0][1], "the updated picture differs from a whole-screen conversion")
            self.assertLess(c.stats()["changed-px"], 4 * W * H, "partial updates converted the whole screen")
        finally:
            c.stop()
            self.x.fill(0x808080, 0, 0, W, H)

    def test_4_identical_redraw_sends_nothing(self):
        c = Capture(self.display, "heartbeat-max-ms=0")
        try:
            c.wait(1)
            time.sleep(0.2)
            n, st0 = len(c.frames), c.stats()
            for _ in range(5):
                self.x.fill(0x808080, 0, 0, W, H)
                time.sleep(0.05)
            time.sleep(0.2)
            st1 = c.stats()
            self.assertEqual(len(c.frames), n, "an identical redraw sent a frame")
            self.assertGreaterEqual(st1["unchanged-grabs"] - st0["unchanged-grabs"], 1)
        finally:
            c.stop()

    def test_5_motion_held_to_max_fps_and_changed_live(self):
        c = Capture(self.display)
        try:
            c.wait(1)

            def animate(seconds):
                end, i = time.monotonic() + seconds, 0
                while time.monotonic() < end:
                    self.x.fill(0x010101 * (i % 200), 100, 100, 200, 200)
                    i += 1
                    time.sleep(0.004)  # 250 draws a second
            n = len(c.frames)
            animate(2.0)
            fps60 = (len(c.frames) - n) / 2.0
            c.src.set_property("max-fps", 30)
            time.sleep(0.1)
            n = len(c.frames)
            animate(2.0)
            fps30 = (len(c.frames) - n) / 2.0
            self.assertGreater(fps60, 54)
            self.assertLessEqual(fps60, 62)
            self.assertGreater(fps30, 27)
            self.assertLessEqual(fps30, 31.5)
        finally:
            c.stop()
            self.x.fill(0x808080, 0, 0, W, H)


# --- the contention control ----------------------------------------------------------------------------------------------
class FakeCapture:
    def __init__(self):
        self.props = {"max-fps": 60}

    def set_property(self, k, v):
        self.props[k] = v


class FakeStream:
    def __init__(self, levels=None, level=None):
        self.levels = levels or {}
        self.level = level
        self.screen = (1920, 1080, "1/1")
        self.capture = FakeCapture()
        self.applied = []
        self.adapt = None

    def apply(self):
        self.applied.append(self.adapt.step)
        return {}, "size"


def adapt_conf(order="scale"):
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.read_string(f"[adapt]\nenabled = true\norder = {order}\npressure-high = 40\npressure-low = 15\n")
    return cfg


class Counters:
    """deskcap's and framemeter's counters, advanced one window at a time."""

    def __init__(self):
        self.cap = {"frames": 0, "changed": 0, "late": 0}
        self.meter = {"frames": 0, "latency-sum-us": 0, **{f"le{b}": 0 for b in (2, 4, 6, 8, 10, 12, 14, 16, 20, 25, 33, 50, 100, 0)}}

    def window(self, changed, out=None, late=0, lat_bucket=8):
        self.cap = dict(self.cap, frames=self.cap["frames"] + changed, changed=self.cap["changed"] + changed,
                        late=self.cap["late"] + late)
        out = changed if out is None else out
        self.meter = dict(self.meter, frames=self.meter["frames"] + out)
        self.meter[f"le{lat_bucket}"] += out
        self.meter["latency-sum-us"] += out * lat_bucket * 1000 * 3 // 4  # a mean a little under the bucket's bound
        return dict(self.cap), dict(self.meter)


@unittest.skipUnless(HAVE_GST, "needs python3-gi with GStreamer")
class Adapter(unittest.TestCase):
    def make(self, order="scale", pressure=None):
        s = FakeStream()
        a = M.Adapter(s, adapt_conf(order))
        a.psi = None
        a.pressure = (lambda: None) if pressure is None else pressure
        s.adapt = a
        return s, a

    def run_windows(self, a, c, n, **kw):
        for _ in range(n):
            a.tick(*c.window(**kw))
            a.prev = (a.prev[0], a.prev[1], time.monotonic() - 0.5)  # each window is half a second

    def test_1_steps_down_on_latency_only_after_two_windows(self):
        s, a = self.make()
        c = Counters()
        self.run_windows(a, c, 2, changed=30)
        self.run_windows(a, c, 1, changed=30, lat_bucket=33)
        self.assertEqual(a.step, 0, "one bad window moved it")
        self.run_windows(a, c, 1, changed=30, lat_bucket=33)
        self.assertEqual(a.step, 1)
        self.assertEqual(s.applied, [1])
        self.assertEqual(s.capture.props["max-fps"], 60)

    def test_2_drops_and_lateness_count(self):
        _, a = self.make()
        c = Counters()
        self.run_windows(a, c, 1, changed=30)
        self.run_windows(a, c, 2, changed=30, out=20)
        self.assertEqual(a.step, 1, "dropped frames")
        _, a = self.make()
        c = Counters()
        self.run_windows(a, c, 1, changed=30)
        self.run_windows(a, c, 2, changed=30, late=12)
        self.assertEqual(a.step, 1, "late captures")

    def test_3_a_still_screen_decides_nothing(self):
        _, a = self.make()
        c = Counters()
        self.run_windows(a, c, 10, changed=2, lat_bucket=100)
        self.assertEqual(a.step, 0)

    def test_4_pressure_with_frames_missing_steps_down(self):
        _, a = self.make(pressure=lambda: 60.0)
        c = Counters()
        self.run_windows(a, c, 3, changed=30)  # 60 changed a second: nothing missing, so pressure alone isn't enough
        self.assertEqual(a.step, 0)
        self.run_windows(a, c, 2, changed=20)  # 40 a second under pressure: the page is starved
        self.assertEqual(a.step, 1)

    def test_5_ladder_orders_and_floor(self):
        s, a = self.make(order="fps")
        c = Counters()
        self.run_windows(a, c, 1, changed=30)
        self.run_windows(a, c, 2, changed=30, lat_bucket=50)
        self.assertEqual((a.step, s.capture.props["max-fps"]), (1, 30))
        for _ in range(20):
            a.settle = 0
            self.run_windows(a, c, 2, changed=15, lat_bucket=100)
        self.assertEqual(a.step, len(M.LADDERS["fps"]) - 1)
        self.assertTrue(all(fps >= 30 for _, _, fps in M.LADDERS["fps"] + M.LADDERS["scale"]), "a step under 30 fps")
        self.assertEqual(s.capture.props["max-fps"], 30)
        s, a = self.make(order="scale")
        self.assertEqual([x[2] for x in a.ladder[:-1]], [60] * (len(a.ladder) - 1), "scale order caps fps only last")

    def test_5b_scale_order_caps_fps_only_under_the_floor(self):
        """At the smallest picture, a stream still getting 30 or more frames through isn't capped at 30: it would only lose
        frames. Under 30, it is."""
        s, a = self.make(pressure=lambda: 60.0)
        last = len(a.ladder) - 1
        a.move(last - 1, "test")
        a.settle = 0
        c = Counters()
        self.run_windows(a, c, 6, changed=20)  # 40 a second, under pressure, at 540 lines and quantizer +4
        self.assertEqual(a.step, last - 1, "capped a stream already at 40 fps")
        self.assertEqual(s.capture.props["max-fps"], 60)
        self.run_windows(a, c, 2, changed=12)  # 24 a second: under the floor
        self.assertEqual(a.step, last)
        self.assertEqual(s.capture.props["max-fps"], 30)

    def test_6_climbs_back_after_the_hold_with_room(self):
        s, a = self.make(pressure=lambda: 5.0)
        c = Counters()
        a.move(2, "test")
        a.changed_at -= 6  # past the 5 s hold
        a.settle = 0
        self.run_windows(a, c, 1, changed=30, lat_bucket=4)  # the first window only sets the baseline
        self.run_windows(a, c, 5, changed=30, lat_bucket=4)
        self.assertEqual(a.step, 2, "climbed before 3 s of room")
        self.run_windows(a, c, 1, changed=30, lat_bucket=4)  # a mean of 3 ms at 720 lines predicts 4.7 at 900
        self.assertEqual(a.step, 1)
        # no room: a mean of 15 ms at 720 predicts 23 ms at 900, over 0.9 x 16.7
        s, a = self.make(pressure=lambda: 5.0)
        a.move(2, "test")
        a.changed_at -= 6
        a.settle = 0
        c = Counters()
        self.run_windows(a, c, 10, changed=30, lat_bucket=20)
        self.assertEqual(a.step, 2)

    def test_6b_climbs_to_the_screens_size_from_900(self):
        """0.3.0 stayed at 900 lines on an idle machine: a mean of 9 ms there, the scaler included, predicted 13 ms at
        1080 against 12.5, though 1080 measured 6.5. Back to the screen's size the scaler goes, so this step's own mean
        is the prediction: 12 ms at 900 lines climbs (scaled, it would predict 17)."""
        s, a = self.make(pressure=lambda: 1.0)
        c = Counters()
        a.move(1, "test")
        a.changed_at -= 6
        a.settle = 0
        self.run_windows(a, c, 7, changed=30, lat_bucket=16)  # a mean of 12 ms at 900 lines
        self.assertEqual(a.step, 0)
        self.assertEqual(s.capture.props["max-fps"], 60)
        # but not with no room at all: a mean of 18.75 ms at 900 is over 0.9 x 16.7, whatever the size above
        s, a = self.make(pressure=lambda: 1.0)
        c = Counters()
        a.move(1, "test")
        a.changed_at -= 6
        a.settle = 0
        self.run_windows(a, c, 10, changed=30, lat_bucket=25)  # a mean of 18.75 ms
        self.assertEqual(a.step, 1)

    def test_7_effective_values_combine_level_and_step(self):
        cfg = configparser.ConfigParser(interpolation=None)
        cfg.read(RECIPE / "stream.conf")
        levels = M.read_levels(cfg)
        s = FakeStream(levels, "low")
        s.adapt = M.Adapter(s, cfg)
        s.base_values = {"quantizer": 23, "bitrate": 8000, "vbv-buf-capacity": 150}
        eff = lambda step: (setattr(s.adapt, "step", step), M.Stream.effective(s))[1]  # noqa: E731
        self.assertEqual(eff(0)["max-height"], 720, "a level's own height is the start")
        self.assertEqual(eff(1)["max-height"], 720, "900 lines doesn't raise Low's 720")
        self.assertEqual(eff(3)["max-height"], 540)
        self.assertEqual(eff(4)["quantizer"], 34)
        s.level = None
        self.assertEqual(eff(0), {"quantizer": 23, "bitrate": 8000, "vbv-buf-capacity": 150, "max-height": 0})
        self.assertEqual(eff(1)["max-height"], 900)


@unittest.skipUnless(HAVE_GST, "needs python3-gi with GStreamer")
class Confs(unittest.TestCase):
    def test_1_fallback_when_deskcap_is_missing(self):
        for name in ("stream.conf", "stream-capped.conf", "stream-deep.conf"):
            cfg = configparser.ConfigParser(interpolation=None)
            cfg.read(RECIPE / name)
            v = cfg["video"]
            self.assertTrue(v["capture"].startswith("deskcap "), name)
            self.assertEqual(M.capture_lines(v, have_deskcap=True)[0], v["capture"])
            capture, convert = M.capture_lines(v, have_deskcap=False)
            self.assertTrue(capture.startswith("ximagesrc "), name)
            self.assertTrue(convert.startswith("yuvconv "), name)
            if name == "stream-deep.conf":
                self.assertIn("width=960,height=540", convert)
                self.assertIn("width=960,height=540", v["convert"])

    def test_2_every_conf_parses_with_deskcap(self):
        if not HAVE_X:
            self.skipTest("no deskcap built here")
        for name in ("stream.conf", "stream-capped.conf", "stream-deep.conf"):
            cfg = configparser.ConfigParser(interpolation=None)
            cfg.read(RECIPE / name)
            cfg["audio"]["enabled"] = "false"
            text = M.pipeline_string(cfg, 7, M.read_levels(cfg))
            self.assertIn("framemeter name=meter", text)
            self.assertIn("capsfilter name=size", text)
            p = Gst.parse_launch(text.replace("fd=7", "fd=1"))
            self.assertIsNotNone(p, name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
