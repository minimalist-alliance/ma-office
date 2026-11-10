#!/usr/bin/env python3
"""One desk-data connection for the rehearsal, as its tests run it: the helper's own code, on the connection that
systemd-socket-activate --accept --inetd hands over on stdin, with the source tree as /data and this user as deskd.

    helper-run.py <desk-data program> <data root> <log dir>

It changes nothing in the helper. It only records, for the rehearsal's checks, each request's op, part, path and
offset (reads.jsonl) and how many body bytes went out (progress/<pid>.json, every MiB and at the end), which the
helper itself never logs, as a desk mustn't. Rehearsal only, never on a desk.
"""
import importlib.machinery
import importlib.util
import json
import os
import socket
import sys
import time

sys.dont_write_bytecode = True   # nothing generated beside the helper
program, root, logs = sys.argv[1:4]
loader = importlib.machinery.SourceFileLoader("desk_data", program)
spec = importlib.util.spec_from_loader("desk_data", loader)
dd = importlib.util.module_from_spec(spec)
loader.exec_module(dd)

STEP = 1 << 20
state = {"pid": os.getpid(), "t0": time.time(), "req": None, "sent": 0, "done": False}
os.makedirs(os.path.join(logs, "progress"), exist_ok=True)


def write_progress():
    state["t"] = time.time()
    path = os.path.join(logs, "progress", f"{os.getpid()}.json")
    with open(path + ".tmp", "w") as f:
        json.dump(state, f)
    os.replace(path + ".tmp", path)


original_parse = dd.parse_request


def parse_and_log(line):
    req = original_parse(line)
    state["req"] = {k: req.get(k) for k in ("op", "part", "path", "offset")}
    with open(os.path.join(logs, "reads.jsonl"), "a") as f:
        f.write(json.dumps({"pid": os.getpid(), "t": time.time(), **state["req"]}) + "\n")
    write_progress()
    return req


dd.parse_request = parse_and_log


class Counting:
    """The connection, counting what's sent."""

    def __init__(self, sock):
        self.sock = sock
        self.mark = STEP

    def sendall(self, data):
        self.sock.sendall(data)
        state["sent"] += len(data)
        if state["sent"] >= self.mark:
            self.mark = state["sent"] + STEP
            write_progress()

    def __getattr__(self, name):
        return getattr(self.sock, name)


os.umask(0o077)
dd._raise_fd_limit()
conn = socket.socket(fileno=0)
try:
    dd.Helper(root, os.getuid()).serve(Counting(conn))
finally:
    state["done"] = True
    if state["req"] is not None:
        write_progress()
