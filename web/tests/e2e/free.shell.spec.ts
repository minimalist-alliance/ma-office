// The free tier in the office (S-119; the Product Designer's draft, `~/ma-coord/design-drafts/free-tier/`), against the
// harness's stand-ins for the wire Platform hasn't written yet (`src/free/wire.ts`): `/v1/me` saying `tier: "free"`, the
// meter's `browserTime`, Maia's `trial`, and MockDeskLink's `desk.contention`. Today's time on the meter, the heads-up once
// a day across reloads, the paused Browser, "Not now" kept in the layout document's `prefs`, Maia's trial and its end (and
// its line in the usage panel), the upgrade's beat with and without reduced motion, the Work desk appearing in place, a
// teen, and a paying member who sees none of it. axe in Light and Dark. (The Work desk spot and the account menu's See
// membership are the setup circle's after-setup card now: the Designer's Nov 9, 9:15 pm change.)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const DAY = 86_400_000;
const GB = 1e9;
const ME = 'u-test';
const ACCOUNT = 'https://platform.localhost/account';
const FREE = { status: 'active', tier: 'free', ageBand: 'adult', adultFrom: null, parent: null };
const TEEN = { status: 'active', tier: 'free', ageBand: 'teen', adultFrom: '2029-08-01', parent: null };
const AGE_RULES = { enabled: true, minimumAge: 13, adultAge: 18 };
// Platform's list, not a fixture: a fixture's layout never goes anywhere, and `prefs` ride in the layout document.
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const desk = (deskId: string, name: string, kind: string, state: string) => ({ deskId, name, kind, state });
const ONE = [desk(PERSONAL, 'Personal', 'personal', 'running')];

// Midnight is the member's own: the page and these numbers both run in UTC, so today's reset is "midnight".
test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** The meter as Platform would answer a free member (proposed): the usual windows, and today's Browser time. */
function freeMeter(usedMin: number, limitMin = 45): Record<string, unknown> {
  const now = Date.now();
  const start = Math.floor(now / DAY) * DAY;
  const win = (limitGb: number) => ({ usedBytes: 0.2 * GB, usedGb: 0.2, limitGb, startsAt: new Date(start).toISOString(), resetsAt: new Date(start + 7 * DAY).toISOString() });
  return {
    tier: 'free', week: win(3), month: win(10), state: 'ok', limitedBy: null, warnAtPct: 80, enforced: true, paused: false, resumesAt: null,
    asOf: new Date(now).toISOString(), pollAfterSeconds: 1,
    browserTime: { usedSeconds: Math.min(usedMin, limitMin) * 60, limitSeconds: limitMin * 60, startsAt: new Date(start).toISOString(), resetsAt: new Date(start + DAY).toISOString() },
  };
}

/** After an upgrade: no day's limit, so no `browserTime`, and the Alliance tier's month. */
function paidMeter(): Record<string, unknown> {
  const m = freeMeter(0);
  delete m['browserTime'];
  return { ...m, tier: 'alliance' };
}

interface Harness { layoutDocs: Record<string, { layout?: { prefs?: Record<string, unknown> } } | undefined>; log: string[] }
const server = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const savedPrefs = async (request: APIRequestContext): Promise<Record<string, unknown>> => (await server(request)).layoutDocs[ME]?.layout?.prefs ?? {};

const meter = (page: Page): Locator => page.getByTestId('free-meter-button');
const notice = (page: Page): Locator => page.getByTestId('free-notice');
const tile = (page: Page, app: string): Locator => page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: new RegExp(`^${app}`) });
const maiaPanel = (page: Page): Locator => page.getByRole('dialog', { name: 'Maia' });

async function arrive(page: Page, request: APIRequestContext, opts: { usedMin?: number; membership?: Record<string, unknown>; path?: string; more?: Record<string, unknown> } = {}): Promise<void> {
  await harness(request, { membership: opts.membership ?? FREE, bandwidth: freeMeter(opts.usedMin ?? 19), fleet: ONE, ...opts.more });
  await signIn(page, opts.path ?? '/');
  await canvasPainted(page);
  await expect(meter(page)).toBeVisible();
}

async function openApp(page: Page, app: string): Promise<void> {
  await tile(page, app).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: new RegExp(app) })).toBeVisible();
}

/** All desks in view, as Esc gives. */
async function overview(page: Page): Promise<void> {
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
}

/** Back in the tab after paying in another one: the office asks `/v1/me`, the meter and the desk list again. */
async function comeBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string; p: Record<string, unknown> }[] } }).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

/**
 * axe at WCAG 2.2 AA and best practice on what's given, with the ground's gradient (which it can't measure past) taken
 * away. Contrast it can't decide counts too, with its reason, unless `unsureOk`: the meter's panel is the bandwidth
 * panel's own look, which floats over the canvas, and axe can't see under it.
 */
async function axe(page: Page, include: string, unsureOk = false): Promise<string[]> {
  // Every finite animation done (a panel's fade-in included), so axe sees what stays.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await page.evaluate(AXE);
  return page.evaluate(async ([sel, ok]) => {
    interface Rule { id: string; nodes: { target: string[]; any: { message: string }[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[]; incomplete: Rule[] }> } };
    const sheet = document.styleSheets[0]!;
    const at = sheet.insertRule('.ma-shell::before { content: none !important; }', sheet.cssRules.length);
    try {
      const r = await w.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations', 'incomplete'] });
      const say = (v: Rule) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`;
      const why = (v: Rule) => v.nodes.map((n) => `unsure ${n.target.join(' ')}: ${n.any.map((a) => a.message).join('; ')}`);
      return [...r.violations.map(say), ...(ok ? [] : r.incomplete.filter((v) => v.id === 'color-contrast').flatMap(why))];
    } finally {
      sheet.deleteRule(at);
    }
  }, [include, unsureOk] as const).then((r) => r);
}

for (const theme of ['light', 'dark'] as ThemeId[]) {
  test(`${theme}: the meter shows today's Browser time, emptying as it's used, with the tier that has no daily limit`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request);
    await expect(meter(page)).toHaveAccessibleName('Browser time today: 19 of 45 minutes used. Resets at midnight.');
    // The bandwidth circle stands aside: one meter.
    await expect(page.getByTestId('bandwidth-button')).toHaveCount(0);
    // The ring is what's left: 26 of 45.
    expect(Number((await page.locator('.free-meter .bw-fill').getAttribute('stroke-dasharray'))!.split(' ')[0])).toBeCloseTo(57.8, 0);

    await meter(page).click();
    const panel = page.getByTestId('free-meter-panel');
    await expect(panel).toContainText('Browser time');
    await expect(panel).toContainText('19 of 45 minutes used');
    await expect(panel).toContainText('Resets at midnight');
    await expect(panel.getByTestId('free-meter-line')).toHaveText('Alliance Member has no daily limit.');
    const link = panel.getByRole('link', { name: 'See membership (opens in a new tab)' });
    await expect(link).toHaveAttribute('href', ACCOUNT);
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await axe(page, '.free-panel', true)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test(`${theme}: Maia sleeps with her trial on offer, "Not now" is kept for the account, and the week starts`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request, { more: { maia: { enabled: true, trial: 'unused' } } });
    const launcher = page.locator('.maia-launcher');
    await expect(launcher).toBeVisible();
    const state = (): Promise<string> => page.evaluate(() => (window as unknown as { __maMaia: { stats: () => { state: string } } }).__maMaia.stats().state);
    await expect.poll(state).toMatch(/sleeping|falling/);

    await launcher.click();
    const trial = page.getByTestId('maia-trial');
    await expect(trial).toHaveText(/^Maia knows your office and can help with it\. Try her free for a week, or up to \$1 of her time, whichever ends first\./);
    await expect(trial.getByRole('button', { name: 'Start the week' })).toBeFocused();
    expect(await axe(page, '.maia-trial')).toEqual([]);
    // The card is the whole panel: no Ask box until the week starts, so nothing typed can start it unchosen.
    await expect(page.getByRole('textbox', { name: 'Message to Maia' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    // Nor her first asks (walk finding 8): pressing one sent a turn, which started the week unchosen and left no box behind.
    await expect(page.getByTestId('maia-asks')).toHaveCount(0);
    // Pressing her doesn't wake her: only starting the week does.
    await expect.poll(state).toMatch(/sleeping|falling/);

    await trial.getByRole('button', { name: 'Not now' }).click();
    await expect(maiaPanel(page)).toHaveCount(0);
    await expect.poll(async () => typeof (await savedPrefs(request))['maiaTrialNotNow'], { timeout: 15_000 }).toBe('string');
    // She asks nothing by herself; pressed again, the card is the member asking.
    await page.reload();
    await canvasPainted(page);
    await expect(maiaPanel(page)).toHaveCount(0);
    await launcher.click();
    await expect(page.getByTestId('maia-trial')).toBeVisible();

    await page.getByRole('button', { name: 'Start the week' }).click();
    await expect(page.getByTestId('maia-trial')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message to Maia' })).toBeFocused();
    await expect(page.getByTestId('maia-asks').getByRole('button').first()).toHaveText('Show me around my office');
    await expect.poll(state).not.toMatch(/sleeping|falling/);
    // The first message starts the week (`trial_started`, which says nothing more), and the stop that ends it shows the trial's last word.
    await page.getByRole('textbox', { name: 'Message to Maia' }).fill('Hello');
    await page.keyboard.press('Enter');
    await expect(page.locator('#maia-panel').getByText('You asked: Hello.')).toBeVisible();
    await expect(page.locator('.maia-note')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message to Maia' }).fill('[stub:trial-over]');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('maia-trial-ended')).toContainText("That was Maia's week. She comes with every membership.");
    await expect(page.getByRole('textbox', { name: 'Message to Maia' })).toHaveCount(0);
    await expect.poll(state).toMatch(/sleeping|falling/);
    expect(errors).toEqual([]);
  });

  test(`${theme}: at the day's limit the Browser pauses in its window, and Notebook keeps working`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, request);
    await openApp(page, 'Browser');
    await expect(page.getByTestId('browser-video')).toBeVisible();
    await expect.poll(() => streamCalls(page)).toContain('live');

    await harness(request, { bandwidth: freeMeter(45) });
    const paused = page.getByTestId('bandwidth-paused');
    await expect(paused).toBeVisible();
    await expect(paused.getByRole('heading')).toHaveText('The Browser is paused until midnight');
    await expect(paused).toContainText("That's today's free Browser time. Notebook and Agent keep working, and your tabs are safe.");
    const link = paused.getByRole('link', { name: 'Alliance Member has no daily limit (opens in a new tab)' });
    await expect(link).toHaveAttribute('href', ACCOUNT);
    await expect(page.getByTestId('browser-video')).toHaveCount(0);
    await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('off');
    await expect(meter(page)).toHaveAccessibleName('Browser time today: 45 of 45 minutes used. Resets at midnight.');
    await expect(page.locator('.free-meter .bw-fill')).toHaveCount(0); // empty
    // Said once, through the shell's live region.
    await expect(page.getByTestId('live-region')).toHaveText("The Browser is paused until midnight. That's today's free Browser time. Notebook and Agent keep working, and your tabs are safe.");
    expect(await axe(page, '.bw-paused')).toEqual([]);
    // It holds past the meter's own minute, which would otherwise ask the desk again.
    await page.waitForTimeout(2_500);
    await expect(paused).toBeVisible();

    await openApp(page, 'Notebook');
    await expect(page.getByTestId('note-editor')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('10 minutes before the limit, one notice, once a day for the account, across reloads and browsers', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await harness(request, { bandwidth: freeMeter(36) });
  await expect(notice(page)).toHaveText('9 minutes of Browser time left today. Resets at midnight.');
  await expect(page.getByTestId('live-region')).toHaveText('9 minutes of Browser time left today. Resets at midnight.');
  // No link: it's information, not a pitch. Gone after 8 s.
  await expect(notice(page).getByRole('link')).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0, { timeout: 10_000 });
  const startsAt = (freeMeter(36)['browserTime'] as { startsAt: string }).startsAt;
  await expect.poll(async () => (await savedPrefs(request))['freeSaidOn'], { timeout: 15_000 }).toBe(startsAt);

  await page.reload();
  await canvasPainted(page);
  await page.waitForTimeout(4_000);
  await expect(notice(page)).toHaveCount(0);
  // Another browser has no copy of its own: the account's document still says it's been said today.
  await page.evaluate(() => localStorage.removeItem('ma.free.prefs.v1'));
  await page.reload();
  await canvasPainted(page);
  await page.waitForTimeout(4_000);
  await expect(notice(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Maia's trial over: asleep, and pressed, its last word with See membership and no composer", async ({ page, request }) => {
  await arrive(page, request, { more: { maia: { enabled: true, trial: 'ended' } } });
  await page.locator('.maia-launcher').click();
  const ended = page.getByTestId('maia-trial-ended');
  await expect(ended).toContainText("That was Maia's week. She comes with every membership.");
  await expect(ended.getByRole('link', { name: 'See membership (opens in a new tab)' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Message to Maia' })).toHaveCount(0);
  expect(await axe(page, '[data-testid="maia-trial-ended"]')).toEqual([]);
});

test("a desk that says it's held back gets one line in the Browser's bar, the first time in a day", async ({ page, request }) => {
  await arrive(page, request);
  await openApp(page, 'Browser');
  const held = (on: boolean): Promise<void> =>
    page.evaluate(([id, v]) => (window as unknown as { __maDeskMock: { setHeld: (d: string, h: boolean) => void } }).__maDeskMock.setHeld(id as string, v as boolean), [PERSONAL, on] as const);
  await held(true);
  await expect(page.getByTestId('free-busy')).toHaveText('Free desks share more, so busy times can be slower.');
  await held(false);
  await expect(page.getByTestId('free-busy')).toHaveCount(0);
  // Once a day: the next time it's held today, nothing more is said.
  await held(true);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('free-busy')).toHaveCount(0);
});

for (const reduce of [false, true]) {
  test(`the upgrade plays one beat${reduce ? ', instant under reduced motion' : ''}: the meter hands back, the Browser comes back, one notice`, async ({ page, request }) => {
    const errors = watchConsole(page);
    if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
    await arrive(page, request, { usedMin: 45, more: { maia: { enabled: true, trial: 'unused' } } });
    await openApp(page, 'Browser');
    await expect(page.getByTestId('bandwidth-paused')).toBeVisible();
    // How long the free meter outlives the notice that says the membership has started.
    await page.evaluate(() => {
      const w = window as unknown as { __beat: { notice?: number; meterGone?: number } };
      w.__beat = {};
      new MutationObserver(() => {
        const now = performance.now();
        if (!w.__beat.notice && document.querySelector('[data-testid="free-notice"]')) w.__beat.notice = now;
        if (w.__beat.notice && !w.__beat.meterGone && !document.querySelector('[data-testid="free-meter"]')) w.__beat.meterGone = now;
      }).observe(document.body, { childList: true, subtree: true });
    });

    await harness(request, { membership: { ...FREE, tier: 'alliance' }, bandwidth: paidMeter(), maia: { enabled: true } });
    await comeBack(page);
    await expect(notice(page)).toHaveText('Your membership has started. Your desk keeps everything, with more room now.');
    await expect(page.getByTestId('live-region')).toHaveText('Your membership has started. Your desk keeps everything, with more room now.');
    await expect(page.getByTestId('bandwidth-button')).toBeVisible();
    await expect(page.getByTestId('free-meter')).toHaveCount(0);
    const beat = await page.evaluate(() => {
      const b = (window as unknown as { __beat: { notice: number; meterGone: number } }).__beat;
      return b.meterGone - b.notice;
    });
    if (reduce) expect(beat).toBeLessThan(150);
    // About 600 ms from the change to the hand-back, less the notice's own render on a busy machine.
    else expect(beat).toBeGreaterThan(300);
    // The paused Browser lifts on the same tabs, and the desk is asked for the picture again.
    await expect(page.getByTestId('bandwidth-paused')).toHaveCount(0);
    await expect(page.getByTestId('browser-video')).toBeVisible();
    await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
    // Maia is asked again, and wakes: no trial card now. (The Browser fills the office, so she's pressed as a key would.)
    await page.locator('.maia-launcher').evaluate((el) => (el as HTMLButtonElement).click());
    await expect(maiaPanel(page)).toBeVisible();
    await expect(page.getByTestId('maia-trial')).toHaveCount(0);
    // She is awake, with her eyes open, and stays so.
    const maiaState = (): Promise<string> => page.evaluate(() => (window as unknown as { __maMaia: { stats: () => { state: string } } }).__maMaia.stats().state);
    await expect.poll(maiaState).not.toMatch(/sleeping|falling/);
    await page.waitForTimeout(1_500);
    expect(await maiaState()).not.toMatch(/sleeping|falling/);
    // The account menu has the new tier, and no See membership.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Account' }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId('menu-tier')).toHaveText('Alliance Member');
    await expect(page.getByTestId('menu-membership')).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0, { timeout: 8_000 });
    expect(errors).toEqual([]);
  });
}

test('taking Officer, the Work desk simply appears where the list puts it, with the one notice', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await overview(page);
  // No spot to rise from: the setup circle's card holds the offer, so nothing on the canvas hints at a Work desk.
  await expect(page.getByRole('button', { name: 'Room for a Work desk' })).toHaveCount(0);
  await expect(page.locator(`#proxy-${WORK}`)).toHaveCount(0);

  await harness(request, { membership: { ...FREE, tier: 'officer' }, bandwidth: paidMeter(), fleet: [...ONE, desk(WORK, 'Work', 'work', 'provisioning')] });
  await comeBack(page);
  await expect(notice(page)).toHaveText('Your membership has started. This desk keeps everything, and your Work desk is on its way.');
  const work = page.locator(`#proxy-${WORK}`);
  await expect(work).toBeAttached();
  await expect(work).toHaveAccessibleName(/^Work desk, \d+ apps, setting up/);
  expect(errors).toEqual([]);
});

test('a teen on the free tier: the same office, with nothing for adults', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request, { membership: TEEN, more: { ageRules: AGE_RULES } });
  await overview(page);
  await expect(page.locator(`#proxy-${PERSONAL}`)).toBeAttached();
  await meter(page).click();
  await expect(page.getByTestId('free-meter-line')).toHaveText('Alliance Member has no daily limit.');
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByTestId('menu-tier')).toHaveText('Free');
  // See membership is the setup circle's card now, so the menu keeps only the tier's name.
  await expect(page.getByTestId('menu-membership')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openApp(page, 'Browser');
  await harness(request, { bandwidth: freeMeter(45) });
  await expect(page.getByTestId('bandwidth-paused')).toContainText("That's today's free Browser time. Notebook keeps working, and your tabs are safe.");
  const words = await page.locator('body').innerText();
  expect(words).not.toMatch(/Officer|Work desk|Agent/);
  expect(errors).toEqual([]);
});

test('a paying member sees none of it, and never fetches the free chunk', async ({ page, request }) => {
  const errors = watchConsole(page);
  const asked: string[] = [];
  page.on('request', (r) => {
    if (/\/office-[\w-]+\.js$/.test(r.url())) asked.push(r.url());
  });
  await harness(request, { maia: { enabled: true }, fleet: ONE });
  await signIn(page, '/');
  await canvasPainted(page);
  await expect(page.getByTestId('bandwidth-button')).toBeVisible();
  await overview(page);
  await expect(page.getByTestId('free-meter')).toHaveCount(0);
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByTestId('menu-tier')).toHaveText('Officer');
  await expect(page.getByTestId('menu-membership')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.maia-launcher').click();
  await expect(page.getByRole('textbox', { name: 'Message to Maia' })).toBeFocused();
  await expect(page.getByTestId('maia-trial')).toHaveCount(0);
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

test('a free desk with no room yet says so in its waking panel, with no link, and the Browser comes when there is room', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openApp(page, 'Browser');
  const busy = (on: boolean): Promise<void> =>
    page.evaluate(([id, v]) => (window as unknown as { __maDeskMock: { setBusy: (d: string, b: boolean) => void } }).__maDeskMock.setBusy(id as string, v as boolean), [PERSONAL, on] as const);
  await busy(true);
  const win = page.getByTestId('browser-app');
  await expect(win).toContainText('Free desks are all busy right now.');
  await expect(win).toContainText(/Yours is saved, and we.ll keep trying\./);
  await expect(win.getByRole('link')).toHaveCount(0);
  await busy(false);
  await expect(win).not.toContainText('Free desks are all busy right now.');
  expect(errors).toEqual([]);
});

test("the account menu keeps its modal's structure and shows only the tier's name for a free member", async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByTestId('menu-tier')).toHaveText('Free');
  await expect(page.getByTestId('menu-membership')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Account' }).getByRole('link', { name: /See membership/ })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Account settings', exact: true })).toHaveAttribute('aria-haspopup', 'dialog');
  expect(errors).toEqual([]);
});

const TRIAL_LINES: [string, string | RegExp][] = [
  ['unused', 'Maia: free for a week or up to $1, starting with your first message'],
  ['active', /^Maia: free trial until \w{3} \d{1,2}$/],
  ['ended', 'Maia: trial ended'],
];
for (const [status, words] of TRIAL_LINES) {
  test(`the usage panel says Maia's trial ${status}, under the numbers`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await arrive(page, request, { more: { maia: { enabled: true, trial: status } } });
    await meter(page).click();
    const line = page.getByTestId('free-meter-trial');
    await expect(line).toBeVisible();
    await expect(line).toHaveText(words);
    await page.screenshot({ path: `test-results/shots/free-usage-trial-${status}.png` });
    expect(errors).toEqual([]);
  });
}

test('no trial line where Maia is not open to the member', async ({ page, request }) => {
  await arrive(page, request);
  await meter(page).click();
  await expect(page.getByTestId('free-meter-panel')).toBeVisible();
  await expect(page.getByTestId('free-meter-trial')).toHaveCount(0);
});

test('the meter\'s panel opens over Maia\'s open panel, so See membership takes the click (walk finding 10)', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request, { more: { maia: { enabled: true, trial: 'active' } } });
  await page.locator('.maia-launcher').click();
  await expect(maiaPanel(page)).toBeVisible();
  await meter(page).click();
  const link = page.getByTestId('free-meter-membership');
  await expect(link).toBeVisible();
  // What a press at the link's middle would reach: the link itself, never Maia's log under it.
  const box = (await link.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid') ?? null, [box.x + box.width / 2, box.y + box.height / 2] as const);
  expect(hit).toBe('free-meter-membership');
  // Both are still open: the meter's panel didn't close hers, and the top bar's menu would still go over both.
  await expect(maiaPanel(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('Account settings says Free under the member\'s name, as the account menu does (free code read #19)', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByTestId('menu-tier')).toHaveText('Free');
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Account settings', exact: true });
  await expect(settings).toBeVisible();
  // The office's own CSP refuses the account frame here (settings.shell.spec.ts, "refused by the office's own CSP"), so the
  // modal shows who's signed in itself: that block is where a free member had no tier line.
  await expect(settings.getByTestId('account-fallback')).toBeVisible();
  await expect(settings.getByTestId('settings-tier')).toHaveText('Free');
  expect(errors.filter((e) => !e.includes('Content Security Policy'))).toEqual([]);
});
