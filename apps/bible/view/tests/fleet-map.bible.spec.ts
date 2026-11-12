// The AI tester fleet's keys for the Bible (`bible.*` in the office's map, ma-desk `web/public/fleet-map.json`; the
// toolkit's bible_* tools read them, ma-platform ADR 0134 addendum): each resolves on the real view against the real
// bible-app, in the state it names, as the tools find it inside the view's frame. A key resolves when its selector has
// a visible match: exactly one, or at least one for a list key. `bible.frame` is the office's (its window's frame) and is
// checked in the office's `web/tests/e2e/fleet-map.shell.spec.ts`; the rest can't be there, since the office's harness
// serves a stand-in view. A change to an element a key names updates the map in the same commit.
import { readFileSync } from 'node:fs';
import { expect, test, type FrameLocator, type Locator } from '@playwright/test';
import { openView, reset, view } from './helpers';

const MAP = JSON.parse(readFileSync(new URL('../../../../web/public/fleet-map.json', import.meta.url), 'utf8')) as { els: Record<string, { sel: string }> };
const sel = (key: string): string => {
  const e = MAP.els[key];
  if (!e) throw new Error(`the map has no ${key}`);
  return e.sel;
};

interface Check { key: string; within?: string; list?: true }

async function resolves(v: FrameLocator, checks: Check[]): Promise<void> {
  for (const c of checks) {
    const scope: FrameLocator | Locator = c.within ? v.locator(sel(c.within)).filter({ visible: true }).first() : v;
    const all = scope.locator(sel(c.key)).filter({ visible: true });
    await expect(all.first(), `${c.key} shows`).toBeVisible();
    if (!c.list) await expect(all, `${c.key} is one element, not several`).toHaveCount(1);
  }
}

const CHECKED = [
  'bible.ready', 'bible.error', 'bible.column', 'bible.chapter', 'bible.ref', 'bible.goto', 'bible.goto.field', 'bible.goto.error', 'bible.translation',
  'bible.translations', 'bible.translation.pick', 'bible.search.open', 'bible.search.box', 'bible.search.results', 'bible.search.count',
  'bible.search.empty', 'bible.search.goref', 'bible.search.all', 'bible.search.hit', 'bible.search.hit.ref', 'bible.search.hit.text',
  'bible.verse', 'bible.verse.text', 'bible.versebar', 'bible.color',
];

async function search(v: FrameLocator, q: string): Promise<void> {
  const box = v.getByRole('searchbox', { name: 'Search' });
  if (!(await box.isVisible())) await v.locator('#searchBtn').click();
  await box.fill(q);
  await box.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await reset(page);
});

test('every Bible key but the office\'s frame is checked here', () => {
  const mine = Object.keys(MAP.els).filter((k) => k.startsWith('bible.') && k !== 'bible.frame').sort();
  expect(mine).toEqual([...CHECKED].sort());
});

test('reading, Go to, the translations, Search and a verse\'s bar: every key resolves', async ({ page }) => {
  const v = await openView(page);
  await resolves(v, [
    { key: 'bible.ready' }, { key: 'bible.column' }, { key: 'bible.chapter' }, { key: 'bible.ref' }, { key: 'bible.translation' },
    { key: 'bible.search.open' }, { key: 'bible.verse', list: true }, { key: 'bible.verse.text', within: 'bible.verse' },
  ]);

  await v.locator(sel('bible.ref')).click();
  await resolves(v, [{ key: 'bible.goto' }, { key: 'bible.goto.field', within: 'bible.goto' }]);
  await v.locator(sel('bible.goto.field')).fill('Hezekiah 4');
  await v.locator(sel('bible.goto.field')).press('Enter');
  await expect(v.locator(sel('bible.goto.error'))).toHaveText('No book or chapter by that name.');
  await resolves(v, [{ key: 'bible.goto.error' }]);
  await page.keyboard.press('Escape');
  await expect(v.locator(sel('bible.goto'))).toHaveCount(0);

  await v.locator(sel('bible.translation')).click();
  await resolves(v, [{ key: 'bible.translations' }, { key: 'bible.translation.pick', within: 'bible.translations', list: true }]);
  await expect(v.locator(sel('bible.translations')).locator(sel('bible.translation.pick'))).toHaveCount(4);
  await page.keyboard.press('Escape');

  await search(v, 'so loved the world');
  await expect(v.locator(sel('bible.search.count'))).toBeVisible();
  await resolves(v, [
    { key: 'bible.search.box' }, { key: 'bible.search.results' }, { key: 'bible.search.count' }, { key: 'bible.search.hit', list: true },
    { key: 'bible.search.hit.ref', within: 'bible.search.hit' }, { key: 'bible.search.hit.text', within: 'bible.search.hit' },
  ]);
  await search(v, 'zebra giraffe');
  await expect(v.locator(sel('bible.search.empty'))).toBeVisible();
  await resolves(v, [{ key: 'bible.search.empty' }, { key: 'bible.search.all' }]);
  await search(v, 'John 3:16');
  await resolves(v, [{ key: 'bible.search.goref' }]);
  await page.keyboard.press('Escape');

  await v.locator(sel('bible.verse')).filter({ visible: true }).first().locator(sel('bible.verse.text')).first().click();
  await resolves(v, [{ key: 'bible.versebar' }, { key: 'bible.color', within: 'bible.versebar', list: true }]);
  await expect(v.locator(sel('bible.versebar')).locator(sel('bible.color'))).toHaveCount(4);
});

test('the view that can\'t reach its app says so', async ({ page }) => {
  test.setTimeout(60_000);
  // More answers of "starting" than the view's seven tries.
  await reset(page, '?starting=20');
  await page.goto('/?theme=light');
  await expect(view(page).locator(sel('bible.error'))).toBeVisible({ timeout: 30_000 });
  await resolves(view(page), [{ key: 'bible.error' }]);
});
