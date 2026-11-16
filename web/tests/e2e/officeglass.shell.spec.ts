// The office's chrome in glass (the owner, Nov 16: "Probably all of the UI elements in office actually"; record
// `docs/sub-status/office-glass.md`): the bars' controls and pills, the notices and the office's menus wear the one recipe
// (`styles/glass.css`), with the light as their edge and no border; under reduced transparency or more contrast each is its
// solid look again, live; a keyboard focus ring stays the office's own on glass; and (release 6.10) the account button and
// its menu wear it too. The contrast on the rendered glass is `officeglass.contrast.shell.spec.ts`'s.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole } from './helpers';

const FLEET = [
  { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
];

type Look = { image: string; color: string; border: string; shadow: string; ring: string };
const look = (l: Locator): Promise<Look> =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { image: cs.backgroundImage, color: cs.backgroundColor, border: cs.borderTopColor, shadow: cs.boxShadow, ring: getComputedStyle(el, '::after').content };
  });

async function arrive(page: Page): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet: FLEET });
  await signIn(page, '/?versionEveryMs=300');
  await canvasPainted(page);
  await harness(page.request, { releaseVersion: '2099.01.01-0000000' });
  await expect(page.getByTestId('new-version')).toBeVisible({ timeout: 10_000 });
  return errors;
}

async function reducedTransparency(page: Page, on: boolean): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: on ? 'reduce' : 'no-preference' }] });
}

const controls = (page: Page) => ({
  shield: page.getByRole('button', { name: 'Privacy shield' }),
  fullscreen: page.getByRole('button', { name: 'Full screen' }),
  scope: page.getByRole('radiogroup', { name: 'Scope' }),
  hints: page.locator('.hints'),
  deskSwitch: page.getByRole('group', { name: 'Switch desk' }),
  zoom: page.getByRole('group', { name: 'Zoom' }),
  notice: page.getByTestId('new-version'),
  circle: page.getByTestId('bandwidth-button'),
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('the bars, the notice, a desk\'s menu, the account button and its menu wear the glass, with the light as their edge', async ({ page }) => {
  const errors = await arrive(page);
  const c = controls(page);
  for (const [name, l] of Object.entries(c)) {
    if (!(await l.isVisible())) continue;
    await expect(l, name).toHaveClass(/\bma-glass\b/);
    const s = await look(l);
    expect(s.image, name).toMatch(/radial-gradient/);
    expect(s.color, name).toBe('rgba(0, 0, 0, 0)');
    // The contact shadow under it and the depth inside: never the old hairline ring.
    expect(s.shadow, name).toMatch(/inset/);
    expect(s.ring, name).toBe('""');
  }
  // A border it had is clear in glass.
  expect((await look(c.shield)).border).toBe('rgba(0, 0, 0, 0)');
  expect((await look(c.notice)).border).toBe('rgba(0, 0, 0, 0)');
  // The account button (release 6.10): its avatar fills it, so its edge is the clear ring round the art, the bell's.
  const account = page.getByRole('button', { name: 'Account', exact: true }).first();
  await expect(account).toHaveClass(/\bma-glass\b/);
  expect((await look(account)).image).toMatch(/radial-gradient/);
  expect(await account.locator('.avatar-face').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgba(0, 0, 0, 0)');
  // Its menu: a plate of glass that never scrolls, holding the menu, which does.
  await account.click();
  const plate = page.locator('.account-glass');
  await expect(plate).toHaveClass(/\bma-glass\b/);
  expect((await look(plate)).image).toMatch(/radial-gradient/);
  expect((await look(plate)).border).toBe('rgba(0, 0, 0, 0)');
  expect(await plate.evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible');
  expect(await page.locator('#account-panel').evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-panel')).toHaveCount(0);
  // A desk's menu, and the bell's panel, whose list scrolls inside it.
  const work = (await page.getByRole('button', { name: /^Work desk,/ }).boundingBox())!;
  await page.mouse.click(work.x + work.width * 0.6, work.y + work.height * 0.7, { button: 'right' });
  const menu = page.locator('.menu.desk-menu');
  await expect(menu).toHaveClass(/\bma-glass\b/);
  expect((await look(menu)).image).toMatch(/radial-gradient/);
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('reduced transparency or more contrast: each is its solid look again, live, and back to glass when it goes', async ({ page }) => {
  const errors = await arrive(page);
  const c = controls(page);
  const glass = await look(c.shield);
  await reducedTransparency(page, true);
  const solid = { shield: await look(c.shield), notice: await look(c.notice), deskSwitch: await look(c.deskSwitch), hints: await look(c.hints) };
  for (const [name, s] of Object.entries(solid)) {
    expect(s.image, name).toBe('none');
    expect(s.color, name).not.toBe('rgba(0, 0, 0, 0)');
    expect(s.ring, name).toBe('none');
  }
  // The border and shadow they had: a hairline round the round buttons and the notice, the menu's shadow under the notice.
  expect(solid.shield.border).not.toBe('rgba(0, 0, 0, 0)');
  expect(solid.notice.border).not.toBe('rgba(0, 0, 0, 0)');
  expect(solid.notice.shadow).not.toMatch(/inset/);
  await reducedTransparency(page, false);
  expect(await look(c.shield)).toEqual(glass);
  await page.emulateMedia({ contrast: 'more' } as Parameters<Page['emulateMedia']>[0]);
  expect((await look(c.shield)).image).toBe('none');
  expect(errors).toEqual([]);
});

test('a keyboard focus ring on glass is the office\'s own, 2 px and off its edge', async ({ page }) => {
  const errors = await arrive(page);
  const c = controls(page);
  await c.shield.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(c.shield).toBeFocused();
  const ring = await c.shield.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth, offset: getComputedStyle(el).outlineOffset, visible: el.matches(':focus-visible') }));
  expect(ring).toEqual({ style: 'solid', width: '2px', offset: '2px', visible: true });
  const next = page.getByRole('button', { name: 'Next desk' });
  await next.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  expect(await next.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(errors).toEqual([]);
});

const bodies: Record<string, string> = {};
for (const theme of ['light', 'dusk', 'dark'] as const) {
  test(`each theme wears its own glass (${theme})`, async ({ page }) => {
    await setTheme(page, theme);
    const errors = await arrive(page);
    const image = (await look(controls(page).notice)).image;
    expect(image).toMatch(/radial-gradient/);
    bodies[theme] = image;
    expect(Object.entries(bodies).filter(([t, b]) => t !== theme && b === image)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
