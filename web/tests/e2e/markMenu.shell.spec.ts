// The mark's menu (the owner's ask, Nov 12; the Product Designer's mark menu spec, §2 to §9): the mark is always a button;
// with a mouse, resting on it 120 ms opens a menu of the Alliance's other pages, leaving shuts it 300 ms later, and a click
// still shows all desks where there's an overview to go to; a tap, Enter or Space opens it pinned. `chrome/TopBar.tsx`
// `HomeMark` and `chrome/MarkPanel.tsx`. Its layout in the bar is `bars.shell.spec.ts`'s, its lazy first open
// `onDemand.shell.spec.ts`'s, its fleet keys `fleet-map.shell.spec.ts`'s. `MARK_SHOTS=<dir>` also saves the review's
// stills and two videos there (the last describe, skipped without it).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, homeMark, setTheme, signIn, watchConsole, type ThemeId, openMenuSection } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['MARK_SHOTS'];

const PERSONAL = 'd-personal00001';
const FLEET = [
  { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
  { deskId: 'd-guild00000001', name: 'Guild', kind: 'guild', state: 'running' },
  { deskId: 'd-extra00000001', name: 'Extra', kind: 'work', state: 'running' },
];
/** Client-config with the five keys Platform is asked for (the harness's site is `localhost`, its apex `https://localhost`). */
const KEYS = {
  forums: 'https://forums.localhost/',
  help: 'https://localhost/help',
  privacy: 'https://localhost/privacy',
  terms: 'https://localhost/terms',
  guidelines: 'https://localhost/guidelines',
  billing: 'https://platform.localhost/billing',
};
/** As staging's and prod's desk-web client-config are today (Nov 12): `links.support` on the apex, no forums, help or policy keys. */
const TODAY = { support: 'https://localhost/contact', billing: 'https://platform.localhost/billing' };
const NEW_TAB = { target: '_blank', rel: 'noopener', 'aria-description': 'Opens in a new tab' };

const mark = (page: Page): Locator => page.getByRole('button', { name: 'Minimalist Alliance', exact: true });
const menu = (page: Page): Locator => page.getByRole('navigation', { name: 'Minimalist Alliance' });
const row = (page: Page, name: string): Locator => menu(page).getByRole(name === 'All desks' ? 'button' : 'link', { name, exact: true });
const mode = (page: Page): Promise<string> => page.evaluate(() => (JSON.parse(localStorage.getItem('ma.view.v1') ?? '{}') as { mode?: string }).mode ?? '');

interface Arrive {
  desks?: number;
  links?: Record<string, string>;
  extra?: Record<string, unknown>;
  more?: Record<string, unknown>;
  theme?: ThemeId;
}

async function arrive(page: Page, request: APIRequestContext, { desks = 2, links = KEYS, extra = {}, more = {}, theme = 'light' }: Arrive = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, { fleet: FLEET.slice(0, desks), configExtra: { links, ...extra }, ...more });
  await setTheme(page, theme);
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600);
  return errors;
}

/** The Personal desk in front, so the mark's click goes home and the office's own Esc would show all desks. */
async function front(page: Page): Promise<void> {
  await page.locator(`[id="proxy-${PERSONAL}"]`).evaluate((e) => (e as HTMLButtonElement).click());
  await expect(homeMark(page)).toBeVisible();
  await page.waitForTimeout(800);
}

async function middle(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Opened from the keyboard, pinned; its motion done. */
async function openByKeys(page: Page): Promise<void> {
  await mark(page).focus();
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeVisible();
  await page.waitForTimeout(300);
}

/**
 * Times from the page's own clock: when the pointer entered and left the mark's wrap, whether it was open 100 ms after
 * entering, and when `aria-expanded` turned true and back to false.
 */
async function clock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const wrap = document.querySelector('.home-mark')!;
    const btn = document.querySelector('.home-mark-btn')!;
    const t = { enter: 0, leave: 0, open: 0, shut: 0, at100: '' };
    (window as unknown as { __mark: typeof t }).__mark = t;
    wrap.addEventListener('pointerenter', () => {
      t.enter = performance.now();
      window.setTimeout(() => (t.at100 = btn.getAttribute('aria-expanded') ?? ''), 100);
    });
    wrap.addEventListener('pointerleave', () => (t.leave = performance.now()));
    new MutationObserver(() => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      if (open && !t.open) t.open = performance.now();
      if (!open && t.open && !t.shut) t.shut = performance.now();
    }).observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
  });
}
const times = (page: Page): Promise<{ enter: number; leave: number; open: number; shut: number; at100: string }> =>
  page.evaluate(() => (window as unknown as { __mark: { enter: number; leave: number; open: number; shut: number; at100: string } }).__mark);

/** Serious and critical axe violations, WCAG 2.2 A and AA, as `a11y.sweep.shell.spec.ts` counts them. */
async function sweep(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('rows and links', () => {
  test('with Platform\'s five keys: every row in order, in its group, each link to its page in a new tab', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await front(page);
    await openByKeys(page);
    await expect(menu(page).locator('a, button')).toHaveText(['All desks', 'Forums', 'Help', 'Account', 'Billing', 'Privacy', 'Terms', 'Guidelines']);
    const links = await menu(page).getByRole('link').evaluateAll((els) =>
      els.map((a) => ({ name: a.textContent, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), 'aria-description': a.getAttribute('aria-description') })),
    );
    expect(links).toEqual([
      { name: 'Forums', href: 'https://forums.localhost/', ...NEW_TAB },
      { name: 'Help', href: 'https://localhost/help', ...NEW_TAB },
      { name: 'Account', href: 'https://platform.localhost/account', ...NEW_TAB },
      { name: 'Billing', href: 'https://platform.localhost/billing', ...NEW_TAB },
      { name: 'Privacy', href: 'https://localhost/privacy', ...NEW_TAB },
      { name: 'Terms', href: 'https://localhost/terms', ...NEW_TAB },
      { name: 'Guidelines', href: 'https://localhost/guidelines', ...NEW_TAB },
    ]);
    // A disclosure that shows a nav of links: never a menu.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(mark(page)).toHaveAttribute('aria-controls', 'mark-menu');
    await expect(menu(page)).toHaveAttribute('id', 'mark-menu');
    await expect(menu(page).getByRole('list', { name: 'Community' }).getByRole('link')).toHaveText(['Forums', 'Help']);
    await expect(menu(page).getByRole('list', { name: 'Your account' }).getByRole('link')).toHaveText(['Account', 'Billing']);
    await expect(menu(page).getByRole('list', { name: 'Policies' }).getByRole('link')).toHaveText(['Privacy', 'Terms', 'Guidelines']);
    await expect(menu(page).locator('.menu-sep')).toHaveCount(3);
    // The stagger's places in reading order: a separator takes the row above it, the footer is one row.
    expect(await menu(page).locator('li, .menu-sep').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.getPropertyValue('--i')))).toEqual(['0', '0', '1', '2', '2', '3', '4', '4', '5', '5', '5']);
    // The footer is one line.
    const tops = await menu(page).getByRole('list', { name: 'Policies' }).getByRole('link').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(errors).toEqual([]);
  });

  test('without them, as staging and prod are today: no Forums, Help is the Contact page, the policies on links.support\'s origin', async ({ page, request }) => {
    const errors = await arrive(page, request, { links: TODAY });
    await front(page);
    await openByKeys(page);
    await expect(menu(page).locator('a, button')).toHaveText(['All desks', 'Help', 'Account', 'Billing', 'Privacy', 'Terms', 'Guidelines']);
    expect(await menu(page).getByRole('link').evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual([
      'https://localhost/contact',
      'https://platform.localhost/account',
      'https://platform.localhost/billing',
      'https://localhost/privacy',
      'https://localhost/terms',
      'https://localhost/guidelines',
    ]);
    expect(errors).toEqual([]);
  });

  test('a links.support that isn\'t the apex, and the harness\'s own http billing: no Help, no policies, no Billing; one desk: no All desks', async ({ page, request }) => {
    const errors = await arrive(page, request, { desks: 1, links: { support: 'https://platform.localhost/support' } });
    await openByKeys(page);
    await expect(menu(page).locator('a, button')).toHaveText(['Account']);
    await expect(menu(page).locator('.menu-sep')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a closed account: Help and the policies only', async ({ page, request }) => {
    const closed = { status: 'ended', tier: 'officer', badge: null, stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null, closed: true, exportUntil: new Date(Date.now() + 19 * 86_400_000).toISOString(), held: false };
    const errors = await arrive(page, request, { more: { closedAccount: true, membership: closed, export: { enabled: true } } });
    await expect(homeMark(page)).toHaveCount(0);
    await openByKeys(page);
    await expect(menu(page).locator('a, button')).toHaveText(['Help', 'Privacy', 'Terms', 'Guidelines']);
    await expect(menu(page).locator('.menu-sep')).toHaveCount(1);
    // The browser's own line for each call refused before `/v1/me` said closed (`accountClosed.shell.spec.ts`).
    expect(errors.filter((e) => !/^Failed to load resource: the server responded with a status of 403/.test(e))).toEqual([]);
  });
});

test.describe('a mouse', () => {
  test('resting 120 ms opens it, not at 100; leaving shuts it 300 ms later; leaving sooner than 120 ms opens nothing', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await front(page);
    await clock(page);
    const at = await middle(mark(page));
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    await page.waitForTimeout(300);
    let t = await times(page);
    expect(t.at100).toBe('false');
    expect(t.open - t.enter).toBeGreaterThanOrEqual(119);
    expect(t.open - t.enter).toBeLessThan(250);
    await page.mouse.move(700, 450);
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    t = await times(page);
    expect(t.shut - t.leave).toBeGreaterThanOrEqual(299);
    expect(t.shut - t.leave).toBeLessThan(450);

    // In and out in 60 ms: nothing.
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(60);
    await page.mouse.move(700, 450);
    await page.waitForTimeout(400);
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
  });

  test('coming back within 300 ms keeps it; the pointer crosses to the panel over the bridge; a press in the panel pins it', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await front(page);
    const at = await middle(mark(page));
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    await page.waitForTimeout(250);
    await page.mouse.move(700, 450);
    await page.waitForTimeout(150);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(500);
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'true');
    // Down to Help, through the gap between the plate and the panel.
    const help = await middle(row(page, 'Help'));
    await page.mouse.move(help.x - 60, help.y, { steps: 12 });
    await page.waitForTimeout(500);
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'true');
    // Opened by hover it's not pinned: away, it shuts.
    await page.mouse.move(700, 450);
    await expect(page.locator('.mark-pop')).toHaveCount(0);

    // A press on the panel's own padding (no row) pins it: away, it stays.
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    const box = (await page.locator('.mark-pop').boundingBox())!;
    await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3, { steps: 6 });
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.move(700, 450);
    await page.waitForTimeout(600);
    await expect(menu(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('where there\'s an overview to go to, a click shows all desks, shuts it at once, and resting there doesn\'t open it again', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await front(page);
    const at = await middle(mark(page));
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
    // At once: no exit motion, since the view changes anyway.
    expect(await page.evaluate(() => document.querySelectorAll('.mark-pop').length)).toBe(0);
    await page.waitForTimeout(700);
    expect(await mode(page)).toBe('overview');
    await expect(homeMark(page)).toHaveCount(0);
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'false');

    // A quick click (before the intent delay) goes home too, and nothing opens after it.
    await front(page);
    await page.mouse.move(700, 450);
    await mark(page).click();
    await page.waitForTimeout(500);
    expect(await mode(page)).toBe('overview');
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('with nowhere to go (the overview, or one desk), a click toggles it, pinned', async ({ page, request }) => {
    const errors = await arrive(page, request);
    expect(await mode(page)).toBe('overview');
    await mark(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('a, button').first()).toHaveText('Forums');
    await page.mouse.move(700, 450);
    await page.waitForTimeout(600);
    await expect(menu(page)).toBeVisible();
    await mark(page).click();
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    // A press outside shuts it and leaves focus alone.
    await mark(page).click();
    await expect(menu(page)).toBeVisible();
    await page.mouse.click(700, 450);
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a tap opens it pinned, another shuts it; a tap outside shuts it; All desks, the first row, is the old tap', async ({ page, request }) => {
    const errors = await arrive(page, request);
    // A phone lands on its desk.
    await expect(homeMark(page)).toBeVisible();
    await mark(page).tap();
    await expect(menu(page)).toBeVisible();
    await page.waitForTimeout(600);
    await expect(menu(page)).toBeVisible();
    await mark(page).tap();
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await mark(page).tap();
    await expect(menu(page)).toBeVisible();
    await page.touchscreen.tap(200, 760);
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    if ((await mode(page)) === 'overview') await front(page);
    await mark(page).tap();
    await row(page, 'All desks').tap();
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(await mode(page)).toBe('overview');
    expect(errors).toEqual([]);
  });
});

test.describe('the keyboard', () => {
  test('focus alone never opens it; Enter and Space toggle it with focus on the mark; Down, Up, Home and End move with no wrap', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await front(page);
    await mark(page).focus();
    await page.waitForTimeout(400);
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(mark(page)).toBeFocused();
    await page.keyboard.press(' ');
    await expect(mark(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(mark(page)).toBeFocused();
    expect(await mode(page)).toBe('desk');
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'All desks')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Forums')).toBeFocused();
    await page.keyboard.press('End');
    await expect(row(page, 'Guidelines')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Guidelines')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, 'Terms')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(row(page, 'All desks')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, 'All desks')).toBeFocused();
    // Shift+Tab from the first row goes back to the mark, and it stays open.
    await page.keyboard.press('Shift+Tab');
    await expect(mark(page)).toBeFocused();
    await expect(menu(page)).toBeVisible();
    // Tab goes to the first row, then on through the links.
    await page.keyboard.press('Tab');
    await expect(row(page, 'All desks')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row(page, 'Forums')).toBeFocused();
    // Tabbing past the last link shuts it.
    for (let i = 0; i < 7; i++) await page.keyboard.press('Tab');
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    expect(await mode(page)).toBe('desk');
    expect(errors).toEqual([]);
  });

  test('Esc shuts it and gives the mark the keyboard, and the office\'s Esc (show all desks) never hears it', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await front(page);
    await openByKeys(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Forums')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await expect(mark(page)).toBeFocused();
    await page.waitForTimeout(600);
    expect(await mode(page)).toBe('desk');
    await expect(homeMark(page)).toBeVisible();
    // Opened by hover with the keyboard elsewhere, Esc still shuts it first.
    await page.locator('.canvas-wrap').focus();
    const at = await middle(mark(page));
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(await mode(page)).toBe('desk');
    expect(errors).toEqual([]);
  });

  test('in the overview, Tab and Down reach Forums; Enter on it opens a new tab, shuts the menu and gives the mark the keyboard', async ({ page, request, context }) => {
    await context.route('https://forums.localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Forums</title>' }));
    const errors = await arrive(page, request);
    await openByKeys(page);
    await page.keyboard.press('Tab');
    await expect(row(page, 'Forums')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Forums')).toBeFocused();
    const opened = context.waitForEvent('page');
    await page.keyboard.press('Enter');
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe('https://forums.localhost/');
    // noopener: the new tab can't reach back.
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await expect(mark(page)).toBeFocused();
    await tab.close();
    expect(errors).toEqual([]);
  });
});

test('one popover at a time: opening it shuts the account menu, and opening the account menu shuts it', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await account.click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  const at = await middle(mark(page));
  await page.mouse.move(at.x, at.y);
  await expect(menu(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Account' })).toHaveCount(0);
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(700, 450);
  await expect(page.locator('.mark-pop')).toHaveCount(0);

  await openByKeys(page);
  await account.click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await expect(page.locator('.mark-pop')).toHaveCount(0);
  // And from the keyboard: Enter on the account button with the mark's menu open.
  await page.keyboard.press('Escape');
  await openByKeys(page);
  await account.focus();
  await expect(page.locator('.mark-pop')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('motion', () => {
  test('it unfolds from the mark and is still by 200 ms; the plate is the ribbon\'s blue while open and stays while it folds away', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await mark(page).focus();
    const seen = await page.evaluate(
      () =>
        new Promise<{ running: number; widthAtStart: number; later: number }>((done) => {
          (document.querySelector('.home-mark-btn') as HTMLButtonElement).click();
          requestAnimationFrame(() => {
            const pop = document.querySelector('.mark-pop');
            const running = pop?.getAnimations({ subtree: true }).length ?? -1;
            const surface = document.querySelector('.mark-surface');
            const widthAtStart = surface ? parseFloat(getComputedStyle(surface).width) : -1;
            window.setTimeout(() => done({ running, widthAtStart, later: pop?.getAnimations({ subtree: true }).length ?? -1 }), 320);
          });
        }),
    );
    expect(seen.running).toBeGreaterThan(0);
    expect(seen.widthAtStart).toBeLessThan(232);
    expect(seen.later).toBe(0);
    // The plate's own 120 ms fade off, to read where each state lands (the CSP takes no style tag; the CSSOM is fine).
    await mark(page).evaluate((b) => (b.style.transition = 'none'));
    const plate = (): Promise<string> => mark(page).evaluate((b) => getComputedStyle(b).backgroundColor);
    const open = await plate();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mark-pop.shut')).toHaveCount(1);
    const folding = await plate();
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    expect(open).not.toBe(folding);
    expect(folding).not.toBe('rgba(0, 0, 0, 0)');
    expect(errors).toEqual([]);
  });

  test('reduced motion: no animation runs on it, whole on the next frame and gone on the next frame', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = await arrive(page, request);
    await mark(page).focus();
    const seen = await page.evaluate(
      () =>
        new Promise<{ running: number; width: number }>((done) => {
          (document.querySelector('.home-mark-btn') as HTMLButtonElement).click();
          requestAnimationFrame(() => {
            const pop = document.querySelector('.mark-pop');
            const surface = document.querySelector('.mark-surface');
            done({ running: pop?.getAnimations({ subtree: true }).length ?? -1, width: surface ? parseFloat(getComputedStyle(surface).width) : -1 });
          });
        }),
    );
    expect(seen).toEqual({ running: 0, width: 232 });
    const gone = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          document.querySelector('.home-mark-btn')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => done(document.querySelectorAll('.mark-pop').length)));
        }),
    );
    expect(gone).toBe(0);
    // The hover's delays stay: they're about intent, not motion.
    await clock(page);
    const at = await middle(mark(page));
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    const t = await times(page);
    expect(t.open - t.enter).toBeGreaterThanOrEqual(119);
    expect(errors).toEqual([]);
  });
});

test('the kill switch (markMenu.enabled false): the mark as it was, a button to all desks only with a desk in front, and no menu', async ({ page, request }) => {
  const errors = await arrive(page, request, { extra: { markMenu: { enabled: false } } });
  await expect(page.getByRole('img', { name: 'Minimalist Alliance' })).toBeVisible();
  await expect(mark(page)).toHaveCount(0);
  await front(page);
  const old = page.getByRole('button', { name: 'Your office, show all desks' });
  await expect(old).toBeVisible();
  await expect(old).not.toHaveAttribute('aria-expanded', /.*/);
  const at = await middle(old);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(500);
  await expect(page.locator('.mark-pop')).toHaveCount(0);
  await old.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  expect(await mode(page)).toBe('overview');
  await expect(page.locator('.mark-pop')).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: axe finds nothing serious with it shut and open, and a row's ring is inset`, async ({ page, request }) => {
    const errors = await arrive(page, request, { theme });
    await front(page);
    expect(await sweep(page)).toEqual([]);
    await openByKeys(page);
    expect(await sweep(page)).toEqual([]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await row(page, 'Forums').evaluate((a) => getComputedStyle(a).outlineOffset)).toBe('-2px');
    // No halo for a ring inside the panel, even over an office background.
    expect(await row(page, 'Forums').evaluate((a) => getComputedStyle(a).boxShadow)).toBe('none');
    expect(errors).toEqual([]);
  });
}

// ----- the review's stills and videos, laid out as the Designer's (`stills/01` to `06`), only with MARK_SHOTS set.
test.describe('shots for the review', () => {
  test.skip(!SHOTS, 'set MARK_SHOTS=<dir> to save them');
  test.describe.configure({ timeout: 240_000 });

  const save = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> => {
    mkdirSync(SHOTS!, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${name}.png`, ...(clip ? { clip } : {}) });
  };
  const zenScene = async (page: Page): Promise<void> => {
    // Zen's stills use "Misty mountains", as the Designer's do, so no green shows.
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await openMenuSection(page, 'menu-appearance');
    await page.getByRole('radio', { name: 'Background: Misty mountains' }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(1500);
  };
  const onForums = async (page: Page): Promise<void> => {
    const at = await middle(mark(page));
    await page.mouse.move(at.x, at.y);
    await expect(menu(page)).toBeVisible();
    const f = await middle(row(page, 'Forums'));
    await page.mouse.move(f.x - 60, f.y, { steps: 8 });
    await page.waitForTimeout(400);
  };
  const TOP = { x: 0, y: 0, width: 300, height: 380 };

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`01 open with the pointer on Forums at 1280, ${theme}; 03 the hover hint at rest and hovered; 04 the keyboard`, async ({ page, request }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await arrive(page, request, { theme });
      if (theme === 'dusk') await zenScene(page);
      await front(page);
      const name = theme === 'dusk' ? 'zen' : theme;
      await page.mouse.move(700, 450);
      await page.waitForTimeout(300);
      await save(page, `03-rest-${name}`, { x: 0, y: 0, width: 160, height: 80 });
      const at = await middle(mark(page));
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(60);
      await save(page, `03-hovered-${name}`, { x: 0, y: 0, width: 160, height: 80 });
      await onForums(page);
      await save(page, `01-open-${name}-1280`);
      await page.mouse.move(700, 450);
      await expect(page.locator('.mark-pop')).toHaveCount(0);
      // The keyboard: Tab to the mark (its ring and plate), Enter (open, focus stays), Tab and Tab to Forums.
      await page.locator('.canvas-wrap').focus();
      await mark(page).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(mark(page)).toBeFocused();
      await page.waitForTimeout(200);
      await save(page, `04-1-focus-${name}`, TOP);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
      await save(page, `04-2-enter-${name}`, TOP);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(row(page, 'Forums')).toBeFocused();
      await page.waitForTimeout(150);
      await save(page, `04-3-tab-forums-${name}`, TOP);
    });
  }

  test('02 the phone at 390 with two desks (folded scope button), opened by a tap', async ({ browser, request }) => {
    const ctx = await (browser as Browser).newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await arrive(page, request);
    await expect(page.locator('.topbar.folded')).toHaveCount(1);
    await mark(page).tap();
    await expect(menu(page)).toBeVisible();
    await page.waitForTimeout(400);
    await save(page, '02-open-light-390-phone');
    await ctx.close();
  });

  test('05 reduced motion; 06 with and without All desks; 07 a closed account', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await arrive(page, request);
    await front(page);
    await onForums(page);
    await save(page, '05-reduced-motion', TOP);
    await page.mouse.move(700, 450);
    await expect(page.locator('.mark-pop')).toHaveCount(0);
    await openByKeys(page);
    await save(page, '06-with-all-desks', TOP);
    await page.keyboard.press('Escape');
    await mark(page).focus();
    await page.keyboard.press('Escape'); // the office's Esc: all desks
    await page.waitForTimeout(800);
    await openByKeys(page);
    await save(page, '06-without-all-desks', TOP);
    await page.keyboard.press('Escape');

    const closed = { status: 'ended', tier: 'officer', badge: null, stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null, closed: true, exportUntil: new Date(Date.now() + 19 * 86_400_000).toISOString(), held: false };
    await arrive(page, request, { more: { closedAccount: true, membership: closed, export: { enabled: true } } });
    await openByKeys(page);
    await save(page, '07-closed-account', TOP);
  });

  for (const theme of ['light', 'dusk'] as ThemeId[]) {
    test(`video: the open and the close at 1280, ${theme}`, async ({ browser, request }) => {
      const dir = `${SHOTS}/video-${theme === 'dusk' ? 'zen' : theme}`;
      const ctx = await (browser as Browser).newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } }, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await arrive(page, request, { theme });
      if (theme === 'dusk') await zenScene(page);
      await front(page);
      await page.mouse.move(400, 300);
      await page.waitForTimeout(600);
      // As the Designer's clip: to the mark, it opens; across Forums and Help; away, it shuts.
      const at = await middle(mark(page));
      await page.mouse.move(at.x, at.y, { steps: 20 });
      await page.waitForTimeout(700);
      const f = await middle(row(page, 'Forums'));
      await page.mouse.move(f.x - 40, f.y, { steps: 15 });
      await page.waitForTimeout(500);
      const h = await middle(row(page, 'Help'));
      await page.mouse.move(h.x - 40, h.y, { steps: 10 });
      await page.waitForTimeout(500);
      await page.mouse.move(500, 380, { steps: 20 });
      await page.waitForTimeout(1200);
      await ctx.close();
    });
  }
});
