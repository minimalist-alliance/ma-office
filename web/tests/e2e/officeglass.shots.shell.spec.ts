// Shots of the office's chrome in glass (the owner, Nov 16: "Probably all of the UI elements in office actually"; record
// `docs/sub-status/office-glass.md`): Light on a Plain desk, and Light, Zen and Dark on White oak, on a desktop (1280 x 800)
// and a 390 px phone, at 2x. Each with a menu open and a notice showing:
//   office   the desks from afar: both bars, the scope switch, the desk switch, the zoom, a widget's card, the new-version
//            notice, and a desk's context menu open
//   bell     the same, with the bell's panel open instead
//   tile     the Personal desk in front: the Notebook live as an open tile beside Files' widget, the notice
//   hand     the same, with the Browser's tile in hand half over Files' card
//   phone    the office on a phone: its bars, the notice, and the mark's menu open
//   account  (release 6.10) the account menu open on its button, the owner with everything it holds; `accountopen` with
//            Appearance open too, scrolled to its foot under its pinned header; `accountphone` the menu open on a 390 px phone
// Run it against any bundle (the one before the glass, then the branch's) to compare. On the mock desk: nobody's real data.
// Skipped unless OFFICE_GLASS_SHOTS names the folder:
//   OFFICE_GLASS_SHOTS=/abs/dir OFFICE_GLASS_TAG=after MA_PW_PORT=5181 npx playwright test --project=shell officeglass.shots
//   [OFFICE_GLASS_ONLY=office,phone] [OFFICE_GLASS_LOOK=solid: under reduced transparency]
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['OFFICE_GLASS_SHOTS'] ?? '';
const TAG = process.env['OFFICE_GLASS_TAG'] ?? 'shot';
const ONLY = (process.env['OFFICE_GLASS_ONLY'] ?? '').split(',').filter(Boolean);
const SOLID = process.env['OFFICE_GLASS_LOOK'] === 'solid';
const asked = (id: string): boolean => !ONLY.length || ONLY.some((o) => id.includes(o));

test.skip(!OUT, 'OFFICE_GLASS_SHOTS names the folder for the screenshots');
test.use({ deviceScaleFactor: 2 });
test.setTimeout(120_000);

const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const NEWER = '2099.01.01-0000000';
type Hook = { __maDesk: { camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };

const it = (desk: string, app: string, x: number, y: number, w = 76, h = 76) => ({ id: `${desk}:${app}`, app, x, y, w, h });
const layout = (style: string) => ({
  desks: {
    [PERSONAL]: {
      id: PERSONAL, x: 0, y: 36, w: 952, h: 528, style,
      items: [
        it(PERSONAL, 'notebook', 24, 24, 536, 444),
        it(PERSONAL, 'files', 576, 24, 352, 260),
        it(PERSONAL, 'browser', 576, 300), it(PERSONAL, 'agent', 668, 300), it(PERSONAL, 'documents', 760, 300), it(PERSONAL, 'courier', 852, 300),
        it(PERSONAL, 'todo', 576, 392),
      ],
    },
    [WORK]: {
      id: WORK, x: 992, y: 36, w: 584, h: 344, style,
      items: [it(WORK, 'browser', 24, 24), it(WORK, 'files', 116, 24), it(WORK, 'notebook', 208, 24), it(WORK, 'agent', 300, 24), it(WORK, 'documents', 392, 24)],
    },
  },
  z: [PERSONAL, WORK],
});

const SCENES: { name: string; theme: ThemeId; style: string }[] = [
  { name: 'light-plain', theme: 'light', style: 'plain' },
  { name: 'light-oak', theme: 'light', style: 'white-oak' },
  { name: 'zen-oak', theme: 'dusk', style: 'white-oak' },
  { name: 'dark-oak', theme: 'dark', style: 'white-oak' },
];

const at = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const NOTIFICATIONS = [
  { id: 'n1', type: 'forum.reply', title: 'Ada replied in Quiet mornings', body: 'Same here, the early hours are the best.', link: '/forums/t/quiet-mornings', actor: { name: 'Ada' }, count: 3, createdAt: at(4), updatedAt: at(4) },
  { id: 'n2', type: 'desk.ready', title: 'Your Work desk is ready', link: '/', createdAt: at(50), updatedAt: at(50) },
  { id: 'n3', type: 'account.card', title: 'Your card expires next month', link: '/account', createdAt: at(1440), updatedAt: at(1440), readAt: at(1000) },
];

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(400);
}

/** The owner with everything the account menu can hold: About this desk, Maia's row, a card that expires soon. */
const OWNER_ALL = {
  roles: ['owner'],
  configExtra: { maiaMode: { enabled: false, listed: true } },
  meMaiaMode: { enabled: true },
  age: 'adult',
  membership: { status: 'active', tier: 'officer', badge: 'officer', ageBand: 'adult', adultFrom: null, parent: null, cardExpiresSoon: { month: 11, year: 2099, last4: '4242' } },
};

async function arrive(page: Page, theme: ThemeId, style: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const errors = watchConsole(page);
  if (SOLID) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  }
  // The styles as they ship (signIn otherwise leaves only Plain).
  await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout(style)));
  await setTheme(page, theme);
  await harness(page.request, { reset: true });
  await harness(page.request, {
    fleet: [
      { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
    ],
    files: { enabled: true }, todo: null, documents: null,
    notifications: { items: NOTIFICATIONS },
    ...extra,
  });
  await signIn(page, '/?speed=fast&versionEveryMs=300');
  await canvasPainted(page);
  if ('configExtra' in extra) {
    // Maia's gate is open, so the first load asks how the office opens: Esc answers it with the default.
    await page.waitForFunction(() => performance.getEntriesByName('ma:office-ready').length > 0);
    if (await page.getByRole('group', { name: 'Open your office in' }).count()) {
      await page.keyboard.press('Escape');
      await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
    }
  }
  await harness(page.request, { releaseVersion: NEWER });
  await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 10_000 });
  // The White oak texture's chunk and image, then the redraw that brings it into the desk and the glass's idle work.
  await page.waitForTimeout(1500);
  return errors;
}

for (const scene of SCENES) {
  const id = (shot: string): string => `${TAG}-${shot}-${scene.name}`;

  if (asked(`office-${scene.name}`)) test(id('office'), async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = await arrive(page, scene.theme, scene.style);
    // A desk's context menu, from a right click on the Work desk's empty floor.
    const work = (await page.getByRole('button', { name: /^Work desk,/ }).boundingBox())!;
    await page.mouse.click(work.x + work.width * 0.5, work.y + work.height * 0.62, { button: 'right' });
    await expect(page.locator('.menu.desk-menu')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${id('office')}.png` });
    expect(errors).toEqual([]);
  });

  if (asked(`bell-${scene.name}`)) test(id('bell'), async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = await arrive(page, scene.theme, scene.style);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.locator('.bell-panel')).toBeVisible();
    await expect(page.locator('.bell-panel').getByText('Ada replied in Quiet mornings')).toBeVisible();
    await page.mouse.move(640, 560);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${id('bell')}.png` });
    expect(errors).toEqual([]);
  });

  if (asked(`tile-${scene.name}`)) test(id('tile'), async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = await arrive(page, scene.theme, scene.style);
    // The Personal desk in front (a click on its empty floor): fit to the screen, the Notebook is big enough to be live.
    const desk = (await page.getByRole('button', { name: /^Personal desk,/ }).boundingBox())!;
    await page.mouse.click(desk.x + desk.width * (800 / 952), desk.y + desk.height * (430 / 528));
    await settled(page);
    await expect(page.locator('.open-tile')).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(1200);
    await page.mouse.move(1270, 420);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${id('tile')}.png` });
    expect(errors).toEqual([]);
  });

  if (asked(`hand-${scene.name}`)) test(id('hand'), async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = await arrive(page, scene.theme, scene.style);
    const desk = (await page.getByRole('button', { name: /^Personal desk,/ }).boundingBox())!;
    await page.mouse.click(desk.x + desk.width * (800 / 952), desk.y + desk.height * (430 / 528));
    await settled(page);
    // The Browser's tile in hand, half over Files' glyph: what's under it shows through its glass.
    const from = (await page.locator(`[id="proxy-${PERSONAL}:browser"]`).boundingBox())!;
    const onto = (await page.locator(`[id="proxy-${PERSONAL}:files"]`).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(onto.x + onto.width * 0.66, onto.y + onto.height * 0.7, { steps: 12 });
    await page.waitForTimeout(700);
    await page.mouse.move(onto.x + onto.width * 0.66 + 1, onto.y + onto.height * 0.7, { steps: 2 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${id('hand')}.png` });
    await page.mouse.up();
    expect(errors).toEqual([]);
  });

  if (asked(`phone-${scene.name}`)) test(id('phone'), async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, scene.theme, scene.style);
    // A tap, Enter or Space opens it pinned: a script's bare click is the keyboard's (a mouse's would go to all desks).
    await page.locator('.home-mark-btn').evaluate((el: HTMLElement) => el.click());
    await expect(page.locator('#mark-menu')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${id('phone')}.png` });
    expect(errors).toEqual([]);
  });

  for (const [shot, width, height, section] of [['account', 1280, 800, null], ['accountopen', 1280, 800, 'menu-appearance'], ['accountphone', 390, 844, null]] as const) {
    if (asked(`${shot}-${scene.name}`)) test(id(shot), async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width, height });
      const errors = await arrive(page, scene.theme, scene.style, OWNER_ALL);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await expect(page.locator('#account-panel')).toBeVisible();
      if (section) {
        await page.locator('#account-panel').getByTestId(section).click();
        await expect(page.getByTestId('theme-tune')).toBeVisible();
        // Scrolled to its foot, so what's above runs under the pinned header, which stays opaque over it.
        await page.waitForTimeout(600);
        await page.locator('#account-panel').evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
      }
      await page.mouse.move(width / 2, height - 40);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${OUT}/${id(shot)}.png` });
      expect(errors).toEqual([]);
    });
  }
}
