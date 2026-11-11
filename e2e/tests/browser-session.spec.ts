// ADR 0035: a member's browser session is carried over. On the test desk's real Chromium and profile, with test data
// only, from a page server on the desk's loopback. Read back through Chromium itself over CDP on the desk: what a page's
// server receives as cookies, the live tab list, chrome://history, and chrome.passwordsPrivate.
//
//   npx playwright test tests/browser-session.spec.ts --output test-results-session
//   SESSION_KEEP=1 ...                leave the seed in place, ready for a stop or a root swap
//   SESSION_CHECK=stop-wake ...       read only, after Platform has run that event. Also: root-swap, which also needs
//                                     Chromium closed cleanly before the swap (image/desk-browser-close.sh, task 33 item 3)
//
// Slot mode (ADR 0077 1.3 item 9): a shared host's slot on a template builder, never a member's host. SESSION_SLOT=<k> runs
// every command on the builder that image/host/template-build.sh launched (lib.ts onBuilder: SESSION_SLOT_SSH, SESSION_SLOT_KEY)
// and reaches slot k's Chromium through the test host's CDP forward (10.98.<k>.2:19222, WR2-01: test hosts only), with the
// pages on the host's side of the slot's veth (10.98.<k>.1:18766, a test host's HOST_PORTS). Only the seed (SESSION_KEEP=1)
// and SESSION_CHECK=stop-wake run in a slot; history is read through chrome://history, since the profile is inside the desk.
//
// The restore rehearsal, docs/runbooks/restore-rehearsal.md (TD-110). These need the seed above, left with SESSION_KEEP=1:
//   SESSION_MARK=<name> ...           set a marker cookie and history entry, prove they took, wait for Chromium to commit them
//   SESSION_CHECK=restore SESSION_VOLUME=<vol> SESSION_ABSENT=<names> [SESSION_PRESENT=<names>] ...
//   SESSION_CHECK=putback SESSION_VOLUME=<vol> SESSION_PRESENT=<names> ...
//   SESSION_CHECK=rollback SESSION_PRESENT=<names> ...
// These three seed nothing. Before anything starts Chromium they read the boot, the mounted volume, the volume record, the
// DTLS identity and both Chromium versions, and they stop there on a bad answer, so Chromium never touches a profile it
// could raze and the volume stays as the boot left it. Reading the session still means running Chromium on the profile.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { onBuilder, onDesk } from './lib';

const CHECK = process.env.SESSION_CHECK ?? '';
const SLOT = process.env.SESSION_SLOT ?? '';
const MARK = process.env.SESSION_MARK ?? '';
const MARK_WAIT_S = Number(process.env.SESSION_MARK_WAIT ?? 120);
const names = (v?: string) => (v ?? '').split(',').filter(Boolean);
const ABSENT = names(process.env.SESSION_ABSENT);
const PRESENT = names(process.env.SESSION_PRESENT);
const VOLUME = process.env.SESSION_VOLUME ?? '';
const REHEARSAL = ['restore', 'putback', 'rollback'].includes(CHECK);
const BASELINE = 'screenshots/session-baseline.json';

// Refused at load, before anything reaches the desk.
for (const n of [...(MARK ? [MARK] : []), ...ABSENT, ...PRESENT]) if (!/^[a-z0-9_]{1,24}$/.test(n)) throw new Error(`bad marker name "${n}": a-z, 0-9 and _ only`);
if (MARK && CHECK) throw new Error('SESSION_MARK and SESSION_CHECK are separate runs');
if (SLOT && !/^([1-9]|1[0-9]|2[0-9])$/.test(SLOT)) throw new Error('SESSION_SLOT is a slot number, 1 to 29');
if (SLOT && (MARK || (CHECK && CHECK !== 'stop-wake'))) throw new Error('in a slot, only the seed and SESSION_CHECK=stop-wake run');
if (!(MARK_WAIT_S >= 0)) throw new Error('SESSION_MARK_WAIT is seconds');
if (!REHEARSAL && (ABSENT.length || PRESENT.length || VOLUME)) throw new Error('SESSION_ABSENT, SESSION_PRESENT and SESSION_VOLUME only go with SESSION_CHECK=restore, putback or rollback');
if (CHECK === 'restore' && !ABSENT.length) throw new Error('SESSION_CHECK=restore needs SESSION_ABSENT: with no marker that must be gone, the old volume passes too');
if ((CHECK === 'putback' || CHECK === 'rollback') && !PRESENT.length) throw new Error(`SESSION_CHECK=${CHECK} needs SESSION_PRESENT`);
if ((CHECK === 'restore' || CHECK === 'putback') && !/^vol-[0-9a-f]+$/.test(VOLUME)) throw new Error(`SESSION_CHECK=${CHECK} needs SESSION_VOLUME, the volume that should be mounted`);
if (ABSENT.some((n) => PRESENT.includes(n))) throw new Error('a marker can\'t be both present and absent');
const DIR = '/var/tmp/ma-session';
/** The swap path's helper, as this tree has it, so the check runs on images that don't carry it (task 33 item 3). */
const CLOSE_HELPER = '../image/recipe/files/usr/local/lib/ma/desk-browser-close';
const UNIT = 'ma-session-pages';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SESS_PY = String.raw`
import base64, http.server, json, os, shutil, socket, sqlite3, struct, sys, time, urllib.request
WEB = 18766; HOSTA = os.environ.get('SESS_WEB_HOST', '127.0.0.1'); BASE = 'http://%s:%d' % (HOSTA, WEB); CDP = os.environ.get('SESS_CDP', 'http://127.0.0.1:9222'); PROFILE = '/data/browser/profile/Default'
USER = 'session-e2e'; SECRET = 'test-only-not-a-secret'
def get(p, m='GET'):
    for i in range(6):
        try: return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=10).read()
        except OSError:
            if i == 5: raise
            time.sleep(2)
def tabs(): return [t for t in json.loads(get('/json/list')) if t['type'] == 'page']
def new(u): return json.loads(get('/json/new?' + u, 'PUT'))
def close(t):
    try: get('/json/close/' + t['id'])
    except Exception: pass
def call(t, expr):
    host, path = t['webSocketDebuggerUrl'].split('ws://', 1)[1].split('/', 1); h, p = host.split(':')
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
    msg = json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'awaitPromise': True, 'returnByValue': True}}).encode(); mask = os.urandom(4)
    s.sendall(b'\x81' + (bytes([0x80 | len(msg)]) if len(msg) < 126 else bytes([0x80 | 126]) + struct.pack('>H', len(msg))) + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(msg)))
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
                if m.get('id') == 1: s.close(); return m.get('result', {}).get('result', {}).get('value')
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path.split('?')[0]; self.send_response(200); self.send_header('Content-Type', 'text/html')
        if p == '/set-persist': self.send_header('Set-Cookie', 'e2e_persist=p1; Max-Age=2592000; Path=/; HttpOnly')
        if p == '/set-session': self.send_header('Set-Cookie', 'e2e_session=s1; Path=/; HttpOnly')
        if p == '/set-fresh': self.send_header('Set-Cookie', 'e2e_fresh=f1; Max-Age=2592000; Path=/')
        if p.startswith('/set-mark/') and p[10:].replace('_', '').isalnum(): self.send_header('Set-Cookie', 'e2e_mark_%s=1; Max-Age=2592000; Path=/' % p[10:])
        b = ('<!doctype html><title>C[%s]</title>' % self.headers.get('Cookie', '')).encode()
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
def visit(path, wait=1.0):
    t = new(BASE + path); time.sleep(wait); title = next((x['title'] for x in tabs() if x['id'] == t['id']), None); close(t); return title
def pm(expr):
    t = new('chrome://password-manager/passwords'); time.sleep(2.5)
    try: return call(t, expr)
    finally: close(t)
def hist_ui(q):
    h = new('chrome://history/?q=' + q); time.sleep(3)
    try: return call(h, "(()=>{const a=document.querySelector('history-app');const l=a&&a.shadowRoot.querySelector('history-list');return l?[...l.shadowRoot.querySelectorAll('history-item')].map(i=>i.item&&i.item.url):null})()")
    finally: close(h)
PW_LIST = 'new Promise(r=>chrome.passwordsPrivate.getSavedPasswordList(l=>r(l.map(x=>({id:x.id,username:x.username})))))'
def read():
    out = {'cookies': visit('/echo'), 'tabs': sorted(t['url'] for t in tabs()), 'at': time.time()}
    h = new('chrome://history/?q=session-hist'); time.sleep(3)
    try: out['history'] = call(h, "(()=>{const a=document.querySelector('history-app');const l=a&&a.shadowRoot.querySelector('history-list');return l?[...l.shadowRoot.querySelectorAll('history-item')].map(i=>i.item&&i.item.url):null})()")
    finally: close(h)
    if os.environ.get('SESS_SLOT'): out['historyDb'] = sorted({u for q in ('session-hist-1', 'session-hist-2') for u in (hist_ui(q) or []) if u and 'session-hist' in u})  # a slot's profile is inside the desk: chrome://history, one query a page (one query for both lists only the latest)
    else: shutil.copy(PROFILE + '/History', '/var/tmp/ma-session/h.db'); c = sqlite3.connect('/var/tmp/ma-session/h.db'); out['historyDb'] = sorted(r[0] for r in c.execute("select url from urls where url like '%session-hist%'")); c.close(); os.unlink('/var/tmp/ma-session/h.db')
    t = new('chrome://password-manager/passwords'); time.sleep(2.5)
    try:
        l = call(t, PW_LIST); out['passwords'] = [x['username'] for x in l or []]; me = next((x for x in l or [] if x['username'] == USER), None)
        out['plaintext'] = call(t, "new Promise(r=>chrome.passwordsPrivate.requestPlaintextPassword(%d,'VIEW',p=>r(chrome.runtime.lastError?'ERR '+chrome.runtime.lastError.message:p)))" % me['id']) if me else None
    finally: close(t)
    out['plaintextOk'] = out.pop('plaintext') == SECRET
    return out
def echo():
    # A page that hasn't loaded has no C[...] title, which must never read as "no cookie".
    for _ in range(30):
        t = visit('/echo', 2.0)
        if t and t.startswith('C['): return t
def hist(like):
    d = '/var/tmp/ma-session/h'; shutil.rmtree(d, True); os.makedirs(d)
    for s in ('', '-wal', '-journal'):
        if os.path.exists(PROFILE + '/History' + s): shutil.copy(PROFILE + '/History' + s, d + '/History' + s)
    c = sqlite3.connect(d + '/History'); r = sorted(x[0] for x in c.execute('select url from urls where url like ?', ('%' + like + '%',))); c.close(); shutil.rmtree(d); return r
cmd = sys.argv[1]
if cmd == 'serve': http.server.ThreadingHTTPServer((HOSTA, WEB), H).serve_forever()
elif cmd == 'seed':
    for t in tabs():
        if '18766' in t['url']: close(t)
    if not any(x['username'] == USER for x in pm(PW_LIST) or []):
        print(json.dumps({'add': pm("new Promise(r=>chrome.passwordsPrivate.addPassword({url:'%s/login',username:'%s',password:'%s',note:'',useAccountStore:false},()=>r(chrome.runtime.lastError?chrome.runtime.lastError.message:'added')))" % (BASE, USER, SECRET))}))
    visit('/set-persist'); visit('/set-session'); visit('/session-hist-1'); visit('/session-hist-2')
    new(BASE + '/tab-a'); time.sleep(0.5); new(BASE + '/tab-b'); time.sleep(0.5)
    print(json.dumps({'seeded': True}))
elif cmd == 'read': print(json.dumps(read()))
elif cmd == 'fresh': print(json.dumps({'title': visit('/set-fresh', 0.5)}))
elif cmd == 'clear-fresh': print(json.dumps({'title': visit('/echo')}))
elif cmd == 'mark':
    visit('/set-mark/' + sys.argv[2]); visit('/mark-hist-' + sys.argv[2]); print(json.dumps({'cookies': echo()}))
elif cmd == 'marks': print(json.dumps({'cookies': echo(), 'history': hist('/mark-hist-')}))
elif cmd == 'close':
    n = 0
    for t in tabs():
        if '18766' in t['url'] or t['url'].startswith(('chrome://password-manager', 'chrome://history')): close(t); n += 1
    print(json.dumps({'closed': n}))
`;

/** In a slot: the host's side of its veth, the CDP forward, and a thaw first (deskd may have frozen an unwatched Chromium). */
const SLOT_ENV = SLOT ? `SESS_SLOT=${SLOT} SESS_WEB_HOST=10.98.${SLOT}.1 SESS_CDP=http://10.98.${SLOT}.2:19222` : '';
const THAW = SLOT ? `python3 -I /var/lib/ma-tb/tools/units.py ${SLOT} thaw desk-browser >/dev/null 2>&1 || true; ` : '';
const run = (command: string, timeoutS = 90) => (SLOT ? onBuilder(command, timeoutS) : onDesk(command, timeoutS));
const deploy = () => run(
  `set -e; install -d -m 0755 ${DIR}; echo ${Buffer.from(SESS_PY).toString('base64')} | base64 -d > ${DIR}/sess.py; chmod 0644 ${DIR}/sess.py; ` +
  `systemctl stop ${UNIT} 2>/dev/null || true; systemd-run --quiet --collect --unit=${UNIT} --uid=65534 --gid=65534 ${SLOT ? `--setenv=SESS_WEB_HOST=10.98.${SLOT}.1 ` : ''}/usr/bin/python3 -I ${DIR}/sess.py serve; sleep 1; echo deployed`);
const sess = async (cmd: string) => JSON.parse((await run(`${THAW}env ${SLOT_ENV} python3 -I ${DIR}/sess.py ${cmd} 2>&1 | tail -4`, 120)).trim().split('\n').pop()!);
/** A slot's Chromium: started through units.sock as deskd would, its CDP forward answering, restored tabs registered. */
const slotBrowserUp = async () => {
  await onBuilder(`python3 -I /var/lib/ma-tb/tools/units.py ${SLOT} start desk-browser >/dev/null 2>&1 || true; ` +
    `for i in $(seq 1 120); do ${THAW}curl -s -m 2 http://10.98.${SLOT}.2:19222/json/version >/dev/null && exit 0; sleep 1; done; exit 1`, 180);
  await sleep(12_000);
};
/** Chromium up, its port answering, and restored tabs registered. */
const browserUp = async () => {
  await onDesk(`for i in $(seq 1 120); do [ "$(systemctl is-active desk-browser)" = active ] && curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && exit 0; sleep 1; done; exit 1`, 180);
  await sleep(12_000);
};

function expectSession(r: { cookies: string; tabs: string[]; history: string[] | null; historyDb: string[]; passwords: string[]; plaintextOk: boolean }, event: string) {
  const report = JSON.stringify(r);
  console.log(`[session] ${event}: ${report}`);
  expect.soft(r.cookies, `persistent cookie after ${event}`).toContain('e2e_persist=p1');
  expect.soft(r.cookies, `session cookie after ${event}`).toContain('e2e_session=s1');
  expect.soft(r.historyDb.length, `history after ${event}`).toBeGreaterThanOrEqual(2);
  expect.soft(r.tabs.filter((u) => /\/tab-[ab]$/.test(u)).length, `open tabs after ${event}`).toBe(2);
  expect.soft(r.passwords, `saved password after ${event}`).toContain('session-e2e');
  expect.soft(r.plaintextOk, `saved password decrypts after ${event}`).toBe(true);
}

// What the desk says about itself. One line each; read-only; never prints a key, a cookie or a password.
const FACTS = [
  `echo "image=$(sed -n 's/^version=//p' /etc/ma-release)"`,
  `echo "chromium=$(dpkg-query -W -f='\${Version}' chromium)"`,
  `echo "browser=$(systemctl is-active desk-browser)"`,
  `if mountpoint -q /data; then echo mounted=yes; else echo mounted=no; fi`,
  `echo "volume=$(tr -d ' ' < "/sys/block/$(basename "$(readlink -f "$(findmnt -n -o SOURCE /data)")")/device/serial")"`,
  `echo "lastVersion=$(head -c 64 '/data/browser/profile/Last Version' 2>/dev/null | tr -d '[:space:]')"`,
  `echo "exitType=$(grep -o '"exit_type":"[A-Za-z]*"' /data/browser/profile/Default/Preferences 2>/dev/null | head -1)"`,
  `echo "record=$(cat /data/.ma-volume 2>/dev/null)"`,
  `echo "recordCopy=$(cat /data/desk/volume.json 2>/dev/null)"`,
  `echo "rtc=$(sha256sum /data/rtc/dtls-identity.pem 2>/dev/null | cut -d' ' -f1)"`,
  `echo "rtcOwner=$(stat -c '%U %a' /data/rtc/dtls-identity.pem 2>/dev/null)"`,
  `echo "deskFiles=$(find /data/desk -type f 2>/dev/null | wc -l)"`,
  `echo "deskd=$(curl -s -m 5 --unix-socket /run/desk/deskd-admin.sock http://desk/health | grep -o '"status":"[a-z]*"' | head -1)"`,
  `echo "used=$(df -B1 --output=used /data 2>/dev/null | tail -1 | tr -d ' ')"`,
  `echo "firstboot=$({ journalctl -b -u desk-firstboot --no-pager -o cat; journalctl -b -t desk-firstboot --no-pager -o cat; } 2>/dev/null | tr '\\n' '|')"`,
  `echo "mount=$(journalctl -b -k --no-pager -o cat 2>/dev/null | grep -E 'EXT4-fs .*(recover|mounted filesystem)' | tr '\\n' '|')"`,
  `echo "blame=$(systemd-analyze blame --no-pager 2>/dev/null | grep -E 'desk-firstboot|data[.]mount|desk-datadirs' | tr -s ' ' | tr '\\n' '|')"`,
].join('; ');
async function deskFacts(): Promise<Record<string, string>> {
  const out = await onDesk(FACTS, 120);
  const f = Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  console.log(`[session] desk: ${JSON.stringify(f)}`);
  return f;
}

/** 1:156.0.8078.79-1~deb13u1 -> 156.0.8078.79 */
const upstream = (v: string) => v.replace(/^\d+:/, '').split(/[-~+]/)[0];
/** Number by number. Above 0 when a is newer than b. */
function versionCmp(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

/** Before anything starts Chromium. Image 0.2.2 has no downgrade refusal of its own, so on a rollback this is the only one. */
function checkBoot(f: Record<string, string>) {
  expect(f.mounted, '/data is mounted').toBe('yes');
  expect(f.firstboot, 'desk-firstboot took the volume for what it is').toContain('NOT formatting');
  for (const bad of ['FORMATTED', 'REFUSING', 'creating ext4']) expect(f.firstboot, `desk-firstboot: ${bad}`).not.toContain(bad);
  expect(f.lastVersion, 'the profile has a Last Version. If it has none, Chromium would start a new profile').toMatch(/^\d+(\.\d+)+$/);
  expect(versionCmp(f.lastVersion, upstream(f.chromium)), `profile last ran ${f.lastVersion}, this root has ${f.chromium}: starting it would raze the cookies (ADR 0035)`).toBeLessThanOrEqual(0);
}

/** These never change, whatever happens to the desk. The first SESSION_MARK run keeps them, and every later run compares. */
function compareBaseline(f: Record<string, string>, mayWrite: boolean) {
  const now = { record: f.record, rtc: f.rtc };
  if (!existsSync(BASELINE)) {
    if (!mayWrite) throw new Error(`no ${BASELINE}: run SESSION_MARK first, on the new image`);
    if (!now.record || !now.rtc) throw new Error('no volume record or no DTLS identity to keep. SESSION_MARK belongs on image 0.2.3 or later');
    mkdirSync('screenshots', { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(now, null, 2));
    console.log(`[session] kept as the baseline: ${JSON.stringify(now)}`);
    return;
  }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  expect.soft(now.record, '/data/.ma-volume is unchanged, formattedAt included').toBe(base.record);
  expect.soft(f.recordCopy, '/data/desk/volume.json matches it').toBe(now.record);
  expect.soft(now.rtc, '/data/rtc/dtls-identity.pem is unchanged').toBe(base.rtc);
}

/** Milliseconds from starting the unit to Chromium's port answering. A restored volume reads slowly at first, so this waits up to 10 minutes. */
async function startTimed(): Promise<number> {
  const out = await onDesk(`t0=$(date +%s%3N); systemctl start desk-browser; for i in $(seq 1 600); do [ "$(systemctl is-failed desk-browser)" = failed ] && exit 1; [ "$(systemctl is-active desk-browser)" = active ] && curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && { echo $(( $(date +%s%3N) - t0 )); exit 0; }; sleep 1; done; exit 1`, 660);
  return Number(out.trim().split('\n').pop());
}

/** The first read after a restore can outrun a cold disk and find a page not loaded yet, so it gets two more tries. Every read is logged, and only the last one counts. */
async function readSlowly(): Promise<Parameters<typeof expectSession>[0]> {
  for (let i = 1; ; i++) {
    const t0 = Date.now();
    try {
      const r = await sess('read');
      console.log(`[session] read ${i} took ${Date.now() - t0} ms: ${JSON.stringify(r)}`);
      if (i === 3 || (r.cookies.includes('e2e_persist=p1') && r.cookies.includes('e2e_session=s1') && r.historyDb.length >= 2 && r.tabs.filter((u: string) => /\/tab-[ab]$/.test(u)).length === 2 && r.plaintextOk)) return r;
    } catch (e) {
      console.log(`[session] read ${i} failed after ${Date.now() - t0} ms: ${String(e).slice(0, 200)}`);
      if (i === 3) throw e;
    }
    await sleep(30_000);
  }
}

test.describe.configure({ mode: 'serial' });

if (SLOT) {
  test(CHECK ? `slot ${SLOT}: the session after ${CHECK}` : `slot ${SLOT}: seed cookies, history, tabs and a saved password`, async () => {
    test.setTimeout(10 * 60_000);
    await slotBrowserUp();
    await deploy(); // before the read, so restored tabs find their pages
    if (!CHECK) {
      await sess('seed');
      await sleep(40_000);
      expectSession(await sess('read'), `seed in slot ${SLOT}`);
    } else {
      expectSession(await readSlowly(), `${CHECK} in slot ${SLOT}`);
    }
    if (!process.env.SESSION_KEEP) await sess('close');
  });
}

/**
 * deskd freezes an unwatched Chromium after 60 s (ADR 0045) and a frozen one answers nothing, so a check that drives
 * Chromium as root through systemd would hang part-way. This holds deskd off for the check: it stops deskd, thaws
 * Chromium (the cgroup freezer, the way desk-units thaws) and drops deskd's frozen marker. A check that starts deskd
 * again calls it again, and the afterAll below starts deskd, which thaws anything left frozen at its own start.
 */
const HOLD = 'systemctl stop deskd 2>/dev/null || true; f=/sys/fs/cgroup/system.slice/desk-browser.service/cgroup.freeze; [ -w "$f" ] && echo 0 > "$f"; rm -f /run/desk/browser-frozen; true';
test.afterAll(async () => { if (!SLOT) await onDesk('systemctl start deskd', 90).catch(() => undefined); }); // never the test desk from a slot run

if (SLOT) {
  // slot mode above
} else if (MARK) {
  test(`marker ${MARK}`, async () => {
    await onDesk(HOLD, 90);
    await deploy();
    await onDesk('systemctl start desk-browser', 120);
    await browserUp();
    const set = await sess(`mark ${MARK}`);
    console.log(`[session] marker ${MARK} set ${new Date().toISOString()}`);
    expect(set.cookies, 'the marker cookie took').toContain(`e2e_mark_${MARK}=1`);
    await sleep(MARK_WAIT_S * 1000);
    expect((await sess('marks')).cookies, 'Chromium still has the marker').toContain(`e2e_mark_${MARK}=1`);
    compareBaseline(await deskFacts(), true);
    console.log(`[session] marker ${MARK} ready ${new Date().toISOString()}, ${MARK_WAIT_S} s after it was set`);
  });
} else if (REHEARSAL) {
  test(`session after ${CHECK}`, async () => {
    test.setTimeout(30 * 60_000);
    const f = await deskFacts();
    checkBoot(f);
    if (VOLUME) expect(f.volume.replace(/^vol-?/, 'vol-'), 'the volume mounted at /data').toBe(VOLUME);
    compareBaseline(f, false);
    await deploy(); // first, so restored tabs find their pages
    console.log(`[session] start to Chromium's port: ${await startTimed()} ms (root, for scale: 3169 warm, 73448 cold)`);
    await sleep(12_000);
    expectSession(await readSlowly(), CHECK);
    const m = await sess('marks');
    console.log(`[session] markers: ${JSON.stringify(m)}`);
    expect(m.cookies, 'the echo page answered, or absence means nothing').toBeTruthy();
    const inHistory = (n: string) => m.history.some((u: string) => u.endsWith(`/mark-hist-${n}`));
    for (const n of PRESENT) {
      expect.soft(m.cookies, `marker ${n} must be there`).toContain(`e2e_mark_${n}=1`);
      expect.soft(inHistory(n), `marker ${n} must be in history`).toBe(true);
    }
    for (const n of ABSENT) {
      expect.soft(m.cookies, `marker ${n} must be gone`).not.toContain(`e2e_mark_${n}=1`);
      expect.soft(inHistory(n), `marker ${n} must be gone from history`).toBe(false);
    }
    if (!process.env.SESSION_KEEP) await sess('close');
  });
} else if (CHECK) {
  test(`session survived ${CHECK}`, async () => {
    // Before anything starts Chromium, which marks its profile Crashed while it runs: how the last one ended.
    const f = await deskFacts();
    if (CHECK === 'root-swap') {
      const clean = /"exit_type":"(SessionEnded|Normal)"/;
      if (f.browser === 'active') {
        // 0.3.2's prewarm (desk-browser-prewarm) has already started Chromium: it marks its profile Crashed while it runs, and
        // desk-browser-start rewrites a Crashed before that start, so the profile no longer says how the last one ended.
        // Don't read it. Take the close's own line (desk-browser-close prints exit_type before the swap, and it exits 1
        // unless that is clean) from SESSION_CLOSE_EXIT, and require that it was prewarm that started Chromium. Without it
        // this fails, rather than passing on a value that proves nothing. `touch /data/desk/no-prewarm` before the swap
        // keeps the strict read of the profile below.
        const prewarmed = await onDesk(`journalctl -b -u desk-browser-prewarm --no-pager -o cat | grep -c 'started the Browser' || true`);
        expect.soft(Number(prewarmed.trim()), 'a running Chromium at this point was started by desk-browser-prewarm').toBeGreaterThan(0);
        expect.soft(process.env.SESSION_CLOSE_EXIT ?? '', 'Chromium is running (prewarm), so the profile cannot say how it ended: pass the close helper\'s exit_type as SESSION_CLOSE_EXIT=Normal (or SessionEnded), or set /data/desk/no-prewarm before the swap').toMatch(/^(SessionEnded|Normal)$/);
      } else {
        expect.soft(f.exitType, 'Chromium was closed cleanly before the swap (image/desk-browser-close.sh)').toMatch(clean);
      }
    }
    await onDesk(HOLD, 90);
    await onDesk('systemctl start desk-browser', 120);
    await browserUp();
    await deploy();
    expectSession(await sess('read'), CHECK);
    if (!process.env.SESSION_KEEP) {
      await sess('close');
      await onDesk(`systemctl stop ${UNIT} 2>/dev/null || true; rm -rf ${DIR}`);
    }
  });
} else {
  test.beforeAll(async () => {
    await onDesk(HOLD, 90);
    await onDesk('systemctl start desk-browser', 120);
    await browserUp();
    await deploy();
  });

  test('seed: cookies, history, tabs, saved password, then 40 s for Chromium to commit them', async () => {
    await sess('seed');
    await sleep(40_000);
    expectSession(await sess('read'), 'seed');
  });

  test('kill -9 of Chromium', async () => {
    const before = (await onDesk('systemctl show -p MainPID --value desk-browser')).trim();
    await onDesk('systemctl kill -s KILL --kill-whom=main desk-browser');
    await sleep(5_000);
    await browserUp();
    expect((await onDesk('systemctl show -p MainPID --value desk-browser')).trim()).not.toBe(before);
    expectSession(await sess('read'), 'kill -9');
  });

  test('deskd restart', async () => {
    const before = (await onDesk('systemctl show -p MainPID --value desk-browser')).trim();
    await onDesk('systemctl restart deskd', 90);
    await onDesk(`for i in $(seq 1 60); do curl -s -m 2 --unix-socket /run/desk/deskd-admin.sock http://desk/health | grep -q '"status":"ok"' && exit 0; sleep 1; done; exit 1`, 90);
    expect((await onDesk('systemctl show -p MainPID --value desk-browser')).trim()).toBe(before);
    await onDesk(HOLD, 90);
    expectSession(await sess('read'), 'deskd restart');
  });

  test('clean stop and start of desk-browser', async () => {
    await onDesk('systemctl restart desk-browser', 60);
    await browserUp();
    expectSession(await sess('read'), 'clean restart');
  });

  test('closed for a root swap: deskd first, then Chromium cleanly, and the session is intact after', async () => {
    const helper = readFileSync(CLOSE_HELPER).toString('base64');
    const out = await onDesk(`echo ${helper} | base64 -d | bash -s; echo "rc=$?"`, 180);
    console.log(`[session] close: ${out.trim().replace(/\n/g, ' ')}`);
    try {
      expect(out, 'the helper says Chromium stopped and ended its session').toMatch(/browser=active->inactive exit_type=(SessionEnded|Normal) deskd=(inactive|failed)/);
      expect(out).toContain('rc=0');
      // The profile as the swap would find it: nothing has started Chromium since.
      expect((await onDesk(`grep -o '"exit_type":"[A-Za-z]*"' /data/browser/profile/Default/Preferences | head -1; systemctl is-active desk-browser || true`)).trim())
        .toMatch(/^"exit_type":"(SessionEnded|Normal)"\ninactive$/);
    } finally {
      await onDesk('systemctl start deskd', 90);
      await onDesk(`for i in $(seq 1 90); do curl -s -m 2 --unix-socket /run/desk/deskd-admin.sock http://desk/health | grep -q '"status":"ok"' && exit 0; sleep 1; done; exit 1`, 120);
    }
    await onDesk(HOLD, 90);
    await onDesk('systemctl start desk-browser', 120);
    await browserUp();
    expectSession(await sess('read'), 'close for a root swap');
  });

  test('measured, not a gate: a cookie set just before a kill -9', async () => {
    await sess('fresh');
    await sleep(2_000);
    await onDesk('systemctl kill -s KILL --kill-whom=main desk-browser');
    await sleep(5_000);
    await browserUp();
    const r = await sess('clear-fresh');
    console.log(`[session] cookie set 2 s before kill -9 ${String(r.title).includes('e2e_fresh=f1') ? 'survived' : 'was LOST'}: ${r.title}`);
  });

  test.afterAll(async () => {
    if (!process.env.SESSION_KEEP) await sess('close').catch(() => undefined);
    await onDesk(`systemctl stop ${UNIT} 2>/dev/null || true; rm -rf ${DIR}`).catch(() => undefined);
  });
}
