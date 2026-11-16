// Courier's office, Waves 2.7 and 3.4 and the Designer's Nov 14 screens (`design-drafts/courier/screens/`), on the mock desk with
// Courier's switch on: choosing this desk's address on Platform's registry (the harness's `courierRegistry.mjs`) and sharing it
// with its invite link and fingerprint; one person across channels (suggestions that link only on a press, the person view,
// Unlink with Undo, Link to someone…, a drag, Requests' link, a deskd from before links); an invite link's Add arriving; the
// tile's count and names; `courier.waiting` in the bell; the Designer's calls (People's dot, the line at the foot in its pane,
// the frame's first view and paper). Light, Zen and Dark with axe, and a 390 px phone. One worker per process (the harness).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const FP = '3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d';
const DESK = 'd-personal';

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

const real = (errors: string[]): string[] => errors.filter((e) => !/Content Security Policy|frame is sandboxed/.test(e));

interface Arrive {
  theme?: ThemeId;
  registry?: Record<string, unknown> | null;
  init?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
  hash?: string;
}

async function arrive(page: Page, request: APIRequestContext, o: Arrive = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, { configExtra: { courier: { enabled: true }, links: { account: 'https://platform.localhost/account' } }, courier: o.registry ?? null, ...(o.notifications ? { notifications: o.notifications } : {}) });
  if (o.init) await page.addInitScript((i) => ((window as unknown as { __maCourierMockInit: unknown }).__maCourierMockInit = i), o.init);
  await setTheme(page, o.theme ?? 'light');
  await signIn(page, `/?fixture=one${o.hash ?? ''}`);
  await canvasPainted(page);
  return errors;
}

async function openCourier(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Courier/ });
  await expect(tile).toHaveCount(1);
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(body(page)).toBeVisible();
}

async function wide(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await win(page).evaluate((el) => {
    const w = el.closest('.ma-window') as HTMLElement;
    w.style.width = '1100px';
    w.style.height = '760px';
  });
  await expect(body(page)).toHaveAttribute('data-cols', '3');
}

async function openRow(page: Page, name: string | RegExp): Promise<void> {
  await rows(page).filter({ hasText: name }).first().click();
  await expect(thread(page)).toBeVisible();
}

async function lane(page: Page, name: string): Promise<void> {
  await body(page).getByRole('navigation', { name: 'Lanes' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

const calls = (page: Page, m: string): Promise<{ p: Record<string, unknown> }[]> =>
  page.evaluate(([d, method]) => (window as unknown as { __maDeskMock: { courier: { desk(id: string): { control: { calls: { m: string; p: Record<string, unknown> }[] } } } } }).__maDeskMock.courier.desk(d!).control.calls.filter((c) => c.m === method), [DESK, m]);

const REGISTRY = (address: { name: string } | null) => ({
  domain: 'courier.example',
  desks: [
    { deskId: DESK, name: 'Personal', kind: 'personal', address: address ? { address: `${address.name}@courier.example`, ...address } : null },
    { deskId: 'd-work', name: 'Work', kind: 'work', address: { address: 'dana.ortiz@courier.example', name: 'dana.ortiz' } },
  ],
  taken: ['taken.name'],
});

// Courier's switch and registry go back as found, so a spec after this one in the same harness doesn't open with Courier on.
test.afterEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe("this desk's address", () => {
  for (const theme of THEMES) {
    test(`${theme}: choosing it, the field's checks, the stem note, then sharing it with its link and fingerprint`, async ({ page, request, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const errors = await arrive(page, request, { theme, registry: REGISTRY(null) });
      await openCourier(page);
      await wide(page);
      const card = page.getByTestId('courier-address-card');
      await expect(card).toBeVisible();
      await expect(card.getByRole('heading', { name: 'Choose this desk’s address' })).toBeVisible();
      await expect(card).toContainText('Personal desk');
      await expect(body(page).getByRole('navigation', { name: 'Lanes' })).toHaveCount(0);
      const field = card.getByRole('textbox', { name: 'Address' });
      await expect(field).toBeFocused();
      const use = card.getByRole('button', { name: 'Use this address' });
      await expect(use).toBeDisabled();
      await field.fill('ab');
      await expect(card.getByRole('status')).toHaveText('Use 3 to 30 characters.');
      await field.fill('2alex');
      await expect(card.getByRole('status')).toHaveText('Use letters, numbers, dots and hyphens, starting with a letter.');
      await field.fill('support');
      await expect(card.getByRole('status')).toHaveText('That name is kept for the service.');
      await field.fill('taken.name');
      await expect(card.getByRole('status')).toHaveText('That one’s taken.');
      // Sharing a stem with the Work desk's address: the note says so; the registry refuses it, so Use stays off.
      await field.fill('dana.home');
      await expect(card.getByTestId('courier-stem')).toContainText('It starts like your Work desk’s address.');
      await expect(card.getByTestId('courier-stem')).toContainText('Someone with one could guess the other.');
      await expect(use).toBeDisabled();
      await card.getByRole('button', { name: 'How mail to it is kept' }).click();
      await expect(card).toContainText('Email isn’t end-to-end encrypted anywhere.');
      expect(await axe(page)).toEqual([]);
      await field.fill('alex.rivers');
      await expect(card.getByRole('status')).toHaveText('No one has this one.');
      await expect(card.getByTestId('courier-stem')).toHaveCount(0);
      await page.screenshot({ path: `test-results/shots/courierui-${theme}-address.png` });
      await use.click();
      // Share, right after choosing: the address, the invite link (its fragment carries the fingerprint), the fingerprint as text.
      const share = page.getByTestId('courier-share');
      await expect(share).toBeVisible();
      await expect(foot(page)).toContainText('alex.rivers@courier.example is this desk’s address.');
      await expect(share.getByTestId('courier-share-address')).toHaveText('alex.rivers@courier.example');
      const link = await share.getByTestId('courier-share-link').textContent();
      expect(link).toBe(`platform.localhost/c/alex.rivers#k=${FP}&n=Test%20Member`);
      // The code shown is exactly the link's k= (the Designer's call): a mismatch would be a security bug.
      await expect(share.getByTestId('courier-fingerprint')).toHaveText(FP.replace(/-/g, ''));
      const shown = await share.getByTestId('courier-fingerprint').locator('span').allTextContents();
      expect(shown.join('-')).toBe(new URLSearchParams(link!.slice(link!.indexOf('#') + 1)).get('k'));
      await expect(share.getByTestId('courier-fingerprint').locator('span').first()).toHaveAttribute('aria-label', 'Group 1 of 8: 3 f 2 a');
      await expect(share.getByRole('button', { name: /^Copy link/ })).toHaveClass(/primary/);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierui-${theme}-share.png` });
      await share.getByRole('button', { name: /^Copy link/ }).click();
      await expect(foot(page)).toContainText('Link copied.');
      // The line at the foot is inside the pane that acted (the Designer's call 3), not over the window.
      await expect(share.getByTestId('courier-foot')).toHaveCount(1);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://platform.localhost/c/alex.rivers#k=${FP}&n=Test%20Member`);
      const puts = await page.evaluate(async () => (await (await fetch('/__harness')).json()).courierPuts);
      expect(puts).toEqual([{ deskId: DESK, body: { name: 'alex.rivers' } }]);
      await share.getByRole('button', { name: 'Done' }).click();
      await expect(body(page).getByRole('navigation', { name: 'Lanes' })).toBeVisible();
      // Accounts: this desk's address with Share; the icon is an @ (the Designer's call 4).
      await body(page).getByRole('button', { name: 'Accounts' }).click();
      const desk = page.getByTestId('courier-desk-address');
      await expect(desk).toContainText('alex.rivers@courier.example');
      await desk.getByRole('button', { name: 'Share' }).click();
      await expect(page.getByTestId('courier-share')).toBeVisible();
      await expect(page.getByTestId('courier-share').getByRole('button', { name: 'Done' })).toHaveCount(0);
      expect(real(errors)).toEqual([]);
    });
  }

  test('Later: Courier works, and Accounts offers "Choose an address"; no registry is no card', async ({ page, request }) => {
    const errors = await arrive(page, request, { registry: REGISTRY(null) });
    await openCourier(page);
    await page.getByTestId('courier-address-card').getByRole('button', { name: 'Later' }).click();
    await expect(rows(page).first()).toBeVisible();
    await body(page).getByRole('button', { name: 'Accounts' }).click();
    await page.getByTestId('courier-desk-address').getByRole('button', { name: 'Choose an address' }).click();
    await expect(page.getByTestId('courier-address-card')).toBeVisible();
    expect(real(errors)).toEqual([]);
  });

  test('a desk without keys shares the address alone', async ({ page, request }) => {
    const errors = await arrive(page, request, { registry: REGISTRY({ name: 'alex.rivers' }), init: { keys: false } });
    await openCourier(page);
    await body(page).getByRole('button', { name: 'Accounts' }).click();
    await page.getByTestId('courier-desk-address').getByRole('button', { name: 'Share' }).click();
    await expect(page.getByTestId('courier-share-address')).toBeVisible();
    await expect(page.getByTestId('courier-share-link')).toHaveCount(0);
    await expect(page.getByTestId('courier-fingerprint')).toHaveCount(0);
    expect(real(errors)).toEqual([]);
  });
});

test.describe('one person across channels', () => {
  for (const theme of THEMES) {
    test(`${theme}: suggestions only ask; Link with Undo, the person view, Unlink with Undo, Not them`, async ({ page, request }) => {
      const errors = await arrive(page, request, { theme, registry: REGISTRY({ name: 'alex.rivers' }), init: { links: true } });
      await openCourier(page);
      await wide(page);
      // The note at the top of People; nothing is linked by it.
      const note = body(page).getByTestId('courier-linknote');
      await expect(note).toContainText('5 people may be someone you already have.');
      expect(await calls(page, 'courier.links.link')).toEqual([]);
      // The number's own conversation asks "Is this also Dana Ortiz?".
      await openRow(page, '+17205550142');
      const ask = thread(page).getByTestId('courier-suggest');
      await expect(ask).toContainText('Is this also Dana Ortiz?');
      await expect(ask).toContainText('Your Mac’s contacts list this number on Dana’s card.');
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierui-${theme}-suggest.png` });
      await ask.getByRole('button', { name: 'Link to Dana' }).click();
      await expect(foot(page)).toContainText('Linked to Dana Ortiz.');
      expect(await calls(page, 'courier.links.link')).toHaveLength(1);
      // Dana's conversation now, with the number's messages; the reply names where it goes on this first send.
      await expect(thread(page).getByRole('heading', { level: 2 })).toHaveText('Dana Ortiz');
      await expect(thread(page)).toContainText('Landed. Taxi now.');
      await expect(thread(page).locator('.courier-thread-head')).toContainText('and 1 more');
      await expect(thread(page).locator('.courier-compose-why')).toContainText('By iMessage to +17205550142 · ');
      // Undo gives it back.
      await foot(page).getByRole('button', { name: 'Undo' }).click();
      await expect(rows(page).filter({ hasText: '+17205550142' })).toHaveCount(1);
      // The person view: every way to reach them; Unlink is one press, with Undo.
      await rows(page).filter({ hasText: '+17205550142' }).first().click();
      await thread(page).getByTestId('courier-suggest').getByRole('button', { name: 'Link to Dana' }).click();
      await expect(foot(page)).toContainText('Linked to Dana Ortiz.');
      await thread(page).getByRole('button', { name: 'Dana Ortiz: ways to reach them' }).click();
      const person = page.getByTestId('courier-person');
      await expect(person.getByRole('heading', { name: 'Ways to reach Dana' })).toBeVisible();
      await expect(person.locator('.courier-way')).toHaveCount(2);
      await expect(person).toContainText('Email · you added it');
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierui-${theme}-person.png` });
      await person.getByRole('button', { name: 'More actions: +17205550142' }).click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: /Unlink/ })).toContainText('Its messages go back to their own conversation.');
      await menu.getByRole('menuitem', { name: /Unlink/ }).click();
      await expect(foot(page)).toContainText('+17205550142 has its own conversation again.');
      await expect(person.locator('.courier-way')).toHaveCount(1);
      await foot(page).getByRole('button', { name: 'Undo' }).click();
      await expect(person.locator('.courier-way')).toHaveCount(2);
      // Add an email or number: one that has its own conversation brings its messages in.
      await person.getByLabel('Add an email or number').fill('kim.park@mail.example');
      await expect(person.getByRole('status')).toContainText('This brings in 1 message from kim.park@mail.example.');
      // One on someone else asks in place.
      await person.getByLabel('Add an email or number').fill('jordan@smith.example');
      await expect(person.getByRole('status')).toContainText('jordan@smith.example is on Jordan Smith. Move it to Dana?');
      await person.getByRole('button', { name: 'Cancel' }).click();
      await person.getByRole('button', { name: 'Back' }).click();
      // Link people: the review, and Not them, which is never asked again.
      await lane(page, 'People');
      await body(page).getByTestId('courier-linknote').getByRole('button', { name: 'Review' }).click();
      const review = page.getByTestId('courier-review');
      await expect(review).toContainText('Link the 3 that match a contact card');
      await expect(review.getByRole('button', { name: 'Link: jordan.s@mail.example, Jordan Smith' })).not.toHaveClass(/primary/);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierui-${theme}-review.png` });
      await review.getByRole('button', { name: 'Not them: jordan.s@mail.example, Jordan Smith' }).click();
      await expect(foot(page)).toContainText('Okay. Courier won’t ask about this again.');
      await expect(review.getByRole('button', { name: /jordan\.s@mail\.example/ })).toHaveCount(0);
      expect(real(errors)).toEqual([]);
    });
  }

  test('Requests: a card that links a new number to someone, in place of Let in', async ({ page, request }) => {
    const errors = await arrive(page, request, { init: { links: true } });
    await openCourier(page);
    await wide(page);
    await lane(page, 'Requests');
    const card = body(page).locator('.courier-request').filter({ hasText: '+13035550199' });
    await expect(card.getByTestId('courier-suggest')).toContainText('Is this also Kim Park?');
    await expect(card.getByRole('button', { name: /^Let in/ })).toHaveCount(0);
    await card.getByRole('button', { name: 'Link to Kim' }).click();
    await expect(foot(page)).toContainText('Linked to Kim Park.');
    await expect(body(page).locator('.courier-request').filter({ hasText: '+13035550199' })).toHaveCount(0);
    expect(real(errors)).toEqual([]);
  });

  test('Link to someone… (the keyboard way) and a drag onto a person', async ({ page, request }) => {
    const errors = await arrive(page, request, { init: { links: true } });
    await openCourier(page);
    await wide(page);
    await openRow(page, 'Is this still your address?');
    await thread(page).getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Link to someone…' }).click();
    const sheet = page.getByTestId('courier-linksheet');
    await expect(sheet.getByRole('heading')).toHaveText('Link Jordan Smith to someone');
    await expect(sheet.getByRole('searchbox', { name: 'Search people' })).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await thread(page).getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Link to someone…' }).click();
    await sheet.getByRole('button', { name: /Jordan Smith\s*jordan@smith\.example/ }).click();
    await expect(sheet).toContainText('Its messages join Jordan’s conversation. You can unlink it any time.');
    await sheet.getByRole('button', { name: 'Link to Jordan' }).click();
    await expect(foot(page)).toContainText('Linked to Jordan Smith.');
    // A drag: Sam's work address onto Sam Lee's row.
    const from = rows(page).filter({ hasText: 'Studio keys' }).first();
    const to = rows(page).filter({ hasText: 'Perfect, see you there.' }).first();
    await from.dragTo(to);
    await expect(foot(page)).toContainText('Linked to Sam Lee.');
    expect(real(errors)).toEqual([]);
  });

  test('a deskd from before links: no suggestions, no Unlink, no drag or Link to someone…, and never a merge', async ({ page, request }) => {
    const errors = await arrive(page, request, { init: { links: false } });
    await openCourier(page);
    await expect(rows(page).first()).toBeVisible();
    await expect(body(page).getByTestId('courier-linknote')).toHaveCount(0);
    await expect(rows(page).first()).not.toHaveAttribute('draggable', 'true');
    await openRow(page, 'Dana Ortiz');
    await expect(thread(page).getByTestId('courier-suggest')).toHaveCount(0);
    await thread(page).locator('.courier-thread-acts').getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Report spam' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Link to someone…' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await calls(page, 'courier.contact.merge')).toEqual([]);
    expect(real(errors)).toEqual([]);
  });
});

test.describe("an invite link's Add", () => {
  test('arrives in the office: Courier opens on that desk and asks; on Add the desk adds them pinned to the link', async ({ page, request }) => {
    const hash = `#courier-add=rowan.birch&d=${DESK}&k=${FP}&n=Rowan%20Birch`;
    const errors = await arrive(page, request, { hash, registry: REGISTRY({ name: 'alex.rivers' }) });
    // The address bar keeps nothing of it.
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    await expect(win(page)).toBeVisible({ timeout: 10_000 });
    const card = page.getByTestId('courier-invite');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Add Rowan Birch to Courier');
    await expect(card).toContainText('rowan.birch@courier.example');
    await expect(card.getByTestId('courier-invite-fp')).toHaveText(FP.replace(/-/g, ''));
    // Nothing is added until the member presses Add here (Security's CU-L1).
    expect(await calls(page, 'courier.contacts.add')).toEqual([]);
    expect(await axe(page)).toEqual([]);
    await card.getByRole('button', { name: 'Add to Personal' }).click();
    await expect(thread(page).getByRole('heading', { level: 2 })).toHaveText('Rowan Birch');
    // Under the name: checked by the link (flow 3's "Private between desks · Checked by invite link").
    await expect(thread(page).getByTestId('courier-keyline')).toHaveText('Private between desks · Checked by invite link');
    expect((await calls(page, 'courier.contacts.add')).map((c) => c.p)).toEqual([{ name: 'rowan.birch', fingerprint: FP, displayName: 'Rowan Birch' }]);
    expect(real(errors)).toEqual([]);
  });

  test("a fingerprint that doesn't match says so; a link without one says what letting them in trusts", async ({ page, request }) => {
    const hash = `#courier-add=rowan.birch&d=${DESK}&k=0000-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d&n=Rowan%20Birch`;
    const errors = await arrive(page, request, { hash });
    await expect(win(page)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('courier-invite').getByRole('button', { name: /^Add to/ }).click();
    // Said on the card, in place (CT-I7), with no Add.
    await expect(page.getByTestId('courier-invite-problem')).toHaveText('This link’s fingerprint doesn’t match Rowan’s desk now. Ask Rowan for a new link.');
    await expect(page.getByTestId('courier-invite').getByRole('button', { name: /^Add to/ })).toHaveCount(0);
    await page.evaluate((h) => sessionStorage.setItem('ma-courier-add', `${Date.now()}${h}`), `#courier-add=sam.oak&d=${DESK}&n=Sam%20Oak`);
    await page.reload();
    await canvasPainted(page);
    await expect(page.getByTestId('courier-invite-nofp')).toContainText('Letting Sam in trusts their desk’s key as it is now. To be sure it’s Sam, compare safety numbers after.', { timeout: 10_000 });
    await page.getByTestId('courier-invite').getByRole('button', { name: 'Not now' }).click();
    expect(await calls(page, 'courier.contacts.add')).toHaveLength(0);
    expect(real(errors)).toEqual([]);
  });
});

test.describe('the tile and the bell (Wave 3.4)', () => {
  test("the tile counts People's unread and Requests, names up to three people, and the bell's Courier item says counts only", async ({ page, request }) => {
    const now = new Date().toISOString();
    const reg = REGISTRY({ name: 'alex.rivers' });
    (reg.desks[0] as Record<string, unknown>)['pending'] = 3;
    const errors = await arrive(page, request, {
      registry: reg,
      notifications: { items: [{ id: 'nt-c1', type: 'courier.waiting', title: 'New messages on your Personal desk', body: 'Dana: the seed list', count: 3, link: 'http://localhost:4173/', createdAt: now, updatedAt: now, readAt: null }] },
    });
    // A desk that's open counts for itself (People's unread and Requests' new senders); while it sleeps, the platform's
    // waiting count is added to the last count it gave.
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Courier/ });
    await expect(tile).toHaveAccessibleName(/^Courier, \d+ unread/, { timeout: 10_000 });
    const named = await tile.getAttribute('aria-label');
    expect(Number(/(\d+) unread/.exec(named ?? '')?.[1])).toBeGreaterThan(0);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const row = page.getByRole('dialog', { name: 'Notifications' }).getByRole('link', { name: /New messages on your Personal desk/ });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('seed list');
    expect(real(errors)).toEqual([]);
  });
});

test.describe("the Designer's calls", () => {
  test("People has a dot, not a count; a person's mail opens as text and Updates as sent; the frame's paper follows the theme", async ({ page, request }) => {
    const errors = await arrive(page, request, { theme: 'dark' });
    await openCourier(page);
    await wide(page);
    const people = body(page).getByRole('navigation', { name: 'Lanes' }).getByRole('button', { name: /^People/ });
    await expect(people.locator('.courier-count')).toHaveCount(0);
    await expect(people.locator('.courier-dot')).toHaveCount(1);
    await expect(people).toHaveAccessibleName('People unread messages');
    await openRow(page, 'Dana Ortiz');
    const card = thread(page).locator('.courier-card.open');
    await expect(card.getByRole('button', { name: 'Text only' })).toHaveAttribute('aria-pressed', 'true');
    await card.getByRole('button', { name: 'As sent' }).click();
    expect(await card.getByTestId('courier-frame').getAttribute('srcdoc')).toContain('data-paper="dark"');
    // The frame takes the pane's free height, at least 320 px.
    const h = await card.getByTestId('courier-frame').evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(320);
    await lane(page, 'Updates');
    await openRow(page, 'City Water');
    expect(real(errors)).toEqual([]);
  });

  test('a 390 px phone: the address card with the domain on its own line, and the link sheet from the bottom', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, request, { registry: REGISTRY(null), init: { links: true } });
    await openCourier(page);
    const card = page.getByTestId('courier-address-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.courier-addr-field')).toHaveAttribute('data-narrow', 'true');
    expect(await body(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: 'test-results/shots/courierui-phone-address.png' });
    await card.getByRole('button', { name: 'Later' }).click();
    await expect(rows(page).first()).toBeVisible();
    expect(real(errors)).toEqual([]);
  });
});
