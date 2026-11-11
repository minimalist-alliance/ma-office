// Teens in the Alliance tier, the Desk app's side (task 40, ma-platform contract age.md, draft-age-rules.md 3.2). The band
// comes only from `/v1/me`. A teen has no Agent app, no way to reach it and no word of it, with Browser, Notebook and
// Chat as ever; never a card about Pro or Officer; a calm card while waiting on a parent; and a report row wherever the
// rules are on. No band at all is today's app, which every other spec in this folder runs against as well.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const ACCOUNT = 'https://platform.localhost/account';
const REPORT = 'https://platform.localhost/report';
const PHONE = { width: 375, height: 667 };
/** Platform's billing block once Alliance is on sale, and with only Pro on sale. */
const ALLIANCE_OPEN = { enabled: true, memberMonthlyUsd: 100, allianceMonthlyUsd: 5 };
const PRO_OPEN = { enabled: true, memberMonthlyUsd: 100 };
const DESK = 'd-personal00001';
const ME = 'u-test';
const fleet = [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' }];
const ALL_APPS = ['Chat', 'Notebook', 'Browser', 'Agent'];
const TEEN_APPS = ['Chat', 'Notebook', 'Browser'];

const TEEN_BODY = 'Your desk appears here once you join. Alliance Member is one small desk with Browser.';
const PARENT_TITLE = 'Waiting for your parent or guardian';
const PARENT_BODY = "We're emailing them a link. Your account opens once they agree.";
const A_BODY = "Your desks appear here once you're a member: one for your personal life and one for your work, each on its own private desk. Work stays at work. Home stays home.";

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

const card = (page: Page): Locator => page.locator('.desk-notice');
const deskGroup = (page: Page): Locator => page.getByRole('group', { name: /^Personal desk/ });

/** The apps a screen reader and the keyboard find on the desk, by name. */
async function appsOnDesk(page: Page): Promise<string[]> {
  const names = await deskGroup(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return ['Chat', 'Notebook', 'Browser', 'Agent', 'Claude'].filter((app) => names.some((n) => n.startsWith(app)));
}

async function arrive(page: Page, request: APIRequestContext, age: string | null, path = '/'): Promise<void> {
  await harness(request, { ...(age ? { age } : {}), fleet });
  await signIn(page, path);
  await canvasPainted(page);
}

/** Every word and accessible name in the page, however it's offered. */
const everyWord = (page: Page): Promise<string> =>
  page.evaluate(() => [
    document.body.innerText,
    ...[...document.querySelectorAll('[aria-label],[title],[alt]')].flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt')]),
    ...[...document.querySelectorAll('[aria-live]')].map((e) => e.textContent),
  ].filter(Boolean).join('\n'));

async function openAccount(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Account' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const reportRow = (page: Page): Locator => page.getByRole('link', { name: 'Report a safety concern', exact: true });

async function settled(page: Page): Promise<void> {
  await expect(card(page)).toBeVisible();
  await card(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

/** axe on the card, as `membership.shell.spec.ts` does it and for the same reasons. */
async function expectClean(page: Page): Promise<void> {
  await settled(page);
  expect(await card(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
  await page.evaluate(AXE);
  const result = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[]; incomplete: Rule[] }> } };
    interface Rule { id: string; nodes: { target: string[]; any: { message: string }[] }[] }
    const sheet = document.styleSheets[0]!;
    const at = sheet.insertRule('.ma-shell::before { content: none !important; }', sheet.cssRules.length);
    sheet.insertRule('.window-layer { display: none !important; }', at + 1);
    try {
      const r = await w.axe.run({ include: ['.desk-notice'] }, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations', 'incomplete'],
      });
      return { violations: r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), unsure: r.incomplete.filter((v) => v.id === 'color-contrast').map((v) => v.id) };
    } finally {
      sheet.deleteRule(at + 1);
      sheet.deleteRule(at);
    }
  });
  expect(result).toEqual({ violations: [], unsure: [] });
}

async function expectFits(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const b = (await card(page).boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width - 16 + 0.5);
  expect(b.y).toBeGreaterThan(bar.y + bar.height);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settled(page);
  await page.screenshot({ path: `test-results/shots/teen-${name}.png` });
}

// ----- nothing changes without a band
test.describe('no teen', () => {
  test("today's /v1/me, with none of the fields: every app, card A word for word, no report row", async ({ page, request }) => {
    const errors = watchConsole(page);
    await arrive(page, request, null);
    expect(await appsOnDesk(page)).toEqual(ALL_APPS);
    await expect(deskGroup(page).getByRole('button', { name: /^Agent/ })).toHaveCount(1);
    await openAccount(page);
    await expect(reportRow(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('no band in /v1/me, and card A is untouched', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: { status: 'unpaid' }, platformBilling: ALLIANCE_OPEN });
    await signIn(page);
    await expect(card(page)).toHaveAttribute('data-card', 'A');
    await expect(card(page).getByRole('paragraph').first()).toHaveText(A_BODY);
    await expect(card(page).locator('.desk-notice-etch')).toHaveText(['Personal', 'Work']);
    await expect(card(page).locator('.desk-notice-alliance')).toBeVisible();
  });

  test('an adult, with the fields, has every app and the report row', async ({ page, request }) => {
    await arrive(page, request, 'adult');
    expect(await appsOnDesk(page)).toEqual(ALL_APPS);
    await openAccount(page);
    await expect(reportRow(page)).toHaveAttribute('href', REPORT);
  });

  test('an adult who has not paid has card A, Pro and all', async ({ page, request }) => {
    await harness(request, { age: 'adult', desks: 'empty', membership: { status: 'unpaid', ageBand: 'adult', adultFrom: null, parent: null }, platformBilling: ALLIANCE_OPEN });
    await signIn(page);
    await expect(card(page)).toHaveAttribute('data-card', 'A');
    await expect(card(page).locator('.desk-notice-alliance')).toBeVisible();
  });

  test('ageBand null, not answered yet, is as today', async ({ page, request }) => {
    await arrive(page, request, 'unanswered');
    expect(await appsOnDesk(page)).toEqual(ALL_APPS);
  });
});

// ----- the Agent: gone
for (const age of ['teen', 'teen-parent-done']) {
  test(`${age}: Browser, Notebook and Chat, and no Agent anywhere`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await arrive(page, request, age);
    expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
    await expect(page.getByRole('button', { name: /^Personal desk, 3 apps/ })).toHaveCount(1);
    await openAccount(page);
    expect(await everyWord(page)).not.toMatch(/\bagents?\b|claude/i);
    expect(errors).toEqual([]);
  });
}

test("a teen's Browser, Notebook and Chat all open", async ({ page, request }) => {
  await arrive(page, request, 'teen', '/?fixture=one');
  await deskGroup(page).getByRole('button', { name: /^Notebook/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: 'Notebook Personal' })).toBeVisible(); // the real Notebook, since sub/notebook-app
  await deskGroup(page).getByRole('button', { name: /^Chat/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('empty-chat')).toBeVisible();
  await deskGroup(page).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-video')).toBeVisible();
});

test('the keyboard never lands on it: every arrow from every app, then Tab through the page', async ({ page, request }) => {
  await arrive(page, request, 'teen', '/?fixture=three');
  await focusCanvas(page);
  const seen = new Set<string>();
  for (const key of ['ArrowRight', 'Enter', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowRight']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
    seen.add((await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')) ?? '');
  }
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    seen.add((await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '')) ?? '');
  }
  const words = [...seen].join('\n');
  expect(words).toMatch(/Browser|Notebook|Chat/);
  expect(words).not.toMatch(/agent|claude/i);
  await expect(page.getByTestId('window-agent')).toHaveCount(0);
});

test("a saved layout with an Agent in it, stacked under the others: gone from the desk, its menu and the hidden count", async ({ page, request }) => {
  const item = (app: string, x: number, y: number, w = 76, h = 76) => ({ id: `${DESK}:${app}`, app, x, y, w, h });
  const items = [item('chat', 100, 100), item('notebook', 300, 40), item('agent', 110, 110, 56, 56), item('browser', 80, 80, 240, 240)];
  const layout = { schemaVersion: 2, desks: { [DESK]: { x: 0, y: 0, w: 800, h: 500, items } }, z: [DESK] };
  await harness(request, { age: 'teen', fleet, layoutDocs: { [ME]: { version: 3, updatedAt: '2026-11-06T00:00:00Z', layout } } });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(800);
  expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
  // Chat is under the Browser, so one is hidden. Were the Agent still there, it would be two.
  await expect(page.getByRole('button', { name: '1 hidden app on the Personal desk' })).toHaveCount(1);
  await page.locator(`[id="proxy-${DESK}:notebook"]`).focus();
  await page.keyboard.press('.');
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await page.getByRole('menu').innerText()).not.toMatch(/agent|claude/i);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '1 hidden app on the Personal desk' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hidden-list').or(page.getByRole('menu'))).toBeVisible();
  expect(await everyWord(page)).not.toMatch(/\bagents?\b|claude/i);
});

for (const path of ['/agent', '/agent/', '/apps/agent', '/claude', '/?app=agent', '/?open=agent', '/#agent', '/?fixture=one&agent=needs-you']) {
  test(`by address: ${path} is the office, with no Agent`, async ({ page, request }) => {
    await arrive(page, request, 'teen', path);
    await expect(page.locator('.ma-shell')).toBeVisible();
    await expect(page.locator('[data-testid="empty-agent"]')).toHaveCount(0);
    await expect(page.locator('.ma-window')).toHaveCount(0);
    expect(await everyWord(page)).not.toMatch(/\bagents?\b|needs you|claude/i);
  });
}

test('a desk that reports an agent says nothing of it to a teen, and an adult still hears it', async ({ page, request }) => {
  await arrive(page, request, 'adult', '/?fixture=one&agent=needs-you');
  await expect(page.getByRole('button', { name: /^Personal desk.*needs you/ })).toHaveCount(1);
  await harness(request, { age: 'teen' });
  await page.goto('/?fixture=one&agent=needs-you');
  await canvasPainted(page);
  await page.waitForTimeout(600);
  await expect(page.getByRole('button', { name: /^Personal desk/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /needs you/ })).toHaveCount(0);
  expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
});

test('a summary already on its way when /v1/me answers is stripped too: it lands a frame later, and says nothing', async ({ page, request }) => {
  await signIn(page);
  await harness(request, { age: 'teen' });
  // Frames wait until the test lets them go, so the desk's summary is queued for a frame before the band is known.
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: FrameRequestCallback[] | null; __letFramesGo: () => void };
    const real = window.requestAnimationFrame.bind(window);
    w.__frames = [];
    w.__letFramesGo = () => {
      const held = w.__frames ?? [];
      w.__frames = null;
      for (const fn of held) real(fn);
    };
    window.requestAnimationFrame = (fn) => {
      if (!w.__frames) return real(fn);
      w.__frames.push(fn);
      return 0;
    };
  });
  let answer = (): void => {};
  const held = new Promise<void>((done) => {
    answer = done;
  });
  let answered = false;
  await page.route('**/v1/me', async (route) => {
    await held;
    await route.continue();
    answered = true;
  });
  await page.goto('/?fixture=one&agent=needs-you');
  await page.waitForFunction(() => !!(window as unknown as { __maDeskMock?: unknown }).__maDeskMock, undefined, { polling: 100 });
  await page.waitForTimeout(600);
  answer();
  await expect.poll(() => answered).toBe(true);
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as { __letFramesGo: () => void }).__letFramesGo());
  await expect.poll(() => appsOnDesk(page)).toEqual(TEEN_APPS);
  await page.waitForTimeout(400);
  await expect(page.getByRole('button', { name: /needs you|agent/i })).toHaveCount(0);
});

test('nothing asks a desk about it: no call in the mock names the Agent or Claude', async ({ page, request }) => {
  await arrive(page, request, 'teen', '/?fixture=one');
  await deskGroup(page).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-video')).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string }[] } }).__maDeskMock.rpc.map((r) => r.m));
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((m) => /agent|claude/i.test(m))).toEqual([]);
});

/**
 * The topics each desk's mock `desk-agent` has been asked for and still serves. Empty until the mock exists: a poll
 * that starts while `/v1/me` is still held runs before the mock desk link has loaded, and a throw there would end
 * the poll instead of waiting.
 */
const agentTopics = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const mock = (window as unknown as { __maDeskMock?: { agent?: { desks: Record<string, { subs: Map<number, { topic: string }> }> } } }).__maDeskMock;
    if (!mock?.agent) return [];
    return Object.values(mock.agent.desks).flatMap((desk) => [...desk.subs.values()].map((sub) => sub.topic));
  });

test("a teen's link never asks a desk for the Agent's state, and an adult's does", async ({ page, request }) => {
  await arrive(page, request, 'adult');
  await expect.poll(() => agentTopics(page)).toContain('agent.state');
  await harness(request, { age: 'teen', fleet });
  await page.goto('/');
  await canvasPainted(page);
  await expect(deskGroup(page)).toHaveCount(1);
  await page.waitForTimeout(800);
  expect(await agentTopics(page)).toEqual([]);
});

test("a link that asked before /v1/me said teen stops asking once it does", async ({ page, request }) => {
  await harness(request, { age: 'teen', ageRules: null, fleet });
  let answer = (): void => {};
  const held = new Promise<void>((done) => {
    answer = done;
  });
  await page.route('**/v1/me', async (route) => {
    await held;
    await route.continue();
  });
  await signIn(page);
  await expect(deskGroup(page)).toHaveCount(1);
  await expect.poll(() => agentTopics(page)).toContain('agent.state');
  answer();
  await expect.poll(() => appsOnDesk(page)).toEqual(TEEN_APPS);
  await expect.poll(() => agentTopics(page)).toEqual([]);
});

test("what's saved for a teen has no Agent: a move saves, as any other", async ({ page, request }) => {
  await arrive(page, request, 'teen');
  await page.waitForTimeout(800);
  await page.locator(`[id="proxy-${DESK}"]`).focus();
  await page.keyboard.press('m');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const saved = async (): Promise<string | null> => {
    const doc = ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout: unknown } | undefined> }).layoutDocs[ME];
    return doc ? JSON.stringify(doc.layout) : null;
  };
  await expect.poll(saved, { timeout: 8_000 }).toMatch(/"app":"browser"/);
  expect(await saved()).not.toMatch(/agent/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.v2')), { timeout: 3_000 }).toMatch(/"app":"browser"/);
  expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2'))).not.toMatch(/agent/);
});

test('an untouched teen has nothing to upload, and a mirror that has the desk says no Agent', async ({ page, request }) => {
  await arrive(page, request, 'teen');
  await page.waitForTimeout(3_000);
  const { layoutPuts } = (await (await request.get('/__harness')).json()) as { layoutPuts: unknown[] };
  expect(layoutPuts).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2'))).not.toMatch(/agent/);
});

test('turning 18: the same desks, with the Agent back', async ({ page, request }) => {
  await arrive(page, request, 'teen');
  expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
  await page.waitForTimeout(1200);
  await harness(request, { age: 'adult' });
  await page.reload();
  await canvasPainted(page);
  await expect.poll(() => appsOnDesk(page)).toEqual(ALL_APPS);
});

// ----- never a flash of it
/** Whether an Agent tile ever reached the page, however briefly. */
async function watchAgent(page: Page): Promise<() => Promise<boolean>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __agentSeen: boolean };
    w.__agentSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[aria-label^="Agent"]')) w.__agentSeen = true;
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
  });
  return () => page.evaluate(() => (window as unknown as { __agentSeen: boolean }).__agentSeen);
}

test('with the rules on, a slow /v1/me on a new browser: the desk waits, and the Agent never shows', async ({ page, request }) => {
  await harness(request, { age: 'teen', fleet });
  const seen = await watchAgent(page);
  let answer = (): void => {};
  const held = new Promise<void>((done) => {
    answer = done;
  });
  await page.route('**/v1/me', async (route) => {
    await held;
    await route.continue();
  });
  await signIn(page);
  await page.waitForTimeout(800);
  await expect(deskGroup(page)).toHaveCount(0);
  answer();
  await expect(deskGroup(page)).toHaveCount(1);
  expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
  expect(await seen()).toBe(false);
});

test('with the rules on and /v1/me failing on a new browser: no desk, the calm line, and it comes back', async ({ page, request }) => {
  await harness(request, { age: 'teen', fleet });
  const seen = await watchAgent(page);
  let failing = true;
  await page.route('**/v1/me', async (route) => {
    if (failing) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"unavailable","message":"Try again."}' });
    else await route.continue();
  });
  await signIn(page);
  await expect(page.getByTestId('desks-error')).toBeVisible();
  await expect(deskGroup(page)).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(deskGroup(page)).toHaveCount(1);
  expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
  expect(await seen()).toBe(false);
});

test('with the rules on, an adult on a new browser waits for /v1/me too, and then has every app', async ({ page, request }) => {
  await harness(request, { age: 'adult', fleet });
  await signIn(page);
  await expect(deskGroup(page)).toHaveCount(1);
  expect(await appsOnDesk(page)).toEqual(ALL_APPS);
});

test('with the rules on, a browser that knows the desk paints from its mirror and never waits', async ({ page, request }) => {
  await arrive(page, request, 'teen');
  await page.waitForTimeout(1200); // the mirror's write
  const seen = await watchAgent(page);
  await page.route('**/v1/me', async (route) => {
    await new Promise((done) => setTimeout(done, 3_000));
    await route.continue();
  });
  await page.goto('/');
  await expect(deskGroup(page)).toHaveCount(1, { timeout: 2_500 });
  expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
  expect(await seen()).toBe(false);
});

test('with the rules off, nothing waits for /v1/me, and a teen still ends up with no Agent', async ({ page, request }) => {
  await harness(request, { age: 'teen', ageRules: null, fleet });
  let answer = (): void => {};
  const held = new Promise<void>((done) => {
    answer = done;
  });
  await page.route('**/v1/me', async (route) => {
    await held;
    await route.continue();
  });
  await signIn(page);
  await expect(deskGroup(page)).toHaveCount(1);
  expect(await appsOnDesk(page)).toEqual(ALL_APPS);
  answer();
  await expect.poll(() => appsOnDesk(page)).toEqual(TEEN_APPS);
  await openAccount(page);
  await expect(reportRow(page)).toHaveCount(0);
});

test("a teen's sign-in in another tab takes the Agent from this one, once the token shows it", async ({ page, request }) => {
  // Short-lived tokens, so every call asks for one, and picks up whatever's stored by then.
  await harness(request, { expiresIn: 60 });
  await arrive(page, request, 'adult');
  expect(await appsOnDesk(page)).toEqual(ALL_APPS);
  // The refresh token in this browser becomes someone else's. This tab finds out as a layout call is about to go.
  await harness(request, { age: 'teen', userId: 'u-teen' });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => appsOnDesk(page), { timeout: 8_000 }).toEqual(TEEN_APPS);
});

// ----- the bandwidth words
test('a teen hears only of what they have when the Browser pauses', async ({ page, request }) => {
  const GB = 1e9;
  const now = new Date();
  const resets = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  const win = (limitGb: number) => ({ usedBytes: 3 * GB, usedGb: 3, limitGb, startsAt: new Date(now.getTime() - 86_400_000).toISOString(), resetsAt: resets });
  await harness(request, { bandwidth: { tier: 'alliance', week: win(3), month: win(10), state: 'limit', limitedBy: 'week', warnAtPct: 80, enforced: true, paused: true, resumesAt: resets, asOf: now.toISOString(), pollAfterSeconds: 1 } });
  await arrive(page, request, 'teen', '/?fixture=one');
  await deskGroup(page).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('bandwidth-paused')).toContainText('Notebook keeps working, and your tabs are safe.');
  expect(await everyWord(page)).not.toMatch(/\bagents?\b/i);
});

// ----- the cards
for (const theme of THEMES) {
  test.describe(`a teen's cards in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await setTheme(page, theme);
    });

    test('waiting on a parent: one calm card, axe clean', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { age: 'teen-parent-pending' });
      await signIn(page);
      await expect(card(page)).toHaveAttribute('data-card', 'P');
      await expect(card(page).getByRole('heading', { name: PARENT_TITLE })).toBeVisible();
      await expect(card(page).getByRole('paragraph')).toHaveText(PARENT_BODY);
      await expect(card(page).getByRole('link', { name: 'Send the email again', exact: true })).toHaveAttribute('href', ACCOUNT);
      await expect(card(page).locator('.btn')).toHaveCount(0);
      await expect(card(page).locator('.desk-notice-pics')).toHaveCount(0);
      expect(await card(page).innerText()).not.toMatch(/\bpay|billing|price|\$|membership|checkout|\bPro\b|officer|\bage\b|\bteen/i);
      await expect(page.getByRole('region', { name: PARENT_TITLE })).toBeVisible();
      await expectClean(page);
      await shoot(page, `parent-${theme}`);
      expect(errors).toEqual([]);
    });

    test('unpaid: one small desk, axe clean', async ({ page, request }) => {
      await harness(request, { age: 'teen-unpaid', platformBilling: ALLIANCE_OPEN });
      await signIn(page);
      await expect(card(page)).toHaveAttribute('data-card', 'T');
      await expect(card(page).getByRole('heading', { name: 'Welcome to your office' })).toBeVisible();
      await expect(card(page).getByRole('paragraph')).toHaveText(TEEN_BODY);
      await expect(card(page).locator('.desk-notice-etch')).toHaveText(['Personal']);
      await expect(card(page).getByRole('link', { name: 'How joining works', exact: true })).toHaveAttribute('href', ACCOUNT);
      await expect(card(page).getByRole('link', { name: 'See membership' })).toHaveCount(0);
      await expect(card(page).locator('.desk-notice-alliance')).toHaveCount(0);
      expect(await card(page).innerText()).not.toMatch(/\bPro\b|officer|\$|\bwork\b|\bage\b|\bteen/i);
      await expectClean(page);
      await shoot(page, `welcome-${theme}`);
    });

    test('a phone: both fit, axe clean', async ({ page, request }) => {
      await page.setViewportSize(PHONE);
      await harness(request, { age: 'teen-parent-pending' });
      await signIn(page);
      await expect(card(page)).toHaveAttribute('data-card', 'P');
      await expectFits(page);
      await expectClean(page);
      const link = await card(page).getByRole('link').boundingBox();
      expect(link!.height).toBeGreaterThanOrEqual(44);
      await shoot(page, `parent-phone-${theme}`);
      await harness(request, { age: 'teen-unpaid', platformBilling: ALLIANCE_OPEN });
      await page.reload();
      await expect(card(page)).toHaveAttribute('data-card', 'T');
      await expectFits(page);
      await expectClean(page);
      await shoot(page, `welcome-phone-${theme}`);
    });

    test('the account menu with the report row', async ({ page, request }) => {
      await arrive(page, request, 'teen');
      await openAccount(page);
      await expect(reportRow(page)).toBeVisible();
      await page.screenshot({ path: `test-results/shots/teen-report-row-${theme}.png` });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      await page.screenshot({ path: `test-results/shots/teen-desk-${theme}.png` });
    });
  });
}

test('the pending card waits for nothing about Pay, and asks nothing of it', async ({ page, request }) => {
  await harness(request, { age: 'teen-parent-pending', platformBilling: ALLIANCE_OPEN });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'P');
  const log = ((await (await request.get('/__harness')).json()) as { log: string[] }).log;
  expect(log.filter((l) => l === 'client-config platform-web')).toEqual([]);
});

test('the pending card by keyboard and screen reader: the link keeps Enter, and it is said once', async ({ page, request }) => {
  await harness(request, { age: 'teen-parent-pending', accountLink: 'https://platform.localhost/account' });
  await signIn(page);
  await expect(card(page)).toBeVisible();
  await expect(page.locator('[aria-live]').filter({ hasText: `${PARENT_TITLE}.` })).toHaveCount(1);
  await expect(page.locator('[aria-live]').filter({ hasText: PARENT_BODY })).toHaveCount(1);
  const link = card(page).getByRole('link', { name: 'Send the email again', exact: true });
  await link.focus();
  await expect(link).toBeFocused();
  let asked = false;
  await page.route('https://platform.localhost/**', async (route) => {
    asked = true;
    await route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => asked).toBe(true);
});

test('with no good account link the pending card still says what is happening, and offers nothing', async ({ page, request }) => {
  await harness(request, { age: 'teen-parent-pending', accountLink: null });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'P');
  await expect(card(page).getByRole('link')).toHaveCount(0);
  await expect(card(page).getByRole('paragraph')).toHaveText(PARENT_BODY);
});

test('once the parent has agreed, the card moves on by itself', async ({ page, request }) => {
  await harness(request, { age: 'teen-parent-pending', platformBilling: ALLIANCE_OPEN });
  await page.route('**/v1/desks*', async (route) => {
    const res = await route.fetch();
    // A 304 says the same again, and has no body to change.
    if (res.status() !== 200) await route.fulfill({ response: res });
    else await route.fulfill({ response: res, json: { ...((await res.json()) as Record<string, unknown>), pollAfterSeconds: 1 } });
  });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'P');
  await harness(request, { age: 'teen-unpaid-parent-done' });
  await expect(card(page)).toHaveAttribute('data-card', 'T', { timeout: 10_000 });
});

test('a parent who has agreed and not paid: the same one small desk, never Pro', async ({ page, request }) => {
  await harness(request, { age: 'teen-unpaid-parent-done', platformBilling: ALLIANCE_OPEN });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'T');
  await expect(card(page).getByRole('link', { name: 'How joining works', exact: true })).toHaveAttribute('href', ACCOUNT);
});

test('Pro on sale and Alliance not: a teen is offered nothing, and told it opens soon', async ({ page, request }) => {
  await harness(request, { age: 'teen-unpaid', platformBilling: PRO_OPEN });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'T');
  await expect(card(page).getByRole('link')).toHaveCount(0);
  await expect(card(page).locator('.desk-notice-soon')).toHaveText('Membership opens soon.');
});

test('Platform not answering: a teen is offered nothing and promised nothing', async ({ page, request }) => {
  await harness(request, { age: 'teen-unpaid', platformBilling: 'fail' });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'T');
  await expect(card(page).getByRole('link')).toHaveCount(0);
  await expect(card(page).locator('.desk-notice-soon')).toHaveCount(0);
});

test('a held or ended teen keeps card F, with no word about a parent', async ({ page, request }) => {
  await harness(request, { age: 'teen-parent-pending', desks: 'empty', membership: { status: 'suspended', tier: 'alliance', ageBand: 'teen', adultFrom: '2029-08-01', parent: 'pending' } });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'F');
  expect(await card(page).innerText()).not.toMatch(/parent|guardian/i);
});

// ----- the report row
test('the report row: everyone where the rules are on, in its own tab, on the Platform app', async ({ page, request }) => {
  for (const age of ['teen', 'adult', 'teen-parent-pending']) {
    await harness(request, { reset: true });
    await harness(request, { age, fleet });
    await signIn(page);
    await openAccount(page);
    await expect(reportRow(page)).toHaveAttribute('href', REPORT);
    await expect(reportRow(page)).toHaveAttribute('target', '_blank');
    await expect(reportRow(page)).toHaveAttribute('rel', 'noopener');
    await page.evaluate(() => localStorage.clear());
  }
});

test('the report row with the rules off, or no good link: not there', async ({ page, request }) => {
  await harness(request, { fleet, ageRules: { enabled: false } });
  await signIn(page);
  await openAccount(page);
  await expect(reportRow(page)).toHaveCount(0);
  await harness(request, { ageRules: { enabled: true }, accountLink: 'https://evil.example/account' });
  await page.reload();
  await openAccount(page);
  await expect(reportRow(page)).toHaveCount(0);
});

test('the report row by keyboard: Tab reaches it, and the menu closes as the page opens', async ({ page, request }) => {
  await arrive(page, request, 'teen');
  await openAccount(page);
  await reportRow(page).focus();
  await expect(reportRow(page)).toBeFocused();
  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    page.keyboard.press('Enter'),
  ]);
  await popup.close();
  await expect(page.getByRole('dialog', { name: 'Account' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeFocused();
});

// ----- Maia follows what the server says
for (const [what, maia] of [
  ['enabled: false', { enabled: false }],
  ['a 403', { stateStatus: 403 }],
  ['a 503', { stateStatus: 503 }],
] as const) {
  test(`Maia for a teen, when her state says ${what}: nothing of her, and nothing broken`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { age: 'teen', fleet, maia });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(800);
    await expect(page.locator('.maia-launcher')).toHaveCount(0);
    await expect(page.locator('.ma-shell')).toBeVisible();
    expect(await appsOnDesk(page)).toEqual(TEEN_APPS);
    // A browser logs its own line for a failed request, which no app code can stop.
    expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
  });
}

test('Maia for a teen the server gives her to: the widget, with no logic of its own', async ({ page, request }) => {
  await harness(request, { age: 'teen', fleet, maia: { enabled: true } });
  await signIn(page);
  await canvasPainted(page);
  await expect(page.locator('.maia-launcher')).toBeVisible();
  // A teen has no desk agents, so Maia's panel never points them to any.
  await page.locator('.maia-launcher').click();
  const panel = page.getByRole('dialog', { name: 'Maia' });
  await expect(panel).toContainText('Ask about your desks, your account, or your office. I can be wrong.');
  await expect(panel).toContainText('Chats are kept 30 days and pass through us.');
  await expect(panel).not.toContainText('desk agents');
});
