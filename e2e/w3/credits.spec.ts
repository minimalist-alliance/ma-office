// TD-227 / task 43 step 4: CPU credits per hour of a t4g.medium desk, by activity, through the real app. Each activity runs for
// CREDITS_MINUTES (default 12) while the desk's own CPU time is read either side (/proc/stat and the desk units), and CloudWatch's
// CPUCreditUsage (1-minute points: the instance needs detailed monitoring on) is summed over exactly that window afterwards. The
// guest's CPU seconds, divided by 60, are the same quantity (1 credit = 1 vCPU-minute at 100%) read from inside: a cross-check.
// Activities (CREDITS_ACTIVITIES, comma list): office (the desk up and the Browser never opened), idle (Browser open on a still
// page), reading (a page scrolled one screen every 20 s), scroll (continuous wheel), video (the real clip). W3_LEVEL=low sets the
// picture quality for the run (as measure.spec.ts). Writes credits-<CREDITS_LABEL>.json to ~/ma-design-drafts/w3/<W3_LABEL>/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { watch } from '../tests/lib';
import { cpuBetween, sleep } from '../tests/streamlib';
import { deployPages, makeClip, pageUrl, removePages } from './pages';
import { noSimpleView, BrowserWin, TestDesk, W3_ON, W3_SKIP, channelHook, clientLoad, installProbe, loadW3User, pickDesk, signIn, w3Input } from './w3lib';

test.skip(!W3_ON || !process.env.CREDITS_LABEL, W3_SKIP);
test.setTimeout(4 * 60 * 60_000);
const run = promisify(execFile);
const aws = async (...a: string[]) => (await run('aws', a, { encoding: 'utf8', env: { ...process.env, AWS_REGION: 'us-east-1' }, maxBuffer: 64 << 20 })).stdout;

async function metric(instance: string, name: string, from: Date, to: Date, stat = 'Sum', period = 60) {
  const r = JSON.parse(await aws('cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/EC2', '--metric-name', name, '--dimensions', `Name=InstanceId,Value=${instance}`, '--start-time', from.toISOString(), '--end-time', to.toISOString(), '--period', String(period), '--statistics', stat, '--output', 'json'));
  return (r.Datapoints ?? []).sort((a: { Timestamp: string }, b: { Timestamp: string }) => a.Timestamp.localeCompare(b.Timestamp)) as { Timestamp: string; Sum?: number; Average?: number }[];
}

test('CPU credits by activity', async ({ browser }) => {
  const inp = w3Input();
  const label = process.env.CREDITS_LABEL!;
  const minutes = Number(process.env.CREDITS_MINUTES ?? 12);
  const acts = (process.env.CREDITS_ACTIVITIES ?? 'office,idle,reading,scroll,video').split(',');
  const dir = join(inp.out, inp.label);
  mkdirSync(dir, { recursive: true });
  const report: Record<string, unknown> = { label, minutes, level: inp.level ?? 'default', startedAt: new Date().toISOString(), activities: {} as Record<string, unknown>, notes: [] as string[] };
  const save = () => writeFileSync(join(dir, `credits-${label}.json`), JSON.stringify(report, null, 2));

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
  const out = report.activities as Record<string, unknown>;

  const measureWindow = async (name: string, drive: (endAt: number) => Promise<void>) => {
    const cpu0 = await desk.cpu();
    const from = new Date();
    const endAt = Date.now() + minutes * 60_000;
    await drive(endAt);
    const to = new Date();
    const cpu1 = await desk.cpu();
    const guest = cpuBetween(cpu0, cpu1);
    out[name] = { from: from.toISOString(), to: to.toISOString(), seconds: (to.getTime() - from.getTime()) / 1000, guestCpu: guest, clientLoad: clientLoad() };
    save();
    console.log(`[credits] ${name}: done`);
  };

  // A wake's own work (boot, the Browser starting) isn't what an hour costs: CREDITS_SETTLE_S waits it out before the first window.
  await sleep(Number(process.env.CREDITS_SETTLE_S ?? 0) * 1000);
  const needBrowser = acts.some((a) => a !== 'office');
  if (acts.includes('office')) {
    await measureWindow('office', async (endAt) => { while (Date.now() < endAt) await sleep(5000); });
  }
  if (needBrowser) {
    await bw.open();
    await bw.waitPicture(300_000);
    await bw.waitTabs(300_000);
    await bw.newTab();
    if (inp.level) {
      await bw.win.getByTestId('quality-button').click();
      await bw.win.getByRole('menuitemradio', { name: new RegExp(`^${inp.level}\\b`, 'i') }).click();
      await sleep(4000);
    }
    await deployPages(desk);
    const clip = acts.includes('video') ? await makeClip(desk, inp.video) : { kind: 'off' };
    report.clip = clip;
    const nonce = Math.random().toString(36).slice(2);
    const show = async (path: string, settle = 3000) => { await bw.go(pageUrl(`${path}${path.includes('?') ? '&' : '?'}n=${nonce}`)); await bw.report((s: { n?: string; vis?: string }) => s.n === nonce && s.vis === 'visible', 30_000); await sleep(settle); };

    if (acts.includes('idle')) {
      await show('article.html');
      await sleep(20_000);
      await measureWindow('idle', async (endAt) => { while (Date.now() < endAt) await sleep(5000); });
    }
    if (acts.includes('reading')) {
      await show('article.html');
      await bw.moveOver(await bw.picture());
      await sleep(20_000);
      await measureWindow('reading', async (endAt) => { while (Date.now() < endAt) { await page.mouse.wheel(0, 600); await sleep(20_000); } });
    }
    if (acts.includes('scroll')) {
      await show('scroll.html');
      await W('wheelStart');
      await sleep(5000);
      await measureWindow('scroll', async (endAt) => { while (Date.now() < endAt) await sleep(5000); });
      await W('wheelStop');
    }
    if (acts.includes('video')) {
      if ((clip as { kind: string }).kind === 'url' || (clip as { kind: string }).kind === 'generated') {
        await show('video.html', 5000);
        await measureWindow('video', async (endAt) => { while (Date.now() < endAt) await sleep(5000); });
      } else (report.notes as string[]).push('no clip, so no video window');
    }
    await bw.closeOwnTab().catch(() => {});
    await bw.close().catch(() => {});
    await removePages(desk).catch(() => {});
  }

  // CloudWatch lags: points for the last minute or two arrive later, so wait before reading.
  await sleep(150_000);
  const type = desk.type;
  for (const [name, a] of Object.entries(out) as [string, { from: string; to: string; seconds: number; guestCpu: unknown }][]) {
    const from = new Date(new Date(a.from).getTime() - 60_000), to = new Date(new Date(a.to).getTime() + 60_000);
    const usage = await metric(desk.instance, 'CPUCreditUsage', from, to, 'Sum', 60);
    const inside = usage.filter((p) => new Date(p.Timestamp) >= new Date(new Date(a.from).getTime() - 30_000) && new Date(p.Timestamp) < new Date(a.to));
    const credits = inside.reduce((s, p) => s + (p.Sum ?? 0), 0);
    const minutesCovered = inside.length;
    // the credit metrics publish every 5 minutes, whatever the monitoring, so a point stands for 5 minutes
    Object.assign(a, { cloudwatchPoints: minutesCovered, cloudwatchCreditsInWindow: +credits.toFixed(3), creditsPerHour: minutesCovered ? +((credits / (minutesCovered * 5)) * 60).toFixed(2) : null, usageSeries: inside.map((p) => [p.Timestamp, +(p.Sum ?? 0).toFixed(3)]) });
  }
  const from = new Date(report.startedAt as string), to = new Date();
  report.balance = { type, CPUCreditBalance: await metric(desk.instance, 'CPUCreditBalance', from, to, 'Average', 300), CPUSurplusCreditBalance: await metric(desk.instance, 'CPUSurplusCreditBalance', from, to, 'Average', 300), CPUSurplusCreditsCharged: await metric(desk.instance, 'CPUSurplusCreditsCharged', from, to, 'Sum', 300) };
  report.finishedAt = new Date().toISOString();
  save();
  await context.close();
  expect(Object.keys(out).length).toBeGreaterThan(0);
});
