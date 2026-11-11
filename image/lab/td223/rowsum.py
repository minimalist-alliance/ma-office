#!/usr/bin/python3 -I
"""rowsum.py <results dir> <label>... : one row of ADR 0036's test 1 on a shared host from lab.sh's files, in
image/lab/throttle/test1_shared_judge.py's shape (one JSON object per label on stdout), plus a line per slot for people (stderr).
The viewer (slot 1) from probe5's run file and the host's sampler; every other slot from shaperlog.jsonl over the probe's window:
each class's Mbit/s (median and max of its per-second rates), its drops, the guard's count (out_<k>) against the veth's, and the
budget's state as it went. TEST ONLY (lab/td223)."""
import json
import pathlib
import statistics
import sys

R = pathlib.Path(sys.argv[1])


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else None


for label in sys.argv[2:]:
    d = R / label
    run = json.loads(next(d.glob("run*-desk1.json")).read_text())
    t0 = float(run["args"]["startAt"]) / 1000
    secs = float(run["args"]["seconds"])
    s, lat, st = run.get("summary", {}), run.get("latency", {}).get("callback_ms", {}), run.get("stream", {})
    srv = {}
    for f in d.glob("server*.json"):
        try:
            srv = json.loads(f.read_text())
        except ValueError:
            pass
    cpu = (srv.get("desks_pct_of_one_core") or {}).get("desk1/desk-stream")
    lines = [json.loads(l) for l in (d / "shaperlog.jsonl").read_text().splitlines() if l.strip().startswith("{")]
    win = [l for l in lines if t0 <= l["t"] <= t0 + secs]
    viewer_1_10, v_mbps = None, []
    if len(win) >= 2:
        a, b = win[0]["1"]["cl"].get("10"), win[-1]["1"]["cl"].get("10")
        viewer_1_10 = (b[1] - a[1]) if a and b else None
        v_mbps = [(y["1"]["cl"]["10"][0] - x["1"]["cl"]["10"][0]) * 8 / 1e6 / (y["t"] - x["t"]) for x, y in zip(win, win[1:])
                  if "10" in x["1"]["cl"] and "10" in y["1"]["cl"] and y["t"] > x["t"]]
    row = {"name": label, "runs": 1, "samples_s": len(win),
           "viewer": {"fps_avg": s.get("page_fps"), "fps_p5": s.get("low5_seen"), "low5_page": s.get("low5_page"), "low5_stream": s.get("low5_stream"),
                      "stream_fps": s.get("stream_fps"), "stream_fps_p5": s.get("stream_fps_p5"), "gap_max_ms": s.get("gap_max_ms"),
                      "b12_p50_ms": lat.get("p50"), "b12_p95_ms": lat.get("p95"), "b12_n": lat.get("n"), "b13_p95_ms": None,
                      "rtp_dropped": st.get("packets_lost"), "tc_drops_1_10": viewer_1_10,
                      "stream_class_mbps": round(statistics.median(v_mbps), 2) if v_mbps else None, "stream_class_mbps_max": round(max(v_mbps), 2) if v_mbps else None, "stream_cpu_pct": cpu, "path": s.get("path"),
                      "failures": len(run.get("failures") or [])},
           "flooders": {}, "host": {}}
    slots = sorted({k for l in win for k in l if k.isdigit() and k != "1"}, key=int)
    for k in slots:
        rates = {m: [] for m in ("10", "15", "20")}
        on = all(all(m in l[k]["cl"] for m in rates) for l in win)
        for x, y in zip(win, win[1:]):
            dt = y["t"] - x["t"]
            for m in rates:
                if m in x[k]["cl"] and m in y[k]["cl"] and dt > 0:
                    rates[m].append((y[k]["cl"][m][0] - x[k]["cl"][m][0]) * 8 / 1e6 / dt)
        out = win[-1][k]["out"] - win[0][k]["out"]
        veth = win[-1][k]["veth_rx"] - win[0][k]["veth_rx"]
        drops = {m: (win[-1][k]["cl"][m][1] - win[0][k]["cl"][m][1]) if (m in win[-1][k]["cl"] and m in win[0][k]["cl"]) else None for m in rates}
        slowed = [round(l["t"] - t0) for x, l in zip(win, win[1:]) if l[k].get("slowed") and not x[k].get("slowed")]
        tx_mbps = [(y[k]["veth_rx"] - x[k]["veth_rx"]) * 8 / 1e6 / (y["t"] - x["t"]) for x, y in zip(win, win[1:]) if y["t"] > x["t"]]
        # the guard's 5-minute buckets as the host counts them (out_<k>), over the window: a 300 s row is one bucket
        bk = [(win[min(i + 300, len(win) - 1)][k]["out"] - win[i][k]["out"]) / 1e9 for i in range(0, max(1, len(win) - 1), 300)]
        f = {"shaper_on": on, "bucket_gb": [round(x, 4) for x in bk], "classes_mbps": {m: round(statistics.median(v), 2) if v else 0 for m, v in rates.items()},
             "classes_mbps_max": {m: round(max(v), 2) if v else 0 for m, v in rates.items()}, "drops": drops,
             "veth_mbps_median": round(statistics.median(tx_mbps), 2) if tx_mbps else None, "veth_mbps_max": round(max(tx_mbps), 2) if tx_mbps else None,
             "guard_tx_gb": round(out / 1e9, 4), "veth_tx_gb": round(veth / 1e9, 4), "slowed_at_s": slowed,
             "slowed_end": win[-1][k].get("slowed"), "bucket_gb_end": win[-1][k].get("level_gb"), "rate_bits_end": {m: v[2] for m, v in win[-1][k]["cl"].items()}}
        up = d / f"upload-{k}.json"
        if up.exists() and up.read_text().strip():
            try:
                u = json.loads(up.read_text().strip().splitlines()[-1])
                f["upload"] = {"mbps": u["mbps"], "secs": u["secs"], "per_s_median": statistics.median(u["per_s"]) if u["per_s"] else None}
            except (ValueError, KeyError):
                pass
        row["flooders"][f"D{k}"] = f
        print(f"{label} slot {k}: shaper {'on' if on else 'OFF'}; 1:10/1:15/1:20 median {f['classes_mbps']} max {f['classes_mbps_max']} Mbit/s; "
              f"veth median {f['veth_mbps_median']} max {f['veth_mbps_max']}; out_{k} {f['guard_tx_gb']} GB vs veth {f['veth_tx_gb']} GB; drops {drops}; "
              f"slowed at {slowed} s, end {f['slowed_end']}, bucket {f['bucket_gb_end']} GB", file=sys.stderr)
    v = row["viewer"]
    print(f"{label} viewer slot 1: page fps {v['fps_avg']}, stream {v['stream_fps']}; lowest 5 s window seen {v['fps_p5']} (page {v['low5_page']}, stream {v['low5_stream']}); gap max {v['gap_max_ms']} ms; input to frame "
          f"p50/p95 {v['b12_p50_ms']}/{v['b12_p95_ms']} ms (n={v['b12_n']}); its 1:10 {v['stream_class_mbps']} Mbit/s (max {v['stream_class_mbps_max']}); lost {v['rtp_dropped']}, 1:10 drops {v['tc_drops_1_10']}, desk-stream "
          f"{cpu}% of a core; {len(win)} one-second samples; path {v['path']}", file=sys.stderr)
    print(json.dumps(row))
