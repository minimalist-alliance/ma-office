// #6, free models through OpenRouter (S-138; the Product Designer's spec `design-drafts/launch-features/agent-free-key/`): the
// free card on the key screen, OpenRouter's PKCE sign-in, the `/connect/openrouter` page's hand-off, the key on the desk, and
// what changes after, on `MockDeskLink` with the real `RpcAgentClient`. OpenRouter itself is a stand-in answered here
// (`standIn`, Playwright's routing of https://openrouter.ai in this browser context): no request ever leaves for the real one,
// and every request to that host is checked to have been answered by the stand-in. Light, Zen and Dark with axe, and a phone.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
/** A made-up OpenRouter key: the stand-in hands it over, and it must turn up nowhere in the page. */
const KEY = 'sk-or-v1-TEST-not-a-real-key-canary-00007Q2f';
const PRIVACY = 'Free models are run by other companies, which may keep what you send and learn from it. Your privacy settings at OpenRouter decide which ones you use.';
const UNUSED = ' The unused key stays in your OpenRouter account until you delete it there.';

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const card = (page: Page): Locator => page.getByTestId('free-card');
const status = (page: Page): Locator => agentWindow(page).locator('.ag-sr[role="status"]');

interface StandIn {
  /** What OpenRouter's auth page was asked: challenge, method, state, label, return address. */
  auth: URLSearchParams[];
  /** What the exchange was sent, with the headers it came with. */
  exchanges: { body: Record<string, unknown>; headers: Record<string, string> }[];
  /** Every request to the host, to be sure each was answered here. */
  seen: string[];
}

/**
 * OpenRouter, answered in this browser context: its auth page (Allow sends the window back with `code` and the same `state`;
 * Deny sends it back with neither, as OpenRouter does), and its exchange, which gives `key`, a status, or a dropped request.
 */
async function standIn(context: BrowserContext, opts: { key?: string; status?: number; drop?: boolean } = {}): Promise<StandIn> {
  const s: StandIn = { auth: [], exchanges: [], seen: [] };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' };
  await context.route(/^https:\/\/([a-z0-9-]+\.)*openrouter\.ai(\/|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    s.seen.push(`${req.method()} ${url.pathname}`);
    if (url.hostname === 'openrouter.ai' && url.pathname === '/auth') {
      s.auth.push(url.searchParams);
      const back = url.searchParams.get('callback_url') ?? '';
      const allow = `${back}?code=TEST-code-1&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`;
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>OpenRouter stand-in</title><a id="allow" href="${allow}">Allow</a> <a id="deny" href="${back}">Deny</a>` });
    }
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/auth/keys') {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      s.exchanges.push({ body: JSON.parse(req.postData() ?? '{}') as Record<string, unknown>, headers: req.headers() });
      if (opts.drop) return route.abort('failed');
      return route.fulfill({ status: opts.status ?? 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(opts.status && opts.status >= 400 ? { error: { message: 'Invalid code' } } : { key: opts.key ?? KEY }) });
    }
    return route.abort('blockedbyclient');
  });
  return s;
}

/** The stand-in's verifier check, as OpenRouter makes it: S256 of the verifier is the challenge the auth page was given. */
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

async function arrive(page: Page, query = ''): Promise<void> {
  await signIn(page, `/?fixture=one&speed=fast${query}`);
  await canvasPainted(page);
}

/** The Agent window, filling the screen as the spec's stills do. */
async function openAgent(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
  const fill = agentWindow(page).getByRole('button', { name: 'Fill the screen' });
  if (await fill.isVisible()) {
    await fill.click();
    await page.waitForTimeout(300);
  }
  await expect(page.getByTestId('key-setup')).toBeVisible();
}

/** Connect pressed, and OpenRouter's window: the popup the press opened. */
async function connect(page: Page): Promise<Page> {
  const popup = page.waitForEvent('popup');
  await card(page).getByTestId('free-connect').click();
  const win = await popup;
  await win.waitForLoadState();
  return win;
}

/** Signs in at the stand-in and allows: the window goes back to the office's own page, which relays the code. */
async function allow(win: Page): Promise<void> {
  await win.locator('#allow').click();
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run({ include: ['.ma-window .window-body'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `test-results/shots/agent-free-${name}.png` });
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
}

/** Everything the page holds that a key could hide in: the DOM, storage, cookies and the address. */
const kept = (page: Page): Promise<string> =>
  page.evaluate(() => [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie, location.href].join('\n'));

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: the key screen, free card first, own key below, clean`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await standIn(page.context());
    await arrive(page);
    await openAgent(page);
    const setup = page.getByTestId('key-setup');
    await expect(setup.getByRole('heading', { name: 'Give Lead a key' })).toBeVisible();
    await expect(setup).toContainText('Lead wakes once it has an AI key, and the key is kept on this desk.');
    // The card, by its title; the privacy line in it, plain text, never folded into a details.
    const c = page.getByRole('region', { name: 'Try free models' });
    await expect(c).toBeVisible();
    await expect(c).toContainText('Connect OpenRouter, and Lead uses its free models. You sign in or make an account there, and it doesn’t ask for a card.');
    await expect(c.locator('.ag-free-facts li')).toHaveText([
      'Slower than paid models, with a limited number of requests each day.',
      'Some chat only: they can’t use tools on your desk.',
      'The key is yours, from your OpenRouter account, and is kept on this desk.',
    ]);
    await expect(c.getByTestId('free-privacy')).toHaveText(PRIVACY);
    await expect(c.getByTestId('free-privacy')).toBeVisible();
    expect(await c.getByTestId('free-privacy').evaluate((el) => el.closest('details'))).toBeNull();
    await expect(c.getByTestId('free-connect')).toHaveText('Connect OpenRouter');
    await expect(c).toContainText('Opens openrouter.ai in a new window');
    // Then "or", then your own key, with OpenRouter in the provider row and its own help line.
    await expect(page.locator('.ag-or')).toHaveAttribute('aria-hidden', 'true');
    const own = page.getByRole('region', { name: 'Add your own key' });
    await expect(own).toContainText('From your own provider account. You pay the provider directly, and your limits here stop Lead before it spends more than you allow.');
    // The card comes before the form, and Connect before the form's fields in the tab order.
    expect(await page.evaluate(() => {
      const a = document.querySelector('[data-testid="free-card"]');
      const b = document.querySelector('[data-testid="key-form"]');
      return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await own.getByRole('radio', { name: 'OpenRouter' }).click();
    await expect(own.getByTestId('key-input')).toHaveAttribute('placeholder', 'sk-or-…');
    await expect(own).toContainText('Make one at openrouter.ai. Only its free models are listed for now.');
    await own.getByRole('radio', { name: 'Anthropic' }).click();
    // "$0" never appears.
    expect(await page.locator('body').innerText()).not.toContain('$0 ');
    expect(await axe(page)).toEqual([]);
    await setup.evaluate((el) => (el.scrollTop = 0));
    await shot(page, `${theme}-key-screen`);
    expect(errors).toEqual([]);
  });
}

test('Connect: OpenRouter in its own window, the code relayed, the key to the desk, and Lead awake on free models', async ({ page }) => {
  const errors = watchConsole(page);
  const or = await standIn(page.context());
  await arrive(page);
  await openAgent(page);

  const win = await connect(page);
  // Waiting: the line, Cancel focused, nothing added yet. The verifier is in this tab's sessionStorage alone.
  await expect(card(page)).toHaveAttribute('data-state', 'waiting');
  await expect(card(page).getByTestId('free-wait')).toContainText('Waiting for OpenRouter…Finish in the OpenRouter window, then come back here. Nothing is added until you do.');
  await expect(card(page).getByTestId('free-cancel')).toBeFocused();
  await expect(card(page).getByTestId('free-privacy')).toHaveText(PRIVACY);
  await shot(page, 'light-waiting');
  const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ma.agent.orConnect') ?? 'null') as { verifier: string; state: string; agentId: string } | null);
  expect(pending?.agentId).toBe('manager');
  // The auth address: S256 of that verifier, its state, the office's own return page, the key named for the desk.
  const asked = or.auth[0]!;
  expect(asked.get('code_challenge')).toBe(s256(pending!.verifier));
  expect(asked.get('code_challenge_method')).toBe('S256');
  expect(asked.get('state')).toBe(pending!.state);
  expect(asked.get('callback_url')).toBe(new URL('/connect/openrouter', page.url()).href);
  expect(asked.get('key_label')).toBe('Minimalist Alliance, Personal desk');
  expect([...asked.keys()]).not.toContain('code_verifier');

  const closed = win.waitForEvent('close');
  await allow(win);
  await closed; // the page said connected and closed itself
  // The exchange went from the office tab, with the verifier, no cookies and no referrer.
  await expect.poll(() => or.exchanges.length).toBe(1);
  expect(or.exchanges[0]!.body).toEqual({ code: 'TEST-code-1', code_verifier: pending!.verifier, code_challenge_method: 'S256' });
  expect(or.exchanges[0]!.headers['cookie']).toBeUndefined();
  expect(or.exchanges[0]!.headers['referer']).toBeUndefined();

  // Awake: the thread, the badge "OR", the note in the empty thread, the usage line, the announcement.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(status(page)).toHaveText('Lead is awake, on free models through OpenRouter.');
  const badge = page.locator('.ag-head').getByTestId('provider-badge');
  await expect(badge).toContainText('OpenRouter');
  await expect(badge.locator('.ag-badge-mono')).toHaveText('OR');
  await expect(badge.locator('.ag-badge-mono')).toHaveAttribute('data-letters', '2');
  await expect(page.locator('.ag-head')).toContainText('nvidia/nemotron-3.5-super-vl:free');
  await expect(page.getByTestId('free-note')).toHaveText('On free models through OpenRouter: slower than paid ones, with a limited number of requests a day. The companies running them may keep what you send.');
  await expect(page.getByTestId('usage-line')).toHaveText('Free models cost nothing here. OpenRouter limits how many requests a day.');
  await shot(page, 'light-awake');

  // The key itself is nowhere, and the pending Connect is gone.
  const all = await kept(page);
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(KEY.slice(0, -4));
  expect(all).not.toContain(pending!.verifier);
  expect(await page.evaluate(() => sessionStorage.getItem('ma.agent.orConnect'))).toBeNull();
  // The mock desk's own record of everything it holds keeps the last 4 only.
  const desk = await page.evaluate(() => Object.values((window as unknown as { __maDeskMock: { agent: { desks: Record<string, { client: { dump(): string } }> } } }).__maDeskMock.agent.desks).map((d) => d.client.dump()).join('\n'));
  expect(desk).not.toContain(KEY.slice(0, -4));
  expect(desk).toContain('7Q2f');
  // The key went over the desk session as `agent.key.add`, OpenRouter's, named "Free models".
  const adds = await page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string; p: Record<string, unknown> }[] } }).__maDeskMock.rpc.filter((r) => r.m === 'agent.key.add').map((r) => ({ provider: r.p['provider'], label: r.p['label'] })));
  expect(adds).toEqual([{ provider: 'openrouter', label: 'Free models' }]);

  // A reply on a free model: "free" in its foot, never "$0".
  await say(page, 'Plan my week.');
  await expect(page.getByTestId('msg-foot').last()).toContainText('· free');
  await expect(page.getByTestId('msg-foot').last()).not.toContainText('$');
  await expect(page.getByTestId('free-note')).toHaveCount(0);

  // Keys: the key and model in their words, the tags, the short privacy line, and the row's line.
  await page.getByTestId('tab-keys').click();
  const keysPanel = page.getByTestId('keys-panel');
  await expect(keysPanel.getByTestId('bind-key').locator('option:checked')).toHaveText('Free models · OpenRouter ····7Q2f');
  await expect(keysPanel.getByTestId('bind-model').locator('option')).toHaveText(['NVIDIA: Nemotron 3.5 Super VL · Free', 'Example Labs: Chat 8B · Free · Chats only']);
  const notes = keysPanel.getByTestId('model-free');
  await expect(notes.locator('.ag-free-tag')).toHaveText(['Free']);
  await expect(notes).toContainText('Slower than paid models, with a limited number of requests a day.');
  await expect(notes.locator('.ag-free-privacy')).toHaveText('The company running a free model may keep what you send and learn from it.');
  await expect(keysPanel.getByTestId('model-unpriced')).toHaveCount(0);
  await expect(keysPanel.getByTestId('key-free')).toHaveText('Free models only, from your OpenRouter account.');
  await expect(keysPanel.getByTestId('free-try')).toHaveCount(0); // there's an OpenRouter key already
  await shot(page, 'light-keys-tab');
  await keysPanel.getByTestId('bind-model').selectOption('example-labs/chat-8b:free');
  await expect(notes.locator('.ag-free-tag')).toHaveText(['Free', 'Chats only']);
  await expect(notes).toContainText('This one chats only: it can’t use tools on your desk, so it can’t read your notes or open pages.');
  expect(await axe(page)).toEqual([]);
  await shot(page, 'light-keys-chats-only');
  expect(or.seen.every((r) => r === 'GET /auth' || r.endsWith('/api/v1/auth/keys'))).toBe(true);
  expect(errors).toEqual([]);
});

test('free requests used, busy, slow and privacy settings: the limit line and banner, and "Pick another model"', async ({ page }) => {
  const errors = watchConsole(page);
  await standIn(page.context());
  await arrive(page);
  await openAgent(page);
  await allow(await connect(page));
  await expect(page.getByTestId('composer-input')).toBeVisible();

  // Today's free requests used: a limit, not a failure. Not red; the warn banner says when they come back.
  await say(page, 'demo:free_limit_at');
  const limitLine = page.getByTestId('msg-free-limit');
  await expect(limitLine).toHaveText('Stopped: today’s free requests are used.');
  expect(await limitLine.evaluate((el) => el.classList.contains('ag-error'))).toBe(false);
  const banner = page.getByTestId('free-limit-banner');
  await expect(banner).toHaveText(/^Today’s free requests at OpenRouter are used\. More come back at \d\d:\d\d\.Add a key$/);
  await expect(banner).toHaveClass(/warn/);
  await expect(page.getByRole('tab', { name: /Lead/ })).toContainText('online');
  expect(await axe(page)).toEqual([]);
  await shot(page, 'light-free-limit');
  // Without a time from OpenRouter, the second sentence.
  await say(page, 'demo:free_limit');
  await expect(banner).toHaveText(/OpenRouter gives more each day\.Add a key$/);
  // "Add a key": Keys, with the form open.
  await page.getByTestId('free-limit-add').click();
  await expect(page.getByTestId('keys-panel').getByTestId('key-form')).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();

  // Busy: red, and "Pick another model", which opens Keys. The banner goes once the last reply isn't a free limit.
  await say(page, 'demo:rate_limited');
  await expect(page.locator('.ag-msg.agent .ag-error').last()).toHaveText('OpenRouter’s free models are busy right now. Try again in a minute, or pick another free model.');
  await expect(banner).toHaveCount(0);
  await shot(page, 'light-busy');
  await page.getByTestId('pick-model').last().click();
  await expect(page.getByTestId('keys-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await say(page, 'demo:timeout');
  await expect(page.locator('.ag-msg.agent .ag-error').last()).toHaveText('The free model took too long to answer. Try again, or pick another free model.');
  await say(page, 'demo:data_policy');
  await expect(page.locator('.ag-msg.agent .ag-error').last()).toHaveText('Your privacy settings at OpenRouter don’t allow any host for this free model. Pick another model, or change those settings at openrouter.ai.');
  await expect(page.getByTestId('pick-model')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('removing the key: today’s confirm and note, the key screen and its free card back, and "Try free models" in Keys', async ({ page }) => {
  await standIn(page.context());
  await arrive(page);
  await openAgent(page);
  await allow(await connect(page));
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('tab-keys').click();
  await page.getByRole('button', { name: 'Delete key Free models' }).click();
  await expect(page.locator('.ag-confirm')).toContainText('Delete this key from the desk? Agents using it stop until they get another.');
  await shot(page, 'light-remove-confirm');
  await page.getByTestId('key-delete-confirm').click();
  await expect(page.getByTestId('key-deleted')).toHaveText('Deleted from this desk. Revoke it at openrouter.ai too: that’s the only way to be sure no copy of it still works.');
  await expect(page.getByTestId('key-setup')).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('free-try')).toHaveText('Try free models');
  await shot(page, 'light-removed');
  // "Try free models" opens the same card in place of the button.
  await page.getByTestId('free-try').click();
  await expect(page.getByTestId('keys-panel').getByTestId('free-card')).toBeVisible();
});

test('the browser kept the window from opening: the link, Cancel, and a code after Cancel adds nothing', async ({ page }) => {
  const or = await standIn(page.context());
  await arrive(page);
  await openAgent(page);
  await page.evaluate(() => {
    window.open = () => null;
  });
  await card(page).getByTestId('free-connect').click();
  await expect(card(page)).toHaveAttribute('data-state', 'blocked');
  await expect(card(page).getByTestId('free-wait')).toContainText('Your browser kept the OpenRouter window from opening.Open it from here instead.');
  const link = card(page).getByTestId('free-open');
  await expect(link).toHaveText('Open OpenRouter');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');
  expect(new URL((await link.getAttribute('href'))!).origin).toBe('https://openrouter.ai');
  await shot(page, 'light-blocked');
  const state = new URL((await link.getAttribute('href'))!).searchParams.get('state');
  // Cancel forgets the verifier; the code that arrives after is ignored and nothing is exchanged.
  await card(page).getByTestId('free-cancel').click();
  await expect(card(page)).toHaveAttribute('data-state', 'idle');
  expect(await page.evaluate(() => sessionStorage.getItem('ma.agent.orConnect'))).toBeNull();
  const late = await page.context().newPage();
  await late.goto(`/connect/openrouter?code=late&state=${state}`);
  await expect(late.getByTestId('connect-callback')).toHaveAttribute('data-phase', 'asleep');
  await page.waitForTimeout(500);
  expect(or.exchanges).toEqual([]);
  await expect(card(page)).toHaveAttribute('data-state', 'idle');
});

test('every way it fails says why, and Connect again', async ({ page, request }) => {
  const words = {
    mismatch: "That answer from OpenRouter didn't match, so nothing was added. Connect again.",
    declined: 'OpenRouter didn’t hand over a key, so nothing was added. Connect again.',
    expired: 'That took more than 10 minutes, so nothing was added. Connect again when you’re ready.',
    unreachable: "OpenRouter couldn't be reached from here. Try again in a moment.",
    desk: `Your desk can’t reach OpenRouter right now, so it kept nothing. Try again later, or add a key of your own below.${UNUSED}`,
    storage: `Your desk couldn’t save the key, and kept nothing. Connect again.${UNUSED}`,
    refused: `OpenRouter refused the new key, so nothing was kept. Connect again.${UNUSED}`,
  };
  const failed = async (text: string): Promise<void> => {
    await expect(card(page).getByTestId('free-error')).toHaveText(text);
    await expect(card(page).getByTestId('free-error')).toHaveAttribute('role', 'alert');
    await expect(card(page).getByTestId('free-connect')).toHaveText('Connect again');
    await expect(card(page).getByTestId('free-connect')).toBeFocused();
    await expect(page.getByTestId('composer-input')).toHaveCount(0);
  };
  const ctx = page.context();
  let or = await standIn(ctx);
  await arrive(page);
  await openAgent(page);

  // Declined at OpenRouter: no code, no state. The page says so too.
  let win = await connect(page);
  await win.locator('#deny').click();
  await expect(win.getByTestId('connect-callback')).toContainText('OpenRouter didn’t connect');
  await failed(words.declined);
  await shot(page, 'light-failed-declined');
  await win.close();

  // Another Connect took its place in this tab's storage before the code came back: didn't match.
  win = await connect(page);
  await page.evaluate(() => {
    const p = JSON.parse(sessionStorage.getItem('ma.agent.orConnect') ?? '{}') as Record<string, unknown>;
    sessionStorage.setItem('ma.agent.orConnect', JSON.stringify({ ...p, state: 'someone-elses' }));
  });
  await allow(win);
  await failed(words.mismatch);
  expect(or.exchanges).toEqual([]);
  await shot(page, 'light-failed-mismatch');
  await page.evaluate(() => sessionStorage.removeItem('ma.agent.orConnect'));
  await win.close();

  // OpenRouter refuses the exchange.
  await ctx.unrouteAll();
  or = await standIn(ctx, { status: 400 });
  win = await connect(page);
  await allow(win);
  await failed(words.declined);

  // The desk refuses the key it made, can't reach OpenRouter, or can't save it: the unused key stays at OpenRouter.
  for (const [key, text] of [
    ['sk-or-v1-TEST-revoked-canary-0000wxyz', words.refused],
    ['sk-or-v1-TEST-unreachable-canary-0000', words.desk],
    ['sk-or-v1-TEST-nostore-canary-000000aa', words.storage],
  ] as const) {
    await ctx.unrouteAll();
    or = await standIn(ctx, { key });
    win = await connect(page);
    await allow(win);
    await failed(text);
  }
  await shot(page, 'light-failed-desk');

  // The office's own CSP refuses the exchange (Platform hasn't added openrouter.ai): unreachable from this window.
  await harness(request, { openRouter: false });
  await ctx.unrouteAll();
  or = await standIn(ctx);
  await page.reload();
  await canvasPainted(page);
  await openAgent(page);
  win = await connect(page);
  await allow(win);
  await failed(words.unreachable);
  expect(or.exchanges).toEqual([]);
  await harness(request, { openRouter: true });

  // A Connect started more than 10 minutes ago, found on opening: it says so, and its verifier goes.
  await page.evaluate(() =>
    sessionStorage.setItem('ma.agent.orConnect', JSON.stringify({ verifier: 'v'.repeat(43), state: 'old-state', deskId: 'd-personal', agentId: 'manager', startedAt: Date.now() - 11 * 60_000 })),
  );
  const deskId = await page.evaluate(() => Object.keys((window as unknown as { __maDeskMock: { agent: { desks: Record<string, unknown> } } }).__maDeskMock.agent.desks)[0]);
  await page.evaluate((id) => {
    const p = JSON.parse(sessionStorage.getItem('ma.agent.orConnect')!) as Record<string, unknown>;
    sessionStorage.setItem('ma.agent.orConnect', JSON.stringify({ ...p, deskId: id }));
  }, deskId);
  await page.reload();
  await canvasPainted(page);
  await openAgent(page);
  await expect(card(page).getByTestId('free-error')).toHaveText(words.expired);
  expect(await page.evaluate(() => sessionStorage.getItem('ma.agent.orConnect'))).toBeNull();
  expect(await axe(page)).toEqual([]);
});

test('a Connect survives the window closing: reopened, the card waits again and finishes', async ({ page }) => {
  await standIn(page.context());
  await arrive(page);
  await openAgent(page);
  const win = await connect(page);
  await agentWindow(page).getByRole('button', { name: 'Close Agent' }).click();
  await expect(agentWindow(page)).toHaveCount(0);
  await allow(win);
  // Nobody's listening: the page says go back to the office.
  await expect(win.getByTestId('connect-callback')).toHaveAttribute('data-phase', 'asleep');
  await expect(win.getByTestId('connect-callback')).toContainText('Go back to your office to finish');
  await openAgent(page).catch(() => undefined);
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 10_000 });
  await expect(status(page)).toHaveText('Lead is awake, on free models through OpenRouter.');
});

test('the /connect/openrouter page alone: the code leaves the address at once, and each of its states', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/connect/openrouter?code=TEST-code-x&state=TEST-state-x');
  const cb = page.getByTestId('connect-callback');
  await expect(cb).toContainText('Minimalist Alliance');
  await expect(cb.getByRole('heading')).toHaveText('Connecting to your desk…');
  expect(page.url()).toMatch(/\/connect\/openrouter$/);
  await expect(cb).toHaveAttribute('data-phase', 'asleep');
  await expect(cb.getByRole('heading')).toHaveText('Go back to your office to finish');
  await expect(cb).toContainText('Keep this page open until it says connected.');
  await page.screenshot({ path: 'test-results/shots/agent-free-light-callback-asleep.png' });
  // No sign-in, no desks: nothing else ran on this page.
  await expect(page.locator('.ma-shell')).toHaveCount(0);
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  await page.goto('/connect/openrouter');
  await expect(cb.getByRole('heading')).toHaveText('OpenRouter didn’t connect');
  await expect(cb).toContainText('Nothing was added. You can close this page.');
  await page.screenshot({ path: 'test-results/shots/agent-free-light-callback-declined.png' });
  expect(errors).toEqual([]);
});

test('a teen has no Agent, so nothing of this shows', async ({ page, request }) => {
  await standIn(page.context());
  await harness(request, { age: 'teen' });
  await arrive(page);
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ })).toHaveCount(0);
  await expect(page.getByTestId('free-card')).toHaveCount(0);
});

test.describe('on a phone, 390 px', () => {
  for (const theme of THEMES) {
    test(`${theme}: the key screen, waiting, awake and free requests used fit, clean`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await standIn(page.context());
      await arrive(page);
      await openAgent(page);
      await expect(card(page)).toContainText('Opens openrouter.ai in a new tab');
      const button = card(page).getByTestId('free-connect');
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(43.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-key-screen`);
      const win = await connect(page);
      await expect(card(page).getByTestId('free-wait')).toContainText('Finish in the OpenRouter tab');
      await card(page).getByTestId('free-wait').scrollIntoViewIfNeeded();
      await shot(page, `phone-${theme}-waiting`);
      await allow(win);
      await expect(page.getByTestId('composer-input')).toBeVisible();
      await shot(page, `phone-${theme}-awake`);
      await say(page, 'demo:free_limit_at');
      await expect(page.getByTestId('free-limit-banner')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-free-limit`);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('Zen and Dark', () => {
  for (const theme of ['dusk', 'dark'] as ThemeId[]) {
    test(`${theme}: awake, Keys with a chats-only model, and free requests used`, async ({ page }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await standIn(page.context());
      await arrive(page);
      await openAgent(page);
      await allow(await connect(page));
      await expect(page.getByTestId('composer-input')).toBeVisible();
      await page.getByTestId('tab-keys').click();
      await page.getByTestId('keys-panel').getByTestId('bind-model').selectOption('example-labs/chat-8b:free');
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-keys-chats-only`);
      await page.getByRole('button', { name: 'Close panel' }).click();
      await say(page, 'demo:free_limit_at');
      await expect(page.getByTestId('free-limit-banner')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-free-limit`);
      expect(errors).toEqual([]);
    });
  }
});
