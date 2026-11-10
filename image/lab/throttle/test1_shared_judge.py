#!/usr/bin/python3 -I
"""test1_shared_judge.py rows.json [--b13-budget-ms N] [--b12-p50-ms 90] [--b12-p95-ms 150]: ADR 0036 section 6 test 1 on a shared host
(addendum 2026-11-09, "Test 1 on a shared host"), judged. TEST ONLY; it only reads numbers, it touches no desk.

rows.json is a list of rows, the first named "R0" (every desk quiet, D1 streaming video). A row:
  {"name": "R2", "runs": 3,
   "viewer": {"fps_avg": 59.6, "fps_p5": 58, "b12_p50_ms": 70, "b12_p95_ms": 110, "b13_p95_ms": 66, "rtp_dropped": 0,
              "tc_drops_1_10": 0, "stream_cpu_pct": 55},
   "flooders": {"D2": {"bucket_gb": [3.7, 3.8], "veth_tx_gb": 7.5, "guard_tx_gb": 7.52, "classes_mbps": {"10": 0, "15": 1.9, "20": 99.8},
                       "shaper_on": true}},
   "host": {"nic_bucket_gb": [18.9, 19.2], "steal_pct": 0.1}}
viewer numbers are the medians over the row's runs (spikes/browser-bench/real-stack/summarize.py names, renamed here), and each
flooder's bucket_gb are its slot's 5-minute buckets as the host counted them. The verdicts:
  viewer  fps_avg within 0.5 of R0; fps_p5 at least 30 (task 46's floor); B12 p50 within 3 ms of R0 and inside the budget;
          B13 p95 inside its budget; rtp_dropped 0; tc_drops_1_10 0; stream CPU within 1 point of R0
  flooder every bucket at most 6.3 GB (the ceiling's 6.1 plus the two bursts), under ADR 0036's 7 GB flag line; its 15 minutes
          at most 19 GB, classes at their ceilings
          (1:10 60, 1:15 2, 1:20 100 Mbps, 3% tolerance); the guard's count (slot_net) within 5% of the veth's; shaper_on
  host    the host's NIC bucket under the sum of the flooders' ceilings (163 Mbps each, 6.1 GB a bucket)
Exit 0 if every row passes."""
import json
import sys

CEIL = {"10": 60.0, "15": 2.0, "20": 100.0}
BUCKET_GB_MAX = 6.3
FIFTEEN_GB_MAX = 19.0
FLAG_GB = 7.0


def judge_row(row, base, b12_p50, b12_p95, b13):
    out = []

    def check(name, ok, detail):
        out.append((name, bool(ok), detail))

    v, b = row["viewer"], base["viewer"]
    check("viewer fps within 0.5 of R0", v["fps_avg"] >= b["fps_avg"] - 0.5, f"{v['fps_avg']} vs {b['fps_avg']}")
    check("viewer fps_p5 at the 30 fps floor", v["fps_p5"] >= 30, f"{v['fps_p5']}")
    check("viewer B12 p50 within 3 ms of R0", v["b12_p50_ms"] <= b["b12_p50_ms"] + 3, f"{v['b12_p50_ms']} vs {b['b12_p50_ms']}")
    check("viewer B12 p50 and p95 in budget", v["b12_p50_ms"] <= b12_p50 and v["b12_p95_ms"] <= b12_p95, f"{v['b12_p50_ms']}/{v['b12_p95_ms']}")
    if b13 is not None:
        check("viewer B13 p95 in budget", v["b13_p95_ms"] <= b13, f"{v['b13_p95_ms']}")
    check("viewer rtpDropped 0 and no drops on 1:10", v["rtp_dropped"] == 0 and v["tc_drops_1_10"] == 0, f"{v['rtp_dropped']}/{v['tc_drops_1_10']}")
    check("viewer stream CPU within 1 point of R0", v["stream_cpu_pct"] <= b["stream_cpu_pct"] + 1, f"{v['stream_cpu_pct']} vs {b['stream_cpu_pct']}")
    flooders = row.get("flooders", {})
    for desk, f in sorted(flooders.items()):
        bk = f["bucket_gb"]
        check(f"{desk} shaper on", f.get("shaper_on") is True, str(f.get("shaper_on")))
        check(f"{desk} every bucket at most {BUCKET_GB_MAX} GB (flag line {FLAG_GB})", bool(bk) and max(bk) <= BUCKET_GB_MAX, f"max {max(bk) if bk else None}")
        three = max((sum(bk[i:i + 3]) for i in range(max(1, len(bk) - 2))), default=0)
        check(f"{desk} 15 minutes at most {FIFTEEN_GB_MAX} GB (fast stop 30)", three <= FIFTEEN_GB_MAX, f"{three:.2f}")
        for minor, want in CEIL.items():
            got = f["classes_mbps"].get(minor, 0)
            check(f"{desk} class 1:{minor} at most {want} Mbps", got <= want * 1.03, f"{got}")
        check(f"{desk} guard count within 5% of the veth", abs(f["guard_tx_gb"] - f["veth_tx_gb"]) <= 0.05 * max(f["veth_tx_gb"], 1e-9), f"{f['guard_tx_gb']} vs {f['veth_tx_gb']}")
    if flooders:
        ceiling_gb = 6.1 * len(flooders) + 1.0  # the viewer's own stream and the quiet desks
        check("host NIC bucket under the flooders' ceilings together", max(row["host"]["nic_bucket_gb"]) <= ceiling_gb, f"{max(row['host']['nic_bucket_gb'])} vs {ceiling_gb:.1f}")
    return out


def main(argv):
    path = argv[1]
    arg = lambda name, default: float(argv[argv.index(name) + 1]) if name in argv else default
    rows = json.load(open(path))
    base = rows[0]
    if base["name"] != "R0":
        raise SystemExit("the first row must be R0")
    ok = True
    for row in rows[1:]:
        print(f"== {row['name']}")
        for name, passed, detail in judge_row(row, base, arg("--b12-p50-ms", 90.0), arg("--b12-p95-ms", 150.0), arg("--b13-budget-ms", None) if "--b13-budget-ms" in argv else None):
            print(f"  {'PASS' if passed else 'FAIL'}  {name}  [{detail}]")
            ok = ok and passed
    print("OVERALL", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
