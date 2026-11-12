#!/usr/bin/python3 -I
"""rowmerge.py <results dir> <rows.jsonl> [--nic <nic.json>] > rows.json: ADR 0036's test 1 on a shared host, the repeats of each row
merged into one row for image/lab/throttle/test1_shared_judge.py (a list starting with R0). rows.jsonl is rowsum.py's output, one
line per repeat, labelled <row>-<n> (R0-1, R0-2, ...); a label with a letter after the number (R1-2b) is a rerun and merges as its own
row (R1b). TEST ONLY (lab/td223); it reads numbers.
  viewer     medians over the repeats; loss and the 1:10 drops are the largest of any repeat (the rule is 0 in every run); B13 is
             probe5's first frame after `live` (first_frame.firstCbMs), its p95 over the repeats (nearest rank: of 3, the largest);
             freezes and the client's dropped frames are summed
  flooders   shaper_on in every repeat; every repeat's window bucket in bucket_gb; each class's median over the repeats; the guard's
             and the veth's bytes summed
  host       nic_bucket_gb from --nic ({"<label>": [GB, ...]}: CloudWatch NetworkOut's 5-minute sums over each repeat), else []"""
import json
import pathlib
import re
import statistics
import sys

args = sys.argv[1:]
nic = {}
if "--nic" in args:
    i = args.index("--nic")
    nic = json.load(open(args[i + 1]))
    del args[i:i + 2]
R, rows_file = pathlib.Path(args[0]), args[1]


def med(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(statistics.median(xs), 2) if xs else None


def mx(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return max(xs) if xs else None


groups = {}
for line in open(rows_file):
    if not line.strip().startswith("{"):
        continue
    r = json.loads(line)
    m = re.fullmatch(r"(R\d+)-(\d+)([a-z]?)", r["name"])
    if not m:
        continue
    groups.setdefault(m.group(1) + m.group(3), []).append(r)

out = []
for name in sorted(groups, key=lambda n: (int(re.search(r"\d+", n).group()), n)):
    reps = sorted(groups[name], key=lambda r: r["name"])
    extra = []
    for r in reps:
        run = json.loads(next((R / r["name"]).glob("run*-desk1.json")).read_text())
        s = run.get("summary", {})
        extra.append({"b13_ms": (run.get("first_frame") or {}).get("firstCbMs"), "freezes": s.get("freezes"), "client_dropped": s.get("client_dropped"),
                      "lat_p50": s.get("lat_p50")})
    vs = [r["viewer"] for r in reps]
    keys = ["fps_avg", "fps_p5", "low5_page", "low5_stream", "stream_fps", "stream_fps_p5", "gap_max_ms", "b12_p50_ms", "b12_p95_ms",
            "stream_class_mbps", "stream_cpu_pct"]
    viewer = {k: med([v.get(k) for v in vs]) for k in keys}
    b13 = [e["b13_ms"] for e in extra]
    viewer.update({"rtp_dropped": mx([v.get("rtp_dropped") for v in vs]), "tc_drops_1_10": mx([v.get("tc_drops_1_10") for v in vs]),
                   "b13_p95_ms": max([x for x in b13 if isinstance(x, (int, float))], default=None), "b13_ms": b13,
                   "freezes": sum(e["freezes"] or 0 for e in extra), "client_dropped": sum(e["client_dropped"] or 0 for e in extra),
                   "failures": sum(v.get("failures") or 0 for v in vs),
                   "per_repeat": {r["name"]: {"fps_avg": v.get("fps_avg"), "fps_p5": v.get("fps_p5"), "b12_p50_ms": v.get("b12_p50_ms"),
                                              "b12_p95_ms": v.get("b12_p95_ms"), "stream_cpu_pct": v.get("stream_cpu_pct"), "b13_ms": e["b13_ms"],
                                              "rtp_dropped": v.get("rtp_dropped"), "freezes": e["freezes"]} for r, v, e in zip(reps, vs, extra)}})
    flooders = {}
    for d in sorted({d for r in reps for d in r.get("flooders", {})}):
        fs = [r["flooders"][d] for r in reps if d in r.get("flooders", {})]
        flooders[d] = {"shaper_on": all(f.get("shaper_on") is True for f in fs),
                       "bucket_gb": [b for f in fs for b in f.get("bucket_gb", [])],
                       "classes_mbps": {m: med([f["classes_mbps"].get(m) for f in fs]) for m in ("10", "15", "20")},
                       "classes_mbps_max": {m: mx([f["classes_mbps_max"].get(m) for f in fs]) for m in ("10", "15", "20")},
                       "drops": {m: sum((f.get("drops") or {}).get(m) or 0 for f in fs) for m in ("10", "15", "20")},
                       "veth_mbps_median": med([f.get("veth_mbps_median") for f in fs]),
                       "guard_tx_gb": round(sum(f["guard_tx_gb"] for f in fs), 4), "veth_tx_gb": round(sum(f["veth_tx_gb"] for f in fs), 4),
                       "slowed_at_s": [f.get("slowed_at_s") for f in fs], "slowed_end": [f.get("slowed_end") for f in fs]}
    host = {"nic_bucket_gb": [b for r in reps for b in nic.get(r["name"], [])]}
    out.append({"name": name, "runs": len(reps), "repeats": [r["name"] for r in reps], "viewer": viewer, "flooders": flooders, "host": host})

if not out or out[0]["name"] != "R0":
    raise SystemExit("no R0 rows: the judge needs R0 first")
json.dump(out, sys.stdout, indent=1)
print()
