import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json, sys, cdp
b = cdp.browser()
ts = b.call('Target.getTargets')['targetInfos']
sw = [t for t in ts if t['type'] == 'service_worker' and 'ddkjiahejlhfcafbddmgiahcphecmpfh' in t['url']]
print('sw targets:', [(t['targetId'][:8], t['url']) for t in sw])
if sw:
    try:
        s = b.call('Target.attachToTarget', targetId=sw[0]['targetId'], flatten=True)['sessionId']
        print(json.dumps(b.value(sys.argv[1], session=s, await_promise=True), indent=1)[:5000])
    except Exception as e: print('attach/eval failed:', e)
