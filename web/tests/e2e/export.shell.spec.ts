// The export page (`/export`, draft ADR "data export and transfer") on the mock link, whose desks answer `data.*` and
// send `bulk` as deskd does, against the harness's client-config, `/v1/me/export`, `connect` and `/v1/moves`. Every
// archive it makes is opened by Python's zipfile and Info-ZIP's unzip.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const DESK = 'd-testk3m7q2x'; // the harness's one desk, Personal
const WORK = 'd-work000000001';
const GUILD = 'd-guild00000001';
const OUT = 'test-results/export';
mkdirSync(OUT, { recursive: true });

interface Harness {
  connects: { deskId: string; start: unknown; purpose?: string }[];
  log: string[];
}
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;

type Mock = { __maDeskMock: { exportWakeMs: number; dropLink(deskId?: string): void; data: { dropAfter: { path: string; bytes: number } | null; drops: number; reads: { path: string; offset: number; scope: string; id: number }[]; credits: { id: number; bytes: number }[]; chunksPerTick: number; tickMs: number; parts: Record<string, Record<string, { type: string; bytes?: Uint8Array }>> } } };

/** Saved as the browser saved it, and opened the way a member's computer would. */
function inspect(path: string): { names: string[]; sha: Record<string, string>; manifest: { files: { path: string; sha256: string }[]; desks: { name: string; complete: boolean }[] }; readme: string } {
  execFileSync('python3', ['-I', '-m', 'zipfile', '-t', path]);
  execFileSync('unzip', ['-tq', path]);
  const script = `
import sys, zipfile, json, hashlib
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({"names": z.namelist(), "sha": {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()},
  "manifest": json.loads(z.read("manifest.json")), "readme": z.read("README.txt").decode()}))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, path], { encoding: 'utf8' }));
}

/** The whole file the stand-in picker handed out, read back from the browser's private storage. */
async function pickedFile(page: Page, name: string): Promise<string> {
  const b64 = await page.evaluate(async (n) => {
    const dir = await navigator.storage.getDirectory();
    const bytes = new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  const path = join(OUT, `${name}`);
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

/** Chromium's own picker can't be driven by a test, so this one hands out a file in the private storage, as a member's choice would. */
async function standInPicker(page: Page, name = 'picked.zip'): Promise<void> {
  await page.addInitScript((n) => {
    (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker = async (o) => {
      (window as unknown as { __picked: unknown }).__picked = o;
      return (await navigator.storage.getDirectory()).getFileHandle(n, { create: true });
    };
  }, name);
}

const sha = (page: Page, part: string, path: string): Promise<string> =>
  page.evaluate(async ([pa, p]) => {
    const f = (window as unknown as Mock).__maDeskMock.data.parts[pa!]![p!]!;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', f.bytes as Uint8Array<ArrayBuffer>));
    return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
  }, [part, path]);

/** How much of the latest read of `path` the page has written: the credit it granted back as it wrote. */
const written = (page: Page, path: string): Promise<number> =>
  page.evaluate((p) => {
    const d = (window as unknown as Mock).__maDeskMock.data;
    const r = d.reads.filter((x) => x.path === p).pop();
    return r ? d.credits.filter((c) => c.id === r.id).reduce((s, c) => s + c.bytes, 0) : 0;
  }, path);

/** The one thing of the journal kept as it is: when the download last moved on. */
const lastProgress = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      new Promise<number>((done) => {
        const r = indexedDB.open('ma-export', 2);
        r.onupgradeneeded = () => r.transaction?.abort();
        r.onerror = () => done(0);
        r.onsuccess = () => {
          const get = r.result.transaction('secret').objectStore('secret').get('current');
          get.onsuccess = () => {
            r.result.close();
            done((get.result as { at: number } | undefined)?.at ?? 0);
          };
        };
      }),
  );

/**
 * Part of the 3 MB photo written and in the journal, then the page goes, as a reload or a closed tab would take it,
 * and comes back offering to carry on. Returns how much of the photo had been written by then, at least.
 */
async function cutOff(page: Page): Promise<number> {
  await expect(page.getByTestId('export-start')).toBeEnabled();
  await page.evaluate(() => {
    // About 650 KB/s, so the photo is still being written at a checkpoint.
    const d = (window as unknown as Mock).__maDeskMock.data;
    d.tickMs = 25;
    d.chunksPerTick = 1;
  });
  await page.getByTestId('export-start').click();
  await expect.poll(() => written(page, 'Photos/harbor.jpg'), { timeout: 30_000 }).toBeGreaterThanOrEqual(768 * 1024);
  const at = await written(page, 'Photos/harbor.jpg');
  const t0 = await page.evaluate(() => {
    (window as unknown as Mock).__maDeskMock.data.tickMs = 400; // slower still, until the page goes
    return Date.now();
  });
  await expect.poll(() => lastProgress(page), { timeout: 30_000 }).toBeGreaterThan(t0); // a checkpoint since
  page.once('dialog', (d) => void d.accept()); // the quiet "leave this page?" while it runs
  await page.reload();
  await expect(page.getByTestId('export-offer')).toContainText('Your last download stopped before it finished.');
  return at;
}

/** Whether anything of a download is left in this browser: the journal's database (with its key), or the working copy. */
const leftBehind = (page: Page): Promise<{ journal: boolean; copy: boolean }> =>
  page.evaluate(async () => ({
    journal: (await indexedDB.databases()).some((d) => d.name === 'ma-export'),
    copy: await (await navigator.storage.getDirectory()).getFileHandle('ma-export-working.zip').then(() => true, () => false),
  }));

/** What a partial download keeps at rest: sealed bytes only, a key that won't leave WebCrypto, and the time. */
const atRest = (page: Page, needles: string[]): Promise<{ found: string[]; copy: number; sealed: number; secret: string[]; extractable: boolean }> =>
  page.evaluate(async (ns) => {
    const has = (hay: Uint8Array, n: string): boolean => {
      const b = new TextEncoder().encode(n);
      outer: for (let i = 0; i + b.length <= hay.length; i += 1) {
        for (let j = 0; j < b.length; j += 1) if (hay[i + j] !== b[j]) continue outer;
        return true;
      }
      return false;
    };
    const copy = new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle('ma-export-working.zip')).getFile()).arrayBuffer());
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open('ma-export', 2);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    const all = (store: string): Promise<unknown[]> =>
      new Promise((ok) => {
        const g = db.transaction(store).objectStore(store).getAll();
        g.onsuccess = () => ok(g.result);
      });
    const [secret] = (await all('secret')) as Record<string, unknown>[];
    const sealed = [...(await all('meta')), ...(await all('entries'))] as Uint8Array[];
    db.close();
    const found = ns.filter((n) => has(copy, n) || sealed.some((b) => has(b, n)));
    return { found, copy: copy.length, sealed: sealed.length, secret: Object.keys(secret ?? {}).sort(), extractable: (secret?.['key'] as CryptoKey).extractable };
  }, needles);

async function arrive(page: Page, path = '/export'): Promise<void> {
  await signIn(page);
  await page.goto(path);
}

async function noPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
}

/** The stored refresh token goes, as `clearRefreshTokenIf` does on `invalid_grant` in a tab nobody is looking at. */
const dropToken = (page: Page): Promise<void> =>
  page.evaluate(() => {
    localStorage.removeItem('ma-desk-web-refresh');
    sessionStorage.removeItem('ma-desk-web-refresh');
  });

const exportConnects = async (request: APIRequestContext): Promise<number> => (await read(request)).connects.filter((c) => c.purpose === 'export').length;

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('with export off', () => {
  test('/export is the office as before, and the account menu has no download', async ({ page, request }) => {
    const errors = watchConsole(page);
    await arrive(page);
    await expect(page.locator('.ma-shell')).toBeVisible();
    await expect(page.getByTestId('export-page')).toHaveCount(0);
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download your data' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download your data' })).toHaveCount(0);
    expect((await read(request)).log).not.toContain('GET /v1/me/export');
    expect(errors).toEqual([]);
  });
});

test.describe('with export on', () => {
  test.beforeEach(async ({ request }) => {
    await harness(request, { export: { enabled: true, moves: false } });
  });

  test('it lives in Account settings\' "Your data", not in the account menu', async ({ page }) => {
    await arrive(page, '/');
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Account', exact: true });
    await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(menu.getByText('Download your data')).toHaveCount(0);
    await menu.getByRole('button', { name: 'Account settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Account settings', exact: true });
    await settings.getByRole('tab', { name: 'Your data' }).click();
    await expect(settings.getByTestId('export-panel')).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Download your data' })).toBeVisible();
    await expect(settings.getByTestId(`choose-${DESK}`)).toContainText('Personal');
    // In the office, not a page of its own: no way back to it, and the tab keeps its title.
    await expect(settings.getByRole('link', { name: 'Your office' })).toHaveCount(0);
    expect(await page.title()).not.toContain('Your data');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('downloads the account and the desk into one archive, straight into the chosen file, every file checked', async ({ page, request }) => {
    const errors = watchConsole(page);
    await standInPicker(page);
    await arrive(page);
    await expect(page.getByRole('heading', { name: 'Your data', level: 1 })).toBeVisible();
    await expect(page.getByTestId(`choose-${DESK}`)).toContainText('Personal');
    await expect(page.getByLabel(/Personal/)).toBeChecked();
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('export-done')).toContainText('Your data is saved as picked.zip'); // what they called it, not what was suggested
    expect(await page.evaluate(() => (window as unknown as { __picked: { suggestedName: string } }).__picked.suggestedName)).toMatch(/^minimalist-alliance-export-\d{4}-\d\d-\d\d\.zip$/);
    await expect(page.getByTestId(`progress-${DESK}`)).toContainText('Done · 10 files');

    const z = inspect(await pickedFile(page, 'picked.zip'));
    expect(z.names.slice(0, 7)).toEqual(['README.txt', 'manifest.json', 'account/account.json', 'account/membership.json', 'account/billing-history.json', 'account/maia-memories.json', 'account/desks.json']);
    for (const n of ['desks/Personal/browser/profile/Default/Cookies', 'desks/Personal/browser-readable/Default/bookmarks.html', 'desks/Personal/browser-readable/Default/history.csv', 'desks/Personal/desk/notebook/Café notes.json', 'desks/Personal/files/Photos/harbor.jpg', 'desks/Personal/files/Empty folder/']) expect(z.names).toContain(n);
    expect(z.sha['desks/Personal/files/Photos/harbor.jpg']).toBe(await sha(page, 'files', 'Photos/harbor.jpg'));
    for (const f of z.manifest.files) expect(z.sha[f.path], f.path).toBe(f.sha256);
    expect(z.manifest.desks).toEqual([expect.objectContaining({ name: 'Personal', complete: true })]);
    expect(z.readme).toContain('If your connection needed our relay');
    expect(z.readme).toContain("agent/keys/ in each desk's folder holds the AI keys you added to that desk, and they work:"); // ADR 0042
    // The office's own session, granting credit as it wrote.
    const mock = await page.evaluate(() => (window as unknown as Mock).__maDeskMock.data);
    expect(new Set(mock.reads.map((r) => r.scope))).toEqual(new Set(['owner']));
    expect(mock.credits.length).toBeGreaterThan(0);
    expect((await read(request)).log).toContain('GET /v1/me/export');
    expect(errors).toEqual([]);
  });

  test('without a file picker, it writes to the browser and offers a Save button', async ({ page }) => {
    const errors = watchConsole(page);
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await arrive(page);
    await page.getByTestId('export-start').click();
    const save = page.getByTestId('export-save');
    await expect(save).toBeVisible({ timeout: 30_000 });
    await expect(save).toHaveAttribute('download', /^minimalist-alliance-export-.*\.zip$/);
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const path = join(OUT, 'saved.zip');
    await download.saveAs(path);
    const z = inspect(path);
    expect(z.names).toContain('desks/Personal/files/notes.txt');
    for (const f of z.manifest.files) expect(z.sha[f.path], f.path).toBe(f.sha256);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
    expect(errors).toEqual([]);
  });

  test('can be protected with a passphrase: the saved file is unreadable without it, opens with the tool, and carries the newer account files', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await harness(request, { meExportExtras: true });
    await arrive(page);
    await page.getByTestId('protect-choice').click();
    await expect(page.getByTestId('export-start')).toBeDisabled();
    await page.getByTestId('pass-1').fill('short');
    await page.getByTestId('pass-2').fill('short');
    await expect(page.getByTestId('pass-note')).toContainText('at least 10');
    await expect(page.getByTestId('export-start')).toBeDisabled();
    await page.getByTestId('pass-1').fill('a long enough passphrase');
    await page.getByTestId('pass-2').fill('a long enough passphrasf');
    await expect(page.getByTestId('pass-note')).toContainText("don't match");
    await page.getByTestId('pass-2').fill('a long enough passphrase');
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await page.getByTestId('export-start').click();
    const save = page.getByTestId('export-save');
    await expect(save).toBeVisible({ timeout: 30_000 });
    await expect(save).toHaveAttribute('download', /^minimalist-alliance-export-.*\.zip\.enc$/);
    await expect(page.getByTestId('export-protected')).toContainText("which we never saw and can't recover");
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const enc = join(OUT, 'protected.zip.enc');
    await download.saveAs(enc);
    const bytes = readFileSync(enc);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('MAEXPORT');
    expect(bytes.includes(Buffer.from('notes.txt'))).toBe(false);
    expect(bytes.includes(Buffer.from('PK\u0003\u0004'))).toBe(false);

    const passFile = join(OUT, 'protected.pass');
    writeFileSync(passFile, 'a long enough passphrase\n', { mode: 0o600 });
    const tool = join(process.cwd(), '../tools/export-decrypt/decrypt.mjs');
    execFileSync('node', [tool, enc, '--passphrase-file', passFile]);
    const z = inspect(join(OUT, 'protected.zip'));
    expect(z.names).toEqual(expect.arrayContaining(['account/maia-chats.json', 'account/activity-log.json', 'account/support-tickets.json', 'account/sign-in-factors.json', 'desks/Personal/files/notes.txt']));
    for (const f of z.manifest.files) expect(z.sha[f.path], f.path).toBe(f.sha256);
    expect(z.readme).toContain('THE PASSPHRASE');
    expect(z.readme).toContain('maia-chats.json');
    // Nothing of the passphrase was kept anywhere in the page's storage.
    const stored = await page.evaluate(() => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]));
    expect(stored).not.toContain('a long enough passphrase');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
    expect(errors).toEqual([]);
  });

  test('a dropped desk connection reconnects and carries on from the byte it reached', async ({ page }) => {
    const errors = watchConsole(page);
    await standInPicker(page, 'dropped.zip');
    await arrive(page);
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await page.evaluate(() => {
      const d = (window as unknown as Mock).__maDeskMock.data;
      d.dropAfter = { path: 'Photos/harbor.jpg', bytes: 1536 * 1024 };
      d.chunksPerTick = 4;
    });
    const phases: string[] = [];
    await page.exposeFunction('__phase', (p: string) => void phases.push(p));
    await page.evaluate((id) => {
      new MutationObserver(() => {
        const p = document.querySelector(`[data-testid="progress-${id}"]`)?.getAttribute('data-phase');
        if (p) (window as unknown as { __phase: (p: string) => void }).__phase(p);
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    }, DESK);
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
    expect(phases).toContain('reconnecting');
    const mock = await page.evaluate(() => (window as unknown as Mock).__maDeskMock.data);
    expect(mock.drops).toBe(1);
    const harbor = mock.reads.filter((r) => r.path === 'Photos/harbor.jpg');
    expect(harbor.map((r) => r.offset > 0)).toEqual([false, true]);
    expect(harbor[1]!.offset).toBeGreaterThanOrEqual(1536 * 1024);
    const z = inspect(await pickedFile(page, 'dropped.zip'));
    expect(z.sha['desks/Personal/files/Photos/harbor.jpg']).toBe(await sha(page, 'files', 'Photos/harbor.jpg'));
    expect(errors).toEqual([]);
  });

  test('a reload mid-download offers to carry on, and carries on from the byte it reached, reading nothing finished again', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchConsole(page);
    await standInPicker(page, 'reloaded.zip');
    await arrive(page);
    const at = await cutOff(page);
    await expect(page.getByTestId('export-offer')).toContainText(/is already saved, and it carries on from there\./);
    await page.screenshot({ path: 'test-results/shots/export-offer.png', fullPage: true });

    // At rest, nothing of the member's in the clear: not a name, not a byte of a file.
    const rest = await atRest(page, ['desks/Personal', 'account/', 'harbor', 'Photos', 'Bookmarks', 'Pick up the film', 'member-1@example.org', 'Test Member']);
    expect(rest.found).toEqual([]);
    expect(rest.copy).toBeGreaterThan(at);
    expect(rest.sealed).toBeGreaterThan(1);
    expect(rest.secret).toEqual(['at', 'epoch', 'handle', 'key', 'owner']); // the handle: the file they chose, to carry on into; the owner: a hash
    expect(rest.extractable).toBe(false);

    await page.getByTestId('export-carry-on').click();
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 60_000 });
    const mock = await page.evaluate(() => (window as unknown as Mock).__maDeskMock.data);
    const harbor = mock.reads.filter((r) => r.path === 'Photos/harbor.jpg');
    expect(harbor[0]!.offset).toBeGreaterThanOrEqual(at);
    expect(mock.reads.map((r) => r.path)).not.toContain('profile/Default/Bookmarks'); // finished before the reload
    const z = inspect(await pickedFile(page, 'reloaded.zip'));
    expect(z.sha['desks/Personal/files/Photos/harbor.jpg']).toBe(await sha(page, 'files', 'Photos/harbor.jpg'));
    for (const f of z.manifest.files) expect(z.sha[f.path], f.path).toBe(f.sha256);
    expect(new Set(z.names).size).toBe(z.names.length);
    // Saved, so nothing left behind: no journal, no key, no working copy.
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
    expect(errors).toEqual([]);
  });

  test('Discard deletes the partial download, its journal and its key, and the page is as for a fresh start', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchConsole(page);
    await standInPicker(page, 'discarded.zip');
    await arrive(page);
    await cutOff(page);
    expect(await leftBehind(page)).toEqual({ journal: true, copy: true });
    await page.getByTestId('export-discard').click();
    await expect(page.getByTestId('export-offer')).toBeHidden();
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
    await page.reload();
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await expect(page.getByTestId('export-offer')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('signing out deletes a partial download, its journal and its key', async ({ page, request }) => {
    test.setTimeout(120_000);
    await harness(request, { signInPath: null });
    await standInPicker(page, 'signed-out.zip');
    await arrive(page);
    await cutOff(page);
    expect(await leftBehind(page)).toEqual({ journal: true, copy: true });
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    expect(await leftBehind(page)).toEqual({ journal: false, copy: false });
  });

  test('signing out in another tab stops a download that is running, and deletes it', async ({ page, context, request }) => {
    test.setTimeout(120_000);
    await harness(request, { signInPath: null });
    await standInPicker(page, 'other-tab.zip');
    await arrive(page);
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await page.evaluate(() => {
      const d = (window as unknown as Mock).__maDeskMock.data;
      d.tickMs = 100;
      d.chunksPerTick = 1;
    });
    await page.getByTestId('export-start').click();
    await expect.poll(() => written(page, 'Photos/harbor.jpg'), { timeout: 30_000 }).toBeGreaterThan(0);
    const office = await context.newPage();
    await office.goto('/');
    await expect(office.locator('.ma-shell')).toBeVisible();
    await office.getByRole('button', { name: 'Account' }).click();
    await office.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(office.getByTestId('sign-in')).toContainText("You're signed out.");
    await expect(page.getByTestId('export-stopped')).toBeVisible();
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
  });

  test("a partial download is its member's alone: a start with nobody signed in deletes it, and the next member is offered nothing", async ({ page, request }) => {
    test.setTimeout(120_000);
    await harness(request, { userId: 'u-member-A' });
    await noPicker(page);
    await arrive(page);
    await cutOff(page);
    expect(await leftBehind(page)).toEqual({ journal: true, copy: true });
    // A's session ends in a tab nobody is looking at, and the browser is closed. Whoever opens it next is B.
    await dropToken(page);
    await harness(request, { userId: 'u-member-B' });
    await arrive(page);
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await expect(page.getByTestId('export-offer')).toHaveCount(0);
    expect(await leftBehind(page)).toEqual({ journal: false, copy: false });
  });

  test("someone signing in on our own pages over a member's session deletes that member's partial download", async ({ page, request }) => {
    test.setTimeout(120_000);
    await harness(request, { signInPath: '/_signin/', userId: 'u-member-A' });
    await noPicker(page);
    await arrive(page);
    await cutOff(page);
    // B signs in on the pages, which put B's refresh token where A's was: no session ever ends here.
    await harness(request, { userId: 'u-member-B' });
    await page.goto('/_signin/?return=%2Fexport');
    await page.waitForURL(/\/export$/);
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
    await expect(page.getByTestId('export-offer')).toHaveCount(0);
  });

  test('a computer that slept through the 6 hours wakes to its download still running, and it finishes', async ({ page }) => {
    test.setTimeout(120_000);
    await noPicker(page);
    await signIn(page);
    await page.clock.install();
    await page.goto('/export');
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await page.evaluate(() => {
      const d = (window as unknown as Mock).__maDeskMock.data;
      d.tickMs = 100;
      d.chunksPerTick = 1;
    });
    await page.getByTestId('export-start').click();
    await expect.poll(() => written(page, 'Photos/harbor.jpg'), { timeout: 30_000 }).toBeGreaterThan(0);
    // The lid closes for 7 hours: on waking, the timers that came due fire, the sweep's among them.
    await page.clock.fastForward('07:00:00');
    await page.evaluate(() => {
      const d = (window as unknown as Mock).__maDeskMock.data;
      d.tickMs = 5;
      d.chunksPerTick = 8;
    });
    await expect(page.getByTestId('export-save')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('export-stopped')).toHaveCount(0);
  });

  test('a desk that never opens holds nobody up, and can be left out after a while, keeping the rest', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchConsole(page);
    await harness(request, { fleet: [{ deskId: WORK, name: 'Work', kind: 'work', state: 'running' }, { deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' }] });
    await standInPicker(page, 'left-out.zip');
    await signIn(page);
    await page.clock.install();
    await page.goto('/export');
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await page.waitForTimeout(500); // the office's links open
    await page.evaluate((id) => (window as unknown as Mock).__maDeskMock.dropLink(id), WORK); // and Work's never comes back
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId(`progress-${DESK}`)).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(page.getByTestId(`progress-${WORK}`)).toHaveAttribute('data-phase', 'connecting');
    await expect(page.getByTestId(`leave-out-${WORK}`)).toHaveCount(0); // not at once: it may yet open
    await page.clock.fastForward(31_000);
    await expect(page.getByTestId(`progress-${WORK}`)).toContainText('Not answering yet. Leave out'); // the reason, then the button
    await page.getByRole('button', { name: 'Leave Work out' }).click();
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`progress-${WORK}`)).toContainText('Left out of this download.');
    const z = inspect(await pickedFile(page, 'left-out.zip'));
    expect(z.names).toContain('desks/Personal/files/Photos/harbor.jpg');
    expect(z.names.filter((n) => n.startsWith('desks/Work/'))).toEqual([]);
    expect(z.manifest.desks).toEqual([expect.objectContaining({ name: 'Work', complete: false }), expect.objectContaining({ name: 'Personal', complete: true })]);
    expect(z.readme).toContain('Work: it was left out of this download.');
    expect(errors).toEqual([]);
  });

  test("a closed account's desk that's stopping is asked again at the pace it gives, not in a burst", async ({ page, request }) => {
    test.setTimeout(60_000);
    await harness(request, {
      membership: { status: 'ended', tier: 'officer' },
      refuseConnect: { code: 'account_inactive', details: {} },
      fleet: [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'stopping' }],
      // What services/desks answers `start: true` on a desk that's stopping.
      refuseWake: { status: 409, code: 'invalid_state', details: { state: 'stopping', retryAfterSeconds: 3 } },
    });
    await noPicker(page);
    await arrive(page, '/export?link=real');
    await expect(page.getByTestId('export-ended')).toBeVisible();
    await page.getByTestId('export-start').click();
    await page.waitForTimeout(2_000);
    expect(await exportConnects(request)).toBe(1);
    await page.waitForTimeout(5_000);
    expect(await exportConnects(request)).toBeGreaterThanOrEqual(2);
    expect(await exportConnects(request)).toBeLessThanOrEqual(3);
    await expect(page.getByTestId('export-done')).toHaveCount(0); // still waiting for it, not given up on
    await page.getByTestId('export-stop').click();
    await expect(page.getByTestId('export-stopped')).toBeVisible();
  });

  test('a sign-out in another tab takes the finished archive offered from this one with it', async ({ page, context, request }) => {
    test.setTimeout(120_000);
    await harness(request, { signInPath: null });
    await noPicker(page);
    await arrive(page);
    await page.getByTestId('export-start').click();
    const save = page.getByTestId('export-save');
    await expect(save).toBeVisible({ timeout: 60_000 });
    const href = (await save.getAttribute('href'))!;
    const office = await context.newPage();
    await office.goto('/');
    await expect(office.locator('.ma-shell')).toBeVisible();
    await office.getByRole('button', { name: 'Account' }).click();
    await office.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(office.getByTestId('sign-in')).toContainText("You're signed out.");
    await expect(save).toHaveCount(0);
    expect(await page.evaluate(async (u) => fetch(u).then(() => 'read', () => 'gone'), href)).toBe('gone');
    await expect.poll(() => leftBehind(page)).toEqual({ journal: false, copy: false });
  });

  test("a retained desk is shown and not offered, as it can't be woken for a download", async ({ page, request }) => {
    await harness(request, { fleet: [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: GUILD, name: 'Guild', kind: 'guild', state: 'retained' }] });
    await arrive(page);
    await expect(page.getByTestId('export-start')).toBeEnabled();
    await expect(page.getByTestId(`choose-${GUILD}`)).toContainText('Kept for you. Not in downloads yet.');
    await expect(page.getByTestId(`choose-${GUILD}`).getByRole('checkbox')).toBeDisabled();
    await expect(page.getByTestId(`choose-${GUILD}`).getByRole('checkbox')).not.toBeChecked();
  });

  test("the new states look intended in Light, Dusk and Dark: a desk that can't be included, one to leave out, and one left out", async ({ page, request }) => {
    test.setTimeout(180_000);
    const errors = watchConsole(page);
    await harness(request, {
      fleet: [
        { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
        { deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' },
        { deskId: GUILD, name: 'Guild', kind: 'guild', state: 'retained' },
      ],
    });
    await standInPicker(page, 'my-backup.zip');
    await signIn(page);
    await page.clock.install();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.goto('/export');
      await expect(page.getByTestId('export-start')).toBeEnabled();
      await page.screenshot({ path: `test-results/shots/export-retained-${theme}.png`, fullPage: true });
      await page.waitForTimeout(500);
      await page.evaluate((id) => (window as unknown as Mock).__maDeskMock.dropLink(id), WORK);
      await page.getByTestId('export-start').click();
      await expect(page.getByTestId(`progress-${DESK}`)).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
      await page.clock.fastForward(31_000);
      await expect(page.getByTestId(`leave-out-${WORK}`)).toBeVisible();
      await page.waitForTimeout(400); // Personal's bar has finished filling
      await page.screenshot({ path: `test-results/shots/export-leave-out-${theme}.png`, fullPage: true });
      await page.getByTestId(`leave-out-${WORK}`).click();
      await expect(page.getByTestId('export-done')).toContainText('Your data is saved as my-backup.zip');
      await page.screenshot({ path: `test-results/shots/export-left-out-${theme}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });

  test("a closed account's desk wakes for the export, with an export-only session", async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { membership: { status: 'ended', tier: 'officer' }, refuseConnect: { code: 'account_inactive', details: {} }, fleet: [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'stopped' }] });
    await standInPicker(page, 'ended.zip');
    await arrive(page, '/export?refuse=account_inactive');
    await expect(page.getByTestId('export-ended')).toContainText('Your membership has ended.');
    await expect(page.getByTestId(`choose-${DESK}`)).toContainText('Asleep. It wakes for the download.');
    await page.evaluate(() => {
      (window as unknown as Mock).__maDeskMock.exportWakeMs = 1500;
    });
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId(`progress-${DESK}`)).toContainText('Waking Personal…');
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
    const h = await read(request);
    expect(h.connects.filter((c) => c.purpose === 'export')).toEqual([{ deskId: DESK, start: true, purpose: 'export' }]);
    const mock = await page.evaluate(() => (window as unknown as Mock).__maDeskMock.data);
    expect(new Set(mock.reads.map((r) => r.scope))).toEqual(new Set(['export']));
    const z = inspect(await pickedFile(page, 'ended.zip'));
    expect(z.names).toContain('desks/Personal/files/Photos/harbor.jpg');
    expect(errors).toEqual([]);
  });

  test('looks intended in Light, Dusk and Dark: choosing, copying and done', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { fleet: [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'stopped' }] });
    await standInPicker(page, 'themes.zip');
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await arrive(page);
      await expect(page.getByTestId('export-start')).toBeEnabled();
      await page.screenshot({ path: `test-results/shots/export-${theme}.png`, fullPage: true });
      await page.evaluate(() => {
        (window as unknown as Mock).__maDeskMock.data.chunksPerTick = 1;
      });
      await page.getByTestId('export-start').click();
      await expect(page.getByTestId(`progress-${DESK}`)).toHaveAttribute('data-phase', 'copying', { timeout: 15_000 });
      await expect(page.getByTestId(`progress-${DESK}`)).toContainText(/of 10 files/);
      await page.screenshot({ path: `test-results/shots/export-copying-${theme}.png`, fullPage: true });
      await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: `test-results/shots/export-done-${theme}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });
});

test.describe('the move', () => {
  const HOME = 'd-home000000001';
  const fleet = (home: boolean) => [
    { deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' },
    ...(home ? [{ deskId: HOME, name: 'Home', kind: 'personal', state: 'running', hosting: 'self' }] : []),
  ];

  test('is hidden while export.moves is off', async ({ page, request }) => {
    await harness(request, { export: { enabled: true, moves: false }, fleet: fleet(true) });
    await arrive(page);
    await expect(page.getByTestId('export-start')).toBeVisible();
    await expect(page.getByTestId('move-panel')).toHaveCount(0);
  });

  test("says to set up a desk on your own computer first, when there is none, linking the Platform app's /self-hosted", async ({ page, request }) => {
    await harness(request, { export: { enabled: true, moves: true }, fleet: fleet(false) });
    await arrive(page);
    await expect(page.getByTestId('move-no-target')).toHaveText('Set up a desk on your own computer first. How to set one up');
    // No link of its own in client-config: on the account link's host (the harness's is https://platform.localhost/account).
    await expect(page.getByTestId('move-guide')).toHaveAttribute('href', 'https://platform.localhost/self-hosted');
  });

  test('a desk on your own computer that is offline is shown and not offered, as it cannot be woken from here', async ({ page, request }) => {
    await harness(request, { export: { enabled: true, moves: true }, fleet: [...fleet(false), { deskId: HOME, name: 'Home', kind: 'personal', state: 'stopped', hosting: 'self' }] });
    await arrive(page);
    await expect(page.getByTestId(`choose-${HOME}`)).toContainText('Offline. Turn on its computer to include it.');
    await expect(page.getByTestId(`choose-${HOME}`).getByRole('checkbox')).toBeDisabled();
    await expect(page.getByTestId(`choose-${DESK}`).getByRole('checkbox')).toBeChecked();
    await expect(page.getByTestId('move-to')).toHaveValue(HOME); // still somewhere a move can go, once it's on
  });

  test('shows the code large and copyable, counts down its 15 minutes, gives the one command, and lists moves', async ({ page, request, context }) => {
    const errors = watchConsole(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await harness(request, {
      export: { enabled: true, moves: true },
      fleet: fleet(true),
      moves: [{ moveId: 'mv-0', sourceDeskId: DESK, targetDeskId: HOME, state: 'done', createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T12:00:00Z' }],
    });
    await arrive(page);
    await expect(page.getByTestId('move-history')).toContainText('Moved to Home desk on Nov 6');
    await expect(page.getByTestId('move-from')).toHaveValue(DESK);
    await expect(page.getByTestId('move-to')).toHaveValue(HOME);
    await page.getByTestId('move-get-code').click();
    await expect(page.getByTestId('move-code')).toHaveText('K7Q2-M9XA-P4TB');
    const font = await page.getByTestId('move-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(font).toBeGreaterThanOrEqual(26);
    await expect(page.getByTestId('move-command')).toHaveText('sudo ma-move');
    const first = await page.getByTestId('move-expires').textContent();
    expect(first).toMatch(/Expires in 1[45]:\d\d\./);
    await page.waitForTimeout(2100);
    expect(await page.getByTestId('move-expires').textContent()).not.toBe(first);
    await page.getByTestId('copy-code').click();
    await expect(page.getByTestId('copy-code')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('K7Q2-M9XA-P4TB');
    await page.getByTestId('copy-command').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('sudo ma-move');
    for (const theme of THEMES) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(100);
      await page.screenshot({ path: `test-results/shots/export-move-${theme}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });

  test('a code that runs out says so, and offers a new one', async ({ page, request }) => {
    await harness(request, { export: { enabled: true, moves: true }, fleet: fleet(true), moveCodeSeconds: 2 });
    await arrive(page);
    await page.getByTestId('move-get-code').click();
    await expect(page.getByTestId('move-code')).toBeVisible();
    await expect(page.getByTestId('move-expired')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('move-get-code')).toHaveText('Get a new code');
  });

  test('cancels a move from the code screen, and a code that is still out from the list', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { export: { enabled: true, moves: true }, fleet: fleet(true) });
    await arrive(page);
    await page.getByTestId('move-get-code').click();
    await expect(page.getByTestId('move-code')).toBeVisible();
    await page.getByTestId('move-cancel-code').click();
    await expect(page.getByTestId('move-code')).toHaveCount(0);
    await expect(page.getByTestId('move-get-code')).toBeVisible();
    await expect(page.getByTestId('move-history')).toContainText('A move to Home desk was cancelled');
    expect(((await (await request.get('/__harness')).json()) as { log: string[] }).log).toContain('POST /v1/moves/mv-1/cancel');

    // A move under way, from an earlier visit: the list offers Cancel.
    await harness(request, {
      moves: [{ moveId: 'mv-9', sourceDeskId: DESK, targetDeskId: HOME, state: 'copying', createdAt: '2026-11-08T09:00:00Z', updatedAt: '2026-11-08T09:10:00Z' }],
    });
    await page.reload();
    await expect(page.getByTestId('move-history')).toContainText('Moving to Home desk');
    await page.getByTestId('move-cancel-mv-9').click();
    await expect(page.getByTestId('move-history')).toContainText('A move to Home desk was cancelled');
    await expect(page.getByTestId('move-cancel-mv-9')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('after a finished move offers to remove the cloud desk, calmly, and says its data is kept 30 days', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, {
      export: { enabled: true, moves: true },
      fleet: fleet(true),
      moves: [{ moveId: 'mv-0', sourceDeskId: DESK, targetDeskId: HOME, state: 'done', createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T12:00:00Z' }],
    });
    await arrive(page);
    await page.getByTestId('move-remove-mv-0').click();
    const sure = page.getByTestId('move-remove-confirm');
    const said = (await sure.innerText()).replace(/\s+/g, ' ');
    expect(said).toContain('30 days');
    expect(said).toContain('Browser');
    expect(said).not.toContain('!');
    // Keeping it changes nothing.
    await page.getByTestId('move-remove-no').click();
    await expect(sure).toHaveCount(0);
    expect(((await (await request.get('/__harness')).json()) as { log: string[] }).log.some((l) => l.endsWith('remove-cloud-desk'))).toBe(false);

    await page.getByTestId('move-remove-mv-0').click();
    await page.getByTestId('move-remove-yes').click();
    await expect(page.getByTestId('move-removed')).toContainText('Personal is removed. Its data is kept for 30 days');
    await expect(page.getByTestId('move-remove-mv-0')).toHaveCount(0);
    expect(((await (await request.get('/__harness')).json()) as { log: string[] }).log).toContain('POST /v1/moves/mv-0/remove-cloud-desk');
    expect(errors.filter((e) => !/503/.test(e))).toEqual([]);
  });

  test('a cloud desk that is still up is stopped first (the platform answers 202), then removed, with its ID in the request', async ({ page, request }) => {
    await harness(request, {
      export: { enabled: true, moves: true },
      fleet: fleet(true),
      removeNeedsStop: true,
      moves: [{ moveId: 'mv-0', sourceDeskId: DESK, targetDeskId: HOME, state: 'done', createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T12:00:00Z' }],
    });
    await arrive(page);
    await page.getByTestId('move-remove-mv-0').click();
    await page.getByTestId('move-remove-yes').click();
    await expect(page.getByTestId('move-removed')).toContainText('is removed. Its data is kept for 30 days', { timeout: 15_000 });
    const log = ((await (await request.get('/__harness')).json()) as { log: string[] }).log;
    // Two asks (202, then 200); the harness logs each request twice, once generally and once for the action.
    expect(log.filter((l) => l === 'POST /v1/moves/mv-0/remove-cloud-desk')).toHaveLength(4);
  });

  test('a removal that fails leaves the cloud desk alone and says so', async ({ page, request }) => {
    await harness(request, {
      export: { enabled: true, moves: true },
      fleet: fleet(true),
      removeSourceFails: true,
      moves: [{ moveId: 'mv-0', sourceDeskId: DESK, targetDeskId: HOME, state: 'done', createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T12:00:00Z' }],
    });
    await arrive(page);
    await page.getByTestId('move-remove-mv-0').click();
    await page.getByTestId('move-remove-yes').click();
    await expect(page.getByTestId('move-error')).toContainText("It's untouched");
    await expect(page.getByTestId('move-remove-yes')).toBeVisible();
  });
});
