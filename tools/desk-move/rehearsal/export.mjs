// Test B of the rehearsal: the shipping Desk app bundle, served by web/harness as production serves it, downloads
// everything from the rehearsal's real deskd at /export, in full headless Chromium as web's `rtc` project runs it.
// Modelled on web/tests/e2e/export.shell.spec.ts and rtc.spec.ts. rig.py starts the harness and drops the connection;
// this drives the page and saves the archive.
//
//   node export.mjs --base http://localhost:<harness> --shim http://127.0.0.1:<shim> --out <dir> --web <web dir>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: arg } = parseArgs({ options: { base: { type: 'string' }, shim: { type: 'string' }, out: { type: 'string' }, web: { type: 'string' } } });
const { chromium } = createRequire(join(arg.web, 'package.json'))('@playwright/test');

const result = { timings: {}, phases: [], console: [], picker: null };
const save = () => writeFileSync(join(arg.out, 'result.json'), JSON.stringify(result, null, 2));
const harness = (patch) => fetch(`${arg.base}/__harness`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  await harness({ reset: true });
  await harness({ shim: arg.shim, export: { enabled: true, moves: false } });
  const context = await browser.newContext({ baseURL: arg.base, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') result.console.push(m.text()); });
  page.on('pageerror', (e) => result.console.push(String(e)));
  // Whether this Chromium offers a save picker at all; the page then gets none, so it takes the OPFS path.
  await page.addInitScript(() => {
    window.__hadPicker = typeof window.showSaveFilePicker === 'function';
    delete window.showSaveFilePicker;
  });
  await page.exposeFunction('__phase', (p) => { result.phases.push({ t: Date.now(), p }); });

  // Sign in through the harness's real redirect and callback, as helpers.signIn does.
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  await button.or(page.locator('.ma-shell')).first().waitFor({ timeout: 30_000 });
  if (await button.isVisible()) await button.click();
  await page.locator('.ma-shell').waitFor({ timeout: 30_000 });
  await page.goto('/export');
  await page.getByRole('heading', { name: 'Your data', level: 1 }).waitFor({ timeout: 30_000 });
  result.picker = await page.evaluate(() => window.__hadPicker);
  const start = page.getByTestId('export-start');
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="export-start"]');
    return b && !b.disabled;
  }, null, { timeout: 60_000 });
  result.rows = await page.locator('[data-testid^="choose-"]').allInnerTexts();
  await page.evaluate(() => {
    let last = '';
    new MutationObserver(() => {
      const row = document.querySelector('[data-testid^="progress-"]');
      const p = row?.getAttribute('data-phase') ?? '';
      const text = row?.textContent ?? '';
      if (`${p}|${text}` !== last) {
        last = `${p}|${text}`;
        window.__phase(`${p}: ${text}`);
      }
    }).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  result.timings.clickMs = Date.now();
  await start.click();
  const saveLink = page.getByTestId('export-save');
  await saveLink.waitFor({ timeout: 1_500_000 });
  result.timings.doneMs = Date.now();
  result.done = await page.getByTestId('export-done').innerText();
  const [download] = await Promise.all([page.waitForEvent('download'), saveLink.click()]);
  await download.saveAs(join(arg.out, 'export.zip'));
  result.suggested = download.suggestedFilename();
  await page.getByRole('button', { name: 'Done' }).click();
  result.opfsCleared = await page.evaluate(async () => (await navigator.storage.getDirectory()).getFileHandle('ma-export.zip').then(() => false, () => true));
  await context.close();
} catch (e) {
  result.error = String(e?.stack ?? e);
  process.exitCode = 1;
} finally {
  save();
  await browser.close();
}
