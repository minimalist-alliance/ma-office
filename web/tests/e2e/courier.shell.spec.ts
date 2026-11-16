// Courier's window on the mock desk (`desk/mockDeskCourier.ts`, deskd API.md §21), with its switch on (it ships "Coming later"
// until linked mailboxes are on main): the lanes, the list, a conversation with its email in the sandboxed frame and its links
// listed outside it, Requests with Let in, Not now and Block, search, Done with Undo, the reply with Undo, a linked mailbox's
// sign-in (which goes once and is kept nowhere in the office), a change from elsewhere, the keyboard, an older deskd, and a
// 390 px phone: in Light, Zen and Dark, with axe. One worker per process (the harness).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface CourierDeskMock {
  deliver(p: { name: string; address: string; subject: string; text: string; lane?: string; known?: boolean }): { messageId: string; channelId: string };
  setHtml(messageId: string, html: string): void;
  find(subject: string): string | null;
  laneOf(messageId: string): string | null;
  blocked(): { kind: string; value: string }[];
  control: { calls: { m: string; p: Record<string, unknown>; idem?: string }[]; imap: boolean; signInsChecked: number };
}
interface Mocked {
  __maDeskMock: { courier: { desk(deskId: string): CourierDeskMock }; rpc: { m: string; p: Record<string, unknown> }[] };
  __maPwned?: unknown;
}

const win = (page: Page): Locator => page.getByTestId('courier-window');
const body = (page: Page): Locator => page.getByTestId('courier-body');
const thread = (page: Page): Locator => page.getByTestId('courier-thread');
const rows = (page: Page): Locator => body(page).locator('.courier-rows .courier-row');
const foot = (page: Page): Locator => page.getByTestId('courier-foot');

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked)'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** The console, less the frame's policy and sandbox refusing what a message tried (a style, a script): that's them working. */
const real = (errors: string[]): string[] => errors.filter((e) => !/Content Security Policy|frame is sandboxed/.test(e));

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, init?: Record<string, unknown>): Promise<string[]> {
  const errors = watchConsole(page);
  // Courier's switch on, as it will ship once linked mailboxes are on main (`apps/courier/door.ts`).
  await harness(request, { configExtra: { courier: { enabled: true } } });
  if (init) await page.addInitScript((i) => ((window as unknown as { __maCourierMockInit: unknown }).__maCourierMockInit = i), init);
  await setTheme(page, theme);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  return errors;
}

async function shot(page: Page, name: string, of?: Locator): Promise<void> {
  await page.waitForTimeout(300);
  await (of ?? win(page)).screenshot({ path: `test-results/shots/courier-${name}.png` });
}

async function openCourier(page: Page, desk = 'Personal desk'): Promise<void> {
  const tile = page.getByRole('group', { name: desk }).getByRole('button', { name: /^Courier/ });
  await expect(tile).toHaveCount(1);
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(body(page)).toBeVisible();
}

const deskOf = (page: Page): Promise<string> => win(page).evaluate((el) => el.closest('.ma-window')?.getAttribute('data-desk') ?? '');
const mock = (page: Page, deskId: string, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(([d, f, a]) => {
    const desk = (window as unknown as Mocked).__maDeskMock.courier.desk(d as string) as unknown as Record<string, (...x: unknown[]) => unknown>;
    return desk[f as string]!(...(a as unknown[]));
  }, [deskId, fn, args] as const);
const calls = (page: Page, deskId: string, m: string): Promise<{ p: Record<string, unknown>; idem?: string }[]> =>
  page.evaluate(([d, method]) => (window as unknown as Mocked).__maDeskMock.courier.desk(d!).control.calls.filter((c) => c.m === method), [deskId, m]);

async function openRow(page: Page, name: string | RegExp): Promise<void> {
  await rows(page).filter({ hasText: name }).first().click();
  await expect(thread(page)).toBeVisible();
}

async function lane(page: Page, name: string): Promise<void> {
  await body(page).getByRole('navigation', { name: 'Lanes' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

// Courier's switch and registry go back as found, so a spec after this one in the same harness doesn't open with Courier on.
test.afterEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('Courier', () => {
  for (const theme of THEMES) {
    test(`${theme}: lanes, a conversation, the frame and its links, Requests and Accounts, axe clean`, async ({ page, request }) => {
      const errors = await arrive(page, request, theme);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openCourier(page);
      // The window's own width decides the columns; at its default size, two.
      await win(page).evaluate((el) => {
        const w = el.closest('.ma-window') as HTMLElement;
        w.style.width = '1100px';
        w.style.height = '760px';
      });
      await expect(body(page)).toHaveAttribute('data-cols', '3');
      // People: one row per person, newest first; unread is weight and a dot.
      await expect(rows(page)).toHaveCount(4);
      await expect(rows(page).nth(0)).toContainText('Sam Lee');
      await expect(rows(page).nth(0)).toContainText('unread');
      await expect(body(page).getByRole('button', { name: 'Requests 2 new senders' })).toBeVisible();
      expect(await axe(page)).toEqual([]);

      // Dana's conversation: the earlier email folded, the newest open, its HTML only in the frame.
      await openRow(page, 'Dana Ortiz');
      const card = thread(page).locator('.courier-card.open');
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('dana@ortiz.example');
      await expect(card.getByRole('heading', { name: 'Re: Garden plans' })).toBeVisible();
      await expect(card.getByTestId('courier-unconfirmed')).toHaveCount(0);
      // A person's mail opens as text (the Designer's call 1); as sent is one press away.
      await expect(card.getByRole('button', { name: 'Text only' })).toHaveAttribute('aria-pressed', 'true');
      await expect(card.getByTestId('courier-frame')).toHaveCount(0);
      await card.getByRole('button', { name: 'As sent' }).click();
      const frame = card.getByTestId('courier-frame');
      await expect(frame).toHaveAttribute('sandbox', '');
      expect(await frame.getAttribute('src')).toBeNull();
      const doc = (await frame.getAttribute('srcdoc')) ?? '';
      expect(doc).toMatch(/^<!doctype html><html lang="en" data-paper="(light|dusk|dark)"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src http:\/\/[^ ]+\/courier-frame-[^ ]+\.css;/);
      // Its stylesheet reached it (from the office's own origin, as its policy names it), and its text is there.
      const inside = page.frameLocator('[data-testid="courier-frame"]');
      await expect(inside.locator('body')).toContainText('raised beds');
      await expect.poll(() => inside.locator('body').evaluate((b) => getComputedStyle(b).marginLeft)).toBe('20px');
      // A picture from the web is off, and said so; the links are listed outside the frame with where they go.
      await expect(card).toContainText("Pictures from the web are off");
      await expect(card.getByRole('region', { name: 'Link in this message' })).toContainText('nursery.example');
      await expect(card).toContainText('Tracking was taken out of it.');
      // Attachments are named, never opened; a program says so.
      await expect(card).toContainText('planting-tool.exe');
      await expect(card).toContainText("A program. It can’t be opened here.");
      // Opened, it's read on the desk.
      await expect.poll(async () => (await calls(page, await deskOf(page), 'courier.read.set')).length).toBeGreaterThan(0);
      // Text only, one press away.
      await card.getByRole('button', { name: 'Text only' }).click();
      await expect(card.getByTestId('courier-frame')).toHaveCount(0);
      await expect(card.locator('.courier-text')).toContainText('Let me know by Friday');
      await card.getByRole('button', { name: 'As sent' }).click();
      await expect(card.getByTestId('courier-frame')).toHaveCount(1);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-thread`);

      // Requests: a card a sender, with Let in, Not now and Block.
      await lane(page, 'Requests');
      const reqs = body(page).locator('.courier-request');
      await expect(reqs).toHaveCount(2);
      await expect(reqs.nth(0)).toContainText('Collaboration on the spring show');
      // A stranger whose sender check failed: said plainly, and its links' warnings with them.
      await reqs.nth(1).locator('.courier-request-open').click();
      await expect(thread(page).getByTestId('courier-unconfirmed')).toContainText("Couldn’t confirm this came from secure-login.example");
      const links = thread(page).getByRole('region', { name: 'Links in this message (3)' });
      await expect(links).toContainText('Its words say paypal.com, but it goes somewhere else.');
      await expect(links).toContainText('xn--pypal-4ve.example');
      await expect(links).toContainText('look-alike letters');
      await expect(links).toContainText('bare number address');
      await expect(thread(page).getByRole('group', { name: /Wants to reach you/ })).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-request`);

      // Accounts: this desk's address first, then the linked mailboxes, then the providers.
      await body(page).getByRole('button', { name: 'Accounts', exact: true }).click();
      const setup = page.getByTestId('courier-setup');
      await expect(setup.getByRole('heading', { name: "This desk’s address" })).toBeVisible();
      await expect(setup).toContainText('Signed in as river.lantern@gmail.example');
      await expect(setup.getByRole('list', { name: 'Choose your provider' }).getByRole('button')).toHaveCount(7);
      expect(await axe(page)).toEqual([]);
      await setup.getByRole('button', { name: 'Gmail', exact: true }).click();
      await expect(setup.getByLabel('App password')).toHaveAttribute('type', 'password');
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-accounts`);
      expect(real(errors)).toEqual([]);
    });
  }

  test("the frame runs nothing, loads nothing and goes nowhere, whatever the sanitizer wrote", async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    const deskId = await deskOf(page);
    const id = (await mock(page, deskId, 'find', 'Re: Garden plans')) as string;
    // As if the sandbox had been broken: every way a message could try to run, load or leave.
    await mock(page, deskId, 'setHtml', id,
      '<script>parent.__maPwned = "script"</script>' +
      '<img src="x" onerror="parent.__maPwned = \'onerror\'">' +
      '<img src="https://evil.example/pixel.png" alt="">' +
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">' +
      '<base href="https://evil.example/">' +
      '<style>body { background: rgb(255, 0, 0) }</style>' +
      '<p id="styled" style="color: rgb(255, 0, 0)">styled</p>' +
      '<a id="away" href="https://evil.example/">away</a>' +
      '<a id="glued" title=">"href="https://evil.example/">glued</a>' +
      '<form action="https://evil.example/"><button id="post">post</button></form>' +
      '<iframe src="https://evil.example/"></iframe>' +
      '<svg onload="parent.__maPwned = \'svg\'"></svg>');
    // What reached the network (a request the policy refused never does, though Playwright still reports it as asked).
    const out: string[] = [];
    await page.route(/evil\.example/, (r) => {
      out.push(r.request().url());
      return r.abort();
    });
    await openRow(page, 'Dana Ortiz');
    await thread(page).locator('.courier-card.open').getByRole('button', { name: 'As sent' }).click();
    const inside = page.frameLocator('[data-testid="courier-frame"]');
    await expect(inside.locator('#styled')).toHaveText('styled');
    // No inline style or style element applies (the office's policy), so nothing red.
    expect(await inside.locator('#styled').evaluate((el) => getComputedStyle(el).color)).not.toBe('rgb(255, 0, 0)');
    expect(await inside.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 0, 0)');
    // A link and a form press go nowhere.
    await inside.locator('#away').click();
    await inside.locator('#glued').click();
    await page.waitForTimeout(800);
    expect(out).toEqual([]);
    const f = await (await page.getByTestId('courier-frame').elementHandle())?.contentFrame();
    expect(f?.url()).toBe('about:srcdoc');
    expect(await page.evaluate(() => (window as unknown as Mocked).__maPwned)).toBeUndefined();
    expect(page.url()).not.toContain('evil.example');
    // The office's own console says only that its policy refused things.
    expect(real(errors)).toEqual([]);
  });

  test('a link opens in the desk’s Browser, never in this page, and copies', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    await openRow(page, 'Dana Ortiz');
    await thread(page).locator('.courier-card.open').getByRole('button', { name: 'As sent' }).click();
    const before = page.context().pages().length;
    await thread(page).getByRole('button', { name: 'Open nursery.example in your desk’s Browser' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Mocked).__maDeskMock.rpc.filter((r) => r.m === 'browser.tab.open').map((r) => r.p['url']))).toEqual(['https://nursery.example/spring-guide']);
    expect(page.context().pages().length).toBe(before);
    await openCourier(page);
    await thread(page).getByRole('button', { name: 'Copy link: nursery.example' }).click();
    await expect(foot(page)).toContainText('Copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://nursery.example/spring-guide');
    expect(real(errors)).toEqual([]);
  });

  test('Requests: Let in, Not now and Block, each on the desk', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    const deskId = await deskOf(page);
    await lane(page, 'Requests');
    const reqs = body(page).locator('.courier-request');
    await reqs.nth(0).getByRole('button', { name: 'Let in: Morgan Reyes' }).click();
    await expect(foot(page)).toContainText('Morgan Reyes is in People now.');
    await expect(reqs).toHaveCount(1);
    await reqs.nth(0).getByRole('button', { name: 'Block: Account Services' }).click();
    await expect(foot(page)).toContainText('Account Services is blocked.');
    await expect(body(page).getByText('No one new is waiting.')).toBeVisible();
    expect(await mock(page, deskId, 'blocked')).toEqual([{ kind: 'address', value: 'alerts@secure-login.example' }]);
    // Empty Trash can't be undone, so it asks first, in place.
    await lane(page, 'Trash');
    await body(page).getByRole('button', { name: 'Empty Trash' }).click();
    const ask = body(page).getByRole('group', { name: /Delete everything in Trash for good/ });
    await expect(ask.getByRole('button', { name: 'Empty Trash' })).toBeFocused();
    await ask.getByRole('button', { name: 'Empty Trash' }).click();
    await expect(body(page).getByText('Trash is empty.').first()).toBeVisible();
    await lane(page, 'People');
    await expect(rows(page).filter({ hasText: 'Morgan Reyes' })).toHaveCount(1);
    expect((await calls(page, deskId, 'courier.request.decide')).every((c) => typeof c.idem === 'string')).toBe(true);
    expect(real(errors)).toEqual([]);
  });

  test('search: as you type, highlighted, opens at the message, and names a bad operator', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    await body(page).getByRole('searchbox', { name: 'Search messages' }).fill('raised');
    const hit = body(page).locator('.courier-rows .courier-row');
    await expect(hit).toHaveCount(1);
    await expect(hit.locator('mark')).toHaveText('raised');
    await expect(body(page).getByRole('status').filter({ hasText: '1 message found' })).toBeVisible();
    await hit.click();
    await expect(thread(page).locator('.courier-card.found')).toHaveCount(1);
    await body(page).getByRole('searchbox', { name: 'Search messages' }).fill('before:soon');
    await expect(body(page).getByText('Dates are written 2026-11-01.')).toBeVisible();
    await body(page).getByRole('searchbox', { name: 'Search messages' }).press('Escape');
    await expect(body(page).getByRole('heading', { name: 'People' })).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    expect(real(errors)).toEqual([]);
  });

  test('Done with Undo, a reply with Undo, and a medium that can’t send yet', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    await openRow(page, 'Dana Ortiz');
    // The reply: by email, because her last message was one; saved on the desk as you type.
    const compose = thread(page).getByRole('form', { name: 'Reply to Dana Ortiz' });
    await expect(compose).toContainText('By email · their last message was an email');
    await compose.getByRole('textbox', { name: 'Reply to Dana Ortiz' }).fill('Friday works. See you then.');
    await expect(compose).toContainText('Draft saved', { timeout: 6000 });
    await compose.getByRole('button', { name: 'Send' }).click();
    await expect(foot(page)).toContainText('Sent.');
    await expect(thread(page)).toContainText('Waiting to send');
    await foot(page).getByRole('button', { name: 'Undo' }).click();
    await expect(foot(page)).toContainText('Back to your draft.');
    await expect(compose.getByRole('textbox', { name: 'Reply to Dana Ortiz' })).toHaveValue('Friday works. See you then.');
    // The draft is the desk's: another conversation and back (another device, a reload), and it's there.
    await openRow(page, 'Sam Lee');
    await openRow(page, 'Dana Ortiz');
    await expect(thread(page).getByRole('textbox', { name: 'Reply to Dana Ortiz' })).toHaveValue('Friday works. See you then.');
    // Done: the conversation leaves People, with Undo.
    await thread(page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(foot(page)).toContainText('Done: Dana Ortiz');
    await expect(rows(page).filter({ hasText: 'Dana Ortiz' })).toHaveCount(1); // the book club's, not hers
    await foot(page).getByRole('button', { name: 'Undo' }).click();
    await expect(rows(page).filter({ hasText: 'Dana Ortiz' })).toHaveCount(2);
    // Sam's are private messages between desks, which can't send until the relay is live.
    await openRow(page, 'Sam Lee');
    const reply = thread(page).getByRole('form', { name: 'Reply to Sam Lee' });
    await reply.getByRole('textbox').fill('On my way');
    await reply.getByRole('button', { name: 'Send' }).click();
    await expect(reply.getByRole('alert')).toHaveText("This account can’t send yet. Your draft is kept.");
    expect(real(errors)).toEqual([]);
  });

  test('a mailbox’s sign-in goes once, to the desk, and is kept nowhere here', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    const deskId = await deskOf(page);
    await body(page).getByRole('button', { name: 'Accounts', exact: true }).click();
    const setup = page.getByTestId('courier-setup');
    // Outlook and iMessage come later: their reason, no form.
    await setup.getByRole('button', { name: /Outlook and Microsoft 365/ }).click();
    await expect(setup).toContainText('These sign in with Microsoft, which comes in a later update.');
    // A wrong password: the provider's refusal, in plain words, and the field emptied.
    await setup.getByRole('button', { name: 'Yahoo Mail' }).click();
    await setup.getByLabel('Email address').fill('river@yahoo.example');
    const secret = 'zq-SECRET' + '-value-7731';
    await setup.getByLabel('App password').fill('wrong-password');
    await setup.getByRole('button', { name: 'Link mailbox' }).click();
    await expect(setup.getByRole('alert')).toContainText("Yahoo didn’t accept that password");
    await expect(setup.getByLabel('App password')).toHaveValue('');
    await expect(setup.getByLabel('App password')).toBeFocused();
    // The right one: linked, and the office only ever says "Signed in as".
    await setup.getByLabel('App password').fill(secret);
    await setup.getByRole('button', { name: 'Link mailbox' }).click();
    await expect(foot(page)).toContainText('river@yahoo.example is linked.');
    await expect(setup).toContainText('Signed in as river@yahoo.example');
    // Nowhere in the page, its storage, the mock's log or the console.
    expect(await page.content()).not.toContain(secret);
    expect(await page.evaluate((s) => JSON.stringify({ ...localStorage }).includes(s) || JSON.stringify({ ...sessionStorage }).includes(s), secret)).toBe(false);
    const adds = await calls(page, deskId, 'courier.accounts.add');
    expect(adds.at(-1)?.p).toMatchObject({ kind: 'imap', address: 'river@yahoo.example', auth: 'app_password', secret: '[sealed]', provider: 'yahoo' });
    expect(adds.at(-1)?.p['server']).toBeUndefined();
    expect(JSON.stringify(adds)).not.toContain(secret);
    expect(errors.join('\n')).not.toContain(secret);
    // Remove: asks first, keeps the mail by default, and says to revoke at the provider.
    await setup.getByRole('button', { name: 'Remove river@yahoo.example' }).click();
    await expect(setup.getByRole('group', { name: 'Remove river@yahoo.example from this desk?' })).toContainText('remove its app password at your provider');
    await setup.getByRole('button', { name: 'Remove it' }).click();
    await expect(foot(page)).toContainText('river@yahoo.example is no longer linked.');
    expect((await calls(page, deskId, 'courier.accounts.remove')).at(-1)?.p).toMatchObject({ keepMail: true });
    expect(real(errors)).toEqual([]);
  });

  test('before linked mailboxes are on the desk, the sign-in says so', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light', { imap: false });
    await openCourier(page);
    await body(page).getByRole('button', { name: 'Accounts', exact: true }).click();
    const setup = page.getByTestId('courier-setup');
    await setup.getByRole('button', { name: 'Other mailbox (IMAP)' }).click();
    await setup.getByLabel('Email address').fill('me@mail.example');
    await setup.getByLabel('App password').fill('pw');
    await setup.getByLabel('Incoming (IMAP) server').fill('imap.mail.example');
    await setup.getByLabel('Outgoing (SMTP) server').fill('smtp.mail.example');
    await setup.getByRole('button', { name: 'Link mailbox' }).click();
    await expect(setup.getByRole('alert')).toHaveText("This desk can’t link mailboxes yet. It comes with a desk update.");
    expect(real(errors)).toEqual([]);
  });

  test('a message from elsewhere shows within a moment; the keyboard reaches everything', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openCourier(page);
    const deskId = await deskOf(page);
    await expect(rows(page)).toHaveCount(4);
    await mock(page, deskId, 'deliver', { name: 'Ada Quinn', address: 'ada@quinn.example', subject: 'Lunch', text: 'Lunch on Tuesday?' });
    await expect(rows(page)).toHaveCount(5, { timeout: 1500 });
    await expect(rows(page).nth(0)).toContainText('Ada Quinn');
    // j and k move through the list and open each; e is Done; / searches; ? lists the keys, Esc puts them away.
    await rows(page).nth(0).focus();
    await page.keyboard.press('j');
    await expect(thread(page).getByRole('heading', { level: 2 })).toHaveText('Sam Lee');
    await page.keyboard.press('k');
    await expect(thread(page).getByRole('heading', { level: 2 })).toHaveText('Ada Quinn');
    await page.keyboard.press('e');
    await expect(foot(page)).toContainText('Done: Ada Quinn');
    await expect(rows(page)).toHaveCount(4);
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(win(page)).toBeVisible();
    await page.keyboard.press('/');
    await expect(body(page).getByRole('searchbox', { name: 'Search messages' })).toBeFocused();
    expect(real(errors)).toEqual([]);
  });

  test("an older desk's Courier says it needs an update", async ({ page, request }) => {
    const errors = await arrive(page, request, 'light', { old: true });
    await openCourier(page);
    await expect(body(page)).toHaveAttribute('data-state', 'refused');
    await expect(body(page)).toContainText("This desk’s Courier needs an update.");
    expect(real(errors)).toEqual([]);
  });
});

test.describe('Courier on a phone, 390 px', () => {
  test.use({ hasTouch: true });
  for (const theme of THEMES) {
    test(`${theme}: one column, the conversation full width with Back, no sideways scroll, axe clean`, async ({ page, request }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const errors = await arrive(page, request, theme);
      await openCourier(page);
      await expect(body(page)).toHaveAttribute('data-cols', '1');
      await expect(rows(page)).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await body(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      // Large targets: every button in the list is at least 44 px tall.
      const short = await body(page).locator('.courier-listpane button:visible').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent));
      expect(short).toEqual([]);
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-list`, page.locator('body'));
      await rows(page).filter({ hasText: 'Dana Ortiz' }).first().tap();
      await expect(thread(page)).toBeVisible();
      await expect(body(page).locator('.courier-listpane')).toHaveCount(0);
      await expect(thread(page).getByRole('heading', { level: 2, name: 'Dana Ortiz' })).toBeFocused();
      expect(await body(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-thread`, page.locator('body'));
      await thread(page).getByRole('button', { name: 'Back', exact: true }).tap();
      await expect(rows(page)).toHaveCount(4);
      await expect(rows(page).filter({ hasText: 'Dana Ortiz' }).first()).toBeFocused();
      expect(real(errors)).toEqual([]);
    });
  }
});
