// Files in the shipping bundle: the real link and the real CSP, through gateway-shim and desk-rtc to fake-deskd, over real data
// channels. fake-deskd answers `not_found` to `files.*`; `filesDesk.ts` stands in for the desk's answers, and for the bytes on
// `bulk`, and nothing else: see there for where that line is. What the page sends on `bulk` goes on to desk-rtc too.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { filesDeskIn } from './filesDesk';
import { harness, signIn, watchConsole } from './helpers';
import { buildTools, Stack } from './rtcStack';

const EVIDENCE = resolve('test-results/rtc-files');
const ONLINE = /^Personal desk, 5 apps, online · dev · up /;
const MiB = 1024 * 1024;
const stack = new Stack(EVIDENCE);

const proxy = (page: Page): Locator => page.getByRole('button', { name: /^Personal desk, 5 apps, / });
const win = (page: Page): Locator => page.getByRole('dialog', { name: /^Files/ });
const row = (page: Page, name: string): Locator => page.locator(`[data-testid="files-row"][data-name="${name}"]`);
const xfer = (page: Page, name: string): Locator => page.locator(`[data-testid="files-xfer"][data-name="${name}"]`);

async function online(page: Page): Promise<void> {
  // The save picker is the browser's own dialog: a download takes the plain path here.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
}

async function openFiles(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Files/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(page.getByRole('listbox', { name: /^Files in/ })).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async () => {
  test.setTimeout(600_000);
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  buildTools();
  await stack.start();
});

test.afterAll(async () => {
  await stack.stop();
});

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, { shim: stack.api, files: { enabled: true } }); // the harness has Files off, so other specs count the tiles they always did
});

test('a desk without Files answers not_found: the calm line, and nothing to upload into', async ({ page }) => {
  const errors = watchConsole(page);
  await online(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Files/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(page.getByText("This desk can't do Files yet")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Upload files' })).toHaveCount(0); // nothing to press
  expect(errors).toEqual([]);
});

test('browse, upload 5 MiB over bulk, download the file and a folder as a ZIP, under the real CSP', async ({ page }) => {
  const errors = watchConsole(page);
  const { desk, sent, csp } = await filesDeskIn(page);
  await online(page);
  await openFiles(page);
  for (const name of ['Backups', 'Documents', 'Photos', 'readme.txt']) await expect(row(page, name)).toBeVisible();

  // Upload: CHUNK frames out over the real bulk channel, the desk's CREDIT in, whole at the end.
  const bytes = Buffer.alloc(5 * MiB + 123);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  await page.getByTestId('files-pick-files').setInputFiles([{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: bytes }]);
  await expect(xfer(page, 'big.bin')).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  expect(Buffer.from(desk.read('big.bin') ?? new Uint8Array()).equals(bytes)).toBe(true);
  const frames = (await sent()).bulk;
  expect(frames).toBeGreaterThan(Math.floor(bytes.length / 16372));
  await expect(row(page, 'big.bin')).toBeVisible();

  // Download a file and a folder: the desk's bytes on bulk, the ZIP made here.
  await row(page, 'readme.txt').click();
  const file = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect(readFileSync((await (await file).path()) as string, 'utf8')).toContain('only on your desk');
  await row(page, 'Documents').click();
  const zip = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const z = readFileSync((await (await zip).path()) as string);
  expect(z.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(z.toString('latin1')).toContain('Documents/Notes/ideas.txt');

  // Rename, then trash and restore.
  await row(page, 'readme.txt').click();
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('hello.txt');
  await page.keyboard.press('Enter');
  await expect(row(page, 'hello.txt')).toBeVisible();
  await expect(page.getByRole('listbox', { name: /^Files in/ })).toBeFocused(); // the button it came from is off now: back to the list
  await row(page, 'hello.txt').click();
  await page.keyboard.press('Delete');
  await expect(row(page, 'hello.txt')).toHaveCount(0);
  await page.getByRole('button', { name: /^Trash/ }).click();
  await row(page, 'hello.txt').click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('button', { name: 'Back to files' }).click();
  await expect(row(page, 'hello.txt')).toBeVisible();

  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('an image never lands without a verdict: the platform has no route here, so the member sees one plain line and can try again', async ({ page }) => {
  const errors = watchConsole(page);
  const { desk } = await filesDeskIn(page);
  await online(page);
  await openFiles(page);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 2)]);
  await page.getByTestId('files-pick-files').setInputFiles([{ name: 'shot.png', mimeType: 'image/png', buffer: png }]);
  await expect(xfer(page, 'shot.png')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(xfer(page, 'shot.png')).toContainText("We couldn't check your image");
  await expect(xfer(page, 'shot.png').getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(desk.exists('shot.png')).toBeNull();
  expect(desk.control.calls.some((c) => c.m === 'files.upload.begin')).toBe(false);
  // A zip, by its bytes, is never checked and goes straight up.
  await page.getByTestId('files-pick-files').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(100, 1)]) }]);
  await expect(xfer(page, 'notes.txt')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  expect(errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
});
