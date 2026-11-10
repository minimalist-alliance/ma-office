/* eslint-disable @typescript-eslint/no-unused-vars */
// One pass over the 42d3112 desk: the cleanup button, its Undo, the context menu, and a desk that goes where
// it's dropped. Signed in as desk-1 with a fresh layout; only the test desk (RT_DESK) is focused; start:true is refused
// for every desk. Live values come from the Konva stage, found through its React fiber: read-only.
// What a screenshot shows is judged by reading it. This script only measures.
import { mkdirSync } from 'node:fs';
import { ALLOWED, events, getDesk, HOST, log, logConfig, openSession, OTHER, S, shot, shutdown, testLabel, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-stage4/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const STRIP = 44;
const PAD = 24;
const GAP = 16;
const APPS = ['chat', 'notebook', 'browser', 'agent'];
const VP = { w: 1440, h: 900 };
const CONTROL_PROXY = `proxy-cleanup:${ALLOWED}`;

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 9 * 60 * 1000);
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
  // Runs after the app's own handler, so it sees whether the browser's menu was refused.
  window.addEventListener('contextmenu', (e) => {
    window.__rtCtx = { prevented: e.defaultPrevented, tag: e.target?.tagName };
  });
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
    const clean = desk.findOne('.desk-cleanup');
    const undo = desk.findOne('.desk-undo');
    const node = clean ?? undo;
    const rect = node?.findOne('Rect');
    return {
      cam: { x: st.x(), y: st.y(), s: st.scaleX() },
      desk: { x: desk.x(), y: desk.y(), handleW: h ? h.x() + 30 : null, handleH: h ? h.y() + 30 : null },
      items,
      cursor: st.container().style.cursor,
      title: st.container().title,
      control: node ? { kind: clean ? 'cleanup' : 'undo', x: node.x(), y: node.y(), w: rect?.width() ?? null, h: rect?.height() ?? null, visible: node.visible(), text: undo?.findOne('Text')?.text() ?? null } : null,
    };
  };
  window.__rtSample = (deskId) => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(window.__rtRead(deskId)))));
  window.__rtRecord = (deskId) => {
    window.__rtFrames = [];
    window.__rtRec = true;
    const tick = () => {
      if (!window.__rtRec) return;
      const f = window.__rtRead(deskId);
      if (f) window.__rtFrames.push({ t: Math.round(performance.now()), items: f.items, cam: f.cam, handleW: f.desk.handleW, handleH: f.desk.handleH });
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
    write(`=== rt-stage4 start ${new Date(started).toISOString()}`);
    write(`=== BUNDLE ${v ?? 'UNKNOWN'} (from the page's /v/<version>/ asset path)${v === EXPECTED ? ' matches the expected version' : ` DOES NOT MATCH expected ${EXPECTED}`}`);
    for (const l of held ?? []) write(l);
    held = null;
    if (v !== EXPECTED) throw new Error(`staging serves ${v}, not ${EXPECTED}`);
  },
});

const p = S.page;
const btn = p.locator(`#proxy-${ALLOWED}`);
const storage = (k) => p.evaluate((key) => localStorage.getItem(key), k);
const read = () => p.evaluate((id) => window.__rtRead(id), ALLOWED);
const sample = () => p.evaluate((id) => window.__rtSample(id), ALLOWED);
const record = () => p.evaluate((id) => window.__rtRecord(id), ALLOWED);
const recordStop = () => p.evaluate(() => window.__rtRecordStop());
const dialogs = () => p.getByRole('dialog').count();

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

/** The saved desk, after the mirror's 1 s debounce. `order` is the list as stored, so reading order can be checked. */
async function docAfter(quiet = false) {
  await wait(1300);
  const d = JSON.parse(await storage('ma.layout.v2')).desks[ALLOWED];
  const items = {};
  for (const a of APPS) {
    const i = d.items.find((it) => it.app === a);
    items[a] = { x: i.x, y: i.y, w: i.w, h: i.h };
  }
  if (!quiet) log(`doc desk ${d.w} x ${d.h} at ${d.x},${d.y}; order ${d.items.map((i) => i.app).join(',')}; ${APPS.map((a) => `${a} ${items[a].x},${items[a].y} ${items[a].w}x${items[a].h}`).join('; ')}`);
  return { x: d.x, y: d.y, w: d.w, h: d.h, items, order: d.items.map((i) => i.app) };
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
const deskBox = (d, f) => screenOf({ x: 0, y: 0, w: d.w, h: d.h }, f);

/** The same rule as shell/order.ts: rows by vertical overlap, then x. */
function readingOrder(items) {
  const list = APPS.map((a) => ({ a, ...items[a] })).sort((p1, p2) => p1.y - p2.y || p1.x - p2.x);
  const rows = [];
  for (const d of list) {
    const row = rows.find((r) => d.y < r.bottom);
    if (row) {
      row.items.push(d);
      row.bottom = Math.max(row.bottom, d.y + d.h);
    } else rows.push({ bottom: d.y + d.h, items: [d] });
  }
  return rows.flatMap((r) => r.items.sort((q, r2) => q.x - r2.x)).map((d) => d.a);
}

/** Bare canvas: on the canvas element, and 24 px clear of both desks' proxies. */
const bareCanvas = () =>
  p.evaluate(({ a, b }) => {
    const rects = [a, b].map((id) => document.getElementById(`proxy-${id}`)?.getBoundingClientRect()).filter(Boolean);
    const gap = (x, y) => Math.min(...rects.map((r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))));
    let best = null;
    for (let y = 60; y < innerHeight - 70; y += 20) {
      for (let x = 40; x < innerWidth - 30; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el?.tagName !== 'CANVAS') continue;
        const d = gap(x, y);
        if (d > 24 && (!best || d > best.d)) best = { x, y, d: Math.round(d) };
      }
    }
    return best;
  }, { a: ALLOWED, b: OTHER });

/** A spot on the desk's bare panel: clear of the apps and the strip, as far from them as can be. */
function panelSpot(d, f) {
  let best = null;
  for (let y = 12; y < d.h - STRIP - 6; y += 4) {
    for (let x = 12; x < d.w - 12; x += 4) {
      let clear = Infinity;
      for (const a of APPS) {
        const r = d.items[a];
        clear = Math.min(clear, Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h))));
      }
      if (clear > 10 && (!best || clear > best.clear)) best = { x, y, clear };
    }
  }
  if (!best) return null;
  return { x: f.cam.x + (f.desk.x + best.x) * f.cam.s, y: f.cam.y + (f.desk.y + best.y) * f.cam.s, world: { x: best.x, y: best.y } };
}

async function press(from) {
  await p.mouse.move(from.x, from.y);
  await wait(90);
  await p.mouse.down();
}
async function stepTo(from, dx, dy, n) {
  let last = null;
  for (let i = 1; i <= n; i += 1) {
    await p.mouse.move(from.x + (dx * i) / n, from.y + (dy * i) / n);
    last = await sample();
  }
  return last;
}

/** Moves an app through world-unit legs, in small steps. */
async function dragApp(d, app, legs) {
  const f = await read();
  const s = f.cam.s;
  const c = screenOf(d.items[app], f);
  let from = { x: c.cx, y: c.cy };
  await press(from);
  for (const [dw, dh] of legs) {
    const n = Math.max(8, Math.round(Math.hypot(dw, dh) * s / 6));
    await stepTo(from, dw * s, dh * s, n);
    from = { x: from.x + dw * s, y: from.y + dh * s };
  }
  await p.mouse.up();
  await wait(250);
}
/** Resizes an app by world units, from its corner handle, shown by hovering. */
async function resizeApp(d, app, dw, dh) {
  const f = await read();
  const s = f.cam.s;
  const box = screenOf(d.items[app], f);
  await p.mouse.move(box.cx, box.cy);
  await wait(140);
  const corner = { x: box.right - 8, y: box.bottom - 8 };
  await p.mouse.move(corner.x, corner.y, { steps: 3 });
  await wait(90);
  await press(corner);
  await stepTo(corner, dw * s, dh * s, Math.max(10, Math.round(Math.hypot(dw, dh) * s / 6)));
  await p.mouse.up();
  await wait(250);
}

/** Where the strip's control is on screen, from its Konva node, and from its proxy for comparison. */
async function controlAt() {
  const f = await read();
  const c = f?.control;
  const proxy = await p.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, name: el.getAttribute('aria-label') };
  }, CONTROL_PROXY);
  if (!c) return { node: null, proxy, screen: null };
  const screen = screenOf({ x: c.x, y: c.y, w: c.w, h: c.h }, f);
  return { node: c, proxy, screen };
}

const menuState = () =>
  p.evaluate(() => {
    const m = document.querySelector('.desk-menu');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { label: m.getAttribute('aria-label'), items: [...m.querySelectorAll('[role="menuitem"]')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })), x: r.x, y: r.y, w: r.width, h: r.height };
  });
const ctxSeen = () => p.evaluate(() => window.__rtCtx ?? null);
/** A real right click. What came of it: our menu, and whether the browser's own was refused. */
async function rightClick(pt) {
  await p.evaluate(() => {
    window.__rtCtx = null;
  });
  await p.mouse.click(pt.x, pt.y, { button: 'right' });
  await wait(180);
  return { menu: await menuState(), ctx: await ctxSeen() };
}
const showMenu = (m) => (m ? `${m.label}: ${m.items.map((i) => `${i.text}${i.disabled ? ' (disabled)' : ''}`).join(', ')}` : 'none');

/** Every frame of a glide: its span, overlaps by pair, and whether the camera moved. */
function glideReport(frames, sizes, label) {
  const key = (fr) => APPS.map((a) => `${fr.items[a]?.x},${fr.items[a]?.y}`).join('|');
  let first = -1;
  let last = -1;
  for (let i = 1; i < frames.length; i += 1) {
    if (key(frames[i]) !== key(frames[i - 1])) {
      if (first < 0) first = i - 1;
      last = i;
    }
  }
  const pairs = new Map();
  let overlapFrames = 0;
  if (first >= 0) {
    for (let i = first; i <= last; i += 1) {
      const at = Object.fromEntries(APPS.map((a) => [a, { x: frames[i].items[a].x, y: frames[i].items[a].y, w: sizes[a].w, h: sizes[a].h }]));
      let any = false;
      for (let m = 0; m < APPS.length; m += 1) {
        for (let n = m + 1; n < APPS.length; n += 1) {
          const u = at[APPS[m]];
          const v = at[APPS[n]];
          if (hit(u, v)) {
            any = true;
            const depth = Math.min(Math.min(u.x + u.w, v.x + v.w) - Math.max(u.x, v.x), Math.min(u.y + u.h, v.y + v.h) - Math.max(u.y, v.y));
            const k = `${APPS[m]}/${APPS[n]}`;
            const cur = pairs.get(k) ?? { frames: 0, deepest: 0 };
            pairs.set(k, { frames: cur.frames + 1, deepest: Math.max(cur.deepest, n2(depth)) });
          }
        }
      }
      if (any) overlapFrames += 1;
    }
  }
  const cam0 = JSON.stringify(frames[0]?.cam);
  const camMoved = frames.filter((fr) => JSON.stringify(fr.cam) !== cam0).length;
  const heights = frames.map((fr) => fr.handleH).filter((h) => h !== null);
  const r = {
    label,
    framesSeen: frames.length,
    glideFrames: first < 0 ? 0 : last - first + 1,
    glideMs: first < 0 ? 0 : frames[last].t - frames[first].t,
    overlapFrames,
    pairs: Object.fromEntries(pairs),
    camMovedFrames: camMoved,
    deskHeightFrom: heights.length ? n2(heights[0]) : null,
    deskHeightTo: heights.length ? n2(heights.at(-1)) : null,
  };
  log(`glide ${JSON.stringify(r)}`);
  return r;
}

function tidyChecks(before, after) {
  const same = APPS.every((a) => near(before.items[a].w, after.items[a].w, 0) && near(before.items[a].h, after.items[a].h, 0));
  const it = after.items;
  let apart = true;
  let smallestGap = Infinity;
  for (let m = 0; m < APPS.length; m += 1) {
    for (let n = m + 1; n < APPS.length; n += 1) {
      const u = it[APPS[m]];
      const v = it[APPS[n]];
      const gapX = Math.max(v.x - (u.x + u.w), u.x - (v.x + v.w));
      const gapY = Math.max(v.y - (u.y + u.h), u.y - (v.y + v.h));
      const g = Math.max(gapX, gapY);
      smallestGap = Math.min(smallestGap, g);
      if (g < GAP - 0.01) apart = false;
    }
  }
  const edges = APPS.every((a) => it[a].x >= PAD - 0.01 && it[a].y >= PAD - 0.01 && it[a].x + it[a].w <= after.w - PAD + 0.01 && it[a].y + it[a].h <= after.h - STRIP + 0.01);
  // Each app sits at the padding or exactly 16 from an app before it, in each direction.
  const anchored = APPS.every((a) => {
    const others = APPS.filter((o) => o !== a).map((o) => it[o]);
    const xOk = near(it[a].x, PAD) || others.some((o) => near(it[a].x, o.x + o.w + GAP));
    const yOk = near(it[a].y, PAD) || others.some((o) => near(it[a].y, o.y + o.h + GAP));
    return xOk && yOk;
  });
  const reading = readingOrder(it);
  const inOrder = JSON.stringify(reading) === JSON.stringify(after.order);
  const pairs = overlapsIn(it);
  const deskOk = near(after.w, before.w, 0) && near(after.x, before.x, 0) && near(after.y, before.y, 0) && after.h >= before.h - 0.001;
  const needH = Math.max(before.h, ...APPS.map((a) => n2(it[a].y + it[a].h + STRIP)));
  const r = { sizesKept: same, overlaps: pairs.length, smallestGap: n2(smallestGap), apart, edges, anchored, stored: after.order.join(','), reading: reading.join(','), inOrder, deskWas: `${before.w}x${before.h}`, deskNow: `${after.w}x${after.h}`, deskOk, deskHeightIsWhatItNeeds: near(after.h, needH, 0.02) };
  log(`tidy checks ${JSON.stringify(r)}`);
  return { ok: same && pairs.length === 0 && apart && edges && anchored && inOrder && deskOk, r };
}

// ----- setup, and the hover rule by itself, in the overview, where the other desk holds the default selection

const onlineOk = await waitPanel(/online/, 60000);
await wait(800);
const version1 = await pageVersion(p).catch(() => null);
await settled();
const v0 = await view();
let doc = await docAfter();
const f0 = await read();
log(`bundle after sign-in ${version1}; v1 layout ${(await storage('ma.layout.v1')) === null ? 'absent' : 'PRESENT'}; view ${JSON.stringify(v0)}; name ${JSON.stringify(testLabel())}; reader ${!!f0}`);
const readerOk = !!f0 && APPS.every((a) => near(f0.items[a]?.x, doc.items[a].x) && near(f0.items[a]?.y, doc.items[a].y));
if (!readerOk || !onlineOk || version1 !== EXPECTED) {
  log(`SCRIPT or STATE problem before any drag: reader ${readerOk}, online ${onlineOk}, version ${version1}`);
  await shutdown(3, 'setup');
}
await shot(SHOTS, 'setup-overview');
const bare0 = await bareCanvas();
log(`bare canvas at ${JSON.stringify(bare0)}`);
const onDesk0 = panelSpot(doc, f0);
await p.mouse.move(bare0.x, bare0.y);
await wait(150);
const tidyOff = (await read()).control;
await p.mouse.move(onDesk0.x, onDesk0.y);
await wait(150);
const tidyOn = (await read()).control;
log(`a tidy desk: control with the pointer off ${JSON.stringify(tidyOff)}, on ${JSON.stringify(tidyOn)}`);

// A small mess, made in the overview. A drag focuses nothing.
await dragApp(doc, 'agent', [[35.3, 13.7]]);
await p.mouse.move(bare0.x, bare0.y);
await wait(250);
const messOff = (await read()).control;
const fOver = await read();
doc = await docAfter();
const spotOver = panelSpot(doc, fOver);
await p.mouse.move(spotOver.x, spotOver.y);
await wait(200);
const messOn = (await read()).control;
await shot(SHOTS, 'step1-hover-in-overview');
await cropTo('step1-hover-in-overview-crop', deskBox(doc, await read()));
await p.mouse.move(bare0.x, bare0.y);
await wait(200);
const messOffAgain = (await read()).control;
const vOver = await view();
log(`a desk with a mess, in the overview: control with the pointer off ${JSON.stringify(messOff)}, on ${JSON.stringify(messOn)}, off again ${JSON.stringify(messOffAgain)}; view ${JSON.stringify(vOver)}`);
const hoverRule = tidyOff === null && tidyOn === null && messOff === null && messOn?.kind === 'cleanup' && messOn?.visible === true && messOffAgain === null;

// ----- 1. Focus, grow, scatter

await btn.focus();
await btn.press('Enter');
await settled();
const v1 = await view();
const f1 = await read();
log(`focused: view ${JSON.stringify(v1)}; camera ${JSON.stringify(f1.cam)}; desk box ${JSON.stringify(deskBox(doc, f1))}`);
if (v1.mode !== 'desk' || v1.activeDesk !== ALLOWED) await shutdown(3, 'not on the desk');
await p.mouse.move(bare0.x, 70);
await wait(200);
const offOnFocused = (await read()).control;
log(`focused, with the pointer off the desk: control ${JSON.stringify(offOnFocused)}`);
await shot(SHOTS, 'step1-focused');

// Grow it, with the real mouse.
{
  const s = f1.cam.s;
  const box = deskBox(doc, f1);
  const from = { x: box.right - 12, y: box.bottom - 12 };
  const dx = Math.min(120, VP.w - 56 - from.x);
  const dy = Math.min(190, VP.h - 56 - from.y);
  log(`growing the desk from ${n2(from.x)},${n2(from.y)} by ${n2(dx)},${n2(dy)} px`);
  await press(from);
  await stepTo(from, dx, dy, 24);
  await p.mouse.up();
  await wait(300);
  doc = await docAfter();
  void s;
}

// Scatter them, so reading order changes and the wide apps force the desk to grow.
{
  const toward = (d, app, x, y) => [x - d.items[app].x, y - d.items[app].y];
  await dragApp(doc, 'agent', [toward(doc, 'agent', 510.86, 10.29)]);
  doc = await docAfter(true);
  const chat = doc.items.chat;
  await dragApp(doc, 'chat', [[0, 110.71 - chat.y], [400.14 - chat.x, 0]]);
  doc = await docAfter(true);
  await dragApp(doc, 'notebook', [toward(doc, 'notebook', 30.29, 100.14)]);
  doc = await docAfter(true);
  await dragApp(doc, 'browser', [toward(doc, 'browser', 130.86, 109.14)]);
  doc = await docAfter(true);
  await resizeApp(doc, 'browser', 240.43 - doc.items.browser.w, 97.14 - doc.items.browser.h);
  doc = await docAfter(true);
  await resizeApp(doc, 'chat', 180.29 - doc.items.chat.w, 92.57 - doc.items.chat.h);
  doc = await docAfter();
}
const before = doc;
const beforeJson = JSON.stringify(before);
const pairs1 = overlapsIn(before.items);
const f2 = await read();
const spot = panelSpot(before, f2);
await p.mouse.move(bare0.x, 70);
await wait(200);
await p.mouse.move(spot.x, spot.y);
await wait(220);
const ctl1 = await controlAt();
log(`scattered; bare panel spot ${JSON.stringify(spot)}; control ${JSON.stringify(ctl1.node)}; its proxy ${JSON.stringify(ctl1.proxy)}; overlaps ${pairs1.length}`);
await shot(SHOTS, 'step1-scattered');
await cropTo('step1-button-crop', { left: ctl1.screen.left - 120, right: ctl1.screen.right + 60, top: ctl1.screen.top - 60, bottom: ctl1.screen.bottom + 20 }, 10);
const nonGrid = APPS.some((a) => before.items[a].x % 8 !== 0) && APPS.some((a) => before.items[a].w % 8 !== 0);
const buttonFound = ctl1.node?.kind === 'cleanup' && ctl1.node.visible && !!ctl1.proxy && near(ctl1.proxy.x, ctl1.screen.left, 2) && near(ctl1.proxy.y, ctl1.screen.top, 2);
const leftOfCorner = ctl1.node && ctl1.node.x + ctl1.node.w <= before.w - 30;
result(1, hoverRule && nonGrid && buttonFound && !!leftOfCorner && pairs1.length === 0, `hover rule in the overview: tidy desk none on or off; a messy desk none off, shown on, none off again. Focused, it also shows with the pointer off the desk: ${offOnFocused?.kind ?? 'no'}. Scattered ${APPS.map((a) => `${a} ${fmt(before.items[a])}`).join('; ')} on a ${before.w}x${before.h} desk; button ${ctl1.node?.w}x${ctl1.node?.h} at ${ctl1.node?.x},${ctl1.node?.y}, left of the corner, its proxy agreeing; aria name ${JSON.stringify(ctl1.proxy?.name)}`);

// ----- 2. Clean up

let firstAfterJson;
{
  const fb = await read();
  const camBefore = JSON.stringify(fb.cam);
  await p.mouse.move(ctl1.screen.cx, ctl1.screen.cy);
  await wait(180);
  const hoverRead = await read();
  log(`on the button: cursor ${JSON.stringify(hoverRead.cursor)}, title ${JSON.stringify(hoverRead.title)}`);
  await shot(SHOTS, 'step2-before');
  await record();
  await p.mouse.down();
  await p.mouse.up();
  await wait(650);
  const frames = await recordStop();
  const g = glideReport(frames, before.items, 'cleanup');
  await shot(SHOTS, 'step2-after-with-undo');
  const after = await docAfter();
  firstAfterJson = JSON.stringify(after);
  const t = tidyChecks(before, after);
  const fa = await read();
  const camStill = JSON.stringify(fa.cam) === camBefore && g.camMovedFrames === 0;
  const ctl = await controlAt();
  log(`after: camera ${JSON.stringify(fa.cam)} (was ${camBefore}), still ${camStill}; control ${JSON.stringify(ctl.node)}; its proxy ${JSON.stringify(ctl.proxy)}; windows ${await dialogs()}`);
  await cropTo('step2-undo-crop', { left: ctl.screen.left - 120, right: ctl.screen.right + 60, top: ctl.screen.top - 60, bottom: ctl.screen.bottom + 20 }, 10);
  await cropTo('step2-after-crop', deskBox(after, fa));
  const noOverlap = g.overlapFrames === 0;
  result(2, t.ok && camStill && noOverlap && g.glideFrames > 0, `${APPS.map((a) => `${a} ${fmt(after.items[a])}`).join('; ')}; sizes kept ${t.r.sizesKept}; smallest gap ${t.r.smallestGap}; edges ${t.r.edges}; anchored at 24 or 16 from a neighbour ${t.r.anchored}; order ${t.r.stored} reads ${t.r.reading}; desk ${t.r.deskWas} to ${t.r.deskNow}; camera still ${camStill}; glide ${g.glideFrames} frames over ${g.glideMs} ms, overlapping in ${g.overlapFrames}, pairs ${JSON.stringify(g.pairs)}`);
}

// ----- 3. Undo, and a tidy desk has no button

{
  const ctl = await controlAt();
  const says = ctl.node?.kind === 'undo' ? ctl.node.text : null;
  log(`the button says ${JSON.stringify(says)}; proxy name ${JSON.stringify(ctl.proxy?.name)}`);
  await p.mouse.move(ctl.screen.cx, ctl.screen.cy);
  await wait(150);
  await record();
  await p.mouse.down();
  await p.mouse.up();
  await wait(650);
  const frames = await recordStop();
  const gu = glideReport(frames, before.items, 'undo');
  const restored = await docAfter();
  const exact = JSON.stringify(restored) === beforeJson;
  const afterUndo = await controlAt();
  log(`undo: doc exact ${exact}; control now ${JSON.stringify(afterUndo.node)}`);
  await shot(SHOTS, 'step3-after-undo');

  // Again, and leave it.
  const c2 = await controlAt();
  await p.mouse.move(c2.screen.cx, c2.screen.cy);
  await wait(120);
  const t0 = Date.now();
  await p.mouse.down();
  await p.mouse.up();
  await wait(300);
  const again = await docAfter();
  const sameAgain = JSON.stringify(again) === firstAfterJson;
  // The pointer stays on the desk. "Undo" should go at 10 s, with nothing in its place.
  const f3 = await read();
  const spot3 = panelSpot(again, f3);
  await p.mouse.move(spot3.x, spot3.y);
  let goneAt = null;
  while (Date.now() - t0 < 16000) {
    const f = await read();
    if (!f.control) {
      goneAt = Date.now() - t0;
      break;
    }
    await wait(100);
  }
  log(`clean up again: same result as the first ${sameAgain}; "Undo" gone after ${goneAt} ms, with the pointer on the desk`);
  await wait(400);
  const ctlGone = await controlAt();
  await p.mouse.move(bare0.x, 70);
  await wait(150);
  await p.mouse.move(spot3.x, spot3.y);
  await wait(200);
  const ctlBack = await controlAt();
  log(`on a tidy desk: control ${JSON.stringify(ctlGone.node)}, proxy ${JSON.stringify(ctlGone.proxy)}; off and on again ${JSON.stringify(ctlBack.node)}`);
  await shot(SHOTS, 'step3-tidy-no-button');
  await cropTo('step3-tidy-strip-crop', { left: f3.cam.x + (f3.desk.x + again.w - 200) * f3.cam.s, right: f3.cam.x + (f3.desk.x + again.w) * f3.cam.s, top: f3.cam.y + (f3.desk.y + again.h - 50) * f3.cam.s, bottom: f3.cam.y + (f3.desk.y + again.h) * f3.cam.s }, 10);

  // A second cleanup through the menu, if it's enabled.
  const m = await rightClick(spot3);
  log(`menu on the tidy desk: ${showMenu(m.menu)}; browser menu refused ${m.ctx?.prevented}`);
  const cleanItem = m.menu?.items.find((i) => i.text === 'Clean up');
  let secondOk;
  if (cleanItem?.disabled) {
    await p.getByRole('menuitem', { name: 'Clean up', exact: true }).click({ force: true, timeout: 2000 }).catch((e) => log('click on the disabled item', e.message.slice(0, 100)));
    await wait(200);
    const d2 = await docAfter(true);
    secondOk = JSON.stringify(d2) === firstAfterJson;
    log(`Clean up is disabled; a forced click on it changed nothing: ${secondOk}`);
  } else {
    await p.getByRole('menuitem', { name: 'Clean up', exact: true }).click();
    await wait(400);
    const d2 = await docAfter(true);
    secondOk = JSON.stringify(d2) === firstAfterJson;
    log(`Clean up was enabled; running it changed nothing: ${secondOk}`);
  }
  if (await menuState()) {
    await p.keyboard.press('Escape');
    await wait(150);
  }
  result(3, says === 'Undo' && exact && gu.camMovedFrames === 0 && sameAgain && goneAt !== null && !ctlGone.node && !ctlGone.proxy && !ctlBack.node && !!secondOk && !!cleanItem?.disabled, `button said ${JSON.stringify(says)}; undo restored the doc byte for byte ${exact}, desk ${restored.w}x${restored.h}; undo's glide overlapped in ${gu.overlapFrames} of ${gu.glideFrames} frames; cleaned again to the same result ${sameAgain}; "Undo" left after ${goneAt} ms and nothing replaced it, on or off the desk; menu's Clean up disabled ${cleanItem?.disabled}, and nothing changed`);
}

// ----- 4. The context menus

{
  const tidy = await docAfter(true);
  let f = await read();
  let spot4 = panelSpot(tidy, f);

  // Tidy, undo still good.
  const a = await rightClick(spot4);
  log(`A. desk, tidy, undo good: ${showMenu(a.menu)}; browser menu refused ${a.ctx?.prevented}; at ${a.menu?.x},${a.menu?.y} for a click at ${spot4.x},${spot4.y}; focus on the menu ${await p.evaluate(() => document.activeElement?.classList.contains('desk-menu'))}`);
  await shot(SHOTS, 'step4-menu-tidy');
  // Its Undo clean up brings the mess back.
  await p.getByRole('menuitem', { name: 'Undo clean up', exact: true }).click();
  await wait(500);
  const viaUndo = await docAfter(true);
  const undoOk = JSON.stringify(viaUndo) === beforeJson;
  const menuGone1 = (await menuState()) === null;
  log(`menu's Undo clean up restored the mess exactly: ${undoOk}; menu closed ${menuGone1}`);

  // Messy, nothing to undo.
  f = await read();
  spot4 = panelSpot(viaUndo, f);
  const b = await rightClick(spot4);
  log(`B. desk, messy: ${showMenu(b.menu)}; browser menu refused ${b.ctx?.prevented}`);
  await shot(SHOTS, 'step4-menu-messy');
  await p.getByRole('menuitem', { name: 'Clean up', exact: true }).click();
  await wait(500);
  const viaMenu = await docAfter(true);
  const cleanOk = JSON.stringify(viaMenu) === firstAfterJson;
  log(`menu's Clean up gave the same result as the button: ${cleanOk}`);

  // Esc on the desk's menu.
  f = await read();
  spot4 = panelSpot(viaMenu, f);
  const c = await rightClick(spot4);
  log(`C. desk, tidy again: ${showMenu(c.menu)}`);
  await p.keyboard.press('Escape');
  await wait(180);
  const escDesk = (await menuState()) === null;
  const v4a = await view();
  log(`Esc closes it: ${escDesk}; mode ${v4a.mode}`);

  // An app's menu.
  const box = screenOf(viaMenu.items.notebook, f);
  const d = await rightClick({ x: box.cx, y: box.cy });
  log(`D. app: ${showMenu(d.menu)}; browser menu refused ${d.ctx?.prevented}`);
  await shot(SHOTS, 'step4-menu-app');
  await p.keyboard.press('Escape');
  await wait(180);
  const escApp = (await menuState()) === null;
  const v4b = await view();
  const winsAfterApp = await dialogs();
  log(`Esc closes it: ${escApp}; mode ${v4b.mode}; windows ${winsAfterApp}`);

  // Move from the app's menu starts a keyboard move, and Esc ends it where it began.
  const d2 = await rightClick({ x: box.cx, y: box.cy });
  await p.getByRole('menuitem', { name: 'Move', exact: true }).click();
  await wait(150);
  const editingApp = await p.evaluate((id) => document.getElementById(id)?.className, `proxy-${ALLOWED}:notebook`);
  await p.keyboard.press('ArrowDown');
  await wait(180);
  const nudged = (await read()).items.notebook;
  await p.keyboard.press('Escape');
  await wait(200);
  const afterMove = await docAfter(true);
  const moveOk = /editing/.test(editingApp ?? '') && nudged.y !== viaMenu.items.notebook.y && JSON.stringify(afterMove) === firstAfterJson;
  log(`app menu had ${showMenu(d2.menu)}; Move: class ${JSON.stringify(editingApp)}, an arrow took it to y ${nudged.y}, Esc restored ${JSON.stringify(afterMove) === firstAfterJson}`);

  // Resize from the desk's menu, likewise.
  f = await read();
  await rightClick(panelSpot(afterMove, f));
  await p.getByRole('menuitem', { name: 'Resize', exact: true }).click();
  await wait(150);
  const editingDesk = await p.evaluate((id) => document.getElementById(id)?.className, `proxy-${ALLOWED}`);
  await p.keyboard.press('ArrowDown');
  await wait(150);
  await p.keyboard.press('Escape');
  await wait(200);
  const afterResize = await docAfter(true);
  const resizeOk = /editing/.test(editingDesk ?? '') && JSON.stringify(afterResize) === firstAfterJson;
  log(`desk menu Resize: class ${JSON.stringify(editingDesk)}, Esc restored ${JSON.stringify(afterResize) === firstAfterJson}`);

  // The empty canvas keeps the browser's own.
  const bare = await bareCanvas();
  const e = await rightClick(bare);
  log(`E. empty canvas at ${bare.x},${bare.y}: ours ${showMenu(e.menu)}; browser menu refused ${e.ctx?.prevented}`);

  // A probe: clicking away from an open menu, on bare canvas.
  f = await read();
  await rightClick(panelSpot(afterResize, f));
  const openBefore = (await menuState()) !== null;
  await p.mouse.click(bare.x, bare.y);
  await wait(300);
  const v4c = await view();
  const closedAway = (await menuState()) === null;
  log(`PROBE click on bare canvas with the menu open (open ${openBefore}): menu closed ${closedAway}; mode now ${v4c.mode}`);
  await settled();
  if (v4c.mode !== 'desk') {
    await btn.focus();
    await btn.press('Enter');
    await settled();
    log(`back on the desk: ${JSON.stringify(await view())}`);
  }
  const textsA = a.menu?.items.map((i) => i.text).join();
  const textsB = b.menu?.items.map((i) => i.text).join();
  const aOk = textsA === 'Clean up,Undo clean up,Move,Resize' && a.menu.items[0].disabled && !a.menu.items[1].disabled && !a.menu.items[2].disabled && !a.menu.items[3].disabled;
  const bOk = textsB === 'Clean up,Move,Resize' && !b.menu.items[0].disabled;
  const dOk = d.menu?.items.map((i) => i.text).join() === 'Move,Resize' && d.menu.label === 'App' && !d.menu.items[0].disabled && !d.menu.items[1].disabled;
  const refused = a.ctx?.prevented && b.ctx?.prevented && d.ctx?.prevented;
  const emptyOk = e.menu === null && e.ctx?.prevented === false;
  result(4, aOk && bOk && dOk && refused && emptyOk && escDesk && escApp && v4a.mode === 'desk' && v4b.mode === 'desk' && winsAfterApp === 0 && undoOk && cleanOk && moveOk && resizeOk, `desk, tidy with undo: ${showMenu(a.menu)}; desk, messy: ${showMenu(b.menu)}; app: ${showMenu(d.menu)}; Esc closes both and stays on the desk; browser's menu refused on desk and app, left alone on empty canvas with none of ours; menu Undo exact ${undoOk}, menu Clean up same as the button ${cleanOk}, Move ${moveOk}, Resize ${resizeOk}`);
}

// ----- 5. A desk goes where it's dropped, and a reload keeps it all

{
  const start = await docAfter(true);
  const f = await read();
  const s = f.cam.s;
  const from = panelSpot(start, f);
  const DX = 73;
  const DY = -37;
  log(`dragging the desk by its bare panel from ${n2(from.x)},${n2(from.y)} by ${DX},${DY} px at ${s}x`);
  await press(from);
  await stepTo(from, DX, DY, 24);
  const live = (await read()).desk;
  await shot(SHOTS, 'step5-drag-held');
  await p.mouse.up();
  await wait(300);
  const moved = await docAfter();
  const after = await read();
  const wantX = n2(start.x + DX / s);
  const wantY = n2(start.y + DY / s);
  const exact = near(moved.x, wantX, 0.02) && near(moved.y, wantY, 0.02) && near(moved.x, live.x, 0.01) && near(moved.y, live.y, 0.01);
  const notGrid = moved.x % 8 !== 0 && moved.y % 8 !== 0;
  const rest = JSON.stringify(moved.items) === JSON.stringify(start.items) && moved.w === start.w && moved.h === start.h;
  const camStill = JSON.stringify(after.cam) === JSON.stringify(f.cam);
  const v5 = await view();
  log(`dropped: doc ${moved.x},${moved.y}; the pointer says ${wantX},${wantY}; live before the drop ${live.x},${live.y}; mod 8: ${n2(moved.x % 8)},${n2(moved.y % 8)}; apps and size unchanged ${rest}; camera still ${camStill}; mode ${v5.mode}`);
  await p.mouse.move(bare0.x, 70);
  await wait(200);
  await shot(SHOTS, 'step5-dropped');

  const beforeReload = JSON.stringify(moved);
  const tReload = Date.now();
  delete S.labels[ALLOWED];
  log('reloading');
  await p.reload({ waitUntil: 'load' });
  const onlineAgain = await waitPanel(/online/, 60000);
  const ms = Date.now() - tReload;
  await settled();
  const reloaded = await docAfter();
  const same = JSON.stringify(reloaded) === beforeReload;
  const live2 = await read();
  const drawnOk = near(live2.desk.x, reloaded.x) && near(live2.desk.y, reloaded.y) && APPS.every((a) => near(live2.items[a].x, reloaded.items[a].x) && near(live2.items[a].y, reloaded.items[a].y));
  const v6 = await view();
  const calls = S.connects.filter((c) => c.at >= tReload);
  await shot(SHOTS, 'step5-after-reload');
  const spot5 = panelSpot(reloaded, live2);
  await p.mouse.move(spot5.x, spot5.y);
  await wait(200);
  const ctlAfter = await controlAt();
  const m = await rightClick(spot5);
  log(`after the reload: online in ${ms} ms; doc identical ${same}; drawn matches ${drawnOk}; view ${JSON.stringify(v6)}; connect ${JSON.stringify(calls.map((c) => ({ desk: c.desk === ALLOWED ? 'test' : 'other', start: c.start })))}; control ${JSON.stringify(ctlAfter.node)}; menu ${showMenu(m.menu)}`);
  if (await menuState()) {
    await p.keyboard.press('Escape');
    await wait(150);
  }
  result(5, exact && notGrid && rest && camStill && onlineAgain && same && drawnOk && v6.mode === 'desk' && v6.activeDesk === ALLOWED && calls.every((c) => c.start === false), `dragged ${DX},${DY} px at ${s}x: ${start.x},${start.y} to ${moved.x},${moved.y} vs ${wantX},${wantY} from the pointer; mod 8 is ${n2(moved.x % 8)},${n2(moved.y % 8)}; apps and size unchanged ${rest}; camera still ${camStill}. Reload: doc byte-identical ${same}, drawn the same, name ${JSON.stringify(testLabel())}; connect since ${calls.length}, start:true ${calls.filter((c) => c.start !== false).length}; undo gone from the menu: ${showMenu(m.menu)}`);
}

// ----- 6. The guard's word, and leave cleanly

const connects = S.connects.filter((c) => c.action === 'connect');
const wakes = S.connects.filter((c) => c.start !== false || c.action !== 'connect');
const consoleProblems = events.filter((e) => e.k === 'console');
const wsErrors = events.filter((e) => e.k === 'ws' && e.type === 'error');
const hello = events.find((e) => e.k === 'ctl.hello.sent');
log(`guard: connect calls ${connects.length} (test ${connects.filter((c) => c.desk === ALLOWED).length}, other ${connects.filter((c) => c.desk === OTHER).length}), start:true or other lifecycle calls ${wakes.length}`);
log(`bundle's own HELLO appVersion ${hello?.appVersion}`);
log(`console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);
result(6, wakes.length === 0 && consoleProblems.length === 0 && wsErrors.length === 0 && !S.guardTripped, `start:true ${wakes.length}, guard tripped ${S.guardTripped}, console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);

S.afterClose = async () => {
  await wait(800);
  const d = await getDesk();
  log(`DESK after close state=${d.state} phase=${d.phase} clientConnected=${d.clientConnected} autoStopMinutes=${d.autoStopMinutes} autoStopAt=${d.autoStopAt}`);
};
log(`SUMMARY ${JSON.stringify(results.map((r) => ({ step: r.step, pass: r.pass })))}`);
await shutdown(results.every((r) => r.pass) ? 0 : 1, 'done');
