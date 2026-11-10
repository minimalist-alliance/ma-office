#!/usr/bin/env python3
"""Prints the load test's results as the README's markdown table: python3 table.py [results]."""
import json
import os
import sys

ROWS = [
    ("m50-t10", "50", "10", "yes"),
    ("m100-t10", "100", "10", "yes"),
    ("m200-t10", "200", "10", "yes"),
    ("m200-t10-voiceonly", "200", "10", "no"),
    ("m200-t3", "200", "3", "yes"),
    ("m200-t20", "200", "20 (10 heard)", "yes"),
    ("m200-t0-idle", "200", "0, all muted", "no"),
    ("m200-t10-chat", "200", "10", "yes, and chat"),
]

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "results")
print("| In the room | Talking | Board activity | Server CPU, cores (peak second) | Memory | Network in | Network out | Packets out/s | Voice through the server, p50 / p99 | Strokes through the server, p50 / p99 |")
print("|---|---|---|---|---|---|---|---|---|---|")
for label, n, talk, board in ROWS:
    p = os.path.join(d, label + ".json")
    if not os.path.exists(p):
        continue
    r = json.load(open(p))
    s = r["server"]
    v = r["voiceThroughServerMs"]
    w = r["drawThroughServerMs"]
    voice = f"{v['p50']} / {v['p99']} ms" if v["p50"] else "–"
    draw = f"{w['p50']} / {w['p99']} ms" if w["p50"] else "–"
    print(
        f"| {n} | {talk} | {board} | {s['cpuPercentOfOneCore'] / 100:.2f} ({s['cpuPercentPeakSecond'] / 100:.2f}) "
        f"| {s['rssMiB']:.0f} MiB | {s['netInMbps']:.1f} Mb/s | {s['netOutMbps']:.1f} Mb/s | {s['netOutPktsPerSec']:,.0f} "
        f"| {voice} | {draw} |"
    )

for label, *_ in ROWS:
    p = os.path.join(d, label + ".json")
    if os.path.exists(p):
        c = json.load(open(p)).get("chatThroughServerMs") or {}
        if c.get("p50"):
            print(f"\n{label}: chat messages through the server {c['p50']} / {c['p99']} ms (p50 / p99), "
                  f"{json.load(open(p))['client'].get('chatInPerSec', 0):.0f} delivered a second to these {json.load(open(p))['members']} members")
