"""adtest.py <host>...: open http://<host>:18767/page in a new tab, report whether the ad script ran (window.adran)."""
import os, sys, json, time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
def check(host, port=18767):
    t = json.loads(cdp.get('/json/new?about:blank', 'PUT')); w = cdp.WS(t['webSocketDebuggerUrl'])
    try:
        w.call('Network.enable'); w.call('Page.enable')
        w.call('Page.navigate', url='http://%s:%d/page?%s' % (host, port, os.urandom(4).hex()))
        res = None
        for _ in range(40):
            time.sleep(0.25)
            v = w.value('JSON.stringify({ready: document.readyState, adran: window.adran, title: document.title})')
            o = json.loads(v or '{}')
            if o.get('ready') == 'complete' and o.get('title', '').startswith('adtest'): res = o; break
        w.pump(0.3)
        failed = [e['params'].get('errorText') for e in w.events if e.get('method') == 'Network.loadingFailed']
        return {'host': host, 'adran': (res or {}).get('adran'), 'failed': failed}
    finally:
        w.close(); cdp.get('/json/close/' + t['id'])
if __name__ == '__main__':
    for h in sys.argv[1:]: print(json.dumps(check(h)))
