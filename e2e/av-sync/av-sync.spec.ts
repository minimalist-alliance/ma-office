// Sound and picture, desk to member (task 23). The desk's Chromium plays a clip with a white box and a 1 kHz tone on the same
// instant once a second. The desk records when each shows on its own screen and in its own sound (sampler.py); a client here
// records when each reaches it (avlib.ts' probe). That gives the picture's delay, the sound's delay and the gap between them,
// over 80 events, plus input-to-screen and frame rate while the clip plays, and what Chrome's getStats says about its buffers.
//
// Same path as stream.spec.ts: desk-1 through Platform's real API and gateway to the staging test desk, with streamlib.ts' client.
// It runs only when AV_LABEL is set, and only on the staging test desk. Hold ~/work/.test-desk.lock around it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { APP, DESK_ID, INSTANCE, apiToken, loadUser, assertTestDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, cpuBetween, deskCpu, deskRun, deskVersions, nx, ny, sleep } from '../tests/streamlib';
import {
  SPOT, capturePcs, counterSteps, deployAv, deskClock, flashOnsets, installHold, installProbe, localClock, pageUrl, pairs, readSampler, removeAv, startSampler, stats,
  type Frame, type SamplerOut,
} from './avlib';
import { HOLD, PictureHold } from '../../web/src/desk/rtc/pictureHold';

const LABEL = process.env.AV_LABEL ?? '';
const SECONDS = Number(process.env.AV_SECONDS ?? 80);
const TRIALS = Number(process.env.AV_TRIALS ?? 60);
const CLIP = process.env.AV_CLIP ?? join(import.meta.dirname, 'results', 'sync.webm');
const OUT = join(import.meta.dirname, 'results', `${LABEL}.json`);
// AV_HOLD=1 runs the Desk app's picture hold in the probe page (web/src/desk/rtc/pictureHold.ts), as the app would.
const HOLDING = process.env.AV_HOLD === '1';

test.skip(!LABEL, 'AV_LABEL is not set: this measures a desk, and runs only when asked (README.md here).');

type SyncState = { n: string; vis: string; f: number; t: number; play: number; ct: number; dropped: number; total: number; kd: number; lf: number; err: string };

test('sound and picture from the desk to the client: delays, the gap, input-to-screen and fps while the clip plays', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  assertTestDesk(); // the staging test desk only
  mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
  const report: Record<string, unknown> = { label: LABEL, startedAt: new Date().toISOString(), client: { cores: cpus().length, loadavg1m: +loadavg()[0].toFixed(2) } };
  const note = (k: string, v: unknown) => { report[k] = v; console.log(`[av] ${k}: ${JSON.stringify(v).slice(0, 400)}`); writeFileSync(OUT, JSON.stringify(report, null, 2)); };

  note('desk', { instance: INSTANCE, deskId: DESK_ID, ...(await deskVersions()) });
  note('clip on the desk', await deployAv(CLIP, join(import.meta.dirname, 'sampler.py')));

  const nonce = randomBytes(3).toString('hex');
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const bearer = await apiToken(context, loadUser('desk-1'));
  await context.addInitScript(capturePcs);
  const page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  const client = new DeskClient(page, bearer, nonce);
  await client.init();
  try {
    let opened = await client.open(false);
    for (let i = 0; !opened.ok && i < 20; i++) { await sleep(3000); opened = await client.open(false); }
    if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code, type: opened.type })}`);
    note('session', { ms: opened.ms, tracks: opened.tracks, extmap: (opened.sdp as { extmap: unknown }).extmap });
    await client.ensureLive();

    // The page, in this run's own tab, as DeskClient.show does for stream.spec.ts' pages.
    const url = `${pageUrl('sync.html')}?n=${nonce}`;
    const tab = await client.rpc<{ tabId: string }>('browser.tab.open', { url }, { idem: true });
    client.testTabId = tab.tabId;
    if ((await client.tabs()).find((t) => t.tabId === tab.tabId)?.active !== true) await client.rpc('browser.tab.activate', { tabId: tab.tabId }, { idem: true });
    const loaded = await client.waitTitle<SyncState>('S', (s) => s.n === nonce, 20_000);
    expect(loaded, 'the sync page loaded in the desk Browser').not.toBeNull();
    // A click starts the clip with sound, as a member's would: the kiosk has no autoplay flag.
    const centre = { x: nx(960), y: ny(540) };
    await client.c('event', { type: 'BUTTON', down: true, button: 1, ...centre });
    await sleep(40);
    await client.c('event', { type: 'BUTTON', down: false, button: 1, ...centre });
    const playing = await client.waitTitle<SyncState>('S', (s) => s.play === 1 && s.ct > 0, 15_000);
    note('desk page playing', playing);
    expect(playing?.play, 'the clip plays in the desk Browser').toBe(1);

    note('probe', await page.evaluate(installProbe, { flash: SPOT.flash, square: SPOT.square, bitsY: SPOT.bitsY, bitXs: Array.from({ length: 10 }, (_, i) => SPOT.bitX(i)) }));
    if (HOLDING) {
      await page.evaluate(installHold, { cls: PictureHold.toString(), hold: JSON.stringify(HOLD) });
      await sleep(6000); // idleMs, then the ramp
      note('hold', { settledMs: await page.evaluate(() => (window as unknown as { HOLDER: { target(): number } }).HOLDER.target()) });
    }
    await sleep(3000);

    // Clocks: the workstation's against true time by SNTP, the desk's by chrony, before and after.
    const clocks0 = { local: await localClock(), desk: await deskClock() };
    await startSampler(SECONDS + 15);
    await sleep(4000);
    const cpu0 = await deskCpu();
    const page0 = await client.readTitle<SyncState>('S');
    await page.evaluate(() => (window as unknown as { AV: { start(): number } }).AV.start());
    await sleep(SECONDS * 1000);
    await page.evaluate(() => (window as unknown as { AV: { stop(): number } }).AV.stop());
    const page1 = await client.readTitle<SyncState>('S');
    const cpu1 = await deskCpu();
    const got = await page.evaluate(() => (window as unknown as { AV: { take(): unknown } }).AV.take()) as { frames: Frame[]; beeps: { heard: number; seen: number; x: number }[]; ticks: Record<string, never>[]; wallMinusPerf: number; info: unknown };
    const sampler = await readSampler(30);
    const clocks1 = { local: await localClock(), desk: await deskClock() };
    note('clocks', { before: clocks0, after: clocks1 });
    note('desk cpu while playing', cpuBetween(cpu0, cpu1));
    const fpsDesk = page0 && page1 ? { rafFps: +(((page1.f - page0.f) * 1000) / (page1.t - page0.t)).toFixed(1), longFrames: page1.lf - page0.lf, videoDropped: page1.dropped - page0.dropped, videoFrames: page1.total - page0.total } : null;
    note('desk page fps', fpsDesk);

    // ---- The arithmetic ----
    const toWall = (perf: number) => perf + got.wallMinusPerf;
    const flashes = flashOnsets(got.frames);
    const flashCb = flashes.map((f) => f.now), flashDisp = flashes.map((f) => f.edt);
    const heard = got.beeps.map((b) => b.heard), seen = got.beeps.map((b) => b.seen);
    // Positive: the sound comes after the picture.
    const avHeard = pairs(flashCb, heard, 500), avSeen = pairs(flashCb, seen, 500), avDisp = pairs(flashDisp, heard, 500);

    const local = clocks0.local as { aheadMs?: number }, local1 = clocks1.local as { aheadMs?: number };
    const localAhead = local.aheadMs !== undefined && local1.aheadMs !== undefined ? (local.aheadMs + local1.aheadMs) / 2 : null;
    const deskAhead = clocks0.desk.aheadMs !== null && clocks1.desk.aheadMs !== null ? (clocks0.desk.aheadMs + clocks1.desk.aheadMs) / 2 : null;
    const skew = localAhead !== null && deskAhead !== null ? localAhead - deskAhead : null; // client clock minus desk clock
    let desk: Record<string, unknown> = { sampler };
    let delays: Record<string, unknown> = { note: 'no desk-side times or clocks' };
    if ('flashOn' in sampler && skew !== null) {
      const s = sampler as SamplerOut;
      const deskAv = pairs(s.flashOn, s.beeps, 500);
      desk = { flashes: s.flashOn.length, beeps: s.beeps.length, pollMs: s.pollMs, videoSamples: s.videoSamples, audioBuffers: s.audioBuffers, soundAfterPictureOnTheDeskMs: stats(deskAv), error: s.error };
      // Desk time to client time: client wall clock minus the skew between the two clocks. Only a pair in 0..1000 ms counts.
      const deskFlash = s.flashOn.map((t) => t + skew), deskBeep = s.beeps.map((t) => t + skew);
      delays = {
        clockSkewMs: +skew.toFixed(2), clockNote: 'client minus desk; the client by SNTP (error up to half its round trip), the desk by chrony',
        pictureMsCallback: stats(pairs(deskFlash, flashCb.map(toWall), 1000, 0)),
        pictureMsDisplay: stats(pairs(deskFlash, flashDisp.map(toWall), 1000, 0)),
        soundMsHeard: stats(pairs(deskBeep, heard.map(toWall), 1000, 0)),
        soundMsSeenByWorklet: stats(pairs(deskBeep, seen.map(toWall), 1000, 0)),
      };
    }
    note('desk side', desk);
    note('delays desk to client', delays);
    note('sound after picture at the client', {
      headline: stats(avHeard), note: 'tone heard (worklet onset mapped through getOutputTimestamp) minus the frame callback of the first white frame. Positive: sound late.',
      againstWorkletSeen: stats(avSeen), againstExpectedDisplay: stats(avDisp), flashes: flashes.length, beeps: got.beeps.length,
    });

    // getStats: averages over the window, from the first and last ticks.
    const T = got.ticks as Record<string, Record<string, number>>[];
    const a = T[0], b = T[T.length - 1];
    const avg = (k: string, sum: string, count: string) => (b?.[k] && a?.[k] ? +((1000 * (b[k][sum] - a[k][sum])) / Math.max(1, b[k][count] - a[k][count])).toFixed(1) : null);
    const ept = T.filter((t) => t.audio?.estimatedPlayoutTimestamp && t.video?.estimatedPlayoutTimestamp).map((t) => t.audio.estimatedPlayoutTimestamp - t.video.estimatedPlayoutTimestamp);
    const frames = got.frames;
    const capToRecv = frames.filter((f) => f.ct !== null && f.rt !== null).map((f) => (f.rt as number) - (f.ct as number));
    const recvToCb = frames.filter((f) => f.rt !== null).map((f) => f.now - (f.rt as number));
    const dt = b && a ? (b.t as unknown as number - (a.t as unknown as number)) / 1000 : 0;
    note('client getStats', {
      seconds: +dt.toFixed(1),
      audioJitterBufferMs: avg('audio', 'jitterBufferDelay', 'jitterBufferEmittedCount'), audioJitterBufferTargetMs: avg('audio', 'jitterBufferTargetDelay', 'jitterBufferEmittedCount'), audioJitterBufferMinimumMs: avg('audio', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount'),
      videoJitterBufferMs: avg('video', 'jitterBufferDelay', 'jitterBufferEmittedCount'), videoJitterBufferTargetMs: avg('video', 'jitterBufferTargetDelay', 'jitterBufferEmittedCount'),
      videoDecodeMs: avg('video', 'totalDecodeTime', 'framesDecoded'), videoProcessingMs: avg('video', 'totalProcessingDelay', 'framesDecoded'),
      audioPlayoutDelayMs: b?.playout && a?.playout ? +((1000 * (b.playout.totalPlayoutDelay - a.playout.totalPlayoutDelay)) / Math.max(1, b.playout.totalSamplesCount - a.playout.totalSamplesCount)).toFixed(1) : null,
      decodedFps: b?.video && a?.video && dt ? +((b.video.framesDecoded - a.video.framesDecoded) / dt).toFixed(1) : null,
      framesDropped: b?.video && a?.video ? b.video.framesDropped - a.video.framesDropped : null, freezes: b?.video && a?.video ? b.video.freezeCount - a.video.freezeCount : null,
      audioConcealed: b?.audio && a?.audio ? b.audio.concealedSamples - a.audio.concealedSamples : null,
      packetsLost: { audio: b?.audio && a?.audio ? b.audio.packetsLost - a.audio.packetsLost : null, video: b?.video && a?.video ? b.video.packetsLost - a.video.packetsLost : null },
      senderReports: { audio: b?.sr_audio ?? null, video: b?.sr_video ?? null, audioCount: b?.sr_audio && a?.sr_audio ? b.sr_audio.reportsSent - a.sr_audio.reportsSent : null, videoCount: b?.sr_video && a?.sr_video ? b.sr_video.reportsSent - a.sr_video.reportsSent : null },
      audioMinusVideoEstimatedPlayoutMs: stats(ept), eptNote: 'estimatedPlayoutTimestamp, audio minus video, sampled together: what Chrome thinks the gap is, in the sender\'s clock. Positive: the sound playing is later content than the picture',
      rttMs: stats(T.filter((t) => typeof t.rtt === 'number').map((t) => (t.rtt as unknown as number) * 1000)),
      rvfcCaptureToReceiveMs: stats(capToRecv), rvfcReceiveToCallbackMs: stats(recvToCb), rvfcHasCaptureTime: frames.some((f) => f.ct !== null), rvfcHasRtpTimestamp: frames.some((f) => f.rtp !== null),
      counter: counterSteps(frames),
      audioContext: got.info,
    });
    writeFileSync(OUT.replace(/\.json$/, '.raw.json'), JSON.stringify({ frames: got.frames.filter((f, i, all) => i === 0 || f.lum !== all[i - 1].lum || i % 30 === 0), flashes: flashes.map((f) => f.now), beeps: got.beeps, ticks: got.ticks, sampler, clocks: { clocks0, clocks1 }, wallMinusPerf: got.wallMinusPerf }));

    // ---- Input to screen while the clip plays: a keydown flips the corner square ----
    await page.bringToFront();
    await page.evaluate(() => (window as unknown as { AV: { clearLat(): void } }).AV.clearLat());
    const kd0 = (await client.readTitle<SyncState>('S'))?.kd ?? 0;
    let misses = 0;
    const heldAtKey: number[] = [];
    for (let i = 0; i < TRIALS; i++) {
      // With the hold on, every other trial waits for it to engage, so those keydowns find the picture held.
      await sleep(HOLDING && i % 2 === 0 ? HOLD.idleMs + 2500 + Math.random() * 300 : 250 + Math.random() * 300);
      if (HOLDING) heldAtKey.push(await page.evaluate(() => (window as unknown as { HOLDER: { target(): number } }).HOLDER.target()));
      await page.evaluate(() => (window as unknown as { AV: { arm(): void } }).AV.arm());
      const n = await page.evaluate(() => (window as unknown as { AV: { latCount(): number } }).AV.latCount());
      await page.keyboard.press('x');
      const t = Date.now();
      while (Date.now() - t < 2000 && (await page.evaluate(() => (window as unknown as { AV: { latCount(): number } }).AV.latCount())) <= n) await sleep(15);
      if ((await page.evaluate(() => (window as unknown as { AV: { latCount(): number } }).AV.latCount())) <= n) { misses++; await page.evaluate(() => (window as unknown as { AV: { disarm(): void } }).AV.disarm()); }
      await sleep(60);
    }
    await sleep(1000);
    const lat = await page.evaluate(() => (window as unknown as { AV: { lat(): { cb: number; display: number; recv: number | null }[] } }).AV.lat());
    const kd1 = (await client.readTitle<SyncState>('S'))?.kd ?? 0;
    note('input to screen while the clip plays', { trials: TRIALS, detected: lat.length, misses, keydownsOnTheDesk: kd1 - kd0, callbackMs: stats(lat.map((x) => x.cb)), displayMs: stats(lat.map((x) => x.display)), lastPacketMs: stats(lat.filter((x) => x.recv !== null).map((x) => x.recv as number)),
      ...(HOLDING && lat.length === heldAtKey.length ? {
        heldAtKeydown: { trials: heldAtKey.filter((x) => x > 0).length, holdMs: stats(heldAtKey.filter((x) => x > 0)), callbackMs: stats(lat.filter((_, i) => heldAtKey[i] > 0).map((x) => x.cb)) },
        notHeldAtKeydown: { trials: heldAtKey.filter((x) => x === 0).length, callbackMs: stats(lat.filter((_, i) => heldAtKey[i] === 0).map((x) => x.cb)) },
      } : {}) });
    if (HOLDING) note('hold log', (await page.evaluate(() => (window as unknown as { HOLDER: { log(): unknown[] } }).HOLDER.log())).slice(-60));

    // ---- The first seconds after play: Chromium opens a new Pulse stream then, and the sink's latency starts high ----
    if (process.env.AV_START !== '0') {
      await startSampler(36);
      await sleep(3000);
      await page.evaluate(() => (window as unknown as { AV: { start(): number } }).AV.start());
      await page.keyboard.press('p');
      await client.waitTitle<SyncState>('S', (s) => s.play === 0, 5000);
      await sleep(12_000); // long enough for Chromium to close its audio stream
      const tPlay = await page.evaluate(() => performance.now());
      await page.keyboard.press('p');
      const resumed = await client.waitTitle<SyncState>('S', (s) => s.play === 1, 5000);
      await sleep(14_000);
      await page.evaluate(() => (window as unknown as { AV: { stop(): number } }).AV.stop());
      const g2 = await page.evaluate(() => (window as unknown as { AV: { take(): unknown } }).AV.take()) as typeof got;
      const s2 = await readSampler(30);
      const fl2 = flashOnsets(g2.frames).map((f) => f.now);
      const byEvent = fl2.map((t) => ({ sincePlayMs: Math.round(t - tPlay), soundAfterPictureMs: pairs([t], g2.beeps.map((b) => b.seen), 500)[0] ?? null }));
      const deskStart = 'flashOn' in s2 ? s2.flashOn.map((t) => ({ t, soundAfterPictureMs: pairs([t], s2.beeps, 500)[0] ?? null })) : s2;
      note('after a pause and play', { resumed: !!resumed, clientByEvent: byEvent, deskByEvent: deskStart });
    }

    expect(flashes.length, 'white boxes seen at the client').toBeGreaterThanOrEqual(60);
    expect(avHeard.length, 'tone and box paired at the client').toBeGreaterThanOrEqual(60);
  } finally {
    note('finish', await client.finish().catch((e: Error) => ({ error: e.message.slice(0, 200) })));
    await context.close();
    note('removed from the desk', (await removeAv().catch((e: Error) => e.message.slice(0, 200))).trim());
    const journal = await deskRun(`journalctl -u desk-stream -u desk-rtc --since '-15 min' --no-pager -o short-iso | grep -E 'WARN|ERROR|desk-stream: (error|unexpected)' | cut -c1-200 | tail -15`).catch((e: Error) => e.message);
    note('desk journal warnings', journal.trim().split('\n').filter(Boolean));
  }
});
