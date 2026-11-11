#!/usr/bin/python3 -I
"""store.py: the Chrome Web Store in the desk's own kiosk Chromium, over CDP as root, for the img035 lab box only.

  store.py open <extension id>       a tab on the extension's store page, in front; prints the page's title and its button
  store.py add <extension id>        the same, then a real mouse click on its "Add to Chrome" button (a user gesture)
  store.py status <extension id>     Chromium's own word on installing it (webstorePrivate.getExtensionStatus, which the store
                                     page asks to draw its button), from the extension's store page
  store.py installed                 every extension Chromium has, by chrome://extensions' own API: id, name, state, location
  store.py remove <extension id>     uninstall it from chrome://extensions (chrome.management.uninstall, no dialog)
  store.py tabs                      the open tabs' URLs
  store.py close <url prefix>        close tabs whose URL starts with it

Nothing here signs in, types into a page or accepts a dialog: the install dialog is Chromium's own window, answered with
xdotool by lab.sh's caller. Reuses verify-chromium.sh's CDP client (/var/tmp/vc.py), which that script writes.
"""
import json, sys, time
sys.path.insert(0, '/var/tmp')
from vc import WS, get  # noqa: E402

STORE = 'https://chromewebstore.google.com/detail/'


def tab(url):
    t = json.loads(get('/json/new?about:blank', 'PUT')); w = WS(t['webSocketDebuggerUrl'])
    w.call('Page.bringToFront'); w.call('Page.navigate', url=url)
    for _ in range(120):
        time.sleep(0.5)
        try:
            if w.value("document.readyState") == 'complete': break
        except RuntimeError:
            pass
    time.sleep(3)
    return t, w


BUTTON = """(() => { const b = [...document.querySelectorAll('button')].find(e => /add to chrome|remove from chrome|blocked|not available|unavailable/i.test(e.innerText || ''));
  if (!b) return {title: document.title, button: null, text: document.body.innerText.slice(0, 400)};
  const r = b.getBoundingClientRect(); return {title: document.title, button: b.innerText.trim(), disabled: b.disabled, x: r.x + r.width / 2, y: r.y + r.height / 2}; })()"""


def main():
    cmd = sys.argv[1]
    if cmd in ('open', 'add'):
        t, w = tab(STORE + sys.argv[2])
        b = w.value(BUTTON); print(json.dumps(b))
        if cmd == 'add' and b and b.get('button') and not b.get('disabled'):
            for typ in ('mouseMoved', 'mousePressed', 'mouseReleased'):
                w.call('Input.dispatchMouseEvent', type=typ, x=b['x'], y=b['y'], button='left' if typ != 'mouseMoved' else 'none', clickCount=1)
            print('clicked', b['button'])
        w.s.close()
    elif cmd == 'status':
        t, w = tab(STORE + sys.argv[2])
        try:
            r = w.call('Runtime.evaluate', returnByValue=True, awaitPromise=True,
                       expression="new Promise(r => chrome.webstorePrivate.getExtensionStatus(%s, undefined, s => r(s || (chrome.runtime.lastError || {}).message)))" % json.dumps(sys.argv[2]))
            print(json.dumps({'id': sys.argv[2], 'title': w.value('document.title'), 'status': r['result'].get('value')}))
        finally:
            w.s.close(); get('/json/close/' + t['id'])
    elif cmd == 'installed':
        t = json.loads(get('/json/new?chrome://extensions', 'PUT')); w = WS(t['webSocketDebuggerUrl']); info = None
        try:
            for _ in range(40):
                time.sleep(0.25)
                try:
                    info = w.call('Runtime.evaluate', returnByValue=True, awaitPromise=True, expression="chrome.developerPrivate.getExtensionsInfo({includeDisabled: true, includeTerminated: true}).then(l => JSON.stringify(l.map(i => ({id: i.id, name: i.name, state: i.state, location: i.location, version: i.version, reasons: i.disableReasons}))))")['result'].get('value')
                except RuntimeError:
                    continue
                if info: break
        finally:
            w.s.close(); get('/json/close/' + t['id'])
        print(info)
    elif cmd == 'remove':
        t = json.loads(get('/json/new?chrome://extensions', 'PUT')); w = WS(t['webSocketDebuggerUrl'])
        try:
            time.sleep(2)
            r = w.call('Runtime.evaluate', returnByValue=True, awaitPromise=True, userGesture=True,
                       expression="new Promise(r => chrome.management.uninstall(%s, {showConfirmDialog: false}, () => r((chrome.runtime.lastError || {}).message || 'removed')))" % json.dumps(sys.argv[2]))
            print(r['result'].get('value'))
        finally:
            w.s.close(); get('/json/close/' + t['id'])
    elif cmd == 'tabs':
        print(json.dumps([x['url'] for x in json.loads(get('/json/list')) if x['type'] == 'page']))
    elif cmd == 'close':
        for x in json.loads(get('/json/list')):
            if x['type'] == 'page' and x['url'].startswith(sys.argv[2]): get('/json/close/' + x['id'])


if __name__ == '__main__':
    main()
