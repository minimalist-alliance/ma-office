// The hidden count on the real test desk (ADR 0064), as desk-1: an app wholly covered shows a count at the desk's
// bottom right, its list brings the app to the front, and Cleanup clears it. Only the allowed desk is touched, and
// the desk must already be running.
import { mkdirSync } from 'node:fs';
import { ALLOWED, events, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const EXPECTED = process.env.MA_EXPECT_VERSION;
if (!EXPECTED) throw new Error('Set MA_EXPECT_VERSION to the bundle version you expect on staging');
const SHOTS = new URL('../../test-results/real-desk/rt-shots-hidden/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 4 * 60 * 1000);
watchdog.unref();

let failed = 0;
const step = (n, ok, text) => {
  if (!ok) failed += 1;
  log(`STEP ${n} ${ok ? 'PASS' : 'FAIL'} ${text}`);
};

await openSession();
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

const count = p.getByRole('button', { name: /^\d+ hidden apps? on the .* desk$/ });
step(2, (await count.count()) === 0, 'no count while everything is visible');
await shot(SHOTS, 'none');

const rect = (app) => p.evaluate((id) => {
  const r = document.getElementById(id)?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}, `proxy-${ALLOWED}:${app}`);
const chat = await rect('chat');
const notebook = await rect('notebook');
await p.mouse.move(notebook.x + notebook.w / 2, notebook.y + notebook.h / 2);
await p.mouse.down();
await p.mouse.move(chat.x + chat.w / 2, chat.y + chat.h / 2, { steps: 24 });
await p.mouse.up();
await wait(800);
await p.mouse.move(5, 5);
await wait(300);
await shot(SHOTS, 'one-hidden');
const name = (await count.count()) ? await count.first().getAttribute('aria-label') : null;
step(3, /^1 hidden app on the .* desk$/.test(name ?? ''), `Notebook over Chat gives: ${JSON.stringify(name)}`);

await count.first().focus();
await p.keyboard.press('Enter');
const list = p.getByRole('menu', { name: /Hidden apps on/ });
await list.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
await shot(SHOTS, 'list');
const item = list.getByRole('menuitem', { name: /Chat/ });
const listed = await item.count();
await item.first().click({ timeout: 4000 }).catch((e) => log('choose failed', e.message.slice(0, 100)));
await wait(300);
await shot(SHOTS, 'ring');
await wait(1500);
const saved = await p.evaluate((id) => JSON.parse(localStorage.getItem('ma.layout.v2') ?? '{}').desks?.[id]?.stack ?? null, ALLOWED);
step(4, listed === 1 && saved?.[saved.length - 1] === `${ALLOWED}:chat`, `the list named Chat, and choosing it brought it to the front: ${JSON.stringify(saved)}`);

const clean = p.getByRole('button', { name: /^Clean up .* desk$/ });
await clean.focus();
await p.keyboard.press('Enter');
await wait(1000);
await p.mouse.move(5, 5);
await wait(300);
await shot(SHOTS, 'cleaned');
step(5, (await count.count()) === 0, 'Cleanup clears the count');

const consoleProblems = events.filter((e) => e.k === 'console').length;
step(6, consoleProblems === 0, `console problems ${consoleProblems}`);
log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
await shutdown(failed === 0 ? 0 : 1, 'done');
