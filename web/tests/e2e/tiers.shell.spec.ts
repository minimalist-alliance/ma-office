// Task 45 (contract tiers.md 0.3.25): every tier word from client-config's `tierNames`, the old `member` id before the
// migration, the member's initials avatar with their tier's badge behind its flag, and renaming a desk for `officer`
// and `lead`, with its errors in plain words, through axe in all three themes. Screenshots of the menu with each badge
// and of the rename flow land in test-results/tiers/ for a look by eye; nothing compares them.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SHOTS = 'test-results/tiers';

const A = 'd-personal00001';
const B = 'd-work000000001';
const RENAMED = { alliance: 'Cadet', officer: 'Captain', lead: 'Pathfinder' };
const RENAMES = ['connect', 'stop', 'rename'];

const desks = (allowedActions = RENAMES) => [
  { deskId: A, name: 'Personal', kind: 'personal', state: 'running', allowedActions },
  { deskId: B, name: 'Work', kind: 'work', state: 'running', allowedActions },
];
const layout = {
  desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] }, [B]: { id: B, x: 640, y: 0, w: 584, h: 360, items: [] } },
  z: [A, B],
};

interface HarnessState { renames: { deskId: string; body: string; status: number }[] }
const read = async (request: APIRequestContext): Promise<HarnessState> => (await (await request.get('/__harness')).json()) as HarnessState;

async function open(page: Page, request: APIRequestContext, patch: Record<string, unknown>, theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await page.addInitScript((d) => {
    // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout));
  await harness(request, { fleet: desks(), ...patch });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600); // the camera lands
  return errors;
}

const accountButton = (page: Page): Locator => page.getByRole('button', { name: 'Account', exact: true });
const accountMenu = (page: Page): Locator => page.getByRole('dialog', { name: 'Account' });
const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const deskMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Desk' });
const field = (page: Page): Locator => page.getByRole('textbox', { name: 'Desk name' });

/** The account menu, open, with /v1/me in: its header shows the member. */
async function openAccount(page: Page): Promise<void> {
  await expect(accountButton(page).locator('.avatar')).toBeVisible();
  await accountButton(page).click();
  await expect(accountMenu(page).locator('.menu-me')).toBeVisible();
}

async function openDeskMenu(page: Page, id: string): Promise<void> {
  await proxy(page, id).focus();
  await page.keyboard.press('.');
  await expect(deskMenu(page)).toBeVisible();
}

const drawnName = (page: Page, id: string): Promise<string> => page.evaluate((deskId) => {
  type Hook = { __maDesk: { camera: { getStage(): { findOne(q: string): { findOne(q: string): { getAttr(k: string): unknown } } } } } };
  return String((window as unknown as Hook).__maDesk.camera.getStage().findOne(`#desk-${deskId}`).findOne('.desk-name').getAttr('drawn') ?? '');
}, id);

/** axe at WCAG 2.2 AA and best practice on what's open, through devtools so the page's CSP doesn't apply. The ground's gradient is taken away while it runs, as in membership.shell.spec.ts, since axe can't measure past it. */
async function axe(page: Page, include: string[]): Promise<{ violations: string[]; unsure: string[] }> {
  await page.evaluate(AXE);
  return page.evaluate(async (inc) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[]; incomplete: Rule[] }> } };
    interface Rule { id: string; nodes: { target: string[]; any: { message: string }[] }[] }
    const sheet = document.styleSheets[0]!;
    const at = sheet.insertRule('.ma-shell::before { content: none !important; }', sheet.cssRules.length);
    // The window layer covers the screen with nothing in it, which axe takes for something over everything.
    sheet.insertRule('.window-layer { display: none !important; }', at + 1);
    try {
      const r = await w.axe.run({ include: inc }, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations', 'incomplete'],
      });
      const say = (v: Rule) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`;
      const why = (v: Rule) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.any.map((a) => a.message).join('; ')}`);
      return { violations: r.violations.map(say), unsure: r.incomplete.filter((v) => v.id === 'color-contrast').flatMap(why) };
    } finally {
      sheet.deleteRule(at + 1);
      sheet.deleteRule(at);
    }
  }, include);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('tier names come from the setting', () => {
  test('a renamed tier shows its new name everywhere: the menu, the button, the badge and a refusal', async ({ page, request }) => {
    const errors = await open(page, request, { tierNames: RENAMED, membership: { status: 'active', tier: 'officer', badge: 'officer' }, renameFail: { status: 403, code: 'tier_required', details: { tiers: ['officer', 'lead'] } } });
    await expect(accountButton(page)).toHaveAccessibleDescription('Test Member, Captain');
    await openAccount(page);
    await expect(accountMenu(page).getByTestId('menu-tier')).toHaveText('Captain');
    await expect(accountMenu(page).locator('.menu-me .avatar')).toHaveAttribute('title', 'Test Member, Captain');
    await page.keyboard.press('Escape');
    await openDeskMenu(page, A);
    await deskMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await field(page).fill('Studio');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Renaming a desk comes with Captain or Pathfinder.');
    // Nothing in the office says a default name, or Pro.
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/\bOfficer\b|\bFounder\b|Alliance Member|\bPro\b/);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });

  test('the Alliance line on card A names the tier from the setting', async ({ page, request }) => {
    await harness(request, { desks: 'unpaid', tierNames: RENAMED, membership: { status: 'unpaid', tier: 'officer', badge: null }, platformBilling: { enabled: true, officerMonthlyUsd: 100, leadMonthlyUsd: 200, allianceMonthlyUsd: 10 } });
    await signIn(page);
    await expect(page.locator('.desk-notice-alliance')).toHaveText('Want to start smaller? Cadet is one small desk with Browser, for $10 a month.');
    // An unpaid sign-up reads as officer, but holds no tier yet: nothing says it does.
    await openAccount(page);
    await expect(accountMenu(page).getByTestId('menu-tier')).toHaveCount(0);
    await expect(accountMenu(page).locator('.avatar-seal')).toHaveCount(0);
  });

  test('before the migration and with no setting, as prod is today: `member` is the default Officer name, with no badge yet', async ({ page, request }) => {
    const errors = await open(page, request, { tierNames: null, membership: { status: 'active', tier: 'member' } });
    await openAccount(page);
    await expect(accountMenu(page).getByTestId('menu-tier')).toHaveText('Officer');
    await expect(page.locator('.avatar-seal')).toHaveCount(0); // Platform says the badge, and hasn't yet
    expect(errors).toEqual([]);
  });

  test('after the migration, with the setting: each id is its own name', async ({ page, request }) => {
    for (const [tier, name] of [['alliance', 'Cadet'], ['officer', 'Captain'], ['lead', 'Pathfinder']] as const) {
      await harness(request, { tierNames: RENAMED, membership: { status: 'active', tier, badge: tier === 'alliance' ? null : tier } });
      await signIn(page);
      await openAccount(page);
      await expect(accountMenu(page).getByTestId('menu-tier')).toHaveText(name);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('the avatar and its badge', () => {
  for (const theme of THEMES) {
    test(`each tier's badge, and none for alliance, in ${theme}, through axe`, async ({ page, request }) => {
      const errors = await open(page, request, { membership: { status: 'active', tier: 'officer', badge: 'officer' } }, theme);
      for (const [tier, badge] of [['officer', 'officer'], ['lead', 'lead'], ['alliance', 'none']] as const) {
        await harness(request, { membership: { status: 'active', tier, badge: badge === 'none' ? null : badge } });
        await page.reload();
        await canvasPainted(page);
        await openAccount(page);
        const name = { officer: 'Officer', lead: 'Founder', alliance: 'Alliance Member' }[tier];
        await expect(accountButton(page).locator('.avatar')).toHaveAttribute('data-badge', badge);
        await expect(accountMenu(page).locator('.menu-me .avatar')).toHaveAttribute('data-badge', badge);
        await expect(accountMenu(page).locator(`.menu-me .avatar-seal${badge === 'none' ? '' : `.${badge}`}`)).toHaveCount(badge === 'none' ? 0 : 1);
        await expect(accountMenu(page).getByTestId('menu-tier')).toHaveText(name);
        await expect(accountButton(page)).toHaveAccessibleDescription(`Test Member, ${name}`);
        // The initials, on the member's own tint, the same wherever they show.
        await expect(accountMenu(page).locator('.menu-me .avatar-face')).toHaveAttribute('data-initials', 'TM');
        expect(await accountMenu(page).locator('.menu-me .avatar-face').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"TM"');
        const hue = await accountButton(page).locator('.avatar').getAttribute('data-hue');
        await expect(accountMenu(page).locator('.menu-me .avatar')).toHaveAttribute('data-hue', hue!);
        // Its pieces are drawn: the cut-out where there's a seal, and the seal's mark from its file.
        const looks = await accountMenu(page).locator('.menu-me .avatar').evaluate((el) => ({
          mask: getComputedStyle(el.querySelector('.avatar-face')!).maskImage,
          mark: el.querySelector('.avatar-seal') ? getComputedStyle(el.querySelector('.avatar-seal')!, '::after').maskImage : null,
        }));
        expect(looks.mask === 'none').toBe(badge === 'none');
        if (badge !== 'none') expect(looks.mark).toMatch(badge === 'officer' ? /chevron.*\.svg/ : /star.*\.svg/);
        expect(await axe(page, ['.topbar'])).toEqual({ violations: [], unsure: [] });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${SHOTS}/menu-${tier}-${theme}.png`, clip: { x: 1440 - 380, y: 0, width: 380, height: 420 } });
        await page.keyboard.press('Escape');
      }
      expect(errors).toEqual([]);
    });
  }

  test('a membership that ended shows no badge and no tier, whatever the row still says', async ({ page, request }) => {
    await open(page, request, { membership: { status: 'ended', tier: 'officer', badge: null } });
    await openAccount(page);
    await expect(page.locator('.avatar-seal')).toHaveCount(0);
    await expect(accountMenu(page).getByTestId('menu-tier')).toHaveCount(0);
    await expect(accountButton(page)).toHaveAccessibleDescription('Test Member');
  });
});

test.describe('renaming a desk', () => {
  test('officer: the menu offers Rename, the name becomes a field, and Enter saves it everywhere with no reload', async ({ page, request }) => {
    const errors = await open(page, request, { membership: { status: 'active', tier: 'officer', badge: 'officer' } });
    await openDeskMenu(page, A);
    // Named for its kind, the menu has nothing to add about it.
    await expect(page.locator('.desk-menu-head')).toHaveCount(0);
    await expect(deskMenu(page).getByRole('menuitem')).toHaveText(['Clean up', 'Move', 'Resize', 'Rename']);
    await deskMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('Personal');
    expect(await field(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 8]);
    await expect(field(page)).toHaveAccessibleDescription('Personal desk');
    // Over the etched name, which gives it room.
    const box = (await field(page).boundingBox())!;
    const desk = (await proxy(page, A).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (desk.x + desk.width / 2))).toBeLessThan(2);
    expect(box.y + box.height).toBeGreaterThan(desk.y + desk.height - 40);
    expect(box.y + box.height).toBeLessThanOrEqual(desk.y + desk.height);
    await page.keyboard.type('Studio');
    await page.keyboard.press('Enter');
    await expect(field(page)).toHaveCount(0);
    expect((await read(request)).renames).toEqual([{ deskId: A, body: '{"name":"Studio"}', status: 200 }]);
    // Everywhere the name shows, at once: the desk's own button, its etched name, the mirror, and back to the keyboard.
    await expect(proxy(page, A)).toHaveAccessibleName(/^Studio desk/);
    await expect(proxy(page, A)).toBeFocused();
    await expect.poll(() => drawnName(page, A)).toMatch(/^studio$/i);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ma.desks.v1') ?? '[]'))).toContainEqual({ id: A, name: 'Studio', kind: 'personal' });
    // Its kind stays, in the menu's header, and the next poll says the same.
    await openDeskMenu(page, A);
    await expect(page.locator('.desk-menu-head')).toHaveText('Personal desk');
    await expect(deskMenu(page)).toHaveAccessibleDescription('Personal desk');
    await page.keyboard.press('Escape');
    await page.reload();
    await canvasPainted(page);
    await expect(proxy(page, A)).toHaveAccessibleName(/^Studio desk/);
    expect(errors).toEqual([]);
  });

  test('lead, by mouse: a right click, Rename, and a click away saves a good name', async ({ page, request }) => {
    await open(page, request, { membership: { status: 'active', tier: 'lead', badge: 'lead' } });
    const desk = (await proxy(page, B).boundingBox())!;
    await page.mouse.click(desk.x + desk.width / 2, desk.y + desk.height / 3, { button: 'right' });
    await deskMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await field(page).fill('  Workshop  ');
    await page.mouse.click(20, 860);
    await expect(field(page)).toHaveCount(0);
    expect((await read(request)).renames.map((r) => r.body)).toEqual(['{"name":"Workshop"}']);
    await expect(proxy(page, B)).toHaveAccessibleName(/^Workshop desk/);
  });

  test('Esc, and an unchanged name, send nothing', async ({ page, request }) => {
    await open(page, request, { membership: { status: 'active', tier: 'officer', badge: 'officer' } });
    await openDeskMenu(page, A);
    await deskMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await field(page).fill('Nope');
    await page.keyboard.press('Escape');
    await expect(field(page)).toHaveCount(0);
    await expect(proxy(page, A)).toBeFocused();
    await expect(page.locator('.ma-shell')).toBeVisible(); // Esc was the field's, not the office's
    await openDeskMenu(page, A);
    await deskMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await page.keyboard.press('Enter');
    await expect(field(page)).toHaveCount(0);
    expect((await read(request)).renames).toEqual([]);
    await expect(proxy(page, A)).toHaveAccessibleName(/^Personal desk/);
  });

  for (const theme of THEMES) {
    test(`errors in plain words, and the field stays, in ${theme}, through axe`, async ({ page, request }) => {
      const errors = await open(page, request, { membership: { status: 'active', tier: 'officer', badge: 'officer' } }, theme);
      await openDeskMenu(page, A);
      await deskMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
      await page.screenshot({ path: `${SHOTS}/rename-open-${theme}.png`, clip: { x: 0, y: 300, width: 1440, height: 400 } });
      // Too long: said here, and nothing goes to Platform.
      await field(page).fill('x'.repeat(41));
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert')).toHaveText('Use 1 to 40 characters.');
      await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
      expect((await read(request)).renames).toEqual([]);
      expect(await axe(page, ['.rename-field'])).toEqual({ violations: [], unsure: [] });
      await page.screenshot({ path: `${SHOTS}/rename-error-${theme}.png`, clip: { x: 0, y: 300, width: 1440, height: 400 } });
      // Typing again clears it.
      await field(page).fill('');
      await expect(page.getByRole('alert')).toHaveCount(0);
      // Platform's refusals.
      for (const [fail, said] of [
        [{ status: 503, code: 'unavailable', times: 1 }, "That didn't save. Try again in a moment."],
        [{ status: 409, code: 'invalid_state', times: 1 }, "This desk can't be renamed right now."],
        [{ status: 404, code: 'not_found', times: 1 }, "That desk isn't in your office."],
        [{ status: 400, code: 'invalid_request', times: 1 }, 'Use 1 to 40 characters.'],
        [{ status: 403, code: 'tier_required', details: { tiers: ['officer', 'lead'] }, times: 1 }, 'Renaming a desk comes with Officer or Founder.'],
      ] as const) {
        await harness(request, { renameFail: fail });
        await field(page).fill('Studio');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert')).toHaveText(said);
        await expect(field(page)).toHaveValue('Studio');
        await expect(field(page)).toBeFocused();
      }
      await expect(proxy(page, A)).toHaveAccessibleName(/^Personal desk/);
      // And once it goes through, it's saved.
      await page.keyboard.press('Enter');
      await expect(field(page)).toHaveCount(0);
      await expect(proxy(page, A)).toHaveAccessibleName(/^Studio desk/);
      await openDeskMenu(page, A);
      expect(await axe(page, ['.desk-menu'])).toEqual({ violations: [], unsure: [] });
      await page.screenshot({ path: `${SHOTS}/rename-done-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 900 } });
      expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
    });
  }

  test('an Alliance member never gets Rename, even where a desk says it allows it', async ({ page, request }) => {
    await open(page, request, { membership: { status: 'active', tier: 'alliance', badge: null } });
    await openDeskMenu(page, A);
    await expect(deskMenu(page).getByRole('menuitem')).toHaveText(['Clean up', 'Move', 'Resize']);
  });

  test('nor does anyone where Platform doesn’t allow it, as before it ships', async ({ page, request }) => {
    await harness(request, { fleet: desks(['connect', 'stop']) });
    await open(page, request, { fleet: desks(['connect', 'stop']), membership: { status: 'active', tier: 'lead', badge: 'lead' } });
    await openDeskMenu(page, A);
    await expect(deskMenu(page).getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
  });
});
