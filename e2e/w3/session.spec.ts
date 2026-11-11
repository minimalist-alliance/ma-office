// TD-128: 10-minute sessions through the real Desk app's Browser window, as the 2026-11-05 follow-up's session.py ran them on Neko
// (docs/benchmarks/2026-11-follow-up.md section 2), so a size's page fps is seen over minutes and not only in 60 s passes.
//   browse: SESSION_MINUTES cycles of 60 s. Odd cycles: the scroll page, read 21 s, a 12 s wheel (the kit's 1200 px/s), read 21 s.
//           Even cycles: the static article, read with a page turned every 7 s. Each cycle starts with a navigation (counted, not scored).
//   video:  the clip page (W3_VIDEO) for SESSION_MINUTES, read in 60 s stretches.
// Page fps (rAF inside the desk's Chromium, the verdict number), the client's decoded fps, drops, freezes and bytes, the desk's CPU per
// cycle and its units' memory at the start and the end. Writes session-<SESSION_LABEL>.json to <W3_OUT>/<W3_LABEL>/ after every cycle.
// Skips unless W3_DESK and SESSION_LABEL are set. Same rules as measure.spec.ts: a staging DeskKind=test desk only.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { watch } from '../tests/lib';
import { cpuBetween, sleep } from '../tests/streamlib';
import { deployPages, makeClip, pageUrl, removePages } from './pages';
import { noSimpleView, BrowserWin, TestDesk, W3_ON, W3_SKIP, appVersion, channelHook, clientLoad, clientNumbers, installProbe, loadW3User, pageFps, pickDesk, signIn, w3Input, type PageSample } from './w3lib';

test.skip(!W3_ON || !process.env.SESSION_LABEL, W3_SKIP);
test.setTimeout(2 * 60 * 60_000);

const pct = (xs: number[], p: number) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : null; };

/** Per-second page fps of many stretches, read as one: frames over seconds, p5 and min of the 1 s intervals, seconds under 55 and 30. */
function pool(stretches: { page: ReturnType<typeof pageFps> }[]) {
  const per = stretches.flatMap((s) => s.page.perInterval);
  const frames = stretches.reduce((a, s) => a + (s.page.first && s.page.last ? s.page.last.f - s.page.first.f : 0), 0);
  const secs = stretches.reduce((a, s) => a + s.page.seconds, 0);
  return { stretches: stretches.length, seconds: +secs.toFixed(1), intervals: per.length, avg: secs ? +(frames / secs).toFixed(1) : null, p5: pct(per, 5), min: per.length ? Math.min(...per) : null, under55: per.filter((x) => x < 55).length, under30: per.filter((x) => x < 30).length, maxGapMs: Math.max(0, ...stretches.map((s) => s.page.maxGapMs ?? 0)) };
}

test('10-minute sessions', async ({ browser }) => {
  const inp = w3Input();
  const label = process.env.SESSION_LABEL!;
  const minutes = Number(process.env.SESSION_MINUTES ?? 10);
  const kinds = (process.env.SESSION_KINDS ?? 'browse,video').split(',');
  const dir = join(inp.out, inp.label);
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report: any = { label, minutes, kinds, startedAt: new Date().toISOString(), sessions: {}, notes: [] };
  const save = () => writeFileSync(join(dir, `session-${label}.json`), JSON.stringify(report, null, 2));

  const desk = await TestDesk.resolve(inp.deskId!);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(channelHook);
  await noSimpleView(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const w = watch(page);
  await signIn(context, page, loadW3User(inp), inp.url);
  const deskId = await pickDesk(page, w, inp);
  await page.evaluate(installProbe);
  const bw = new BrowserWin(page, deskId);
  const W = bw.W.bind(bw);
  report.desk = { instance: desk.instance, deskId, type: desk.type, ami: desk.ami, info: await desk.info() };
  report.client = { chrome: browser.version(), appVersion: await appVersion(page), load: clientLoad() };
  save();

  const mem = async () => {
    const out = await desk.run(`for u in desk-browser desk-stream deskd desk-rtc desk-xorg; do echo "$u $(systemctl show -p MemoryCurrent --value $u)"; done; free -m | awk '/^Mem:/{print "used", $3*1048576; print "available", $7*1048576}'`);
    return Object.fromEntries(out.trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, +(Number(v) / 1048576).toFixed(0)]));
  };
  const show = async (path: string, nonce: string, ready: (s: PageSample) => boolean = () => true) => {
    await bw.go(pageUrl(`${path}${path.includes('?') ? '&' : '?'}n=${nonce}`));
    const s = await bw.report<PageSample>((x) => x.n === nonce && x.vis === 'visible' && ready(x), 30_000);
    if (!s || s.n !== nonce) throw new Error(`${path} didn't report on screen`);
  };
  /** One scored stretch on the page already showing: page fps from its titles, the client's getStats each second. */
  const stretch = async (seconds: number, kind: string) => {
    const t0 = await W<number>('now');
    const ticks = await W('segment', { seconds });
    const t1 = await W<number>('now');
    return { kind, page: pageFps(await W<string[]>('titlesBetween', [t0, t1])), client: clientNumbers(ticks) };
  };

  try {
    await bw.open();
    await bw.waitPicture(300_000);
    await bw.waitTabs(300_000);
    await bw.newTab();
    await deployPages(desk);
    report.clip = kinds.includes('video') ? await makeClip(desk, inp.video) : { kind: 'off' };
    save();

    for (const kind of kinds) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: any = { startedAt: new Date().toISOString(), memStart: await mem(), cycles: [] };
      report.sessions[kind] = s;
      const cpu0 = await desk.cpu();
      const t0 = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = [];
      for (let c = 1; c <= minutes; c++) {
        const cycleStart = Date.now();
        const nonce = randomBytes(3).toString('hex');
        const cpuA = await desk.cpu();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: any[] = [];
        if (kind === 'browse' && c % 2 === 1) {
          await show('scroll.html', nonce);
          const nav = Date.now() - cycleStart;
          parts.push(await stretch(Math.max(5, 27 - Math.round(nav / 1000)), 'read'));
          await W('wheelStart');
          parts.push(await stretch(12, 'scroll'));
          await W('wheelStop');
          parts.push(await stretch(19, 'read'));
        } else if (kind === 'browse') {
          await show('article.html', nonce);
          await bw.moveOver(await bw.picture());
          const left = 58_000 - (Date.now() - cycleStart);
          for (let k = 0; k < Math.floor(left / 7000); k++) { parts.push(await stretch(6, 'read')); await page.mouse.wheel(0, 600); }
        } else if (kind === 'video') {
          if (c === 1) { await show('video.html', nonce, (x) => Number(x.vf) > 0); await sleep(3000); }
          const r = await stretch(56, 'video');
          const a = r.page.first, b = r.page.last, secs = a && b ? (b.t - a.t) / 1000 : 0;
          parts.push({ ...r, video: a && b && secs ? { presentedFps: +((Number(b.vp) - Number(a.vp)) / secs).toFixed(1), decodedFps: +((Number(b.vq) - Number(a.vq)) / secs).toFixed(1), dropped: Number(b.vd) - Number(a.vd), paused: b.vpause, size: `${b.vw}x${b.vh}` } : null });
        }
        const cpuB = await desk.cpu();
        all.push(...parts);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        s.cycles.push({ cycle: c, seconds: (Date.now() - cycleStart) / 1000, deskCpu: cpuBetween(cpuA, cpuB), clientLoad: clientLoad().loadavg1m, parts: parts.map((p: any) => ({ kind: p.kind, page: { avg: p.page.avg, p5: p.page.p5, min: p.page.min, samples: p.page.samples, maxGapMs: p.page.maxGapMs, scrolledPx: p.page.scrolledPx }, client: p.client, video: p.video })) });
        save();
        console.log(`[session ${kind}] cycle ${c}: ${parts.map((p) => `${p.kind} ${p.page.avg}`).join(', ')}`);
      }
      const cpu1 = await desk.cpu();
      s.seconds = (Date.now() - t0) / 1000;
      s.deskCpu = cpuBetween(cpu0, cpu1);
      s.memEnd = await mem();
      s.byKind = Object.fromEntries([...new Set(all.map((p) => p.kind))].map((k) => [k, pool(all.filter((p) => p.kind === k))]));
      const clients = all.map((p) => p.client);
      const secs = clients.reduce((a, x) => a + x.seconds, 0);
      s.client = { seconds: +secs.toFixed(1), gbPerHourScored: secs ? +(clients.reduce((a, x) => a + x.gbPerHour * x.seconds, 0) / secs).toFixed(3) : null, dropped: clients.reduce((a, x) => a + x.dropped, 0), freezes: clients.reduce((a, x) => a + x.freezes, 0), freezeSeconds: +clients.reduce((a, x) => a + x.freezeSeconds, 0).toFixed(3), packetsLost: clients.reduce((a, x) => a + x.packetsLost, 0), decodedFpsMin: Math.min(...clients.map((x) => x.decodedFps)), rttMsP50: pct(clients.map((x) => x.rttMs), 50) };
      s.clientLoad = { p50: pct(s.cycles.map((x: { clientLoad: number }) => x.clientLoad), 50), max: Math.max(...s.cycles.map((x: { clientLoad: number }) => x.clientLoad)) };
      s.finishedAt = new Date().toISOString();
      save();
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    await bw.closeOwnTab().catch(() => {});
    await bw.close().catch(() => {});
    await removePages(desk).catch((e) => report.notes.push(`removePages failed: ${String(e).slice(0, 200)}`));
    save();
    await context.close();
  }
  expect(Object.keys(report.sessions).length).toBeGreaterThan(0);
});
