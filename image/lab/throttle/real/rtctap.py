#!/usr/bin/python3 -I
"""rtctap.py: TEST ONLY. A relay on rtc.sock, so ADR 0036 section 6 test 1 can read desk-rtc's per-session `rtpDropped`,
which only `stats` carries (desk-runtime.md section 8.4) and which deskd parses but reports nowhere.

  rtctap.py start    as root: move desk-rtc's socket aside, listen at its path with the same owner and mode, relay every
                     envelope both ways unchanged, and every --every seconds ask desk-rtc `stats.get` itself, keeping that
                     reply from deskd. Every `stats` (deskd's own too) goes to --log as one JSON line, with no address.
  rtctap.py stop     put desk-rtc's socket back (deskd reconnects at its next try, or restart deskd)

The envelope is rtc.sock v1's (desk-rtc/internal/rtcsock): a 4-byte big-endian length, a type byte, the body. `stats`
replies come back in the order asked; a multi-part reply ends at `last`. Nothing else is read or changed.
"""
import collections
import json
import os
import socket
import struct
import sys
import threading
import time

SOCK = "/run/desk/rtc.sock"
REAL = "/run/desk/rtc-tap-real.sock"
LOG = "/var/tmp/rtctap.jsonl"
EVERY = 5.0


def read_env(f):
    hdr = f.read(4)
    if len(hdr) < 4:
        return None
    n = struct.unpack(">I", hdr)[0]
    body = f.read(n)
    if len(body) < n:
        return None
    return hdr + body


class Link:
    def __init__(self, deskd, rtc, log):
        self.deskd, self.rtc, self.log = deskd, rtc, log
        self.rtc_lock = threading.Lock()
        self.origins = collections.deque()
        self.olock = threading.Lock()
        self.alive = True

    def to_rtc(self, env):
        with self.rtc_lock:
            self.rtc.sendall(env)

    def d2r(self):
        f = self.deskd.makefile("rb")
        try:
            while self.alive:
                env = read_env(f)
                if env is None:
                    break
                if env[4] == 0x01:
                    try:
                        if json.loads(env[5:]).get("t") == "stats.get":
                            with self.olock:
                                self.origins.append("deskd")
                    except ValueError:
                        pass
                self.to_rtc(env)
        finally:
            self.close()

    def r2d(self):
        f = self.rtc.makefile("rb")
        try:
            while self.alive:
                env = read_env(f)
                if env is None:
                    break
                origin = "deskd"
                if env[4] == 0x01:
                    try:
                        m = json.loads(env[5:])
                    except ValueError:
                        m = {}
                    if m.get("t") == "stats":
                        with self.olock:
                            origin = self.origins[0] if self.origins else "deskd"
                            if m.get("last", True) and self.origins:
                                self.origins.popleft()
                        rows = [{k: s.get(k) for k in ("sessionId", "transport", "rttMs", "bytesSent", "viewing", "rtpDropped")}
                                for s in m.get("sessions", [])]
                        self.log.write(json.dumps({"t": round(time.time(), 3), "origin": origin, "sessions": rows,
                                                   "bytesSent": m.get("bytesSent"), "stream": m.get("stream")}) + "\n")
                        self.log.flush()
                if origin == "deskd":
                    self.deskd.sendall(env)
        finally:
            self.close()

    def ask(self):
        while self.alive:
            time.sleep(EVERY)
            if not self.alive:
                break
            body = json.dumps({"t": "stats.get"}).encode()
            with self.olock:
                self.origins.append("tap")
            try:
                self.to_rtc(struct.pack(">IB", len(body) + 1, 0x01) + body)
            except OSError:
                break

    def close(self):
        self.alive = False
        for s in (self.deskd, self.rtc):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def start():
    st = os.stat(SOCK)
    if not os.path.exists(REAL):
        os.rename(SOCK, REAL)
    elif os.path.exists(SOCK):
        os.unlink(SOCK)
    ln = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ln.bind(SOCK)
    os.chown(SOCK, st.st_uid, st.st_gid)
    os.chmod(SOCK, st.st_mode & 0o777)
    ln.listen(4)
    log = open(LOG, "a")
    print(f"rtctap: relaying {SOCK}, stats every {EVERY:g} s to {LOG}", flush=True)
    while True:
        deskd, _ = ln.accept()
        rtc = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            rtc.connect(REAL)
        except OSError as e:
            print(f"rtctap: desk-rtc refused: {e}", flush=True)
            deskd.close()
            continue
        link = Link(deskd, rtc, log)
        for fn in (link.d2r, link.r2d, link.ask):
            threading.Thread(target=fn, daemon=True).start()
        print("rtctap: deskd connected", flush=True)


def stop():
    if os.path.exists(REAL):
        if os.path.exists(SOCK):
            os.unlink(SOCK)
        os.rename(REAL, SOCK)
        print("rtctap: desk-rtc's socket is back")


if __name__ == "__main__":
    {"start": start, "stop": stop}[sys.argv[1]]()
