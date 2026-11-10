#!/usr/bin/python3 -I
"""sample.py <seconds>: machine CPU and per-unit CPU and memory over an interval, as JSON. Test only."""
import json, os, sys, time
UNITS = ["desk-stream", "desk-rtc", "desk-browser", "desk-xorg", "desk-audio"]
def cg(u, f):
    with open(f"/sys/fs/cgroup/system.slice/{u}.service/{f}") as fh:
        return fh.read()
def usage(u):
    try:
        for line in cg(u, "cpu.stat").splitlines():
            k, v = line.split()
            if k == "usage_usec":
                return int(v)
    except OSError:
        return 0
    return 0
def mem(u):
    try:
        return round(int(cg(u, "memory.current")) / 1e6)
    except OSError:
        return 0
def stat():
    v = list(map(int, open("/proc/stat").readline().split()[1:9]))
    return v[3] + v[4], sum(v), v[7]
secs = float(sys.argv[1])
i0, t0, s0 = stat(); u0 = {u: usage(u) for u in UNITS}; w0 = time.monotonic()
series = []
pi, pt, _ = i0, t0, s0
for _ in range(int(secs)):
    time.sleep(1)
    i, t, _s = stat()
    series.append(round(100 * (1 - (i - pi) / max(1, t - pt)), 1))
    pi, pt = i, t
rest = secs - int(secs)
if rest > 0:
    time.sleep(rest)
i1, t1, s1 = stat(); w = time.monotonic() - w0
print(json.dumps({
    "seconds": round(w, 1), "machine_pct": round(100 * (1 - (i1 - i0) / max(1, t1 - t0)), 1), "steal_pct": round(100 * (s1 - s0) / max(1, t1 - t0), 2),
    "series": series, "units_pct_of_one_core": {u: round((usage(u) - u0[u]) / 1e6 / w * 100, 1) for u in UNITS}, "units_mem_mb": {u: mem(u) for u in UNITS},
}))
