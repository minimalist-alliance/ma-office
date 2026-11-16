// A kept Personal desk's own panel (Terms 6 "When a paid membership ends"; Sales' `business/ended-membership-copy.md` 1A, "Stopped,
// kept for you to download"): a Free member whose paid Personal desk couldn't be their Free desk (an instance of its own) finds
// it on the canvas with its tiles dimmed, and opening it says why it's stopped, that it's kept with its data and nothing is
// deleted, that it returns on moving back up, with Download your data and Move back up. It waits while "You're on {Free} now"
// says the same over the desks. The panel is its own chunk, fetched only when the list holds such a desk. Axe in three themes;
// shots in test-results/ended-personal/.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SHOTS = 'test-results/ended-personal';
const A = 'd-personal00001';
const BILLING = 'https://platform.localhost/billing';
const KEPT = { deskId: A, name: 'Personal', kind: 'personal', state: 'stopped', phase: 'stopped', notInPlan: true, allowedActions: ['export'], stateChangedAt: '2026-12-01T18:04:00Z' };
const TITLE = 'Your Personal desk stopped on December 1';
const BODY = "It can't be your Free desk, so it's kept for you to download, with its files, tabs and sign-ins. Nothing is deleted, and it returns when you move back up.";
const layout = { desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] } }, z: [A] };

async function open(page: Page, request: APIRequestContext, extra: Record<string, unknown> = {}, theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await page.addInitScript((d) => {
    // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout));
  await harness(request, { fleet: [KEPT], membership: { status: 'active', tier: 'free' }, configExtra: { links: { billing: BILLING } }, export: { enabled: true, moves: true }, ...extra });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600);
  return errors;
}

async function openPersonal(page: Page): Promise<void> {
  await page.locator(`[id="proxy-${A}"]`).focus();
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a Free member\'s kept Personal desk says why, what happens next and how to come back, on the desk in view', async ({ page, request }) => {
  const errors = await open(page, request);
  await openPersonal(page);
  const panel = page.getByTestId('ended-desk');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-kind', 'personal');
  await expect(panel).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('ended-desk-title')).toHaveText(TITLE);
  await expect(page.getByTestId('ended-desk-body')).toHaveText(BODY);
  await expect(panel).not.toContainText(/Sorry|!|free member/);
  const up = page.getByTestId('ended-desk-moveup');
  await expect(up).toHaveText('Move back up (opens in a new tab)');
  await expect(up).toHaveAttribute('href', BILLING);
  await expect(up).toHaveAttribute('target', '_blank');
  expect(errors).toEqual([]);
  // Download your data opens Account settings at Your data, as on the Work desk's panel (its account frame is the harness's
  // CSP's to refuse, so no console check after).
  await page.getByTestId('ended-desk-download').click();
  await expect(page.getByRole('dialog', { name: /Account settings/i })).toBeVisible();
});

test('while "You\'re on Free now" shows over the desks, the panel waits: the card says the same', async ({ page, request }) => {
  const STEPPED = { status: 'active', tier: 'free', monthlyUsd: 0, steppedDown: { from: 'alliance', at: '2026-12-01T18:04:00Z' }, actions: { checkout: true } };
  await open(page, request, {
    platformBilling: { enabled: true, officerMonthlyUsd: 100, allianceMonthlyUsd: 10 },
    platformFree: { open: true, monthlyUsd: 0, minimumAge: 13, desks: 1, browserMinutesPerDay: 45, filesGb: 2, idleStopMinutes: 30 },
    billingStatus: STEPPED,
  });
  await expect(page.getByRole('region', { name: "You're on Free now" })).toBeVisible();
  await openPersonal(page);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('ended-desk')).toHaveCount(0);
});

test('a running Personal desk has no panel, and its chunk never loads', async ({ page, request }) => {
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/EndedDeskPanel/.test(r.url())) chunks.push(r.url());
  });
  await open(page, request, { fleet: [{ ...KEPT, state: 'running', phase: 'ready', notInPlan: undefined, allowedActions: ['connect', 'stop'] }] });
  await openPersonal(page);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('ended-desk')).toHaveCount(0);
  expect(chunks).toEqual([]);
});

for (const theme of THEMES) {
  test(`axe and a shot, ${theme}, desktop and phone`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, request, {}, theme);
    await openPersonal(page);
    await expect(page.getByTestId('ended-desk')).toBeVisible();
    await page.evaluate(AXE);
    const run = (): Promise<string[]> => page.evaluate(async () => {
      const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string }[] }> } };
      const r = await w.axe.run({ include: ['.ended-desk'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
      return r.violations.map((v) => v.id);
    });
    expect(await run()).toEqual([]);
    const name = theme === 'dusk' ? 'zen' : theme;
    await page.screenshot({ path: `${SHOTS}/office-personal-kept-${name}-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const panel = page.getByTestId('ended-desk');
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await run()).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/office-personal-kept-${name}-390.png` });
  });
}
