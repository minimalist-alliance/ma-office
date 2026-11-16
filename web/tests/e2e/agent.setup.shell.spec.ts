// The new-agent setup screen and its settings (draft ADR "the Agent's tools and approvals", section 16; deskd API.md section
// 18), on `MockDeskLink`, whose agent mock keeps each agent's access and refuses a run before its screen is saved, as
// desk-agent does, so the real `RpcAgentClient` and the window run as on a desk. `?agentSetup=new` has every agent the fixture
// starts with waiting for its screen; `upgrade` as agents made before the screen. The office is `?fixture=three`: Personal,
// Work and a Guild Desk, so "Other desks" offers Work alone. Every screen in Light, Zen and Dark with axe, a phone, and the
// owner's colour rule: nothing on it green, brown or warm.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface MockControl {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  agent: { desks: Record<string, { client: { needsSetup(agentId: string, reason?: string): void; allowGrant(agentId: string, deskId: string): void } }> };
}
type W = { __maDeskMock: MockControl };

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const screen = (page: Page): Locator => page.getByTestId('setup-screen');
const rpcs = (page: Page, method: string): Promise<Record<string, unknown>[]> =>
  page.evaluate((m) => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === m).map((r) => r.p), method);
const agentMock = (page: Page, hook: 'needsSetup' | 'allowGrant', ...args: string[]): Promise<void> =>
  page.evaluate(
    ([name, list]) => {
      const desks = (window as unknown as W).__maDeskMock.agent.desks;
      const client = (desks['d-personal'] ?? Object.values(desks)[0])!.client as unknown as Record<string, (...a: unknown[]) => unknown>;
      client[name as string]!(...(list as unknown[]));
    },
    [hook, args] as const,
  );

async function arrive(page: Page, query: string): Promise<void> {
  await signIn(page, `/?fixture=three&speed=fast${query}`);
  await canvasPainted(page);
}

async function openAgent(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
  const fill = agentWindow(page).getByRole('button', { name: 'Fill the screen' });
  if (await fill.isVisible()) {
    await fill.click();
    await page.waitForTimeout(300);
  }
}

async function pick(page: Page, agentId: string): Promise<void> {
  const row = page.getByTestId(`agent-${agentId}`);
  const toggle = page.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => (await row.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await row.isVisible())) await toggle.click();
  await row.click();
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

/**
 * The owner's colour rule (Nov 12): no green, brown or warm tints. Every colour the screen draws with (text, fills, borders,
 * the switches) that carries any colour at all is a blue to violet one, or a grey.
 */
async function tints(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const out: string[] = [];
    const hueOf = (c: string): { h: number; s: number } | null => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
      if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
      const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0 };
      const s = d / (1 - Math.abs(2 * l - 1));
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return { h, s };
    };
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const cs = getComputedStyle(node);
      for (const prop of ['color', 'background-color', 'border-top-color', 'outline-color']) {
        const value = cs.getPropertyValue(prop);
        const hs = hueOf(value);
        // A grey (little saturation) is fine; a colour must be between cyan-blue and violet.
        if (hs && hs.s > 0.18 && !(hs.h >= 190 && hs.h <= 290)) out.push(`${node.tagName.toLowerCase()}.${(node as HTMLElement).className} ${prop} ${value}`);
      }
    }
    return [...new Set(out)];
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: a new agent's screen, its defaults, Save and the thread, clean and calm`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, '&agentFixture=ready&agentSetup=new');
    await openAgent(page);

    const s = screen(page);
    await expect(s).toBeVisible();
    await expect(s.getByRole('heading', { name: 'What can Lead use?' })).toBeVisible();
    await expect(s).toContainText('Lead asks you before it changes, sends or buys anything, unless you say otherwise below.');
    await expect(page.getByTestId('access-reason')).toHaveCount(0);
    // Notebook, Files, Browser and To-dos start on; Courier off.
    for (const [app, on] of [['Notebook', true], ['Files', true], ['Browser', true], ['Courier', false], ['To-dos', true]] as const) {
      await expect(s.getByRole('switch', { name: new RegExp(`^${app}`) })).toBeChecked({ checked: on });
    }
    await expect(s.getByRole('switch', { name: /^Courier/ })).toHaveAccessibleName(/It can’t send anything/);
    // Other desks: Work, never this desk or the Guild Desk, and off.
    const desks = page.getByTestId('access-desks');
    await expect(desks).toContainText('Let Lead message agents on your other desks.');
    await expect(desks.getByRole('switch')).toHaveCount(1);
    await expect(desks.getByRole('switch', { name: /^Work/ })).not.toBeChecked();
    // Without asking: all off, and what it never does unasked.
    const auto = page.getByTestId('access-auto');
    await expect(auto.getByRole('switch')).toHaveCount(3);
    for (const sw of await auto.getByRole('switch').all()) await expect(sw).not.toBeChecked();
    await expect(page.getByTestId('access-always')).toHaveText(/never deletes, sends, buys, uses your sign-ins or changes what you wrote without asking/);
    // No composer while it waits: nothing can be sent before the save.
    await expect(page.getByTestId('composer-input')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    expect(await tints(s)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-setup-${theme}-new.png` });

    await s.getByTestId('access-save').click();
    await expect(screen(page)).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    // The first save is every app and every switch, and nothing more.
    expect(await rpcs(page, 'agent.access.set')).toEqual([{ agentId: 'manager', apps: { notebook: true, files: true, browser: true, courier: false, todos: true }, auto: { notebook: null, files: null, todos: false } }]);
    expect(errors).toEqual([]);
  });
}

test('Back keeps it waiting, with no composer, and Set up brings the screen again', async ({ page }) => {
  await arrive(page, '&agentFixture=ready&agentSetup=new');
  await openAgent(page);
  await screen(page).getByTestId('access-back').click();
  const waiting = page.getByTestId('setup-waiting');
  await expect(waiting).toContainText('Lead is waiting for you to set it up.');
  expect(await tints(waiting)).toEqual([]);
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
  expect(await rpcs(page, 'agent.access.set')).toEqual([]);
  await waiting.getByRole('button', { name: 'Set up Lead' }).click();
  await expect(screen(page)).toBeVisible();
});

test('a switch needs its app: off with it, and saying so; a new place is made as the member saves', async ({ page }) => {
  await arrive(page, '&agentFixture=ready&agentSetup=new');
  await openAgent(page);
  const s = screen(page);
  const notebookAuto = page.getByTestId('access-auto-notebook').getByRole('switch');
  const filesAuto = page.getByTestId('access-auto-files').getByRole('switch');
  await s.getByRole('switch', { name: /^Notebook/ }).click({ force: true });
  await expect(notebookAuto).toBeDisabled();
  await expect(notebookAuto).toHaveAccessibleName(/Turn on Notebook first/);
  // Files' switch: a new folder named after the agent, made on Save, then chosen.
  await filesAuto.click({ force: true });
  await expect(filesAuto).toBeChecked();
  await expect(page.getByTestId('access-place-files')).toHaveValue('__new__');
  await expect(page.getByTestId('access-place-files').locator('option').first()).toHaveText('A new folder, “Lead”');
  await s.getByTestId('access-save').click();
  await expect(screen(page)).toHaveCount(0);
  expect((await rpcs(page, 'files.mkdir')).map((p) => p['path'])).toEqual(['Lead']);
  const saved = (await rpcs(page, 'agent.access.set'))[0]!;
  expect(saved['apps']).toMatchObject({ notebook: false, files: true });
  expect(saved['auto']).toEqual({ notebook: null, files: { folder: 'Lead' }, todos: false });
});

test('another desk is the member’s explicit grant: off, then on, offered until that desk allows, and Stop in settings', async ({ page }) => {
  await arrive(page, '&agentFixture=ready&agentSetup=new');
  await openAgent(page);
  const work = page.getByTestId('access-desks').getByRole('switch', { name: /^Work/ });
  await expect(work).toHaveAccessibleName(/You’ll confirm on Work too/);
  await work.click({ force: true });
  await screen(page).getByTestId('access-save').click();
  await expect(screen(page)).toHaveCount(0);
  expect((await rpcs(page, 'agent.access.set'))[0]!['desks']).toEqual([{ deskId: 'd-work', on: true, deskName: 'Work' }]);

  await page.getByTestId('tab-settings').click();
  const section = page.getByTestId('settings-access');
  const grant = section.getByTestId('access-grant');
  await expect(grant).toContainText('Waiting for you to confirm on Work.');
  expect(await axe(page)).toEqual([]);
  // The settings' rows, the switch that's on and the grant line: the colour rule as on the screen.
  expect(await tints(section)).toEqual([]);
  await grant.getByTestId('access-grant-stop').click();
  await expect(section.getByTestId('access-grant')).toHaveCount(0);
  expect((await rpcs(page, 'agent.desks.revoke')).length).toBe(1);
  await expect(section.getByRole('switch', { name: /^Work/ })).not.toBeChecked();
});

test('settings change any of it later, sending only what changed', async ({ page }) => {
  await arrive(page, '&agentFixture=ready');
  await openAgent(page);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('tab-settings').click();
  const section = page.getByTestId('settings-access');
  await expect(section.getByTestId('access-save')).toBeDisabled();
  await section.getByRole('switch', { name: /^Files/ }).click({ force: true });
  await section.getByRole('switch', { name: /^Courier/ }).click({ force: true });
  await section.getByTestId('access-save').click();
  await expect(section.getByText('Saved', { exact: true })).toBeVisible();
  expect(await rpcs(page, 'agent.access.set')).toEqual([{ agentId: 'manager', apps: { files: false, courier: true } }]);
  await expect(section.getByTestId('access-save')).toBeDisabled();
});

test('an agent made before the screen gets it on its next run, starting from what it could use', async ({ page }) => {
  await arrive(page, '&agentFixture=ready&agentSetup=upgrade');
  await openAgent(page);
  const s = screen(page);
  await expect(page.getByTestId('access-reason')).toHaveText('This is new. Until now Lead could use Notebook, Files and Browser. Choose what it uses from here on.');
  await expect(s.getByRole('switch', { name: /^To-dos/ })).not.toBeChecked();
  await expect(s.getByRole('switch', { name: /^Courier/ })).not.toBeChecked();
  await expect(s.getByRole('switch', { name: /^Browser/ })).toBeChecked();
  await s.getByTestId('access-save').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  // Its thread was there all along.
  await expect(page.getByTestId('msg-agent').first()).toBeVisible();
});

test('when the desk asks again (it lost its own copy), the screen comes back with the choices kept', async ({ page }) => {
  await arrive(page, '&agentFixture=ready');
  await openAgent(page);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await agentMock(page, 'needsSetup', 'manager', 'confirm');
  await expect(screen(page)).toBeVisible();
  await expect(page.getByTestId('access-reason')).toHaveText('Your desk needs you to confirm these again before Lead can work.');
  await screen(page).getByTestId('access-save').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('New agent goes to its setup screen next, after the name and key', async ({ page }) => {
  await arrive(page, '&agentFixture=ready');
  await openAgent(page);
  await agentWindow(page).getByTestId('new-agent').click();
  await agentWindow(page).getByTestId('new-agent-name').fill('Scout');
  await agentWindow(page).getByTestId('new-agent-submit').click();
  await expect(screen(page).getByRole('heading', { name: 'What can Scout use?' })).toBeVisible();
  await expect(page.getByTestId('drawer')).toHaveCount(0);
  await screen(page).getByTestId('access-save').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await pick(page, 'manager');
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test.describe('on a phone, 390 px', () => {
  for (const theme of THEMES) {
    test(`${theme}: the screen fits, clean, with nothing beside it`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await setTheme(page, theme);
      await arrive(page, '&agentFixture=ready&agentSetup=new');
      await openAgent(page);
      const s = screen(page);
      await expect(s).toBeVisible();
      const overflow = await s.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(await axe(page)).toEqual([]);
      expect(await tints(s)).toEqual([]);
      await page.screenshot({ path: `test-results/shots/agent-setup-${theme}-phone.png`, fullPage: false });
      await s.getByTestId('access-save').scrollIntoViewIfNeeded();
      await s.getByTestId('access-save').click();
      await expect(page.getByTestId('composer-input')).toBeVisible();
    });
  }
});
