"""ddmin.py <site> [video]: delta-debug which blocked hosts, when allowed, stop the page's anti-adblock "recovery" (a flood of
requests to rotating numbered subdomains, the `rot` count in trace.py) or restore its video. Lab only (ADR 0076 follow-up).
Step 1 a plain blocked run lists the blocked hosts; step 2 allows all and checks the symptom is gone; then ddmin: drop chunks
of hosts while the symptom stays gone. Each test is one quick visit (READ=8, SCROLL=2). Log: results/ddmin-<site>.log"""
import json, os, sys, time
site = sys.argv[1]; mode = sys.argv[2] if len(sys.argv) > 2 else 'rot'
os.environ.setdefault('READ', '8'); os.environ.setdefault('SCROLL', '2')
sys.argv = ['trace.py', 'ma', site]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trace as T, bench
LOG = open(os.path.join(bench.OUT, 'ddmin-%s.log' % T.NAME), 'a')
def log(*a):
    l = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a); print(l, flush=True); LOG.write(l + '\n'); LOG.flush()
def run(hosts):
    if hosts:
        json.dump([{'priority': 2000000, 'action': {'type': 'allow'}, 'condition': {'requestDomains': hosts}}], open('/tmp/bis.json', 'w')); os.environ['ALLOWFILE'] = '/tmp/bis.json'
    else: os.environ.pop('ALLOWFILE', None)
    o = T.one(0); return o
def symptom(o):
    if mode == 'novideo': return not o.get('vcount')
    if mode == 'noplay': return not o.get('vplay')
    if mode == 'video': return bool(o['video'] == 'x' or (isinstance(o['video'], dict) and o['video'].get('failed_text')))
    return o['rot'] >= 40
bench.sh('systemctl', 'stop', 'desk-browser'); bench.sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
o = run([]); log('blocked run: rot', o['rot'], 'video', o['video'], 'blocked', o['blocked'], 'symptom', symptom(o))
hosts = sorted({h for h, c in o['blocked_hosts']}); log('candidates', len(hosts))
if not symptom(o): log('no symptom at baseline; stop'); sys.exit(0)
o = run(hosts); log('all allowed: rot', o['rot'], 'video', o['video'], 'symptom', symptom(o))
if symptom(o): log('allowing every blocked host does not remove it; stop'); sys.exit(0)
C = hosts; n = 2
while len(C) >= 2:
    size = max(1, len(C) // n); chunks = [C[i:i + size] for i in range(0, len(C), size)]; reduced = False
    for ch in chunks:
        rest = [h for h in C if h not in ch]
        o = run(rest); s = symptom(o); log('try without %d hosts -> %d left: rot %s video %s symptom %s' % (len(ch), len(rest), o['rot'], o['video'], s))
        if not s: C = rest; n = max(n - 1, 2); reduced = True; break
    if not reduced:
        if n >= len(C): break
        n = min(len(C), n * 2)
log('MINIMAL SET', C)
