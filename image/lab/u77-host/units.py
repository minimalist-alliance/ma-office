#!/usr/bin/python3 -I
"""units.py <k> <start|stop|freeze|thaw> <unit> [--retry-busy N]: TEST ONLY. A stand-in for deskd on slot k's units.sock,
from the host: the call runs as slot k's uid 1100 (host uid 100000 + k*65536 + 1100, which the desk sees as deskd), on the
socket the host's tmpfs carries (/run/desk-host/share/<k>/desk/units.sock). Prints one JSON line."""
import json
import os
import socket
import sys
import time

k, verb, unit = int(sys.argv[1]), sys.argv[2], sys.argv[3]
retry = int(sys.argv[sys.argv.index("--retry-busy") + 1]) if "--retry-busy" in sys.argv else 0
base = 100000 + k * 65536
path = f"/run/desk-host/share/{k}/desk/units.sock"


def ask():
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            os.setgroups([base + 1100])
            os.setgid(base + 1100)
            os.setuid(base + 1100)
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(120)
            s.connect(path)
            s.sendall(f"{verb} {unit}\n".encode())
            os.write(w, s.recv(300))
        except OSError as e:
            os.write(w, f"err client {e}".encode())
        os._exit(0)
    os.close(w)
    out = b""
    while True:
        d = os.read(r, 300)
        if not d:
            break
        out += d
    os.waitpid(pid, 0)
    return out.decode().strip()


t0 = time.time()
tries = 0
while True:
    tries += 1
    reply = ask()
    if not (retry and reply.startswith("err busy") and tries <= retry):
        break
    time.sleep(3)
ev = ""
try:
    ev = open(f"/sys/fs/cgroup/desk-host/desk-{k}/desk/desk-browser/cgroup.events").read()
except OSError:
    pass
print(json.dumps({"desk": k, "action": verb, "unit": unit, "reply": reply, "ok": reply == "ok", "code": reply.split()[1] if reply.startswith("err") and len(reply.split()) > 1 else "ok",
                  "ms": round((time.time() - t0) * 1000), "tries": tries, "at": round(t0, 3), "frozen": "frozen 1" in ev}), flush=True)
