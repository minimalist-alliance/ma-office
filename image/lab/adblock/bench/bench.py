"""bench.py <reps> [config ...]: ADR 0076's measurement. Each pass is one config on a fresh profile in a fresh Chromium,
started by the image's own desk-browser-start (same flags, same window), on display :99, in its own unit for CPU accounting.
Every site: load (to the load event, at most 30 s, then 3 s), read 20 s without input, the simplified view's extractor
once, then 12 s of wheel scrolling at about 1200 px/s with the page's own rAF counted. Results: results/visits.jsonl."""
import base64, json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'results'); os.makedirs(os.path.join(OUT, 'shots'), exist_ok=True)
ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
POLICY = '/etc/chromium/policies/managed/ma-adblock.json'
UNIT = 'bench-chromium'
CG = '/sys/fs/cgroup/system.slice/%s.service' % UNIT
SITES = [
    ('cnn', 'https://www.cnn.com/'),
    ('foxnews', 'https://www.foxnews.com/'),
    ('dailymail', 'https://www.dailymail.co.uk/ushome/index.html'),
    ('theverge', 'https://www.theverge.com/'),
    ('yahoo', 'https://www.yahoo.com/'),
    ('allrecipes', 'https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/'),
    ('foodnetwork', 'https://www.foodnetwork.com/recipes/ina-garten/perfect-roast-chicken-recipe-1940592'),
    ('reddit', 'https://www.reddit.com/r/AskReddit/'),
    ('stackoverflow', 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array'),
    ('fandom', 'https://harrypotter.fandom.com/wiki/Harry_Potter'),
    ('weather', 'https://weather.com/weather/today/l/New+York+NY+USNY0996:1:US'),
    ('youtube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'),
    ('twitch', 'https://www.twitch.tv/'),
]
# A modal that locks the page (CNN's terms, a cookie wall) gets the click a member would give it, in every config alike.
CONSENT = r"""(() => {
  const se = document.scrollingElement || document.documentElement;
  const locked = se.scrollHeight <= innerHeight + 4 || getComputedStyle(document.body).overflowY === 'hidden' || getComputedStyle(document.documentElement).overflowY === 'hidden';
  if (!locked) return 'not locked';
  const re = /^\s*(agree|i agree|accept|accept all|accept all cookies|allow all|got it|ok|okay|continue|i accept)\s*$/i;
  const btn = [...document.querySelectorAll('button, [role=button], a')].find(e => re.test(e.innerText || e.textContent || '') && e.checkVisibility && e.checkVisibility());
  if (!btn) return 'locked, no button';
  btn.click(); return 'clicked ' + (btn.innerText || '').trim().slice(0, 30);
})()"""
if os.environ.get('BENCH_SITES'): SITES = [x for x in SITES if x[0] in os.environ['BENCH_SITES'].split(',')]
CONFIGS = {
    'off': None,
    'ubol': {'disableFirstRunPage': True, 'noFiltering': []},
    'ubol-annoy': {'disableFirstRunPage': True, 'noFiltering': [], 'rulesets': ['+annoyances-cookies', '+annoyances-overlays']},
    # What ships after the Security Analyst's T47S-2: network blocking only, no content scripts, no added lists
    'ubol-basic': {'disableFirstRunPage': True, 'noFiltering': [], 'defaultFiltering': 'basic'},
    # What ships after the Security Analyst's T47S-2: the image's own network-only blocker (ADR 0076)
    'ma': 'image',
}
EXTRACT = open(os.path.join(HERE, 'extract.js')).read()
AD_LABEL = re.compile(r'\b(advertisement|sponsored|promoted|paid (content|post|partner)|ad ?choices|adchoices)\b', re.I)
LOG = open(os.path.join(OUT, 'bench.log'), 'a')
def log(*a):
    line = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a); print(line, flush=True); LOG.write(line + '\n'); LOG.flush()
def sh(*a): return subprocess.run(a, capture_output=True, text=True)

def set_policy(cfg):
    global ID
    if cfg is None:
        if os.path.exists(POLICY): os.unlink(POLICY)
        return
    if cfg == 'image':
        # What ships: the image's own blocker (image/recipe/adblock), its policy as desk-adblock renders it, no site off.
        ID = next(iter(json.load(open('/etc/ma/chromium-adblock.json'))['ExtensionSettings']))
        sh('/usr/local/lib/ma/desk-adblock', 'render')
        return
    ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
    tmp = POLICY + '.tmp'
    json.dump({'ExtensionInstallForcelist': ['%s;https://clients2.google.com/service/update2/crx' % ID],
               '3rdparty': {'extensions': {ID: cfg}}}, open(tmp, 'w'), indent=1)
    os.chmod(tmp, 0o644); os.rename(tmp, POLICY)

def cpu_us():
    for l in open(CG + '/cpu.stat'):
        if l.startswith('usage_usec'): return int(l.split()[1])
def pss_kb():
    tot = 0
    for pid in open(CG + '/cgroup.procs').read().split():
        try:
            for l in open('/proc/%s/smaps_rollup' % pid):
                if l.startswith('Pss:'): tot += int(l.split()[1])
        except OSError: pass
    return tot
def mem_current(): return int(open(CG + '/memory.current').read())
def net():
    for l in open('/proc/net/dev'):
        if l.strip().startswith('ens5:'):
            f = l.split(':', 1)[1].split(); return int(f[0]), int(f[8])
    return 0, 0

def start(profile):
    sh('systemctl', 'stop', UNIT); sh('systemctl', 'reset-failed', UNIT)
    sh('rm', '-rf', profile); os.makedirs(profile); sh('chown', 'kiosk:kiosk', profile)
    os.makedirs('/data/bench/home', exist_ok=True); sh('chown', 'kiosk:kiosk', '/data/bench/home')
    r = sh('systemd-run', '--quiet', '--collect', '--unit=' + UNIT, '-p', 'User=kiosk', '-p', 'Group=kiosk', '-p', 'MemoryMax=2560M',
           '--setenv=DISPLAY=:99', '--setenv=HOME=/data/bench/home', '--setenv=PULSE_SERVER=unix:/run/desk-audio/native',
           '--setenv=MA_BROWSER_PROFILE=' + profile, '/usr/local/lib/ma/desk-browser-start')
    if r.returncode: raise RuntimeError('systemd-run: ' + r.stderr)
    t0 = time.time()
    for _ in range(300):
        try: cdp.get('/json/version'); break
        except OSError: time.sleep(0.2)
    return t0

def wait_ext(b, t0, want):
    if not want: return None
    for _ in range(600):
        if any(t['type'] == 'service_worker' and ID in t['url'] for t in b.call('Target.getTargets')['targetInfos']): return round(time.time() - t0, 2)
        time.sleep(0.1)
    raise RuntimeError('the blocker never started')

def visit(b, name, url, cfgname, rep):
    st = {'site': name, 'url': url, 'config': cfgname, 'rep': rep, 'req': 0, 'blocked': 0, 'failed': 0, 'bytes': 0, 'frames_attached': 0}
    tid = b.call('Target.createTarget', url='about:blank')['targetId']
    s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
    def handler(m):
        meth = m.get('method'); p = m.get('params', {})
        if meth == 'Target.attachedToTarget':
            cs = p['sessionId']; st['frames_attached'] += 1
            b.send('Network.enable', {}, cs)
            b.send('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True}, cs)
            b.send('Runtime.runIfWaitingForDebugger', {}, cs)
        elif meth == 'Network.requestWillBeSent': st['req'] += 1
        elif meth == 'Network.loadingFinished': st['bytes'] += int(p.get('encodedDataLength') or 0)
        elif meth == 'Network.loadingFailed':
            if p.get('errorText') == 'net::ERR_BLOCKED_BY_CLIENT': st['blocked'] += 1
            else: st['failed'] += 1
        elif meth == 'Page.loadEventFired' and m.get('sessionId') == s: st.setdefault('load_s', round(time.time() - st['_t0'], 2))
        else: return m.get('sessionId') is not None
        return True
    b.handler = handler
    try:
        b.call('Page.enable', session=s); b.call('Network.enable', session=s); b.call('Runtime.enable', session=s)
        b.call('Target.setAutoAttach', session=s, autoAttach=True, waitForDebuggerOnStart=True, flatten=True)
        b.call('Page.bringToFront', session=s)
        time.sleep(1)
        c0, n0 = cpu_us(), net(); st['_t0'] = time.time()
        b.call('Page.navigate', session=s, url=url)
        while 'load_s' not in st and time.time() - st['_t0'] < 30: b.pump(0.25)
        b.pump(3)
        c1, n1 = cpu_us(), net(); t1 = time.time()
        st['load_cpu_s'] = round((c1 - c0) / 1e6, 2); st['load_wall_s'] = round(t1 - st['_t0'], 2)
        # read: 20 s, no input. Video pages: press play, as a member would, and sample the players.
        try: st['consent'] = b.value(CONSENT, session=s)
        except Exception as e: st['consent'] = 'error'
        b.pump(1)
        if name in ('youtube', 'twitch'):
            try: st['play'] = b.value("(()=>{const v=document.querySelector('video'); return v ? Promise.race([v.play().then(()=>'ok', e=>'err '+e.name), new Promise(r => setTimeout(() => r('timeout'), 5000))]) : 'no video'})()", session=s, await_promise=True)
            except Exception as e: st['play'] = 'eval error'
        vids = []
        for i in range(10):
            b.pump(2)
            try:
                vids.append(json.loads(b.value("JSON.stringify({ad: !!document.querySelector('.ad-showing, .ad-interrupting'), v: [...document.querySelectorAll('video')].map(v => [Math.round(v.currentTime*10)/10, v.paused, v.videoWidth])})", session=s) or '{}'))
            except Exception: vids.append(None)
        c2, n2 = cpu_us(), net(); t2 = time.time()
        st['read_cpu_s'] = round((c2 - c1) / 1e6, 2); st['read_core_pct'] = round(100 * (c2 - c1) / 1e6 / (t2 - t1), 1)
        st['videos'] = vids
        st['pss_mb'] = round(pss_kb() / 1024, 1); st['memcg_mb'] = round(mem_current() / 2**20, 1)
        # the simplified view, as the prototype extracts it (design 7.2): what's left of the page after blocking
        try:
            b.value(EXTRACT, session=s)
            txt = b.value('window.__mdoc.extractText()', session=s)
            meta, *lines = txt.split('\n'); meta = json.loads(meta); blocks = [json.loads(l.split('\t', 1)[1]) for l in lines if '\t' in l]
            media = {}
            for bl in blocks:
                if bl.get('k') == 'media': media[bl.get('m')] = media.get(bl.get('m'), 0) + 1
            st['mdoc'] = {'mode': meta.get('mode'), 'blocks': len(blocks), 'chars': meta.get('chars'), 'ms': meta.get('ms'), 'media': media,
                          'imgs': sum(1 for bl in blocks if bl.get('k') == 'img') + txt.count('["img"'),
                          'ad_labels': sum(1 for l in lines if AD_LABEL.search(l))}
        except Exception as e: st['mdoc'] = {'error': str(e)[:200]}
        try:
            st['text_chars'] = b.value('document.body ? document.body.innerText.length : 0', session=s)
            st['title'] = (b.value('document.title', session=s) or '')[:80]
            st['final_url'] = (b.value('location.href', session=s) or '')[:120]
        except Exception: pass
        try:
            shot = b.call('Page.captureScreenshot', session=s, format='jpeg', quality=35)['data']
            open(os.path.join(OUT, 'shots', '%s-%s-r%d.jpg' % (name, cfgname, rep)), 'wb').write(base64.b64decode(shot))
        except Exception: pass
        # scroll: the page's own frame rate while the wheel turns
        b.value("window.__fr=[]; (function f(t){window.__fr.push(t); requestAnimationFrame(f)})(performance.now()); window.__y0=scrollY; 1", session=s)
        b.call('Input.dispatchMouseEvent', session=s, type='mouseMoved', x=960, y=600)
        c3, n3 = cpu_us(), net(); t3 = time.time()
        while time.time() - t3 < 12:
            b.send('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': 960, 'y': 600, 'deltaX': 0, 'deltaY': 60}, s); b.pump(0.05)
        c4, n4 = cpu_us(), net(); t4 = time.time()
        fr = json.loads(b.value("JSON.stringify({fr: window.__fr, y: scrollY - window.__y0, vis: document.visibilityState})", session=s) or '{}')
        ts = fr.get('fr', [])
        if len(ts) > 2:
            span = (ts[-1] - ts[1]) / 1000; secs = {}
            for t in ts[1:]: secs[int((t - ts[1]) / 1000)] = secs.get(int((t - ts[1]) / 1000), 0) + 1
            full = [secs.get(k, 0) for k in range(int(span))]
            st['scroll_fps'] = round((len(ts) - 2) / span, 1) if span else None
            st['scroll_fps_min_s'] = min(full) if full else None
        st['scrolled_px'] = fr.get('y'); st['visibility'] = fr.get('vis')
        st['scroll_cpu_s'] = round((c4 - c3) / 1e6, 2); st['scroll_core_pct'] = round(100 * (c4 - c3) / 1e6 / (t4 - t3), 1)
        st['rx_mb'] = round(((n4[0] - n0[0]) - 0) / 2**20, 2); st['tx_mb'] = round((n4[1] - n0[1]) / 2**20, 2)
        st['rx_load_mb'] = round((n1[0] - n0[0]) / 2**20, 2)
        st['cdp_mb'] = round(st['bytes'] / 2**20, 2)
        st['cpu_total_s'] = round((c4 - c0) / 1e6, 2)
    finally:
        b.handler = None
        try: b.call('Target.closeTarget', targetId=tid)
        except Exception: pass
        b.pump(1); b.events.clear()
    st.pop('_t0', None)
    return st

def adtest(b, want_blocked):
    import adtest as A
    return A.check('a.localhost')

def run(reps, configs):
    sh('systemctl', 'stop', 'desk-browser'); sh('systemctl', 'start', 'desk-xorg', 'desk-audio')
    for rep in range(1, reps + 1):
        order = configs[rep - 1:] + configs[:rep - 1]
        for cfgname in order:
            cfg = CONFIGS[cfgname]; set_policy(cfg)
            prof = '/data/bench/p-%s-r%d' % (cfgname, rep)
            t0 = start(prof); b = cdp.browser()
            try:
                ext_s = wait_ext(b, t0, cfg is not None)
                time.sleep(10)
                info = {'event': 'start', 'config': cfgname, 'rep': rep, 'ext_up_s': ext_s, 'idle_pss_mb': round(pss_kb() / 1024, 1)}
                try: info['adtest'] = adtest(b, cfg is not None)
                except Exception as e: info['adtest'] = 'error %s' % e
                c0 = cpu_us(); time.sleep(20); info['idle_core_pct'] = round(100 * (cpu_us() - c0) / 1e6 / 20, 2)
                log(json.dumps(info)); open(os.path.join(OUT, 'visits.jsonl'), 'a').write(json.dumps(info) + '\n')
                for name, url in SITES:
                    try: st = visit(b, name, url, cfgname, rep)
                    except Exception as e: st = {'site': name, 'config': cfgname, 'rep': rep, 'error': str(e)[:300]}
                    log(name, cfgname, rep, json.dumps({k: st.get(k) for k in ('load_s', 'cpu_total_s', 'read_core_pct', 'rx_mb', 'blocked', 'scroll_fps', 'pss_mb', 'error')}))
                    open(os.path.join(OUT, 'visits.jsonl'), 'a').write(json.dumps(st) + '\n')
            finally:
                b.close(); sh('systemctl', 'stop', UNIT)
    set_policy(None)
    log('BENCH DONE')

if __name__ == '__main__':
    reps = int(sys.argv[1]); configs = sys.argv[2:] or list(CONFIGS)
    run(reps, configs)
