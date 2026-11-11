#!/usr/bin/python3 -I
"""sess_slot.py: TEST ONLY, on a TEST host as root (the u77-host lab box). A slot's Chromium over the test host's CDP forward
(10.98.<k>.2:19222, WR2-01: test hosts only), as e2e/tests/browser-session.spec.ts seeds and reads a desk of its own, with test
data only: cookies (persistent, session, and a late one set just before a stop), localStorage, two tabs and a saved password.
The pages come from this host's side of the slot's veth (10.98.<k>.1:18766, a test host's HOST_PORTS).

  sess_slot.py serve                 the pages, on every slot's host side (0.0.0.0:18766; the host's ruleset lets only desks in)
  sess_slot.py seed <k>              the session's test data, then 40 s for Chromium to commit it
  sess_slot.py mark <k> <name>       a cookie e2e_mark_<name> (the one set 8 s before a stop)
  sess_slot.py read <k>              one JSON line: cookies, tabs, localStorage, saved passwords and whether one decrypts
"""
import base64
import http.server
import json
import os
import socket
import struct
import sys
import time
import urllib.request

PORT = 18766
USER = "session-e2e"
SECRET = "test-only-not-a-secret"
OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def cdp(k):
    return f"http://10.98.{k}.2:19222"


def base(k):
    return f"http://10.98.{k}.1:{PORT}"


def get(k, p, m="GET"):
    for i in range(10):
        try:
            return OP.open(urllib.request.Request(cdp(k) + p, method=m), timeout=10).read()
        except OSError:
            if i == 9:
                raise
            time.sleep(2)


def tabs(k):
    return [t for t in json.loads(get(k, "/json/list")) if t["type"] == "page"]


def new(k, u):
    return json.loads(get(k, "/json/new?" + u, "PUT"))


def close(k, t):
    try:
        get(k, "/json/close/" + t["id"])
    except OSError:
        pass


def call(k, t, expr):
    url = t["webSocketDebuggerUrl"].replace("127.0.0.1:9222", f"10.98.{k}.2:19222").replace("[::1]:9222", f"10.98.{k}.2:19222")
    host, path = url.split("ws://", 1)[1].split("/", 1)
    h, p = host.rsplit(":", 1)
    s = socket.create_connection((h, int(p)), timeout=20)
    s.sendall((f"GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "
               f"{base64.b64encode(os.urandom(16)).decode()}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    b = b""
    while b"\r\n\r\n" not in b:
        b += s.recv(4096)
    rest = b.split(b"\r\n\r\n", 1)[1]

    def rd(n):
        nonlocal rest
        while len(rest) < n:
            d = s.recv(65536)
            if not d:
                raise EOFError
            rest += d
        o, rest = rest[:n], rest[n:]
        return o
    msg = json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}).encode()
    mask = os.urandom(4)
    s.sendall(b"\x81" + (bytes([0x80 | len(msg)]) if len(msg) < 126 else bytes([0x80 | 126]) + struct.pack(">H", len(msg))) + mask
              + bytes(c ^ mask[i % 4] for i, c in enumerate(msg)))
    buf = b""
    while True:
        a, ln = rd(2)
        n = ln & 0x7F
        if n == 126:
            n = struct.unpack(">H", rd(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", rd(8))[0]
        pl = rd(n)
        if a & 0xF in (0, 1):
            buf += pl
            if a & 0x80:
                m = json.loads(buf)
                buf = b""
                if m.get("id") == 1:
                    s.close()
                    return m.get("result", {}).get("result", {}).get("value")


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path.split("?")[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        if p == "/set-persist":
            self.send_header("Set-Cookie", "e2e_persist=p1; Max-Age=2592000; Path=/; HttpOnly")
        if p == "/set-session":
            self.send_header("Set-Cookie", "e2e_session=s1; Path=/; HttpOnly")
        if p.startswith("/set-mark/") and p[10:].replace("_", "").isalnum():
            self.send_header("Set-Cookie", f"e2e_mark_{p[10:]}=1; Max-Age=2592000; Path=/")
        b = f"<!doctype html><title>C[{self.headers.get('Cookie', '')}]</title>".encode()
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


def visit(k, path, wait=1.5):
    t = new(k, base(k) + path)
    time.sleep(wait)
    title = next((x["title"] for x in tabs(k) if x["id"] == t["id"]), None)
    close(k, t)
    return title


def pm(k, expr):
    t = new(k, "chrome://password-manager/passwords")
    time.sleep(2.5)
    try:
        return call(k, t, expr)
    finally:
        close(k, t)


PW_LIST = "new Promise(r=>chrome.passwordsPrivate.getSavedPasswordList(l=>r(l.map(x=>({id:x.id,username:x.username})))))"


def echo(k):
    for _ in range(20):
        t = visit(k, "/echo", 2.0)
        if t and t.startswith("C["):
            return t
    return None


def main(a):
    cmd = a[0]
    if cmd == "serve":
        http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
    k = int(a[1])
    if cmd == "seed":
        for t in tabs(k):
            if str(PORT) in t["url"]:
                close(k, t)
        if not any(x["username"] == USER for x in pm(k, PW_LIST) or []):
            add = pm(k, "new Promise(r=>chrome.passwordsPrivate.addPassword({url:'%s/login',username:'%s',password:'%s',note:'',"
                        "useAccountStore:false},()=>r(chrome.runtime.lastError?chrome.runtime.lastError.message:'added')))" % (base(k), USER, SECRET))
        else:
            add = "present"
        visit(k, "/set-persist")
        visit(k, "/set-session")
        ta = new(k, base(k) + "/tab-a")
        time.sleep(1)
        new(k, base(k) + "/tab-b")
        time.sleep(1)
        ls = call(k, ta, "localStorage.setItem('u77', 'kept-%d'); localStorage.getItem('u77')" % k)
        time.sleep(40)
        print(json.dumps({"seeded": True, "password": add, "localStorage": ls}))
    elif cmd == "mark":
        print(json.dumps({"cookies": visit(k, "/set-mark/" + a[2])}))
    elif cmd == "read":
        out = {"cookies": echo(k), "tabs": sorted(t["url"].replace(base(k), "") for t in tabs(k))}
        ta = next((t for t in tabs(k) if t["url"].endswith("/tab-a")), None)
        out["localStorage"] = call(k, ta, "localStorage.getItem('u77')") if ta else None
        t = new(k, "chrome://password-manager/passwords")
        time.sleep(2.5)
        try:
            lst = call(k, t, PW_LIST)
            out["passwords"] = [x["username"] for x in lst or []]
            me = next((x for x in lst or [] if x["username"] == USER), None)
            pt = call(k, t, "new Promise(r=>chrome.passwordsPrivate.requestPlaintextPassword(%d,'VIEW',p=>r(chrome.runtime.lastError?"
                            "'ERR '+chrome.runtime.lastError.message:p)))" % me["id"]) if me else None
        finally:
            close(k, t)
        out["plaintextOk"] = pt == SECRET
        print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
