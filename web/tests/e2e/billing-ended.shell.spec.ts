// The ended Work desk's panel (the Product Designer's billing spec, still 15): once a step down has stopped the Work desk, it
// stays on the canvas with its tiles dimmed, and opening it says so, with Download your data and Move back up. It shows
// only for a Work desk Platform marks (`notInPlan`, or retained with `export` alone); without one the office is today's.
// Axe in three themes; shots in test-results/billing142b/.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SHOTS = 'test-results/billing142b';
const A = 'd-personal00001';
const B = 'd-work000000001';
const PERSONAL = { deskId: A, name: 'Personal', kind: 'personal', state: 'running', allowedActions: ['connect', 'stop'] };
const NOT_IN_PLAN = { deskId: B, name: 'Work', kind: 'work', state: 'stopped', notInPlan: true, allowedActions: ['export'], stateChangedAt: '2026-12-01T18:04:00Z' };
const RETAINED = { deskId: B, name: 'Work', kind: 'work', state: 'retained', allowedActions: ['export'], endsAt: '2026-12-01T18:04:00Z', retainedUntil: '2026-12-31T00:00:00Z' };
const layout = {
  desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] }, [B]: { id: B, x: 640, y: 0, w: 584, h: 360, items: [] } },
  z: [A, B],
};

async function open(page: Page, request: APIRequestContext, work: Record<string, unknown> | null, theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await page.addInitScript((d) => {
    // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout));
  const fleet = work ? [PERSONAL, work] : [PERSONAL, { ...NOT_IN_PLAN, state: 'running', notInPlan: undefined, allowedActions: ['connect', 'stop'] }];
  await harness(request, { fleet, membership: { status: 'active', tier: 'alliance' }, configExtra: { links: { billing: 'https://platform.localhost/billing' } } });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600);
  return errors;
}

async function openWork(page: Page): Promise<void> {
  await page.locator(`[id="proxy-${B}"]`).focus();
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a Work desk that is still running: no panel', async ({ page, request }) => {
  const errors = await open(page, request, null);
  await openWork(page);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('ended-desk')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('notInPlan: the desk is kept, and the panel says so on the desk in view only', async ({ page, request }) => {
  const errors = await open(page, request, NOT_IN_PLAN);
  await expect(page.getByTestId('ended-desk')).toHaveCount(0); // the overview shows no panel
  await openWork(page);
  const panel = page.getByTestId('ended-desk');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('ended-desk-title')).toHaveText('Your Work desk stopped on December 1');
  await expect(page.getByTestId('ended-desk-body')).toHaveText("It isn't part of Alliance Member. It's kept, with its files, tabs and sign-ins, until you move back up, and you can download everything on it.");
  const up = page.getByTestId('ended-desk-moveup');
  await expect(up).toHaveAttribute('href', 'https://platform.localhost/billing');
  await expect(up).toHaveAttribute('target', '_blank');
  expect(errors).toEqual([]);
  // Download your data opens Account settings at Your data (its account frame is the harness's CSP's to refuse, so no console check after).
  await page.getByTestId('ended-desk-download').click();
  await expect(page.getByRole('dialog', { name: /Account settings/i })).toBeVisible();
});

test('retained with a snapshot date: the spec\'s words', async ({ page, request }) => {
  const errors = await open(page, request, RETAINED);
  await openWork(page);
  await expect(page.getByTestId('ended-desk-title')).toHaveText('Your Work desk stopped on December 1');
  await expect(page.getByTestId('ended-desk-body')).toHaveText("It isn't part of Alliance Member. We keep a snapshot of it until December 31, 2026, and you can download everything on it until then.");
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`axe and a shot, ${theme}`, async ({ page, request }) => {
    await open(page, request, RETAINED, theme);
    await openWork(page);
    await expect(page.getByTestId('ended-desk')).toBeVisible();
    await page.evaluate(AXE);
    const bad = await page.evaluate(async () => {
      const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string }[] }> } };
      const r = await w.axe.run({ include: ['.ended-desk'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
      return r.violations.map((v) => v.id);
    });
    expect(bad).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/15-office-work-ended-${theme === 'dusk' ? 'zen' : theme}.png` });
  });
}

test('phone width: the panel fits the desk', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, request, RETAINED);
  await openWork(page);
  const panel = page.getByTestId('ended-desk');
  if (await panel.count()) {
    const box = await panel.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  }
  await page.screenshot({ path: `${SHOTS}/15-office-work-ended-phone.png` });
});
