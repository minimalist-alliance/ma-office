// The Notebook on the real test desk as desk-1, with this checkout's own bundle in place of staging's (`dist/release`, served by
// page.route at the app's own origin, so sign-in, the real CSP and the gateway are all the real ones). Only the test desk (`RT_DESK`).
//
// What it proves depends on the desk:
// - `notebook.tree` answers `not_found`, as a desk with no Notebook service does: the calm window, nothing to type into, one
//   question, nothing on `collab`, no console errors and no CSP report. This is what a member sees until the service ships.
// - It answers: the real check. A new page, text typed, saved on the desk, a reload (a new session), still there. A second tab on
//   the same page, and typing in each reaches the other. A version saved and shown in History, and search finding the page. A
//   paste of about 1.6 MB, which goes in several messages, none near 1 MiB, saved, and whole after another reload. Both pages
//   go to Trash at the end.
//
// Hold the test desk's lock for the whole run, and no more than 45 minutes:
//
//   npm run build:release
//   flock ~/work/.test-desk.lock timeout 45m nice -n 15 node tests/real-desk/rt-notebook.mjs
//   MA_EXPECT_VERSION=2026.11.07-abc1234 ... node tests/real-desk/rt-notebook.mjs   # staging's own bundle, once it's promoted there
//
// The desk must be running already, unless `--wake` says this may wake it by focusing it, as a member would.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALLOWED, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-notebook/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
/** Set: staging's own bundle, which must be this version. Unset: this checkout's `dist/release` in its place. */
const EXPECTED = process.env.MA_EXPECT_VERSION ?? null;
const release = EXPECTED ? { version: EXPECTED, entry: null } : JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
const WATCHDOG_MS = 40 * 60 * 1000;

const failures = [];
const report = { bundle: release.version, desk: ALLOWED, steps: [] };
const note = () => writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
const step = (name, ok, text = '') => {
  if (!ok) failures.push(name);
  report.steps.push({ name, ok, text });
  note();
  log(`STEP ${name} ${ok ? 'PASS' : 'FAIL'} ${text}`);
};
const skip = (name, why) => {
  report.steps.push({ name, skipped: why });
  note();
  log(`STEP ${name} SKIPPED ${why}`);
};
const until = async (fn, ms, every = 250) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await wait(every);
  }
};

/** Method names and counts only: no note text ever leaves the page in this. CSP reports, by directive. */
function clientProbe() {
  const w = window;
  // Whole collab messages by size, from each frame's header: MORE is bit 0 of byte 2, and the id is bytes 4 to 7.
  const nb = (w.__nb = { rpc: {}, collabFrames: 0, collabSizes: [], pending: {}, csp: [] });
  document.addEventListener('securitypolicyviolation', (e) => nb.csp.push(`${e.effectiveDirective}: ${e.blockedURI}`));
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(d) {
    try {
      if (this.label === 'collab') {
        nb.collabFrames += 1;
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
        nb.pending[id] = (nb.pending[id] ?? 0) + bytes.byteLength - 12;
        if (!(bytes[2] & 1)) {
          nb.collabSizes.push(nb.pending[id]);
          delete nb.pending[id];
        }
      }
      if (this.label === 'rpc' && d && d.byteLength < 4096) {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        const m = /"m":"(notebook\.[a-zA-Z.]+)"/.exec(new TextDecoder().decode(bytes.subarray(12)));
        if (m) nb.rpc[m[1]] = (nb.rpc[m[1]] ?? 0) + 1;
      }
    } catch {
      /* never in the way */
    }
    return send.call(this, d);
  };
}

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), WATCHDOG_MS);
watchdog.unref();

await openSession({
  browserKind: 'full',
  onContext: async (ctx) => {
    await ctx.addInitScript(clientProbe);
    // This checkout's bundle in place of the one staging names, at the same paths, so nothing else about the page changes.
    if (EXPECTED) return;
    await ctx.route(/\/v\/[^/]+\/ma-release\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(release) }));
    await ctx.route(/\/v\/[^/]+\/assets\/[^/?]+/, (route) => {
      const file = `${DIST}assets/${new URL(route.request().url()).pathname.split('/').pop()}`;
      return existsSync(file) ? route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }) : route.continue();
    });
  },
});

const p = S.page;
let problems = 0;
p.on('console', (m) => {
  if (m.type() === 'error') problems += 1;
});
p.on('pageerror', () => {
  problems += 1;
});

const probe = () => p.evaluate(() => window.__nb);
const proxyButton = p.locator(`[id="proxy-${ALLOWED}"]`);
await proxyButton.waitFor({ state: 'attached', timeout: 60_000 });
const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
step('0 bundle', EXPECTED ? Boolean(loaded?.includes(`/v/${EXPECTED}/`)) : Boolean(loaded?.endsWith(release.entry.split('/').pop())), EXPECTED ? `staging's ${loaded}` : `this checkout's ${release.version} (${release.entry})`);
const desk = await getDesk();
report.deskState = desk.state;
log('desk state', desk.state);
if (desk.state !== 'running' && !process.argv.includes('--wake')) {
  log(`STOP: the desk is ${desk.state}, and opening an app would wake it. --wake to do that`);
  note();
  await shutdown(1, 'desk not running');
}

await proxyButton.focus();
await p.keyboard.press('Enter');
step('1 online', await waitPanel(/online/, 120_000));

const tile = p.locator(`[id="proxy-${ALLOWED}:notebook"]`);
await tile.focus();
await p.keyboard.press('Enter');
const win = p.getByRole('dialog', { name: /Notebook/ }).first();
await win.waitFor({ state: 'visible', timeout: 15_000 });
const panel = win.getByTestId('notebook-panel');
const editor = win.getByTestId('note-editor');
const state = await until(async () => {
  if (await editor.isVisible()) return 'editor';
  const kind = await panel.getAttribute('data-panel', { timeout: 200 });
  return kind === 'missing' || kind === 'unavailable' ? kind : null;
}, 40_000);
step('2 the window settles', Boolean(state), `it says ${state}`);
await shot(OUT, `notebook-${state ?? 'none'}`);

if (state === 'missing') {
  step('3 the calm line', (await panel.innerText()).includes("Notebook isn't on this desk yet"), JSON.stringify((await panel.innerText()).replace(/\s+/g, ' ')));
  step('4 nothing to type into', (await win.locator('input, textarea, [contenteditable="true"]').count()) === 0);
  await wait(20_000);
  const seen = await probe();
  step('5 one question, and nothing on collab', seen.rpc['notebook.tree'] === 1 && seen.collabFrames === 0, JSON.stringify(seen.rpc) + ` collab frames ${seen.collabFrames}`);
  skip('6 typed, reloaded and still there', 'notebook.* answers not_found on this desk');
} else if (state === 'editor') {
  // The real check, against the Desk Engineer's service on this desk.
  const stamp = Date.now();
  // The browser's own prompt on leaving means text the desk hadn't confirmed. Never expected here: say so, and go on.
  let leavingPrompts = 0;
  p.on('dialog', (d) => {
    if (d.type() === 'beforeunload') leavingPrompts += 1;
    void d.accept().catch(() => {});
  });
  const word = `rt-notebook-${stamp}`;
  const line = () => win.getByTestId('notebook-line');
  /** Pages this run made, by id, for the Trash at the end. */
  const currentId = () => win.locator('.nb-page-btn[aria-current="true"]').getAttribute('data-page-id');
  const made_ = [];
  // A new page opens once the desk has sent it, a round trip, and the editor takes focus then. Typing waits for that, as a member's
  // eyes would, and how long it took is reported.
  const editorFocused = () => p.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="note-editor"]')) && document.activeElement?.getAttribute('contenteditable') === 'true');
  const newPage = async () => {
    const t0 = Date.now();
    await win.getByTestId('new-page').click();
    await editor.waitFor({ state: 'visible' });
    const where = () => p.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).split(' ').slice(0, 2).join('.')} ${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('aria-label') ?? ''}` : 'none';
    });
    const focused = await until(editorFocused, 10_000, 25);
    if (!focused) log('FOCUS still on', await where());
    const ms = Date.now() - t0;
    if (!focused) await editor.click();
    return { ms, focused: Boolean(focused) };
  };
  const saved = async (ms) => Boolean(await until(async () => !(await line().isVisible()), ms)) && (await wait(2_500), !(await line().isVisible()));
  const made = await newPage();
  report.newPageToFocusMs = made.ms;
  made_.push(await currentId());
  await p.keyboard.type(word);
  await p.keyboard.press('Enter');
  await p.keyboard.type('Typed on the real desk.');
  // "Not saved yet." shows after 2 s with no confirmation, so its absence past that is the desk's answer.
  const typed = (await editor.innerText()).includes(word);
  step('3 a new page takes focus by itself', made.focused && made.ms < 3_000, made.focused ? `in ${made.ms} ms` : 'never in 10 s, so it was clicked');
  step('3 typed into its Title, and the desk confirmed it', typed && (await saved(15_000)) && (await probe()).collabFrames > 0 && (await editor.locator('h1').first().innerText()).includes(word));
  await wait(3_000); // past the store's debounce, so a title and a version have something to read
  await shot(OUT, 'notebook-typed');

  const caretOf = (pg) => pg.evaluate(() => {
    const s = getSelection();
    const root = document.querySelector('[data-testid="note-editor"]');
    const block = s?.anchorNode ? [...(root?.children ?? [])].findIndex((b) => b.contains(s.anchorNode)) : -2;
    const ed = root?.editor;
    const pm = ed ? `pm ${ed.state.selection.from}/${ed.state.doc.content.size} ${ed.state.selection.$from.parent.type.name}` : 'pm ?';
    return `dom block ${block} of ${root?.children.length} (${root?.children[block]?.tagName ?? '-'}) at ${s?.anchorOffset}, ${pm}, focus ${document.hasFocus()}`;
  });
  /**
   * Click into the page and go to its end. ProseMirror reads a click's caret on the next selectionchange, and a script's keys can
   * beat that by milliseconds (a member's can't), so this waits until ProseMirror's own selection is at the end.
   */
  const toEnd = async (pg, ed) => {
    await ed.click();
    await pg.keyboard.press('Control+End');
    return Boolean(
      await until(() => pg.evaluate(() => {
        const e = document.querySelector('[data-testid="note-editor"]')?.editor;
        return Boolean(e) && e.state.selection.from >= e.state.doc.content.size - 1;
      }), 3_000, 25),
    );
  };
  const reopen = async () => {
    await p.reload();
    await proxyButton.waitFor({ state: 'attached', timeout: 60_000 });
    await proxyButton.focus();
    await p.keyboard.press('Enter');
    await wait(1_000);
    await waitPanel(/online/, 120_000);
    await tile.focus();
    await p.keyboard.press('Enter');
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
  };
  await reopen();
  step('4 still there after a reload, on a new session', Boolean(await until(async () => (await editor.innerText()).includes(word), 15_000)) && leavingPrompts === 0, `leaving prompts ${leavingPrompts}`);

  {
    const atEnd = await toEnd(p, editor);
    await p.keyboard.press('Enter');
    await p.keyboard.type(`One tab ${stamp}.`);
    const lines = (await editor.innerText()).split('\n').filter(Boolean);
    step('4 a line added at the end of a page from the desk lands at the end', atEnd && lines.at(-1) === `One tab ${stamp}.`, `${await caretOf(p)}`);
    await saved(10_000);
  }

  // A second tab, signed in by the same browser, on the same page: its own session on the desk.
  const p2 = await S.context.newPage();
  p2.on('console', (m) => {
    if (m.type() === 'error') problems += 1;
  });
  p2.on('pageerror', () => {
    problems += 1;
  });
  await p2.goto(p.url(), { waitUntil: 'load' });
  const proxy2 = p2.locator(`[id="proxy-${ALLOWED}"]`);
  await proxy2.waitFor({ state: 'attached', timeout: 60_000 });
  await proxy2.focus();
  await p2.keyboard.press('Enter');
  await wait(3_000);
  const tile2 = p2.locator(`[id="proxy-${ALLOWED}:notebook"]`);
  await tile2.focus();
  await p2.keyboard.press('Enter');
  const win2 = p2.getByRole('dialog', { name: /Notebook/ }).first();
  const editor2 = win2.getByTestId('note-editor');
  await editor2.waitFor({ state: 'visible', timeout: 60_000 });
  const same = await until(async () => (await editor2.innerText()).includes(word), 20_000);
  const caretTrail = [];
  // Typing goes to the tab in front, as for a member. A page behind gets no selectionchange, so ProseMirror wouldn't hear the click.
  await p.bringToFront();
  caretTrail.push(`1 at the end: ${await toEnd(p, editor)}`);
  await p.keyboard.press('Enter');
  await p.keyboard.type(`From the first tab ${stamp}.`);
  caretTrail.push(`1 typed: ${await caretOf(p)}`);
  const toSecond = await until(async () => (await editor2.innerText()).includes(`From the first tab ${stamp}.`), 15_000);
  await p2.bringToFront();
  caretTrail.push(`2 at the end: ${await toEnd(p2, editor2)}`);
  await p2.keyboard.press('Enter');
  await p2.keyboard.type(`From the second tab ${stamp}.`);
  caretTrail.push(`2 typed: ${await caretOf(p2)}`);
  log('CARET', caretTrail.join(' | '));
  report.caretTrail = caretTrail;
  const toFirst = await until(async () => (await editor.innerText()).includes(`From the second tab ${stamp}.`), 15_000);
  await wait(2_500);
  const agree = (await editor.innerText()) === (await editor2.innerText());
  // In order, at the end, each its own line: what a member would expect of two tabs on one page.
  const lines = (await editor.innerText()).split('\n').filter(Boolean);
  const inOrder = lines.at(-2) === `From the first tab ${stamp}.` && lines.at(-1) === `From the second tab ${stamp}.`;
  try {
    await p2.screenshot({ path: `${OUT}two-tabs-second.png` });
  } catch {
    /* a picture only */
  }
  await shot(OUT, 'two-tabs-first');
  step('5 two tabs on one page converge', Boolean(same && toSecond && toFirst && agree && inOrder), `opened on it ${Boolean(same)}, first to second ${Boolean(toSecond)}, second to first ${Boolean(toFirst)}, identical ${agree}, each at the end in order ${inOrder}`);
  await p2.close();
  await p.bringToFront();
  step('5 both tabs saved', await saved(15_000));

  // A version, saved by hand and shown in History.
  await win.getByRole('button', { name: 'Page actions' }).click();
  await p.getByRole('menuitem', { name: 'Save a version now' }).click();
  await wait(2_000);
  await win.getByRole('button', { name: 'History', exact: true }).click();
  const history = win.getByTestId('history');
  await history.waitFor({ state: 'visible', timeout: 15_000 });
  const versions = await until(async () => {
    const n = await history.getByRole('list', { name: 'Versions' }).getByRole('button').count();
    return n > 0 && (await history.locator('.nb-prose').innerText()).includes(word) ? n : null;
  }, 15_000);
  await shot(OUT, 'notebook-history');
  step('6 a version, and History shows it', Boolean(versions), `${versions ?? 0} version(s)`);
  await history.getByRole('button', { name: 'Back to the page' }).click();
  await history.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

  // Search, from the desk's own index, which a store fills.
  await editor.click();
  await p.keyboard.press('Control+K');
  const input = win.getByTestId('search-input');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(word.slice(0, 16));
  const found = await until(async () => (await win.getByRole('option').filter({ hasText: word }).count()) > 0, 20_000);
  await shot(OUT, 'notebook-search');
  step('7 search finds the page', Boolean(found));
  if (found) await win.getByRole('option').filter({ hasText: word }).first().click(); // opens it, and the search closes
  else await p.keyboard.press('Escape');
  await wait(500);

  // A large paste: over 1 MiB, so the editor sends it in pieces, and nothing on the wire comes near DATA's 4 MiB.
  await newPage();
  made_.push(await currentId());
  const pasteTitle = `rt-paste-${stamp}`;
  await p.keyboard.type(pasteTitle);
  await p.keyboard.press('Enter');
  const before = (await probe()).collabSizes.length;
  const pasted = await p.evaluate(() => {
    const lines = [];
    for (let i = 0; i < 1000; i += 1) lines.push(`Line ${i} ${'the ferry leaves at seven forty from pier two '.repeat(35)}`);
    const text = lines.join('\n');
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('[data-testid="note-editor"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return { chars: text.length, last: `Line 999 the ferry` };
  });
  const shown = await until(() => p.evaluate((last) => (document.querySelector('[data-testid="note-editor"]')?.lastElementChild?.textContent ?? '').startsWith(last), pasted.last), 60_000);
  const pasteSaved = Boolean(shown) && (await saved(90_000));
  const sizes = (await probe()).collabSizes.slice(before).filter((n) => n > 64 * 1024);
  const biggest = Math.max(0, ...sizes);
  await shot(OUT, 'notebook-paste');
  step('8 a paste of about 1.6 MB goes in pieces and is saved', pasteSaved && sizes.length >= 2 && biggest < 1024 * 1024, `${pasted.chars} chars, ${sizes.length} messages over 64 KiB, the largest ${biggest} bytes`);
  await wait(3_000);
  await reopen();
  const whole = await until(() => p.evaluate((last) => (document.querySelector('[data-testid="note-editor"]')?.lastElementChild?.textContent ?? '').startsWith(last), pasted.last), 30_000);
  step('8 all of it there after a reload', Boolean(whole) && (await editor.innerText()).includes(pasteTitle) && leavingPrompts === 0, `leaving prompts ${leavingPrompts}`);

  // Both pages to Trash, by id.
  const trash = async () => {
    await win.getByRole('button', { name: 'Page actions' }).click();
    await p.getByRole('menuitem', { name: 'Delete page' }).click();
    await win.getByRole('button', { name: 'Delete', exact: true }).click();
    await wait(1_000);
  };
  for (const id of made_.filter(Boolean).reverse()) {
    const btn = win.locator(`.nb-page-btn[data-page-id="${id}"]`);
    if (!(await btn.count())) continue;
    await btn.first().click();
    await wait(800);
    if ((await currentId()) === id) await trash();
  }
  const left = [];
  for (const id of made_.filter(Boolean)) if (await win.locator(`.nb-page-btn[data-page-id="${id}"]`).count()) left.push(id);
  step('9 cleaned up: both test pages are in Trash', made_.filter(Boolean).length === 2 && left.length === 0, `${made_.filter(Boolean).length} made, ${left.length} left`);
} else {
  skip('3 and on', `the window says ${state}`);
}

const after = await probe();
step('9 no CSP report', after.csp.length === 0, after.csp.join(', '));
step('9 no console errors', problems === 0, `${problems}`);
report.failures = failures;
note();
log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASSED');
await shutdown(failures.length ? 1 : 0, 'done');
