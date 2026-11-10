"""A small Chrome DevTools Protocol client over Python's standard library: a WebSocket client, enough of it for
CDP on loopback, and the few calls the rehearsal needs. Rehearsal only, never on a desk."""
import base64
import json
import os
import socket
import struct
import time
import urllib.parse
import urllib.request


def version(port, timeout=1.0):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as r:
        return json.loads(r.read())


def wait_port(port, seconds=60):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return version(port)
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.2)


class WebSocket:
    def __init__(self, url, timeout=30):
        u = urllib.parse.urlsplit(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (f"?{u.query}" if u.query else "")
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            b = self.sock.recv(4096)
            if not b:
                raise ConnectionError("closed during the handshake")
            head += b
        status, _, self.buf = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n")[0]:
            raise ConnectionError(status.split(b"\r\n")[0].decode())

    def _recv(self, n):
        while len(self.buf) < n:
            b = self.sock.recv(1 << 20)
            if not b:
                raise ConnectionError("closed")
            self.buf += b
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        message = b""
        while True:
            b0, b1 = self._recv(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv(8))[0]
            payload = self._recv(n)
            op = b0 & 0x0F
            if op == 8:
                raise ConnectionError("closed by Chromium")
            if op in (9, 10):
                continue
            message += payload
            if b0 & 0x80:
                return message.decode()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Browser:
    """One connection to the browser target, with flattened sessions for pages."""

    def __init__(self, port, timeout=30):
        self.ws = WebSocket(version(port)["webSocketDebuggerUrl"], timeout)
        self.next_id = 0
        self.events = []

    def call(self, method, params=None, session=None, timeout=30):
        self.next_id += 1
        mid = self.next_id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error'].get('message')}")
                return m.get("result", {})
            self.events.append(m)
        raise TimeoutError(method)

    def wait_event(self, method, session=None, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            for i, m in enumerate(self.events):
                if m.get("method") == method and (session is None or m.get("sessionId") == session):
                    return self.events.pop(i)
            if time.monotonic() > deadline:
                raise TimeoutError(method)
            self.events.append(json.loads(self.ws.recv()))

    def page(self):
        """Attaches to the first page target, or opens one."""
        targets = [t for t in self.call("Target.getTargets")["targetInfos"] if t["type"] == "page"]
        tid = targets[0]["targetId"] if targets else self.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = self.call("Target.attachToTarget", {"targetId": tid, "flatten": True})["sessionId"]
        self.call("Page.enable", session=sid)
        self.call("Runtime.enable", session=sid)
        return sid

    def navigate(self, sid, url, timeout=30):
        self.events = [e for e in self.events if e.get("method") != "Page.loadEventFired"]
        self.call("Page.navigate", {"url": url}, session=sid)
        self.wait_event("Page.loadEventFired", session=sid, timeout=timeout)

    def evaluate(self, sid, expression, timeout=30):
        r = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True, "returnByValue": True},
                      session=sid, timeout=timeout)
        if "exceptionDetails" in r:
            raise RuntimeError(f"page script failed: {r['exceptionDetails'].get('text')}")
        return r["result"].get("value")

    def cookies(self):
        return self.call("Storage.getCookies")["cookies"]

    def close(self):
        self.ws.close()
