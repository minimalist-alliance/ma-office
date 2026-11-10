// The Files window on the mock desk (`desk/mockDeskFiles.ts`): browsing, the keyboard, upload by picker, folder and drop, the
// image check in line, rejection, download and folder ZIP, rename, move, trash and restore, search, and the states of a desk
// asleep, in all three themes with axe. `files.rtc.spec.ts` runs the shipping bundle over real data channels.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const PERSONAL = 'd-personal00001';

interface FilesDesk {
  control: { calls: { m: string; p: Record<string, unknown> }[]; landed: { path: string; size: number; sha256: string }[]; otherBytes: number; totalBytes: number; ackDelayMs: number };
  read(path: string): Uint8Array | null;
  exists(path: string): 'file' | 'dir' | null;
  allFiles(): string[];
  trashedNames(): string[];
  put(path: string, bytes: Uint8Array): void;
}
interface Mock {
  dropLink(deskId?: string): void;
  restoreLink(deskId?: string): void;
  files: Promise<{ desk(deskId: string): FilesDesk }>;
}
declare const __maDeskMock: Mock;
declare const __maImageStub: { stepMs: number; startPlace: number; rejectNext: string | null; failNext: { retryable: boolean } | null; checked: { bytes: number }[]; settled: string[] };

const win = (page: Page): Locator => page.getByRole('dialog', { name: /^Files/ });
const list = (page: Page): Locator => page.getByRole('listbox', { name: /^Files in|^Trash|^Results/ });
const row = (page: Page, name: string): Locator => page.locator(`[data-testid="files-row"][data-name="${name}"]`);
const xfer = (page: Page, name: string): Locator => page.locator(`[data-testid="files-xfer"][data-name="${name}"]`);
const live = (page: Page): Locator => page.getByTestId('live-region');

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked)'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function arrive(page: Page, theme: ThemeId, request: APIRequestContext): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { files: { enabled: true } }); // the harness has Files off, so other specs count the tiles they always did
  await setTheme(page, theme);
  // The save picker is the browser's own dialog; the tests take the plain download path unless one says otherwise.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  return errors;
}

/** A picture for a person to look at: passing tests have missed a broken layout. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(450); // the window has finished opening
  await win(page).screenshot({ path: `test-results/shots/files-${name}.png` });
}

async function openFiles(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Files/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(list(page)).toBeVisible();
}

// Questions put to the mock desk inside the page (a FilesDesk can't cross the boundary, and the page's CSP allows no eval).
type Op = 'len' | 'text' | 'head' | 'exists' | 'files' | 'trashed' | 'putText';
const ask = (page: Page, op: Op, a = '', b = ''): Promise<unknown> =>
  page.evaluate(
    async ([o, x, y]) => {
      const deskId = document.querySelector('[data-testid="window-files"]')?.getAttribute('data-desk') ?? '';
      const d = (await __maDeskMock.files).desk(deskId);
      const bytes = d.read(x);
      switch (o) {
        case 'len':
          return bytes?.length;
        case 'text':
          return new TextDecoder().decode(bytes ?? new Uint8Array());
        case 'head':
          return Array.from(bytes ?? []).slice(0, 4);
        case 'exists':
          return d.exists(x);
        case 'files':
          return d.allFiles().filter((p) => p.startsWith(x));
        case 'trashed':
          return d.trashedNames();
        case 'putText':
          return d.put(x, new TextEncoder().encode(y));
      }
    },
    [op, a, b] as const,
  );

async function fastStub(page: Page, ms = 40): Promise<void> {
  await page.waitForFunction(() => '__maImageStub' in window); // made when the window's chunk has loaded
  await page.evaluate((m) => {
    __maImageStub.stepMs = m;
  }, ms);
}

for (const theme of THEMES) {
  test.describe(theme, () => {
    test('browse folders and breadcrumbs, with axe, and the dialogs and the trash', async ({ page, request }) => {
      const errors = await arrive(page, theme, request);
      await openFiles(page);
      for (const name of ['Backups', 'Documents', 'Empty folder', 'Photos', 'readme.txt']) await expect(row(page, name)).toBeVisible();
      await expect(page.getByTestId('files-usage-words')).toContainText('used');
      await expect(page.getByTestId('files-usage-words')).not.toContainText('free');
      await expect(page.getByTestId('files-usage')).toHaveAttribute('title', /All other apps .*free/);
      // At rest the bar is only what can be done with nothing selected.
      for (const name of ['Download', 'Rename', 'Move to…', 'Delete']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      await row(page, 'readme.txt').click();
      for (const name of ['Download', 'Rename', 'Move to…', 'Delete']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-list`);

      await row(page, 'Documents').dblclick();
      await expect(page.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current="location"]')).toHaveText('Documents');
      await expect(row(page, 'report.pdf')).toBeVisible();
      await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Files' }).click();
      await expect(row(page, 'Photos')).toBeVisible();

      await page.getByRole('button', { name: 'New folder' }).click();
      await expect(page.getByRole('dialog', { name: 'New folder' })).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-new-folder`);
      await page.keyboard.type('Receipts');
      await page.keyboard.press('Enter');
      await expect(row(page, 'Receipts')).toBeVisible();

      await row(page, 'readme.txt').click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row(page, 'readme.txt')).toHaveCount(0);
      await page.getByRole('button', { name: /^Trash/ }).click();
      await expect(row(page, 'readme.txt')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-trash`);
      await row(page, 'readme.txt').click();
      await page.getByRole('button', { name: 'Restore' }).click();
      await expect(row(page, 'readme.txt')).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to files' }).click();
      await expect(row(page, 'readme.txt')).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('keyboard only: arrows, Enter, Backspace, type-ahead, F2, Delete and restore', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await list(page).focus();
      await page.keyboard.press('ArrowDown'); // Backups
      await page.keyboard.press('ArrowDown'); // Documents
      await expect(row(page, 'Documents')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(row(page, 'report.pdf')).toBeVisible();
      await page.keyboard.type('re');
      await expect(row(page, 'report.pdf')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('F2');
      const dialog = page.getByRole('dialog', { name: 'Rename' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox')).toBeFocused();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('summary.pdf');
      await page.keyboard.press('Enter');
      await expect(row(page, 'summary.pdf')).toBeVisible();
      await expect(list(page)).toBeFocused(); // focus came back
      // The renamed item stays selected under its new name, with the keyboard on it and the toolbar's set kept.
      await expect(row(page, 'summary.pdf')).toHaveAttribute('aria-selected', 'true');
      await expect(list(page)).toHaveAttribute('aria-activedescendant', (await row(page, 'summary.pdf').getAttribute('id')) ?? '');
      await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
      await page.keyboard.press('Delete');
      await expect(row(page, 'summary.pdf')).toHaveCount(0);
      await expect(live(page)).toContainText('moved to the trash');
      await page.keyboard.press('Backspace');
      await expect(row(page, 'Photos')).toBeVisible();
      // Escape with no dialog and nothing selected is the desk's own: it closes the window, as in every app.
      await page.keyboard.press('Escape');
      await expect(win(page)).toHaveCount(0);
    });

    test('a name the grammar refuses is said in plain words, and a taken name too', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      await page.getByRole('button', { name: 'Rename' }).click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('a\\b');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: "Names can't contain" })).toBeVisible();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Photos');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: 'already there' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Rename' })).toHaveCount(0);
      await expect(row(page, 'readme.txt')).toBeVisible();
    });

    test('upload by the picker lands whole, with a progress line, and the folder is refreshed', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      const bytes = Buffer.alloc(1_500_000, 7);
      await page.getByTestId('files-pick-files').setInputFiles([{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: bytes }, { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
      await expect(xfer(page, 'big.bin')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
      await expect(xfer(page, 'a.txt')).toHaveAttribute('data-state', 'done');
      await expect(row(page, 'big.bin')).toBeVisible();
      expect(await ask(page, 'len', 'big.bin')).toBe(1_500_000);
      expect(await ask(page, 'len', 'a.txt')).toBe(5);
      await expect(live(page)).toContainText('uploaded');
      expect(await axe(page)).toEqual([]);
    });

    test('a folder by the picker keeps its shape', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      const dir = mkdtempSync(join(tmpdir(), 'ma-files-'));
      mkdirSync(join(dir, 'Trip', 'Day 1'), { recursive: true });
      writeFileSync(join(dir, 'Trip', 'Day 1', 'a.txt'), 'alpha');
      writeFileSync(join(dir, 'Trip', 'b.txt'), 'beta');
      await page.getByTestId('files-pick-folder').setInputFiles(join(dir, 'Trip'));
      await expect(xfer(page, 'a.txt')).toHaveAttribute('data-state', 'done');
      await expect(xfer(page, 'b.txt')).toHaveAttribute('data-state', 'done');
      expect(await ask(page, 'files', 'Trip/')).toEqual(['Trip/Day 1/a.txt', 'Trip/b.txt']);
      // The desk names only the folders the files landed in, not the one the upload made on the way: the row shows at once.
      await expect(row(page, 'Trip')).toBeVisible({ timeout: 3_000 });
    });

    test('files dropped from the computer upload, folders included', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      const target = page.getByTestId('files-body');
      const dt = await page.evaluateHandle(() => {
        const d = new DataTransfer();
        d.items.add(new File(['dropped words'], 'dropped.txt', { type: 'text/plain' }));
        return d;
      });
      await target.dispatchEvent('dragenter', { dataTransfer: dt });
      await expect(page.locator('.files-dropzone')).toBeVisible();
      await target.dispatchEvent('drop', { dataTransfer: dt });
      await expect(xfer(page, 'dropped.txt')).toHaveAttribute('data-state', 'done');
      expect(await ask(page, 'text', 'dropped.txt')).toBe('dropped words');
      await expect(page.locator('.files-dropzone')).toHaveCount(0);
    });

    test('an image waits in line in plain words, goes up as its original bytes, and is never "busy"', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await fastStub(page, 700);
      // Every line the tray ever shows for a file, because a poll can miss a short one.
      await page.evaluate(() => {
        const seen = new Set<string>();
        (window as unknown as { __seenWords: Set<string> }).__seenWords = seen;
        new MutationObserver(() => document.querySelectorAll('[data-testid="files-xfer"][data-name="sunset.txt"] .files-xfer-words').forEach((n) => seen.add(n.textContent ?? ''))).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40_000, 3)]);
      // Named .txt on purpose: whether it is an image is the bytes' say, never the name's.
      await page.getByTestId('files-pick-files').setInputFiles([{ name: 'sunset.txt', mimeType: 'text/plain', buffer: jpeg }, { name: 'bundle.zip', mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]) }]);
      await expect(xfer(page, 'sunset.txt')).toContainText('2nd in line', { timeout: 10_000 });
      await shot(page, `${theme}-image-in-line`);
      await expect(xfer(page, 'sunset.txt')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
      const seen = await page.evaluate(() => [...(window as unknown as { __seenWords: Set<string> }).__seenWords]);
      expect(seen).toEqual(expect.arrayContaining(['Checking your image: 3rd in line.', 'Checking your image: 2nd in line.', 'Checking your image: 1st in line.']));
      await expect(xfer(page, 'bundle.zip')).toHaveAttribute('data-state', 'done');
      expect(await page.getByTestId('files-tray').innerText()).not.toMatch(/busy/i);
      expect(await page.evaluate(() => __maImageStub.checked.length)).toBe(1); // the zip was never checked
      expect(await ask(page, 'head', 'sunset.txt')).toEqual([0xff, 0xd8, 0xff, 0xe0]);
      expect(await ask(page, 'len', 'sunset.txt')).toBe(jpeg.length); // the original, byte for byte
    });

    test('a rejection shows the guideline in plain words with its code, and nothing lands', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await fastStub(page);
      await page.evaluate(() => {
        __maImageStub.rejectNext = 'G2';
      });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 1)]);
      await page.getByTestId('files-pick-files').setInputFiles([{ name: 'bad.png', mimeType: 'image/png', buffer: png }]);
      await expect(xfer(page, 'bad.png')).toHaveAttribute('data-state', 'rejected', { timeout: 10_000 });
      await expect(xfer(page, 'bad.png')).toContainText('guideline G2');
      await expect(xfer(page, 'bad.png')).toContainText("This image wasn't added. It goes against guideline G2: no hate or harassment.");
      await expect(xfer(page, 'bad.png').getByRole('link')).toHaveCount(0);
      await shot(page, `${theme}-rejected`);
      expect(await ask(page, 'exists', 'bad.png')).toBeNull();
      expect(await axe(page)).toEqual([]);
    });

    test('download a file, and a folder as a ZIP', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      const file = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download' }).click();
      const dl = await file;
      expect(dl.suggestedFilename()).toBe('readme.txt');
      const path = await dl.path();
      expect(readFileSync(path, 'utf8')).toContain('only on your desk');

      await row(page, 'Photos').click();
      const zip = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download' }).click();
      const z = await zip;
      expect(z.suggestedFilename()).toBe('Photos.zip');
      const bytes = readFileSync((await z.path()) as string);
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(bytes.toString('latin1')).toContain('Photos/Summer/pier.png');
    });

    test('move by the dialog, and replace asks first', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      await page.getByRole('button', { name: 'Move to…' }).click();
      const dialog = page.getByRole('dialog', { name: /Move "readme.txt" to/ });
      await expect(dialog).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await dialog.getByRole('button', { name: 'Documents' }).click();
      await dialog.getByRole('button', { name: 'Move here' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row(page, 'readme.txt')).toHaveCount(0);
      expect(await ask(page, 'exists', 'Documents/readme.txt')).toBe('file');
      // A same-named file already there: asked, and the old one goes to the trash.
      await ask(page, 'putText', 'readme.txt', 'newer');
      await page.evaluate(() => void 0);
      await page.getByRole('button', { name: /^Trash/ }).click();
      await page.getByRole('button', { name: 'Back to files' }).click();
      await row(page, 'readme.txt').click();
      await page.getByRole('button', { name: 'Move to…' }).click();
      await page.getByRole('dialog', { name: /Move/ }).getByRole('button', { name: 'Documents' }).click();
      await page.getByRole('dialog', { name: /Move/ }).getByRole('button', { name: 'Move here' }).click();
      const confirm = page.getByRole('dialog', { name: 'Replace the file there?' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Replace' }).click();
      await expect(confirm).toHaveCount(0);
      expect(await ask(page, 'text', 'Documents/readme.txt')).toBe('newer');
      expect(await ask(page, 'trashed')).toContain('readme.txt');
    });

    test('emptying the trash asks, and says what it frees', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      await page.keyboard.press('Delete');
      await page.getByRole('button', { name: /^Trash/ }).click();
      await page.getByRole('button', { name: 'Empty trash' }).click();
      const dialog = page.getByRole('dialog', { name: 'Empty the trash?' });
      await expect(dialog).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await dialog.getByRole('button', { name: 'Empty trash' }).click();
      await expect(page.getByTestId('files-empty')).toContainText('The trash is empty.');
      expect(await ask(page, 'trashed')).toEqual([]);
    });

    test('search by name finds across folders', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await page.getByTestId('files-search').fill('pier');
      await expect(row(page, 'pier.png')).toBeVisible();
      await expect(live(page)).toContainText('Search for pier');
      await page.getByTestId('files-search').press('Escape');
      await expect(row(page, 'Photos')).toBeVisible();
    });

    test('closing the window does not stop a transfer: the desk keeps it, and the window shows it again', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await page.evaluate(async () => {
        const deskId = document.querySelector('[data-testid="window-files"]')?.getAttribute('data-desk') ?? '';
        (await __maDeskMock.files).desk(deskId).control.ackDelayMs = 120;
      });
      await page.getByTestId('files-pick-files').setInputFiles([{ name: 'keeps-going.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3_000_000, 4) }]);
      await expect(xfer(page, 'keeps-going.bin')).toHaveAttribute('data-state', /sending|finishing/);
      await page.getByRole('button', { name: 'Close Files' }).click();
      await expect(win(page)).toHaveCount(0);
      await page.waitForTimeout(300);
      await openFiles(page);
      await expect(xfer(page, 'keeps-going.bin')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
      expect(await ask(page, 'len', 'keeps-going.bin')).toBe(3_000_000);
    });

    test('a lost session pauses a transfer as "Waiting for your desk" and it finishes when the desk is back', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      const bytes = Buffer.alloc(4_000_000, 9);
      await page.getByTestId('files-pick-files').setInputFiles([{ name: 'long.bin', mimeType: 'application/octet-stream', buffer: bytes }]);
      await expect(xfer(page, 'long.bin')).toHaveAttribute('data-state', /sending|finishing|done/);
      await page.evaluate(() => __maDeskMock.dropLink());
      await page.waitForTimeout(150);
      await page.evaluate(() => __maDeskMock.restoreLink());
      await expect(xfer(page, 'long.bin')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
      expect(await ask(page, 'len', 'long.bin')).toBe(4_000_000);
    });
  });
}

test.describe('a desk that is asleep', () => {
  const stopped = { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'stopped' }] };

  for (const theme of THEMES) {
    test(`${theme}: "Wake your desk", with axe`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await harness(request, { ...stopped, files: { enabled: true }, refuseWake: { status: 409, code: 'downtime_active' } });
      await signIn(page, '/?link=real');
      await canvasPainted(page);
      await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
      await page.waitForTimeout(300);
      await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Files/ }).evaluate((el) => (el as HTMLButtonElement).click());
      await expect(page.getByTestId('files-panel')).toHaveAttribute('data-panel', 'asleep');
      await expect(page.getByRole('button', { name: 'Wake your desk' })).toBeVisible();
      await page.waitForTimeout(500); // the window finishes opening: axe measures its buttons' size
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-asleep`);
      expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
    });
  }
});
