import os, sys, json, time, shutil, sqlite3; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp, bench
cfg = dict(bench.CONFIGS['ubol']); cfg['noFiltering'] = ['x1.off.ma-check.localhost']
bench.set_policy(cfg); t0 = bench.start('/data/bench/p-probe'); b = cdp.browser(); bench.wait_ext(b, t0, True); time.sleep(4)
def probe(main):
    tid = b.call('Target.createTarget', url=main, background=True)['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
    b.call('Runtime.enable', session=s); b.pump(1)
    b.value("window.__m=[]; addEventListener('message', e => window.__m.push(e.data)); for (const h of ['x1.off', 'x1.on']) { const f = document.createElement('iframe'); f.src = 'http://' + h + '.ma-check.localhost:18767/frame?' + Math.random(); document.body ? document.body.appendChild(f) : document.documentElement.appendChild(f) }; 1", session=s)
    b.pump(2.5)
    r = b.value("JSON.stringify(window.__m)", session=s)
    msgs = [e['params'].get('message', e['params']).get('text', '') if isinstance(e.get('params'), dict) else '' for e in b.events if 'console' in e.get('method', '').lower() or 'Log.' in e.get('method', '')]
    b.call('Target.closeTarget', targetId=tid); b.pump(0.5)
    return r, [e for e in b.events if e.get('method') == 'Runtime.consoleAPICalled' or e.get('method') == 'Runtime.exceptionThrown'][:3]
for main in ('about:blank',):
    r, ev = probe(main); print(main, '->', r, json.dumps(ev)[:300])
targets = [t['url'] for t in b.call('Target.getTargets')['targetInfos'] if t['type'] == 'page']; print('pages now:', targets)
b.close(); bench.sh('systemctl', 'stop', bench.UNIT); time.sleep(2)
shutil.copy('/data/bench/p-probe/Default/History', '/var/tmp/lab/h.db')
c = sqlite3.connect('/var/tmp/lab/h.db'); print('history urls:', c.execute("select url, visit_count, hidden from urls").fetchall()); print('visits:', c.execute("select count(*) from visits").fetchall())
