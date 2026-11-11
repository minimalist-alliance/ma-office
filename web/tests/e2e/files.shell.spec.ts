// The Files window on the mock desk (`desk/mockDeskFiles.ts`): browsing, the keyboard, upload by picker, folder and drop, the
// image check in line, rejection, download and folder ZIP, rename, move, trash and restore, search, and the states of a desk
// asleep, in all three themes with axe. `files.rtc.spec.ts` runs the shipping bundle over real data channels.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { APP_INKS } from '../../src/theme/tokens';
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
/** Whether leaving the office now would ask first (`shell/closeGuard.ts`), from the guard's own answer, without leaving. */
const wouldAsk = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

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

// A free member's drive (S-119, ADR 0090): the footer reads against the desk's cap, in the office's own words.
const FREE_ME = { status: 'active', tier: 'free', ageBand: 'adult', adultFrom: null, parent: null };
const GIB = 1024 ** 3;
const setCap = (page: Page, cap: number | null, extra = 0): Promise<void> =>
  page.evaluate(
    async ([c, x]) => {
      const deskId = document.querySelector('[data-testid="window-files"]')?.getAttribute('data-desk') ?? '';
      const d = (await __maDeskMock.files).desk(deskId);
      Object.assign(d.control, { capBytes: c, capExtraBytes: x });
      (d as unknown as { usageChanged(): void }).usageChanged();
    },
    [cap, extra] as const,
  );

for (const theme of THEMES) {
  test(`the drive line of a free desk, ${theme}`, async ({ page, request }) => {
    await harness(request, { membership: FREE_ME, configExtra: { tierAllowances: { alliance: { driveGb: 25 } }, links: {} } });
    const errors = await arrive(page, theme, request);
    await openFiles(page);
    await setCap(page, 2 * GIB, 1.4 * GIB);
    const words = page.getByTestId('files-usage-words');
    await expect(words).toHaveText('1.4 GB of 2 GB used');
    await expect(page.getByTestId('files-usage')).toHaveAttribute('data-cap', 'ok');
    await expect(page.getByTestId('files-cap-note')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-free-drive`);

    // Near the cap: the calm second line and the link.
    await setCap(page, 2 * GIB, 1.85 * GIB);
    await expect(page.getByTestId('files-usage')).toHaveAttribute('data-cap', 'near');
    await expect(page.getByTestId('files-cap-note')).toContainText('has a 25 GB drive.');
    const link = page.getByRole('link', { name: 'See membership (opens in a new tab)' });
    await expect(link).toHaveAttribute('href', /^https:\/\/platform\.localhost\//);
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-free-drive-near`);

    // Full: the Designer's sentence. Nothing is hidden or deleted.
    await setCap(page, 2 * GIB, 2.1 * GIB);
    await expect(page.getByTestId('files-usage')).toHaveAttribute('data-cap', 'full');
    await expect(page.getByTestId('files-cap-note')).toContainText('Your drive is full. Delete something to make room, or get 25 GB with');
    await expect(row(page, 'readme.txt')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-free-drive-full`);
    expect(errors).toEqual([]);
  });
}

// A step down to a smaller drive (billing spec 4.4): more is kept than the plan's drive holds. Paid, so not the free tier's words.
for (const theme of THEMES) {
  test(`the over-drive line of a stepped-down desk, ${theme}`, async ({ page, request }) => {
    await harness(request, { membership: { status: 'active', tier: 'alliance', ageBand: 'adult', adultFrom: null, parent: null }, configExtra: { links: { billing: 'https://platform.localhost/billing' } } });
    const errors = await arrive(page, theme, request);
    await openFiles(page);
    await setCap(page, 25 * GIB, 31.2 * GIB);
    await expect(page.getByTestId('files-usage')).toHaveAttribute('data-cap', 'over');
    await expect(page.getByTestId('files-cap-note')).toHaveText(/^You have 31\.2 GB in Files, more than 25 GB\. It all stays readable; to add more, make room or move back up\./);
    await expect(page.getByTestId('files-over-link')).toHaveAttribute('href', 'https://platform.localhost/billing');
    await expect(row(page, 'readme.txt')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-over-drive`);
    // Back under the drive: the line goes.
    await setCap(page, 25 * GIB, 10 * GIB);
    await expect(page.getByTestId('files-cap-note')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('a paid desk keeps its own line', async ({ page, request }) => {
  const errors = await arrive(page, 'light', request);
  await openFiles(page);
  await setCap(page, null);
  await expect(page.getByTestId('files-usage')).not.toHaveAttribute('data-cap', /.+/);
  await expect(page.getByTestId('files-usage-words')).toContainText('of 34 GB used');
  await expect(page.getByTestId('files-cap-note')).toHaveCount(0);
  expect(errors).toEqual([]);
});

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
      // One ring at a time: the row's, not the list's.
      expect(await row(page, 'Documents').evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('solid');
      expect(await list(page).evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('none');
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
      await expect.poll(() => wouldAsk(page)).toBe(true); // closing the office would stop it, so the browser asks first
      await page.getByRole('button', { name: 'Close Files' }).click();
      await expect(win(page)).toHaveCount(0);
      await page.waitForTimeout(300);
      await openFiles(page);
      await expect(xfer(page, 'keeps-going.bin')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
      expect(await ask(page, 'len', 'keeps-going.bin')).toBe(3_000_000);
      await expect.poll(() => wouldAsk(page)).toBe(false); // done: nothing to lose

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

    // ---- the context menu: the toolbar's actions again, on a right click, a long press or a key
    const menu = (page: Page): Locator => page.getByRole('menu', { name: /^Actions for|actions$/ });
    const names = (page: Page): Promise<string[]> => menu(page).getByRole('menuitem').allInnerTexts();
    const rightClick = (page: Page, name: string, modifiers: ('Control')[] = []): Promise<void> => row(page, name).click({ button: 'right', modifiers });
    const rowSelected = (page: Page, name: string): Locator => page.locator(`[data-testid="files-row"][data-name="${name}"][aria-selected="true"]`);

    test('its own colors: the Files accent inside the window, the office\'s outside, with a selection, axe and a picture', async ({ page, request }) => {
      const errors = await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      await expect(row(page, 'readme.txt')).toHaveAttribute('aria-selected', 'true');
      const ink = APP_INKS["files"]![theme];
      const props = await page.evaluate(() => {
        const v = (el: Element, p: string) => getComputedStyle(el).getPropertyValue(p).trim();
        const w = document.querySelector('.ma-window[data-app="files"]')!;
        const body = document.querySelector('[data-testid="files-body"]')!;
        const bar = document.querySelector('.top-bar, header, [role="banner"]') ?? document.body;
        const sel = document.querySelector('[data-testid="files-row"][aria-selected="true"]')!;
        return {
          inside: v(body, '--ma-accent'),
          window: v(w, '--ma-surface-window'),
          ring: v(body, '--ma-focus-ring'),
          outside: v(document.documentElement, '--ma-accent'),
          outsideBar: v(bar, '--ma-accent'),
          selBg: getComputedStyle(sel).backgroundColor,
        };
      });
      expect(props.inside.toLowerCase()).toBe(ink.accent.toLowerCase());
      expect(props.ring.toLowerCase()).toBe(ink.accent.toLowerCase());
      expect(props.window.toLowerCase()).toBe(ink.window.toLowerCase());
      expect(props.outside.toLowerCase()).not.toBe(ink.accent.toLowerCase());
      expect(props.outsideBar.toLowerCase()).not.toBe(ink.accent.toLowerCase());
      const n = parseInt(ink.accentSubtle.slice(1), 16);
      expect(props.selBg).toBe(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-selection`);
      expect(errors).toEqual([]);
    });

    test('context menu: a right click on a file, a folder, a selection and empty space', async ({ page, request }) => {
      const errors = await arrive(page, theme, request);
      await openFiles(page);
      // The bar stays as it was: nothing selected, so no Download.
      await rightClick(page, 'readme.txt');
      await expect(menu(page)).toBeVisible();
      await expect(menu(page)).toHaveAttribute('aria-label', 'Actions for readme.txt');
      expect(await names(page)).toEqual(['Download', 'Rename', 'Move to…', 'Delete']);
      await expect(rowSelected(page, 'readme.txt')).toHaveCount(1);
      await expect(menu(page)).toBeFocused();
      // It is inside the window.
      const inside = await page.evaluate(() => {
        const m = document.querySelector('[data-testid="files-menu"]')!.getBoundingClientRect();
        const w = document.querySelector('[data-testid="files-body"]')!.getBoundingClientRect();
        return m.left >= w.left && m.top >= w.top && m.right <= w.right && m.bottom <= w.bottom;
      });
      expect(inside).toBe(true);
      // Delete is last, after a separator, in the danger color; the separator is not an item.
      const order = await menu(page).evaluate((m) => Array.from(m.children).map((c) => c.getAttribute('role') ?? c.tagName));
      expect(order).toEqual(['menuitem', 'menuitem', 'menuitem', 'separator', 'menuitem']);
      await expect(menu(page).getByRole('separator')).toHaveCount(1);
      const dangerRgb = await page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--ma-text-danger)';
        document.querySelector('[data-testid="files-menu"]')!.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(await menu(page).getByRole('menuitem', { name: 'Delete' }).evaluate((e) => getComputedStyle(e).color)).toBe(dangerRgb);
      expect(await menu(page).getByRole('menuitem', { name: 'Rename' }).evaluate((e) => getComputedStyle(e).color)).not.toBe(dangerRgb);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-menu-file`);
      // Keys: arrows wrap, End, Home, type-ahead.
      await page.keyboard.press('ArrowDown');
      await expect(menu(page).getByRole('menuitem', { name: 'Download' })).toBeFocused();
      await page.keyboard.press('End');
      await expect(menu(page).getByRole('menuitem', { name: 'Delete' })).toBeFocused();
      await page.keyboard.press('ArrowUp'); // the separator is skipped: Move to… is above Delete
      await expect(menu(page).getByRole('menuitem', { name: 'Move to…' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu(page).getByRole('menuitem', { name: 'Delete' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu(page).getByRole('menuitem', { name: 'Download' })).toBeFocused();
      await page.keyboard.press('r');
      await expect(menu(page).getByRole('menuitem', { name: 'Rename' })).toBeFocused();
      await page.keyboard.press('Home');
      await expect(menu(page).getByRole('menuitem', { name: 'Download' })).toBeFocused();
      // Esc closes it and the keyboard is back on the list's row.
      await page.keyboard.press('Escape');
      await expect(menu(page)).toHaveCount(0);
      await expect(list(page)).toBeFocused();
      await expect(win(page)).toBeVisible(); // Esc was the menu's, not the window's

      // A folder adds Open; choosing it goes in.
      await rightClick(page, 'Documents');
      expect(await names(page)).toEqual(['Open', 'Download', 'Rename', 'Move to…', 'Delete']);
      await expect(rowSelected(page, 'readme.txt')).toHaveCount(0);
      await menu(page).getByRole('menuitem', { name: 'Open' }).click();
      await expect(menu(page)).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current="location"]')).toHaveText('Documents');
      await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Files' }).click();

      // Choosing Rename does what the bar's does.
      await rightClick(page, 'readme.txt');
      await menu(page).getByRole('menuitem', { name: 'Rename' }).click();
      const dialog = page.getByRole('dialog', { name: 'Rename' });
      await expect(dialog).toBeVisible();
      // The browser's own menu is only suppressed in the list: in the text field it is left alone.
      const prevented = await dialog.getByRole('textbox').evaluate((el) => {
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      expect(prevented).toBe(false);
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      // Empty space: the uploads and New folder, and the selection is as it was.
      const box = (await list(page).boundingBox())!;
      await list(page).click({ button: 'right', position: { x: 40, y: box.height - 12 } });
      await expect(menu(page)).toHaveAttribute('aria-label', 'Folder actions');
      expect(await names(page)).toEqual(['Upload files', 'Upload folder', 'New folder']);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-menu-space`);
      // A click away closes it, and the keyboard is on the list.
      await page.getByRole('navigation', { name: 'Folder path' }).click({ position: { x: 4, y: 4 } });
      await expect(menu(page)).toHaveCount(0);
      await expect(list(page)).toBeFocused();
      await list(page).click({ button: 'right', position: { x: 40, y: box.height - 12 } });
      await menu(page).getByRole('menuitem', { name: 'New folder' }).click();
      await expect(page.getByRole('dialog', { name: 'New folder' })).toBeVisible();
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    });

    test('context menu: a multi-selection keeps its rows, and a row outside it takes over', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      await row(page, 'Photos').click({ modifiers: ['Control'] });
      await rightClick(page, 'Photos');
      await expect(menu(page)).toHaveAttribute('aria-label', 'Actions for 2 items');
      expect(await names(page)).toEqual(['Move to…', 'Delete']);
      await expect(rowSelected(page, 'readme.txt')).toHaveCount(1);
      await expect(rowSelected(page, 'Photos')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await rightClick(page, 'Backups');
      expect(await names(page)).toEqual(['Open', 'Download', 'Rename', 'Move to…', 'Delete']);
      await expect(rowSelected(page, 'readme.txt')).toHaveCount(0);
      await expect(rowSelected(page, 'Backups')).toHaveCount(1);
      await page.keyboard.press('Escape');
      // Delete on two moves both to the trash.
      await row(page, 'readme.txt').click();
      await row(page, 'Photos').click({ modifiers: ['Control'] });
      await rightClick(page, 'readme.txt');
      await menu(page).getByRole('menuitem', { name: 'Delete' }).click();
      await expect(row(page, 'readme.txt')).toHaveCount(0);
      await expect(row(page, 'Photos')).toHaveCount(0);
      expect(await ask(page, 'trashed')).toEqual(expect.arrayContaining(['readme.txt', 'Photos']));
    });

    test('context menu: Shift+F10 and the Menu key open it on the keyboard row, and the list', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await list(page).focus();
      // With no row yet, it is the list's.
      await page.keyboard.press('Shift+F10');
      await expect(menu(page)).toHaveAttribute('aria-label', 'Folder actions');
      await expect(menu(page).getByRole('menuitem', { name: 'Upload files' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(list(page)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ContextMenu');
      await expect(menu(page)).toHaveAttribute('aria-label', 'Actions for Documents');
      await expect(menu(page).getByRole('menuitem', { name: 'Open' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(list(page)).toBeFocused();
      await expect(menu(page)).toHaveCount(0);
      await page.keyboard.press('Shift+F10');
      await expect(menu(page).getByRole('menuitem', { name: 'Open' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current="location"]')).toHaveText('Documents');
    });

    test('context menu: in the trash', async ({ page, request }) => {
      await arrive(page, theme, request);
      await openFiles(page);
      await row(page, 'readme.txt').click();
      await page.keyboard.press('Delete');
      await page.getByRole('button', { name: /^Trash/ }).click();
      await rightClick(page, 'readme.txt');
      expect(await names(page)).toEqual(['Restore', 'Delete forever']);
      await expect(menu(page).getByRole('separator')).toHaveCount(1);
      expect(await menu(page).evaluate((m) => Array.from(m.children).map((c) => c.getAttribute('role')))).toEqual(['menuitem', 'separator', 'menuitem']);
      expect(await menu(page).getByRole('menuitem', { name: 'Delete forever' }).evaluate((e) => getComputedStyle(e).color))
        .not.toBe(await menu(page).getByRole('menuitem', { name: 'Restore' }).evaluate((e) => getComputedStyle(e).color));
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-menu-trash`);
      await page.keyboard.press('Escape');
      const box = (await list(page).boundingBox())!;
      await list(page).click({ button: 'right', position: { x: 40, y: box.height - 12 } });
      await expect(menu(page)).toHaveAttribute('aria-label', 'Trash actions');
      expect(await names(page)).toEqual(['Empty trash']);
      await expect(menu(page).getByRole('separator')).toHaveCount(0);
      await menu(page).getByRole('menuitem', { name: 'Empty trash' }).click();
      await expect(page.getByRole('dialog', { name: 'Empty the trash?' })).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await rightClick(page, 'readme.txt');
      await menu(page).getByRole('menuitem', { name: 'Restore' }).click();
      await expect(row(page, 'readme.txt')).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to files' }).click();
      await expect(row(page, 'readme.txt')).toBeVisible();
    });

    test.describe('on touch', () => {
      test.use({ hasTouch: true });
      test('a long press opens it, and lifting the finger selects nothing else', async ({ page, request }) => {
        await arrive(page, theme, request);
        await openFiles(page);
        const b = (await row(page, 'readme.txt').boundingBox())!;
        const at = { x: Math.round(b.x + 60), y: Math.round(b.y + b.height / 2) };
        const cdp = await page.context().newCDPSession(page);
        // A short tap is a tap: no menu.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(menu(page)).toHaveCount(0);
        await row(page, 'Photos').click();
        await row(page, 'Backups').click({ modifiers: ['Control'] });
        await expect(rowSelected(page, 'Photos')).toHaveCount(1);
        // A long one is a menu, on the row, in the window.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
        await expect(menu(page)).toBeVisible();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(menu(page)).toHaveAttribute('aria-label', 'Actions for readme.txt');
        await expect(rowSelected(page, 'readme.txt')).toHaveCount(1);
        await expect(rowSelected(page, 'Photos')).toHaveCount(0);
        expect(await names(page)).toEqual(['Download', 'Rename', 'Move to…', 'Delete']);
        await page.keyboard.press('Escape');
        await expect(menu(page)).toHaveCount(0);
      });
    });
  });
}

test.describe('a desk that is asleep', () => {
  const stopped = { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'stopped' }] };

  for (const theme of THEMES) {
    test(`${theme}: "Wake this desk", with axe`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await harness(request, { ...stopped, files: { enabled: true }, refuseWake: { status: 409, code: 'downtime_active' } });
      await signIn(page, '/?link=real');
      await canvasPainted(page);
      await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
      await page.waitForTimeout(300);
      await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Files/ }).evaluate((el) => (el as HTMLButtonElement).click());
      await expect(page.getByTestId('files-panel')).toHaveAttribute('data-panel', 'asleep');
      await expect(page.getByRole('button', { name: 'Wake this desk' })).toBeVisible();
      await page.waitForTimeout(500); // the window finishes opening: axe measures its buttons' size
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-asleep`);
      expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
    });
  }
});
