// The close hold's notice in the office (ma-platform contract auth.md section 2.7; `src/closehold/`, whose `words.test.ts`
// has the words' rules). `GET /v1/me` carries `notices: [{kind: "close_hold_cancelled", at, requestedAt}]` after a request to
// close the account was stopped by its use: the office shows one card among its notices, says it once, never takes focus,
// and "Got it" dismisses it for every app. Shots in the three themes at 1280 and 390 go to test-results/close-hold/.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = 'test-results/close-hold';
const KIND = 'close_hold_cancelled';
const NOTICE = { kind: KIND, at: '2026-11-14T09:30:00.000Z', requestedAt: '2026-11-12T10:00:00.000Z' };
const TITLE = 'We stopped a request to close your account';
const BODY = "On November 12, 2026, someone writing from this account's email address asked us to close it. Your account was used on November 14, 2026, so the account stays open and nothing was deleted.";
const BODY_NO_DAY = "Someone writing from this account's email address asked us to close it. Your account was used on November 14, 2026, so the account stays open and nothing was deleted.";
const NOT_YOU = "If that wasn't you, someone may be able to read your email. Change your email password.";
const FAILED = "That didn't save. Try again.";
const fleet = [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' }];

const card = (page: Page) => page.getByTestId('close-hold-notice');
const gotIt = (page: Page) => card(page).getByRole('button', { name: 'Got it', exact: true });

type Said = { __said: string[] };
/** Every line the shell's polite live region says on this page, in order. Set up before the first navigation. */
async function watchSaid(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const said: string[] = [];
    (window as unknown as Said).__said = said;
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="live-region"]')?.textContent ?? '';
      if (t && said[said.length - 1] !== t) said.push(t);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}
const said = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as Said).__said);

async function office(page: Page, request: APIRequestContext, extra: Record<string, unknown> = {}): Promise<void> {
  await harness(request, { fleet, notices: [NOTICE], ...extra });
  await signIn(page);
  await canvasPainted(page);
}

const harnessState = async (request: APIRequestContext): Promise<{ noticeDismisses: { kind: string; auth: string | null; body: string; status: number }[]; log: string[] }> =>
  (await request.post('/__harness', { data: {} })).json();

const focusInCard = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('[data-testid="close-hold-notice"]'));

/** Tab from the top of the page until "Got it" has focus: it's in the keyboard's reach. */
async function tabToGotIt(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 120; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'close-hold-dismiss')) return;
  }
  throw new Error('Tab never reached "Got it"');
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } };
    const r = await w.axe.run(
      { include: ['[data-testid="close-hold-notice"]'] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] },
    );
    return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 120)}`));
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('it shows once /v1/me carries it: a card among the notices with its heading and the words, said once, and focus stays put', async ({ page, request }) => {
  const errors = watchConsole(page);
  await watchSaid(page);
  await office(page, request);
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.notices [data-testid="close-hold-notice"]')).toHaveCount(1);
  await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(TITLE);
  await expect(page.getByRole('region', { name: TITLE })).toBeVisible();
  await expect(card(page)).toContainText(BODY);
  await expect(card(page)).toContainText(NOT_YOU);
  // No passkey line: `/v1/me` doesn't say whether the member has one, so `/account` says it.
  await expect(card(page)).not.toContainText(/passkey/i);
  await expect(card(page)).not.toContainText('@');
  await expect(card(page).getByTestId('close-hold-error')).toHaveCount(0);
  // Said politely, once, through the shell's region; the card itself isn't live.
  await expect.poll(() => said(page)).toContain(`${TITLE}. ${BODY}`);
  await expect(card(page)).not.toHaveAttribute('aria-live');
  expect(await focusInCard(page)).toBe(false);
  await page.waitForTimeout(600);
  expect((await said(page)).filter((s) => s.startsWith(TITLE))).toHaveLength(1);
  expect(await focusInCard(page)).toBe(false);
  // In the keyboard's reach, and nothing was asked of the dismiss yet.
  await tabToGotIt(page);
  expect((await harnessState(request)).noticeDismisses).toEqual([]);
  expect(errors).toEqual([]);
});

test('with no request day it says when the account was used; a teen gets it the same way', async ({ page, request }) => {
  await office(page, request, { notices: [{ ...NOTICE, requestedAt: null }], age: 'teen' });
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText(BODY_NO_DAY);
  await expect(card(page)).not.toContainText('On November');
});

test('"Got it": one POST with the office\'s token and no body; the card goes, focus goes back, it\'s said, and a reload agrees', async ({ page, request }) => {
  const errors = watchConsole(page);
  await watchSaid(page);
  await office(page, request);
  await tabToGotIt(page);
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveCount(0);
  const { noticeDismisses } = await harnessState(request);
  expect(noticeDismisses.map((d) => [d.kind, d.status, d.body])).toEqual([[KIND, 200, '']]);
  expect(noticeDismisses[0]!.auth).toMatch(/^Bearer \S+$/);
  await expect.poll(() => said(page)).toContain('Notice dismissed.');
  // Back where the keyboard came into the card from, never left on the page itself.
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true);
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  await expect(card(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a dismiss that fails keeps the card and says so, with focus on the button; the next try works', async ({ page, request }) => {
  await office(page, request, { noticeDismissFail: { status: 503, times: 1 } });
  await gotIt(page).click();
  const error = card(page).getByRole('alert');
  await expect(error).toHaveText(FAILED);
  await expect(card(page)).toBeVisible();
  await expect(gotIt(page)).toBeFocused();
  await gotIt(page).click();
  await expect(card(page)).toHaveCount(0);
  expect((await harnessState(request)).noticeDismisses.map((d) => d.status)).toEqual([503, 200]);
});

test('another kind, one whose at isn\'t a time, or none at all draws nothing; another kind fetches no card code', async ({ page, request }) => {
  const errors = watchConsole(page);
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));
  await office(page, request, { notices: [{ kind: 'something_new', at: NOTICE.at }] });
  await page.waitForTimeout(600);
  await expect(card(page)).toHaveCount(0);
  expect(asked.filter((u) => /\/assets\/Card-[\w-]+\.js$/.test(u))).toEqual([]);

  await harness(request, { notices: [{ kind: KIND, at: 'yesterday', requestedAt: NOTICE.requestedAt }] });
  await page.reload();
  await canvasPainted(page);
  await page.waitForTimeout(400);
  await expect(card(page)).toHaveCount(0);

  await harness(request, { notices: null });
  await page.reload();
  await canvasPainted(page);
  await expect(card(page)).toHaveCount(0);
  expect((await harnessState(request)).noticeDismisses).toEqual([]);
  expect(errors).toEqual([]);
});

test('Account settings hides it while open, and /v1/me is read again when it closes: gone if dismissed there, else back, unsaid', async ({ page, request }) => {
  await watchSaid(page);
  await office(page, request);
  await expect(card(page)).toBeVisible();
  const reads = async () => (await harnessState(request)).log.filter((l) => l === 'GET /v1/me').length;

  // Closed with the notice still there: back, and not said again.
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account settings', exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  let before = await reads();
  await page.getByTestId('account-settings-close').click();
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(card(page)).toBeVisible();
  expect((await said(page)).filter((s) => s.startsWith(TITLE))).toHaveLength(1);

  // Dismissed in the framed /account meanwhile: gone once it closes.
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await harness(request, { notices: [] });
  before = await reads();
  await page.getByTestId('account-settings-close').click();
  await expect.poll(reads).toBeGreaterThan(before);
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);
  expect((await harnessState(request)).noticeDismisses).toEqual([]);
});

for (const width of [1280, 390]) {
  test(`with no desks at ${width}: it takes the office's own card's place until "Got it", then that card shows and is said`, async ({ page, request }) => {
    await watchSaid(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await harness(request, { desks: 'unpaid', membership: { status: 'unpaid' }, notices: [NOTICE] });
    await signIn(page);
    await expect(card(page)).toBeVisible();
    const own = page.locator('section.desk-notice');
    await expect(own).toHaveCount(1);
    await expect(own).toBeHidden();
    // Centered on the screen, as the office's card is, and whole.
    await page.waitForTimeout(300);
    const b = (await card(page).boundingBox())!;
    expect(Math.abs(b.x + b.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(b.y).toBeGreaterThanOrEqual(64);
    await page.screenshot({ path: `${SHOTS}/close-hold-no-desks-light-${width}.png` });
    expect(await axe(page)).toEqual([]);
    await gotIt(page).click();
    await expect(card(page)).toHaveCount(0);
    await expect(own).toBeVisible();
    await expect(own.getByRole('heading', { level: 2 })).toHaveText('Welcome to your office');
    await expect.poll(() => said(page)).toContain('Notice dismissed. Welcome to your office.');
  });
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  for (const width of [1280, 390]) {
    test(`axe and shots, ${theme} at ${width}: the card, then a failed dismiss`, async ({ page, request }) => {
      const name = theme === 'dusk' ? 'zen' : theme;
      await setTheme(page, theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await office(page, request, { noticeDismissFail: { status: 503 } });
      await expect(card(page)).toBeVisible();
      await page.waitForTimeout(300);
      expect(await axe(page)).toEqual([]);
      // The card fits the width, with the 16 px gutters.
      const box = (await card(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(15);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 15);
      await page.screenshot({ path: `${SHOTS}/close-hold-${name}-${width}.png` });
      await gotIt(page).click();
      await expect(card(page).getByRole('alert')).toHaveText(FAILED);
      await gotIt(page).blur();
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `${SHOTS}/close-hold-${name}-${width}-failed.png` });
    });
  }
}
