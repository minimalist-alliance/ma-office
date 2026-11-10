// The Agent window in the bundle exactly as it ships: the lazy chunk through the real loader path and under the real CSP, in both
// sign-in modes (`HARNESS_SIGN_IN_PATH`). No desk here: `connect` keeps saying not ready, so the window says "Opening…", and
// `agent.rtc.spec.ts` has the app itself on a real link. `build-release.mjs` checks every file for the mock.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test('the chunk stays out until the window opens, then loads under the real CSP, with no mock in it', async ({ page }) => {
  const errors = watchConsole(page);
  const violations = await watchCsp(page);
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
  });
  await signIn(page);
  await canvasPainted(page);
  expect(scripts.filter((s) => /AgentBody/.test(s))).toEqual([]);

  const chunk = page.waitForResponse((r) => /\/assets\/AgentBody-[^/]+\.js$/.test(r.url()));
  const tile = page.getByRole('button', { name: /^Agent/ });
  await tile.focus();
  await page.keyboard.press('Enter');
  const win = page.getByRole('dialog', { name: /Agent/ });
  await expect(win).toBeVisible();
  const res = await chunk;
  expect(res.status()).toBe(200);
  expect(new URL(res.url()).pathname).toMatch(/^\/v\/[^/]+\/assets\//);

  const body = await res.text();
  for (const word of ['MockAgentClient', 'k-anthropic-1', 'This is the demo', '__maDeskMock', '__maAgentMock']) expect(body, word).not.toContain(word);

  // The app's own styles came with the one stylesheet, since nothing else can load under this CSP without being listed.
  const styled = await page.evaluate(() => [...document.styleSheets].some((s) => {
    try {
      return [...s.cssRules].some((r) => r.cssText.includes('.ag-app'));
    } catch {
      return false;
    }
  }));
  expect(styled).toBe(true);

  // No session on this desk, so the window waits and says so, and nothing a mock would answer has appeared.
  await expect(win.getByTestId('agent-panel')).toHaveAttribute('data-panel', 'opening');
  await expect(win.getByTestId('key-setup')).toHaveCount(0);
  expect(await page.evaluate(() => '__maDeskMock' in window)).toBe(false);
  await page.keyboard.press('Escape');
  expect(await violations()).toEqual([]);
  expect(errors).toEqual([]);
});
