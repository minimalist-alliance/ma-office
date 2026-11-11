#!/usr/bin/python3 -I
"""S-29: a new desk-stream told a level other than its [video] line's, as desk-rtc tells it first thing on connecting, then
`resume` at once. On a real desk (deskcap, 2026-11-11) `level max` then `resume` failed two starts in a row with x264enc's
"encoder not initialized", and systemd's restarts took the picture away for 3.8 s.

Runs the real desk-stream and the real deskcap on an Xvfb of its own, in Debian 13's GStreamer (as test_desk_stream_damage.py
builds deskcap). Each trial: a fresh desk-stream on stream.conf (or $CONF), warm, then the two lines, then 2 s of frames.
  python3 -I image/lab/s29/repro_start_level.py [trials]     # prints each trial and a summary
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.join(HERE, "..", "..", "tests")
sys.path.insert(0, TESTS)
os.environ.setdefault("DISPLAY_FOR_TEST", ":77")
xvfb = subprocess.Popen(["Xvfb", ":77", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.0)
try:
    import test_desk_stream_damage as D  # builds deskcap and puts it on GST_PLUGIN_PATH
    import test_desk_stream_levels as L
    assert D.HAVE_X and L.HAVE_GST, "needs deskcap built, Xvfb and GStreamer 1.26"
    trials = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    conf_name = os.environ.get("CONF", "stream.conf")
    results = {}
    x = D.X(":77")
    for level in ("high", "max", "medium", "low"):
        for i in range(trials):
            cfg = L.conf(conf_name)
            cfg["video"]["capture"] = "deskcap display-name=:77 max-fps=60 heartbeat-max-ms=1000 ! video/x-raw,format=NV12"
            cfg["audio"]["enabled"] = "false"
            start = time.monotonic()
            d = L.Desk(cfg)
            # As desk-rtc's attach writes them: the level, resume, then a keyframe, back to back.
            t = time.monotonic()
            d.sock.sendall(f"level {level}\nresume\nkeyframe\n".encode())
            # Something moving, so frames come at 60 a second.
            end = time.monotonic() + 2.0
            k = 0
            while time.monotonic() < end:
                k += 1
                x.fill(0xff0000 if k % 2 else 0x0000ff, 100, 100, 400, 300)
                time.sleep(1 / 60)
            errors = [line for when, line in L.LOG if when >= start and "error" in line]
            frames = len(d.rx.window(t, time.monotonic()))
            ok = d.stream.exit_code == 0 and not errors and frames > 30
            results.setdefault(level, []).append(ok)
            print(f"{conf_name} level {level} trial {i + 1}: {'ok' if ok else 'FAILED'}, {frames} frames in 2 s, exit {d.stream.exit_code}, errors {errors[:1]}", flush=True)
            try:
                d.stop()
            except AssertionError as e:
                print(f"  stop: {e}", flush=True)
    print("summary:", {k: f"{sum(v)} of {len(v)} ok" for k, v in results.items()}, flush=True)
    sys.exit(0 if all(all(v) for v in results.values()) else 1)
finally:
    xvfb.terminate()
