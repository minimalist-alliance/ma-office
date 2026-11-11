#!/usr/bin/python3 -I
"""S-29 / 16 D item 2: desk-egress's real Budget class on a fake clock, by the minute, as the weekend review's simulation did.

  python3 -I image/lab/s29/sim.py <path to a desk-egress> [--json out.json]

Viewers sit at their encoder's hard cap the whole time (ADR 0036 section 1: a viewer at High's cap 3.75 GB/h, capped 1.89,
deep 1.20; Max 5.55, Medium 1.89, Low 1.20), every class sends what its kernel ceiling lets it, so a clamp or a profile
feeds back, and an upload goes out on 1:20 at its class's rate (100 Mbit, or 0.75 slowed). Each run starts at 00:00 on the
1st of a 31-day month, so the month line (100 GB) can't step the stream down first: the day lines are all there is.

`levels` says what the capped and deep profiles do with the member's level: "ignore" (desk-stream 0.3.3 and before: the
capped conf has no levels, so every level is the capped picture) or "honour" (S-29: within the cap, so Low stays Low).
The guard's `day` stop is 150 GB of everything in 24 h (ADR 0082); this reports the first hour any 24 h reached it.
"""
import calendar
import importlib.machinery
import importlib.util
import json
import sys

GB = 10**9
OCT1 = calendar.timegm((2026, 10, 1, 0, 0, 0))
PER_VIEWER = {  # GB/h at the hard cap, by level, under each profile
    "ignore": {"normal": {"low": 1.20, "medium": 1.89, "high": 3.75, "max": 5.55},
               "capped": {"low": 1.89, "medium": 1.89, "high": 1.89, "max": 1.89},
               "deep": {"low": 1.20, "medium": 1.20, "high": 1.20, "max": 1.20}},
    "honour": {"normal": {"low": 1.20, "medium": 1.89, "high": 3.75, "max": 5.55},
               "capped": {"low": 1.20, "medium": 1.89, "high": 1.89, "max": 1.89},
               "deep": {"low": 1.20, "medium": 1.20, "high": 1.20, "max": 1.20}},
}
DAY_STOP_GB = 150
BASELINE_GBH = 0.03  # ADR 0036's small other traffic


def load(path):
    loader = importlib.machinery.SourceFileLoader("desk_egress_sim", path)
    spec = importlib.util.spec_from_loader("desk_egress_sim", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    mod.log = lambda *a, **k: None
    return mod


def run(E, viewers=0, level="high", levels="honour", uploads=(), other_gb_day=0.0, rtc_broken=False, saturated=False, hours=72):
    """uploads: (start hour, GB) each. Returns the profile and clamp times, the peaks, and the guard's day stop."""
    b = E.Budget(dict(E.DEFAULTS), OCT1)
    counters = {"10": 0, "15": 0, "20": 0}
    pending = sorted(uploads)
    left = 0.0
    per_min, per_min_10 = [], []
    first = {}
    clamp_minutes = 0
    at = {"normal": 0, "capped": 0, "deep": 0}
    switches, prev = 0, "normal"
    for m in range(hours * 60):
        rates = b.rates()
        cap10 = rates["10"] * 0.45 / 60  # GB a minute the class lets out
        if rtc_broken:
            s = cap10
        else:
            s = min(viewers * PER_VIEWER[levels][b.profile][level] / 60, cap10)
        while pending and pending[0][0] * 60 <= m:
            left += pending.pop(0)[1]
        cap20 = rates["20"] * 0.45 / 60
        o = (BASELINE_GBH + other_gb_day / 24) / 60
        if saturated:
            o = cap20 + rates["15"] * 0.45 / 60
        elif left > 0:
            up = min(left, max(0.0, cap20 - o))
            left -= up
            o += up
        counters["10"] += int(s * GB)
        counters["20"] += int(o * GB)
        per_min.append(s + o)
        per_min_10.append(s)
        b.tick(OCT1 + m * 60 + 59, dict(counters))
        at[b.profile] += 1
        switches += b.profile != prev
        prev = b.profile
        for name in ("capped", "deep"):
            if b.profile == name and name not in first:
                first[name] = (m + 1) / 60
        if b.clamped:
            clamp_minutes += 1
            first.setdefault("clamp", (m + 1) / 60)
    day_stop, run_all, run_10, peak, peak_10 = None, 0.0, 0.0, 0.0, 0.0
    for i, (v, v10) in enumerate(zip(per_min, per_min_10)):
        run_all += v
        run_10 += v10
        if i >= 1440:
            run_all -= per_min[i - 1440]
            run_10 -= per_min_10[i - 1440]
        peak, peak_10 = max(peak, run_all), max(peak_10, run_10)
        if day_stop is None and run_all >= DAY_STOP_GB:
            day_stop = (i + 1) / 60
    return {"capped_h": first.get("capped"), "deep_h": first.get("deep"), "clamp_h": first.get("clamp"),
            "clamp_min": clamp_minutes, "peak24_gb": round(peak, 1), "peak24_rtc_gb": round(peak_10, 1),
            "day_stop_h": day_stop, "switches": switches, "hours": {k: round(v / 60, 1) for k, v in at.items()}}


def worst_upload(E, gb, **kw):
    """The upload's start hour, 0 to 47, that brings the 24 h total highest."""
    best = None
    for h in range(48):
        r = run(E, uploads=((h, gb),), **kw)
        if best is None or r["peak24_gb"] > best[1]["peak24_gb"]:
            best = (h, r)
    return best


CASES = [
    ("1 viewer", dict(viewers=1)),
    ("1 viewer at Max", dict(viewers=1, level="max")),
    ("1 viewer, 30 GB upload at hour 23", dict(viewers=1, uploads=((23, 30),))),
    ("1 viewer at Max, 30 GB upload at hour 17", dict(viewers=1, level="max", uploads=((17, 30),))),
    ("2 viewers", dict(viewers=2)),
    ("2 viewers, 6 GB a day other", dict(viewers=2, other_gb_day=6)),
    ("2 viewers, 20 GB upload at hour 20", dict(viewers=2, uploads=((20, 20),))),
    ("2 viewers, 25 GB upload at hour 20", dict(viewers=2, uploads=((20, 25),))),
    ("2 viewers, 30 GB upload at hour 20", dict(viewers=2, uploads=((20, 30),))),
    ("2 viewers at Max", dict(viewers=2, level="max")),
    ("3 viewers", dict(viewers=3)),
    ("4 viewers, the session limit", dict(viewers=4)),
    ("broken desk-rtc", dict(rtc_broken=True)),
    ("broken desk-rtc, bucket saturated", dict(rtc_broken=True, saturated=True)),
]
WORST = [  # an upload of a whole bucket at whichever hour hurts most
    ("2 viewers, 30 GB upload at the worst hour", dict(viewers=2)),
    ("2 viewers at Max, 30 GB upload at the worst hour", dict(viewers=2, level="max")),
    ("3 viewers, 30 GB upload at the worst hour", dict(viewers=3)),
    ("3 viewers at Medium, 30 GB upload at the worst hour", dict(viewers=3, level="medium")),
    ("1 viewer at Low, 30 GB upload at the worst hour", dict(viewers=1, level="low")),
]


def fmt(v):
    return "never" if v is None else f"{v:.1f}"


def main(argv):
    path = argv[1]
    levels = "honour" if "--honour" in argv else "ignore"
    E = load(path)
    rows = []
    for name, kw in CASES:
        rows.append((name, run(E, levels=levels, **kw)))
    for name, kw in WORST:
        h, r = worst_upload(E, 30, levels=levels, **kw)
        rows.append((f"{name} ({h})", r))
    print(f"desk-egress: {path}; levels under capped and deep: {levels}")
    print("| Case | capped at h | deep at h | clamp at h | clamped min | peak 24 h, all | peak 24 h, 1:10 | guard `day` stop at h | switches in 72 h | h normal / capped / deep |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for name, r in rows:
        print(f"| {name} | {fmt(r['capped_h'])} | {fmt(r['deep_h'])} | {fmt(r['clamp_h'])} | {r['clamp_min']} | {r['peak24_gb']} | "
              f"{r['peak24_rtc_gb']} | {fmt(r['day_stop_h'])} | {r['switches']} | {r['hours']['normal']} / {r['hours']['capped']} / {r['hours']['deep']} |")
    if "--json" in argv:
        with open(argv[argv.index("--json") + 1], "w", encoding="ascii") as f:
            json.dump({"path": path, "levels": levels, "rows": [{"case": n, **r} for n, r in rows]}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
