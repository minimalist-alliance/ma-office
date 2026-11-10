"""pol.py [reload]: Chromium's own policy table (chrome://policy), rows that are set, as JSON. 'reload' presses Reload policies first."""
import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
JS = """JSON.stringify([...document.querySelector('policy-app').shadowRoot.querySelectorAll('policy-table')].map(t => ({t: (t.shadowRoot.querySelector('h3, .header, #header') || {}).textContent || '', rows: [...t.shadowRoot.querySelectorAll('policy-row')].map(r => r.policy).filter(p => p && 'value' in p).map(p => ({name: p.name, value: p.value, status: p.status}))})))"""
def read(reload=False):
    t = json.loads(cdp.get('/json/new?chrome://policy', 'PUT')); w = cdp.WS(t['webSocketDebuggerUrl'])
    try:
        if reload:
            time.sleep(1); w.value("chrome.send('reloadPolicies')"); time.sleep(1)
        out = []
        for _ in range(40):
            time.sleep(0.5); r = w.value(JS); out = json.loads(r) if r else []
            if any(row['name'] == 'RestoreOnStartup' for tb in out for row in tb['rows']): break
        return out
    finally:
        w.close(); cdp.get('/json/close/' + t['id'])
if __name__ == '__main__':
    for tb in read(len(sys.argv) > 1 and sys.argv[1] == 'reload'):
        print('==', tb['t'].strip()[:60]); [print('  ', r['name'], json.dumps(r['value'])[:150], r['status']) for r in tb['rows']]
