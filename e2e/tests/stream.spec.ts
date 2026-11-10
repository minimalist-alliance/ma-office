// Milestone 2 on the real test desk: real deskd, desk-rtc and desk-stream on a Platform-managed desk, through Platform's real
// API and gateway. The shipped app has no Browser window yet, so the client is test-only code at the app's own origin
// (streamlib.ts). Pages come from a loopback server on the desk and report what they saw in document.title, read back
// through deskd's browser.tabs and browser.tab.list.
//
// Tests are not `serial` on purpose: Playwright would skip everything after a failure, and each check's result matters on
// its own. A failed test costs a new worker, whose beforeAll signs in again; every test sets up what it needs.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, DESK_ID, INSTANCE, apiToken, deskTruth, loadUser, type DeskTruth, assertTestDesk } from './lib';
import {
  B11, B12, B13_MS, DeskClient, FIXTURE_HTML, FIXTURE_PATH, KEYSYM, type OpenResult, TITLE_TEXT, cpuBetween, deployPages, deskCpu, deskRun, deskUnits, deskVersions, keysym,
  localUdp, nx, ny, pageUrl, pct, removePages, sleep, sum5, titleState, udpDelta,
} from './streamlib';

const REPORT = 'screenshots/stream-report.json';
const FRAME_PNG = 'screenshots/stream-frame.png';

// As proof2.mjs. Without the autoplay flag a video with sound won't play with no gesture.
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] } });

let report: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  report[k] = v;
  console.log(`[stream] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
};
const clientLoad = () => ({ cores: cpus().length, loadavg1m: +loadavg()[0].toFixed(2) });

let context: BrowserContext;
let page: Page;
let client: DeskClient;
let truth: DeskTruth;
let opened: OpenResult;
let nonce = '';
const consoleErrors: string[] = [];
const startedAt = new Date().toISOString();

async function openUntilReady(limitMs: number): Promise<{ result: OpenResult; attempts: unknown[] }> {
  const t0 = Date.now();
  const attempts: unknown[] = [];
  let result: OpenResult = { ok: false, step: 'none' };
  while (Date.now() - t0 < limitMs) {
    result = await client.open(false);
    attempts.push({ atMs: Date.now() - t0, ok: result.ok, step: result.step, code: result.code, type: result.type, phase: result.phase });
    if (result.ok) break;
    await sleep(2000);
  }
  return { result, attempts };
}

test.beforeAll(async ({ browser }, info) => {
  mkdirSync('screenshots', { recursive: true });
  const previous = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : {};
  // STREAM_KEEP_REPORT=1: re-running one test with -g keeps the numbers of the others.
  report = info.workerIndex > 0 || process.env.STREAM_KEEP_REPORT === '1' ? previous : { startedAt };
  assertTestDesk(); // the staging test desk only
  truth = await deskTruth();
  expect(truth.deskId).toBe(DESK_ID);
  const versions = await deskVersions();
  note('desk', { instance: INSTANCE, deskId: truth.deskId, publicIp: truth.publicIp, deskdVersion: truth.deskdVersion, rtcVersion: truth.rtcVersion, ...versions });
  // The first live after a boot happens once, and Chromium then stays up, so a later run on this boot keeps that run's number.
  const firstLive = previous['first live on this boot'] ?? (previous['1 off to first frame']?.chromiumWasRunning === false ? { ...previous['1 off to first frame'], chromiumReachable: previous['1 Chromium reachable after live'] ?? null } : null);
  if (firstLive && Date.parse(previous.startedAt) > Date.parse(`${versions.bootedAt} UTC`)) note('first live on this boot', { ...firstLive, measuredInRunStarted: previous['first live on this boot']?.measuredInRunStarted ?? previous.startedAt });
  await deployPages();
  nonce = randomBytes(3).toString('hex');
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const bearer = await apiToken(context, loadUser('desk-1'));
  page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().replace(/[?#]\S*/g, '').slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  client = new DeskClient(page, bearer, nonce);
  await client.init();
  const { result, attempts } = await openUntilReady(90_000);
  note('session open attempts', attempts);
  if (!result.ok) throw new Error(`no session: ${JSON.stringify({ step: result.step, code: result.code, type: result.type, message: result.message })}`);
  opened = result;
  note('session', { ms: result.ms, iceServers: result.iceServers, tracksAtRemote: result.tracksAtRemote, tracks: result.tracks, sdp: result.sdp, hello: result.hello, tabsSubscribed: result.tabsSubscribed });
});

test.afterAll(async () => {
  note('token refreshes', client?.tokenRefreshes ?? []);
  const log = await client?.c('log').catch(() => []);
  const finish = await client?.finish().catch((e: Error) => ({ error: e.message.slice(0, 200) }));
  await sleep(1500);
  const clientLog = await page?.evaluate(() => (window as unknown as { C?: { log(): unknown[] } }).C?.log() ?? []).catch(() => log);
  note('client log, last 40', (clientLog as unknown[] ?? []).slice(-40));
  note('client console errors', consoleErrors.slice(-20));
  await context?.close();
  await sleep(2000);
  note('finish', finish);
  const end = await deskUnits().catch((e: Error) => ({ error: e.message.slice(0, 200) }));
  note('desk at the end', end);
  await removePages().catch((e: Error) => note('removePages failed', e.message.slice(0, 200)));
  // Warnings and errors these units logged during this run. Units never log tokens (services/CLAUDE.md).
  const since = new Date(Date.parse(startedAt) - 5000).toISOString().replace('T', ' ').slice(0, 19);
  const journal = await deskRun(`journalctl -u desk-stream -u desk-rtc -u deskd --since '${since} UTC' --no-pager -o short-iso | grep -E ' (WARN|ERROR) |level=(WARN|ERROR)|Failed with|desk-stream: [^wl]' | cut -c1-240 | tail -40`).catch((e: Error) => e.message);
  note('desk journal warnings', journal.trim().split('\n'));
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
});

type Fps = { samples: number; seconds: number; avg: number | null; p5: number | null; min: number | null; scrollChangeFps: number | null; scrolledPx: number; longFramePct: number | null; visibility: unknown; perInterval: number[] };
/** The page's own rAF rate between two reads of its title. Each sample carries the page's clock, so title delays don't matter. */
function pageFps(samples: (Record<string, number> | null)[]): Fps {
  const seen = new Set<number>();
  const pts = samples.filter((s): s is Record<string, number> => !!s).filter((s) => !seen.has(s.t) && !!seen.add(s.t)).sort((a, b) => a.t - b.t);
  const perInterval: number[] = [];
  for (let i = 1; i < pts.length; i++) perInterval.push(+(((pts[i].f - pts[i - 1].f) * 1000) / (pts[i].t - pts[i - 1].t)).toFixed(1));
  const first = pts[0], last = pts[pts.length - 1];
  const dt = last && first ? (last.t - first.t) / 1000 : 0;
  return {
    samples: pts.length, seconds: +dt.toFixed(1), avg: dt ? +((last.f - first.f) / dt).toFixed(1) : null, p5: pct(perInterval, 5), min: perInterval.length ? Math.min(...perInterval) : null,
    scrollChangeFps: dt ? +((last.sf - first.sf) / dt).toFixed(1) : null, scrolledPx: last ? last.px - first.px : 0, longFramePct: dt && last.f > first.f ? +((100 * (last.lf - first.lf)) / (last.f - first.f)).toFixed(1) : null,
    visibility: last?.vis, perInterval,
  };
}
const rttMs = (s: { pair?: { rtt?: number } }) => (s.pair?.rtt !== undefined ? +(s.pair.rtt * 1000).toFixed(1) : null);

test('1 stream starts: live decodes a real picture at the desk size, H.264, direct to the desk on port 443', async () => {
  const before = await deskUnits();
  note('1 units before live', before);
  const cold = { deskStreamWasRunning: before.units['desk-stream']?.active === 'active', chromiumWasRunning: before.units['desk-browser']?.active === 'active', xorgWasRunning: before.units['desk-xorg']?.active === 'active' };
  expect(opened.tracksAtRemote, 'ontrack fires at setRemoteDescription, with nothing renegotiated (8.5)').toBe(true);

  const ff = await client.c('firstFrame', { state: 'live', waitMs: 120_000 });
  note('1 off to first frame', { ...ff, ...cold, load: clientLoad() });
  expect(ff.error ?? null, 'browser.stream.set live').toBeNull();
  expect(ff.firstCbMs, 'a decoded frame after live').not.toBeNull();

  // On a first use after boot this outlasts the first frame: API.md section 10 says calls get `unavailable` until Chromium is up.
  const chromium = await client.waitChromium();
  note('1 Chromium reachable after live', { afterFirstFrameMs: chromium.ms, codesSeen: chromium.codes });
  expect(chromium.ok, 'tab calls work once Chromium is up').toBe(true);

  // The tabs the desk already had stay as they are. This suite works in its own tab, and closes it at the end.
  const found = await client.tabs();
  note('1 tabs found on the desk', found.map((t) => ({ url: t.url.slice(0, 120), title: t.title.slice(0, 60), active: t.active })));
  const shown = await client.show('bars.html');
  expect(shown.netError ?? null, 'the page on the desk loads').toBeNull();
  const afterOpen = await client.tabs();
  note('1 tabs after browser.tab.open', afterOpen.map((t) => ({ mine: t.tabId === shown.tabId, active: t.active, loading: t.loading })));
  expect.soft(afterOpen.find((t) => t.tabId === shown.tabId)?.active, 'the new tab is the one on screen').toBe(true);

  // A call that leaves out tabId is what the app does, and has only been checked headless (services/CLAUDE.md, Known gaps).
  const omit = await client.rpcTry('browser.tab.navigate', { url: pageUrl(`bars.html?n=${nonce}&omit=1`) }, { idem: true });
  note('1 navigate leaving out tabId', omit);
  expect.soft(omit.ok, 'navigate with no tabId').toBe(true);
  expect.soft((omit.result as unknown as { tabId?: string } | undefined)?.tabId, 'it acted on the tab on screen').toBe(shown.tabId);

  const seen = await client.waitTitle('R', (s) => (s as unknown as { n: string; vis: string }).n === nonce && (s as unknown as { vis: string }).vis === 'visible', 15_000);
  note('1 what the page itself says', seen);
  note('1 the title as deskd reports it', client.lastRawTitle);
  expect(seen, 'the page published its size').not.toBeNull();

  // Known colors at known places: the decoded frame really is this page.
  const points: [number, number][] = [[480, 270], [1440, 270], [480, 810], [1440, 810]];
  const looksRight = (px: number[][] | null) => !!px && px[0][0] > 150 && px[0][1] < 70 && px[0][2] < 70 && px[1][1] > 130 && px[1][0] < 70 && px[1][2] < 70 && px[2][2] > 150 && px[2][0] < 70 && px[2][1] < 70 && px[3].every((c) => c > 200);
  let pixels: number[][] | null = null;
  for (let i = 0; i < 100 && !looksRight(pixels); i++) { pixels = await client.c('samplePixels', points); if (!looksRight(pixels)) await sleep(100); }
  note('1 decoded pixels at the four quadrants (RGB)', pixels);
  expect(looksRight(pixels), 'red, green, blue, white where the page has them').toBe(true);

  const png = await client.c<string>('grabFrame');
  writeFileSync(FRAME_PNG, Buffer.from(png.split(',')[1], 'base64'));

  const s = await client.stats();
  const pings = await client.c<number[]>('pingRtt', 20);
  note('1 stats', { videoSize: `${s.videoW}x${s.videoH}`, frameSize: `${s.video?.w}x${s.video?.h}`, codec: s.video?.codec, fmtp: s.video?.fmtp, decoder: s.video?.decoder, powerEfficient: s.video?.powerEfficient, pair: s.pair, iceRttMs: rttMs(s), ctlPingMs: sum5(pings), keyFramesDecoded: s.video?.keyFramesDecoded });
  note('1 desk size against the video', { video: `${s.videoW}x${s.videoH}`, screen: `${seen!.sw}x${seen!.sh}`, viewport: `${seen!.iw}x${seen!.ih}`, dpr: seen!.dpr });
  expect(`${s.videoW}x${s.videoH}`, 'the size the spec names').toBe('1920x1080');
  expect(`${s.videoW}x${s.videoH}`, "the desk's own screen, as its Chromium reports it").toBe(`${seen!.sw}x${seen!.sh}`);
  expect(s.video?.codec).toBe('video/H264');
  expect(s.pair?.remote?.address, "the desk's public IPv4").toBe(truth.publicIp);
  expect(s.pair?.remote?.port).toBe(443);
  expect(s.pair?.remote?.type, 'not relayed').not.toBe('relay');
  expect(s.pair?.local?.type, 'not relayed').not.toBe('relay');
});

test('1b tab titles: the client gets a title as the page set it, and browser.tabs delivers it', async () => {
  await client.ensureLive();
  const shown = await client.show('title.html');
  expect(shown.netError ?? null, 'the page on the desk loads').toBeNull();
  const t0 = Date.now();
  let viaList = '';
  while (Date.now() - t0 < 8000 && !/é/.test(viaList)) { viaList = (await client.tabs()).find((t) => t.tabId === shown.tabId)?.title ?? ''; await sleep(100); }
  await sleep(1500);
  const events = await client.c<{ t: number; tabs: { tabId: string; title: string }[] }[]>('titles');
  const viaEvent = [...events].reverse().map((e) => e.tabs.find((t) => t.tabId === shown.tabId)?.title).find((x) => x && /é/.test(x));
  note('1b title', { pageSet: TITLE_TEXT, viaBrowserTabList: viaList, viaBrowserTabsEvent: viaEvent ?? null, tabEventsSoFar: await client.c('tabEvents') });
  expect.soft(viaEvent, 'browser.tabs delivered the title').toBeTruthy();
  expect.soft(viaList, 'browser.tab.list gives the title as the page set it').toBe(TITLE_TEXT);
});

test('2 frame rate under motion: the page itself holds B11 while the wheel scrolls it, 30 s', async () => {
  await client.ensureLive();
  await client.show('scroll.html');
  await client.waitTitle('R', (s) => (s as unknown as { n: string }).n === nonce, 10_000);
  await sleep(1500);
  const startY = await client.readTitle('R');
  await client.c('wheelStart');
  await sleep(2000); // into the steady state, past any first long frame
  const cpu0 = await deskCpu();
  const udp0 = localUdp();
  const first = await client.readTitle('R');
  const t0 = await client.c<number>('now');
  const ticks = await client.c<Record<string, never>[]>('segment', { seconds: 30 });
  const t1 = await client.c<number>('now');
  const last = await client.readTitle('R');
  const udp1 = localUdp();
  const cpu1 = await deskCpu();
  const load = clientLoad();
  const pxSent = await client.c<number>('wheelStop');

  const titles = await client.c<{ t: number; tabs: { tabId: string; title: string }[] }[]>('titles');
  const inWindow = titles.filter((x) => x.t >= t0 && x.t <= t1).map((x) => titleState<Record<string, number>>(x.tabs.find((y) => y.tabId === client.testTabId)?.title, 'R'));
  const fps = pageFps([first, ...inWindow, last]);
  note('2 page fps (rAF inside the desk Chromium)', { ...fps, titleEventsInWindow: inWindow.length, startY: startY?.y, pxSentByClient: pxSent });

  // Decoded at the client, as page2.js and proof2.mjs compute it.
  type Tick = { t: number; changed: number; video: { framesDecoded: number; framesReceived: number; framesDropped: number; bytes: number; packetsLost: number; nackCount: number; pliCount: number; freezeCount: number; totalFreezesDuration: number; jitterBufferDelay: number; jitterBufferEmittedCount: number; totalDecodeTime: number; keyFramesDecoded: number; decoder: string; retransmitted?: number }; pair?: { rtt?: number } };
  const T = ticks as unknown as Tick[];
  const a = T[0], b = T[T.length - 1];
  const dt = (b.t - a.t) / 1000;
  const perSec = T.slice(1).map((x, i) => x.video.framesDecoded - T[i].video.framesDecoded);
  const client2 = {
    seconds: +dt.toFixed(1), decodedFps: +((b.video.framesDecoded - a.video.framesDecoded) / dt).toFixed(1), decodedP5: pct(perSec, 5), decodedMin: Math.min(...perSec), receivedFps: +((b.video.framesReceived - a.video.framesReceived) / dt).toFixed(1),
    contentChangedFps: +((b.changed - a.changed) / dt).toFixed(1), dropped: b.video.framesDropped - a.video.framesDropped, freezes: b.video.freezeCount - a.video.freezeCount, freezeSeconds: +(b.video.totalFreezesDuration - a.video.totalFreezesDuration).toFixed(3),
    mbps: +(((b.video.bytes - a.video.bytes) * 8) / dt / 1e6).toFixed(2), packetsLost: b.video.packetsLost - a.video.packetsLost, nacks: b.video.nackCount - a.video.nackCount, plis: b.video.pliCount - a.video.pliCount, keyframes: b.video.keyFramesDecoded - a.video.keyFramesDecoded,
    jitterBufferMs: +((1000 * (b.video.jitterBufferDelay - a.video.jitterBufferDelay)) / Math.max(1, b.video.jitterBufferEmittedCount - a.video.jitterBufferEmittedCount)).toFixed(1), decodeMs: +((1000 * (b.video.totalDecodeTime - a.video.totalDecodeTime)) / Math.max(1, b.video.framesDecoded - a.video.framesDecoded)).toFixed(1),
    decoder: b.video.decoder, iceRttMs: rttMs(b), load, retransmitted: (b.video.retransmitted ?? 0) - (a.video.retransmitted ?? 0),
    perSecondDecoded: perSec,
    perSecondJitterBufferMs: T.slice(1).map((x, i) => Math.round((1000 * (x.video.jitterBufferDelay - T[i].video.jitterBufferDelay)) / Math.max(1, x.video.jitterBufferEmittedCount - T[i].video.jitterBufferEmittedCount))),
    perSecondPlis: T.slice(1).map((x, i) => x.video.pliCount - T[i].video.pliCount),
    workstationUdp: udpDelta(udp0, udp1),
  };
  note('2 client', client2);
  note('2 desk cpu', cpuBetween(cpu0, cpu1));

  expect(fps.samples, 'page samples read back through the title').toBeGreaterThanOrEqual(2);
  expect(fps.scrolledPx, 'WHEEL really scrolled the page').toBeGreaterThan(1000);
  expect.soft(fps.visibility, 'the tab on screen').toBe('visible');
  expect.soft(fps.avg, `B11: page avg >= ${B11.avg}`).toBeGreaterThanOrEqual(B11.avg);
  expect.soft(fps.p5, `B11: page p5 >= ${B11.p5}`).toBeGreaterThanOrEqual(B11.p5);
  expect.soft(client2.receivedFps, 'frames reaching the client').toBeGreaterThanOrEqual(B11.avg);
  expect.soft(client2.freezes, 'B11: zero freezes').toBe(0);
});

test('3 warm stops RTP and keeps desk-stream, warm to live meets B13, off stops desk-stream and keeps Chromium', async () => {
  await client.ensureLive();
  await client.show('scroll.html');
  await client.waitTitle('R', (s) => (s as unknown as { n: string }).n === nonce, 10_000);
  await sleep(1500);

  const atLive = await deskUnits();
  note('3 at live', { desk: atLive.units['desk-stream'], stream: atLive.stream });
  expect(atLive.units['desk-stream']?.active).toBe('active');
  expect.soft(atLive.stream, "deskd's /health").toMatchObject({ wanted: 'live', rtc: 'live' });

  const warm = await client.c('setAndWatch', { state: 'warm', watchMs: 2500 });
  const atWarm = await deskUnits();
  note('3 warm', { ...warm, deskStream: atWarm.units['desk-stream'], stream: atWarm.stream, chromium: atWarm.units['desk-browser'] });
  expect(warm.ok, 'browser.stream.set warm').toBe(true);
  expect.soft(warm.lastVideoPacketMs, 'warm stops video RTP within about 1 s').toBeLessThanOrEqual(1200);
  expect(atWarm.units['desk-stream']?.active, 'desk-stream stays up in warm').toBe('active');
  expect(atWarm.units['desk-stream']?.pid, 'the same desk-stream process').toBe(atLive.units['desk-stream']?.pid);
  expect.soft(atWarm.stream, "deskd's /health").toMatchObject({ wanted: 'warm', rtc: 'warm' });

  const runs: { rpcMs: number; firstCbMs: number | null; firstDisplayMs: number | null; error?: unknown }[] = [];
  for (let i = 0; i < 13; i++) {
    await sleep(600 + Math.random() * 400);
    runs.push(await client.c('firstFrame', { state: 'live', waitMs: 8000 }));
    await sleep(300);
    await client.rpc('browser.stream.set', { state: 'warm' }, { deadlineMs: 40_000 });
  }
  const scored = runs.slice(1); // as proof2.mjs: the first comes after the longer warm above
  const b13 = { firstFrameCallbackMs: sum5(scored.map((r) => r.firstCbMs)), rpcMs: sum5(scored.map((r) => r.rpcMs)), firstRun: runs[0].firstCbMs, misses: scored.filter((r) => r.firstCbMs === null).length, errors: scored.filter((r) => r.error).length, budgetMs: B13_MS, load: clientLoad(), iceRttMs: rttMs(await client.stats()) };
  note('3 warm to live (B13)', b13);
  expect(b13.misses, 'every warm to live showed a frame').toBe(0);
  expect.soft(b13.firstFrameCallbackMs.p95, `B13 <= ${B13_MS} ms`).toBeLessThanOrEqual(B13_MS);

  const off = await client.c('setAndWatch', { state: 'off', watchMs: 2000 });
  const atOff = await deskUnits();
  note('3 off', { ...off, units: atOff.units, stream: atOff.stream });
  expect(off.ok, 'browser.stream.set off').toBe(true);
  expect(atOff.units['desk-stream']?.active, 'off stops desk-stream, by systemctl is-active').toBe('inactive');
  expect(atOff.units['desk-browser']?.active, 'Chromium keeps running').toBe('active');
  expect(atOff.units['desk-browser']?.pid, 'the same Chromium').toBe(atWarm.units['desk-browser']?.pid);
  expect(atOff.units['desk-xorg']?.active, 'Xorg keeps running').toBe('active');
  expect.soft(atOff.stream, "deskd's /health").toMatchObject({ wanted: 'off', rtc: 'down' });

  const tabs = await client.tabs();
  expect.soft(tabs.some((t) => t.tabId === client.testTabId), 'the tab outlives the stream').toBe(true);

  const cold: { rpcMs: number; firstCbMs: number | null }[] = [];
  for (let i = 0; i < 4; i++) {
    cold.push(await client.c('firstFrame', { state: 'live', waitMs: 20_000 }));
    await sleep(800);
    await client.rpc('browser.stream.set', { state: 'off' }, { deadlineMs: 40_000 });
    await sleep(800);
  }
  note('3 off to live with Chromium up', { firstFrameCallbackMs: cold.map((r) => r.firstCbMs), rpcMs: cold.map((r) => r.rpcMs), summary: sum5(cold.map((r) => r.firstCbMs)) });
  expect(cold.every((r) => r.firstCbMs !== null), 'every off to live showed a frame').toBe(true);
});

test('4 audio: an Opus track carries the sound the page plays', async () => {
  await client.ensureLive();
  await client.show('audio.html');
  const ready = await client.waitTitle('R', (s) => (s as unknown as { n: string }).n === nonce && (s as unknown as { on: number }).on === 0, 10_000);
  expect(ready, 'audio page ready').not.toBeNull();

  type Audio = { packetsReceived: number; energy: number; codec?: string; bytes: number; level?: number; concealedSamples: number; samples: number };
  // From desk-stream 0.3.3 a quiet desk sends no sound at all (ADR 0073 addendum), and Chrome lists an inbound audio stream only
  // once its first packet arrives: until the page plays, there may be none. Before 0.3.3 the desk sent silence all the time.
  const none: Audio = { packetsReceived: 0, energy: 0, bytes: 0, concealedSamples: 0, samples: 0 };
  const sample = async () => (await client.stats()).audio as Audio | undefined;
  const delta = (x: Audio | undefined, y: Audio | undefined) => {
    const a = x ?? none, b = y ?? none;
    return { packets: b.packetsReceived - a.packetsReceived, bytes: b.bytes - a.bytes, energy: +(b.energy - a.energy).toExponential(3), level: b.level, concealed: b.concealedSamples - a.concealedSamples, samples: b.samples - a.samples };
  };

  const s0 = await sample();
  if (s0) expect(s0.codec, 'the codec').toBe('audio/opus');
  const q0 = await sample();
  const quietPeak = await client.c('audioPeak', { ms: 3000 });
  const q1 = await sample();
  const quiet = { ...delta(q0, q1), peak: quietPeak };

  const centre = { x: nx(960), y: ny(540) };
  const clickCentre = async () => {
    await client.c('event', { type: 'BUTTON', down: true, button: 1, ...centre });
    await sleep(40);
    await client.c('event', { type: 'BUTTON', down: false, button: 1, ...centre });
  };
  await clickCentre();
  const on = await client.waitTitle('R', (s) => (s as unknown as { on: number }).on === 1, 8000);
  note('4 page after the click', on);
  expect((on as unknown as { on?: number } | null)?.on, 'the click started the tone in the page').toBe(1);
  await sleep(800);
  const a0 = await sample();
  const tonePeak = await client.c('audioPeak', { ms: 3000 });
  const a1 = await sample();
  const tone = { ...delta(a0, a1), peak: tonePeak };
  await clickCentre();
  await client.waitTitle('R', (s) => (s as unknown as { on: number }).on === 0, 5000);
  const tracks = (opened.tracks as { kind: string; trackId: string; streamId: string }[]);
  note('4 audio', { tracks, opusInAnswer: JSON.stringify(opened.sdp).toLowerCase().includes('opus'), silence3s: quiet, tone3s: tone, inboundBeforeTone: !!s0, load: clientLoad() });

  expect(a1, 'an inbound audio track once the page plays').toBeDefined();
  expect(a1?.codec, 'the codec').toBe('audio/opus');
  expect(tone.packets, 'Opus packets while the page plays').toBeGreaterThan(0);
  expect.soft(tone.energy, 'more energy than silence').toBeGreaterThan(Number(quiet.energy) * 10 + 1e-9);
  expect.soft(Math.abs((tone.peak.peakHz as number) - 1000), 'the 1 kHz tone, at the client').toBeLessThanOrEqual(50);
});

type InputState = { id: number; c: Record<string, number>; l: [string, number, number, number] | null; md: number; mu: number; cm: number; mv: [number, number] | null; kd: number; ku: number; rp: number; lk: string; lc: string; sh: number; v: string; sy: number; sx: number };

test('5 input: MOVE, BUTTON, WHEEL, KEY and RELEASE_ALL reach the page, and CURSOR reaches the client', async () => {
  await client.ensureLive();
  await client.show('input.html');
  const ready = await client.waitTitle<InputState>('I', () => true, 10_000);
  expect(ready, 'input page ready').not.toBeNull();

  const ev = (type: string, f: Record<string, unknown> = {}) => client.c('event', { type, ...f });
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const wait = (ok: (s: InputState) => boolean, ms = 6000) => client.waitTitle<InputState>('I', ok, ms);
  const click = async (x: number, y: number, button = 1) => {
    await ev('BUTTON', { down: true, button, x: nx(x), y: ny(y) });
    await sleep(30);
    await ev('BUTTON', { down: false, button, x: nx(x), y: ny(y) });
  };
  const tap = async (sym: number) => { await ev('KEY', { down: true, keysym: sym }); await sleep(30); await ev('KEY', { down: false, keysym: sym }); };

  // MOVE, on the lossy channel.
  await ev('MOVE', { x: nx(960), y: ny(700) });
  let s = await wait((x) => !!x.mv && near(x.mv[0], 960) && near(x.mv[1], 700));
  note('5 MOVE to 960,700', s?.mv);
  expect.soft(s?.mv && near(s.mv[0], 960) && near(s.mv[1], 700), 'MOVE lands where it was sent').toBe(true);

  // BUTTON: small targets in the corners and the middle, so a scale or offset error lands somewhere else.
  const targets: [string, number, number][] = [['tl', 80, 60], ['tr', 1840, 60], ['bl', 80, 1020], ['br', 1840, 1020], ['mid', 960, 340]];
  const clicks: Record<string, unknown> = {};
  for (const [id, x, y] of targets) {
    await click(x, y);
    const got = await wait((v) => v.c[id] === 1);
    clicks[id] = { sent: [x, y], landed: got?.l };
    expect.soft(got?.c[id], `click lands on #${id}`).toBe(1);
    expect.soft(got?.l?.[0], `the click's target is #${id}`).toBe(id);
    expect.soft(got && near(got.l![1], x) && near(got.l![2], y), `#${id} clicked at the position sent, ${got?.l}`).toBe(true);
    expect.soft(got?.l?.[3], 'left button').toBe(0);
  }
  note('5 clicks', clicks);
  const cmBefore = (await client.readTitle<InputState>('I'))?.cm ?? 0;
  await click(960, 340, 3);
  s = await wait((v) => v.cm === cmBefore + 1);
  note('5 right click', s?.l);
  expect.soft(s?.cm, 'BUTTON 3 is a right click').toBe(cmBefore + 1);
  expect.soft(s?.l?.[3], 'contextmenu button').toBe(2);

  // KEY. One bare shifted character, one with Shift held as a real keyboard sends it, and non-ASCII on both sides of U+0100.
  await click(960, 64);
  s = await wait((v) => v.c.text >= 1);
  expect.soft(s?.c.text, 'the click focused the input').toBe(1);
  const typed: { step: string; expect: string; got: string | undefined; lastKey?: string; code?: string; shift?: number }[] = [];
  let want = '';
  const step = async (label: string, add: string, act: () => Promise<void>) => {
    await act();
    want += add;
    const got = await wait((v) => v.v === want, 4000);
    typed.push({ step: label, expect: want, got: got?.v, lastKey: got?.lk, code: got?.lc, shift: got?.sh });
    expect.soft(got?.v, `typed ${label}`).toBe(want);
    want = got?.v ?? want; // a miss doesn't take every later step with it
  };
  await step('a', 'a', () => tap(keysym('a')));
  await step('B, keysym alone (desk-rtc adds Shift)', 'B', () => tap(keysym('B')));
  await step('C, with Shift held', 'C', async () => { await ev('KEY', { down: true, keysym: KEYSYM.Shift }); await sleep(30); await tap(keysym('C')); await sleep(30); await ev('KEY', { down: false, keysym: KEYSYM.Shift }); });
  await step('1', '1', () => tap(keysym('1')));
  await step('! (shifted on a US keymap)', '!', () => tap(keysym('!')));
  await step('é (below U+0100)', 'é', () => tap(keysym('é')));
  await step('€ (above U+0100)', '€', () => tap(keysym('€')));
  await tap(KEYSYM.Backspace);
  want = want.slice(0, -1);
  const afterBs = await wait((v) => v.v === want, 4000);
  typed.push({ step: 'Backspace', expect: want, got: afterBs?.v });
  expect.soft(afterBs?.v, 'Backspace').toBe(want);
  await tap(KEYSYM.Enter);
  const enter = await wait((v) => v.lk === 'Enter', 4000);
  expect.soft(enter?.lk, 'Enter').toBe('Enter');
  note('5 typing', typed);
  const clearInput = async () => {
    await ev('KEY', { down: true, keysym: KEYSYM.Control }); await tap(keysym('a')); await ev('KEY', { down: false, keysym: KEYSYM.Control });
    await tap(KEYSYM.Backspace);
    return wait((v) => v.v === '', 3000);
  };

  // Named keys from the 8.6 table, each proved by what it does to the text.
  await clearInput();
  const named: Record<string, unknown>[] = [];
  const nav = async (name: keyof typeof KEYSYM, wantValue: string) => {
    await tap(KEYSYM[name]);
    const got = await wait((v) => v.lk === name && v.v === wantValue, 3000);
    named.push({ key: name, eventKey: got?.lk, code: got?.lc, value: got?.v });
    expect.soft(got?.lk, `${name} arrives as ${name}`).toBe(name);
    expect.soft(got?.v, `after ${name}`).toBe(wantValue);
  };
  const put = async (ch: string, wantValue: string) => {
    await tap(keysym(ch));
    const got = await wait((v) => v.v === wantValue, 3000);
    named.push({ key: ch, value: got?.v });
    expect.soft(got?.v, `typed ${ch}`).toBe(wantValue);
  };
  for (const [ch, v] of [['a', 'a'], ['b', 'ab'], ['c', 'abc']]) await put(ch, v);
  await nav('ArrowLeft', 'abc'); await put('X', 'abXc');
  await nav('Home', 'abXc'); await put('Y', 'YabXc');
  await nav('End', 'YabXc'); await put('Z', 'YabXcZ');
  await nav('ArrowLeft', 'YabXcZ'); await nav('Delete', 'YabXc');
  await nav('Home', 'YabXc'); await nav('ArrowRight', 'YabXc'); await put('R', 'YRabXc');
  await nav('Tab', 'YRabXc');
  note('5 named keys', named);
  await click(960, 64);
  await wait((v) => v.c.text >= 2);

  // Characters that need a spare keycode. Pace first, with ASCII as the control.
  const paced: { chars: string; gapMs: number; got: string | undefined; lost: number }[] = [];
  for (const [chars, gapMs] of [['abcdef', 0], ['ñüßçøå', 0], ['ñüßçøå', 30], ['ñüßçøå', 120]] as [string, number][]) {
    await clearInput();
    for (const ch of chars) { await ev('KEY', { down: true, keysym: keysym(ch) }); await ev('KEY', { down: false, keysym: keysym(ch) }); if (gapMs) await sleep(gapMs); }
    const got = await wait((v) => v.v === chars, 2500);
    paced.push({ chars, gapMs, got: got?.v, lost: chars.length - (got?.v.length ?? 0) });
    expect.soft(got?.v, `${chars} with ${gapMs} ms between keys`).toBe(chars);
  }
  note('5 typing pace', paced);

  // 8.6: "any character types". One at a time, refocusing first, because a character that misses can act as another key: `code` says
  // which one the page saw, and a reload shows as a new page id. Which character lands on which keycode depends on the order of first use.
  const letters = [...'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿßÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ¡¿£¥§«»€中日ж'];
  const failed: { ch: string; code?: string; key?: string; value?: string; reloaded: boolean; page?: string }[] = [];
  for (const ch of letters) {
    await click(960, 64);
    await clearInput();
    const id = (await client.readTitle<InputState>('I'))?.id;
    await tap(keysym(ch));
    const got = await wait((v) => v.v === ch, 700);
    if (got?.v === ch) continue;
    const page = (await client.tabs()).find((t) => t.tabId === client.testTabId)?.url.replace(/^.*\//, '').replace(/\?.*/, '');
    failed.push({ ch, code: got?.lc, key: got?.lk, value: got?.v, reloaded: got?.id !== id, page });
    if (page !== 'input.html') { await client.show('input.html'); await wait(() => true, 5000); }
  }
  const keymap = await deskRun(`cd /tmp; DISPLAY=:99 runuser -u stream -- xmodmap -pke | grep -E '^keycode +[0-9]+ = ([^ ]+) \\1 \\1 \\1 *$' | sed -E 's/^keycode +([0-9]+) = ([^ ]+).*/\\1=\\2/' | tr '\\n' ' '; echo; DISPLAY=:99 runuser -u stream -- xkbcomp :99 - 2>/dev/null | grep -m1 xkb_keycodes`);
  note('5 every character types', { tried: letters.length, typed: letters.length - failed.length, failed, spareKeycodesInUse: keymap.trim().split('\n')[0], xkbKeycodes: keymap.trim().split('\n')[1] });
  expect.soft(failed.map((f) => f.ch).join(''), 'characters that did not type').toBe('');
  await clearInput();

  // WHEEL: one X wheel click is 120 px, and desk-rtc keeps the remainder, including what test 2's scrolling left.
  // So 530 px is 3 to 5 clicks: a whole number of steps, within one step and the carry of what was sent.
  const steps = (v: number, sign: 1 | -1) => v % 120 === 0 && sign * v >= 360 && sign * v <= 600;
  const wheel: Record<string, unknown> = {};
  const scroll = async (label: string, dx: number, dy: number, ok: (v: InputState) => boolean) => {
    await ev('WHEEL', { x: nx(960), y: ny(700), dx, dy });
    const got = await wait(ok, 5000);
    await sleep(400); // any smooth-scroll animation still running
    const settled = await client.readTitle<InputState>('I');
    wheel[label] = { sy: settled?.sy, sx: settled?.sx };
    expect.soft(got && ok(got), `WHEEL ${label}`).toBe(true);
  };
  await scroll('down 530', 0, 530, (v) => steps(v.sy, 1));
  await scroll('up 530', 0, -530, (v) => v.sy === 0);
  await scroll('right 530', 530, 0, (v) => steps(v.sx, 1));
  await scroll('left 530', -530, 0, (v) => v.sx === 0);
  // One X wheel click, the unit desk-rtc divides by (wheelNotch).
  await ev('WHEEL', { x: nx(960), y: ny(700), dx: 0, dy: 120 });
  await sleep(900);
  wheel['one click, 120 px sent'] = { sy: (await client.readTitle<InputState>('I'))?.sy };
  await ev('WHEEL', { x: nx(960), y: ny(700), dx: 0, dy: -120 });
  await sleep(900);
  note('5 wheel', wheel);

  // RELEASE_ALL: hold a button and a key. X's auto-repeat is off, so the hold sends nothing more (8.6).
  const b0 = (await client.readTitle<InputState>('I'))!;
  await ev('BUTTON', { down: true, button: 1, x: nx(1500), y: ny(400) });
  await ev('KEY', { down: true, keysym: keysym('q') });
  const held = await wait((v) => v.md === b0.md + 1 && v.kd === b0.kd + 1);
  await sleep(1500);
  const afterHold = await client.readTitle<InputState>('I');
  await ev('RELEASE_ALL');
  const released = await wait((v) => v.mu === b0.mu + 1 && v.ku === b0.ku + 1);
  note('5 RELEASE_ALL', { pressed: { mouseDowns: (held?.md ?? 0) - b0.md, keyDowns: (held?.kd ?? 0) - b0.kd }, keyDownsAfter1500msHold: (afterHold?.kd ?? 0) - b0.kd, repeats: afterHold?.rp, released: { mouseUps: (released?.mu ?? 0) - b0.mu, keyUps: (released?.ku ?? 0) - b0.ku } });
  expect.soft(held?.md, 'the button went down').toBe(b0.md + 1);
  expect.soft(held?.kd, 'the key went down').toBe(b0.kd + 1);
  expect.soft(afterHold?.kd, 'no auto-repeat during a hold').toBe(b0.kd + 1);
  expect.soft(released?.mu, 'RELEASE_ALL lets go of the button').toBe(b0.mu + 1);
  expect.soft(released?.ku, 'RELEASE_ALL lets go of the key').toBe(b0.ku + 1);

  // CURSOR: arrives on keys when the shape changes, and when a session starts viewing.
  type Cur = { at: number; type: number; hotX: number; hotY: number; w: number; h: number; bytes: number; pngSig?: boolean; hash?: string; decoded?: [number, number] | null };
  const onKeys = () => client.c<Cur[]>('cursors');
  // desk-rtc 0.3.3 also answers on keys with a 16-byte QUALITY reply, 0x82, when a session starts viewing (stream-quality.md 3).
  const cursors = async () => (await onKeys()).filter((c) => c.type === 0x81);
  const moveAndWait = async (label: string, x: number, y: number) => {
    const n = (await cursors()).length;
    await ev('MOVE', { x: nx(x), y: ny(y) });
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && (await cursors()).length <= n) await sleep(50);
    await sleep(150); // createImageBitmap
    const all = await cursors();
    return { label, newMessages: all.length - n, last: all.length > n ? all[all.length - 1] : null };
  };
  const pointer = await moveAndWait('cursor:pointer', 500, 550);
  const text = await moveAndWait('cursor:text', 800, 550);
  const none = await moveAndWait('cursor:none', 1100, 550);
  const back = await moveAndWait('back to default', 1500, 700);
  const viewersBefore = (await cursors()).length;
  await client.rpc('browser.stream.set', { state: 'warm' }, { deadlineMs: 40_000 });
  await sleep(600);
  await client.c('firstFrame', { state: 'live', waitMs: 8000 });
  await sleep(600);
  const all = await cursors();
  const others = (await onKeys()).filter((c) => c.type !== 0x81);
  note('5 CURSOR', { total: all.length, shapes: [pointer, text, none, back], newOnStartingToView: all.length - viewersBefore, otherOnKeys: others.map((c) => ({ type: c.type, bytes: c.bytes })), maxBytes: Math.max(...all.map((c) => c.bytes)) });
  expect(all.length, 'a CURSOR message arrived').toBeGreaterThan(0);
  expect.soft(others.every((c) => c.type === 0x82 && c.bytes === 16), 'every message on keys is a CURSOR (0x81) or a 16-byte QUALITY reply (0x82)').toBe(true);
  expect.soft(pointer.newMessages, 'CURSOR when the shape changes').toBeGreaterThan(0);
  expect.soft(pointer.last?.pngSig, 'a PNG').toBe(true);
  expect.soft(pointer.last?.decoded, 'it decodes at the size it states').toEqual([pointer.last?.w, pointer.last?.h]);
  expect.soft(text.last?.hash && text.last.hash !== pointer.last?.hash, 'the text cursor is another shape').toBeTruthy();
  expect.soft([none.last?.w, none.last?.h], 'cursor:none is hidden: 0x0 (8.6)').toEqual([0, 0]);
  expect.soft(all.length - viewersBefore, 'CURSOR when a session starts viewing').toBeGreaterThan(0);
  expect.soft(Math.max(...all.map((c) => c.bytes)), 'at most 16 KiB').toBeLessThanOrEqual(16_384);
});

async function latencyPass(label: string, path: string, trials: number) {
  await client.show(path);
  await client.waitTitle('R', (s) => (s as unknown as { n: string; vis: string }).n === nonce && (s as unknown as { vis: string }).vis === 'visible', 15_000);
  await sleep(2000);
  await client.c('clearResults');
  await page.bringToFront();
  const kd0 = ((await client.readTitle('R')) as unknown as { kd?: number } | null)?.kd ?? 0;
  const cpu0 = await deskCpu();
  const udp0 = localUdp();
  const s0 = await client.stats();
  const rtts: (number | null)[] = [];
  let misses = 0;
  for (let i = 0; i < trials; i++) {
    await sleep(250 + Math.random() * 300);
    await client.c('arm');
    const n = await client.c<number>('resultCount');
    await page.keyboard.press('x');
    const t = Date.now();
    while (Date.now() - t < 2000 && (await client.c<number>('resultCount')) <= n) await sleep(15);
    if ((await client.c<number>('resultCount')) <= n) { misses++; await client.c('disarm'); }
    await sleep(60);
    if (i % 10 === 0) rtts.push(rttMs(await client.stats()));
  }
  const results = await client.c<{ cb: number; display: number; recv: number | null }[]>('results');
  const s1 = await client.stats();
  const udp1 = localUdp();
  const load = clientLoad();
  const cpu1 = await deskCpu();
  await sleep(1200);
  const kd = ((await client.readTitle('R')) as unknown as { kd?: number } | null)?.kd ?? 0;
  const rtt = sum5(rtts);
  const cb = sum5(results.map((r) => r.cb));
  const extra = Math.max(0, (rtt.p50 ?? 0) - B12.atRttMs);
  return {
    label, trials, detected: results.length, misses, keydownsSeenByThePage: kd - kd0, aligned: kd - kd0 === trials,
    callbackMs: cb, displayMsNotTheHeadline: sum5(results.map((r) => r.display)), lastPacketMs: sum5(results.map((r) => r.recv)), iceRttMs: rtt,
    atThisRttMinusExtraRtt: { note: `callback minus ${extra.toFixed(1)} ms of RTT above ${B12.atRttMs} ms: a reading aid, not a measurement`, p50: cb.p50 === null ? null : +(cb.p50 - extra).toFixed(1), p95: cb.p95 === null ? null : +(cb.p95 - extra).toFixed(1) },
    jitterBufferMs: +((1000 * (s1.video.jitterBufferDelay - s0.video.jitterBufferDelay)) / Math.max(1, s1.video.jitterBufferEmittedCount - s0.video.jitterBufferEmittedCount)).toFixed(1),
    decodeMs: +((1000 * (s1.video.totalDecodeTime - s0.video.totalDecodeTime)) / Math.max(1, s1.video.framesDecoded - s0.video.framesDecoded)).toFixed(1),
    dropped: s1.video.framesDropped - s0.video.framesDropped, freezes: s1.video.freezeCount - s0.video.freezeCount, packetsLost: s1.video.packetsLost - s0.video.packetsLost, nacks: s1.video.nackCount - s0.video.nackCount, plis: s1.video.pliCount - s0.video.pliCount, keyframes: s1.video.keyFramesDecoded - s0.video.keyFramesDecoded, workstationUdp: udpDelta(udp0, udp1), desk: cpuBetween(cpu0, cpu1), load,
  };
}

test('6 input-to-screen latency: 120 trials each, idle and loaded, callback method, with the real RTT', async () => {
  await client.ensureLive();
  const pings = await client.c<number[]>('pingRtt', 30);
  note('6 ctl PING to PONG', sum5(pings));
  const idle = await latencyPass('idle', 'latency.html', 120);
  note('6 latency idle', idle);
  const loaded = await latencyPass('loaded: animated 520x292 canvas, not the benchmark BBB clip', 'latency.html?load=1', 120);
  note('6 latency loaded', loaded);
  const rtt = Math.max(idle.iceRttMs.p50 ?? Infinity, loaded.iceRttMs.p50 ?? Infinity);
  const judged = rtt <= B12.atRttMs;
  note('6 B12', { budget: B12, measuredRttMs: rtt, judged, why: judged ? 'RTT is at or below the budget assumption' : 'not judged: the RTT is above what B12 assumes, so the numbers are recorded and not failed on' });
  // Input not working is the only hard failure here.
  expect(idle.detected, 'at least 100 samples, idle').toBeGreaterThanOrEqual(100);
  expect(loaded.detected, 'at least 100 samples, loaded').toBeGreaterThanOrEqual(100);
  expect.soft(idle.aligned, 'one keydown on the desk per key pressed, idle').toBe(true);
  expect.soft(loaded.aligned, 'one keydown on the desk per key pressed, loaded').toBe(true);
  if (judged) {
    expect.soft(idle.callbackMs.p50, 'B12 p50, idle').toBeLessThanOrEqual(B12.p50);
    expect.soft(idle.callbackMs.p95, 'B12 p95, idle').toBeLessThanOrEqual(B12.p95);
    expect.soft(loaded.callbackMs.p50, 'B12 p50, loaded').toBeLessThanOrEqual(B12.p50);
    expect.soft(loaded.callbackMs.p95, 'B12 p95, loaded').toBeLessThanOrEqual(B12.p95);
  }
});

// Keep this last: it restarts deskd.
test('7 reconnect: after a deskd restart during a live stream, a new session gets video again', async () => {
  await client.ensureLive();
  await client.show('scroll.html');
  await client.waitTitle('R', (s) => (s as unknown as { n: string }).n === nonce, 10_000);
  await sleep(1000);
  const before = await deskUnits();
  const tabBefore = client.testTabId;
  const oldSession = (await client.c('sessionState')).sessionId as string;
  note('7 before', { units: before.units, stream: before.stream });

  const wall0 = Date.now();
  const restart = deskRun(`echo "AT=$(date +%s.%N)"; systemctl restart deskd; echo "DONE=$(date +%s.%N)"; systemctl is-active deskd`, 120);
  let lostMs: number | null = null;
  while (Date.now() - wall0 < 90_000) {
    const st = await client.c('sessionState');
    if (!st || st.gone.length || st.connection !== 'connected') { lostMs = Date.now() - wall0; break; }
    await sleep(50);
  }
  const lostState = await client.c('sessionState');
  const lastFrame = await client.stats();
  note('7 session lost', { afterSsmCallMs: lostMs, state: lostState });
  expect(lostMs, 'the session ends when deskd restarts (desk-rtc closes it within 5 s of rtc.sock dropping, 4.1)').not.toBeNull();
  const tLost = Date.now();
  await client.c('dropPeer');

  // What a client does: come straight back, with about 2 s between tries (API.md section 7, 4002).
  const attempts: unknown[] = [];
  let again: OpenResult = { ok: false };
  while (Date.now() - tLost < 180_000) {
    const t = Date.now();
    again = await client.open(true);
    attempts.push({ afterLossMs: t - tLost, tookMs: Date.now() - t, ok: again.ok, step: again.step, code: again.code, type: again.type, phase: again.phase, state: again.state });
    if (again.ok) break;
    await sleep(2000);
  }
  const tOpen = Date.now();
  note('7 reconnect attempts', attempts);
  expect(again.ok, 'a new session within 180 s').toBe(true);
  const ff = await client.c('firstFrame', { state: 'live', waitMs: 40_000 });
  const tFrame = Date.now();
  // A static page only gets the encoder's 10 fps heartbeat, so scroll: that also proves input works on the new session.
  const beforeMotion = await client.readTitle('R');
  await client.c('wheelStart');
  await sleep(500);
  const ticks = await client.c<{ video: { framesDecoded: number }; t: number }[]>('segment', { seconds: 5 });
  await client.c('wheelStop');
  await sleep(1200);
  const afterMotion = await client.readTitle('R');
  const restartOut = await restart;
  const at = Number(/AT=([\d.]+)/.exec(restartOut)?.[1] ?? 0) * 1000;
  const done = Number(/DONE=([\d.]+)/.exec(restartOut)?.[1] ?? 0) * 1000;
  const fpsAfter = +(((ticks[ticks.length - 1].video.framesDecoded - ticks[0].video.framesDecoded) * 1000) / (ticks[ticks.length - 1].t - ticks[0].t)).toFixed(1);
  const after = await deskUnits();
  const tabsAfter = await client.tabs();
  const log = (await client.c<{ t: number; wall: number; what: string }[]>('log')).filter((x) => x.wall >= wall0);
  const journal = await deskRun(`journalctl -u deskd --since @${Math.floor(at / 1000)} --no-pager -o short-iso | grep -E 'ready in|BootSequence|GatewayLink|hello|Started|Stopped|ERROR|WARN' | cut -c1-220 | tail -25`);
  note('7 recovered', {
    restartCommandSec: +((done - at) / 1000).toFixed(1),
    sessionLostAfterRestartSec: +((wall0 + (lostMs ?? 0) - at) / 1000).toFixed(1),
    sessionOpenAfterRestartSec: +((tOpen - at) / 1000).toFixed(1),
    firstFrameAfterRestartSec: +((tFrame - at) / 1000).toFixed(1),
    firstFrameAfterLossSec: +((tFrame - tLost) / 1000).toFixed(1),
    firstFrameAfterLiveMs: ff.firstCbMs, liveRpcMs: ff.rpcMs, fpsDecodedWhileScrollingAfter: fpsAfter, pagePxScrolledByInputOnNewSession: (afterMotion?.px ?? 0) - (beforeMotion?.px ?? 0),
    clockNote: 'AT and DONE are the desk clock, the rest the workstation clock; both NTP-disciplined, so about tens of ms apart at most',
    oldSession, newSession: again.sessionId, hello: again.hello, sessionMs: again.ms,
    lastDecodedBeforeLoss: lastFrame.video?.framesDecoded, connectionAtLoss: lastFrame.connection,
    units: after.units, stream: after.stream, sameChromium: after.units['desk-browser']?.pid === before.units['desk-browser']?.pid, sameTab: tabsAfter.some((t) => t.tabId === tabBefore), load: clientLoad(),
  });
  note('7 client log around the restart', log.slice(0, 30));
  note('7 deskd journal', journal.trim().split('\n'));

  expect(ff.firstCbMs, 'a frame on the new session').not.toBeNull();
  expect(fpsAfter, 'video keeps flowing').toBeGreaterThan(0);
  expect((afterMotion?.px ?? 0) - (beforeMotion?.px ?? 0), 'input works on the new session').toBeGreaterThan(0);
  expect.soft(after.units['desk-browser']?.pid, 'Chromium survives a deskd restart').toBe(before.units['desk-browser']?.pid);
  expect.soft(tabsAfter.some((t) => t.tabId === tabBefore), 'tab ids survive a deskd restart (API.md section 10)').toBe(true);
  expect.soft((again.hello as { resumed?: boolean }).resumed, 'resume state does not survive a restart (API.md section 3)').toBe(false);
});
