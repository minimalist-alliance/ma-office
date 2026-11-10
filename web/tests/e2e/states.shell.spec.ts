// Contract 0.3.11: a new member's desks arrive as `requested` or `provisioning` and start on their own, `connect` can
// refuse for the membership or for a desk that can't be opened, and a held desk has `allowedActions: []`. The real
// link against the harness's `connect`, so every call it makes is counted.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, storedRefreshToken, watchConsole, type ThemeId } from './helpers';

const REAL_LINK = '/?link=real';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const BILLING = 'https://platform.localhost/billing';
const SUPPORT = 'support@minimalistalliance.com';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

const desk = (deskId: string, name: string, kind: string, state: string, more: Record<string, unknown> = {}) => ({ deskId, name, kind, state, ...more });
const personal = (state: string, more?: Record<string, unknown>) => desk(PERSONAL, 'Personal', 'personal', state, more);
const work = (state: string, more?: Record<string, unknown>) => desk(WORK, 'Work', 'work', state, more);

interface Harness { connects: { deskId: string; start: unknown }[]; log: string[]; refreshSent: string[] }
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const connectsTo = async (request: APIRequestContext, id: string): Promise<unknown[]> => (await read(request)).connects.filter((c) => c.deskId === id).map((c) => c.start);
const wakes = async (request: APIRequestContext): Promise<number> => (await read(request)).connects.filter((c) => c.start === true).length;
const proxyOf = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^${name} desk, `) });
const meReads = async (request: APIRequestContext): Promise<number> => (await read(request)).log.filter((l) => l === 'GET /v1/me').length;
/** What `GET /v1/me` says while `connect` refuses for the membership, as services/desks does. */
const MEMBERSHIP_FOR: Record<string, string> = { account_suspended: 'suspended', account_inactive: 'ended' };
const refused = (code: string, billingUrl: unknown = BILLING) => ({ refuseConnect: { code, details: { billingUrl } }, membership: { status: MEMBERSHIP_FOR[code], tier: 'officer' } });
const backInTab = (page: Page): Promise<void> => page.evaluate(() => void window.dispatchEvent(new Event('focus')));
const appOf = (page: Page, name: string, app: string): Locator => page.getByRole('group', { name: `${name} desk` }).getByRole('button', { name: app, exact: true });

async function press(locator: Locator): Promise<void> {
  await locator.focus();
  await locator.press('Enter');
}

interface Box { x: number; y: number; w: number; h: number }
const box = (page: Page, id: string): Promise<Box> => page.locator(`[id="proxy-${id}"]`).evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
const apart = (a: Box, b: Box): number => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

/** How much of the harness's log signing in wrote: with HARNESS_SIGN_IN_PATH, that includes a visit to the pages. */
let signedInAt = 0;

/** Signed in as `signIn` does, and the log marked, so only what came after counts against the page. */
async function arrive(page: Page, request: APIRequestContext, path: string): Promise<void> {
  await signIn(page, path);
  signedInAt = (await read(request)).log.length;
}

/** Nothing that ends a member's session since signing in: no sign-in redirect, no sign-out, and the refresh token still there. */
async function expectStillSignedIn(page: Page, request: APIRequestContext): Promise<void> {
  const log = (await read(request)).log.slice(signedInAt);
  expect(log.filter((l) => l.startsWith('GET /_signin/') || l === 'POST /v1/me/sign-out' || l.includes('/logout'))).toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('.ma-shell')).toBeVisible();
  expect(await storedRefreshToken(page)).not.toBeNull();
}

/** The same view in each theme, loaded again from the session the page already has. */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.reload();
    await canvasPainted(page);
    await ready();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/states-${name}-${theme}.png` });
  }
}

test.beforeEach(async ({ request }) => {
  signedInAt = 0;
  await harness(request, { reset: true });
});

test.describe('a new member: desks still being set up', () => {
  test('two new desks are drawn apart, say they are being set up, and nothing asks them anything until one runs', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { fleet: [personal('provisioning'), work('requested')] });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, setting up…$/);
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, setting up…$/);
    expect(apart(await box(page, PERSONAL), await box(page, WORK))).toBeGreaterThanOrEqual(24 - 0.011);
    await expect(page.locator('.desk-nav-label')).toContainText('of 2'); // the overview, with both

    // Focusing one and opening its Browser send nothing, and the window says why it's empty.
    await press(proxyOf(page, 'Personal'));
    await press(appOf(page, 'Personal', 'Browser'));
    const panel = page.getByTestId('browser-panel');
    await expect(panel).toHaveAttribute('data-panel', 'settingUp');
    await expect(panel).toHaveText('This desk is still being set up');
    await expect(page.getByTestId('browser-address')).toBeDisabled(); // nothing typed could go anywhere
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/shots/states-setting-up-window.png' });

    // The list is read at its own 2 s pace meanwhile: often enough to see the change, never in a loop.
    const before = (await read(request)).log.filter((l) => l === 'GET /v1/desks').length;
    await page.waitForTimeout(6_000);
    const polls = (await read(request)).log.filter((l) => l === 'GET /v1/desks').length - before;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
    expect((await read(request)).connects).toEqual([]);

    // Personal runs: the next read of the list opens its link, with no reload. Work still sends nothing.
    await harness(request, { fleet: [personal('running'), work('provisioning')] });
    await expect(proxyOf(page, 'Personal')).not.toHaveAccessibleName(/setting up/, { timeout: 5_000 });
    await expect.poll(() => connectsTo(request, PERSONAL)).toContain(false);
    await expect(panel).not.toHaveAttribute('data-panel', 'settingUp');
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, setting up…$/);
    expect(await connectsTo(request, WORK)).toEqual([]);
    expect(await wakes(request)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('one new desk: arriving on it wakes nothing, and once it runs, nothing has to', async ({ page, request }) => {
    await harness(request, { fleet: [personal('provisioning')] });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, setting up…$/);
    await page.waitForTimeout(3_000);
    expect((await read(request)).connects).toEqual([]);
    await harness(request, { fleet: [personal('running')] });
    await expect.poll(() => connectsTo(request, PERSONAL), { timeout: 5_000 }).toEqual([false]);
    await page.waitForTimeout(1_000);
    expect(await wakes(request)).toBe(0);
  });

  test('looks calm in every theme', async ({ page, request }) => {
    await harness(request, { fleet: [personal('provisioning'), work('requested')] });
    await arrive(page, request, REAL_LINK);
    await shoot(page, 'setting-up', () => expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, setting up…$/));
    expect((await read(request)).connects).toEqual([]);
  });
});

test.describe('the membership refused', () => {
  for (const code of ['account_suspended', 'account_inactive']) {
    test(`${code}: one calm notice with the billing link, no retry, no redirect, no sign-out`, async ({ page, request }) => {
      const errors = watchConsole(page);
      // A desk being set up keeps the list at its 2 s pace, so a poll that retried would show here.
      await harness(request, { fleet: [personal('running'), desk('d-guild00000001', 'Guild', 'guild', 'stopped'), work('provisioning')], ...refused(code) });
      await arrive(page, request, REAL_LINK);
      await canvasPainted(page);
      const notice = page.getByTestId('office-notice');
      await expect(notice).toHaveText('Your membership is not active. Billing');
      await expect(notice.getByTestId('billing-link')).toHaveAttribute('href', BILLING);
      await expect(page.getByTestId('office-notice')).toHaveCount(1);
      await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, membership not active$/);
      await expect(proxyOf(page, 'Guild')).toHaveAccessibleName(/, membership not active$/);
      await page.waitForTimeout(7_000);
      expect(await connectsTo(request, PERSONAL)).toEqual([false]);
      expect(await connectsTo(request, 'd-guild00000001')).toEqual([false]);

      // Focusing a refused desk, or coming back to the tab, reads the membership at most once in 15 s, and never
      // asks `connect`: it's still not active, so nothing changes.
      const reads = await meReads(request);
      await press(proxyOf(page, 'Guild'));
      await backInTab(page);
      await press(proxyOf(page, 'Personal'));
      await page.waitForTimeout(1_000);
      expect(await meReads(request)).toBeLessThanOrEqual(reads + 1);
      expect(await connectsTo(request, PERSONAL)).toEqual([false]);
      expect(await connectsTo(request, 'd-guild00000001')).toEqual([false]);
      expect(await wakes(request)).toBe(0);
      await expect(page.getByTestId('office-notice')).toHaveCount(1);
      await expectStillSignedIn(page, request);
      // The app logs nothing of its own. Chromium notes each 403 it was given: one per desk, so nothing went twice.
      expect(errors.filter((e) => !e.startsWith('Failed to load resource: the server responded with a status of 403'))).toEqual([]);
      expect(errors).toHaveLength(2);
    });
  }

  test('paid since: coming back to the tab reads the membership once, and the desks come back with start: false', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { fleet: [personal('running'), work('stopped')], ...refused('account_suspended') });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    await expect(page.getByTestId('office-notice')).toBeVisible();
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, membership not active$/);
    // Paid in the billing tab: services/desks stops refusing at once, with no other step.
    await harness(request, { refuseConnect: null, membership: { status: 'active', tier: 'officer' } });
    const reads = await meReads(request);
    await backInTab(page);
    await expect(page.getByTestId('office-notice')).toHaveCount(0);
    await expect(proxyOf(page, 'Work')).not.toHaveAccessibleName(/membership/);
    await expect.poll(() => connectsTo(request, PERSONAL)).toEqual([false, false]);
    await expect.poll(() => connectsTo(request, WORK)).toEqual([false, false]);
    expect(await meReads(request)).toBe(reads + 1);
    // Nothing is refused now, so another return reads nothing.
    await backInTab(page);
    await page.waitForTimeout(500);
    expect(await meReads(request)).toBe(reads + 1);
    expect(await wakes(request)).toBe(0);
    // Two 403s, one per desk, before paying.
    expect(errors.filter((e) => !e.startsWith('Failed to load resource: the server responded with a status of 403'))).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  test('a bad billing link: the notice shows without one', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running')], ...refused('account_suspended', 'http://evil.localhost/billing') });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    const notice = page.getByTestId('office-notice');
    await expect(notice).toHaveText('Your membership is not active.');
    await expect(notice.getByRole('link')).toHaveCount(0);
  });

  test('a window open when the refusal arrives says so, with no spinner and no retry', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running')] });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    await press(appOf(page, 'Personal', 'Browser'));
    const panel = page.getByTestId('browser-panel');
    await expect(panel).toHaveAttribute('data-panel', 'opening');
    await harness(request, refused('account_suspended'));
    await expect(panel).toHaveAttribute('data-panel', 'membership', { timeout: 15_000 }); // the link's next not-ready check
    await expect(panel.getByTestId('billing-link')).toHaveAttribute('href', BILLING);
    await expect(panel.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByTestId('browser-address')).toBeDisabled();
    const asked = (await connectsTo(request, PERSONAL)).length;
    await page.waitForTimeout(12_000);
    expect(await connectsTo(request, PERSONAL)).toHaveLength(asked);
    await page.screenshot({ path: 'test-results/shots/states-membership-window.png' });
    await expectStillSignedIn(page, request);
  });

  test('looks calm in every theme', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('stopped')], ...refused('account_suspended') });
    await arrive(page, request, REAL_LINK);
    await shoot(page, 'membership', () => expect(page.getByTestId('office-notice')).toBeVisible());
  });
});

test.describe("a desk that can't be opened", () => {
  test('desk_unavailable from connect: the support address and nothing else, asked once', async ({ page, request }) => {
    await harness(request, { fleet: [personal('stopped', { refuse: 'desk_unavailable' }), work('provisioning')] });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    const notice = page.getByTestId('office-notice');
    await expect(notice).toHaveText(SUPPORT);
    await expect(notice.getByRole('link')).toHaveAttribute('href', `mailto:${SUPPORT}`);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(`Personal desk, 4 apps, ${SUPPORT}`);
    await press(proxyOf(page, 'Personal'));
    await page.waitForTimeout(6_000);
    expect(await connectsTo(request, PERSONAL)).toEqual([false]);
    await expectStillSignedIn(page, request);
  });

  test('allowedActions: [] offers nothing and is never asked: no connect, no wake, no window', async ({ page, request }) => {
    await harness(request, { fleet: [personal('stopped', { allowedActions: [] }), work('running')] });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(`Personal desk, 4 apps, ${SUPPORT}`);
    await expect(page.getByTestId('office-notice')).toHaveText(SUPPORT);
    await press(proxyOf(page, 'Personal'));
    await press(appOf(page, 'Personal', 'Browser'));
    await press(appOf(page, 'Personal', 'Notebook'));
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-testid^="window-"]')).toHaveCount(0);
    expect(await connectsTo(request, PERSONAL)).toEqual([]);
    expect(await wakes(request)).toBe(0);
    // Moving it is only layout, and stays.
    await press(proxyOf(page, 'Personal'));
    await page.keyboard.press('m');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect(await connectsTo(request, PERSONAL)).toEqual([]);
  });

  test('a hold that lands on a running desk closes what was open, and a window says only the address', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('provisioning')] });
    await arrive(page, request, REAL_LINK);
    await canvasPainted(page);
    await press(appOf(page, 'Personal', 'Browser'));
    const panel = page.getByTestId('browser-panel');
    await expect(panel).toHaveAttribute('data-panel', 'opening');
    await harness(request, { fleet: [personal('running', { allowedActions: [] }), work('provisioning')] });
    await expect(panel).toHaveAttribute('data-panel', 'support', { timeout: 5_000 });
    await expect(panel).toHaveText(SUPPORT);
    await expect(page.getByTestId('browser-address')).toBeDisabled();
    const asked = (await connectsTo(request, PERSONAL)).length;
    await page.waitForTimeout(8_000);
    expect(await connectsTo(request, PERSONAL)).toHaveLength(asked);
    await page.screenshot({ path: 'test-results/shots/states-support-window.png' });
  });

  test('looks calm in every theme', async ({ page, request }) => {
    await harness(request, { fleet: [personal('stopped', { allowedActions: [] }), work('running')] });
    await arrive(page, request, REAL_LINK);
    await shoot(page, 'held', () => expect(page.getByTestId('office-notice')).toBeVisible());
  });
});

test('the mock link knows the refusals too: ?refuse=', async ({ page, request }) => {
  await harness(request, { fleet: [personal('running')] });
  await arrive(page, request, `/?refuse=account_inactive&billing=${encodeURIComponent(BILLING)}`);
  await canvasPainted(page);
  await expect(page.getByTestId('office-notice')).toHaveText('Your membership is not active. Billing');
  await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, membership not active$/);
});
