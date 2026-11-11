#!/usr/bin/python3 -I
"""The live profile test's rows (e2e/w3/profile.spec.ts), one per phase, from each run's profile.json.
  python3 -I image/lab/s29/summarize.py <profile.json>...
"""
import json
import sys


def f(v, nd=1):
    return "" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


print("| Run | Phase | Page fps: n, avg, p5, min | Decoded fps: avg, p5, min (s) | Mbit/s | Pause ms | Decoded 30+ again, ms after | Reply, ms after the command | Freezes (s), lost |")
print("|---|---|---|---|---:|---:|---:|---|---|")
for path in sys.argv[1:]:
    r = json.load(open(path))
    for p in r["phases"]:
        pg, c = p["page"], p["client"]
        fr = p.get("frames") or {}
        back = fr.get("decodedBackAt30AfterGapMs", fr.get("backAt60AfterGapMs"))
        reply = p.get("reply")
        rep = f"{reply['text']}, {reply['afterCommandMs']}" if reply else ""
        print(f"| {r['label']} | {p['name']} | {pg['samples']}, {f(pg['avg'])}, {f(pg['p5'])}, {f(pg['min'])} | "
              f"{f(c['decodedFps'])}, {f(c['decodedP5'])}, {f(c['decodedMin'])} ({f(c['seconds'])}) | {f(c['mbps'], 2)} | "
              f"{f(fr.get('longestGapMs'))} | {f(back) if p['kind'] == 'switch' else ''} | {rep} | {c['freezes']} ({f(c['freezeSeconds'], 3)}), {c['packetsLost']} |")
