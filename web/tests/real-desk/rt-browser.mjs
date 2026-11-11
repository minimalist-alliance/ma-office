// The real Browser window on the real test desk (Milestone 2), as desk-1, in full Chromium for H.264: video plays,
// tabs and navigation work through real deskd, a click reaches the page, closing the window stops the stream, and
// no CSP violation or console problem appears. Key codes and wheel scale aren't judged here: they depend on the
// desk's image. Only the allowed desk is touched, and the desk must already be running.
import { mkdirSync } from 'node:fs';
import { ALLOWED, events, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-browser/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 6 * 60 * 1000);
watchdog.unref();

let failed = 0;
const step = (n, ok, text) => {
  if (!ok) failed += 1;
  log(`STEP ${n} ${ok ? 'PASS' : 'FAIL'} ${text}`);
};
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  let v = await fn().catch(() => null);
  while (!v && Date.now() < end) {
    await wait(250);
    v = await fn().catch(() => null);
  }
  return v;
};

await openSession({ browserKind: 'full' });
const p = S.page;
const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
const desk = await getDesk();
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}`);
  await shutdown(1, 'desk not running');
}
const version = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name.match(/\/v\/([^/]+)\//)?.[1]).find(Boolean));
step(1, version === EXPECTED, `bundle ${version}`);

await p.evaluate(() => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile });
  });
});

await btn.focus();
await p.keyboard.press('Enter');
await waitPanel(/online/, 60_000);
await wait(1000);

const t0 = Date.now();
const proxy = p.locator(`[id="proxy-${ALLOWED}:browser"]`);
await proxy.focus();
await p.keyboard.press('Enter');
await p.getByRole('dialog', { name: 'Browser' }).first().waitFor({ state: 'visible', timeout: 10_000 });

const video = p.locator('video.br-video');
const frame = () => video.evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, muted: v.muted, frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0 }));
const first = await until(async () => {
  const f = await frame();
  return f.w > 0 && f.frames > 0 ? f : null;
}, 45_000);
const ms = Date.now() - t0;
await wait(3000);
const later = await frame();
step(2, Boolean(first) && later.frames > first.frames, `picture ${later.w}x${later.h} ${ms} ms after opening; frames ${first?.frames} then ${later.frames} over 3 s; paused ${later.paused}, muted ${later.muted}`);
await shot(SHOTS, 'open');

const tablist = p.getByRole('group', { name: 'Tabs on this desk' });
const tabs = () => tablist.locator('.br-tab');
const tabCount0 = await until(async () => (await tabs().count()) || null, 20_000);
step(3, Boolean(tabCount0), `${tabCount0} tab(s) in the strip`);

const address = p.getByTestId('browser-address');
await address.click();
await address.fill('https://example.com/');
await p.keyboard.press('Enter');
const titled = await until(async () => /example/i.test((await tablist.innerText()) || '') || /example\.com/.test(await address.inputValue()), 25_000);
await wait(2500);
step(4, Boolean(titled), `navigated: address ${await address.inputValue()}; tabs ${JSON.stringify((await tablist.innerText()).slice(0, 80))}`);
await shot(SHOTS, 'navigated');

await address.click();
await address.fill('https://www.iana.org/help/example-domains');
await p.keyboard.press('Enter');
await until(async () => /iana/.test(await address.inputValue()) && !(await p.getByTestId('browser-pending').count().catch(() => 0)), 25_000);
await wait(2500);
const back = p.getByRole('button', { name: 'Back', exact: true });
const enabled = await until(async () => back.isEnabled(), 10_000);
await back.click({ timeout: 5000 }).catch((e) => log('back failed', e.message.slice(0, 100)));
const wentBack = await until(async () => /example\.com/.test(await address.inputValue()), 15_000);
step(5, Boolean(enabled && wentBack), `Back returned to ${await address.inputValue()}`);

await p.getByRole('button', { name: 'Reload', exact: true }).click({ timeout: 5000 }).catch((e) => log('reload failed', e.message.slice(0, 100)));
await wait(1500);

await p.getByRole('button', { name: 'New tab', exact: true }).click();
const opened = await until(async () => (await tabs().count()) === tabCount0 + 1, 15_000);
await wait(1500);
await shot(SHOTS, 'new-tab');
const closeBtn = tablist.getByRole('button', { name: /^Close / }).last();
await closeBtn.click({ timeout: 5000 }).catch((e) => log('close tab failed', e.message.slice(0, 100)));
const closed = await until(async () => (await tabs().count()) === tabCount0, 15_000);
step(6, Boolean(opened && closed), `new tab opened and closed; ${await tabs().count()} tab(s)`);

const box = await video.boundingBox();
await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await wait(1200);
const stillPlaying = await frame();
step(7, stillPlaying.frames > later.frames, `a click in the page keeps the stream going; frames ${stillPlaying.frames}; notice ${JSON.stringify(await p.getByTestId('browser-notice').innerText({ timeout: 300 }).catch(() => null))}`);
await shot(SHOTS, 'after-click');

await p.keyboard.press('Escape');
await p.getByRole('button', { name: 'Close Browser' }).click({ timeout: 4000 }).catch(() => p.keyboard.press('Escape'));
await wait(1000);
step(8, (await p.getByRole('dialog', { name: 'Browser' }).count()) === 0, 'the window closed');

const violations = await p.evaluate(() => window.__violations);
step(9, violations.length === 0, `CSP violations with real video: ${JSON.stringify(violations)}`);
const consoleProblems = events.filter((e) => e.k === 'console').length;
step(10, consoleProblems === 0, `console problems ${consoleProblems}`);
log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
await shutdown(failed === 0 ? 0 : 1, 'done');
