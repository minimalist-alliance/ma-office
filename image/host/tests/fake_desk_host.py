#!/usr/bin/python3 -I
"""fake_desk_host.py <host.json> <command> [args...]: desk-host as desk-host-link sees it, for test_link.py. Never on an image.

host.json holds the fake host: "slots" {k: {state, deskId, epoch, fault}} for the report, "calls" (every command, appended),
and per command "fail" counts ({"up": 1} fails the next up). up sets the slot running with the desk and the epoch its tag
names (host.json "tags", the same tags the test's fake IMDS serves) unless "stuck" lists the command; stop sets it
unmounted; prepare sets it prepared with the tag's epoch.
"""
import fcntl
import json
import sys

sys.dont_write_bytecode = True
path, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(path + ".lock", "w") as lk:
    fcntl.flock(lk, fcntl.LOCK_EX)
    h = json.load(open(path))
    if cmd == "report":
        n = h.get("slotsPerHost") or h.get("desksPerHost", 2)
        out = []
        for k in range(1, n + 1):
            s = h["slots"].get(str(k), {"state": "empty", "deskId": None, "epoch": 0})
            e = {"k": k, "state": s["state"], "deskId": s.get("deskId"), "epoch": s.get("epoch", 0), "net": {"bytesOut": s.get("bytesOut", 0)}}
            if s.get("fault"):
                e["fault"] = s["fault"]
            out.append(e)
        print(json.dumps({"slots": out, "conntrack": {"count": 10, "max": 65536}}))
        sys.exit(0)
    h.setdefault("calls", []).append([cmd, *args])
    rc = 0
    if h.get("fail", {}).get(cmd, 0) > 0:
        h["fail"][cmd] -= 1
        rc = 1
    elif cmd not in h.get("stuck", []):
        k = args[0]
        tag = h.get("tags", {}).get(k, "")
        parts = tag.split("/") if tag else []
        epoch = int(parts[4]) if len(parts) in (5, 6) else 0
        if cmd == "up":
            h["slots"][k] = {"state": "running", "deskId": args[1], "epoch": epoch}
        elif cmd == "stop":
            h["slots"][k] = {"state": "unmounted", "deskId": h["slots"].get(k, {}).get("deskId"), "epoch": h["slots"].get(k, {}).get("epoch", 0)}
        elif cmd == "prepare":
            h["slots"][k] = {"state": "prepared", "deskId": None, "epoch": epoch}
    json.dump(h, open(path + ".tmp", "w"))
    import os
    os.replace(path + ".tmp", path)
sys.exit(rc)
