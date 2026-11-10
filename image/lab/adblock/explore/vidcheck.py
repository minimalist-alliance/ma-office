import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp, bench
bench.set_policy(bench.CONFIGS['ubol']); t0 = bench.start('/data/bench/p-dbg'); b = cdp.browser(); bench.wait_ext(b, t0, True); time.sleep(5)
for url in sys.argv[1:]:
    tid = b.call('Target.createTarget', url='about:blank')['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
    b.call('Page.enable', session=s); b.call('Page.bringToFront', session=s)
    b.call('Page.navigate', session=s, url=url); b.pump(8)
    try: print('play:', b.value("(()=>{const v=document.querySelector('video'); return v ? Promise.race([v.play().then(()=>'ok', e=>'err '+e.name), new Promise(r=>setTimeout(()=>r('timeout'),5000))]) : 'no video'})()", session=s, await_promise=True))
    except Exception as e: print('play error', e)
    for i in range(4):
        b.pump(3); print(url[:50], b.value("JSON.stringify({t: document.title.slice(0,50), v: [...document.querySelectorAll('video')].map(v => [Math.round(v.currentTime*10)/10, v.paused, v.videoWidth, v.muted])})", session=s))
    shot = b.call('Page.captureScreenshot', session=s, format='jpeg', quality=30)['data']
    import base64; open('/var/tmp/lab/results/vid-%d.jpg' % sys.argv.index(url), 'wb').write(base64.b64decode(shot))
    b.call('Target.closeTarget', targetId=tid); b.pump(1)
b.close(); bench.sh('systemctl', 'stop', bench.UNIT)
