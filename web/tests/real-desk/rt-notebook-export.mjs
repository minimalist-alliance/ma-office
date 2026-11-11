// Notebook page export and print on the real test desk as desk-1 (S-13). Only the staging test desk, through staging's own bundle
// (MA_EXPECT_VERSION, required: the version `GET /v1/client-config?app=desk-web` names on staging) or this checkout's `dist/release`.
//
// Makes a scratch page "rt export check <time>" (title, heading, list, checklist, bold, link), then for every export the page menu
// offers (Markdown, Web page) saves the real download and reads it back, and for "Print or save as PDF" emulates print media,
// records what the print view is (its text, and whether any office chrome is still shown) once window.print has been called (stubbed, so the view stays), and makes
// a PDF of the page with page.pdf() and reads its text. The scratch page goes to Trash and is then deleted from it if the app allows.
//
//   flock -w 1800 ~/work/.test-desk.lock timeout 30m nice -n 15 env MA_EXPECT_VERSION=<staging's> node tests/real-desk/rt-notebook-export.mjs
//
// The desk must be running (nothing wakes it unless --wake). Results in test-results/real-desk/rt-notebook-export/report.json.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ALLOWED, getDesk, log, openSession, S, shot, shutdown, wait, waitPanel } from './rt-lib.mjs';

const DIST = new URL('../../dist/release/', import.meta.url).pathname;
const OUT = new URL('../../test-results/real-desk/rt-notebook-export/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const EXPECTED = process.env.MA_EXPECT_VERSION ?? null;
const release = EXPECTED ? { version: EXPECTED, entry: null } : JSON.parse(readFileSync(`${DIST}ma-release.json`, 'utf8'));
const failures = [];
const report = { bundle: release.version, desk: ALLOWED, steps: [] };
const note = () => writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
const step = (name, ok, text = '') => {
  if (!ok) failures.push(name);
  report.steps.push({ name, ok, text });
  note();
  log(`STEP ${name} ${ok ? 'PASS' : 'FAIL'} ${text}`);
};
const until = async (fn, ms, every = 250) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await wait(every);
  }
};
const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 28 * 60 * 1000);
watchdog.unref();

/** window.print is recorded, not run: the print view stays mounted so page.pdf() can take it. */
function printProbe() {
  const w = window;
  w.__print = { calls: 0, snap: null };
  w.__snap = () => {
    const view = document.querySelector('[data-testid="print-view"]');
    const shown = [...document.body.children].filter((e) => e !== view && !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName) && getComputedStyle(e).display !== 'none');
    return {
      media: matchMedia('print').matches,
      viewText: view ? view.innerText : null,
      viewDisplay: view ? getComputedStyle(view).display : null,
      chromeShown: shown.map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).slice(0, 40)}`),
    };
  };
  w.print = () => {
    w.__print.calls += 1;
  };
}

await openSession({
  browserKind: 'full',
  onContext: async (ctx) => {
    await ctx.addInitScript(printProbe);
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
  // 429 is the platform's rate limit on a call the page repeats (the desk's rtt); not the Notebook's.
  if (m.type() === 'error' && !/status of 429/.test(m.text())) problems += 1;
});
p.on('pageerror', () => {
  problems += 1;
});
const proxyButton = p.locator(`[id="proxy-${ALLOWED}"]`);
await proxyButton.waitFor({ state: 'attached', timeout: 60_000 });
const loaded = await p.evaluate(() => [...document.querySelectorAll('script[type="module"]')].map((e) => e.src).find((n) => /\/assets\//.test(n)) ?? null);
step('0 bundle', EXPECTED ? Boolean(loaded?.includes(`/v/${EXPECTED}/`)) : Boolean(loaded?.endsWith(release.entry.split('/').pop())), String(loaded));
const desk = await getDesk();
if (desk.state !== 'running' && !process.argv.includes('--wake')) {
  log(`STOP: the desk is ${desk.state}`);
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
const editor = win.getByTestId('note-editor');
const ok2 = await until(() => editor.isVisible(), 40_000);
step('2 the Notebook has an editor', Boolean(ok2));
if (!ok2) {
  await shutdown(1, 'no editor');
}

const stamp = new Date().toISOString().slice(11, 19);
const title = `rt export check ${stamp}`;
const BODY = { heading: 'Heading words', bullets: ['alpha item', 'beta item'], tasks: ['done task', 'open task'], bold: 'bold words', link: 'link words', url: 'https://example.com/rt-export' };
const currentId = () => win.locator('.nb-page-btn[aria-current="true"]').getAttribute('data-page-id');
await win.getByTestId('new-page').click();
await editor.waitFor({ state: 'visible' });
await until(() => p.evaluate(() => document.activeElement?.closest('[data-testid="note-editor"]') != null), 10_000, 50);
const pageId = await currentId();
await p.keyboard.type(title);
await p.keyboard.press('Enter');
await p.evaluate((B) => {
  const ed = document.querySelector('[data-testid="note-editor"]').editor;
  const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
  const para = (...c) => ({ type: 'paragraph', content: c });
  ed.chain().focus('end').insertContent([
    { type: 'heading', attrs: { level: 2 }, content: [t(B.heading)] },
    para(t('Plain, then '), t(B.bold, [{ type: 'bold' }]), t(', then a '), t(B.link, [{ type: 'link', attrs: { href: B.url } }]), t('.')),
    { type: 'bulletList', content: B.bullets.map((x) => ({ type: 'listItem', content: [para(t(x))] })) },
    { type: 'taskList', content: B.tasks.map((x, i) => ({ type: 'taskItem', attrs: { checked: i === 0 }, content: [para(t(x))] })) },
  ]).run();
}, BODY);
const saved = async () => Boolean(await until(async () => !(await win.getByTestId('notebook-line').isVisible()), 15_000)) && (await wait(2_500), !(await win.getByTestId('notebook-line').isVisible()));
step('3 scratch page made and saved', (await saved()) && (await editor.innerText()).includes(BODY.heading), `${title}`);
await shot(OUT, 'page');

const menu = async (name) => {
  await win.getByRole('button', { name: 'Page actions' }).click();
  await p.getByRole('menuitem', { name }).click();
};
const labels = await (async () => {
  await win.getByRole('button', { name: 'Page actions' }).click();
  const l = await p.getByRole('menuitem').allInnerTexts();
  await p.keyboard.press('Escape');
  return l;
})();
report.menuItems = labels;
log('MENU', labels.join(' | '));
const exportLabels = labels.filter((l) => /\(\.\w+\)/.test(l));
step('4 the menu offers export formats', exportLabels.length >= 2, exportLabels.join(', '));

const bad = (s) => (/undefined|\[object Object\]|NaN/.test(s) ? 'contains undefined/[object Object]' : '');
for (const label of exportLabels) {
  const ext = /\(\.(\w+)\)/.exec(label)[1];
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20_000 }), menu(label)]);
  const file = `${OUT}download.${ext}`;
  await dl.saveAs(file);
  const text = readFileSync(file, 'utf8');
  const name = dl.suggestedFilename();
  const has = (s) => text.includes(s);
  const common = has(title) && has(BODY.heading) && BODY.bullets.every(has) && BODY.tasks.every(has) && has(BODY.bold) && has(BODY.link) && has(BODY.url);
  let format = false;
  if (ext === 'md') format = has('## Heading words') && has(`**${BODY.bold}**`) && has(`[${BODY.link}](${BODY.url})`) && /^[-*] alpha item/m.test(text) && has('- [x] done task') && has('- [ ] open task') && !/<html/i.test(text);
  if (ext === 'html') format = /^<!doctype html>/i.test(text.trim()) && has('<h2') && has(`<strong>${BODY.bold}</strong>`) && has(`href="${BODY.url}"`) && has('<ul') && /type="checkbox"[^>]*checked/.test(text) && has('<title>');
  step(`5 export ${label}`, Boolean(common && format && !bad(text) && name.endsWith(`.${ext}`) && name.toLowerCase().includes('rt export check')), `${name}, ${text.length} chars ${bad(text)}${common ? '' : ' MISSING-TEXT'}${format ? '' : ' BAD-FORMAT'}`);
  rmSync(file);
}

// Print
// The window itself is hidden under print media, so the menu is used first and print media is emulated once print() was called.
await menu('Print or save as PDF');
await until(() => p.evaluate(() => window.__print.calls), 10_000, 100);
await p.emulateMedia({ media: 'print' });
const snap = await p.evaluate(() => window.__snap());
report.printSnap = snap;
log('PRINT', JSON.stringify(snap));
step('6 print was called once, in print media', Boolean(snap) && snap.media && (await p.evaluate(() => window.__print.calls)) === 1);
const vt = snap?.viewText ?? '';
const viewOk = [title, BODY.heading, ...BODY.bullets, ...BODY.tasks, BODY.bold, BODY.link].every((s) => vt.includes(s));
step('6 the print view shows the page text', viewOk && !bad(vt) && snap?.viewDisplay === 'block', JSON.stringify(vt.slice(0, 160)));
step('6 the office chrome is hidden', snap?.chromeShown.length === 0, (snap?.chromeShown ?? []).join(', '));
try {
  const pdf = await p.pdf({ printBackground: true });
  writeFileSync(`${OUT}print.pdf`, pdf);
  let txt = '';
  let pages = 0;
  try {
    txt = execFileSync('pdftotext', ['-layout', `${OUT}print.pdf`, '-'], { encoding: 'utf8' });
  } catch {
    // No poppler here: pdf.js (not a dependency; `npm i --no-save pdfjs-dist`) reads the text instead.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
    pages = doc.numPages;
    for (let i = 1; i <= pages; i += 1) txt += (await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + '\n';
  }
  pages ||= (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  txt = txt.replace(/\s+/g, ' ');
  report.pdf = { bytes: pdf.length, pages, text: txt.slice(0, 400) };
  const inPdf = [title, BODY.heading, BODY.bullets[0], BODY.tasks[1], BODY.bold].every((s) => txt.includes(s));
  step('7 the PDF has the page text and is one page', inPdf && !bad(txt) && pages >= 1, `${pdf.length} bytes, ${pages} page(s), text ${JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 140))}`);
} catch (e) {
  step('7 the PDF has the page text', false, String(e).slice(0, 200));
}
rmSync(`${OUT}print.pdf`, { force: true });
await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));
await p.emulateMedia({ media: null });
step('8 the print view is gone afterwards', Boolean(await until(async () => (await p.locator('[data-testid="print-view"]').count()) === 0, 5_000)));
await shot(OUT, 'after-print');

// Clean up: Trash, then empty only this page if the app allows.
const btn = win.locator(`.nb-page-btn[data-page-id="${pageId}"]`);
if (await btn.count()) await btn.first().click();
await wait(600);
if ((await currentId()) === pageId) {
  await menu('Delete page');
  await win.getByRole('button', { name: 'Delete', exact: true }).click();
  await wait(1_200);
}
// Leftovers of an earlier, crashed run of this script (same name), so a failed run never piles up pages.
for (let i = 0; i < 5; i += 1) {
  const old = win.locator('.nb-page-btn', { hasText: /^\s*rt export check/ });
  if (!(await old.count())) break;
  await old.first().click();
  await wait(600);
  if (!(await win.getByTestId('note-editor').innerText()).startsWith('rt export check')) break;
  await menu('Delete page');
  await win.getByRole('button', { name: 'Delete', exact: true }).click();
  await wait(1_000);
}
const inList = await win.locator(`.nb-page-btn[data-page-id="${pageId}"]`).count();
step('9 the scratch page is in Trash', inList === 0, `${inList} left in the list`);
try {
  const trashBtn = win.getByRole('button', { name: /Trash/ }).first();
  if (await trashBtn.count()) {
    await trashBtn.click();
    await wait(800);
    await shot(OUT, 'trash');
    const row = win.getByText(title).first();
    if (await row.count()) {
      report.trashOptions = (await win.getByRole('button').allInnerTexts()).filter((x) => /delete|empty|restore|forever/i.test(x));
      log('TRASH', report.trashOptions.join(' | '));
    }
  }
} catch (e) {
  log('trash peek failed', String(e).slice(0, 100));
}
step('9 no console errors', problems === 0, `${problems}`);
report.failures = failures;
note();
log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASSED');
await shutdown(failures.length ? 1 : 0, 'done');
