// The Notebook's chunk in the bundle exactly as it ships: under the default CSP, through the real loader path, with the real link.
// No desk answers here, so it stops at the window's first state. `notebook.rtc.spec.ts` runs the editor itself over real channels.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const DIST = resolve('dist/release');
const js = (): string[] => readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
const read = (f: string): string => readFileSync(join(DIST, 'assets', f), 'utf8');

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the chunk is prefetched at idle, under the default CSP, before anything opens, and with no CSP report', async ({ page }) => {
  const errors = watchConsole(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.effectiveDirective}: ${e.blockedURI}`));
  });
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/\/assets\/NotebookApp-[\w-]+\.js$/.test(r.url())) chunks.push(r.url());
  });
  await signIn(page);
  const csp = await page.request.get(page.url()).then((r) => r.headers()['content-security-policy']);
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  await canvasPainted(page);
  await expect.poll(() => chunks.length, { timeout: 15_000 }).toBe(1);
  expect(new URL(chunks[0] as string).origin).toBe(new URL(page.url()).origin);

  // Opening the window asks for nothing more: the code is here, and no desk answers, so it waits calmly.
  const tile = page.getByRole('button', { name: /^Notebook/ });
  await tile.focus();
  await page.keyboard.press('Enter');
  const win = page.getByRole('dialog', { name: /Notebook/ });
  await expect(win.getByTestId('notebook-panel')).toBeAttached();
  await expect(win.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(chunks).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  // Its stylesheet is the app's one stylesheet, so there's nothing to load and nothing inline.
  expect(await page.evaluate(() => [...document.styleSheets].every((s) => s.href !== null))).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ma-nb-tab-blue').trim())).not.toBe('');
  expect(errors).toEqual([]);
});

test('the shipping bundle holds no mock and no local backend, and the editor only in its chunk', () => {
  const release = JSON.parse(readFileSync(join(DIST, 'ma-release.json'), 'utf8')) as { entry: string };
  const entry = release.entry.split('/').pop() as string;
  const notebook = js().filter((f) => f.startsWith('NotebookApp-'));
  expect(notebook).toHaveLength(1);
  for (const f of js()) {
    const src = read(f);
    for (const word of ['MockDeskLink', 'mockDeskLink', 'mockNotebook', 'ma-mock-notebook', 'MockCollab', '__maDeskMock', 'ma-notebook-local', 'LocalBackend']) {
      expect(src.includes(word), `${f} holds ${word}`).toBe(false);
    }
  }
  // Nothing of the editor or the provider in what loads first.
  const first = read(entry);
  for (const word of ['ProseMirror-', 'y-prosemirror', 'hocuspocus', 'HocuspocusProvider']) expect(first.includes(word), `${entry} holds ${word}`).toBe(false);
  const chunk = read(notebook[0] as string);
  expect(chunk).toContain('ProseMirror-');
  // What the brief said to expect, with room to grow a little. `build:release` holds the initial budget.
  expect(gzipSync(chunk).length).toBeLessThan(230 * 1024);
});

test('nothing of the Notebook asks the desk anything until its window opens', async ({ page, request }) => {
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(1_500);
  const log = (await (await request.get('/__harness')).json()) as { log: string[] };
  expect(log.log.filter((l) => /notebook/i.test(l))).toEqual([]);
});
