// What the check does on the test desk, all over SSM through w3lib's TestDesk (which refuses any desk that isn't DeskKind=test,
// Env=staging, and the owner's by id). It writes one file, DIR/probe.py, and removes it at the end. It reads the visible tab over
// Chromium's debugging port as root (nftables lets uid 0 reach 9222), counts the profile's cookies per site without reading a value
// out, and reads the NIC's byte counters. It never writes to /data/browser/profile: the visits themselves are the only change, as
// a member's would be.
import type { TestDesk } from '../w3/w3lib';
import type { Probe } from './classify';

export const DIR = '/var/tmp/ma-e2e-real-sites';

// The socket code is pages.ts' CDP_PY (browser-session.spec.ts' before it), with any length of frame, and any method.
const PROBE_PY = String.raw`
import base64, json, os, socket, struct, sys, urllib.request
CDP = os.environ.get('MA_CDP', 'http://127.0.0.1:9222')  # a test hook; the desk never sets it
def call(ws, method, params):
    host, path = ws.split('ws://', 1)[1].split('/', 1); h, p = host.split(':')
    s = socket.create_connection((h, int(p)), timeout=20)
    s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, host, base64.b64encode(os.urandom(16)).decode())).encode())
    b = b''
    while b'\r\n\r\n' not in b: b += s.recv(4096)
    rest = b.split(b'\r\n\r\n', 1)[1]
    def rd(n):
        nonlocal rest
        while len(rest) < n:
            d = s.recv(65536)
            if not d: raise EOFError
            rest += d
        o, rest = rest[:n], rest[n:]; return o
    msg = json.dumps({'id': 1, 'method': method, 'params': params}).encode(); mask = os.urandom(4); n = len(msg)
    head = bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
    s.sendall(b'\x81' + head + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(msg)))
    buf = b''
    while True:
        a, l = rd(2); n = l & 0x7f
        if n == 126: n = struct.unpack('>H', rd(2))[0]
        elif n == 127: n = struct.unpack('>Q', rd(8))[0]
        pl = rd(n)
        if a & 0xf in (0, 1):
            buf += pl
            if a & 0x80:
                m = json.loads(buf); buf = b''
                if m.get('id') == 1: s.close(); return m.get('result', {})
def evaluate(t, expr): return call(t['webSocketDebuggerUrl'], 'Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True}).get('result', {}).get('value')
def pages(): return [t for t in json.loads(urllib.request.urlopen(CDP + '/json/list', timeout=10).read()) if t['type'] == 'page']
mode = sys.argv[1]
if mode == 'eval':
    expr = base64.b64decode(sys.argv[2]).decode()
    for t in pages():
        if evaluate(t, 'document.visibilityState') == 'visible':
            print(json.dumps({'value': evaluate(t, expr)})); break
    else: print(json.dumps({'value': None}))
elif mode == 'tabs':
    print(json.dumps({'tabs': len(pages())}))
elif mode == 'cookies':
    # Counts and the names of known clearance cookies only. No value leaves this process.
    ws = json.loads(urllib.request.urlopen(CDP + '/json/version', timeout=10).read())['webSocketDebuggerUrl']
    jar = call(ws, 'Storage.getCookies', {}).get('cookies', [])
    known = ('cf_clearance', '__cf_bm', 'datadome', 'GOOGLE_ABUSE_EXEMPTION', '_abck', 'bm_sv', 'ak_bmsc')
    out = {}
    for d in sys.argv[2].split(','):
        mine = [c for c in jar if c['domain'].lstrip('.') == d or c['domain'].lstrip('.').endswith('.' + d)]
        out[d] = {'count': len(mine), 'clearance': sorted({c['name'] for c in mine if c['name'] in known or c['name'].startswith('_px')})}
    print(json.dumps({'total': len(jar), 'byDomain': out}))
`;

export async function deployProbe(desk: TestDesk): Promise<void> {
  const out = await desk.run(`set -e; rm -rf ${DIR}; install -d -m 700 ${DIR}; echo ${Buffer.from(PROBE_PY).toString('base64')} | base64 -d > ${DIR}/probe.py; chmod 600 ${DIR}/probe.py; python3 -I ${DIR}/probe.py tabs`);
  if (!/"tabs"/.test(out)) throw new Error(`the probe on the desk did not answer: ${out.slice(0, 200)}`);
}

export async function removeProbe(desk: TestDesk): Promise<void> {
  await desk.run(`rm -rf ${DIR}; echo removed`);
}

/** An expression in the tab on screen, awaited if it's a promise. Null if no tab is visible. */
export async function evalOnScreen<T>(desk: TestDesk, expression: string): Promise<T | null> {
  const out = await desk.run(`python3 -I ${DIR}/probe.py eval ${Buffer.from(expression).toString('base64')} 2>&1 | tail -3`, 60);
  try { return JSON.parse(out.trim().split('\n').pop()!).value as T | null; } catch { throw new Error(`CDP on the desk: ${out.slice(0, 200)}`); }
}
export const probePage = (desk: TestDesk, expression: string) => evalOnScreen<Probe>(desk, expression);

/** Whether the desk's Chromium can play protected video (Netflix, Prime Video, Disney+, Spotify need Widevine). Asked on an https page. */
export const DRM = `(async () => {
  const cfg = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }];
  const out = { secureContext: isSecureContext };
  for (const ks of ['com.widevine.alpha', 'org.w3.clearkey']) { try { await navigator.requestMediaKeySystemAccess(ks, cfg); out[ks] = true; } catch (e) { out[ks] = String(e && e.name || e).slice(0, 60); } }
  return out;
})()`;

export async function tabCount(desk: TestDesk): Promise<number> {
  const out = await desk.run(`python3 -I ${DIR}/probe.py tabs`);
  return JSON.parse(out.trim().split('\n').pop()!).tabs as number;
}

export interface Jar { total: number; byDomain: Record<string, { count: number; clearance: string[] }> }
export async function cookieCounts(desk: TestDesk, domains: string[]): Promise<Jar> {
  const out = await desk.run(`python3 -I ${DIR}/probe.py cookies ${[...new Set(domains)].join(',')} 2>&1 | tail -3`, 60);
  try { return JSON.parse(out.trim().split('\n').pop()!) as Jar; } catch { throw new Error(`cookies on the desk: ${out.slice(0, 200)}`); }
}

/** The desk's own byte counters on its internet-facing NIC, with the desk's clock. rx: what sites sent the desk; tx: mostly the stream. */
export interface Nic { at: number; rx: number; tx: number; dev: string }
export async function nic(desk: TestDesk): Promise<Nic> {
  const out = await desk.run(`dev=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); echo "$(date +%s.%N) $(cat /sys/class/net/$dev/statistics/rx_bytes) $(cat /sys/class/net/$dev/statistics/tx_bytes) $dev"`);
  const [at, rx, tx, dev] = out.trim().split(/\s+/);
  return { at: Number(at), rx: Number(rx), tx: Number(tx), dev };
}
