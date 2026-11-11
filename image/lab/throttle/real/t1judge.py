#!/usr/bin/python3 -I
"""t1judge.py <results dir> <label prefix> [--rows noshaper,idle,kiosk,empty]: ADR 0036 section 6 test 1 on a desk of its own,
judged from real.sh's runs. TEST ONLY; it reads numbers. Per row, the median over its repeats (proof2.mjs's run*.json, through
../../../../spikes/browser-bench/real-stack/summarize.py's metrics), the 1:10 class's drops from tc around each run, and the
largest `rtpDropped` rtctap.py saw for any session in it. The first row is the baseline (no shaper). Pass, per section 6:
  page fps        within 0.5 of the baseline: the kiosk's scroll rAF and the video page's presented frames (also the client's
                  decoded fps, reported)
  B12             callback p50 within 3 ms of the baseline, and p50 <= 90 and p95 <= 150 ms, idle and with video playing
  B13             warm to live, callback p95 <= 300 ms
  1:10 and RTP    no drop on 1:10 in any run, rtpDropped 0 in every run
  CPU             desk-stream's CPU (% of one core) within 1 point of the baseline, scroll and video (the addendum's reading);
                  the machine's is reported beside it, and a row's own sender (the flood, the upload) is in the machine's
Prints a table and a verdict per rule and row; writes <results dir>/<prefix>-judged.json."""
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../../spikes/browser-bench/real-stack"))
from summarize import metrics  # noqa: E402


def med(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(statistics.median(xs), 2) if xs else None


def g(d, *p):
    for k in p:
        d = d.get(k) if isinstance(d, dict) else None
    return d


def row(root, label):
    d = os.path.join(root, label)
    runs = sorted(glob.glob(os.path.join(d, "run*.json")))
    rs = [json.load(open(f)) for f in runs]
    ms = [metrics(r) for r in rs]
    out = {"n": len(rs), "failures": sum(len(r.get("failures", [])) for r in rs)}
    for k in ("scroll_kiosk_raf", "video_kiosk_presented", "scroll_fps", "video_fps", "lat_idle_cb_p50", "lat_idle_cb_p95", "lat_load_cb_p50",
              "lat_load_cb_p95", "b13_cb_p50", "b13_cb_p95", "scroll_cpu", "video_cpu", "video_gbh", "scroll_gbh", "scroll_freezes", "video_freezes"):
        out[k] = med([m[k] for m in ms])
        out[k + "_all"] = [m[k] for m in ms]
    for seg, key in (("scroll", "scroll_stream_cpu"), ("video", "video_stream_cpu")):
        vals = [g(r, "phases", seg, "server", "units_pct_of_one_core", "desk-stream") for r in rs]
        out[key], out[key + "_all"] = med(vals), vals
    lost = [(g(r, "phases", "video", "packets_lost") or 0) + (g(r, "phases", "scroll", "packets_lost") or 0) for r in rs]
    out["client_packets_lost_all"] = lost
    drops, rtp, cls = [], [], []
    for i in range(1, len(rs) + 1):
        try:
            a, b = json.load(open(os.path.join(d, f"tc-before-{i}.json"))), json.load(open(os.path.join(d, f"tc-after-{i}.json")))
            drops.append(b["1:10"]["drops"] - a["1:10"]["drops"] if "1:10" in b and "1:10" in a else None)
            cls.append({h: {"MB": round((b[h]["bytes"] - a.get(h, {}).get("bytes", 0)) / 1e6, 1), "drops": b[h]["drops"] - a.get(h, {}).get("drops", 0),
                            "rateMbit": b[h]["rate"] / 1e6} for h in b})
        except (OSError, ValueError):
            drops.append(None)
            cls.append(None)
        mx, seen = 0, 0
        try:
            for line in open(os.path.join(d, f"rtctap-{i}.jsonl")):
                j = json.loads(line)
                for s in j.get("sessions", []):
                    seen += 1
                    mx = max(mx, s.get("rtpDropped") or 0)
        except OSError:
            seen = None
        rtp.append({"max": mx, "rows": seen})
    out["tc_drops_1_10_all"], out["rtp_dropped_all"], out["classes_all"] = drops, rtp, cls
    return out


def judge(r, base):
    v = []

    def chk(name, ok, detail):
        v.append({"rule": name, "pass": bool(ok), "detail": detail})

    for k, nm in (("scroll_kiosk_raf", "scroll page fps"), ("video_kiosk_presented", "video page presented fps")):
        chk(f"{nm} within 0.5 of no shaper", r[k] is not None and base[k] is not None and r[k] >= base[k] - 0.5, f"{r[k]} vs {base[k]} ({r[k + '_all']})")
    for k, nm in (("lat_idle_cb", "B12 idle"), ("lat_load_cb", "B12 video playing")):
        p50, p95, b50 = r[k + "_p50"], r[k + "_p95"], base[k + "_p50"]
        chk(f"{nm} p50 within 3 ms of no shaper", p50 is not None and p50 <= b50 + 3, f"{p50} vs {b50} ({r[k + '_p50_all']})")
        chk(f"{nm} p50 <= 90 and p95 <= 150", p50 is not None and p50 <= 90 and p95 <= 150, f"{p50}/{p95}")
    chk("B13 warm to live p95 <= 300 ms", r["b13_cb_p95"] is not None and r["b13_cb_p95"] <= 300, f"{r['b13_cb_p95']} (p50 {r['b13_cb_p50']})")
    d = r["tc_drops_1_10_all"]
    chk("no drop on 1:10", bool(d) and all(x == 0 for x in d), f"{d}")
    chk("rtpDropped 0", bool(r["rtp_dropped_all"]) and all(x["max"] == 0 and x["rows"] for x in r["rtp_dropped_all"]), f"{r['rtp_dropped_all']}")
    for seg in ("scroll", "video"):
        a, b = r[f"{seg}_stream_cpu"], base[f"{seg}_stream_cpu"]
        chk(f"desk-stream CPU within 1 point of no shaper, {seg}", a is not None and b is not None and a <= b + 1, f"{a} vs {b} (% of one core; machine {r[seg + '_cpu']} vs {base[seg + '_cpu']} %)")
    return v


if __name__ == "__main__":
    root, prefix = sys.argv[1], sys.argv[2]
    names = (sys.argv[sys.argv.index("--rows") + 1] if "--rows" in sys.argv else "noshaper,idle,kiosk,empty").split(",")
    rows = {n: row(root, f"{prefix}-{n}") for n in names}
    base = rows[names[0]]
    res = {"rows": rows, "verdicts": {}}
    keys = ("n", "failures", "scroll_kiosk_raf", "video_kiosk_presented", "scroll_fps", "video_fps", "lat_idle_cb_p50", "lat_idle_cb_p95",
            "lat_load_cb_p50", "lat_load_cb_p95", "b13_cb_p50", "b13_cb_p95", "scroll_stream_cpu", "video_stream_cpu", "scroll_cpu", "video_cpu", "video_gbh")
    print("row".ljust(10) + "".join(k[:14].rjust(15) for k in keys))
    for n in names:
        print(n.ljust(10) + "".join(str(rows[n][k]).rjust(15) for k in keys))
    ok = True
    for n in names[1:]:
        res["verdicts"][n] = judge(rows[n], base)
        print(f"== {n}")
        for x in res["verdicts"][n]:
            print(f"  {'PASS' if x['pass'] else 'FAIL'}  {x['rule']}  [{x['detail']}]")
            ok = ok and x["pass"]
    print("== the baseline's own 1:10 and RTP:", base["tc_drops_1_10_all"], base["rtp_dropped_all"])
    print("OVERALL", "PASS" if ok else "FAIL")
    json.dump(res, open(os.path.join(root, f"{prefix}-judged.json"), "w"), indent=1)
