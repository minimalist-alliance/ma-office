// The bundle exactly as it ships: the real link, the loader path, the default CSP, and the real auth
// code against the harness's fake Cognito and API. No desk here: its `connect` keeps saying "not
// ready". `rtc.spec.ts` drives this same bundle against a real desk-rtc.
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, storedRefreshToken, storeRefreshToken, watchCard, watchConsole, type ThemeId } from './helpers';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the loader path, sign-in and desk list work under the default CSP', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  const errors = watchConsole(page);
  const card = await watchCard(page);
  await page.goto('/');
  // Sign-in comes first, with nothing to press on the way.
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  expect(card.seen).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('button', { name: /^Personal desk, 4 apps, connecting…/ })).toHaveCount(1);
  const log = (await (await request.get('/__harness')).json()).log as string[];
  expect(log).toContain('GET /v1/desks');
  expect(log).toContain('POST /fake-auth/oauth2/token');
  expect(errors).toEqual([]);
});

test('the etched name\'s font is self-hosted, loads under the default CSP, and only its Latin subset is fetched', async ({ page }) => {
  const errors = watchConsole(page);
  const fonts: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('jost')) fonts.push(r.url());
  });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.fonts.check('600 14px "Jost"', 'PERSONAL'))).toBe(true);
  expect(fonts.length).toBe(1);
  expect(new URL(fonts[0]!).origin).toBe(new URL(page.url()).origin);
  expect(fonts[0]).toMatch(/jost-latin-600-normal.*\.woff2$/);
  expect(errors).toEqual([]);
});

test('the layout reaches Platform from the shipping bundle: a real GET and If-Match PUT, under the default CSP', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  const state = async (): Promise<{ layoutDocs: Record<string, { version: number; layout: { schemaVersion: number; desks: Record<string, unknown> } } | undefined>; layoutGets: unknown[]; layoutPuts: { ifMatch: string; status: number }[] }> => (await request.get('/__harness')).json();
  await expect.poll(async () => (await state()).layoutGets.length).toBeGreaterThan(0);
  // A first change, from the keyboard: nothing to upload until then, for a desk still at its default.
  const proxy = page.getByRole('button', { name: /^Personal desk/ });
  await proxy.focus();
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state()).layoutDocs['u-test']?.layout.schemaVersion, { timeout: 8_000 }).toBe(2);
  expect((await state()).layoutPuts.every((p) => p.status === 200)).toBe(true);
  expect(errors).toEqual([]);
});

test('desk styles as they ship: Light oak by default, the chooser lists the five, and only the images a desk wears are fetched, as files of their own', async ({ page }) => {
  const errors = watchConsole(page);
  const images: { url: string; status: number }[] = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'image' && /\.(webp|png|avif|jpe?g)(\?|$)/.test(r.url())) images.push({ url: r.url(), status: r.status() });
  });
  await signIn(page);
  await canvasPainted(page);
  const proxy = page.getByRole('button', { name: /^Personal desk/ });
  await proxy.focus();
  await page.keyboard.press('.');
  const menu = page.getByRole('menu', { name: 'Desk' });
  await expect(menu.getByRole('menuitem', { name: 'Resize' })).toBeVisible();
  const group = menu.getByRole('group', { name: 'Desk style' });
  await expect(group).toBeVisible();
  expect(await group.getByRole('menuitemradio').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Light oak', 'White ash', 'Walnut', 'Linoleum', 'Plain']);
  await expect(group.getByRole('menuitemradio', { name: 'Light oak' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByTestId('desk-style-name')).toHaveText('Light oak');
  await page.keyboard.press('Escape');
  // Past the idle preload of the style's other two themes. The swatches are CSS backgrounds, not fetched until the menu showed them.
  await page.waitForTimeout(2500);
  const mine = images.filter((i) => /\/oak-(light|dusk|dark)-[\w-]+\.webp$/.test(new URL(i.url).pathname));
  expect(mine.length).toBeGreaterThanOrEqual(1);
  expect(images.every((i) => i.status === 200)).toBe(true);
  // Only the style a desk wears is fetched for the canvas; the swatches may show the others in the current theme.
  expect(images.filter((i) => /\/(ash|walnut|linoleum)-(dusk|dark)-/.test(i.url))).toEqual([]);
  expect(errors).toEqual([]);
});

test('each self-hosted font has its OFL licence beside it, in the shipping bundle', async ({ page }) => {
  const fonts = new Map<string, string>();
  page.on('request', (r) => {
    const m = /\/(inter|jost)-[^/]*\.woff2$/.exec(new URL(r.url()).pathname);
    if (m) fonts.set(m[1]!, r.url());
  });
  await signIn(page);
  await canvasPainted(page);
  await expect.poll(() => [...fonts.keys()].sort()).toEqual(['inter', 'jost']);
  for (const [name, author] of [['inter', 'The Inter Project Authors'], ['jost', 'The Jost Project Authors']] as const) {
    const licence = new URL(`${name}-OFL.txt`, fonts.get(name)).href; // the same directory as the font
    const res = await page.request.get(licence);
    expect(res.status(), licence).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain(`Copyright 20`);
    expect(text).toContain(author);
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  }
});

test('the Google button shows only when client-config allows it', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await page.goto('/signed-out');
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await harness(request, { google: true });
  await page.goto('/signed-out');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});

test('production has no mock data: apps are honest until a desk answers', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { roles: ['owner'] }); // About this desk is the owner's only
  await signIn(page);
  await canvasPainted(page);
  const tile = page.getByRole('button', { name: /^Notebook/ });
  await tile.focus();
  await page.keyboard.press('Enter');
  const win = page.getByRole('dialog', { name: /Notebook/ });
  await expect(win.getByTestId('notebook-panel')).toBeAttached();
  await expect(win.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByTestId('about-toggle').click();
  await expect(page.getByTestId('about-desk')).toHaveText("This desk isn't connected yet.");
  expect(await page.evaluate(() => '__maDesk' in window)).toBe(false);
  expect(errors).toEqual([]);
});

test('a refused account gets the calm screen on a 403, after sign-in', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await harness(request, { desks: 'forbidden' });
  await page.goto('/');
  await expect(page.getByTestId('refusal')).toBeVisible();
  await expect(page.getByTestId('refusal')).toContainText("can't open this office");
  await expect(page.locator('.ma-shell')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/shots/refusal.png' });
});

test('the top-left mark loads in every theme from the shipping bundle', async ({ page, request }) => {
  await harness(request, { desks: 'empty' });
  await signIn(page);
  await expect(page.getByRole('img', { name: 'Minimalist Alliance' })).toBeVisible();
  for (const theme of ['light', 'dusk', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset['theme'] = t; }, theme);
    const shown = page.locator('.home-mark-img:visible');
    await expect(shown).toHaveCount(1);
    await expect.poll(() => shown.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/shots/mark-no-desk.png' });
});

test('an empty list is a calm state', async ({ page, request }) => {
  await harness(request, { desks: 'empty' });
  await signIn(page);
  await expect(page.getByTestId('desks-empty')).toBeVisible();
  await expect(page.locator('.bottombar')).toHaveCount(0); // nothing to zoom or pan yet
  await page.screenshot({ path: 'test-results/shots/empty.png' });
});

test('an API error is a calm state with a working retry', async ({ page, request }) => {
  await harness(request, { desks: 'error' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await signIn(page);
  await expect(page.getByTestId('desks-error')).toBeVisible();
  await harness(request, { desks: 'ok' });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
  expect(errors).toEqual([]);
});

const pollList = (page: Page): Promise<boolean> => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const logOf = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log;

test('after an outage, a 304 clears the "can\'t reach" notice', async ({ page, request }) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
  await harness(request, { desks: 'error' });
  await pollList(page);
  await expect(page.getByTestId('desks-stale')).toBeVisible();
  await harness(request, { desks: 'ok' });
  await pollList(page);
  await expect(page.getByTestId('desks-stale')).toBeHidden();
  expect(await logOf(request)).toContain('list 304');
});

test('a 304 keeps the pace the last full list asked for', async ({ page, request }) => {
  await harness(request, { fleet: [{ deskId: 'd-waking0000001', name: 'Personal', kind: 'personal', state: 'starting' }] });
  await signIn(page);
  // 2 s while a desk is transitional (contract desks.md), not 60 s after the first 304.
  await expect.poll(async () => (await logOf(request)).filter((l) => l === 'list 304').length, { timeout: 9_000 }).toBeGreaterThanOrEqual(3);
  const polls = (await logOf(request)).filter((l) => l === 'GET /v1/desks').length;
  expect(polls).toBeLessThanOrEqual(6);
});

test('card A, as it ships: "Membership opens soon." with no billing, and a button to the account page with it', async ({ page, request }) => {
  await harness(request, { desks: 'unpaid', membership: { status: 'unpaid' } });
  const errors = watchConsole(page);
  await signIn(page);
  await expect(page.getByTestId('desks-welcome')).toContainText('Membership opens soon.');
  await expect(page.getByRole('link', { name: 'See membership' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open billing' })).toHaveCount(0);
  // Platform's own config, under the default CSP: the only place that says whether Pay is open.
  expect((await (await request.get('/__harness')).json()).log).toContain('client-config platform-web');
  // The picture's etched names are the desk's own Jost, self-hosted.
  await expect.poll(() => page.evaluate(() => document.fonts.check('600 12px "Jost"', 'PERSONAL'))).toBe(true);

  await harness(request, { platformBilling: { enabled: true, officerMonthlyUsd: 100 } });
  await page.reload();
  await expect(page.getByRole('link', { name: 'See membership' })).toHaveAttribute('href', 'https://platform.localhost/account');
  await expect(page.getByTestId('desks-welcome')).not.toContainText('Membership opens soon.');
  expect(errors).toEqual([]);
});

test('a returning member paints the desk from the mirror and refreshes behind it', async ({ page, request }) => {
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(1200); // the layout mirror is debounced by 1 s
  await harness(request, { desks: 'error' });
  await page.reload();
  // No network list, but the mirror still paints the desk.
  await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
  await expect(page.getByTestId('desks-stale')).toBeVisible();
  const log = (await (await request.get('/__harness')).json()).log as string[];
  expect(log.filter((l) => l === 'POST /fake-auth/oauth2/token').length).toBe(2);
});

test('a dead refresh token returns to sign-in, calmly', async ({ page, request }) => {
  await signIn(page);
  await canvasPainted(page);
  await harness(request, { refreshFails: true });
  await page.reload();
  // Just after signing in, so the guard has it end here in either mode: 'a dead session' below has where it goes otherwise.
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
  expect(await storedRefreshToken(page)).toBeNull();
});

test.describe('a refresh that keeps failing', () => {
  const TRIGGER_FAILED = { status: 400, body: { error: 'PreTokenGenerationV2_0 failed with error Internal. Error Code: UserLambdaValidationException; Request ID: 1234' } };
  const signInCalls = async (request: APIRequestContext): Promise<number> => (await logOf(request)).filter((l) => l.includes('/oauth2/authorize') || l.startsWith('GET /_signin/')).length; // on managed login, or on our own pages
  const refreshesSent = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { refreshSent: string[] }).refreshSent;

  test('a page load keeps the member in the office, and it recovers with no nudge', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(1200); // the layout mirror is debounced by 1 s
    const kept = await storedRefreshToken(page);
    expect(kept).toMatch(/^refresh-/);

    await harness(request, { refreshFailure: TRIGGER_FAILED });
    await page.reload();
    await expect(page.locator('.ma-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
    await expect(page.getByTestId('desks-stale')).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    expect(await storedRefreshToken(page)).toBe(kept);
    await page.screenshot({ path: 'test-results/shots/refresh-failing.png' });

    await harness(request, { refreshFailure: null });
    await expect(page.getByTestId('desks-stale')).toBeHidden({ timeout: 20_000 }); // the list's own retry, 15 s
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await storedRefreshToken(page)).not.toBe(kept); // rotated, by the token it kept
    expect((await refreshesSent(request)).at(-1)).toBe(kept);
    expect(await signInCalls(request)).toBe(1); // only the first sign-in, before any of this
    expect(errors).toEqual([]);
  });

  test('a first load with no mirror shows the calm notice, then the desks', async ({ page, request }) => {
    await signIn(page);
    // The list answers after the shell shows, and its answer writes the mirror: wait for it, or it comes back.
    await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
    await harness(request, { refreshFailure: { status: 503, body: { message: 'Service Unavailable' } } });
    await page.evaluate(() => localStorage.removeItem('ma.desks.v1'));
    await page.reload();
    await expect(page.getByTestId('desks-error')).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    await harness(request, { refreshFailure: null });
    await page.getByRole('button', { name: 'Try again' }).click(); // doesn't wait out the backoff
    await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
    await expect(page.getByTestId('desks-error')).toHaveCount(0);
  });

  test('with the access token expired, no failure signs the member out, and there is no tight loop', async ({ page, request }) => {
    await harness(request, { expiresIn: 2 }); // inside the 5 minute margin, so every call refreshes
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(2100);
    const kept: string[] = [];
    for (const failure of [
      TRIGGER_FAILED,
      { status: 503, body: { message: 'Service Unavailable' } },
      { status: 401, body: { error: 'invalid_client' } },
      { status: 400, body: '<html>Bad Request</html>' },
      'drop',
    ]) {
      await harness(request, { refreshFailure: failure });
      const before = (await refreshesSent(request)).length;
      await pollList(page); // doesn't wait out the backoff
      await expect.poll(async () => (await refreshesSent(request)).length).toBeGreaterThan(before);
      await expect(page.getByTestId('desks-stale')).toBeVisible();
      await expect(page.getByTestId('sign-in')).toHaveCount(0);
      kept.push((await storedRefreshToken(page)) ?? 'gone');
    }
    expect(kept.every((t) => t === kept[0] && t.startsWith('refresh-'))).toBe(true);

    // Left alone for 8 s with a link retrying every 3 s and the list every 15 s: 2, 4, 8 s apart at the very most.
    const before = (await refreshesSent(request)).length;
    await page.waitForTimeout(8_000);
    expect((await refreshesSent(request)).length - before).toBeLessThanOrEqual(3);

    // By now the backoff is at its 30 s cap, so back in the tab is what ends the wait.
    await harness(request, { refreshFailure: null });
    await pollList(page);
    await expect(page.getByTestId('desks-stale')).toBeHidden();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    expect(await signInCalls(request)).toBe(1);
  });

  test('invalid_grant mid-session still signs a member out, and clears the token', async ({ page, request }) => {
    await harness(request, { expiresIn: 2 });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(2100);
    await harness(request, { refreshFailure: TRIGGER_FAILED });
    await pollList(page);
    await expect(page.getByTestId('desks-stale')).toBeVisible();
    await harness(request, { refreshFails: true });
    await pollList(page);
    await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
    expect(await storedRefreshToken(page)).toBeNull();
  });

  test('invalid_grant for a token another tab rotated away leaves the newer one, and uses it', async ({ page, request }) => {
    await signIn(page);
    await canvasPainted(page);
    const old = (await storedRefreshToken(page)) as string;
    await harness(request, { refreshRefuses: [old], refreshDelayMs: 1500 });
    await page.reload();
    await expect.poll(() => refreshesSent(request)).toContain(old);
    await storeRefreshToken(page, 'refresh-from-another-tab'); // while the refused request is on its way
    await expect.poll(() => refreshesSent(request)).toContain('refresh-from-another-tab');
    await harness(request, { refreshDelayMs: 0 });
    await expect(page.locator('.ma-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
    await expect.poll(() => storedRefreshToken(page)).toMatch(/^refresh-\d+$/); // the newer one's successor
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    expect(await signInCalls(request)).toBe(1);
  });
});

test('a forged callback is refused', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await page.goto('/auth/callback?code=stolen&state=wrong');
  await expect(page.getByTestId('sign-in')).toContainText("couldn't be verified");
  expect(new URL(page.url()).pathname).toBe('/');
});

test('sign-out revokes, logs out and lands on the signed-out screen', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await signIn(page);
  await canvasPainted(page);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  const log = (await (await request.get('/__harness')).json()).log as string[];
  expect(log).toContain('POST /v1/me/sign-out');
  expect(log).toContain('POST /fake-auth/oauth2/revoke');
  expect(log).toContain('GET /fake-auth/logout');
  expect(log.filter((l) => l.includes('/oauth2/authorize'))).toHaveLength(1); // only the first sign-in: it's the card that ends this
});

// Platform's sign-out fix, matched (task 34 item 2): `fetch` resolves on the headers, so leaving then cut the revoke
// off. These take whichever sign-in the suite runs with (HARNESS_SIGN_IN_PATH), so they run in both.
test.describe('sign-out reads the revoke to the end, then leaves', () => {
  const harnessState = async (request: APIRequestContext) => (await (await request.get('/__harness')).json()) as { log: string[]; revoked: string[] };

  test('a slow answer: Signing out… while it comes, the whole of it, then the logout, and that token is revoked', async ({ page, request }) => {
    await harness(request, { revokeBodyMs: 800 });
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    const token = await storedRefreshToken(page);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    const { log, revoked } = await harnessState(request);
    const at = (line: string): number => log.indexOf(line);
    expect(at('POST /v1/me/sign-out')).toBeGreaterThan(-1);
    expect(at('POST /fake-auth/oauth2/revoke')).toBeGreaterThan(at('POST /v1/me/sign-out'));
    expect(at('revoke answered in full')).toBeGreaterThan(at('POST /fake-auth/oauth2/revoke'));
    expect(at('GET /fake-auth/logout')).toBeGreaterThan(at('revoke answered in full'));
    expect(log).not.toContain('revoke cut off');
    expect(revoked).toEqual([token]);
  });

  test('a revoke that never answers: sign-out still ends, after about 3 s', async ({ page, request }) => {
    await harness(request, { revokeHolds: true });
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    await page.getByRole('button', { name: 'Account' }).click();
    const pressed = Date.now();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.", { timeout: 10_000 });
    expect(Date.now() - pressed).toBeGreaterThanOrEqual(2_900);
    expect(Date.now() - pressed).toBeLessThan(8_000);
    expect((await harnessState(request)).log).toContain('GET /fake-auth/logout');
  });

  test('a second press, before the button can say so, starts nothing: one sign-out, its revoke whole', async ({ page, request }) => {
    await harness(request, { desks: 'forbidden', revokeBodyMs: 500 });
    await page.goto('/');
    await expect(page.getByTestId('refusal')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((el: HTMLButtonElement) => {
      el.click();
      el.click(); // before React has rendered it disabled
    });
    await expect(page.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    const { log } = await harnessState(request);
    expect(log.filter((l) => l === 'POST /v1/me/sign-out')).toHaveLength(1);
    expect(log.filter((l) => l === 'POST /fake-auth/oauth2/revoke')).toHaveLength(1);
    expect(log.filter((l) => l === 'GET /fake-auth/logout')).toHaveLength(1);
    expect(log.indexOf('revoke answered in full')).toBeLessThan(log.indexOf('GET /fake-auth/logout'));
    expect(log).not.toContain('revoke cut off');
  });
});

test.describe('auth.signInPath present: our own sign-in pages', () => {
  const harnessLog = async (request: APIRequestContext) => (await (await request.get('/__harness')).json()).log as string[];

  test.beforeEach(async ({ request }) => {
    await harness(request, { signInPath: '/_signin/', google: true });
  });

  test('a signed-out member goes straight there, and the refresh token they leave signs in', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    expect(new URL(page.url()).pathname).toBe('/');
    const log = await harnessLog(request);
    expect(log).toContain('GET /_signin/?return=%2F');
    expect(log).toContain('POST /fake-auth/oauth2/token');
    expect(log.some((l) => l.includes('/oauth2/authorize'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('a reload stays signed in, without going back there', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    await page.reload();
    await expect(page.locator('.ma-shell')).toBeVisible();
    expect((await harnessLog(request)).filter((l) => l.startsWith('GET /_signin/'))).toHaveLength(1);
  });

  test('signed out, the calm screen stays, offers one way in, and it goes there', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.ma-shell')).toBeVisible();
    expect((await harnessLog(request)).filter((l) => l.startsWith('GET /_signin/'))).toHaveLength(2);
  });

  test('a refused account still gets its calm screen, after coming back', async ({ page, request }) => {
    await harness(request, { desks: 'forbidden' });
    await page.goto('/');
    await expect(page.getByTestId('refusal')).toBeVisible();
    expect((await harnessLog(request)).filter((l) => l.startsWith('GET /_signin/'))).toHaveLength(1);
  });

  test('signInPath on before the route exists: no growing redirect loop, and managed login takes over', async ({ page, request }) => {
    await harness(request, { signInRouteMissing: true });
    await page.goto('/');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await expect(page).toHaveURL(/\/_signin\/\?return=%2F$/);
    expect((await harnessLog(request)).filter((l) => l.startsWith('GET /_signin/'))).toEqual(['GET /_signin/?return=%2F']);
    await page.waitForTimeout(500);
    expect((await harnessLog(request)).filter((l) => l.startsWith('GET /_signin/'))).toHaveLength(1);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.ma-shell')).toBeVisible();
    expect(await harnessLog(request)).toContain('GET /fake-auth/oauth2/authorize');
  });

  test('that same missing route, arriving there first with Google failing: still no loop', async ({ page, request }) => {
    await harness(request, { signInRouteMissing: true });
    await page.goto('/auth/callback?error=access_denied');
    await page.waitForURL(/\/_signin\/\?error=google$/);
    await expect(page.getByTestId('sign-in')).toBeVisible();
    expect((await harnessLog(request)).filter((l) => l.startsWith('GET /_signin/'))).toHaveLength(1);
  });

  test('Google failing comes back to our own pages, with no message of its own', async ({ page }) => {
    await page.goto('/auth/callback?error=access_denied&error_description=nope&state=x');
    await page.waitForURL(/\/_signin\/\?error=google$/);
    await expect(page.getByRole('heading', { name: 'Sign-in pages' })).toBeVisible();
  });
});

test.describe('auth.signInPath absent: managed login', () => {
  const AUTHORIZE = /\/fake-auth\/oauth2\/authorize\?/;
  const GUARD_KEY = 'ma.auth.leftForSignIn';
  const authorizes = async (request: APIRequestContext): Promise<number> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log.filter((l) => l.includes('/oauth2/authorize')).length;

  test.beforeEach(async ({ request }) => {
    await harness(request, { signInPath: null });
  });

  test('a signed-out member goes straight there, with no card on the way, by the PKCE start, and lands in the office', async ({ page, request }) => {
    const errors = watchConsole(page);
    const card = await watchCard(page);
    const asked: URL[] = [];
    page.on('request', (r) => {
      if (AUTHORIZE.test(r.url())) asked.push(new URL(r.url()));
    });
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    expect(card.seen).toBe(false);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(asked).toHaveLength(1);
    const q = asked[0]!.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBeTruthy();
    expect(q.get('state')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('identity_provider')).toBeNull();
    const log = (await (await request.get('/__harness')).json()).log as string[];
    expect(log.some((l) => l.startsWith('GET /_signin/'))).toBe(false);
    expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
    expect(errors).toEqual([]);
  });

  test('any path goes there, and a member reading its form stays there', async ({ page, request }) => {
    await harness(request, { authorizeHolds: true });
    await page.goto('/somewhere?x=1');
    await page.waitForURL(AUTHORIZE);
    await expect(page.getByRole('heading', { name: 'Managed login' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await authorizes(request)).toBe(1);
  });

  test('Back from there doesn\'t land on a page that sends them there again', async ({ page, request }) => {
    await harness(request, { authorizeHolds: true, signInHolds: true });
    await page.goto('/_signin/?from=here');
    await page.goto('/');
    await page.waitForURL(AUTHORIZE);
    await page.goBack();
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe('/_signin/');
    expect(await authorizes(request)).toBe(1);
  });

  for (const [where, words] of [['callback', "couldn't be verified"], ['home', '']] as const) {
    test(`a managed login that comes straight back with no code, to ${where}, ends at the card and stops there`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { authorizeBounces: where });
      await page.goto('/');
      await expect(page.getByTestId('sign-in')).toBeVisible();
      if (words) await expect(page.getByTestId('sign-in')).toContainText(words);
      await page.waitForTimeout(1000);
      expect(await authorizes(request)).toBe(1);
      expect(new URL(page.url()).pathname).toBe('/');
      expect(errors).toEqual([]);

      // Pressing the button is the member's own round, and the guard has no say in it.
      await harness(request, { authorizeBounces: null });
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('.ma-shell')).toBeVisible();
    });
  }

  test('the guard lapses: past 30 s, signed out goes there again', async ({ page, request }) => {
    await harness(request, { authorizeHolds: true });
    await page.goto('/signed-out');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await page.evaluate((key) => sessionStorage.setItem(key, String(Date.now() - 31_000)), GUARD_KEY);
    await page.goto('/');
    await page.waitForURL(AUTHORIZE);
  });

  test('within 30 s it\'s the card, and it\'s only this tab\'s', async ({ page, request }) => {
    await harness(request, { authorizeHolds: true });
    await page.goto('/signed-out');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await page.evaluate((key) => sessionStorage.setItem(key, String(Date.now() - 5_000)), GUARD_KEY);
    await page.goto('/');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    expect(await authorizes(request)).toBe(0);

    const other = await page.context().newPage();
    await other.goto('/');
    await other.waitForURL(AUTHORIZE);
  });

  test('with session storage blocked, the guard can\'t count, so it\'s the card', async ({ page, request }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get: () => { throw new DOMException('blocked', 'SecurityError'); } }));
    await page.goto('/');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await authorizes(request)).toBe(0);
  });

  test('a setting it can\'t use reads as no setting, so it goes there too', async ({ page, request }) => {
    await harness(request, { signInPath: 'https://evil.example/in/', authorizeHolds: true });
    await page.goto('/');
    await page.waitForURL(AUTHORIZE);
    expect(new URL(page.url()).hostname).toBe('localhost');
  });

  test('with no client-config it can\'t go anywhere: the card says so, and its retry brings the button', async ({ page, request }) => {
    let calls = 0;
    await page.route('**/v1/client-config**', (route) => {
      calls += 1;
      return calls > 1 ? route.abort() : route.continue(); // the loader's gets through, and the app's don't
    });
    await page.goto('/');
    await expect(page.getByTestId('sign-in')).toContainText("can't be reached");
    expect(await authorizes(request)).toBe(0);
    await page.unroute('**/v1/client-config**');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await authorizes(request)).toBe(0);
  });

  test('a deliberate sign-out keeps its card, and goes nowhere by itself', async ({ page, request }) => {
    const card = await watchCard(page);
    await page.goto('/');
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    expect(card.seen).toBe(false);
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    expect(await authorizes(request)).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.ma-shell')).toBeVisible();
    expect(await authorizes(request)).toBe(2);
  });

  test('/signed-out by itself is the card, with Google where it\'s allowed, and Google still redirects straight there', async ({ page, request }) => {
    await harness(request, { google: true });
    await page.goto('/signed-out');
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    await page.waitForTimeout(300);
    expect(await authorizes(request)).toBe(0);
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.locator('.ma-shell')).toBeVisible();
    const log = (await (await request.get('/__harness')).json()).log as string[];
    expect(log).toContain('GET /fake-auth/oauth2/authorize');
    expect(log.some((l) => l.startsWith('GET /_signin/'))).toBe(false);
  });

  test('a reload of that card is a signed-out member like any other, and goes there', async ({ page, request }) => {
    await harness(request, { authorizeHolds: true });
    await page.goto('/signed-out');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await page.reload();
    await page.waitForURL(AUTHORIZE);
  });

  test('a cancelled sign-in stays on the calm screen, with its own words', async ({ page, request }) => {
    await page.goto('/auth/callback?error=access_denied');
    await expect(page.getByTestId('sign-in')).toContainText('Sign-in was cancelled');
    await page.waitForTimeout(300);
    expect(await authorizes(request)).toBe(0);
  });
});

test.describe('/account is a page on the Platform app', () => {
  const ACCOUNT = 'https://platform.localhost/account';
  const platformStandIn = (page: Page) => page.context().route('https://platform.localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Platform</title><h1>Platform account</h1>' }));
  const signInsHere = async (request: APIRequestContext): Promise<string[]> => (await logOf(request)).filter((l) => l.includes('/oauth2/') || l.startsWith('GET /_signin/'));
  const platformHeading = (page: Page) => page.getByRole('heading', { name: 'Platform account' });

  for (const signInPath of [null, '/_signin/']) {
    test.describe(signInPath ? 'with our own pages' : 'with managed login', () => {
      test.beforeEach(async ({ request }) => {
        await harness(request, { signInPath });
      });

      for (const path of ['/account', '/account/']) {
        test(`signed out, ${path} goes there before any sign-in here, and only once`, async ({ page, request }) => {
          const errors = watchConsole(page);
          await platformStandIn(page);
          const went: string[] = [];
          page.on('framenavigated', (f) => went.push(f.url()));
          await page.goto(path);
          await expect(platformHeading(page)).toBeVisible();
          expect(page.url()).toBe(ACCOUNT);
          await page.waitForTimeout(300);
          expect(went.filter((u) => u === ACCOUNT)).toHaveLength(1);
          expect(await signInsHere(request)).toEqual([]);
          expect(errors).toEqual([]);
        });
      }

      test('signed in, it goes there too, and this site keeps its session', async ({ page }) => {
        await platformStandIn(page);
        await signIn(page);
        await page.goto('/account');
        await expect(platformHeading(page)).toBeVisible();
        await page.goto('/');
        await expect(page.locator('.ma-shell')).toBeVisible();
        expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
      });

      test('Back from there skips /account, so it can\'t bounce', async ({ page, request }) => {
        await harness(request, { signInHolds: true });
        await platformStandIn(page);
        await page.goto('/_signin/?from=here');
        await page.goto('/account');
        await expect(platformHeading(page)).toBeVisible();
        await page.goBack();
        expect(new URL(page.url()).pathname).toBe('/_signin/');
      });

      test('a link that\'s missing or odd carries on as today, with no trip anywhere', async ({ page, request }) => {
        await harness(request, { signInHolds: true, authorizeHolds: true });
        for (const accountLink of [null, 'http://platform.localhost/account', 'https://evil.example/account', 'https://localhost/account', 'https://office.localhost/account', 'https://a.platform.localhost/account', '/account']) {
          await harness(request, { accountLink });
          await page.goto('/account');
          if (signInPath) await page.waitForURL(/\/_signin\/\?return=%2Faccount$/);
          else await expect(page.getByRole('heading', { name: 'Managed login' }).or(page.getByTestId('sign-in'))).toBeVisible(); // the first goes there, and the guard takes the rest
          expect(new URL(page.url()).hostname).toBe('localhost');
        }
      });

      test('it\'s that path only', async ({ page, request }) => {
        await harness(request, { signInHolds: true, authorizeHolds: true });
        for (const path of ['/accounts', '/account/settings', '/Account']) {
          await page.goto(path);
          if (signInPath) await page.waitForURL(/\/_signin\/\?return=/);
          else await expect(page.getByRole('heading', { name: 'Managed login' }).or(page.getByTestId('sign-in'))).toBeVisible();
          expect(new URL(page.url()).hostname).toBe('localhost');
        }
      });

      test('the account menu opens Account settings over the office, the keyboard reaches it, and Esc puts it away', async ({ page }) => {
        await platformStandIn(page);
        await signIn(page);
        await canvasPainted(page);
        const button = page.getByRole('button', { name: 'Account' });
        await button.click();
        const item = page.getByRole('button', { name: 'Account settings', exact: true });
        await expect(item).toHaveAttribute('aria-haspopup', 'dialog');

        // Esc closes the menu from the item, as from anything in the panel.
        await page.getByRole('button', { name: 'Sign out', exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
        await expect(item).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(item).toHaveCount(0);
        await expect(button).toBeFocused();

        await button.click();
        await item.focus();
        await page.keyboard.press('Enter');
        const settings = page.getByRole('dialog', { name: 'Account settings', exact: true });
        await expect(settings).toBeVisible();
        // Until Platform lets the office frame its account page, the page is offered as its own: no "(opens in a new tab)".
        const open = settings.getByRole('link', { name: 'Open account settings', exact: true });
        await expect(open).toHaveAttribute('href', ACCOUNT);
        await expect(open).toHaveAttribute('target', '_blank');
        await expect(settings).not.toContainText('opens in a new tab');
        const opened = page.context().waitForEvent('page');
        await open.click();
        const tab = await opened;
        await expect(platformHeading(tab)).toBeVisible();
        await tab.close();

        // This tab stayed in the office, and Esc puts Account settings away, back to the button.
        expect(new URL(page.url()).pathname).toBe('/');
        await page.keyboard.press('Escape');
        await expect(settings).toHaveCount(0);
        await expect(page.locator('.ma-shell')).toBeVisible();
        await expect(button).toBeFocused();
      });

      test('with no good link, the menu has no item', async ({ page, request }) => {
        await harness(request, { accountLink: 'https://evil.example/account' });
        await signIn(page);
        await page.getByRole('button', { name: 'Account' }).click();
        await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Account' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Account settings' })).toHaveCount(0); // and no export here either
      });
    });
  }

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`the menu's Account item, ${theme}`, async ({ page, request }) => {
      await harness(request, { signInPath: null });
      await setTheme(page, theme);
      await signIn(page);
      await canvasPainted(page);
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('button', { name: 'Account settings', exact: true }).hover();
      await page.screenshot({ path: `test-results/shots/account-menu-${theme}.png` });
    });
  }
});

test.describe('a sign-in that fails at /auth/callback', () => {
  const GOOD = { state: 'good-state', nonce: 'good-nonce', verifier: 'good-verifier' };
  /** What the pages or the app leave for Google's return, in this tab. */
  const pendingSignIn = async (page: Page): Promise<void> => {
    await page.goto('/_signin/?error=stay');
    await page.evaluate((p) => sessionStorage.setItem('ma.auth.pending', JSON.stringify(p)), GOOD);
  };
  const NOT_VERIFIED = "couldn't be verified";
  const NOT_COMPLETE = "didn't complete";
  const failures: { name: string; url: string; words: string; pending?: boolean; prepare?: (page: Page, request: APIRequestContext) => Promise<unknown> }[] = [
    { name: 'a bare callback', url: '/auth/callback', words: NOT_VERIFIED },
    { name: 'a state with nothing pending', url: `/auth/callback?code=c&state=${GOOD.state}`, words: NOT_VERIFIED },
    { name: 'a bad state', url: '/auth/callback?code=c&state=wrong', words: NOT_VERIFIED, pending: true },
    { name: 'no code', url: `/auth/callback?state=${GOOD.state}`, words: NOT_VERIFIED, pending: true },
    { name: 'a refused code exchange', url: `/auth/callback?code=c&state=${GOOD.state}`, words: NOT_COMPLETE, pending: true, prepare: (_, request) => harness(request, { codeExchangeFails: true }) },
    { name: 'a code exchange the network drops', url: `/auth/callback?code=c&state=${GOOD.state}`, words: NOT_COMPLETE, pending: true, prepare: (page) => page.route('**/fake-auth/oauth2/token', (route) => route.abort()) },
    { name: 'a nonce that doesn\'t match', url: `/auth/callback?code=c&state=${GOOD.state}`, words: NOT_VERIFIED, pending: true },
  ];
  const callbackGoes = async (request: APIRequestContext): Promise<string[]> => (await logOf(request)).filter((l) => l.startsWith('GET /_signin/') && !l.includes('error=stay'));

  test.describe('with our own pages: back to the form, with its error', () => {
    test.beforeEach(async ({ request }) => {
      await harness(request, { signInPath: '/_signin/' });
    });

    for (const f of failures) {
      test(f.name, async ({ page, request }) => {
        const card = await watchCard(page);
        if (f.pending) await pendingSignIn(page);
        await f.prepare?.(page, request);
        await page.goto(f.url);
        await page.waitForURL(/\/_signin\/\?error=google$/);
        await expect(page.getByRole('heading', { name: 'Sign-in pages' })).toBeVisible();
        await page.waitForTimeout(200);
        expect(await callbackGoes(request)).toEqual(['GET /_signin/?error=google']);
        expect(await page.evaluate(() => sessionStorage.getItem('ma.auth.pending'))).toBeNull();
        expect(card.seen).toBe(false);
      });
    }

    test('that same missing route, from a bare callback: no loop, and managed login takes over', async ({ page, request }) => {
      await harness(request, { signInRouteMissing: true });
      await page.goto('/auth/callback');
      await page.waitForURL(/\/_signin\/\?error=google$/);
      await expect(page.getByTestId('sign-in')).toBeVisible();
      await page.waitForTimeout(300);
      expect(await callbackGoes(request)).toEqual(['GET /_signin/?error=google']);
    });

    test('a good callback still signs in, by the code', async ({ page, request }) => {
      await pendingSignIn(page);
      const back = new URL('/auth/callback', page.url()).href;
      await page.goto(`/fake-auth/oauth2/authorize?code_challenge_method=S256&code_challenge=x&nonce=${GOOD.nonce}&state=${GOOD.state}&redirect_uri=${encodeURIComponent(back)}`);
      await expect(page.locator('.ma-shell')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
      expect(await callbackGoes(request)).toEqual([]);
    });
  });

  test.describe('with managed login: the card, in its own words, as today', () => {
    test.beforeEach(async ({ request }) => {
      await harness(request, { signInPath: null });
    });

    for (const f of failures) {
      test(f.name, async ({ page, request }) => {
        if (f.pending) await pendingSignIn(page);
        await f.prepare?.(page, request);
        await page.goto(f.url);
        await expect(page.getByTestId('sign-in')).toContainText(f.words);
        expect(new URL(page.url()).pathname).toBe('/');
        expect(await callbackGoes(request)).toEqual([]);
      });
    }
  });
});

test.describe('a dead session', () => {
  const GUARD_KEY = 'ma.auth.leftForSignIn';
  const signInGoes = async (request: APIRequestContext): Promise<string[]> => (await logOf(request)).filter((l) => l.startsWith('GET /_signin/'));
  const DIED = /\/_signin\/\?return=%2F&notice=session$/;

  test.describe('with our own pages', () => {
    test.beforeEach(async ({ request }) => {
      await harness(request, { signInPath: '/_signin/' });
    });

    /** Signed in through the stand-in, painted. */
    const inTheOffice = async (page: Page, path = '/'): Promise<void> => {
      await page.goto(path);
      await expect(page.locator('.ma-shell')).toBeVisible();
      await canvasPainted(page);
    };

    test('goes to the form with its path and the line, no card on the way, and signing in comes back to that path', async ({ page, request }) => {
      const errors = watchConsole(page);
      const card = await watchCard(page);
      await inTheOffice(page, '/somewhere?x=1');
      await harness(request, { refreshFails: true, signInHolds: true });
      await page.reload();
      await page.waitForURL(/\/_signin\/\?return=%2Fsomewhere%3Fx%3D1&notice=session$/);
      await expect(page.getByRole('heading', { name: 'Sign-in pages' })).toBeVisible();
      expect(await storedRefreshToken(page)).toBeNull();
      expect(card.seen).toBe(false);

      await harness(request, { refreshFails: false, signInHolds: false });
      await page.reload(); // the stand-in signs in now
      await expect(page.locator('.ma-shell')).toBeVisible();
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/somewhere?x=1');
      expect(card.seen).toBe(false);
      // The refused refresh is the point of this test, and Chromium logs any 400. Nothing else may show: no CSP violation, no page error.
      expect(errors.filter((e) => !e.includes('status of 400'))).toEqual([]);
    });

    test('in the middle of a session too, when the list hears it', async ({ page, request }) => {
      const card = await watchCard(page);
      await harness(request, { expiresIn: 2 }); // inside the 5 minute margin, so every call refreshes
      await inTheOffice(page);
      await page.waitForTimeout(2100);
      await harness(request, { refreshFails: true, signInHolds: true });
      await pollList(page);
      await page.waitForURL(DIED);
      expect(await storedRefreshToken(page)).toBeNull();
      expect(card.seen).toBe(false);
    });

    test('Back from the form doesn\'t bounce through the page that sent them', async ({ page, request }) => {
      await page.goto('/_signin/?from=here');
      await inTheOffice(page);
      await harness(request, { refreshFails: true, signInHolds: true });
      await page.reload();
      await page.waitForURL(DIED);
      const before = (await signInGoes(request)).length;
      await page.goBack();
      await page.waitForTimeout(300);
      expect((await signInGoes(request)).length - before).toBeLessThanOrEqual(1); // the earlier form itself, if Back reloads it
      expect(page.url()).not.toMatch(DIED);
    });

    test('the loop guard: dying again straight after coming back shows the card, and it stops there', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { refreshFails: true });
      await page.reload();
      // Out to the stand-in, which signs in by itself and comes straight back, where that token dies too.
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      await page.screenshot({ path: 'test-results/shots/dead-session-guard-card.png' });
      await page.waitForTimeout(1000);
      expect(await signInGoes(request)).toEqual(['GET /_signin/?return=%2F', 'GET /_signin/?return=%2F&notice=session']);
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await storedRefreshToken(page)).toBeNull();

      // The card's button is still a way in.
      await harness(request, { refreshFails: false });
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('.ma-shell')).toBeVisible();
    });

    test('the guard lapses: past 30 s, a session that dies goes to the form again', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { refreshFails: true, signInHolds: true });
      await page.evaluate(([key, at]) => sessionStorage.setItem(key as string, String(at)), [GUARD_KEY, Date.now() - 31_000]);
      await page.reload();
      await page.waitForURL(DIED);
      expect(await signInGoes(request)).toHaveLength(2);
    });

    test('with session storage blocked, the guard can\'t count, so it\'s the card', async ({ page, request }) => {
      await inTheOffice(page);
      await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get: () => { throw new DOMException('blocked', 'SecurityError'); } }));
      await harness(request, { refreshFails: true });
      await page.reload();
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(await signInGoes(request)).toHaveLength(1);
    });

    test('a refresh that fails for now never goes there', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      const card = await watchCard(page);
      await inTheOffice(page);
      await page.waitForTimeout(2100);
      for (const failure of [
        { status: 400, body: { error: 'PreTokenGenerationV2_0 failed with error Internal.' } },
        { status: 503, body: { message: 'Service Unavailable' } },
        { status: 401, body: { error: 'invalid_client' } },
        { status: 400, body: '<html>Bad Request</html>' },
        'drop',
      ]) {
        await harness(request, { refreshFailure: failure });
        await pollList(page);
        await expect(page.getByTestId('desks-stale')).toBeVisible();
      }
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toHaveLength(1);
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
      expect(card.seen).toBe(false);
    });

    test('a failed request never goes there', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { desks: 'error' });
      await pollList(page);
      await expect(page.getByTestId('desks-stale')).toBeVisible();
      await page.route('**/v1/desks', (route) => route.abort());
      await pollList(page);
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toHaveLength(1);
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
    });

    test('the API refusing a good token is the card, with the token kept: signing in wouldn\'t mend it', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { desksUnauthorized: true });
      await pollList(page);
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(await signInGoes(request)).toHaveLength(1);
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
    });

    test('a token another tab rotated away never goes there', async ({ page, request }) => {
      await inTheOffice(page);
      const old = (await storedRefreshToken(page)) as string;
      await harness(request, { refreshRefuses: [old], refreshDelayMs: 1000 });
      await page.reload();
      await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { refreshSent: string[] }).refreshSent).toContain(old);
      await storeRefreshToken(page, 'refresh-from-another-tab');
      await harness(request, { refreshDelayMs: 0 });
      await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toHaveLength(1);
    });

    test('a sign-out in another tab is the card here, not a trip to the form', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      await inTheOffice(page);
      const other = await page.context().newPage();
      await inTheOffice(other);
      await other.getByRole('button', { name: 'Account' }).click();
      await other.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(other.getByTestId('sign-in')).toContainText("You're signed out.");
      await other.close();
      await page.waitForTimeout(2100);
      await pollList(page);
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await signInGoes(request)).toHaveLength(1);
    });

    test('a sign-out ends at its own card, with no trip to the form', async ({ page, request }) => {
      await inTheOffice(page);
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toHaveLength(1);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), GUARD_KEY)).toBeNull();
    });

    test('a sign-out while the session dies under it still ends at its own card', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      await inTheOffice(page);
      await page.waitForTimeout(2100);
      await harness(request, { refreshFails: true, refreshDelayMs: 800 });
      await pollList(page); // a poll on its way, waiting on a refresh that will be refused
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toHaveLength(1);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), GUARD_KEY)).toBeNull();
    });

    test('a hidden tab waits, and goes when it comes back, even if a link heard first', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      await inTheOffice(page);
      await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }));
      await harness(request, { refreshFails: true, signInHolds: true });
      // The list doesn't poll in a hidden tab. A link's retry refreshes, and that clears the token.
      await expect.poll(() => storedRefreshToken(page), { timeout: 15_000 }).toBeNull();
      await page.waitForTimeout(500);
      expect(new URL(page.url()).pathname).toBe('/');
      await expect(page.getByTestId('sign-in')).toHaveCount(0);
      expect(await signInGoes(request)).toHaveLength(1);

      await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: false, configurable: true }));
      await pollList(page);
      await page.waitForURL(DIED);
    });

    test('signInPath on before the route exists: the card, and no loop', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { refreshFails: true, signInRouteMissing: true });
      await page.reload();
      await page.waitForURL(DIED);
      // The SPA fallback answered, with no token left: being there already means the card and managed login.
      await expect(page.getByTestId('sign-in')).toBeVisible();
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toHaveLength(2);
    });

    test('a dead token while already at that missing route: the card, and no redirect to itself', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { refreshFails: true, signInRouteMissing: true });
      await page.goto('/_signin/?return=%2F');
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      await page.waitForTimeout(500);
      expect(await signInGoes(request)).toEqual(['GET /_signin/?return=%2F', 'GET /_signin/?return=%2F']);
    });
  });

  test.describe('with an address on another site', () => {
    const ID = 'https://id.localhost/in/';

    test('every path uses it, `return` is absolute, its own path isn\'t mistaken for this page, and the guard still holds', async ({ page, request }) => {
      await page.context().route('https://id.localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Id</title><h1>Sign-in site</h1>' }));
      await harness(request, { signInPath: ID });
      const here = new URL('/', test.info().project.use.baseURL).href;
      const toThere = (path: string, extra = '') => `${ID}?return=${encodeURIComponent(new URL(path, here).href)}${extra}`;

      await page.goto('/');
      await page.waitForURL(toThere('/'));
      await page.goto('/in/'); // the same path as the setting's, on this host: not the sign-in page
      await page.waitForURL(toThere('/in/'));
      await page.goto('/auth/callback');
      await page.waitForURL(`${ID}?error=google`);

      await page.goto('/signed-out');
      await expect(page.getByTestId('sign-in')).toBeVisible();
      await storeRefreshToken(page, 'refresh-1');
      await harness(request, { refreshFails: true });
      await page.goto('/');
      await page.waitForURL(toThere('/', '&notice=session'));

      // Back from there, in the same tab, and it dies again: the guard is on this site, and held.
      await page.goto('/signed-out');
      await expect(page.getByTestId('sign-in')).toBeVisible();
      await storeRefreshToken(page, 'refresh-2');
      await page.goto('/');
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(new URL(page.url()).hostname).toBe('localhost');
    });
  });

  test.describe('with managed login', () => {
    const AUTHORIZE = /\/fake-auth\/oauth2\/authorize\?/;
    const authorizes = async (request: APIRequestContext): Promise<string[]> => (await logOf(request)).filter((l) => l.includes('/oauth2/authorize'));

    test.beforeEach(async ({ request }) => {
      await harness(request, { signInPath: null });
    });

    /** Signed in, painted, and past the 30 s that signing in itself started. */
    const inTheOffice = async (page: Page): Promise<void> => {
      await page.goto('/');
      await expect(page.locator('.ma-shell')).toBeVisible();
      await canvasPainted(page);
      await page.evaluate((key) => sessionStorage.removeItem(key), GUARD_KEY);
    };

    test('goes straight there, with no card on the way, and signing in comes back to the office', async ({ page, request }) => {
      const errors = watchConsole(page);
      const card = await watchCard(page);
      await inTheOffice(page);
      await harness(request, { refreshFails: true, authorizeHolds: true });
      await page.reload();
      await page.waitForURL(AUTHORIZE);
      await expect(page.getByRole('heading', { name: 'Managed login' })).toBeVisible();
      expect(card.seen).toBe(false);
      expect(await authorizes(request)).toHaveLength(2);
      expect(await storedRefreshToken(page)).toBeNull(); // the harness has it on this origin

      await harness(request, { refreshFails: false, authorizeHolds: false });
      await page.reload(); // the stand-in signs in now
      await expect(page.locator('.ma-shell')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
      expect(card.seen).toBe(false);
      expect(errors.filter((e) => !e.includes('status of 400'))).toEqual([]);
    });

    test('in the middle of a session too, when the list hears it', async ({ page, request }) => {
      const card = await watchCard(page);
      await harness(request, { expiresIn: 2 }); // inside the 5 minute margin, so every call refreshes
      await inTheOffice(page);
      await page.waitForTimeout(2100);
      await harness(request, { refreshFails: true, authorizeHolds: true });
      await pollList(page);
      await page.waitForURL(AUTHORIZE);
      expect(card.seen).toBe(false);
    });

    test('Back from there doesn\'t bounce through the page that sent them', async ({ page, request }) => {
      await harness(request, { signInHolds: true });
      await page.goto('/_signin/?from=here');
      await inTheOffice(page);
      await harness(request, { refreshFails: true, authorizeHolds: true });
      await page.reload();
      await page.waitForURL(AUTHORIZE);
      const before = (await authorizes(request)).length;
      await page.goBack();
      await page.waitForTimeout(300);
      expect(new URL(page.url()).pathname).toBe('/_signin/');
      expect((await authorizes(request)).length).toBe(before);
    });

    test('the loop guard: dying again straight after coming back shows the card, and it stops there', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 }); // every call refreshes, so the new session's first call hears it too
      await inTheOffice(page);
      await harness(request, { refreshFails: true });
      await page.reload();
      // Out to managed login, which signs in by itself and comes straight back, where that session dies too.
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      await page.screenshot({ path: 'test-results/shots/managed-dead-session-guard-card.png' });
      await page.waitForTimeout(1000);
      expect(await authorizes(request)).toHaveLength(2);
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await storedRefreshToken(page)).toBeNull();

      // The card's button is still a way in.
      await harness(request, { refreshFails: false });
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('.ma-shell')).toBeVisible();
    });

    test('with session storage blocked, the guard can\'t count, so it\'s the card', async ({ page, request }) => {
      await inTheOffice(page);
      await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get: () => { throw new DOMException('blocked', 'SecurityError'); } }));
      await harness(request, { refreshFails: true });
      await page.reload();
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(await authorizes(request)).toHaveLength(1);
    });

    test('a refresh that fails for now never goes there', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      const card = await watchCard(page);
      await inTheOffice(page);
      await page.waitForTimeout(2100);
      for (const failure of [{ status: 503, body: { message: 'Service Unavailable' } }, 'drop']) {
        await harness(request, { refreshFailure: failure });
        await pollList(page);
        await expect(page.getByTestId('desks-stale')).toBeVisible();
      }
      await page.waitForTimeout(500);
      expect(await authorizes(request)).toHaveLength(1);
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
      expect(card.seen).toBe(false);
    });

    test('the API refusing a good token is the card, with the token kept: signing in wouldn\'t mend it', async ({ page, request }) => {
      await inTheOffice(page);
      await harness(request, { desksUnauthorized: true });
      await pollList(page);
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(await authorizes(request)).toHaveLength(1);
      expect(await storedRefreshToken(page)).toMatch(/^refresh-/);
    });

    test('a sign-out in another tab is the card here, as with our own pages, and a reload then goes there', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      await inTheOffice(page);
      const other = await page.context().newPage();
      await inTheOffice(other);
      await other.getByRole('button', { name: 'Account' }).click();
      await other.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(other.getByTestId('sign-in')).toContainText("You're signed out.");
      await other.close();
      await page.waitForTimeout(2100);
      await pollList(page);
      await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
      expect(new URL(page.url()).pathname).toBe('/');
      expect(await authorizes(request)).toHaveLength(1); // only the first sign-in: the other tab used its token

      await harness(request, { authorizeHolds: true });
      await page.reload();
      await page.waitForURL(AUTHORIZE);
    });

    test('a sign-out while the session dies under it still ends at its own card', async ({ page, request }) => {
      await harness(request, { expiresIn: 2 });
      await inTheOffice(page);
      await page.waitForTimeout(2100);
      await harness(request, { refreshFails: true, refreshDelayMs: 800 });
      await pollList(page); // a poll on its way, waiting on a refresh that will be refused
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
      await page.waitForTimeout(500);
      expect(await authorizes(request)).toHaveLength(1);
    });
  });
});

test("the app clears the loader's inline boot colors, and writes the resolved theme", async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await page.addInitScript(() => {
    localStorage.setItem('ma.prefs.theme', JSON.stringify({ mode: 'dusk', systemDark: 'dark' }));
    localStorage.setItem('ma.theme.resolved', 'dusk');
  });
  await page.goto('/signed-out');
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await page.waitForFunction(() => document.documentElement.style.backgroundColor === '' && document.documentElement.style.colorScheme === '');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  expect(await page.evaluate(() => localStorage.getItem('ma.theme.resolved'))).toBe('dusk');
});

test('ma-release.json is what the Platform loader needs', () => {
  const rel = JSON.parse(readFileSync('dist/release/ma-release.json', 'utf8')) as { app: string; version: string; deskApiRange: string; entry: string; css: string[] };
  expect(rel.app).toBe('desk-web');
  expect(rel.deskApiRange).toBe('>=1.0 <2.0');
  expect(rel.version).toMatch(/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+(-dirty)?$/);
  expect(rel.entry).toMatch(/^assets\/.+\.js$/);
  expect(rel.css.length).toBeGreaterThan(0);
  const entry = readFileSync(`dist/release/${rel.entry}`, 'utf8');
  expect(entry).not.toContain('MockDeskLink');
  const css = readFileSync(`dist/release/${rel.css[0]}`, 'utf8');
  expect(css).toContain(`/v/${rel.version}/assets/inter-latin`);
});

test('Sign out everywhere from the shipping bundle under the default CSP: Platform hears everywhere, then this browser signs out as Sign out does', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  const token = await storedRefreshToken(page);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByTestId('sign-out-everywhere').click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  const { log, signOuts, revoked } = (await (await request.get('/__harness')).json()) as { log: string[]; signOuts: unknown[]; revoked: string[] };
  expect(signOuts).toEqual([{ everywhere: true }]);
  const at = (line: string): number => log.indexOf(line);
  expect(at('POST /v1/me/sign-out')).toBeGreaterThan(-1);
  expect(at('POST /fake-auth/oauth2/revoke')).toBeGreaterThan(at('POST /v1/me/sign-out'));
  expect(at('GET /fake-auth/logout')).toBeGreaterThan(at('POST /fake-auth/oauth2/revoke'));
  expect(revoked).toEqual([token]);
  expect(await storedRefreshToken(page)).toBeNull();
  expect(errors).toEqual([]);
});
