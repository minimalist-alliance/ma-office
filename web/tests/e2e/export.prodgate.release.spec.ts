// Prod gating for task 32's export and move (draft ADR "data export and transfer"), in the bundle exactly as it ships:
// with client-config shaped as prod serves it, the office shows no export or move, `/export` is the office, the
// export chunk is never fetched, and nothing asks for `/v1/me/export`, `/v1/moves` or an export-only `connect`.
// Two shapes of prod: today's, with no `export` block, and the one prod serves once Platform's part ships with its
// settings off (`export#current` absent: `{enabled: false, moves: false}`). Only URLs come from the harness, so the
// page can load; every other block is prod's (2026-11-06: `links` with prod's keys, `googleSignIn`, no `maia`).
import { expect, test, type Page, type Request } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';

const PROD_LINK_KEYS = ['signUp', 'billing', 'account', 'guilds', 'guildAdmin', 'office', 'support'];

const SHAPES: { name: string; export?: unknown }[] = [
  { name: "today's prod, no export block" },
  { name: "prod once Platform's part ships, settings off", export: { enabled: false, moves: false } },
];

/** client-config for desk-web as prod has it, with the harness's own origin in place of prod's hosts. */
async function prodShaped(page: Page, exportBlock: unknown): Promise<void> {
  await page.route(/\/v1\/client-config\?app=desk-web$/, async (route) => {
    const harnessConfig = (await (await route.fetch()).json()) as Record<string, unknown> & { auth: Record<string, unknown>; api: string };
    const origin = harnessConfig.api;
    const config: Record<string, unknown> = {
      ...harnessConfig,
      env: 'prod',
      auth: { ...harnessConfig.auth, identityProviders: ['COGNITO', 'Google'], googleSignIn: true },
      links: Object.fromEntries(PROD_LINK_KEYS.map((k) => [k, `${origin}/${k}`])),
    };
    delete config['export'];
    delete config['maia'];
    if (exportBlock !== undefined) config['export'] = exportBlock;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
  });
}

/** Every request the page makes, and the body of every `connect`. */
function record(page: Page): { urls: string[]; connects: string[] } {
  const seen = { urls: [] as string[], connects: [] as string[] };
  page.on('request', (r: Request) => {
    seen.urls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    if (/\/v1\/desks\/[^/]+\/connect$/.test(new URL(r.url()).pathname)) seen.connects.push(r.postData() ?? '');
  });
  return seen;
}

function expectNothingOfExport(seen: { urls: string[]; connects: string[] }): void {
  expect(seen.urls.filter((u) => /ExportPage|\/v1\/me\/export|\/v1\/moves/.test(u))).toEqual([]);
  for (const body of seen.connects) expect(JSON.parse(body)).not.toHaveProperty('purpose');
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const shape of SHAPES) {
  test.describe(shape.name, () => {
    test('the office has no download or move, and the account menu is as before', async ({ page }) => {
      const errors = watchConsole(page);
      await prodShaped(page, shape.export);
      const seen = record(page);
      await signIn(page);
      await page.getByRole('button', { name: 'Account' }).click();
      const menu = page.getByRole('dialog', { name: 'Account' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); // the menu is open and whole
      await expect(menu.getByRole('link', { name: /Download your data/ })).toHaveCount(0);
      await expect(page.getByText(/Download your data|Move to your own computer/)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500); // anything late, such as a link's first connect
      expectNothingOfExport(seen);
      expect(errors).toEqual([]);
    });

    test('/export is the office, and the export chunk is never fetched', async ({ page }) => {
      const errors = watchConsole(page);
      await prodShaped(page, shape.export);
      const seen = record(page);
      await signIn(page);
      await page.goto('/export');
      await expect(page.locator('.ma-shell')).toBeVisible();
      await expect(page.getByTestId('export-page')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Your data' })).toHaveCount(0);
      await page.waitForTimeout(1500);
      expectNothingOfExport(seen);
      expect(errors).toEqual([]);
    });
  });
}
