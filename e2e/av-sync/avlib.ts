// Helpers for av-sync.spec.ts: the sync page and clip on the desk, the desk-side sampler, the probe in the client page, the
// workstation's clock against the desk's, and the arithmetic. Test only. No secret is ever printed.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { deskRun } from '../tests/streamlib';

export const PORT = 18768; // stream.spec.ts has 18765, browser-session.spec.ts 18766, the W3 kit 18767
export const DIR = '/var/tmp/ma-avsync'; // not /tmp, which can be a tmpfs
const PAGES_UNIT = 'ma-avsync-pages';
const SAMPLER_UNIT = 'ma-avsync-sampler';
export const pageUrl = (path: string) => `http://127.0.0.1:${PORT}/${path}`;

/** Where the probes look, in screen pixels of the 1920x1080 desk. The clip is 1280x720, stretched to fill the screen. */
export const SPOT = { flash: { x: 956, y: 536 }, square: { x: 1756, y: 916 }, bitsY: 60, bitX: (i: number) => 60 + 72 * i };

/**
 * The page the desk's Chromium shows: the clip filling the screen, looping, with sound once a click has started it (the kiosk has
 * no autoplay flag, and a member's click is what starts a video too). A keydown flips a square in the bottom-right corner, for
 * input-to-screen while the clip plays. It publishes its rAF count and the video's own counters in its title, as `S{...}`.
 */
const SYNC_HTML = `<!doctype html><meta charset="utf-8"><title>sync</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}
video{position:fixed;left:0;top:0;width:100vw;height:100vh;object-fit:fill}
#sq{position:fixed;left:1640px;top:800px;width:240px;height:240px;background:#000}</style>
<body><video id="v" src="sync.webm" loop playsinline preload="auto"></video><div id="sq"></div>
<script>
const q = new URLSearchParams(location.search), v = document.getElementById('v'), sq = document.getElementById('sq');
const s = { n: q.get('n') || '', vis: document.visibilityState, f: 0, t: 0, play: 0, ct: 0, dropped: 0, total: 0, kd: 0, lf: 0, err: '' };
let white = false, last = null;
const pub = () => { s.vis = document.visibilityState; s.t = Math.round(performance.now()); document.title = 'S' + JSON.stringify(s).replaceAll('"', '~'); };
requestAnimationFrame(function loop(t) { if (last !== null && t - last > 25) s.lf++; last = t; s.f++; requestAnimationFrame(loop); });
const start = () => v.play().then(() => { s.play = 1; pub(); }, (e) => { s.err = String(e).slice(0, 60); pub(); });
addEventListener('click', start, true);
addEventListener('keydown', (e) => {
  e.preventDefault();
  if (e.key === 'p') { if (v.paused) start(); else { v.pause(); s.play = 0; pub(); } return; }
  white = !white; s.kd++; sq.style.background = white ? '#fff' : '#000';
}, true);
setInterval(() => { const pq = v.getVideoPlaybackQuality(); s.dropped = pq.droppedVideoFrames; s.total = pq.totalVideoFrames; s.ct = Math.round(v.currentTime * 1000); s.play = v.paused ? 0 : 1; pub(); }, 500);
start();
pub();
</script></body>`;

/** SSM's command parameters have a size limit, so the clip goes over in pieces, four at a time. */
const PIECE = 40_000;

export async function deployAv(clipPath: string, samplerPath: string): Promise<{ clipBytes: number; pieces: number }> {
  const clip = readFileSync(clipPath).toString('base64');
  const files: Record<string, string> = { 'sync.html': Buffer.from(SYNC_HTML).toString('base64'), 'sampler.py': readFileSync(samplerPath).toString('base64') };
  await deskRun(`set -e
systemctl stop ${PAGES_UNIT} ${SAMPLER_UNIT} 2>/dev/null || true
systemctl reset-failed ${PAGES_UNIT} ${SAMPLER_UNIT} 2>/dev/null || true
rm -rf ${DIR}; install -d -m 755 ${DIR} ${DIR}/www ${DIR}/parts; install -d -m 755 -o stream -g stream ${DIR}/out
${Object.entries(files).map(([n, b]) => `echo ${b} | base64 -d > ${DIR}/${n === 'sampler.py' ? n : `www/${n}`}`).join('\n')}
echo ok`);
  const pieces: string[] = [];
  for (let i = 0; i < clip.length; i += PIECE) pieces.push(clip.slice(i, i + PIECE));
  for (let i = 0; i < pieces.length; i += 4) {
    await Promise.all(pieces.slice(i, i + 4).map((p, j) => deskRun(`printf %s '${p}' > ${DIR}/parts/${String(i + j).padStart(4, '0')}`)));
  }
  const out = await deskRun(`set -e
cat ${DIR}/parts/* | base64 -d > ${DIR}/www/sync.webm; rm -rf ${DIR}/parts
chmod 644 ${DIR}/www/* ${DIR}/sampler.py
systemd-run --quiet --collect --unit=${PAGES_UNIT} --uid=65534 --gid=65534 -p RuntimeMaxSec=3600 /usr/bin/python3 -I -m http.server ${PORT} --bind 127.0.0.1 --directory ${DIR}/www
sleep 1
echo "BYTES=$(stat -c %s ${DIR}/www/sync.webm)"
curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' ${pageUrl('sync.webm')}`);
  const bytes = Number(/BYTES=(\d+)/.exec(out)?.[1] ?? 0);
  if (!out.includes('HTTP=200') || bytes !== readFileSync(clipPath).length) throw new Error(`the clip didn't arrive whole on the desk: ${out.slice(0, 200)}`);
  return { clipBytes: bytes, pieces: pieces.length };
}

export async function removeAv(): Promise<string> {
  return deskRun(`systemctl stop ${PAGES_UNIT} ${SAMPLER_UNIT} 2>/dev/null || true; systemctl reset-failed ${PAGES_UNIT} ${SAMPLER_UNIT} 2>/dev/null || true; rm -rf ${DIR}; echo removed`);
}

/** Starts the desk-side sampler as `stream` for `seconds`, in a unit that can't outlive 10 minutes. */
export async function startSampler(seconds: number): Promise<void> {
  await deskRun(`set -e
systemctl stop ${SAMPLER_UNIT} 2>/dev/null || true; systemctl reset-failed ${SAMPLER_UNIT} 2>/dev/null || true
rm -f ${DIR}/out/sampler.json; [ -e /usr/local/lib/ma/gst-registry.bin ] && install -m 644 -o stream -g stream /usr/local/lib/ma/gst-registry.bin ${DIR}/out/registry.bin || true
systemd-run --quiet --collect --unit=${SAMPLER_UNIT} --uid=stream --gid=stream -p RuntimeMaxSec=600 -p CPUWeight=50 \\
  --setenv=DISPLAY=:99 --setenv=PULSE_SERVER=unix:/run/desk-audio/native --setenv=HOME=${DIR}/out --setenv=GST_REGISTRY_1_0=${DIR}/out/registry.bin \\
  --setenv=GST_PLUGIN_PATH=/usr/local/lib/ma/gst-plugins \\
  /usr/bin/python3 -I ${DIR}/sampler.py ${seconds} ${DIR}/out/sampler.json ${SPOT.flash.x} ${SPOT.flash.y}
echo started`);
}

export interface SamplerOut { flashOn: number[]; flashOff: number[]; beeps: number[]; videoSamples: number; audioBuffers: number; pollMs: { p50: number; p99: number; max: number } | null; error?: string }
export async function readSampler(waitS: number): Promise<SamplerOut | { error: string; journal?: string }> {
  const out = await deskRun(`for i in $(seq 1 ${waitS}); do [ -s ${DIR}/out/sampler.json ] && break; sleep 1; done; if [ -s ${DIR}/out/sampler.json ]; then echo "J$(cat ${DIR}/out/sampler.json)"; else journalctl -u ${SAMPLER_UNIT} --no-pager -n 15 | cut -c1-200; fi`, waitS + 30);
  const line = out.split('\n').find((l) => l.startsWith('J'));
  if (!line) return { error: 'no sampler output', journal: out.slice(-1500) };
  return JSON.parse(line.slice(1));
}

/** The desk's clock against true time, from chrony. Positive means the desk's clock is ahead. */
export async function deskClock(): Promise<{ aheadMs: number | null; raw: string }> {
  const raw = await deskRun(`chronyc tracking 2>/dev/null | grep -E '^(Reference ID|System time|Root delay|Root dispersion|Leap status)'`);
  const m = /System time\s*:\s*([\d.]+) seconds (fast|slow)/.exec(raw);
  return { aheadMs: m ? +(Number(m[1]) * 1000 * (m[2] === 'fast' ? 1 : -1)).toFixed(3) : null, raw: raw.trim() };
}

/**
 * The workstation's clock against true time, by SNTP: of `n` exchanges, the one with the least round trip, whose error is at
 * most half that round trip. Positive means this clock is ahead.
 */
export async function localClock(host = 'time.cloudflare.com', n = 12): Promise<{ aheadMs: number; delayMs: number; host: string } | { error: string }> {
  const one = () => new Promise<{ offset: number; delay: number }>((resolve, reject) => {
    const s = createSocket('udp4');
    const pkt = Buffer.alloc(48); pkt[0] = 0x23;
    const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 2000);
    const t1 = performance.timeOrigin + performance.now();
    s.on('message', (d) => {
      const t4 = performance.timeOrigin + performance.now();
      clearTimeout(timer); s.close();
      const ts = (o: number) => (d.readUInt32BE(o) - 2208988800) * 1000 + (d.readUInt32BE(o + 4) / 2 ** 32) * 1000;
      const t2 = ts(32), t3 = ts(40);
      resolve({ offset: ((t2 - t1) + (t3 - t4)) / 2, delay: (t4 - t1) - (t3 - t2) });
    });
    s.send(pkt, 123, host);
  });
  const got: { offset: number; delay: number }[] = [];
  for (let i = 0; i < n; i++) { try { got.push(await one()); } catch { /* lost */ } await new Promise((r) => setTimeout(r, 150)); }
  if (!got.length) return { error: `no SNTP answer from ${host}` };
  got.sort((a, b) => a.delay - b.delay);
  // performance.timeOrigin + now() follows the wall clock this process started with; the offset of true time from that is -offset.
  return { aheadMs: +(-got[0].offset).toFixed(2), delayMs: +got[0].delay.toFixed(2), host };
}

// ---- The probe, in the client page ----
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Wraps RTCPeerConnection before any page code runs, so the probe can find the session's connection. */
export const capturePcs = () => {
  const w = window as any;
  if (w.__pcs) return;
  const pcs: RTCPeerConnection[] = [];
  w.__pcs = pcs;
  const Orig = w.RTCPeerConnection;
  w.__dcs = {};
  w.RTCPeerConnection = class extends Orig {
    constructor(...a: unknown[]) { super(...a); pcs.push(this as unknown as RTCPeerConnection); }
    createDataChannel(label: string, init?: RTCDataChannelInit) { const dc = super.createDataChannel(label, init); w.__dcs[label] = dc; return dc; }
  };
};

export const installProbe = async (spot: { flash: { x: number; y: number }; square: { x: number; y: number }; bitsY: number; bitXs: number[] }) => {
  const w = window as any;
  if (w.AV) return w.AV.info();
  const video = document.querySelector('video') as HTMLVideoElement;
  const pc = (w.__pcs as RTCPeerConnection[]).filter((p) => p.connectionState === 'connected').pop()!;
  const rec = { on: false };
  const frames: any[] = [];
  const beeps: any[] = [];
  const ticks: any[] = [];
  const lat: any[] = [];
  let arm: { t0: number; white: boolean } | null = null, armed = false, lastSq = 0;

  // Per decoded frame: the white box's luminance, the counter's bits and the corner square, from one small canvas.
  const cv = document.createElement('canvas'); cv.width = 820; cv.height = 10;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  const onFrame = (now: number, m: any) => {
    const sx = video.videoWidth / 1920, sy = video.videoHeight / 1080;
    if (sx > 0) {
      cx.drawImage(video, 0, (spot.bitsY - 5) * sy, 760 * sx, 10 * sy, 0, 0, 760, 10);
      cx.drawImage(video, spot.flash.x * sx, spot.flash.y * sy, 8 * sx, 8 * sy, 770, 0, 8, 8);
      cx.drawImage(video, spot.square.x * sx, spot.square.y * sy, 8 * sx, 8 * sy, 790, 0, 8, 8);
      const d = cx.getImageData(0, 0, 820, 10).data;
      const g = (x: number, y: number) => d[(y * 820 + x) * 4 + 1];
      let ctr = 0; spot.bitXs.forEach((bx, i) => { if (g(bx, 5) > 128) ctr |= 1 << i; });
      let lum = 0, sq = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { lum += g(770 + x, y); sq += g(790 + x, y); }
      lum /= 64; sq /= 64;
      if (rec.on) frames.push({ now: +now.toFixed(2), edt: +m.expectedDisplayTime.toFixed(2), rt: m.receiveTime ?? null, ct: m.captureTime ?? null, rtp: m.rtpTimestamp ?? null, pf: m.presentedFrames, lum: Math.round(lum), ctr });
      if (arm && (sq > 128) === arm.white) { lat.push({ cb: now - arm.t0, display: m.expectedDisplayTime - arm.t0, recv: m.receiveTime ? m.receiveTime - arm.t0 : null }); arm = null; }
      lastSq = sq;
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  // The stamp for input-to-screen, taken in a keydown listener as the existing probe does. installClient's listener sends the KEY.
  addEventListener('keydown', () => { if (armed) { arm = { t0: performance.now(), white: !(lastSq > 128) }; armed = false; } }, true);

  // The tone's onset on the received track, sample-exact, in an AudioWorklet. Its context time maps to performance.now() through
  // getOutputTimestamp, so `heard` is when the output device plays that sample, and `seen` is when the worklet saw it.
  const actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const code = `class O extends AudioWorkletProcessor { constructor(){ super(); this.q = 0; }
    process(inputs) { const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
      for (let i = 0; i < ch.length; i++) { const x = ch[i] < 0 ? -ch[i] : ch[i];
        if (x > 0.05) { if (this.q > 0.3 * sampleRate) this.port.postMessage({ t: currentTime + i / sampleRate, x }); this.q = 0; } else this.q++; }
      return true; } }
    registerProcessor('onset', O);`;
  await actx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  await actx.resume();
  const audioTrack = pc.getReceivers().find((r) => r.track?.kind === 'audio')!.track;
  const src = new MediaStreamAudioSourceNode(actx, { mediaStream: new MediaStream([audioTrack]) });
  const node = new AudioWorkletNode(actx, 'onset');
  src.connect(node).connect(new GainNode(actx, { gain: 0 })).connect(actx.destination);
  node.port.onmessage = (e) => {
    if (!rec.on) return;
    const ts = actx.getOutputTimestamp();
    beeps.push({ heard: +(ts.performanceTime! + (e.data.t - ts.contextTime!) * 1000).toFixed(2), seen: +performance.now().toFixed(2), x: +e.data.x.toFixed(3) });
  };

  // getStats every 250 ms while recording: jitter buffers, playout, sender reports, the estimated playout NTP time of each track.
  const pick = (r: any, keys: string[]) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  const tick = async () => {
    const s = await pc.getStats();
    const t: any = { t: +performance.now().toFixed(1), wallMinusPerf: Date.now() - performance.now() };
    s.forEach((r: any) => {
      if (r.type === 'inbound-rtp') t[r.kind] = pick(r, ['jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount', 'estimatedPlayoutTimestamp', 'totalProcessingDelay', 'framesDecoded', 'framesReceived', 'framesDropped', 'totalDecodeTime', 'totalAssemblyTime', 'packetsReceived', 'packetsLost', 'nackCount', 'freezeCount', 'totalSamplesReceived', 'concealedSamples', 'playoutId', 'lastPacketReceivedTimestamp', 'framesPerSecond', 'jitter']);
      if (r.type === 'media-playout') t.playout = pick(r, ['totalPlayoutDelay', 'totalSamplesCount', 'synthesizedSamplesDuration', 'synthesizedSamplesEvents']);
      if (r.type === 'remote-outbound-rtp') t[`sr_${r.kind}`] = { ...pick(r, ['remoteTimestamp', 'reportsSent', 'roundTripTime']), at: r.timestamp };
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') t.rtt = r.currentRoundTripTime;
    });
    if (rec.on) ticks.push(t);
  };
  setInterval(() => { void tick(); }, 250);

  const info = () => ({ sampleRate: actx.sampleRate, baseLatency: actx.baseLatency, outputLatency: (actx as any).outputLatency, state: actx.state, remoteSdpMsid: (pc.remoteDescription?.sdp ?? '').split(/\r?\n/).filter((l) => /^a=(msid|ssrc:\d+ msid)/.test(l)) });
  w.AV = {
    info,
    start: () => { frames.length = 0; beeps.length = 0; ticks.length = 0; rec.on = true; return performance.now(); },
    stop: () => { rec.on = false; return performance.now(); },
    take: () => ({ frames, beeps, ticks, wallMinusPerf: Date.now() - performance.now(), info: info() }),
    arm: () => { armed = true; }, disarm: () => { arm = null; armed = false; }, lat: () => lat, latCount: () => lat.length, clearLat: () => { lat.length = 0; arm = null; armed = false; },
  };
  return info();
};
/**
 * The Desk app's picture hold (`web/src/desk/rtc/pictureHold.ts`), run in the probe page exactly as `peer.ts` runs it: the class
 * itself comes in as source, so this measures the app's own rule. Each keydown lets go, as any input does in the app.
 */
export const installHold = (src: { cls: string; hold: string }) => {
  const w = window as any;
  if (w.HOLDER) return;
  // eslint-disable-next-line no-new-func
  const PictureHold = new Function('HOLD', `return (${src.cls});`)(JSON.parse(src.hold));
  const h = new PictureHold();
  const pc = (w.__pcs as RTCPeerConnection[]).filter((p) => p.connectionState === 'connected').pop()!;
  const audio = pc.getReceivers().find((r) => r.track?.kind === 'audio')!;
  const keys = w.__dcs.keys as RTCDataChannel;
  const log: { t: number; target: number; why: string }[] = [];
  // As peer.ts: a HOLD event on keys (type 6, the ms at byte 12), which desk-rtc turns into this session's playout-delay.
  const set = (ms: number, why: string) => {
    const b = new ArrayBuffer(16), v = new DataView(b);
    v.setUint8(0, 6); v.setUint16(12, Math.max(0, Math.min(65535, Math.round(ms))));
    if (keys.readyState === 'open') keys.send(b);
    log.push({ t: +performance.now().toFixed(1), target: ms, why });
  };
  addEventListener('keydown', () => { if (h.input(performance.now())) set(0, 'input'); }, true);
  setInterval(async () => {
    const stats = await audio.getStats();
    let a: any;
    stats.forEach((x: any) => { if (x.type === 'inbound-rtp') a = x; });
    if (!a) return;
    const playout: any = a.playoutId ? stats.get(a.playoutId) : undefined;
    const next = h.sample({ at: performance.now(), packetsReceived: a.packetsReceived ?? 0, jitterBufferDelay: a.jitterBufferDelay ?? 0, jitterBufferEmittedCount: a.jitterBufferEmittedCount ?? 0,
      totalAudioEnergy: a.totalAudioEnergy, totalSamplesDuration: a.totalSamplesDuration, totalPlayoutDelay: playout?.totalPlayoutDelay, totalSamplesCount: playout?.totalSamplesCount });
    if (next !== null) set(next, 'sample');
  }, 500);
  w.HOLDER = { target: () => h.target, log: () => log };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- Arithmetic ----
export const pct = (xs: number[], p: number): number | null => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const k = ((s.length - 1) * p) / 100, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
  return +(s[f] + (s[c] - s[f]) * (k - f)).toFixed(1);
};
export const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p5: pct(xs, 5), min: pct(xs, 0), max: pct(xs, 100) });

export interface Frame { now: number; edt: number; rt: number | null; ct: number | null; rtp: number | null; pf: number; lum: number; ctr: number }
/** Times (performance.now) of the frames where the white box first shows. */
export const flashOnsets = (frames: Frame[]) => frames.filter((f, i) => i > 0 && f.lum > 128 && frames[i - 1].lum <= 128);

/** Pairs each `a` with the nearest `b` within `windowMs`, returning b - a. */
export function pairs(a: number[], b: number[], windowMs: number, lo = -Infinity): number[] {
  const out: number[] = [];
  for (const x of a) {
    let best: number | null = null;
    for (const y of b) { const d = y - x; if (d >= lo && Math.abs(d) <= windowMs && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
    if (best !== null) out.push(+best.toFixed(2));
  }
  return out;
}

/** The counter on each decoded frame should step by one (the clip loops at 600): anything else is a frame the client never got. */
export function counterSteps(frames: Frame[]) {
  let skipped = 0, repeated = 0, jumps = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = (frames[i].ctr - frames[i - 1].ctr + 600) % 600;
    if (d === 1) continue;
    if (d === 0) repeated++;
    else if (d < 30) skipped += d - 1;
    else jumps++;
  }
  return { frames: frames.length, skipped, repeated, jumps };
}
