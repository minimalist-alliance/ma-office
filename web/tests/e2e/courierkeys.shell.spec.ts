// Members' keys in Courier's office (the Designer's flows 3 to 6; CT-I7 of mm-courier-transports.md), on the mock desk with
// Courier's switch on: a contact's changed key in their conversation (held until checked, two equal answers, the reply kept),
// the safety number in the person view (Copy, Compare safety numbers, Mark as checked), and an invite's Add the desk refused (a
// fingerprint that doesn't match, a checked key that changed). Light, Zen and Dark with axe, and a 390 px phone.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const DESK = 'd-personal';
const FP = '3f2a-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d';

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
  hash?: string;
}

async function arrive(page: Page, request: APIRequestContext, o: Arrive = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, { configExtra: { courier: { enabled: true }, links: { account: 'https://platform.localhost/account' } }, courier: o.registry ?? null });
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

type Mocked = { __maDeskMock: { courier: { desk(id: string): { control: { calls: { m: string; p: Record<string, unknown> }[] }; pins: Map<string, { state: string; number: string; newNumber: string | null }> } } } };
const calls = (page: Page, m: string): Promise<{ p: Record<string, unknown> }[]> =>
  page.evaluate(([d, method]) => (window as unknown as Mocked).__maDeskMock.courier.desk(d!).control.calls.filter((c) => c.m === method), [DESK, m]);
const pin = (page: Page, address: string): Promise<{ state: string; number: string; newNumber: string | null } | null> =>
  page.evaluate(([d, a]) => (window as unknown as Mocked).__maDeskMock.courier.desk(d!).pins.get(a!) ?? null, [DESK, address]);

const REGISTRY = {
  domain: 'courier.example',
  desks: [{ deskId: DESK, name: 'Personal', kind: 'personal', address: { address: 'alex.rivers@courier.example', name: 'alex.rivers' } }],
  taken: [],
};

const groups = (l: Locator): Promise<string[]> => l.locator('span').allInnerTexts();

test.afterEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe("a contact's changed key", () => {
  for (const theme of THEMES) {
    test(`${theme}: held until checked, two equal answers, the reply kept; Numbers match lets it in`, async ({ page, request }) => {
      const errors = await arrive(page, request, { theme, init: { keyChanged: true } });
      await openCourier(page);
      await wide(page);
      await openRow(page, 'Rowan Birch');
      const t = thread(page);
      await expect(t.getByTestId('courier-keyline')).toHaveText('Private between desks · New key, not checked');
      await expect(t.getByTestId('courier-held')).toHaveText('1 message from Rowan is held until you check.');
      const card = t.getByTestId('courier-key-changed');
      await expect(card.getByRole('heading', { level: 3 })).toHaveText('Rowan’s desk has a new key');
      await expect(card).toContainText('Private messages with Rowan are held until you check it.');
      const shown = await groups(card.getByTestId('courier-key-number'));
      expect(shown).toHaveLength(12);
      expect(shown.every((g) => /^\d{5}$/.test(g))).toBe(true);
      expect((await pin(page, 'rowan.birch@courier.example'))?.newNumber).toBe(shown.join(' '));
      // Two equal answers: neither is the primary button.
      const match = card.getByRole('button', { name: 'Numbers match' });
      const noMatch = card.getByRole('button', { name: 'They don’t match' });
      await expect(match).not.toHaveClass(/primary/);
      await expect(noMatch).not.toHaveClass(/primary/);
      // The reply keeps its words and can't go privately.
      const reply = t.getByRole('textbox', { name: /^Reply to/ });
      await reply.fill('Did you get the seed list?');
      await expect(t.locator('.courier-compose-why')).toHaveText('By private message · held until you check Rowan’s new key');
      await expect(t.getByRole('button', { name: 'Send' })).toBeDisabled();
      await expect(t.locator('.courier-compose-foot')).toContainText('Your draft is kept.');
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierkeys-${theme}-changed.png` });
      expect(await calls(page, 'courier.contact.verify')).toEqual([]);
      await match.click();
      await expect(foot(page)).toContainText('Checked. Messages with Rowan go again.');
      expect((await calls(page, 'courier.contact.verify')).map((c) => c.p)).toEqual([{ address: 'rowan.birch@courier.example', safetyNumber: shown.join(' ') }]);
      // What it held comes in; the card and the hold go, and the reply can go.
      await expect(t.getByText('Here is the seed list, as promised.')).toBeVisible();
      await expect(t.getByTestId('courier-key-changed')).toHaveCount(0);
      await expect(t.getByTestId('courier-held')).toHaveCount(0);
      await expect(t.getByTestId('courier-keyline')).toHaveText(/^Private between desks · Checked [A-Z][a-z]{2} \d{1,2}$/);
      await expect(t.getByRole('button', { name: 'Send' })).toBeEnabled();
      expect(real(errors)).toEqual([]);
    });
  }

  test("They don't match: everything stays held, and nothing is asked of the desk", async ({ page, request }) => {
    const errors = await arrive(page, request, { init: { keyChanged: true } });
    await openCourier(page);
    await wide(page);
    await openRow(page, 'Rowan Birch');
    const card = thread(page).getByTestId('courier-key-changed');
    await card.getByRole('button', { name: 'They don’t match' }).click();
    await expect(card.getByRole('status')).toHaveText('Private messages with Rowan stay held. Ask Rowan for a new invite link.');
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(thread(page).getByTestId('courier-held')).toBeVisible();
    expect(await calls(page, 'courier.contact.verify')).toEqual([]);
    expect((await pin(page, 'rowan.birch@courier.example'))?.state).toBe('changed');
    expect(real(errors)).toEqual([]);
  });

  test('a 390 px phone: the card and its number fit, each answer a 44 px target', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, request, { init: { keyChanged: true } });
    await openCourier(page);
    await expect(body(page)).toHaveAttribute('data-cols', '1');
    await openRow(page, 'Rowan Birch');
    const card = thread(page).getByTestId('courier-key-changed');
    await card.scrollIntoViewIfNeeded();
    for (const name of ['Numbers match', 'They don’t match']) {
      const box = await card.getByRole('button', { name }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const sn = await card.getByTestId('courier-key-number').boundingBox();
    expect(sn!.x).toBeGreaterThanOrEqual(0);
    expect(sn!.x + sn!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'test-results/shots/courierkeys-phone-changed.png' });
    expect(real(errors)).toEqual([]);
  });
});

test.describe('the safety number', () => {
  for (const theme of THEMES) {
    test(`${theme}: "Compare safety numbers" under the name opens it; Compare safety numbers marks it checked on a match`, async ({ page, request, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const errors = await arrive(page, request, { theme });
      await openCourier(page);
      await wide(page);
      await openRow(page, 'Sam Lee');
      const line = thread(page).getByTestId('courier-keyline');
      await expect(line).toHaveText('Private between desks · Compare safety numbers');
      await line.getByRole('button', { name: 'Compare safety numbers' }).click();
      const sec = page.getByTestId('courier-safety');
      await expect(sec.getByRole('heading', { level: 3 })).toHaveText('Safety number');
      await expect(sec).toContainText('MA can’t read your private messages. It can see which desks talk, when and how much. To rule out MA itself, compare this number with Sam’s, in person or another way you trust.');
      await expect(sec).toContainText('Not checked yet.');
      const number = (await groups(sec.getByTestId('courier-sn'))).join(' ');
      expect(number).toMatch(/^\d{5}( \d{5}){11}$/);
      await expect(sec.getByTestId('courier-sn').locator('span').first()).toHaveAttribute('aria-label', /^Group 1 of 12: \d \d \d \d \d$/);
      await sec.getByRole('button', { name: 'Copy: Safety number' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(number);
      await sec.getByRole('button', { name: 'Compare safety numbers' }).click();
      const field = sec.getByRole('textbox', { name: 'Paste their number' });
      await expect(field).toHaveAttribute('placeholder', 'Paste their number');
      // Theirs with one digit wrong: they don't match, and nothing is marked.
      const wrong = `${number.slice(0, -1)}${number.endsWith('0') ? '1' : '0'}`;
      await field.fill(wrong.replace(/ /g, '\n'));
      await expect(sec.getByRole('status')).toHaveText('They don’t match. Don’t mark it checked; talk to Sam another way.');
      expect(await calls(page, 'courier.contact.verify')).toEqual([]);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierkeys-${theme}-safety.png` });
      // Spaces and line breaks don't count.
      await field.fill(number.replace(/ /g, ''));
      await expect(sec.getByRole('status')).toHaveText(/^They match\. Marked as checked, [A-Z][a-z]{2} \d{1,2}\.$/);
      expect((await calls(page, 'courier.contact.verify')).map((c) => c.p)).toEqual([{ address: 'sam.lee@courier.example', safetyNumber: number }]);
      await expect(sec.getByRole('button', { name: 'Mark as checked' })).toHaveCount(0);
      expect((await pin(page, 'sam.lee@courier.example'))?.state).toBe('verified');
      expect(real(errors)).toEqual([]);
    });
  }

  test('Mark as checked, for a comparison done aloud', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await openCourier(page);
    await wide(page);
    await openRow(page, 'Sam Lee');
    await thread(page).getByTestId('courier-keyline').getByRole('button', { name: 'Compare safety numbers' }).click();
    const sec = page.getByTestId('courier-safety');
    const number = (await groups(sec.getByTestId('courier-sn'))).join(' ');
    await sec.getByRole('button', { name: 'Mark as checked' }).click();
    await expect(foot(page)).toContainText(/Checked [A-Z][a-z]{2} \d{1,2}\./);
    expect((await calls(page, 'courier.contact.verify')).map((c) => c.p)).toEqual([{ address: 'sam.lee@courier.example', safetyNumber: number }]);
    await expect(sec).toContainText(/Checked [A-Z][a-z]{2} \d{1,2}\./);
    await expect(sec.getByRole('button', { name: 'Mark as checked' })).toHaveCount(0);
    expect(real(errors)).toEqual([]);
  });
});

test.describe("an invite the desk couldn't add (CT-I7)", () => {
  test("a link that doesn't match a desk already pinned: no Add; Compare safety numbers opens theirs", async ({ page, request }) => {
    const hash = `#courier-add=sam.lee&d=${DESK}&k=0000-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d&n=Sam%20Lee`;
    const errors = await arrive(page, request, { hash, registry: REGISTRY });
    await expect(win(page)).toBeVisible({ timeout: 10_000 });
    const card = page.getByTestId('courier-invite');
    await card.getByRole('button', { name: 'Add to Personal' }).click();
    await expect(card).toHaveAttribute('data-problem', 'mismatch');
    await expect(card.getByTestId('courier-invite-problem')).toHaveText('This link’s fingerprint doesn’t match Sam’s desk now. Ask Sam for a new link.');
    await expect(card.getByRole('button', { name: /^Add to/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await card.getByRole('button', { name: 'Compare safety numbers' }).click();
    await expect(page.getByTestId('courier-person').getByRole('heading', { level: 2 })).toHaveText('Sam Lee');
    await expect(page.getByTestId('courier-safety')).toContainText('Not checked yet.');
    expect(real(errors)).toEqual([]);
  });

  for (const theme of THEMES) {
    test(`${theme}: a key the member checked has changed: its new number on the card; Numbers match adds them`, async ({ page, request }) => {
      const hash = `#courier-add=sam.lee&d=${DESK}&k=1111-91c0-7d4e-b815-0a6c-e2f9-5b37-c41d&n=Sam%20Lee`;
      const errors = await arrive(page, request, { theme, hash, registry: REGISTRY });
      await expect(win(page)).toBeVisible({ timeout: 10_000 });
      // Sam was checked before (by an earlier link).
      await page.evaluate(([d]) => {
        const p = (window as unknown as Mocked).__maDeskMock.courier.desk(d!).pins.get('sam.lee@courier.example')!;
        p.state = 'verified';
      }, [DESK]);
      const card = page.getByTestId('courier-invite');
      await wide(page);
      await card.getByRole('button', { name: 'Add to Personal' }).click();
      await expect(card).toHaveAttribute('data-problem', 'changed');
      const kc = card.getByTestId('courier-key-changed');
      await expect(kc.getByRole('heading', { level: 3 })).toHaveText('Sam’s desk has a new key');
      const shown = (await groups(kc.getByTestId('courier-key-number'))).join(' ');
      expect((await pin(page, 'sam.lee@courier.example'))?.newNumber).toBe(shown);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/courierkeys-${theme}-invite-changed.png` });
      await kc.getByRole('button', { name: 'Numbers match' }).click();
      // Checked: the Add goes through, and their conversation opens, checked.
      await expect(thread(page).getByRole('heading', { level: 2 })).toHaveText('Sam Lee');
      expect((await calls(page, 'courier.contact.verify')).map((c) => c.p)).toEqual([{ address: 'sam.lee@courier.example', safetyNumber: shown }]);
      expect(await calls(page, 'courier.contacts.add')).toHaveLength(2);
      await expect(thread(page).getByTestId('courier-keyline')).toHaveText('Private between desks · Checked by invite link');
      expect(real(errors)).toEqual([]);
    });
  }

  test('a closed address says so, with no Add', async ({ page, request }) => {
    const hash = `#courier-add=closed.one&d=${DESK}&k=${FP}&n=Ola%20Berg`;
    const errors = await arrive(page, request, { hash, registry: REGISTRY });
    await expect(win(page)).toBeVisible({ timeout: 10_000 });
    const card = page.getByTestId('courier-invite');
    await card.getByRole('button', { name: 'Add to Personal' }).click();
    await expect(card.getByTestId('courier-invite-problem')).toHaveText('This address is no longer in use.');
    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toHaveCount(0);
    expect(real(errors)).toEqual([]);
  });
});
