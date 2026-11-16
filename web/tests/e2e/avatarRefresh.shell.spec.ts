// A new avatar shows without a reload (the owner, Nov 16: "I had to refresh the page to see my avatar"). `/v1/me` is read
// again whenever Account settings closes, and on coming back to the tab at most once a minute (`?meReturnGapMs=0` makes
// that every time here). The new avatar comes in place: the one drawn stays until the new image is decoded, in the
// account button and in the open menu's 40 px header, never the initials or an empty circle in between.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const A = 'd-personal00001';
const layout = { desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] } }, z: [A] };
/** Periwinkle (`bg` 3, rose before kit 1.1.0) and steel (`bg` 6): each one's background colours are in its SVG, so a test can tell them apart. */
const PERIWINKLE = { kind: 'built', kit: 1, skin: 4, face: 'smile', hair: 'curly-short', bg: 3 };
const STEEL = { kind: 'built', kit: 1, skin: 2, hair: 'long-wavy', bg: 6 };
const built = (config: unknown) => ({ kind: 'built', config, setAt: '2026-11-16T10:00:00Z' });
const PICTURE = `https://api.avatar.test/v1/public/avatars/im_${'b'.repeat(26)}`;

const account = (page: Page) => page.getByRole('button', { name: 'Account', exact: true });
const buttonImg = (page: Page) => account(page).locator('.avatar-face img');
const svgOf = async (page: Page, img = buttonImg(page)): Promise<string> => decodeURIComponent((await img.getAttribute('src')) ?? '');

interface Seen {
  where: 'button' | 'menu';
  initials: string | null;
  src: string | null;
  complete: boolean | null;
}

/** Every state either avatar's face is ever in, from the first frame: a MutationObserver sees each commit React makes. */
async function watchFaces(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __faces: unknown[]; __hide: boolean };
    w.__faces = [];
    w.__hide = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__hide });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w.__hide ? 'hidden' : 'visible') });
    const look = (): void => {
      for (const [where, sel] of [['button', '.account-btn .avatar-face'], ['menu', '.menu-me .avatar-face']] as const) {
        const face = document.querySelector<HTMLElement>(sel);
        if (!face) continue;
        const img = face.querySelector('img');
        const s = { where, initials: face.dataset['initials'] || null, src: img?.getAttribute('src') ?? null, complete: img ? img.complete && img.naturalWidth > 0 : null };
        const last = w.__faces.findLast((x) => (x as { where: string }).where === where) as typeof s | undefined;
        if (!last || last.initials !== s.initials || last.src !== s.src) w.__faces.push(s);
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-initials'] });
  });
}

const faces = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __faces: Seen[] }).__faces);

/** After the first image, a face never shows the initials or no image again, and every image it shows is ready to draw. */
function noFlash(seen: Seen[], where: Seen['where']): void {
  const mine = seen.filter((s) => s.where === where);
  const first = mine.findIndex((s) => s.src !== null);
  expect(first).toBeGreaterThanOrEqual(0);
  for (const s of mine.slice(first)) {
    expect(s.initials, JSON.stringify(s).slice(0, 120)).toBeNull();
    expect(s.src).not.toBeNull();
  }
  // A swap puts in an image already decoded (the first one may still be loading as it mounts).
  for (const s of mine.slice(first + 1)) expect(s.complete, s.src?.slice(0, 80)).toBe(true);
}

async function hideAndShow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hide: boolean };
    w.__hide = true;
    document.dispatchEvent(new Event('visibilitychange'));
    w.__hide = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Counts this page's `GET /v1/me`. */
function countMe(page: Page): { n: number } {
  const c = { n: 0 };
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/v1/me') c.n += 1;
  });
  return c;
}

async function arrive(page: Page, request: Parameters<typeof harness>[0], avatar: unknown, path = '/'): Promise<{ n: number }> {
  await watchFaces(page);
  await page.addInitScript((d) => {
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout));
  await harness(request, { reset: true });
  await harness(request, { fleet: [{ deskId: A, name: 'Personal', kind: 'personal', state: 'running', allowedActions: ['connect', 'stop', 'rename'] }], avatar, membership: { status: 'active', tier: 'lead', badge: 'lead' } });
  const me = countMe(page);
  await signIn(page, path);
  await canvasPainted(page);
  await expect.poll(() => buttonImg(page).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0).catch(() => false)).toBe(true);
  return me;
}

test('closing Account settings reads /v1/me again, and the new avatar takes the old one\'s place', async ({ page, request }) => {
  const me = await arrive(page, request, built(PERIWINKLE));
  expect(await svgOf(page)).toContain('#C7C9E6');
  await account(page).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Account settings', exact: true });
  await expect(settings).toBeVisible();
  // Changed in the account page while the modal is open.
  await harness(request, { avatar: built(STEEL) });
  await page.waitForTimeout(300);
  expect(await svgOf(page)).toContain('#C7C9E6');
  const before = me.n;
  await page.getByTestId('account-settings-close').click();
  await expect(settings).toHaveCount(0);
  await expect.poll(() => me.n).toBe(before + 1);
  await expect.poll(() => svgOf(page)).toContain('#CBD9EC');
  noFlash(await faces(page), 'button');
  // Opening it and closing it again reads again, each time.
  await account(page).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect.poll(() => me.n).toBe(before + 2);
});

test('coming back to the tab within a minute of the last read asks nothing', async ({ page, request }) => {
  const me = await arrive(page, request, built(PERIWINKLE));
  const before = me.n;
  await harness(request, { avatar: built(STEEL) });
  await hideAndShow(page);
  await page.waitForTimeout(800);
  expect(me.n).toBe(before);
  expect(await svgOf(page)).toContain('#C7C9E6');
});

test('coming back to the tab reads /v1/me again, and the open menu\'s 40 px header changes in place too', async ({ page, request }) => {
  const me = await arrive(page, request, built(PERIWINKLE), '/?meReturnGapMs=0');
  await account(page).click();
  const head = page.locator('.menu-me .avatar-face img');
  await expect(head).toBeVisible();
  expect(await svgOf(page, head)).toContain('#C7C9E6');
  await harness(request, { avatar: built(STEEL) });
  const before = me.n;
  await hideAndShow(page);
  await expect.poll(() => me.n).toBe(before + 1);
  await expect.poll(() => svgOf(page)).toContain('#CBD9EC');
  await expect.poll(() => svgOf(page, head)).toContain('#CBD9EC');
  // One image for both: the menu's needs nothing loaded of its own.
  expect(await buttonImg(page).getAttribute('src')).toBe(await head.getAttribute('src'));
  const seen = await faces(page);
  noFlash(seen, 'button');
  noFlash(seen, 'menu');
});

test.describe('a picture', () => {
  // The harness's CSP allows no picture host, and a real one is Platform's (`MA_AVATAR_ORIGIN`); this one is routed here.
  test.use({ bypassCSP: true });

  test('the old avatar stays until the new picture has loaded, then the picture takes its place', async ({ page, request }) => {
    let release = (): void => {};
    const held = new Promise<void>((done) => (release = done));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPwTW3BihiGlgQAOspNgUDoPmMAAAAASUVORK5CYII=', 'base64');
    await page.route('https://api.avatar.test/**', async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: 'image/png', body: png });
    });
    const me = await arrive(page, request, built(PERIWINKLE), '/?meReturnGapMs=0');
    const old = await buttonImg(page).getAttribute('src');
    await harness(request, { avatar: { kind: 'upload', url: PICTURE, setAt: '2026-11-16T10:00:00Z' } });
    const before = me.n;
    await hideAndShow(page);
    await expect.poll(() => me.n).toBe(before + 1);
    // `/v1/me` has answered and the picture is on its way: the built avatar is still what's drawn.
    await page.waitForTimeout(700);
    expect(await buttonImg(page).getAttribute('src')).toBe(old);
    await expect(account(page).locator('.avatar-face')).toHaveAttribute('data-initials', '');
    release();
    await expect.poll(() => buttonImg(page).getAttribute('src')).toBe(PICTURE);
    await expect(buttonImg(page)).not.toHaveClass(/avatar-built/);
    noFlash(await faces(page), 'button');
  });

  test('a picture that never loads leaves the initials, as before', async ({ page, request }) => {
    await page.route('https://api.avatar.test/**', (route) => route.fulfill({ status: 404, body: '' }));
    await arrive(page, request, built(PERIWINKLE), '/?meReturnGapMs=0');
    await harness(request, { avatar: { kind: 'upload', url: PICTURE, setAt: '2026-11-16T10:00:00Z' } });
    await hideAndShow(page);
    await expect(account(page).locator('.avatar-face')).toHaveAttribute('data-initials', 'TM');
    await expect(buttonImg(page)).toHaveCount(0);
  });
});
