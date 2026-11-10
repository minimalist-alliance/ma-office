"""applytime.py <off-host> <on-host>: write nothing; force a policy reload, reload uBOL, and time until the off-host's ad runs."""
import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp, adtest
ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
b = cdp.browser()
t0 = time.time()
tid = b.call('Target.createTarget', url='chrome://policy', background=True)['targetId']
s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
for _ in range(80):
    time.sleep(0.05)
    try:
        if b.value("typeof chrome.send", session=s) == 'function' and b.value('document.readyState', session=s) == 'complete': break
    except RuntimeError: pass
b.value("chrome.send('reloadPolicies')", session=s); t1 = time.time()
b.call('Page.navigate', session=s, url='chrome://extensions')
for _ in range(80):
    time.sleep(0.05)
    try:
        if b.value('typeof chrome.developerPrivate', session=s) == 'object': break
    except RuntimeError: pass
r = b.value("chrome.developerPrivate.reload('%s', {failQuietly: true}).then(() => 'reloaded', e => 'error: ' + e)" % ID, session=s, await_promise=True); t2 = time.time()
b.call('Target.closeTarget', targetId=tid)
print('policy reload at %.2f s, uBOL reload %s at %.2f s' % (t1 - t0, r, t2 - t0))
for i in range(60):
    a = adtest.check(sys.argv[1]); c = adtest.check(sys.argv[2])
    print('%.2f s: %s %s, %s %s' % (time.time() - t0, sys.argv[1], a['adran'], sys.argv[2], c['adran']))
    if a['adran'] == 1: break
