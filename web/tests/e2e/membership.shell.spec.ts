// The office's membership cards (the membership card proposal; chrome/CalmScreen.tsx, chrome/membershipCards.tsx):
// A, B and F, the only states before billing, in all three themes on desktop and phone, by keyboard, by screen reader
// and through axe. Nothing shows until /v1/me has answered, so a paying member never sees a card, however slow it is.
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

test('ended and closed get card F too, until /v1/me says why (cards C to E)', async ({ page, request }) => {
  for (const status of ['ended', 'closed']) {
    await harness(request, { desks: 'empty', membership: { status } });
    await signIn(page);
    await expect(page.getByTestId('desks-inactive')).toContainText('Your membership is not active');
    await expect(page.getByTestId('desks-inactive')).toHaveAttribute('data-card', 'F');
  }
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
  ];
  for (const [name, status, theme, viewport, platformBilling] of stills) {
    await harness(request, { desks: 'empty', membership: { status }, platformBilling });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
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
  expect(stops.slice(0, -1)).toEqual(['Privacy shield', 'Full screen', 'Account']);
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
