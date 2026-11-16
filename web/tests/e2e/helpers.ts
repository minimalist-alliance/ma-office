import { expect, type APIRequestContext, type ConsoleMessage, type Locator, type Page } from '@playwright/test';
import { STORED_COURIER } from '../../src/canvas/storedIds';

/**
 * Courier's id where the office stores a layout (its mirror `ma.layout.v2`, Platform's document): `chat` until the flip
 * (`src/canvas/storedIds.ts`, `docs/sub-status/courier-id.md`), so a test seeding or reading stored JSON goes through these.
 * `stored` turns layout JSON in memory's terms into what this build stores; `inMemory` reads stored layout JSON back as
 * `courier`, as the office does.
 */
export const stored = (json: string): string => json.replaceAll('"courier"', `"${STORED_COURIER}"`).replaceAll(':courier"', `:${STORED_COURIER}"`);
export const inMemory = (json: string): string => json.replaceAll('"chat"', '"courier"').replaceAll(':chat"', ':courier"');
/** Layout JSON in memory's terms as every build before Courier's id stored it: `chat`, whatever this build writes. */
export const asOldBuilds = (json: string): string => json.replaceAll('"courier"', '"chat"').replaceAll(':courier"', ':chat"');
/** A stored layout (or anything holding one) read in memory's terms. */
export const fromStored = <T>(value: T): T => (value == null ? value : (JSON.parse(inMemory(JSON.stringify(value))) as T));

export type ThemeId = 'light' | 'dusk' | 'dark';

/** Steer the harness's fake API. */
export async function harness(request: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
  await request.post('/__harness', { data: patch });
}

/**
 * The harness's gateway when no gateway-shim runs (`gatewayUrl()` in `harness/serve.mjs`), which its CSP doesn't allow.
 * A waking desk's link watches it on the gateway from the wake's first answer (TD-227 part 3), so a spec that wakes a
 * desk with no shim sees the browser refuse that address. That line, for that address only, isn't the app's fault.
 */
const NO_GATEWAY = "Connecting to 'ws://localhost:1/v1' violates";

/** Fails a test on any console error, CSP violation included (but `NO_GATEWAY`'s). */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' && !m.text().startsWith(NO_GATEWAY)) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Whether the sign-in card ever showed on this page, however briefly. Set up before the first navigation. */
export async function watchCard(page: Page): Promise<{ seen: boolean }> {
  const card = { seen: false };
  await page.exposeBinding('__maCardSeen', () => {
    card.seen = true;
  });
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="sign-in"]')) (window as unknown as { __maCardSeen: () => void }).__maCardSeen();
    }).observe(document, { childList: true, subtree: true });
  });
  return card;
}

/**
 * A theme's radio in the account menu, by its label ("Light", "Zen", "Dark", "System"), scoped to the Theme control: the
 * Background row under it is radios too, and "Mountain light" or "Dark lake" would match a bare `{ name: 'Light' }`.
 */
export const themeRadio = (page: Page, label: string): Locator => page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: label, exact: true });

/**
 * One of the account menu's tucked sections (`chrome/AccountPanel.tsx`, the owner's Nov 16 tidy), opened if it's shut, with
 * the menu already open: `menu-appearance` (the system-dark choice, Blue and Contrast, Background, the setup circle's switch),
 * `menu-maia` (Maia's rows) or `about-toggle` (the owner's About this desk). Sign out is a plain row, never a section (6.11).
 */
export async function openMenuSection(page: Page, testId: 'menu-appearance' | 'menu-maia' | 'about-toggle'): Promise<void> {
  const row = page.locator('#account-panel').getByTestId(testId);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

export async function setTheme(page: Page, theme: ThemeId): Promise<void> {
  await page.addInitScript((t) => {
    // Not in a frame: an app's view is a sandboxed frame with no storage (ADR 0054), where this would throw.
    if (window !== window.top) return;
    localStorage.setItem('ma.prefs.theme', JSON.stringify({ mode: t, systemDark: 'dark' }));
    localStorage.setItem('ma.theme.resolved', t);
  }, theme);
}

/**
 * Through the real redirect and the real callback code, by the fake Cognito, or with auth.signInPath on by the
 * stand-in for our own sign-in pages, with no button on the way. The loop guard's card has one, which this presses.
 */
export async function signIn(page: Page, path = '/'): Promise<void> {
  // Desks wear Light oak unless the member chose, and most specs measure the flat desk of before (the etch, the surface).
  // So unless a spec brings its own styles (`__maTestDeskStyles`, `deskStyle.shell.spec.ts`), the only built-in style is Plain.
  await page.addInitScript(() => {
    const w = window as unknown as { __maTestDeskStyles?: unknown };
    w.__maTestDeskStyles ??= [{ id: 'plain', name: 'Plain', onlyPlain: true, looks: {} }];
  });
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(button.or(page.locator('.ma-shell')).first()).toBeVisible();
  if (await button.isVisible()) await button.click();
  await expect(page.locator('.ma-shell')).toBeVisible();
  if (path !== '/') await page.goto(path);
  await expect(page.locator('.ma-shell')).toBeVisible();
}

/** The refresh token as the app reads it (`platform/tokenStore.ts`): this tab's sessionStorage copy, then localStorage. */
export function storedRefreshToken(page: Page): Promise<string | null> {
  return page.evaluate(() => sessionStorage.getItem('ma-desk-web-refresh') ?? localStorage.getItem('ma-desk-web-refresh'));
}

/** Where it is: [localStorage, sessionStorage]. */
export function refreshTokenPlaces(page: Page): Promise<[string | null, string | null]> {
  return page.evaluate(() => [localStorage.getItem('ma-desk-web-refresh'), sessionStorage.getItem('ma-desk-web-refresh')] as [string | null, string | null]);
}

/** What another tab does when it rotates the token: where this tab reads it from. */
export function storeRefreshToken(page: Page, token: string): Promise<void> {
  return page.evaluate((value) => {
    if (sessionStorage.getItem('ma-desk-web-refresh') !== null) sessionStorage.setItem('ma-desk-web-refresh', value);
    else localStorage.setItem('ma-desk-web-refresh', value);
  }, token);
}

/**
 * The mark while a mouse click on it shows all desks (`chrome/TopBar.tsx` `HomeMark`, `data-home`): a desk in front and more
 * than one in scope. The mark is a button at other times too, "Minimalist Alliance", whose click then opens its menu.
 */
export const homeMark = (page: Page): Locator => page.locator('.home-mark-btn[data-home]');

/**
 * All desks, as a mouse click on the mark does, even with a window over the bar. A script's bare `click()` has no press
 * before it, which the mark takes for the keyboard: that opens its menu instead.
 */
export async function markHome(page: Page): Promise<void> {
  await homeMark(page).evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
}

/** All desks on a phone: a tap on the mark opens its menu, whose first row is All desks. */
export async function tapHome(page: Page): Promise<void> {
  await homeMark(page).tap();
  await page.locator('#mark-menu').getByRole('button', { name: 'All desks' }).tap();
}

export async function canvasPainted(page: Page): Promise<void> {
  await page.waitForFunction(() => performance.getEntriesByName('ma:first-canvas-paint').length > 0);
  await page.waitForTimeout(400); // the fit and the settle redraw
}

/**
 * Give the canvas the keyboard, as a press on it does, and nothing else. Its single keys act only while it has focus
 * (`shell/useKeyboard.ts`), so a test that presses `1` or `\` for some other reason starts here.
 */
export async function focusCanvas(page: Page): Promise<void> {
  await page.locator('.canvas-wrap').focus();
}
