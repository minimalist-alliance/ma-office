// Stacking on the real test desk (ADR 0064), as desk-1: an app dragged over another stays where it's dropped and
// on top, the order survives a reload, and Cleanup gives no overlap and undoes. Only the allowed desk is touched,
// start:true is refused, and the desk must already be running.
import { mkdirSync } from 'node:fs';
import { ALLOWED, createLayoutStandIn, events, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-stack/', import.meta.url).pathname;
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
const btn = p.locator(`#proxy-${ALLOWED}`);
await btn.waitFor({ state: 'attached', timeout: 60_000 });
const desk = await getDesk();
if (desk.state !== 'running') {
  log(`STOP: the desk is ${desk.state}`);
  await shutdown(1, 'desk not running');
}
const version = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name.match(/\/v\/([^/]+)\//)?.[1]).find(Boolean));
step(1, version === EXPECTED, `bundle ${version}`);

await btn.focus();
await p.keyboard.press('Enter');
await waitPanel(/online/, 60_000);
await wait(1500);

const rect = (app) => p.evaluate((id) => {
  const r = document.getElementById(id)?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}, `proxy-${ALLOWED}:${app}`);
const savedDesk = () => p.evaluate((id) => JSON.parse(localStorage.getItem('ma.layout.v2') ?? '{}').desks?.[id] ?? null, ALLOWED);
const clash = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const chat = await rect('chat');
const notebook = await rect('notebook');
const from = center(notebook);
const to = { x: chat.x + chat.w * 0.75, y: chat.y + chat.h * 0.6 };
await p.mouse.move(from.x, from.y);
await p.mouse.down();
await p.mouse.move(to.x, to.y, { steps: 24 });
await shot(SHOTS, 'mid-drag');
await p.mouse.up();
await wait(800);
await shot(SHOTS, 'dropped-over');
const afterChat = await rect('chat');
const afterNb = await rect('notebook');
const onPointer = Math.abs(afterNb.x + afterNb.w / 2 - to.x) < 2 && Math.abs(afterNb.y + afterNb.h / 2 - to.y) < 2;
step(2, clash(afterChat, afterNb) && onPointer, `Notebook rests over Chat, exactly where dropped: ${JSON.stringify(afterNb)} against ${JSON.stringify(afterChat)}`);

// The layout saves a moment after a change, so wait for it rather than read too early.
const settledDesk = async (ok, ms = 8000) => {
  const until = Date.now() + ms;
  let d = await savedDesk();
  while (!ok(d) && Date.now() < until) {
    await wait(250);
    d = await savedDesk();
  }
  return d;
};
const topIs = (d, id) => d?.stack?.[d.stack.length - 1] === id;
const saved = await settledDesk((d) => topIs(d, `${ALLOWED}:notebook`));
const order = saved?.stack ?? [];
step(3, topIs(saved, `${ALLOWED}:notebook`), `saved stack, top last: ${JSON.stringify(order)}`);

await p.reload({ waitUntil: 'load' });
await btn.waitFor({ state: 'attached', timeout: 60_000 });
await waitPanel(/online/, 60_000);
await wait(1500);
const reloaded = await savedDesk();
const r1 = await rect('notebook');
const r2 = await rect('chat');
step(4, JSON.stringify(reloaded) === JSON.stringify(saved) && clash(r1, r2), 'the document and the overlap survive a reload unchanged');
await shot(SHOTS, 'after-reload');

await btn.focus();
if ((await p.evaluate(() => JSON.parse(sessionStorage.getItem('ma.view') ?? '{}').mode)) !== 'desk') await p.keyboard.press('Enter');
await wait(1500);
const clean = p.getByRole('button', { name: /^Clean up .* desk$/ });
const box = await rect('agent');
await p.mouse.move(box.x + box.w + 30, box.y + box.h / 2);
await clean.focus();
await p.keyboard.press('Enter');
await wait(900);
await shot(SHOTS, 'cleaned');
const apps = ['chat', 'notebook', 'browser', 'agent'];
const rects = await Promise.all(apps.map(rect));
const overlaps = rects.flatMap((a, i) => rects.slice(i + 1).filter((b) => clash(a, b))).length;
step(5, overlaps === 0, `Cleanup leaves ${overlaps} overlaps`);

const undo = p.getByRole('button', { name: /^Undo clean up .* desk$/ });
await undo.focus();
await p.keyboard.press('Enter');
await wait(900);
const undone = await settledDesk((d) => JSON.stringify(d?.stack) === JSON.stringify(saved.stack));
step(6, JSON.stringify(undone?.stack) === JSON.stringify(saved.stack) && clash(await rect('notebook'), await rect('chat')), `Undo restores the overlap and the stack: ${JSON.stringify(undone?.stack)}`);
await shot(SHOTS, 'undone');

// Leave the test desk's document for the next run: back to a clean arrangement.
await clean.focus().catch(() => {});
await p.keyboard.press('Enter').catch(() => {});
await wait(600);

const consoleProblems = events.filter((e) => e.k === 'console').length;
step(7, consoleProblems === 0, `console problems ${consoleProblems}`);
log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
await shutdown(failed === 0 ? 0 : 1, 'done');
