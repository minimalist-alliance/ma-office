"""Minimal CDP client (stdlib only), as verify.sh's. Import or run: cdp.py list | eval <target-substr> <expr> | policy"""
import base64, json, os, socket, struct, sys, time, urllib.request
CDP = os.environ.get('CDP', 'http://127.0.0.1:9222')
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()
def targets(): return json.loads(get('/json/list'))
class WS:
    def __init__(self, url, timeout=60):
        hostport, path = url[len('ws://'):].split('/', 1); host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), 10); self.s.settimeout(timeout); self.n = 0; self.events = []
        self.handler = None  # handler(msg) -> True if consumed; called for every event as it arrives
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key)).encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf: self.buf += self.s.recv(4096)
        head, self.buf = self.buf.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]: raise RuntimeError(head[:80])
    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(1 << 20)
            if not d: raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]; return out
    def recv(self):
        msg = b''
        while True:
            b0, b1 = self._read(2); ln = b1 & 0x7f
            if ln == 126: ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127: ln = struct.unpack('>Q', self._read(8))[0]
            if b1 & 0x80: self._read(4)
            data = self._read(ln); op = b0 & 0x0f
            if op == 8: raise EOFError
            if op in (9, 10): continue
            msg += data
            if b0 & 0x80: return msg
    def send(self, method, params=None, session=None):
        self.n += 1; i = self.n; m = {'id': i, 'method': method, 'params': params or {}}
        if session: m['sessionId'] = session
        data = json.dumps(m).encode(); mask = os.urandom(4); n = len(data)
        if n < 126: hdr = bytes([0x81, 0x80 | n])
        elif n < 65536: hdr = bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
        else: hdr = bytes([0x81, 0x80 | 127]) + struct.pack('>Q', n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data)))
        return i
    def call(self, method, session=None, **params):
        i = self.send(method, params, session)
        while True:
            m = json.loads(self.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError('%s: %s' % (method, m['error']))
                return m['result']
            self._event(m)
    def _event(self, m):
        if 'id' in m: return  # a reply to a fire-and-forget send
        if self.handler and self.handler(m): return
        self.events.append(m)
    def pump(self, seconds):
        """Collect events for a while."""
        end = time.time() + seconds; old = self.s.gettimeout()
        try:
            while True:
                left = end - time.time()
                if left <= 0: break
                self.s.settimeout(left)
                try: self._event(json.loads(self.recv()))
                except socket.timeout: break
        finally: self.s.settimeout(old)
    def value(self, expr, session=None, await_promise=False):
        r = self.call('Runtime.evaluate', session=session, expression=expr, returnByValue=True, awaitPromise=await_promise)
        if 'exceptionDetails' in r: raise RuntimeError('eval: %s' % json.dumps(r['exceptionDetails'])[:400])
        return r['result'].get('value')
    def close(self):
        try: self.s.close()
        except OSError: pass
def browser():
    return WS(json.loads(get('/json/version'))['webSocketDebuggerUrl'])
def ws_for(sub):
    for t in targets():
        if sub in t.get('url', '') or sub == t.get('id'): return WS(t['webSocketDebuggerUrl']), t
    raise LookupError(sub)
if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'list':
        for t in targets(): print(t['type'], t['id'][:8], t['url'][:120])
    elif cmd == 'eval':
        w, t = ws_for(sys.argv[2]); print(json.dumps(w.value(sys.argv[3], await_promise=True), indent=1)[:4000])
