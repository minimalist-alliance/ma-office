#!/usr/bin/python3 -I
"""cdpload.py URL...: loads each page in the kiosk Chromium over CDP (127.0.0.1:9222, as root or desk), cache off, and prints
one JSON line a page: time to the load event, requests, bytes on the wire, the main response's status. Stdlib only."""
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.request

CDP = "http://127.0.0.1:9222"


class WS:
    def __init__(self, url):
        hostport, path = url[len("ws://"):].split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), 10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise OSError("no websocket upgrade")
        self.n = 0

    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(1 << 16)
            if not d:
                raise OSError("closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            msg += self._read(n)
            if b0 & 0x80:
                return json.loads(msg)

    def call(self, method, **params):
        self.n += 1
        body = json.dumps({"id": self.n, "method": method, "params": params}).encode()
        mask = os.urandom(4)
        n = len(body)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        self.s.sendall(head + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(body)))
        return self.n


def main(urls):
    tab = json.loads(urllib.request.urlopen(urllib.request.Request(CDP + "/json/new?about:blank", method="PUT"), timeout=30).read())
    ws = WS(tab["webSocketDebuggerUrl"])
    ws.s.settimeout(90)
    for m, p in (("Network.enable", {}), ("Network.setCacheDisabled", {"cacheDisabled": True}), ("Page.enable", {})):
        ws.call(m, **p)
    for url in urls:
        t0 = time.monotonic()
        ws.call("Page.navigate", url=url)
        reqs, wire, status, done = set(), 0, None, None
        try:
            while done is None:
                m = ws.recv()
                meth = m.get("method")
                if meth == "Network.requestWillBeSent":
                    reqs.add(m["params"]["requestId"])
                elif meth == "Network.loadingFinished":
                    wire += m["params"].get("encodedDataLength", 0)
                elif meth == "Network.responseReceived" and m["params"].get("type") == "Document" and status is None:
                    status = m["params"]["response"]["status"]
                elif meth == "Page.loadEventFired":
                    done = time.monotonic()
                if time.monotonic() - t0 > 90:
                    break
        except (socket.timeout, OSError):
            pass
        print(json.dumps({"url": url, "loadMs": round((done - t0) * 1000) if done else None, "requests": len(reqs),
                          "wireKB": round(wire / 1000), "status": status}), flush=True)
    urllib.request.urlopen(CDP + "/json/close/" + tab["id"], timeout=10).read()


if __name__ == "__main__":
    main(sys.argv[1:])
