#!/usr/bin/python3 -I
"""fakertc2.py SECS: a stand-in for desk-rtc with one viewer, as uid 1101, for ADR 0036's profile change. It listens on
/run/desk-media/stream.sock and, like desk-rtc with someone viewing, sends `resume` and `keyframe` to each desk-stream that
connects. It keeps accepting, so a restart shows as a new connection. One JSON line at the end: each connection's first
packet, first keyframe, last packet, video packets and frames a second, and the gap the viewer saw at each restart."""
import json
import os
import select
import socket
import struct
import sys
import time

path, secs = "/run/desk-media/stream.sock", float(sys.argv[1])
if os.path.exists(path):
    os.unlink(path)
ln = socket.socket(socket.AF_UNIX)
ln.bind(path)
os.chmod(path, 0o666)
ln.listen(1)
t0 = time.monotonic()
conns, cur, buf = [], None, b""
print("listening", flush=True)


def ms():
    return round((time.monotonic() - t0) * 1000, 1)


while time.monotonic() - t0 < secs:
    socks = [ln] + ([cur["sock"]] if cur else [])
    r, _, _ = select.select(socks, [], [], 0.2)
    for s in r:
        if s is ln:
            c, _ = ln.accept()
            if cur:
                cur["sock"].close()
            cur = {"sock": c, "connect": ms(), "first": None, "firstKey": None, "last": None, "v": 0, "a": 0, "bytes": 0, "ts": set(), "eof": None}
            conns.append(cur)
            buf = b""
            c.sendall(b"resume\nkeyframe\n")
            continue
        d = s.recv(1 << 20)
        if not d:
            cur["eof"] = ms()
            s.close()
            cur = None
            continue
        buf += d
        while len(buf) >= 2:
            n = struct.unpack(">H", buf[:2])[0]
            if len(buf) < 2 + n:
                break
            p, buf = buf[2:2 + n], buf[2 + n:]
            now = ms()
            cur["first"] = cur["first"] or now
            cur["last"] = now
            cur["bytes"] += n
            if p[1] & 0x7F == 96:
                cur["v"] += 1
                cur["ts"].add(struct.unpack(">I", p[4:8])[0])
                nal = p[12] & 0x1F
                inner = p[13] & 0x1F if nal == 28 else p[15] & 0x1F if nal == 24 and len(p) > 15 else nal
                if inner in (5, 7) and cur["firstKey"] is None:
                    cur["firstKey"] = now
            elif p[1] & 0x7F == 111:
                cur["a"] += 1
out = []
for c in conns:
    c.pop("sock", None)
    dur = ((c["last"] or 0) - (c["first"] or 0)) / 1000
    c["fps"] = round(len(c.pop("ts")) / dur, 1) if dur > 0 else None
    c["mbps"] = round(c["bytes"] * 8 / 1e6 / dur, 2) if dur > 0 else None
    out.append(c)
gaps = [round(b["firstKey"] - a["last"], 1) for a, b in zip(out, out[1:]) if a["last"] and b["firstKey"]]
print(json.dumps({"connections": out, "gapsMs": gaps}), flush=True)
