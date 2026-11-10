import os, sys, json, time; sys.path.insert(0, '/var/tmp/lab')
exec(open('/var/tmp/ab.py').read().split("cmd = sys.argv[1]")[0])
b = browser()
print('worker before:', worker(b))
t = json.loads(get('/json/new?about:blank', 'PUT')); w = WS(t['webSocketDebuggerUrl'])
try:
    w.call('ServiceWorker.enable'); time.sleep(1)
    regs = [e['params'] for e in w.events if e.get('method') == 'ServiceWorker.workerRegistrationUpdated']
    print('registrations seen:', json.dumps(regs)[:400])
    try: print('startWorker:', w.call('ServiceWorker.startWorker', scopeURL='chrome-extension://%s/' % ID))
    except Exception as e: print('startWorker error:', e)
    time.sleep(1)
finally:
    w.s.close(); get('/json/close/' + t['id'])
b = browser(); print('worker after:', worker(b))
print(json.dumps(state())[:600])
