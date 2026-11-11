// The office's membership cards (the membership card proposal; chrome/CalmScreen.tsx, chrome/membershipCards.tsx):
// A, B and F, the only states before billing, and C, D and E from /v1/me's stoppedBy, stoppedAt and dataDeleteAt
// (ma-platform contract desks.md 0.3.69), in all three themes on desktop and phone, by keyboard, by screen reader and
// through axe. Nothing shows until /v1/me has answered, so a paying member never sees a card, however slow it is.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const ACCOUNT = 'https://platform.localhost/account';
/** Platform's own app's billing block where checkout is live (contract billing.md). */
const OPEN = { enabled: true, officerMonthlyUsd: 100 };
/** With the Alliance price that nothing sends yet (STATUS.md), to see the whole of card A as the mockups do. */
const OPEN_ALLIANCE = { ...OPEN, allianceMonthlyUsd: 10 };
const PHONE = { width: 375, height: 667 };

const A_BODY = "Your desks appear here once you're a member: one for your personal life and one for your work, each on its own private desk. Work stays at work. Home stays home.";
const ALLIANCE = 'Want to start smaller? Alliance Member is one small desk with Browser, for $10 a month.';
const B_BODY = "Membership opens soon, and we'll email you when it does. There's nothing to do until then.";
const F_BODY = 'If you think this is a mistake, write to support@minimalistalliance.com.';

// ----- C, D and E: dates around today, read in one time zone, as a member reads them (their own calendar date).
const ZONE = 'America/Denver';
const DAY = 86_400_000;
const BILLING = 'https://platform.localhost/billing';
const STOPPED_AT = new Date(Date.now() - 4 * DAY).toISOString();
const KEPT_UNTIL = new Date(Date.now() + 26 * DAY).toISOString();
const DELETED_ON = new Date(Date.now() - 9 * DAY).toISOString();
/** "December 6", with the year only when it isn't this year's, in the member's time zone (`calendarDate`). */
function dateOf(iso: string): string {
  const y = (d: Date) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: ZONE }).format(d);
  const same = y(new Date(iso)) === y(new Date());
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: ZONE, ...(same ? {} : { year: 'numeric' }) }).format(new Date(iso));
}
const C_BODY = `Your last payment didn't go through, so your desks stopped on ${dateOf(STOPPED_AT)}. Everything on them is kept until ${dateOf(KEPT_UNTIL)}. Update your payment method and they start again.`;
const D_BODY = `Your desks are kept until ${dateOf(KEPT_UNTIL)}. Rejoin before then and we'll restore them. After that we delete them, as our Terms say.`;
const E_BODY = `Your earlier desks were deleted on ${dateOf(DELETED_ON)}, as our Terms say, so rejoining starts with fresh ones.`;
/** What /v1/me says for each (stoppedBy, stoppedAt, dataDeleteAt), as ma-platform's identity sends them. */
const PAUSED = { status: 'suspended', tier: 'officer', stoppedBy: 'payment', stoppedAt: STOPPED_AT, dataDeleteAt: KEPT_UNTIL };
const KEPT = { status: 'ended', tier: 'officer', stoppedBy: 'member', stoppedAt: STOPPED_AT, dataDeleteAt: KEPT_UNTIL };
const GONE = { status: 'ended', tier: 'officer', stoppedBy: 'member', stoppedAt: DELETED_ON, dataDeleteAt: DELETED_ON };
/** client-config's billing page on a sibling host, and the office's own export page on. */
const STOP_CONFIG = { configExtra: { links: { billing: BILLING } }, export: { enabled: true, moves: true } };

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

const card = (page: Page): Locator => page.locator('.desk-notice');
const logOf = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log;

/** The 160 ms fade done, so axe and the screenshots see the card as it stays. */
async function settled(page: Page): Promise<void> {
  await expect(card(page)).toBeVisible();
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

/**
 * axe on the card, at WCAG 2.2 AA and best practice. Through devtools, so the page's CSP doesn't apply. axe can't
 * measure contrast past the ground's gradient, a pseudo element on `.ma-shell`, nor under the window layer, which
 * covers the screen with nothing in it and takes no pointer, so both are taken away while it runs. That changes
 * nothing it measures: the card's own background is opaque, and the layer empty, which this checks first.
 */
async function axe(page: Page): Promise<{ violations: string[]; unsure: string[] }> {
  expect(await card(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
  expect(await page.locator('.window-layer').evaluate((el) => el.childElementCount)).toBe(0);
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[]; incomplete: Rule[] }> } };
    interface Rule { id: string; nodes: { target: string[]; any: { message: string }[] }[] }
    const sheet = document.styleSheets[0]!;
    const at = sheet.insertRule('.ma-shell::before { content: none !important; }', sheet.cssRules.length);
    sheet.insertRule('.window-layer { display: none !important; }', at + 1);
    try {
      const r = await w.axe.run({ include: ['.desk-notice'] }, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations', 'incomplete'],
      });
      const say = (v: Rule) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`;
      const why = (v: Rule) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.any.map((a) => a.message).join('; ')}`);
      // Contrast axe couldn't decide counts against the card too: every pair on it must be measurable.
      return { violations: r.violations.map(say), unsure: r.incomplete.filter((v) => v.id === 'color-contrast').flatMap(why) };
    } finally {
      sheet.deleteRule(at + 1);
      sheet.deleteRule(at);
    }
  });
}

async function expectClean(page: Page): Promise<void> {
  await settled(page);
  expect(await axe(page)).toEqual({ violations: [], unsure: [] });
}

/** Every `desks-*` notice that is ever in the page, however briefly, and whether a card's "opens soon" ever was. */
async function recordNotices(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __notices: Set<string> }).__notices = seen;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-testid^="desks-"]')) seen.add(el.getAttribute('data-testid') ?? '');
      if (document.querySelector('.desk-notice-soon')) seen.add('soon');
    }).observe(document, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => [...(window as unknown as { __notices: Set<string> }).__notices]);
}

/** Holds every `GET /v1/me` until the returned function is called. */
async function holdMe(page: Page): Promise<() => void> {
  let answer = (): void => {};
  const held = new Promise<void>((done) => {
    answer = done;
  });
  await page.route('**/v1/me', async (route) => {
    await held;
    await route.continue();
  });
  return answer;
}

/** The card on screen, inside it, clear of the top bar, and nothing scrolls sideways. */
async function expectFits(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const b = (await card(page).boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width - 16 + 0.5);
  expect(b.y).toBeGreaterThan(bar.y + bar.height);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
  expect(await card(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true); // the whole card shows
}

async function shoot(page: Page, name: string): Promise<void> {
  await settled(page);
  await page.screenshot({ path: `test-results/shots/card-${name}.png` });
}

// ----- card A: signed up, never paid
for (const theme of THEMES) {
  test.describe(`card A in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await setTheme(page, theme);
    });

    test('before billing opens, as in prod: no button, and "Membership opens soon."', async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership: { status: 'unpaid' } });
      const errors = watchConsole(page);
      await signIn(page);
      const a = page.getByRole('region', { name: 'Welcome to your office' });
      await expect(a).toBeVisible();
      await expect(a.getByRole('heading', { level: 2 })).toHaveText('Welcome to your office');
      await expect(a.getByText(A_BODY, { exact: true })).toBeVisible();
      await expect(a.getByText('Membership opens soon.', { exact: true })).toBeVisible();
      await expect(a.getByRole('link')).toHaveCount(0);
      await expect(a.getByRole('button')).toHaveCount(0);
      await expect(page.locator('.desk-notice-alliance')).toHaveCount(0);
      // The picture is decoration: the body says it in words.
      await expect(page.locator('.desk-notice-pics')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('.desk-notice-etch')).toHaveText(['Personal', 'Work']);
      await expectClean(page);
      await shoot(page, `A-soon-${theme}`);
      await page.setViewportSize(PHONE);
      await expectFits(page);
      await expectClean(page);
      await shoot(page, `A-soon-${theme}-phone`);
      expect(errors).toEqual([]);
    });

    test('with Pay open: one button, to the account page, and the Alliance line only with its price', async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN });
      const errors = watchConsole(page);
      await signIn(page);
      const a = page.getByRole('region', { name: 'Welcome to your office' });
      await expect(a.getByRole('link', { name: 'See membership' })).toHaveAttribute('href', ACCOUNT);
      await expect(a.getByRole('link')).toHaveCount(1);
      await expect(page.locator('.desk-notice-soon')).toHaveCount(0);
      await expect(page.locator('.desk-notice-alliance')).toHaveCount(0); // that tier isn't on sale
      await expectClean(page);
      await shoot(page, `A-open-${theme}`);

      await harness(request, { platformBilling: OPEN_ALLIANCE });
      await page.reload();
      await expect(page.locator('.desk-notice-alliance')).toHaveText(ALLIANCE);
      await expectFits(page);
      await expectClean(page);
      await shoot(page, `A-alliance-${theme}`);
      await page.setViewportSize(PHONE);
      await expectFits(page);
      const button = a.getByRole('link', { name: 'See membership' });
      const [btn, box] = [(await button.boundingBox())!, (await card(page).boundingBox())!];
      expect(btn.height).toBeGreaterThanOrEqual(44); // a thumb's target, full width
      expect(btn.width).toBeGreaterThanOrEqual(box.width - 2 * 21);
      await expectClean(page);
      await shoot(page, `A-alliance-${theme}-phone`);
      expect(errors).toEqual([]);
    });
  });
}

// ----- B and F
for (const theme of THEMES) {
  test(`card B, the waitlist, in ${theme}: nothing to press`, async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: { status: 'waitlisted' }, platformBilling: OPEN });
    await setTheme(page, theme);
    const errors = watchConsole(page);
    await signIn(page);
    const b = page.getByRole('region', { name: "You're on the list" });
    await expect(b.getByText(B_BODY, { exact: true })).toBeVisible();
    await expect(b.getByRole('link')).toHaveCount(0);
    await expect(b.getByRole('button')).toHaveCount(0);
    await expect(page.locator('.desk-notice-pics, .desk-notice-soon, .desk-notice-alliance')).toHaveCount(0);
    await expectClean(page);
    await shoot(page, `B-${theme}`);
    await page.setViewportSize(PHONE);
    await expectFits(page);
    await expectClean(page);
    await shoot(page, `B-${theme}-phone`);
    expect(errors).toEqual([]);
    // Nothing on it depends on Pay, so Platform's own config is never asked.
    expect(await logOf(request)).not.toContain('client-config platform-web');
  });

  test(`card F, not active, in ${theme}: the support address and nothing else`, async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: { status: 'suspended' }, platformBilling: OPEN_ALLIANCE });
    await setTheme(page, theme);
    const errors = watchConsole(page);
    await signIn(page);
    const f = page.getByRole('region', { name: 'Your membership is not active' });
    await expect(f.locator('p')).toHaveText(F_BODY);
    await expect(f.getByRole('link')).toHaveCount(1);
    await expect(f.getByRole('link', { name: 'support@minimalistalliance.com' })).toHaveAttribute('href', 'mailto:support@minimalistalliance.com');
    await expect(page.locator('.desk-notice-pics, .desk-notice-soon, .desk-notice-alliance, .desk-notice .btn')).toHaveCount(0);
    await expectClean(page);
    await shoot(page, `F-${theme}`);
    await page.setViewportSize(PHONE);
    await expectFits(page);
    await expectClean(page);
    await shoot(page, `F-${theme}-phone`);
    expect(errors).toEqual([]);
  });
}

test('ended and closed get card F too while /v1/me says nothing of why (a Platform from before 0.3.69)', async ({ page, request }) => {
  for (const status of ['ended', 'closed']) {
    await harness(request, { desks: 'empty', membership: { status } });
    await signIn(page);
    await expect(page.getByTestId('desks-inactive')).toContainText('Your membership is not active');
    await expect(page.getByTestId('desks-inactive')).toHaveAttribute('data-card', 'F');
  }
});

// ----- C, D and E
test.describe('cards C, D and E', () => {
  test.use({ timezoneId: ZONE });

  for (const theme of THEMES) {
    test(`card C, paused, in ${theme}: the two dates, Update payment and Write to us`, async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership: PAUSED, platformBilling: OPEN_ALLIANCE, ...STOP_CONFIG });
      await setTheme(page, theme);
      const errors = watchConsole(page);
      await signIn(page);
      const c = page.getByRole('region', { name: 'Your desks are paused' });
      await expect(c).toHaveAttribute('data-card', 'C');
      await expect(c.locator('p')).toHaveText(C_BODY);
      await expect(c.locator('p b')).toHaveText([dateOf(STOPPED_AT), dateOf(KEPT_UNTIL)]); // the one emphasis
      await expect(c.getByRole('link', { name: 'Update payment' })).toHaveAttribute('href', BILLING);
      await expect(c.getByRole('link', { name: 'Write to us' })).toHaveAttribute('href', 'mailto:support@minimalistalliance.com');
      await expect(c.getByRole('link')).toHaveCount(2);
      // No price pitch, no picture: this person already wants in.
      await expect(page.locator('.desk-notice-pics, .desk-notice-soon, .desk-notice-alliance')).toHaveCount(0);
      await expectClean(page);
      await shoot(page, `C-${theme}`);
      await page.setViewportSize(PHONE);
      await expectFits(page);
      await expectClean(page);
      await shoot(page, `C-${theme}-phone`);
      expect(errors).toEqual([]);
      // Nothing on it depends on Pay.
      expect(await logOf(request)).not.toContain('client-config platform-web');
    });

    test(`card D, kept, in ${theme}: the date, Rejoin, and the export as easy to find`, async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership: KEPT, platformBilling: OPEN_ALLIANCE, ...STOP_CONFIG });
      await setTheme(page, theme);
      const errors = watchConsole(page);
      await signIn(page);
      const d = page.getByRole('region', { name: 'Your membership has ended' });
      await expect(d).toHaveAttribute('data-card', 'D');
      await expect(d.locator('p')).toHaveText(D_BODY);
      await expect(d.locator('p b')).toHaveText([dateOf(KEPT_UNTIL)]);
      await expect(d.getByRole('link', { name: 'Rejoin' })).toHaveAttribute('href', ACCOUNT);
      await expect(d.getByRole('link', { name: 'Ask for an export' })).toHaveAttribute('href', '/export');
      await expect(d.getByRole('link')).toHaveCount(2);
      await expect(page.locator('.desk-notice-pics, .desk-notice-soon, .desk-notice-alliance')).toHaveCount(0);
      // The export link is the body's size, so it's as easy to see as Rejoin.
      expect(await d.getByRole('link', { name: 'Ask for an export' }).evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
      await expectClean(page);
      await shoot(page, `D-${theme}`);
      await page.setViewportSize(PHONE);
      await expectFits(page);
      await expectClean(page);
      await shoot(page, `D-${theme}-phone`);
      expect(errors).toEqual([]);
    });

    test(`card E, welcome back, in ${theme}: the date, the picture, See membership and the Alliance line`, async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership: GONE, platformBilling: OPEN_ALLIANCE, ...STOP_CONFIG });
      await setTheme(page, theme);
      const errors = watchConsole(page);
      await signIn(page);
      const e = page.getByRole('region', { name: 'Welcome back' });
      await expect(e).toHaveAttribute('data-card', 'E');
      await expect(e.locator('p').first()).toHaveText(E_BODY);
      await expect(e.locator('p b')).toHaveText([dateOf(DELETED_ON)]);
      await expect(page.locator('.desk-notice-pics')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('.desk-notice-etch')).toHaveText(['Personal', 'Work']);
      await expect(e.getByRole('link', { name: 'See membership' })).toHaveAttribute('href', ACCOUNT);
      await expect(e.getByRole('link')).toHaveCount(1);
      await expect(page.locator('.desk-notice-alliance')).toHaveText(ALLIANCE);
      await expectClean(page);
      await shoot(page, `E-${theme}`);
      await page.setViewportSize(PHONE);
      await expectFits(page);
      await expectClean(page);
      await shoot(page, `E-${theme}-phone`);
      expect(errors).toEqual([]);
    });
  }

  test('E before billing opens: no button and no Alliance line, and no "opens soon" either', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: GONE, platformBilling: null, ...STOP_CONFIG });
    await signIn(page);
    const e = page.getByRole('region', { name: 'Welcome back' });
    await expect(e.locator('p').first()).toHaveText(E_BODY);
    await expect(e.getByRole('link')).toHaveCount(0);
    await expect(page.locator('.desk-notice-alliance, .desk-notice-soon')).toHaveCount(0);
  });

  test('D\'s "Ask for an export" opens the office\'s own export page, in this tab', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: KEPT, ...STOP_CONFIG });
    await signIn(page);
    await page.getByRole('link', { name: 'Ask for an export' }).click();
    await expect(page).toHaveURL(/\/export$/);
    await expect(page.getByTestId('export-page')).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
  });

  test('where the export page is off, D\'s export goes by email, as before', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: KEPT, configExtra: { links: { billing: BILLING } } });
    await signIn(page);
    await expect(page.getByRole('link', { name: 'Ask for an export' })).toHaveAttribute('href', 'mailto:support@minimalistalliance.com?subject=Export%20my%20desks');
  });

  test('C\'s Update payment goes to the billing page in this tab, by keyboard, Space included', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: PAUSED, ...STOP_CONFIG });
    await page.route('https://platform.localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Billing</title><h1>Billing</h1>' }));
    await signIn(page);
    const button = page.getByRole('link', { name: 'Update payment' });
    await expect(button).toBeVisible();
    await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 8 && !(await button.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(BILLING);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('anything /v1/me doesn\'t explain plainly is F, with no date: other (a safety suspension, a hold, anything we did), an end after a failed payment, a bad date', async ({ page, request }) => {
    const plainF = [
      { status: 'suspended', stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null },
      { status: 'ended', stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null },
      { status: 'closed', stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null },
      { status: 'ended', stoppedBy: 'payment', stoppedAt: STOPPED_AT, dataDeleteAt: KEPT_UNTIL },
      { status: 'suspended', stoppedBy: 'payment', stoppedAt: STOPPED_AT, dataDeleteAt: 'soon' },
      { status: 'suspended', stoppedBy: 'payment', stoppedAt: STOPPED_AT, dataDeleteAt: DELETED_ON },
    ];
    for (const membership of plainF) {
      await harness(request, { desks: 'empty', membership: { tier: 'officer', ...membership }, ...STOP_CONFIG });
      await signIn(page);
      const f = page.getByTestId('desks-inactive');
      await expect(f, JSON.stringify(membership)).toHaveAttribute('data-card', 'F');
      await expect(f.locator('p')).toHaveText(F_BODY);
      await expect(f.locator('b')).toHaveCount(0);
    }
  });

  test('a screen reader hears C once, title and body with its dates', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: PAUSED, ...STOP_CONFIG });
    await signIn(page);
    await expect(page.getByRole('region', { name: 'Your desks are paused' })).toBeVisible();
    await expect(page.getByTestId('live-region')).toHaveText(`Your desks are paused. ${C_BODY}`);
  });
});

// ----- C and D over a member's stopped desks (S-82): the desks stay behind the card, which is the same card.
test.describe('cards C and D over the desks', () => {
  test.use({ timezoneId: ZONE });
  const SHOTS = process.env['S82_SHOTS'];

  for (const theme of THEMES) {
    for (const [name, membership, title, body, links] of [
      ['C', PAUSED, 'Your desks are paused', C_BODY, ['Update payment', 'Write to us']],
      ['D', KEPT, 'Your membership has ended', D_BODY, ['Rejoin', 'Ask for an export']],
    ] as const) {
      for (const [size, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]] as const) {
        test(`card ${name} shows over the desks in ${theme} at ${size}`, async ({ page, request }) => {
          await harness(request, { membership, platformBilling: OPEN, ...STOP_CONFIG });
          await page.setViewportSize(viewport);
          await setTheme(page, theme);
          const errors = watchConsole(page);
          await signIn(page);
          const c = page.getByRole('region', { name: title });
          await expect(c).toHaveAttribute('data-card', name);
          await expect(c.locator('p')).toHaveText(body);
          for (const l of links) await expect(c.getByRole('link', { name: l })).toBeVisible();
          // The desks are listed behind it, and nothing offers to dismiss the card.
          expect(await page.evaluate(() => (window as unknown as { __maDesk?: unknown }).__maDesk !== undefined)).toBe(true);
          await expect(c.getByRole('button')).toHaveCount(0);
          await expectFits(page);
          for (const l of links) {
            const b = (await c.getByRole('link', { name: l }).boundingBox())!;
            if (size === 'phone') expect(b.height).toBeGreaterThanOrEqual(44 - 0.5);
          }
          await settled(page);
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-over-desks-${theme}-${size}.png` });
          expect(errors).toEqual([]);
        });
      }
    }
  }

  // S-82, the Product Designer's call: behind C and D the desks are at 35 percent as one group, with no counts.
  const BADGED = [{ deskId: 'd-testk3m7q2x', name: 'Personal', kind: 'personal', state: 'stopped', badges: { total: 5, apps: { chat: 4, browser: 1 } } }];
  const desksOpacity = (page: Page) => page.evaluate(() => (window as unknown as { __maDesk: { desksOpacity: () => number | null } }).__maDesk.desksOpacity());
  for (const [name, membership, title] of [['C', PAUSED, 'Your desks are paused'], ['D', KEPT, 'Your membership has ended']] as const) {
    test(`card ${name}: the desks are at 35 percent and carry no counts`, async ({ page, request }) => {
      await harness(request, { membership, platformBilling: OPEN, fleet: BADGED, ...STOP_CONFIG });
      await signIn(page);
      await expect(page.getByRole('region', { name: title })).toHaveAttribute('data-card', name);
      await expect.poll(() => desksOpacity(page)).toBe(0.35);
      await expect(page.getByRole('button', { name: /unread|need you/ })).toHaveCount(0);
      await expect(page.locator('[id^="proxy-"][aria-label*="hidden"]')).toHaveCount(0);
    });
  }

  test('an active member keeps the desks at full strength, with their counts', async ({ page, request }) => {
    await harness(request, { membership: { status: 'active', tier: 'officer' }, fleet: BADGED, ...STOP_CONFIG });
    await signIn(page);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect.poll(() => desksOpacity(page)).toBe(1);
    await expect(page.getByRole('button', { name: /4 unread/ })).toHaveCount(1);
  });

  test('an active member sees no card over the desks', async ({ page, request }) => {
    await harness(request, { membership: { status: 'active', tier: 'officer' }, ...STOP_CONFIG });
    await signIn(page);
    await expect(page.locator('.topbar')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator('.desk-notice')).toHaveCount(0);
  });

  test('E and F stay off the desks', async ({ page, request }) => {
    await harness(request, { membership: GONE, ...STOP_CONFIG });
    await signIn(page);
    await page.waitForTimeout(800);
    await expect(page.locator('.desk-notice')).toHaveCount(0);
  });
});

// ----- beside the Product Designer's stills: the same screens, at their size and 2x
test('stills at the mockups\' sizes, for the side-by-side look', async ({ browser, request }) => {
  const stills: [string, string, ThemeId, { width: number; height: number }, Record<string, unknown>][] = [
    ['1-A-light-desktop', 'unpaid', 'light', { width: 1280, height: 800 }, OPEN_ALLIANCE],
    ['2-A-dusk-desktop', 'unpaid', 'dusk', { width: 1280, height: 800 }, OPEN_ALLIANCE],
    ['3-A-dark-desktop', 'unpaid', 'dark', { width: 1280, height: 800 }, OPEN_ALLIANCE],
    ['4-A-light-phone', 'unpaid', 'light', PHONE, OPEN_ALLIANCE],
    ['7-F-light-desktop', 'suspended', 'light', { width: 1280, height: 800 }, OPEN],
    ['B-dusk-desktop', 'waitlisted', 'dusk', { width: 1280, height: 800 }, OPEN],
    ['F-dark-phone', 'ended', 'dark', PHONE, OPEN],
    ['5-D-dusk-desktop', 'kept', 'dusk', { width: 1280, height: 800 }, OPEN],
    ['6-C-dark-phone', 'paused', 'dark', PHONE, OPEN],
    ['E-light-desktop', 'gone', 'light', { width: 1280, height: 800 }, OPEN_ALLIANCE],
  ];
  const stops: Record<string, Record<string, unknown>> = { kept: KEPT, paused: PAUSED, gone: GONE };
  for (const [name, status, theme, viewport, platformBilling] of stills) {
    await harness(request, { desks: 'empty', membership: stops[status] ?? { status }, platformBilling, ...(stops[status] ? STOP_CONFIG : {}) });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL, timezoneId: ZONE });
    const page = await ctx.newPage();
    await setTheme(page, theme);
    await signIn(page);
    await settled(page);
    await page.screenshot({ path: `test-results/shots/still-${name}.png` });
    await ctx.close();
  }
});

// ----- keyboard and screen readers
test('the keyboard reaches the button straight after the top bar, and Enter goes to the account page in this tab', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN });
  await page.route('https://platform.localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Account</title><h1>Account</h1>' }));
  await signIn(page);
  const button = page.getByRole('link', { name: 'See membership' });
  await expect(button).toBeVisible();
  await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
  const stops: string[] = [];
  for (let i = 0; i < 8 && !(await button.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''));
  }
  expect(stops.at(-1)).toBe('See membership');
  // The top bar's buttons in order: the bell (ADR 0125) sits between Full screen and Account, with no count on an empty list.
  expect(stops.slice(0, -1)).toEqual(['Privacy shield', 'Full screen', 'Notifications', 'Account']);
  // A visible focus ring, in the theme's own color.
  expect(await button.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(ACCOUNT);
  expect(page.context().pages()).toHaveLength(1);
});

test('Space presses "See membership" too, on the release, as it looks like a button, and a screen reader still hears a link', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN });
  await page.route('https://platform.localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Account</title><h1>Account</h1>' }));
  await signIn(page);
  const link = page.getByRole('link', { name: 'See membership' });
  await expect(link).toBeVisible();
  // What a screen reader is given: a link with its address, and no button of that name.
  expect(await link.ariaSnapshot()).toBe(`- link "See membership":\n  - /url: ${ACCOUNT}`);
  await expect(page.getByRole('button', { name: 'See membership' })).toHaveCount(0);
  // Reached by Tab, as a member would.
  await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 8 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await page.keyboard.down('Space');
  await page.waitForTimeout(150);
  expect(page.url()).not.toBe(ACCOUNT); // a button goes on the release
  await page.keyboard.up('Space');
  await expect(page).toHaveURL(ACCOUNT);
  expect(page.context().pages()).toHaveLength(1);
});

test('the error notice\'s Try again works by keyboard too, now that the card owns Enter and Space', async ({ page, request }) => {
  await harness(request, { desks: 'error' });
  await signIn(page);
  await expect(page.getByTestId('desks-error')).toBeVisible();
  await harness(request, { desks: 'empty' });
  await page.getByRole('button', { name: 'Try again' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('desks-empty')).toBeVisible();
});

test('card F\'s address is a link the keyboard reaches', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'ended' } });
  await signIn(page);
  const mail = page.getByRole('link', { name: 'support@minimalistalliance.com' });
  await expect(mail).toBeVisible();
  for (let i = 0; i < 8 && !(await mail.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(mail).toBeFocused();
  // Underlined in the line, so it isn't told apart by color alone.
  expect(await mail.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
});

test('a screen reader hears the card once, as it appears, and finds it as a region under its title', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'waitlisted' } });
  await signIn(page);
  await expect(page.getByRole('region', { name: "You're on the list" })).toBeVisible();
  await expect(page.locator('.sr-only[aria-live="polite"]')).toHaveText(`You're on the list. ${B_BODY}`);
  // The card itself isn't a live region, so it isn't read twice.
  await expect(card(page)).not.toHaveAttribute('role', 'status');
  await expect(card(page)).not.toHaveAttribute('aria-live', /.+/);
});

// ----- motion
test('the card fades in over 160 ms with a 4 px rise, once, and doesn\'t rise under reduced motion', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'waitlisted' } });
  await signIn(page);
  await expect(card(page)).toBeVisible();
  const motion = (): Promise<string[]> => card(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.animationName, s.animationDuration, s.animationIterationCount];
  });
  expect(await motion()).toEqual(['desk-notice-in', '0.16s', '1']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await motion()).toEqual(['desk-notice-fade', '0.16s', '1']);
  const rises = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((s) => [...s.cssRules]);
    const frames = (name: string) => (rules.find((r) => r instanceof CSSKeyframesRule && r.name === name) as CSSKeyframesRule).cssRules[0]!.cssText;
    return [frames('desk-notice-in'), frames('desk-notice-fade')];
  });
  expect(rises[0]).toContain('translate: 0px 4px');
  expect(rises[1]).not.toContain('translate');
});

// ----- what card A waits for, and what it does without
test('card A waits for Platform to say whether Pay is open, so it never changes once it shows', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN, platformConfigDelayMs: 1500 });
  const seen = await recordNotices(page);
  await signIn(page);
  await expect.poll(() => logOf(request)).toContain('client-config platform-web');
  await page.waitForTimeout(500);
  expect(await seen()).toEqual([]);
  await expect(page.getByRole('link', { name: 'See membership' })).toBeVisible();
  expect(await seen()).toEqual(['desks-welcome']);
});

test('if Platform can\'t be asked, card A offers nothing and promises nothing', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: 'fail' });
  await signIn(page);
  await settled(page);
  await expect(page.getByTestId('desks-welcome')).toContainText('Welcome to your office');
  await expect(page.locator('.desk-notice-soon, .desk-notice-alliance, .desk-notice .btn')).toHaveCount(0);
});

test('with Pay open but no usable account link, card A has no button, and still promises nothing', async ({ page, request }) => {
  for (const accountLink of [null, 'http://platform.localhost/account', 'https://evil.example/account']) {
    await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN, accountLink });
    await signIn(page);
    await settled(page);
    await expect(page.locator('.desk-notice-soon, .desk-notice .btn')).toHaveCount(0);
  }
});

test('a phone at 400% zoom: the card scrolls inside itself, under the top bar, rather than run off the screen', async ({ page, request }) => {
  await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN_ALLIANCE });
  await page.setViewportSize({ width: 360, height: 225 });
  await signIn(page);
  await settled(page);
  const b = (await card(page).boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(b.y + b.height).toBeLessThanOrEqual(225);
  const button = page.getByRole('link', { name: 'See membership' });
  await button.focus();
  await expect(button).toBeInViewport();
});

// LS-27: on a phone on its side the card squashed "See membership" to 22 px and ran the Alliance line under its edge.
test.describe('a phone on its side', () => {
  test.use({ hasTouch: true, isMobile: true });
  const SIDEWAYS = [['iphone15', { width: 734, height: 343 }], ['pixel7', { width: 863, height: 360 }]] as const;

  for (const theme of THEMES) {
    for (const [name, size] of SIDEWAYS) {
      test(`${name} in ${theme}: card A shows whole, with a 44 px button and the Alliance line`, async ({ page, request }) => {
        await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN_ALLIANCE });
        await setTheme(page, theme);
        await page.setViewportSize(size);
        const errors = watchConsole(page);
        await signIn(page);
        await settled(page);
        await expectFits(page);
        const button = (await page.getByRole('link', { name: 'See membership' }).boundingBox())!;
        expect(button.height).toBe(44);
        await expect(page.locator('.desk-notice-alliance')).toHaveText(ALLIANCE);
        await expect(page.locator('.desk-notice-alliance')).toBeInViewport({ ratio: 1 });
        // The body's last line isn't one word on its own ("home.").
        const lastLineWords = await page.evaluate(() => {
          const node = [...document.querySelectorAll('.desk-notice p')].map((p) => p.firstChild).find((n) => n?.nodeType === 3 && n.textContent!.includes('Home stays home'))!;
          const text = node.textContent!;
          const last = text.lastIndexOf(' ');
          const range = document.createRange();
          range.setStart(node, text.lastIndexOf(' ', last - 1) + 1);
          range.setEnd(node, text.length);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        });
        expect(lastLineWords).toBe(1); // the last two words sit on one line
        await expectClean(page);
        await shoot(page, `A-alliance-${theme}-${name}-landscape`);
        expect(errors).toEqual([]);
      });
    }
  }

  test('shorter still: nothing gives way, and the card scrolls to the Alliance line', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: OPEN_ALLIANCE });
    await page.setViewportSize({ width: 640, height: 290 });
    await signIn(page);
    await settled(page);
    expect(await card(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect((await page.getByRole('link', { name: 'See membership' }).boundingBox())!.height).toBe(44);
    const alliance = page.locator('.desk-notice-alliance');
    await alliance.scrollIntoViewIfNeeded();
    const [a, c] = [(await alliance.boundingBox())!, (await card(page).boundingBox())!];
    expect(a.y + a.height).toBeLessThanOrEqual(c.y + c.height);
  });
});

// ----- a paying member never sees a card
test.describe('a paying member never sees a card', () => {
  const CARDS = ['desks-welcome', 'desks-waitlist', 'desks-inactive'];

  test('with desks, however long /v1/me takes', async ({ page, request }) => {
    await harness(request, { desks: 'ok', membership: { status: 'active', tier: 'officer' } });
    const seen = await recordNotices(page);
    const answer = await holdMe(page);
    await signIn(page);
    await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
    await page.waitForTimeout(2500);
    expect(await seen()).toEqual([]);
    answer();
    await expect.poll(() => logOf(request)).toContain('GET /v1/me');
    await page.waitForTimeout(500);
    expect(await seen()).toEqual([]);
  });

  for (const membership of [
    { status: 'active', tier: 'officer' },
    { status: 'active', tier: 'lead', comped: true },
    { status: 'past_due', tier: 'officer' },
    { status: 'canceling', tier: 'officer' },
  ]) {
    test(`${membership.status}${membership.comped ? ', comped' : ''}, with no desk yet and a slow /v1/me: nothing, then "on its way"`, async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership, platformBilling: OPEN_ALLIANCE });
      const seen = await recordNotices(page);
      const answer = await holdMe(page);
      await signIn(page);
      await expect.poll(() => logOf(request)).toContain('GET /v1/desks');
      await page.waitForTimeout(2500);
      expect(await seen()).toEqual([]);
      answer();
      await expect(page.getByTestId('desks-empty')).toBeVisible();
      expect(await seen()).toEqual(['desks-empty']);
      expect(await logOf(request)).not.toContain('client-config platform-web');
    });
  }

  test('just paid: the list still says unpaid, /v1/me already says active, and only "on its way" ever shows', async ({ page, request }) => {
    await harness(request, { desks: 'unpaid', membership: { status: 'active', tier: 'officer' }, platformBilling: OPEN });
    const seen = await recordNotices(page);
    const answer = await holdMe(page);
    await signIn(page);
    await expect.poll(() => logOf(request)).toContain('GET /v1/desks');
    await page.waitForTimeout(2500);
    expect(await seen()).toEqual([]);
    answer();
    await expect(page.getByTestId('desks-empty')).toBeVisible();
    await page.waitForTimeout(500);
    expect((await seen()).filter((s) => CARDS.includes(s))).toEqual([]);
  });
});
