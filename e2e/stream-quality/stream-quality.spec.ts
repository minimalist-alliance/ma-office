// Stream quality levels on the test desk (task 29, ADR 0039 section 1, stream-quality.md sections 3 to 5). One live session; the
// level is switched in it, with no reconnect, by test-only injection: an init script keeps the session's `keys` channel, and the
// page sends QUALITY (type 7) on it and records the desk's replies (0x82), as the Desk app's menu will.
//
// Per level, in the order of SQ_LEVELS (High first and last, so run-to-run noise shows):
//   switch:  QUALITY while the clip plays; the reply, the first keyframe after it, and the first frame at the new size
//   video:   the 1080p60 clip full screen in the desk's Browser, SQ_VIDEO_S seconds: video and audio bytes, decoded fps, size,
//            the desk page's rAF fps, the clip's dropped frames, desk CPU
//   scroll:  stream.spec.ts' scroll page under the same wheel, SQ_SCROLL_S seconds: the same numbers
//   still:   the same page left alone, SQ_STILL_S seconds
//   input:   stream.spec.ts test 6's method, SQ_TRIALS keydowns on its latency page (and SQ_LOADED=1: its loaded page too)
//
// Same path as stream.spec.ts and av-sync: desk-1 through Platform's real API and gateway to the staging test desk, with
// streamlib.ts' client. It runs only when SQ_LABEL is set. Hold ~/work/.test-desk.lock around it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { APP, DESK_ID, INSTANCE, apiToken, loadUser, assertTestDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, cpuBetween, deskCpu, deskRun, deskVersions, nx, ny, sleep, sum5, titleState } from '../tests/streamlib';
import { LEVEL, type LevelName, type Tick, deploySq, deskProcs, installSq, keepKeys, pageFps, rates, removeSq, showSq } from './sqlib';

const LABEL = process.env.SQ_LABEL ?? '';
const ORDER = (process.env.SQ_LEVELS ?? 'high,low,medium,max,high').split(',').map((s) => s.trim()) as LevelName[];
const VIDEO_S = Number(process.env.SQ_VIDEO_S ?? 45);
const SCROLL_S = Number(process.env.SQ_SCROLL_S ?? 30);
const STILL_S = Number(process.env.SQ_STILL_S ?? 20);
const TRIALS = Number(process.env.SQ_TRIALS ?? 30);
const LOADED = process.env.SQ_LOADED === '1';
/** The whole run's time budget: a level that wouldn't fit (judged by the last one's length) isn't started, so cleanup always runs. */
const BUDGET_S = Number(process.env.SQ_BUDGET_S ?? 1500);
const CLIP = process.env.SQ_CLIP ?? join(import.meta.dirname, 'results', 'clip.webm');
const OUT = join(import.meta.dirname, 'results', `${LABEL}.json`);
/** The desk's screen. Low fits 1280x720 (stream.conf [level.low] max-height = 720). */
const FULL: [number, number] = [1920, 1080];
const SIZE: Record<LevelName, [number, number]> = { low: [1280, 720], medium: FULL, high: FULL, max: FULL };

test.skip(!LABEL, 'SQ_LABEL is not set: this measures a desk, and runs only when asked (README.md here).');

type Title = Record<string, number> & { n?: string; vis?: string; err?: string };
const C = <T = unknown>(client: DeskClient, fn: string, arg?: unknown) => client.page.evaluate(([f, a]) => (window as unknown as Record<string, Record<string, (x: unknown) => unknown>>).SQ[f as string](a), [fn, arg] as const) as Promise<T>;

test('stream quality levels: switch time, data, fps and input-to-screen at Low, Medium, High and Max', async ({ browser }) => {
  test.setTimeout(40 * 60_000);
  assertTestDesk(); // the staging test desk only
  for (const l of ORDER) if (!(l in LEVEL)) throw new Error(`unknown level in SQ_LEVELS: ${l}`);
  mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
  const report: Record<string, unknown> = { label: LABEL, startedAt: new Date().toISOString(), order: ORDER, seconds: { video: VIDEO_S, scroll: SCROLL_S, still: STILL_S }, trials: TRIALS, loaded: LOADED, client: { cores: cpus().length, loadavg1m: +loadavg()[0].toFixed(2) } };
  const levels: Record<string, unknown>[] = [];
  report.levels = levels;
  const save = () => writeFileSync(OUT, JSON.stringify(report, null, 2));
  const note = (k: string, v: unknown) => { report[k] = v; console.log(`[sq] ${k}: ${JSON.stringify(v).slice(0, 400)}`); save(); };
  const log = (s: string) => console.log(`[sq] ${new Date().toISOString().slice(11, 19)} ${s}`);
  const startedAt = report.startedAt as string;

  note('desk', { instance: INSTANCE, deskId: DESK_ID, ...(await deskVersions()) });
  note('desk before', await deskProcs());
  note('pages on the desk', await deploySq(CLIP));

  const nonce = randomBytes(3).toString('hex');
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const bearer = await apiToken(context, loadUser('desk-1'));
  await context.addInitScript(keepKeys);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  const client = new DeskClient(page, bearer, nonce);
  await client.init();
  let aborted: string | null = null;
  try {
    let opened = await client.open(false);
    for (let i = 0; !opened.ok && i < 20; i++) { await sleep(3000); opened = await client.open(false); }
    if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code, type: opened.type })}`);
    note('session', { ms: opened.ms, hello: opened.hello });
    expect(await page.evaluate(installSq), 'the keys channel was kept by the init script').toBe(true);
    await client.ensureLive();
    await sleep(1500);
    note('quality replies on viewing', await C(client, 'replies'));
    note('ctl PING to PONG', sum5(await client.c<number[]>('pingRtt', 15)));

    const readTitle = (tag: string) => client.readTitle<Title>(tag);
    const waitTitle = (tag: string, ok: (s: Title) => boolean, ms = 15_000) => client.waitTitle<Title>(tag, ok, ms);
    const titlesBetween = async (tag: string, t0: number, t1: number) => (await client.c<{ t: number; tabs: { tabId: string; title: string }[] }[]>('titles'))
      .filter((x) => x.t >= t0 && x.t <= t1).map((x) => titleState<Title>(x.tabs.find((y) => y.tabId === client.testTabId)?.title, tag));

    /** One measured stretch: getStats each second in the client, the page's title reports and desk CPU around it. */
    const measure = async (tag: string, seconds: number) => {
      const cpu0 = await deskCpu();
      const first = await readTitle(tag);
      const t0 = await client.c<number>('now');
      const ticks = await C<Tick[]>(client, 'segment', { seconds });
      const t1 = await client.c<number>('now');
      const last = await readTitle(tag);
      const cpu1 = await deskCpu();
      const fps = pageFps([first, ...(await titlesBetween(tag, t0, t1)), last]);
      return { client: rates(ticks), deskPage: { ...fps, visibility: last?.vis }, deskCpu: cpuBetween(cpu0, cpu1) };
    };

    let lastLevelS = 0;
    for (let i = 0; i < ORDER.length; i++) {
      const name = ORDER[i];
      const elapsedS = (Date.now() - Date.parse(startedAt)) / 1000;
      if (elapsedS + lastLevelS + 90 > BUDGET_S) { aborted = `time budget: ${Math.round(elapsedS)} s used of ${BUDGET_S}, a level takes about ${Math.round(lastLevelS)} s; stopped before ${name} (run ${i + 1} of ${ORDER.length})`; log(aborted); break; }
      const tLevel = Date.now();
      const run: Record<string, unknown> = { level: name, run: ORDER.slice(0, i + 1).filter((x) => x === name).length, startedAt: new Date().toISOString() };
      levels.push(run);
      log(`level ${name} (run ${run.run})`);
      const procs0 = await deskProcs();

      // ---- The clip, then the switch while it plays ----
      await showSq(client, 'video.html', nonce);
      const loaded = await waitTitle('V', (s) => s.n === nonce);
      if (!loaded) throw new Error(`the video page didn't load: ${client.lastRawTitle.slice(0, 80)}`);
      const centre = { x: nx(960), y: ny(540) };
      await client.c('event', { type: 'BUTTON', down: true, button: 1, ...centre });
      await sleep(40);
      await client.c('event', { type: 'BUTTON', down: false, button: 1, ...centre });
      const playing = await waitTitle('V', (s) => s.n === nonce && s.play === 1 && s.muted === 0 && s.ct > 500);
      run.videoPage = playing ? { play: playing.play, muted: playing.muted, err: playing.err } : { error: 'not playing with sound', last: client.lastRawTitle.slice(0, 120) };
      await sleep(2000);
      // The level the desk last said it runs at. Asking for that same level changes nothing (no reply, no keyframe), so the switch
      // is then marked as such and its keyframe time, which could only be the stream's own 4 s keyframe, isn't a switch time.
      const inEffect = (await C<{ level: number }[]>(client, 'replies')).at(-1)?.level ?? LEVEL.high;
      const noChange = inEffect === LEVEL[name];
      run.switch = { noChange, inEffectBefore: inEffect, ...(await C<Record<string, unknown>>(client, 'switchTo', { level: LEVEL[name], expect: SIZE[name], waitMs: noChange ? 1500 : 8000 })) };
      save();
      log(`switch ${JSON.stringify(run.switch).slice(0, 220)}`);
      // A level that brings no picture stops the run (and the caller rolls back): frames must keep decoding at the expected size.
      await sleep(2500);
      const chk = await C<Tick[]>(client, 'segment', { seconds: 2 });
      const dec = (chk[2].video?.fd ?? 0) - (chk[0].video?.fd ?? 0);
      const size = `${chk[2].video?.fw}x${chk[2].video?.fh}`;
      run.afterSwitch = { decodedIn2s: dec, size };
      if (dec < 20) { aborted = `no picture after switching to ${name}: ${dec} frames decoded in 2 s`; break; }
      if (size !== SIZE[name].join('x')) run.sizeMismatch = `expected ${SIZE[name].join('x')}, got ${size}`;

      run.video = await measure('V', VIDEO_S);
      save();
      log(`video ${JSON.stringify((run.video as { client: unknown }).client).slice(0, 200)}`);

      // ---- Scrolling, then the same page left alone ----
      await showSq(client, 'scroll.html', nonce);
      if (!(await waitTitle('R', (s) => s.n === nonce && s.vis === 'visible'))) throw new Error('the scroll page did not load');
      await sleep(1500);
      await client.c('wheelStart');
      await sleep(2000);
      run.scroll = await measure('R', SCROLL_S);
      run.scrollPxSentByClient = await client.c<number>('wheelStop');
      save();
      log(`scroll ${JSON.stringify((run.scroll as { client: unknown }).client).slice(0, 200)}`);
      await sleep(3000); // the last wheel's smooth scroll settles
      run.still = await measure('R', STILL_S);
      save();
      log(`still ${JSON.stringify((run.still as { client: unknown }).client).slice(0, 200)}`);

      // ---- Input to screen: stream.spec.ts test 6's method ----
      const latency = async (path: string) => {
        await showSq(client, path, nonce);
        await waitTitle('R', (s) => s.n === nonce && s.vis === 'visible');
        await sleep(2000);
        await client.c('clearResults');
        await page.bringToFront();
        const kd0 = (await readTitle('R'))?.kd ?? 0;
        const rtts: number[] = [];
        let misses = 0;
        for (let k = 0; k < TRIALS; k++) {
          await sleep(250 + Math.random() * 300);
          await client.c('arm');
          const n = await client.c<number>('resultCount');
          await page.keyboard.press('x');
          const t = Date.now();
          while (Date.now() - t < 2000 && (await client.c<number>('resultCount')) <= n) await sleep(15);
          if ((await client.c<number>('resultCount')) <= n) { misses++; await client.c('disarm'); }
          await sleep(60);
          if (k % 5 === 0) { const s = await C<Tick>(client, 'sample'); if (s.pair?.rtt) rtts.push(+(s.pair.rtt * 1000).toFixed(1)); }
        }
        const res = await client.c<{ cb: number; display: number; recv: number | null }[]>('results');
        await sleep(1200);
        const kd = (await readTitle('R'))?.kd ?? 0;
        return { trials: TRIALS, detected: res.length, misses, keydownsSeenByThePage: kd - kd0, callbackMs: sum5(res.map((r) => r.cb)), displayMs: sum5(res.map((r) => r.display)), lastPacketMs: sum5(res.map((r) => r.recv)), iceRttMs: sum5(rtts), raw: res.map((r) => +r.cb.toFixed(1)) };
      };
      run.input = await latency('latency.html');
      log(`input ${JSON.stringify(run.input).slice(0, 200)}`);
      if (LOADED) run.inputLoaded = await latency('latency.html?load=1');
      run.desk = { before: procs0, after: await deskProcs() };
      run.endedAt = new Date().toISOString();
      lastLevelS = (Date.now() - tLevel) / 1000;
      run.seconds = Math.round(lastLevelS);
      save();
      const u0 = (procs0.units as Record<string, { pid: number; restarts: number }>)['desk-stream'], u1 = ((run.desk as { after: { units: Record<string, { pid: number; restarts: number }> } }).after.units)['desk-stream'];
      if (u0 && u1 && (u0.pid !== u1.pid || u0.restarts !== u1.restarts)) { aborted = `desk-stream restarted during ${name}: pid ${u0.pid} to ${u1.pid}, restarts ${u0.restarts} to ${u1.restarts}`; break; }
    }
    note('aborted', aborted);
    note('quality replies, all', await C(client, 'replies'));
    note('sizes seen', await C(client, 'sizes'));
  } finally {
    // Leave the level at High (what a desk runs with nobody asking), then as stream.spec.ts: the tab closed, the stream off, the session closed.
    await C(client, 'send', LEVEL.high).catch(() => null);
    await sleep(800);
    note('finish', await client.finish().catch((e: Error) => ({ error: e.message.slice(0, 200) })));
    await context.close();
    note('client page errors', consoleErrors.slice(-10));
    note('removed from the desk', (await removeSq().catch((e: Error) => e.message.slice(0, 200))).trim());
    const since = new Date(Date.parse(startedAt) - 5000).toISOString().replace('T', ' ').slice(0, 19);
    const journal = await deskRun(`journalctl -u desk-stream -u desk-rtc --since '${since} UTC' --no-pager -o short-iso | grep -iE 'level|limit|WARN|ERROR|unknown command|Failed|Started|Stopped' | sed -E 's/^(\\S+) \\S+ /\\1 desk /' | cut -c1-220 | tail -60`).catch((e: Error) => e.message);
    note('desk journal: level lines and warnings', journal.trim().split('\n').filter(Boolean));
    note('desk after', await deskProcs().catch((e: Error) => ({ error: e.message.slice(0, 200) })));
    note('endedAt', new Date().toISOString());
  }
  expect(aborted, 'every level ran, kept a picture, and desk-stream never restarted').toBeNull();
  for (const r of levels) {
    expect.soft((r.switch as { sent?: boolean } | undefined)?.sent, `${r.level}: QUALITY sent`).toBe(true);
    expect.soft(((r.input as { detected?: number } | undefined)?.detected ?? 0), `${r.level}: input reached the screen`).toBeGreaterThanOrEqual(TRIALS - 2);
  }
});
