// The first load as it ships (`vite-plugins/firstLoad.ts`, `sub/js-trim-17`): the entry, one chunk holding every module the
// entry imports statically (`first-load-*.js`), and Rolldown's runtime, under the default CSP. Lazy chunks import what they
// share from that one chunk, so there's one React and one copy of each store, and no chunk carries a list of dependencies to
// preload (`build.modulePreload: false`; `vite-plugins/noPreload.ts` fails the build if one comes back).
import { expect, test, type APIRequestContext } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

/** A built file's name without its hash: `first-load-Dg0OGo33.js` is `first-load`. */
const named = (url: string): string => (new URL(url).pathname.split('/').pop() ?? '').replace(/-[\w-]{8}\.js$/, '');

/** The scripts a built file imports statically, by name, the way `scripts/build-release.mjs` counts the first load. */
async function staticImports(request: APIRequestContext, url: string): Promise<{ imports: string[]; text: string }> {
  const text = await (await request.get(url)).text();
  const imports = [...text.matchAll(/(?:^|[;\s}])import\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)].map((m) => named(new URL(m[1]!, url).href));
  return { imports: [...new Set(imports)].sort(), text };
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the office paints from three scripts: the entry, its one chunk and the runtime, with no preload lists', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  // This page's own fetches (sign-in loads the office twice), cached ones included.
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js$/.test(new URL(n).pathname)));

  const entry = scripts.find((u) => named(u) === 'main');
  const first = scripts.find((u) => named(u) === 'first-load');
  expect(entry).toBeTruthy();
  expect(first).toBeTruthy();
  // Each once, and none of the shared chunks the first load used to be split into.
  for (const name of ['main', 'first-load', 'rolldown-runtime']) expect(scripts.filter((u) => named(u) === name)).toHaveLength(1);
  for (const gone of ['layoutStore', 'liveStore', 'session', 'api', 'react', 'react-dom', 'themeStore', 'preload-helper']) expect(scripts.map(named)).not.toContain(gone);

  const fromEntry = await staticImports(request, entry!);
  const fromFirst = await staticImports(request, first!);
  expect(fromEntry.imports).toEqual(['first-load', 'rolldown-runtime']);
  expect(fromFirst.imports).toEqual(['rolldown-runtime']);
  expect(fromEntry.text).not.toContain('__vite__mapDeps');
  expect(fromFirst.text).not.toContain('__vite__mapDeps');
  expect(errors).toEqual([]);
});

test('a chunk fetched at idle takes what it shares from the first load: the account menu opens from it, under the default CSP', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  // The top bar's panels are fetched once the page is idle (`main.tsx`).
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/popovers-[\w-]{8}\.js$/.test(n)) ?? null), { timeout: 10_000 }).not.toBeNull();
  const popovers = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/popovers-[\w-]{8}\.js$/.test(n))!);
  const { imports, text } = await staticImports(request, popovers);
  expect(imports).toContain('first-load');
  expect(text).not.toContain('__vite__mapDeps');

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});
