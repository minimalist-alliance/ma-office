// Shots of the shipped glass (the owner's pick C, Nov 16): every app's tile and agents' tiles (the hat), on a Plain and a White
// oak desk in Light and on White oak in Zen and Dark, at 100 % on a desktop and on a 390 px phone, at 2x, as glass and as the
// fallback under reduced transparency (`solid`); then the mode chooser's highlighted card and Maia's bubble in the office's CSS
// glass, in Light, Zen and Dark, desktop and phone. On the mock desk: nobody's real data. Skipped unless GLASS_SHOTS names the
// folder:
//   GLASS_SHOTS=/abs/dir MA_PW_PORT=5181 npx playwright test --project=shell apptiles.glass.shots --workers=1   [GLASS_ONLY=a,b]
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['GLASS_SHOTS'] ?? '';
const ONLY = (process.env['GLASS_ONLY'] ?? '').split(',').filter(Boolean);
const PERSONAL = 'd-personal00001';
const BIBLE = 'com.minimalistalliance.bible';
const asked = (id: string): boolean => !ONLY.length || ONLY.some((o) => id.includes(o));

test.skip(!OUT, 'GLASS_SHOTS names the folder for the screenshots');
test.use({ deviceScaleFactor: 2 });
test.setTimeout(120_000);

type Hook = { __maDesk: { camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };
type MockDesk = { client: { createAgent(i: Record<string, unknown>, m: { idem: string }): Promise<unknown> } };
const APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons', 'todo', 'documents', `app:${BIBLE}`];
const COLS = 6;
const item = (app: string, k: number) => ({ id: `${PERSONAL}:${app}`, app, x: 24 + (k % COLS) * 92, y: 24 + Math.floor(k / COLS) * 92, w: 76, h: 76 });
const desk = (style: string) => ({ id: PERSONAL, x: 0, y: 36, w: 24 + COLS * 92 - 16 + 24, h: 24 + 3 * 92 - 16 + 60, style, items: APPS.map(item) });

const LOOKS = ['glass', 'solid'] as const;
const SCENES: { name: string; theme: ThemeId; style: string }[] = [
  { name: 'light-plain', theme: 'light', style: 'plain' },
  { name: 'light-oak', theme: 'light', style: 'white-oak' },
  { name: 'zen-oak', theme: 'dusk', style: 'white-oak' },
  { name: 'dark-oak', theme: 'dark', style: 'white-oak' },
];
const THEMES: [string, ThemeId][] = [['light', 'light'], ['zen', 'dusk'], ['dark', 'dark']];

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(400);
}

async function solidIf(page: Page, look: string): Promise<void> {
  if (look !== 'solid') return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
}

async function arrive(page: Page, theme: ThemeId, style: string, look: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await solidIf(page, look);
  // The styles as they ship (signIn otherwise leaves only Plain).
  await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: { [PERSONAL]: desk(style) }, z: [PERSONAL] }));
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 60_000, preinstalled: { [PERSONAL]: [BIBLE] }, tamper: {} });
  await setTheme(page, theme);
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }], files: { enabled: true }, todo: null, documents: null, appFrames: true, ...extra });
  await signIn(page, '/?speed=fast&agentFixture=ready');
  await canvasPainted(page);
  await page.evaluate(async () => {
    const d = Object.values((window as unknown as { __maDeskMock: { agent: { desks: Record<string, MockDesk> } } }).__maDeskMock.agent.desks)[0]!;
    await d.client.createAgent({ name: 'Writer' }, { idem: 'shots-c1' });
    await d.client.createAgent({ name: 'Planner' }, { idem: 'shots-c2' });
  });
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Planner/ })).toHaveCount(1);
  // The White oak texture's chunk and image, then the redraw that brings it into the desk and the glass's idle work.
  await page.waitForTimeout(1500);
  return errors;
}

for (const scene of SCENES) {
  for (const look of LOOKS) {
    const id = `${look}-${scene.name}`;
    if (!asked(id)) continue;
    test(`${id}: desktop`, async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 800 });
      const errors = await arrive(page, scene.theme, scene.style, look);
      const d = desk(scene.style);
      await page.evaluate(({ x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s: 1, x: 60 - x, y: 100 - y }), { x: d.x, y: d.y });
      await settled(page);
      await page.waitForTimeout(800);
      await page.mouse.move(2, 790);
      await page.screenshot({ path: `${OUT}/desktop-${id}.png` });
      expect(errors).toEqual([]);
    });
    test(`${id}: phone`, async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: 390, height: 844 });
      const errors = await arrive(page, scene.theme, scene.style, look);
      await page.mouse.move(2, 840);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/phone-${id}.png` });
      expect(errors).toEqual([]);
    });
  }
}

// Maia's bubble, bottom right (Support Maia's widget), in each theme, glass and the fallback.
for (const [name, theme] of THEMES) {
  for (const look of LOOKS) {
    for (const phone of [false, true]) {
      const id = `bubble-${look}-${name}${phone ? '-phone' : ''}`;
      if (!asked(id)) continue;
      test(id, async ({ page }) => {
        mkdirSync(OUT, { recursive: true });
        await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
        const errors = await arrive(page, theme, 'white-oak', look, { maia: { enabled: true } });
        await expect(page.locator('.maia-bubble')).toBeVisible();
        await page.mouse.move(2, phone ? 840 : 790);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/${id}.png` });
        const box = (await page.locator('.maia-bubble').boundingBox())!;
        await page.screenshot({ path: `${OUT}/${id}-crop.png`, clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
        expect(errors).toEqual([]);
      });
    }
  }
}

// The mode chooser after the loading screen, its highlighted option in glass: Maia Mode on, asked at every start.
const ON = { configExtra: { maiaMode: { enabled: false, listed: true } }, meMaiaMode: { enabled: true } };
for (const [name, theme] of THEMES) {
  for (const look of LOOKS) {
    for (const phone of [false, true]) {
      const id = `chooser-${look}-${name}${phone ? '-phone' : ''}`;
      if (!asked(id)) continue;
      test(id, async ({ page }) => {
        mkdirSync(OUT, { recursive: true });
        // Turned on at a desktop's width (the room's way back to the desks differs on a phone), then asked at the phone's.
        await page.setViewportSize({ width: 1280, height: 800 });
        const errors = watchConsole(page);
        await solidIf(page, look);
        await setTheme(page, theme);
        await harness(page.request, { reset: true });
        await harness(page.request, ON);
        await signIn(page, '/?fixture=three');
        // The first question once, then on through the account menu's switch and the disclosure, then back to the desks.
        await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 5000 });
        await page.getByRole('button', { name: 'Account', exact: true }).first().click();
        await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
        await dialog.getByRole('checkbox', { name: 'I’ve read this' }).check();
        await dialog.getByRole('button', { name: 'Turn on Maia' }).click();
        await expect(page.locator('.mm-room[data-ready]')).toBeVisible();
        await page.getByRole('button', { name: /Show my desks/ }).click();
        await expect(page.locator('.mm-layer')).toHaveCount(0, { timeout: 3000 });
        if (phone) await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
        await page.waitForTimeout(700); // its fade in, and the card in place
        await page.screenshot({ path: `${OUT}/${id}.png` });
        const box = (await page.locator('.mm-ch-row').boundingBox())!;
        await page.screenshot({ path: `${OUT}/${id}-crop.png`, clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
        expect(errors).toEqual([]);
      });
    }
  }
}
