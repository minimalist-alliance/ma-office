/* eslint-disable @typescript-eslint/no-unused-vars */
// One pass over the 1f75161 desk: a real old layout migrates, desks grow freely, they stop at what they
// hold, and the size survives a reload. Signed in as desk-1; only the test desk (RT_DESK) is focused; start:true is
// refused for every desk. The seeded layout lives only in this browser context: the layout sync's calls are
// answered here by a stand-in for Platform's document, which starts never saved, so desk-1's real document is
// neither read nor written, and the seeded layout is the one that loads.
//
// The shipping bundle has no window.__maDesk and the proxy only updates on a drop, so the live size during
// a drag is read from the canvas's own pixels, calibrated at rest against the proxy. Read-only.
import { mkdirSync } from 'node:fs';
import { ALLOWED, createLayoutStandIn, events, getDesk, HOST, log, logConfig, openSession, OTHER, S, shot, shutdown, testLabel, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-stage2/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const APP_HOST = new URL(HOST).hostname;
const VP = { w: 1440, h: 900 };
const LABEL = 36; // G.label: the proxy box includes the name above the panel

// The shape of REAL_V1 in web/src/canvas/layoutDoc.test.ts, with desk-1's ids: the desk moved, and grown
// by a column and two rows with its Chat as a widget. The other desk stays a default desk.
const items = (id, chat) => [
  { id: `${id}:chat`, app: 'chat', size: chat },
  { id: `${id}:notebook`, app: 'notebook', size: 'icon' },
  { id: `${id}:browser`, app: 'browser', size: 'icon' },
  { id: `${id}:agent`, app: 'agent', size: 'icon' },
];
const V1 = JSON.stringify({
  desks: {
    [ALLOWED]: { id: ALLOWED, x: 728, y: 128, cols: 7, rows: 3, items: items(ALLOWED, 'small') },
    [OTHER]: { id: OTHER, x: 0, y: 36, cols: 6, rows: 1, items: items(OTHER, 'icon') },
  },
  z: [OTHER, ALLOWED],
});
// What migrating that must give: panelW(7), panelH(3), with Chat at 2 x 2 cells.
const WANT = { x: 728, y: 128, w: 676, h: 328 };
const WANT_OTHER = { x: 0, y: 36, w: 584, h: 144 };
const WANT_ITEMS = { chat: { x: 24, y: 24, w: 168, h: 168 }, notebook: { x: 208, y: 24, w: 76, h: 76 }, browser: { x: 300, y: 24, w: 76, h: 76 }, agent: { x: 392, y: 24, w: 76, h: 76 } };

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 6 * 60 * 1000);
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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

const standIn = createLayoutStandIn();
const layoutCalls = standIn.calls;

await openSession({
  watch: true,
  layoutStandIn: standIn,
  onContext: async (context) => {
    await context.addInitScript(
      ({ doc, host }) => {
        if (location.hostname === host && localStorage.getItem('ma.layout.v1') === null) localStorage.setItem('ma.layout.v1', doc);
      },
      { doc: V1, host: APP_HOST },
    );
  },
  onLanding: async (page) => {
    const limit = Date.now() + 15000;
    let v = null;
    while (!v && Date.now() < limit) {
      v = await pageVersion(page).catch(() => null);
      if (!v) await wait(100);
    }
    write(`=== rt-stage2 start ${new Date(started).toISOString()}`);
    write(`=== BUNDLE ${v ?? 'UNKNOWN'} (from the page's /v/<version>/ asset path)${v === EXPECTED ? ' matches the expected version' : ` DOES NOT MATCH expected ${EXPECTED}`}`);
    for (const l of held ?? []) write(l);
    held = null;
    if (v !== EXPECTED) throw new Error(`staging serves ${v}, not ${EXPECTED}`);
  },
});

const p = S.page;
const btn = p.locator(`#proxy-${ALLOWED}`);
const storage = (k) => p.evaluate((key) => localStorage.getItem(key), k);
const savedDoc = async () => JSON.parse((await storage('ma.layout.v2')) ?? 'null');

async function view() {
  const v = JSON.parse((await storage('ma.view.v1')) ?? '{}');
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
const rect = (id) =>
  p.evaluate((pid) => {
    const r = document.getElementById(`proxy-${pid}`)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null;
  }, id);
const worldOf = (r, c) => ({ x: (r.x - c.x) / c.s, y: (r.y - c.y) / c.s + LABEL, w: r.w / c.s, h: r.h / c.s - LABEL });
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
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]));

// ----- the canvas, read directly

/**
 * The panel's right and bottom edges in CSS px, from the first pixel that isn't the ground, scanning in from
 * the viewport's edge. The focused desk is the only thing to the right of or below that row and column.
 */
const edges = (rowY, colX) =>
  p.evaluate(
    async ({ rowY, colX }) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = document.querySelector('[data-testid="canvas"] canvas');
      const k = c.width / c.clientWidth;
      const ctx = c.getContext('2d');
      const row = ctx.getImageData(0, Math.round(rowY * k), c.width, 1).data;
      const col = ctx.getImageData(Math.round(colX * k), 0, 1, c.height).data;
      let right = -1;
      for (let x = c.width - 1; x >= 0; x--) {
        if (row[x * 4 + 3] >= 200) {
          right = x / k;
          break;
        }
      }
      let bottom = -1;
      for (let y = c.height - 1; y >= 0; y--) {
        if (col[y * 4 + 3] >= 200) {
          bottom = y / k;
          break;
        }
      }
      return { right, bottom };
    },
    { rowY, colX },
  );

/**
 * A seam in nine stretched pieces is a line of a different colour across the panel. Reads a row and a column
 * of bare panel, and counts the pixels away from its colour. Past 2 levels of 255 would be visible as a line.
 */
const seamScan = (panel, s) =>
  p.evaluate(
    ({ panel, s }) => {
      const c = document.querySelector('[data-testid="canvas"] canvas');
      const k = c.width / c.clientWidth;
      const ctx = c.getContext('2d');
      const scan = (x, y, w, h) => {
        const d = ctx.getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data;
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
      };
      const stripY = panel.bottom - 22 * s;
      const freeX = panel.right - 60 * s;
      return {
        // Along the strip, clear of the corners and the handle: crosses every vertical seam.
        row: scan(panel.left + 30 * s, stripY, panel.right - panel.left - 90 * s, 1),
        // Down the right side, clear of the tiles and the corners: crosses every horizontal seam.
        column: scan(freeX, panel.top + 30 * s, 1, panel.bottom - panel.top - 60 * s),
      };
    },
    { panel, s },
  );

/** Where a focused desk's panel is on screen, from its proxy. Only true at rest. */
async function panelAtRest() {
  const r = await rect(ALLOWED);
  const c = await cam();
  return { c, r, left: r.x, top: r.y + LABEL * c.s, right: r.right, bottom: r.bottom };
}

/** Which way to read the size: the first pixel in from the edge should be the proxy's own edge, at rest. */
async function calibrate(panel) {
  const rowY = panel.top + 30 * panel.c.s;
  const colX = panel.left + 40 * panel.c.s;
  const e = await edges(rowY, colX);
  const off = { right: e.right - panel.right, bottom: e.bottom - panel.bottom };
  log(`calibration: proxy right ${panel.right.toFixed(1)} bottom ${panel.bottom.toFixed(1)}; canvas ${e.right} ${e.bottom}; offsets ${off.right.toFixed(2)} ${off.bottom.toFixed(2)}`);
  // The panel's drawn border sits a constant few px outside the proxy. Tracking uses differences, so only a
  // wild offset, meaning this isn't the panel at all, stops the test.
  return { rowY, colX, ...off, ok: off.right >= -3 && off.right <= 12 && off.bottom >= -3 && off.bottom <= 12 };
}

/** Moves the held pointer in equal small steps, reading the desk after each. Returns the samples. */
async function dragSteps(from, dx, dy, n, cal, label, onStep) {
  const samples = [];
  for (let i = 1; i <= n; i++) {
    const px = (dx * i) / n;
    const py = (dy * i) / n;
    await p.mouse.move(from.x + px, from.y + py);
    const e = await edges(cal.rowY, cal.colX);
    const sample = { i, px: +px.toFixed(2), py: +py.toFixed(2), right: e.right, bottom: e.bottom };
    samples.push(sample);
    log(`${label} step ${i}/${n} pointer +${sample.px},+${sample.py} panel right ${e.right} bottom ${e.bottom}`);
    await onStep?.(i, sample);
  }
  return samples;
}

function analyse(samples, base, dx, dy, n) {
  const moved = samples.filter((q) => q.right !== base.right || q.bottom !== base.bottom);
  const stepX = Math.abs(dx / n);
  const stepY = Math.abs(dy / n);
  let maxJumpX = 0;
  let maxJumpY = 0;
  let prev = { right: base.right, bottom: base.bottom };
  for (const q of samples) {
    maxJumpX = Math.max(maxJumpX, Math.abs(q.right - prev.right));
    maxJumpY = Math.max(maxJumpY, Math.abs(q.bottom - prev.bottom));
    prev = q;
  }
  const errX = moved.map((q) => Math.abs(q.right - base.right - q.px));
  const errY = moved.map((q) => Math.abs(q.bottom - base.bottom - q.py));
  return {
    stepsMoved: moved.length,
    of: samples.length,
    distinctRight: new Set(samples.map((q) => q.right)).size,
    distinctBottom: new Set(samples.map((q) => q.bottom)).size,
    pointerStepPx: [+stepX.toFixed(2), +stepY.toFixed(2)],
    maxJumpPx: [+maxJumpX.toFixed(2), +maxJumpY.toFixed(2)],
    maxErrorFromPointerPx: [+Math.max(0, ...errX).toFixed(2), +Math.max(0, ...errY).toFixed(2)],
    moved,
  };
}

const crop = async (name, panel) => {
  const x = Math.max(0, panel.left - 14);
  const y = Math.max(0, panel.top - 60);
  const path = `${SHOTS}${name}.png`;
  await p.screenshot({ path, clip: { x, y, width: Math.min(VP.w - x, panel.right - x + 14), height: Math.min(VP.h - y, panel.bottom - y + 14) } });
  log('crop', path);
};

const tilesInDesk = (panel) =>
  p.evaluate(
    ({ ids, panel }) =>
      ids.map((id) => {
        const r = document.getElementById(`proxy-${id}`)?.getBoundingClientRect();
        if (!r) return { id, missing: true };
        return { id: id.split(':')[1], marginLeft: +(r.left - panel.left).toFixed(1), marginTop: +(r.top - panel.top).toFixed(1), marginRight: +(panel.right - r.right).toFixed(1), marginBottom: +(panel.bottom - r.bottom).toFixed(1) };
      }),
    { ids: ['chat', 'notebook', 'browser', 'agent'].map((a) => `${ALLOWED}:${a}`), panel },
  );

// ----- 1. Migration from a real old layout

const onlineOk = await waitPanel(/online/, 60000);
await wait(1000);
const version1 = await pageVersion(p).catch(() => null);
log(`bundle after sign-in ${version1}; view ${JSON.stringify(await view())}`);
await settled();
const v1After = await storage('ma.layout.v1');
const v2Raw = await storage('ma.layout.v2');
const doc1 = JSON.parse(v2Raw ?? 'null');
const d1 = doc1?.desks?.[ALLOWED];
const o1 = doc1?.desks?.[OTHER];
log(`ma.layout.v1 is ${v1After?.length} chars; identical to what was seeded: ${v1After === V1}`);
log(`ma.layout.v2 test desk ${JSON.stringify(d1)}`);
log(`ma.layout.v2 other desk ${JSON.stringify(o1 && { x: o1.x, y: o1.y, w: o1.w, h: o1.h })}; z ${JSON.stringify(doc1?.z)}`);
const c1 = await cam();
const screen1 = worldOf(await rect(ALLOWED), c1);
const screenOther1 = worldOf(await rect(OTHER), c1);
log(`on screen: camera ${JSON.stringify(c1)}; test desk in world units ${JSON.stringify(round(screen1))}; other ${JSON.stringify(round(screenOther1))}`);
await shot(SHOTS, 'step1-migrated-overview');
const itemsOk = d1 && Object.entries(WANT_ITEMS).every(([app, w]) => {
  const it = d1.items.find((i) => i.id === `${ALLOWED}:${app}`);
  return it && it.x === w.x && it.y === w.y && it.w === w.w && it.h === w.h;
});
const savedOk = d1 && d1.x === WANT.x && d1.y === WANT.y && d1.w === WANT.w && d1.h === WANT.h && o1 && o1.x === WANT_OTHER.x && o1.y === WANT_OTHER.y && o1.w === WANT_OTHER.w && o1.h === WANT_OTHER.h;
const onScreenOk = near(screen1.x, WANT.x, 1) && near(screen1.y, WANT.y, 1) && near(screen1.w, WANT.w, 1) && near(screen1.h, WANT.h, 1);
result(1, onlineOk && version1 === EXPECTED && v1After === V1 && !!savedOk && !!itemsOk && onScreenOk, `v2 written: ${!!doc1}; desk saved at ${d1?.x},${d1?.y} size ${d1?.w}x${d1?.h}, on screen ${round(screen1).x},${round(screen1).y} size ${round(screen1).w}x${round(screen1).h}, the v1 doc says ${WANT.x},${WANT.y} and ${WANT.w}x${WANT.h}; apps as packed: ${!!itemsOk}; v1 byte-identical: ${v1After === V1}; name ${JSON.stringify(testLabel())}`);

// ----- 2. Free growth

await btn.focus();
await btn.press('Enter');
await settled();
const v2a = await view();
log(`view ${JSON.stringify(v2a)}`);
let panel = await panelAtRest();
const s2 = panel.c.s;
log(`focused: scale ${s2}, panel left ${panel.left} top ${panel.top} right ${panel.right} bottom ${panel.bottom}`);
await shot(SHOTS, 'step2-before-drag');
const cal2 = await calibrate(panel);
const before2 = await savedDoc();
const items2 = JSON.stringify(before2.desks[ALLOWED].items);
const tiles2Before = await tilesInDesk(panel);
log(`tiles at rest, margins inside the panel ${JSON.stringify(tiles2Before)}`);

const from2 = { x: panel.right - 12, y: panel.bottom - 12 };
// 137 x 61, unless the screen runs out first. Neither divides by 8, 16, 76 or 92.
const dx2 = from2.x + 137 <= VP.w - 3 ? 137 : 127;
const dy2 = from2.y + 61 <= VP.h - 3 ? 61 : 41;
const N2 = 30;
log(`dragging the corner from ${from2.x.toFixed(1)},${from2.y.toFixed(1)} by ${dx2},${dy2} px, ${N2} steps: ${(dx2 / s2).toFixed(2)} x ${(dy2 / s2).toFixed(2)} world units`);
let result2;
if (!cal2.ok || v2a.mode !== 'desk' || v2a.activeDesk !== ALLOWED) {
  result(2, false, `not dragged: calibration ${JSON.stringify(cal2)}, view ${JSON.stringify(v2a)}`);
} else {
  const base2 = await edges(cal2.rowY, cal2.colX);
  await p.mouse.move(from2.x, from2.y);
  await p.mouse.down();
  let seamMid = null;
  const samples2 = await dragSteps(from2, dx2, dy2, N2, cal2, 'grow', async (i, q) => {
    if (i === Math.round(N2 / 2)) {
      const live = { left: panel.left, top: panel.top, right: q.right - cal2.right, bottom: q.bottom - cal2.bottom };
      seamMid = await seamScan(live, s2);
      log(`seam scan mid-drag ${JSON.stringify(seamMid)}`);
      await shot(SHOTS, 'step2-mid-drag');
      await crop('step2-mid-drag-crop', live);
    }
  });
  const end2 = samples2.at(-1);
  const live2 = { left: panel.left, top: panel.top, right: end2.right - cal2.right, bottom: end2.bottom - cal2.bottom };
  const seamEnd = await seamScan(live2, s2);
  log(`seam scan before the drop ${JSON.stringify(seamEnd)}`);
  await shot(SHOTS, 'step2-before-drop');
  await p.mouse.up();
  await settled();
  await wait(1300); // the mirror is debounced by 1 s
  const v2b = await view();
  const after2 = (await savedDoc()).desks[ALLOWED];
  const wantW = before2.desks[ALLOWED].w + dx2 / s2;
  const wantH = before2.desks[ALLOWED].h + dy2 / s2;
  const a2 = analyse(samples2, base2, dx2, dy2, N2);
  log(`tracking ${JSON.stringify({ ...a2, moved: undefined })}`);
  log(`saved after the drop ${after2.w} x ${after2.h}; the pointer says ${wantW.toFixed(2)} x ${wantH.toFixed(2)}`);
  panel = await panelAtRest();
  log(`after the drop: view ${JSON.stringify(v2b)}, scale ${panel.c.s}, panel left ${panel.left} top ${panel.top} right ${panel.right} bottom ${panel.bottom}`);
  const seamAfter = await seamScan(panel, panel.c.s);
  log(`seam scan after the drop ${JSON.stringify(seamAfter)}`);
  const tiles2After = await tilesInDesk(panel);
  log(`tiles after the drop ${JSON.stringify(tiles2After)}`);
  await shot(SHOTS, 'step2-after-drop');
  await crop('step2-after-drop-crop', panel);
  const itemsSame = JSON.stringify(after2.items) === items2;
  const follows = a2.maxErrorFromPointerPx[0] <= 2 && a2.maxErrorFromPointerPx[1] <= 2;
  const small = a2.maxJumpPx[0] <= a2.pointerStepPx[0] + 2 && a2.maxJumpPx[1] <= a2.pointerStepPx[1] + 2;
  const finalOk = near(after2.w, wantW, 1) && near(after2.h, wantH, 1);
  const seams = seamMid && seamMid.row.off === 0 && seamMid.column.off === 0 && seamEnd.row.off === 0 && seamEnd.column.off === 0 && seamAfter.row.off === 0 && seamAfter.column.off === 0;
  result2 = { after2 };
  result(2, follows && small && finalOk && itemsSame && !!seams && v2b.mode === 'desk', `moved on ${a2.stepsMoved}/${a2.of} steps, ${a2.distinctRight} distinct right edges and ${a2.distinctBottom} bottom; biggest jump ${a2.maxJumpPx} px for a pointer step of ${a2.pointerStepPx}; furthest from the pointer ${a2.maxErrorFromPointerPx} px; final ${after2.w} x ${after2.h} vs ${wantW.toFixed(2)} x ${wantH.toFixed(2)} from the pointer; apps unchanged: ${itemsSame}; seam pixels ${seamMid?.row.off}+${seamMid?.column.off} mid, ${seamEnd.row.off}+${seamEnd.column.off} before the drop, ${seamAfter.row.off}+${seamAfter.column.off} after`);
}

// ----- 3. The limit: far up and left

const doc3 = (await savedDoc()).desks[ALLOWED];
const minW = Math.max(216, ...doc3.items.map((i) => i.x + i.w + 8));
const minH = Math.max(124, ...doc3.items.map((i) => i.y + i.h + 44));
panel = await panelAtRest();
const s3 = panel.c.s;
const cal3 = await calibrate(panel);
const other3 = await rect(OTHER);
const minCorner = { x: panel.left + minW * s3, y: panel.top + minH * s3 };
const from3 = { x: panel.right - 12, y: panel.bottom - 12 };
log(`what the desk holds: ${minW} x ${minH}; that corner is at ${minCorner.x.toFixed(1)},${minCorner.y.toFixed(1)}; the other desk is at ${JSON.stringify(round(other3))}`);
// As far up and left as the screen allows, and never to end up over the other desk.
// Bare canvas too, so the press doesn't end on the top bar.
const onCanvas = (x, y) => p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', { x, y });
let target3 = null;
for (let total = 80; total < VP.w + VP.h && !target3; total += 10) {
  for (let x = 10; x <= total && !target3; x += 10) {
    const y = total - x + 10;
    if (y < 70 || x >= minCorner.x - 40 || y >= minCorner.y - 40 || x >= VP.w || y >= VP.h) continue;
    const overOther = other3 && x > other3.x - 24 && x < other3.right + 24 && y > other3.y - 24 && y < other3.bottom + 24;
    if (!overOther && (await onCanvas(x, y))) target3 = { x, y };
  }
}
if (!target3 || !cal3.ok) {
  result(3, false, `not dragged: target ${JSON.stringify(target3)}, calibration ${JSON.stringify(cal3)}`);
} else {
  const dx3 = target3.x - from3.x;
  const dy3 = target3.y - from3.y;
  const N3 = 50;
  const base3 = await edges(cal3.rowY, cal3.colX);
  log(`dragging the corner from ${from3.x.toFixed(1)},${from3.y.toFixed(1)} to ${target3.x},${target3.y} (${dx3.toFixed(1)},${dy3.toFixed(1)} px), ${N3} steps`);
  await p.mouse.move(from3.x, from3.y);
  await p.mouse.down();
  const samples3 = await dragSteps(from3, dx3, dy3, N3, cal3, 'shrink');
  const end3 = samples3.at(-1);
  const liveEnd = { left: panel.left, top: panel.top, right: end3.right - cal3.right, bottom: end3.bottom - cal3.bottom };
  await shot(SHOTS, 'step3-at-limit-before-drop');
  await crop('step3-at-limit-crop', liveEnd);
  const a3 = analyse(samples3, base3, dx3, dy3, N3);
  log(`tracking ${JSON.stringify({ ...a3, moved: undefined })}`);
  const heldX = samples3.filter((q) => q.right === end3.right).length;
  const heldY = samples3.filter((q) => q.bottom === end3.bottom).length;
  log(`at the limit the right edge held for ${heldX} of ${N3} steps and the bottom for ${heldY}, with the pointer still going`);
  await p.mouse.up();
  await settled();
  await wait(1300);
  const v3 = await view();
  const after3 = (await savedDoc()).desks[ALLOWED];
  panel = await panelAtRest();
  const tiles3 = await tilesInDesk(panel);
  log(`saved after the drop ${after3.w} x ${after3.h}; view ${JSON.stringify(v3)}; scale ${panel.c.s}; panel left ${panel.left} top ${panel.top} right ${panel.right} bottom ${panel.bottom}`);
  log(`tiles at the limit, margins inside the panel in px ${JSON.stringify(tiles3)}`);
  await shot(SHOTS, 'step3-at-limit-after-drop');
  await crop('step3-after-drop-crop', panel);
  const allInside = tiles3.every((t) => !t.missing && t.marginLeft >= 0 && t.marginTop >= 0 && t.marginRight >= 0 && t.marginBottom >= 0);
  const noJump = a3.maxJumpPx[0] <= a3.pointerStepPx[0] + 2 && a3.maxJumpPx[1] <= a3.pointerStepPx[1] + 2;
  result(3, near(after3.w, minW, 0.01) && near(after3.h, minH, 0.01) && allInside && noJump && v3.mode === 'desk', `stopped at ${after3.w} x ${after3.h}, what it holds is ${minW} x ${minH}; every tile inside the panel: ${allInside}; biggest jump on the way ${a3.maxJumpPx} px for a pointer step of ${a3.pointerStepPx}; apps unchanged: ${JSON.stringify(after3.items) === items2}`);
}

// ----- 4. Persistence. A size that isn't round goes first, so a reload has something to get wrong.

panel = await panelAtRest();
const s4 = panel.c.s;
const from4 = { x: panel.right - 12, y: panel.bottom - 12 };
const dx4 = 83;
const dy4 = 47;
const before4 = (await savedDoc()).desks[ALLOWED];
await p.mouse.move(from4.x, from4.y);
await p.mouse.down();
for (let i = 1; i <= 12; i++) {
  await p.mouse.move(from4.x + (dx4 * i) / 12, from4.y + (dy4 * i) / 12);
  await wait(16);
}
await p.mouse.up();
await settled();
await wait(1300);
const beforeReload = (await savedDoc()).desks[ALLOWED];
const viewBefore = await view();
log(`grown again by ${dx4},${dy4} px at scale ${s4}: ${before4.w} x ${before4.h} to ${beforeReload.w} x ${beforeReload.h}; view ${JSON.stringify(viewBefore)}`);
await shot(SHOTS, 'step4-before-reload');

const tReload = Date.now();
delete S.labels[ALLOWED];
log('reloading');
await p.reload({ waitUntil: 'load' });
const onlineAgain = await waitPanel(/online/, 60000);
const onlineAfter = Date.now() - tReload;
await settled();
const viewAfter = await view();
const afterReload = (await savedDoc()).desks[ALLOWED];
const c4 = await cam();
const screen4 = worldOf(await rect(ALLOWED), c4);
const callsSince = S.connects.filter((c) => c.at >= tReload);
log(`after the reload: view ${JSON.stringify(viewAfter)}; online after ${onlineAfter} ms; saved ${afterReload.w} x ${afterReload.h} at ${afterReload.x},${afterReload.y}; on screen ${JSON.stringify(round(screen4))}`);
log(`connect calls since the reload ${JSON.stringify(callsSince.map((c) => ({ desk: c.desk === ALLOWED ? 'test' : 'other', start: c.start })))}`);
await shot(SHOTS, 'step4-after-reload');
const v1End = await storage('ma.layout.v1');
const sameSize = afterReload.w === beforeReload.w && afterReload.h === beforeReload.h;
const onScreen4 = near(screen4.w, beforeReload.w, 1) && near(screen4.h, beforeReload.h, 1);
const noStart = callsSince.every((c) => c.start === false);
result(4, onlineAgain && sameSize && onScreen4 && noStart && viewAfter.mode === 'desk' && viewAfter.activeDesk === ALLOWED, `saved ${beforeReload.w} x ${beforeReload.h} before and ${afterReload.w} x ${afterReload.h} after, ${round(screen4).w} x ${round(screen4).h} on screen; mode ${viewAfter.mode}, active ${viewAfter.activeDesk}; name ${JSON.stringify(testLabel())}; connect since the reload: ${callsSince.length}, start:true ${callsSince.filter((c) => c.start !== false).length}; v1 still byte-identical: ${v1End === V1}`);

// ----- 5. The guard's word, and leave cleanly

const connects = S.connects.filter((c) => c.action === 'connect');
const wakes = S.connects.filter((c) => c.start !== false || c.action !== 'connect');
const consoleProblems = events.filter((e) => e.k === 'console');
const wsErrors = events.filter((e) => e.k === 'ws' && e.type === 'error');
const hello = events.find((e) => e.k === 'ctl.hello.sent');
log(`guard: connect calls ${connects.length} (test ${connects.filter((c) => c.desk === ALLOWED).length}, other ${connects.filter((c) => c.desk === OTHER).length}), start:true or other lifecycle calls ${wakes.length}`);
log(`bundle's own HELLO appVersion ${hello?.appVersion}`);
log(`calls to /v1/me/desk-layout, all answered by the stand-in ${JSON.stringify(layoutCalls)}; stand-in at version ${standIn.version}`);
log(`console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}`);
// The layout sync ran (it read at load), and nothing of it reached Platform: every call the page made was the stand-in's.
const layoutRead = layoutCalls.some((c) => c.startsWith('GET '));
const layoutPassed = standIn.unrouted;
result(5, wakes.length === 0 && consoleProblems.length === 0 && !S.guardTripped && layoutRead && layoutPassed === 0, `start:true ${wakes.length}, guard tripped ${S.guardTripped}, console problems ${consoleProblems.length}, gateway errors ${wsErrors.length}, layout calls ${layoutCalls.length} (a read: ${layoutRead}), past the stand-in to Platform ${layoutPassed}`);

S.afterClose = async () => {
  await wait(800);
  const d = await getDesk();
  log(`DESK after close state=${d.state} phase=${d.phase} clientConnected=${d.clientConnected} autoStopMinutes=${d.autoStopMinutes} autoStopAt=${d.autoStopAt}`);
};
log(`SUMMARY ${JSON.stringify(results.map((r) => ({ step: r.step, pass: r.pass })))}`);
await shutdown(results.every((r) => r.pass) ? 0 : 1, 'done');
