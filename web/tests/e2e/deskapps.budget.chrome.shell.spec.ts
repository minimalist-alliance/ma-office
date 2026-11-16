// The frame budget in Chrome itself (`channel: 'chromium'`), where a view's sandboxed frame has a process of its own (Chrome on a
// computer isolates sandboxed frames): a view that busy-loops can't slow the office, the probe says so, and it's never paused.
// The headless shell's half, where the frame shares the office's thread, is `deskapps.budget.shell.spec.ts`.
import { expect, test } from '@playwright/test';
import { busyView, harness, office, openTile, PAUSED, READY, TALLY, threadOf, viewFrame, watchGaps } from './budget.helpers';

test.use({ channel: 'chromium' });

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('(b2) the same busy view runs in its own process: the office keeps its frames and the view is never paused', async ({ page, request }) => {
  test.setTimeout(60_000);
  const errors = await office(page, request, [TALLY]);
  await openTile(page, TALLY);
  await expect.poll(() => threadOf(page), { timeout: 8000 }).toBe('own');
  await page.waitForTimeout(1300);
  const gaps = await watchGaps(page);
  await busyView(await viewFrame(page), 100, 6000);
  await page.waitForTimeout(7000);
  const long = await gaps.stop();
  await expect(page.locator(PAUSED)).toHaveCount(0);
  await expect(page.locator(READY)).toBeVisible();
  // The view's 100 ms frames never held the office's.
  expect(long.filter((g) => g >= 90)).toEqual([]);
  console.log(`(b2) office gaps over 50 ms while the view was busy: ${JSON.stringify(long)}`);
  expect(errors).toEqual([]);
});
