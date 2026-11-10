// W3's numbers for one desk, through the real Desk app and its real Browser window: t4g.medium at 1280x800 against c7g.large at
// 1920x1080. Identical scenarios on both, W3_RUNS passes (at least 3 for a verdict), every run reported. Page fps from the rAF
// callback is the verdict number; decoded fps sits beside it and isn't one. Nothing here judges: it records, and numbers.md says
// when RTT and client load rule out a latency verdict. Only what makes the numbers meaningless stops it: a wrong screen, input
// that doesn't land, someone else's stream. Writes numbers.json and numbers.md to ~/ma-design-drafts/w3/<label>/, after every run.
//
// See README.md here for how to run it. It skips unless W3_DESK is set.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { watch } from '../tests/lib';
import { B12, B13_MS, cpuBetween, localUdp, sleep, sum5, udpDelta } from '../tests/streamlib';
import { renderNumbers } from './numbers';
import { deployPages, makeClip, pageUrl, removePages } from './pages';
import { noSimpleView, BrowserWin, TestDesk, W3_ON, W3_SKIP, appVersion, channelHook, clientLoad, clientNumbers, installProbe, loadW3User, pageFps, pickDesk, signIn, rttMs, w3Input, type PageSample } from './w3lib';

test.skip(!W3_ON, W3_SKIP);
test.setTimeout(2 * 60 * 60_000);

const SCROLL_SECONDS = 60; // B11's own window
const MOTION_SECONDS = 30;
const STATIC_SECONDS = 15;

// One event, as a hard flick of a wheel sends it, and a burst of a frame's worth each, as a trackpad does. 8 clicks (960 px) is
// desk-rtc's wheelBatch and 20 (2400 px) its maxPerEvent, so 3600 shows that cap, the same on both.
const FLICKS: { name: string; single?: number; frames?: number; dy?: number }[] = [
  { name: '480 px', single: 480 }, { name: '960 px', single: 960 }, { name: '1200 px', single: 1200 }, { name: '1920 px', single: 1920 }, { name: '2400 px', single: 2400 }, { name: '3600 px', single: 3600 },
  { name: '20 frames of 120 px', frames: 20, dy: 120 }, { name: '40 frames of 120 px', frames: 40, dy: 120 },
];
const TYPED = 'The quick brown fox jumps over the lazy dog 0123456789';

test('W3 numbers for one desk', async ({ browser }) => {
  const inp = w3Input();
  const dir = join(inp.out, inp.label);
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report: any = { label: inp.label, startedAt: new Date().toISOString(), smoke: inp.runs < 3, input: { url: inp.url, userSsmPath: inp.userPath, deskId: inp.deskId, expectScreen: inp.expectScreen, runs: inp.runs, trials: inp.trials, video: inp.video }, runs: {}, notes: [] };
  const save = () => {
    writeFileSync(join(dir, 'numbers.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(dir, 'numbers.md'), renderNumbers(report));
  };
  const note = (s: string) => { report.notes.push(s); console.log(`[w3] ${s}`); };

  let desk = inp.deskId ? await TestDesk.resolve(inp.deskId) : null;
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(channelHook);
  await noSimpleView(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const consoleErrors: string[] = [];
  const w = watch(page);
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().replace(/[?#]\S*/g, '').slice(0, 200)); });
  await signIn(context, page, loadW3User(inp), inp.url);
  const deskId = await pickDesk(page, w, inp);
  desk ??= await TestDesk.resolve(deskId);
  await page.evaluate(installProbe);
  const bw = new BrowserWin(page, deskId);
  if (inp.level && inp.expectScreen) bw.deskWidth = Number(inp.expectScreen.split('x')[0]);
  const W = bw.W.bind(bw);
  const nonce = randomBytes(3).toString('hex');
  const d: TestDesk = desk;
  report.desk = { instance: d.instance, deskId, type: d.type, amiId: d.ami, az: d.az, tags: { DeskKind: d.tags.DeskKind, Env: d.tags.Env, Name: d.tags.Name } };
  report.client = { viewport: '1920x1080 at scale 1', chrome: browser.version(), appVersion: await appVersion(page), load: clientLoad() };
  save();

  /** One measured stretch: desk CPU either side, the client's getStats every second, and the page's reports in between. */
  const stretch = async (seconds: number) => {
    const cpu0 = await d.cpu();
    const udp0 = localUdp();
    const t0 = await W<number>('now');
    const ticks = await W('segment', { seconds });
    const t1 = await W<number>('now');
    const udp1 = localUdp();
    const cpu1 = await d.cpu();
    return { page: pageFps(await W<string[]>('titlesBetween', [t0, t1])), client: { ...clientNumbers(ticks), workstationUdp: udpDelta(udp0, udp1) }, deskCpu: cpuBetween(cpu0, cpu1), clientLoad: clientLoad() };
  };
  const showPage = async (path: string, ready: (s: PageSample) => boolean = () => true, settleMs = 1500) => {
    await bw.go(pageUrl(`${path}${path.includes('?') ? '&' : '?'}n=${nonce}`));
    const s = await bw.report<PageSample>((x) => x.n === nonce && x.vis === 'visible' && ready(x), 30_000);
    if (!s || s.n !== nonce) throw new Error(`${path} didn't report on screen: ${await bw.activeTab.getAttribute('title')}`);
    await sleep(settleMs);
    return s;
  };

  try {
    // ---- Preflight: nobody else's stream, and what's on this desk.
    const unitsBefore = await d.units();
    report.desk.info = await d.info();
    report.desk.creditsAtStart = await d.credits();
    report.preflight = { stream: unitsBefore.stream, health: unitsBefore.healthStatus, units: unitsBefore.units };
    if (unitsBefore.stream?.wanted === 'live' && !inp.allowBusy) throw new Error('another viewer is streaming on this desk, which would change every number. Wait, or W3_ALLOW_BUSY=1');
    const leftover = await deployPages(d);
    if (leftover) note(`closed ${leftover} tab(s) a cut-off W3 run had left open on its pages: each had been loading the desk until now, so this run's credits at start may be lower than usual`);
    report.clip = await makeClip(d, inp.video);
    const haveClip = report.clip.kind === 'generated' || report.clip.kind === 'url';
    if (report.clip.kind === 'failed') note(`no clip for the video page: ${report.clip.error}`);
    if (report.clip.kind === 'generated') note(`the video page plays a synthetic clip made on the desk, not real footage: harder to encode than real footage, so its bitrate and CPU don't read directly against the real-stack report's Big Buck Bunny rows`);
    save();

    // ---- The first open on this boot. Cold-root slowness is a finding of its own and goes in no average.
    const chromiumWasRunning = unitsBefore.units['desk-browser']?.active === 'active';
    const tClick = await bw.open();
    await bw.waitPicture(300_000);
    const pictureAfterMs = Date.now() - tClick;
    await bw.waitTabs(300_000);
    const tabsAfterMs = Date.now() - tClick;
    await bw.newTab();
    const [openMark] = (await W<number[]>('marks', 'ma:window-open:browser')).slice(-1);
    const [frameMark] = (await W<number[]>('marks', 'ma:browser-first-frame')).slice(-1);
    report.firstOpen = { chromiumWasRunning, xorgWasRunning: unitsBefore.units['desk-xorg']?.active === 'active', bootedAt: report.desk.info.bootedAt, firstFrameMs: frameMark && openMark ? +(frameMark - openMark).toFixed(0) : null, pictureAfterMs, chromiumReachableAfterMs: tabsAfterMs, deskdTiming: await d.streamTimings() };
    if (chromiumWasRunning) note('Chromium was already running on this boot, so this desk gave no cold first-open number');
    save();

    // ---- W3_LEVEL=low|medium|high|max: the picture quality, chosen in the window's own menu (ADR 0039). The account's setting is put back at the end.
    if (inp.level) {
      await bw.win.getByTestId('quality-button').click();
      await bw.win.getByRole('menuitemradio', { name: new RegExp(`^${inp.level}\\b`, 'i') }).click();
      await sleep(4000);
      report.level = inp.level;
      note(`the picture quality was set to ${inp.level} in the window's menu for this run`);
      save();
    }

    // ---- The screen, the window and the stream agree, and input lands. A run at the wrong size can't be a benchmark.
    const shown = await showPage('targets.html', (s) => !!s.tg); // report.js publishes once before the page's own script has run
    const pic = await bw.picture();
    const screen = `${shown.sw}x${shown.sh}`, viewport = `${shown.iw}x${shown.ih}`, stream = `${pic.vw}x${pic.vh}`;
    const clicks: Record<string, unknown> = {};
    const slack = Math.ceil(1 / pic.scale) + 1;
    let landed = true;
    for (const [id, [x, y]] of Object.entries(shown.tg as Record<string, [number, number]>)) {
      await bw.clickDesk(pic, x, y);
      const got = await bw.report<PageSample & { c: Record<string, number>; l: [string, number, number] }>((s) => (s.c?.[id] ?? 0) >= 1, 6000);
      const ok = got?.l?.[0] === id && Math.abs((got?.l?.[1] ?? -99) - x) <= slack && Math.abs((got?.l?.[2] ?? -99) - y) <= slack;
      clicks[id] = { aimed: [x, y], landed: got?.l, ok };
      landed &&= ok;
    }
    report.screen = { screen, viewport, stream, dpr: shown.dpr, expected: inp.expectScreen, clicks, xrandr: (await d.info()).xrandr, picture: pic };
    save();
    if (screen !== viewport || (!inp.level && screen !== stream)) throw new Error(`the screen ${screen}, the page ${viewport} and the stream ${stream} should be the same size`);
    if (inp.expectScreen && (inp.level ? screen : stream) !== inp.expectScreen) throw new Error(`W3_EXPECT_SCREEN is ${inp.expectScreen}, and this desk streams ${stream}`);
    if (!landed) throw new Error(`clicks didn't land where aimed at this size: ${JSON.stringify(clicks)}`);

    // ---- One pass through everything, unmeasured, so round 1 isn't the first read of these files from a lazy root.
    const warmed: Record<string, unknown> = {};
    for (const p of ['article.html', 'scroll.html', 'motion.html', 'latency.html', 'typing.html', ...(haveClip ? ['video.html'] : [])]) {
      const t = Date.now();
      await showPage(p, () => true, 3000);
      warmed[p] = Date.now() - t - 3000;
    }
    report.warmup = { pageReportedAfterMs: warmed };
    await showPage('article.html', () => true, 1000); // the warm-up ends on the video, and this baseline is an idle page
    await sleep(20_000);
    report.baseline = await stretch(5);
    save();

    // ---- The scenarios.
    const scenarios: Record<string, () => Promise<Record<string, unknown>>> = {
      static: async () => { await showPage('article.html', () => true, 3000); return stretch(STATIC_SECONDS); },

      scroll: async () => {
        await showPage('scroll.html');
        await W('wheelStart');
        await sleep(2000); // past any first long frame
        const r = await stretch(SCROLL_SECONDS);
        return { ...r, pxSent: await W<number>('wheelStop') };
      },

      flick: async () => {
        await showPage('scroll.html?flick=1');
        await bw.moveOver(await bw.picture());
        /** Scrolled and settled: two reports at least 900 ms apart, at the same place. */
        const settled = async () => {
          let prev: PageSample | null = null;
          const t0 = Date.now();
          while (Date.now() - t0 < 12_000) {
            const before: PageSample | null = prev;
            const s: PageSample | null = await bw.report<PageSample>((x) => !before || x.t >= before.t + 900, 3000);
            if (s && before && s.y === before.y) return s;
            prev = s;
          }
          return prev;
        };
        const t0 = await W<number>('now');
        const flicks: Record<string, unknown>[] = [];
        for (const f of FLICKS) {
          const before = await settled();
          const y0 = before?.y ?? NaN;
          const wheels = Number(before?.wc ?? 0);
          if (f.single) await page.mouse.wheel(0, f.single); else await W('wheelBurst', { frames: f.frames, dy: f.dy });
          // A title can arrive a second late. Wait for one that has seen this flick, or an old report could pass as settled.
          await bw.report<PageSample>((x) => Number(x.wc ?? 0) > wheels, 8000);
          const y1 = (await settled())?.y ?? NaN;
          const sent = f.single ?? f.frames! * f.dy!;
          // desk-rtc turns pixels into 120 px clicks and keeps the remainder, so up to 119 px either way isn't a shortfall.
          const reachable = f.single ? Math.min(Math.floor(sent / 120), 20) * 120 : sent;
          flicks.push({ flick: f.name, sent, reachable, travelled: y1 - y0, shortBy: reachable - (y1 - y0), clicks: +((y1 - y0) / 120).toFixed(1), y0 });
        }
        const t1 = await W<number>('now');
        return { flicks, page: pageFps(await W<string[]>('titlesBetween', [t0, t1])), clientLoad: clientLoad(), rttMs: rttMs(await W('stats')) };
      },

      motion: async () => { await showPage('motion.html', () => true, 3000); return stretch(MOTION_SECONDS); },

      video: async () => {
        if (!haveClip) return { skipped: `no clip: ${report.clip.kind}` };
        await showPage('video.html', (s) => Number(s.vf) > 0, 5000);
        const r = await stretch(MOTION_SECONDS);
        const a = r.page.first, b = r.page.last;
        const secs = a && b ? (b.t - a.t) / 1000 : 0;
        return { ...r, video: a && b && secs ? { presentedFps: +((Number(b.vp) - Number(a.vp)) / secs).toFixed(1), callbackFps: +((Number(b.vf) - Number(a.vf)) / secs).toFixed(1), decodedFps: +((Number(b.vq) - Number(a.vq)) / secs).toFixed(1), dropped: Number(b.vd) - Number(a.vd), paused: b.vpause, error: b.verr, size: `${b.vw}x${b.vh}` } : null };
      },

      typing: async () => {
        const s = await showPage('typing.html', (x) => Number(x.ix) > 0);
        await bw.clickDesk(await bw.picture(), Number(s.ix), Number(s.iy));
        await expect(bw.keys, 'the stream has the keyboard').toBeFocused({ timeout: 5000 });
        const focused = await bw.report<PageSample>((x) => x.fo === 1, 5000);
        await W('setRead', true);
        await sleep(500);
        await W('clearResults');
        const t0 = await W<number>('now');
        let misses = 0;
        // A fast typist, about 80 words a minute, with each key's trip timed.
        for (const ch of TYPED) {
          await sleep(110 + Math.random() * 80);
          const n = await W<number>('resultCount');
          await W('arm');
          await page.keyboard.type(ch);
          const t = Date.now();
          while (Date.now() - t < 400 && (await W<number>('resultCount')) <= n) await sleep(10);
          if ((await W<number>('resultCount')) <= n) { misses++; await W('disarm'); }
        }
        const t1 = await W<number>('now');
        const paced = await bw.report<PageSample>((x) => x.v === TYPED, 4000);
        const results = await W<{ cb: number }[]>('results');
        await W('setRead', false);
        // Then as fast as a key can go: did every character land, in order?
        await page.keyboard.press('Enter');
        await bw.report<PageSample>((x) => x.v === '', 4000);
        await page.keyboard.type(TYPED, { delay: 40 });
        const burst = await bw.report<PageSample>((x) => x.v === TYPED, 6000);
        return { focused: focused?.fo === 1, chars: TYPED.length, keyToScreenMs: sum5(results.map((r) => r.cb)), misses, pacedTextRight: paced?.v === TYPED, pacedGot: paced?.v, burstGapMs: 40, burstTextRight: burst?.v === TYPED, burstGot: burst?.v, page: pageFps(await W<string[]>('titlesBetween', [t0, t1])), clientLoad: clientLoad(), rttMs: rttMs(await W('stats')) };
      },

      latencyIdle: () => latencyPass('latency.html', 'idle'),
      latencyLoaded: () => latencyPass(haveClip ? 'latency.html?load=video' : 'latency.html?load=1', haveClip ? 'the clip playing at 520x292' : 'an animated 520x292 canvas'),

      warmToLive: async () => {
        await showPage('scroll.html');
        const off = await W('setStream', 'warm');
        if (!off.ok) throw new Error(`browser.stream.set warm: ${off.code}`);
        await sleep(2000);
        const switches: { rpcMs: number; firstCbMs: number | null; error?: string }[] = [];
        for (let i = 0; i < 13; i++) {
          await sleep(600 + Math.random() * 400);
          switches.push(await W('firstFrame', { state: 'live', waitMs: 8000 }));
          await sleep(300);
          await W('setStream', i === 12 ? 'live' : 'warm');
        }
        const scored = switches.slice(1); // as proof2.mjs: the first comes after the longer warm above
        return { firstFrameMs: sum5(scored.map((r) => r.firstCbMs)), rpcMs: sum5(scored.map((r) => r.rpcMs)), everySwitchMs: scored.map((r) => r.firstCbMs), firstOfThePass: switches[0].firstCbMs, misses: scored.filter((r) => r.firstCbMs === null).length, errors: switches.filter((r) => r.error).length, budgetMs: B13_MS, clientLoad: clientLoad(), rttMs: rttMs(await W('stats')) };
      },

      // Closing the window asks for `off`, so each open starts desk-stream again. Time from the open's first mark to the app's first frame.
      firstFrame: async () => {
        const opens: { firstFrameMs: number | null; pictureAfterMs: number }[] = [];
        for (let i = 0; i < 3; i++) {
          await bw.close();
          await sleep(1200 + Math.random() * 400);
          const clicked = await bw.open();
          await bw.waitPicture(60_000);
          const after = Date.now() - clicked;
          const [open] = (await W<number[]>('marks', 'ma:window-open:browser')).slice(-1);
          await expect.poll(async () => (await W<number[]>('marks', 'ma:browser-first-frame')).slice(-1)[0] > open, { timeout: 20_000 }).toBe(true);
          const [frame] = (await W<number[]>('marks', 'ma:browser-first-frame')).slice(-1);
          opens.push({ firstFrameMs: +(frame - open).toFixed(0), pictureAfterMs: after });
        }
        return { opens, clientLoad: clientLoad(), rttMs: rttMs(await W('stats')) };
      },
    };

    /** stream.spec.ts' latencyPass, through the app's window: a real key press into the app's own textarea. */
    async function latencyPass(path: string, load: string) {
      await showPage(path, () => true, 2000);
      await bw.clickDesk(await bw.picture(), 8, 8);
      await expect(bw.keys, 'the stream has the keyboard').toBeFocused({ timeout: 5000 });
      await W('setRead', true);
      await sleep(500);
      await W('clearResults');
      const kd0 = Number((await bw.report<PageSample>())?.kd ?? 0);
      const cpu0 = await d.cpu();
      const s0 = await W('stats');
      const rtts: (number | null)[] = [];
      let misses = 0;
      for (let i = 0; i < inp.trials; i++) {
        await sleep(250 + Math.random() * 300);
        await W('arm');
        const n = await W<number>('resultCount');
        await page.keyboard.press('x');
        const t = Date.now();
        while (Date.now() - t < 2000 && (await W<number>('resultCount')) <= n) await sleep(15);
        if ((await W<number>('resultCount')) <= n) { misses++; await W('disarm'); }
        await sleep(60);
        if (i % 10 === 0) rtts.push(rttMs(await W('stats')));
      }
      const results = await W<{ cb: number; display: number; recv: number | null }[]>('results');
      const s1 = await W('stats');
      const cpu1 = await d.cpu();
      await W('setRead', false);
      await sleep(1200);
      const kd = Number((await bw.report<PageSample>())?.kd ?? 0);
      return {
        load, trials: inp.trials, detected: results.length, misses, keydownsSeenByThePage: kd - kd0, aligned: kd - kd0 === inp.trials,
        callbackMs: sum5(results.map((r) => r.cb)), displayMsNotTheNumber: sum5(results.map((r) => r.display)), lastPacketMs: sum5(results.map((r) => r.recv)), everyTrialMs: results.map((r) => +r.cb.toFixed(1)), iceRttMs: sum5(rtts),
        jitterBufferMs: +((1000 * (s1.video.jitterBufferDelay - s0.video.jitterBufferDelay)) / Math.max(1, s1.video.jitterBufferEmittedCount - s0.video.jitterBufferEmittedCount)).toFixed(1),
        decodeMs: +((1000 * (s1.video.totalDecodeTime - s0.video.totalDecodeTime)) / Math.max(1, s1.video.framesDecoded - s0.video.framesDecoded)).toFixed(1),
        dropped: s1.video.framesDropped - s0.video.framesDropped, freezes: s1.video.freezeCount - s0.video.freezeCount, packetsLost: s1.video.packetsLost - s0.video.packetsLost, nacks: s1.video.nackCount - s0.video.nackCount, plis: s1.video.pliCount - s0.video.pliCount,
        deskCpu: cpuBetween(cpu0, cpu1), clientLoad: clientLoad(), budget: B12,
      };
    }

    // Rounds, not one scenario three times over, so a desk that drifts (credits, a slow root) shows across every scenario.
    for (let round = 1; round <= inp.runs; round++) {
      for (const [name, fn] of Object.entries(scenarios)) {
        if (inp.only && !inp.only.includes(name)) continue;
        report.runs[name] ??= [];
        const started = new Date().toISOString();
        try {
          report.runs[name].push({ round, started, ...(await fn()) });
          console.log(`[w3] round ${round} ${name}: done`);
        } catch (e) {
          report.runs[name].push({ round, started, error: String(e).slice(0, 400) });
          console.log(`[w3] round ${round} ${name} FAILED: ${String(e).slice(0, 400)}`);
          // A failure can leave the stream `warm` or the window closed, and the next scenario shouldn't inherit that.
          await W('setStream', 'live').catch(() => {});
          if (!(await bw.win.isVisible().catch(() => false))) { await bw.open().catch(() => {}); await bw.waitPicture(60_000).catch(() => {}); }
        }
        save();
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.consoleErrors = consoleErrors.slice(-30);
    report.client.loadAtEnd = clientLoad();
    if (inp.level && inp.level !== 'high') { await bw.win.getByTestId('quality-button').click().catch(() => {}); await bw.win.getByRole('menuitemradio', { name: /^high\b/i }).click().catch(() => {}); await sleep(1000); }
    await bw.closeOwnTab().catch(() => {});
    await bw.close().catch(() => {});
    await sleep(2000);
    report.desk.creditsAtEnd = await d.credits().catch(() => null);
    report.desk.infoAtEnd = await d.info().catch(() => null);
    report.desk.deskdTimingAtEnd = await d.streamTimings().catch(() => null);
    await removePages(d).catch((e) => note(`removePages failed: ${String(e).slice(0, 200)}`));
    save();
    await context.close();
    console.log(`[w3] numbers: ${join(dir, 'numbers.md')}`);
  }
});
