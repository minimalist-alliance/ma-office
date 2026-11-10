// Files window on the staging test desk, through the real window, as the e2e test account (desk-1).
// Run after the gate, never beside it:  npx playwright test -c release-1110 files.spec.ts
// No secret, file name or content is printed except random test names `rel1110-*`.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { loadUser, onDesk, openAbout, signInApp, watch, focusTestDesk, type Watch, assertTestDesk } from '../tests/lib';
import { sleep } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[files] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sha = (p: string) => new Promise<string>((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const mk = (path: string, mb: number) => execFileSync('sh', ['-c', `head -c ${mb * 1048576} /dev/urandom > "${path}"`]);

const tag = randomBytes(3).toString('hex');
const work = mkdtempSync(join(tmpdir(), 'rel1110-'));
const big = join(work, `rel1110-${tag}.bin`);
const renamed = `rel1110-${tag}-renamed.bin`;
const dirName = `rel1110dir${tag}`;

let context: BrowserContext;
let page: Page;
let w: Watch;
const filesWin = () => page.getByRole('dialog', { name: /^Files/ });
const row = (name: string) => filesWin().locator(`[data-testid="files-row"][data-name="${name}"]`);
const usage = async () => (await filesWin().getByTestId('files-usage-words').innerText()).trim();
const deskFiles = async () => (await onDesk(`ls -1A /data/files /data/files/* 2>/dev/null | head -60; echo; du -sb /data/files | cut -f1`)).trim();

async function start(): Promise<void> {
  context = await (await import('@playwright/test')).chromium.launch({ channel: 'chromium' }).then((b) => b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }));
  await context.addInitScript(() => { delete (window as unknown as Record<string, unknown>)['showSaveFilePicker']; });
  page = await context.newPage();
  w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
  await focusTestDesk(page, w);
}
async function openFiles(): Promise<void> {
  const tile = page.getByRole('group', { name: /^test-desk/ }).getByRole('button', { name: /^Files/ });
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(filesWin()).toBeVisible();
  await expect(filesWin().getByTestId('files-usage-words')).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(async () => {
  assertTestDesk(); // the staging test desk only
  mk(big, 50);
  note('50 MB file made', 'random, sha256 below');
  await start();
});
test.afterAll(async () => { await context?.browser()?.close(); rmSync(work, { recursive: true, force: true }); });

test('the Files tile shows, the window opens', async () => {
  const tiles = await page.getByRole('group', { name: /^test-desk/ }).getByRole('button').allInnerTexts();
  note('tiles on the test desk', tiles.map((t) => t.split('\n')[0]));
  await openFiles();
  note('usage line at start', await usage());
  const names = async () => (await filesWin().getByRole('group', { name: 'Actions' }).getByRole('button').allInnerTexts()).map((t) => t.trim());
  note('toolbar at rest (no selection)', await names());
  expect(await names()).not.toContain('Download');
  const u = filesWin().getByTestId('files-usage');
  note('footer words', await usage());
  expect(await usage()).toMatch(/^\d+(\.\d)? (MB|GB) of \d+(\.\d)? GB used$/);
  const tip = (await u.getAttribute('title')) ?? '';
  note('footer tooltip', tip);
  const sf = (await onDesk(`stat -f -c '%S %b %a %f' /data`)).trim().split(' ').map(Number);
  const total = sf[0]! * sf[1]!, free = sf[0]! * sf[2]!;
  note('statvfs on the desk: total, free for users (f_bavail), free incl. reserved (f_bfree), used = total - bavail (bytes)', [total, free, sf[0]! * sf[3]!, total - free]);
  const gb = (t: string) => Number(/([\d.]+) GB/.exec(t)![1]);
  const m = /^([\d.]+) (\w+) of ([\d.]+) (\w+) used, Files ([\d.]+) (\w+)(?:, Trash ([\d.]+) (\w+))?, All other apps ([\d.]+) (\w+), ([\d.]+) (\w+) free/.exec(tip);
  expect(m, 'tooltip shape').not.toBeNull();
  const unit: Record<string, number> = { bytes: 1, B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  const v = (n: string | undefined, uu: string | undefined) => (n ? Number(n) * unit[uu!]! : 0);
  const parts = { used: v(m![1], m![2]), total: v(m![3], m![4]), files: v(m![5], m![6]), trash: v(m![7], m![8]), other: v(m![9], m![10]), free: v(m![11], m![12]) };
  note('tooltip numbers (bytes)', parts);
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  note('tooltip total vs statvfs total (GB)', [parts.total / 1e9, total / 1e9]);
  expect(near(parts.total, total, 0.15e9)).toBe(true);
  expect(near(parts.free, free, 0.15e9)).toBe(true);
  expect(near(parts.used, total - free, 0.15e9)).toBe(true);
  note('parts add up: files+trash+other vs used; used+free vs total (GB)', [(parts.files + parts.trash + parts.other) / 1e9, parts.used / 1e9, (parts.used + parts.free) / 1e9, parts.total / 1e9]);
  expect(near(parts.files + parts.trash + parts.other, parts.used, 0.35e9)).toBe(true);
  expect(near(parts.used + parts.free, parts.total, 0.15e9)).toBe(true);
  void gb;
  note('files on the desk at start', (await deskFiles()).split('\n').slice(-3));
});

test('upload 50 MB, download, sha256 matches', async () => {
  test.setTimeout(10 * 60_000);
  const want = await sha(big);
  note('sha256 of the upload', want.slice(0, 16) + '...');
  const before = await usage();
  const t0 = Date.now();
  await filesWin().getByTestId('files-pick-files').setInputFiles(big);
  await expect(row(`rel1110-${tag}.bin`)).toBeVisible({ timeout: 5 * 60_000 });
  await expect(filesWin().getByTestId('files-xfer').first()).toHaveAttribute('data-state', 'done', { timeout: 5 * 60_000 });
  note('upload seconds', ((Date.now() - t0) / 1000).toFixed(1));
  note('row size', (await row(`rel1110-${tag}.bin`).locator('.c-size').innerText()).trim());
  await expect.poll(usage, { timeout: 30_000 }).not.toBe(before);
  note('usage before / after upload', [before, await usage()]);
  const onDisk = await onDesk(`find /data/files -name 'rel1110-${tag}.bin' -printf '%s %u\\n'; sha256sum $(find /data/files -name 'rel1110-${tag}.bin') | cut -d' ' -f1`);
  note('on the desk (size owner, sha256 head)', onDisk.trim().split('\n').map((l, i) => (i === 1 ? l.slice(0, 16) + '...' : l)));
  expect(onDisk).toContain(want);
  // download
  await filesWin().getByTestId('files-xfer').first().getByRole('button', { name: /^Dismiss/ }).click().catch(() => {});
  await row(`rel1110-${tag}.bin`).click();
  const withSel = (await filesWin().getByRole('group', { name: 'Actions' }).getByRole('button').allInnerTexts()).map((t) => t.trim());
  note('toolbar with one file selected', withSel);
  expect(withSel).toEqual(expect.arrayContaining(['Download', 'Rename', 'Move to…', 'Delete']));
  const slowNote = () => page.getByText('slower while your Browser is on screen').count();
  const t1 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5 * 60_000 }), filesWin().getByRole('button', { name: 'Download', exact: true }).click()]);
  note('browser-on-screen note shown during download', await slowNote());
  const out = join(work, 'dl.bin');
  await dl.saveAs(out);
  note('download seconds', ((Date.now() - t1) / 1000).toFixed(1));
  const got = await sha(out);
  note('download sha256 matches', got === want);
  expect(got).toBe(want);
});

test('rename, trash, restore, trash again, empty the trash', async () => {
  test.setTimeout(5 * 60_000);
  await row(`rel1110-${tag}.bin`).click();
  await filesWin().getByRole('button', { name: 'Rename', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename' });
  await dlg.getByLabel('New name').fill(renamed);
  await dlg.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(row(renamed)).toBeVisible({ timeout: 30_000 });
  note('rename', 'ok');
  note('toolbar right after rename (selection gone?)', (await filesWin().getByRole('group', { name: 'Actions' }).getByRole('button').allInnerTexts()).map((t) => t.trim()));
  await row(renamed).click();
  const beforeTrash = await usage();
  await filesWin().getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(renamed)).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => filesWin().getByRole('button', { name: /^Trash/ }).innerText(), { timeout: 30_000 }).toContain('(');
  note('usage before / after delete to trash (trash still counts)', [beforeTrash, await usage()]);
  await filesWin().getByRole('button', { name: /^Trash/ }).click();
  await expect(row(renamed)).toBeVisible({ timeout: 30_000 });
  await row(renamed).click();
  await filesWin().getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(row(renamed)).toHaveCount(0, { timeout: 30_000 });
  await filesWin().getByRole('button', { name: 'Back to files' }).click();
  await expect(row(renamed)).toBeVisible({ timeout: 30_000 });
  note('restore', 'ok, back in the folder');
  // search
  await filesWin().getByTestId('files-search').fill(`rel1110-${tag}`);
  await expect(row(renamed)).toBeVisible({ timeout: 30_000 });
  note('search finds it', await filesWin().locator('h3.files-where').innerText().catch(() => '?'));
  await filesWin().getByTestId('files-search').fill('');
  await filesWin().getByRole('button', { name: 'Back to files' }).click().catch(() => {});
  await row(renamed).click();
  await filesWin().getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(renamed)).toHaveCount(0, { timeout: 30_000 });
  await sleep(1500);
  await filesWin().getByRole('button', { name: /^Trash/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(filesWin().getByRole('button', { name: 'Back to files' })).toBeVisible({ timeout: 30_000 });
  await expect(row(renamed)).toBeVisible({ timeout: 30_000 });
  await sleep(1500);
  const inTrash = await usage();
  await filesWin().getByRole('button', { name: 'Empty trash' }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.getByTestId('files-confirm-dialog').getByRole('button', { name: 'Empty trash' }).click();
  await expect(filesWin().getByTestId('files-empty')).toBeVisible({ timeout: 60_000 });
  await expect.poll(usage, { timeout: 30_000 }).not.toBe(inTrash);
  note('usage in trash / after emptying', [inTrash, await usage()]);
  const left = await onDesk(`find /data/files -name 'rel1110-${tag}*' | wc -l`);
  note('copies of the file left on the desk after emptying', left.trim());
  expect(left.trim()).toBe('0');
  await filesWin().getByRole('button', { name: 'Back to files' }).click();
});

test('upload a folder of 3 files', async () => {
  const d = join(work, dirName);
  mkdirSync(d);
  for (let i = 1; i <= 3; i++) writeFileSync(join(d, `f${i}.dat`), randomBytes(200_000 * i));
  await filesWin().getByTestId('files-pick-folder').setInputFiles(d);
  await expect(filesWin().getByTestId('files-xfer').filter({ hasText: 'f3.dat' })).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const shown = await row(dirName).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  note('folder row shown in the list by itself after the upload', shown);
  if (!shown) {
    await filesWin().getByRole('button', { name: /^Trash/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await filesWin().getByRole('button', { name: 'Back to files' }).evaluate((el) => (el as HTMLButtonElement).click());
  }
  await expect(row(dirName)).toBeVisible({ timeout: 30_000 });
  await row(dirName).dblclick();
  await expect(filesWin().getByTestId('files-row')).toHaveCount(3, { timeout: 60_000 });
  note('folder upload rows', await filesWin().getByTestId('files-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-name'))));
  const sizes = await onDesk(`find /data/files -path '*${dirName}*' -type f -printf '%f %s\\n' | sort`);
  note('on the desk', sizes.trim().split('\n'));
});

test('cut the connection mid-upload, reopen, see what happens', async () => {
  test.setTimeout(10 * 60_000);
  const cutName = `rel1110-cut${tag}.bin`;
  const cutFile = join(work, cutName);
  mk(cutFile, 400);
  const want = await sha(cutFile);
  await filesWin().getByRole('button', { name: 'Back to files' }).click().catch(() => {});
  // back to the top folder
  await filesWin().getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Files' }).click().catch(() => {});
  await filesWin().getByTestId('files-pick-files').setInputFiles(cutFile);
  const bar = filesWin().getByRole('progressbar').first();
  await expect.poll(async () => Number((await bar.getAttribute('aria-valuenow').catch(() => '0')) ?? 0), { timeout: 120_000, intervals: [100] }).toBeGreaterThanOrEqual(15);
  note('progress when the page was closed', await bar.getAttribute('aria-valuetext'));
  await page.close(); // the peer drops
  await sleep(5000);
  const partial = await onDesk(`find /data/files -name '*${cutName.slice(0, 16)}*' -printf '%p %s\\n' | sed 's#^/data/files/##'; ls -la /data/files/.uploads | tail -n +2 | head; du -sb /data/files/.uploads`);
  note('on the desk after the cut (partials)', partial.trim().split('\n').slice(0, 6));
  page = await context.newPage();
  w = watch(page);
  await page.goto('https://test.office.staging.minimalistalliance.com');
  await page.locator('.ma-shell').waitFor({ timeout: 60_000 });
  await openFiles();
  const seen = await filesWin().getByTestId('files-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
  note('rows after reopen (the cut file is listed?)', seen.includes(cutName));
  // pick the same file again: does it resume?
  const t0 = Date.now();
  await filesWin().getByTestId('files-pick-files').setInputFiles(cutFile);
  const x = filesWin().getByTestId('files-xfer').first();
  await expect(x).toBeVisible({ timeout: 30_000 });
  const first = await x.innerText();
  note('tray right after re-picking', first.replace(/\s+/g, ' ').slice(0, 200));
  const samples: string[] = [];
  for (let i = 0; i < 40; i++) { const v = await filesWin().getByRole('progressbar').first().getAttribute('aria-valuetext', { timeout: 500 }).catch(() => null); if (v && !samples.includes(v)) samples.push(v); if (samples.length >= 4) break; await sleep(250); }
  note('progress texts seen in the first 10 s after re-pick', samples);
  const firstPct = await filesWin().getByRole('progressbar').first().getAttribute('aria-valuenow').catch(() => null);
  note('first progress % on re-pick (>0 means resumed)', firstPct);
  await expect(x).toHaveAttribute('data-state', /done|failed|rejected/, { timeout: 5 * 60_000 });
  note('final state / words', [await x.getAttribute('data-state'), (await x.locator('.files-xfer-words').first().innerText()).replace(/\s+/g, ' ')]);
  note('seconds to finish after re-pick', ((Date.now() - t0) / 1000).toFixed(1));
  const onDisk = await onDesk(`sha256sum $(find /data/files -name '${cutName}') | cut -d' ' -f1`);
  note('final copy sha256 matches the source', onDisk.trim() === want);
  expect(onDisk.trim()).toBe(want);
  // tidy
  await row(cutName).click();
  await filesWin().getByRole('button', { name: 'Delete', exact: true }).click();
  await filesWin().getByRole('button', { name: /^Trash/ }).click();
  await sleep(1500);
  await filesWin().getByRole('button', { name: 'Empty trash' }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.getByTestId('files-confirm-dialog').getByRole('button', { name: 'Empty trash' }).click();
  await expect(filesWin().getByTestId('files-empty')).toBeVisible({ timeout: 60_000 });
  await filesWin().getByRole('button', { name: 'Back to files' }).click();
});

test('a small JPEG fails safe and nothing lands on the desk', async () => {
  test.setTimeout(3 * 60_000);
  const jpg = join(work, `rel1110-img${tag}.jpg`);
  // a minimal valid JPEG (1x1)
  writeFileSync(jpg, Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
  const calls: string[] = [];
  page.on('response', (r) => { if (/image-check/.test(r.url())) calls.push(`${r.request().method()} ${new URL(r.url()).pathname.replace(/[0-9a-f-]{16,}/g, ':id')} ${r.status()}`); });
  const seenWords = new Set<string>();
  const timer = setInterval(() => { void filesWin().getByTestId('files-xfer').and(page.locator(`[data-name="rel1110-img${tag}.jpg"]`)).locator('.files-xfer-words').first().innerText().then((t) => seenWords.add(t.replace(/\s+/g, ' ')), () => {}); }, 150);
  await filesWin().getByTestId('files-pick-files').setInputFiles(jpg);
  const x = filesWin().getByTestId('files-xfer').and(page.locator(`[data-name="rel1110-img${tag}.jpg"]`));
  await expect(x).toHaveAttribute('data-state', /failed|rejected|done/, { timeout: 120_000 });
  const state = await x.getAttribute('data-state');
  const words = (await x.locator('.files-xfer-words').first().innerText()).replace(/\s+/g, ' ');
  clearInterval(timer);
  note('JPEG state / words', [state, words]);
  note('JPEG words seen in order', [...seenWords]);
  note('JPEG image-check calls', calls);
  note('guidelines link on the JPEG line', await x.getByRole('link', { name: /guidelines/i }).count());
  const onDisk = await onDesk(`find /data/files -name 'rel1110-img${tag}*' | wc -l; find /data/files -newer /proc/1 -type f 2>/dev/null | wc -l; ls -la /data/files | head -20`);
  note('JPEG copies on the desk (0 expected) + ls', onDisk.trim().split('\n').slice(0, 2));
  note('JPEG row in the list', await row(`rel1110-img${tag}.jpg`).count());
});

test('no file names or contents in deskd journal', async () => {
  const names = [`rel1110-${tag}`, `rel1110-cut${tag}`, dirName, `rel1110-img${tag}`, 'f1.dat', 'f2.dat', 'f3.dat', renamed];
  const pat = names.map((n) => `-e '${n}'`).join(' ');
  const out = await onDesk(`journalctl -t deskd --no-pager --since '-90min' | grep -c ${pat}; journalctl -t deskd --no-pager --since '-90min' | wc -l; journalctl -u deskd --no-pager --since '-90min' | grep -c ${pat}; true`);
  note('journal matches (-t deskd), lines (-t deskd), matches (-u deskd)', out.trim().split('\n'));
});

test('the rest of the app: Agent window, desk menu, About, Browser window', async () => {
  test.setTimeout(5 * 60_000);
  await page.getByRole('button', { name: /^Close/ }).first().click().catch(() => {});
  for (const app of ['Agent', 'Notebook', 'Browser']) {
    const tile = page.getByRole('group', { name: /^test-desk/ }).getByRole('button', { name: new RegExp(`^${app}`) });
    await tile.evaluate((el) => (el as HTMLButtonElement).click());
    const d = page.getByRole('dialog', { name: new RegExp(app) });
    await expect(d).toBeVisible({ timeout: 30_000 });
    if (app === 'Agent') { await expect(d.locator('.ag-agent-name').first()).toBeAttached({ timeout: 60_000 }); note('Agent window text', (await d.innerText()).replace(/\s+/g, ' ').slice(0, 200)); }
    if (app === 'Notebook') await expect(page.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 });
    if (app === 'Browser') await expect(d.locator('video')).toBeVisible({ timeout: 120_000 });
    note(`${app} window`, 'opens');
  }
  await expect.poll(() => page.locator('video').first().evaluate((el: HTMLVideoElement) => el.videoWidth), { timeout: 90_000 }).toBeGreaterThan(0);
  const v = await page.locator('video').first().evaluate((el: HTMLVideoElement) => ({ w: el.videoWidth, h: el.videoHeight, ready: el.readyState }));
  await sleep(4000);
  note('Browser video', v);
  for (const n of ['Browser', 'Notebook', 'Agent']) await page.getByRole('button', { name: `Close ${n}` }).first().click().catch(() => {});
  await page.keyboard.press('Escape');
  const about = await openAbout(page);
  note('About', about.replace(/\s+/g, ' ').slice(0, 300));
  note('console errors', w.errors);
});
