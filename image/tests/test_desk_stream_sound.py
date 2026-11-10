#!/usr/bin/python3 -I
"""desk-stream 0.3.3 (ADR 0073 addendum): x264 options for one machine, and sound only while something plays.

The pure parts run anywhere. The rest needs Debian 13's GStreamer 1.26 (python3-gi, gir1.2-gstreamer-1.0, plugins base, good
and ugly) and is skipped without it:
- x264-aarch64's options reach x264enc only on aarch64, it takes them, and asm=NEON encodes the same bytes (threads=1);
- the sound gate, with a stand-in pactl and audiotestsrc for the Pulse monitor: no sound packets until a sink-input appears,
  sound within a moment of one, stamped on CLOCK_MONOTONIC like the picture (ADR 0037), none after the tail once it goes, none
  while warm, nothing stale after a start, and sound all the time when pactl stops.
  python3 -I image/tests/test_desk_stream_sound.py     # about 25 s with GStreamer
"""
import configparser
import hashlib
import importlib.machinery
import importlib.util
import os
import pathlib
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
RECIPE = pathlib.Path(__file__).resolve().parent.parent / "recipe" / "desk-stream"
try:
    loader = importlib.machinery.SourceFileLoader("desk_stream", str(RECIPE / "desk-stream"))
    spec = importlib.util.spec_from_loader("desk_stream", loader)
    M = importlib.util.module_from_spec(spec)
    loader.exec_module(M)
    from gi.repository import GLib, Gst
    Gst.init(None)
    HAVE_GST = all(Gst.ElementFactory.find(e) for e in ("x264enc", "opusenc", "audiotestsrc", "rtpopuspay", "rtpstreampay"))
except (ImportError, ValueError):
    HAVE_GST = False
M_LOG = []
if HAVE_GST:
    M.log = lambda *a: M_LOG.append(" ".join(str(x) for x in a))
ARM = os.uname().machine == "aarch64"


class Pure(unittest.TestCase):
    @unittest.skipUnless(HAVE_GST, "desk-stream imports gi")
    def test_x264_line_per_machine(self):
        v = {"x264": "threads=2 pass=qual option-string=vbv-maxrate=8000:vbv-bufsize=1200 key-int-max=240", "x264-aarch64": "asm=NEON"}
        self.assertEqual(M.x264_line(v, "aarch64"), "threads=2 pass=qual option-string=vbv-maxrate=8000:vbv-bufsize=1200:asm=NEON key-int-max=240")
        self.assertEqual(M.x264_line(v, "x86_64"), v["x264"])
        self.assertEqual(M.x264_line({"x264": "threads=2", "x264-aarch64": "asm=NEON"}, "aarch64"), "threads=2 option-string=asm=NEON")
        self.assertEqual(M.x264_line({"x264": 'threads=2 option-string="a=1"', "x264-aarch64": "asm=NEON"}, "aarch64"),
                         'threads=2 option-string="a=1:asm=NEON"')
        self.assertEqual(M.x264_line({"x264": "threads=2 option-string=", "x264-aarch64": "asm=NEON"}, "aarch64"), "threads=2 option-string=asm=NEON")
        # Anything that could be pipeline syntax is left out.
        self.assertEqual(M.x264_line({"x264": "threads=2", "x264-aarch64": "asm=NEON ! fakesink"}, "aarch64"), "threads=2")
        self.assertEqual(M.x264_line({"x264": "threads=2"}, "aarch64"), "threads=2")

    @unittest.skipUnless(HAVE_GST, "desk-stream imports gi")
    def test_pactl_lines(self):
        self.assertEqual(M.sink_input_event("Event 'new' on sink-input #12"), ("new", 12))
        self.assertEqual(M.sink_input_event("Event 'remove' on sink-input #3\n"), ("remove", 3))
        self.assertIsNone(M.sink_input_event("Event 'change' on sink-input #3"))
        self.assertIsNone(M.sink_input_event("Event 'new' on source-output #4"))
        self.assertIsNone(M.sink_input_event("Event 'new' on client #9"))
        self.assertEqual(M.sink_inputs("12\t0\t7\tprotocol-native.c\tfloat32le 2ch 48000Hz\n4\t0\t9\tx\ty\n"), {12, 4})
        self.assertEqual(M.sink_inputs(""), set())
        self.assertEqual(M.sink_inputs("Connection failure: refused\n"), set())

    @unittest.skipUnless(HAVE_GST, "desk-stream imports gi")
    def test_gate_mode(self):
        def cfg(text):
            c = configparser.ConfigParser(interpolation=None)
            c.read_string(text)
            return c
        self.assertEqual(M.gate_mode(cfg("[audio]\ngate = sink-input\n")), "sink-input")
        self.assertEqual(M.gate_mode(cfg("[audio]\nenabled = true\n")), "always")
        self.assertEqual(M.gate_mode(cfg("[audio]\ngate = sometimes\n")), "always")

    def test_confs(self):
        """All three confs gate the sound and add asm=NEON on arm64 only, the same way."""
        for name in ("stream.conf", "stream-capped.conf", "stream-deep.conf"):
            c = configparser.ConfigParser(interpolation=None)
            c.read(RECIPE / name)
            self.assertEqual(c["audio"]["gate"], "sink-input", name)
            self.assertEqual(c["audio"]["gate-tail-ms"], "3000", name)
            self.assertEqual(c["audio"]["gate-stops"], "sending", name)
            self.assertNotIn("gate-start", c["audio"], name)
            self.assertEqual(c["video"]["x264-aarch64"], "asm=NEON", name)
            self.assertNotIn("asm=", c["video"]["x264"], name)
            self.assertFalse([k for k in c["video"] if k.startswith("x264-") and k != "x264-aarch64"], name)


@unittest.skipUnless(HAVE_GST, "needs GStreamer 1.26 with x264enc")
class X264(unittest.TestCase):
    LINE = "threads=1 pass=qual quantizer=23 bitrate=8000 vbv-buf-capacity=150 option-string=vbv-maxrate=8000:vbv-bufsize=1200 " \
           "key-int-max=240 bframes=0 byte-stream=true tune=zerolatency speed-preset=ultrafast"

    def encode(self, line):
        p = Gst.parse_launch(f"videotestsrc num-buffers=60 pattern=ball ! video/x-raw,format=NV12,width=1280,height=720,framerate=60/1"
                             f" ! x264enc {line} ! appsink name=out emit-signals=false sync=false")
        out = p.get_by_name("out")
        p.set_state(Gst.State.PLAYING)
        h, n = hashlib.md5(), 0
        while True:
            s = out.emit("try-pull-sample", 5 * Gst.SECOND)
            if s is None:
                break
            b = s.get_buffer()
            h.update(b.extract_dup(0, b.get_size()))
            n += 1
        msg = p.get_bus().pop_filtered(Gst.MessageType.ERROR)
        p.set_state(Gst.State.NULL)
        self.assertIsNone(msg, msg and msg.parse_error()[0].message)
        self.assertEqual(n, 60)
        return h.hexdigest()

    def test_this_machine(self):
        v = {"x264": self.LINE, "x264-aarch64": "asm=NEON"}
        line = M.x264_line(v)
        self.assertEqual("asm=NEON" in line, ARM)
        self.encode(line)

    @unittest.skipUnless(ARM, "asm=NEON is for aarch64")
    def test_same_bytes(self):
        self.assertEqual(self.encode(self.LINE), self.encode(M.x264_line({"x264": self.LINE, "x264-aarch64": "asm=NEON"})))


CONF = """
[video]
capture = videotestsrc is-live=true pattern=ball ! video/x-raw,format=NV12,width=320,height=240,framerate=30/1
x264 = threads=1 key-int-max=30 bframes=0 byte-stream=true tune=zerolatency speed-preset=ultrafast
caps = video/x-h264,stream-format=byte-stream,profile=constrained-baseline
rtp = mtu=1200 config-interval=-1 aggregate-mode=zero-latency
[audio]
enabled = true
capture = audiotestsrc is-live=true wave=sine samplesperbuffer=240
encoder = opusenc bitrate=64000 frame-size=10 audio-type=generic
gate = sink-input
gate-tail-ms = 400
gate-stops = {stops}
[adapt]
enabled = false
"""


@unittest.skipUnless(HAVE_GST, "needs GStreamer 1.26 with x264enc and opusenc")
class Gate(unittest.TestCase):
    """The real Stream on one end of a socketpair; this test is desk-rtc on the other, and pactl is a stand-in script.
    gate-stops = sending (the default): the valve; GateCapture runs the same with the capture stopped instead."""
    STOPS = "sending"

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="desk-stream-sound-")
        self.fifo, self.list = os.path.join(self.dir, "events"), os.path.join(self.dir, "list")
        os.mkfifo(self.fifo)
        open(self.list, "w").close()
        pactl = os.path.join(self.dir, "pactl")
        with open(pactl, "w") as fh:
            fh.write(f'#!/bin/sh\nif [ "$1" = subscribe ]; then exec cat {self.fifo}; fi\ncat {self.list}\n')
        os.chmod(pactl, 0o755)
        M.PACTL = pactl
        self.events = os.open(self.fifo, os.O_RDWR)  # never blocks; closing it ends the stand-in's subscribe
        self.packets = []  # (monotonic ns at arrival, payload type, RTP timestamp)
        self.lock = threading.Lock()

    def tearDown(self):
        try:
            os.close(self.events)
        except OSError:
            pass

    def say(self, line):
        os.write(self.events, (line + "\n").encode())

    def run_stream(self, script, list_at_start=""):
        with open(self.list, "w") as fh:
            fh.write(list_at_start)
        cfg = configparser.ConfigParser(interpolation=None)
        cfg.read_string(CONF.format(stops=self.STOPS))
        ours, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        stream = M.Stream(cfg, theirs)
        stop = threading.Event()

        def reader():
            buf = b""
            ours.settimeout(0.2)
            while not stop.is_set():
                try:
                    data = ours.recv(65536)
                except socket.timeout:
                    continue
                if not data:
                    return
                now = time.monotonic_ns()
                buf += data
                while len(buf) >= 2 and len(buf) >= 2 + struct.unpack(">H", buf[:2])[0]:
                    n = struct.unpack(">H", buf[:2])[0]
                    pkt, buf = buf[2:2 + n], buf[2 + n:]
                    with self.lock:
                        self.packets.append((now, pkt[1] & 0x7F, struct.unpack(">I", pkt[4:8])[0]))

        def driver():
            try:
                script(ours)
            finally:
                GLib.idle_add(stream.quit, 0)

        threads = [threading.Thread(target=reader, daemon=True), threading.Thread(target=driver, daemon=True)]
        for t in threads:
            t.start()
        code = stream.start()
        stop.set()
        ours.close()
        theirs.close()
        return stream, code

    def window(self, seconds):
        """Packets that arrive over the next `seconds`: (audio, video) lists."""
        with self.lock:
            start = len(self.packets)
        time.sleep(seconds)
        with self.lock:
            got = self.packets[start:]
        return [p for p in got if p[1] == M.PT_OPUS], [p for p in got if p[1] == M.PT_H264]

    def lags_ms(self, audio):
        """Each sound packet's arrival less its RTP timestamp read as CLOCK_MONOTONIC at 48 kHz, in ms."""
        return [(((now * 48000 // 10**9) - ts) % 2**32) / 48 for now, _pt, ts in audio]

    def test_gate(self):
        r = {}

        def script(sock):
            sock.sendall(b"resume\n")
            r["quiet"] = self.window(1.2)
            self.say("Event 'new' on client #3")
            r["t_new"] = time.monotonic_ns()
            self.say("Event 'new' on sink-input #7")
            r["on"] = self.window(1.0)
            self.say("Event 'change' on sink-input #7")
            self.say("Event 'remove' on sink-input #7")
            r["tail"] = self.window(0.2)
            time.sleep(0.6)
            r["off"] = self.window(1.0)
            time.sleep(1.5)  # long enough apart that a stale packet from before would stand out
            self.say("Event 'new' on sink-input #8")
            r["again"] = self.window(1.0)
            sock.sendall(b"pause\n")
            time.sleep(0.3)
            r["warm"] = self.window(1.0)
            sock.sendall(b"resume\n")
            r["resumed"] = self.window(1.0)
            self.say("Event 'remove' on sink-input #8")
            time.sleep(1.0)
            os.close(self.events)  # pactl stops: sound runs all the time
            time.sleep(0.5)
            r["unwatched"] = self.window(1.0)

        _stream, code = self.run_stream(script)
        self.assertEqual(code, 0, M_LOG[-10:])
        a, v = r["quiet"]
        self.assertEqual(len(a), 0, "no sound before a stream")
        self.assertGreater(len(v), 20, "the picture runs")
        a, _ = r["on"]
        self.assertGreater(len(a), 70, "about 100 Opus packets a second once a stream appears")
        self.assertLess((a[0][0] - r["t_new"]) / 1e6, 150, "the first sound within 150 ms of the stream")
        lag = self.lags_ms(a)
        self.assertTrue(all(0 <= x < 100 for x in lag), f"timestamps on CLOCK_MONOTONIC: {min(lag):.1f} to {max(lag):.1f} ms behind")
        self.assertGreater(len(r["tail"][0]), 0, "the tail keeps sound a moment")
        self.assertEqual(len(r["off"][0]), 0, "no sound after the tail")
        a, _ = r["again"]
        lag = self.lags_ms(a)
        self.assertGreater(len(a), 70)
        # The valve keeps the encoder running, so its last part-frame from before the shut may come first, stamped then
        # (desk-rtc drops it past 2 s, a browser as late). Stopping the capture leaves nothing.
        stale = 1 if self.STOPS == "sending" else 0
        self.assertLessEqual(sum(1 for x in lag if not 0 <= x < 100), stale, f"nothing stale after a start: {max(lag):.1f} ms")
        self.assertTrue(all(0 <= x < 100 for x in lag[stale:]), f"then on the clock: {max(lag[stale:]):.1f} ms")
        self.assertEqual(len(r["warm"][0]), 0, "no sound while warm")
        self.assertEqual(len(r["warm"][1]), 0, "no picture while warm")
        a, _ = r["resumed"]
        self.assertGreater(len(a), 70, "sound again on resume while the stream is there")
        # With the valve the capture is paused and resumed with the pipeline, as before 0.3.3: its one stale packet after a
        # resume (ADR 0037, which desk-rtc drops) is still there.
        lag = self.lags_ms(a)
        self.assertLessEqual(sum(1 for x in lag if not 0 <= x < 100), stale)
        self.assertTrue(all(0 <= x < 100 for x in lag[stale:]))
        self.assertGreater(len(r["unwatched"][0]), 70, "pactl gone: sound runs as before 0.3.3")
        self.assertTrue(any("sound: on (stream #7)" in x for x in M_LOG), M_LOG[-10:])
        self.assertTrue(any("sound: off (no stream for 0.4 s)" in x for x in M_LOG), M_LOG[-10:])
        if self.STOPS == "sending":
            self.assertTrue(any("sent only while something plays" in x for x in M_LOG), M_LOG[-10:])

    @unittest.skipUnless(HAVE_GST and Gst.ElementFactory.find("pulsesrc"), "needs pulsesrc")
    def test_sink_of(self):
        """The sink whose clock a start restarts: the monitor's sink, and none for anything else."""
        src = Gst.ElementFactory.make("pulsesrc")
        src.set_property("device", "desk.monitor")
        self.assertEqual(M.SoundGate.sink_of(src), "desk")
        src.set_property("device", "alsa_input.mic")
        self.assertIsNone(M.SoundGate.sink_of(src))
        src.set_property("device", "a;b.monitor")
        self.assertIsNone(M.SoundGate.sink_of(src))
        self.assertIsNone(M.SoundGate.sink_of(Gst.ElementFactory.make("audiotestsrc")))
        self.assertEqual(src.get_property("source-output-index"), M.NO_STREAM)

    def test_stream_already_there(self):
        """A sink-input that's there before desk-stream starts (pactl list) opens the gate on resume."""
        r = {}

        def script(sock):
            time.sleep(0.3)
            sock.sendall(b"resume\n")
            r["on"] = self.window(1.0)

        _stream, code = self.run_stream(script, list_at_start="5\t0\t9\tprotocol-native.c\tfloat32le 2ch 48000Hz\n")
        self.assertEqual(code, 0, M_LOG[-10:])
        self.assertGreater(len(r["on"][0]), 70)


@unittest.skipUnless(HAVE_GST, "needs GStreamer 1.26 with x264enc and opusenc")
class GateCapture(Gate):
    """gate-stops = capture: the branch stopped and started from NULL (off by default; ADR 0073 addendum)."""
    STOPS = "capture"


if __name__ == "__main__":
    unittest.main(verbosity=2)
