#!/usr/bin/python3 -I
"""fake.py: the lab's fake Platform state (LAB ONLY). init <instance> <public ip> <DeskSlot1> <DeskSlot2> | want <k> running|stopped |
orders '<json list>' | updates '<json>' | show"""
import fcntl
import json
import os
import sys

P = "/root/fake/state.json"
a = sys.argv[1:]
_lk = open(P + ".lock", "w")
fcntl.flock(_lk, fcntl.LOCK_EX)   # one edit at a time (steps.sh starts two slots at once)


def save(s):
    json.dump(s, open(P + ".tmp", "w"))
    os.chmod(P + ".tmp", 0o600)
    os.replace(P + ".tmp", P)


if a[0] == "init":
    iid, pub, t1, t2 = a[1:5]
    slots = {}
    for k, t in ((1, t1), (2, t2)):
        f = t.split("/")
        slots[str(k)] = {"deskId": f[0], "volumeId": f[1], "publicIp": pub, "udpPort": 4430 + k, "epoch": int(f[4]), "want": "stopped",
                         "userId": f"lab-user-{k}", "deskKind": "test"}
    for k in range(3, 7):
        slots[str(k)] = {"deskId": None, "volumeId": None, "publicIp": pub, "udpPort": 4430 + k, "epoch": 0, "want": "stopped"}
    save({"hostId": iid, "env": "staging", "desksPerHost": 6, "reportSeconds": 10, "refreshAfterSeconds": 600, "slots": slots})
    sys.exit(0)
s = json.load(open(P))
if a[0] == "want":
    s["slots"][a[1]]["want"] = a[2]
elif a[0] == "orders":
    s["extraOrders"] = json.loads(a[1])
elif a[0] == "updates":
    s["updates"] = json.loads(a[1])
elif a[0] == "show":
    print(json.dumps(s, indent=1))
    sys.exit(0)
save(s)
