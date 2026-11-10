"""privacy.py: which names Chromium looks up with and without the blocker, idle on the home page for 90 s from a fresh
profile (resolved's monitor), and what chrome://components holds. Results to results/privacy.txt."""
import os, sys, json, time, subprocess, re; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp, bench
out = open('/var/tmp/lab/results/privacy.txt', 'w')
def names(cfgname):
    bench.set_policy(bench.CONFIGS[cfgname])
    mon = subprocess.Popen(['resolvectl', 'monitor'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1)
    t0 = bench.start('/data/bench/p-priv-%s' % cfgname); b = cdp.browser()
    if bench.CONFIGS[cfgname]: print('blocker up after', bench.wait_ext(b, t0, True), file=out)
    time.sleep(90)
    comps = None
    if cfgname == 'off':
        tid = b.call('Target.createTarget', url='chrome://components', background=True)['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
        time.sleep(3); comps = b.value('document.body.innerText', session=s)
        b.call('Target.closeTarget', targetId=tid)
        tid = b.call('Target.createTarget', url='chrome://policy', background=True)['targetId']; s = b.call('Target.attachToTarget', targetId=tid, flatten=True)['sessionId']
        time.sleep(3)
        try:
            pol = b.value("""(async () => { const app = document.querySelector('policy-app'); const cb = app.shadowRoot.querySelector('#show-unset'); if (cb && !cb.checked) cb.click(); await new Promise(r => setTimeout(r, 1500)); return [...app.shadowRoot.querySelectorAll('policy-table')].flatMap(t => [...t.shadowRoot.querySelectorAll('policy-row')]).map(r => r.policy && r.policy.name).filter(n => n && /^Ads|Ad[A-Z]|HeavyAd|Intrusive/.test(n)) })()""", session=s, await_promise=True)
        except Exception as e: pol = 'error %s' % e
        print('ad-related policy names Chromium knows:', pol, file=out)
        b.call('Target.closeTarget', targetId=tid)
    b.close(); bench.sh('systemctl', 'stop', bench.UNIT); time.sleep(1); mon.terminate()
    text = mon.communicate(timeout=10)[0]
    qs = sorted(set(re.findall(r'Q: ([^ ]+) IN', text)))
    return qs, comps
off, comps = names('off')
on, _ = names('ubol')
print('names looked up with no blocker (%d): %s' % (len(off), off), file=out)
print('names looked up with the blocker (%d): %s' % (len(on), on), file=out)
print('only with the blocker: %s' % sorted(set(on) - set(off)), file=out)
print('--- chrome://components\n' + (comps or ''), file=out)
out.close(); print(open('/var/tmp/lab/results/privacy.txt').read())
