// End-to-end proof for milestone 2: a real browser with H.264 decode, real desk-rtc and desk-stream,
// kiosk Chromium on :99. Runs on the client box. See README "Prove the stream".
//   node proof.mjs --api http://DESK:8787 --cdp http://127.0.0.1:19222 --ssh 'ssh -i key admin@DESK' --out result.json [--phases a,b] [--tcp]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const DESK = 'd-dev0000000000';
const PAGES = 'http://127.0.0.1:8000';
const phases = (args.phases || 'firstframe,input,latency,scroll,video,warm,viewers').split(',');
const out = { args, phases: {}, failures: [] };
const log = (...a) => console.error(`[proof ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const k = (s.length - 1) * p / 100, f = Math.floor(k), c = Math.min(f + 1, s.length - 1); return +(s[f] + (s[c] - s[f]) * (k - f)).toFixed(1); };
const check = (name, ok, detail = '') => { log(ok ? 'ok  ' : 'FAIL', name, detail); if (!ok) out.failures.push(`${name} ${detail}`); };

function remoteSample(seconds) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `${args.ssh} python3 /opt/proof/sample.py ${seconds}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let o = ''; p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => { try { resolve(JSON.parse(o)); } catch { resolve({ error: o.slice(0, 200) }); } });
  });
}

const remote = (cmd) => new Promise((resolve) => {
  const p = spawn('sh', ['-c', `${args.ssh} "${cmd}"`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => resolve(o.trim()));
});

const pageServer = createServer((req, res) => {
  if (req.url === '/page.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(path.join(here, 'page.js'))); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>stream proof</title><style>html,body{margin:0;background:#000}</style><script src="/page.js"></script>');
});
const pagePort = await new Promise((r) => pageServer.listen(+(args.pagePort || 8099), '127.0.0.1', () => r(pageServer.address().port)));
const origin = `http://127.0.0.1:${pagePort}`;

// Playwright's "chromium" channel is Chrome for Testing in new headless mode, which has H.264.
const browser = await chromium.launch({ channel: args.channel === 'none' ? undefined : 'chromium', headless: true, executablePath: args.chrome || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-sandbox'] });
out.browser = browser.version();
log('client browser', out.browser);

const kiosk = await chromium.connectOverCDP(args.cdp);
// Session restore plus the startup URL leaves more than one tab after a Chromium restart, and a background
// tab is throttled to 1 fps. Keep one and bring it forward.
const kpages = kiosk.contexts()[0].pages();
const kpage = kpages[kpages.length - 1] || await kiosk.contexts()[0].newPage();
for (const p of kpages.slice(0, -1)) await p.close();
await kpage.bringToFront();
const goto = async (url, settle = 1000) => { await kpage.goto(url, { waitUntil: 'load', timeout: 45000 }); await sleep(settle); };

async function openClient() {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  page.on('pageerror', (e) => lines.push('pageerror: ' + e.message));
  await page.goto(origin);
  const opened = await page.evaluate((o) => window.openDesk(o), { api: args.api, deskId: DESK, tcpOnly: !!args.tcp });
  return { page, opened, lines };
}

const c = await openClient();
const cp = c.page;
out.answer = c.opened;
check('H.264 in the offer', c.opened.h264Offered);
check('audio and video answered sendonly', c.opened.sections[0].includes('a=sendonly') && c.opened.sections[1].includes('a=sendonly'), JSON.stringify(c.opened.sections.slice(0, 2)));
log('playout-delay offered', c.opened.playoutDelayOffered, 'answered', c.opened.playoutDelayAnswered);
const cstats = () => cp.evaluate(() => window.D.stats());

// Client asks for video; how long until a frame?
const firstFrame = () => cp.evaluate(async () => {
  const { P, call } = window.D;
  const before = P.frames;
  P.firstAt = null; P.firstAfter = before;
  const t0 = performance.now();
  await call('browser.stream.set', { state: 'live' });
  const rpc = performance.now() - t0;
  while (P.firstAt === null && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 2));
  const at = P.firstAt; P.firstAfter = null;
  return { rpcMs: rpc, firstCbMs: at ? at.now - t0 : null, firstDisplayMs: at ? at.display - t0 : null };
});

async function segment(name, seconds, action) {
  const s0 = await cstats();
  const smp = remoteSample(seconds);
  const act = action ? action(seconds) : null;
  const ticks = [];
  for (let i = 0; i < seconds; i++) { await sleep(1000); ticks.push(await cstats()); }
  if (act) await act;
  const cpu = await smp;
  const s1 = ticks[ticks.length - 1];
  const fps = ticks.map((t, i) => t.video.framesDecoded - (i ? ticks[i - 1] : s0).video.framesDecoded);
  const dt = (s1.t - s0.t) / 1000;
  const v0 = s0.video, v1 = s1.video;
  const r = {
    name, seconds: +dt.toFixed(1),
    fps_avg: +((v1.framesDecoded - v0.framesDecoded) / dt).toFixed(2), fps_p5: pct(fps, 5), fps_min: Math.min(...fps), per_second: fps,
    content_fps: +((s1.changed - s0.changed) / dt).toFixed(1),
    dropped: v1.framesDropped - v0.framesDropped, freezes: (v1.freezeCount || 0) - (v0.freezeCount || 0), freeze_seconds: +((v1.totalFreezesDuration || 0) - (v0.totalFreezesDuration || 0)).toFixed(3),
    mbps: +(((v1.bytes - v0.bytes) * 8) / dt / 1e6).toFixed(2),
    jitter_buffer_ms: +(1000 * (v1.jitterBufferDelay - v0.jitterBufferDelay) / Math.max(1, v1.jitterBufferEmittedCount - v0.jitterBufferEmittedCount)).toFixed(1),
    decode_ms: +(1000 * (v1.totalDecodeTime - v0.totalDecodeTime) / Math.max(1, v1.framesDecoded - v0.framesDecoded)).toFixed(1),
    processing_ms: +(1000 * (v1.totalProcessingDelay - v0.totalProcessingDelay) / Math.max(1, v1.framesDecoded - v0.framesDecoded)).toFixed(1),
    packets_lost: v1.packetsLost - v0.packetsLost, nacks: v1.nackCount - v0.nackCount, plis: v1.pliCount - v0.pliCount, keyframes: v1.keyFramesDecoded - v0.keyFramesDecoded,
    size: `${v1.w}x${v1.h}`, decoder: v1.decoder, codec: v1.codec, rtt_ms: s1.pair?.rtt !== undefined ? +(s1.pair.rtt * 1000).toFixed(1) : null, audio_bytes: (s1.audio?.bytes || 0) - (s0.audio?.bytes || 0), server: cpu,
  };
  log(name, `fps ${r.fps_avg} p5 ${r.fps_p5} min ${r.fps_min}, content ${r.content_fps}, ${r.mbps} Mbps, decode ${r.decode_ms} ms, lost ${r.packets_lost}, nack ${r.nacks}, pli ${r.plis}, jb ${r.jitter_buffer_ms} ms, freezes ${r.freezes}, server ${cpu.machine_pct}%`, JSON.stringify(cpu.units_pct_of_one_core));
  return r;
}

const norm = (px, size) => Math.round(65535 * px / (size - 1));
const R = {};

async function latencyPass(label, trials, load) {
  await goto(`${PAGES}/latency.html`, 1500);
  // Under load: a 1080p60 video beside the flipping square, so the desk's CPU is as busy as it gets.
  if (load) await kpage.evaluate(() => { const v = document.createElement('video'); v.src = 'media/test1080p60.mp4'; v.muted = true; v.loop = true; v.style = 'position:absolute;left:0;top:0;width:520px;height:292px'; document.body.append(v); return v.play(); });
  await cp.evaluate(() => { window.D.P.results = []; window.D.P.arm = null; });
  const smp = remoteSample(Math.round(trials * 0.45) + 3);
  let misses = 0;
  for (let i = 0; i < trials; i++) {
    await sleep(250 + Math.random() * 300);
    await cp.evaluate(() => { window.D.P.armed = true; });
    const n = await cp.evaluate(() => window.D.P.results.length);
    await cp.keyboard.press('x');
    const t = Date.now();
    while (Date.now() - t < 2000 && (await cp.evaluate(() => window.D.P.results.length)) <= n) await sleep(15);
    if ((await cp.evaluate(() => window.D.P.results.length)) <= n) { misses++; await cp.evaluate(() => { window.D.P.arm = null; }); }
  }
  const results = await cp.evaluate(() => window.D.P.results);
  const seen = await kpage.evaluate(() => window.__latencyState().n);
  const disp = results.map((r) => r.display), cb = results.map((r) => r.cb);
  const cpu = await smp;
  const st = await cstats();
  const r = { label, trials, detected: results.length, misses, keydowns_seen_on_desk: seen, display_ms: { p50: pct(disp, 50), p95: pct(disp, 95), min: Math.min(...disp), max: Math.max(...disp) }, callback_ms: { p50: pct(cb, 50), p95: pct(cb, 95) },
    recv_ms: { p50: pct(results.map((x) => x.recv).filter((x) => x !== null), 50) }, rtt_ms: st.pair?.rtt !== undefined ? +(st.pair.rtt * 1000).toFixed(1) : null, server: cpu };
  log('latency', label, `input-to-photon p50 ${r.display_ms.p50} p95 ${r.display_ms.p95} (callback p50 ${r.callback_ms.p50}), ${r.detected}/${trials}, keydowns on desk ${seen}, RTT ${r.rtt_ms}`);
  return r;
}

try {
  if (phases.includes('firstframe') || true) {
    // desk-stream is up and paused (warm) here: the runner starts it before this script.
    await goto(`${PAGES}/scroll.html`, 1500);
    R.firstframe = await firstFrame();
    log('first frame after live', JSON.stringify(R.firstframe));
    check('video reaches the browser', R.firstframe.firstCbMs !== null);
    await sleep(500);
    const st = await cstats();
    log('decoder', st.video.decoder, st.video.codec, `${st.video.w}x${st.video.h}`, 'audio bytes', st.audio?.bytes);
    out.decoder = { decoder: st.video.decoder, codec: st.video.codec, fmtp: st.video.fmtp, size: `${st.video.w}x${st.video.h}` };
    check('1080p H.264 decoded', st.video.w === 1920 && st.video.h === 1080 && /h264/i.test(st.video.codec), JSON.stringify(out.decoder));
  }

  if (phases.includes('input')) {
    await goto(`${PAGES}/input.html`, 1000);
    const send = (f) => cp.evaluate(f);
    const geo = await kpage.evaluate(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }; return { t: r('t'), b: r('b'), s: r('s'), l: r('l'), w: innerWidth, h: innerHeight, sx: screenX, sy: screenY }; });
    log('kiosk geometry', JSON.stringify(geo));
    const at = (p) => ({ x: norm(p[0] + geo.sx, 1920), y: norm(p[1] + geo.sy, 1080) });
    // Click into the text field and type.
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; ev(TYPE.MOVE, a); ev(TYPE.BUTTON, { ...a, button: 1, down: true }); ev(TYPE.BUTTON, { ...a, button: 1, down: false }); }, { a: at(geo.t) });
    await sleep(300);
    await cp.evaluate(() => { const { ev, TYPE } = window.D; const tap = (k) => { ev(TYPE.KEY, { keysym: k, down: true }); ev(TYPE.KEY, { keysym: k, down: false }); };
      for (const k of [0x68, 0x69, 0x20, 0x41, 0x21]) tap(k); // "hi A!" with no Shift sent: desk-rtc adds it
      tap(0x010020ac); // the euro sign, not on the US keymap
      tap(0xff51); }); // Left arrow
    await sleep(600);
    const value = await kpage.evaluate(() => [document.getElementById('t').value, document.getElementById('t').selectionStart, document.hasFocus(), window.E.keys.slice(0, 6)]);
    log('typed', JSON.stringify(value));
    check('keystrokes reach the page', value[0] === 'hi A!€', JSON.stringify(value[0]));
    check('Left arrow moved the caret', value[1] === 5, String(value[1]));
    // Shift held by the client: Shift, then 'B'. Ctrl+A selects.
    await cp.evaluate(() => { const { ev, TYPE } = window.D;
      ev(TYPE.KEY, { keysym: 0xffe1, down: true }); ev(TYPE.KEY, { keysym: 0x42, down: true }); ev(TYPE.KEY, { keysym: 0x42, down: false }); ev(TYPE.KEY, { keysym: 0xffe1, down: false }); });
    await sleep(300);
    const v2 = await kpage.evaluate(() => document.getElementById('t').value);
    check('Shift held by the client', v2.includes('B'), v2);
    // Click the button; the page sees its coordinates.
    const n0 = await kpage.evaluate(() => window.E.clicks.length);
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; ev(TYPE.BUTTON, { ...a, button: 1, down: true }); ev(TYPE.BUTTON, { ...a, button: 1, down: false }); }, { a: at(geo.b) });
    await sleep(400);
    const cl = await kpage.evaluate(() => window.E.clicks);
    check('click reaches the page at its coordinates', cl.length === n0 + 1 && Math.abs(cl[cl.length - 1][0] - geo.b[0]) <= 1 && Math.abs(cl[cl.length - 1][1] - geo.b[1]) <= 1, JSON.stringify(cl));
    // Right button.
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; ev(TYPE.BUTTON, { ...a, button: 3, down: true }); ev(TYPE.BUTTON, { ...a, button: 3, down: false }); }, { a: at(geo.b) });
    await sleep(300);
    check('right button', (await kpage.evaluate(() => window.E.right)) === 1);
    // Wheel in the scroller.
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; for (let i = 0; i < 6; i++) ev(TYPE.WHEEL, { ...a, dy: 60 }); }, { a: at(geo.s) });
    await sleep(800);
    const wh = await kpage.evaluate(() => [window.E.wheel, document.getElementById('s').scrollTop]);
    check('wheel scrolls the page', wh[1] > 0, JSON.stringify(wh));
    // A <select> pops up its own X window: it has to show and take the keyboard with no window manager.
    const pgeo = await kpage.evaluate(() => { const b = document.getElementById('p').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; ev(TYPE.BUTTON, { ...a, button: 1, down: true }); ev(TYPE.BUTTON, { ...a, button: 1, down: false }); }, { a: at(pgeo) });
    await sleep(500);
    await cp.evaluate(() => { const { ev, TYPE } = window.D; for (const k of [0xff54, 0xff54, 0xff0d]) { ev(TYPE.KEY, { keysym: k, down: true }); ev(TYPE.KEY, { keysym: k, down: false }); } });
    await sleep(500);
    const picked = await kpage.evaluate(() => document.getElementById('p').value);
    check('a <select> popup opens and takes keys', picked === 'three', picked);
    // Moves: newest wins, and a stale seq doesn't apply. Hover the link: cursor shape changes.
    const cur0 = await cp.evaluate(() => window.D.cursors.length);
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; ev(TYPE.MOVE, a); }, { a: at(geo.l) });
    await sleep(500);
    const curs = await cp.evaluate(() => window.D.cursors.map((c) => [c.type, c.hotX, c.hotY, c.w, c.h, c.png]));
    log('cursor messages', JSON.stringify(curs));
    check('CURSOR arrives on keys, with a shape', curs.length > 0 && curs[0][0] === 0x81);
    check('hovering a link changes the shape', curs.length > cur0, `${cur0} -> ${curs.length}`);
    // A held key doesn't repeat by itself (X auto-repeat off); RELEASE_ALL lets go.
    await goto(`${PAGES}/input.html`, 800);
    await cp.evaluate(({ a }) => { const { ev, TYPE } = window.D; ev(TYPE.BUTTON, { ...a, button: 1, down: true }); ev(TYPE.BUTTON, { ...a, button: 1, down: false }); ev(TYPE.KEY, { keysym: 0x7a, down: true }); }, { a: at(geo.t) });
    await sleep(1500);
    const held = await kpage.evaluate(() => document.getElementById('t').value);
    check('a held key does not auto-repeat', held === 'z', held);
    await cp.evaluate(() => { const { ev, TYPE } = window.D; ev(TYPE.RELEASE_ALL); });
    await sleep(200);
    const ups = await kpage.evaluate(() => window.E.keys.filter((k) => k[0] === 'u' && k[1] === 'z').length);
    check('RELEASE_ALL lets go', ups === 1, String(ups));
    const stats = await cp.evaluate(() => window.D.call('test.rtc.stats'));
    out.deskStats = stats;
    check('input events accepted', (stats.sessions.find((s) => s.sessionId === c.opened.sessionId)?.keysDropped || 0) === 0, JSON.stringify(stats.sessions));
  }

  if (phases.includes('latency')) {
    R.latency = await latencyPass('idle', +(args.trials || 60));
  }

  if (phases.includes('latency_load')) {
    R.latency_load = await latencyPass('video playing', +(args.trials || 60), true);
  }

  if (phases.includes('realpage')) {
    // A real site, not a fixture. Pages from AWS addresses can meet bot walls, so a failure here is reported, not fatal.
    try {
      await goto(args.realUrl || 'https://en.wikipedia.org/wiki/World_War_II', 4000);
      await cp.evaluate(() => { const { ev, TYPE } = window.D; let on = true, t0 = performance.now(), last = t0; window.__stopScroll = () => { on = false; };
        const step = (now) => { if (!on) return; const dy = Math.round((now - last) * 1.2) * (((now - t0) % 16000) < 8000 ? 1 : -1); last = now; ev(TYPE.WHEEL, { x: 32768, y: 32768, dy }); requestAnimationFrame(step); }; requestAnimationFrame(step); });
      R.realpage = await segment('real_page_scroll', +(args.scrollSeconds || 60));
      R.realpage.title = await kpage.title();
      await cp.evaluate(() => window.__stopScroll());
    } catch (e) { R.realpage = { error: e.message.slice(0, 200) }; log('real page failed', R.realpage.error); }
  }

  if (phases.includes('scroll')) {
    await goto(`${PAGES}/scroll.html`, 1500);
    // Wheel input at about 1200 px/s, coalesced per frame as the app would (B11's 60 s scroll).
    await cp.evaluate(() => { const { ev, TYPE } = window.D; let on = true, t0 = performance.now(), last = t0; window.__stopScroll = () => { on = false; };
      const step = (now) => { if (!on) return; const dy = Math.round((now - last) * 1.2) * (((now - t0) % 8000) < 4000 ? 1 : -1); last = now; ev(TYPE.WHEEL, { x: 32768, y: 32768, dy }); requestAnimationFrame(step); }; requestAnimationFrame(step); });
    await kpage.evaluate(() => window.__bench.start());
    R.scroll = await segment('scroll', +(args.scrollSeconds || 60));
    R.scroll.kiosk = await kpage.evaluate(() => { const r = window.__bench.stop(); return { raf_fps: r.raf_fps, scroll_change_fps: r.scroll_change_fps, scrolled_px: r.scrolled_px, long_frames_pct: r.long_frames_pct }; });
    log('kiosk during scroll', JSON.stringify(R.scroll.kiosk));
    await cp.evaluate(() => window.__stopScroll());
    await sleep(400);
    R.latency_after_scroll_note = 'see latency';
  }

  if (phases.includes('video')) {
    await goto(`${PAGES}/video.html?fps=60`, 3000);
    await kpage.evaluate(() => window.__bench && window.__bench.start && window.__bench.start()).catch(() => {});
    R.video = await segment('video_1080p60', +(args.videoSeconds || 20));
    R.video.kiosk = await kpage.evaluate(() => window.__bench && window.__bench.stop && window.__bench.stop()).catch(() => null);
  }

  if (phases.includes('idle')) {
    await goto(`${PAGES}/blank.html`, 1500);
    R.idle = await segment('static_page', 10);
  }

  if (phases.includes('audio')) {
    // A real click for Chromium's autoplay rule, then a tone in the kiosk. It has to arrive as sound.
    await goto(`${PAGES}/input.html`, 500);
    await cp.evaluate(() => { const { ev, TYPE } = window.D; ev(TYPE.BUTTON, { x: 32768, y: 32768, button: 1, down: true }); ev(TYPE.BUTTON, { x: 32768, y: 32768, button: 1, down: false }); });
    await sleep(200);
    const s0 = await cstats();
    await kpage.evaluate(() => { window.__ac = new AudioContext(); const o = window.__ac.createOscillator(); o.frequency.value = 440; o.connect(window.__ac.destination); o.start(); return window.__ac.state; });
    await sleep(5000);
    const s1 = await cstats();
    await kpage.evaluate(() => window.__ac.close());
    const a0 = s0.audio || {}, a1 = s1.audio || {};
    R.audio = { kbps: +(((a1.bytes - a0.bytes) * 8) / 5 / 1000).toFixed(1), packets: a1.packetsReceived - a0.packetsReceived, energy: +((a1.energy || 0) - (a0.energy || 0)).toFixed(4),
      concealed: (a1.concealedSamples || 0) - (a0.concealedSamples || 0), samples: (a1.samples || 0) - (a0.samples || 0), jitter_buffer_ms: +(1000 * (a1.jitterBufferDelay - a0.jitterBufferDelay) / Math.max(1, a1.emitted - a0.emitted)).toFixed(1) };
    log('audio', JSON.stringify(R.audio));
    check('audio arrives as sound', R.audio.packets > 100 && R.audio.energy > 0, JSON.stringify(R.audio));
  }

  if (phases.includes('resilience')) {
    await goto(`${PAGES}/scroll.html`, 800);
    await firstFrame();
    const firstNewFrame = () => cp.evaluate(async () => { const { P } = window.D; P.firstAt = null; P.firstAfter = P.frames; const t0 = performance.now(); while (P.firstAt === null && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 5)); P.firstAfter = null; return P.firstAt !== null; });
    // desk-stream dies: systemd restarts it, and desk-rtc resumes it for the viewer still there.
    let t = Date.now();
    await remote('sudo pkill -9 -f /opt/ma/desk-stream/current/desk-stream');
    await sleep(100);
    let ok = await firstNewFrame();
    R.recover_kill_ms = Date.now() - t;
    log('after kill -9 of desk-stream: frames again in', R.recover_kill_ms, 'ms');
    check('frames return after desk-stream dies', ok);
    // Cold start of the encoder with a viewer waiting.
    await remote('sudo systemctl stop desk-stream');
    await sleep(500);
    t = Date.now();
    await remote('sudo systemctl start desk-stream');
    ok = await firstNewFrame();
    R.cold_encoder_ms = Date.now() - t;
    log('desk-stream start to frames, viewer waiting:', R.cold_encoder_ms, 'ms');
    check('frames after a cold desk-stream start', ok);
    const st = await cstats();
    log('after both: keyframes', st.video.keyFramesDecoded, 'freezes', st.video.freezeCount, 'pli', st.video.pliCount);
  }

  if (phases.includes('bulk')) {
    // Design 4.2.6: about 2 Mbps while viewing. Off again when not.
    const rate = (seconds, bytes) => cp.evaluate(async ({ seconds, bytes }) => { const { channels, call } = window.D; let n = 0; const prev = channels.bulk.onmessage; channels.bulk.onmessage = (e) => { n += e.data.byteLength; };
      await call('test.bulk.download', { bytes }); const t0 = performance.now(); await new Promise((r) => setTimeout(r, seconds * 1000)); const mbps = (n * 8) / ((performance.now() - t0) / 1000) / 1e6; channels.bulk.onmessage = prev; return { mbps: +mbps.toFixed(2), bytes: n }; }, { seconds, bytes });
    await goto(`${PAGES}/scroll.html`, 500);
    await firstFrame();
    await sleep(500);
    const viewing = await rate(6, 3_000_000);
    await sleep(8000); // lets that transfer finish
    await cp.evaluate(() => window.D.call('browser.stream.set', { state: 'warm' }));
    await sleep(500);
    const notViewing = await rate(3, 8_000_000);
    await cp.evaluate(() => window.D.call('browser.stream.set', { state: 'live' }));
    R.bulk = { viewing, notViewing };
    log('bulk', JSON.stringify(R.bulk));
    check('bulk capped near 2 Mbps while viewing', viewing.mbps > 1.2 && viewing.mbps < 2.6, `${viewing.mbps} Mbps`);
    check('bulk not capped otherwise', notViewing.mbps > viewing.mbps * 1.5, `${notViewing.mbps} Mbps`);
  }

  if (phases.includes('color')) {
    // The converter and x264's VUI have to agree, or colors shift. Solid patches, read back off decoded frames.
    await goto(`${PAGES}/blank.html`, 500);
    const want = [[51, 102, 153], [200, 30, 30], [30, 200, 30], [30, 30, 200], [128, 128, 128], [245, 240, 225]];
    const got = [];
    for (const c of want) {
      await kpage.evaluate((c) => { document.body.textContent = ''; document.documentElement.style.background = `rgb(${c})`; document.body.style.background = `rgb(${c})`; }, c);
      await sleep(400);
      got.push(await cp.evaluate(() => { const { video } = window.D; const t = document.createElement('canvas'); t.width = t.height = 8; const x = t.getContext('2d'); x.drawImage(video, video.videoWidth / 2 - 4, video.videoHeight / 2 - 4, 8, 8, 0, 0, 8, 8); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); }));
    }
    const worst = Math.max(...want.flatMap((c, i) => c.map((v, j) => Math.abs(v - got[i][j]))));
    R.color = { want, got, worst };
    log('color', JSON.stringify(got), 'worst channel error', worst);
    check('colors come through', worst <= 8, `worst ${worst}`);
  }

  if (phases.includes('warm')) {
    // Warm: session.video off, encoder paused. B13: back to live.
    await goto(`${PAGES}/scroll.html`, 1000);
    const runs = [];
    let warmCpu = null;
    for (let i = 0; i < 10; i++) {
      await cp.evaluate(() => window.D.call('browser.stream.set', { state: 'warm' }));
      if (i === 0) { await sleep(1000); warmCpu = await remoteSample(5); }
      await sleep(600 + Math.random() * 400);
      runs.push(await firstFrame());
      await sleep(400);
    }
    const ms = runs.map((r) => r.firstDisplayMs);
    R.warm = { warm_cpu: warmCpu, first_frame_display_ms: { p50: pct(ms, 50), p95: pct(ms, 95), max: Math.max(...ms) }, first_frame_cb_ms: { p50: pct(runs.map((r) => r.firstCbMs), 50) }, rpc_ms: { p50: pct(runs.map((r) => r.rpcMs), 50) }, runs };
    log('warm', `first frame p50 ${R.warm.first_frame_display_ms.p50} p95 ${R.warm.first_frame_display_ms.p95} max ${R.warm.first_frame_display_ms.max} ms; warm CPU ${warmCpu?.machine_pct}%`, JSON.stringify(warmCpu?.units_pct_of_one_core));
    check('B13: first frame within 300 ms of live, from warm', R.warm.first_frame_display_ms.p95 <= 300, `p95 ${R.warm.first_frame_display_ms.p95}`);
  }

  if (phases.includes('viewers')) {
    // One encode, two sessions: the second gets its own keyframe, and CPU stays with the encoder.
    await goto(`${PAGES}/scroll.html`, 1000);
    const c2 = await openClient();
    const t = await c2.page.evaluate(async () => { const { P, call } = window.D; const t0 = performance.now(); P.firstAt = null; P.firstAfter = P.frames; await call('browser.stream.set', { state: 'live' }); while (P.firstAt === null && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 2)); return P.firstAt ? P.firstAt.now - t0 : null; });
    await sleep(1000);
    const seg = await segment('two_viewers', 10);
    const s2 = await c2.page.evaluate(() => window.D.stats());
    await c2.page.evaluate(() => window.D.call('browser.stream.set', { state: 'off' }));
    await c2.page.close();
    R.viewers = { second_first_frame_ms: t, first: seg, second_decoded: s2.video.framesDecoded };
    check('second viewer decodes', s2.video.framesDecoded > 100, `${s2.video.framesDecoded}`);
  }
} catch (e) {
  out.failures.push('fatal: ' + e.message);
  log('FATAL', e.stack);
  log(c.lines.join('\n'));
} finally {
  out.phases = R;
  writeFileSync(args.out || 'result.json', JSON.stringify(out, null, 2));
  await cp.evaluate(() => window.D?.call('browser.stream.set', { state: 'off' })).catch(() => {});
  await browser.close();
  await kiosk.close().catch(() => {});
  pageServer.close();
}
log(out.failures.length ? `FAILED ${out.failures.length}:\n  ${out.failures.join('\n  ')}` : 'All checks passed.');
process.exit(out.failures.length ? 1 : 0);
