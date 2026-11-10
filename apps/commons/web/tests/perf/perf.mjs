// Commons performance, in headless Chromium against the stand-in server:
//   1. panning and zooming a heavy board (2,000 strokes, 100 notes, 100 rectangles): frame pacing;
//   2. drawing on it: pointer event to the frame that shows it, and frame pacing;
//   3. a stroke from one member to another's screen: sent to the frame that draws it;
//   4. voice from one member to another: a tone's start to its arrival in the other's audio graph;
//   5. joining: the click to voice connected.
// Writes tests/perf/results/<time>.json and prints a summary. Indicative only: software
// compositing, no real audio devices, everything on one machine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { join, launch, member, startServer } from './harness.mjs';

const results = {};
const server = await startServer((process.env.PERF_SERVER_ARGS ?? '').split(' ').filter(Boolean));
const browser = await launch();
const pct = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null;
};
const frames = (iv) => ({
  fps: Math.round(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)),
  missedPct: Math.round((iv.filter((d) => d > 1000 / 60 * 1.5).length / iv.length) * 1000) / 10,
  worstMs: Math.round(Math.max(...iv) * 10) / 10,
});

try {
  // A speaks with a tone we control; B and C use Chromium's fake microphone.
  const a = await member(browser, 'Ana', { query: '&frame=0' });
  await a.page.evaluate(() => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.frequency.value = 1000;
    osc.connect(gain);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    osc.start();
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    window.__beep = () => {
      const at = ctx.currentTime + 0.05;
      gain.gain.setValueAtTime(0.8, at);
      gain.gain.setValueAtTime(0, at + 0.12);
      return performance.timeOrigin + performance.now() + 50;
    };
    window.__actx = ctx;
  });
  const b = await member(browser, 'Ben', { query: '&frame=0' });

  // 5. Joining.
  const joins = [];
  for (const m of [a, b]) {
    const t0 = Date.now();
    await join(m);
    await m.page.waitForFunction(() => window.commons.client.state.voice === 'on', null, { timeout: 15000 });
    joins.push(Date.now() - t0);
  }
  results.joinToVoiceMs = joins;

  // 1. A heavy board, then pan and zoom it with the wheel at 60 events a second.
  await a.page.evaluate(() => window.commons.engine.fixture(2000));
  await b.page.waitForFunction(() => window.commons.engine.itemCount >= 2200, null, { timeout: 20000 });
  results.items = await b.page.evaluate(() => window.commons.engine.itemCount);
  const bx = (await b.page.locator('.ma-cm-board').boundingBox()).x; // the channel list sits left of the board
  await b.page.mouse.move(bx + 340, 400);
  const pan = await b.page.evaluate(async () => {
    const iv = [];
    let last = performance.now();
    let run = true;
    const loop = (t) => {
      iv.push(t - last);
      last = t;
      if (run) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const long = [];
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)));
    po.observe({ type: 'longtask', buffered: false });
    const el = document.querySelector('.ma-cm-over');
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 180; i++) {
      const zoom = i % 60 > 40;
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: zoom ? 0 : Math.sin(i / 20) * 24, deltaY: zoom ? (i % 120 > 60 ? 8 : -8) : 14, ctrlKey: zoom, clientX: r.left + 340, clientY: r.top + 400, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 1000 / 60));
    }
    run = false;
    po.disconnect();
    return { iv: iv.slice(2), long };
  });
  results.panZoom = { ...frames(pan.iv), longTasks: pan.long.length };
  await b.page.evaluate(() => window.commons.engine.fit());

  // 2. Drawing on the heavy board: real input through CDP, 60 moves a second.
  await b.page.keyboard.press('p');
  await b.page.evaluate(() => {
    window.__lat = [];
    window.__iv = [];
    const el = document.querySelector('.ma-cm-over');
    el.addEventListener('pointermove', (e) => {
      const ts = e.timeStamp;
      requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - ts), 0));
    });
    let last = performance.now();
    window.__run = true;
    const loop = (t) => {
      window.__iv.push(t - last);
      last = t;
      if (window.__run) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await b.page.mouse.move(bx + 80, 300);
  await b.page.mouse.down();
  for (let i = 0; i < 180; i++) {
    await b.page.mouse.move(bx + 80 + i * 3, 300 + Math.sin(i / 10) * 120);
    await b.page.waitForTimeout(1000 / 60);
  }
  await b.page.mouse.up();
  const draw = await b.page.evaluate(() => {
    window.__run = false;
    return { lat: window.__lat, iv: window.__iv.slice(2) };
  });
  results.drawLocal = { inputToFrameMs: { p50: pct(draw.lat, 0.5), p95: pct(draw.lat, 0.95), max: pct(draw.lat, 1) }, ...frames(draw.iv) };

  // 3. A stroke from B to A: B's send to A's frame that draws it, matched by message order.
  await a.page.evaluate(() => {
    window.__recv = [];
    window.commons.client.onLiveMsg((_m, msg) => {
      if (msg.kind !== 1) return;
      requestAnimationFrame(() => window.__recv.push(performance.timeOrigin + performance.now()));
    });
  });
  await b.page.evaluate(() => {
    window.__sent = [];
    const c = window.commons.client;
    const orig = c.sendLive.bind(c);
    c.sendLive = (m) => {
      if (m.kind === 1) window.__sent.push(performance.timeOrigin + performance.now());
      orig(m);
    };
  });
  await b.page.mouse.move(bx + 80, 500);
  await b.page.mouse.down();
  for (let i = 0; i < 120; i++) {
    await b.page.mouse.move(bx + 80 + i * 4.5, 500 + Math.cos(i / 8) * 60);
    await b.page.waitForTimeout(1000 / 60);
  }
  await b.page.mouse.up();
  await a.page.waitForTimeout(500);
  const sent = await b.page.evaluate(() => window.__sent);
  const recv = await a.page.evaluate(() => window.__recv);
  const remote = [];
  for (let i = 0; i < Math.min(sent.length, recv.length); i++) remote.push(recv[i] - sent[i]);
  results.drawRemote = { messages: [sent.length, recv.length], sendToFrameMs: { p50: pct(remote, 0.5), p95: pct(remote, 0.95), max: pct(remote, 1) } };

  // 4. Voice: 10 tones from A, detected in B's audio graph on A's slot.
  await b.page.evaluate(async () => {
    const c = window.commons.client;
    const ana = c.state.members.find((m) => m.name === 'Ana').i;
    const v = c.voiceDebug;
    const slot = v.slots.indexOf(ana);
    const track = v.trackFor(slot);
    const ctx = new AudioContext();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const sp = ctx.createScriptProcessor(256, 1, 1);
    window.__onsets = [];
    let armed = true;
    let quiet = 0;
    sp.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let peak = 0;
      let first = -1;
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
        if (first < 0 && v > 0.2) first = i;
      }
      if (armed && first >= 0) {
        const ts = ctx.getOutputTimestamp();
        const t = e.playbackTime - (d.length - first) / ctx.sampleRate;
        window.__onsets.push(performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000);
        armed = false;
        quiet = 0;
      } else if (!armed) {
        quiet = peak < 0.05 ? quiet + 1 : 0;
        if (quiet > 40) armed = true;
      }
    };
    src.connect(sp);
    sp.connect(ctx.destination);
    window.__slot = slot;
  });
  const beeps = [];
  for (let i = 0; i < 10; i++) {
    beeps.push(await a.page.evaluate(() => window.__beep()));
    await a.page.waitForTimeout(800);
  }
  const onsets = await b.page.evaluate(() => window.__onsets);
  const vlat = [];
  for (const t of beeps) {
    const o = onsets.find((x) => x >= t - 5 && x < t + 600);
    if (o) vlat.push(o - t);
  }
  const jb = await b.page.evaluate(async () => (await window.commons.client.voiceDebug.stats()).find((s) => s.packets > 0)?.jitterBufferMs);
  results.voice = { tones: beeps.length, heard: vlat.length, toneToGraphMs: { p50: pct(vlat, 0.5), min: pct(vlat, 0), max: pct(vlat, 1) }, jitterBufferMs: Math.round((jb ?? 0) * 10) / 10 };
  // The same tones over a plain WebRTC call inside A's page, with no server: the browser's own
  // share of the time (capture, 20 ms Opus frames, jitter buffer, playout, this detector).
  const base = await a.page.evaluate(async () => {
    const ctx = window.__actx;
    const tone = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    pc1.addTrack(tone.getAudioTracks()[0], tone);
    const got = new Promise((res) => (pc2.ontrack = (e) => res(e.track)));
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    const track = await got;
    const el = new Audio();
    el.srcObject = new MediaStream([track]);
    el.muted = true;
    void el.play();
    const dctx = new AudioContext();
    await dctx.resume();
    const src = dctx.createMediaStreamSource(new MediaStream([track]));
    const sp = dctx.createScriptProcessor(256, 1, 1);
    const onsets = [];
    let armed = true;
    let quiet = 0;
    sp.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let peak = 0;
      let first = -1;
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
        if (first < 0 && v > 0.2) first = i;
      }
      if (armed && first >= 0) {
        const ts = dctx.getOutputTimestamp();
        const t = e.playbackTime - (d.length - first) / dctx.sampleRate;
        onsets.push(performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000);
        armed = false;
        quiet = 0;
      } else if (!armed) {
        quiet = peak < 0.05 ? quiet + 1 : 0;
        if (quiet > 40) armed = true;
      }
    };
    src.connect(sp);
    sp.connect(dctx.destination);
    await new Promise((r) => setTimeout(r, 1500));
    const beeps = [];
    for (let i = 0; i < 10; i++) {
      beeps.push(window.__beep());
      await new Promise((r) => setTimeout(r, 800));
    }
    pc1.close();
    pc2.close();
    void ctx;
    return beeps.map((t) => onsets.find((x) => x >= t - 5 && x < t + 600)).map((o, i) => (o ? o - beeps[i] : null)).filter((x) => x !== null);
  });
  results.voice.directCallMs = { heard: base.length, p50: pct(base, 0.5), min: pct(base, 0), max: pct(base, 1) };
  results.rtt = await a.page.evaluate(() => {
    const r = window.commons.client.rtts;
    return r.length ? Math.round(r.reduce((x, y) => x + y, 0) / r.length * 10) / 10 : null;
  });
} finally {
  await browser.close();
  await server.stop();
}
const out = resolve(import.meta.dirname, 'results');
mkdirSync(out, { recursive: true });
const file = resolve(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
