#!/usr/bin/env python3
"""Reads wake-<label>.json and its wake-<label>-<n>-guest.txt files (written by wake.spec.ts) and prints each sample's phases.

    python3 wake-report.py ~/ma-design-drafts/w3/<W3_LABEL> <label> [<label> ...]

All times are milliseconds since the office page began to load (t0), the instant the app's wake starts. The guest's own
events are placed on that clock by its boot epoch (date minus /proc/uptime, read in one command), so they carry the clock
offset between this workstation and the desk (both chrony-synced) and about 100 ms of rounding; the EC2 states come from a
polling loop with about 1 s resolution.
"""
import json
import re
import statistics
import sys
from datetime import datetime
from pathlib import Path


def mono(guest: str, pattern: str):
    m = re.search(r"\[\s*([\d.]+)\][^\n]*" + pattern, guest)
    return float(m.group(1)) if m else None


def ws_ready(events):
    for e in events:
        if e["what"] == "ws:desk.progress" and e.get("detail") == "ready":
            return e["ms"]
    return None


def first(events, what, detail=None):
    for e in events:
        if e["what"] == what and (detail is None or e.get("detail") == detail):
            return e["ms"]
    return None


def last(events, what, detail):
    xs = [e["ms"] for e in events if e["what"] == what and e.get("detail") == detail]
    return xs[-1] if xs else None


def phases(sample, guest):
    boot_ms = sample.get("bootEpochMs")  # kernel's time zero on the t0 clock
    g = {}
    if boot_ms is not None:
        for k, pat in {
            "net_up": r"Reached target network-online|Reached target Network is Online",
            "docker": r"Started docker\.service",
            "deskd_start": r"Started deskd\.service",
            "deskd_ready": r"ReadinessReporter deskd ready",
            "hello": r"hello accepted",
            "gateway": r"gateway link up",
        }.items():
            t = mono(guest, pat)
            g[k] = None if t is None else round(boot_ms + t * 1000)
    row = sample.get("rowChangedAt")
    row_ms = None
    if row:
        t0 = sample["t0"]
        row_ms = round(datetime.fromisoformat(row.replace("Z", "+00:00")).timestamp() * 1000 - t0)
    ev = sample["events"]
    return {
        "connect_req": first(ev, "connect:request"),
        "connect_resp": first(ev, "connect:response"),
        "ec2_pending": sample.get("pendingSeenMs"),
        "ec2_running": sample.get("runningSeenMs"),
        "kernel": boot_ms,
        **g,
        "row_running": row_ms,
        "connect_200": last(ev, "connect:response", "200") if sample.get("windowOpenMs") is not None and last(ev, "connect:response", "202") is not None else last(ev, "connect:response", "200"),
        "app_ready": ws_ready(ev),
        "window": sample.get("windowOpenMs"),
        "first_frame": sample.get("firstFrameMs"),
        "tabs_answer": (None if sample.get("tabsMs") is None or sample.get("tabsMs") != sample.get("tabsMs") else sample.get("tabsMs")),
        "frame_after_open": sample.get("firstFrameAfterClickMs"),
    }


def sub(a, b):
    return None if a is None or b is None else a - b


def derived(r):
    """The four stretches that add up to the wait. A is mostly EC2's; B is the guest's boot; C the app's polling; D the stream."""
    return {
        "A office load to kernel start": r["kernel"],
        "B kernel start to hello accepted": sub(r.get("hello"), r["kernel"]),
        "C hello to the app's connect 200": sub(r.get("connect_200"), r.get("hello")),
        "D connect 200 to first frame": sub(r["first_frame"], r.get("connect_200")),
        "D' connect 200 to Chromium's tabs": sub(r.get("tabs_answer"), r.get("connect_200")),
        "total: office load to first frame": r["first_frame"],
        "total: office load to Chromium's tabs": r.get("tabs_answer"),
    }


def main():
    d = Path(sys.argv[1]).expanduser()
    for label in sys.argv[2:]:
        # "a+b" merges the samples of two runs of the same variant; a sample whose desk booted before the page began to
        # load was never stopped (valid false, or a negative kernel time on older files) and is left out, and counted.
        rows = []
        dropped = 0
        j = None
        for part in label.split("+"):
            j = json.loads((d / f"wake-{part}.json").read_text())
            for s in j["samples"]:
                if s.get("valid") is False or (s.get("bootEpochMs") is not None and s["bootEpochMs"] < -3000):
                    dropped += 1
                    continue
                gp = d / f"wake-{part}-{s['sample']}-guest.txt"
                guest = gp.read_text() if gp.exists() else ""
                rows.append(phases(s, guest))
        keys = list(rows[0].keys())
        print(f"\n## {label}  ({len(rows)} samples{f', {dropped} dropped: desk not stopped' if dropped else ''}, {j['type']}, {j['ami']})")
        print("| phase (ms since the office began to load) | " + " | ".join(f"#{i+1}" for i in range(len(rows))) + " | median | min | max |")
        print("|---|" + "---|" * (len(rows) + 3))
        for k in keys:
            vals = [r[k] for r in rows]
            nums = [v for v in vals if isinstance(v, (int, float))]
            med = f"{statistics.median(nums):.0f}" if nums else "-"
            print(f"| {k} | " + " | ".join("-" if v is None else str(v) for v in vals) + f" | {med} | {min(nums) if nums else '-'} | {max(nums) if nums else '-'} |")
        print()
        print("| stretch | " + " | ".join(f"#{i+1}" for i in range(len(rows))) + " | median | min | max |")
        print("|---|" + "---|" * (len(rows) + 3))
        ds = [derived(r) for r in rows]
        for k in ds[0]:
            vals = [d[k] for d in ds]
            nums = [v for v in vals if isinstance(v, (int, float))]
            med = f"{statistics.median(nums):.0f}" if nums else "-"
            print(f"| {k} | " + " | ".join("-" if v is None else str(v) for v in vals) + f" | {med} | {min(nums) if nums else '-'} | {max(nums) if nums else '-'} |")


if __name__ == "__main__":
    main()
