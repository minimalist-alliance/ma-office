// A returning visit draws the avatar, its seal, the usage circle and the desks from what this member's last visit drew,
// before Platform answers, and each answer then replaces it (`platform/lastKnown.ts`; the owner, Nov 10: "some items
// like the avatar on office take a while to load"). Kept per account, in sessionStorage under "Until you close the
// browser", and gone at sign-out. `lastKnown.test.ts` has the rules.
import { expect, test, type Page, type Route } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';

const KEY = 'ma-desk-web-last-known';
const face = (page: Page) => page.locator('.account-btn .avatar-face');
const kept = (page: Page) => page.evaluate((k) => [localStorage.getItem(k), sessionStorage.getItem(k)], KEY);

/** Holds every `path` request until `release()`, counting how many have been answered. */
async function hold(page: Page, path: string): Promise<{ answered: () => number; release: () => void }> {
  let answered = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  await page.route(`**${path}`, async (route: Route) => {
    await gate;
    await route.continue();
    answered += 1;
  });
  return { answered: () => answered, release: () => open() };
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a returning load paints the avatar, its seal, the circle and the desks before Platform answers, then refreshes them', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { displayName: 'Dana Example', membership: { status: 'active', tier: 'officer', badge: 'officer' } });
  await signIn(page);
  await expect(face(page)).toHaveAttribute('data-initials', 'DE');
  await expect(page.getByTestId('bandwidth')).toBeVisible();
  await expect.poll(async () => (await kept(page))[0]).toContain('Dana Example');
  const desks = await page.getByRole('group', { name: / desk$/ }).count();
  expect(desks).toBeGreaterThan(0);

  // Platform is slow this time, and the member has changed their name meanwhile.
  await harness(request, { displayName: 'Dana Fresh' });
  const me = await hold(page, '/v1/me');
  const meter = await hold(page, '/v1/desks/bandwidth');
  const list = await hold(page, '/v1/desks');
  await page.reload();
  await expect(face(page)).toHaveAttribute('data-initials', 'DE');
  await expect(page.locator('.account-btn .avatar-seal')).toBeVisible();
  await expect(page.getByTestId('bandwidth')).toBeVisible();
  await expect(page.getByRole('group', { name: / desk$/ })).toHaveCount(desks);
  expect([me.answered(), meter.answered(), list.answered()]).toEqual([0, 0, 0]);

  // Revalidated: Platform's answers replace what was drawn, and are kept for next time.
  me.release();
  meter.release();
  list.release();
  await expect(face(page)).toHaveAttribute('data-initials', 'DF');
  await expect.poll(async () => (await kept(page))[0]).toContain('Dana Fresh');
  expect(errors).toEqual([]);
});

test('"Until you close the browser" keeps it in this tab only, and sign-out takes it', async ({ page, request }) => {
  await harness(request, { staySignedIn: 'browser' });
  await signIn(page);
  await expect.poll(() => kept(page)).toEqual([null, expect.stringContaining('Test Member')]);
  const me = await hold(page, '/v1/me');
  await page.reload();
  await expect(face(page)).toHaveAttribute('data-initials', 'TM');
  expect(me.answered()).toBe(0);
  me.release();
  await expect.poll(() => kept(page)).toEqual([null, expect.stringContaining('Test Member')]);

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect(await kept(page)).toEqual([null, null]);
  expect(await page.evaluate(() => [localStorage.getItem('ma.desks.v1'), sessionStorage.getItem('ma.desks.v1')])).toEqual([null, null]);
});

test("someone else's sign-in here draws none of the last member's", async ({ page, request }) => {
  await harness(request, { displayName: 'Dana Example' });
  await signIn(page);
  await expect.poll(async () => (await kept(page))[0]).toContain('Dana Example');
  // The sign-in pages hand over a new sign-in (whoever's) as they do: a new token and its own sign-in time.
  await harness(request, { displayName: 'Bo Other' });
  await page.evaluate(() => localStorage.setItem('ma-desk-web-signed-in-at', String(Math.floor(Date.now() / 1000) + 5)));
  const me = await hold(page, '/v1/me');
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(face(page)).toHaveCount(0); // the plain account icon until /v1/me says who
  me.release();
  await expect(face(page)).toHaveAttribute('data-initials', 'BO');
});
