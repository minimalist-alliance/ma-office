"""extreload.py [id]: reload an extension through chrome://extensions' own API (developerPrivate), as a background target."""
import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
ID = sys.argv[1] if len(sys.argv) > 1 else 'ddkjiahejlhfcafbddmgiahcphecmpfh'
b = cdp.browser()
tid = b.call('Target.createTarget', url='chrome://extensions', background=True)['targetId']
try:
    s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
    for _ in range(40):
        time.sleep(0.25)
        if b.value('typeof chrome.developerPrivate', session=s) == 'object': break
    t0 = time.time()
    print('info before:', json.dumps(b.value("chrome.developerPrivate.getExtensionInfo('%s').then(i => ({state: i.state, location: i.location, version: i.version, controlledInfo: i.controlledInfo, disableReasons: i.disableReasons}))" % ID, session=s, await_promise=True)))
    try:
        r = b.value("chrome.developerPrivate.reload('%s', {failQuietly: true}).then(() => 'reloaded', e => 'error: ' + e)" % ID, session=s, await_promise=True)
    except Exception as e: r = 'eval error: %s' % e
    print('reload:', r, '%.2f s' % (time.time() - t0))
finally:
    b.call('Target.closeTarget', targetId=tid)
