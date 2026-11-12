// Carousel mode on the real test desk as desk-1, with this checkout's `dist/release` routed in place of staging's bundle, in
// full Chromium. Hold ~/work/.test-desk.lock; the desk must be running (nothing wakes it).
//   npm run build:release && flock ~/work/.test-desk.lock timeout 30m nice -n 15 node tests/real-desk/rt-carousel.mjs
// Turns the test desk to carousel, swipes (keys, head buttons, CDP touch on the head) Browser -> Notebook -> Agent and back, types
// into the Browser on stage, reloads to see it remembered, and turns it off. Reads only names and states. Shots in
// test-results/real-desk/rt-carousel/, which the next Playwright run wipes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALLOWED, createLayoutStandIn, getDesk, log, openSession, S, shot, shutdown, wait } from './rt-lib.mjs';

const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-carousel/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const release = JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const until = async (fn, ms, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await wait(every);
  }
  return null;
};
const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 25 * 60 * 1000);
watchdog.unref();

await openSession({
  layoutStandIn: createLayoutStandIn(),
  browserKind: 'full',
  onContext: async (ctx) => {
    await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
    await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
      const file = `${DIST}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
    });
  },
});
const p = S.page;
S.beforeExit = () => {
  try {
    writeFileSync(`${OUT}report.json`, JSON.stringify({ bundle: release.version, results }, null, 2));
  } catch {
    /* the log has it all */
  }
};
const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
const desk = await getDesk();
log('desk', desk.state);
if (desk.state !== 'running') await shutdown(1, `desk is ${desk.state}; not waking it`);
const toggle = () => p.locator(`[id="proxy-carousel:${ALLOWED}"]`);
const slide = () => p.locator('.carousel-slide:not(.leaving)');
const label = async () => (await slide().getAttribute('aria-label', { timeout: 5_000 }).catch(() => null)) ?? '';
const frames = () => p.locator('video.br-video').evaluate((v) => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
const playing = async () => {
  const a = await until(async () => ((await p.locator('video.br-video').evaluate((v) => v.videoWidth)) > 0 ? frames() : null), 60_000);
  if (a === null) return false;
  return Boolean(await until(async () => (await frames()) > a, 10_000));
};
const touchSwipe = async (from, dx) => {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 6, y: from.y + i }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
};

try {
  await btn.focus();
  await p.keyboard.press('Enter');
  await toggle().waitFor({ state: 'attached', timeout: 60_000 });
  const startedOn = (await toggle().getAttribute('aria-pressed')) === 'true';
  step('1 the switch is on the test desk', true, startedOn ? 'already a carousel' : 'off');
  if (!startedOn) await toggle().evaluate((el) => el.click());
  await p.locator('[data-testid="carousel-stage"]').waitFor({ timeout: 20_000 });
  await wait(1500);
  log('on stage:', await label());
  await shot(OUT, '1-carousel-on');
  // To the Browser by the head's Next, then the picture.
  const next = p.getByRole('button', { name: 'Next app' });
  const prev = p.getByRole('button', { name: 'Previous app' });
  await p.locator('[data-testid="carousel-stage"]').focus();
  for (let i = 0; i < 6 && !/^Browser/.test(await label()); i += 1) {
    await p.keyboard.press(/^Browser/.test(await label()) ? 'ArrowLeft' : 'ArrowRight');
    await wait(500);
  }
  step('2 the Browser is on stage', /^Browser/.test(await label()), await label());
  step('3 its picture plays', await playing());
  await shot(OUT, '2-browser');
  // Type into the page: click the picture, type into the address bar if present.
  const video = p.locator('video.br-video');
  const vb = await video.boundingBox();
  await p.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await p.keyboard.type('hello', { delay: 40 });
  const typingRing = await p.locator('.carousel-stage .br-surface').evaluate((el) => getComputedStyle(el).outlineStyle);
  const stageRing = await p.locator('[data-testid="carousel-stage"]').evaluate((el) => getComputedStyle(el).outlineStyle);
  step('4 typing in the Browser on stage: one ring, the picture\'s', typingRing === 'solid' && stageRing === 'none', `picture ${typingRing}, stage ${stageRing}`);
  await shot(OUT, '3-typing');
  // Browser -> Notebook -> Agent and back, by the head and by touch.
  const stageBox = await p.locator('[data-testid="carousel-stage"]').boundingBox();
  const head = { x: stageBox.x + stageBox.width / 2, y: stageBox.y + 20 };
  const apps = [];
  await prev.click();
  await wait(700);
  apps.push(await label());
  await touchSwipe(head, 200); // right: toward the earlier app, if any
  await wait(700);
  apps.push(await label());
  await touchSwipe(head, -200);
  await wait(700);
  apps.push(await label());
  for (let i = 0; i < 3; i += 1) {
    await next.click({ trial: false }).catch(() => undefined);
    await wait(700);
  }
  apps.push(await label());
  log('slides seen:', apps.join(' | '));
  step('5 the head moves apps by button and by touch', new Set(apps.filter(Boolean)).size >= 2, apps.join(' | '));
  await shot(OUT, '4-moved');
  // Go to the Agent and Notebook both, once each.
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    seen.add(await label());
    await p.locator('[data-testid="carousel-stage"]').focus();
    await p.keyboard.press('ArrowLeft');
    await wait(600);
  }
  step('6 Browser, Notebook and Agent each reached', ['Browser', 'Notebook', 'Agent'].every((a) => [...seen].some((l) => l.startsWith(a))), [...seen].join(' | '));
  // Park on the Browser, reload, remembered.
  for (let i = 0; i < 8 && !/^Browser/.test(await label()); i += 1) {
    await p.locator('[data-testid="carousel-stage"]').focus();
    await p.keyboard.press(/^Notebook|^Chat/.test(await label()) ? 'ArrowRight' : 'ArrowLeft');
    await wait(600);
  }
  const before = await label();
  await wait(2500); // the layout sync's debounce
  await p.reload({ waitUntil: 'load' });
  await btn.waitFor({ state: 'attached', timeout: 60_000 });
  const back = await until(async () => ((await label()) ? label() : null), 30_000);
  step('7 reload remembers the carousel and its app', Boolean(back) && back === before, `${before} -> ${back}`);
  await shot(OUT, '5-reloaded');
  // Off again: the same switch.
  if (back) await toggle().evaluate((el) => el.click());
  await wait(1500);
  step('8 off again', (await p.locator('[data-testid="carousel-stage"]').count()) === 0);
  await wait(2500);
  await shot(OUT, '6-off');
  if (startedOn) log('NOTE: the desk was a carousel at the start; left off');
} catch (e) {
  step('script', false, String(e.message).slice(0, 300));
}
const failed = results.filter((r) => !r.ok);
log(failed.length ? `FAILED ${failed.length}` : 'ALL PASSED');
await shutdown(failed.length ? 1 : 0, 'done');
