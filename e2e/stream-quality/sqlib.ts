// Helpers for stream-quality.spec.ts (task 29, ADR 0039): the pages and clip on the desk, the test-only QUALITY injection in
// the client page, the getStats sampler, and the arithmetic. Test only. No secret, SDP, candidate or address is ever recorded.
import { readFileSync } from 'node:fs';
import { deskRun, pct } from '../tests/streamlib';
import type { DeskClient, Tab } from '../tests/streamlib';

export const PORT = 18769; // stream.spec.ts 18765, browser-session.spec.ts 18766, the W3 kit 18767, av-sync 18768
export const DIR = '/var/tmp/ma-sq'; // not /tmp, which can be a tmpfs
const PAGES_UNIT = 'ma-sq-pages';
export const pageUrl = (path: string) => `http://127.0.0.1:${PORT}/${path}`;

/** Level numbers on the wire (stream-quality.md section 1). */
export const LEVEL = { low: 1, medium: 2, high: 3, max: 4 } as const;
export type LevelName = keyof typeof LEVEL;

// ---- Pages on the desk. Each publishes what it saw in its title (read back through deskd's browser.tab.list), and none draws a
// visible counter, so a still page is really still. The rAF counter is stream.spec.ts' (bench.js'): frames, and frames over 25 ms.
const RAF = `const q = new URLSearchParams(location.search);
const S = { n: q.get('n') || '', f: 0, lf: 0, t: 0, sf: 0, px: 0, y: 0, kd: 0, vis: '' };
let last = null, y0 = scrollY;
requestAnimationFrame(function loop(t) { if (last !== null && t - last > 25) S.lf++; last = t; S.f++; const y = scrollY; if (y !== y0) { S.sf++; S.px += Math.abs(y - y0); y0 = y; } requestAnimationFrame(loop); });`;
const PUB = (tag: string) => `const pub = () => { S.t = Math.round(performance.now()); S.y = Math.round(scrollY); S.vis = document.visibilityState; document.title = '${tag}' + JSON.stringify(S).replaceAll('"', '~'); };
setInterval(pub, 1000); pub();`;

/**
 * The clip filling the screen, looping. It starts with sound if the autoplay policy lets it, else muted; a click (a member's
 * gesture) starts it with sound. It adds the video's own counters to the title: playing, muted, dropped and total frames.
 */
const VIDEO_HTML = `<!doctype html><meta charset="utf-8"><title>video</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}video{position:fixed;left:0;top:0;width:100vw;height:100vh;object-fit:fill}</style>
<body><video id="v" src="clip.webm" loop playsinline preload="auto"></video>
<script>${RAF}
const v = document.getElementById('v');
Object.assign(S, { play: 0, muted: 0, dropped: 0, total: 0, ct: 0, err: '' });
${PUB('V')}
const start = (withSound) => { v.muted = !withSound; return v.play().then(() => { S.play = 1; S.muted = v.muted ? 1 : 0; pub(); }, (e) => { S.err = String(e).slice(0, 60); if (withSound) return start(false); pub(); }); };
addEventListener('click', () => start(true), true);
setInterval(() => { const p = v.getVideoPlaybackQuality(); S.dropped = p.droppedVideoFrames; S.total = p.totalVideoFrames; S.ct = Math.round(v.currentTime * 1000); S.play = v.paused ? 0 : 1; S.muted = v.muted ? 1 : 0; }, 500);
start(true);
</script></body>`;

// The document of stream.spec.ts' scroll.html (real-stack/pages/scroll.html), without the visible fps counter. Scrolled, it's the
// scrolling phase; left alone afterwards, it's the still page.
const SCROLL_HTML = `<!doctype html><meta charset="utf-8"><title>scroll</title>
<style>body{margin:0 auto;max-width:1100px;font:18px/1.6 Georgia,serif;color:#222;background:#fafafa;padding:20px}
h2{font:bold 28px sans-serif;margin:40px 0 10px}.card{display:flex;gap:16px;margin:16px 0;padding:16px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.img{flex:0 0 260px;height:160px;border-radius:8px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:4px 8px;font:14px sans-serif}</style>
<body><h1>Scroll benchmark page</h1><div id="c"></div>
<script>${RAF}
${PUB('R')}
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

// stream.spec.ts' latency.html: an 800x800 square in the middle that a keydown flips, for its test 6 method. ?load=1 adds its
// animated 520x292 canvas.
const LATENCY_HTML = `<!doctype html><meta charset="utf-8"><title>latency</title>
<style>html,body{margin:0;height:100%;background:#808080;overflow:hidden}
#sq{position:absolute;left:50%;top:50%;width:800px;height:800px;margin:-400px 0 0 -400px;background:#000}
#v{position:absolute;left:0;top:0;width:520px;height:292px}</style>
<body><div id="sq"></div><canvas id="v" width="520" height="292" style="display:none"></canvas>
<script>${RAF}
${PUB('R')}
let white = false;
addEventListener('keydown', (e) => { white = !white; S.kd++; document.getElementById('sq').style.background = white ? '#fff' : '#000'; e.preventDefault(); }, true);
if (q.get('load')) {
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
}
</script></body>`;

export const PAGES: Record<string, string> = { 'video.html': VIDEO_HTML, 'scroll.html': SCROLL_HTML, 'latency.html': LATENCY_HTML };

/** SSM's command parameters have a size limit, so the clip goes over in pieces, four at a time, as av-sync's does. */
const PIECE = 40_000;

/** Pages and clip to DIR on the desk, served on loopback by a transient unit as `nobody` that can't outlive an hour. */
export async function deploySq(clipPath: string): Promise<{ clipBytes: number; pieces: number; ms: number }> {
  const t0 = Date.now();
  const clipBuf = readFileSync(clipPath);
  const clip = clipBuf.toString('base64');
  await deskRun(`set -e
systemctl stop ${PAGES_UNIT} 2>/dev/null || true
systemctl reset-failed ${PAGES_UNIT} 2>/dev/null || true
rm -rf ${DIR}; install -d -m 755 ${DIR} ${DIR}/www ${DIR}/parts
${Object.entries(PAGES).map(([n, body]) => `echo ${Buffer.from(body).toString('base64')} | base64 -d > ${DIR}/www/${n}`).join('\n')}
echo ok`);
  const pieces: string[] = [];
  for (let i = 0; i < clip.length; i += PIECE) pieces.push(clip.slice(i, i + PIECE));
  for (let i = 0; i < pieces.length; i += 4) {
    await Promise.all(pieces.slice(i, i + 4).map((p, j) => deskRun(`printf %s '${p}' > ${DIR}/parts/${String(i + j).padStart(4, '0')}`)));
  }
  const out = await deskRun(`set -e
cat ${DIR}/parts/* | base64 -d > ${DIR}/www/clip.webm; rm -rf ${DIR}/parts
chmod 644 ${DIR}/www/*
systemd-run --quiet --collect --unit=${PAGES_UNIT} --uid=65534 --gid=65534 -p RuntimeMaxSec=3600 /usr/bin/python3 -I -m http.server ${PORT} --bind 127.0.0.1 --directory ${DIR}/www
sleep 1
echo "BYTES=$(stat -c %s ${DIR}/www/clip.webm)"
curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' ${pageUrl('clip.webm')}`);
  const bytes = Number(/BYTES=(\d+)/.exec(out)?.[1] ?? 0);
  if (!out.includes('HTTP=200') || bytes !== clipBuf.length) throw new Error(`the clip didn't arrive whole on the desk: ${out.slice(0, 200)}`);
  return { clipBytes: bytes, pieces: pieces.length, ms: Date.now() - t0 };
}

export async function removeSq(): Promise<string> {
  return deskRun(`systemctl stop ${PAGES_UNIT} 2>/dev/null || true; systemctl reset-failed ${PAGES_UNIT} 2>/dev/null || true; rm -rf ${DIR}; echo "removed $( [ -e ${DIR} ] && echo NOT || echo ok ) $(systemctl is-active ${PAGES_UNIT} 2>/dev/null)"`);
}

/** As DeskClient.show, on this kit's own server: this run's own tab, opened once, then navigated. */
export async function showSq(client: DeskClient, path: string, nonce: string): Promise<string> {
  const url = pageUrl(`${path}${path.includes('?') ? '&' : '?'}n=${nonce}`);
  let tabId = client.testTabId;
  if (tabId && !(await client.tabs()).some((t: Tab) => t.tabId === tabId)) tabId = null;
  if (!tabId) {
    tabId = client.testTabId = (await client.rpc<{ tabId: string }>('browser.tab.open', { url }, { idem: true })).tabId;
  } else {
    const nav = await client.rpc<{ netError?: string }>('browser.tab.navigate', { url, tabId }, { idem: true });
    if (nav.netError) throw new Error(`navigate ${path}: ${nav.netError}`);
  }
  if ((await client.tabs()).find((t) => t.tabId === tabId)?.active !== true) await client.rpc('browser.tab.activate', { tabId }, { idem: true });
  return tabId;
}

/** desk-stream's and desk-rtc's PID and restart count, and deskd's /health stream state: a level that restarts desk-stream shows here. */
export async function deskProcs(): Promise<Record<string, unknown>> {
  const out = await deskRun(`for u in desk-stream desk-rtc deskd desk-browser; do echo "U $u $(systemctl is-active $u) $(systemctl show -p MainPID --value $u) $(systemctl show -p NRestarts --value $u)"; done; echo "H $(curl -s -m 3 --unix-socket /run/desk/deskd-admin.sock http://desk/health)"`);
  const units: Record<string, { active: string; pid: number; restarts: number }> = {};
  let health: Record<string, unknown> = {};
  for (const line of out.split('\n')) {
    const [tag, a, b, c, d] = line.split(' ');
    if (tag === 'U') units[a] = { active: b, pid: Number(c), restarts: Number(d) };
    if (tag === 'H') { try { health = JSON.parse(line.slice(2)); } catch { /* deskd isn't answering */ } }
  }
  return { units, healthStatus: health.status ?? null, stream: health.stream ?? null };
}

// ---- The injection and the sampler, in the client page ----
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * addInitScript: wraps RTCPeerConnection.prototype.createDataChannel so the test can keep the session's `keys` channel (and its
 * connection), and records every QUALITY reply (0x82) the desk sends on it from the start, the one on starting to view included.
 */
export const keepKeys = () => {
  const w = window as any;
  if (w.__sq) return;
  const sq: any = { keys: null, pc: null, replies: [] };
  w.__sq = sq;
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, label: string, init?: RTCDataChannelInit) {
    const dc = orig.call(this, label, init);
    if (label === 'keys') {
      sq.keys = dc; sq.pc = this; sq.replies.length = 0;
      dc.binaryType = 'arraybuffer';
      dc.addEventListener('message', (e: MessageEvent) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const b = new Uint8Array(e.data);
        if (b[0] === 0x82) sq.replies.push({ at: +performance.now().toFixed(1), level: b[1], stream: b[2], flags: b[3], limit: b[4], bytes: b.length });
      });
    }
    return dc;
  };
};

/** The page side: QUALITY (stream-quality.md section 3), the switch timer, and a getStats sampler. Needs installClient first. */
export const installSq = () => {
  const w = window as any;
  if (w.SQ) return true;
  const sq = w.__sq;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const video = document.querySelector('video') as HTMLVideoElement;
  // Every decoded frame: a count, and each change of the decoded size with its frame-callback time.
  const R: any = { frames: 0, w: 0, h: 0, sizes: [] };
  const onFrame = (now: number, m: any) => {
    R.frames++;
    if (m.width !== R.w || m.height !== R.h) { R.w = m.width; R.h = m.height; R.sizes.push({ at: +now.toFixed(1), w: m.width, h: m.height }); if (R.sizes.length > 200) R.sizes.shift(); }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  // [7, level, stream 0, 0, seq u32 BE, 0 x 8]. desk-rtc doesn't read seq; this counter keeps clear of the client's own.
  let seq = 0x40000000;
  const send = (level: number) => {
    const b = new ArrayBuffer(16), v = new DataView(b);
    v.setUint8(0, 7); v.setUint8(1, level); v.setUint32(4, ++seq);
    if (sq.keys?.readyState !== 'open') return null;
    sq.keys.send(b);
    return performance.now();
  };

  const sample = async () => {
    const out: any = { t: +performance.now().toFixed(1), rvfc: R.frames, w: video.videoWidth, h: video.videoHeight };
    if (!sq.pc) return out;
    const s = await sq.pc.getStats();
    const byId: any = {}; s.forEach((r: any) => { byId[r.id] = r; });
    s.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') out.video = { bytes: r.bytesReceived ?? 0, hdr: r.headerBytesReceived ?? 0, pkts: r.packetsReceived ?? 0, lost: r.packetsLost ?? 0, fd: r.framesDecoded ?? 0, fr: r.framesReceived ?? 0, drop: r.framesDropped ?? 0, kf: r.keyFramesDecoded ?? 0,
        fw: r.frameWidth ?? 0, fh: r.frameHeight ?? 0, fps: r.framesPerSecond ?? null, frz: r.freezeCount ?? 0, frzS: r.totalFreezesDuration ?? 0, nack: r.nackCount ?? 0, pli: r.pliCount ?? 0, jbd: r.jitterBufferDelay ?? 0, jbe: r.jitterBufferEmittedCount ?? 0, dec: r.totalDecodeTime ?? 0, decoder: r.decoderImplementation };
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.audio = { bytes: r.bytesReceived ?? 0, hdr: r.headerBytesReceived ?? 0, pkts: r.packetsReceived ?? 0, lost: r.packetsLost ?? 0 };
      if (r.type === 'transport' && r.selectedCandidatePairId) { const p = byId[r.selectedCandidatePairId]; out.pair = { bytes: p?.bytesReceived ?? 0, rtt: p?.currentRoundTripTime ?? null }; }
    });
    return out;
  };

  /**
   * Sends QUALITY and times, from the send: the desk's reply naming that level, the first keyframe decoded after it (getStats,
   * polled every ~15 ms), and the first decoded frame at `expect` size if the size changes (frame callback, exact).
   */
  const switchTo = async (a: { level: number; expect: [number, number]; waitMs: number }) => {
    const s0 = await sample();
    const k0 = s0.video?.kf ?? 0, f0 = s0.video?.fd ?? 0;
    const from = [R.w, R.h];
    const sizeChanges = from[0] !== a.expect[0] || from[1] !== a.expect[1];
    const nReplies = sq.replies.length, nSizes = R.sizes.length;
    const t0 = send(a.level);
    if (t0 === null) return { sent: false, error: 'keys not open' };
    let replyMs: number | null = null, keyframeMs: number | null = null, sizeMs: number | null = null, reply: any = null;
    while (performance.now() - t0 < a.waitMs) {
      if (replyMs === null) { const r = sq.replies.slice(nReplies).find((x: any) => x.level === a.level); if (r) { replyMs = +(r.at - t0).toFixed(1); reply = r; } }
      if (sizeMs === null && sizeChanges) { const z = R.sizes.slice(nSizes).find((x: any) => x.w === a.expect[0] && x.h === a.expect[1]); if (z) sizeMs = +(z.at - t0).toFixed(1); }
      if (keyframeMs === null) { const s = await sample(); if ((s.video?.kf ?? 0) > k0) keyframeMs = +(performance.now() - t0).toFixed(1); }
      if (replyMs !== null && keyframeMs !== null && (sizeMs !== null || !sizeChanges)) break;
      await pause(10);
    }
    const s1 = await sample();
    return { sent: true, level: a.level, from: from.join('x'), to: a.expect.join('x'), sizeChanges, replyMs, reply, firstKeyframeMs: keyframeMs, firstFrameAtNewSizeMs: sizeMs,
      decodedDuring: (s1.video?.fd ?? 0) - f0, keyframesDuring: (s1.video?.kf ?? 0) - k0, repliesSince: sq.replies.slice(nReplies), sizesSince: R.sizes.slice(nSizes) };
  };

  /** One sample now, then one a second for `seconds`. */
  const segment = async (a: { seconds: number }) => {
    const ticks: any[] = [await sample()];
    const t0 = performance.now();
    for (let i = 1; i <= a.seconds; i++) { await pause(Math.max(0, t0 + i * 1000 - performance.now())); ticks.push(await sample()); }
    return ticks;
  };

  w.SQ = { send, sample, switchTo, segment, replies: () => sq.replies, sizes: () => R.sizes, keysOpen: () => sq.keys?.readyState === 'open' };
  return !!sq.keys;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- Arithmetic ----
export interface Tick { t: number; rvfc: number; w: number; h: number; video?: Record<string, number>; audio?: Record<string, number>; pair?: { bytes: number; rtt: number | null } }
const GBH = (bytesPerS: number) => +((bytesPerS * 3600) / 1e9).toFixed(3);

/** Rates over a segment: GB an hour (10^9 bytes) from the byte counters, decoded fps, the picture size, and the rest of getStats. */
export function rates(T: Tick[]) {
  const a = T[0], b = T[T.length - 1];
  const dt = (b.t - a.t) / 1000;
  const d = (k: 'video' | 'audio', f: string) => ((b[k]?.[f] ?? 0) - (a[k]?.[f] ?? 0));
  const per = (k: 'video' | 'audio', f: string) => T.slice(1).map((x, i) => (x[k]?.[f] ?? 0) - (T[i][k]?.[f] ?? 0));
  const videoBps = d('video', 'bytes') / dt, videoHdrBps = d('video', 'hdr') / dt, audioBps = d('audio', 'bytes') / dt, audioHdrBps = d('audio', 'hdr') / dt;
  const pairBps = ((b.pair?.bytes ?? 0) - (a.pair?.bytes ?? 0)) / dt;
  const sizes: Record<string, number> = {};
  for (const x of T) { const k = `${x.video?.fw ?? 0}x${x.video?.fh ?? 0}`; sizes[k] = (sizes[k] ?? 0) + 1; }
  const perSecFd = per('video', 'fd');
  return {
    seconds: +dt.toFixed(1),
    size: Object.entries(sizes).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null, sizes,
    decodedFps: +(d('video', 'fd') / dt).toFixed(1), decodedP5: pct(perSecFd, 5), decodedMin: perSecFd.length ? Math.min(...perSecFd) : null, receivedFps: +(d('video', 'fr') / dt).toFixed(1),
    rvfcFps: +((b.rvfc - a.rvfc) / dt).toFixed(1),
    videoMbps: +((videoBps * 8) / 1e6).toFixed(3), videoGBh: GBH(videoBps), videoWithRtpHeadersGBh: GBH(videoBps + videoHdrBps),
    audioKbps: +((audioBps * 8) / 1e3).toFixed(1), audioGBh: GBH(audioBps), audioWithRtpHeadersGBh: GBH(audioBps + audioHdrBps),
    transportGBh: GBH(pairBps), transportNote: 'all bytes the selected candidate pair received: SRTP, RTCP, data channels',
    perSecondVideoMbps: per('video', 'bytes').map((x) => +((x * 8) / 1e6).toFixed(2)), perSecondDecoded: perSecFd,
    keyframes: d('video', 'kf'), dropped: d('video', 'drop'), freezes: d('video', 'frz'), freezeSeconds: +d('video', 'frzS').toFixed(3), packetsLost: d('video', 'lost'), nacks: d('video', 'nack'), plis: d('video', 'pli'),
    jitterBufferMs: +((1000 * d('video', 'jbd')) / Math.max(1, d('video', 'jbe'))).toFixed(1), decodeMs: +((1000 * d('video', 'dec')) / Math.max(1, d('video', 'fd'))).toFixed(2),
    rttMs: pct(T.map((x) => (x.pair?.rtt ?? null) === null ? null : (x.pair!.rtt as number) * 1000), 50),
    decoder: (b.video as unknown as { decoder?: string } | undefined)?.decoder ?? null,
  };
}

/** The desk page's own rAF rate from its title reports: start to end, and per interval between reports (stream.spec.ts test 2). */
export function pageFps(samples: (Record<string, number> | null)[]) {
  const seen = new Set<number>();
  const pts = samples.filter((s): s is Record<string, number> => !!s).filter((s) => !seen.has(s.t) && !!seen.add(s.t)).sort((a, b) => a.t - b.t);
  const perInterval: number[] = [];
  for (let i = 1; i < pts.length; i++) perInterval.push(+(((pts[i].f - pts[i - 1].f) * 1000) / (pts[i].t - pts[i - 1].t)).toFixed(1));
  const first = pts[0], last = pts[pts.length - 1];
  const dt = first && last ? (last.t - first.t) / 1000 : 0;
  return {
    samples: pts.length, seconds: +dt.toFixed(1), avg: dt ? +((last.f - first.f) / dt).toFixed(1) : null, p5: pct(perInterval, 5), min: perInterval.length ? Math.min(...perInterval) : null,
    longFramePct: dt && last.f > first.f ? +((100 * (last.lf - first.lf)) / (last.f - first.f)).toFixed(1) : null,
    scrollChangeFps: dt ? +((last.sf - first.sf) / dt).toFixed(1) : null, scrolledPx: last && first ? last.px - first.px : 0,
    videoDropped: last && first && 'dropped' in last ? last.dropped - first.dropped : undefined, videoFrames: last && first && 'total' in last ? last.total - first.total : undefined,
  };
}
