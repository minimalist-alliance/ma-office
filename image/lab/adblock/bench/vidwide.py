"""vidwide.py <off|ma> [site ...]: does each page's main video play? One fresh Chromium per config (as bench.py), each page: load,
8 s, then in the page and in every frame (cross-origin ones too) the largest <video> is muted and play()ed as a member would press
it, and every video is sampled 3 times 3 s apart. played = a video with width and currentTime moving. Lab only (ADR 0076 follow-up).
Results: results/vidwide.jsonl. Sites: WIDE below, or names/URLs given."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench, cdp
WIDE = [  # news, recipes, sports, how-to, embedded YouTube
    ('bbc', 'https://www.bbc.com/news'), ('nbcnews', 'https://www.nbcnews.com/'), ('cbsnews', 'https://www.cbsnews.com/'),
    ('usatoday', 'https://www.usatoday.com/'), ('nypost', 'https://nypost.com/'),
    ('tasty', 'https://tasty.co/'), ('delish', 'https://www.delish.com/'), ('epicurious', 'https://www.epicurious.com/'),
    ('espn', 'https://www.espn.com/'), ('cbssports', 'https://www.cbssports.com/'), ('bleacherreport', 'https://bleacherreport.com/'),
    ('wikihow', 'https://www.wikihow.com/Tie-a-Tie'), ('people', 'https://people.com/'), ('ign', 'https://www.ign.com/'),
    ('w3schools-yt', 'https://www.w3schools.com/html/html5_youtube.asp'),
]
PLAY = """(() => { const vs = [...document.querySelectorAll('video')];
  const info = vs.map(v => { const r = v.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), vw: v.videoWidth, paused: v.paused, t: Math.round(v.currentTime * 10) / 10, rs: v.readyState, err: v.error ? v.error.code : 0, src: (v.currentSrc || '').slice(0, 70), cls: (v.className || '').toString().slice(0, 30), ad: !!v.closest('[class*=ad-], [id*=ad-], [class*=advert]')}; });
  if (!vs.length) return JSON.stringify({n: 0});
  const big = vs.map((v, i) => [v.getBoundingClientRect().width * v.getBoundingClientRect().height, i]).sort((a, b) => b[0] - a[0])[0][1], v = vs[big];
  v.scrollIntoView({block: 'center'}); v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {});
  return JSON.stringify({n: vs.length, big, info}); })()"""
SAMPLE = "JSON.stringify([...document.querySelectorAll('video')].map(v => [Math.round(v.currentTime * 10) / 10, v.paused, v.videoWidth, v.readyState]))"
LINK = """(() => { const base = location.hostname.split('.').slice(-2).join('.'); const as = [...document.querySelectorAll('a[href]')].filter(a => { try { return new URL(a.href).hostname.endsWith(base) && new URL(a.href).pathname.length > 12 && a.checkVisibility && a.checkVisibility(); } catch (e) { return false; } }).map(a => a.href);
  return as.find(h => /\\/(videos?|watch)\\//i.test(h)) || as.find(h => /\\/recipes?\\//i.test(h)) || null; })()"""
def ev(b, key, expr):
    fs, cid = key
    r = b.call('Runtime.evaluate', session=fs, expression=expr, returnByValue=True, **({'contextId': cid} if cid else {}))
    return r['result'].get('value') if 'exceptionDetails' not in r else None
def one(b, name, url):
    out = {'site': name, 'url': url}
    tid = b.call('Target.createTarget', url='about:blank')['targetId']
    s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
    frames = {s: 'top'}; ctxs = {}
    def handler(m):
        if m.get('method') == 'Runtime.executionContextCreated' and m.get('sessionId') == s:
            c = m['params']['context']
            if c.get('auxData', {}).get('isDefault') and not c.get('auxData', {}).get('type') == 'isolated': ctxs[c['id']] = c['origin'][:60]
            return True
        if m.get('method') == 'Runtime.executionContextsCleared' and m.get('sessionId') == s: ctxs.clear(); return True
        if m.get('method') == 'Target.attachedToTarget':
            cs = m['params']['sessionId']; frames[cs] = (m['params']['targetInfo'].get('url') or '')[:70]
            b.send('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True}, cs)
            b.send('Runtime.runIfWaitingForDebugger', {}, cs); return True
        return m.get('sessionId') is not None
    b.handler = handler
    try:
        b.call('Page.enable', session=s); b.call('Page.bringToFront', session=s); b.call('Runtime.enable', session=s)
        b.call('Target.setAutoAttach', session=s, autoAttach=True, waitForDebuggerOnStart=True, flatten=True)
        b.call('Page.navigate', session=s, url=url); b.pump(10)
        try: out['consent'] = b.value(bench.CONSENT, session=s)
        except Exception: pass
        b.pump(1)
        try: out['title'] = (b.value('document.title', session=s) or '')[:70]; out['text_chars'] = b.value('document.body ? document.body.innerText.length : 0', session=s)
        except Exception: pass
        res = {}
        targets = [((fs, None), label) for fs, label in list(frames.items()) if fs != s] + [((s, cid), 'top' if o == out.get('origin') else o) for cid, o in list(ctxs.items())]
        out['origin'] = None
        for key, label in targets:
            try: r = json.loads(ev(b, key, PLAY) or '{}')
            except Exception: continue
            if r.get('n'): res[key] = (label, r)
        out['videos_found'] = {l: r['n'] for l, r in res.values()}; out['info'] = {l: r.get('info') for l, r in res.values()}
        samples = {fs: [] for fs in res}
        for i in range(3):
            b.pump(3)
            for fs in res:
                try: samples[fs].append(json.loads(ev(b, fs, SAMPLE) or '[]'))
                except Exception: pass
        played = []
        for fs, (label, r) in res.items():
            sm = samples[fs]
            for k in range(r['n']):
                ts = [x[k][0] for x in sm if k < len(x)]; vw = max([x[k][2] for x in sm if k < len(x)] or [0])
                if ts and vw and max(ts) - min(ts + [r['info'][k]['t']]) > 0.5: played.append([label[:50], k, max(ts), vw])
        out['played'] = played; out['ok'] = bool(played)
        out['frames'] = len(frames)
        try: out['link'] = b.value(LINK, session=s)
        except Exception: out['link'] = None
    finally:
        b.handler = None
        try: b.call('Target.closeTarget', targetId=tid)
        except Exception: pass
        b.pump(1); b.events.clear()
    return out
if __name__ == '__main__':
    cfgname = sys.argv[1]; want = sys.argv[2:]; DEEP = os.environ.get('DEEP') == '1'
    sites = [x for x in (WIDE + bench.SITES) if not want or x[0] in want] or [(u.split('/')[2], u) for u in want]
    bench.sh('systemctl', 'stop', 'desk-browser'); bench.sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
    cfg = bench.CONFIGS[cfgname]; bench.set_policy(cfg)
    t0 = bench.start('/data/bench/v-%s' % cfgname); b = cdp.browser()
    try:
        bench.wait_ext(b, t0, cfg is not None); time.sleep(8)
        for name, url in sites:
            try:
                o = one(b, name, url)
                if not o.get('ok') and o.get('link') and DEEP:
                    h = o; o = one(b, name, o['link']); o['home'] = {k: h.get(k) for k in ('ok', 'videos_found', 'text_chars')}
            except Exception as e: o = {'site': name, 'error': str(e)[:200]}
            o['config'] = cfgname; o['tag'] = os.environ.get('TAG', '')
            print(json.dumps({k: o.get(k) for k in ('site', 'config', 'ok', 'videos_found', 'played', 'error', 'text_chars', 'url', 'link')}), flush=True)
            open(os.path.join(bench.OUT, 'vidwide.jsonl'), 'a').write(json.dumps(o) + '\n')
    finally:
        b.close(); bench.sh('systemctl', 'stop', bench.UNIT); bench.set_policy(None)
