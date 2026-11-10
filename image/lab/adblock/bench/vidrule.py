"""vidrule.py <site|url> <rules.json|-> : vidwide's check of one page with the shipped blocker plus extra dynamic rules (a JSON list;
ids are assigned here). Lab only."""
import json, os, sys, time
site, rf = sys.argv[1], sys.argv[2]
sys.argv = ['trace.py', 'ma', site]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trace as T, bench, cdp, vidwide as V
url = dict(bench.SITES).get(site) or site
rules = json.load(open(rf)) if rf != '-' else []
for i, r in enumerate(rules): r['id'] = 100 + i; r.setdefault('priority', 2000000)
bench.sh('systemctl', 'stop', 'desk-browser'); bench.sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
bench.set_policy(bench.CONFIGS['ma']); t0 = bench.start('/data/bench/vr'); b = cdp.browser()
try:
    bench.wait_ext(b, t0, True); time.sleep(8)
    if rules: T.sw_eval(b, "chrome.declarativeNetRequest.updateDynamicRules({addRules: %s}).then(() => 'ok')" % json.dumps(rules))
    o = V.one(b, T.NAME, url); print(json.dumps({k: o.get(k) for k in ('site', 'ok', 'videos_found', 'played', 'text_chars')}))
finally:
    b.close(); bench.sh('systemctl', 'stop', bench.UNIT); bench.set_policy(None)
