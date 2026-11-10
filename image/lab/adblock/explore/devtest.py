import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp, bench
POL = '/etc/chromium/policies/managed/ma-adblock.json'
cfg = dict(bench.CONFIGS['ubol']); cfg['noFiltering'] = ['b.localhost']
bench.set_policy(cfg); d = json.load(open(POL)); d['DeveloperToolsAvailability'] = 1; json.dump(d, open(POL, 'w'))
t0 = bench.start('/data/bench/p-dev'); b = cdp.browser(); bench.wait_ext(b, t0, True); time.sleep(3)
def sw():
    for t in b.call('Target.getTargets')['targetInfos']:
        if t['type'] == 'service_worker' and bench.ID in t['url']: return t['targetId']
def dyn():
    s = b.call('Target.attachToTarget', targetId=sw(), flatten=True)['sessionId']
    r = b.value("chrome.declarativeNetRequest.getDynamicRules().then(rs => rs.filter(r => r.action.type === 'allowAllRequests').map(r => r.condition))", session=s, await_promise=True)
    b.call('Target.detachFromTarget', sessionId=s); return r
print('attach ok, dyn rules:', dyn())
# change the list, reload policies, reload the extension from its own worker, poll
d['3rdparty']['extensions'][bench.ID]['noFiltering'] = ['a.localhost', 'c.localhost']; json.dump(d, open(POL, 'w'))
T = time.time()
tid = b.call('Target.createTarget', url='chrome://policy', background=True)['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
for _ in range(100):
    time.sleep(0.05)
    try:
        if b.value("typeof chrome.send", session=s) == 'function': break
    except RuntimeError: pass
b.value("chrome.send('reloadPolicies')", session=s); b.call('Target.closeTarget', targetId=tid)
print('policies reloaded %.2f' % (time.time() - T))
time.sleep(0.5)
s = b.call('Target.attachToTarget', targetId=sw(), flatten=True)['sessionId']
print('managed now:', b.value("chrome.storage.managed.get('noFiltering')", session=s, await_promise=True))
b.send('Runtime.evaluate', {'expression': 'chrome.runtime.reload()'}, s); b.pump(0.3)
print('reload sent %.2f' % (time.time() - T))
for i in range(100):
    time.sleep(0.1)
    try:
        if not sw(): continue
        r = dyn()
        if r and sorted(r[0].get('requestDomains', [])) == ['a.localhost', 'c.localhost']:
            print('confirmed at %.2f s: %s' % (time.time() - T, r)); break
    except Exception as e: pass
import adtest; print(adtest.check('a.localhost'), adtest.check('b.localhost'))
print('pages:', [t['url'] for t in b.call('Target.getTargets')['targetInfos'] if t['type'] == 'page'])
b.close(); bench.sh('systemctl', 'stop', bench.UNIT)
