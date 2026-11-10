// The data guard in the Desk app (ma-platform ADR 0110, contract bandwidth.md 0.3.44): `dataGuard` beside the circle, the
// platform's words at a refused start with the member's next billing day, the stop countdown's reason, and a Guild Desk's
// token or wake refused. The harness stands in for Platform. Three themes. Never a dollar figure, never "absorbed".
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const GB = 1e9;
const DAY = 86_400_000;
const WORDS =
  'Your desks were stopped because the data they sent this month went well past what your plan includes. Your files and your browser sessions are safe. Email support@minimalistalliance.com and we will start them again, or they can start by themselves on your next billing day.';
const GUILD_WORDS =
  'Your guild sessions are paused because the data you used this month went well past what your plan includes. The guild carries on without you. Email support@minimalistalliance.com and we will turn them back on, or they come back by themselves on your next billing day.';
const RESUMES = new Date(Date.now() + 8 * DAY);
RESUMES.setUTCHours(12, 0, 0, 0);
/** The same day the app will say, in this browser's zone. */
const DAY_LINE = `Your next billing day is ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(RESUMES)}.`;
const NEVER = /\$\s?\d|absorbed/i;

function meter(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const used = Math.round(5 * GB);
  return {
    tier: 'officer',
    week: { usedBytes: used, usedGb: 5, limitGb: 30, startsAt: new Date(weekStart).toISOString(), resetsAt: new Date(weekStart + 7 * DAY).toISOString() },
    month: { usedBytes: used, usedGb: 5, limitGb: 100, startsAt: new Date(monthStart).toISOString(), resetsAt: new Date(nextMonth).toISOString() },
    state: 'ok', limitedBy: null, warnAtPct: 80, enforced: false, paused: false, resumesAt: null, asOf: now.toISOString(), pollAfterSeconds: 1,
    dataGuard: null,
    ...over,
  };
}
const guarded = (): Record<string, unknown> => meter({ dataGuard: { message: WORDS, since: new Date().toISOString(), resumesAt: RESUMES.toISOString() } });

async function arrive(page: Page, request: APIRequestContext, m: Record<string, unknown>): Promise<void> {
  await harness(request, { bandwidth: meter() });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await harness(request, { bandwidth: m });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the circle carries the guard's words as given, then the billing day`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request, guarded());
    await expect(page.getByTestId('bandwidth')).toHaveAttribute('data-guard', 'stopped');
    await expect(page.getByTestId('bandwidth-button')).toHaveAccessibleName(/Desks stopped: data use past your plan\.$/);
    // The one-time heads-up says the platform's words as given.
    await expect(page.getByTestId('bandwidth-notice')).toContainText('went well past what your plan includes');
    await page.getByTestId('bandwidth-button').click();
    const guard = page.getByTestId('data-guard-panel');
    await expect(guard).toBeVisible();
    await expect(guard.getByTestId('data-guard-message')).toHaveText(WORDS);
    await expect(guard.getByTestId('data-guard-day')).toHaveText(DAY_LINE);
    expect(await page.locator('body').innerText()).not.toMatch(NEVER);
    expect(errors).toEqual([]);
  });
}

test('no guard, no words: the panel is as it was', async ({ page, request }) => {
  await arrive(page, request, meter());
  await page.getByTestId('bandwidth-button').click();
  await expect(page.getByTestId('bandwidth-panel')).toBeVisible();
  await expect(page.getByTestId('data-guard-panel')).toHaveCount(0);
  await expect(page.getByTestId('bandwidth')).not.toHaveAttribute('data-guard', /./);
});

test('a refused start shows the platform\'s message as given and the billing day', async ({ page }) => {
  // The mock desk refuses `connect` as Platform's `403 data_guard` does (`?refuse=data_guard&message=&resumes=`).
  await signIn(page, `/?fixture=one&refuse=data_guard&message=${encodeURIComponent(WORDS)}&resumes=${encodeURIComponent(RESUMES.toISOString())}`);
  await canvasPainted(page);
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  const dialog = page.getByRole('dialog', { name: /Browser/ });
  await expect(dialog.getByTestId('data-guard-message')).toHaveText(WORDS);
  await expect(dialog.getByTestId('data-guard-day')).toHaveText(DAY_LINE);
  expect(await page.locator('body').innerText()).not.toMatch(NEVER);
  // It is not a membership problem: no billing link, no membership line.
  await expect(page.getByText('Your membership is not active')).toHaveCount(0);
  await expect(page.getByTestId('billing-link')).toHaveCount(0);
});

test('the stop countdown says why, for the data guard only', async ({ page, request }) => {
  const stopAt = new Date(Date.now() + 60_000).toISOString();
  await harness(request, { fleet: [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'stopping', stopAt, stopReason: 'data_guard' }] });
  await signIn(page, '/');
  await canvasPainted(page);
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Personal desk,/ })).toHaveAccessibleName(/Your desks are stopping: your data use this month went past your plan\./);
  await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Browser/ }).getByRole('heading', { level: 3 })).toHaveText('Your desks are stopping: your data use this month went past your plan.');
});

test('any other stop reason keeps the usual words', async ({ page, request }) => {
  const stopAt = new Date(Date.now() + 60_000).toISOString();
  await harness(request, { fleet: [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'stopping', stopAt, stopReason: 'something_new' }] });
  await signIn(page, '/');
  await canvasPainted(page);
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Personal desk,/ })).toHaveAccessibleName(/going to sleep/);
});

test('a Guild Desk refused with 403 data_guard shows the guild message as given, and nothing else added', async ({ page, request }) => {
  const guild = { guildId: 'gu-platformteam', name: 'Platform team', role: 'member', grants: [] };
  await harness(request, {
    guilds: { list: [guild], desks: { [guild.guildId]: { deskId: 'd-gplatform', state: 'running' } }, guard: { [guild.guildId]: { message: GUILD_WORDS, resumesAt: RESUMES.toISOString() } } },
  });
  await signIn(page, '/?fixture=one&speed=fast');
  await canvasPainted(page);
  await page.getByRole('group', { name: 'Platform team desk' }).getByRole('button', { name: /^Commons|^Notebook|^Agent/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('data-guard-message').first()).toHaveText(GUILD_WORDS);
  await expect(page.getByTestId('data-guard-day')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toMatch(NEVER);
});
