// The landing's signed-in cookie from the office (ma-platform contract auth.md section 3.4, platform/signedInCookie.ts). Where
// client-config carries `signedInCookie`, a sign-in sets `ma_signed_in=1` for the member's "Stay signed in", a refresh sets it again,
// and Sign out, Sign out everywhere and a refused refresh clear it. Without the key, no cookie is ever written. The harness is on
// localhost, so the setting's domain is localhost (prod's is the apex); each write is also recorded as written, to check its
// exact attributes. Our own sign-in pages and the hand-off landing set it in ma-platform (web/signin's signed-in-cookie.spec.ts).
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';

const SETTING = { signedInCookie: { name: 'ma_signed_in', domain: 'localhost' } };
const DAY = 86_400;
const AGE = { '30d': 30 * DAY, '7d': 7 * DAY, '1d': DAY, browser: null } as const;
const SET = (age: number | null): string => `ma_signed_in=1; Domain=localhost; Path=/; ${age === null ? '' : `Max-Age=${age}; `}Secure; SameSite=Lax`;
const CLEAR = 'ma_signed_in=; Domain=localhost; Path=/; Max-Age=0; Secure; SameSite=Lax';
const ENDED = 'PreTokenGenerationV2_0 failed with error ma_session_ended. Error Code: UserLambdaValidationException; Request ID: 1';
const nowS = (): number => Math.floor(Date.now() / 1000);

test.beforeEach(async ({ page, request }) => {
  await harness(request, { reset: true });
  // Every document.cookie write, in order, kept in this tab's sessionStorage so it outlives the page leaving for the logout.
  await page.addInitScript(() => {
    const own = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get() {
        return own.get!.call(this) as string;
      },
      set(v: string) {
        sessionStorage.setItem('cookie-writes', JSON.stringify([...(JSON.parse(sessionStorage.getItem('cookie-writes') ?? '[]') as string[]), v]));
        own.set!.call(this, v);
      },
    });
  });
});

const writes = async (page: Page): Promise<string[]> =>
  (await page.evaluate(() => JSON.parse(sessionStorage.getItem('cookie-writes') ?? '[]') as string[])).filter((w) => w.startsWith('ma_signed_in='));
const cookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === 'ma_signed_in') ?? null;

/** `ma_signed_in=1`, Path /, Secure, SameSite=Lax, readable by script, for `age` seconds from now, or for the browser's session. */
async function expectCookie(context: BrowserContext, age: number | null): Promise<void> {
  await expect
    .poll(async () => {
      const c = await cookie(context);
      if (!c) return 'none';
      const lasts = age === null ? c.expires === -1 : Math.abs(c.expires - (nowS() + age)) < 120;
      return c.value === '1' && c.path === '/' && c.secure && !c.httpOnly && c.sameSite === 'Lax' && lasts ? 'right' : JSON.stringify(c);
    })
    .toBe('right');
}

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
}

const withKey = (request: APIRequestContext, patch: Record<string, unknown> = {}): Promise<void> => harness(request, { configExtra: SETTING, ...patch });

for (const choice of ['30d', '7d', '1d', 'browser'] as const) {
  test(`a sign-in sets it for "Stay signed in" ${choice}, exactly as the spec writes it`, async ({ page, context, request }) => {
    const errors = watchConsole(page);
    await withKey(request, { staySignedIn: choice });
    await signIn(page);
    await expectCookie(context, AGE[choice]);
    const w = await writes(page);
    expect(w[0]).toBe(SET(AGE['30d'])); // the exchange, before GET /v1/me has said the choice
    expect(w.at(-1)).toBe(SET(AGE[choice]));
    expect(errors).toEqual([]);
  });
}

test('a Platform that sends no choice: 30 days, as the token is kept then', async ({ page, context, request }) => {
  await withKey(request);
  await signIn(page);
  await expectCookie(context, AGE['30d']);
});

test('a refresh sets it again, for the choice kept beside the token', async ({ page, context, request }) => {
  await withKey(request, { staySignedIn: '7d' });
  await signIn(page);
  await expectCookie(context, AGE['7d']);
  await context.clearCookies();
  // GET /v1/me says nothing now, so only the page load's refresh can set it.
  await harness(request, { staySignedIn: null });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { refreshSent: string[] }).refreshSent.length).toBe(1);
  await expectCookie(context, AGE['7d']);
});

test('Sign out clears it before the page leaves for the logout', async ({ page, context, request }) => {
  await withKey(request);
  await signIn(page);
  await expectCookie(context, AGE['30d']);
  await openMenu(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect(await cookie(context)).toBeNull();
  expect((await writes(page)).at(-1)).toBe(CLEAR);
});

test('Sign out everywhere clears it too', async ({ page, context, request }) => {
  await withKey(request);
  await signIn(page);
  await expectCookie(context, AGE['30d']);
  await openMenu(page);
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect(await cookie(context)).toBeNull();
  expect((await writes(page)).at(-1)).toBe(CLEAR);
});

for (const [name, refusal] of [
  ['invalid_grant', { refreshFails: true }],
  ['ma_session_ended', { refreshFailure: { status: 400, body: { error: ENDED } } }],
] as const) {
  test(`a refresh refused with ${name} clears it`, async ({ page, context, request }) => {
    await withKey(request, { staySignedIn: '7d' });
    await signIn(page);
    await expectCookie(context, AGE['7d']);
    await harness(request, refusal);
    await page.reload();
    await expect.poll(async () => (await writes(page).catch(() => [])).at(-1) ?? 'none').toBe(CLEAR);
    expect(await cookie(context)).toBeNull();
  });
}

test('client-config without signedInCookie (staging, local): a sign-in, a refresh and sign-out write no cookie at all', async ({ page, context, request }) => {
  await harness(request, { staySignedIn: '7d' });
  await signIn(page);
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await openMenu(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect(await writes(page)).toEqual([]);
  expect(await cookie(context)).toBeNull();
});
