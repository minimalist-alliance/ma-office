"""peek.py <off|ma> <url> [rules.json]: load a page in a fresh Chromium, wait 12 s, print title, the first 500 characters of text and the
state of the first video, and save results/peek-<cfg>.jpg. Lab only."""
import base64, json, os, sys, time
cfgname, url = sys.argv[1], sys.argv[2]; rf = sys.argv[3] if len(sys.argv) > 3 else None
sys.argv = ['trace.py', cfgname, 'x']
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trace as T, bench, cdp
bench.sh('systemctl', 'stop', 'desk-browser'); bench.sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
cfg = bench.CONFIGS[cfgname]; bench.set_policy(cfg); t0 = bench.start('/data/bench/peek'); b = cdp.browser()
try:
    bench.wait_ext(b, t0, cfg is not None); time.sleep(6)
    if rf:
        os.environ['ALLOWFILE'] = rf; T.add_allow(b)
    tid = b.call('Target.createTarget', url='about:blank')['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
    b.call('Page.enable', session=s); b.call('Page.bringToFront', session=s); b.call('Page.navigate', session=s, url=url); b.pump(12)
    print(b.value("document.title", session=s)); print((b.value("document.body.innerText", session=s) or '')[:500].replace('\n', ' | '))
    shot = b.call('Page.captureScreenshot', session=s, format='jpeg', quality=40)['data']
    open(os.path.join(bench.OUT, 'peek-%s-%s.jpg' % (cfgname, T.NAME if False else url.split('/')[2])), 'wb').write(base64.b64decode(shot))
finally:
    b.close(); bench.sh('systemctl', 'stop', bench.UNIT); bench.set_policy(None)
