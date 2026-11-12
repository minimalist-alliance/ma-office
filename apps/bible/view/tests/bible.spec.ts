// The Bible view (S-150) in its sandboxed frame, played by the harness against the real bible-app and texts.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, axe, calls, frame, goTo, openView, reset, scrollToVerse, topVerse, view } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(fs.readFileSync(path.join(here, '../dev/tokens.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await reset(page);
});

test('first open reads Genesis 1 in the BSB, with headings, verse numbers and footnote letters', async ({ page }) => {
  const v = await openView(page);
  await expect(v.locator('#chHead')).toHaveText('Genesis 1');
  await expect(v.locator('#refBtn')).toHaveAccessibleName('Go to, Genesis 1');
  await expect(v.locator('#trBtn')).toHaveAccessibleName('Translation, BSB');
  await expect(v.locator('h2.sec').first()).toHaveText('The Creation');
  await expect(v.locator('.v[data-v="1"] .vt')).toHaveText('In the beginning God created the heavens and the earth.');
  await expect(v.locator('.v[data-v="1"] .vn')).toHaveText('1');
  await expect(v.locator('.fn').first()).toHaveText('a');
  await expect(v.getByRole('navigation', { name: 'Chapters' }).getByRole('button')).toHaveText(['Genesis 2']);
  // A verse number never ends a line apart from its words.
  const apart = await frame(page).evaluate(() => [...document.querySelectorAll('.vn')].filter((vn) => {
    const n = vn.getClientRects();
    const w = vn.parentElement!.querySelector('.vt')!.getClientRects();
    return n.length && w.length && Math.abs(n[n.length - 1].bottom - w[0].bottom) > 12;
  }).length);
  expect(apart).toBe(0);
});

test('switching to KJV and back keeps the chapter and the verse at the top', async ({ page }) => {
  const v = await openView(page);
  await goTo(page, 'John 3');
  await scrollToVerse(page, 16);
  expect(await topVerse(page)).toBe(16);
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: /^King James Version/ }).click();
  await expect(v.locator('#trBtn')).toHaveAccessibleName('Translation, KJV');
  await expect(v.locator('#chHead')).toHaveText('John 3');
  await expect(v.locator('.v[data-v="16"] .vt')).toContainText('For God so loved the world, that he gave his only begotten Son');
  expect(await topVerse(page)).toBe(16);
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: /^Berean Standard Bible/ }).click();
  await expect(v.locator('.v[data-v="16"] .vt')).toContainText('For God so loved the world that He gave His one and');
  expect(await topVerse(page)).toBe(16);
});

test('Go to by the grid reaches Psalm 23, with its poetry indented', async ({ page }) => {
  const v = await openView(page);
  await v.locator('#refBtn').click();
  await expect(v.getByRole('textbox', { name: 'Go to' })).toBeFocused();
  await expect(v.getByRole('textbox', { name: 'Go to' })).toHaveAttribute('placeholder', 'Type a reference, like John 3:16');
  await expect(v.getByRole('button', { name: 'Genesis', exact: true })).toHaveAttribute('aria-current', 'true');
  await v.getByRole('button', { name: 'Psalms', exact: true }).click();
  await expect(v.getByRole('button', { name: 'Psalm 150' })).toBeVisible();
  await v.getByRole('button', { name: 'Psalm 23', exact: true }).click();
  await expect(v.locator('#chHead')).toHaveText('Psalm 23');
  // Each level starts 1.5em further in; every wrap hangs 1.5em past the deepest level (3em in Psalm 23).
  const lines = await frame(page).evaluate(() => ['.ql.l1', '.ql.l2'].map((s) => {
    const cs = getComputedStyle(document.querySelector(s)!);
    return { start: parseFloat(cs.paddingLeft) + parseFloat(cs.textIndent), wrap: parseFloat(cs.paddingLeft), em: parseFloat(cs.fontSize) };
  }));
  expect(lines[0].start).toBe(0);
  expect(lines[1].start).toBeCloseTo(1.5 * lines[1].em, 1);
  expect(lines[0].wrap).toBeCloseTo(3 * lines[0].em, 1);
  expect(lines[1].wrap).toBeCloseTo(3 * lines[1].em, 1);
  await expect(v.locator('.ql.l2').first()).toContainText('I shall not want.');
  // The number comes after the Psalm's title, before its words.
  await expect(v.locator('.ttl')).toHaveText('A Psalm of David.');
  await expect(v.locator('.ttl .vn')).toHaveCount(0);
});

test('Go to by typing reads the reference on the desk and flashes the verse', async ({ page }) => {
  const v = await openView(page);
  await goTo(page, 'jn 3:16');
  await expect(v.locator('#chHead')).toHaveText('John 3');
  expect((await calls(page)).some((c) => c.m === 'bible.lookup' && c.p.q === 'jn 3:16')).toBe(true);
  await expect(v.locator('.v.flash[data-v="16"]')).toHaveCount(1);
  await v.locator('#refBtn').click();
  await v.getByRole('textbox', { name: 'Go to' }).fill('nowhere 9');
  await v.getByRole('textbox', { name: 'Go to' }).press('Enter');
  await expect(v.getByRole('alert')).toHaveText('No book or chapter by that name.');
});

test('search finds "love" in the BSB, then in all four', async ({ page }) => {
  const v = await openView(page);
  await v.getByRole('button', { name: 'Search' }).click();
  const box = v.getByRole('searchbox', { name: 'Search' });
  await expect(box).toBeFocused();
  await box.fill('love');
  await expect(v.locator('.count')).toContainText(/^\d+ verses in BSB/);
  await expect(v.locator('.hit').first().locator('b').first()).toHaveText(/^love$/i);
  await expect(v.locator('h3.grp').first()).toContainText('Genesis');
  // Only "nothing found" offers all four (the Designer's fix 9): a word the BSB doesn't use.
  await expect(v.getByRole('button', { name: 'Search all four translations' })).toHaveCount(0);
  await box.fill('lovingkindness');
  await expect(v.locator('.empty')).toContainText('No verses in BSB with those words.');
  await v.getByRole('button', { name: 'Search all four translations' }).click();
  await expect(v.locator('.count')).toContainText(/^\d+ verses in all four translations/);
  await expect(v.locator('.hit .tag').filter({ hasText: 'KJV' }).first()).toBeVisible();
  expect((await calls(page)).filter((c) => c.m === 'bible.search').map((c) => c.p.translation)).toEqual(expect.arrayContaining(['bsb', 'all']));
  // A book with more than 20 shows them all on request.
  const more = v.getByRole('button', { name: /^Show all \d+$/ }).first();
  const n = Number((await more.textContent())!.replace(/\D/g, ''));
  await more.click();
  await expect(v.locator('.hit')).not.toHaveCount(0);
  expect(n).toBeGreaterThan(20);
  // The panel scrolls inside itself, never the window.
  expect(await frame(page).evaluate(() => [document.scrollingElement!.scrollTop, document.querySelector('.rpanel .pbody')!.scrollTop > 0])).toEqual([0, true]);
  // The words that are also a reference offer Go to; a new query searches the BSB again.
  await box.fill('jn 3:16');
  await v.getByRole('button', { name: 'Go to John 3:16' }).click();
  await expect(v.locator('#chHead')).toHaveText('John 3');
  // Nothing found.
  await page.keyboard.press('/');
  await box.fill('zzzzqx');
  await expect(v.locator('.empty')).toContainText('No verses in BSB with those words.');
  await expect(v.locator('.empty').getByRole('button', { name: 'Search all four translations' })).toBeVisible();
});

// The accessibility pass of Nov 11 (docs/sub-status/lsub-a11y-desk.md): the count is said through one status region that is
// always in the page, since one put in with the results is often not read (WCAG 4.1.3).
test('search says its count through one status region that stays, new counts and nothing found alike', async ({ page }) => {
  const v = await openView(page);
  const said = v.locator('#said');
  await expect(said).toHaveAttribute('role', 'status');
  await expect(said).toHaveText('');
  await v.getByRole('button', { name: 'Search' }).click();
  const box = v.getByRole('searchbox', { name: 'Search' });
  await box.fill('born again');
  await expect(v.locator('.count')).toContainText(/^\d+ verses in BSB/);
  const first = (await v.locator('.count').textContent())!.trim();
  await expect(said).toHaveText(first);
  await frame(page).evaluate(() => ((document.getElementById('said') as HTMLElement & { kept?: boolean }).kept = true));
  await box.fill('zzzzqx');
  await expect(said).toHaveText('No verses in BSB with those words.');
  await box.fill('love');
  await expect(said).toHaveText(/^\d+ verses in BSB$/);
  expect(await frame(page).evaluate(() => (document.getElementById('said') as HTMLElement & { kept?: boolean }).kept)).toBe(true);
  // The results themselves carry no live region of their own, so nothing is said twice.
  await expect(v.locator('.rpanel [role=status]')).toHaveCount(0);
});

test('a highlight, a bookmark and a note belong to the verse: they show in another translation and in Saved', async ({ page }) => {
  const v = await openView(page);
  await goTo(page, 'John 3:16');
  await v.locator('.v[data-v="16"] .vt').first().click();
  const bar = v.getByRole('group', { name: 'Verse' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
  await expect(bar.getByRole('radio')).toHaveText(['', '', '', '', 'None']);
  expect(await bar.getByRole('radio').evaluateAll((rs) => rs.map((r) => r.getAttribute('aria-label') || r.textContent))).toEqual(['Amber', 'Blue', 'Green', 'Rose', 'None']);
  await bar.getByRole('radio', { name: 'Blue' }).hover();
  await expect(v.locator('.v[data-v="16"] .vt.pv-blue')).toHaveCount(1);
  await bar.getByRole('radio', { name: 'Amber' }).click();
  await expect(v.locator('.v[data-v="16"] .vt.hl-amber')).toHaveCount(1);
  await expect(bar.getByRole('radio', { name: 'Amber' })).toHaveAttribute('aria-checked', 'true');
  await bar.getByRole('button', { name: 'Bookmark' }).click();
  await expect(bar.getByRole('button', { name: 'Bookmark' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Note', exact: true }).click();
  const note = v.getByRole('textbox', { name: 'Note' });
  await expect(note).toBeFocused();
  await expect(v.locator('.rpanel .pht')).toHaveText('John 3:16, BSB');
  await note.fill('Loved, and sent.');
  await expect.poll(async () => (await calls(page)).filter((c) => c.m === 'bible.mark.put' && c.p.mark.kind === 'note').length).toBe(1);
  await note.press('Escape');
  const marks = (await api(page, 'bible.marks.chapter', { book: 'JHN', chapter: 3 })).marks;
  expect(marks.map((m: any) => `${m.kind}:${m.verse}:${m.color ?? m.text ?? ''}`).sort()).toEqual(['bookmark:16:', 'highlight:16:amber', 'note:16:Loved, and sent.']);
  expect((await api(page, 'bible.prefs.get')).highlightColor).toBe('amber');
  // Every mutation carried its own key, the bridge's way.
  for (const c of (await calls(page)).filter((x) => x.m === 'bible.mark.put' || x.m === 'bible.mark.remove')) expect(c.idem).toMatch(/^[0-9a-f-]{36}$/);

  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: /^World English Bible/ }).click();
  await expect(v.locator('#trBtn')).toHaveAccessibleName('Translation, WEB');
  await expect(v.locator('.v[data-v="16"] .vt.hl-amber')).toHaveCount(1);
  await expect(v.getByRole('button', { name: 'Bookmark, John 3:16' })).toBeVisible();
  await expect(v.getByRole('button', { name: 'Note, John 3:16' })).toBeVisible();

  await v.getByRole('button', { name: 'Saved' }).click();
  const list = v.locator('.rpanel .list');
  await expect(list.locator('.hit')).toHaveCount(3);
  await expect(list.locator('h3.grp')).toHaveText(['John']);
  await expect(list.locator('.hit').filter({ hasText: 'Loved, and sent.' })).toHaveCount(1);
  await expect(list.locator('.ind.dot[data-c="amber"]')).toHaveCount(1);
  await expect(list.locator('.sline').first()).toContainText('For God so loved the world, that he gave his only born Son');
  await v.locator('.rpanel').getByRole('button', { name: 'Notes' }).click();
  await expect(list.locator('.hit')).toHaveCount(1);
  await list.locator('.hit').click();
  await expect(v.locator('.rpanel')).toBeHidden();
  await expect(v.locator('#chHead')).toHaveText('John 3');
});

for (const theme of ['dusk', 'dark'] as const) {
  test(`in ${theme}, a footnote letter inside a highlight is drawn in text.primary`, async ({ page }) => {
    await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'JHN', chapter: 3, verse: 3, color: 'amber' } }, true);
    await openView(page, `theme=${theme}`);
    await goTo(page, 'John 3');
    const [inside, outside] = await frame(page).evaluate(() => [
      getComputedStyle(document.querySelector('.v[data-v="3"] .vt.hl .fn')!).color,
      getComputedStyle(document.querySelector('.v[data-v="7"] .fn')!).color,
    ]);
    const hex = tokens[theme]['text.primary'] as string;
    expect(inside).toBe(`rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`);
    expect(outside).not.toBe(inside);
  });
}

// The accessibility pass's pick (2), the Designer's: a footnote letter inside a highlight takes text.primary for its focus
// ring too, the letter's own rule, since focus.ring is under 3:1 on Zen's and Dark's highlights.
for (const theme of ['light', 'dusk', 'dark'] as const) {
  test(`in ${theme}, a footnote's focus ring inside a highlight is text.primary, 3:1 or more on each of the four colors`, async ({ page }) => {
    await openView(page, `theme=${theme}`);
    await goTo(page, 'John 3');
    const verses: string[] = await frame(page).evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#col .v')].filter((v) => v.querySelector('.fn')).map((v) => v.dataset['v']!).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4),
    );
    expect(verses).toHaveLength(4);
    const colors = ['amber', 'green', 'blue', 'rose'];
    for (const [i, verse] of verses.entries()) await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'JHN', chapter: 3, verse: Number(verse), color: colors[i] } }, true);
    await openView(page, `theme=${theme}`);
    await goTo(page, 'John 3');
    const hex = tokens[theme]['text.primary'] as string;
    const tp = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    for (const [i, verse] of verses.entries()) {
      // A key first, so focus from here on is the keyboard's and draws its ring.
      await page.keyboard.press('Shift');
      const look = await frame(page).evaluate((v) => {
        const fn = document.querySelector<HTMLElement>(`.v[data-v="${v}"] .vt.hl .fn`)!;
        fn.focus();
        const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((x) => x / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const cs = getComputedStyle(fn);
        const ground = getComputedStyle(fn.closest('.vt.hl')!).backgroundColor;
        const [a, b] = [lum(rgb(cs.outlineColor)), lum(rgb(ground))].sort((x, y) => y - x);
        return { visible: fn.matches(':focus-visible'), style: cs.outlineStyle, color: cs.outlineColor, ratio: (a! + 0.05) / (b! + 0.05) };
      }, verse);
      expect(look.visible, colors[i]).toBe(true);
      expect(look.style, colors[i]).toBe('solid');
      expect(look.color, colors[i]).toBe(tp);
      expect(look.ratio, `${colors[i]}: ${look.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
    // Outside a highlight it keeps focus.ring.
    await page.keyboard.press('Shift');
    const plain = await frame(page).evaluate(() => {
      const fn = [...document.querySelectorAll<HTMLElement>('#col .fn')].find((f) => !f.closest('.vt.hl'))!;
      fn.focus();
      return getComputedStyle(fn).outlineColor;
    });
    expect(plain).not.toBe(tp);
  });
}

test('a Psalm\'s title stays plain when verse 1 is highlighted', async ({ page }) => {
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'PSA', chapter: 23, verse: 1, color: 'green' } }, true);
  const v = await openView(page);
  await goTo(page, 'Psalm 23');
  await expect(v.locator('.v[data-v="1"]:not(.ttlp) .vt.hl-green')).toHaveCount(2);
  expect(await frame(page).evaluate(() => getComputedStyle(document.querySelector('.ttlp .vt')!).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

test('deleting a note asks nothing, and Undo puts it back', async ({ page }) => {
  await api(page, 'bible.mark.put', { mark: { kind: 'note', book: 'JHN', chapter: 3, verse: 8, text: 'Ask the group about verse 8.', translation: 'bsb' } }, true);
  const v = await openView(page);
  await goTo(page, 'John 3');
  await v.getByRole('button', { name: 'Note, John 3:8' }).click();
  await expect(v.getByRole('textbox', { name: 'Note' })).toHaveValue('Ask the group about verse 8.');
  expect(await frame(page).evaluate(() => getComputedStyle(document.querySelector('.note .ta')!).resize)).toBe('none');
  await v.getByRole('button', { name: 'Delete note' }).click();
  await expect(v.locator('#toast')).toContainText('Note deleted');
  await expect(v.getByRole('button', { name: 'Note, John 3:8' })).toHaveCount(0);
  expect((await api(page, 'bible.marks.chapter', { book: 'JHN', chapter: 3 })).marks).toHaveLength(0);
  await v.locator('#toast').getByRole('button', { name: 'Undo' }).click();
  await expect(v.getByRole('button', { name: 'Note, John 3:8' })).toBeVisible();
  const back = (await api(page, 'bible.marks.chapter', { book: 'JHN', chapter: 3 })).marks;
  expect(back.map((m: any) => [m.kind, m.verse, m.text])).toEqual([['note', 8, 'Ask the group about verse 8.']]);
});

test('Text: five sizes, one verse per line, and footnotes on and off', async ({ page }) => {
  const v = await openView(page);
  await goTo(page, 'John 3');
  await v.getByRole('button', { name: 'Text' }).click();
  const sizes = v.getByRole('radiogroup', { name: 'Size' }).getByRole('radio');
  await expect(sizes).toHaveCount(5);
  await expect(v.getByRole('radio', { name: 'Size 18' })).toHaveAttribute('aria-checked', 'true');
  for (const n of [16, 18, 20, 22, 24]) {
    await v.getByRole('radio', { name: `Size ${n}` }).click();
    await expect.poll(() => frame(page).evaluate(() => getComputedStyle(document.getElementById('col')!).fontSize)).toBe(`${n}px`);
  }
  await expect.poll(async () => (await api(page, 'bible.prefs.get')).textSize).toBe(24);
  await v.getByRole('switch', { name: 'One verse per line' }).click();
  await expect(v.getByRole('switch', { name: 'One verse per line' })).toHaveAttribute('aria-checked', 'true');
  const shared = await frame(page).evaluate(() => [...document.querySelectorAll('#col p.pr')].filter((p) => new Set([...p.querySelectorAll('.v')].map((x) => (x as HTMLElement).dataset.v)).size > 1).length);
  expect(shared).toBe(0);
  await expect(v.locator('.fn').first()).toBeVisible();
  await v.getByRole('switch', { name: 'Footnotes' }).click();
  await expect(v.locator('.fn')).toHaveCount(0);
  await expect.poll(async () => api(page, 'bible.prefs.get')).toMatchObject({ textSize: 24, oneVersePerLine: true, footnotes: false });
});

test('a footnote opens in a popover; Esc closes it', async ({ page }) => {
  const v = await openView(page);
  await goTo(page, 'John 3');
  await v.getByRole('button', { name: 'Footnote a' }).click();
  await expect(v.getByRole('dialog', { name: 'Footnote a' })).toContainText('Or born from above; also in verse 7.');
  await page.keyboard.press('Escape');
  await expect(v.getByRole('dialog', { name: 'Footnote a' })).toHaveCount(0);
  await v.getByRole('button', { name: 'Footnote b' }).focus();
  await page.keyboard.press('Enter');
  await expect(v.getByRole('dialog', { name: 'Footnote b' })).toBeVisible();
});

test('keys: ← → change chapter, / opens Search, g opens Go to, Esc closes, and the verses rove', async ({ page }) => {
  const v = await openView(page);
  await v.locator('#scroll').focus();
  await page.keyboard.press('ArrowRight');
  await expect(v.locator('#chHead')).toHaveText('Genesis 2');
  await page.keyboard.press('ArrowLeft');
  await expect(v.locator('#chHead')).toHaveText('Genesis 1');
  await page.keyboard.press('/');
  await expect(v.getByRole('searchbox', { name: 'Search' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(v.locator('.rpanel')).toBeHidden();
  await page.keyboard.press('g');
  await expect(v.getByRole('textbox', { name: 'Go to' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(v.locator('.goto')).toHaveCount(0);
  // One tab stop for the column, then ↑ ↓; Enter selects and moves into the bar; Esc clears and comes back.
  await v.getByRole('button', { name: 'Verse 1', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(v.getByRole('button', { name: 'Verse 2', exact: true })).toBeFocused();
  expect(await frame(page).evaluate(() => document.querySelectorAll('.vn[tabindex="0"]').length)).toBe(1);
  await page.keyboard.press('Enter');
  await expect(v.getByRole('radio', { name: 'None' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(v.getByRole('radio', { name: 'Rose' })).toBeFocused();
  await expect(v.locator('.v.sel .vt.pv-rose')).toHaveCount(1);
  await expect(v.locator('.v.sel')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(v.locator('.v.sel')).toHaveCount(0);
  await expect(v.getByRole('button', { name: 'Verse 2', exact: true })).toBeFocused();
});

test('a reload opens where the member left off', async ({ page }) => {
  const v = await openView(page);
  await goTo(page, 'Romans 8');
  await scrollToVerse(page, 28);
  await expect.poll(async () => (await api(page, 'bible.prefs.get')).place).toEqual({ translation: 'bsb', book: 'ROM', chapter: 8, verse: 28 });
  await page.reload();
  await expect(v.locator('#chHead')).toHaveText('Romans 8');
  await expect.poll(() => topVerse(page)).toBe(28);
});

test('copy writes the verses and the reference to the clipboard inside the tap, and says Copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const v = await openView(page);
  await goTo(page, 'John 3');
  await v.locator('.v[data-v="16"] .vt').first().click();
  await v.locator('.v[data-v="17"] .vt').first().click({ modifiers: ['Shift'] });
  await v.getByRole('button', { name: 'Copy' }).click();
  await expect(v.locator('.abar')).toContainText('Copied');
  await expect(v.locator('.copybox')).toHaveCount(0);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toMatch(/^For God so loved the world .* through Him\.\nJohn 3:16–17 \(BSB\)$/s);
});

test('where the clipboard is refused, copy puts the words in a selected box for the member\'s own Ctrl+C', async ({ page }) => {
  const v = await openView(page, 'theme=light&clip=0');
  await goTo(page, 'John 3');
  await v.locator('.v[data-v="16"] .vt').first().click();
  await v.getByRole('button', { name: 'Copy' }).click();
  const box = v.getByRole('textbox', { name: 'Verses to copy' });
  await expect(box).toBeFocused();
  expect(await box.inputValue()).toMatch(/^For God so loved the world .*\nJohn 3:16 \(BSB\)$/s);
  expect(await frame(page).evaluate(() => {
    const t = document.activeElement as HTMLTextAreaElement;
    return t.selectionStart === 0 && t.selectionEnd === t.value.length;
  })).toBe(true);
  await expect(v.locator('.copybox')).toContainText('Press Ctrl+C to copy.');
  await page.keyboard.press('Control+C');
  await expect(v.locator('.abar')).toContainText('Copied');
  await expect(v.locator('.copybox')).toHaveCount(0);
});

test('About shows the publisher\'s notice as plain text and the source as words with its address', async ({ page }) => {
  const v = await openView(page);
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: 'About King James Version' }).click();
  const about = v.getByRole('dialog', { name: 'King James Version' });
  await expect(about).toBeVisible();
  const notice = (await api(page, 'bible.about', { translation: 'kjv' })).statement as string;
  expect(notice).toContain('https://en.wikipedia.org/');
  await expect(about.locator('.stmt')).toHaveText(notice);
  await expect(about.locator('.credit')).toHaveText('King James Version (KJV), the 1769 text. Public domain in the United States.');
  await expect(about.locator('.srcwords')).toHaveText('eBible.org’s page for the King James Version');
  await expect(about.locator('.srcaddr')).toHaveText('https://ebible.org/find/details.php?id=eng-kjv2006');
  await expect(about.locator('a, details, summary, input')).toHaveCount(0);
  await expect(about).not.toContainText('SHA-256');
  await expect(about).not.toContainText('====');
});

test('a translation that can\'t be read says so and offers the other three', async ({ page }) => {
  await reset(page, '?broken=kjv');
  const v = await openView(page);
  await v.locator('#trBtn').click();
  await v.getByRole('button', { name: /^King James Version/ }).click();
  await expect(v.locator('.state')).toContainText('This translation couldn’t be opened. The others still work.');
  await expect(v.locator('.state').getByRole('button')).toHaveText(['Berean Standard Bible', 'World English Bible', 'American Standard Version']);
  await v.locator('.state').getByRole('button', { name: 'World English Bible' }).click();
  await expect(v.locator('#chHead')).toHaveText('Genesis 1');
  await expect(v.locator('#trBtn')).toHaveAccessibleName('Translation, WEB');
});

test('while the app is starting the view waits quietly, then reads', async ({ page }) => {
  await reset(page, '?starting=3');
  const v = await openView(page);
  await expect(v.locator('#chHead')).toHaveText('Genesis 1');
  expect((await calls(page)).filter((c) => c.m === 'bible.state').length).toBe(4);
});

test('a phone at 390 px: More holds Saved and Text, Go to is a full sheet, the bar is a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const v = await openView(page, 'theme=light&phone=1');
  await expect(v.getByRole('button', { name: 'Saved' })).toBeHidden();
  await expect(v.getByRole('button', { name: 'More' })).toBeVisible();
  for (const b of await v.locator('.tbar button:visible').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // The toolbar's first label starts with the text, 24 px in.
  expect(await frame(page).evaluate(() => [document.getElementById('refLabel')!, document.querySelector('#col .ch-head')!].map((e) => Math.round(e.getBoundingClientRect().left)))).toEqual([24, 24]);
  await v.locator('#refBtn').click();
  const sheet = v.locator('.goto.sheet');
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  const fr = (await page.locator('#frame').boundingBox())!;
  expect(Math.round(box.width)).toBe(Math.round(fr.width));
  await expect(v.locator('.bk .short').filter({ hasText: /^Gen$/ })).toBeVisible();
  for (const b of await v.locator('.bk').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // One 16 px inset: the title, the field and the labels start together.
  const xs = await frame(page).evaluate(() => [
    document.querySelector('.goto .pht')!.getBoundingClientRect().left,
    document.querySelector('.goto .field')!.getBoundingClientRect().left,
    document.querySelector('.goto .gl')!.getBoundingClientRect().left,
  ].map(Math.round));
  expect(xs).toEqual([16, 16, 16]);
  await v.getByRole('button', { name: 'John', exact: true }).click();
  await v.getByRole('button', { name: 'John 3', exact: true }).click();
  // A verse low on the screen: the sheet opens and the column scrolls it clear, 16 px above the sheet at least.
  const low = await frame(page).evaluate(() => {
    const parts = [...document.querySelectorAll<HTMLElement>('#col .v')];
    const fold = innerHeight - 120;
    return Number(parts.find((p) => p.getClientRects()[0] && p.getClientRects()[0].top > fold && p.getClientRects()[0].top < innerHeight)!.dataset.v);
  });
  await v.locator(`.v[data-v="${low}"] .vt`).first().click();
  const bar = v.locator('.abar.sheet');
  await expect(bar).toBeVisible();
  const bb = (await bar.boundingBox())!;
  expect(Math.round(bb.y + bb.height)).toBe(Math.round(fr.y + fr.height));
  await expect(bar.locator('.bsref')).toHaveText(`John 3:${low}`);
  await expect.poll(() => frame(page).evaluate((n) => {
    const sheet = document.querySelector('.abar.sheet')!.getBoundingClientRect().top;
    const bottom = Math.max(...[...document.querySelectorAll(`#col .v[data-v="${n}"]`)].flatMap((p) => [...p.getClientRects()].map((r) => r.bottom)));
    return sheet - bottom;
  }, low)).toBeGreaterThanOrEqual(16);
  for (const b of await bar.locator('[role="radio"], .abtn').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(v.locator('.vt[class*="pv-"]')).toHaveCount(0); // the sheet came up under the pointer: no preview
  await page.keyboard.press('Escape');
  await v.getByRole('button', { name: 'More' }).click();
  await v.getByRole('menuitem', { name: 'Saved' }).click();
  await expect(v.locator('.rpanel')).toBeVisible();
  expect(Math.round((await v.locator('.rpanel').boundingBox())!.width)).toBe(Math.round(fr.width));
  await expect(v.locator('.rpanel')).toContainText('Nothing saved yet. Select a verse to highlight, bookmark or add a note.');
  for (const b of await v.locator('.rpanel .seg button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

for (const theme of ['light', 'dusk', 'dark'] as const) {
  test(`the ${theme} tokens reach the view, and a switch follows`, async ({ page }) => {
    const v = await openView(page, `theme=${theme}`);
    const f = frame(page);
    await expect(v.locator('html')).toHaveAttribute('data-theme', theme);
    const bg = await f.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const hex = tokens[theme]['surface.window'] as string;
    const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    expect(bg).toBe(rgb);
    const next = theme === 'dark' ? 'light' : 'dark';
    await page.evaluate((t) => (window as any).__harness.setTheme(t), next);
    await expect(v.locator('html')).toHaveAttribute('data-theme', next);
    expect(await f.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(rgb);
  });
}

test('axe finds nothing in reading, Go to, the translation menu and About, the bar, Saved, Search and Text', async ({ page }) => {
  await api(page, 'bible.mark.put', { mark: { kind: 'note', book: 'JHN', chapter: 3, verse: 8, text: 'A note.', translation: 'bsb' } }, true);
  await api(page, 'bible.mark.put', { mark: { kind: 'highlight', book: 'JHN', chapter: 3, verse: 3, color: 'amber' } }, true);
  for (const theme of ['light', 'dusk', 'dark']) {
    const v = await openView(page, `theme=${theme}`);
    await goTo(page, 'John 3');
    const found: unknown[] = [];
    found.push(...await axe(page));
    await v.locator('#refBtn').click();
    found.push(...await axe(page));
    await page.keyboard.press('Escape');
    await v.locator('#trBtn').click();
    found.push(...await axe(page));
    await v.getByRole('button', { name: 'About Berean Standard Bible' }).click();
    await expect(v.getByRole('dialog', { name: 'Berean Standard Bible' })).toBeVisible();
    found.push(...await axe(page));
    await page.keyboard.press('Escape');
    await v.locator('.v[data-v="5"] .vt').first().click();
    found.push(...await axe(page));
    await v.getByRole('button', { name: 'Saved' }).click();
    await expect(v.locator('.rpanel .hit').first()).toBeVisible();
    found.push(...await axe(page));
    await v.getByRole('button', { name: 'Search' }).click();
    await v.getByRole('searchbox').fill('born again');
    await expect(v.locator('.rpanel .hit').first()).toBeVisible();
    found.push(...await axe(page));
    await page.keyboard.press('Escape');
    await v.getByRole('button', { name: 'Text' }).click();
    found.push(...await axe(page));
    expect(found, theme).toEqual([]);
  }
});

test('the view is three files under 512 KiB, fetches nothing, and runs under the contract\'s policy', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.frame() !== page.mainFrame()) asked.push(r.url());
  });
  await openView(page);
  await goTo(page, 'Psalm 23');
  const sizes: number[] = await page.evaluate(() => (window as any).__harness.sizes);
  const onDisk = ['index.html', 'view.js', 'view.css'].map((f) => fs.statSync(path.join(here, '..', f)).size);
  expect(sizes).toEqual(onDisk);
  const total = onDisk.reduce((a, b) => a + b, 0);
  console.log(`view size: ${onDisk.join(' + ')} = ${total} bytes (${(total / 1024).toFixed(1)} KiB)`);
  expect(total).toBeLessThanOrEqual(512 * 1024);
  // Only the host's own boot script and the view's script as a blob: nothing else, ever.
  expect(asked.filter((u) => !u.endsWith('/boot.js') && !u.startsWith('blob:'))).toEqual([]);
  const csp = await frame(page).evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content'));
  expect(csp).toContain("default-src 'none'");
  expect(await page.evaluate(() => (window as any).__harness.loads)).toBe(1);
  const src = fs.readFileSync(path.join(here, '../view.js'), 'utf8');
  for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB', 'eval(', 'new Function', 'innerHTML']) {
    expect(src.includes(word), word).toBe(false);
  }
  for (const f of ['index.html', 'view.js', 'view.css']) expect(fs.readFileSync(path.join(here, '..', f), 'utf8').toLowerCase()).not.toContain('offline');
});
