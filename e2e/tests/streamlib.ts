// Helpers for stream.spec.ts: a test-only client for the media path (desk-runtime.md sections 8.5 and 8.6, API.md),
// the pages shown in the desk's Chromium, and non-blocking SSM. No secret is ever printed: desk tokens and the Bearer
// stay in memory, and nothing below logs an SDP, a token or a resume token.
//
// The pages are copies of spikes/browser-bench/real-stack/pages/ (scroll.html, latency-wc.html, bench.js' fps counter)
// and page2.js' probe, so these numbers read against docs/benchmarks/2026-11-real-stack.md. What differs: this run has
// no CDP from the workstation, so each page publishes what it saw in document.title, and the spec reads that back
// through deskd's own browser.tabs and browser.tab.list.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { API, DESK_ID, INSTANCE, REGION } from './lib';

const run = promisify(execFile);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const PAGES_PORT = 18765;
export const PAGES_DIR = '/tmp/ma-e2e-stream';
const PAGES_UNIT = 'ma-e2e-stream-pages';
export const pageUrl = (path: string) => `http://127.0.0.1:${PAGES_PORT}/${path}`;

/** Budgets, design 2.2 as the real-stack report states them. */
export const B11 = { avg: 58, p5: 55 };
export const B12 = { p50: 90, p95: 150, atRttMs: 30 };
export const B13_MS = 300;

/** Same interpolation as proof2.mjs, so percentiles compare. */
export const pct = (xs: (number | null | undefined)[], p: number): number | null => {
  const s = xs.filter((x): x is number => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const k = ((s.length - 1) * p) / 100, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
  return +(s[f] + (s[c] - s[f]) * (k - f)).toFixed(1);
};
export const sum5 = (xs: (number | null | undefined)[]) => ({ n: xs.filter((x) => x !== null && x !== undefined).length, p50: pct(xs, 50), p95: pct(xs, 95), min: pct(xs, 0), max: pct(xs, 100) });

// ---- SSM, without blocking the event loop (lib.onDesk blocks it, which would stall the page-side clocks' reads) ----
async function aws(...args: string[]): Promise<string> {
  const { stdout } = await run('aws', args, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION } });
  return stdout;
}

/** Runs a shell command on the test desk. Only lib's INSTANCE is ever addressed. */
export async function deskRun(command: string, timeoutS = 90): Promise<string> {
  const id = (await aws('ssm', 'send-command', '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await sleep(700);
    let inv: { Status: string; StandardOutputContent: string; StandardErrorContent: string };
    try { inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', INSTANCE, '--output', 'json')); } catch { continue; }
    if (inv.Status === 'Success') return inv.StandardOutputContent;
    if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}: ${inv.StandardErrorContent.slice(0, 300)}`);
  }
  throw new Error('ssm command timed out');
}

export interface DeskUnits {
  units: Record<string, { active: string; pid: number }>;
  stream: { wanted?: string; rtc?: string } | null;
  browser: Record<string, unknown> | null;
  healthStatus: string | null;
}
/** systemd's own view of the units, and what deskd's /health says about the stream. */
export async function deskUnits(): Promise<DeskUnits> {
  const out = await deskRun(
    `for u in desk-stream desk-browser desk-xorg desk-audio desk-rtc deskd; do echo "U $u $(systemctl is-active $u) $(systemctl show -p MainPID --value $u)"; done; ` +
    `echo "H $(curl -s -m 3 --unix-socket /run/desk/deskd-admin.sock http://desk/health)"`);
  const units: DeskUnits['units'] = {};
  let health: { stream?: DeskUnits['stream']; browser?: DeskUnits['browser']; status?: string } = {};
  for (const line of out.split('\n')) {
    const [tag, a, b, c] = line.split(' ');
    if (tag === 'U') units[a] = { active: b, pid: Number(c) };
    if (tag === 'H') { try { health = JSON.parse(line.slice(2)); } catch { /* deskd isn't answering */ } }
  }
  return { units, stream: health.stream ?? null, browser: health.browser ?? null, healthStatus: health.status ?? null };
}

export async function deskVersions(): Promise<Record<string, string>> {
  const out = await deskRun(`for c in desk-rtc desk-stream deskd; do echo "$c=$(basename "$(readlink -f /opt/ma/$c/current)")"; done; echo "image=$(grep '^version=' /etc/ma-release | cut -d= -f2)"; echo "bootedAt=$(uptime -s)"; echo "instanceType=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $(curl -s -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)"`);
  return Object.fromEntries(out.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
}

/** Kernel UDP counters from a /proc/net/snmp body. A rise in RcvbufErrors or SndbufErrors is a socket overflowing on that host. */
function udpCounters(snmp: string): Record<string, number> {
  const rows = snmp.split('\n').filter((l) => l.startsWith('Udp:')).map((l) => l.split(/\s+/).slice(1));
  if (rows.length < 2) return {};
  return Object.fromEntries(rows[0].map((k, i) => [k, Number(rows[1][i])]));
}
export const localUdp = () => udpCounters(readFileSync('/proc/net/snmp', 'utf8'));
export const udpDelta = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(['InDatagrams', 'InErrors', 'RcvbufErrors', 'SndbufErrors', 'OutDatagrams'].map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]));

export interface CpuSample { at: number; total: number; idle: number; units: Record<string, number>; udp: Record<string, number>; nic: Record<string, number> }
export async function deskCpu(): Promise<CpuSample> {
  const names = ['desk-stream', 'desk-browser', 'deskd', 'desk-rtc', 'desk-xorg', 'desk-audio'];
  const out = await deskRun(`date +%s.%N; head -1 /proc/stat; for u in ${names.join(' ')}; do systemctl show -p CPUUsageNSec --value $u; done; ` +
    `grep '^Udp:' /proc/net/snmp; dev=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); ethtool -S "$dev" 2>/dev/null | grep -E 'allowance_exceeded' | sed 's/^ */NIC /'; tc -s qdisc show dev "$dev" 2>/dev/null | grep -oE 'dropped [0-9]+' | sed 's/^/QDISC /'`);
  const lines = out.trim().split('\n');
  const f = lines[1].trim().split(/\s+/).slice(1).map(Number);
  const units: Record<string, number> = {};
  names.forEach((n, i) => { const v = Number(lines[2 + i]); if (Number.isFinite(v)) units[n] = v; });
  const nic: Record<string, number> = {};
  for (const l of lines) {
    const m = /^NIC (\S+): (\d+)/.exec(l); if (m) nic[m[1]] = Number(m[2]);
    const q = /^QDISC dropped (\d+)/.exec(l); if (q) nic.qdiscDropped = (nic.qdiscDropped ?? 0) + Number(q[1]);
  }
  return { at: Number(lines[0]), total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4], units, udp: udpCounters(lines.filter((l) => l.startsWith('Udp:')).join('\n')), nic };
}
export function cpuBetween(a: CpuSample, b: CpuSample) {
  const dt = b.at - a.at;
  const unit: Record<string, number> = {};
  for (const k of Object.keys(b.units)) if (k in a.units) unit[k] = +(((b.units[k] - a.units[k]) / 1e9 / dt) * 100).toFixed(1); // percent of one core
  const nic: Record<string, number> = {};
  for (const k of Object.keys(b.nic)) nic[k] = b.nic[k] - (a.nic[k] ?? 0);
  return { seconds: +dt.toFixed(1), machinePct: +((1 - (b.idle - a.idle) / (b.total - a.total)) * 100).toFixed(1), unitPctOfOneCore: unit, udp: udpDelta(a.udp, b.udp), nic };
}

// ---- Pages on the desk ----
/** rAF rate and scroll changes inside the desk's Chromium, published in the title. The counter is bench.js' own. */
const REPORT_JS = `(function () {
  const q = new URLSearchParams(location.search);
  const S = { frames: 0, sf: 0, px: 0, lf: 0, y: scrollY, last: null };
  window.__extra = {};
  requestAnimationFrame(function loop(t) {
    if (S.last !== null && t - S.last > 25) S.lf++;
    S.last = t; S.frames++;
    const y = scrollY;
    if (y !== S.y) { S.sf++; S.px += Math.abs(y - S.y); S.y = y; }
    requestAnimationFrame(loop);
  });
  window.__publish = () => {
    document.title = 'R' + JSON.stringify(Object.assign({ t: Math.round(performance.now()), f: S.frames, sf: S.sf, px: Math.round(S.px), lf: S.lf, y: Math.round(scrollY),
      sw: screen.width, sh: screen.height, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, vis: document.visibilityState, foc: document.hasFocus() ? 1 : 0, n: q.get('n') || '' }, window.__extra)).replaceAll('"', '~');
  };
  setInterval(window.__publish, 1000);
  window.__publish();
  function counter() {
    if (!document.body) return setTimeout(counter, 100);
    const el = document.createElement('div');
    el.id = '__fps';
    el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;font:bold 20px monospace;background:#000;color:#0f0;padding:4px 8px;';
    document.body.appendChild(el);
    let n = 0, t0 = performance.now();
    (function tick(t) { n++; if (t - t0 >= 500) { el.textContent = (n * 1000 / (t - t0)).toFixed(0) + ' fps'; n = 0; t0 = t; } requestAnimationFrame(tick); })(t0);
  }
  counter();
})();`;

const BARS_HTML = `<!doctype html><meta charset="utf-8"><title>bars</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}.q{position:fixed;width:50vw;height:50vh}
#l{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#000;color:#fff;font:700 56px monospace;padding:24px 40px;white-space:nowrap}</style>
<script src="report.js"></script>
<body><div class="q" style="left:0;top:0;background:#c00000"></div><div class="q" style="left:50vw;top:0;background:#00b000"></div>
<div class="q" style="left:0;top:50vh;background:#0000c0"></div><div class="q" style="left:50vw;top:50vh;background:#f0f0f0"></div><div id="l"></div>
<script>document.getElementById('l').textContent = 'MA stream e2e ' + new URLSearchParams(location.search).get('n');</script></body>`;

// Same document as real-stack/pages/scroll.html.
const SCROLL_HTML = `<!doctype html><meta charset="utf-8"><title>scroll test</title>
<style>body{margin:0 auto;max-width:1100px;font:18px/1.6 Georgia,serif;color:#222;background:#fafafa;padding:20px}
h2{font:bold 28px sans-serif;margin:40px 0 10px}.card{display:flex;gap:16px;margin:16px 0;padding:16px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.img{flex:0 0 260px;height:160px;border-radius:8px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:4px 8px;font:14px sans-serif}</style>
<script src="report.js"></script>
<body><h1>Scroll benchmark page</h1><div id="c"></div>
<script>
let s = 1; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua minimalist desk alliance browser stream frame latency'.split(' ');
const para = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ') + '.';
let h = '';
for (let i = 0; i < 220; i++) {
  h += '<h2>Section ' + (i + 1) + '</h2><p>' + para(90) + '</p>';
  const a = Math.floor(rnd() * 360), b = Math.floor(rnd() * 360);
  h += '<div class="card"><div class="img" style="background:linear-gradient(' + a + 'deg,hsl(' + a + ',70%,55%),hsl(' + b + ',70%,45%))"></div><p>' + para(60) + '</p></div>';
  if (i % 5 === 0) { h += '<table>'; for (let r = 0; r < 8; r++) { h += '<tr>' + Array.from({ length: 6 }, () => '<td>' + (rnd() * 1e5).toFixed(2) + '</td>').join('') + '</tr>'; } h += '</table>'; }
}
document.getElementById('c').innerHTML = h;
</script></body>`;

// Same square as real-stack/pages/latency-wc.html. ?load=1 replaces its 1080p60 BBB clip (not in the repo) with an animated
// canvas of the same 520x292 size, so this load is not the benchmark's load.
const LATENCY_HTML = `<!doctype html><meta charset="utf-8"><title>latency</title>
<style>html,body{margin:0;height:100%;background:#808080;overflow:hidden}
#sq{position:absolute;left:50%;top:50%;width:800px;height:800px;margin:-400px 0 0 -400px;background:#000}
#v{position:absolute;left:0;top:0;width:520px;height:292px}</style>
<script src="report.js"></script>
<body><div id="sq"></div><canvas id="v" width="520" height="292" style="display:none"></canvas>
<script>
let white = false, n = 0;
addEventListener('keydown', (e) => { white = !white; n++; window.__extra.kd = n; document.getElementById('sq').style.background = white ? '#fff' : '#000'; e.preventDefault(); }, true);
if (new URLSearchParams(location.search).get('load')) {
  const c = document.getElementById('v'), x = c.getContext('2d'); c.style.display = 'block';
  requestAnimationFrame(function draw(t) {
    for (let i = 0; i < 24; i++) {
      const a = t / 500 + i, cx = 260 + 240 * Math.sin(a * 1.3), cy = 146 + 130 * Math.cos(a * 0.7);
      const g = x.createRadialGradient(cx, cy, 2, cx, cy, 90);
      g.addColorStop(0, 'hsl(' + ((t / 8 + i * 40) % 360) + ',90%,60%)'); g.addColorStop(1, 'hsl(' + ((t / 5 + i * 70) % 360) + ',80%,25%)');
      x.fillStyle = g; x.fillRect(cx - 90, cy - 90, 180, 180);
    }
    requestAnimationFrame(draw);
  });
  window.__extra.load = 1;
}
</script></body>`;

/** Every event the page saw, in the title. Fixed targets, so a wrong coordinate lands on the wrong element. */
const INPUT_HTML = `<!doctype html><meta charset="utf-8"><title>input</title>
<style>html,body{margin:0;background:#eef;font:20px sans-serif}body{width:5000px;height:20000px}
.t{position:fixed;width:120px;height:80px;border:0;background:#264;color:#fff;font:20px sans-serif}
#text{position:fixed;left:760px;top:40px;width:400px;height:48px;font:28px monospace}
.z{position:fixed;top:500px;width:200px;height:100px}</style>
<body><button class="t" id="tl" style="left:20px;top:20px">tl</button><button class="t" id="tr" style="left:1780px;top:20px">tr</button>
<button class="t" id="bl" style="left:20px;top:980px">bl</button><button class="t" id="br" style="left:1780px;top:980px">br</button>
<button class="t" id="mid" style="left:900px;top:300px">mid</button><input id="text" autocomplete="off" spellcheck="false">
<div class="z" id="pt" style="left:400px;background:#36a;cursor:pointer"></div><div class="z" id="tx" style="left:700px;background:#6a3;cursor:text"></div><div class="z" id="no" style="left:1000px;background:#a36;cursor:none"></div>
<script>
const text = document.getElementById('text');
const s = { id: Math.round(performance.timeOrigin) % 100000, c: {}, l: null, md: 0, mu: 0, cm: 0, mv: null, kd: 0, ku: 0, rp: 0, lk: '', lc: '', sh: 0, v: '', sy: 0, sx: 0 };
const pub = () => { s.v = text.value.slice(-24); s.sy = Math.round(scrollY); s.sx = Math.round(scrollX); document.title = 'I' + JSON.stringify(s).replaceAll('"', '~'); };
addEventListener('mousedown', () => { s.md++; pub(); }, true);
addEventListener('mouseup', () => { s.mu++; pub(); }, true);
addEventListener('click', (e) => { const id = e.target.id || e.target.tagName; s.c[id] = (s.c[id] || 0) + 1; s.l = [id, e.clientX, e.clientY, e.button]; pub(); }, true);
addEventListener('contextmenu', (e) => { s.cm++; s.l = [e.target.id || e.target.tagName, e.clientX, e.clientY, e.button]; e.preventDefault(); pub(); }, true);
addEventListener('mousemove', (e) => { s.mv = [e.clientX, e.clientY]; pub(); }, true);
addEventListener('keydown', (e) => { s.kd++; if (e.repeat) s.rp++; s.lk = e.key; s.lc = e.code; s.sh = e.shiftKey ? 1 : 0; pub(); }, true);
addEventListener('keyup', () => { s.ku++; pub(); }, true);
addEventListener('input', pub, true);
addEventListener('scroll', pub, true);
pub();
</script></body>`;

/** A click (a real user activation, so the autoplay policy allows it) starts or stops a 1 kHz tone. */
const AUDIO_HTML = `<!doctype html><meta charset="utf-8"><title>audio</title>
<style>html,body{margin:0;height:100%;background:#123}#play{position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;background:#123;color:#fff;font:700 64px sans-serif}</style>
<script src="report.js"></script>
<body><button id="play">tone</button>
<script>
let ctx, osc; window.__extra.on = 0;
document.getElementById('play').addEventListener('click', async () => {
  ctx = ctx || new AudioContext(); await ctx.resume();
  if (osc) { osc.stop(); osc = null; window.__extra.on = 0; } else { osc = ctx.createOscillator(); osc.frequency.value = 1000; const g = ctx.createGain(); g.gain.value = 0.5; osc.connect(g).connect(ctx.destination); osc.start(); window.__extra.on = 1; }
  window.__extra.ctx = ctx.state; window.__publish();
});
</script></body>`;

/** Characters a real page title has: & in "Q&A", quotes, angle brackets, non-ASCII. */
export const TITLE_TEXT = 'Q&A: <b> "quoted" it\'s é € 中';
const TITLE_HTML = `<!doctype html><meta charset="utf-8"><title>title</title><body>title check<script>document.title = ${JSON.stringify(TITLE_TEXT)};</script></body>`;

const PAGES: Record<string, string> = { 'title.html': TITLE_HTML, 'report.js': REPORT_JS, 'bars.html': BARS_HTML, 'scroll.html': SCROLL_HTML, 'latency.html': LATENCY_HTML, 'input.html': INPUT_HTML, 'audio.html': AUDIO_HTML };

/** A loopback-only static server in a transient unit as `nobody`. Removed by removePages(). */
export async function deployPages(): Promise<void> {
  const writes = Object.entries(PAGES).map(([name, body]) => `echo ${Buffer.from(body).toString('base64')} | base64 -d > ${PAGES_DIR}/${name}`).join('\n');
  const out = await deskRun(`set -e
systemctl stop ${PAGES_UNIT} 2>/dev/null || true
systemctl reset-failed ${PAGES_UNIT} 2>/dev/null || true
rm -rf ${PAGES_DIR}; install -d -m 755 ${PAGES_DIR}
${writes}
chmod 644 ${PAGES_DIR}/*
systemd-run --quiet --collect --unit=${PAGES_UNIT} --uid=65534 --gid=65534 /usr/bin/python3 -I -m http.server ${PAGES_PORT} --bind 127.0.0.1 --directory ${PAGES_DIR}
sleep 1
curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' http://127.0.0.1:${PAGES_PORT}/bars.html`);
  if (!out.includes('HTTP=200')) throw new Error(`the page server on the desk did not answer: ${out.slice(0, 200)}`);
}
export async function removePages(): Promise<void> {
  await deskRun(`systemctl stop ${PAGES_UNIT} 2>/dev/null || true; systemctl reset-failed ${PAGES_UNIT} 2>/dev/null || true; rm -rf ${PAGES_DIR}; echo removed`);
}

// ---- The client, in the page ----
export const FIXTURE_PATH = '/__stream-e2e';
/** Served by page.route at the app's own origin, so the gateway's Origin check is the real one. No app code, so no app session. */
export const FIXTURE_HTML = '<!doctype html><meta charset="utf-8"><title>stream e2e client</title><style>html,body{margin:0;background:#000}</style><body></body>';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const installClient = () => {
  const w = window as any;
  if (w.C) return;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const KIND = { HELLO: 1, AUTH: 2, PING: 4, PONG: 5, CLOSE: 6, REQ: 7, RES: 8, ERR: 9, SUB: 10, EVT: 12 };
  const TYPE: Record<string, number> = { MOVE: 1, BUTTON: 2, WHEEL: 3, KEY: 4, RELEASE_ALL: 5 };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const log: any[] = [];
  const mark = (what: string, extra: any = {}) => log.push({ t: +performance.now().toFixed(1), wall: Date.now(), what, ...extra });

  // API.md section 2.
  const frame = (kind: number, id: number, payload: unknown) => {
    const body = enc.encode(JSON.stringify(payload));
    const buf = new Uint8Array(12 + body.length);
    const v = new DataView(buf.buffer);
    buf[0] = 1; buf[1] = kind; v.setUint32(4, id);
    buf.set(body, 12);
    return buf;
  };
  const parts = new Map<string, Uint8Array[]>();
  const reassemble = (chan: string, data: ArrayBuffer) => {
    const b = new Uint8Array(data), v = new DataView(data);
    const f = { kind: b[1], flags: b[2], id: v.getUint32(4), seq: v.getUint32(8) };
    const key = `${chan}:${f.kind}:${f.id}`;
    const payload = b.subarray(12);
    if (f.flags & 1) { const p = parts.get(key) ?? []; p.push(payload.slice()); parts.set(key, p); return null; }
    const held = parts.get(key);
    if (!held) return { ...f, body: payload };
    parts.delete(key);
    const whole = new Uint8Array(held.reduce((n, x) => n + x.length, 0) + payload.length);
    let at = 0;
    for (const x of [...held, payload]) { whole.set(x, at); at += x.length; }
    return { ...f, body: whole };
  };
  const hexOf = (s: string) => s.replaceAll(':', '').toLowerCase();

  // ---- the tab's one gateway WebSocket (gateway.md 0.3.3) ----
  let ws: WebSocket | null = null;
  const waiting = new Map<string, (m: any) => void>();
  let wsNext = 1;
  let S: any = null;
  const onGateway = (m: any) => {
    const r = m.id ? waiting.get(m.id) : undefined;
    if (r) { waiting.delete(m.id); r(m); return; }
    if (m.type === 'pong') return;
    if (m.type === 'signal' && S && m.sessionId === S.sessionId) { S.onSignal(m.data); return; }
    if (m.type === 'session.closed') { mark('gateway session.closed', { sessionId: m.sessionId, reason: m.reason }); if (S && m.sessionId === S.sessionId) S.gone('session.closed'); return; }
    mark(`gateway ${m.type}`, { code: m.code, reason: m.reason });
  };
  const ensureGateway = (url: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((res, rej) => {
      const s = new WebSocket(url, 'ma.gw.v1');
      s.onopen = () => { ws = s; mark('gateway open'); res(); };
      s.onerror = () => rej(new Error('gateway refused the WebSocket'));
      s.onmessage = (e) => { try { onGateway(JSON.parse(e.data)); } catch { /* not ours */ } };
      s.onclose = (e) => { mark('gateway closed', { code: e.code }); if (ws === s) ws = null; };
    });
  };
  const gwRequest = (m: any, ms: number) => new Promise<any>((res) => {
    const id = `r${wsNext++}`;
    const timer = setTimeout(() => { waiting.delete(id); res({ type: 'timeout' }); }, ms);
    waiting.set(id, (x) => { clearTimeout(timer); res(x); });
    if (!ws) { clearTimeout(timer); waiting.delete(id); res({ type: 'no_gateway' }); return; }
    ws.send(JSON.stringify({ ...m, id }));
  });
  setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 4 * 60_000);

  // ---- identity ----
  let cert: RTCCertificate;
  const identity = async () => {
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: 24 * 3600 * 1000 } as any);
    return 'sha-256 ' + cert.getFingerprints().find((f) => f.algorithm === 'sha-256')!.value!.toUpperCase();
  };

  // ---- video element and the probe (real-stack/page2.js) ----
  const video = document.createElement('video');
  video.playsInline = true; video.autoplay = true;
  video.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;object-fit:contain;background:#000';
  document.body.append(video);
  const px = document.createElement('canvas'); px.width = 8; px.height = 8;
  const pctx = px.getContext('2d', { willReadFrequently: true })!;
  const TW = 96, TH = 54;
  const thumb = document.createElement('canvas'); thumb.width = TW; thumb.height = TH;
  const tctx = thumb.getContext('2d', { willReadFrequently: true })!;
  const P: any = { frames: 0, changed: 0, lastLum: null, arm: null, armed: false, results: [], firstAfter: null, firstAt: null, lastFrameAt: 0 };
  let prevThumb: Uint8Array | null = null;
  const onFrame = (now: number, m: any) => {
    P.frames++;
    P.lastFrameAt = now;
    if (P.firstAfter !== null && P.firstAt === null) P.firstAt = { now, display: m.expectedDisplayTime };
    tctx.drawImage(video, 0, 0, TW, TH);
    const td = tctx.getImageData(0, 0, TW, TH).data;
    const g = new Uint8Array(TW * TH);
    let diff = 0;
    for (let i = 0, j = 0; i < td.length; i += 4, j++) { g[j] = (td[i] * 3 + td[i + 1] * 6 + td[i + 2]) / 10; if (prevThumb) diff += Math.abs(g[j] - prevThumb[j]); }
    if (prevThumb && diff / (TW * TH) > 0.3) P.changed++;
    prevThumb = g;
    pctx.drawImage(video, video.videoWidth / 2 - 4, video.videoHeight / 2 - 4, 8, 8, 0, 0, 8, 8);
    const d = pctx.getImageData(0, 0, 8, 8).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i];
    const lum = s / 64;
    if (P.arm && (lum > 128) === P.arm.white) {
      P.results.push({ cb: now - P.arm.t0, display: m.expectedDisplayTime - P.arm.t0, recv: m.receiveTime ? m.receiveTime - P.arm.t0 : null });
      P.arm = null;
    }
    P.lastLum = lum;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  // ---- section 8.6 ----
  let seq = 0;
  const sendEvent = (type: number, f: any = {}) => {
    const b = new ArrayBuffer(16), v = new DataView(b);
    v.setUint8(0, type); v.setUint8(1, f.down ? 1 : 0); v.setUint8(2, f.button ?? 0);
    v.setUint32(4, ++seq); v.setUint16(8, f.x ?? 0); v.setUint16(10, f.y ?? 0);
    if (type === TYPE.KEY) v.setUint32(12, f.keysym);
    if (type === TYPE.WHEEL) { v.setInt16(12, f.dx ?? 0); v.setInt16(14, f.dy ?? 0); }
    if (type === TYPE.MOVE) {
      if (S.channels.input.bufferedAmount > 0) return false; // dropped, never queued
      S.channels.input.send(b);
    } else S.channels.keys.send(b);
    return true;
  };
  // A real keydown, as the app would see it. The stamp is taken in the listener, as page2.js does.
  addEventListener('keydown', (e) => {
    const t0 = performance.now();
    if (P.armed) { P.arm = { t0, white: !(P.lastLum > 128) }; P.armed = false; }
    if (S?.channels?.keys?.readyState === 'open' && e.key.length === 1 && e.key.charCodeAt(0) < 0x100) sendEvent(TYPE.KEY, { down: true, keysym: e.key.charCodeAt(0) });
    e.preventDefault();
  }, true);
  addEventListener('keyup', (e) => {
    if (S?.channels?.keys?.readyState === 'open' && e.key.length === 1 && e.key.charCodeAt(0) < 0x100) sendEvent(TYPE.KEY, { down: false, keysym: e.key.charCodeAt(0) });
    e.preventDefault();
  }, true);

  // ---- one session ----
  const cursors: any[] = [];
  const titles: any[] = [];
  let tabsNow: any[] | null = null;
  let tabEvents = 0;

  let lastResume: { sessionId: string; resumeToken: string } | null = null; // memory only, API.md section 3
  const open = async (o: { deskId: string; deskToken: string; gateway: string; identity: string[]; resume?: boolean }) => {
    const t0 = performance.now();
    await ensureGateway(o.gateway);
    const opened = await gwRequest({ type: 'session.open', deskId: o.deskId, deskToken: o.deskToken }, 20_000);
    if (opened.type !== 'session.opened') { mark('session.open refused', { type: opened.type, code: opened.code }); return { ok: false, step: 'session.open', type: opened.type, code: opened.code, message: opened.message, retryable: opened.retryable, ms: performance.now() - t0 }; }
    const tOpened = performance.now();
    const pc = new RTCPeerConnection({ iceServers: opened.iceServers ?? [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [cert] });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
    const channels: Record<string, RTCDataChannel> = {};
    const opens: Promise<unknown>[] = [];
    for (const [label, id, extra] of [['ctl', 0, {}], ['rpc', 1, {}], ['events', 2, {}], ['collab', 3, {}], ['mdoc', 4, {}], ['bulk', 5, {}], ['input', 6, { ordered: false, maxRetransmits: 0 }], ['keys', 7, {}]] as const) {
      const dc = pc.createDataChannel(label, { negotiated: true, id, ...extra });
      dc.binaryType = 'arraybuffer';
      channels[label] = dc;
      opens.push(new Promise((res) => { dc.onopen = res; }));
    }
    const session: any = { sessionId: opened.sessionId, pc, channels, pending: new Map(), nextId: 1, closedReasons: [], pongs: new Map() };
    S = session;
    seq = 0; // one counter per session, starting at 1 (8.6)
    session.gone = (why: string) => { session.closedReasons.push(why); };
    pc.onconnectionstatechange = () => mark('pc state', { state: pc.connectionState, sessionId: session.sessionId });
    const tracks: any = {};
    const trackInfo: any[] = [];
    const gotTracks = new Promise<void>((res) => {
      pc.ontrack = (e) => {
        tracks[e.track.kind] = e.track;
        trackInfo.push({ kind: e.track.kind, trackId: e.track.id, streamId: e.streams[0]?.id ?? null });
        if (e.track.kind === 'video') (e.receiver as any).jitterBufferTarget = 0; // design 6.5
        if (tracks.audio && tracks.video) res();
      };
    });
    session.tracks = tracks;

    await pc.setLocalDescription(await pc.createOffer());
    const offerSdp = pc.localDescription!.sdp;
    const answer = new Promise<any>((res) => { session.onSignal = res; });
    ws!.send(JSON.stringify({ type: 'signal', sessionId: opened.sessionId, data: { type: 'offer', sdp: offerSdp } }));
    const sig = await Promise.race([answer, pause(15_000).then(() => ({ type: 'timeout' }))]);
    session.onSignal = (d: any) => mark('late signal', { type: d?.type });
    if (sig.type !== 'answer') { mark('no answer', { type: sig.type, code: sig.code }); pc.close(); return { ok: false, step: 'answer', type: sig.type, code: sig.code, message: sig.message, ms: performance.now() - t0 }; }
    const sdp: string = sig.sdp;
    const fps = sdp.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith('a=fingerprint:')).map((l) => l.split(/\s+/));
    const identityOk = fps.length > 0 && fps.every((f) => f[0].toLowerCase() === 'a=fingerprint:sha-256' && o.identity.map(hexOf).includes(hexOf(f[1])));
    if (!identityOk) { pc.close(); return { ok: false, step: 'identity', message: "the answer's a=fingerprint isn't one of the desk's" }; }
    await pc.setRemoteDescription({ type: 'answer', sdp });
    const tracksAtRemote = await Promise.race([gotTracks.then(() => true), pause(5000).then(() => false)]);
    const channelsOpen = await Promise.race([Promise.all(opens).then(() => true), pause(20_000).then(() => false)]);
    if (!channelsOpen) { const st = `${pc.iceConnectionState}/${pc.connectionState}`; pc.close(); return { ok: false, step: 'channels', message: `channels didn't open, ice/conn ${st}` }; }
    const tChannels = performance.now();

    const finish = (id: number, f: any) => {
      const r = session.pending.get(id);
      if (r) { session.pending.delete(id); r(f); }
    };
    channels.rpc.onmessage = (e) => { const f = reassemble('rpc', e.data); if (f) finish(f.id, f); };
    channels.ctl.onmessage = (e) => {
      const f = reassemble('ctl', e.data);
      if (!f) return;
      if (f.kind === KIND.PONG) { const sent = session.pongs.get(f.id); if (sent) { session.pongs.delete(f.id); sent(performance.now()); } return; }
      if (f.kind === KIND.CLOSE) { const b = JSON.parse(dec.decode(f.body)); mark('ctl CLOSE', { code: b.code, reason: b.reason, sessionId: session.sessionId }); session.gone(`CLOSE ${b.code}`); return; }
      if (f.kind === KIND.AUTH) { const b = JSON.parse(dec.decode(f.body)); mark('ctl AUTH reply', { ok: b.ok, code: b.code }); return; }
      finish(f.id, f);
    };
    channels.events.onmessage = (e) => {
      const f = reassemble('events', e.data);
      if (!f || f.kind !== KIND.EVT) return;
      const ev = JSON.parse(dec.decode(f.body));
      if (ev.type === 'snapshot' && ev.data?.tabs) {
        tabEvents++;
        tabsNow = ev.data.tabs;
        titles.push({ t: performance.now(), tabs: ev.data.tabs.map((x: any) => ({ tabId: x.tabId, title: x.title, active: x.active })) });
        if (titles.length > 2000) titles.shift();
      } else if (ev.type === 'snapshot' && ev.data?.downloads) {
        downloadEvents.push({ t: performance.now(), downloads: ev.data.downloads });
      } else mark('events other', { type: ev.type, code: ev.data?.code });
    };
    channels.keys.onmessage = (e) => {
      const v = new DataView(e.data);
      const b = new Uint8Array(e.data);
      const c: any = { at: performance.now(), type: v.getUint8(0), hotX: v.getUint16(2), hotY: v.getUint16(4), w: v.getUint16(6), h: v.getUint16(8), bytes: e.data.byteLength, session: session.sessionId };
      if (c.type === 0x81 && e.data.byteLength > 10) {
        const png = b.subarray(10);
        c.pngSig = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
        let h = 2166136261; for (const x of png) { h ^= x; h = Math.imul(h, 16777619); }
        c.hash = (h >>> 0).toString(16);
        createImageBitmap(new Blob([png.slice()], { type: 'image/png' })).then((i) => { c.decoded = [i.width, i.height]; i.close(); }, () => { c.decoded = null; });
      }
      cursors.push(c);
    };
    for (const dc of [channels.ctl, channels.rpc]) dc.onclose = () => mark('channel closed', { label: dc.label, sessionId: session.sessionId });

    const hello: any = { deskApi: '1.0', appVersion: 'stream-e2e' };
    if (o.resume && lastResume) hello.resume = lastResume;
    const helloReply: any = await new Promise((res) => { session.pending.set(0, res); channels.ctl.send(frame(KIND.HELLO, 0, hello)); });
    const h = JSON.parse(dec.decode(helloReply.body));
    lastResume = { sessionId: opened.sessionId, resumeToken: h.resumeToken };
    const tHello = performance.now();

    video.srcObject = new MediaStream([tracks.video, tracks.audio]);
    video.play().catch((e) => mark('video.play refused', { error: String(e) }));
    prevThumb = null;

    const sections = sdp.split(/\r\n(?=m=)/).slice(1);
    const pick = (re: RegExp) => sections.map((s) => s.split('\r\n').filter((l) => re.test(l)));
    return {
      ok: true, sessionId: opened.sessionId,
      ms: { open: +(tOpened - t0).toFixed(1), toChannels: +(tChannels - t0).toFixed(1), toHello: +(tHello - t0).toFixed(1) },
      iceServers: (opened.iceServers ?? []).length, tracksAtRemote, tracks: trackInfo,
      sdp: { mLines: pick(/^m=/), directions: pick(/^a=(sendonly|recvonly|sendrecv|inactive)$/), rtpmaps: pick(/^a=rtpmap:/), fmtp: pick(/^a=fmtp:/), rtcpFb: pick(/^a=rtcp-fb:/), extmap: pick(/^a=extmap:/), playoutDelay: sdp.includes('playout-delay'), iceLite: /^a=ice-lite/m.test(sdp), candidates: (sdp.match(/^a=candidate:.*$/gm) ?? []).map((c) => c.split(' ').slice(2, 6).join(' ')) },
      hello: { deskApi: h.deskApi, version: h.version, deskId: h.deskId, resumed: h.resumed, sentResume: !!hello.resume, maxSessions: h.limits?.maxSessions },
    };
  };

  const call = (a: { m: string; p?: any; idem?: string; deadlineMs?: number; timeoutMs?: number }) => new Promise<any>((res) => {
    const s = S;
    if (!s || s.channels.rpc.readyState !== 'open') { res({ ok: false, code: 'no_session' }); return; }
    const id = s.nextId++;
    const timer = setTimeout(() => { s.pending.delete(id); res({ ok: false, code: 'client_timeout' }); }, a.timeoutMs ?? 45_000);
    s.pending.set(id, (f: any) => {
      clearTimeout(timer);
      const body = JSON.parse(dec.decode(f.body));
      res(f.kind === KIND.ERR ? { ok: false, code: body.code, message: body.message, details: body.details } : { ok: true, result: body });
    });
    const req: any = { m: a.m, p: a.p ?? {} };
    if (a.idem) req.idem = a.idem;
    if (a.deadlineMs) req.deadlineMs = a.deadlineMs;
    s.channels.rpc.send(frame(KIND.REQ, id, req));
  });
  const subscribeTabs = () => new Promise<any>((res) => {
    const s = S;
    const id = s.nextId++;
    const timer = setTimeout(() => { s.pending.delete(id); res({ ok: false, code: 'client_timeout' }); }, 15_000);
    s.pending.set(id, (f: any) => { clearTimeout(timer); const b = JSON.parse(dec.decode(f.body)); res(f.kind === KIND.ERR ? { ok: false, code: b.code, details: b.details } : { ok: true, subId: b.subId }); });
    s.channels.rpc.send(frame(KIND.SUB, id, { topic: 'browser.tabs', params: {} }));
  });
  const downloadEvents: any[] = [];
  const subscribeDownloads = () => new Promise<any>((res) => {
    const id = S.nextId++;
    const timer = setTimeout(() => { S.pending.delete(id); res({ ok: false, code: 'client_timeout' }); }, 15_000);
    S.pending.set(id, (f: any) => { clearTimeout(timer); const b = JSON.parse(dec.decode(f.body)); res(f.kind === KIND.ERR ? { ok: false, code: b.code, details: b.details } : { ok: true, subId: b.subId }); });
    S.channels.rpc.send(frame(KIND.SUB, id, { topic: 'browser.downloads', params: {} }));
  });
  /** PING to PONG on ctl: through SCTP, desk-rtc and deskd. */
  const pingRtt = async (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = S.nextId++;
      const t0 = performance.now();
      const rtt = await Promise.race([new Promise<number>((res) => { S.pongs.set(id, (t: number) => res(t - t0)); S.channels.ctl.send(frame(KIND.PING, id, {})); }), pause(3000).then(() => -1)]);
      if (rtt >= 0) out.push(rtt);
      await pause(100);
    }
    return out;
  };

  const stats = async () => {
    const out: any = { t: performance.now(), frames: P.frames, changed: P.changed, lastFrameAt: P.lastFrameAt, videoW: video.videoWidth, videoH: video.videoHeight, connection: S?.pc.connectionState ?? null };
    if (!S) return out;
    const s = await S.pc.getStats();
    const byId: any = {}; s.forEach((r: any) => { byId[r.id] = r; });
    s.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        out.video = { framesDecoded: r.framesDecoded, framesDropped: r.framesDropped ?? 0, framesReceived: r.framesReceived, framesPerSecond: r.framesPerSecond, bytes: r.bytesReceived, packetsLost: r.packetsLost, packetsReceived: r.packetsReceived,
          jitter: r.jitter, totalDecodeTime: r.totalDecodeTime, jitterBufferDelay: r.jitterBufferDelay, jitterBufferEmittedCount: r.jitterBufferEmittedCount, w: r.frameWidth, h: r.frameHeight, decoder: r.decoderImplementation,
          powerEfficient: r.powerEfficientDecoder, codec: byId[r.codecId]?.mimeType, fmtp: byId[r.codecId]?.sdpFmtpLine, freezeCount: r.freezeCount, totalFreezesDuration: r.totalFreezesDuration, nackCount: r.nackCount, pliCount: r.pliCount, firCount: r.firCount, keyFramesDecoded: r.keyFramesDecoded,
          retransmitted: r.retransmittedPacketsReceived, framesPerSecondStat: r.framesPerSecond, totalInterFrameDelay: r.totalInterFrameDelay, packetsDiscarded: r.packetsDiscarded };
      }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.audio = { bytes: r.bytesReceived, packetsReceived: r.packetsReceived, packetsLost: r.packetsLost, codec: byId[r.codecId]?.mimeType, concealedSamples: r.concealedSamples, energy: r.totalAudioEnergy, samples: r.totalSamplesReceived, level: r.audioLevel };
      if (r.type === 'transport' && r.selectedCandidatePairId) {
        const p = byId[r.selectedCandidatePairId], rc = byId[p?.remoteCandidateId], lc = byId[p?.localCandidateId];
        out.pair = { rtt: p?.currentRoundTripTime, totalRtt: p?.totalRoundTripTime, responses: p?.responsesReceived, bytesReceived: p?.bytesReceived, nominated: p?.nominated,
          remote: rc ? { address: rc.address ?? rc.ip, port: rc.port, protocol: rc.protocol, type: rc.candidateType } : null,
          local: lc ? { protocol: lc.protocol, type: lc.candidateType } : null };
      }
    });
    return out;
  };

  const firstFrame = async (a: { state?: string; waitMs?: number } = {}) => {
    const before = P.frames;
    P.firstAt = null; P.firstAfter = before;
    const t0 = performance.now();
    const r = await call({ m: 'browser.stream.set', p: { state: a.state ?? 'live' }, deadlineMs: 40_000 });
    const rpcMs = performance.now() - t0;
    if (!r.ok) { P.firstAfter = null; return { rpcMs, error: r, firstCbMs: null, firstDisplayMs: null }; }
    while (P.firstAt === null && performance.now() - t0 < (a.waitMs ?? 40_000)) await pause(2);
    const at = P.firstAt; P.firstAfter = null;
    return { rpcMs: +rpcMs.toFixed(1), state: r.result.state, firstCbMs: at ? +(at.now - t0).toFixed(1) : null, firstDisplayMs: at ? +(at.display - t0).toFixed(1) : null, wallAt: Date.now() };
  };

  /** Sets a state and watches inbound RTP for `watchMs`: when did the last packet of each kind arrive, counted from the request? */
  const setAndWatch = async (a: { state: string; watchMs: number }) => {
    const first = await stats();
    let vLast = first.video?.packetsReceived ?? 0, aLast = first.audio?.packetsReceived ?? 0;
    const t0 = performance.now();
    let vAt = 0, aAt = 0, polls = 0;
    const p = call({ m: 'browser.stream.set', p: { state: a.state }, deadlineMs: 40_000 });
    let rpcMs: number | null = null;
    const reply = p.then((r) => { rpcMs = +(performance.now() - t0).toFixed(1); return r; });
    while (performance.now() - t0 < a.watchMs) {
      const s = await stats(); polls++;
      const now = performance.now() - t0;
      if ((s.video?.packetsReceived ?? 0) !== vLast) { vLast = s.video?.packetsReceived ?? 0; vAt = now; }
      if ((s.audio?.packetsReceived ?? 0) !== aLast) { aLast = s.audio?.packetsReceived ?? 0; aAt = now; }
      await pause(40);
    }
    const r = await reply;
    return { ok: r.ok, code: r.code, details: r.details, state: r.result?.state, rpcMs, lastVideoPacketMs: +vAt.toFixed(1), lastAudioPacketMs: +aAt.toFixed(1), polls };
  };

  const segment = async (a: { seconds: number }) => {
    const ticks: any[] = [await stats()];
    for (let i = 0; i < a.seconds; i++) { await pause(1000); ticks.push(await stats()); }
    return ticks;
  };

  // The wheel as the app sends it in page2's scroll phase: about 1200 px/s, reversing every 4 s.
  let wheelOn = false, wheelSent = 0;
  const wheelStart = () => {
    wheelOn = true; wheelSent = 0;
    const t0 = performance.now(); let last = t0;
    const step = (now: number) => {
      if (!wheelOn) return;
      const dy = Math.round((now - last) * 1.2) * (((now - t0) % 8000) < 4000 ? 1 : -1);
      last = now;
      if (dy && S?.channels.keys.readyState === 'open') { sendEvent(TYPE.WHEEL, { x: 32768, y: 32768, dy }); wheelSent += Math.abs(dy); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const wheelStop = () => { wheelOn = false; return wheelSent; };

  const samplePixels = (points: [number, number][]) => {
    if (!video.videoWidth) return null;
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(video, 0, 0);
    return points.map(([a, b]) => Array.from(x.getImageData(a, b, 1, 1).data).slice(0, 3));
  };
  const grabFrame = () => {
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    return c.toDataURL('image/png');
  };

  /** Remote audio through Web Audio, for the peak frequency; the track also plays in the video element. */
  let actx: AudioContext | null = null, analyser: AnalyserNode | null = null;
  const audioPeak = async (a: { ms: number }) => {
    if (!actx) {
      actx = new AudioContext();
      await actx.resume();
    }
    analyser?.disconnect();
    analyser = actx.createAnalyser(); analyser.fftSize = 4096;
    actx.createMediaStreamSource(new MediaStream([S.tracks.audio])).connect(analyser);
    const buf = new Float32Array(analyser.frequencyBinCount);
    await pause(a.ms);
    analyser.getFloatFrequencyData(buf);
    let best = -Infinity, bin = 0;
    buf.forEach((v, i) => { if (v > best) { best = v; bin = i; } });
    return { state: actx.state, peakHz: Math.round((bin * actx.sampleRate) / analyser.fftSize), peakDb: Number.isFinite(best) ? +best.toFixed(1) : null };
  };

  const refresh = async (a: { deskToken: string }) => {
    const r = await gwRequest({ type: 'session.refresh', sessionId: S.sessionId, deskToken: a.deskToken }, 10_000);
    if (r.type === 'session.refreshed') { mark('token refreshed by gateway'); return { ok: true, via: 'gateway' }; }
    // gateway.md: fall back to the data channel.
    S.channels.ctl.send(frame(KIND.AUTH, S.nextId++, { deskToken: a.deskToken }));
    mark('token refresh fell back to AUTH', { type: r.type, code: r.code });
    return { ok: true, via: 'ctl', gatewayReply: r.type, code: r.code };
  };

  /** Ends the session for good: CLOSE on ctl (no resume), session.close on the gateway. */
  const closeSession = async () => {
    const s = S;
    if (!s) return { closed: false };
    const reply = s.sessionId ? gwRequest({ type: 'session.close', sessionId: s.sessionId, reason: 'closed_by_client' }, 3000) : Promise.resolve(null);
    try { if (s.channels.ctl.readyState === 'open') s.channels.ctl.send(frame(KIND.CLOSE, s.nextId++, { code: 1000, reason: 'closed_by_client' })); } catch { /* it's going anyway */ }
    await pause(300);
    await reply;
    s.pc.close();
    S = null;
    return { closed: true };
  };
  const dropPeer = () => { if (S) { S.pc.close(); } };

  w.C = {
    identity, open, call, subscribeTabs, subscribeDownloads, downloadEvents: () => downloadEvents, pingRtt, stats, firstFrame, setAndWatch, segment, wheelStart, wheelStop, samplePixels, grabFrame, audioPeak, refresh, closeSession, dropPeer,
    event: (a: { type: string; [k: string]: unknown }) => sendEvent(TYPE[a.type], a),
    arm: () => { P.armed = true; }, disarm: () => { P.arm = null; P.armed = false; }, results: () => P.results, resultCount: () => P.results.length, clearResults: () => { P.results = []; P.arm = null; P.armed = false; },
    frames: () => P.frames, cursors: () => cursors, titles: () => titles, tabEvents: () => tabEvents, tabs: () => tabsNow,
    log: () => log, sessionState: () => (S ? { sessionId: S.sessionId, connection: S.pc.connectionState, gone: S.closedReasons } : null), now: () => performance.now(),
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- The client, from the test ----
export const uuid7 = () => {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export class RpcFailure extends Error {
  constructor(readonly method: string, readonly code: string, readonly details: unknown) {
    super(`${method}: ${code} ${JSON.stringify(details ?? null)}`);
  }
}

export interface Tab { tabId: string; url: string; title: string; loading: boolean; active: boolean; canGoBack?: boolean; canGoForward?: boolean }
export interface OpenResult { ok: boolean; step?: string; code?: string; type?: string; message?: string; retryable?: boolean; sessionId?: string; [k: string]: unknown }

/**
 * Parses what a page published in its title. Null for a title that isn't ours (or was cut). Pages write `~` for `"`, because
 * titles reach the client HTML-escaped (test 1b checks that on its own).
 */
export function titleState<T = Record<string, unknown>>(title: string | undefined, tag: string): T | null {
  if (!title || !title.startsWith(tag)) return null;
  try { return JSON.parse(title.slice(tag.length).replaceAll('~', '"')) as T; } catch { return null; }
}

export class DeskClient {
  gateway = '';
  identity: string[] = [];
  connectPhase: string | null = null;
  tokenRefreshes: { at: string; via: string; code?: string }[] = [];
  /** The tab this suite opened. The tabs it found stay as they were. */
  testTabId: string | null = null;
  /** What deskd last reported as the title, when a page's report can't be read: evidence for a failure. */
  lastRawTitle = '';
  private fingerprint = '';
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(readonly page: Page, private readonly bearer: string, private readonly nonce: string) {}

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  c<T = any>(fn: string, arg?: unknown): Promise<T> {
    return this.page.evaluate(([f, a]) => (window as unknown as Record<string, Record<string, (x: unknown) => unknown>>).C[f as string](a), [fn, arg] as const) as Promise<T>;
  }

  async init(): Promise<void> {
    await this.page.evaluate(installClient);
    this.fingerprint = await this.c<string>('identity');
  }

  /** POST /connect with this tab's fingerprint. `start:false` never wakes anything. The token stays in this object's caller. */
  async connect(): Promise<{ status: number; deskToken?: string; state?: string; phase?: string | null; gateway?: string; identity: string[]; errorCode?: string }> {
    const r = await fetch(`${API}/v1/desks/${DESK_ID}/connect`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.bearer}` }, body: JSON.stringify({ scope: 'owner', start: false, clientDtlsFingerprint: this.fingerprint }) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, deskToken: j.deskToken, state: j.state, phase: j.phase, gateway: j.gateway, identity: j.deskIdentity?.fingerprintsSha256 ?? [], errorCode: j.error?.code };
  }

  /** One attempt at a whole session: connect, session.open, offer and answer, eight channels, HELLO, browser.tabs. */
  async open(resume = false): Promise<OpenResult> {
    const c = await this.connect();
    this.connectPhase = c.phase ?? null;
    if (c.status >= 300 || !c.deskToken) return { ok: false, step: 'connect', code: c.errorCode ?? String(c.status), phase: c.phase, state: c.state };
    if (c.phase !== 'ready') return { ok: false, step: 'connect', code: 'not_ready', phase: c.phase, state: c.state };
    this.gateway = c.gateway ?? this.gateway;
    this.identity = c.identity;
    const r = await this.c<OpenResult>('open', { deskId: DESK_ID, deskToken: c.deskToken, gateway: this.gateway, identity: this.identity, resume });
    if (r.ok) {
      const sub = await this.c<{ ok: boolean; code?: string }>('subscribeTabs');
      (r as Record<string, unknown>).tabsSubscribed = sub;
      this.startRefreshing();
    }
    return r;
  }

  /** Desk tokens live 5 min, so a session past that needs refresh (gateway.md 2.3). */
  private startRefreshing(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void (async () => {
        const c = await this.connect();
        if (!c.deskToken) { this.tokenRefreshes.push({ at: new Date().toISOString(), via: 'none', code: c.errorCode ?? String(c.status) }); return; }
        const r = await this.c<{ via: string; code?: string }>('refresh', { deskToken: c.deskToken });
        this.tokenRefreshes.push({ at: new Date().toISOString(), via: r.via, code: r.code });
      })().catch((e) => this.tokenRefreshes.push({ at: new Date().toISOString(), via: 'failed', code: String(e).slice(0, 120) }));
    }, 200_000);
    this.refreshTimer.unref();
  }
  stopRefreshing(): void { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null; }

  async rpcTry(m: string, p: unknown = {}, opts: { idem?: boolean; deadlineMs?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; result?: never; code?: string; details?: unknown; message?: string } & Record<string, unknown>> {
    return this.c('call', { m, p, idem: opts.idem ? uuid7() : undefined, deadlineMs: opts.deadlineMs, timeoutMs: opts.timeoutMs });
  }
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  async rpc<T = any>(m: string, p: unknown = {}, opts: { idem?: boolean; deadlineMs?: number; timeoutMs?: number } = {}): Promise<T> {
    const r = await this.rpcTry(m, p, opts);
    if (!r.ok) throw new RpcFailure(m, String(r.code), r.details);
    return r.result as T;
  }

  stats() { return this.c('stats'); }
  async tabs(): Promise<Tab[]> { return (await this.rpc<{ tabs: Tab[] }>('browser.tab.list')).tabs; }

  /**
   * API.md section 10: until Chromium is up, tab calls get `unavailable` and nothing holds them. On a first use after boot that
   * outlasts both the reply to `live` and the first frame, so a client has to retry. Returns how long that took, and every code seen.
   */
  async waitChromium(limitMs = 90_000): Promise<{ ms: number; codes: string[]; ok: boolean }> {
    const t0 = Date.now();
    const codes: string[] = [];
    while (Date.now() - t0 < limitMs) {
      const r = await this.rpcTry('browser.tab.list');
      if (r.ok) return { ms: Date.now() - t0, codes, ok: true };
      const code = `${r.code}:${(r.details as { reason?: string } | undefined)?.reason ?? ''}`;
      if (!codes.includes(code)) codes.push(code);
      await sleep(250);
    }
    return { ms: Date.now() - t0, codes, ok: false };
  }

  /** Live, and the session really decoding. Idempotent. */
  async ensureLive(): Promise<void> {
    const before = await this.c<number>('frames');
    const r = await this.c('firstFrame', { state: 'live', waitMs: 15_000 });
    if (r.error) throw new RpcFailure('browser.stream.set', r.error.code, r.error.details);
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      if ((await this.c<number>('frames')) > before) {
        const w = await this.waitChromium();
        if (!w.ok) throw new Error(`Chromium stayed unreachable for ${w.ms} ms after live: ${w.codes.join(', ')}`);
        return;
      }
      await sleep(50);
    }
    throw new Error('live was answered, but no frame decoded in 15 s');
  }

  /**
   * Shows a page in this suite's own tab, without touching the tabs already on the desk. navigate and activate name the tab;
   * the path that leaves out tabId has its own check in test 1.
   */
  async show(path: string): Promise<{ tabId: string; netError?: string }> {
    const sep = path.includes('?') ? '&' : '?';
    const url = pageUrl(`${path}${sep}n=${this.nonce}`);
    let tabId = this.testTabId;
    if (tabId && !(await this.tabs()).some((t) => t.tabId === tabId)) tabId = null;
    if (!tabId) {
      const opened = await this.rpc<{ tabId: string }>('browser.tab.open', { url }, { idem: true });
      tabId = this.testTabId = opened.tabId;
    } else {
      const nav = await this.rpc<{ tabId: string; netError?: string }>('browser.tab.navigate', { url, tabId }, { idem: true });
      if (nav.netError) return { tabId, netError: nav.netError };
    }
    if ((await this.tabs()).find((t) => t.tabId === tabId)?.active !== true) await this.rpc('browser.tab.activate', { tabId }, { idem: true });
    return { tabId };
  }

  /** Polls browser.tab.list until the test tab's title, as the page set it, satisfies `ok`. */
  async waitTitle<T = Record<string, number>>(tag: string, ok: (s: T) => boolean, timeoutMs = 8000): Promise<T | null> {
    const t0 = Date.now();
    let last: T | null = null;
    while (Date.now() - t0 < timeoutMs) {
      const tab = (await this.tabs()).find((t) => t.tabId === this.testTabId);
      this.lastRawTitle = tab?.title ?? '(no such tab)';
      const s = titleState<T>(tab?.title, tag);
      if (s) { last = s; if (ok(s)) return s; }
      await sleep(120);
    }
    return last;
  }

  /** Current published state without waiting for a condition. */
  async readTitle<T = Record<string, number>>(tag: string): Promise<T | null> {
    return titleState<T>((await this.tabs()).find((t) => t.tabId === this.testTabId)?.title, tag);
  }

  /** Closes this suite's tab, then the session. Leaves the desk's stream off, by asking for it as a client does. */
  async finish(): Promise<{ off?: unknown; closed?: unknown; tabClosed?: boolean }> {
    const out: { off?: unknown; closed?: unknown; tabClosed?: boolean } = {};
    const state = await this.c('sessionState').catch(() => null);
    if (!state || state.connection !== 'connected' || state.gone.length) {
      // The session died in a test: a tab left behind would come back in the desk's restored session, so get a new one.
      await this.c('dropPeer').catch(() => {});
      const again = await this.open(false).catch(() => ({ ok: false }));
      if (!again.ok) { this.stopRefreshing(); return out; }
    }
    this.stopRefreshing();
    if (this.testTabId) {
      const r = await this.rpcTry('browser.tab.close', { tabId: this.testTabId }, { idem: true, timeoutMs: 15_000 });
      out.tabClosed = r.ok;
      if (r.ok) this.testTabId = null;
    }
    out.off = await this.rpcTry('browser.stream.set', { state: 'off' }, { deadlineMs: 40_000, timeoutMs: 45_000 });
    out.closed = await this.c('closeSession');
    return out;
  }
}

// ---- Input encoding: section 8.6 ----
export const SCREEN = { w: 1920, h: 1080 };
export const nx = (px: number) => Math.max(0, Math.min(65535, Math.round((65535 * px) / SCREEN.w)));
export const ny = (px: number) => Math.max(0, Math.min(65535, Math.round((65535 * px) / SCREEN.h)));
/** `KeyboardEvent.key` to keysym: a code point below U+0100 is itself, anything else is 0x01000000 + code point. */
export const keysym = (ch: string) => { const cp = ch.codePointAt(0)!; return cp < 0x100 ? cp : 0x01000000 + cp; };
export const KEYSYM = { Shift: 0xffe1, Control: 0xffe3, Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Home: 0xff50, ArrowLeft: 0xff51, ArrowRight: 0xff53, End: 0xff57, Delete: 0xffff };
