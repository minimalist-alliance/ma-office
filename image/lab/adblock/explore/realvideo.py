"""realvideo.py <url>: a real page's own video, pressed play as a member would: load, wait 8 s, play() the largest <video>
(or the first), then sample every <video> 4 times 3 s apart. Lab only (ADR 0076: does a site's own video play with blocking?)."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
url = sys.argv[1]
t = json.loads(cdp.get('/json/new?about:blank', 'PUT')); w = cdp.WS(t['webSocketDebuggerUrl'])
PLAY = """(() => { const vs = [...document.querySelectorAll('video')]; if (!vs.length) return 'no video';
  const v = vs.sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))[0];
  v.scrollIntoView({block: 'center'}); v.muted = true;
  return Promise.race([v.play().then(() => 'ok', e => 'err ' + e.name), new Promise(r => setTimeout(() => r('timeout'), 5000))]); })()"""
SAMPLE = "JSON.stringify([...document.querySelectorAll('video')].map(v => [Math.round(v.currentTime * 10) / 10, v.paused, v.videoWidth]))"
try:
    w.call('Page.enable'); w.call('Page.bringToFront'); w.call('Page.navigate', url=url); w.pump(8)
    out = {'url': url.split('/')[2], 'videos_before': json.loads(w.value(SAMPLE) or '[]')}
    try: out['play'] = w.value(PLAY, await_promise=True)
    except RuntimeError as e: out['play'] = 'eval error'
    out['samples'] = []
    for i in range(4):
        w.pump(3); out['samples'].append(json.loads(w.value(SAMPLE) or '[]'))
    adv = [max((s[k][0] for s in out['samples'] if k < len(s)), default=0) for k in range(max((len(s) for s in out['samples']), default=0))]
    out['advanced'] = [a for a in adv if a > 0]
    print(json.dumps(out))
finally:
    w.close(); cdp.get('/json/close/' + t['id'])
