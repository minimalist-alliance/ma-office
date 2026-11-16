// Courier's spam and safety and attachments into Files in the office (Waves 3.2 and 3.1, deskd API.md §21), on the mock desk with
// Courier's switch on: sender warnings as neutral cards and a warned row's mark; a known contact's mail whose sender check
// failed, in Requests with its card and no Block (the coordinator's call, Nov 14); the learning filter's Spam and Not spam;
// Report spam with Undo; Save to Files with the second press for a dangerous type; blocked senders in Accounts with Unblock.
// Light, Zen and Dark with axe, and a 390 px phone. One worker per process (the harness).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
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

// Courier's switch and the mock go back as found, so a spec after this one doesn't open with Courier on.
test.afterEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('spam and safety', () => {
  for (const theme of THEMES) {
    test(`${theme}: warnings, a forged contact in Requests, the filter's Spam, Report spam with Undo`, async ({ page, request }) => {
      const errors = await arrive(page, request, { theme, init: { safety: true } });
      await openCourier(page);
      await wide(page);
      await lane(page, 'Requests');
      const cards = body(page).locator('.courier-request');
      // The stranger who borrows Dana's name, from a lookalike domain: its row is marked, and its message says both.
      const pal = cards.filter({ hasText: 'dana.ortiz@0rtiz-mail.example' });
      await expect(pal.getByTestId('courier-forged')).toHaveCount(0);
      await pal.locator('.courier-request-open').click();
      const warnings = thread(page).getByTestId('courier-warning');
      await expect(warnings).toHaveCount(2);
      await expect(warnings.nth(0)).toContainText('This isn’t Dana’s usual address.');
      await expect(warnings.nth(1)).toContainText('This address looks like ortiz.example.');
      await expect(warnings.nth(1)).toContainText('It’s really 0rtiz-mail.example.');
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/couriersafety-${theme}-warnings.png` });
      // Mail in Dana's own name whose sender check failed: a Request, with its card, Report spam and no Block.
      const forged = cards.filter({ hasText: 'Quick favour' });
      await expect(forged.getByTestId('courier-forged')).toContainText('Couldn’t confirm it’s really them.');
      await expect(forged.getByRole('button', { name: /^Block/ })).toHaveCount(0);
      await forged.locator('.courier-request-open').click();
      await expect(thread(page).getByTestId('courier-forged')).toContainText('It uses Dana Ortiz’s address, but its sender check failed');
      await expect(thread(page).getByRole('button', { name: 'Block' })).toHaveCount(0);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/couriersafety-${theme}-forged.png` });
      await thread(page).getByTestId('courier-forged').getByRole('button', { name: 'Report spam' }).click();
      await expect(foot(page)).toContainText('Spam: Dana Ortiz');
      expect((await calls(page, 'courier.report')).map((c) => c.p['block'])).toEqual([undefined]);
      await foot(page).getByRole('button', { name: 'Undo' }).click();
      await expect(body(page).locator('.courier-request').filter({ hasText: 'Quick favour' })).toHaveCount(1);
      // The filter's Spam says so; Not spam brings it back.
      await lane(page, 'Spam');
      await openRow(page, 'Deals Desk');
      await expect(thread(page).getByTestId('courier-filtered')).toHaveText('Courier’s filter put this in Spam. Not spam teaches it.');
      await thread(page).getByRole('button', { name: 'Not spam' }).click();
      await expect(foot(page)).toContainText('Not spam: Deals Desk');
      expect(real(errors)).toEqual([]);
    });
  }

  test('Report spam from a conversation, and blocked senders in Accounts with Unblock', async ({ page, request }) => {
    const errors = await arrive(page, request, { init: { safety: true } });
    await openCourier(page);
    await wide(page);
    await openRow(page, 'Priya Shah');
    await thread(page).getByRole('button', { name: 'More actions' }).first().click();
    await page.getByRole('menuitem', { name: 'Report spam' }).click();
    await expect(foot(page)).toContainText('Spam: Priya Shah');
    expect(await calls(page, 'courier.report')).toHaveLength(1);
    await foot(page).getByRole('button', { name: 'Undo' }).click();
    await expect(rows(page).filter({ hasText: 'Priya Shah' })).toHaveCount(1);
    await body(page).getByRole('button', { name: 'Accounts' }).click();
    const blocked = page.getByTestId('courier-blocked');
    await expect(blocked).toContainText('Anyone at prizes.example');
    await blocked.getByRole('button', { name: 'Unblock: Anyone at prizes.example' }).click();
    await expect(foot(page)).toContainText('Anyone at prizes.example is no longer blocked.');
    await expect(blocked).toContainText('No one is blocked.');
    expect(real(errors)).toEqual([]);
  });
});

test.describe('attachments into Files', () => {
  test('Save to Files, and a dangerous type only after its second press; on a phone, 44 px', async ({ page, request }) => {
    const errors = await arrive(page, request, {});
    await openCourier(page);
    await wide(page);
    await openRow(page, 'Dana Ortiz');
    const card = thread(page).locator('.courier-card.open');
    await card.getByRole('button', { name: 'Save to Files: garden-sketch.pdf' }).click();
    await expect(foot(page)).toContainText(/Saved to Files: Courier\/\d{4}-\d{2}-\d{2} Garden plans\/garden-sketch\.pdf/);
    await card.getByRole('button', { name: 'Save to Files: garden-sketch.pdf' }).click();
    await expect(foot(page)).toContainText('Already in Files:');
    // A program: the first press asks, in place; nothing is saved until the second.
    await card.getByRole('button', { name: 'Save to Files: planting-tool.exe' }).click();
    const ask = card.locator('[data-danger="program"]').getByRole('group', { name: 'Save it to Files anyway?' });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Save anyway' })).toBeFocused();
    expect((await calls(page, 'courier.attachment.save')).filter((c) => c.p['part'] === '3')).toEqual([]);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: 'test-results/shots/couriersafety-light-save.png' });
    await ask.getByRole('button', { name: 'Save anyway' }).click();
    await expect(foot(page)).toContainText('planting-tool.exe');
    expect((await calls(page, 'courier.attachment.save')).filter((c) => c.p['part'] === '3').map((c) => c.p['allowDanger'])).toEqual([true]);
    expect(real(errors)).toEqual([]);
  });

  test('a 390 px phone: the warnings and Save to Files fit, 44 px targets, axe clean', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, request, { init: { safety: true } });
    await openCourier(page);
    await rows(page).filter({ hasText: 'Dana Ortiz' }).first().click();
    const save = thread(page).getByRole('button', { name: 'Save to Files: garden-sketch.pdf' });
    await expect(save).toBeVisible();
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await body(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await axe(page)).toEqual([]);
    expect(real(errors)).toEqual([]);
  });
});
