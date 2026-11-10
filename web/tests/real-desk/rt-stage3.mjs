/* eslint-disable @typescript-eslint/no-unused-vars */
// One pass over the eb099bc desk: apps move and resize freely, can't overlap, stay inside, take the keyboard,
// and survive a reload. Signed in as desk-1 with a fresh layout; only the test desk (RT_DESK) is focused; start:true is
// refused for every desk. All four apps are empty states, so opening one changes nothing on the desk.
//
// The shipping bundle has no window.__maDesk and proxies only update on a drop. Live positions are read from
// the Konva stage, found through its React fiber: read-only, and the same numbers the app itself uses.
// What a screenshot shows is judged by reading it. This script only measures.
import { mkdirSync } from 'node:fs';
import { ALLOWED, events, getDesk, HOST, log, logConfig, openSession, OTHER, S, shot, shutdown, testLabel, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-stage3/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const EDGE = 8;
const STRIP = 44;
const MIN = 56;
const APPS = ['chat', 'notebook', 'browser', 'agent'];
const VP = { w: 1440, h: 900 };

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 8 * 60 * 1000);
watchdog.unref();

// The version heads the log.
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
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const n2 = (v) => +(+v).toFixed(2);

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

/** Read-only. Runs in the page, before the app, so it's there again after a reload. */
function readerInit() {
  window.__rtStage = () => {
    if (window.__rtS) return window.__rtS;
    const el = document.querySelector('[data-testid="canvas"]');
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    const isStage = (v) => v && typeof v.getClassName === 'function' && v.getClassName() === 'Stage';
    const hooks = (f) => {
      let s = f?.memoizedState;
      for (let i = 0; s && typeof s === 'object' && i < 60; i += 1) {
        if (s.memoizedState && isStage(s.memoizedState.current)) return s.memoizedState.current;
        s = s.next;
      }
      return null;
    };
    let up = el[key];
    for (let i = 0; up && i < 12; i += 1, up = up.return) {
      const st = hooks(up);
      if (st) return (window.__rtS = st);
    }
    const queue = [el[key].child];
    for (let n = 0; queue.length && n < 300; n += 1) {
      const f = queue.shift();
      if (!f) continue;
      const st = hooks(f);
      if (st) return (window.__rtS = st);
      queue.push(f.child, f.sibling);
    }
    return null;
  };
  window.__rtRead = (deskId) => {
    const st = window.__rtStage();
    if (!st) return null;
    const desk = st.findOne((n) => n.id() === `desk-${deskId}`);
    if (!desk) return null;
    const items = {};
    for (const t of desk.find('.app-tile')) {
      const g = t.findOne('.app-resize');
      items[t.id().split(':')[1]] = { x: t.x(), y: t.y(), gripW: g ? g.x() + 20 : null, gripH: g ? g.y() + 20 : null };
    }
    const h = desk.findOne('.resize-handle');
    return { cam: { x: st.x(), y: st.y(), s: st.scaleX() }, desk: { x: desk.x(), y: desk.y(), handleW: h ? h.x() + 30 : null, handleH: h ? h.y() + 30 : null }, items, cursor: st.container().style.cursor };
  };
  window.__rtSample = (deskId) => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(window.__rtRead(deskId)))));
  window.__rtRecord = (deskId) => {
    window.__rtFrames = [];
    window.__rtRec = true;
    const tick = () => {
      if (!window.__rtRec) return;
      const f = window.__rtRead(deskId);
      if (f) window.__rtFrames.push({ t: Math.round(performance.now()), items: f.items });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  window.__rtRecordStop = () => {
    window.__rtRec = false;
    return window.__rtFrames;
  };
}

await openSession({
  watch: true,
  onContext: async (context) => {
    await context.addInitScript(readerInit);
  },
  onLanding: async (page) => {
    const limit = Date.now() + 15000;
    let v = null;
    while (!v && Date.now() < limit) {
      v = await pageVersion(page).catch(() => null);
      if (!v) await wait(100);
    }
    write(`=== rt-stage3 start ${new Date(started).toISOString()}`);
    write(`=== BUNDLE ${v ?? 'UNKNOWN'} (from the page's /v/<version>/ asset path)${v === EXPECTED ? ' matches the expected version' : ` DOES NOT MATCH expected ${EXPECTED}`}`);
    for (const l of held ?? []) write(l);
    held = null;
    if (v !== EXPECTED) throw new Error(`staging serves ${v}, not ${EXPECTED}`);
  },
});

const p = S.page;
const btn = p.locator(`#proxy-${ALLOWED}`);
const proxyOf = (app) => p.locator(`[id="proxy-${ALLOWED}:${app}"]`);
const storage = (k) => p.evaluate((key) => localStorage.getItem(key), k);
const savedDoc = async () => JSON.parse((await storage('ma.layout.v2')) ?? 'null');
const read = () => p.evaluate((id) => window.__rtRead(id), ALLOWED);
const sample = () => p.evaluate((id) => window.__rtSample(id), ALLOWED);

async function view() {
  const v = JSON.parse((await storage('ma.view.v1')) ?? '{}');
  if (v.mode !== 'overview' && v.activeDesk === OTHER) {
    log('!!! the other desk took focus. Stopping here.');
    await shutdown(1, 'other desk focused');
  }
  return v;
}
async function settled() {
  await wait(1500);
  let last = '';
  let same = 0;
  for (let i = 0; i < 40 && same < 7; i += 1) {
    const now = JSON.stringify((await read())?.cam);
    same = now === last ? same + 1 : 0;
    last = now;
    await wait(100);
  }
}

/** The saved desk, after the mirror's 1 s debounce, by app. */
async function docAfter() {
  await wait(1300);
  const d = (await savedDoc()).desks[ALLOWED];
  const items = Object.fromEntries(d.items.map((i) => [i.app, { x: i.x, y: i.y, w: i.w, h: i.h }]));
  log(`doc desk ${d.w} x ${d.h} at ${d.x},${d.y}; ${APPS.map((a) => `${a} ${items[a].x},${items[a].y} ${items[a].w}x${items[a].h}`).join('; ')}`);
  return { w: d.w, h: d.h, x: d.x, y: d.y, items };
}
const fmt = (r) => `${r.x},${r.y} ${r.w}x${r.h}`;
const hit = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
function overlapsIn(items) {
  const out = [];
  for (let i = 0; i < APPS.length; i += 1) {
    for (let j = i + 1; j < APPS.length; j += 1) {
      if (hit(items[APPS[i]], items[APPS[j]])) out.push(`${APPS[i]}/${APPS[j]}`);
    }
  }
  return out;
}
const inside = (r, d) => r.x >= EDGE - 0.01 && r.y >= EDGE - 0.01 && r.x + r.w <= d.w - EDGE + 0.01 && r.y + r.h <= d.h - STRIP + 0.01;
function screenOf(r, f) {
  const left = f.cam.x + (f.desk.x + r.x) * f.cam.s;
  const top = f.cam.y + (f.desk.y + r.y) * f.cam.s;
  return { left, top, right: left + r.w * f.cam.s, bottom: top + r.h * f.cam.s, cx: left + (r.w * f.cam.s) / 2, cy: top + (r.h * f.cam.s) / 2 };
}
const cropTo = async (name, box, pad = 26) => {
  const x = Math.max(0, box.left - pad);
  const y = Math.max(0, box.top - pad);
  const path = `${SHOTS}${name}.png`;
  await p.screenshot({ path, clip: { x, y, width: Math.min(VP.w - x, box.right - box.left + 2 * pad), height: Math.min(VP.h - y, box.bottom - box.top + 2 * pad) } });
  log('crop', path);
};

/** Holds the pointer down at `from`. */
async function press(from) {
  await p.mouse.move(from.x, from.y);
  await wait(90);
  await p.mouse.down();
}
/** Moves the held pointer in equal steps, reading after each. */
async function stepTo(from, dx, dy, n, label, onStep) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const ptr = { x: from.x + (dx * i) / n, y: from.y + (dy * i) / n };
    await p.mouse.move(ptr.x, ptr.y);
    const f = await sample();
    out.push({ i, ptr, f });
    await onStep?.(i, f);
  }
  log(`${label}: ${n} steps of ${n2(dx / n)},${n2(dy / n)} px`);
  return out;
}

const seam = (x, y, w, h) =>
  p.evaluate(
    ({ x, y, w, h }) => {
      const c = document.querySelector('[data-testid="canvas"] canvas');
      const k = c.width / c.clientWidth;
      const d = c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data;
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const [mode] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const [mr, mg, mb] = mode.split(',').map(Number);
      let off = 0;
      let maxDelta = 0;
      for (const [key, n] of counts) {
        const [r, g, b] = key.split(',').map(Number);
        const delta = Math.max(Math.abs(r - mr), Math.abs(g - mg), Math.abs(b - mb));
        maxDelta = Math.max(maxDelta, delta);
        if (delta > 2) off += n;
      }
      return { pixels: d.length / 4, colour: mode, off, maxDelta };
    },
    { x, y, w, h },
  );
/** A row and a column of bare app surface, 8 units in, clear of its corners, glyph and handle. */
async function tileSeams(box, s) {
  const row = await seam(box.left + 24 * s, box.bottom - 8 * s, box.right - box.left - 54 * s, 1);
  const column = await seam(box.right - 8 * s, box.top + 24 * s, 1, box.bottom - box.top - 54 * s);
  return { row, column };
}

function moveAnalysis(samples, app, x0, y0, from) {
  let maxErrX = 0;
  let maxErrY = 0;
  let maxStepOff = 0;
  let prev = { x: x0, y: y0, px: 0, py: 0 };
  let movedSteps = 0;
  const xs = new Set();
  const ys = new Set();
  for (const q of samples) {
    const s = q.f.cam.s;
    const it = q.f.items[app];
    const px = (q.ptr.x - from.x) / s;
    const py = (q.ptr.y - from.y) / s;
    xs.add(it.x);
    ys.add(it.y);
    if (it.x !== x0 || it.y !== y0) {
      movedSteps += 1;
      maxErrX = Math.max(maxErrX, Math.abs(it.x - x0 - px));
      maxErrY = Math.max(maxErrY, Math.abs(it.y - y0 - py));
      if (prev.x !== x0 || prev.y !== y0) maxStepOff = Math.max(maxStepOff, Math.abs(it.x - prev.x - (px - prev.px)), Math.abs(it.y - prev.y - (py - prev.py)));
    }
    prev = { x: it.x, y: it.y, px, py };
  }
  return { movedSteps, of: samples.length, distinctX: xs.size, distinctY: ys.size, maxErrWorld: [n2(maxErrX), n2(maxErrY)], maxStepOffWorld: n2(maxStepOff) };
}

// ----- setup: a fresh layout, online, focused

const onlineOk = await waitPanel(/online/, 60000);
await wait(800);
const version1 = await pageVersion(p).catch(() => null);
await settled();
const v1Key = await storage('ma.layout.v1');
const doc0 = await docAfter();
log(`bundle after sign-in ${version1}; ma.layout.v1 ${v1Key === null ? 'absent' : 'PRESENT'}; view ${JSON.stringify(await view())}; name ${JSON.stringify(testLabel())}`);
await shot(SHOTS, 'setup-overview');
await btn.focus();
await btn.press('Enter');
await settled();
const v0 = await view();
const f0 = await read();
if (!f0 || !onlineOk || version1 !== EXPECTED || v0.mode !== 'desk' || v0.activeDesk !== ALLOWED) {
  log(`SCRIPT or STATE problem before any drag: reader ${!!f0}, online ${onlineOk}, version ${version1}, view ${JSON.stringify(v0)}`);
  await shutdown(3, 'setup');
}
const readerOk = APPS.every((a) => near(f0.items[a]?.x, doc0.items[a].x) && near(f0.items[a]?.y, doc0.items[a].y));
log(`live reader vs doc agree: ${readerOk}; camera ${JSON.stringify(f0.cam)}; desk ${JSON.stringify(f0.desk)}`);
if (!readerOk) await shutdown(3, 'the live reader disagrees with the doc');
await shot(SHOTS, 'setup-focused');

// The default desk gives an app 16 units of height to move in, so give it room as a member would.
const panelLeft = (f) => f.cam.x + f.desk.x * f.cam.s;
const panelTop = (f) => f.cam.y + f.desk.y * f.cam.s;
{
  const s = f0.cam.s;
  const from = { x: panelLeft(f0) + doc0.w * s - 12, y: panelTop(f0) + doc0.h * s - 12 };
  const dy = Math.min(190, VP.h - 56 - from.y);
  log(`setup: growing the desk from ${n2(from.x)},${n2(from.y)} by 0,${n2(dy)} px`);
  await press(from);
  await stepTo(from, 0, dy, 20, 'setup grow');
  await p.mouse.up();
  await wait(400);
}
let doc = await docAfter();
const f1 = await read();
log(`setup done: desk ${doc.w} x ${doc.h}; camera ${JSON.stringify(f1.cam)} (was ${JSON.stringify(f0.cam)})`);
const camStill = f1.cam.s === f0.cam.s && f1.cam.x === f0.cam.x && f1.cam.y === f0.cam.y;
log(`dropping a desk's corner left the camera alone: ${camStill}`);
await shot(SHOTS, 'setup-grown');

// ----- 1. Free move, and a click still opens

{
  const f = await read();
  const a0 = doc.items.agent;
  const c = screenOf(a0, f);
  const from = { x: c.cx, y: c.cy };
  const DX = 137;
  const DY = 61;
  await press(from);
  const samples = await stepTo(from, DX, DY, 30, 'move agent', async (i) => {
    if (i === 15) {
      await shot(SHOTS, 'step1-mid-drag');
    }
  });
  const a = moveAnalysis(samples, 'agent', a0.x, a0.y, from);
  const last = samples.at(-1).f.items.agent;
  log(`tracking ${JSON.stringify(a)}; last live ${last.x},${last.y}`);
  await p.mouse.up();
  await wait(300);
  const afterDrop = (await read()).items.agent;
  doc = await docAfter();
  await wait(1700);
  const later = (await read()).items.agent;
  const wantX = n2(a0.x + DX / f.cam.s);
  const wantY = n2(a0.y + DY / f.cam.s);
  await p.mouse.move(40, 760); // off the app, for a look with no hover
  await wait(200);
  await shot(SHOTS, 'step1-after-drop');
  const follows = a.maxErrWorld[0] <= 1 && a.maxErrWorld[1] <= 1 && a.maxStepOffWorld <= 1;
  const stays = near(doc.items.agent.x, wantX, 0.5) && near(doc.items.agent.y, wantY, 0.5) && near(afterDrop.x, doc.items.agent.x) && near(later.x, doc.items.agent.x) && near(later.y, doc.items.agent.y);

  // A plain click opens, and doesn't move.
  const beforeClick = JSON.stringify(doc.items);
  const nb = screenOf(doc.items.notebook, await read());
  const win = p.getByTestId('window-notebook');
  await p.mouse.move(nb.cx, nb.cy);
  await wait(150);
  await shot(SHOTS, 'step1-hover');
  await p.mouse.down();
  await p.mouse.up();
  const opened = await win.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  await wait(400);
  await shot(SHOTS, 'step1-click-opened');
  const docClick = await docAfter();
  const sameAfterClick = JSON.stringify(docClick.items) === beforeClick;
  await p.getByRole('button', { name: 'Close Notebook' }).click().catch((e) => log('close failed', e.message.slice(0, 120)));
  const closed = await win.waitFor({ state: 'hidden', timeout: 4000 }).then(() => true).catch(() => false);
  await wait(400);

  // A jitter under Konva's 4 px drag distance is still a click.
  await p.mouse.move(nb.cx, nb.cy);
  await wait(120);
  await p.mouse.down();
  await p.mouse.move(nb.cx + 2, nb.cy + 1);
  await p.mouse.up();
  const openedJitter = await win.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  await wait(400);
  const docJitter = await docAfter();
  const sameAfterJitter = JSON.stringify(docJitter.items) === beforeClick;
  await p.getByRole('button', { name: 'Close Notebook' }).click().catch((e) => log('close failed', e.message.slice(0, 120)));
  const closedJitter = await win.waitFor({ state: 'hidden', timeout: 4000 }).then(() => true).catch(() => false);
  await wait(400);
  const v1a = await view();
  log(`click: opened ${opened}, doc unchanged ${sameAfterClick}, closed ${closed}; 2 px jitter: opened ${openedJitter}, doc unchanged ${sameAfterJitter}, closed ${closedJitter}; mode ${v1a.mode}`);
  result(1, follows && stays && opened && sameAfterClick && closed && openedJitter && sameAfterJitter && closedJitter && v1a.mode === 'desk', `dragged ${DX},${DY} px at ${n2(f.cam.s)}x; moved on ${a.movedSteps}/${a.of} steps, ${a.distinctX} distinct x and ${a.distinctY} y; furthest from the pointer ${a.maxErrWorld} units; final ${doc.items.agent.x},${doc.items.agent.y} vs ${wantX},${wantY} from the pointer, same 2 s later; click opened and moved nothing; a 2 px jitter also opened and moved nothing`);
  doc = docJitter;
}

// A probe, not a pass or fail: a flick released at once, with no frame for the catch-up.
{
  const f = await read();
  const a0 = doc.items.agent;
  const c = screenOf(a0, f);
  await press({ x: c.cx, y: c.cy });
  await p.evaluate((id) => window.__rtRecord(id), ALLOWED);
  await p.mouse.move(c.cx + 120, c.cy);
  await p.mouse.up();
  await wait(300);
  const frames = await p.evaluate(() => window.__rtRecordStop());
  doc = await docAfter();
  log(`PROBE flick of +120 px released at once: wanted x ${n2(a0.x + 120 / f.cam.s)}, got ${doc.items.agent.x}; short by ${n2(a0.x + 120 / f.cam.s - doc.items.agent.x)} units; ${frames.length} frames seen`);
}

// ----- 2. No overlap: fast, then in small steps, then sliding

function frameCheck(frames, app, others, size) {
  let overlapFrames = 0;
  let maxDelta = 0;
  let prev = null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const fr of frames) {
    const it = fr.items[app];
    const box = { x: it.x, y: it.y, w: size.w, h: size.h };
    if (others.some((o) => hit(box, o))) overlapFrames += 1;
    if (prev) maxDelta = Math.max(maxDelta, Math.hypot(it.x - prev.x, it.y - prev.y));
    minX = Math.min(minX, it.x);
    maxX = Math.max(maxX, it.x);
    prev = it;
  }
  return { frames: frames.length, overlapFrames, maxDeltaPerFrame: n2(maxDelta), minX: n2(minX), maxX: n2(maxX) };
}
const othersOf = (d, app) => APPS.filter((a) => a !== app).map((a) => d.items[a]);
{
  // Fast, straight through: Chat at Notebook, the pointer far past it in one move.
  let f = await read();
  let b = doc.items.chat;
  let c = screenOf(b, f);
  const wantChat = doc.items.notebook.x - b.w;
  await press({ x: c.cx, y: c.cy });
  await p.evaluate((id) => window.__rtRecord(id), ALLOWED);
  await p.mouse.move(c.cx + 600, c.cy);
  await wait(450);
  const fastChat = frameCheck(await p.evaluate(() => window.__rtRecordStop()), 'chat', othersOf(doc, 'chat'), b);
  const liveChat = (await read()).items.chat;
  log(`fast: chat flung +600 px at notebook: frames ${JSON.stringify(fastChat)}; held at ${liveChat.x},${liveChat.y} with the pointer far past; contact is x ${wantChat}`);
  await shot(SHOTS, 'step2-fast-contact');
  await cropTo('step2-fast-contact-crop', screenOf({ x: b.x, y: b.y - 16, w: 260, h: 108 }, await read()));
  await p.mouse.up();
  doc = await docAfter();
  const chatOk = fastChat.overlapFrames === 0 && near(doc.items.chat.x, wantChat) && near(doc.items.chat.y, b.y);

  // And the other way: Browser flung left into Notebook.
  f = await read();
  b = doc.items.browser;
  c = screenOf(b, f);
  const wantBrowser = doc.items.notebook.x + doc.items.notebook.w;
  await press({ x: c.cx, y: c.cy });
  await p.evaluate((id) => window.__rtRecord(id), ALLOWED);
  await p.mouse.move(c.cx - 480, c.cy, { steps: 3 });
  await wait(450);
  const fastBrowser = frameCheck(await p.evaluate(() => window.__rtRecordStop()), 'browser', othersOf(doc, 'browser'), b);
  const liveBrowser = (await read()).items.browser;
  log(`fast: browser flung -480 px at notebook in 3 moves: frames ${JSON.stringify(fastBrowser)}; held at ${liveBrowser.x},${liveBrowser.y}; contact is x ${wantBrowser}`);
  await p.mouse.up();
  doc = await docAfter();
  const browserOk = fastBrowser.overlapFrames === 0 && near(doc.items.browser.x, wantBrowser) && near(doc.items.browser.y, b.y);

  // Small steps: Agent left into Browser, then down, so it slides along Browser and clears it.
  f = await read();
  b = doc.items.agent;
  c = screenOf(b, f);
  const s = f.cam.s;
  const from = { x: c.cx, y: c.cy };
  const contactX = doc.items.browser.x + doc.items.browser.w;
  const goLeftWorld = b.x - contactX + 40; // 40 past contact
  await press(from);
  const leftSamples = await stepTo(from, -goLeftWorld * s, 0, 40, 'small steps into browser');
  const atContact = leftSamples.at(-1).f.items.agent;
  const overlapLeft = leftSamples.filter((q) => hit({ ...b, x: q.f.items.agent.x, y: q.f.items.agent.y }, doc.items.browser)).length;
  const heldSteps = leftSamples.filter((q) => near(q.f.items.agent.x, contactX)).length;
  const beforeContact = moveAnalysis(leftSamples.filter((q) => q.f.items.agent.x > contactX + 0.01), 'agent', b.x, b.y, from);
  log(`small steps: before contact furthest from the pointer ${beforeContact.maxErrWorld} units; at contact x ${atContact.x} (contact ${contactX}), held for ${heldSteps} of 40 steps with the pointer 40 units past; overlapping samples ${overlapLeft}`);
  await shot(SHOTS, 'step2-small-contact');
  await cropTo('step2-small-contact-crop', screenOf({ x: doc.items.browser.x - 8, y: Math.min(doc.items.browser.y, b.y) - 12, w: 180, h: 150 }, await read()));
  // Slide: down until it clears Browser, and the left it was held back from then catches up.
  const area = { yMax: doc.h - STRIP - b.h };
  const downWorld = Math.min(area.yMax - b.y - 3, 72);
  await p.evaluate((id) => window.__rtRecord(id), ALLOWED);
  const downFrom = { x: from.x - goLeftWorld * s, y: from.y };
  const downSamples = await stepTo(downFrom, 0, downWorld * s, 30, 'slide down browser');
  await wait(250);
  const slideFrames = frameCheck(await p.evaluate(() => window.__rtRecordStop()), 'agent', othersOf(doc, 'agent'), b);
  const pinned = downSamples.filter((q) => q.f.items.agent.y + b.h > doc.items.browser.y && q.f.items.agent.y < doc.items.browser.y + doc.items.browser.h);
  const pinnedOk = pinned.every((q) => near(q.f.items.agent.x, contactX));
  const liveEnd = (await read()).items.agent;
  log(`slide: ${pinned.length} steps beside browser, x pinned at contact ${pinnedOk}; y from ${b.y} to ${liveEnd.y}; then x ${liveEnd.x}; frames ${JSON.stringify(slideFrames)}`);
  await shot(SHOTS, 'step2-after-slide');
  await p.mouse.up();
  doc = await docAfter();
  const pairs = overlapsIn(doc.items);
  await p.mouse.move(40, 760);
  await wait(200);
  await shot(SHOTS, 'step2-end');
  const clearedLeft = near(doc.items.agent.x, n2(contactX - 40), 0.6);
  result(2, chatOk && browserOk && overlapLeft === 0 && near(atContact.x, contactX) && pinnedOk && slideFrames.overlapFrames === 0 && pairs.length === 0 && clearedLeft, `fast: chat stopped at x ${doc.items.chat.x} (contact ${wantChat}), browser at x ${doc.items.browser.x} (contact ${wantBrowser}), ${fastChat.overlapFrames + fastBrowser.overlapFrames} overlapping frames in ${fastChat.frames + fastBrowser.frames}; small steps: stopped at x ${atContact.x}, ${overlapLeft} overlapping samples; slide: x pinned for ${pinned.length} steps, then cleared and caught up to x ${doc.items.agent.x}, ${slideFrames.overlapFrames} overlapping frames in ${slideFrames.frames}, largest frame move ${slideFrames.maxDeltaPerFrame} units; overlaps in the doc: ${pairs.length}`);
}

// ----- 3. The desk's edges, and the strip

{
  let f = await read();
  const b = doc.items.agent;
  const c = screenOf(b, f);
  const s = f.cam.s;
  const pl = panelLeft(f);
  const pt = panelTop(f);
  const pr = pl + doc.w * s;
  const pb = pt + doc.h * s;
  const maxX = doc.w - EDGE - b.w;
  const maxY = doc.h - STRIP - b.h;
  let from = { x: c.cx, y: c.cy };
  await press(from);
  // Right, far past the edge.
  let to = { x: Math.min(VP.w - 20, pr + 160), y: from.y };
  const right = await stepTo(from, to.x - from.x, 0, 30, 'agent right');
  const atRight = right.at(-1).f.items.agent;
  await shot(SHOTS, 'step3-right-edge');
  // Down, far into and past the strip.
  from = to;
  to = { x: from.x, y: Math.min(VP.h - 20, pb + 90) };
  const down = await stepTo(from, 0, to.y - from.y, 25, 'agent down');
  const atBottom = down.at(-1).f.items.agent;
  await shot(SHOTS, 'step3-strip');
  await cropTo('step3-strip-crop', screenOf({ x: doc.w - 150, y: doc.h - 130, w: 150, h: 130 }, await read()));
  // Up, far past the top.
  from = to;
  to = { x: from.x, y: Math.max(70, pt - 110) };
  const up = await stepTo(from, 0, to.y - from.y, 30, 'agent up');
  const atTop = up.at(-1).f.items.agent;
  await p.mouse.up();
  doc = await docAfter();
  const outside = [...right, ...down, ...up].filter((q) => !inside({ ...b, x: q.f.items.agent.x, y: q.f.items.agent.y }, doc)).length;
  log(`agent limits: right x ${atRight.x} (max ${maxX}), bottom y ${atBottom.y} (max ${maxY}, app's bottom ${n2(atBottom.y + b.h)}, strip starts ${n2(doc.h - STRIP)}), top y ${atTop.y} (min ${EDGE}); samples outside ${outside}`);

  // Chat: left and up.
  f = await read();
  const ch = doc.items.chat;
  const cc = screenOf(ch, f);
  let fromC = { x: cc.cx, y: cc.cy };
  await press(fromC);
  let toC = { x: Math.max(120, pl - 85), y: fromC.y };
  const left = await stepTo(fromC, toC.x - fromC.x, 0, 25, 'chat left');
  const atLeft = left.at(-1).f.items.chat;
  fromC = toC;
  toC = { x: fromC.x, y: Math.max(70, pt - 110) };
  const upC = await stepTo(fromC, 0, toC.y - fromC.y, 20, 'chat up');
  const atTopC = upC.at(-1).f.items.chat;
  await p.mouse.up();
  doc = await docAfter();
  await p.mouse.move(40, 760);
  await wait(200);
  await shot(SHOTS, 'step3-end');
  const outsideC = [...left, ...upC].filter((q) => !inside({ ...ch, x: q.f.items.chat.x, y: q.f.items.chat.y }, doc)).length;
  const allInside = APPS.every((a) => inside(doc.items[a], doc));
  const pairs = overlapsIn(doc.items);
  log(`chat limits: left x ${atLeft.x} (min ${EDGE}), top y ${atTopC.y} (min ${EDGE}); samples outside ${outsideC}; every app inside ${allInside}; overlaps ${pairs.length}`);
  result(3, near(atRight.x, maxX) && near(atBottom.y, maxY) && near(atTop.y, EDGE) && near(atLeft.x, EDGE) && near(atTopC.y, EDGE) && outside === 0 && outsideC === 0 && allInside && pairs.length === 0, `right x ${atRight.x} (limit ${maxX}), bottom y ${atBottom.y} so its bottom is ${n2(atBottom.y + b.h)} and the strip starts at ${n2(doc.h - STRIP)}, top y ${atTop.y}, left x ${atLeft.x}; ${outside + outsideC} samples outside in ${right.length + down.length + up.length + left.length + upC.length}; overlaps ${pairs.length}`);
}

// ----- 4. Free resize, into a neighbour, down to the minimum

{
  let f = await read();
  let b = doc.items.browser;
  let box = screenOf(b, f);
  const s = f.cam.s;
  // Hover shows the corner.
  await p.mouse.move(box.cx, box.cy);
  await wait(200);
  const hoverRead = (await read()).items.browser;
  log(`hover: corner handle present ${hoverRead.gripW !== null}`);
  await shot(SHOTS, 'step4-hover');
  await cropTo('step4-hover-crop', box, 40);
  const corner = { x: box.right - 8, y: box.bottom - 8 };
  await p.mouse.move(corner.x, corner.y, { steps: 3 });
  await wait(120);
  const cursor = (await read()).cursor;
  log(`on the corner the cursor is ${JSON.stringify(cursor)}`);

  // 4a. A size that isn't on any grid.
  const DX = 83;
  const DY = 47;
  await press(corner);
  let seamMid = null;
  const grow = await stepTo(corner, DX, DY, 24, 'resize browser', async (i, fr) => {
    if (i === 12) {
      const it = fr.items.browser;
      const live = screenOf({ x: it.x, y: it.y, w: it.gripW, h: it.gripH }, fr);
      seamMid = await tileSeams(live, s);
      log(`seam scan mid-resize at ${n2(it.gripW)} x ${n2(it.gripH)} ${JSON.stringify(seamMid)}`);
      await shot(SHOTS, 'step4-mid-resize');
      await cropTo('step4-mid-resize-crop', live);
    }
  });
  let maxErr = 0;
  let maxStepOff = 0;
  let prevW = b.w;
  let prevH = b.h;
  let prevPx = 0;
  let prevPy = 0;
  const sizes = new Set();
  for (const q of grow) {
    const it = q.f.items.browser;
    const px = (q.ptr.x - corner.x) / s;
    const py = (q.ptr.y - corner.y) / s;
    sizes.add(`${it.gripW}x${it.gripH}`);
    if (it.gripW !== b.w || it.gripH !== b.h) {
      maxErr = Math.max(maxErr, Math.abs(it.gripW - b.w - px), Math.abs(it.gripH - b.h - py));
      if (prevW !== b.w || prevH !== b.h) maxStepOff = Math.max(maxStepOff, Math.abs(it.gripW - prevW - (px - prevPx)), Math.abs(it.gripH - prevH - (py - prevPy)));
    }
    prevW = it.gripW;
    prevH = it.gripH;
    prevPx = px;
    prevPy = py;
  }
  await p.mouse.up();
  doc = await docAfter();
  const wantW = n2(b.w + DX / s);
  const wantH = n2(b.h + DY / s);
  const after4a = doc.items.browser;
  f = await read();
  box = screenOf(after4a, f);
  const seamAfter = await tileSeams(box, s);
  await p.mouse.move(40, 760);
  await wait(250);
  await shot(SHOTS, 'step4-after-resize');
  await cropTo('step4-after-resize-crop', box);
  log(`4a: ${sizes.size} distinct sizes in 24 steps; furthest from the pointer ${n2(maxErr)} units, worst step off the pointer's ${n2(maxStepOff)}; final ${after4a.w} x ${after4a.h} vs ${wantW} x ${wantH}; seam scan at rest ${JSON.stringify(seamAfter)}`);
  const free = maxErr <= 1 && maxStepOff <= 1 && near(after4a.w, wantW, 0.5) && near(after4a.h, wantH, 0.5) && near(after4a.x, b.x) && near(after4a.y, b.y);

  // 4b. Into a neighbour: Agent is on its right, in the same row. Then down, into widget size.
  b = after4a;
  const ag = doc.items.agent;
  const contactW = n2(ag.x - b.x);
  const inRow = b.y < ag.y + ag.h && ag.y < b.y + b.h;
  await p.mouse.move(box.cx, box.cy);
  await wait(150);
  const corner2 = { x: box.right - 8, y: box.bottom - 8 };
  await p.mouse.move(corner2.x, corner2.y, { steps: 3 });
  await wait(100);
  await press(corner2);
  const pastW = (contactW - b.w + 50) * s;
  const right = await stepTo(corner2, Math.min(pastW, VP.w - 20 - corner2.x), 0, 40, 'resize into agent');
  const atContact = right.at(-1).f.items.browser;
  const overlapped = right.filter((q) => hit({ x: b.x, y: b.y, w: q.f.items.browser.gripW, h: q.f.items.browser.gripH }, ag)).length;
  log(`4b: agent in the same row ${inRow}; at contact ${atContact.gripW} x ${atContact.gripH}, contact width ${contactW}; overlapping samples ${overlapped}`);
  await shot(SHOTS, 'step4-contact');
  const liveBox = screenOf({ x: b.x, y: b.y, w: atContact.gripW + 90, h: atContact.gripH }, await read());
  await cropTo('step4-contact-crop', liveBox);
  // Down, far enough to become a widget at the first size that crosses 168 x 168.
  const corner3 = right.at(-1).ptr;
  const maxH = n2(doc.h - STRIP - b.y);
  const downWorld = maxH - b.h + 30;
  let widgetSeam = null;
  const down = await stepTo(corner3, 0, Math.min(downWorld * s, VP.h - 20 - corner3.y), 36, 'resize down', async (i, fr) => {
    const it = fr.items.browser;
    if (!widgetSeam && it.gripH >= 172) {
      const live = screenOf({ x: it.x, y: it.y, w: it.gripW, h: it.gripH }, fr);
      widgetSeam = await tileSeams(live, s);
      log(`seam scan as a widget, mid-resize, at ${n2(it.gripW)} x ${n2(it.gripH)} ${JSON.stringify(widgetSeam)}`);
      await shot(SHOTS, 'step4-widget-mid-resize');
    }
  });
  const atBottom = down.at(-1).f.items.browser;
  await p.mouse.up();
  doc = await docAfter();
  const after4b = doc.items.browser;
  f = await read();
  box = screenOf(after4b, f);
  await p.mouse.move(40, 760);
  await wait(300);
  await shot(SHOTS, 'step4-widget');
  await cropTo('step4-widget-crop', box);
  log(`4b down: held width ${atBottom.gripW}, height ${atBottom.gripH}, limit ${maxH}; saved ${after4b.w} x ${after4b.h}; overlaps ${overlapsIn(doc.items).length}`);
  const contactOk = inRow && overlapped === 0 && near(atContact.gripW, contactW) && near(after4b.w, contactW) && near(after4b.h, maxH) && overlapsIn(doc.items).length === 0;

  // 4c. Far smaller.
  b = after4b;
  await p.mouse.move(box.cx, box.cy);
  await wait(150);
  const corner4 = { x: box.right - 8, y: box.bottom - 8 };
  await p.mouse.move(corner4.x, corner4.y, { steps: 3 });
  await wait(100);
  await press(corner4);
  const target = { x: box.left + 26 * s, y: box.top + 26 * s };
  const small = await stepTo(corner4, target.x - corner4.x, target.y - corner4.y, 40, 'resize far smaller');
  const atMin = small.at(-1).f.items.browser;
  const belowMin = small.filter((q) => q.f.items.browser.gripW < MIN - 0.01 || q.f.items.browser.gripH < MIN - 0.01).length;
  await shot(SHOTS, 'step4-min-held');
  await cropTo('step4-min-held-crop', screenOf({ x: b.x, y: b.y, w: 60, h: 60 }, await read()), 40);
  await p.mouse.up();
  doc = await docAfter();
  const after4c = doc.items.browser;
  f = await read();
  box = screenOf(after4c, f);
  await p.mouse.move(40, 760);
  await wait(300);
  await shot(SHOTS, 'step4-min');
  await cropTo('step4-min-crop', box, 40);
  log(`4c: held at ${atMin.gripW} x ${atMin.gripH}; samples below the minimum ${belowMin}; saved ${after4c.w} x ${after4c.h} at ${after4c.x},${after4c.y}`);
  const minOk = near(after4c.w, MIN) && near(after4c.h, MIN) && belowMin === 0 && near(after4c.x, b.x) && near(after4c.y, b.y);
  const seams = [seamMid, seamAfter, widgetSeam].filter(Boolean).every((q) => q.row.off === 0 && q.column.off === 0);
  result(4, hoverRead.gripW !== null && cursor === 'nwse-resize' && free && contactOk && minOk && seams && widgetSeam !== null, `hover shows the corner, cursor ${cursor}; +${DX},+${DY} px gave ${after4a.w} x ${after4a.h} vs ${wantW} x ${wantH}, ${sizes.size} distinct sizes in 24 steps, furthest ${n2(maxErr)} units from the pointer; stopped at agent with width ${atContact.gripW} (contact ${contactW}), ${overlapped} overlapping samples; grew down to ${after4b.w} x ${after4b.h}; stopped at ${after4c.w} x ${after4c.h}; off-colour pixels ${seamMid?.row.off}+${seamMid?.column.off} mid, ${seamAfter.row.off}+${seamAfter.column.off} at rest, ${widgetSeam?.row.off}+${widgetSeam?.column.off} as a widget`);
}

// ----- 5. The keyboard

{
  const said = () => p.evaluate(() => document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '');
  const key = async (k, times = 1) => {
    for (let i = 0; i < times; i += 1) {
      await p.keyboard.press(k);
      await wait(70);
    }
    log(`key ${k}${times > 1 ? ` x${times}` : ''}: says ${JSON.stringify(await said())}`);
  };
  const dialogs = () => p.getByRole('dialog').count();
  const focusId = () => p.evaluate(() => document.activeElement?.id ?? '');
  const proxy = proxyOf('notebook');
  const start = doc.items.notebook;
  log(`keyboard starts with notebook at ${fmt(start)}`);
  await proxy.focus();
  await wait(150);

  // m, arrows, Enter.
  await key('m');
  const editing = await p.evaluate((id) => document.getElementById(id)?.className, `proxy-${ALLOWED}:notebook`);
  await key('ArrowDown', 2);
  await key('ArrowLeft');
  await shot(SHOTS, 'step5-moving');
  await key('Enter');
  await wait(200);
  doc = await docAfter();
  const a = doc.items.notebook;
  const wantA = { x: start.x - 8, y: start.y + 16, w: start.w, h: start.h };
  const aOk = near(a.x, wantA.x) && near(a.y, wantA.y) && near(a.w, wantA.w) && near(a.h, wantA.h);
  const focusA = await focusId();
  const dialogsA = await dialogs();
  const modeA = (await view()).mode;
  log(`m Enter: ${fmt(a)} vs ${fmt(wantA)}; class while editing ${JSON.stringify(editing)}; focus ${focusA.endsWith(':notebook')}; windows open ${dialogsA}; mode ${modeA}`);

  // m, arrows, Esc. One arrow runs into Browser, which the keyboard jumps past, so Esc has further to restore.
  await key('m');
  await key('ArrowRight', 2);
  await key('ArrowUp');
  await wait(220);
  const midLive = (await read()).items.notebook;
  await shot(SHOTS, 'step5-moved-before-esc');
  log(`before Esc it's live at ${midLive.x},${midLive.y}; browser is at ${fmt(doc.items.browser)}`);
  await key('Escape');
  await wait(200);
  doc = await docAfter();
  const b = doc.items.notebook;
  const bOk = near(b.x, a.x) && near(b.y, a.y) && near(b.w, a.w) && near(b.h, a.h) && (midLive.x !== a.x || midLive.y !== a.y);
  const modeB = (await view()).mode;
  const dialogsB = await dialogs();
  log(`m Esc: ${fmt(b)} vs ${fmt(a)}; had really moved ${midLive.x !== a.x || midLive.y !== a.y}; mode ${modeB}; windows open ${dialogsB}; focus ${(await focusId()).endsWith(':notebook')}`);

  // r, arrows, Enter.
  await key('r');
  await key('ArrowDown', 2);
  await key('ArrowLeft');
  await shot(SHOTS, 'step5-resizing');
  await key('Enter');
  await wait(200);
  doc = await docAfter();
  const c = doc.items.notebook;
  const wantC = { x: a.x, y: a.y, w: a.w - 8, h: a.h + 16 };
  const cOk = near(c.x, wantC.x) && near(c.y, wantC.y) && near(c.w, wantC.w) && near(c.h, wantC.h);
  const dialogsC = await dialogs();
  const pairs = overlapsIn(doc.items);
  await shot(SHOTS, 'step5-end');
  log(`r Enter: ${fmt(c)} vs ${fmt(wantC)}; windows open ${dialogsC}; focus ${(await focusId()).endsWith(':notebook')}; overlaps ${pairs.length}`);
  result(5, aOk && bOk && cOk && dialogsA === 0 && dialogsB === 0 && dialogsC === 0 && modeA === 'desk' && modeB === 'desk' && pairs.length === 0, `m+arrows+Enter ${fmt(start)} to ${fmt(a)}; m+arrows+Esc went to ${midLive.x},${midLive.y} and restored ${fmt(b)}; r+arrows+Enter to ${fmt(c)}; no window opened on Enter, Esc didn't leave the desk; overlaps ${pairs.length}`);
}

// ----- 6. Reload

{
  doc = await docAfter();
  const before = JSON.stringify(doc);
  await p.mouse.move(40, 760);
  await wait(200);
  await shot(SHOTS, 'step6-before-reload');
  const tReload = Date.now();
  delete S.labels[ALLOWED];
  log('reloading');
  await p.reload({ waitUntil: 'load' });
  const onlineAgain = await waitPanel(/online/, 60000);
  const ms = Date.now() - tReload;
  await settled();
  const after = await docAfter();
  const same = JSON.stringify(after) === before;
  const live = await read();
  const liveOk = APPS.every((a) => near(live.items[a].x, after.items[a].x) && near(live.items[a].y, after.items[a].y));
  const proxies = await p.evaluate(({ id, apps }) => Object.fromEntries(apps.map((a) => {
    const r = document.getElementById(`proxy-${id}:${a}`)?.getBoundingClientRect();
    return [a, r ? { w: r.width, h: r.height } : null];
  })), { id: ALLOWED, apps: APPS });
  const sizesOk = APPS.every((a) => near(proxies[a].w / live.cam.s, after.items[a].w, 0.5) && near(proxies[a].h / live.cam.s, after.items[a].h, 0.5));
  const v = await view();
  const calls = S.connects.filter((c) => c.at >= tReload);
  const pairs = overlapsIn(after.items);
  await shot(SHOTS, 'step6-after-reload');
  log(`after the reload: online in ${ms} ms; doc identical ${same}; drawn positions match ${liveOk}; proxy sizes match ${sizesOk}; view ${JSON.stringify(v)}; connect ${JSON.stringify(calls.map((c) => ({ desk: c.desk === ALLOWED ? 'test' : 'other', start: c.start })))}; overlaps ${pairs.length}`);
  result(6, onlineAgain && same && liveOk && sizesOk && v.mode === 'desk' && v.activeDesk === ALLOWED && calls.every((c) => c.start === false) && pairs.length === 0, `doc byte-identical ${same}; ${APPS.map((a) => `${a} ${fmt(after.items[a])}`).join('; ')}; drawn and proxied the same; name ${JSON.stringify(testLabel())}; connect since the reload ${calls.length}, start:true ${calls.filter((c) => c.start !== false).length}`);
}

// ----- 7. The guard's word, and leave cleanly

const connects = S.connects.filter((c) => c.action === 'connect');
const wakes = S.connects.filter((c) => c.start !== false || c.action !== 'connect');
const consoleProblems = events.filter((e) => e.k === 'console');
const wsErrors = events.filter((e) => e.k === 'ws' && e.type === 'error');
const hello = events.find((e) => e.k === 'ctl.hello.sent');
log(`guard: connect calls ${connects.length} (test ${connects.filter((c) => c.desk === ALLOWED).length}, other ${connects.filter((c) => c.desk === OTHER).length}), start:true or other lifecycle calls ${wakes.length}`);
log(`bundle's own HELLO appVersion ${hello?.appVersion}`);
log(`console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);
result(7, wakes.length === 0 && consoleProblems.length === 0 && wsErrors.length === 0 && !S.guardTripped, `start:true ${wakes.length}, guard tripped ${S.guardTripped}, console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);

S.afterClose = async () => {
  await wait(800);
  const d = await getDesk();
  log(`DESK after close state=${d.state} phase=${d.phase} clientConnected=${d.clientConnected} autoStopMinutes=${d.autoStopMinutes} autoStopAt=${d.autoStopAt}`);
};
log(`SUMMARY ${JSON.stringify(results.map((r) => ({ step: r.step, pass: r.pass })))}`);
await shutdown(results.every((r) => r.pass) ? 0 : 1, 'done');
