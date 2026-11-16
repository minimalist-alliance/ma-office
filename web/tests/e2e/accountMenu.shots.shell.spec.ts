// Stills of the account menu for the owner's look (`accountMenu.shell.spec.ts` is the check): Light, Zen and Dark, at 1440x900,
// 390x844 and 640x360, for the owner with everything the menu holds and Maia on, as his own office has it: the first view, then
// each tucked section open, and the Keyboard shortcuts modal. On a build without the sections (main before Nov 16), the menu
// as it was, at its screen height and drawn at its whole length. Since the release 6.8 brand review, also: a phone as it's
// held (touch, so 44 px rows), the keyboard's focus rings close up (device scale 2), and a member's first view and
// Appearance (no About, no Maia). Since release 6.8's polish (the pinned header), each section is shot once the menu's glide
// has settled, and the focus rings take Sign out too. Since release 6.11, Sign out is one plain row (the owner, Nov 16: "Just
// let me sign out"), and `foot-*` shots it close up, in glass, hovered, signing out and under reduced transparency. Skipped
// unless $ACCOUNT_MENU_SHOTS names a folder.
import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const DIR = process.env['ACCOUNT_MENU_SHOTS'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'short', width: 640, height: 360 },
] as const;
const RICH = {
  roles: ['owner'],
  configExtra: { maiaMode: { enabled: false, listed: true } },
  meMaiaMode: { enabled: true },
  sso: { origin: 'https://id.localhost' },
  membership: { status: 'active', tier: 'lead', badge: 'lead' },
  maiaAway: { enabled: true, on: true, email: false, hoursPerDay: 4, wake: [] },
};

const panel = (page: Page) => page.locator('#account-panel');

/** Once the menu's glide is over and what loads into an open section is in: scroll and size still for 12 frames. */
const settle = (page: Page): Promise<void> =>
  panel(page).evaluate(
    (el) =>
      new Promise<void>((done) => {
        const t0 = performance.now();
        let last = '';
        let still = 0;
        const tick = (): void => {
          const now = `${el.scrollTop}/${el.scrollHeight}`;
          still = now === last ? still + 1 : 0;
          last = now;
          if ((still >= 12 && performance.now() - t0 > 300) || performance.now() - t0 > 2500) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

/**
 * With Maia's gate open, the first load asks once how the office opens (`maiamode/chooser.ts`), over an inert office: Esc
 * answers it with the default, as `maiaMode.shell.spec.ts` does. Nothing to answer for anyone else.
 */
async function answerChooser(page: Page): Promise<void> {
  const ask = page.getByRole('group', { name: 'Open your office in' });
  await page.waitForFunction(() => performance.getEntriesByName('ma:office-ready').length > 0);
  if (!(await ask.count())) return;
  await page.keyboard.press('Escape');
  await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('#ma-root')).not.toHaveAttribute('inert', '');
}

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).first().click();
  await expect(panel(page)).toBeVisible();
}

/** Maia on, as the owner has her: through the switch and her disclosure, then back to the desks. */
async function maiaOn(page: Page): Promise<void> {
  await openMenu(page);
  const row = page.getByTestId('menu-maia');
  if (await row.count()) await row.click();
  await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'I’ve read this' }).check();
  await dialog.getByRole('button', { name: 'Turn on Maia' }).click();
  await expect(page.locator('.mm-room[data-ready]')).toBeVisible();
  await page.waitForTimeout(800);
  // "Show my desks" on a larger screen; a phone's room says "Desks".
  await page.getByRole('button', { name: /^(Show my desks|Desks)$/ }).first().click();
  await expect(page.locator('.mm-room[data-ready]')).toHaveCount(0, { timeout: 5000 });
  await page.waitForTimeout(800);
}

test.skip(!DIR, 'stills only: set ACCOUNT_MENU_SHOTS to a folder');

/** The owner's menu in one theme at one size: the first view, each tucked section open, then the shortcuts modal. */
async function ownersMenu(page: Page, request: APIRequestContext, theme: ThemeId, base: string, size?: { width: number; height: number }): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  await harness(request, { reset: true });
  await harness(request, RICH);
  await setTheme(page, theme);
  if (size) await page.setViewportSize(size);
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await answerChooser(page);
  await maiaOn(page);
  await page.screenshot({ path: `${base}-0-closed.png` });
  await openMenu(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${base}-1-menu.png` });
  const tucked = (await page.getByTestId('menu-appearance').count()) > 0;
  if (!tucked) {
    if (!size) return;
    // The menu as it was: its whole length, drawn past the screen's foot for the record.
    await panel(page).evaluate((el) => {
      el.style.maxHeight = 'none';
    });
    await page.setViewportSize({ width: size.width, height: Math.max(size.height, Math.ceil(await panel(page).evaluate((el) => el.getBoundingClientRect().bottom + 16))) });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${base}-2-whole-length.png` });
    return;
  }
  let n = 2;
  for (const [id, name] of [['menu-appearance', 'appearance'], ['menu-maia', 'maia'], ['about-toggle', 'about']] as const) {
    const row = page.getByTestId(id);
    if (!(await row.count())) continue;
    await row.click();
    await settle(page);
    await page.screenshot({ path: `${base}-${n++}-${name}.png` });
    await row.click();
  }
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${base}-${n}-shortcuts.png` });
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    test(`${size.name}, ${theme}`, async ({ page, request }) => {
      test.setTimeout(90_000);
      await ownersMenu(page, request, theme, `${DIR}/${size.name}-${theme}`, { width: size.width, height: size.height });
    });
  }
}

// A phone as members hold it: a coarse pointer, so the rows are 44 px, Sign out's too.
test.describe('phone, touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const theme of THEMES) {
    test(`phone-touch, ${theme}`, async ({ page, request }) => {
      test.setTimeout(90_000);
      await ownersMenu(page, request, theme, `${DIR}/phone-touch-${theme}`);
    });
  }
});

/** Give `target` the keyboard's focus with a key press, so `:focus-visible` holds as it does for a member on the keyboard. */
async function keyFocus(page: Page, target: ReturnType<Page['locator']>): Promise<void> {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  await page.mouse.move(700, 700);
  await page.waitForTimeout(150);
}

// The keyboard's rings close up (device scale 2): a disclosure row, Sign out, a slider in Appearance, the shortcuts row and the
// modal's Close.
test.describe('focus rings', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  for (const theme of THEMES) {
    test(`focus, ${theme}`, async ({ page, request }) => {
      test.setTimeout(90_000);
      mkdirSync(DIR, { recursive: true });
      await harness(request, { reset: true });
      await harness(request, RICH);
      await setTheme(page, theme);
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await answerChooser(page);
      await openMenu(page);
      const clip = async () => {
        const b = (await panel(page).boundingBox())!;
        return { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 };
      };
      const base = `${DIR}/focus-${theme}`;
      await keyFocus(page, page.getByTestId('menu-appearance'));
      await page.screenshot({ path: `${base}-1-row.png`, clip: await clip() });
      await keyFocus(page, panel(page).getByRole('button', { name: 'Sign out', exact: true }));
      await page.screenshot({ path: `${base}-2b-sign-out.png`, clip: await clip() });
      await page.getByTestId('menu-appearance').press('Enter');
      await expect(page.getByTestId('menu-appearance')).toHaveAttribute('aria-expanded', 'true');
      const slider = panel(page).getByRole('slider').first();
      await expect(slider).toBeEnabled(); // once the sliders' engine has loaded
      await keyFocus(page, slider);
      await page.screenshot({ path: `${base}-3-slider.png`, clip: await clip() });
      await page.getByTestId('menu-appearance').press('Enter');
      await keyFocus(page, page.getByTestId('menu-shortcuts'));
      await page.screenshot({ path: `${base}-4-shortcuts-row.png`, clip: await clip() });
      await page.getByTestId('menu-shortcuts').press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('shortcuts-close')).toBeFocused();
      await page.waitForTimeout(200);
      const d = (await dialog.boundingBox())!;
      await page.screenshot({ path: `${base}-5-dialog-close.png`, clip: { x: d.x - 8, y: d.y - 8, width: d.width + 16, height: Math.min(d.height + 16, 240) } });
    });
  }
});

// A member's menu, not the owner's: no About, no Maia (her gate shut), the setup circle's row on a narrow phone.
for (const [name, options] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone-touch', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]] as const) {
  test.describe(`member, ${name}`, () => {
    test.use(options);
    for (const theme of THEMES) {
      test(`member, ${name}, ${theme}`, async ({ page, request }) => {
        test.setTimeout(90_000);
        mkdirSync(DIR, { recursive: true });
        await harness(request, { reset: true });
        await setTheme(page, theme);
        await signIn(page, '/?fixture=three');
        await canvasPainted(page);
        await openMenu(page);
        await page.waitForTimeout(400);
        const base = `${DIR}/member-${name}-${theme}`;
        await page.screenshot({ path: `${base}-1-menu.png` });
        await page.getByTestId('menu-appearance').click();
        await settle(page);
        await page.screenshot({ path: `${base}-2-appearance.png` });
      });
    }
  });
}

// Sign out, one plain row at the menu's foot (release 6.11): the menu's foot close up, at rest, hovered and signing out, in
// glass and under reduced transparency (6.10's fallback look), for the owner's menu and a member's, in three themes.
test.describe('the foot', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  for (const theme of THEMES) {
    for (const [who, fallback] of [['owner', false], ['member', false], ['member', true]] as const) {
      test(`foot, ${who}${fallback ? ', reduced transparency' : ''}, ${theme}`, async ({ page, request }) => {
        test.setTimeout(90_000);
        mkdirSync(DIR, { recursive: true });
        await harness(request, { reset: true });
        if (who === 'owner') await harness(request, RICH);
        if (fallback) await (await page.context().newCDPSession(page)).send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
        await setTheme(page, theme);
        await signIn(page, '/?fixture=three');
        await canvasPainted(page);
        await answerChooser(page);
        await openMenu(page);
        await page.mouse.move(700, 700);
        await page.waitForTimeout(400);
        const base = `${DIR}/foot-${who}${fallback ? '-fallback' : ''}-${theme}`;
        await page.screenshot({ path: `${base}-menu.png`, clip: await menuClip(page) });
        await page.screenshot({ path: `${base}-1-rest.png`, clip: await footClip(page) });
        const row = panel(page).getByRole('button', { name: 'Sign out', exact: true });
        await row.hover();
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${base}-2-hover.png`, clip: await footClip(page) });
        await harness(request, { signOutDelayMs: 5_000 });
        await row.click();
        await expect(page.getByTestId('menu-sign-out')).toHaveText('Signing out…');
        await page.mouse.move(700, 700);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${base}-3-signing-out.png`, clip: await footClip(page) });
      });
    }
  }
});

async function menuClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = (await page.locator('.account-glass').boundingBox())!;
  return { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 };
}

/** The menu's foot: from the divider over Account settings' row to the plate's lower edge, its light and lift included. */
async function footClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = (await page.locator('.account-glass').boundingBox())!;
  const settings = (await page.getByTestId('menu-account-settings').boundingBox())!;
  const top = settings.y - 6;
  return { x: b.x - 12, y: top, width: b.width + 24, height: b.y + b.height + 14 - top };
}
