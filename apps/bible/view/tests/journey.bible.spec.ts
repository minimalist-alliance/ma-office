// The Bible view (S-150) end to end: one reader's sitting, the way a member moves through it, where bible.spec.ts checks
// each part on its own. In by Search to a verse; a highlight and a note on it; on to the next chapter and back by the keys;
// another translation, where the marks are the verse's still; Go to and a bookmark elsewhere; Saved bringing both back and
// its Notes taking the reader to the verse; a reload opening in the same place and translation with every mark there; and the
// service holding exactly what the reader made. The harness plays the Desk app against the real bible-app and texts.
import { expect, test } from '@playwright/test';
import { api, calls, goTo, openView, reset, scrollToVerse, topVerse, view } from './helpers';

test.beforeEach(async ({ page }) => {
  await reset(page);
});

test('a reader\'s sitting: Search, marks, the keys, another translation, Saved, and a reload that keeps it all', async ({ page }) => {
  const v = await openView(page);
  await expect(v.locator('#chHead')).toHaveText('Genesis 1');

  // In by Search: the words, a hit, and the verse flashed where it opens.
  await page.keyboard.press('/');
  const box = v.getByRole('searchbox', { name: 'Search' });
  await expect(box).toBeFocused();
  await box.fill('so loved the world');
  await expect(v.locator('.count')).toContainText(/verses? in BSB/);
  await v.locator('.hit').filter({ has: v.locator('.sref', { hasText: 'John 3:16' }) }).first().click();
  await expect(v.locator('.rpanel')).toBeHidden();
  await expect(v.locator('#chHead')).toHaveText('John 3');
  await expect(v.locator('.v.flash[data-v="16"]')).toHaveCount(1);

  // A highlight and a note on it.
  await v.locator('.v[data-v="16"] .vt').first().click();
  const bar = v.getByRole('group', { name: 'Verse' });
  await bar.getByRole('radio', { name: 'Green' }).click();
  await expect(v.locator('.v[data-v="16"] .vt.hl-green')).toHaveCount(1);
  await bar.getByRole('button', { name: 'Note', exact: true }).click();
  const note = v.getByRole('textbox', { name: 'Note' });
  await expect(note).toBeFocused();
  await note.fill('Read this with the group on Sunday.');
  await expect.poll(async () => (await calls(page)).filter((c) => c.m === 'bible.mark.put' && c.p.mark.kind === 'note').length).toBe(1);
  await note.press('Escape');

  // On by the keys and back: the marks are drawn again on the way back.
  await v.locator('#scroll').focus();
  await page.keyboard.press('ArrowRight');
  await expect(v.locator('#chHead')).toHaveText('John 4');
  await expect(v.locator('.vt.hl-green')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(v.locator('#chHead')).toHaveText('John 3');
  await expect(v.locator('.v[data-v="16"] .vt.hl-green')).toHaveCount(1);
  await expect(v.getByRole('button', { name: 'Note, John 3:16' })).toBeVisible();

  // Another translation: the marks belong to the verse.
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: /^King James Version/ }).click();
  await expect(v.locator('#trBtn')).toHaveAccessibleName('Translation, KJV');
  await expect(v.locator('.v[data-v="16"] .vt')).toContainText('For God so loved the world, that he gave his only begotten Son');
  await expect(v.locator('.v[data-v="16"] .vt.hl-green')).toHaveCount(1);

  // Go to somewhere else, and a bookmark there.
  await goTo(page, 'Romans 8:28');
  await expect(v.locator('#chHead')).toHaveText('Romans 8');
  await v.locator('.v[data-v="28"] .vt').first().click();
  await v.getByRole('group', { name: 'Verse' }).getByRole('button', { name: 'Bookmark' }).click();
  await expect(v.getByRole('button', { name: 'Bookmark, Romans 8:28' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Saved has all three, by book in the Bible's order; its Notes take the reader back to the verse.
  await v.getByRole('button', { name: 'Saved' }).click();
  const list = v.locator('.rpanel .list');
  await expect(list.locator('.hit')).toHaveCount(3);
  await expect(list.locator('h3.grp')).toHaveText(['John', 'Romans']);
  await v.locator('.rpanel').getByRole('button', { name: 'Notes' }).click();
  await expect(list.locator('.hit')).toHaveCount(1);
  await expect(list.locator('.hit')).toContainText('Read this with the group on Sunday.');
  await list.locator('.hit').click();
  await expect(v.locator('.rpanel')).toBeHidden();
  await expect(v.locator('#chHead')).toHaveText('John 3');

  // Every change went with its own key, the bridge's way.
  const puts = (await calls(page)).filter((x) => x.m === 'bible.mark.put');
  expect(puts.length).toBeGreaterThanOrEqual(3);
  for (const c of puts) expect(c.idem).toMatch(/^[0-9a-f-]{36}$/);

  // A reload opens where the reader is, in the translation they chose, with every mark there.
  await expect.poll(async () => (await api(page, 'bible.prefs.get')).place).toMatchObject({ translation: 'kjv', book: 'JHN', chapter: 3 });
  const at = (await api(page, 'bible.prefs.get')).place.verse;
  await page.reload();
  await expect(view(page).locator('#app')).toHaveAttribute('data-state', 'ready');
  await expect(v.locator('#chHead')).toHaveText('John 3');
  await expect(v.locator('#trBtn')).toHaveAccessibleName('Translation, KJV');
  await expect.poll(() => topVerse(page)).toBe(at);
  await expect(v.locator('.v[data-v="16"] .vt.hl-green')).toHaveCount(1);
  await expect(v.getByRole('button', { name: 'Note, John 3:16' })).toBeVisible();
  await goTo(page, 'Romans 8');
  await scrollToVerse(page, 28);
  await expect(v.getByRole('button', { name: 'Bookmark, Romans 8:28' })).toBeVisible();

  // The service holds exactly what the reader made.
  const john = (await api(page, 'bible.marks.chapter', { book: 'JHN', chapter: 3 })).marks;
  expect(john.map((m: any) => `${m.kind}:${m.verse}:${m.color ?? m.text ?? ''}`).sort()).toEqual(['highlight:16:green', 'note:16:Read this with the group on Sunday.']);
  const romans = (await api(page, 'bible.marks.chapter', { book: 'ROM', chapter: 8 })).marks;
  expect(romans.map((m: any) => `${m.kind}:${m.verse}`)).toEqual(['bookmark:28']);
});
