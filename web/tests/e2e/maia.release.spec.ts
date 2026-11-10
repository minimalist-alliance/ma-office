// Maia's gate in the bundle exactly as it ships (contract maia.md, "The widget"). Prod's client-config has no `maia`
// block today, and this app is promoted to prod with every release, so with prod's defaults there must be nothing of
// her at all: no element, no chunk, and no request to any Maia route.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** Every request the page makes that has anything to do with Maia. */
function watchMaia(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (/maia/i.test(r.url())) seen.push(r.url());
  });
  return seen;
}

const maiaLog = async (request: Parameters<typeof harness>[0]): Promise<string[]> =>
  ((await (await request.get('/__harness')).json()).log as string[]).filter((l) => l.includes('/v1/maia') || l.includes('__pixel'));

test("prod's defaults: no maia block means no widget, no chunk and no Maia request", async ({ page, request }) => {
  const errors = watchConsole(page);
  const seen = watchMaia(page);
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(1500); // anything late would have gone by now
  await expect(page.locator('[data-testid="maia"], .maia')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Maia/ })).toHaveCount(0);
  expect(seen).toEqual([]);
  expect(await maiaLog(request)).toEqual([]);
  const config = await page.evaluate(async () => (await fetch('/v1/client-config?app=desk-web')).json());
  expect(config).not.toHaveProperty('maia');
  expect(errors).toEqual([]);
});

test('the shipping bundle takes only an https Maia: the harness\'s http origin gets nothing either', async ({ page, request }) => {
  await harness(request, { maia: { enabled: true } });
  const seen = watchMaia(page);
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-testid="maia"]')).toHaveCount(0);
  expect(seen).toEqual([]);
  expect(await maiaLog(request)).toEqual([]);
});
