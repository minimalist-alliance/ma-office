// The top bar's bell (ma-platform ADR 0125 §9, contract notifications.md 0.3.72; the panel as `packages/bell-kit`
// SPEC.md draws it): the count in the accent tint, capped at 9+; the list newest first in the kit's words; a click
// marks the item read and goes to it in this tab; "Mark all read" in the header while anything is unread; the empty
// state; the kill switch hides the bell; Esc and the focus return; a phone at 375 px; axe on the open panel.
// `MA_BELL_SHOTS=<dir>` also saves stills of the open list, Light and Dark, at 1280 and 375 px.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

interface Harness { log: string[]; notificationPosts: { path: string; body: unknown }[] }
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/**
 * Four items, the newest change first once sorted: three unread, one read. A followed thread and a reply to the member's
 * own, each a group of three (`actor`, `count`, the thread in `body`), as the kit words them. Links stay on this origin, as
 * the contract keeps them on ours.
 */
const items = (origin: string) => [
  { id: 'nt-1', type: 'forums.thread', title: 'New reply in Community Forums', body: 'Quiet mornings', link: `${origin}/forums/t/1`, actor: { name: 'Ada' }, count: 3, critical: false, createdAt: at(300), updatedAt: at(4), readAt: null },
  { id: 'nt-2', type: 'forums.reply', title: 'New reply to your thread', body: 'Low-noise notifications', link: `${origin}/forums/t/2`, actor: { name: 'lio' }, count: 3, critical: false, createdAt: at(400), updatedAt: at(30), readAt: null },
  { id: 'nt-3', type: 'billing.card_expiring', title: 'Your card expires this month', body: 'Update it before the next renewal.', link: `${origin}/billing`, count: 1, critical: true, createdAt: at(600), updatedAt: at(95), readAt: null },
  { id: 'nt-4', type: 'desk.storage', title: 'Work desk is low on space', body: '2 GB left of 20 GB.', link: `${origin}/`, count: 1, critical: true, createdAt: at(3_000), updatedAt: at(3_000), readAt: at(2_000) },
];

const bell = (page: Page) => page.getByTestId('bell');
const count = (page: Page) => page.getByTestId('bell-count');
const panel = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

async function open(page: Page): Promise<void> {
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.bell-item, .bell-empty').first()).toBeVisible();
}

test.beforeEach(async ({ request, baseURL }) => {
  // A reset takes nothing else with it, so the list goes in a second step.
  await harness(request, { reset: true });
  await harness(request, { notifications: { items: items(baseURL!) } });
});

test('the count, in words for screen readers; the list opens newest first and says it was seen', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  await expect(count(page)).toHaveText('3');
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 3 unread');
  // Beside the avatar: the bell, then the account button, and nothing between them.
  const actions = page.locator('.top-actions > *');
  const n = await actions.count();
  await expect(actions.nth(n - 2).getByTestId('bell')).toBeVisible();
  await expect(actions.nth(n - 1).getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  // The pill is the accent, never red: more blue than red in every theme.
  const [r, , b] = (await count(page).evaluate((el) => getComputedStyle(el).backgroundColor)).match(/\d+/g)!.map(Number);
  expect(b!).toBeGreaterThan(r!);

  await open(page);
  // The kit's words (SPEC.md): who first, the thing on the second line, the time on the right; a group says "and N others".
  await expect(panel(page).locator('.bell-title')).toHaveText(['Ada and 2 others replied in Quiet mornings', 'lio and 2 others replied to your thread', 'Your card expires this month', 'Work desk is low on space']);
  await expect(panel(page).locator('.bell-second')).toHaveText(['Community Forums', 'Low-noise notifications', 'Update it before the next renewal.', '2 GB left of 20 GB.']);
  await expect(panel(page).locator('.bell-time')).toHaveText(['4 min', '30 min', '1 h', '2 d']);
  await expect(panel(page).locator('.bell-item.unread')).toHaveCount(3);
  await expect(panel(page).locator('.bell-item.unread .bell-dot')).toHaveCount(3);
  // The header: "Notifications" left and "Mark all read" right, since something is unread; the footer is the one link.
  await expect(panel(page).locator('.bell-head-title')).toHaveText('Notifications');
  await expect(panel(page).locator('.bell-head').getByRole('button', { name: 'Mark all read' })).toBeVisible();
  await expect(panel(page).locator('.bell-foot > *')).toHaveText(['All notifications']);
  await expect(panel(page).getByRole('link', { name: 'All notifications' })).toHaveAttribute('href', 'https://platform.localhost/notifications');
  // The chip and the dot are the spec's sizes; the dot is the accent, never red.
  const chip = (await panel(page).locator('.bell-chip').first().boundingBox())!;
  expect([chip.width, chip.height]).toEqual([28, 28]);
  const dot = (await panel(page).locator('.bell-dot').first().boundingBox())!;
  expect([dot.width, dot.height]).toEqual([8, 8]);
  const [dr, , db] = (await panel(page).locator('.bell-dot').first().evaluate((el) => getComputedStyle(el).backgroundColor)).match(/\d+/g)!.map(Number);
  expect(db!).toBeGreaterThan(dr!);
  const { log, notificationPosts } = await read(request);
  expect(log.filter((l) => l === 'GET /v1/me/notifications/unread').length).toBeGreaterThanOrEqual(1);
  expect(log).toContain('GET /v1/me/notifications');
  expect(notificationPosts).toEqual([{ path: '/v1/me/notifications/seen', body: {} }]);
  expect(errors).toEqual([]);
});

test('past nine it says 9+, and the name keeps the real number', async ({ page, request, baseURL }) => {
  await harness(request, { notifications: { items: items(baseURL!), unreadExtra: 10 } });
  await signIn(page);
  await expect(count(page)).toHaveText('9+');
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 13 unread');
});

test('a click on an item marks it read and goes to it in this tab; the count is one less after', async ({ page, request }) => {
  await signIn(page);
  await canvasPainted(page);
  await open(page);
  await panel(page).getByRole('link', { name: /replied in Quiet mornings/ }).click();
  await expect(page).toHaveURL(/\/forums\/t\/1$/);
  await expect.poll(async () => (await read(request)).notificationPosts.filter((p) => p.path === '/v1/me/notifications/read')).toEqual([{ path: '/v1/me/notifications/read', body: { ids: ['nt-1'] } }]);
  // Back in the office, the count is Platform's: one less.
  await page.goto('/');
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect(count(page)).toHaveText('2');
});

test('Mark all read: the count goes, the dots go, and the header goes with them', async ({ page, request }) => {
  await signIn(page);
  await open(page);
  await panel(page).getByRole('button', { name: 'Mark all read' }).click();
  await expect(count(page)).toHaveCount(0);
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications');
  await expect(panel(page).locator('.bell-item.unread')).toHaveCount(0);
  await expect(panel(page).locator('.bell-dot')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Mark all read' })).toHaveCount(0);
  await expect(panel(page).locator('.bell-head')).toHaveCount(0);
  await expect(panel(page).getByRole('link', { name: 'All notifications' })).toBeVisible();
  await expect.poll(async () => (await read(request)).notificationPosts.filter((p) => p.path === '/v1/me/notifications/read')).toEqual([{ path: '/v1/me/notifications/read', body: { all: true } }]);
  // A reload agrees.
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect(bell(page)).toBeVisible();
  await expect(count(page)).toHaveCount(0);
});

test('with nothing to show: no count, "Nothing new.", no header, and the footer still there', async ({ page, request }) => {
  await harness(request, { notifications: null });
  await signIn(page);
  await expect(bell(page)).toBeVisible();
  await expect(count(page)).toHaveCount(0);
  await open(page);
  await expect(panel(page).getByText('Nothing new.')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Mark all read' })).toHaveCount(0);
  await expect(panel(page).locator('.bell-head')).toHaveCount(0);
  await expect(panel(page).getByRole('link', { name: 'All notifications' })).toBeVisible();
});

test('the kill switch (503 notifications_paused) hides the bell, and the rest of the bar stands', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { notifications: { items: [], paused: true } });
  await signIn(page);
  await canvasPainted(page);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  await expect(bell(page)).toHaveCount(0);
  // Chromium itself logs the 503 as a failed resource; nothing of the app's is in the console.
  expect(errors.filter((e) => !e.includes('status of 503'))).toEqual([]);
});

test('the routes absent (404) hide the bell, leave it out of the Tab stops, and slow the poll', async ({ page, request }) => {
  await harness(request, { notifications: { items: [], absent: true } });
  await signIn(page);
  await canvasPainted(page);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  await expect(bell(page)).toHaveCount(0);
  // The top bar's Tab stops, from the first one to the account button: no Notifications among them.
  await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
  const account = page.getByRole('button', { name: 'Account', exact: true });
  const stops: string[] = [];
  for (let i = 0; i < 8 && !(await account.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''));
  }
  expect(stops.at(-1)).toBe('Account');
  expect(stops).not.toContain('Notifications');
  // One ask, and no second within the wait: the poll is slowed to about 10 minutes.
  const asks = async (): Promise<number> => (await read(request)).log.filter((l) => l === 'GET /v1/me/notifications/unread').length;
  expect(await asks()).toBe(1);
  await page.waitForTimeout(3_000);
  expect(await asks()).toBe(1);
});

test('Esc shuts it and the keyboard goes back to the bell; a click outside shuts it; Tab stays inside', async ({ page }) => {
  await signIn(page);
  await canvasPainted(page);
  await bell(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.bell-item').first()).toBeVisible();
  await expect(bell(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('button', { name: 'Mark all read' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('link', { name: /replied in Quiet mornings/ })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(bell(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(panel(page).getByRole('link', { name: 'All notifications' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bell(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(bell(page)).toBeFocused();
  await expect(bell(page)).toHaveAttribute('aria-expanded', 'false');
  // Esc stopped at the panel: the office is where it was.
  await expect(page.locator('.ma-shell')).toBeVisible();

  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(400, 500);
  await expect(panel(page)).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

  test('the bell stays beside the avatar, the open list fits the screen, and a finger has 44 px to press', async ({ page }) => {
    await signIn(page);
    await canvasPainted(page);
    const b = (await bell(page).boundingBox())!;
    const a = (await page.getByRole('button', { name: 'Account', exact: true }).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(a.x).toBeGreaterThan(b.x);
    expect(a.x + a.width).toBeLessThanOrEqual(375);
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    await open(page);
    const p = (await panel(page).boundingBox())!;
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(375);
    expect(p.y + p.height).toBeLessThanOrEqual(667);
    await expect(panel(page).locator('.bell-title').first()).toBeVisible();
    await expect(panel(page).getByRole('link', { name: 'All notifications' })).toBeVisible();
    // A finger's targets: the header's and the footer's links are 44 px tall on a touch screen (`pointer: coarse`).
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    for (const name of ['Mark all read', 'All notifications']) {
      const box = (await panel(page).getByText(name).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
  });
});

/** axe on the bell and its open panel, at WCAG 2.2 AA and best practice, as the membership cards are checked. */
async function axe(page: Page): Promise<{ violations: string[]; unsure: string[] }> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[]; incomplete: Rule[] }> } };
    interface Rule { id: string; nodes: { target: string[]; any: { message: string }[] }[] }
    const sheet = document.styleSheets[0]!;
    const i = sheet.insertRule('.ma-shell::before { content: none !important; }', sheet.cssRules.length);
    sheet.insertRule('.window-layer { display: none !important; }', i + 1);
    try {
      const r = await w.axe.run({ include: [['.bell-btn'], ['.bell-panel']] }, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations', 'incomplete'],
      });
      const say = (v: Rule) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`;
      const why = (v: Rule) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.any.map((a) => a.message).join('; ')}`);
      return { violations: r.violations.map(say), unsure: r.incomplete.filter((v) => v.id === 'color-contrast').flatMap(why) };
    } finally {
      sheet.deleteRule(i + 1);
      sheet.deleteRule(i);
    }
  });
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the open list passes axe, and its stills`, async ({ page }) => {
    await setTheme(page, theme);
    const shots = process.env['MA_BELL_SHOTS'];
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width < 600 ? 667 : 800 });
      await signIn(page);
      await canvasPainted(page);
      await open(page);
      expect(await axe(page), `${theme} at ${width}`).toEqual({ violations: [], unsure: [] });
      if (shots && theme !== 'dusk') await page.screenshot({ path: join(shots, `bell-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
    }
  });
}
