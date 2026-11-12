// The Desk app's side of the Bible view, for the harness (a test aid, never shipped). It does what the host on
// sub/apps-host does (`web/src/deskapps/host/frame.ts`, `bridge.ts`, `AppView.tsx`): builds the sandboxed srcdoc frame with
// the view's own policy and the boot script, waits for `ma.boot`, hands the view a MessagePort with the theme's tokens,
// routes each call by the manifest's `mutation` flag (refusing undeclared names and a mutation without a key), answers a
// subscription with `{subId}` on its first event, and sends `{t: "theme"}` on a switch. Calls reach the real bible-app
// through the dev server (`server.mjs`), as the Desk app's reach it through deskd.
'use strict';
(async () => {
  const q = new URLSearchParams(location.search);
  const frame = document.getElementById('frame');
  const all = await (await fetch('/tokens.json')).json();
  let theme = ['light', 'dusk', 'dark'].includes(q.get('theme')) ? q.get('theme') : 'light';

  const paint = () => {
    const h = all[`harness.${theme}`];
    for (const [k, v] of Object.entries(h)) document.body.style.setProperty(`--${k}`, v);
  };
  paint();
  if (q.get('phone') === '1') {
    document.body.classList.add('phone');
    document.getElementById('back').hidden = false;
  } else {
    const win = document.getElementById('win');
    win.style.width = `${Number(q.get('w')) || 1000}px`;
    win.style.height = `${Number(q.get('h')) || 720}px`;
  }

  const manifest = await (await fetch('/ma-app.json')).json();
  const methods = new Map(manifest.methods.map((m) => [m.name, m.mutation]));
  const topics = new Set(manifest.topics);
  const files = await Promise.all(['index.html', 'view.js', 'view.css'].map((f) => fetch(`/view/${f}`).then((r) => r.text())));
  const [html, script, style] = files;
  const enc = new TextEncoder();
  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const sha = async (text) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
  const [scriptHash, styleHash] = await Promise.all([sha(script), sha(style)]);
  const font = q.get('font') === '0' ? null : await fetch('/font.woff2').then((r) => (r.ok ? r.arrayBuffer() : null));
  const sizes = files.map((f) => enc.encode(f).length);

  // The host lets the frame write the clipboard (FRAME_ALLOW on sub/apps-host, ADR 0054); &clip=0 plays an older office.
  if (q.get('clip') !== '0') frame.setAttribute('allow', 'clipboard-write');

  // frame.ts's viewSrcdoc, as written there.
  const bootUrl = new URL('/boot.js', location.href).href;
  const policy = `default-src 'none'; script-src ${bootUrl} 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`;
  const block = (id, bytes, attrs = '') => `<script type="text/plain" id="${id}"${attrs}>${b64(bytes)}</script>`;
  frame.srcdoc =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    block('ma-style', enc.encode(style)) +
    (font ? block('ma-font', new Uint8Array(font), ' data-family="Inter Variable"') : '') +
    block('ma-view', enc.encode(script), ` data-integrity="sha256-${scriptHash}"`) +
    `<script src="${bootUrl}" defer></script>` +
    `</head><body>${html}</body></html>`;

  const H = { calls: [], booted: null, loads: 0, sizes, port: null, theme: () => theme };
  window.__harness = H;
  frame.addEventListener('load', () => (H.loads += 1));

  const subs = new Map();
  let nextSub = 1;
  const onView = async ({ data: msg }) => {
    if (!msg || (typeof msg.id !== 'number' && typeof msg.id !== 'string')) return;
    const send = (v) => H.port.postMessage(v);
    const refuse = (code, reason) => send({ t: 'err', id: msg.id, err: { code, message: code, details: { reason } } });
    if (msg.t === 'call') {
      const mutation = methods.get(msg.m);
      if (mutation === undefined) return refuse('not_found', 'method');
      if (mutation && !/^[A-Za-z0-9_-]{8,64}$/.test(msg.idem || '')) return refuse('bad_request', 'idem');
      H.calls.push({ m: msg.m, p: msg.p, idem: mutation ? msg.idem : undefined });
      const r = await (await fetch('/api/call', { method: 'POST', body: JSON.stringify({ m: msg.m, p: msg.p ?? {}, idem: mutation ? msg.idem : undefined }) })).json();
      return send(r.err ? { t: 'err', id: msg.id, err: r.err } : { t: 'res', id: msg.id, res: r.res });
    }
    if (msg.t === 'sub') {
      if (!topics.has(msg.topic)) return refuse('not_found', 'topic');
      const subId = nextSub++;
      let answered = false;
      const es = new EventSource(`/api/events?topic=${encodeURIComponent(msg.topic)}`);
      subs.set(subId, es);
      es.onmessage = (e) => {
        if (!answered) {
          answered = true;
          send({ t: 'res', id: msg.id, res: { subId } });
        }
        send({ t: 'evt', sub: subId, evt: JSON.parse(e.data) });
      };
      es.addEventListener('err', (e) => {
        if (!answered) send({ t: 'err', id: msg.id, err: JSON.parse(e.data) });
        es.close();
      });
    }
  };

  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || !e.data || e.data.t !== 'ma.boot' || H.port) return;
    H.booted = e.data.ok === true;
    if (!H.booted) return;
    const ch = new MessageChannel();
    H.port = ch.port1;
    H.port.onmessage = onView;
    frame.contentWindow.postMessage({ t: 'ma.bridge', appApi: '1.0', tokens: all[theme] }, '*', [ch.port2]);
  });

  H.setTheme = (t) => {
    theme = t;
    paint();
    H.port?.postMessage({ t: 'theme', tokens: all[theme] });
  };
})();
