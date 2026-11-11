#!/usr/bin/python3 -I
"""up.py HOST PORT SECS [--pace-mbps N]: one ordinary TCP upload to net.py's tcp-sink (the 'U' mode), as fast as the path and the
shaper let it, or paced; its throughput each second. One JSON line; no address printed. TEST ONLY (lab/td223)."""
import json
import socket
import sys
import time

host, port, secs = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
pace = float(sys.argv[sys.argv.index("--pace-mbps") + 1]) if "--pace-mbps" in sys.argv else 0
s = socket.create_connection((host, port), timeout=15)
if pace:
    s.setsockopt(socket.SOL_SOCKET, 47, int(pace * 1e6 / 8))   # SO_MAX_PACING_RATE
s.sendall(b"U".ljust(16))
chunk, n, t0, per, last, lastn = b"\0" * (1 << 16), 0, time.monotonic(), [], time.monotonic(), 0
s.settimeout(5)
while True:
    now = time.monotonic()
    if now - t0 >= secs:
        break
    try:
        n += s.send(chunk)
    except socket.timeout:
        pass
    if now - last >= 1:
        per.append(round((n - lastn) * 8 / 1e6 / (now - last), 2))
        last, lastn = now, n
el = time.monotonic() - t0
s.close()
print(json.dumps({"bytes": n, "secs": round(el, 1), "mbps": round(n * 8 / 1e6 / el, 2), "per_s": per}))
