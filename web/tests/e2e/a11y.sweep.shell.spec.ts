// The regression set's axe sweep over the surfaces no app spec owns: Maia's panel open, the export page, the signed-out
// card, the new-version notice and the account menu open, on a desktop and on a phone. WCAG 2.2 A and AA; a serious or
// critical violation fails, the rest is for the accessibility passes (`docs/sub-status/a11y-*.md`). The apps' own
// windows have axe in their own specs (`files`, `agent`, `notebook`, `guild`, `a11y.browser`).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 375, height: 667 },
];
const NEWER = '2099.01.01-0000000';

/** Serious and critical violations on the whole page, each with where. */
async function sweep(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const openMenu = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
};

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test.beforeEach(async ({ request }) => {
      await harness(request, { reset: true });
    });

    test("Maia's panel open", async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { maia: { enabled: true } });
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await page.locator('.maia-launcher').click();
      await expect(page.getByRole('dialog', { name: 'Maia' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message to Maia' })).toBeFocused();
      expect(await sweep(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('the export page', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { export: { enabled: true, moves: false } });
      await signIn(page);
      await page.goto('/export');
      await expect(page.getByTestId('export-page')).toBeVisible();
      await expect(page.getByTestId('export-start')).toBeEnabled();
      expect(await sweep(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('the signed-out card', async ({ page }) => {
      const errors = watchConsole(page);
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await openMenu(page);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
      expect(await sweep(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('the new-version notice', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { releaseVersion: NEWER });
      await signIn(page, '/?fixture=one&versionEveryMs=300');
      await canvasPainted(page);
      await expect(page.getByTestId('new-version')).toContainText(/A new version is ready/);
      expect(await sweep(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('the account menu open', async ({ page }) => {
      const errors = watchConsole(page);
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await openMenu(page);
      expect(await sweep(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('the account menu open, with the office tour on: no tour switch or "Take the tour" in it (ADR 0056), and no "Plain background"', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { walkthrough: null });
      // A member who has had the tour: it doesn't start over the menu.
      await page.addInitScript(() => {
        if (window === window.top) localStorage.setItem('ma.tour.v1', JSON.stringify({ who: 'u-test', off: true }));
      });
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await openMenu(page);
      await expect(page.getByRole('switch', { name: /office tour|Plain background/ })).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Take the tour' })).toHaveCount(0);
      expect(await sweep(page)).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

