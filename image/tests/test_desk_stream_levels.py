#!/usr/bin/python3 -I
"""desk-stream's quality levels (stream-quality.md section 5) in a real GStreamer: the real desk-stream, the real stream.conf,
its pipeline_string() and command(), on a socketpair as desk-rtc has it. Only the capture (videotestsrc) and convert
(videoconvert, no yuvconv) are swapped, and audio is off. It reads the RTP back, rebuilds the H.264 and reads each SPS.

Needs GStreamer 1.26 with x264enc, as on the desk (Debian 13). In a debian:trixie container:
  apt-get install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-ugly
  python3 -I image/tests/test_desk_stream_levels.py    # about 90 s; skipped where there's no GStreamer
"""
import configparser
import importlib.machinery
import importlib.util
import os
import pathlib
import re
import socket
import statistics
import struct
import sys
import threading
import time
import unittest

sys.dont_write_bytecode = True  # Nothing lands in the release's directory.
RECIPE = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "desk-stream"
try:
    loader = importlib.machinery.SourceFileLoader("desk_stream", str(RECIPE / "desk-stream"))
    spec = importlib.util.spec_from_loader("desk_stream", loader)
    M = importlib.util.module_from_spec(spec)
    loader.exec_module(M)
    from gi.repository import GLib, Gst
    Gst.init(None)
    HAVE_GST = Gst.ElementFactory.find("x264enc") is not None
except (ImportError, ValueError):
    HAVE_GST = False

LOG = []  # (monotonic, line) of everything desk-stream logs


def record(*a):
    line = " ".join(str(x) for x in a)
    LOG.append((time.monotonic(), line))
    print("  desk-stream:", line, file=sys.stderr, flush=True)


if HAVE_GST:
    M.log = record

BALL = "videotestsrc pattern=ball is-live=true ! video/x-raw,width=1920,height=1080,framerate=60/1"
SNOW = "videotestsrc pattern=snow is-live=true ! video/x-raw,width=1920,height=1080,framerate=60/1"
CONVERT = "videoconvert ! video/x-raw,format=NV12"
WINDOW = 3.9  # s: from a level's keyframe to just before x264's own next one (key-int-max=240 at 60 fps)
SPEC = {  # stream-quality.md section 5
    "low": {"max-height": 720, "quantizer": 30, "bitrate": 2500, "vbv-buf-capacity": 150},
    "medium": {"max-height": 0, "quantizer": 27, "bitrate": 4000, "vbv-buf-capacity": 150},
    "high": {"max-height": 0, "quantizer": 23, "bitrate": 8000, "vbv-buf-capacity": 150},
    "max": {"max-height": 0, "quantizer": 19, "bitrate": 12000, "vbv-buf-capacity": 150},
}
FULL, LOW = (1920, 1080), (1280, 720)


def reference_0_2_3(cfg, fd):
    """desk-stream 0.2.3's pipeline_string(), verbatim: what a stream.conf without levels must still build."""
    PT_H264, PT_OPUS = 96, 111
    v = cfg["video"]
    parts = [
        f"funnel name=mux ! fdsink name=out fd={fd} sync=false async=false",
        f"{v['capture']} ! {v['convert']}"
        " ! queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream"
        f" ! x264enc name=encoder {v['x264']} ! {v['caps']}"
        f" ! rtph264pay pt={PT_H264} timestamp-offset=0 {v['rtp']} ! rtpstreampay ! mux.",
    ]
    if cfg.getboolean("audio", "enabled", fallback=True):
        a = cfg["audio"]
        parts.append(
            f"{a['capture']} ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2"
            f" ! {a['encoder']} ! rtpopuspay pt={PT_OPUS} timestamp-offset=0 ! rtpstreampay ! mux."
        )
    return " ".join(parts)


def conf(name, capture=None, levels=True, adapt=True):
    cfg = configparser.ConfigParser(interpolation=None)
    assert cfg.read(RECIPE / name), name
    if not adapt and cfg.has_section("adapt"):
        cfg["adapt"]["enabled"] = "false"
    if not levels:
        for s in [s for s in cfg.sections() if s.startswith("level.")]:
            cfg.remove_section(s)
    if capture:
        cfg["video"]["capture"] = capture
        cfg["video"]["convert"] = CONVERT
        cfg["audio"]["enabled"] = "false"
    return cfg


# --- H.264 out of RTP ------------------------------------------------------------------------------------------------------

class Bits:
    def __init__(self, data):
        self.d, self.i = data, 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.d[self.i >> 3] >> (7 - (self.i & 7))) & 1)
            self.i += 1
        return v

    def ue(self):
        z = 0
        while self.u(1) == 0:
            z += 1
        return (1 << z) - 1 + self.u(z)

    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def unescape(nal):
    return nal.replace(b"\x00\x00\x03", b"\x00\x00")


def sps_size(nal):
    """Picture width and height from an SPS NAL (H.264 7.3.2.1.1), cropping applied."""
    b = Bits(unescape(nal[1:]))
    profile = b.u(8)
    b.u(16)
    b.ue()
    chroma = 1
    if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        chroma = b.ue()
        if chroma == 3:
            b.u(1)
        b.ue(), b.ue(), b.u(1)
        if b.u(1):
            raise ValueError("SPS with scaling lists")
    b.ue()
    poc = b.ue()
    if poc == 0:
        b.ue()
    elif poc == 1:
        b.u(1), b.se(), b.se()
        for _ in range(b.ue()):
            b.se()
    b.ue(), b.u(1)
    w, h_map = (b.ue() + 1) * 16, b.ue() + 1
    frame_mbs_only = b.u(1)
    if not frame_mbs_only:
        b.u(1)
    b.u(1)
    h = (2 - frame_mbs_only) * h_map * 16
    if b.u(1):
        left, right, top, bottom = b.ue(), b.ue(), b.ue(), b.ue()
        w -= (left + right) * (2 if chroma in (1, 2) else 1)
        h -= (top + bottom) * (2 if chroma == 1 else 1) * (2 - frame_mbs_only)
    return w, h


class Receiver(threading.Thread):
    """desk-rtc's end of the socket: RFC 4571 frames in, H.264 access units out, each with its receive time."""

    def __init__(self, sock):
        super().__init__(daemon=True)
        self.sock = sock
        self.aus = []
        self.cv = threading.Condition()
        self.au = self.fu = None
        self.size = None
        self.other_pt = 0
        self.seq = self.ssrc = None
        self.seq_gaps = 0  # RTP sequence numbers that didn't follow on: a payloader started again, or a packet was lost
        self.ssrcs = set()

    def read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise EOFError
            buf += chunk
        return buf

    def run(self):
        try:
            while True:
                n = struct.unpack(">H", self.read(2))[0]
                pkt = self.read(n)
                self.packet(pkt, time.monotonic(), n + 2)
        except (EOFError, OSError):
            pass

    def packet(self, pkt, t, size):
        cc, ext, marker, pt = pkt[0] & 0x0F, pkt[0] & 0x10, pkt[1] >> 7, pkt[1] & 0x7F
        ts = struct.unpack(">I", pkt[4:8])[0]
        off = 12 + 4 * cc
        if ext:
            off += 4 + 4 * struct.unpack(">H", pkt[off + 2:off + 4])[0]
        payload = pkt[off:]
        if pt != M.PT_H264:
            self.other_pt += 1
            return
        seq = struct.unpack(">H", pkt[2:4])[0]
        if self.seq is not None and seq != (self.seq + 1) & 0xFFFF:
            self.seq_gaps += 1
        self.seq = seq
        self.ssrcs.add(pkt[8:12])
        if self.au is not None and self.au["ts"] != ts:
            self.finish()
        if self.au is None:
            self.au = {"ts": ts, "t0": t, "bytes": 0, "nals": [], "sps": None, "sei": None}
        self.au["bytes"] += size
        self.au["t1"] = t
        typ = payload[0] & 0x1F
        if typ == 24:  # STAP-A
            i = 1
            while i + 2 <= len(payload):
                n = struct.unpack(">H", payload[i:i + 2])[0]
                self.nal(payload[i + 2:i + 2 + n])
                i += 2 + n
        elif typ == 28:  # FU-A
            if payload[1] & 0x80:
                self.fu = bytearray([(payload[0] & 0xE0) | (payload[1] & 0x1F)])
            if self.fu is not None:
                self.fu += payload[2:]
                if payload[1] & 0x40:
                    self.nal(bytes(self.fu))
                    self.fu = None
        else:
            self.nal(payload)
        # Not on the marker alone: rtph264pay sets it on the SPS and PPS it sends ahead of each keyframe, at the same timestamp.
        if marker and any(1 <= n <= 5 for n in self.au["nals"]):
            self.finish()

    def nal(self, nal):
        typ = nal[0] & 0x1F
        self.au["nals"].append(typ)
        if typ == 7:
            self.au["sps"] = self.size = sps_size(nal)
        elif typ == 6:  # x264 writes its settings in an SEI each time it opens
            m = re.search(rb"options: ([ -~]+)", unescape(nal))
            if m:
                self.au["sei"] = dict(kv.split("=", 1) for kv in m.group(1).decode().split() if "=" in kv)

    def finish(self):
        au, self.au = self.au, None
        au["idr"] = 5 in au["nals"]
        au["size"] = self.size
        with self.cv:
            self.aus.append(au)
            self.cv.notify_all()

    def first(self, after, pred, timeout=2.0):
        """The first access unit received after `after` that pred accepts, and how many came from `after` up to it."""
        end = time.monotonic() + timeout
        with self.cv:
            while True:
                later = [au for au in self.aus if au["t0"] >= after]
                for i, au in enumerate(later):
                    if pred(au):
                        return au, i + 1
                left = end - time.monotonic()
                if left <= 0:
                    return None, len(later)
                self.cv.wait(left)

    def window(self, t0, t1):
        with self.cv:
            return [au for au in self.aus if t0 <= au["t0"] < t1]


# --- desk-stream, run as desk-rtc runs it ----------------------------------------------------------------------------------

class Desk:
    KEEP = []  # Sockets stay open until exit, so an old stream's GLib watch never sees a reused fd.

    def __init__(self, cfg, before=()):
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        a.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, M.SEND_BUFFER)
        Desk.KEEP += [a, b]
        self.sock = b
        self.stream = M.Stream(cfg, a)
        self.pay = None
        self.pts_ticks = set()  # RTP timestamps the payloader should write: running time at 90 kHz, offset 0
        it = self.stream.pipeline.iterate_elements()
        while True:
            res, e = it.next()
            if res != Gst.IteratorResult.OK:
                break
            if e.get_factory().get_name() == "rtph264pay":
                self.pay = e
        self.pay.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, self.on_pts)
        self.rx = Receiver(b)
        self.rx.start()
        for cmd in before:  # through command() itself, before the pipeline is even warm
            self.stream.command(cmd)
        self.thread = threading.Thread(target=self.stream.start, daemon=True)
        self.thread.start()
        time.sleep(0.3)  # warm

    def on_pts(self, pad, info):
        # Running time, as rtpbasepayload takes it: x264enc moves PTS 1000 h on (min-pts) and its segment along with it.
        segment = pad.get_sticky_event(Gst.EventType.SEGMENT, 0).parse_segment()
        running = segment.to_running_time(Gst.Format.TIME, info.get_buffer().pts)
        self.pts_ticks.add((running * 90000 // Gst.SECOND) & 0xFFFFFFFF)
        return Gst.PadProbeReturn.OK

    def send(self, cmd):
        t = time.monotonic()
        self.sock.sendall(cmd.encode() + b"\n")
        return t

    def stop(self):
        GLib.idle_add(self.stream.quit, 0)
        self.thread.join(5)
        assert not self.thread.is_alive(), "desk-stream didn't stop"
        assert self.stream.exit_code == 0, "desk-stream stopped on an error"


def captured_after(au, t):
    """The frame was captured after monotonic time t: its RTP timestamp is CLOCK_MONOTONIC at 90 kHz (task 23)."""
    return ((au["ts"] - int(t * 90000)) & 0xFFFFFFFF) < 1 << 31


def logged_since(t):
    return [line for when, line in LOG if when >= t]


def kbps(aus, seconds):
    return sum(au["bytes"] for au in aus) * 8 / 1000 / seconds


def lag_ms(au):
    """Receive time minus the RTP timestamp, both CLOCK_MONOTONIC: capture to desk-rtc."""
    return ((int(au["t1"] * 90000) - au["ts"]) & 0xFFFFFFFF) / 90


@unittest.skipUnless(HAVE_GST, "needs GStreamer with x264enc (python3-gi, gstreamer1.0-plugins-ugly)")
class Levels(unittest.TestCase):
    def test_1_pipeline_without_levels_is_0_2_3s(self):
        """(g) No [level.*] and no [adapt]: byte for byte what 0.2.3 builds, for every conf, but for 0.3.0's framemeter after
        the encoder where deskcap's plugin is there (ADR 0073). With levels or [adapt]: only the scaler is added too."""
        meter = " ! framemeter name=meter"

        def as_0_2_3(text):
            """Less 0.3.0's meter and 0.3.3's two additions (ADR 0073 addendum): x264-<machine>'s options in the x264 line's
            option-string on that machine (asm=NEON on aarch64), and the sound gate's valve and the branch's last element named."""
            text = text.replace(meter, "").replace(" ! rtpstreampay name=soundframe ! mux.", " ! rtpstreampay ! mux.")
            text = text.replace(" ! valve name=soundvalve drop=true drop-mode=forward-sticky-events", "")
            extra = cfg["video"].get(f"x264-{os.uname().machine}", "").strip()
            return text.replace(f":{extra} ", " ", 1) if extra else text

        for name in ("stream.conf", "stream-capped.conf", "stream-deep.conf"):
            cfg = conf(name, BALL, levels=False, adapt=False)
            levels = M.read_levels(cfg)
            self.assertEqual(levels, {})
            self.assertEqual(as_0_2_3(M.pipeline_string(cfg, 7, levels)), reference_0_2_3(cfg, 7), name)
            self.assertEqual(as_0_2_3(M.pipeline_string(cfg, 7)), reference_0_2_3(cfg, 7), name)
            adapting = as_0_2_3(M.pipeline_string(conf(name, BALL, levels=False), 7))
            self.assertEqual(adapting.replace(f" ! {M.SCALE}", "", 1), reference_0_2_3(cfg, 7), name)
        cfg = conf("stream.conf", adapt=False)
        cfg["video"]["capture"], cfg["video"]["convert"] = BALL, CONVERT
        with_levels = as_0_2_3(M.pipeline_string(cfg, 7, M.read_levels(cfg)))
        self.assertEqual(with_levels.count("videoscale"), 1)
        self.assertEqual(with_levels.replace(f" ! {M.SCALE}", "", 1), reference_0_2_3(cfg, 7))
        self.assertIn(f"{cfg['video']['convert']} ! {M.SCALE} ! queue max-size-buffers=1", with_levels)
        print("\n(g) stream.conf, levels:   ", with_levels)
        print("(g) stream.conf, none, 0.2.3:", reference_0_2_3(conf("stream.conf", BALL, levels=False, adapt=False), 7))

    def test_2_read_levels(self):
        cfg = conf("stream.conf")
        self.assertEqual(M.read_levels(cfg), SPEC)
        x264 = dict(kv.split("=", 1) for kv in cfg["video"]["x264"].split() if "=" in kv)
        for key in M.ENCODER_KEYS:
            self.assertEqual(int(x264[key]), SPEC["high"][key], f"[level.high] {key} differs from [video]")
        # S-29: the capped conf's levels are stream.conf's held to its own picture; the deep conf has none (each would be it).
        capped = {name: {"max-height": v["max-height"] if v["max-height"] else 0, "quantizer": max(v["quantizer"], 28),
                         "bitrate": min(v["bitrate"], 4000), "vbv-buf-capacity": v["vbv-buf-capacity"]} for name, v in SPEC.items()}
        self.assertEqual(M.read_levels(conf("stream-capped.conf")), capped)
        self.assertEqual(capped["low"], SPEC["low"])
        self.assertEqual(M.read_levels(conf("stream-deep.conf")), {})
        bad = configparser.ConfigParser(interpolation=None)
        bad.read_string(
            "[level.low]\nmax-height = 720        # a comment, as in the contract\nquantizer = 30\nbitrate = 2500\n"
            "vbv-buf-capacity = 150\n"
            "[level.medium]\nmax-height = 0\nquantizer = 51\nbitrate = 4000\nvbv-buf-capacity = 150\n"
            "[level.high]\nmax-height = 0\nquantizer = 23\nbitrate = 8000\n"
            "[level.max]\nmax-height = 0\nquantizer = 19\nbitrate = lots\nvbv-buf-capacity = 150\n"
            "[level.ultra]\nmax-height = 0\nquantizer = 19\nbitrate = 12000\nvbv-buf-capacity = 150\n"
            "[level.tiny]\nmax-height = 8\nquantizer = 19\nbitrate = 12000\nvbv-buf-capacity = 150\n")
        t = time.monotonic()
        self.assertEqual(M.read_levels(bad), {"low": SPEC["low"]})
        self.assertEqual(len([x for x in logged_since(t) if "skipped" in x]), 5)

    def test_3_fit(self):
        self.assertEqual(M.fit(1920, 1080, 720), (1280, 720))
        self.assertEqual(M.fit(1280, 800, 720), (1152, 720))
        self.assertEqual(M.fit(2560, 1440, 720), (1280, 720))
        self.assertEqual(M.fit(1366, 768, 720), (1280, 720))
        self.assertEqual(M.fit(1920, 1080, 721), (1280, 720))
        self.assertEqual(M.fit(1920, 1200, 720), (1152, 720))
        self.assertEqual(M.fit(1920, 1080, 0), None)
        self.assertEqual(M.fit(1280, 720, 720), None)
        self.assertEqual(M.fit(1280, 720, 1080), None)

    def test_4_live_and_paused(self):
        """(a) to (f) on the ball, switching while PLAYING and while PAUSED."""
        d = Desk(conf("stream.conf", BALL))
        rx = d.rx
        self.assertEqual(rx.aus, [], "frames while warm")
        t = d.send("resume")
        au, _ = rx.first(t, lambda a: a["idr"])
        self.assertEqual(au["sps"], FULL)
        self.assertEqual((au["sei"]["crf"], au["sei"]["vbv_maxrate"], au["sei"]["vbv_bufsize"]), ("23.0", "8000", "1200"))
        time.sleep(1)

        rows = {}

        def switch(level, size, sei=None):
            t = d.send(f"level {level}")
            idr, frames = rx.first(t, lambda a: a["idr"] and a["size"] == size)
            self.assertIsNotNone(idr, f"no keyframe at {size} after level {level}")
            self.assertEqual(idr["sps"], size)
            self.assertLessEqual(frames, 3, f"level {level}: keyframe {frames} frames after the command")
            switch_ms = (idr["t1"] - t) * 1000
            self.assertLess(switch_ms, 500)
            if sei:
                self.assertEqual((idr["sei"]["crf"], idr["sei"]["vbv_maxrate"], idr["sei"]["vbv_bufsize"]), sei)
            lines = [x for x in logged_since(t) if x.startswith(f"level {level}:")]
            self.assertEqual(len(lines), 1, lines)
            return t, idr, frames, switch_ms, lines[0]

        def measure(level, size, sei=None, extra=None):
            t, idr, frames, switch_ms, line = switch(level, size, sei)
            if extra:
                extra()
            time.sleep(max(0.0, idr["t0"] + WINDOW + 0.1 - time.monotonic()))
            aus = rx.window(idr["t0"], idr["t0"] + WINDOW)
            deltas = {(b["ts"] - a["ts"]) & 0xFFFFFFFF for a, b in zip(aus, aus[1:])}
            self.assertEqual(deltas, {1500}, f"level {level}: frames missing or late, RTP steps {deltas}")
            self.assertEqual([a["idr"] for a in aus].count(True), 1, f"level {level}: more than one keyframe")
            self.assertEqual({a["size"] for a in aus}, {size})
            fps = len(aus) / WINDOW
            self.assertTrue(58.5 <= fps <= 61.5, f"level {level}: {fps:.1f} fps")
            lags = [lag_ms(a) for a in aus]
            rows[level] = dict(size=size, kbps=kbps(aus, WINDOW), fps=fps, frames=frames, switch_ms=switch_ms,
                               idr_kb=idr["bytes"] / 1000, lag50=statistics.median(lags), lag_max=max(lags), log=line)

        def same_twice():
            """The same level again, and an unknown one: nothing at all."""
            t = d.send("level max")
            u = d.send("level ultra")
            time.sleep(0.6)
            self.assertFalse([a for a in rx.window(t, time.monotonic()) if a["idr"]], "a keyframe for nothing")
            self.assertEqual(logged_since(t), ["unknown level: ultra"])

        measure("high", FULL)  # [video] already has High's values: nothing to reopen, only a keyframe
        rows["high (from [video])"] = rows.pop("high")
        measure("low", LOW, ("30.0", "2500", "375"))
        measure("medium", FULL, ("27.0", "4000", "600"))
        measure("max", FULL, ("19.0", "12000", "1800"), extra=same_twice)

        # PAUSED after playing: the level is set while nothing flows, and the first frame of the resume carries it.
        d.send("pause")
        time.sleep(0.4)
        t = time.monotonic()
        time.sleep(0.4)
        self.assertEqual(rx.window(t, time.monotonic()), [], "frames while paused")
        t = d.send("level low")
        time.sleep(0.2)
        self.assertEqual([x for x in logged_since(t) if x.startswith("level")], ["level low: 1280x720 q30 2500 kbit/s"])
        t = d.send("resume")
        # The first frame captured after the resume. One captured before the pause may come out ahead of it: it waited in
        # fdsink's preroll, the old encoder's last frame. 0.2.3 does the same (17 of 20 resumes on stream-capped.conf).
        first, _ = rx.first(t, lambda a: captured_after(a, t))
        stale = [a for a in rx.window(t, first["t0"]) if not captured_after(a, t)]
        self.assertTrue(first["idr"], "first frame after a resume isn't a keyframe")
        self.assertEqual(first["sps"], LOW)
        self.assertEqual((first["sei"]["crf"], first["sei"]["vbv_maxrate"]), ("30.0", "2500"))
        paused_ms = (first["t1"] - t) * 1000
        time.sleep(0.5)
        measure("high", FULL, ("23.0", "8000", "1200"))
        rows["high (back from low)"] = rows.pop("high")

        # (f) Task 23's clock: untouched by every switch.
        self.assertEqual(d.stream.pipeline.get_base_time(), 0)
        self.assertEqual(d.stream.pipeline.get_start_time(), Gst.CLOCK_TIME_NONE)
        self.assertEqual(d.pay.get_property("timestamp-offset"), 0)
        with rx.cv:
            sent = [a["ts"] for a in rx.aus]
        off = [ts for ts in sent if ts not in d.pts_ticks]
        self.assertEqual(off, [], f"{len(off)} of {len(sent)} RTP timestamps aren't running time at 90 kHz")
        self.assertEqual((rx.seq_gaps, len(rx.ssrcs)), (0, 1), "the payloader started again")
        d.stop()

        # (c) the same content costs less at each lower level
        self.assertLess(rows["low"]["kbps"], rows["medium"]["kbps"])
        self.assertLess(rows["medium"]["kbps"], rows["high (back from low)"]["kbps"])
        self.assertLess(rows["high (back from low)"]["kbps"], rows["max"]["kbps"])
        print(f"\nBall, 1920x1080@60 in, {WINDOW} s from each level's keyframe:")
        print(f"  {'level':22s} {'size':>10s} {'kbit/s':>8s} {'fps':>6s} {'frames':>6s} {'switch ms':>9s} {'IDR kB':>7s}"
              f" {'lag p50/max ms':>15s}")
        for level, r in rows.items():
            print(f"  {level:22s} {'%dx%d' % r['size']:>10s} {r['kbps']:8.0f} {r['fps']:6.1f} {r['frames']:6d}"
                  f" {r['switch_ms']:9.1f} {r['idr_kb']:7.1f} {r['lag50']:7.1f}/{r['lag_max']:<7.1f}")
        print(f"  paused at max, level low, resume: first frame a {first['sps'][0]}x{first['sps'][1]} keyframe,"
              f" {paused_ms:.1f} ms after resume ({len(stale)} frame from before the pause ahead of it)")
        print(f"  base time 0, start time none, timestamp-offset 0; all {len(sent)} RTP timestamps = running time x 90 kHz;"
              f" one SSRC, sequence numbers unbroken")

    def test_5_warm_level_before_first_resume(self):
        """What desk-rtc does: level first, then resume. The very first frame is already Low's size: with the screen's size known
        while warm (the source has negotiated), and with it not known yet (sized when the caps go by). Its quantizer and ceiling
        are [video]'s, and Low's follow at once after it (S-29: the encoder takes a level's values only once it has opened on a
        frame, which on a real desk at Max failed 4 starts in 10 when reopened while warm)."""
        for known in (True, False):
            t = start = time.monotonic()
            if known:
                d = Desk(conf("stream.conf", BALL))
                d.send("level low")
                time.sleep(0.2)
                expect = ["level low: 1280x720 q30 2500 kbit/s"]
            else:
                d = Desk(conf("stream.conf", BALL), before=["level low"])
                expect = ["level low: fits 720 lines q30 2500 kbit/s"]
            self.assertEqual([x for x in logged_since(t) if x.startswith("level")], expect)
            t = d.send("resume")
            first, _ = d.rx.first(t, lambda a: True)
            time.sleep(max(0.0, first["t0"] + 1.1 - time.monotonic()))
            later = d.rx.window(first["t0"], first["t0"] + 1)
            d.stop()
            self.assertTrue(first["idr"])
            self.assertEqual(first["sps"], LOW)
            self.assertEqual((first["sei"]["crf"], first["sei"]["vbv_maxrate"]), ("23.0", "8000"))
            low = [i for i, a in enumerate(later) if a["idr"] and a["sei"] and a["sei"]["crf"] == "30.0"]
            self.assertTrue(low and low[0] <= 3, f"Low's values {low[:1]} frames after the first, want within 3")
            self.assertEqual({a["size"] for a in later}, {LOW})
            self.assertEqual([a["idr"] for a in later].count(True), 2)
            if not known:
                self.assertIn("screen 1920x1080: level low is 1280x720", logged_since(start))
            print(f"\nwarm, screen {'known' if known else 'not known yet'}, level low, resume: first frame a"
                  f" {first['sps'][0]}x{first['sps'][1]} keyframe in {(first['t1'] - t) * 1000:.1f} ms")

    def test_5b_a_new_process_told_max_opens_then_takes_it(self):
        """S-29, from a real desk: a new desk-stream told `level max`, then `resume` and `keyframe` together, as desk-rtc's
        connection sends them. The encoder opens on the first frame with [video]'s values, then reopens at Max's right after,
        at 60 fps, and never errors. Before, it reopened while warm, and on a desk 4 starts in 10 met "encoder not initialized"."""
        for trial in range(3):
            d = Desk(conf("stream.conf", BALL))
            t = time.monotonic()
            d.sock.sendall(b"level max\nresume\nkeyframe\n")
            first, _ = d.rx.first(t, lambda a: True)
            self.assertIsNotNone(first, "no frame after resume")
            time.sleep(1.6)
            later = d.rx.window(first["t0"], first["t0"] + 1.5)
            d.stop()
            self.assertTrue(first["idr"])
            self.assertEqual((first["sei"]["crf"], first["sei"]["vbv_maxrate"]), ("23.0", "8000"), "the first frame is [video]'s")
            mx = [i for i, a in enumerate(later) if a["idr"] and a["sei"] and a["sei"]["crf"] == "19.0"]
            self.assertTrue(mx and mx[0] <= 3, f"Max's values {mx[:1]} frames after the first, want within 3")
            fps = len(later) / 1.5
            self.assertTrue(58 <= fps <= 62, f"{fps:.1f} fps")
            self.assertFalse([x for x in logged_since(t) if "error" in x])
            print(f"\n(start at max, trial {trial + 1}) first frame q23, Max's keyframe {mx[0]} frames on, {fps:.1f} fps")

    def test_6_capped_conf_holds_each_level_to_its_picture(self):
        """S-29: past 100 GB the member's level counts within the cap. Low stays Low (1280x720, q30, 2.5 Mbit); Medium, High and
        Max are the capped picture (1920x1080, q28, 4 Mbit). Before, stream-capped.conf had no levels, so Low got the capped
        picture: sharper and more data than the member chose. Every switch keeps 60 fps."""
        d = Desk(conf("stream-capped.conf", BALL))
        rx = d.rx
        t = d.send("resume")
        au, _ = rx.first(t, lambda a: a["idr"])
        self.assertEqual(au["sps"], FULL)
        self.assertEqual((au["sei"]["crf"], au["sei"]["vbv_maxrate"], au["sei"]["vbv_bufsize"]), ("28.0", "4000", "600"))
        capped = ("28.0", "4000", "600")
        # high after low reopens the encoder (its SEI carries the values); medium after high has the same values, so it's a
        # keyframe on the open encoder with no SEI, and the encoder's own properties say what runs.
        for level, size, sei in (("low", LOW, ("30.0", "2500", "375")), ("max", FULL, capped), ("low", LOW, None),
                                 ("high", FULL, capped), ("medium", FULL, None)):
            t = d.send(f"level {level}")
            idr, frames = rx.first(t, lambda a, size=size: a["idr"] and a["size"] == size)
            self.assertIsNotNone(idr, f"no keyframe at {size} after level {level}")
            self.assertLessEqual(frames, 3, f"level {level}: keyframe {frames} frames after the command")
            if sei:
                self.assertEqual((idr["sei"]["crf"], idr["sei"]["vbv_maxrate"], idr["sei"]["vbv_bufsize"]), sei, level)
            time.sleep(max(0.0, idr["t0"] + 1.6 - time.monotonic()))
            aus = rx.window(idr["t0"], idr["t0"] + 1.5)
            self.assertEqual({a["size"] for a in aus}, {size}, level)
            fps = len(aus) / 1.5
            self.assertTrue(58 <= fps <= 62, f"level {level}: {fps:.1f} fps")
            print(f"\n(capped) level {level}: {size[0]}x{size[1]}, keyframe {frames} frames after, {fps:.1f} fps")
        self.assertEqual(d.stream.encoder.get_property("quantizer"), 28)
        self.assertEqual(d.stream.encoder.get_property("bitrate"), 4000)
        d.stop()

    def test_6b_deep_conf_ignores_level(self):
        """stream-deep.conf has no levels: every level held to its picture is its picture. level is logged once and changes nothing."""
        d = Desk(conf("stream-deep.conf", BALL))
        t = d.send("resume")
        first, _ = d.rx.first(t, lambda a: a["idr"])  # this test's capture replaces the conf's convert, scaler included
        time.sleep(0.5)
        t = d.send("level low")
        d.send("level max")
        time.sleep(1.0)
        aus = d.rx.window(t, time.monotonic())
        d.stop()
        self.assertEqual(len([x for x in logged_since(t) if "level" in x]), 1)
        self.assertFalse([a for a in aus if a["idr"]])
        self.assertEqual({a["size"] for a in aus}, {first["sps"]})
        self.assertEqual(d.stream.encoder.get_property("quantizer"), 30)

    def test_7_ceilings_on_noise(self):
        """Snow is more than any level's ceiling, so each runs at its VBV cap: each level's bitrate holds after the encoder
        reopens, with or without a new size, and option-string's vbv-maxrate=8000 never comes back."""
        d = Desk(conf("stream.conf", SNOW))
        rx = d.rx
        t = d.send("resume")
        rx.first(t, lambda a: a["idr"])
        time.sleep(1)
        rows = []
        for level, size in (("low", LOW), ("medium", FULL), ("high", FULL), ("max", FULL), ("medium", FULL)):
            t = d.send(f"level {level}")
            idr, _ = rx.first(t, lambda a: a["idr"] and a["size"] == size)
            self.assertIsNotNone(idr, level)
            time.sleep(max(0.0, idr["t0"] + WINDOW + 0.1 - time.monotonic()))
            aus = rx.window(idr["t0"], idr["t0"] + WINDOW)
            rate = kbps(aus, WINDOW)
            cap = SPEC[level]["bitrate"]
            rows.append((level, rate, cap, len(aus) / WINDOW, idr["sei"]))
            self.assertLess(rate, cap * 1.10, f"{level}: {rate:.0f} kbit/s over its {cap} ceiling")
            self.assertGreater(rate, cap * 0.5, f"{level}: {rate:.0f} kbit/s, far under its {cap} ceiling")
        d.stop()
        print("\nSnow (noise), 1920x1080@60 in: socket kbit/s against each level's ceiling")
        for level, rate, cap, fps, sei in rows:
            how = f"SEI crf={sei['crf']} vbv_maxrate={sei['vbv_maxrate']}" if sei else "no SEI"
            print(f"  {level:7s} {rate:7.0f} of {cap:5d} kbit/s ({rate / cap:4.0%}), {fps:4.1f} fps, {how}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
