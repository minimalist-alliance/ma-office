// MA Connector for Mac in Courier's Accounts, on the mock desk (`desk/mockDeskCourier.ts`'s courier.imsg.pair): the member
// types the code their Mac shows, the desk claims it, and the Mac's row says how it stands, with Disconnect. In Light, Zen and
// Dark, with axe; a phone at 390 px. The mock's Mac shows BCDF-GHJK; BCDF-ZZZZ is one that needs Full Disk Access.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

const win = (page: Page): Locator => page.getByTestId('courier-window');
const body = (page: Page): Locator => page.getByTestId('courier-body');

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

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { configExtra: { courier: { enabled: true } } });
  await setTheme(page, theme);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  return errors;
}

async function openAccounts(page: Page): Promise<Locator> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Courier/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await body(page).getByRole('button', { name: 'Accounts', exact: true }).click();
  const setup = page.getByTestId('courier-setup');
  await expect(setup).toBeVisible();
  return setup;
}

test.afterEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('Courier: iMessage on your Mac', () => {
  for (const theme of THEMES) {
    test(`${theme}: a code from the Mac pairs it, its row says how it stands, Disconnect ends it, axe clean`, async ({ page, request }) => {
      const errors = await arrive(page, request, theme);
      await page.setViewportSize({ width: 1440, height: 900 });
      const setup = await openAccounts(page);
      await setup.getByRole('button', { name: /^iMessage on your Mac/ }).click();
      const form = page.getByTestId('courier-mac-form');
      await expect(form).toBeVisible();
      await expect(form).toContainText('MA never sees them.');
      const code = form.getByLabel('Code from your Mac');
      // Typed any way: two groups of four, upper case.
      await code.fill('bcdf ghjk');
      await expect(code).toHaveValue('BCDF-GHJK');
      expect(await axe(page)).toEqual([]);
      await page.waitForTimeout(300);
      await win(page).screenshot({ path: `test-results/shots/couriermac-${theme}-code.png` });
      // A code that isn't waiting: said in words, nothing kept.
      await code.fill('BCDF-MMMM');
      await form.getByRole('button', { name: 'Connect' }).click();
      await expect(form.getByRole('alert')).toContainText('That code isn’t waiting.');
      await win(page).screenshot({ path: `test-results/shots/couriermac-${theme}-not-waiting.png` });
      await code.fill('BCDF-GHJK');
      await form.getByRole('button', { name: 'Connect' }).click();
      await expect(page.getByTestId('courier-foot')).toContainText('Now press Connect on your Mac. It shows 4071 2958 3316.');
      // The number is read whole: the line wraps, never cut short.
      const cut = await page.getByTestId('courier-foot').locator('span').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(cut).toBe(false);
      const row = setup.locator('.courier-account[data-kind="imessage"]');
      await expect(row).toContainText('iMessage on your Mac');
      await expect(row).toContainText('Connected through MA Connector');
      await expect(row).toContainText('Checked 2 minutes ago.');
      await expect(row).toContainText('Check number 4071 2958 3316. Your Mac shows the same.');
      expect(await axe(page)).toEqual([]);
      await win(page).screenshot({ path: `test-results/shots/couriermac-${theme}-connected.png` });
      // One Mac a desk.
      await setup.getByRole('button', { name: /^iMessage on your Mac/ }).click();
      await page.getByTestId('courier-mac-form').getByLabel('Code from your Mac').fill('BCDF-GHJK');
      await page.getByTestId('courier-mac-form').getByRole('button', { name: 'Connect' }).click();
      await expect(page.getByTestId('courier-mac-form').getByRole('alert')).toContainText('This desk has a Mac already.');
      await page.getByTestId('courier-mac-form').getByRole('button', { name: 'Other providers' }).click();
      // Disconnect: the messages stay by default.
      await row.getByRole('button', { name: 'Remove iMessage on your Mac' }).click();
      await expect(row).toContainText('Disconnect this Mac from this desk?');
      await expect(row.getByLabel('Keep the messages already on this desk')).toBeChecked();
      await win(page).screenshot({ path: `test-results/shots/couriermac-${theme}-disconnect.png` });
      await row.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(page.getByTestId('courier-foot')).toContainText('Your Mac is disconnected.');
      await expect(setup.locator('.courier-account[data-kind="imessage"]')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test('a Mac that needs Full Disk Access says so on its row; a phone at 390 px', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await page.setViewportSize({ width: 390, height: 844 });
    const setup = await openAccounts(page);
    await setup.getByRole('button', { name: /^iMessage on your Mac/ }).click();
    const form = page.getByTestId('courier-mac-form');
    await form.getByLabel('Code from your Mac').fill('bcdfzzzz');
    await form.getByRole('button', { name: 'Connect' }).click();
    const row = setup.locator('.courier-account[data-kind="imessage"]');
    await expect(row).toContainText('Needs you: on your Mac, allow MA Connector under Full Disk Access.');
    await expect(row).toHaveAttribute('data-needs-you', 'true');
    const box = await row.boundingBox();
    expect(box && box.width <= 390).toBe(true);
    await page.screenshot({ path: 'test-results/shots/couriermac-phone-needs-you.png' });
    expect(errors).toEqual([]);
  });
});
