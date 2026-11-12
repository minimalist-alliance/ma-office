// The Designer's re-read of the four fixes before merge (SHOTS=1 only), into SHOTS_DIR: About in Zen (the KJV's notice and
// its source), the phone's bar in Zen with its verse clear, a footnote letter inside a highlight in Zen and Dark (the window
// and a close crop), and the phone's Go to grid.
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { api, frame, goTo, openView, reset, view } from './helpers';

const DIR = process.env.SHOTS_DIR || path.join(process.cwd(), 'shots');
fs.mkdirSync(DIR, { recursive: true });
const shot = (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) =>
  page.screenshot({ path: path.join(DIR, `${name}.png`), ...(clip ? { clip } : {}) });

test.beforeEach(async ({ page }) => {
  await reset(page);
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'JHN', chapter: 3, verse: 3, color: 'amber', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'JHN', chapter: 3, verse: 7, color: 'blue', translation: 'bsb' } }, true);
});

test('fix 1: About in Zen shows the publisher\'s notice and the source as words', async ({ page }) => {
  const v = await openView(page, 'theme=dusk');
  await goTo(page, 'John 3');
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: 'About King James Version' }).click();
  await expect(v.getByRole('dialog', { name: 'King James Version' })).toBeVisible();
  await shot(page, 'fix1-zen-about-kjv');
  await page.keyboard.press('Escape');
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: 'About Berean Standard Bible' }).click();
  await expect(v.getByRole('dialog', { name: 'Berean Standard Bible' })).toBeVisible();
  await shot(page, 'fix1-zen-about-bsb');
});

test('fix 2: the phone\'s bar in Zen keeps its verse clear', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const v = await openView(page, 'theme=dusk&phone=1');
  await goTo(page, 'John 3');
  await v.locator('.v[data-v="5"] .vt').first().click();
  await expect(v.locator('.abar.sheet')).toBeVisible();
  await page.waitForTimeout(700);
  await shot(page, 'fix2-zen-phone-bar-john3-5');
  await page.keyboard.press('Escape');
  await frame(page).evaluate(() => {
    const s = document.getElementById('scroll')!;
    s.scrollTop = s.scrollHeight;
  });
  await v.locator('.v[data-v="36"] .vt').first().click();
  await page.waitForTimeout(700);
  await shot(page, 'fix2-zen-phone-bar-john3-36-last');
});

for (const [theme, name] of [['dusk', 'zen'], ['dark', 'dark']] as const) {
  test(`fix 3: a footnote letter inside a highlight, ${name}`, async ({ page }) => {
    const v = await openView(page, `theme=${theme}`);
    await goTo(page, 'John 3');
    await shot(page, `fix3-${name}-highlight-footnote`);
    const a = (await v.locator('.v[data-v="3"]').first().boundingBox())!;
    const b = (await v.locator('.v[data-v="7"]').first().boundingBox())!;
    const top = Math.min(a.y, b.y) - 12;
    await shot(page, `fix3-${name}-highlight-footnote-crop`, { x: a.x - 24, y: top, width: 680, height: Math.max(a.y + a.height, b.y + b.height) - top + 12 });
  });
}

for (const [theme, name] of [['dusk', 'zen'], ['light', 'light']] as const) {
  test(`fix 4 and 12: the phone's Go to grid, ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const v = await openView(page, `theme=${theme}&phone=1`);
    await goTo(page, 'John 3');
    await v.locator('#refBtn').click();
    await expect(v.locator('.goto.sheet')).toBeVisible();
    await shot(page, `fix4-${name}-phone-goto`);
    await v.getByRole('button', { name: 'John', exact: true }).click();
    await shot(page, `fix4-${name}-phone-goto-chapters`);
    void view;
  });
}

// The accessibility pass's pick (2): a footnote letter inside a highlight, focused from the keyboard, its ring text.primary,
// in Light, Zen and Dark at 1440 and 390 (the window and a close crop), for the Designer's brand read.
for (const theme of ['light', 'dusk', 'dark'] as const) {
  for (const width of [1440, 390] as const) {
    test(`pick 2: a highlighted footnote's focus ring, ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openView(page, `theme=${theme}${width === 390 ? '&phone=1' : ''}`);
      await goTo(page, 'John 3');
      await page.keyboard.press('Shift');
      const box = await frame(page).evaluate(() => {
        const fn = document.querySelector<HTMLElement>('.v[data-v="3"] .vt.hl .fn')!;
        fn.scrollIntoView({ block: 'center' });
        fn.focus();
        const r = fn.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, visible: fn.matches(':focus-visible') };
      });
      expect(box.visible).toBe(true);
      const name = `pick2-${theme === 'dusk' ? 'zen' : theme}-${width}`;
      await shot(page, name);
      const frameBox = (await page.locator('#frame').boundingBox())!;
      const cx = frameBox.x + box.x + box.w / 2;
      const cy = frameBox.y + box.y + box.h / 2;
      await shot(page, `${name}-crop`, { x: Math.max(0, cx - 90), y: Math.max(0, cy - 40), width: 180, height: 80 });
    });
  }
}
