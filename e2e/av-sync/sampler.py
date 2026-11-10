#!/usr/bin/python3 -I
"""sampler.py <seconds> <out.json> <x> <y>: test only, never shipped. The desk's own view of the sync clip.

Runs on the test desk as user `stream`, which has X access to :99 and the Pulse socket, in a transient unit the spec starts
and removes. Two GStreamer branches on one clock:
- a 4x4 patch of the X screen at (x, y), polled about 500 times a second: when the white box appears on the desk's screen;
- the Pulse sink's monitor, which is what desk-stream captures: when the tone starts there.
Times are CLOCK_REALTIME in ms. The desk's clock follows Amazon Time Sync (chrony), so the workstation compares its own
times against these after measuring its own offset.
"""
import json
import sys
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

LOUD = 1638  # 0.05 of full scale; the clip's tone is 0.5
QUIET_S = 0.3  # silence needed before an onset counts


def main():
    secs, out, x, y = float(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    Gst.init(None)
    p = Gst.parse_launch(
        f"ximagesrc display-name=:99 startx={x} starty={y} endx={x + 3} endy={y + 3} use-damage=false show-pointer=false"
        " ! video/x-raw,framerate=500/1 ! videoconvert ! video/x-raw,format=GRAY8"
        " ! appsink name=v emit-signals=true sync=false max-buffers=1000 drop=false "
        "pulsesrc device=desk.monitor buffer-time=20000 latency-time=5000 provide-clock=false"
        " ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=1"
        " ! appsink name=a emit-signals=true sync=false max-buffers=1000 drop=false"
    )
    clock = Gst.SystemClock.obtain()
    p.use_clock(clock)
    r = {"flashOn": [], "flashOff": [], "beeps": [], "videoSamples": 0, "audioBuffers": 0, "gaps": []}
    st = {"lum": None, "quiet": 0, "lastV": None}

    def real_ms(abs_ns):
        # CLOCK_MONOTONIC (the system clock's default) to CLOCK_REALTIME, read now: the two don't drift apart in 90 s.
        return (abs_ns + (time.time_ns() - clock.get_time())) / 1e6

    def on_v(sink):
        s = sink.emit("pull-sample")
        b = s.get_buffer()
        ok, m = b.map(Gst.MapFlags.READ)
        lum = sum(m.data) / max(1, len(m.data))
        b.unmap(m)
        t = real_ms(p.get_base_time() + b.pts)
        r["videoSamples"] += 1
        if st["lastV"] is not None and len(r["gaps"]) < 20000:
            r["gaps"].append(round(t - st["lastV"], 2))
        st["lastV"] = t
        if st["lum"] is not None:
            if lum > 128 >= st["lum"]:
                r["flashOn"].append(round(t, 2))
            elif lum <= 128 < st["lum"]:
                r["flashOff"].append(round(t, 2))
        st["lum"] = lum
        return Gst.FlowReturn.OK

    def on_a(sink):
        s = sink.emit("pull-sample")
        b = s.get_buffer()
        ok, m = b.map(Gst.MapFlags.READ)
        data = memoryview(m.data).cast("h")
        t0 = p.get_base_time() + b.pts
        r["audioBuffers"] += 1
        q = st["quiet"]
        for i, v in enumerate(data):
            if v > LOUD or v < -LOUD:
                if q >= QUIET_S * 48000:
                    r["beeps"].append(round(real_ms(t0 + i * 1_000_000_000 // 48000), 2))
                q = 0
            else:
                q += 1
        st["quiet"] = q
        b.unmap(m)
        return Gst.FlowReturn.OK

    p.get_by_name("v").connect("new-sample", on_v)
    p.get_by_name("a").connect("new-sample", on_a)
    loop = GLib.MainLoop()
    bus = p.get_bus()
    bus.add_signal_watch()
    bus.connect("message::error", lambda _b, msg: (r.setdefault("error", msg.parse_error()[0].message), loop.quit()))
    if p.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        r["error"] = "pipeline would not start"
    else:
        GLib.timeout_add(int(secs * 1000), loop.quit)
        loop.run()
    p.set_state(Gst.State.NULL)
    gaps = sorted(r.pop("gaps"))
    r["pollMs"] = {"p50": gaps[len(gaps) // 2], "p99": gaps[int(len(gaps) * 0.99)], "max": gaps[-1]} if gaps else None
    with open(out, "w") as f:
        json.dump(r, f)


if __name__ == "__main__":
    main()
