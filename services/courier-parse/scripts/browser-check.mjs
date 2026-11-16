#!/usr/bin/env node
// courier-parse's real-browser check (the Courier launch plan §7: "0 scripts run in a real browser").
//
//   node browser-check.mjs <chrome binary> <dir of NNNNNN.html files from BrowserExport> <port>
//
// Each sanitized document is served from 127.0.0.1:<port>/doc/<n> to a headless Chromium with scripts ON and NO Content
// Security Policy, so the sanitizer is the only wall, as if the office's frame and CSP had both failed. Then every element
// gets mouseover, mouseenter, focus and click (an anchor's click follows a live href). It counts, over CDP:
//   - dialogs (alert, confirm, prompt: what the vectors call when they run),
//   - every request other than the document itself (a hit on /hit/<name>, or anything else),
//   - navigations of the page or any frame away from the document.
// It exits 0 only if all three are 0. No npm packages: Node 24's own fetch and WebSocket speak CDP.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chrome, dir, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!chrome || !dir || !port) {
  console.error('usage: browser-check.mjs <chrome> <dir> <port>');
  process.exit(2);
}
const docs = readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
const hits = [];
let current = -1;
const server = createServer((req, res) => {
  const m = /^\/doc\/(\d+)$/.exec(req.url);
  if (m && Number(m[1]) === current) {
    const body = readFileSync(join(dir, docs[current]), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body>' + body + '</body></html>');
    return;
  }
  if (req.url !== '/favicon.ico') hits.push({ doc: current, url: req.url });
  res.writeHead(404);
  res.end();
});
await new Promise((ok) => server.listen(port, '127.0.0.1', ok));

const profile = mkdtempSync(join(tmpdir(), 'courier-browser-'));
const cdpPort = port + 1;
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });

let version;
for (let i = 0; i < 100 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
let nextId = 1;
const waiting = new Map();
const dialogs = [];
const navigations = [];
const requests = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
  if (msg.method === 'Page.javascriptDialogOpening') {
    dialogs.push({ doc: current, message: msg.params.message });
    send('Page.handleJavaScriptDialog', { accept: false });
  } else if (msg.method === 'Network.requestWillBeSent') {
    const url = msg.params.request.url;
    // The browser's own favicon fetch for the check's origin isn't the document's doing.
    if (url !== `http://127.0.0.1:${port}/doc/${current}` && url !== `http://127.0.0.1:${port}/favicon.ico`
        && !url.startsWith('data:') && url !== 'about:blank') {
      requests.push({ doc: current, url: url.slice(0, 200) });
    }
  } else if (msg.method === 'Page.frameNavigated') {
    const url = msg.params.frame.url;
    if (url !== `http://127.0.0.1:${port}/doc/${current}` && url !== 'about:blank' && !url.startsWith('about:srcdoc')) {
      navigations.push({ doc: current, url: url.slice(0, 200) });
    }
  }
});
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok) => waiting.set(id, ok));
}
await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');

const poke = `(() => { for (const el of document.querySelectorAll('*')) {
  for (const t of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'focus', 'focusin', 'animationstart', 'transitionend']) {
    try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
  }
  try { el.focus(); } catch (e) {}
  try { if (el.tagName !== 'A' || el.hasAttribute('href')) el.click(); else el.click(); } catch (e) {}
} return document.querySelectorAll('*').length; })()`;

const limit = Number(process.env.CHECK_LIMIT || docs.length);
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
const started = Date.now();
for (let i = 0; i < Math.min(limit, docs.length); i++) {
  current = i;
  const loaded = new Promise((ok) => {
    const t = setTimeout(ok, 3000);
    const on = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { clearTimeout(t); ws.removeEventListener('message', on); ok(); } };
    ws.addEventListener('message', on);
  });
  // Every step is bounded, so a document that keeps opening dialogs or navigating can't hold the check up.
  await within(send('Page.navigate', { url: `http://127.0.0.1:${port}/doc/${i}` }), 3000);
  await within(loaded, 3000);
  await within(send('Runtime.evaluate', { expression: poke, timeout: 2000 }), 2500);
  await new Promise((r) => setTimeout(r, 60));
  if ((i + 1) % 500 === 0) console.log(`  ${i + 1} of ${docs.length}`);
}
await new Promise((r) => setTimeout(r, 500));
const name = (n) => { try { return readFileSync(join(dir, docs[n].replace('.html', '.name')), 'utf8'); } catch { return String(n); } };
console.log(`browser check: ${Math.min(limit, docs.length)} documents in ${Math.round((Date.now() - started) / 1000)} s, ${version.Browser},`
  + ` scripts on, no CSP: ${dialogs.length} dialogs, ${requests.length + hits.length} requests, ${navigations.length} navigations`);
for (const d of dialogs.slice(0, 20)) console.log('  dialog', name(d.doc), d.message);
for (const r of requests.slice(0, 20)) console.log('  request', name(r.doc), r.url);
for (const h of hits.slice(0, 20)) console.log('  hit', name(h.doc), h.url);
for (const n of navigations.slice(0, 20)) console.log('  navigation', name(n.doc), n.url);
ws.close();
// Chromium still writes its profile as it exits, so the profile goes only once it has, with retries.
const exited = new Promise((r) => proc.once('exit', r));
proc.kill('SIGTERM');
await within(exited, 10000);
if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
server.close();
try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.error('left', profile, e.code); }
process.exit(dialogs.length + requests.length + hits.length + navigations.length === 0 ? 0 : 1);
