// One pass over the b910fb7 desk: nothing drawn on a healthy desk, a click on empty canvas goes to the
// overview, a drag pans. Signed in as desk-1; only the test desk (RT_DESK) is ever focused; start:true is refused
// for every desk. What a screenshot shows is judged by reading it: this script only measures.
import { mkdirSync } from 'node:fs';
import { ALLOWED, CONNECTED, events, getDesk, log, logConfig, openSession, OTHER, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-stage1/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 5 * 60 * 1000);
watchdog.unref();

// The version heads the log, so nothing prints until it's known.
const started = Date.now();
let held = [];
const write = (t) => process.stdout.write(`${t}\n`);
logConfig.line = (at, text) => {
  const l = `${new Date(at).toISOString()} ${`+${((at - started) / 1000).toFixed(3)}`.padStart(9)} ${text}`;
  if (held) held.push(l);
  else write(l);
};
const results = [];
function result(step, pass, detail) {
  results.push({ step, pass, detail });
  log(`STEP ${step} ${pass ? 'PASS' : 'FAIL'} ${detail}`);
}

async function pageVersion(page) {
  return page.evaluate(() => {
    const re = /\/v\/([^/]+)\//;
    const urls = [...document.querySelectorAll('script[src], link[href]')].map((el) => el.src || el.href).concat(performance.getEntriesByType('resource').map((r) => r.name));
    for (const u of urls) {
      const m = re.exec(new URL(u, location.href).pathname);
      if (m) return m[1];
    }
    return null;
  });
}

await openSession({
  watch: true,
  onLanding: async (page) => {
    const limit = Date.now() + 15000;
    let v = null;
    while (!v && Date.now() < limit) {
      v = await pageVersion(page).catch(() => null);
      if (!v) await wait(100);
    }
    write(`=== rt-stage1 start ${new Date(started).toISOString()}`);
    write(`=== BUNDLE ${v ?? 'UNKNOWN'} (from the page's /v/<version>/ asset path)${v === EXPECTED ? ' matches the expected version' : ` DOES NOT MATCH expected ${EXPECTED}`}`);
    for (const l of held ?? []) write(l);
    held = null;
    if (v !== EXPECTED) throw new Error(`staging serves ${v}, not ${EXPECTED}`);
  },
});

const p = S.page;
const btn = p.locator(`#proxy-${ALLOWED}`);
const nameOf = () => btn.getAttribute('aria-label');

async function view() {
  const v = JSON.parse((await p.evaluate(() => localStorage.getItem('ma.view.v1'))) ?? '{}');
  if (v.mode !== 'overview' && v.activeDesk === OTHER) {
    log('!!! the other desk took focus. Stopping here.');
    await shutdown(1, 'other desk focused');
  }
  return v;
}

const cam = () =>
  p.evaluate(() => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(document.querySelector('.proxy-layer')?.style.transform ?? '');
    return m ? { x: +m[1], y: +m[2], s: +m[3] } : null;
  });
const box = () => p.evaluate((id) => {
  const r = document.getElementById(`proxy-${id}`)?.getBoundingClientRect();
  return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
}, ALLOWED);

/** The camera writes the proxy layer when it settles, so wait out the move, then for no more change. */
async function settled() {
  await wait(1500);
  let last = '';
  let same = 0;
  for (let i = 0; i < 40 && same < 7; i++) {
    const now = JSON.stringify(await cam());
    same = now === last ? same + 1 : 0;
    last = now;
    await wait(100);
  }
}

/** Grid points that are bare canvas: on the canvas element, and 24 px clear of both desks' boxes. */
const bareCanvas = () =>
  p.evaluate(() => {
    const rects = [...document.querySelectorAll('button.proxy[id^="proxy-d-"]')].filter((b) => !b.id.includes(':')).map((b) => b.getBoundingClientRect());
    const M = 24;
    const gap = (x, y) => Math.min(...rects.map((r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))));
    const out = [];
    for (let y = 40; y < innerHeight - 30; y += 20) {
      for (let x = 40; x < innerWidth - 30; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el?.tagName !== 'CANVAS' || !el.closest('[data-testid="canvas"]')) continue;
        const d = gap(x, y);
        if (d > M) out.push({ x, y, d: Math.round(d) });
      }
    }
    return { out, desks: rects.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })) };
  });

// ----- 1. The overview, with the desk online

const onlineOk = await waitPanel(/online/, 60000);
const v1 = await pageVersion(p).catch(() => null);
log(`bundle after sign-in ${v1}`);
log(`view ${JSON.stringify(await view())}`);
await settled();
const name1 = await nameOf();
await shot(SHOTS, 'step1-overview');
result(1, onlineOk && v1 === EXPECTED, `name ${JSON.stringify(name1)}; other desk ${JSON.stringify(await p.locator(`#proxy-${OTHER}`).getAttribute('aria-label'))}`);

// ----- 2. Focus the desk, by its button, as rt-wake.mjs does

const beforeFocus = Date.now();
await btn.focus();
await btn.press('Enter');
await settled();
const v2 = await view();
const name2 = await nameOf();
const box2 = await box();
log(`view ${JSON.stringify(v2)} camera ${JSON.stringify(await cam())} desk box ${JSON.stringify(box2)}`);
await shot(SHOTS, 'step2-desk-focused');
const clip = { x: Math.max(0, box2.x - 8), y: Math.max(0, box2.y - 8), width: Math.min(box2.w + 16, 1440 - Math.max(0, box2.x - 8)), height: Math.min(box2.h + 16, 900 - Math.max(0, box2.y - 8)) };
await p.screenshot({ path: `${SHOTS}step2-desk-crop.png`, clip });
const wakes2 = S.connects.filter((c) => c.at >= beforeFocus && c.start !== false);
result(2, v2.mode === 'desk' && v2.activeDesk === ALLOWED && wakes2.length === 0 && CONNECTED.test(name2), `mode ${v2.mode}, active ${v2.activeDesk}, name still ${JSON.stringify(name2)}, start:true since focus ${wakes2.length}. The drawn text is judged from the screenshot.`);

// ----- 3. The Account panel opens and closes on the real desk. "About this desk" is the owner's only (the owner, Nov 9), and
// the test account is never the owner, so a member's panel has none of it.

const account = p.getByRole('button', { name: 'Account', exact: true });
await account.click();
const panel = p.getByRole('dialog', { name: 'Account', exact: true });
await panel.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: 10000 });
const aboutShown = (await p.getByTestId('about-toggle').count()) + (await p.getByTestId('about-desk').count()) + (await p.locator('.about-version').count());
log(`about parts a member sees: ${aboutShown}`);
await shot(SHOTS, 'step3-account');
await account.click();
await panel.waitFor({ state: 'hidden', timeout: 5000 });
const v3 = await view();
result(3, aboutShown === 0 && v3.mode === 'desk', `about parts shown ${aboutShown}; panel closed; mode still ${v3.mode}`);
await wait(800);

// ----- 4. A real click on bare canvas goes to the overview

const bare4 = await bareCanvas();
log(`desk boxes ${JSON.stringify(bare4.desks)}; bare canvas points ${bare4.out.length}`);
if (!bare4.out.length) {
  result(4, false, 'no bare canvas outside both desks at this size: nothing clicked');
} else {
  const c = [...bare4.out].sort((a, b) => b.d - a.d)[0];
  const cam4 = await cam();
  log(`clicking bare canvas at ${c.x},${c.y}, ${c.d} px from the nearest desk, camera ${JSON.stringify(cam4)}`);
  await p.mouse.click(c.x, c.y);
  const limit = Date.now() + 3000;
  let v4 = await view();
  while (v4.mode !== 'overview' && Date.now() < limit) {
    await wait(50);
    v4 = await view();
  }
  await settled();
  v4 = await view();
  const camAfter = await cam();
  await shot(SHOTS, 'step4-after-click');
  log(`view ${JSON.stringify(v4)} camera ${JSON.stringify(camAfter)}`);
  result(4, v4.mode === 'overview' && camAfter.s < cam4.s, `mode ${v4.mode}, scale ${cam4.s.toFixed(3)} to ${camAfter.s.toFixed(3)}, active ${v4.activeDesk}`);
}

// ----- 5. Focus again, then a drag on bare canvas pans

await btn.focus();
await btn.press('Enter');
await settled();
const v5a = await view();
const bare5 = await bareCanvas();
const good = new Set(bare5.out.map((o) => `${o.x},${o.y}`));
let drag = null;
for (const o of [...bare5.out].sort((a, b) => b.d - a.d)) {
  for (const [dx, dy] of [[200, 0], [-200, 0], [0, 200], [0, -200]]) {
    let clear = true;
    for (let i = 1; i <= 10 && clear; i++) clear = good.has(`${o.x + (dx / 10) * i},${o.y + (dy / 10) * i}`);
    if (clear) {
      drag = { x: o.x, y: o.y, dx, dy };
      break;
    }
  }
  if (drag) break;
}
if (v5a.mode !== 'desk' || v5a.activeDesk !== ALLOWED || !drag) {
  result(5, false, `not dragged: view ${JSON.stringify(v5a)}, drag path ${JSON.stringify(drag)}`);
} else {
  const cam5 = await cam();
  const box5 = await box();
  await shot(SHOTS, 'step5-before-drag');
  log(`dragging from ${drag.x},${drag.y} by ${drag.dx},${drag.dy}; the whole path is bare canvas; camera ${JSON.stringify(cam5)} desk box ${JSON.stringify(box5)}`);
  await p.mouse.move(drag.x, drag.y);
  await p.mouse.down();
  await p.mouse.move(drag.x + drag.dx, drag.y + drag.dy, { steps: 20 });
  await p.mouse.up();
  await settled();
  const v5 = await view();
  const camAfter = await cam();
  const boxAfter = await box();
  await shot(SHOTS, 'step5-after-drag');
  log(`view ${JSON.stringify(v5)} camera ${JSON.stringify(camAfter)} desk box ${JSON.stringify(boxAfter)}`);
  const moved = { x: Math.round(camAfter.x - cam5.x), y: Math.round(camAfter.y - cam5.y) };
  // Late: nothing should bring it back to the overview after the press ends.
  await wait(2000);
  const v5late = await view();
  result(5, v5late.mode !== 'overview' && camAfter.s === cam5.s && Math.abs(moved.x - drag.dx) <= 8 && Math.abs(moved.y - drag.dy) <= 8, `camera moved ${moved.x},${moved.y} for a drag of ${drag.dx},${drag.dy}; scale ${camAfter.s.toFixed(3)} unchanged; mode ${v5.mode}, ${v5late.mode} 2 s later`);
}

// ----- 6. The guard's word, and leave cleanly

const connects = S.connects.filter((c) => c.action === 'connect');
const byDesk = (id) => connects.filter((c) => c.desk === id);
const wakes = S.connects.filter((c) => c.start !== false || c.action !== 'connect');
const consoleProblems = events.filter((e) => e.k === 'console');
const wsErrors = events.filter((e) => e.k === 'ws' && e.type === 'error');
const hello = events.find((e) => e.k === 'ctl.hello.sent');
log(`guard: connect calls ${connects.length} (test ${byDesk(ALLOWED).length}, other ${byDesk(OTHER).length}), start:true or other lifecycle calls ${wakes.length}`);
log(`bundle's own HELLO appVersion ${hello?.appVersion}`);
log(`console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);
result(6, wakes.length === 0 && consoleProblems.length === 0 && !S.guardTripped, `start:true ${wakes.length}, guard tripped ${S.guardTripped}, console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);

S.afterClose = async () => {
  await wait(800);
  const d = await getDesk();
  log(`DESK after close state=${d.state} phase=${d.phase} clientConnected=${d.clientConnected} autoStopMinutes=${d.autoStopMinutes} autoStopAt=${d.autoStopAt}`);
};
log(`SUMMARY ${JSON.stringify(results.map((r) => ({ step: r.step, pass: r.pass })))}`);
await shutdown(results.every((r) => r.pass) ? 0 : 1, 'done');
