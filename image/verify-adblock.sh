#!/bin/bash
# verify-adblock.sh <part>: the desk Browser's ad and tracker blocker and its per-site switch on a booted desk (ADR 0076).
# verify.sh pipes this to root on the box once per part (bash -s -- <part>), and lab/adblock/lab.sh runs it on a lab box.
# Each part puts back what it changed, except "leave-off", which leaves one site off for the root replacement's part, "swap".
# It prints BAD <what> and FAILED for each failure, and "ran to the end" last. Each part has been seen to fail with what it
# guards broken: evidence/adblock-2026-11-07/breaks.txt.
#   install   the image's blocker installed at the pinned version from the image's own manifest, with two permissions, no
#             host permissions or content scripts and only block and allow rules, every list on, under the teen lock
#             and on band adult; Chromium reports the policy; an ad request is blocked and the page's other script runs
#   switch    through units.sock as deskd: off for one site only, confirmed by the blocker's own rules, then on again, and
#             no page of the helper's left
#   restart   the list survives a Chromium restart: the policy and the blocker hold it, and 10 s later the site is off
#             and another is blocked
#   stopped   a list written while Chromium is down applies at its next start by itself, and through an apply after it
#   kill      the kill switch: nothing blocked, the blocker still installed, the list kept, uid 1100 can't set or clear
#             it; then on again
#   cookies   a profile's cookies and local storage are byte-identical after pages with the blocker on (T47S-2), and the
#             blocker has no script in a page
#   hostile   a symlink, a FIFO, a directory, an oversized list and bad lines: blocking stays on, no hang, the Browser
#             starts, no site in the log; uids 1100 and 1102 can't change the template or the policy; the policy is
#             root:kiosk 0640, which uids 1100 and 1103 can't read (T47S-3)
#   keys      no key in two managed files (four from 0.3.5); the policy is the template with the list and the kill switch
#   leave-off one site off, for "swap"
#   swap      after a real root replacement: the list kept on /data, the policy rendered again at the Browser's start, the
#             blocker still installed and running, the site still off and another blocked; then the list goes
set -u
part=${1:-}
ID=$(python3 -I -c 'import json; print(*json.load(open("/etc/ma/chromium-adblock.json"))["ExtensionSettings"])' 2>/dev/null)
KILL=/data/.ma-adblock-off
LIST=/data/desk/adblock-off POLICY=/etc/chromium/policies/managed/ma-adblock.json TEMPLATE=/etc/ma/chromium-adblock.json
HELPER=/usr/local/lib/ma/desk-adblock BAND=/data/desk/age-band
OFF=a.ma-verify.localhost ON=b.ma-verify.localhost PORT=18767
bad() { echo "BAD: $*"; echo FAILED; }
cat > /var/tmp/ab.py <<'P'
import base64, glob, http.server, json, os, re, socket, struct, sys, time, urllib.request
CDP = 'http://127.0.0.1:9222'; PORT = 18767
ID = next(iter(json.load(open('/etc/ma/chromium-adblock.json'))['ExtensionSettings']))
NAME = 'Minimalist Alliance blocker'
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()
class WS:  # as verify.sh's, with events kept
    def __init__(self, url):
        hostport, path = url[len('ws://'):].split('/', 1); host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), 10); self.s.settimeout(30); self.n = 0; self.events = []
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
    def call(self, method, session=None, **params):
        self.n += 1; i = self.n; m = {'id': i, 'method': method, 'params': params}
        if session: m['sessionId'] = session
        data = json.dumps(m).encode(); mask = os.urandom(4); n = len(data)
        hdr = bytes([0x81, 0x80 | n]) if n < 126 else bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data)))
        while True:
            r = json.loads(self.recv())
            if r.get('id') == i:
                if 'error' in r: raise RuntimeError('%s: %s' % (method, r['error']))
                return r['result']
            self.events.append(r)
    def value(self, expr, session=None):
        r = self.call('Runtime.evaluate', session=session, expression=expr, returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in r: raise RuntimeError('evaluation: %s' % json.dumps(r['exceptionDetails'])[:200])
        return r['result'].get('value')
def browser(): return WS(json.loads(get('/json/version'))['webSocketDebuggerUrl'])
def worker(b):
    for t in b.call('Target.getTargets')['targetInfos']:
        if t['type'] == 'service_worker' and t['url'].startswith('chrome-extension://%s/' % ID): return t['targetId']
def wake():
    """Its worker sleeps when idle and nothing at a start wakes it: start it as Chromium's ServiceWorker domain can."""
    t = json.loads(get('/json/new?about:blank', 'PUT')); w = WS(t['webSocketDebuggerUrl'])
    try:
        w.call('ServiceWorker.enable'); w.call('ServiceWorker.startWorker', scopeURL='chrome-extension://%s/' % ID)
    except RuntimeError: pass
    finally:
        w.s.close(); get('/json/close/' + t['id'])
def wait_blocker(secs):
    """Up to secs for its worker to answer, then its version: reaching it at all needs DeveloperToolsAvailability 1."""
    end = time.time() + secs
    while time.time() < end:
        try:
            b = browser(); tid = worker(b)
            if tid:
                s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
                v = b.value("chrome.runtime.getManifest().version", s); b.s.close(); return v
            b.s.close(); wake()
        except (OSError, RuntimeError, EOFError, ValueError): pass
        time.sleep(0.5)
    return None
STATE = ("Promise.all([chrome.storage.managed.get(null), chrome.storage.local.get('applied'), chrome.declarativeNetRequest.getDynamicRules(), chrome.declarativeNetRequest.getEnabledRulesets()])"
         ".then(([m, a, rs, en]) => ({managed: m, applied: a.applied || null, through: [...new Set(rs.flatMap(r => r.condition.requestDomains || r.condition.initiatorDomains || []))], rulesets: en,"
         " all: chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r => r.id), version: chrome.runtime.getManifest().version}))")
def state():
    if wait_blocker(30) is None: return None
    b = browser(); tid = worker(b)
    if not tid: return None
    s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']; v = b.value(STATE, s); b.s.close(); return v
def policy_rows():
    """chrome://policy's set rows, Chromium's and the blocker's (its own table), as tl.py reads them."""
    t = json.loads(get('/json/new?chrome://policy', 'PUT')); w = WS(t['webSocketDebuggerUrl']); out = {}
    js = """JSON.stringify([...document.querySelector('policy-app').shadowRoot.querySelectorAll('policy-table')].flatMap(t => [...t.shadowRoot.querySelectorAll('policy-row')]).map(r => r.policy).filter(p => p && 'value' in p).map(p => [p.name, p.value, p.status, p.level, p.scope, p.source]))"""
    try:
        for _ in range(60):
            time.sleep(0.5); r = w.value(js); rows = json.loads(r) if r else []
            out = {x[0]: x[1:] for x in rows}
            if 'RestoreOnStartup' in out and 'noFiltering' in out: break
    finally:
        get('/json/close/' + t['id'])
    return out
def ad_path():
    """A rule the installed blocker has today that blocks a plain path anywhere: so the check follows the lists as they change."""
    for f in sorted(glob.glob('/data/browser/profile/Default/Extensions/%s/*/rules/easylist.json' % ID)) + sorted(glob.glob('/data/browser/profile/Default/Extensions/%s/*/rules/ublock-filters.json' % ID)):
        for r in json.load(open(f)):
            c = r.get('condition', {})
            if r.get('action', {}).get('type') == 'block' and list(c) == ['urlFilter'] and re.fullmatch(r'/[a-z0-9_-]{3,40}\.js', c['urlFilter']):
                return c['urlFilter']
def installed():
    """The installed blocker's manifest and rule action types, from the profile, and Chromium's own word on it."""
    d = sorted(glob.glob('/data/browser/profile/Default/Extensions/%s/*/' % ID))
    if not d: return None
    m = json.load(open(d[-1] + 'manifest.json'))
    acts = sorted({r['action']['type'] for f in glob.glob(d[-1] + 'rules/*.json') for r in json.load(open(f))})
    scripts = sorted(os.path.relpath(f, d[-1]) for f in glob.glob(d[-1] + '**/*.js', recursive=True))
    t = json.loads(get('/json/new?chrome://extensions', 'PUT')); w = WS(t['webSocketDebuggerUrl']); info = None
    try:
        for _ in range(40):
            time.sleep(0.25)
            try: info = w.value("chrome.developerPrivate ? chrome.developerPrivate.getExtensionInfo('%s').then(i => ({version: i.version, updateUrl: i.updateUrl, state: i.state, location: i.location})) : null" % ID)
            except RuntimeError: continue
            if info: break
    finally:
        w.s.close(); get('/json/close/' + t['id'])
    site = json.load(open(d[-1] + 'rules/ma-site-allow.json')) if os.path.exists(d[-1] + 'rules/ma-site-allow.json') else None
    return {'site_allow': site, 'rulesets': sorted(r['id'] for r in m.get('declarative_net_request', {}).get('rule_resources', [])),
            'permissions': m.get('permissions'), 'host_permissions': m.get('host_permissions'), 'content_scripts': m.get('content_scripts'),
            'optional': [k for k in ('optional_permissions', 'optional_host_permissions') if k in m], 'actions': acts, 'scripts': scripts,
            'version': m.get('version'), 'chromium': info}
def serve(ad):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            p = self.path.split('?')[0]
            if p == '/page': body, ct = ('<!doctype html><title>ab</title><script>window.adran=0;window.okran=0</script><script src="%s"></script><script src="/ma-verify-ok.js"></script>' % ad).encode(), 'text/html'
            elif p == ad: body, ct = b'window.adran=1', 'text/javascript'
            elif p == '/ma-verify-ok.js': body, ct = b'window.okran=1', 'text/javascript'
            else: self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header('content-type', ct); self.send_header('cache-control', 'no-store'); self.send_header('content-length', str(len(body)))
            if os.path.exists('/var/tmp/ab-jar-break') and p == '/page' and not self.path.endswith('?jar'): self.send_header('set-cookie', 'ma_verify_plain=changed-by-a-break')
            self.end_headers(); self.wfile.write(body)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
def page(host):
    """Load http://host:PORT/page in a new tab: whether the ad script ran, whether the page's other script ran, what failed."""
    t = json.loads(get('/json/new?about:blank', 'PUT')); w = WS(t['webSocketDebuggerUrl']); o = {}
    try:
        w.call('Runtime.enable'); w.call('Network.enable'); w.call('Page.navigate', url='http://%s:%d/page?%s' % (host, PORT, os.urandom(4).hex()))
        for _ in range(60):
            time.sleep(0.25)
            try: o = json.loads(w.value("JSON.stringify({ready: document.readyState, title: document.title, ad: window.adran, ok: window.okran})") or '{}')
            except RuntimeError: continue
            if o.get('ready') == 'complete' and o.get('title') == 'ab': break
        time.sleep(0.3)
        try: w.value('1')
        except RuntimeError: pass
        o['failed'] = [e['params'].get('errorText') for e in w.events if e.get('method') == 'Network.loadingFailed']
        o['worlds'] = sorted({e['params']['context'].get('name') or '' for e in w.events if e.get('method') == 'Runtime.executionContextCreated' and (e['params']['context'].get('auxData') or {}).get('type') == 'isolated'})
    finally:
        w.s.close(); get('/json/close/' + t['id'])
    return o
def jar(seed=None):
    """The cookies and local storage of the two test sites, as Chromium holds them. With seed, set them first: a cookie of
    each kind on each site, and local storage on each, through a page of the site."""
    out = {}
    for host in ('a.ma-verify.localhost', 'b.ma-verify.localhost'):
        t = json.loads(get('/json/new?about:blank', 'PUT')); w = WS(t['webSocketDebuggerUrl'])
        try:
            w.call('Network.enable'); url = 'http://%s:%d/page?jar' % (host, PORT)
            if seed:
                for name, extra in (('plain', {}), ('httponly', {'httpOnly': True}), ('lax', {'sameSite': 'Lax'}), ('persistent', {'expires': time.time() + 86400 * 30})):
                    w.call('Network.setCookie', name='ma_verify_' + name, value=seed + '-' + name + '-' + host, url=url, **extra)
            w.call('Page.navigate', url=url)
            for _ in range(40):
                time.sleep(0.25)
                try:
                    if w.value("document.readyState") == 'complete': break
                except RuntimeError: pass
            if seed: w.value("localStorage.setItem('ma_verify', %s), localStorage.setItem('ma_verify_2', 'x'.repeat(4096)), 1" % json.dumps(seed + '-' + host))
            cookies = w.call('Network.getCookies', urls=[url])['cookies']
            store = w.value("JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))")
        finally:
            w.s.close(); get('/json/close/' + t['id'])
        out[host] = {'cookies': sorted((c['name'], c['value'], c['domain'], c['path'], round(c.get('expires', -1)), c['httpOnly'], c['secure'], c.get('sameSite')) for c in cookies if c['name'].startswith('ma_verify_')),
                     'storage': json.loads(store)}
    return out
cmd = sys.argv[1]
if cmd == 'serve': serve(sys.argv[2])
elif cmd == 'wait': print(wait_blocker(float(sys.argv[2])))
elif cmd == 'state': print(json.dumps(state()))
elif cmd == 'policy': print(json.dumps(policy_rows()))
elif cmd == 'adpath': print(ad_path() or '')
elif cmd == 'page': print(json.dumps(page(sys.argv[2])))
elif cmd == 'installed': print(json.dumps(installed()))
elif cmd == 'jar': print(json.dumps(jar(sys.argv[2] if len(sys.argv) > 2 else None), sort_keys=True))
elif cmd == 'tabs': print(json.dumps([t['url'] for t in json.loads(get('/json/list')) if t['type'] == 'page']))
elif cmd == 'targets': print(json.dumps([t['type'] + ' ' + t['url'] for t in json.loads(get('/json/list'))]))
P
chmod 644 /var/tmp/ab.py
ab() { timeout 120 python3 -I /var/tmp/ab.py "$@"; }
ask() { timeout 60 setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I -c "
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect('/run/desk/units.sock'); s.sendall(sys.argv[1].encode() + b'\n'); print(s.recv(300).decode().strip())" "$1" 2>&1 | tail -1; }
up() { for i in $(seq 1 120); do [ "$(systemctl is-active desk-browser)" = active ] && curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && return 0; sleep 1; done; bad "Chromium's port never came up"; return 1; }
start_browser() { local r; r=$(ask 'start desk-browser'); [ "$r" = ok ] || bad "units.sock said to start desk-browser: $r"; up; }
stop_browser() { local r; r=$(ask 'stop desk-browser'); [ "$r" = ok ] || bad "units.sock said to stop desk-browser: $r"; }
setlist() { # setlist <bytes, printf format>: as deskd writes it, a temp file then a rename, desk's
  printf "$1" > /data/desk/.adblock-off.v; chown desk:desk /data/desk/.adblock-off.v; chmod 0644 /data/desk/.adblock-off.v; mv -f /data/desk/.adblock-off.v "$LIST"; }
apply() { # apply <what>: through units.sock as deskd; prints how long, and the helper's own line from this run
  local since t0 r l; since=$(date '+%F %T'); sleep 1; t0=$(date +%s.%N); r=$(ask 'start desk-adblock'); local dt; dt=$(echo "$(date +%s.%N) - $t0" | bc)
  [ "$r" = ok ] || bad "$1: units.sock said: $r"
  l=$(journalctl -u desk-adblock --since "$since" --no-pager -o cat | grep '^desk-adblock:' | tail -2 | paste -sd' ')
  echo "$1: $r in ${dt} s; $l"; }
pages() { # pages <what> <off-host-ad-runs 0|1> <on-host-ad-runs 0|1>
  local a b; a=$(ab page "$OFF"); b=$(ab page "$ON"); echo "$1: $OFF $a"; echo "$1: $ON $b"
  for x in "$OFF:$2:$a" "$ON:$3:$b"; do
    local h=${x%%:*} rest=${x#*:}; local want=${rest%%:*} got=${rest#*:}
    case "$got" in *'"ok": 1'*) ;; *) bad "$1: on $h the page's own script didn't run, so the page didn't load" ;; esac
    if [ "$want" = 1 ]; then case "$got" in *'"ad": 1'*) ;; *) bad "$1: on $h the ad request should go through" ;; esac
    else case "$got" in *'"ad": 0'*'ERR_BLOCKED_BY_CLIENT'*) ;; *) bad "$1: on $h the ad request should be blocked by the blocker" ;; esac; fi
  done; }
policy_pages() { ab targets | python3 -I -c 'import json,sys; print(sum(1 for t in json.load(sys.stdin) if " chrome://policy" in t))'; }
no_tabs_left() { # no_tabs_left <what> <count before>: the helper's page (a hidden chrome://policy) goes when it's done, and is
  # never a tab: one left would be the member's to see, and session restore would keep it. Counted against the part's start,
  # since a lab box can carry pages of its own. A close returns before the page is gone, so 5 s.
  local n i; for i in 1 2 3 4 5 6; do n=$(policy_pages); [ "$n" -le "$2" ] && { echo "$1: no page of the helper's left ($n, as before)"; return 0; }; sleep 1; done
  bad "$1: $n chrome://policy page(s), $2 before: one of the helper's is still open"; }
no_site_off() { # for a part that wants blocking everywhere: a lab box can come to it with a site off, which restore puts back
  if [ -e "$LIST" ] || [ -L "$LIST" ]; then rm -rf "$LIST"; [ "$(systemctl is-active desk-browser)" = active ] && apply "no site off for this part"; fi; }
wait_blocker() { local v; v=$(ab wait "${1:-90}"); [ -n "$v" ] && [ "$v" != None ] && echo "blocker running: version $v" || bad "the blocker isn't running (or its worker can't be reached)"; }
pages_server() {
  AD=$(ab adpath); [ -n "$AD" ] || { bad "no plain-path rule in the installed blocker's lists to test with"; AD=/no-rule.js; }
  echo "testing with the blocker's own rule for $AD"
  systemctl stop verify-adpages 2>/dev/null; systemctl reset-failed verify-adpages 2>/dev/null
  systemd-run --quiet --collect --unit=verify-adpages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/ab.py serve "$AD"; sleep 1; }
remember() { rm -rf /var/tmp/ab-start; mkdir -m 0700 /var/tmp/ab-start
  if [ -e "$LIST" ] || [ -L "$LIST" ]; then cp -a "$LIST" /var/tmp/ab-start/list; fi
  systemctl is-active --quiet desk-browser && touch /var/tmp/ab-start/running; }
restore() { rm -rf "$LIST"; [ -e /var/tmp/ab-start/list ] || [ -L /var/tmp/ab-start/list ] && cp -a /var/tmp/ab-start/list "$LIST"
  if [ -e /var/tmp/ab-start/running ]; then [ "$(systemctl is-active desk-browser)" = active ] || start_browser; apply restore; else stop_browser; $HELPER render 2>&1; fi
  systemctl stop verify-adpages 2>/dev/null; }

case "$part" in
install)
  remember
  no_site_off
  echo "band: $(cat "$BAND" 2>/dev/null || echo none); managed files: $(ls /etc/chromium/policies/managed | paste -sd' '); blocker $ID"
  [ "$(systemctl is-active desk-browser)" = active ] || start_browser
  wait_blocker 120; pages_server
  ab policy > /var/tmp/ab-pol.json; python3 -I - /var/tmp/ab-pol.json "$TEMPLATE" <<'P' || bad "Chromium's policy table"
import json, sys
rows, t = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])); (ID,) = t['ExtensionSettings']; bad = 0
def want(ok, what):
    global bad; print(('ok: ' if ok else 'BAD: ') + what); bad += not ok
for k in ('ExtensionSettings', 'DeveloperToolsAvailability'):
    r = rows.get(k); want(r is not None and r[0] == t[k] and r[1] == 'OK' and r[2:] == ['mandatory', 'machine', 'platform'], '%s applied: %s' % (k, json.dumps(r)[:200]))
r = rows.get('off'); want(r is not None and r[0] is False and r[1] == 'OK', "the blocker's off applied: %s" % json.dumps(r))
if 'ExtensionInstallBlocklist' in rows: print('ExtensionInstallBlocklist (every desk from 0.3.5, the teen lock before) in place too: %s' % json.dumps(rows['ExtensionInstallBlocklist'][0]))
sys.exit(1 if bad else 0)
P
  # Installed from the image at the pinned version, and able to do nothing but block (T47S-2): two permissions, no host
  # permissions, no content scripts, no script but its own worker, rules that only block or allow.
  i=$(ab installed); echo "installed: $(echo "$i" | cut -c1-500)"
  python3 -I - "$i" /usr/share/ma/adblock/blocker.json <<'P' || bad "the installed blocker isn't the image's, network-only one"
import json, sys
i, b = json.loads(sys.argv[1]), json.load(open(sys.argv[2])); bad = 0
def want(ok, what):
    global bad; print(('ok: ' if ok else 'BAD: ') + what); bad += not ok
want(i is not None, 'in the profile')
i = i or {}; c = i.get('chromium') or {}
want(i.get('version') == b['version'] == c.get('version'), 'version %s, pinned %s' % (c.get('version'), b['version']))
want(c.get('updateUrl') == 'file:///usr/share/ma/adblock/update.xml', 'updates only from the image: %s' % c.get('updateUrl'))
want(c.get('state') == 'ENABLED', 'enabled: %s' % c.get('state'))
want(i.get('permissions') == ['declarativeNetRequest', 'storage'], 'permissions %s' % i.get('permissions'))
want(not i.get('host_permissions') and not i.get('content_scripts') and not i.get('optional'), 'no host permissions, content scripts or optional ones')
want(i.get('scripts') == ['worker.js'], 'scripts %s' % i.get('scripts'))
want(set(i.get('actions') or ['?']) <= {'block', 'allow'}, 'rule actions %s' % i.get('actions'))
# The site exceptions (site-allow.json): the installed ruleset is what the build recorded, every rule an allow for named sites
# and one exact request above every block rule, and the ruleset is one of those the worker turns on and off with the rest.
sa = i.get('site_allow')
want(bool(sa) and sa == b.get('site_allow'), 'the site exceptions are the build\'s: %s' % json.dumps(sa)[:200])
want(all(r['action']['type'] == 'allow' and r['priority'] > 40 and r['condition'].get('initiatorDomains') and r['condition']['urlFilter'].startswith('||') and not set(r['condition']) - {'urlFilter', 'initiatorDomains'} for r in sa or [{'action': {'type': '?'}}]),
     'each exception is an allow for named sites and one request')
want('ma-site-allow' in (i.get('rulesets') or []) and sorted(i.get('rulesets') or []) == sorted(b['rules']), 'the exceptions are a ruleset of the blocker: %s' % i.get('rulesets'))
sys.exit(1 if bad else 0)
P
  for k in $(seq 1 30); do s=$(ab state); case "$s" in *'"applied": {'*|null|'') break ;; esac; sleep 2; done
  echo "blocker state: $(echo "$s" | cut -c1-400)"
  python3 -I -c 'import json,sys; s=json.loads(sys.argv[1]); sys.exit(not (s and s["all"] and sorted(s["rulesets"]) == sorted(s["all"])))' "$s" || bad "not every list of the blocker is on"
  pages "band $(cat "$BAND" 2>/dev/null || echo none)" 0 0
  tabs=$(ab tabs); echo "tabs: $tabs"; case "$tabs" in *chrome-extension:*) bad "the blocker opened a page of its own" ;; esac
  echo "--- band adult, so no teen lock"
  cp -a "$BAND" /var/tmp/ab-start/band 2>/dev/null; stop_browser; printf 'adult\n' > "$BAND"; chown desk:desk "$BAND"; start_browser
  [ ! -e /etc/chromium/policies/managed/ma-teen.json ] || bad "band adult, and a teen lock"
  wait_blocker 60; pages "band adult" 0 0
  stop_browser; rm -f "$BAND"; [ -e /var/tmp/ab-start/band ] && cp -a /var/tmp/ab-start/band "$BAND"; start_browser; wait_blocker 60
  restore ;;
switch)
  remember; [ "$(systemctl is-active desk-browser)" = active ] || start_browser; wait_blocker 90; pages_server; pp=$(policy_pages)
  setlist "$OFF\n"; apply off
  pages "one site off" 1 0
  s=$(ab state); echo "blocker state: $(echo "$s" | cut -c1-300)"
  case "$s" in *"\"through\": [\"$OFF\"]"*) ;; *) bad "the blocker's own rules don't let exactly $OFF through" ;; esac
  r=$(ab policy | python3 -I -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("noFiltering")))'); echo "Chromium's policy page: noFiltering $r"
  case "$r" in *"\"$OFF\""*) ;; *) bad "chrome://policy doesn't show the list" ;; esac
  setlist ''; apply on
  pages "on again" 0 0
  no_tabs_left "after two applies" "$pp"
  restore ;;
restart)
  remember; [ "$(systemctl is-active desk-browser)" = active ] || start_browser; wait_blocker 90; pages_server
  setlist "$OFF\n"; apply off; pages "before the restart" 1 0
  stop_browser; start_browser; v=$(ab wait 60); echo "blocker back: $v"
  # Recorded, not required: the first page in the moment after a start. Required: the policy, the settings Chromium gives
  # the blocker, its own rules, and the pages 10 s on.
  echo "right after a restart (recorded only): $OFF $(ab page "$OFF" | cut -c1-120)"
  n=$(python3 -I -c 'import json,sys; p=json.load(open(sys.argv[1])); (i,)=p["ExtensionSettings"]; print(json.dumps(p["3rdparty"]["extensions"][i]["noFiltering"]))' "$POLICY")
  echo "the policy after the restart: noFiltering $n"; [ "$n" = "[\"$OFF\"]" ] || bad "the restart's policy doesn't hold the list"
  sleep 8; s=$(ab state); echo "blocker state: $(echo "$s" | cut -c1-300)"
  case "$s" in *"\"noFiltering\": [\"$OFF\"]"*) ;; *) bad "the blocker wasn't given the list at the restart" ;; esac
  case "$s" in *"\"through\": [\"$OFF\"]"*) ;; *) bad "10 s after the restart, the blocker's own rules don't let exactly $OFF through" ;; esac
  pages "10 s after the restart" 1 0
  restore ;;
stopped)
  remember; [ "$(systemctl is-active desk-browser)" = active ] || start_browser; wait_blocker 90; pages_server
  setlist "$OFF\n"; apply off; stop_browser
  setlist "$ON\n"; start_browser; wait_blocker 60; t0=$SECONDS
  # No apply: the blocker takes a policy Chromium gives it at a start, or a moment after, by itself.
  for i in $(seq 1 15); do a=$(ab page "$ON"); case "$a" in *'"ad": 1'*) break ;; esac; sleep 1; done
  echo "the list written while it was down took $((SECONDS - t0)) s after the blocker was up"
  journalctl -u desk-browser -b --no-pager -o cat | grep '^desk-adblock:' | tail -1 | sed 's/^/this start: /'
  pages "a list written while Chromium was down" 0 1
  pp=$(policy_pages); apply "an apply after the start"; pages "and after that apply" 0 1
  no_tabs_left "after the apply" "$pp"
  restore ;;
kill)
  # The kill switch (T47S-2): blocking nothing, the blocker still installed and its list kept; then on again.
  remember; [ "$(systemctl is-active desk-browser)" = active ] || start_browser; wait_blocker 90; pages_server
  setlist "$OFF\n"; apply "a site off"
  rm -rf "$KILL"; : > "$KILL"; chmod 0644 "$KILL"; r=$(systemctl start desk-adblock 2>&1 && echo ok); echo "kill switch set, apply as the Platform would: $r"
  journalctl -u desk-adblock -n 3 --no-pager -o cat | grep '^desk-adblock:' | tail -2
  pages "kill switch set" 1 1
  s=$(ab state); echo "blocker state: $(echo "$s" | cut -c1-300)"
  case "$s" in *'"rulesets": []'*) ;; *) bad "the kill switch left a list on" ;; esac
  case "$s" in *"\"noFiltering\": [\"$OFF\"]"*) ;; *) bad "the kill switch lost the member's list" ;; esac
  v=$(ab wait 30); [ -n "$v" ] && [ "$v" != None ] && echo "still installed: version $v" || bad "the kill switch uninstalled the blocker"
  : > /tmp/ab-kill-try; chown desk /tmp/ab-kill-try
  setpriv --reuid=1100 --regid=1100 --clear-groups sh -c "rm -f $KILL" 2>/dev/null; [ -e "$KILL" ] || bad "uid 1100 could remove the kill switch"
  setpriv --reuid=1100 --regid=1100 --clear-groups sh -c ": > /data/.ma-adblock-off-x" 2>/dev/null && { rm -f /data/.ma-adblock-off-x; bad "uid 1100 can make files in /data"; }
  rm -f "$KILL" /tmp/ab-kill-try; r=$(systemctl start desk-adblock 2>&1 && echo ok); echo "kill switch taken away: $r"
  pages "kill switch taken away" 1 0
  restore ;;
cookies)
  # T47S-2: a profile's cookies and local storage are byte-identical after pages with the blocker on, one of them with a
  # request it blocks. The blocker has no cookie or host permission and no script in a page; this checks the outcome.
  remember; no_site_off; [ "$(systemctl is-active desk-browser)" = active ] || start_browser; wait_blocker 90; pages_server
  seed=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
  before=$(ab jar "$seed"); echo "seeded: $(echo "$before" | cut -c1-200)…"
  case "$before" in *ma_verify_plain*ma_verify_plain*) ;; *) bad "the cookies weren't set, so the check proves nothing" ;; esac
  for k in 1 2 3; do pages "pages with the blocker on, $k" 0 0; done
  setlist "$OFF\n"; apply "a site off"; pages "and with one site off" 1 0; setlist ''; apply "on again"
  after=$(ab jar); [ "$before" = "$after" ] && echo "cookies and local storage: byte-identical ($(echo -n "$after" | wc -c) bytes)" || { bad "cookies or local storage changed"; echo "after: $after" | cut -c1-400; }
  w=$(ab page "$ON"); case "$w" in *'"worlds": []'*) echo "no isolated world in the page: the blocker has no script in it" ;; *) bad "an isolated world in the page: $w" ;; esac
  restore ;;
hostile)
  remember; pages_server
  printf "$OFF\n" > /var/tmp/ab-off; chmod 644 /var/tmp/ab-off
  check() { # check <what>: through the unit, with a time limit; blocking stays on everywhere, the Browser starts
    local t0=$SECONDS since; since=$(date '+%F %T'); sleep 1; stop_browser; start_browser; echo "$1: $((SECONDS - t0)) s"
    [ $((SECONDS - t0)) -lt 40 ] || bad "$1: slow enough to have hung"
    journalctl -u desk-browser --since "$since" --no-pager -o cat | grep '^desk-adblock:' | sed "s/^/$1: /"
    n=$(python3 -I -c 'import json,sys; p=json.load(open(sys.argv[1])); (i,)=p["ExtensionSettings"]; print(len(p["3rdparty"]["extensions"][i]["noFiltering"]))' "$POLICY")
    [ "$n" = "$2" ] || bad "$1: $n site(s) off in the policy, wanted $2"; }
  rm -rf "$LIST"; ln -s /var/tmp/ab-off "$LIST"; check "symlink to a list" 0
  rm -rf "$LIST"; mkfifo "$LIST"; check "FIFO with no writer" 0
  rm -rf "$LIST"; mkdir "$LIST"; check "a directory" 0
  rm -rf "$LIST"; { printf "$OFF\n"; head -c 70000 /dev/zero | tr '\0' 'a'; } > "$LIST"; check "70,000 bytes" 0
  setlist "$OFF\nNOT A SITE\nhttps://x.example/\n10.0.0.1\n$OFF\n"; check "bad lines among good" 1
  rm -rf "$LIST"; mkfifo "$LIST"; t0=$SECONDS; r=$(ask 'start desk-adblock'); echo "apply on a FIFO: $r in $((SECONDS - t0)) s"
  [ "$r" = ok ] && [ $((SECONDS - t0)) -lt 25 ] || bad "apply on a FIFO: $r"
  rm -rf "$LIST"; wait_blocker 60; pages "after all of that" 0 0
  n=$(journalctl -u desk-browser -u desk-adblock -b --no-pager -o cat | grep -c 'ma-verify'); echo "journal lines naming a site: $n"; [ "$n" = 0 ] || bad "a site reached the log"
  for u in desk kiosk; do
    as() { setpriv --reuid="$(id -u $u)" --regid="$(id -g $u)" --init-groups sh -c "$1" 2>/dev/null; }
    as ': > /tmp/ab-own' || bad "$u: can't write even its own file, so a refusal below proves nothing"; rm -f /tmp/ab-own
    for f in "$TEMPLATE" "$POLICY"; do
      for try in "echo x >> $f" ": > $f" "rm -f $f" "mv $f $f.x" "chmod 666 $f" "touch $f"; do as "$try" && bad "$u could: $try"; done
    done
    echo "$u ($(id -u $u)): refused on the template and the policy"
  done
  # T47S-3: the policy, which holds the list, is Chromium's group's to read and no other user's.
  setpriv --reuid=1100 --regid=1100 --clear-groups cat "$POLICY" >/dev/null 2>&1 && bad "uid 1100 can read the policy"
  setpriv --reuid=1103 --regid=1103 --clear-groups cat "$POLICY" >/dev/null 2>&1 && bad "uid 1103 can read the policy"
  setpriv --reuid="$(id -u kiosk)" --regid="$(id -g kiosk)" --init-groups cat "$POLICY" >/dev/null 2>&1 || bad "Chromium's user can't read the policy"
  [ "$(stat -c '%U:%G %a' "$TEMPLATE" "$POLICY" | paste -sd,)" = "root:root 644,root:kiosk 640" ] || bad "owners or modes: $(stat -c '%U:%G %a' "$TEMPLATE" "$POLICY" | paste -sd,)"
  if systemctl is-active --quiet verify-pages; then python3 -I /var/tmp/tl.py cookie || bad "3b2's cookies didn't come through"; else echo "3b2's page server isn't running here, so its cookies aren't read"; fi
  rm -f /var/tmp/ab-off; restore ;;
keys)
  python3 -I - /etc/chromium/policies/managed/ma.json /etc/ma/chromium-teen.json "$TEMPLATE" "$POLICY" "$LIST" "$KILL" /etc/ma/chromium-adult.json <<'P' || bad "the policy files"
import itertools, json, os, sys
a, b, c, p = (json.load(open(f)) for f in sys.argv[1:5]); bad = 0
# From 0.3.5 a fourth: the password managers' allowlist, an adult's (image/README.md, "Sign-in extensions")
files = [(1, a), (2, b), (3, c)] + ([(7, json.load(open(sys.argv[7])))] if os.path.exists(sys.argv[7]) else [])
for (n1, x), (n2, y) in itertools.combinations(files, 2):
    s = sorted(set(x) & set(y)); print('%s and %s share %s' % (sys.argv[n1], sys.argv[n2], s or 'nothing')); bad += bool(s)
try: lst = [l for l in open(sys.argv[5]).read().split('\n') if l]
except OSError: lst = []
(i,) = c['ExtensionSettings']
want = json.loads(json.dumps(c)); want['3rdparty']['extensions'][i].update(noFiltering=lst, off=os.path.isfile(sys.argv[6]))
print('the policy is the template with the list (%d site(s)) and the kill switch: %s' % (len(lst), p == want)); bad += p != want
sys.exit(1 if bad else 0)
P
  ;;
leave-off)
  setlist "$OFF\n"; [ "$(systemctl is-active desk-browser)" = active ] && apply "left off for the root replacement" || $HELPER render
  echo "list: $(cat "$LIST")" ;;
swap)
  echo "list on /data: $(cat "$LIST" 2>/dev/null || echo none)"; [ "$(cat "$LIST" 2>/dev/null)" = "$OFF" ] || bad "the list didn't survive the root replacement"
  journalctl -b -u desk-browser --no-pager -o cat | grep '^desk-adblock:' | sed 's/^/this boot: /'
  journalctl -b -u desk-browser --no-pager -o cat | grep -q '^desk-adblock: policy written: blocking off on 1 site(s)' || bad "the helper didn't render the list on this root"
  [ "$(systemctl is-active desk-browser)" = active ] || start_browser
  wait_blocker 120; pages_server
  for i in $(seq 1 15); do a=$(ab page "$OFF"); case "$a" in *'"ad": 1'*) break ;; esac; sleep 1; done
  pages "after a real root replacement" 1 0
  rm -f "$LIST"; apply "list removed"; systemctl stop verify-adpages 2>/dev/null ;;
*) bad "no part $part" ;;
esac
echo "ran to the end"
