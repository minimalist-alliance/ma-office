// A desk on the member's own computer started (task 31/32): the office says "<name> started at <time>" once, calmly,
// for a new boot only, and never for a cloud desk or a first sight. `src/platform/bootNotice.test.ts` has the rules.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const HOME = 'd-home000000001';
const boot = (firstSeen: string, previous: string | null, refused: string | null = null) => ({
  bootFirstSeenAt: firstSeen, previousBootFirstSeenAt: previous, bootRefusedAt: refused,
});
const fleet = (b: Record<string, string | null>) => [
  { deskId: 'd-cloud00000001', name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: HOME, name: 'Home desk', kind: 'personal', state: 'running', hosting: 'self', ...b },
];
const line = (page: Page) => page.getByTestId('boot-notice');

test('says nothing the first time, then once for a new start, with calm words', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: fleet(boot('2026-11-08T20:00:00Z', null)) });
  await signIn(page);
  await canvasPainted(page);
  await expect(line(page)).toHaveCount(0);

  await harness(request, { fleet: fleet(boot('2026-11-08T21:12:00Z', '2026-11-08T20:00:00Z')) });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect(line(page)).toHaveCount(1);
  const said = (await line(page).innerText()).replace(/\s+/g, ' ');
  expect(said).toContain('Home desk started at');
  expect(said).not.toContain('!');
  expect(said).not.toContain('Personal started');

  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(line(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('can be put away', async ({ page, request }) => {
  await harness(request, { fleet: fleet(boot('2026-11-08T20:00:00Z', null)) });
  await signIn(page);
  await canvasPainted(page);
  await harness(request, { fleet: fleet(boot('2026-11-08T22:00:00Z', '2026-11-08T21:12:00Z')) });
  await page.reload();
  await expect(line(page)).toBeVisible();
  await line(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(line(page)).toHaveCount(0);
});

test('says a second copy is trying to start, while the platform says it just was, and not when it was long ago', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: fleet(boot('2026-11-08T20:00:00Z', null, new Date().toISOString())) });
  await signIn(page);
  await canvasPainted(page);
  await expect(line(page)).toHaveCount(1);
  const said = (await line(page).innerText()).replace(/\s+/g, ' ');
  expect(said).toContain('Another copy of Home desk is trying to start.');
  expect(said).not.toContain('!');
  await harness(request, { fleet: fleet(boot('2026-11-08T20:00:00Z', null, '2026-11-08T20:30:00Z')) });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(line(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
