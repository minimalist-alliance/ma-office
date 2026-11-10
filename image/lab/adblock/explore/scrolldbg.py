import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp, bench
bench.set_policy(bench.CONFIGS['ubol']); t0 = bench.start('/data/bench/p-dbg'); b = cdp.browser(); bench.wait_ext(b, t0, True); time.sleep(5)
tid = b.call('Target.createTarget', url='about:blank')['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
b.call('Page.enable', session=s); b.call('Page.bringToFront', session=s)
b.call('Page.navigate', session=s, url=sys.argv[1]); b.pump(12)
print(b.value("JSON.stringify({y: scrollY, se: document.scrollingElement && document.scrollingElement.tagName, sh: document.scrollingElement.scrollHeight, ih: innerHeight, at: (e => e && (e.tagName + '#' + e.id + '.' + e.className).slice(0, 80))(document.elementFromPoint(960, 600)), ov: getComputedStyle(document.documentElement).overflowY + '/' + getComputedStyle(document.body).overflowY})", session=s))
for x, y in ((960, 600), (200, 500)):
    b.call('Input.dispatchMouseEvent', session=s, type='mouseMoved', x=x, y=y)
    for i in range(20): b.send('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': x, 'y': y, 'deltaX': 0, 'deltaY': 60}, s); b.pump(0.05)
    b.pump(0.5); print(x, y, b.value("JSON.stringify({y: scrollY, st: document.scrollingElement.scrollTop, bt: document.body.scrollTop})", session=s))
b.close(); bench.sh('systemctl', 'stop', bench.UNIT)
