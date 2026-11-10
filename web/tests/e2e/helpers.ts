import { expect, type APIRequestContext, type ConsoleMessage, type Page } from '@playwright/test';

export type ThemeId = 'light' | 'dusk' | 'dark';

/** Steer the harness's fake API. */
export async function harness(request: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
  await request.post('/__harness', { data: patch });
}

/** Fails a test on any console error, CSP violation included. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
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

export async function setTheme(page: Page, theme: ThemeId): Promise<void> {
  await page.addInitScript((t) => {
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
