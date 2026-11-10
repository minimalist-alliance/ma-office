// "Stay signed in" (the owner, 2026-11-07): where the Desk app keeps its refresh token (platform/tokenStore.ts). A
// reload and a browser restart keep the member signed in; "Until you close the browser" doesn't outlive the browser;
// a refresh refused with invalid_grant or ma_session_ended goes to sign-in and clears both stores; sign-out clears both;
// a token in the old IndexedDB store moves over with no sign-in; tabs keep in step; the account menu links to the
// setting. A restart is a persistent profile closed and opened again, against the same harness.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { harness, refreshTokenPlaces, signIn, watchConsole } from './helpers';

const KEY = 'ma-desk-web-refresh';
const ENDED = 'PreTokenGenerationV2_0 failed with error ma_session_ended. Error Code: UserLambdaValidationException; Request ID: 1';
const shell = (page: Page) => page.locator('.ma-shell');

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('where the token is kept', () => {
  test('30 days: localStorage, and a reload stays signed in', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { staySignedIn: '30d' });
    await signIn(page);
    const [local, session] = await refreshTokenPlaces(page);
    expect(local).toMatch(/^refresh-/);
    expect(session).toBeNull();
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('"browser": GET /v1/me moves it into this tab at once, a reload stays signed in, and 30 days moves it back', async ({ page, request }) => {
    await harness(request, { staySignedIn: 'browser' });
    await signIn(page);
    await expect.poll(() => refreshTokenPlaces(page)).toEqual([null, expect.stringMatching(/^refresh-/)]);
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect.poll(() => refreshTokenPlaces(page)).toEqual([null, expect.stringMatching(/^refresh-/)]);
    await harness(request, { staySignedIn: '30d' });
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect.poll(() => refreshTokenPlaces(page)).toEqual([expect.stringMatching(/^refresh-/), null]);
  });

  test('a Platform without the setting moves nothing', async ({ page }) => {
    await signIn(page);
    await page.evaluate((key) => {
      sessionStorage.setItem(key, localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }, KEY);
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await page.waitForTimeout(500);
    expect((await refreshTokenPlaces(page))[0]).toBeNull();
  });

  test('our own sign-in pages hand it over in the right place', async ({ page, request }) => {
    await harness(request, { signInPath: '/_signin/', staySignedIn: 'browser' });
    await page.goto('/');
    await expect(shell(page)).toBeVisible();
    await expect.poll(() => refreshTokenPlaces(page)).toEqual([null, expect.stringMatching(/^refresh-/)]);
  });

  test('a token in the old IndexedDB store moves to localStorage with no sign-in, and the old store goes', async ({ page, request }) => {
    await harness(request, { signInPath: null });
    await page.goto('/__harness');
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const open = indexedDB.open('ma-desk', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => {
            const tx = open.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put('refresh-from-before', 'refresh');
            tx.oncomplete = () => {
              open.result.close();
              done();
            };
          };
        }),
    );
    await page.goto('/');
    await expect(shell(page)).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { refreshSent: string[] }).refreshSent[0]).toBe('refresh-from-before');
    await expect.poll(() => refreshTokenPlaces(page)).toEqual([expect.stringMatching(/^refresh-\d+$/), null]);
    await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain('ma-desk');
  });

  test('another tab follows a move and a rotation, so neither is stranded', async ({ page, context, request }) => {
    const sent = async (): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { refreshSent: string[] }).refreshSent;
    /** Both tabs hold the same token in their own sessionStorage, and none in localStorage. */
    const inStep = async (): Promise<string | null> => {
      const [a, b] = [await refreshTokenPlaces(page), await refreshTokenPlaces(two)];
      return a[0] === null && b[0] === null && a[1] !== null && a[1] === b[1] ? a[1] : null;
    };
    await harness(request, { staySignedIn: '30d' });
    await signIn(page);
    await expect(shell(page)).toBeVisible();
    await page.waitForTimeout(500); // the first tab's own refresh, if its sign-in left only a refresh token
    const signedIn = (await sent()).length;
    const two = await context.newPage();
    await two.goto('/');
    await expect(shell(two)).toBeVisible();
    await expect.poll(async () => (await sent()).length).toBe(signedIn + 1); // the second tab's first refresh
    // The member chooses the browser on /account: the first tab hears it from GET /v1/me and moves the token, and the
    // second, which read localStorage until now, takes the same one into its own.
    await harness(request, { staySignedIn: 'browser' });
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect.poll(inStep).not.toBeNull();
    const moved = await inStep();
    // The first rotates it: the second follows.
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect.poll(async () => { const t = await inStep(); return t !== null && t !== moved; }).toBe(true);
    // The second's own refresh sends that newest one, and the first follows it in turn.
    const before = (await sent()).length;
    await two.reload();
    await expect(shell(two)).toBeVisible();
    await expect.poll(async () => (await sent()).length).toBeGreaterThan(before);
    await expect.poll(inStep).not.toBeNull();
    // No token was ever sent twice: no tab was left holding one another tab had rotated away.
    const all = await sent();
    expect(new Set(all).size).toBe(all.length);
  });
});

test.describe('the way out', () => {
  for (const [name, refusal] of [
    ['invalid_grant', { refreshFails: true }],
    ['ma_session_ended', { refreshFailure: { status: 400, body: { error: ENDED } } }],
  ] as const) {
    for (const choice of ['30d', 'browser'] as const) {
      test(`a refresh refused with ${name} clears both stores and goes to sign-in, with ${choice}`, async ({ page, request }) => {
        await harness(request, { signInPath: '/_signin/', signInHolds: true, staySignedIn: choice });
        await page.goto('/__harness');
        await page.evaluate(([key, where]) => (where === 'browser' ? sessionStorage : localStorage).setItem(key, 'refresh-planted'), [KEY, choice] as const);
        await harness(request, refusal);
        await page.goto('/');
        await page.waitForURL(/\/_signin\/\?.*notice=session/);
        expect(await refreshTokenPlaces(page)).toEqual([null, null]);
        const { refreshSent } = (await (await request.get('/__harness')).json()) as { refreshSent: string[] };
        expect(refreshSent).toEqual(['refresh-planted']); // once: no retry
      });
    }
  }

  test('ma_session_ended with a kept 7-day choice revokes the token and tells sign-in why', async ({ page, request }) => {
    await harness(request, { signInPath: '/_signin/', signInHolds: true, staySignedIn: '7d' });
    await page.goto('/__harness');
    await page.evaluate(([key]) => {
      localStorage.setItem(key, 'refresh-planted');
      localStorage.setItem('ma-desk-web-session-choice', JSON.stringify({ staySignedIn: '7d', staySignedInSince: null }));
    }, [KEY] as const);
    await harness(request, { refreshFailure: { status: 400, body: { error: ENDED } } });
    await page.goto('/');
    await page.waitForURL(/\/_signin\/\?.*notice=ended-7d/);
    expect(await refreshTokenPlaces(page)).toEqual([null, null]);
    const seen = (await (await request.get('/__harness')).json()) as { revoked: string[]; refreshSent: string[] };
    expect(seen.revoked).toEqual(['refresh-planted']);
  });

  test("the member's own 7 days, past on this browser: nothing is sent, the token is revoked, and sign-in is told why", async ({ page, request }) => {
    await harness(request, { signInPath: '/_signin/', signInHolds: true, staySignedIn: '7d' });
    await page.goto('/__harness');
    await page.evaluate(([key]) => {
      localStorage.setItem(key, 'refresh-planted');
      localStorage.setItem('ma-desk-web-signed-in-at', String(Math.floor(Date.now() / 1000) - 8 * 86_400));
      localStorage.setItem('ma-desk-web-session-choice', JSON.stringify({ staySignedIn: '7d', staySignedInSince: null }));
    }, [KEY] as const);
    await page.goto('/');
    await page.waitForURL(/\/_signin\/\?.*notice=ended-7d/);
    expect(await refreshTokenPlaces(page)).toEqual([null, null]);
    const seen = (await (await request.get('/__harness')).json()) as { revoked: string[]; refreshSent: string[] };
    expect(seen.refreshSent).toEqual([]);
    expect(seen.revoked).toEqual(['refresh-planted']);
  });

  test('a shorter choice saved after the sign-in never ends it on the spot', async ({ page, request }) => {
    await harness(request, { staySignedIn: '7d' });
    await signIn(page);
    await page.evaluate(() => {
      localStorage.setItem('ma-desk-web-signed-in-at', String(Math.floor(Date.now() / 1000) - 20 * 86_400));
      localStorage.setItem('ma-desk-web-session-choice', JSON.stringify({ staySignedIn: '7d', staySignedInSince: new Date().toISOString() }));
    });
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
  });

  test('any other failed trigger keeps the token and stays', async ({ page, request }) => {
    await signIn(page);
    await harness(request, { refreshFailure: { status: 400, body: { error: 'PreTokenGenerationV2_0 failed with error Internal. Error Code: UserLambdaValidationException' } } });
    await page.reload();
    await expect(shell(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect((await refreshTokenPlaces(page))[0]).toMatch(/^refresh-/);
    expect(page.url()).not.toContain('/_signin/');
  });

  test('sign-out clears both stores', async ({ page, request }) => {
    await harness(request, { staySignedIn: 'browser' });
    await signIn(page);
    await expect.poll(() => refreshTokenPlaces(page)).toEqual([null, expect.stringMatching(/^refresh-/)]);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    expect(await refreshTokenPlaces(page)).toEqual([null, null]);
  });
});

test.describe('a browser restart', () => {
  async function profile(dir: string, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await chromium.launchPersistentContext(dir, { baseURL, viewport: { width: 1440, height: 900 } });
    return { context, page: context.pages()[0] ?? (await context.newPage()) };
  }

  for (const [choice, kept] of [['30d', true], ['7d', true], ['1d', true], ['browser', false]] as const) {
    test(`with ${choice}, ${kept ? 'still signed in' : 'signed out'} after the browser closes and opens`, async ({ request, baseURL }) => {
      await harness(request, { signInPath: null, staySignedIn: choice });
      const dir = mkdtempSync(join(tmpdir(), 'ma-desk-stay-'));
      try {
        let open = await profile(dir, baseURL!);
        await signIn(open.page);
        await expect.poll(() => refreshTokenPlaces(open.page)).toEqual(choice === 'browser' ? [null, expect.stringMatching(/^refresh-/)] : [expect.stringMatching(/^refresh-/), null]);
        await open.context.close();

        // Sign-in waits, so a signed-out member is seen as one rather than signed straight back in by the harness.
        await harness(request, { authorizeHolds: true });
        open = await profile(dir, baseURL!);
        const leaving = kept ? null : open.page.waitForRequest(/\/oauth2\/authorize/);
        await open.page.goto('/');
        if (kept) {
          await expect(shell(open.page)).toBeVisible();
          expect((await refreshTokenPlaces(open.page))[0]).toMatch(/^refresh-/);
        } else {
          await leaving;
          expect(await refreshTokenPlaces(open.page).catch(() => [null, null])).toEqual([null, null]);
        }
        await open.context.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
