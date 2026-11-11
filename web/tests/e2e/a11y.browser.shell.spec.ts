// The accessibility pass of Nov 10, the Browser window: the wake's progress bar has a name (WCAG 4.1.2), and each tab's
// close button is a 24 px target (WCAG 2.5.8), as axe checks.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** axe on the Browser window, as rule ids with their targets. */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['[data-testid="window-browser"]'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}
test('a desk waking in the Browser window: its progress bar is named, and axe finds nothing else there', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'starting' }] });
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-panel')).toHaveAttribute('data-panel', 'waking');
  const bar = page.getByTestId('browser-panel').getByRole('progressbar');
  await expect(bar).toHaveAccessibleName('Waking this desk');
  await expect(bar).toHaveAttribute('aria-valuetext', /step \d of 4$/);
  expect(await axe(page)).toEqual([]);
  expect(errors.filter((e) => !/Content Security Policy|connect-src/.test(e))).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: each tab's close button is a 24 px target, and the tabs keep their size`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId('browser-tab')).toHaveCount(1);
    const tab = (tabId: string, title: string, active: boolean) => ({ tabId, url: 'https://example.org/', title, loading: false, active, canGoBack: false, canGoForward: false });
    await page.evaluate((t) => (window as unknown as { __maDeskMock: { setTabs(t: unknown): void } }).__maDeskMock.setTabs(t), [tab('t1', 'Example page', false), tab('t2', 'Second', true), tab('t3', 'Third', false)]);
    await expect(page.getByTestId('browser-tab')).toHaveCount(3);
    for (const name of ['Close Example page', 'Close Second', 'Close Third']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(box.width, name).toBeGreaterThanOrEqual(24);
      expect(box.height, name).toBeGreaterThanOrEqual(24);
    }
    // Every tab is still 30 px tall, and the close button sits inside it.
    const heights = await page.getByTestId('browser-tab').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(heights).toEqual([30, 30, 30]);
    expect((await axe(page)).filter((l) => l.startsWith('target-size'))).toEqual([]);
    // O1: a group of buttons, not a tablist; the open tab says so with aria-current, and axe finds nothing in the strip.
    const strip = page.getByRole('group', { name: 'Tabs on this desk' });
    await expect(strip.getByRole('button', { name: 'Second', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(strip.getByRole('button', { name: 'Third', exact: true })).not.toHaveAttribute('aria-current');
    await expect(page.getByTestId('window-browser').locator('[role="tab"], [role="tablist"]')).toHaveCount(0);
    expect((await axe(page)).filter((l) => l.includes('.br-tabs'))).toEqual([]);
    await page.getByTestId('window-browser').screenshot({ path: `test-results/shots/a11y-browser-tabs-${theme}.png` });
    expect(errors).toEqual([]);
  });
}
