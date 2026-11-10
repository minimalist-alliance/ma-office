// TD-212: the 20 sites a member would try first, from the test desk's real Browser, through the shipped app as a member uses it.
// Each is recorded as pass, challenge or block (classify.ts), with the stream's GB/h over a visit of typical use (sites.ts), for
// TD-46. See README.md here for how to run it and what it leaves on the desk. It skips unless REAL_SITES=1.
//
// The desk is lib.ts' test desk only, as desk-1, the account the gate uses. Its second desk is never focused, so never woken.
// It signs in to no site, types only the sites' addresses, and clicks only a video's own player to start it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { DESK_ID, INSTANCE, REGION, focusTestDesk, loadUser, signInApp, watch, assertTestDesk } from '../tests/lib';
import { sleep } from '../tests/streamlib';
import { BrowserWin, TestDesk, appVersion, clientLoad, installProbe } from '../w3/w3lib';
import { PROBE, classify, redact, type Probe } from './classify';
import { DRM, cookieCounts, deployProbe, evalOnScreen, nic, probePage, removeProbe, tabCount, type Nic } from './desk';
import { render } from './render';
import { pick } from './sites';

const ON = process.env.REAL_SITES === '1';
test.skip(!ON, 'REAL_SITES=1 is not set. This check runs only when asked: see README.md in this folder.');
// Under the 45 minutes the shared test desk's lock may be held for at once.
test.setTimeout(42 * 60_000);

const LOAD_MS = 15_000;
const STILL_MS = 10_000;
const STEP_MS = 5_000;
// desk-1's other desk, kept stopped. Read only, to show it stayed so.
/** The fake desk's instance, from the environment; its state is only reported. */
const FAKE_DESK_INSTANCE = process.env['E2E_FAKE_DESK_INSTANCE'] ?? '';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bytes = { t: number; transport: number; video: number; audio: number; peers: number };

const ec2State = (instance: string) => !instance ? 'unknown' : execFileSync('aws', ['ec2', 'describe-instances', '--region', REGION, '--instance-ids', instance, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text'], { encoding: 'utf8' }).trim();
const gbh = (bytes: number, seconds: number) => (seconds > 0 && bytes >= 0 ? +((bytes / seconds) * 3600 / 1e9).toFixed(3) : null);
const between = (a: Bytes, b: Bytes) => (b.peers === a.peers && b.transport >= a.transport ? gbh(b.transport - a.transport, (b.t - a.t) / 1000) : null);
const nicGbh = (a: Nic, b: Nic, k: 'rx' | 'tx') => gbh(b[k] - a[k], b.at - a.at);

/** What a file may keep of a page: no address, short text. */
function keep(p: Probe | null) {
  if (!p) return null;
  return { title: redact(p.title).slice(0, 120), host: p.host, path: redact(p.path), status: p.status, readyState: p.readyState, textLength: p.textLength, textStart: redact(p.text).slice(0, 200),
    frames: [...new Set(p.frames.map((f) => `${f.host}${f.w >= 250 && f.h >= 60 ? ' (shown)' : ''}`))].slice(0, 12), videos: p.videos.map(({ x: _x, y: _y, ...v }) => v), scrollY: p.scrollY, scrollHeight: p.scrollHeight };
}

test('TD-212: real sites from the test desk', async ({ browser }) => {
  const sites = pick(process.env.REAL_SITES_ONLY);
  const label = process.env.REAL_SITES_LABEL ?? `${new Date().toISOString().slice(0, 16).replace(/[:]/g, '')}Z${process.env.REAL_SITES_ONLY ? `-${process.env.REAL_SITES_ONLY.replace(/,/g, '_')}` : ''}`;
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('REAL_SITES_LABEL: letters, digits, dot, dash and underscore only');
  const here = new URL('.', import.meta.url).pathname;
  const outDir = join(here, 'out', label); // frames and whole reads, ignored by git: a page can show an address
  const resultsDir = join(here, 'results');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const report: any = { label, task: 'TD-212', startedAt: new Date().toISOString(), sites: sites.map((s) => s.id), visits: [], notes: [] };
  const save = () => {
    writeFileSync(join(resultsDir, `${label}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(resultsDir, `${label}.md`), render([report]));
  };
  const note = (s: string) => { report.notes.push(s); console.log(`[real-sites] ${s}`); };

  // ---- The desk: the gate's test desk and nothing else, and nobody else's stream on it.
  assertTestDesk(); // the staging test desk only
  const desk = await TestDesk.resolve(DESK_ID);
  expect(desk.instance, 'the tags lead to the test desk').toBe(INSTANCE);
  const before = await desk.units();
  if (before.stream?.wanted === 'live' && process.env.REAL_SITES_ALLOW_BUSY !== '1') throw new Error("another viewer is streaming on this desk, which would add to every GB/h. Wait, or REAL_SITES_ALLOW_BUSY=1");
  const info = await desk.info();
  report.desk = { deskId: DESK_ID, type: desk.type, az: desk.az, info, screen: /current (\d+) x (\d+)/.exec(info.xrandr ?? '')?.slice(1).join('x') ?? null, unitsBefore: before.units, streamBefore: before.stream, fakeDeskBefore: ec2State(FAKE_DESK_INSTANCE) };
  await deployProbe(desk);
  const tabsBefore = await tabCount(desk);
  const domains = [...new Set(sites.map((s) => s.cookieDomain))];
  report.desk.tabsBefore = tabsBefore;
  report.cookiesBefore = await cookieCounts(desk, domains);
  save();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const w = watch(page);
  const bw = new BrowserWin(page, DESK_ID);
  let windowOpen = false;

  /** Everything the desk sent this browser so far, from getStats on the app's own peer connections. */
  const bytes = (): Promise<Bytes> => page.evaluate(async () => {
    const pcs = (((window as any).__e2e?.pcs ?? []) as RTCPeerConnection[]).filter((p) => p.connectionState !== 'closed');
    const o = { t: performance.now(), transport: 0, video: 0, audio: 0, peers: pcs.length };
    for (const pc of pcs) {
      (await pc.getStats()).forEach((r: any) => {
        if (r.type === 'transport') o.transport += r.bytesReceived ?? 0;
        if (r.type === 'inbound-rtp' && r.kind === 'video') o.video += r.bytesReceived ?? 0;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') o.audio += r.bytesReceived ?? 0;
      });
    }
    return o;
  });
  /** The decoded picture at half size, for a person to confirm the call. Kept out of git. */
  const grab = (): Promise<string | null> => page.evaluate(() => {
    const v = document.querySelector('video[data-testid="browser-video"]') as HTMLVideoElement | null;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth / 2); c.height = Math.round(v.videoHeight / 2);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  });

  try {
    await signInApp(context, page, loadUser('desk-1'));
    const deskName = await focusTestDesk(page, w);
    await page.evaluate(installProbe);
    report.client = { chrome: browser.version(), appVersion: await appVersion(page), viewport: '1440x900', load: clientLoad() };
    await bw.open();
    windowOpen = true;
    await expect(bw.win.getByRole('heading', { name: /^Browser/ }), "it's the test desk's window").toContainText(deskName);
    await bw.waitPicture(120_000);
    await bw.newTab();
    const pic = await bw.picture();
    report.client.picture = { vw: pic.vw, vh: pic.vh, scale: +pic.scale.toFixed(3) };
    save();

    for (const site of sites) {
      const v: any = { id: site.id, name: site.name, category: site.category, url: site.url, use: site.use, at: new Date().toISOString() };
      report.visits.push(v);
      try {
        const n0 = await nic(desk);
        const b0 = await bytes();
        await bw.go(site.url);
        await sleep(LOAD_MS);
        const b1 = await bytes();
        const atLoad = await probePage(desk, PROBE);
        await bw.moveOver(pic);
        const b2 = await bytes();
        // ---- Typical use, as sites.ts says.
        let b3 = b2;
        if (site.use === 'read' || site.use === 'maps') {
          await sleep(STILL_MS);
          b3 = await bytes();
          const steps = site.use === 'read' ? 8 : 6;
          for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, site.use === 'read' ? 360 : -240); await sleep(STEP_MS); }
        } else if (site.use === 'video') {
          const vid = atLoad?.videos[0];
          if (vid?.paused) { await bw.clickDesk(pic, vid.x, vid.y); v.clickedPlay = true; }
          await sleep(60_000);
        } else {
          await sleep(20_000);
          b3 = await bytes();
        }
        const b4 = await bytes();
        const afterUse = await probePage(desk, PROBE);
        const frame = await grab();
        if (frame) writeFileSync(join(outDir, `${String(site.id).padStart(2, '0')}-${site.name.replace(/[^A-Za-z0-9]+/g, '-')}.jpg`), Buffer.from(frame.split(',')[1], 'base64'));
        const n1 = await nic(desk);
        const b5 = await bytes();
        writeFileSync(join(outDir, `${String(site.id).padStart(2, '0')}.json`), JSON.stringify({ atLoad, afterUse }, null, 2));
        const call = classify(atLoad, afterUse, site.use === 'video');
        Object.assign(v, { verdict: call.verdict, why: call.why, atLoadCall: call.atLoad, afterUseCall: call.afterUse, atLoad: keep(atLoad), afterUse: keep(afterUse) });
        v.gbh = {
          visit: between(b0, b5), load: between(b0, b1),
          still: site.use === 'video' ? null : between(b2, b3),
          use: site.use === 'login' ? null : between(site.use === 'video' ? b2 : b3, b4),
          deskTx: nicGbh(n0, n1, 'tx'), deskRx: nicGbh(n0, n1, 'rx'),
        };
        v.seconds = +((b5.t - b0.t) / 1000).toFixed(1);
        v.bytes = { stream: b5.transport - b0.transport, video: b5.video - b0.video, audio: b5.audio - b0.audio, deskTx: n1.tx - n0.tx, deskRx: n1.rx - n0.rx };
        if (b5.peers !== b0.peers) note(`${site.name}: the app's peer connections changed during the visit (${b0.peers} to ${b5.peers}), so its stream GB/h is left out`);
        if (atLoad) report.chromium = { ua: atLoad.ua, webdriver: atLoad.webdriver, lang: atLoad.lang, viewport: `${atLoad.iw}x${atLoad.ih}` };
        if (afterUse?.scheme === 'https:' && !report.chromium?.drm) report.chromium = { ...report.chromium, drm: await evalOnScreen(desk, DRM).catch((e: Error) => e.message.slice(0, 120)) };
        const tabs = await tabCount(desk);
        if (tabs !== tabsBefore + 1) note(`after ${site.name} the desk has ${tabs} tabs, not ${tabsBefore + 1}: a site opened or closed one`);
      } catch (e) {
        v.verdict = 'unclear';
        v.error = String(e).replace(/\s+/g, ' ').slice(0, 300);
        note(`${site.name}: ${v.error}`);
        if (!(await bw.win.isVisible().catch(() => false))) throw new Error('the Browser window closed during the run');
      }
      console.log(`[real-sites] ${site.id} ${site.name}: ${v.verdict}${v.why ? ` (${v.why})` : ''}, stream ${v.gbh?.visit ?? '-'} GB/h`);
      save();
    }
    report.cookiesAfter = await cookieCounts(desk, domains);
  } finally {
    // ---- Leave the desk as it was found: our tab closed, the window closed and the stream off, the probe gone.
    if (windowOpen) {
      await bw.closeOwnTab().catch((e: Error) => note(`closing our tab: ${e.message.slice(0, 120)}`));
      await sleep(1500);
      await bw.close().catch((e: Error) => note(`closing the window: ${e.message.slice(0, 120)}`));
    }
    await context.close();
    let after = await desk.units();
    for (let i = 0; i < 20 && after.stream?.wanted === 'live'; i++) { await sleep(1500); after = await desk.units(); }
    report.desk.streamAfter = after.stream;
    report.desk.unitsAfter = after.units;
    report.desk.tabsAfter = await tabCount(desk).catch(() => null);
    if (report.desk.tabsAfter !== tabsBefore) note(`the desk has ${report.desk.tabsAfter} tabs after the run, ${tabsBefore} before`);
    await removeProbe(desk).catch((e: Error) => note(`removing the probe: ${e.message.slice(0, 120)}`));
    report.desk.fakeDeskAfter = ec2State(FAKE_DESK_INSTANCE);
    report.finishedAt = new Date().toISOString();
    save();
  }
  expect(report.desk.streamAfter?.wanted, 'the stream is off again').not.toBe('live');
  expect(report.desk.fakeDeskAfter, "desk-1's other desk stayed as it was").toBe(report.desk.fakeDeskBefore);
  expect(report.visits.length).toBe(sites.length);
});
