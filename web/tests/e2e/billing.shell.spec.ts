// The office's parts of the billing launch features (the Product Designer's billing spec, Nov 11): the account menu's card
// line (still 32, `membership.cardExpiresSoon`, ma-platform contract billing.md 0.3.86) and its failed-payment line ahead of
// it (`membership.billingNote`, not built), and "Stops on {date}" in a Work desk's menu (still 14, the desk's `endsAt`, not
// built). Each shows only while Platform sends its field; without them the menus are today's. Axe in all three themes;
// shots in test-results/billing142/.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SHOTS = 'test-results/billing142';

const A = 'd-personal00001';
const B = 'd-work000000001';
const ENDS = '2026-12-01T18:04:00Z';
const fleet = (workEnds: string | null = null) => [
  { deskId: A, name: 'Personal', kind: 'personal', state: 'running', allowedActions: ['connect', 'stop'] },
  { deskId: B, name: 'Work', kind: 'work', state: 'running', allowedActions: ['connect', 'stop'], ...(workEnds ? { endsAt: workEnds } : {}) },
];
const layout = {
  desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] }, [B]: { id: B, x: 640, y: 0, w: 584, h: 360, items: [] } },
  z: [A, B],
};
const CARD = { month: 11, year: 2099, last4: '4242' };
const BILLING = 'https://platform.localhost/billing';

async function open(page: Page, request: APIRequestContext, patch: Record<string, unknown>, theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await page.addInitScript((d) => {
    // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout));
  // The billing page on a sibling host, as client-config's `links.billing` has it in production (`platform/hosts.ts`).
  await harness(request, { fleet: fleet(), membership: { status: 'active', tier: 'officer', badge: 'officer' }, configExtra: { links: { billing: BILLING } }, ...patch });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600); // the camera lands
  return errors;
}

const accountButton = (page: Page): Locator => page.getByRole('button', { name: 'Account', exact: true });
const accountMenu = (page: Page): Locator => page.getByRole('dialog', { name: 'Account' });
const deskMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Desk' });

async function openAccount(page: Page): Promise<void> {
  await expect(accountButton(page).locator('.avatar')).toBeVisible();
  await accountButton(page).click();
  await expect(accountMenu(page).locator('.menu-me')).toBeVisible();
}

async function openDeskMenu(page: Page, id: string): Promise<void> {
  await page.locator(`[id="proxy-${id}"]`).focus();
  await page.keyboard.press('.');
  await expect(deskMenu(page)).toBeVisible();
}

async function axe(page: Page, include: string[]): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (inc) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const sheet = document.styleSheets[0]!;
    const at = sheet.insertRule('.ma-shell::before { content: none !important; }', sheet.cssRules.length);
    sheet.insertRule('.window-layer { display: none !important; }', at + 1);
    try {
      const r = await w.axe.run({ include: inc }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
      return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    } finally {
      sheet.deleteRule(at + 1);
      sheet.deleteRule(at);
    }
  }, include);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('an older Platform: today\'s menus', () => {
  test('no card line in the account menu, and no Stops on in the Work desk menu', async ({ page, request }) => {
    const errors = await open(page, request, {});
    await openAccount(page);
    await expect(page.getByTestId('menu-billing-note')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await openDeskMenu(page, B);
    await expect(page.getByTestId('desk-menu-stops')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('the account menu (still 32)', () => {
  test('the card line under the tier, its link the first Tab stop, opening billing in a new tab', async ({ page, request }) => {
    const errors = await open(page, request, { membership: { status: 'active', tier: 'officer', badge: 'officer', cardExpiresSoon: CARD } });
    await openAccount(page);
    const note = page.getByTestId('menu-billing-note');
    await expect(note).toHaveText('Card ending 4242 expires 11/99. Update card');
    const link = note.getByRole('link', { name: 'Update card' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', BILLING);
    await expect(note).not.toHaveClass(/menu-note-failed/);
    // The panel's first Tab stop.
    const first = await page.evaluate(() => {
      const panel = document.getElementById('account-panel')!;
      const f = panel.querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      return f?.textContent?.trim();
    });
    expect(first).toBe('Update card');
    expect(errors).toEqual([]);
  });

  test('a failed payment comes first, in the danger color', async ({ page, request }) => {
    await open(page, request, { membership: { status: 'past_due', tier: 'officer', badge: 'officer', cardExpiresSoon: CARD, billingNote: { kind: 'payment_failed', stopsAt: ENDS } } });
    await openAccount(page);
    const note = page.getByTestId('menu-billing-note');
    await expect(note).toHaveText("Your last payment didn't go through. Pay now");
    await expect(note).toHaveClass(/menu-note-failed/);
  });

  for (const theme of THEMES) {
    test(`axe and a shot, ${theme}`, async ({ page, request }) => {
      await open(page, request, { membership: { status: 'active', tier: 'officer', badge: 'officer', cardExpiresSoon: CARD } }, theme);
      await openAccount(page);
      await expect(page.getByTestId('menu-billing-note')).toBeVisible();
      expect(await axe(page, ['#account-panel'])).toEqual([]);
      await page.screenshot({ path: `${SHOTS}/32-office-menu-card-expiring-${theme === 'dusk' ? 'zen' : theme}.png` });
    });
  }
});

test.describe('the Work desk menu (still 14)', () => {
  test('"Stops on December 1" under its kind, said as the menu\'s description, not focusable', async ({ page, request }) => {
    const errors = await open(page, request, { fleet: fleet(ENDS) });
    await openDeskMenu(page, B);
    const stops = page.getByTestId('desk-menu-stops');
    await expect(stops).toHaveText('Stops on December 1');
    const described = await deskMenu(page).getAttribute('aria-describedby');
    expect(described?.split(' ')).toContain(await stops.getAttribute('id'));
    await expect(stops).not.toHaveAttribute('tabindex');
    await page.keyboard.press('Escape');
    await openDeskMenu(page, A);
    await expect(page.getByTestId('desk-menu-stops')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  for (const theme of THEMES) {
    test(`axe and a shot, ${theme}`, async ({ page, request }) => {
      await open(page, request, { fleet: fleet(ENDS) }, theme);
      await openDeskMenu(page, B);
      await expect(page.getByTestId('desk-menu-stops')).toBeVisible();
      expect(await axe(page, ['.desk-menu'])).toEqual([]);
      await page.screenshot({ path: `${SHOTS}/14-office-work-menu-ending-${theme === 'dusk' ? 'zen' : theme}.png` });
    });
  }
});
