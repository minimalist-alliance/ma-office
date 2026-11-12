// Review shots for the Designer (SHOTS=1 only): the window at 1280 x 800 in Light, Zen and Dark, and a 390 px phone.
// Written to SHOTS_DIR (default ./shots). The data is set up through the service, as a member would have made it.
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { api, goTo, openView, reset, scrollToVerse, view } from './helpers';

const DIR = process.env.SHOTS_DIR || path.join(process.cwd(), 'shots');
fs.mkdirSync(DIR, { recursive: true });
const NAMES = { light: 'light', dusk: 'zen', dark: 'dark' } as const;

async function seed(page: Page): Promise<void> {
  await reset(page);
  await api(page, 'bible.mark.put', { mark: { kind: 'bookmark', book: 'JHN', chapter: 3, verse: 1, translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'JHN', chapter: 3, verse: 3, color: 'amber', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'note', book: 'JHN', chapter: 3, verse: 8, text: 'Ask the group about verse 8.\nRead verses 5 to 8 aloud first.', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'PSA', chapter: 23, verse: 1, color: 'green', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'note', book: 'PSA', chapter: 23, verse: 4, text: 'Memorize this one.', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'ROM', chapter: 8, verse: 28, color: 'rose', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'bookmark', book: 'GEN', chapter: 1, verse: 1, translation: 'bsb' } }, true);
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(DIR, `${name}.png`) });

for (const theme of ['light', 'dusk', 'dark'] as const) {
  const t = NAMES[theme];
  test(`shots, ${t}`, async ({ page }) => {
    await seed(page);
    const v = await openView(page, `theme=${theme}`);
    await goTo(page, 'John 3');
    await page.waitForTimeout(300);
    await shot(page, `${t}-01-reading-john3`);
    await v.locator('.v[data-v="5"] .vt').first().click();
    await expect(v.locator('.abar')).toBeVisible();
    await shot(page, `${t}-02-verse-selected-bar`);
    await page.keyboard.press('Escape');
    await v.getByRole('button', { name: 'Note, John 3:8' }).click();
    await expect(v.getByRole('textbox', { name: 'Note' })).toBeFocused();
    await shot(page, `${t}-03-highlight-and-note`);
    await page.keyboard.press('Escape');
    await v.locator('#refBtn').click();
    await shot(page, `${t}-04-goto`);
    await v.getByRole('button', { name: 'John', exact: true }).click();
    await shot(page, `${t}-05-goto-chapters`);
    await page.keyboard.press('Escape');
    await v.locator('#trBtn').click();
    await shot(page, `${t}-06-translation-menu`);
    await v.getByRole('button', { name: 'About World English Bible' }).click();
    await expect(v.getByRole('dialog', { name: 'World English Bible' })).toBeVisible();
    await shot(page, `${t}-07-about-web`);
    await page.keyboard.press('Escape');
    await v.getByRole('button', { name: 'Saved' }).click();
    await expect(v.locator('.rpanel .hit').first()).toBeVisible();
    await shot(page, `${t}-08-saved`);
    await page.keyboard.press('Escape');
    await v.getByRole('button', { name: 'Search' }).click();
    await v.getByRole('searchbox').fill('born again');
    await expect(v.locator('.rpanel .hit').first()).toBeVisible();
    await shot(page, `${t}-09-search`);
    await page.keyboard.press('Escape');
    await v.getByRole('button', { name: 'Text' }).click();
    await shot(page, `${t}-10-text`);
    await page.keyboard.press('Escape');
    await goTo(page, 'Psalm 23');
    await page.waitForTimeout(1300);
    await shot(page, `${t}-11-psalm23`);
    await v.getByRole('button', { name: 'Footnote b' }).click();
    await shot(page, `${t}-12-footnote`);
    await page.keyboard.press('Escape');
    await goTo(page, 'John 3');
    await page.waitForTimeout(1300);
    await scrollToVerse(page, 27);
    await shot(page, `${t}-13-chapter-end`);
  });

  test(`phone shots, ${t}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seed(page);
    const v = await openView(page, `theme=${theme}&phone=1`);
    await goTo(page, 'John 3');
    await page.waitForTimeout(300);
    await shot(page, `${t}-phone-1-reading`);
    await v.locator('#refBtn').click();
    await shot(page, `${t}-phone-2-goto`);
    await page.keyboard.press('Escape');
    await v.locator('.v[data-v="5"] .vt').first().click();
    await shot(page, `${t}-phone-3-bar`);
    await page.keyboard.press('Escape');
    await goTo(page, 'Psalm 23');
    await page.waitForTimeout(1300);
    await shot(page, `${t}-phone-4-psalm23`);
    void view;
  });
}
