// Files context menus and Steel teal through the real window on the staging test desk, as the e2e test account (desk-1).
// Run under the test-desk lock, after the gate:  npx playwright test -c release-1110 menus.spec.ts
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loadUser, onDesk, signInApp, watch, focusTestDesk } from '../tests/lib';

const note = (k: string, v: unknown) => console.log(`[menus] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

test('Files menus, colors, one upload and download', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const tag = randomBytes(3).toString('hex');
  const work = mkdtempSync(join(tmpdir(), 'rel1110m-'));
  const name = `rel1110-${tag}.bin`;
  const src = join(work, name);
  writeFileSync(src, randomBytes(3 * 1048576));
  const want = createHash('sha256').update(readFileSync(src)).digest('hex');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => { delete (window as unknown as Record<string, unknown>)['showSaveFilePicker']; });
  const page = await context.newPage();
  const w = watch(page);
  try {
    await signInApp(context, page, loadUser('desk-1'));
    await focusTestDesk(page, w);
    const desk = page.getByRole('group', { name: /^test-desk/ });
    await desk.getByRole('button', { name: /^Files/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.getByRole('dialog', { name: /^Files/ });
    await expect(win.getByTestId('files-usage-words')).toBeVisible({ timeout: 60_000 });
    const row = win.locator(`[data-testid="files-row"][data-name="${name}"]`);
    await win.getByTestId('files-pick-files').setInputFiles(src);
    await expect(row).toBeVisible({ timeout: 120_000 });
    const menu = page.getByTestId('files-menu');
    const read = async () => menu.evaluate((m) => Array.from(m.children).map((c) => (c.getAttribute('role') === 'menuitem' ? { t: (c.textContent ?? '').trim(), danger: c.classList.contains('danger'), color: getComputedStyle(c).color } : { sep: c.getAttribute('role') ?? c.tagName })));
    // file menu
    await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
    const file = await read(); note('file menu', file);
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
    // Shift+F10
    await row.click(); await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible(); note('Shift+F10 opens menu', true);
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
    // empty space (after the 400 ms in which the list takes a right click for the key's own echo)
    await page.waitForTimeout(900);
    await win.getByTestId('files-list').click({ button: 'right', position: { x: 260, y: 240 } });
    await expect(menu).toBeVisible();
    const empty = await read(); note('empty-space menu', empty);
    await page.keyboard.press('Escape');
    // colors
    const accent = await win.evaluate((e) => getComputedStyle(e).getPropertyValue('--ma-accent').trim());
    await desk.getByRole('button', { name: /^Notebook/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const nb = page.getByRole('dialog', { name: /Notebook/ });
    await expect(nb).toBeVisible({ timeout: 30_000 });
    const other = await nb.evaluate((e) => getComputedStyle(e).getPropertyValue('--ma-accent').trim());
    note('accent in Files / in Notebook window', [accent, other]);
    await page.getByRole('button', { name: /^Close Notebook/ }).first().click().catch(() => {});
    // download
    await row.click();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), win.getByRole('button', { name: 'Download', exact: true }).click()]);
    const out = join(work, 'dl.bin'); await dl.saveAs(out);
    const got = createHash('sha256').update(readFileSync(out)).digest('hex');
    note('download sha256 matches', got === want);
    const onDisk = await onDesk(`sha256sum $(find /data/files -name '${name}') | cut -d' ' -f1`);
    note('desk copy sha256 matches', onDisk.trim() === want);
    // delete to trash, trash menu
    await row.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /^Delete/ }).click();
    await page.waitForTimeout(1500);
    await win.getByRole('button', { name: /^Trash/ }).click();
    const trow = win.locator('[data-testid="files-row"]').first();
    await expect(trow).toBeVisible({ timeout: 30_000 });
    await trow.click({ button: 'right' });
    await expect(menu).toBeVisible();
    const trash = await read(); note('trash menu', trash);
    await page.keyboard.press('Escape');
    await menu.getByRole('menuitem', { name: /Delete forever/ }).click().catch(() => {});
    // delete forever via menu
    await trow.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /Delete forever/ }).click();
    const confirm = page.getByTestId(/files-dialog|confirm/).getByRole('button', { name: /Delete forever|Delete/ }).last();
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(2500);
    note('left on desk', (await onDesk(`find /data/files -name '${name}' | wc -l`)).trim());
    note('console errors', w.errors);
  } finally {
    await context.close();
    rmSync(work, { recursive: true, force: true });
  }
});
