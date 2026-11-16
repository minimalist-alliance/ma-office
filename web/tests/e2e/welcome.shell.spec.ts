// Maia's welcome (design-drafts/maia-welcome/CONCEPT.md, direction A, the owner's pick and his change of Nov 15: an input for
// their own words at every question). A new member's first load opens on the threshold; "Begin quietly" plays the whole
// welcome with captions; their own words and taps both answer; the interviewer's ack, echo, placement and follow-up show; a
// late model falls back to the scripted echo in 2.5 s; the scripted path past a cap; a key typed is cleared and never sent;
// the member's name and Q4's names never reach the Platform; a teen never calls it; "I'll explore myself" is today's first
// load; Pause and Finish later, then L3; Here's what I heard, Looks right, the reveal and the office after; who it isn't for;
// the kill switch; axe on the threshold, a question and the summary, in Light, Zen and Dark, desktop and phone.
// `WELCOME_SHOTS=<dir>` writes the screens in three themes and on a phone for the brand review.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['WELCOME_SHOTS'] ?? '';
const now = (): string => new Date(Date.now() - 60_000).toISOString();
const PERSONAL = { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' };
const WORK_BUILDING = { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'requested' };
const WORK = { ...WORK_BUILDING, state: 'running' };
/** A new Officer: the membership began a minute ago. */
const NEW = { membership: { status: 'active', tier: 'officer', billingAnchor: now() }, displayName: 'Dana Example' };

const line = (page: Page) => page.getByTestId('welcome-line');
const welcome = (page: Page) => page.getByTestId('welcome');
const chip = (page: Page, id: string) => page.locator(`.wl-chip[data-choice="${id}"]`);

async function newMember(page: Page, request: APIRequestContext, extra: Record<string, unknown> = {}, path = '/'): Promise<void> {
  await harness(request, { reset: true });
  await harness(request, { fleet: [PERSONAL, WORK_BUILDING], maia: { enabled: true }, welcome: { model: true }, welcomeSwitch: null, ...NEW, ...extra });
  await signIn(page, path);
  await expect(welcome(page)).toBeVisible();
}

async function calls(request: APIRequestContext): Promise<{ method: string; path: string; body: Record<string, unknown> | null }[]> {
  return ((await (await request.get('/__harness')).json()) as { welcomeCalls: { method: string; path: string; body: Record<string, unknown> | null }[] }).welcomeCalls;
}

async function axe(page: Page): Promise<void> {
  await page.evaluate(AXE);
  const bad = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe.run(document.querySelector('[data-testid="welcome"]'), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
  });
  expect(bad).toEqual([]);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Through the threshold, quietly, to Q1. */
async function beginQuietly(page: Page): Promise<void> {
  await page.getByTestId('welcome-quiet').click();
  await expect(line(page)).toHaveText('First, which light suits you?', { timeout: 15_000 });
}

test.describe('Maia’s welcome', () => {
  // A welcome is a few minutes of beats; each test walks one end to end.
  test.describe.configure({ timeout: 120_000 });
  // Helpers are made only where they can run (the owner's two dead "snowflake" helpers, Nov 15): with the member's MA credits
  // usable they're made on them; with none, nothing is made and the reveal says so in one line.
  for (const credits of [true, false]) {
  test(`a new Officer${credits ? '' : ' with no credits to use'}: threshold, quiet, own words and taps, a follow-up, a custom helper, the summary and the reveal`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await newMember(page, request, {}, credits ? '/?agentCredits=1' : '/');
    // The threshold: her greeting by first name, three answers, nothing has asked yet.
    await expect(page.getByRole('heading', { name: 'Hi Dana, I’m Maia.' })).toBeVisible();
    await expect(page.getByTestId('welcome-sound')).toHaveText('Begin with sound');
    await expect(page.getByTestId('welcome-explore')).toHaveText('I’ll explore myself');
    await expect(page.getByText('About 3 minutes · Best with headphones')).toBeVisible();
    // The office waits behind her, out of reach.
    await expect(page.locator('.ma-shell')).toHaveClass(/wl-on/);
    await beginQuietly(page);
    await expect(page.getByText('I ask how you work, never what’s in it.')).toBeVisible();
    // Q1: Zen opens the scenes; the office's light follows the tap.
    await chip(page, 'dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await chip(page, 'zen').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
    await page.locator('.wl-scene[data-scene="moonlit-sea"]').click();
    await page.getByTestId('welcome-primary').click();
    await expect(page.getByTestId('welcome-echo')).toBeVisible();
    // Q2: a tap and their own words together; the follow-up the interviewer wrote comes next.
    await expect(line(page)).toHaveText('What fills most of your day?', { timeout: 10_000 });
    await expect(page.getByTestId('welcome-own')).toBeVisible();
    await chip(page, 'writing').click();
    await page.getByTestId('welcome-own').fill('lots of mail too [stub:followup]');
    await page.getByTestId('welcome-primary').click();
    // The interviewer said `lovely` again, which Q1 just used: never the same twice in a row, so the rotation's next.
    await expect(line(page)).toHaveText(/^(Got it|Okay|Noted|That helps|Good to know)\.$/);
    await expect(page.getByTestId('welcome-echo')).toHaveText('In your words, noted.');
    await expect(line(page)).toHaveText('Which kind of writing?', { timeout: 10_000 });
    await page.locator('.wl-chip', { hasText: 'Reports' }).click();
    // Q3: two templates and their words (a custom helper from the interviewer).
    await expect(line(page)).toHaveText('What would you like help with first?', { timeout: 10_000 });
    await chip(page, 'sorting').click();
    await chip(page, 'research').click();
    await page.getByTestId('welcome-own').fill('grant applications');
    await page.getByTestId('welcome-primary').click();
    // Pencilled in on Work while it builds.
    await expect(page.locator('.wl-desk[data-step="placing"] .wl-pen')).toHaveCount(3, { timeout: 10_000 });
    // Q7, a single choice: moves on by itself.
    await expect(line(page)).toHaveText('When I bring you something, how much?', { timeout: 10_000 });
    await chip(page, 'line').click();
    // Work is still building: the fill steps. Names aren't offered (no rename here); the list goes straight to the desk.
    await expect(line(page)).toHaveText('Anything on your mind I should put on your list?', { timeout: 10_000 });
    await page.getByTestId('welcome-todo-0').fill('Renew passport');
    await page.getByRole('button', { name: 'Add to my list' }).click();
    await expect(line(page)).toHaveText('Want to take three slow breaths while I finish?');
    await page.getByRole('button', { name: 'No thanks' }).click();
    // Here's what I heard.
    const heard = page.getByTestId('welcome-heard');
    await expect(heard).toBeVisible({ timeout: 10_000 });
    await expect(heard).toContainText('Zen, Moonlit sea');
    await expect(heard).toContainText('Helpers: Inbox, Research and Grants');
    await expect(heard).toContainText('This goes onto your desks, not into my memory.');
    // Work comes up; Looks right; the reveal lifts the dimming and the office is there.
    await harness(request, { fleet: [PERSONAL, WORK] });
    await page.getByTestId('welcome-looks-right').click();
    await expect(page.getByTestId('welcome-reveal')).toBeVisible({ timeout: 15_000 });
    await expect(line(page)).toHaveText('Your office is ready, Dana.');
    if (credits) await expect(page.getByTestId('welcome-helpers-held')).toHaveCount(0);
    else {
      await expect(page.getByTestId('welcome-helpers-held')).toHaveText('I didn’t add helpers yet: they need credits or your own AI key, which you can add in Agent.', { timeout: 10_000 });
      await expect(page.getByTestId('welcome-reveal').locator('.wl-item', { hasText: 'Inbox' })).toHaveCount(0);
      await shot(page, 'reveal-helpers-held');
    }
    await expect(page.getByText('Notebook’s open on Work, for your writing.')).toBeVisible();
    await expect(page.locator('.ma-shell')).not.toHaveClass(/wl-on/);
    await page.getByTestId('welcome-all-set').click();
    await expect(welcome(page)).toHaveCount(0, { timeout: 10_000 });
    // What went up: ids and their words, never the name, the to-do or anything else.
    const sent = JSON.stringify(await calls(request));
    expect(sent).toContain('"q":"q2"');
    expect(sent).toContain('lots of mail too');
    expect(sent).not.toContain('Dana');
    expect(sent).not.toContain('Renew passport');
    const turns = (await calls(request)).filter((c) => c.path === '/v1/maia/welcome/turn');
    expect(turns.find((t) => t.body?.['kind'] === 'plan')).toBeTruthy();
    expect((await calls(request)).some((c) => c.method === 'DELETE')).toBe(true);
    // The setup went through the member's own session on the desks: helpers made, each asking first, the list, the notes.
    const rpc = await page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string; p: Record<string, unknown> }[] } }).__maDeskMock.rpc.map((r) => ({ m: r.m, p: r.p })));
    const made = rpc.filter((r) => r.m === 'agent.create').map((r) => r.p['name']);
    expect(made.sort()).toEqual(['Grants', 'Inbox', 'Research']);
    for (const r of rpc.filter((x) => x.m === 'agent.create')) expect(r.p['ifRunnable']).toBe(true);
    const access = rpc.filter((x) => x.m === 'agent.access.set' && x.p['agentId'] !== 'maia');
    expect(access).toHaveLength(credits ? 3 : 0);
    for (const r of access) expect(r.p['auto']).toEqual({ notebook: null, files: null, todos: false });
    expect(rpc.some((r) => r.m === 'todo.add' && r.p['title'] === 'Renew passport')).toBe(true);
    expect(rpc.some((r) => r.m === 'notebook.page.import')).toBe(true);
    expect(errors).toEqual([]);
  });
  }

  test('a model that is slow falls back to the scripted echo in 2.5 s; past a cap the whole talk is scripted', async ({ page, request }) => {
    await newMember(page, request, { welcome: { model: true, delayMs: 4000 } });
    await beginQuietly(page);
    await page.getByTestId('welcome-primary').click();
    await expect(line(page)).toHaveText('What fills most of your day?', { timeout: 10_000 });
    const t0 = Date.now();
    await chip(page, 'writing').click();
    await chip(page, 'meetings').click();
    await page.getByTestId('welcome-primary').click();
    await expect(page.getByTestId('welcome-echo')).toHaveText('Meetings and writing.', { timeout: 4000 });
    expect(Date.now() - t0).toBeLessThan(3800);
    // Past a cap: every turn scripted, and the welcome is the same to the member.
    await harness(request, { welcome: { mode: 'scripted' } });
    await expect(line(page)).toHaveText('What would you like help with first?', { timeout: 10_000 });
    await chip(page, 'todos').click();
    await page.getByTestId('welcome-primary').click();
    await expect(page.getByTestId('welcome-echo')).toHaveText('Keeping track of to-dos.');
  });

  test('a key typed is cleared here and never sent', async ({ page, request }) => {
    await newMember(page, request);
    await beginQuietly(page);
    await page.getByTestId('welcome-primary').click();
    await expect(line(page)).toHaveText('What fills most of your day?', { timeout: 10_000 });
    await page.getByTestId('welcome-own').fill('my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456');
    await page.getByTestId('welcome-own').press('Enter');
    await expect(page.getByTestId('welcome-notice')).toHaveText('That looked like a password or key, so I cleared it. Keys go in your desk’s own settings.');
    await expect(line(page)).toHaveText('What fills most of your day?');
    expect(JSON.stringify(await calls(request))).not.toContain('sk-ant');
  });

  test('a teen: scripted, no Platform call, their own question, no name', async ({ page, request }) => {
    await newMember(page, request, { membership: { status: 'active', tier: 'alliance', billingAnchor: now(), ageBand: 'teen' }, age: 'teen', fleet: [PERSONAL] });
    await expect(page.getByRole('heading', { name: 'Hi there, I’m Maia.' })).toBeVisible();
    await beginQuietly(page);
    await page.getByTestId('welcome-primary').click();
    await expect(line(page)).toHaveText('What will you mostly use your desk for?', { timeout: 10_000 });
    await chip(page, 'school').click();
    await expect(page.getByTestId('welcome-heard')).toBeVisible({ timeout: 10_000 });
    expect(await calls(request)).toEqual([]);
  });

  test('I’ll explore myself: today’s first load, their own light back, and not asked again', async ({ page, request }) => {
    await setTheme(page, 'light');
    await newMember(page, request);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
    await page.getByTestId('welcome-explore').click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('.ma-shell')).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(welcome(page)).toHaveCount(0);
    // Any time after: the mark's menu sets it up again, at Q1, with no threshold.
    await page.locator('.home-mark-btn').click();
    await page.locator('#mark-menu').getByRole('button', { name: 'Set up my office with Maia' }).click();
    await expect(line(page)).toHaveText('First, which light suits you?', { timeout: 15_000 });
  });

  test('Pause, Finish later, and Welcome back within a day', async ({ page, request }) => {
    await newMember(page, request);
    await beginQuietly(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('welcome-paused')).toBeVisible();
    await page.getByRole('button', { name: 'Finish later' }).click();
    await expect(page.getByText('No problem. I’ve kept your answers for a day.')).toBeVisible();
    await expect(welcome(page)).toHaveCount(0, { timeout: 10_000 });
    await harness(request, { welcome: { model: true, talk: { talkId: '00000000-0000-4000-8000-000000000001', answers: [{ q: 'q1', choices: ['dark'], text: null }], followUps: [], startedAt: now() } } });
    await page.reload();
    await expect(line(page)).toHaveText('Welcome back. Pick up where we left off?', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Pick up' }).click();
    await expect(line(page)).toHaveText('What fills most of your day?', { timeout: 15_000 });
  });

  test('isn’t for an existing member, the owner, or with the kill switch thrown', async ({ page, request }) => {
    await harness(request, { reset: true });
    await harness(request, { fleet: [PERSONAL], maia: { enabled: true }, welcome: { model: true }, welcomeSwitch: null });
    await signIn(page);
    await page.waitForTimeout(1500);
    await expect(welcome(page)).toHaveCount(0);
    await harness(request, { ...NEW, roles: ['owner'] });
    await page.reload();
    await page.waitForTimeout(1500);
    await expect(welcome(page)).toHaveCount(0);
    await harness(request, { roles: [], welcomeSwitch: { enabled: false } });
    await page.reload();
    await page.waitForTimeout(1500);
    await expect(welcome(page)).toHaveCount(0);
  });

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    for (const phone of [false, true]) {
      test(`axe and the screens in ${theme}${phone ? ' on a phone' : ''}`, async ({ page, request }) => {
        if (phone) await page.setViewportSize({ width: 390, height: 844 });
        await newMember(page, request, { meMaiaMode: { enabled: true }, configExtra: { maiaMode: { enabled: true } } });
        await page.waitForTimeout(5000);
        await axe(page);
        await shot(page, `threshold-${theme}${phone ? '-phone' : ''}`);
        await beginQuietly(page);
        // Q1 in the theme under test, then a question with choices and the input.
        await chip(page, theme === 'dusk' ? 'zen' : theme).click();
        await page.getByTestId('welcome-primary').click();
        await expect(line(page)).toHaveText('What fills most of your day?', { timeout: 10_000 });
        await chip(page, 'email').click();
        await axe(page);
        await shot(page, `question-${theme}${phone ? '-phone' : ''}`);
        await page.getByTestId('welcome-primary').click();
        await expect(line(page)).toHaveText('What would you like help with first?', { timeout: 10_000 });
        await page.getByTestId('welcome-skip').click();
        // A listed Officer gets Q4 to Q6 and Q8 (Maia's desk role, and the focus shield's questions now that it ships with the
        // welcome), and the consent sheet.
        await expect(line(page)).toHaveText('What should always reach you?', { timeout: 10_000 });
        await page.getByTestId('welcome-skip').click();
        await expect(line(page)).toHaveText('When would you like me to catch you up?', { timeout: 10_000 });
        await page.getByTestId('welcome-skip').click();
        await expect(line(page)).toHaveText('When do you do your best focused work?', { timeout: 10_000 });
        await page.getByTestId('welcome-skip').click();
        await expect(line(page)).toHaveText('When I bring you something, how much?', { timeout: 10_000 });
        await page.getByTestId('welcome-skip').click();
        await expect(line(page)).toHaveText('What may I do without asking?', { timeout: 10_000 });
        await page.getByTestId('welcome-skip').click();
        await page.getByRole('button', { name: 'Nothing for now' }).click({ timeout: 10_000 });
        await page.getByRole('button', { name: 'No thanks' }).click();
        await expect(page.getByTestId('welcome-heard')).toBeVisible({ timeout: 10_000 });
        await axe(page);
        await shot(page, `heard-${theme}${phone ? '-phone' : ''}`);
        await harness(request, { fleet: [PERSONAL, WORK] });
        await page.getByTestId('welcome-looks-right').click();
        await expect(page.getByTestId('welcome-consent')).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('heading', { name: 'Before Maia works on your desks' })).toBeVisible();
        await axe(page);
        await shot(page, `consent-${theme}${phone ? '-phone' : ''}`);
        await page.getByRole('button', { name: 'Not now' }).click();
        await expect(page.getByTestId('welcome-reveal')).toBeVisible({ timeout: 15_000 });
        await shot(page, `reveal-${theme}${phone ? '-phone' : ''}`);
        await expect(page.locator('body')).not.toContainText('Maia Mode');
      });
    }
  }
});
