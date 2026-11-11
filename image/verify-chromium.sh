#!/bin/bash
# verify-chromium.sh <part>: what the image gives the desk's Chromium beyond the kiosk itself (from 0.3.5): links out through
# the xdg-open stand-in (runtime spec section 8.11), the password managers' policies by age band (image/README.md, "Sign-in
# extensions"), and JPEG XL off. verify.sh pipes this to root on the box once per part (bash -s -- <part>), and
# lab/img035/ runs it alone on a lab box. Each part puts back the band and the Browser as it found them. It prints BAD <what>
# and FAILED for each failure, and "ran to the end" last. Each part has been seen to fail with what it guards broken:
# evidence/img035-2026-11-11/mutations.txt.
#   links   the stand-in is the only xdg-open and xdg-email on Chromium's PATH (xdg-utils' two diverted off it), its socket
#           directory is desk:kiosk 2750 and mounted in deskd's container, Chromium has no session bus, and chrome://policy
#           has AutoLaunchProtocolsFromOrigins for exactly the six schemes, as mandatory
#   click   an http page's tel:, webcal: and mailto: links, each clicked, reach deskd's links socket (/health browser.links
#           counts one more), and its ssh: and ms-settings: links reach nothing (Chromium asks, and nobody answers)
#   bands   ma.json's ExtensionInstallBlocklist ["*"], ExtensionAllowedTypes ["extension"] and BlockExternalExtensions on
#           every band; ExtensionInstallAllowlist the three password managers on band adult only, as mandatory, and unset on
#           teen, with no band and with a band that isn't one; ma-adult.json the template's bytes, root's, on adult only
#   keys    no key in two of the four managed files, and the teen and adult files hold what this check expects
#   jxl     Chromium's command line turns JXLImageFormat off, and neither a page's request nor its image's has image/jxl in
#           its Accept header, which still asks for AVIF (the control: the header was read)
set -u
part=${1:-}
BAND=/data/desk/age-band HELPER=/usr/local/lib/ma/desk-browser-policy
MA=/etc/chromium/policies/managed/ma.json ADULT=/etc/chromium/policies/managed/ma-adult.json ADULT_T=/etc/ma/chromium-adult.json
TEEN=/etc/ma/chromium-teen.json PORT=18769 SRV=/var/tmp/vc-srv
bad() { echo "BAD: $*"; echo FAILED; }
cat > /var/tmp/vc.py <<'P'
import base64, http.server, json, os, socket, struct, sys, time, urllib.request
CDP = 'http://127.0.0.1:9222'; PORT = 18769; SRV = '/var/tmp/vc-srv'
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()
class WS:  # as verify.sh's, just enough of RFC 6455 for CDP
    def __init__(self, url):
        hostport, path = url[len('ws://'):].split('/', 1); host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), 10); self.s.settimeout(30); self.n = 0
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
    def call(self, method, **params):
        self.n += 1; i = self.n; data = json.dumps({'id': i, 'method': method, 'params': params}).encode(); mask = os.urandom(4)
        n = len(data); hdr = bytes([0x81, 0x80 | n]) if n < 126 else bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data)))
        while True:
            m = json.loads(self.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError('%s: %s' % (method, m['error']))
                return m['result']
    def value(self, expr):
        r = self.call('Runtime.evaluate', expression=expr, returnByValue=True)
        if 'exceptionDetails' in r: raise RuntimeError('evaluation: %s' % json.dumps(r['exceptionDetails'])[:200])
        return r['result'].get('value')
def policy():
    """chrome://policy's set rows, as Chromium itself reports them: {name: [value, status, level, scope, source]}."""
    t = json.loads(get('/json/new?chrome://policy', 'PUT')); w = WS(t['webSocketDebuggerUrl']); out = {}
    js = """JSON.stringify([...document.querySelector('policy-app').shadowRoot.querySelectorAll('policy-table')].flatMap(t => [...t.shadowRoot.querySelectorAll('policy-row')]).map(r => r.policy).filter(p => p && 'value' in p).map(p => [p.name, p.value, p.status, p.level, p.scope, p.source]))"""
    try:
        for _ in range(60):
            time.sleep(0.5)
            try: r = w.value(js)
            except RuntimeError: continue
            out = {x[0]: x[1:] for x in json.loads(r)} if r else {}
            if 'RestoreOnStartup' in out: break
    finally:
        w.s.close(); get('/json/close/' + t['id'])
    return out
def opened(url):
    """A new tab at url, in front, once its document is complete and its title set."""
    t = json.loads(get('/json/new?about:blank', 'PUT')); w = WS(t['webSocketDebuggerUrl'])
    w.call('Page.bringToFront'); w.call('Page.navigate', url=url)
    for _ in range(60):
        time.sleep(0.25)
        try:
            if w.value("document.readyState === 'complete' && document.title === 'vc'"): break
        except RuntimeError: pass
    return t, w
def click(sel):
    """Opens the links page and clicks one link as a member would (a real mouse press and release, so a user gesture).
    The tab stays open 2 s for Chromium to hand the link on, then closes, which also takes away any prompt it showed."""
    t, w = opened('http://127.0.0.1:%d/links?%s' % (PORT, os.urandom(4).hex()))
    try:
        r = w.value("(() => { const e = document.querySelector(%s); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, e.href]; })()" % json.dumps(sel))
        if not r: print('no element', sel); return
        for typ in ('mouseMoved', 'mousePressed', 'mouseReleased'):
            w.call('Input.dispatchMouseEvent', type=typ, x=r[0], y=r[1], button='left' if typ != 'mouseMoved' else 'none', clickCount=1)
        print('clicked', r[2]); time.sleep(2)
    finally:
        w.s.close(); get('/json/close/' + t['id'])
def jxl():
    """The jxl page and its picture, each with a fresh query so no cache answers: the two Accept headers the server saw."""
    tag = os.urandom(4).hex(); t, w = opened('http://127.0.0.1:%d/jxl?%s' % (PORT, tag))
    try:
        for _ in range(40):
            time.sleep(0.25)
            try:
                if w.value("document.images.length && document.images[0].complete"): break
            except RuntimeError: pass
    finally:
        w.s.close(); get('/json/close/' + t['id'])
    seen = {}
    for line in open(SRV + '/accept.log'):
        path, _, accept = line.rstrip('\n').partition(' ')
        if tag in path: seen[path.split('?')[0]] = accept
    print(json.dumps(seen))
def serve():
    links = ('<!doctype html><title>vc</title><body style="font: 40px sans-serif">'
             '<p><a id="tel" href="tel:+15550100">call</a> <a id="webcal" href="webcal://example.invalid/vc.ics">calendar</a>'
             ' <a id="mailto" href="mailto:vc@example.invalid?subject=vc">mail</a></p>'
             '<p><a id="ssh" href="ssh://vc.example.invalid">ssh</a> <a id="mssettings" href="ms-settings:privacy">settings</a></p>')
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            with open(SRV + '/accept.log', 'a') as f: f.write('%s %s\n' % (self.path, self.headers.get('Accept', '')))
            p, _, q = self.path.partition('?')
            if p == '/links': body, ct = links.encode(), 'text/html'
            elif p == '/jxl': body, ct = ('<!doctype html><title>vc</title><img src="/pic.png?%s">' % q).encode(), 'text/html'
            elif p == '/pic.png': body, ct = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), 'image/png'
            else: self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header('content-type', ct); self.send_header('cache-control', 'no-store'); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'policy': print(json.dumps(policy()))
    elif cmd == 'click': click(sys.argv[2])
    elif cmd == 'jxl': jxl()
    elif cmd == 'serve': serve()
P
chmod 644 /var/tmp/vc.py
vc() { timeout 120 python3 -I /var/tmp/vc.py "$@"; }
ask() { timeout 60 setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I -c "
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect('/run/desk/units.sock'); s.sendall(sys.argv[1].encode() + b'\n'); print(s.recv(300).decode().strip())" "$1" 2>&1 | tail -1; }
up() { for i in $(seq 1 120); do [ "$(systemctl is-active desk-browser)" = active ] && curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && return 0; sleep 1; done; bad "Chromium's port never came up"; return 1; }
start_browser() { local r; r=$(ask 'start desk-browser'); [ "$r" = ok ] || bad "units.sock said to start desk-browser: $r"; up; }
stop_browser() { local r; r=$(ask 'stop desk-browser'); [ "$r" = ok ] || bad "units.sock said to stop desk-browser: $r"; }
setband() { rm -rf "$BAND"; printf "$1" > "$BAND"; chown desk:desk "$BAND"; chmod 0644 "$BAND"; }
remember() { rm -rf /var/tmp/vc-start; mkdir -m 0700 /var/tmp/vc-start
  if [ -e "$BAND" ] || [ -L "$BAND" ]; then cp -a "$BAND" /var/tmp/vc-start/band; fi
  systemctl is-active --quiet desk-browser && touch /var/tmp/vc-start/running; }
restore() { local r=0; [ "$(systemctl is-active desk-browser)" = active ] && { stop_browser; r=1; }
  rm -rf "$BAND"; [ -e /var/tmp/vc-start/band ] || [ -L /var/tmp/vc-start/band ] && cp -a /var/tmp/vc-start/band "$BAND"
  if [ -e /var/tmp/vc-start/running ]; then start_browser; else $HELPER 2>/dev/null; fi
  systemctl stop verify-vcpages 2>/dev/null; rm -rf /var/tmp/vc-start; }
browser() { [ "$(systemctl is-active desk-browser)" = active ] && up || start_browser; }
pages_server() { systemctl stop verify-vcpages 2>/dev/null; systemctl reset-failed verify-vcpages 2>/dev/null
  rm -rf "$SRV"; install -d -m 0700 -o 65534 -g 65534 "$SRV"
  systemd-run --quiet --collect --unit=verify-vcpages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/vc.py serve
  for i in $(seq 1 30); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/links" && return 0; sleep 0.2; done; bad "the page server didn't come up"; }
links_total() { curl -s -m 5 --unix-socket /run/desk/deskd-admin.sock http://localhost/health | jq -c '.browser.links // empty'; }
count() { jq -r '(.sent // 0) + ([.dropped // {} | .[]] | add // 0)' <<<"$1"; }
# Chromium's browser process: the unit's main process, once the wrappers have exec'd into it.
chromium_pid() { local p; p=$(systemctl show -p MainPID --value desk-browser); [ "$(cat /proc/${p:-0}/comm 2>/dev/null)" = chromium ] && echo "$p"; }
# Its switches, one a line. Chromium may rewrite its own title, which joins the arguments with spaces in /proc/<pid>/cmdline.
switches() { tr '\0' ' ' < /proc/${1:-0}/cmdline 2>/dev/null | tr ' ' '\n' | grep -- '^--'; }

case "$part" in
links)
  remember; browser
  echo "--- the stand-in"
  s=$(stat -c '%U:%G %a' /usr/local/bin/xdg-open 2>&1); echo "/usr/local/bin/xdg-open: $s, $(head -1 /usr/local/bin/xdg-open 2>&1)"
  [ "$s" = "root:root 755" ] || bad "the stand-in isn't root's 0755"
  grep -q '^"""xdg-open and xdg-email on a desk' /usr/local/bin/xdg-open || bad "/usr/local/bin/xdg-open isn't deskd's stand-in"
  [ "$(readlink /usr/local/bin/xdg-email)" = xdg-open ] || bad "xdg-email isn't a link to the stand-in: $(ls -l /usr/local/bin/xdg-email 2>&1)"
  echo "--- xdg-utils (chromium-common needs it): its xdg-open and xdg-email diverted off PATH"
  dpkg-query -W -f='${Package} ${Version} ${db:Status-Status}\n' xdg-utils 2>&1
  for f in xdg-open xdg-email; do
    t=$(dpkg-divert --truename /usr/bin/$f); echo "/usr/bin/$f: diverted to $t, there: $([ -e /usr/bin/$f ] && echo yes || echo no)"
    [ "$t" = /usr/share/ma/xdg-utils/$f ] && [ ! -e /usr/bin/$f ] && [ ! -L /usr/bin/$f ] || bad "/usr/bin/$f is xdg-utils' and on PATH"
  done
  # Chromium's environment is what systemd gives the unit (the manager's, then the unit's own Environment and files) and
  # what Debian's /usr/bin/chromium and /etc/chromium.d add. /proc/<pid>/environ can't say: once Chromium rewrites its title
  # (it did with a bus address set, on the lab box) that memory holds the title.
  uenv=$(systemctl show -p Environment --value desk-browser); ufiles=$(systemctl show -p EnvironmentFiles --value desk-browser)
  upass=$(systemctl show -p PassEnvironment --value desk-browser); menv=$(systemctl show-environment)
  cpath=$(tr ' ' '\n' <<<"$uenv" | sed -n 's/^PATH=//p'); [ -n "$cpath" ] || cpath=$(sed -n 's/^PATH=//p' <<<"$menv")
  echo "--- what Chromium finds, by its own PATH ($cpath), as kiosk"
  got=$(setpriv --reuid=kiosk --regid=kiosk --clear-groups env -i PATH="$cpath" sh -c 'command -v xdg-open; command -v xdg-email' | paste -sd' ')
  echo "found: $got"; [ "$got" = "/usr/local/bin/xdg-open /usr/local/bin/xdg-email" ] || bad "Chromium's PATH finds $got"
  echo "--- no session bus for Chromium"
  echo "the unit's Environment: $uenv"; echo "its EnvironmentFiles: ${ufiles:-none}; PassEnvironment: ${upass:-none}"
  for v in DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; do
    tr ' ' '\n' <<<"$uenv" | grep -q "^$v=" && bad "the unit gives Chromium $v"
    grep -q "^$v=" <<<"$menv" && bad "systemd's manager environment has $v"
    grep -qw "$v" <<<"$upass" && bad "the unit passes $v through"
    hits=$(grep -l "$v" /etc/chromium.d/* /usr/bin/chromium /usr/local/lib/ma/desk-browser-start 2>/dev/null | paste -sd' ')
    [ -z "$hits" ] || bad "$v is set by $hits"
  done
  [ -z "$ufiles" ] || bad "the unit reads an environment file ($ufiles), which this check doesn't read"
  pid=$(chromium_pid); envp=$(tr '\0' '\n' < /proc/${pid:-0}/environ 2>/dev/null)
  grep -q '^DBUS_SESSION_BUS_ADDRESS=' <<<"$envp" && bad "Chromium's process ($pid) has a session bus address"
  [ -e /run/user/$(id -u kiosk) ] && bad "kiosk has a user runtime directory"
  pgrep -u kiosk -x dbus-daemon >/dev/null && bad "a bus runs as kiosk"
  command -v dbus-launch >/dev/null && bad "dbus-launch is installed, which Chromium could start a session bus with"
  echo "/run/user/$(id -u kiosk): $([ -e /run/user/$(id -u kiosk) ] && echo there || echo none); dbus-launch: $(command -v dbus-launch || echo none)"
  echo "--- the socket's directory, and deskd's view of it"
  grep -x 'd /run/desk-links 2750 desk kiosk -' /etc/tmpfiles.d/desk-links.conf || bad "no tmpfiles line for /run/desk-links"
  d=$(stat -c '%U:%G %a' /run/desk-links 2>&1); echo "/run/desk-links: $d"; [ "$d" = "desk:kiosk 2750" ] || bad "/run/desk-links is $d"
  m=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/desk-links"}}{{.Source}}{{end}}{{end}}' deskd 2>&1); echo "deskd's mount of it: ${m:-none}"
  [ "$m" = /run/desk-links ] || bad "deskd's container doesn't have /run/desk-links"
  l=$(links_total); echo "deskd /health browser.links: ${l:-absent}"; [ -n "$l" ] || bad "deskd has no links socket up (a deskd from before links out, 3c132d94?)"
  s=$(stat -c '%U:%G %a %F' /run/desk-links/links.sock 2>&1); echo "links.sock: $s"; [ "$s" = "desk:kiosk 660 socket" ] || bad "links.sock is $s"
  echo "--- the policy, as Chromium applies it"
  vc policy > /var/tmp/vc-pol.json
  python3 -I - /var/tmp/vc-pol.json "$MA" <<'Q' || bad "AutoLaunchProtocolsFromOrigins"
import json, sys
rows, ma = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])); want = [{'protocol': p, 'allowed_origins': ['*']} for p in ('tel', 'sms', 'zoommtg', 'msteams', 'facetime', 'webcal')]
r = rows.get('AutoLaunchProtocolsFromOrigins'); print('AutoLaunchProtocolsFromOrigins: %s' % json.dumps(r))
sys.exit(0 if ma.get('AutoLaunchProtocolsFromOrigins') == want and r and r[0] == want and r[1:] == ['OK', 'mandatory', 'machine', 'platform'] else 1)
Q
  restore ;;
click)
  remember; browser; pages_server
  l0=$(links_total); echo "deskd /health browser.links before: ${l0:-absent}"
  [ -n "$l0" ] || { bad "deskd has no links socket up, so nothing can be counted"; l0='{}'; }
  n=$(count "$l0")
  for id in tel webcal mailto ssh mssettings; do
    case $id in tel|webcal|mailto) want=1 ;; *) want=0 ;; esac
    sleep 4   # deskd passes at most 3 links in any 10 s, and counts the rest too, as "rate": spaced, each click is its own count
    vc click "#$id"; got=$n
    for i in $(seq 1 20); do got=$(count "$(links_total)"); [ "$got" -gt "$n" ] && break; [ $want = 0 ] && [ $i -ge 10 ] && break; sleep 0.5; done
    echo "$id: deskd counted $((got - n)) ($(links_total))"
    [ $((got - n)) = $want ] || bad "$id: deskd counted $((got - n)), wanted $want"
    n=$got
  done
  echo "server saw: $(cut -d' ' -f1 $SRV/accept.log | sed 's/?.*//' | sort | uniq -c | xargs)"
  journalctl -u desk-browser --since '-2min' --no-pager -o cat | grep -i 'xdg-open (desk)' | tail -3
  restore ;;
bands)
  remember; [ "$(systemctl is-active desk-browser)" = active ] && stop_browser
  for b in adult teen none garbage adult; do
    case $b in adult) setband 'adult\n' ;; teen) setband 'teen\n' ;; none) rm -rf "$BAND" ;; garbage) setband 'Adult\n' ;; esac
    start_browser; vc policy > /var/tmp/vc-pol.json
    echo "--- band $b: managed files $(ls /etc/chromium/policies/managed | paste -sd' ')"
    python3 -I - /var/tmp/vc-pol.json "$b" <<'Q' || bad "band $b: Chromium's policies"
import json, sys
rows, band = json.load(open(sys.argv[1])), sys.argv[2]; bad = 0
def want(ok, what):
    global bad; print(('ok: ' if ok else 'BAD: ') + what); bad += not ok
def applied(k, v):
    r = rows.get(k); want(r is not None and r[0] == v and r[1:] == ['OK', 'mandatory', 'machine', 'platform'], '%s applied as %s: %s' % (k, json.dumps(v), json.dumps(r)))
applied('ExtensionInstallBlocklist', ['*']); applied('ExtensionAllowedTypes', ['extension']); applied('BlockExternalExtensions', True)
ids = ['nngceckbapebfimnlniiiahkandclblb', 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', 'ghmbeldphafepmbegfdlkpapadhbakde']
if band == 'adult': applied('ExtensionInstallAllowlist', ids)
else: want('ExtensionInstallAllowlist' not in rows, 'ExtensionInstallAllowlist unset: %s' % json.dumps(rows.get('ExtensionInstallAllowlist')))
want(('DnsOverHttpsMode' in rows) == (band != 'adult'), 'the teen lock %s' % ('off' if band == 'adult' else 'on'))
sys.exit(1 if bad else 0)
Q
    if [ $b = adult ]; then
      cmp -s "$ADULT" "$ADULT_T" && [ ! -L "$ADULT" ] && [ "$(stat -c '%U:%G %a' "$ADULT")" = "root:root 644" ] && echo "ma-adult.json: the template's bytes, root:root 644" || bad "band adult: ma-adult.json isn't the template's, root's, 0644"
    else
      [ ! -e "$ADULT" ] && [ ! -L "$ADULT" ] && echo "ma-adult.json: none" || bad "band $b: ma-adult.json is there"
    fi
    journalctl -u desk-browser --since '-1min' --no-pager -o cat | grep '^desk-browser-policy:' | tail -1
    stop_browser
  done
  for u in desk kiosk; do
    as() { setpriv --reuid="$(id -u $u)" --regid="$(id -g $u)" --init-groups sh -c "$1" 2>/dev/null; }
    for try in "echo x >> $ADULT_T" ": > $ADULT_T" "rm -f $ADULT_T" "echo x > $ADULT"; do as "$try" && bad "$u could: $try"; done
  done
  [ -s "$ADULT_T" ] && echo "uids 1100 and 1102 can't write the template or put an allowlist in place" || bad "the template is gone or empty"
  restore ;;
keys)
  python3 -I - "$MA" "$TEEN" "$ADULT_T" /etc/ma/chromium-adblock.json <<'Q' || bad "the managed files"
import itertools, json, sys
d = {f: json.load(open(f)) for f in sys.argv[1:]}; bad = 0
def want(ok, what):
    global bad; print(('ok: ' if ok else 'BAD: ') + what); bad += not ok
for a, b in itertools.combinations(d, 2):
    s = sorted(set(d[a]) & set(d[b])); want(not s, '%s and %s share %s' % (a, b, s or 'nothing'))
ma, teen, adult = d[sys.argv[1]], d[sys.argv[2]], d[sys.argv[3]]
want(sorted(teen) == ['DnsOverHttpsMode', 'DnsOverHttpsTemplates', 'ForceGoogleSafeSearch', 'ForceYouTubeRestrict', 'ProxyMode'], 'chromium-teen.json: the lock alone, %s' % sorted(teen))
want(adult == {'ExtensionInstallAllowlist': ['nngceckbapebfimnlniiiahkandclblb', 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', 'ghmbeldphafepmbegfdlkpapadhbakde']}, 'chromium-adult.json: the three password managers, %s' % json.dumps(adult))
want(ma.get('ExtensionInstallBlocklist') == ['*'] and ma.get('ExtensionAllowedTypes') == ['extension'] and ma.get('BlockExternalExtensions') is True and 'ExtensionInstallForcelist' not in ma,
     'ma.json: every extension blocked but what a policy allows, extensions only, none from outside')
sys.exit(1 if bad else 0)
Q
  for f in "$TEEN" "$ADULT_T"; do [ "$(stat -c '%U:%G %a' $f)" = "root:root 644" ] || bad "$f: $(stat -c '%U:%G %a' $f)"; done ;;
jxl)
  remember; browser; pages_server
  pid=$(chromium_pid); [ -n "$pid" ] || bad "no Chromium browser process"; c=$(switches "$pid" | grep -- '^--disable-features' | paste -sd' ')
  echo "Chromium's --disable-features: ${c:-none}"
  [ "$(switches "$pid" | grep -c -- '^--disable-features')" = 1 ] || bad "not exactly one --disable-features (Chromium reads only the last)"
  case ",${c#--disable-features=}," in *,JXLImageFormat,*) ;; *) bad "JXLImageFormat isn't turned off" ;; esac
  r=$(vc jxl); echo "Accept headers: $r"
  python3 -I -c 'import json, sys; s = json.loads(sys.argv[1]); p, i = s.get("/jxl", ""), s.get("/pic.png", "")
ok = p and i and "image/jxl" not in p and "image/jxl" not in i and "image/avif" in i and "image/avif" in p
sys.exit(0 if ok else 1)' "$r" || bad "an Accept header has image/jxl, or a request wasn't seen"
  restore ;;
*) bad "no part $part" ;;
esac
echo "ran to the end"
