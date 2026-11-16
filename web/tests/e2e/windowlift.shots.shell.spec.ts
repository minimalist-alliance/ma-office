// Screenshots of the window lift (ADR 0029's addendum) for the Designer's read, on the scene of their pick sheet
// (`design-drafts/window-lift`): the real office in the shell harness at 1280 x 800, the Personal desk in front, Files and
// the Notebook open as windows and overlapping a little, in Light, Zen and Dark, at device scale 1 and 2, the whole office
// and the Notebook's top-left corner (200 x 130 CSS px, as their corners.png crops it), plus an open tile and a desk's
// carousel stage at 2x. On MockDeskLink: nobody's real data. Skipped unless WINDOW_LIFT_SHOTS names the folder, so it never
// runs in the suite:
//   WINDOW_LIFT_SHOTS=/abs/dir MA_PW_PORT=4941 npx playwright test --project=shell windowlift.shots
// With WINDOW_LIFT_REF=/abs/options.json (the Designer's `options.py` output) each scene is also shot with their option 5
// CSS laid over this build (`-ref`, which should change nothing) and with today's look put back (`-today`).
import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, type ThemeId, openMenuSection } from './helpers';

const OUT = process.env['WINDOW_LIFT_SHOTS'] ?? '';
const REF = process.env['WINDOW_LIFT_REF'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
/** The Designer's sheet's rects (`ma.windows.v1`): Files behind, the Notebook in front over the desk. */
const RECTS = {
  [`${PERSONAL}:files`]: { rect: { x: 690, y: 104, w: 540, h: 380 }, mode: 'window' },
  [`${PERSONAL}:notebook`]: { rect: { x: 500, y: 404, w: 600, h: 330 }, mode: 'window' },
};
/** The Notebook's top-left corner and the desk round it, in CSS pixels: corners.png's crop. */
const CORNER = { x: 456, y: 374, width: 200, height: 130 };
/** Today's look, put back over this build for a before: the menu's shadow at rest, the window's when active or full, no edge. */
const TODAY = '.ma-window { box-shadow: var(--ma-elevation-menu) !important; } .ma-window.active, .ma-window.full { box-shadow: var(--ma-elevation-window) !important; } .ma-window::after, .carousel-stage::after, .open-tile::after { content: none !important; }';
/** Every page's Date starts at the same whole minute, so the Notebook's "Created" line reads the same in every shot. */
const NOW = Math.floor(Date.now() / 60_000) * 60_000;

test.skip(!OUT, 'WINDOW_LIFT_SHOTS names the folder for the screenshots');
test.describe.configure({ timeout: 300_000 });

const option5 = (theme: ThemeId): string | null => {
  if (!REF) return null;
  const o = JSON.parse(readFileSync(REF, 'utf8')) as { options: { id: string; css: Record<ThemeId, string> }[] };
  return o.options.find((x) => x.id === 'combo')!.css[theme];
};

/** The Designer's scene, step for step (`windowlift.shots.shell.spec.ts` in their folder). */
async function scene(page: Page, request: APIRequestContext, theme: ThemeId): Promise<void> {
  await harness(request, { reset: true });
  await harness(request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }], files: { enabled: true } });
  await page.addInitScript((now) => {
    const Real = Date;
    const delta = now - Real.now();
    class Shifted extends Real {
      constructor(...a: ConstructorParameters<DateConstructor>) {
        if ((a as unknown[]).length === 0) super(Real.now() + delta);
        else super(...a);
      }
      static now(): number {
        return Real.now() + delta;
      }
    }
    (window as unknown as { Date: DateConstructor }).Date = Shifted as unknown as DateConstructor;
  }, NOW);
  await setTheme(page, theme);
  await page.addInitScript((r) => {
    if (window === window.top) localStorage.setItem('ma.windows.v1', JSON.stringify(r));
  }, RECTS);
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600);
  if (theme === 'dusk') {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await openMenuSection(page, 'menu-appearance');
    await page.getByRole('radio', { name: 'Background: Misty mountains' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
  }
  await page.locator(`[id="proxy-${PERSONAL}"]`).evaluate((e) => (e as HTMLButtonElement).click());
  await page.waitForTimeout(1200);
  const desk = page.getByRole('group', { name: 'Personal desk' });
  for (const app of ['Files', 'Notebook']) {
    await desk.getByRole('button', { name: new RegExp(`^${app}`) }).first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId(`window-${app.toLowerCase()}`)).toBeVisible();
    await page.waitForTimeout(800);
  }
  await expect(page.locator('.ma-window.active[data-app="notebook"]')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(40, 650);
  await page.waitForTimeout(2500);
}

async function shoot(page: Page, base: string): Promise<void> {
  await page.screenshot({ path: `${base}.png`, animations: 'disabled' });
  await page.screenshot({ path: `${base}-corner.png`, animations: 'disabled', clip: CORNER });
}

for (const theme of THEMES) {
  for (const scale of [1, 2]) {
    test(`${theme} at device scale ${scale}`, async ({ browser, request, baseURL }) => {
      const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale, bypassCSP: !!REF });
      const page = await ctx.newPage();
      await scene(page, request, theme);
      mkdirSync(OUT, { recursive: true });
      const base = `${OUT}/${theme}-x${scale}`;
      await shoot(page, base);
      const ref = option5(theme);
      if (ref) {
        for (const [name, css] of [['ref', ref], ['today', TODAY]] as const) {
          const tag = await page.addStyleTag({ content: css });
          await page.waitForTimeout(400);
          await shoot(page, `${base}-${name}`);
          await tag.evaluate((el) => (el as Element).remove());
        }
        await page.waitForTimeout(400);
        await shoot(page, `${base}-again`);
      }
      await ctx.close();
    });
  }

  test(`${theme}: an open tile and a carousel stage at device scale 2`, async ({ browser, request, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
    const open = { w: span(6), h: span(5) };
    const item = (app: string, x: number, y: number, size = { w: 76, h: 76 }) => ({ id: `${PERSONAL}:${app}`, app, x, y, ...size });
    const items = [item('notebook', 24, 24, open), item('courier', 24, 24 + open.h + 16), item('files', 116, 24 + open.h + 16), item('browser', 208, 24 + open.h + 16), item('agent', 300, 24 + open.h + 16)];
    await harness(request, { reset: true });
    await harness(request, {
      fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }],
      files: { enabled: true },
      layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks: { [PERSONAL]: { x: 0, y: 0, w: 24 + open.w + 24, h: 24 + open.h + 16 + 76 + 44 + 16, items } }, z: [PERSONAL] } } },
    });
    await setTheme(page, theme);
    await signIn(page);
    await canvasPainted(page);
    await focusCanvas(page);
    await page.keyboard.press('1');
    await expect(page.getByTestId('open-tile-notebook').getByTestId('note-editor')).toBeVisible();
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(1500);
    mkdirSync(OUT, { recursive: true });
    const t = (await page.getByTestId('open-tile-notebook').boundingBox())!;
    await page.screenshot({ path: `${OUT}/${theme}-x2-opentile.png`, animations: 'disabled' });
    await page.screenshot({ path: `${OUT}/${theme}-x2-opentile-corner.png`, animations: 'disabled', clip: { x: t.x - 44, y: t.y - 30, width: 200, height: 130 } });
    await focusCanvas(page);
    await page.keyboard.press('2');
    await page.waitForTimeout(1500);
    await page.getByRole('group', { name: 'Work desk' }).getByRole('button', { name: 'Carousel' }).evaluate((el) => (el as HTMLButtonElement).click());
    const stage = page.getByTestId('carousel-stage');
    await expect(stage).toBeVisible();
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(1500);
    const s = (await stage.boundingBox())!;
    await page.screenshot({ path: `${OUT}/${theme}-x2-carousel.png`, animations: 'disabled' });
    await page.screenshot({ path: `${OUT}/${theme}-x2-carousel-corner.png`, animations: 'disabled', clip: { x: s.x - 44, y: s.y - 30, width: 200, height: 130 } });
    await ctx.close();
  });
}
