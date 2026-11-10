"""realcount.py <url>: load a real page in a new background tab and count its requests and those the blocker stopped
(net::ERR_BLOCKED_BY_CLIENT), over the load and 8 s after it. Lab only (ADR 0076's real-site proof of the switch)."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
url = sys.argv[1]
t = json.loads(cdp.get('/json/new?about:blank', 'PUT')); w = cdp.WS(t['webSocketDebuggerUrl'])
try:
    w.call('Network.enable'); w.call('Page.enable'); w.call('Page.navigate', url=url)
    end = time.time() + 30; loaded = None
    while time.time() < end:
        w.pump(0.5)
        if loaded is None and any(e.get('method') == 'Page.loadEventFired' for e in w.events): loaded = time.time(); end = min(end, loaded + 8)
    req = sum(1 for e in w.events if e.get('method') == 'Network.requestWillBeSent')
    blocked = sum(1 for e in w.events if e.get('method') == 'Network.loadingFailed' and e['params'].get('errorText') == 'net::ERR_BLOCKED_BY_CLIENT')
    print(json.dumps({'url': url.split('/')[2], 'requests': req, 'blocked': blocked, 'loaded': loaded is not None}))
finally:
    w.close(); cdp.get('/json/close/' + t['id'])
