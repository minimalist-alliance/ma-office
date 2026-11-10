"""ddmin2.py <site|url>: ddmin.py for "the page's main video doesn't play with the blocker" (vidwide.py's check as the symptom,
which waits and presses play the way a member would). Candidates: the hosts a long trace visit has blocked. Lab only."""
import json, os, sys, time
site = sys.argv[1]
os.environ.setdefault('READ', '14'); os.environ.setdefault('SCROLL', '2')
sys.argv = ['trace.py', 'ma', site]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trace as T, bench, cdp, vidwide as V
url = dict(bench.SITES).get(site) or site
LOG = open(os.path.join(bench.OUT, 'ddmin2-%s.log' % T.NAME), 'a')
def log(*a):
    l = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a); print(l, flush=True); LOG.write(l + '\n'); LOG.flush()
def vid(hosts):
    bench.set_policy(bench.CONFIGS['ma']); t0 = bench.start('/data/bench/dd2'); b = cdp.browser()
    try:
        bench.wait_ext(b, t0, True); time.sleep(8)
        if hosts:
            T.sw_eval(b, "chrome.declarativeNetRequest.updateDynamicRules({addRules: %s}).then(() => 'ok')" % json.dumps([{'id': 100, 'priority': 2000000, 'action': {'type': 'allow'}, 'condition': {'requestDomains': hosts}}]))
        o = V.one(b, T.NAME, url); return o
    finally:
        b.close(); bench.sh('systemctl', 'stop', bench.UNIT)
bench.sh('systemctl', 'stop', 'desk-browser'); bench.sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
os.environ.pop('ALLOWFILE', None); o = T.one(0)
hosts = sorted({h for h, c in o['blocked_hosts']}); log('candidates', len(hosts), hosts)
o = vid([]); log('blocked: ok', o['ok'], o['videos_found'], o['played'])
if o['ok']: log('plays at baseline; stop'); sys.exit(0)
for it in range(5):
    # allowing a script lets the page go on to ask for others: collect what is blocked next, until nothing new is
    json.dump([{'priority': 2000000, 'action': {'type': 'allow'}, 'condition': {'requestDomains': hosts}}], open('/tmp/dd2.json', 'w')); os.environ['ALLOWFILE'] = '/tmp/dd2.json'
    new = sorted({h for h, c in T.one(0)['blocked_hosts']} - set(hosts)); os.environ.pop('ALLOWFILE', None)
    log('grow', it, 'new blocked hosts', new)
    if not new: break
    hosts = sorted(set(hosts) | set(new))
o = vid(hosts); log('all allowed: ok', o['ok'], o['videos_found'], o['played'])
if not o['ok']: log('allowing every blocked host does not make it play; stop'); sys.exit(0)
C = hosts; n = 2
while len(C) >= 2:
    size = max(1, len(C) // n); chunks = [C[i:i + size] for i in range(0, len(C), size)]; reduced = False
    for ch in chunks:
        rest = [h for h in C if h not in ch]
        o = vid(rest); log('try without %d hosts -> %d left: ok %s videos %s' % (len(ch), len(rest), o['ok'], o['videos_found']))
        if o['ok']: C = rest; n = max(n - 1, 2); reduced = True; break
    if not reduced:
        if n >= len(C): break
        n = min(len(C), n * 2)
log('MINIMAL SET', C)
