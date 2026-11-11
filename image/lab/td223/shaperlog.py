#!/usr/bin/python3 -I
"""shaperlog.py SECS k...: every second for SECS, each slot's HTB classes on its veth (bytes, drops, rate), its out_<k> counter (the
guard's count) and its budget (slowed, the bucket): one JSON line a second on stdout. Host root. TEST ONLY (lab/td223)."""
import json
import subprocess
import sys
import time

secs, slots = float(sys.argv[1]), [int(k) for k in sys.argv[2:]]


def classes(k):
    r = subprocess.run(["nsenter", f"--net=/run/desk-host/ns/{k}/net", "tc", "-j", "-s", "class", "show", "dev", "eth0"], capture_output=True, text=True)
    try:
        return {c["handle"].split(":")[1]: [c["stats"]["bytes"], c["stats"].get("drops", 0), c.get("rate", 0) * 8]
                for c in json.loads(r.stdout or "[]") if c.get("class") == "htb"}
    except ValueError:
        return {}


def counters():
    r = subprocess.run(["nft", "-j", "list", "counters", "table", "inet", "host"], capture_output=True, text=True)
    return {o["counter"]["name"]: o["counter"]["bytes"] for o in json.loads(r.stdout)["nftables"] if "counter" in o}


def state(k):
    try:
        d = json.load(open(f"/run/desk-host/{k}/slot.json"))["deskId"]
        s = json.load(open(f"/var/lib/desk-host/egress/{d}.json"))
        return {"slowed": s["slowed"], "level_gb": round(s["level"] / 1e9, 3), "profile": s["profile"]}
    except (OSError, ValueError, KeyError):
        return {}


end = time.time() + secs
while time.time() < end:
    t = time.time()
    c = counters()
    print(json.dumps({"t": round(t, 2), **{str(k): {"cl": classes(k), "out": c.get(f"out_{k}", 0), "veth_rx": int(open(f"/sys/class/net/dhv{k}/statistics/rx_bytes").read()),
                                                       **state(k)} for k in slots}}), flush=True)
    time.sleep(max(0, 1 - (time.time() - t)))
