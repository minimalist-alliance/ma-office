// The window lift (ADR 0029's addendum): the owner's pick on Nov 12, option 5 of the Product Designer's sheet
// (`design-drafts/window-lift`), "the top-edge highlight plus the contact shadow". What the browser computes for the
// office's windows, a desk's carousel stage and an open tile (since release 6.10 in the office's glass, its lit edge the glass's
// rim light, and the lit edge its fallback), in Light, Zen and Dark, pinned here so the look can't drift:
// a resting window sits on the tight contact shadow, the active and a full one on the deeper one (with Zen's and Dark's
// hairline), and every window surface has a 1 px edge lit from the top left, drawn by a ::after over its content. Where a
// surface fills the screen (a phone's stage, a full window on a phone or a short screen) there's no edge to light, and under
// forced colours the browser drops every shadow, so the edge isn't drawn. `src/theme/windowLift.test.ts` pins the tokens.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const ME = 'u-test';
const fleet = [
  { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
];

/**
 * What Chromium computes from the tokens: the colour first, every length in px. The Designer's option 5, exactly, but for
 * the faint left edges: Chromium keeps a colour's alpha in 8 bits, so Zen's 0.053 is 14/255 (0.055) and Dark's 0.033 is
 * 8/255 (0.03), as it was in the Designer's own shots, which went through the same browser.
 */
const COMPUTED: Record<ThemeId, { rest: string; active: string; edge: string }> = {
  light: {
    rest: 'rgba(20, 30, 50, 0.14) 0px 1px 3px 0px, rgba(20, 30, 50, 0.11) 0px 6px 18px 0px',
    active: 'rgba(20, 30, 50, 0.18) 0px 1px 3px 0px, rgba(20, 30, 50, 0.15) 0px 18px 48px 0px',
    edge: 'rgba(255, 255, 255, 0.9) 0px 1px 0px 0px inset, rgba(255, 255, 255, 0.3) 1px 0px 0px 0px inset',
  },
  dusk: {
    rest: 'rgba(16, 20, 30, 0.45) 0px 1px 2px 0px, rgba(16, 20, 30, 0.26) 0px 2px 6px 0px',
    active: 'rgba(16, 20, 30, 0.5) 0px 1px 2px 0px, rgba(16, 20, 30, 0.26) 0px 3px 10px 0px, rgba(241, 243, 247, 0.14) 0px 0px 0px 1px',
    edge: 'rgba(241, 243, 247, 0.16) 0px 1px 0px 0px inset, rgba(241, 243, 247, 0.055) 1px 0px 0px 0px inset',
  },
  dark: {
    rest: 'rgba(5, 6, 8, 0.55) 0px 1px 3px 0px, rgba(5, 6, 8, 0.38) 0px 6px 18px 0px',
    active: 'rgba(5, 6, 8, 0.65) 0px 1px 3px 0px, rgba(5, 6, 8, 0.42) 0px 12px 36px 0px, rgba(236, 237, 239, 0.12) 0px 0px 0px 1px',
    edge: 'rgba(236, 237, 239, 0.1) 0px 1px 0px 0px inset, rgba(236, 237, 239, 0.03) 1px 0px 0px 0px inset',
  },
};

/** The shadows the lift leaves as they were: a carousel stage's (`elevation.menu`) and an open tile's (`elevation.tile`; none in Zen). */
const OWN: Record<ThemeId, { stage: string; tile: string }> = {
  light: { stage: 'rgba(20, 30, 50, 0.16) 0px 8px 24px 0px', tile: 'rgba(20, 30, 50, 0.1) 0px 2px 6px 0px' },
  dusk: { stage: 'rgba(16, 20, 30, 0.35) 0px 2px 8px 0px', tile: 'none' },
  dark: { stage: 'rgba(5, 6, 8, 0.5) 0px 8px 24px 0px', tile: 'rgba(5, 6, 8, 0.4) 0px 1px 3px 0px' },
};

/** Where the two windows sit (the app's own saved rects, `ma.windows.v1`), as on the Designer's sheet: Files behind, the Notebook in front. */
const RECTS = {
  [`${PERSONAL}:files`]: { rect: { x: 690, y: 104, w: 540, h: 380 }, mode: 'window' },
  [`${PERSONAL}:notebook`]: { rect: { x: 500, y: 404, w: 600, h: 330 }, mode: 'window' },
};

type Hook = { __maDesk: { camera: { isMoving(): boolean } } };
interface Look { shadow: string; content: string; edge: string; position: string; zIndex: string; events: string; radius: string; ownRadius: string; isolation: string }

const desk = (page: Page, name = 'Personal'): Locator => page.getByRole('group', { name: `${name} desk` });
const win = (page: Page, app: string): Locator => page.locator(`.window-layer .ma-window[data-app="${app}"]`);

/** A surface's own shadow and its ::after, as computed. */
const look = (l: Locator): Promise<Look> =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el);
    const a = getComputedStyle(el, '::after');
    return { shadow: cs.boxShadow, content: a.content, edge: a.boxShadow, position: a.position, zIndex: a.zIndex, events: a.pointerEvents, radius: a.borderTopLeftRadius, ownRadius: cs.borderTopLeftRadius, isolation: cs.isolation };
  });

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, extra: Record<string, unknown> = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await harness(request, { fleet, files: { enabled: true }, ...extra });
  await signIn(page);
  await canvasPainted(page);
  return errors;
}

/** Files and the Notebook open as windows on the Personal desk, the Notebook last, so it's the active one. */
async function twoWindows(page: Page): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  for (const app of ['Files', 'Notebook']) {
    await desk(page).getByRole('button', { name: new RegExp(`^${app}`) }).first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId(`window-${app.toLowerCase()}`)).toBeVisible();
  }
  await expect(win(page, 'notebook')).toHaveClass(/\bactive\b/);
  await expect(win(page, 'files')).not.toHaveClass(/\bactive\b/);
}

async function axe(page: Page, include: string[]): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (inc) => {
    interface Rule { id: string; impact: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const res = await w.axe.run({ include: inc }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test.describe(`in ${theme}`, () => {
    test('a resting window sits on the contact shadow, the active and a full one on the deeper one, and every one is lit along its top and left', async ({ page, request }) => {
      await page.addInitScript((r) => {
        if (window === window.top) localStorage.setItem('ma.windows.v1', JSON.stringify(r));
      }, RECTS);
      const errors = await arrive(page, request, theme);
      await twoWindows(page);

      const lit = { content: '""', edge: COMPUTED[theme].edge, position: 'absolute', zIndex: '5', events: 'none', radius: '16px', ownRadius: '16px', isolation: 'auto' };
      expect(await look(win(page, 'notebook'))).toEqual({ shadow: COMPUTED[theme].active, ...lit });
      expect(await look(win(page, 'files'))).toEqual({ shadow: COMPUTED[theme].rest, ...lit });

      // A press on Files' head brings it forward: the two swap.
      await win(page, 'files').locator('.window-head').click({ position: { x: 300, y: 20 } });
      await expect(win(page, 'files')).toHaveClass(/\bactive\b/);
      await expect.poll(() => look(win(page, 'files')).then((l) => l.shadow)).toBe(COMPUTED[theme].active);
      await expect.poll(() => look(win(page, 'notebook')).then((l) => l.shadow)).toBe(COMPUTED[theme].rest);

      // The edge is over the window's content and takes no press: the window's top row is still its resize edge's, and the
      // head's under it still the head's.
      const box = (await win(page, 'files').boundingBox())!;
      const hit = (x: number, y: number): Promise<string | undefined> => page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.className, [x, y]);
      expect(await hit(box.x + 200, box.y + 1)).toBe('window-edge n');
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.window-head'), [box.x + 200, box.y + 8])).toBe(true);

      // A Files dialog's scrim is over the window's edge, so the edge dims with the rest of the window.
      await win(page, 'files').getByRole('button', { name: 'New folder' }).click();
      const scrim = win(page, 'files').locator('.files-scrim');
      await expect(scrim).toBeVisible();
      expect(Number(await scrim.evaluate((e) => getComputedStyle(e).zIndex))).toBeGreaterThan(Number((await look(win(page, 'files'))).zIndex));
      await page.keyboard.press('Escape');
      await expect(scrim).toHaveCount(0);

      // Fill the screen: the deeper shadow, the edge as ever.
      await win(page, 'files').getByRole('button', { name: 'Fill the screen' }).click();
      await expect(win(page, 'files')).toHaveClass(/\bfull\b/);
      expect(await look(win(page, 'files'))).toEqual({ shadow: COMPUTED[theme].active, ...lit });

      expect(await axe(page, ['.window-layer'])).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('a desk\'s carousel stage and an open tile are lit along their top and left, and the app inside each draws no edge of its own', async ({ page, request }) => {
      const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
      const open = { w: span(6), h: span(5) };
      const item = (app: string, x: number, y: number, size = { w: 76, h: 76 }) => ({ id: `${PERSONAL}:${app}`, app, x, y, ...size });
      const items = [item('notebook', 24, 24, open), item('courier', 24, 24 + open.h + 16), item('files', 116, 24 + open.h + 16), item('browser', 208, 24 + open.h + 16), item('agent', 300, 24 + open.h + 16)];
      const personal = { x: 0, y: 0, w: 24 + open.w + 24, h: 24 + open.h + 16 + 76 + 44 + 16, items };
      const errors = await arrive(page, request, theme, {
        layoutDocs: { [ME]: { version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks: { [PERSONAL]: personal }, z: [PERSONAL] } } },
      });
      await focusCanvas(page);
      await page.keyboard.press('1');
      await settled(page);

      const tile = page.getByTestId('open-tile-notebook');
      await expect(tile.getByTestId('note-editor')).toBeVisible();
      // Since release 6.10 the open tile's frame wears the office's glass (`docs/sub-status/office-glass.md`): its shadow is the
      // glass's depth and lift, and its ::after is the glass's rim light, round the whole tile over the app's own edge, in the
      // lit edge's place. Its own stacking context, so that light's z-index never reaches a neighbouring tile.
      const t = await look(tile);
      const glass = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.boxShadow = 'var(--ma-glass-depth), var(--ma-glass-lift)';
        document.body.append(probe);
        const v = getComputedStyle(probe).boxShadow;
        probe.remove();
        return v;
      });
      expect({ shadow: t.shadow, content: t.content, edge: t.edge, position: t.position, zIndex: t.zIndex, events: t.events, isolation: t.isolation }).toEqual({ shadow: glass, content: '""', edge: 'none', position: 'absolute', zIndex: '5', events: 'none', isolation: 'isolate' });
      expect(await tile.evaluate((el) => getComputedStyle(el, '::after').backgroundImage)).toMatch(/^conic-gradient/);
      expect(t.radius).toBe(t.ownRadius);
      const app = await look(tile.locator('.open-tile-app'));
      expect([app.shadow, app.content]).toEqual(['none', 'none']);
      expect(await axe(page, ['.open-layer'])).toEqual([]);
      // Under reduced transparency it's the frame it was: the tile's own shadow and the window lift's lit edge.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      const f = await look(tile);
      expect({ shadow: f.shadow, content: f.content, edge: f.edge, position: f.position, zIndex: f.zIndex, events: f.events, isolation: f.isolation }).toEqual({ shadow: OWN[theme].tile, content: '""', edge: COMPUTED[theme].edge, position: 'absolute', zIndex: '5', events: 'none', isolation: 'isolate' });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });

      // The Work desk as a carousel: its stage is lit, its slide isn't.
      await focusCanvas(page);
      await page.keyboard.press('2');
      await settled(page);
      await desk(page, 'Work').getByRole('button', { name: 'Carousel' }).evaluate((el) => (el as HTMLButtonElement).click());
      const stage = page.getByTestId('carousel-stage');
      await expect(stage).toBeVisible();
      const s = await look(stage);
      expect({ shadow: s.shadow, content: s.content, edge: s.edge, position: s.position, zIndex: s.zIndex, events: s.events, radius: s.radius, isolation: s.isolation }).toEqual({ shadow: OWN[theme].stage, content: '""', edge: COMPUTED[theme].edge, position: 'absolute', zIndex: '5', events: 'none', radius: '16px', isolation: 'isolate' });
      await expect(stage.locator('.carousel-slide:not(.leaving)')).toBeVisible();
      const slide = await look(stage.locator('.carousel-slide:not(.leaving)'));
      expect([slide.shadow, slide.content]).toEqual(['none', 'none']);
      expect(errors).toEqual([]);
    });
  });
}

test('under forced colours the browser drops the shadows, and the edge isn\'t drawn', async ({ page, request }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.addInitScript((r) => {
    if (window === window.top) localStorage.setItem('ma.windows.v1', JSON.stringify(r));
  }, RECTS);
  const errors = await arrive(page, request, 'light');
  await twoWindows(page);
  for (const app of ['notebook', 'files']) {
    const l = await look(win(page, app));
    expect(l.content, app).toBe('none');
    expect(l.shadow, app).toBe('none');
  }
  expect(errors).toEqual([]);
});

test.describe('where a window fills the screen', () => {
  test('a short screen\'s full window has no edge to light; a tablet\'s full window, with the office round it, keeps it', async ({ page, request }) => {
    const errors = await arrive(page, request, 'dusk');
    await page.setViewportSize({ width: 900, height: 420 });
    await focusCanvas(page);
    await page.keyboard.press('1');
    await settled(page);
    await desk(page).getByRole('button', { name: /^Notebook/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(win(page, 'notebook')).toHaveClass(/\bfull\b/);
    let l = await look(win(page, 'notebook'));
    expect([l.ownRadius, l.content]).toEqual(['0px', 'none']);

    await page.setViewportSize({ width: 800, height: 1000 });
    await expect.poll(() => look(win(page, 'notebook')).then((x) => x.ownRadius)).toBe('16px');
    l = await look(win(page, 'notebook'));
    expect([l.content, l.edge, l.shadow]).toEqual(['""', COMPUTED.dusk.edge, COMPUTED.dusk.active]);
    expect(errors).toEqual([]);
  });

  test('a window left open as the screen narrows to a phone\'s is a full-screen sheet, with no edge to light', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await focusCanvas(page);
    await page.keyboard.press('1');
    await settled(page);
    await desk(page).getByRole('button', { name: /^Notebook/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(win(page, 'notebook')).toBeVisible();
    expect((await look(win(page, 'notebook'))).content).toBe('""');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(win(page, 'notebook')).toHaveClass(/\bfull\b/);
    await expect.poll(() => look(win(page, 'notebook')).then((x) => x.ownRadius)).toBe('0px');
    expect((await look(win(page, 'notebook'))).content).toBe('none');
    expect(errors).toEqual([]);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test('the full-screen stage has no edge to light', async ({ page, request }) => {
      const errors = await arrive(page, request, 'dark');
      await focusCanvas(page);
      await page.keyboard.press('1');
      await settled(page);
      const b = (await desk(page).getByRole('button', { name: /^Notebook/ }).first().boundingBox())!;
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      const stage = page.getByTestId('carousel-stage');
      await expect(stage).toHaveClass(/\bphone\b/);
      expect((await look(stage)).content).toBe('none');
      expect((await look(stage.locator('.carousel-slide:not(.leaving)'))).content).toBe('none');
      expect(errors).toEqual([]);
    });
  });
});
