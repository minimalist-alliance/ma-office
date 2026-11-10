"""trace.py <off|ma> <site> [reps]: ADR 0076 follow-up (task 46 sites). One visit of one bench site, with the evidence a cause needs:
every request and which were blocked (ERR_BLOCKED_BY_CLIENT, by host and by path, with repeats), console errors, long tasks, the
main thread's profile while scrolling (self time by script), the page's rAF rate. Env ALLOW=host,host adds dynamic `allow` rules
(requestDomains) through the blocker's service worker before the visit, ALLOWFILE=path a JSON list of rules, to bisect a fix
without rebuilding. Results: results/trace-<site>-<cfg>[-tag].json. Lab only; run as root from /var/tmp/lab after push-bench."""
import collections, json, os, sys, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench, cdp
cfgname, site = sys.argv[1], sys.argv[2]; reps = int(sys.argv[3]) if len(sys.argv) > 3 else 1
TAG = os.environ.get('TAG', '')
NAME = re.sub(r'\W+', '_', site.split('//')[-1])[:40]
url = dict(bench.SITES)[site] if site in dict(bench.SITES) else site
LT = "window.__lt=[]; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration), (e.attribution && e.attribution[0] && (e.attribution[0].containerSrc || e.attribution[0].containerName)) || '']) }).observe({type: 'longtask', buffered: true}) } catch (e) {}"
def sw_eval(b, expr):
    ts = b.call('Target.getTargets')['targetInfos']
    sw = [t for t in ts if t['type'] == 'service_worker' and bench.ID in t['url']]
    s = b.call('Target.attachToTarget', targetId=sw[0]['targetId'], flatten=True)['sessionId']
    return b.value(expr, session=s, await_promise=True)
def add_allow(b):
    rules = []
    if os.environ.get('ALLOW'): rules.append({'priority': 2000000, 'action': {'type': 'allow'}, 'condition': {'requestDomains': os.environ['ALLOW'].split(',')}})
    if os.environ.get('ALLOWFILE'): rules += json.load(open(os.environ['ALLOWFILE']))
    if not rules: return
    for i, r in enumerate(rules): r['id'] = 100 + i; r.setdefault('priority', 2000000)
    sw_eval(b, "chrome.declarativeNetRequest.updateDynamicRules({addRules: %s}).then(() => 'ok')" % json.dumps(rules))
def prof_summary(p):
    nodes = {n['id']: n for n in p['nodes']}; self_us = collections.Counter()
    dts = p.get('timeDeltas', []); samples = p.get('samples', [])
    for sid, dt in zip(samples, dts):
        cf = nodes[sid]['callFrame']; self_us[(cf['url'] or '(' + cf['functionName'] + ')', )] += dt
    tot = sum(self_us.values()) or 1
    return [[k[0][:140], round(v / 1000), round(100 * v / tot, 1)] for k, v in self_us.most_common(10)]
def one(rep):
    cfg = bench.CONFIGS[cfgname]; bench.set_policy(cfg)
    prof = '/data/bench/t-%s-%s-r%d' % (cfgname, site, rep)
    t0 = bench.start(prof); b = cdp.browser(); out = {'site': site, 'config': cfgname, 'rep': rep, 'allow': os.environ.get('ALLOW') or os.environ.get('ALLOWFILE')}
    try:
        bench.wait_ext(b, t0, cfg is not None); time.sleep(10)
        add_allow(b)
        tid = b.call('Target.createTarget', url='about:blank')['targetId']
        s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
        WATCH = os.environ.get('WATCH'); watched = []; timeline = []; bt = []; reqs = {}; blocked = []; cons = []; exc = []; allreq = []
        def handler(m):
            meth = m.get('method'); p = m.get('params', {}); key = (m.get('sessionId'), p.get('requestId'))
            if meth == 'Target.attachedToTarget':
                cs = p['sessionId']
                for mm in ('Network.enable', 'Runtime.enable', 'Log.enable'): b.send(mm, {}, cs)
                b.send('Page.addScriptToEvaluateOnNewDocument', {'source': LT}, cs)
                b.send('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True}, cs)
                b.send('Runtime.runIfWaitingForDebugger', {}, cs)
            elif meth == 'Network.requestWillBeSent':
                ini = p.get('initiator') or {}; fr0 = ((ini.get('stack') or {}).get('callFrames') or [{}])[0]
                reqs[key] = (p['request']['url'], p.get('type'), (ini.get('url') or fr0.get('url') or '')[:100]); allreq.append(reqs[key])
                if WATCH and re.search(WATCH, p['request']['url']) and len(watched) < int(os.environ.get('WATCHN', 6)): watched.append([round(time.time() - out['_t0'], 2), p['request']['url'][:110], ini.get('type'), ini.get('url', '')[:100], [(f.get('url', '')[-70:], f.get('functionName')) for f in ((ini.get('stack') or {}).get('callFrames') or [])[:4]]])
                timeline.append([round(time.time() - out['_t0'], 1), p['request']['url'][:90]])
            elif meth == 'Network.loadingFailed' and p.get('errorText') == 'net::ERR_BLOCKED_BY_CLIENT':
                blocked.append(reqs.get(key, ('?', p.get('type'), ''))); bt.append([round(time.time() - out['_t0'], 1), reqs.get(key, ('?',))[0][:100], reqs.get(key, ('?', 0, ''))[2]])
            elif meth == 'Runtime.consoleAPICalled' and p.get('type') in ('error', 'warning'):
                cons.append([p['type'], ' '.join(str(a.get('value', a.get('description', '')))[:200] for a in p.get('args', []))[:300]])
            elif meth == 'Runtime.exceptionThrown':
                d = p['exceptionDetails']; exc.append((d.get('exception', {}).get('description') or d.get('text', ''))[:250] + ' @' + (d.get('url') or '')[-60:])
            elif meth == 'Log.entryAdded' and p['entry'].get('level') in ('error', 'warning'):
                cons.append(['log-' + p['entry']['level'], (p['entry'].get('text', '') + ' ' + (p['entry'].get('url') or ''))[:300]])
            elif meth == 'Page.loadEventFired' and m.get('sessionId') == s: out.setdefault('load_s', round(time.time() - out['_t0'], 2))
            else: return m.get('sessionId') is not None
            return True
        b.handler = handler
        for mm in ('Page.enable', 'Network.enable', 'Runtime.enable', 'Log.enable'): b.call(mm, session=s)
        b.call('Page.addScriptToEvaluateOnNewDocument', session=s, source=LT)
        b.call('Target.setAutoAttach', session=s, autoAttach=True, waitForDebuggerOnStart=True, flatten=True)
        b.call('Page.bringToFront', session=s); time.sleep(1)
        c0 = bench.cpu_us(); out['_t0'] = time.time()
        b.call('Page.navigate', session=s, url=url)
        while 'load_s' not in out and time.time() - out['_t0'] < 30: b.pump(0.25)
        b.pump(3)
        try: out['consent'] = b.value(bench.CONSENT, session=s)
        except Exception: pass
        READ = float(os.environ.get('READ', 12)); SCROLL = float(os.environ.get('SCROLL', 12))
        c1 = bench.cpu_us(); t1 = time.time(); b.pump(READ)
        out['read_core_pct'] = round(100 * (bench.cpu_us() - c1) / 1e6 / (time.time() - t1), 1)
        # scroll, with the main thread profiled
        b.call('Profiler.enable', session=s); b.call('Profiler.setSamplingInterval', session=s, interval=1000); b.call('Profiler.start', session=s)
        b.value("window.__fr=[]; (function f(t){window.__fr.push(t); requestAnimationFrame(f)})(performance.now()); window.__y0=scrollY; window.__lt0=window.__lt.length; 1", session=s)
        b.call('Input.dispatchMouseEvent', session=s, type='mouseMoved', x=960, y=600)
        c3 = bench.cpu_us(); t3 = time.time()
        while time.time() - t3 < SCROLL:
            b.send('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': 960, 'y': 600, 'deltaX': 0, 'deltaY': 60}, s); b.pump(0.05)
        out['scroll_core_pct'] = round(100 * (bench.cpu_us() - c3) / 1e6 / (time.time() - t3), 1)
        pr = b.call('Profiler.stop', session=s)['profile']; out['scroll_profile_self_ms'] = prof_summary(pr)
        fr = json.loads(b.value("JSON.stringify({fr: window.__fr, y: scrollY - window.__y0, lt: window.__lt, lt0: window.__lt0})", session=s) or '{}')
        ts = fr['fr']; span = (ts[-1] - ts[1]) / 1000 if len(ts) > 2 else 0
        if span:
            secs = collections.Counter(int((t - ts[1]) / 1000) for t in ts[1:]); full = [secs.get(k, 0) for k in range(int(span))]
            out['scroll_fps'] = round((len(ts) - 2) / span, 1); out['scroll_fps_min_s'] = min(full)
        out['scrolled_px'] = fr.get('y')
        lt = fr.get('lt', []); out['longtasks_total'] = {'n': len(lt), 'ms': sum(x[1] for x in lt)}
        out['longtasks_while_scrolling'] = {'n': len(lt) - fr.get('lt0', 0), 'ms': sum(x[1] for x in lt[fr.get('lt0', 0):])}
        out['longtask_top'] = sorted(lt, key=lambda x: -x[1])[:5]
        out['rot'] = max([c for h, c in collections.Counter(re.sub(r'^https?://([^/]+).*', r'\1', u[0]) for u in allreq).items() if re.match(r'^\d\.', h)] or [0]); out['requests'] = len(allreq); out['blocked'] = len(blocked)
        out['blocked_hosts'] = collections.Counter(re.sub(r'^https?://([^/]+).*', r'\1', u[0]) for u in blocked).most_common(90)
        base = collections.Counter(re.sub(r'[?#].*', '', u[0]) for u in blocked)
        out['blocked_repeats'] = [[k[:160], v] for k, v in base.most_common(12) if v >= 2]
        out['blocked_urls'] = sorted({u[0][:200] + ' [' + str(u[1]) + ']' for u in blocked})[:150]
        out['all_hosts_top'] = collections.Counter(re.sub(r'^https?://([^/]+).*', r'\1', u[0]) for u in allreq).most_common(15)
        out['console'] = collections.Counter(c[0] + ': ' + re.sub(r'\d+', 'N', c[1])[:160] for c in cons).most_common(15)
        out['exceptions'] = collections.Counter(re.sub(r'\d+', 'N', e)[:200] for e in exc).most_common(10)
        out['watched'] = watched; out['blocked_timeline'] = bt[:60]
        try: out['video'] = json.loads(b.value("JSON.stringify({videos: document.querySelectorAll('video').length, failed_text: /video player failed to load|player failed|Error Code: 1\\d+/i.test(document.body.innerText), jwp: document.querySelectorAll('.jwplayer, [id^=jwplayer]').length, jwp_error: document.querySelectorAll('.jw-error, .jw-state-error').length, jwlib: typeof window.jwplayer})", session=s) or '{}')
        except Exception as e: out['video'] = str(e)[:100]
        try:
            import vidwide as V
            v0 = json.loads(b.value(V.PLAY, session=s) or '{}'); b.pump(2.5); v1 = json.loads(b.value(V.SAMPLE, session=s) or '[]'); b.pump(2.5); v2 = json.loads(b.value(V.SAMPLE, session=s) or '[]')
            out['vplay'] = any(k < len(v1) and v2[k][2] and v2[k][0] - v1[k][0] > 0.5 for k in range(len(v2))); out['vcount'] = v0.get('n', 0)
        except Exception as e: out['vplay'] = None
        out['title'] = (b.value('document.title', session=s) or '')[:80]
        out['text_chars'] = b.value('document.body ? document.body.innerText.length : 0', session=s)
        out['cpu_total_s'] = round((bench.cpu_us() - c0) / 1e6, 1)
    finally:
        b.handler = None; b.close(); bench.sh('systemctl', 'stop', bench.UNIT)
    out.pop('_t0', None); return out
if __name__ == '__main__':
    bench.sh('systemctl', 'stop', 'desk-browser'); bench.sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
    for r in range(1, reps + 1):
        o = one(r); fn = os.path.join(bench.OUT, 'trace-%s-%s%s.json' % (NAME, cfgname, ('-' + TAG) if TAG else ''))
        open(fn, 'a').write(json.dumps(o) + '\n'); print(json.dumps({k: o.get(k) for k in ('site', 'config', 'rep', 'load_s', 'scroll_fps', 'scroll_fps_min_s', 'read_core_pct', 'scroll_core_pct', 'requests', 'blocked', 'cpu_total_s')}), flush=True)
    bench.set_policy(None)
