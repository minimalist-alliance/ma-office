// Stills of the setup circle (S-121) for the Product Designer's brand read, in Light, Dusk and Dark: the ring beside the
// usage circle, its panel in setup, a Founder with no guild (Found your guild first, and no Guild Desk spot
// ), "Your office is set up.", the after-setup panel (What's new and the offer card), the offer alone, the account
// menu's switch, and a phone at 375 and 320 px. On the harness and the mock desks: nobody's real data. Skipped unless
// SETUP_SHOTS names the folder to write to, so it never runs in the suite:
//   SETUP_SHOTS=/abs/dir MA_PW_PORT=4673 npx playwright test --project=shell setup.shots
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['SETUP_SHOTS'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const MIRROR = 'ma.setup.prefs.v1';
const PERSONAL_WORK = [
  { deskId: 'd-personal0000', kind: 'personal', name: 'Personal', state: 'running' },
  { deskId: 'd-work00000001', kind: 'work', name: 'Work', state: 'running' },
];
const OFFICER_ALL = ['work-desk', 'browser', 'agent-key', 'files', 'guild-join', 'name-desks'];
const ALLIANCE_ALL = ['browser', 'agent-key', 'files', 'guild-join'];
const WHATS_NEW = {
  items: [{ id: 'simple-1', title: 'A quieter Browser', line: 'Pages come through simpler, at your own size.', action: { app: 'browser' }, from: '2026-11-01T00:00:00Z', until: '2027-01-01T00:00:00Z' }],
};

test.skip(!OUT, 'SETUP_SHOTS names the folder for the screenshots');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, timezoneId: 'America/Denver' });

interface Arrive {
  tier: 'free' | 'alliance' | 'officer' | 'lead';
  theme: ThemeId;
  mirror?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  harnessExtra?: Record<string, unknown>;
  fleet?: unknown[];
}

async function arrive(page: Page, request: APIRequestContext, o: Arrive): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, {
    setupCircle: null,
    files: { enabled: true },
    membership: { status: 'active', tier: o.tier },
    displayName: 'Dana Example',
    configExtra: { links: { guildAdmin: 'https://guild.localhost/' }, tierAllowances: { alliance: { driveGb: 25 }, officer: { weeklyAllowanceGb: 30 } }, ...(o.extra ?? {}) },
    ...(o.fleet ? { fleet: o.fleet } : {}),
    ...(o.harnessExtra ?? {}),
  });
  await setTheme(page, o.theme);
  const mirror = o.mirror ?? { setup: { done: [], skipped: [] } };
  await page.addInitScript(
    ([key, prefs]) => {
      localStorage.setItem(key as string, JSON.stringify({ who: 'u-test', prefs }));
      // Each still starts from the overview of all desks, not the scope the last one chose.
      localStorage.removeItem('ma.view.v1');
    },
    [MIRROR, mirror] as const,
  );
  await signIn(page, o.fleet ? '/?agentFixture=fresh&speed=fast' : '/?fixture=three&agentFixture=fresh&speed=fast');
  await canvasPainted(page);
  // The camera's first fit and the ring's one fill settle.
  await page.waitForTimeout(900);
  return errors;
}

const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
};

/** The bottom bar's right end: the setup ring beside the usage circle. */
const corner = async (page: Page, name: string): Promise<void> => {
  const vp = page.viewportSize()!;
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', clip: { x: vp.width - 420, y: vp.height - 96, width: 420, height: 96 } });
};

const ring = (page: Page) => page.getByTestId('setup-button');
const panel = (page: Page) => page.getByTestId('setup-panel');

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const theme of THEMES) {
  test(`setup circle stills in ${theme}`, async ({ page, request }) => {
    // 1. Setup under way: an {officer} two steps in (one done, one skipped). The ring beside the usage circle, then its panel.
    let errors = await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: ['work-desk'], skipped: ['files'] } } });
    await expect(ring(page)).toHaveAccessibleName('Setup: 2 of 6 done');
    await corner(page, `01-ring-${theme}`);
    await shot(page, `02-office-${theme}`);
    await ring(page).click();
    await expect(panel(page)).toBeVisible();
    await shot(page, `03-panel-setup-${theme}`);
    // Another step pressed open, the first closing.
    await panel(page).locator('[data-step="agent-key"] .su-step-head').click();
    await shot(page, `04-panel-step-${theme}`);
    expect(errors).toEqual([]);

    // 2. A Founder with no guild: Found your guild first, and no Guild Desk spot.
    errors = await arrive(page, request, { tier: 'lead', theme, fleet: PERSONAL_WORK, harnessExtra: { guilds: { list: [] } } });
    await shot(page, `05-founder-office-${theme}`);
    await ring(page).click();
    await expect(panel(page)).toBeVisible();
    await shot(page, `06-founder-panel-${theme}`);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);

    // 3. The last step settling with the panel open: "Your office is set up."
    errors = await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: OFFICER_ALL.slice(0, -1), skipped: [] } } });
    await ring(page).click();
    await panel(page).getByRole('button', { name: 'Skip: Name your desks' }).click();
    await expect(panel(page).getByTestId('setup-all-set')).toBeVisible();
    await shot(page, `09-all-set-${theme}`);
    expect(errors).toEqual([]);

    // 4. After setup: What's new (the star) and the offer card, then the offer alone (the arrow).
    errors = await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: OFFICER_ALL, skipped: [] } }, extra: { whatsNew: WHATS_NEW } });
    await expect(ring(page)).toHaveAccessibleName("What's new");
    await corner(page, `10-ring-whats-new-${theme}`);
    await ring(page).click();
    await shot(page, `11-panel-after-${theme}`);
    errors.push(...(await arrive(page, request, { tier: 'alliance', theme, mirror: { setup: { done: ALLIANCE_ALL, skipped: [] } } })));
    await corner(page, `12-ring-offer-${theme}`);
    await ring(page).click();
    await shot(page, `13-panel-offer-${theme}`);
    expect(errors).toEqual([]);

    // 5. The account menu's switch, with the circle hidden.
    errors = await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: ['work-desk'], skipped: [] }, circleHidden: true } });
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('switch', { name: "Show setup and what's new" })).toBeVisible();
    await shot(page, `14-menu-switch-off-${theme}`);
    expect(errors).toEqual([]);

    // 6. Phones: the ring and its panel at 375, and at 320 the account menu's row in its place.
    await page.setViewportSize({ width: 375, height: 740 });
    errors = await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: ['work-desk'], skipped: ['files'] } } });
    await shot(page, `15-phone375-${theme}`);
    await ring(page).click();
    await shot(page, `16-phone375-panel-${theme}`);
    await page.setViewportSize({ width: 320, height: 640 });
    errors.push(...(await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: ['work-desk'], skipped: ['files'] } } })));
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByTestId('menu-setup').click();
    await expect(panel(page)).toBeVisible();
    await shot(page, `17-phone320-menu-${theme}`);
    expect(errors).toEqual([]);
  });
}
