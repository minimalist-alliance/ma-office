// A way to move and resize that's no drag (WCAG 2.5.7, the Product Designer's spec): while a desk or an app is moved or
// resized, the bottom bar's row is the edit's own, four arrows that step it one grid cell (an app's pitch, 92 units), then
// Keep and Restore, which do what Enter and Esc do. The keyboard goes to the first arrow as it starts and back to the tile
// as it ends; the keys are as they were (8 units, Shift 40, Enter keeps, Esc restores, Tab keeps), and so is the drag.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const SHOTS = process.env['EDITBAR_SHOTS'];
const CELL = 92;
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const MOVE = ['Move left', 'Move up', 'Move down', 'Move right', 'Keep', 'Restore'];
const RESIZE = ['Narrower', 'Shorter', 'Taller', 'Wider', 'Keep', 'Restore'];

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

interface Box { x: number; y: number; w: number; h: number }
/** Where the store has it: a proxy is placed in world units from the layout. */
const placed = (el: Locator): Promise<Box> => el.evaluate((b: HTMLElement) => ({ x: parseFloat(b.style.left), y: parseFloat(b.style.top), w: parseFloat(b.style.width), h: parseFloat(b.style.height) }));
const deskTile = (page: Page) => page.getByRole('button', { name: /^Personal desk/ });
/** The row, named by its label: "Moving Personal", "Resizing Notebook". */
const bar = (page: Page, kind: 'Move' | 'Resize') => page.getByRole('group', { name: kind === 'Move' ? /^Moving / : /^Resizing / });
const said = (page: Page) => page.getByRole('status').first();
type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const rect = (el: Locator): Promise<Rect> => el.evaluate((e) => e.getBoundingClientRect().toJSON() as Rect);

async function arrive(page: Page, path = '/?fixture=one', size = { width: 1440, height: 900 }, theme: ThemeId = 'light'): Promise<void> {
  await setTheme(page, theme);
  await page.setViewportSize(size);
  await signIn(page, path);
  await canvasPainted(page);
  await page.waitForTimeout(400);
}

/** The tile's ring while it's edited: dashed, 3 px, drawn with the keyboard on the bar. */
const ring = (el: Locator) => el.evaluate((b) => { const a = getComputedStyle(b, '::after'); return { content: a.content, style: a.borderTopStyle }; });

test('move mode on a desk: the row is ← ↑ ↓ →, Keep and Restore, the keyboard on the first; each arrow moves it a grid cell; Restore puts it back', async ({ page }) => {
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  await desk.focus();
  await page.keyboard.press('m');
  const row = bar(page, 'Move');
  await expect(row).toBeVisible();
  // The quiet label at its left says which edit and what of, and names the group (the Designer's fix).
  await expect(row).toHaveAccessibleName('Moving Personal');
  await expect(row.locator('.edit-name')).toHaveText('Moving Personal');
  // In `text.secondary`: the same color an element given that token draws.
  expect(await row.locator('.edit-name').evaluate((el) => {
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--ma-text-secondary)';
    const same = getComputedStyle(el).color === getComputedStyle(probe).color;
    probe.remove();
    return same;
  })).toBe(true);
  expect((await rect(row.locator('.edit-name'))).right).toBeLessThanOrEqual((await rect(row.getByRole('button', { name: 'Move left' }))).left);
  expect(await row.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent))).toEqual(MOVE);
  // The row is the edit's: the hints, the desk switch and the zoom are gone while it's on.
  await expect(page.locator('.bottombar .hints, .bottombar .zoom-ctl, .bottombar .zoom-menu')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Move left' })).toBeFocused();
  await expect(desk).toHaveClass(/\bediting\b/);
  expect(await ring(desk)).toEqual({ content: '""', style: 'dashed' });

  const steps: [string, number, number][] = [['Move right', CELL, 0], ['Move down', CELL, CELL], ['Move left', 0, CELL], ['Move up', 0, 0]];
  for (const [name, dx, dy] of steps) {
    await row.getByRole('button', { name }).click();
    expect(await placed(desk), name).toMatchObject({ x: start.x + dx, y: start.y + dy });
    await expect(row, 'a press on the row is the edit\'s own: it goes on').toBeVisible();
  }
  await expect(said(page)).toHaveText(`Personal desk at ${Math.round(start.x)}, ${Math.round(start.y)}`);
  await row.getByRole('button', { name: 'Move right' }).click();
  await row.getByRole('button', { name: 'Move right' }).click();
  expect((await placed(desk)).x).toBe(start.x + 2 * CELL);
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(row).toHaveCount(0);
  expect(await placed(desk)).toEqual(start);
  await expect(said(page)).toHaveText('Restored');
  await expect(desk).toBeFocused();
  await expect(desk).not.toHaveClass(/\bediting\b/);
  await expect(page.locator('.bottombar .zoom-ctl')).toBeVisible();
});

test('move mode: Keep keeps, as Enter does, and the keyboard goes back to the desk', async ({ page }) => {
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  await desk.focus();
  await page.keyboard.press('m');
  await bar(page, 'Move').getByRole('button', { name: 'Move down' }).click();
  await bar(page, 'Move').getByRole('button', { name: 'Keep' }).click();
  await expect(bar(page, 'Move')).toHaveCount(0);
  expect(await placed(desk)).toMatchObject({ x: start.x, y: start.y + CELL });
  await expect(said(page)).toHaveText('Kept');
  await expect(desk).toBeFocused();
  // Enter, with the keyboard on the row's first arrow, is Keep, as it always was.
  await page.keyboard.press('m');
  await expect(bar(page, 'Move').getByRole('button', { name: 'Move left' })).toBeFocused();
  await bar(page, 'Move').getByRole('button', { name: 'Move right' }).click();
  await page.keyboard.press('Enter');
  await expect(bar(page, 'Move')).toHaveCount(0);
  expect(await placed(desk)).toMatchObject({ x: start.x + CELL, y: start.y + CELL });
  await expect(desk).toBeFocused();
});

test('resize mode: Narrower, Shorter, Taller and Wider move the bottom-right corner a grid cell; Keep and Restore', async ({ page }) => {
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  await desk.focus();
  await page.keyboard.press('r');
  const row = bar(page, 'Resize');
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName('Resizing Personal');
  expect(await row.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent))).toEqual(RESIZE);
  await expect(row.getByRole('button', { name: 'Narrower' })).toBeFocused();
  const steps: [string, number, number][] = [['Wider', CELL, 0], ['Taller', CELL, CELL], ['Narrower', 0, CELL], ['Shorter', 0, 0]];
  for (const [name, dw, dh] of steps) {
    await row.getByRole('button', { name }).click();
    expect(await placed(desk), name).toEqual({ x: start.x, y: start.y, w: start.w + dw, h: start.h + dh });
  }
  await row.getByRole('button', { name: 'Wider' }).click();
  await row.getByRole('button', { name: 'Restore' }).click();
  expect(await placed(desk)).toEqual(start);
  await expect(desk).toBeFocused();
  await page.keyboard.press('r');
  await row.getByRole('button', { name: 'Taller' }).click();
  await row.getByRole('button', { name: 'Keep' }).click();
  expect(await placed(desk)).toEqual({ ...start, h: start.h + CELL });
  await expect(desk).toBeFocused();
});

test('an app: Move right and Move left by a grid cell, Restore, and the keyboard back on the app', async ({ page }) => {
  await arrive(page);
  await deskTile(page).focus();
  await page.keyboard.press('ArrowRight');
  const app = page.locator('.proxy-layer :focus');
  await expect(app).toHaveAttribute('aria-label', /^(Notebook|Browser|Chat|Agent)/);
  const id = (await app.getAttribute('id'))!;
  const tile = page.locator(`[id="${id}"]`);
  const start = await placed(tile);
  await page.keyboard.press('m');
  const row = bar(page, 'Move');
  await expect(row).toHaveAccessibleName(`Moving ${(await tile.getAttribute('aria-label'))!.split(',')[0]}`);
  await expect(row.getByRole('button', { name: 'Move left' })).toBeFocused();
  await row.getByRole('button', { name: 'Move right' }).click();
  expect((await placed(tile)).x).toBe(start.x + CELL);
  await row.getByRole('button', { name: 'Move left' }).click();
  expect((await placed(tile)).x).toBe(start.x);
  await row.getByRole('button', { name: 'Move right' }).click();
  await row.getByRole('button', { name: 'Restore' }).click();
  expect(await placed(tile)).toEqual(start);
  await expect(tile).toBeFocused();
  await page.keyboard.press('r');
  await bar(page, 'Resize').getByRole('button', { name: 'Taller' }).click();
  await bar(page, 'Resize').getByRole('button', { name: 'Keep' }).click();
  expect((await placed(tile)).h).toBeGreaterThan(start.h);
  await expect(tile).toBeFocused();
});

test('the keys are as they were with the row on: arrows 8, Shift 40, Space presses the arrow it\'s on, Esc restores, Tab keeps and goes on from the desk', async ({ page }) => {
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  await desk.focus();
  await page.keyboard.press('m');
  await expect(bar(page, 'Move').getByRole('button', { name: 'Move left' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  expect((await placed(desk)).x).toBe(start.x + 8);
  await page.keyboard.press('Shift+ArrowDown');
  expect((await placed(desk)).y).toBe(start.y + 40);
  await page.keyboard.press('Space'); // Move left, the button the keyboard is on
  expect((await placed(desk)).x).toBe(start.x + 8 - CELL);
  await expect(bar(page, 'Move')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar(page, 'Move')).toHaveCount(0);
  expect(await placed(desk)).toEqual(start);
  await expect(desk).toBeFocused();
  await page.keyboard.press('m');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(bar(page, 'Move')).toHaveCount(0);
  expect(await placed(desk)).toMatchObject({ y: start.y + 8 });
  // Kept, and the keyboard is on the desk or the stop after it, as Tab from the desk always went: never lost with the row.
  await expect.poll(() => page.evaluate(() => {
    const el = document.activeElement;
    return !!el && el !== document.body && el.isConnected && !el.closest('.edit-bar');
  })).toBe(true);
});

test('by mouse from the desk\'s menu: the row\'s presses go on with the edit, a press anywhere else keeps it', async ({ page }) => {
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  const box = await rect(desk);
  await page.mouse.click(box.left + box.width / 2, box.top + box.height - 12, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Move' }).click();
  const row = bar(page, 'Move');
  await expect(row).toBeVisible();
  await expect(desk).toHaveClass(/\bediting\b/);
  expect((await ring(desk)).style).toBe('dashed');
  await row.getByRole('button', { name: 'Move right' }).click();
  await row.getByRole('button', { name: 'Move right' }).click();
  expect((await placed(desk)).x).toBe(start.x + 2 * CELL);
  await page.mouse.click(8, 450); // the canvas, off every desk
  await expect(row).toHaveCount(0);
  expect((await placed(desk)).x).toBe(start.x + 2 * CELL);
});

test('a drag is as it was: the edit row never shows for one', async ({ page }) => {
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  const box = await rect(desk);
  // A desk drags from its panel's foot, under its apps.
  await page.mouse.move(box.left + box.width / 2, box.bottom - 10);
  await page.mouse.down();
  await page.mouse.move(box.left + box.width / 2 + 60, box.bottom - 10, { steps: 6 });
  await expect(page.locator('.edit-bar')).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(async () => (await placed(desk)).x).toBeGreaterThan(start.x);
  await expect(page.locator('.edit-bar')).toHaveCount(0);
});

// The row is the popovers chunk's (fetched at idle), so the first load keeps only the bar's switch to it. An edit begun
// before the chunk is here keeps its keys meanwhile, and the row comes as it lands, with the keyboard on its first arrow.
test('begun before the popovers chunk is here, the edit keeps its keys, and the row comes as the chunk lands, the keyboard on its first arrow', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/popovers-[^/]*\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  await arrive(page);
  const desk = deskTile(page);
  const start = await placed(desk);
  await desk.focus();
  await page.keyboard.press('m');
  await expect(desk).toHaveClass(/\bediting\b/);
  await page.keyboard.press('ArrowRight');
  expect((await placed(desk)).x).toBe(start.x + 8);
  await page.waitForTimeout(300);
  await expect(page.locator('.edit-bar')).toHaveCount(0);
  await expect(desk).toBeFocused();
  release();
  await expect(bar(page, 'Move').getByRole('button', { name: 'Move left' })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await placed(desk)).toEqual(start);
  await expect(desk).toBeFocused();
});

// In short-viewport mode (under 400 px high) the six still fit on the bar's one 44 px row. Moving and resizing exist from
// 600 px wide (a phone keeps its grid, ADR 0062), so the narrowest is 640 x 360, a 2560 x 1440 window at 400 %.
for (const theme of THEMES) {
  for (const kind of ['Move', 'Resize'] as const) {
    test(`short-viewport mode, 640 x 360, ${theme}: ${kind}'s row on one 44 px row, clear of the top bar, every button takes a press`, async ({ page }) => {
      await arrive(page, '/?fixture=three', { width: 640, height: 360 }, theme);
      await deskTile(page).focus();
      await page.keyboard.press(kind === 'Move' ? 'm' : 'r');
      const row = bar(page, kind);
      await expect(row).toBeVisible();
      await page.waitForTimeout(300);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/640x360-${theme}-${kind.toLowerCase()}.png` });
      const top = await rect(page.locator('.topbar'));
      const bottom = await rect(page.locator('.bottombar'));
      expect(top.bottom).toBeLessThanOrEqual(bottom.top);
      expect(bottom.height).toBe(60);
      const buttons = await row.getByRole('button').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { name: el.getAttribute('aria-label') ?? el.textContent, w: r.width, h: r.height, mid: r.top + r.height / 2, left: r.left, right: r.right, pressable: !!hit && el.contains(hit) };
      }));
      expect(buttons.map((b) => b.name)).toEqual(kind === 'Move' ? MOVE : RESIZE);
      expect(buttons.slice(0, 4).map((b) => [b.w, b.h])).toEqual([[36, 36], [36, 36], [36, 36], [36, 36]]);
      expect(buttons.slice(1, 4).map((b, i) => b.left - buttons[i]!.right)).toEqual([4, 4, 4]);
      for (const b of buttons) {
        expect(b.h).toBe(36);
        expect(Math.abs(b.mid - (360 - 30))).toBeLessThanOrEqual(1);
        expect(b.pressable, b.name ?? '').toBe(true);
      }
      expect(buttons[0]!.left).toBeGreaterThanOrEqual(16);
      const ringBox = await rect(page.getByTestId('bandwidth-button'));
      expect(buttons[5]!.right).toBeLessThanOrEqual(ringBox.left);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
      await page.keyboard.press('Escape');
    });
  }
}

for (const kind of ['Move', 'Resize'] as const) {
  test(`1440 x 900, three desks: ${kind}'s row in the middle of the bar`, async ({ page }) => {
    await arrive(page, '/?fixture=three');
    const nav = await rect(page.locator('.desk-nav'));
    await deskTile(page).focus();
    await page.keyboard.press(kind === 'Move' ? 'm' : 'r');
    const row = bar(page, kind);
    await expect(row).toBeVisible();
    await page.waitForTimeout(300);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1440x900-light-${kind.toLowerCase()}.png` });
    // Where the desk switch was: the bar's middle column.
    const r = await rect(row);
    expect(Math.abs(r.left + r.width / 2 - (nav.left + nav.width / 2))).toBeLessThanOrEqual(1);
    expect((await rect(page.locator('.bottombar'))).height).toBe(70);
    await page.keyboard.press('Escape');
  });
}

// With a finger each of the six is a whole 44 px target, measured as a press lands, as `touch.shell.spec.ts` measures.
for (const viewport of [{ width: 734, height: 343 }, { width: 1024, height: 768 }]) {
  test.describe(`with a finger, ${viewport.width} x ${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test('each of the edit row\'s six takes a 44 px press, the arrows still drawn at 36', async ({ page }) => {
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await deskTile(page).focus();
      await page.keyboard.press('m');
      await expect(bar(page, 'Move')).toBeVisible();
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('.edit-bar button')) {
          const b = el.getBoundingClientRect();
          const [cx, cy] = [b.left + b.width / 2, b.top + b.height / 2];
          const on = (x: number, y: number): boolean => {
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
            const h = document.elementFromPoint(x, y);
            return !!h && el.contains(h);
          };
          let [l, r, t, d] = [0, 0, 0, 0];
          while (l < 30 && on(cx - l - 1, cy)) l++;
          while (r < 30 && on(cx + r + 1, cy)) r++;
          while (t < 30 && on(cx, cy - t - 1)) t++;
          while (d < 30 && on(cx, cy + d + 1)) d++;
          if (l + r + 1 < 44 || t + d + 1 < 44) out.push(`${el.getAttribute('aria-label') ?? el.textContent} ${l + r + 1}x${t + d + 1}`);
        }
        return out;
      });
      expect(small).toEqual([]);
      expect(await page.locator('.edit-bar .icon-btn').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))).toEqual([36, 36, 36, 36]);
    });
  });
}
