// Desks never overlap on the real office, as desk-1 (ADR 0064): dragging the test desk into its neighbour pushes the
// neighbour aside, nothing overlaps, and it survives a reload. The other desk only moves on the canvas: it is never
// focused or woken, and start:true is refused for every desk. Screenshots also show the etched name and icons.
import { mkdirSync } from 'node:fs';
import { ALLOWED, createLayoutStandIn, events, getDesk, log, openSession, OTHER, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-desks/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 5 * 60 * 1000);
watchdog.unref();

let failed = 0;
const step = (n, ok, text) => {
  if (!ok) failed += 1;
  log(`STEP ${n} ${ok ? 'PASS' : 'FAIL'} ${text}`);
};

await openSession({ layoutStandIn: createLayoutStandIn() });
const p = S.page;
const mine = p.locator(`#proxy-${ALLOWED}`);
await mine.waitFor({ state: 'attached', timeout: 60_000 });
const desk = await getDesk();
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}`);
  await shutdown(1, 'desk not running');
}
const version = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name.match(/\/v\/([^/]+)\//)?.[1]).find(Boolean));
step(1, version === EXPECTED, `bundle ${version}`);
await waitPanel(/online/, 60_000);
await wait(1500);
await shot(SHOTS, 'overview');

const rect = (id) => p.evaluate((i) => {
  const r = document.getElementById(`proxy-${i}`)?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}, id);
const clash = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const saved = () => p.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? '{}').desks ?? {});

const a0 = await rect(ALLOWED);
const b0 = await rect(OTHER);
step(2, !clash(a0, b0), `apart at the start: ${JSON.stringify(a0)} and ${JSON.stringify(b0)}`);

// Drag the test desk onto its neighbour, from its free band under the apps.
const from = { x: a0.x + a0.w * 0.6, y: a0.y + a0.h * 0.62 };
const dx = b0.x + b0.w * 0.5 - (a0.x + a0.w * 0.5);
const dy = b0.y + b0.h * 0.5 - (a0.y + a0.h * 0.5);
await p.mouse.move(from.x, from.y);
await p.mouse.down();
await p.mouse.move(from.x + dx, from.y + dy, { steps: 40 });
await wait(200);
await shot(SHOTS, 'pushing');
await p.mouse.up();
await wait(1500);
await shot(SHOTS, 'dropped');
const a1 = await rect(ALLOWED);
const b1 = await rect(OTHER);
const moved = Math.abs(b1.x - b0.x) > 5 || Math.abs(b1.y - b0.y) > 5;
const held = Math.abs(a1.x - (a0.x + dx)) < 3 && Math.abs(a1.y - (a0.y + dy)) < 3;
step(3, !clash(a1, b1) && moved && held, `the held desk went where it was dropped (${held}), the neighbour moved aside (${moved}), no overlap: ${JSON.stringify(a1)} and ${JSON.stringify(b1)}`);

const doc = await saved();
await p.reload({ waitUntil: 'load' });
await mine.waitFor({ state: 'attached', timeout: 60_000 });
await wait(2500);
const a2 = await rect(ALLOWED);
const b2 = await rect(OTHER);
const doc2 = await saved();
step(4, !clash(a2, b2) && JSON.stringify(doc[ALLOWED]) === JSON.stringify(doc2[ALLOWED]) && JSON.stringify(doc[OTHER]) === JSON.stringify(doc2[OTHER]), 'the arrangement survives a reload unchanged');
await shot(SHOTS, 'after-reload');

const consoleProblems = events.filter((e) => e.k === 'console').length;
step(5, consoleProblems === 0, `console problems ${consoleProblems}`);
log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
await shutdown(failed === 0 ? 0 : 1, 'done');
