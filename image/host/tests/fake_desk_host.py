#!/usr/bin/python3 -I
"""fake_desk_host.py <host.json> <command> [args...]: desk-host as desk-host-link sees it, for test_link.py. Never on an image.

host.json holds the fake host: "slots" {k: {state, deskId, epoch, fault, class}} for the report, "calls" (every command,
appended), per command "fail" counts ({"up": 1} fails the next up) and exit codes ("failrc" {"class": 75}; 1 otherwise), and
"slow" seconds a command takes before it acts (outside the lock, so reports go on). up sets the slot running with the desk and
the epoch its tag names (host.json "tags", the same tags the test's fake IMDS serves) and the class it was given (--class),
unless "stuck" lists the command; stop sets it unmounted; prepare sets it prepared with the tag's epoch; class sets a running
slot's class to the one given, else its tag's sixth field (standard when there's none), as desk-host class does.
ADR 0077: "templates", "fetch" and "hostApt" in host.json go into the report as they are, and a slot's "template", "behind",
"chromium" and "update" too. `template <sub> ...` (desk-host-template through desk-host) is recorded with no slot; its exit is
host.json "templateRc" {sub: rc} (0 if absent), and `template upd -- ... fetch <order>` marks the order's gen sealed as the
candidate. reroot, restart and reboot are recorded and fail by "fail" counts as the rest; restart moves the slot to "rerootTo".
ADR 0078: "batches", "batchFetch", "templatePending" and "imagePending" go into the report as they are, and a slot's "batch" and
"releases" too. `batch <sub> ...` (desk-host-batch through desk-host) is recorded with no slot, its exit host.json "batchRc" {sub: rc}
(0 if absent); `template upd -- ... desk-host-batch fetch <order>` marks the order's seq the candidate (batchRc "fetch"), and
`template upd -- /bin/bash .../desk-host switch|relroot <k>` the slot's batch current (batchRc "switch" or "relroot").
"""
import fcntl
import json
import sys
import time

sys.dont_write_bytecode = True
path, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
if cmd != "report":
    try:
        time.sleep(json.load(open(path)).get("slow", {}).get(cmd, 0))
    except ValueError:   # the test writing the file just then
        pass
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
            for x in ("template", "chromium", "behind", "chromiumBehind", "lastVersion", "update", "batch", "releases"):
                if x in s:
                    e[x] = s[x]
            if s.get("class") and s["state"] in ("starting", "running", "stopping"):
                e["class"] = s["class"]
            out.append(e)
        rep = {"slots": out, "conntrack": {"count": 10, "max": 65536}}
        for x in ("templates", "fetch", "hostApt", "batches", "batchFetch", "templatePending", "imagePending"):
            if x in h:
                rep[x] = h[x]
        print(json.dumps(rep))
        sys.exit(0)
    if cmd == "batch":
        h.setdefault("calls", []).append([cmd, *args])
        rc = h.get("batchRc", {}).get(args[0] if args else "", 0)
        json.dump(h, open(path + ".tmp", "w"))
        import os
        os.replace(path + ".tmp", path)
        sys.exit(rc)
    if cmd == "template":
        h.setdefault("calls", []).append([cmd, *args])
        sub = args[0] if args else ""
        rc = h.get("templateRc", {}).get(sub, 1 if sub == "start-failed" else 0)   # a slot isn't on a candidate unless a test says so
        if sub == "upd" and any(a.endswith("desk-host-batch") for a in args) and "fetch" in args:
            order = json.load(open(args[-1]))
            rc = h.get("batchRc", {}).get("fetch", 0)
            if rc == 0:
                h["batchFetch"] = {"seq": order["seq"], "state": "installed"}
                h.setdefault("batches", {})["candidate"] = {"seq": order["seq"], "id": f"b-{order['seq']}", "at": "x"}
            json.dump(h, open(path + ".tmp", "w"))
            import os
            os.replace(path + ".tmp", path)
            sys.exit(rc)
        if sub == "upd" and len(args) >= 3 and args[-2] in ("switch", "relroot"):
            rc = h.get("batchRc", {}).get(args[-2], 0)
            sl = h["slots"].get(args[-1])
            if rc == 0 and sl and sl.get("batch"):
                sl["batch"] = {"seq": sl["batch"].get("to", sl["batch"]["seq"]), "state": "current"}
            json.dump(h, open(path + ".tmp", "w"))
            import os
            os.replace(path + ".tmp", path)
            sys.exit(rc)
        if sub == "upd" and "fetch" in args:
            order = json.load(open(args[-1]))
            sub = "fetch"
            rc = h.get("templateRc", {}).get("fetch", 0)
            if rc == 0:
                h["fetch"] = {"target": order["targetId"], "gen": order["gen"], "state": "sealed"}
                h.setdefault("templates", {})["candidate"] = {"gen": order["gen"], "chromium": "x", "sealedAt": "x", "target": order["targetId"]}
        json.dump(h, open(path + ".tmp", "w"))
        import os
        os.replace(path + ".tmp", path)
        sys.exit(rc)
    h.setdefault("calls", []).append([cmd, *args])
    rc = 0
    if h.get("fail", {}).get(cmd, 0) > 0:
        h["fail"][cmd] -= 1
        rc = h.get("failrc", {}).get(cmd, 1)
    elif cmd == "reboot":
        pass
    elif cmd not in h.get("stuck", []):
        k = args[0]
        tag = h.get("tags", {}).get(k, "")
        parts = tag.split("/") if tag else []
        epoch = int(parts[4]) if len(parts) in (5, 6) else 0
        if cmd == "up":
            h["slots"][k] = {"state": "running", "deskId": args[1], "epoch": epoch, "class": args[args.index("--class") + 1] if "--class" in args else "standard"}
        elif cmd == "class":
            given = [a for a in args[1:] if not a.startswith("--")]
            if h["slots"].get(k, {}).get("state") == "running":
                h["slots"][k]["class"] = given[0] if given else (parts[5] if len(parts) == 6 else "standard")
            else:
                rc = 1   # desk-host class: no desk running
        elif cmd == "stop":
            h["slots"][k] = {"state": "unmounted", "deskId": h["slots"].get(k, {}).get("deskId"), "epoch": h["slots"].get(k, {}).get("epoch", 0)}
        elif cmd == "prepare":
            h["slots"][k] = {"state": "prepared", "deskId": None, "epoch": epoch}
        elif cmd == "restart" and h.get("rerootTo"):
            h["slots"][k]["template"] = h["rerootTo"]
            h["slots"][k]["behind"] = False
    json.dump(h, open(path + ".tmp", "w"))
    import os
    os.replace(path + ".tmp", path)
sys.exit(rc)
