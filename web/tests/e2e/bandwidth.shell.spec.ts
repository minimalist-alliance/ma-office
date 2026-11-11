// The bandwidth circle and the weekly limit (task 24, ma-platform ADR 0095), against the harness's stand-in for
// `GET /v1/desks/bandwidth`, with MockDeskLink's Browser. Three themes, the keyboard, touch, the names a screen reader
// hears, the 80% heads-up, and the Browser pausing at the limit while Notebook keeps working.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const GB = 1e9;
const DAY = 86_400_000;

/** A meter as services/desks answers it, for this week and month, with `weekGb` used of 30 (and of 100 this month). */
function meter(weekGb: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const used = Math.round(weekGb * GB);
  const state = weekGb >= 30 ? 'limit' : weekGb >= 24 ? 'warn' : 'ok';
  const weekEnd = new Date(weekStart + 7 * DAY).toISOString();
  return {
    tier: 'officer',
    week: { usedBytes: used, usedGb: weekGb, limitGb: 30, startsAt: new Date(weekStart).toISOString(), resetsAt: weekEnd },
    month: { usedBytes: used, usedGb: weekGb, limitGb: 100, startsAt: new Date(monthStart).toISOString(), resetsAt: new Date(nextMonth).toISOString() },
    state,
    limitedBy: state === 'limit' ? 'week' : null,
    warnAtPct: 80,
    enforced: true,
    paused: state === 'limit',
    resumesAt: state === 'limit' ? weekEnd : null,
    asOf: now.toISOString(),
    pollAfterSeconds: 1,
    ...over,
  };
}

interface MockControl {
  rpc: { m: string; p: Record<string, unknown> }[];
  refuse: Record<string, string>;
  refuseDetails: Record<string, unknown>;
}
const mock = <T>(page: Page, fn: (c: MockControl, arg: unknown) => T, arg: unknown = null): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__maDeskMock, ${JSON.stringify(arg)})`) as Promise<T>;
const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(`(${((c: MockControl) => c.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string)).toString()})(window.__maDeskMock)`) as Promise<string[]>;

const circle = (page: Page) => page.getByTestId('bandwidth-button');
const panel = (page: Page) => page.getByTestId('bandwidth-panel');
const tile = (page: Page, app: string) => page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: new RegExp(`^${app}`) });

/**
 * Signs in on a quiet week, then Platform starts saying `m`, which the next poll (1 s) brings. Signing in loads the
 * page twice, and a heads-up shown on the first load would count as seen.
 */
async function arrive(page: Page, request: APIRequestContext, m: Record<string, unknown> | 404, fixture = 'one'): Promise<void> {
  await harness(request, { bandwidth: m === 404 ? 404 : meter(0) });
  await signIn(page, `/?fixture=${fixture}`);
  await canvasPainted(page);
  if (m === 404) return;
  await harness(request, { bandwidth: m });
  await expect(page.getByTestId('bandwidth')).toHaveAttribute('data-state', String(m['state']));
}

async function openApp(page: Page, app: string): Promise<void> {
  await tile(page, app).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: new RegExp(app) })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the circle sits bottom right, says the numbers, and opens on hover`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request, meter(12.34));
    await expect(circle(page)).toHaveAccessibleName(/^Bandwidth: 12\.3 GB of 30 GB used this week\. Resets \w{3} \d{1,2}:\d{2} [AP]M\.$/);
    await expect(circle(page)).toHaveAttribute('aria-expanded', 'false');

    // Bottom right, level with the zoom control and clear of it.
    const vp = page.viewportSize()!;
    const box = (await circle(page).boundingBox())!;
    const zoom = (await page.getByRole('group', { name: 'Zoom' }).boundingBox())!;
    expect(vp.width - (box.x + box.width)).toBeCloseTo(32, 0);
    expect(vp.height - (box.y + box.height)).toBeCloseTo(16, 0);
    expect(zoom.x + zoom.width).toBeLessThanOrEqual(box.x - 4);
    expect(Math.abs(zoom.y + zoom.height / 2 - (box.y + box.height / 2))).toBeLessThan(2);

    await circle(page).hover();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('This week12.3 GB of 30 GB');
    await expect(panel(page)).toContainText('This month12.3 GB of 100 GB');
    await expect(panel(page).getByRole('meter', { name: 'This week' })).toHaveAttribute('aria-valuetext', '12.3 GB of 30 GB');
    await expect(panel(page).getByRole('meter', { name: 'This month' })).toHaveAttribute('aria-valuenow', '12.34');
    await page.screenshot({ path: `test-results/shots/${theme}-bandwidth.png` });
    await page.mouse.move(200, 200);
    await expect(panel(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test(`${theme}: 80% gives one gentle heads-up, and the limit pauses the Browser while Notebook keeps working`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request, meter(25));
    const notice = page.getByTestId('bandwidth-notice');
    await expect(notice).toHaveText("You've used 83% of this week's bandwidth: 25 GB of 30 GB.");
    await expect(page.getByTestId('bandwidth')).toHaveAttribute('data-state', 'warn');
    await page.screenshot({ path: `test-results/shots/${theme}-bandwidth-warn.png` });

    await openApp(page, 'Browser');
    await expect(page.getByTestId('browser-video')).toBeVisible();
    await expect.poll(() => streamCalls(page)).toContain('live');

    // The limit: Platform says paused. The picture goes, the desk is told `off`, and the window says when it's back.
    await harness(request, { bandwidth: meter(30.2) });
    const paused = page.getByTestId('bandwidth-paused');
    await expect(paused).toBeVisible();
    await expect(paused.getByRole('heading')).toHaveText(/^Browser is paused until \w{3} \d{1,2}:\d{2} [AP]M$/);
    await expect(paused).toContainText("You've used this week's 30 GB of bandwidth. Notebook and Agent keep working, and your tabs are safe.");
    await expect(page.getByTestId('browser-video')).toHaveCount(0);
    await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('off');
    await expect(circle(page)).toHaveAccessibleName(/Browser paused until/);
    await expect(page.getByTestId('bandwidth-notice')).toContainText('Bandwidth limit reached. The Browser is paused until');
    await page.screenshot({ path: `test-results/shots/${theme}-bandwidth-paused.png` });

    // Notebook isn't streamed, so it opens as ever.
    await openApp(page, 'Notebook');
    await expect(page.getByTestId('note-editor')).toBeVisible();

    // The reset: Platform says it's a new week, and the Browser comes back by itself.
    await harness(request, { bandwidth: meter(0) });
    await expect(page.getByTestId('bandwidth-paused')).toHaveCount(0);
    await expect(page.getByTestId('browser-video')).toBeVisible();
    await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
    expect(errors).toEqual([]);
  });
}

/**
 * Records every live region as it comes into the page, with what it said then, so a test can tell words said through a
 * region that was there, empty, before them (which a screen reader announces) from a region added with its words (which
 * it may not). The callback runs after each commit, so a region and its words in one commit read as born with words.
 */
async function watchRegions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Born = HTMLElement & { __bornWith?: string };
    const w = window as unknown as { __born: string[] };
    w.__born = [];
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          for (const el of [n, ...n.querySelectorAll<HTMLElement>('[role="status"], [aria-live]')]) {
            if (!el.matches('[role="status"], [aria-live]') || (el as Born).__bornWith !== undefined) continue;
            (el as Born).__bornWith = el.textContent ?? '';
            w.__born.push((el as Born).__bornWith!);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
const bornWith = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __born: string[] }).__born);
const shellRegion = (page: Page) => page.getByTestId('live-region');

test("the heads-up and the pause are said through the shell's live region, there, empty, before their words", async ({ page, request }) => {
  await watchRegions(page);
  await arrive(page, request, meter(25));
  const heads = "You've used 83% of this week's bandwidth: 25 GB of 30 GB.";
  await expect(page.getByTestId('bandwidth-notice')).toHaveText(heads);
  await expect(shellRegion(page)).toHaveText(heads);
  expect(await shellRegion(page).evaluate((el) => (el as unknown as { __bornWith: string }).__bornWith)).toBe('');
  // The notice isn't a region of its own, so it isn't said twice, or added with its words.
  await expect(page.getByTestId('bandwidth-notice')).not.toHaveAttribute('role', 'status');
  await expect(page.getByTestId('bandwidth-notice').locator('[role="status"], [aria-live]')).toHaveCount(0);

  // A window open as the pause comes.
  await openApp(page, 'Browser');
  await expect(page.getByTestId('browser-video')).toBeVisible();
  await harness(request, { bandwidth: meter(30.2) });
  const paused = page.getByTestId('bandwidth-paused');
  await expect(paused).toBeVisible();
  await expect(paused).not.toHaveAttribute('role', 'status');
  const pauseSaid = /^Browser is paused until \w{3} \d{1,2}:\d{2} [AP]M\. You've used this week's 30 GB of bandwidth\. Notebook and Agent keep working, and your tabs are safe\.$/;
  await expect(shellRegion(page)).toHaveText(pauseSaid);

  // A window that opens already paused says it too (after the shell's "window opened", which it replaces).
  await page.getByRole('dialog', { name: /Browser/ }).first().getByRole('button', { name: /^Close/ }).click();
  await expect(paused).toHaveCount(0);
  await openApp(page, 'Browser');
  await expect(shellRegion(page)).toHaveText(pauseSaid);

  // No region came into the page already holding any of these words.
  expect((await bornWith(page)).filter((t) => /bandwidth|paused/i.test(t))).toEqual([]);
});

test('the keyboard: Enter opens, Esc closes and keeps focus, and a screen reader hears the numbers first', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request, meter(3));
  await circle(page).focus();
  await page.keyboard.press('Enter');
  await expect(circle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toBeVisible();
  const controls = await circle(page).getAttribute('aria-controls');
  expect(await panel(page).getAttribute('id')).toBe(controls);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(circle(page)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Space');
  await expect(panel(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test('touch: a tap opens it, a tap elsewhere closes it, and it stays clear of the zoom on a phone', async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  const errors = watchConsole(page);
  await arrive(page, request, meter(28));
  await circle(page).tap();
  await expect(panel(page)).toBeVisible();
  const p = (await panel(page).boundingBox())!;
  expect(p.x).toBeGreaterThanOrEqual(16);
  expect(p.x + p.width).toBeLessThanOrEqual(390 - 16 + 0.5);
  await page.screenshot({ path: 'test-results/shots/bandwidth-phone.png' });
  await page.touchscreen.tap(100, 400);
  await expect(panel(page)).toBeHidden();
  const box = (await circle(page).boundingBox())!;
  const zoom = (await page.getByRole('group', { name: 'Zoom' }).boundingBox())!;
  expect(zoom.x + zoom.width).toBeLessThanOrEqual(box.x - 4);
  expect(390 - (box.x + box.width)).toBeCloseTo(16, 0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('not enforced, as in prod until the owner turns it on: the real number past the limit, and the Browser plays on', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request, meter(31, { enforced: false, paused: false }));
  await expect(circle(page)).toHaveAccessibleName('Bandwidth: 31 GB of 30 GB used this week. Limit reached.');
  await circle(page).click();
  await expect(page.getByTestId('bandwidth-line')).toHaveText("You're past this week's limit.");
  await openApp(page, 'Browser');
  await expect(page.getByTestId('browser-video')).toBeVisible();
  await expect(page.getByTestId('bandwidth-paused')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a Platform with no meter yet shows no circle and asks no more', async ({ page, request }) => {
  const errors = watchConsole(page);
  const asks = async (): Promise<number> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log.filter((l) => l === 'GET /v1/desks/bandwidth').length;
  await arrive(page, request, 404);
  const once = await asks(); // one per page load: signing in loads it twice
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId('bandwidth')).toHaveCount(0);
  expect(await asks()).toBe(once);
  // The browser's own line for the 404, which no app code can stop; nothing else.
  expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
});

test('the heads-up is once a week per browser, not on every load', async ({ page, request }) => {
  await arrive(page, request, meter(25));
  await expect(page.getByTestId('bandwidth-notice')).toBeVisible();
  await page.reload();
  await canvasPainted(page);
  await expect(page.getByTestId('bandwidth')).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId('bandwidth-notice')).toHaveCount(0);
});

// ----- The desk's own word (review findings 4 and 6)

/** deskd's refusal of `live` while Platform has the member paused (deskd API.md section 10). */
async function deskRefuses(page: Page, resumesAt: string | null): Promise<void> {
  await mock(page, (c, at) => {
    c.refuse['browser.stream.set'] = 'unavailable';
    c.refuseDetails = { reason: 'bandwidth_limit', resumesAt: at };
  }, resumesAt);
}

/** "Mon 5:00 PM", as the app says a time within the coming week, in this browser's zone. */
const said = (page: Page, iso: string): Promise<string> =>
  page.evaluate((t) => {
    const at = Date.parse(t);
    return `${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)} ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)}`;
  }, iso);

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: finding 6, the desk refuses live with bandwidth_limit: the pause shows the desk's time, and nothing asks again`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request, 404); // no meter: only the desk can say
    // The desk's time has passed by this browser's clock, as when the clock runs fast: the desk's word still holds.
    const resumesAt = new Date(Date.now() - 3 * 60_000).toISOString();
    await deskRefuses(page, resumesAt);
    await openApp(page, 'Browser');
    const paused = page.getByTestId('bandwidth-paused');
    await expect(paused).toBeVisible();
    await expect(paused).toHaveAttribute('data-by', 'desk');
    await expect(paused.getByRole('heading')).toHaveText(`Browser is paused until ${await said(page, resumesAt)}`);
    await expect(paused).toContainText("You've reached your bandwidth limit. Notebook and Agent keep working, and your tabs are safe.");
    await expect(page.getByTestId('browser-panel')).toHaveCount(0);
    await page.waitForTimeout(3_000); // past the backoff's first steps, which any other `unavailable` gets
    expect(await streamCalls(page)).toEqual(['live']);
    await page.screenshot({ path: `test-results/shots/${theme}-bandwidth-desk-paused.png` });
    // Notebook isn't streamed, so it opens as ever.
    await openApp(page, 'Notebook');
    await expect(page.getByTestId('note-editor')).toBeVisible();
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
}

test("finding 6: at the desk's time the Browser asks once more, no sooner than a minute on, and comes back when the desk lifts it", async ({ page, request }) => {
  test.setTimeout(150_000);
  const errors = watchConsole(page);
  await arrive(page, request, meter(30.2, { enforced: false, paused: false })); // at the limit, not paused by the meter
  const resumesAt = new Date(Date.now() + 5_000).toISOString();
  await deskRefuses(page, resumesAt);
  await openApp(page, 'Browser');
  const paused = page.getByTestId('bandwidth-paused');
  await expect(paused.getByRole('heading')).toHaveText(`Browser is paused until ${await said(page, resumesAt)}`);
  // The meter is at its limit too, so its numbers are said.
  await expect(paused).toContainText("You've used this week's 30 GB of bandwidth.");
  // Past the desk's time, still within the minute: nothing asks.
  await page.waitForTimeout(15_000);
  expect(await streamCalls(page)).toEqual(['live']);
  await expect(paused).toBeVisible();
  // The desk lifts it; at a minute from its answer, the Browser asks once and the picture comes.
  await mock(page, (c) => {
    delete c.refuse['browser.stream.set'];
    c.refuseDetails = {};
  });
  await expect(paused).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('browser-video')).toBeVisible();
  await expect.poll(() => streamCalls(page)).toEqual(['live', 'live']);
  expect(errors).toEqual([]);
});

test('finding 4: a desk on the member\'s own computer never pauses at the cloud limit; the cloud desk beside it does', async ({ page, request }) => {
  const errors = watchConsole(page);
  const PERSONAL = 'd-personal00001';
  const HOME = 'd-work000000001';
  await harness(request, {
    bandwidth: meter(0),
    fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: HOME, name: 'Work', kind: 'work', state: 'running', hosting: 'self' }],
  });
  await signIn(page, '/?speed=fast');
  await canvasPainted(page);
  await harness(request, { bandwidth: meter(30.2) });
  await expect(page.getByTestId('bandwidth')).toHaveAttribute('data-state', 'limit');
  const browserOn = async (desk: string, deskId: string) => {
    await page.getByRole('group', { name: `${desk} desk` }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.locator(`[data-testid="window-browser"][data-desk="${deskId}"]`);
    await expect(win).toBeVisible();
    return win;
  };

  const cloud = await browserOn('Personal', PERSONAL);
  await expect(cloud.getByTestId('bandwidth-paused')).toBeVisible();
  await expect(cloud.getByTestId('browser-video')).toHaveCount(0);
  expect(await streamCalls(page)).toEqual([]);
  await cloud.getByRole('button', { name: 'Close Browser' }).click();

  const home = await browserOn('Work', HOME);
  await expect(home.getByTestId('browser-video')).toBeVisible();
  await expect(home.getByTestId('bandwidth-paused')).toHaveCount(0);
  await expect.poll(() => streamCalls(page)).toEqual(['live']);
  await page.waitForTimeout(2_500); // two more polls of the paused meter
  await expect(home.getByTestId('bandwidth-paused')).toHaveCount(0);
  expect(await streamCalls(page)).toEqual(['live']);
  await page.screenshot({ path: 'test-results/shots/light-bandwidth-self-hosted.png' });
  expect(errors).toEqual([]);
});

// One quiet Maia line under the numbers (contract maia.md, `GET /v1/maia/state`), asked only when the panel opens.
const maiaLineOf = (page: Page) => page.getByTestId('bandwidth-maia');

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the panel says how much of Maia's month is used, asked when it opens`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await harness(request, { maia: { enabled: true, usedFraction: 0.379 } });
    await arrive(page, request, meter(12.34));
    await circle(page).hover();
    await expect(panel(page)).toBeVisible();
    await expect(maiaLineOf(page)).toHaveText("Maia: 37% of this month's allowance used");
    await expect(panel(page)).toContainText("Maia: 37% of this month's allowance used");
    await page.screenshot({ path: `test-results/shots/${theme}-bandwidth-maia.png` });
    expect(errors).toEqual([]);
  });
}

test('limited: free Maia keeps answering; without it, the reset date; the plain off body and a failing ask show no line', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { maia: { enabled: true, limited: 'personal', usedFraction: 1, resetsAt: '2026-12-01T07:00:00Z', freeUntil: '2026-12-01T07:00:00Z' } });
  await arrive(page, request, meter(12.34));
  await circle(page).click();
  await expect(maiaLineOf(page)).toHaveText("Maia: this month's allowance is used. She keeps answering on free Maia.");
  await page.screenshot({ path: 'test-results/shots/light-bandwidth-maia-free.png' });

  await page.reload();
  await harness(request, { maia: { enabled: true, limited: 'personal', usedFraction: 1, resetsAt: '2026-12-01T07:00:00Z' } });
  await page.reload();
  await canvasPainted(page);
  await circle(page).click();
  await expect(maiaLineOf(page)).toHaveText(/^Maia: this month's allowance is used\. It resets (Dec 1|\w{3} \d{1,2} \d{1,2}:\d{2} [AP]M)\.$/);
  await page.screenshot({ path: 'test-results/shots/light-bandwidth-maia-limited.png' });

  await harness(request, { maia: { enabled: false } });
  await page.reload();
  await canvasPainted(page);
  await circle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(maiaLineOf(page)).toHaveCount(0);

  await harness(request, { maia: { enabled: true, stateStatus: 503 } });
  await page.reload();
  await canvasPainted(page);
  await circle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(maiaLineOf(page)).toHaveCount(0);
  expect(errors.filter((e) => !/503/.test(e))).toEqual([]);
});

test('no Maia in client-config: no line and no request to her', async ({ page, request }) => {
  await arrive(page, request, meter(12.34));
  await circle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(maiaLineOf(page)).toHaveCount(0);
});

// An {alliance} adult feels the weekly limit and reads where more comes from (the Designer's free-tier README, A2 and A3).
const ALLIANCE_ADULT = { status: 'active', tier: 'alliance', ageBand: 'adult', adultFrom: null, parent: null };
const AGE_ON = { enabled: true, minimumAge: 13, adultAge: 18 };
const OFFICER_30 = { officer: { weeklyAllowanceGb: 30 } };
const offerOf = (page: Page) => page.getByTestId('bandwidth-offer');

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: an alliance adult's panel adds the next tier's weekly allowance and See membership`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await harness(request, { membership: ALLIANCE_ADULT, ageRules: AGE_ON, tierNames: { alliance: 'Alliance Member', officer: 'Steward', lead: 'Captain' }, tierAllowances: OFFICER_30 });
    await arrive(page, request, meter(12.34, { tier: 'alliance' }));
    await circle(page).click();
    await expect(offerOf(page)).toHaveText('Steward has 30 GB a week. See membership');
    const link = offerOf(page).getByRole('link', { name: 'See membership' });
    await expect(link).toHaveAttribute('href', 'https://platform.localhost/account');
    await expect(link).toHaveAttribute('target', '_blank');
    await page.screenshot({ path: `test-results/shots/${theme}-alliance-up-panel.png` });
    expect(errors).toEqual([]);
  });

  test(`${theme}: an alliance adult's weekly pause adds one quiet link, and the words stay`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await harness(request, { membership: ALLIANCE_ADULT, ageRules: AGE_ON, tierAllowances: OFFICER_30 });
    await arrive(page, request, meter(0, { tier: 'alliance' }));
    await openApp(page, 'Browser');
    await harness(request, { bandwidth: meter(30.2, { tier: 'alliance' }) });
    const paused = page.getByTestId('bandwidth-paused');
    await expect(paused.getByRole('heading')).toHaveText(/^Browser is paused until \w{3} \d{1,2}:\d{2} [AP]M$/);
    await expect(paused).toContainText("You've used this week's 30 GB of bandwidth. Notebook and Agent keep working, and your tabs are safe.");
    await expect(paused.getByRole('link')).toHaveText('Officer has 30 GB a week');
    await expect(paused.getByRole('link')).toHaveAttribute('href', 'https://platform.localhost/account');
    await page.screenshot({ path: `test-results/shots/${theme}-alliance-up-paused.png` });
    expect(errors).toEqual([]);
  });
}

test('no allowance on the wire: "more each week", no number; the heads-up at the warning line has no link', async ({ page, request }) => {
  await harness(request, { membership: ALLIANCE_ADULT, ageRules: AGE_ON });
  await arrive(page, request, meter(25, { tier: 'alliance' }));
  await expect(page.getByTestId('bandwidth-notice')).toHaveText("You've used 83% of this week's bandwidth: 25 GB of 30 GB.");
  await expect(page.getByTestId('bandwidth-notice').getByRole('link')).toHaveCount(0);
  await circle(page).click();
  await expect(offerOf(page)).toHaveText('Officer has more each week. See membership');
});

const NOTHING_NEW: [string, Record<string, unknown>, string][] = [
  ['a teen', { age: 'teen' }, 'alliance'],
  ['an officer', { membership: { ...ALLIANCE_ADULT, tier: 'officer' }, ageRules: AGE_ON }, 'officer'],
  ['an alliance member whose age band is not known', { membership: { ...ALLIANCE_ADULT, ageBand: null } }, 'alliance'],
];
for (const [who, state, tier] of NOTHING_NEW) {
  test(`${who} sees nothing new in the panel`, async ({ page, request }) => {
    await harness(request, { ...state, tierAllowances: OFFICER_30 });
    await arrive(page, request, meter(0, { tier }));
    await circle(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(offerOf(page)).toHaveCount(0);
    await expect(panel(page).getByRole('link')).toHaveCount(0);
  });
}
