#!/usr/bin/python3 -I
"""order.py <gen> <targetId> [<header dir>] [--urgent]: a template_target order for the lab's fake Platform (LAB ONLY): the artifact
on the loopback server (a test host takes http://127.0.0.1 URLs), presigned-like URLs good for an hour."""
import hashlib
import json
import sys
import time

gen, tid = sys.argv[1], sys.argv[2]
hd = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else gen
b = "http://127.0.0.1:18080"
sha = hashlib.sha256(open(f"/srv/desk-host/lab-art/{hd}/header.json", "rb").read()).hexdigest()
print(json.dumps({"op": "template_target", "id": f"template_target:{tid}", "targetId": tid, "gen": gen, "hostImage": "0.1.10", "sha256": sha,
                  "urls": {"header": f"{b}/{hd}/header.json", "signature": f"{b}/{hd}/header.sig", "manifest": f"{b}/{gen}/manifest.json",
                           "plan": f"{b}/{gen}/plan.txt", "archive": f"{b}/{gen}/template.tar.zst"},
                  "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600)), "urgent": "--urgent" in sys.argv}))
