// A closed account in the office (S-152; ma-platform contract moderation.md section 8; chrome/membershipCards.tsx
// `closedCard`, card X): the harness answers as a closed account's office token is answered (`closedAccount`). The card
// in Sales' words over the dimmed desks, the download through the office's own export page, nothing to start, rejoin or
// buy anywhere, the plain line once the window has passed, and an `account_closed` from any API mid-session switching to
// the card. Axe in three themes at 1280 and 390. Shots in $CLOSED_SHOTS, else test-results/account-closed.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SHOTS = process.env['CLOSED_SHOTS'] ?? 'test-results/account-closed';
mkdirSync(SHOTS, { recursive: true });
const ZONE = 'America/Denver';
const DAY = 86_400_000;
const SUPPORT = 'support@minimalistalliance.com';
const DESK = 'd-testk3m7q2x7';
const WORK = 'd-work000000001';
const FLEET = [
  { deskId: DESK, name: 'Personal', kind: 'personal', state: 'stopped', badges: { total: 2, apps: { browser: 2 } } },
  { deskId: WORK, name: 'Work', kind: 'work', state: 'stopped' },
];
const UNTIL = new Date(Date.now() + 19 * DAY).toISOString();
const PASSED = new Date(Date.now() - 2 * DAY).toISOString();
/**
 * What identity sends a closed account (contract moderation.md section 8, 0.3.117 draft amended Nov 12): ended, stopped by
 * other, no dates, `closed`, and the pair `exportUntil` and `held` (`null` and `true` when the ban held the export).
 * `undefined` here: neither, as from an identity before the pair.
 */
const closedMe = (exportUntil?: string | null): Record<string, unknown> => ({
  status: 'ended', tier: 'officer', badge: null, stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null, closed: true,
  ...(exportUntil === undefined ? {} : exportUntil === null ? { exportUntil: null, held: true } : { exportUntil, held: false }),
});
/** Everything that could offer a way back: billing's page, Pay open, the export page and the move. */
const SETUP = {
  closedAccount: true, fleet: FLEET, export: { enabled: true, moves: true }, maia: {},
  configExtra: { links: { billing: 'https://platform.localhost/billing' } }, accountLink: 'https://platform.localhost/account',
  platformBilling: { enabled: true, officerMonthlyUsd: 100, allianceMonthlyUsd: 10 },
};

function dateOf(iso: string): string {
  const y = (d: Date) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: ZONE }).format(d);
  const same = y(new Date(iso)) === y(new Date());
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: ZONE, ...(same ? {} : { year: 'numeric' }) }).format(new Date(iso));
}
const DATED = `You can download your data until ${dateOf(UNTIL)}. After that we delete it, as our Terms say.`;
const PLAIN = `If you have questions, write to ${SUPPORT}.`;

const card = (page: Page): Locator => page.getByRole('region', { name: 'This account is closed' });
const logOf = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log;
const desksOpacity = (page: Page) => page.evaluate(() => (window as unknown as { __maDesk: { desksOpacity: () => number | null } }).__maDesk.desksOpacity());
/** The browser's own line for each refused call: a closed account's office asks a few things before `/v1/me` says closed. */
const real = (errors: string[]): string[] => errors.filter((e) => !/^Failed to load resource: the server responded with a status of 403/.test(e));

/** The desk controls do nothing for a closed account, so none shows (the Designer's review); the account menu stays, to sign out. */
async function noDeskControls(page: Page): Promise<void> {
  await expect(page.locator('.bottombar')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Switch desk' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Zoom' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Zoom/ })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Scope' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Scope/ })).toHaveCount(0);
  await expect(page.locator('.home-mark-btn[data-home]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
}

/** Nothing anywhere on the page offers a way back in, a tier or a trial. */
async function offersNothing(page: Page): Promise<void> {
  const back = /Rejoin|Join again|See membership|Update payment|Pay now|Start|Upgrade|Move back up|Try Maia|How joining works/i;
  await expect(page.getByRole('link', { name: back })).toHaveCount(0);
  await expect(page.getByRole('button', { name: back })).toHaveCount(0);
  await expect(page.getByTestId('desks-inactive')).toHaveCount(0); // never card F
  await expect(page.getByTestId('menu-billing-note')).toHaveCount(0);
}

async function settled(page: Page): Promise<void> {
  await expect(card(page)).toBeVisible();
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string }[] }> } };
    const r = await w.axe.run({ include: ['.desk-notice'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => v.id);
  });
}

async function fits(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const b = (await card(page).boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width - 16 + 0.5);
  expect(b.y).toBeGreaterThan(bar.y + bar.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
}

test.use({ timezoneId: ZONE });

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('inside its window: Sales\' words with the date, over the dimmed desks, and nothing to start, rejoin or buy', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { ...SETUP, membership: closedMe(UNTIL) });
  await signIn(page);
  const x = card(page);
  await expect(x).toHaveAttribute('data-card', 'X');
  await expect(x.getByRole('heading', { level: 2 })).toHaveText('This account is closed');
  await expect(x.locator('p')).toHaveText(DATED);
  await expect(x.locator('b')).toHaveText(dateOf(UNTIL));
  await expect(x.getByRole('link', { name: 'Download your data' })).toHaveAttribute('href', '/export');
  await expect(x.getByRole('link', { name: 'Write to us' })).toHaveAttribute('href', `mailto:${SUPPORT}`);
  await expect(x.getByRole('link')).toHaveCount(2);
  await expect(x.getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('live-region')).toHaveText(`This account is closed. ${DATED}`);
  // The desks are behind it at 35 percent, with no counts, as behind C and D.
  await expect.poll(() => desksOpacity(page)).toBe(0.35);
  await expect(page.getByRole('button', { name: /unread/ })).toHaveCount(0);
  await offersNothing(page);
  await noDeskControls(page);
  // The account menu: signing out, and no billing line.
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await offersNothing(page);
  await page.keyboard.press('Escape');
  // What the office asked before `/v1/me` said closed is refused once each; from the card on, only what a closed account
  // may ask (contract section 8), and never Platform's offer.
  const log = await logOf(request);
  console.log(`refused while loading: ${log.filter((l) => !/^(GET \/v1\/me|GET \/v1\/desks|list 304|POST \/fake-auth|GET \/fake-auth)/.test(l)).join(', ')}`);
  expect(log).not.toContain('client-config platform-web');
  await page.waitForTimeout(2500);
  const later = (await logOf(request)).slice(log.length);
  expect(later.filter((l) => !/^(GET \/v1\/me|GET \/v1\/desks|list 304)$/.test(l))).toEqual([]);
  expect(real(errors)).toEqual([]);
});

test('with no desks listed, the same card', async ({ page, request }) => {
  await harness(request, { ...SETUP, fleet: null, desks: 'empty', membership: closedMe(UNTIL) });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'X');
  await expect(card(page).locator('p')).toHaveText(DATED);
  await offersNothing(page);
});

test('a free member and a teen waiting on a parent get the same card, and nothing of their own', async ({ page, request }) => {
  for (const extra of [{ tier: 'free' }, { ageBand: 'teen', adultFrom: '2029-08-01', parent: 'pending' }]) {
    await harness(request, { ...SETUP, membership: { ...closedMe(UNTIL), ...extra } });
    await signIn(page);
    await expect(card(page)).toHaveAttribute('data-card', 'X');
    await expect(card(page).locator('p')).toHaveText(DATED);
    await offersNothing(page);
    await expect(page.getByTestId('desks-parent')).toHaveCount(0);
  }
});

test('Download your data goes through the office\'s export page, by keyboard, and the desk wakes for the export only', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { ...SETUP, fleet: [FLEET[0]], membership: closedMe(UNTIL) });
  // Chromium's own save picker can't be driven by a test: this one hands out a file in the private storage.
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker: () => Promise<FileSystemFileHandle> }).showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('closed.zip', { create: true });
  });
  await signIn(page);
  const download = card(page).getByRole('link', { name: 'Download your data' });
  await expect(download).toBeVisible();
  await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 12 && !(await download.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(download).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/export$/);
  await expect(page.getByTestId('export-page')).toBeVisible();
  // As an ended member's page, with the window's end as its date, and no move: a closed account's desks can't move.
  const until = new Date(UNTIL).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: ZONE });
  await expect(page.getByTestId('export-ended')).toHaveText(`Your membership isn't active. Your desks are kept until ${until}, so you can take everything with you.`);
  await expect(page.getByText(/your own computer/i)).toHaveCount(0);
  await expect(page.getByTestId(`choose-${DESK}`)).toContainText('Personal');
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const h = (await (await request.get('/__harness')).json()) as { connects: { deskId: string; start: unknown; purpose?: string }[]; log: string[] };
  expect(h.connects).toEqual([{ deskId: DESK, start: true, purpose: 'export' }]);
  expect(h.log).toContain('GET /v1/me/export');
  expect(h.log.filter((l) => l.startsWith('GET /v1/moves'))).toEqual([]);
  const size = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('closed.zip')).getFile()).size);
  expect(size).toBeGreaterThan(1000);
  expect(real(errors)).toEqual([]);
});

test('once the window has passed: the plain line, nothing to press but the address', async ({ page, request }) => {
  await harness(request, { ...SETUP, membership: closedMe(PASSED) });
  await signIn(page);
  const x = card(page);
  await expect(x).toHaveAttribute('data-card', 'X');
  await expect(x.locator('p')).toHaveText(PLAIN);
  await expect(x.getByRole('link')).toHaveCount(1);
  await expect(x.getByRole('link', { name: SUPPORT })).toHaveAttribute('href', `mailto:${SUPPORT}`);
  await expect(x).not.toContainText(/download|data/i);
  await expect(page.getByTestId('live-region')).toHaveText(`This account is closed. ${PLAIN}`);
  await offersNothing(page);
});

test('the data held (exportUntil null, held true) reads as a passed window: nothing about the data', async ({ page, request }) => {
  await harness(request, { ...SETUP, membership: closedMe(null) });
  await signIn(page);
  await expect(card(page).locator('p')).toHaveText(PLAIN);
  await expect(card(page)).not.toContainText(/download|data|held/i);
});

test('the card changes by itself as the window ends', async ({ page, request }) => {
  await harness(request, { ...SETUP, membership: closedMe(new Date(Date.now() + 6000).toISOString()) });
  await signIn(page);
  await expect(card(page).getByRole('link', { name: 'Download your data' })).toBeVisible();
  await expect(card(page).locator('p')).toHaveText(PLAIN, { timeout: 15_000 });
  await expect(card(page).getByRole('link', { name: 'Download your data' })).toHaveCount(0);
});

test('neither exportUntil nor held sent (an identity from before them): the download is offered with no line, never a guessed date', async ({ page, request }) => {
  await harness(request, { ...SETUP, membership: closedMe() });
  await signIn(page);
  const x = card(page);
  await expect(x).toHaveAttribute('data-card', 'X');
  await expect(x.locator('p')).toHaveCount(0);
  await expect(x.getByRole('link', { name: 'Download your data' })).toHaveAttribute('href', '/export');
  await expect(x.getByRole('link', { name: 'Write to us' })).toBeVisible();
  await expect(page.getByTestId('live-region')).toHaveText('This account is closed.');
  await offersNothing(page);
});

test('mid-session, an account_closed from any API switches to the card, not the refusal screen, then reads /v1/me for its date', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { ...SETUP, closedAccount: false, fleet: FLEET.map((d) => ({ ...d, allowedActions: ['connect', 'stop'] })), membership: { status: 'active', tier: 'officer' } });
  await signIn(page);
  await expect(page.locator('.topbar')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator('.desk-notice')).toHaveCount(0);
  // Closed now: even the list answers `account_closed`, and `/v1/me` says so too.
  await harness(request, { closedAccount: 'all', membership: closedMe(UNTIL) });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(card(page)).toHaveAttribute('data-card', 'X');
  await expect(card(page).locator('p')).toHaveText(DATED);
  await expect(page.getByTestId('refusal')).toHaveCount(0);
  await expect.poll(() => desksOpacity(page)).toBe(0.35);
  await offersNothing(page);
  await noDeskControls(page);
  expect(real(errors)).toEqual([]);
});

test('mid-session, an account_closed heard before /v1/me says anything: the card, with the download and no date', async ({ page, request }) => {
  await harness(request, { ...SETUP, closedAccount: false, membership: { status: 'active', tier: 'officer' } });
  await signIn(page);
  await expect(page.locator('.topbar')).toBeVisible();
  await harness(request, { closedAccount: 'all' });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(card(page)).toHaveAttribute('data-card', 'X');
  await expect(card(page).locator('p')).toHaveCount(0);
  await expect(card(page).getByRole('link', { name: 'Download your data' })).toBeVisible();
  await expect(page.getByTestId('refusal')).toHaveCount(0);
  // `/v1/me` was asked again when it was heard.
  expect((await logOf(request)).filter((l) => l === 'GET /v1/me').length).toBeGreaterThanOrEqual(2);
});

// ----- axe and the shots: L/Z/D at 1280 and 390, before and after the window's end
for (const theme of THEMES) {
  for (const [size, viewport] of [['1280', { width: 1280, height: 800 }], ['390', { width: 390, height: 844 }]] as const) {
    for (const [when, until] of [['before', UNTIL], ['after', PASSED]] as const) {
      test(`axe and a shot, ${theme} at ${size}, ${when} the window's end`, async ({ page, request }) => {
        const errors = watchConsole(page);
        await harness(request, { ...SETUP, membership: closedMe(until) });
        await page.setViewportSize(viewport);
        await setTheme(page, theme);
        await signIn(page);
        await settled(page);
        await fits(page);
        await noDeskControls(page);
        // A phone's targets are 44 px tall, as on C and D.
        if (size === '390') for (const l of await card(page).locator('a.btn, a.desk-notice-link').all()) expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 0.5);
        expect(await axe(page)).toEqual([]);
        const t = theme === 'light' ? 'L' : theme === 'dusk' ? 'Z' : 'D';
        await page.screenshot({ path: `${SHOTS}/X-${t}-${size}-${when}.png` });
        expect(real(errors)).toEqual([]);
      });
    }
  }
}
