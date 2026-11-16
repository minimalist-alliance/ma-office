// Shots of the app tiles (the APP-TILES row, the owner, Nov 15: each icon's tile tinted by its app's accent, a clean bevel and
// lift, a very subtle egg-shaped gradient; agents the same in their own colour), for the Product Designer's before/after sheet
// and the brand review: a desk with every core app, the Bible and three agents, at 100 % on a desktop and on a 390 px phone,
// in Light, Zen and Dark, at 2x so a crop at 1:1 shows the tile's edge. On MockDeskLink: nobody's real data. Skipped unless
// APPTILES_SHOTS names the folder:
//   APPTILES_SHOTS=/abs/dir MA_PW_PORT=5181 npx playwright test --project=shell apptiles.shots --workers=1
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['APPTILES_SHOTS'] ?? '';
const NAMES: Record<ThemeId, string> = { light: 'light', dusk: 'zen', dark: 'dark' };
const PERSONAL = 'd-personal00001';
const BIBLE = 'com.minimalistalliance.bible';

test.skip(!OUT, 'APPTILES_SHOTS names the folder for the screenshots');
test.use({ deviceScaleFactor: 2 });
test.setTimeout(120_000);

type Hook = { __maDesk: { camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };
type MockDesk = { client: { createAgent(i: Record<string, unknown>, m: { idem: string }): Promise<unknown> } };
const APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons', 'todo', 'documents', `app:${BIBLE}`];
const COLS = 6;
const item = (app: string, k: number) => ({ id: `${PERSONAL}:${app}`, app, x: 24 + (k % COLS) * 92, y: 24 + Math.floor(k / COLS) * 92, w: 76, h: 76 });
const DESK = { id: PERSONAL, x: 0, y: 36, w: 24 + COLS * 92 - 16 + 24, h: 24 + 3 * 92 - 16 + 60, items: APPS.map(item) };

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(400);
}

async function arrive(page: Page, theme: ThemeId): Promise<string[]> {
  const errors = watchConsole(page);
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: { [PERSONAL]: DESK }, z: [PERSONAL] }));
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 60_000, preinstalled: { [PERSONAL]: [BIBLE] }, tamper: {} });
  await setTheme(page, theme);
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }], files: { enabled: true }, todo: null, documents: null, appFrames: true });
  await signIn(page, '/?speed=fast&agentFixture=ready');
  await canvasPainted(page);
  // Researcher is the fixture's (blue); two more take the next free colours (sage, amber), as a member's would.
  await page.evaluate(async () => {
    const desk = Object.values((window as unknown as { __maDeskMock: { agent: { desks: Record<string, MockDesk> } } }).__maDeskMock.agent.desks)[0]!;
    await desk.client.createAgent({ name: 'Writer' }, { idem: 'shots-c1' });
    await desk.client.createAgent({ name: 'Planner' }, { idem: 'shots-c2' });
  });
  const desk = page.getByRole('group', { name: 'Personal desk' });
  await expect(desk.getByRole('button', { name: /^Planner/ })).toHaveCount(1);
  await page.waitForTimeout(800);
  return errors;
}

const file = (name: string, theme: ThemeId): string => `${OUT}/${name}-${NAMES[theme]}.png`;

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${NAMES[theme]}: every app's tile and three agents' at 100 %, desktop`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = await arrive(page, theme);
    await page.evaluate(({ x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s: 1, x: 60 - x, y: 100 - y }), { x: DESK.x, y: DESK.y });
    await settled(page);
    await page.mouse.move(2, 790);
    await page.screenshot({ path: file('desktop', theme) });
    // The desk's tiles alone, and one tile's top-left corner and foot (100 % crops: the bitmap is 2x).
    await page.screenshot({ path: file('tiles', theme), clip: { x: 60, y: 100, width: DESK.w, height: DESK.h - 50 } });
    await page.screenshot({ path: file('edge', theme), clip: { x: 60 + 24 - 8, y: 100 + 24 - 8, width: 2 * 92 + 16, height: 92 + 16 } });
    expect(errors).toEqual([]);
  });

  test(`${NAMES[theme]}: an agent's mark in its settings, on the same face`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors = await arrive(page, theme);
    await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Writer/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const dialog = page.getByRole('dialog', { name: /Writer/ });
    await dialog.getByTestId('tab-settings').click();
    const colors = dialog.getByRole('radiogroup', { name: 'Color' });
    await colors.scrollIntoViewIfNeeded();
    await expect(colors).toBeVisible();
    await page.mouse.move(2, 790);
    await page.waitForTimeout(400);
    await page.screenshot({ path: file('agent-settings', theme) });
    expect(errors).toEqual([]);
  });

  test(`${NAMES[theme]}: the same desk on a 390 px phone`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, theme);
    await page.mouse.move(2, 840);
    await page.screenshot({ path: file('phone', theme) });
    expect(errors).toEqual([]);
  });
}
