// S-29 (16 D, item 3): ADR 0036 section 6's video test, the profile part, through a real desk-rtc. A member's session through the real
// Desk app and its Browser window, the clip playing, while the desk's own desk-egress steps the stream from normal to capped (as at
// 100 GB) and back. Page fps (the rAF callback on the desk) is the verdict, never under 30; the stream must come back after each switch.
//
// How the profile changes: as a member's desk does at 100 GB, through desk-egress itself. Its egress.conf gets a capped month line of
// 1 kB and a 5 s tick, desk-egress restarts, and its first tick names `capped` and restarts desk-stream. Back: desk-egress stops, its
// conf and state go back as they were, and it starts, names `normal` and restarts desk-stream again. Everything is put back at the end,
// pass or fail: the conf, the state, the level the member had chosen, the pages.
//
// Only on a staging DeskKind=test desk whose Owner tag is S29_OWNER (a temporary desk of this task's own). Skips unless S29_PROFILE=1.
//   W3_DESK=https://office.staging.minimalistalliance.com W3_LABEL=s29-profile-1 W3_USER_SSM=/ma/staging/test-users/<user> \
//   W3_DESK_ID=d-... W3_VIDEO=gen S29_PROFILE=1 S29_OWNER=syseng-s29 npx playwright test -c w3 profile
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { watch } from '../tests/lib';
import { cpuBetween, pct, sleep } from '../tests/streamlib';
import { deployPages, makeClip, pageUrl, removePages } from './pages';
import { noSimpleView, BrowserWin, TestDesk, W3_ON, channelHook, clientLoad, clientNumbers, installProbe, loadW3User, pageFps, pickDesk, signIn, w3Input, type PageSample } from './w3lib';

const ON = W3_ON && process.env.S29_PROFILE === '1';
test.skip(!ON, 'S29_PROFILE=1 and W3_DESK are not set: this changes a desk\'s stream profile, and runs only when asked.');
test.setTimeout(45 * 60_000);

const OWNER = process.env.S29_OWNER ?? '';
const STRETCH_S = Number(process.env.S29_STRETCH_S ?? 30);
const WATCH_S = Number(process.env.S29_WATCH_S ?? 45);
const WORK = '/var/tmp/ma-s29';
const LEVELS = ['low', 'medium', 'high', 'max'];
/** The level the member asks for across both switches: max (held at Medium when capped) or low (Low within the cap). */
const ASK = process.env.S29_ASK ?? 'max';
if (!['max', 'low'].includes(ASK)) throw new Error('S29_ASK: max or low');
const WIRE: Record<string, number> = { low: 1, medium: 2, high: 3, max: 4 };
const SIZE: Record<string, string> = { low: '1280x720', max: '1920x1080' };
const A = ASK === 'max' ? 'Max' : 'Low';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Before the app runs: every QUALITY reply (0x82) on `keys`, with the client's clock, so the desk's own word is on record. */
const keysHook = () => {
  const w = window as any;
  if (w.__s29) return;
  const S: any = { replies: [] };
  w.__s29 = S;
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, label: string, init?: RTCDataChannelInit) {
    const dc = orig.call(this, label, init);
    if (label === 'keys') {
      dc.addEventListener('message', async (e: MessageEvent) => {
        const buf: ArrayBuffer | null = e.data instanceof ArrayBuffer ? e.data : e.data instanceof Blob ? await e.data.arrayBuffer() : null;
        if (!buf) return;
        const b = new Uint8Array(buf);
        if (b[0] === 0x82 && b.length === 16) S.replies.push({ at: +performance.now().toFixed(1), level: b[1], flags: b[3], limit: b[4] });
      });
    }
    return dc;
  } as typeof orig;
};

/** On the app's video: each decoded frame's time and size, to find the gap a switch leaves and when the picture is back. */
const installFrames = () => {
  const w = window as any;
  const v = document.querySelector('video[data-testid="browser-video"]') as HTMLVideoElement | null;
  if (!v) return false;
  if (w.__s29f?.v === v) return true;
  const F: any = { v, at: [] as number[], sizes: [] as { at: number; w: number; h: number }[], w: 0, h: 0 };
  w.__s29f = F;
  const cb = (now: number, m: any) => {
    if (w.__s29f !== F) return;
    F.at.push(+now.toFixed(1)); if (F.at.length > 20000) F.at.splice(0, 5000);
    if (m.width !== F.w || m.height !== F.h) { F.w = m.width; F.h = m.height; F.sizes.push({ at: +now.toFixed(1), w: m.width, h: m.height }); }
    v.requestVideoFrameCallback(cb);
  };
  v.requestVideoFrameCallback(cb);
  return true;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const LEVEL_NAME = ['none', 'low', 'medium', 'high', 'max'];
const replyText = (r: { level: number; flags: number; limit: number }) =>
  `${LEVEL_NAME[r.level]}${r.flags & 1 ? ' held' : ''}${r.flags & 2 ? ' raised' : ''}${r.limit ? ` (ceiling ${LEVEL_NAME[r.limit]})` : ''}`;

test('a live profile change, normal to capped to normal: page fps and the stream through each', async ({ browser }) => {
  const inp = w3Input();
  if (!inp.deskId) throw new Error('W3_DESK_ID is required');
  const d = await TestDesk.resolve(inp.deskId);
  if (!OWNER || d.tags.Owner !== OWNER) throw new Error(`refusing ${d.instance}: its Owner tag is ${d.tags.Owner ?? 'missing'}, not S29_OWNER`);
  const dir = join(inp.out, inp.label);
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report: any = { label: inp.label, ask: ASK, startedAt: new Date().toISOString(), desk: { instance: d.instance, deskId: d.deskId, type: d.type, ami: d.ami, tags: { DeskKind: d.tags.DeskKind, Env: d.tags.Env, Owner: d.tags.Owner } }, phases: [], notes: [] };
  const save = () => writeFileSync(join(dir, 'profile.json'), JSON.stringify(report, null, 2));
  const note = (s: string) => { report.notes.push(s); console.log(`[s29] ${new Date().toISOString().slice(11, 19)} ${s}`); save(); };

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(channelHook);
  await context.addInitScript(keysHook);
  await noSimpleView(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const w = watch(page);
  await signIn(context, page, loadW3User(inp), inp.url);
  const deskId = await pickDesk(page, w, inp);
  if (deskId !== d.deskId) throw new Error(`the app picked ${deskId}, not ${d.deskId}`);
  await page.evaluate(installProbe);
  const bw = new BrowserWin(page, deskId);
  const W = bw.W.bind(bw);
  const nonce = randomBytes(3).toString('hex');
  const replies = () => page.evaluate(() => (window as unknown as { __s29: { replies: { at: number; level: number; flags: number; limit: number }[] } }).__s29.replies);
  const frames = () => page.evaluate(() => { const F = (window as unknown as { __s29f?: { at: number[]; sizes: { at: number; w: number; h: number }[] } }).__s29f; return F ? { at: F.at.slice(), sizes: F.sizes.slice() } : { at: [], sizes: [] }; });
  const deskState = async () => {
    const out = await d.run(`echo "profile=$(cat /run/desk-egress/profile 2>/dev/null)"; for u in desk-stream desk-rtc desk-egress; do echo "$u=$(systemctl is-active $u) $(systemctl show -p MainPID --value $u) $(systemctl show -p NRestarts --value $u)"; done; ` +
      `for c in desk-rtc desk-stream; do echo "$c.version=$(basename "$(readlink -f /opt/ma/$c/current)")"; done; echo "conf=$(sha256sum /etc/ma/egress.conf | cut -c1-16)"`);
    return Object.fromEntries(out.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  };

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type T = any;
/** getStats ticks with a video entry. Across a desk-stream restart a second can come back without one (seen at Low, run 3). */
const withVideo = (ticks: T[]) => ticks.filter((t) => t?.video);

/** One measured stretch: the client's getStats every second and the page's reports in between, desk CPU either side. */
  const stretch = async (name: string, seconds: number, extra: Record<string, unknown> = {}) => {
    const cpu0 = await d.cpu();
    const t0 = await W<number>('now');
    const ticks = await W('segment', { seconds });
    const t1 = await W<number>('now');
    const cpu1 = await d.cpu();
    const phase = { name, kind: 'stretch', page: pageFps(await W<string[]>('titlesBetween', [t0, t1])), client: clientNumbers(withVideo(ticks)), ticksWithoutVideo: ticks.length - withVideo(ticks).length, deskCpu: cpuBetween(cpu0, cpu1), lastReply: (await replies()).at(-1), ...extra };
    delete (phase.page as { perInterval?: unknown }).perInterval;
    report.phases.push(phase);
    save();
    console.log(`[s29] ${name}: page ${JSON.stringify({ n: phase.page.samples, avg: phase.page.avg, p5: phase.page.p5, min: phase.page.min })} client ${JSON.stringify({ fps: phase.client.decodedFps, p5: phase.client.decodedP5, mbps: phase.client.mbps })}`);
    return phase;
  };

  /**
   * A switch, as the desk makes it: `command` over SSM at t0, then WATCH_S seconds watched. Frame times say how long the picture
   * stopped and when 60 fps was back; the page's own reports say what the desk's Chromium drew meanwhile.
   */
  const watchSwitch = async (name: string, command: string, want: { level: number; flags: number; limit: number }, size: string) => {
    await page.evaluate(installFrames);
    const before = await deskState();
    const r0 = (await replies()).length;
    const tStart = await W<number>('now');
    const cpu0 = await d.cpu();
    const t0 = await W<number>('now');
    const ticksP = W('segment', { seconds: WATCH_S });
    const cmdOut = await d.run(command);
    const tCmd = await W<number>('now');
    const ticks = await ticksP;
    const t1 = await W<number>('now');
    const cpu1 = await d.cpu();
    const after = await deskState();
    const f = await frames();
    const at = f.at.filter((x) => x >= tStart && x <= t1);
    const gaps = at.slice(1).map((x, i) => x - at[i]);
    const worst = gaps.length ? Math.max(...gaps) : null;
    const worstAt = worst !== null ? at[gaps.indexOf(worst)] : null;
    const rs = (await replies()).slice(r0);
    const reply = rs.find((r) => r.level === want.level && r.flags === want.flags && r.limit === want.limit) ?? null;
    // Presented frames a second, as this client drew them: on a busy workstation's headless compositor, fewer than it decoded.
    const perSec: { t: number; n: number }[] = [];
    for (let s = Math.floor(tStart); s < t1; s += 1000) perSec.push({ t: s, n: at.filter((x) => x >= s && x < s + 1000).length });
    // Back: decoded frames a second (getStats, the stream's own frames reaching the client) at 30 or more again, after the
    // second in which the longest gap ended. The verdict on the picture stays the desk's page fps.
    const vt = withVideo(ticks);
    const decPerSec = vt.slice(1).map((x: { t: number; video: { framesDecoded: number } }, i: number) => ({ t: x.t, n: x.video.framesDecoded - vt[i].video.framesDecoded }));
    const gapEnd = worstAt !== null && worst !== null ? worstAt + worst : null;
    const back = gapEnd !== null ? decPerSec.find((p: { t: number; n: number }) => p.t >= gapEnd && p.n >= 30) ?? null : null;
    const sizeAfter = f.sizes.at(-1);
    const pageNumbers = pageFps(await W<string[]>('titlesBetween', [t0, t1]));
    delete (pageNumbers as { perInterval?: unknown }).perInterval;
    const phase = {
      name, kind: 'switch', commandMs: +(tCmd - t0).toFixed(0), before, after, desk: cmdOut.trim().split('\n').slice(-6),
      page: pageNumbers, client: clientNumbers(vt), ticksWithoutVideo: ticks.length - vt.length, deskCpu: cpuBetween(cpu0, cpu1),
      frames: { n: at.length, longestGapMs: worst !== null ? +worst.toFixed(1) : null, gapEndsAfterCommandMs: worstAt !== null && worst !== null ? +(worstAt + worst - t0).toFixed(0) : null, gapsOver100ms: gaps.filter((g) => g > 100).length,
        decodedBackAt30AfterGapMs: back && gapEnd !== null ? +(back.t - gapEnd).toFixed(0) : null,
        decodedPerSecond: { n: decPerSec.length, p5: pct(decPerSec.map((p: { n: number }) => p.n), 5), min: decPerSec.length ? Math.min(...decPerSec.map((p: { n: number }) => p.n)) : null },
        presentedPerSecond: { n: perSec.length - 2, p5: pct(perSec.slice(1, -1).map((p) => p.n), 5), min: perSec.length > 2 ? Math.min(...perSec.slice(1, -1).map((p) => p.n)) : null } },
      reply: reply ? { ...reply, text: replyText(reply), afterCommandMs: +(reply.at - t0).toFixed(0) } : null, repliesSeen: rs.map((r) => ({ ...r, text: replyText(r) })),
      sizeAfter: sizeAfter ? `${sizeAfter.w}x${sizeAfter.h}` : null, sizeWanted: size,
    };
    report.phases.push(phase);
    save();
    console.log(`[s29] ${name}: gap ${phase.frames.longestGapMs} ms, decoded at 30+ ${phase.frames.decodedBackAt30AfterGapMs} ms after, page ${JSON.stringify({ n: phase.page.samples, avg: phase.page.avg, p5: phase.page.p5, min: phase.page.min })}, reply ${phase.reply?.text ?? 'none'}, size ${phase.sizeAfter}`);
    return phase;
  };
  const menu = async () => { await bw.win.getByTestId('quality-button').click(); return bw.win.getByTestId('quality-menu'); };
  const choose = async (level: string) => {
    const m = await menu();
    await m.locator(`[role="menuitemradio"][data-level="${level}"]`).click();
    await sleep(2500);
  };
  const reason = async () => {
    const m = await menu();
    const t = await m.getByTestId('quality-reason').textContent({ timeout: 1500 }).catch(() => null);
    await page.keyboard.press('Escape');
    return t;
  };

  let chosenBefore: string | null = null;
  let switched = false;
  try {
    report.client = { chrome: browser.version(), load: clientLoad() };
    report.deskBefore = await deskState();
    if (report.deskBefore.profile !== 'normal') throw new Error(`this desk's profile is ${report.deskBefore.profile}, not normal: not a starting point`);
    const units = await d.units();
    if (units.stream?.wanted === 'live') throw new Error('another viewer is streaming on this desk');
    await deployPages(d);
    report.clip = await makeClip(d, inp.video === 'off' ? 'gen' : inp.video);
    if (report.clip.kind === 'failed') throw new Error(`no clip: ${report.clip.error}`);
    await d.run(`set -e; rm -rf ${WORK}; install -d -m 700 ${WORK}; cp -p /etc/ma/egress.conf ${WORK}/egress.conf; if [ -f /data/desk-egress/state.json ]; then cp -p /data/desk-egress/state.json ${WORK}/state.json; fi; echo saved`);
    save();

    await bw.open();
    await bw.waitPicture(300_000);
    await bw.waitTabs(300_000);
    await bw.newTab();
    const m0 = await menu();
    chosenBefore = await m0.locator('[role="menuitemradio"][aria-checked="true"]').getAttribute('data-level').catch(() => null);
    await page.keyboard.press('Escape');
    report.chosenBefore = chosenBefore;
    await choose(ASK);
    await bw.go(pageUrl(`video.html?n=${nonce}`));
    const playing = await bw.report<PageSample>((s) => s.n === nonce && Number(s.vf) > 0, 30_000);
    if (!playing || playing.n !== nonce) throw new Error('the video page did not play');
    await bw.moveOver(await bw.picture());
    await sleep(3000);

    await stretch(`normal, ${A} asked`, STRETCH_S);

    // ---- To capped, as at 100 GB: desk-egress's own decision, at its next tick.
    const toCapped = `set -e; python3 -I - <<'EOF'
import re
p = "/etc/ma/egress.conf"
t = open(p).read()
for k, v in (("capped_month_gb", "0.000001"), ("tick_seconds", "5")):
    t = re.sub(r"(?m)^" + k + r" *=.*$", k + " = " + v, t)
open(p, "w").write(t)
EOF
systemctl restart desk-egress; echo "restarted $(date -u +%T.%N)"; for i in $(seq 1 40); do [ "$(cat /run/desk-egress/profile)" = capped ] && break; sleep 0.5; done; echo "profile $(cat /run/desk-egress/profile) $(date -u +%T.%N)"`;
    switched = true;
    await watchSwitch(`to capped (${A} asked)`, toCapped, ASK === 'max' ? { level: 2, flags: 1, limit: 2 } : { level: 1, flags: 0, limit: 2 }, SIZE[ASK]);
    report.reasonWhileCapped = await reason();
    note(`the menu says: ${report.reasonWhileCapped}`);
    await stretch(`capped, ${A} asked (${ASK === 'max' ? 'held at Medium' : 'Low within the cap'})`, STRETCH_S);
    const other = ASK === 'max' ? 'low' : 'max';
    await choose(other);
    await stretch(`capped, ${other === 'max' ? 'Max asked (held at Medium)' : 'Low asked (Low within the cap)'}`, STRETCH_S, { sizeWanted: SIZE[other] });
    await choose(ASK);
    await sleep(2000);

    // ---- Back to normal: desk-egress as it was, which names normal at its start and restarts desk-stream.
    const toNormal = `set -e; systemctl stop desk-egress; cp -p ${WORK}/egress.conf /etc/ma/egress.conf; if [ -f ${WORK}/state.json ]; then cp -p ${WORK}/state.json /data/desk-egress/state.json; fi; systemctl start desk-egress; for i in $(seq 1 40); do [ "$(cat /run/desk-egress/profile)" = normal ] && break; sleep 0.5; done; echo "profile $(cat /run/desk-egress/profile) $(date -u +%T.%N)"`;
    await watchSwitch(`back to normal (${A} asked)`, toNormal, { level: WIRE[ASK], flags: 0, limit: 0 }, SIZE[ASK]);
    switched = false;
    await stretch(`normal again, ${A} asked`, STRETCH_S);
  } finally {
    if (switched) {
      note('putting desk-egress back after a failure');
      await d.run(`systemctl stop desk-egress; cp -p ${WORK}/egress.conf /etc/ma/egress.conf; [ -f ${WORK}/state.json ] && cp -p ${WORK}/state.json /data/desk-egress/state.json; systemctl start desk-egress; sleep 2; cat /run/desk-egress/profile`).catch((e: Error) => note(`could not: ${e.message.slice(0, 200)}`));
    }
    if (chosenBefore && LEVELS.concat('default').includes(chosenBefore)) await choose(chosenBefore).catch(() => note('could not put the level back'));
    report.chosenAfter = await (async () => { const m = await menu(); const v = await m.locator('[role="menuitemradio"][aria-checked="true"]').getAttribute('data-level').catch(() => null); await page.keyboard.press('Escape'); return v; })().catch(() => null);
    await bw.closeOwnTab().catch(() => {});
    await bw.close().catch(() => {});
    await removePages(d).catch(() => {});
    report.journal = (await d.run(`journalctl -u desk-egress -u desk-stream -u desk-rtc --since '${report.startedAt.replace('T', ' ').slice(0, 19)} UTC' --no-pager -o short-iso | grep -iE 'profile|level|limit|Started|Stopped|WARN|ERROR' | cut -c1-200 | tail -60`).catch((e: Error) => e.message)).trim().split('\n');
    report.deskAfter = await deskState().catch(() => null);
    await d.run(`rm -rf ${WORK}; echo ok`).catch(() => {});
    report.endedAt = new Date().toISOString();
    save();
    await context.close();
  }

  const sw = report.phases.filter((p: { kind: string }) => p.kind === 'switch');
  for (const p of report.phases) {
    expect.soft(p.page.samples, `${p.name}: page reports`).toBeGreaterThanOrEqual(Math.min(STRETCH_S, WATCH_S) - 5);
    expect.soft(p.page.min, `${p.name}: page fps never under 30`).toBeGreaterThanOrEqual(30);
  }
  for (const p of sw) {
    expect.soft(p.reply, `${p.name}: the desk's reply`).not.toBeNull();
    expect.soft(p.frames.decodedBackAt30AfterGapMs, `${p.name}: the stream came back`).not.toBeNull();
    expect.soft(p.sizeAfter, `${p.name}: picture size`).toBe(p.sizeWanted);
  }
  expect(report.deskAfter?.profile, 'the desk is back on normal').toBe('normal');
  expect(report.deskAfter?.conf, 'egress.conf is as it was').toBe(report.deskBefore.conf);
});
