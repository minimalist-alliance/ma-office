// Each app tile's proxy button says what its tile draws, `data-face` (`icon` or `content`), by the canvas's own rule
// (`tileFace` in canvas/layout.ts) at the current zoom and level, so the AI tester fleet (map key `office.tile.face`)
// can tell a glyph from widget words. Nothing on screen changes. Real tiles on MockDeskLink: a Notebook (the mock gives it words)
// at an icon size and at a medium one.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, signIn } from './helpers';

const MAP = JSON.parse(readFileSync(new URL('../../public/fleet-map.json', import.meta.url), 'utf8')) as { els: Record<string, { sel: string }> };
const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const MEDIUM = span(2);
type Hook = { __maDesk: { camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };

const ICON_ID = `${PERSONAL}:notebook`;
const BIG_ID = `${PERSONAL}:agent`;
const items = [
  { id: ICON_ID, app: 'notebook', x: 24, y: 24, w: 76, h: 76 },
  { id: BIG_ID, app: 'notebook', x: 116, y: 24, w: MEDIUM, h: MEDIUM },
];
const DESK = { x: 0, y: 0, w: 116 + MEDIUM + 24, h: 24 + MEDIUM + 60, items };

async function zoomTo(page: Page, s: number): Promise<void> {
  await page.evaluate(({ s, cx, cy }) => {
    (window as unknown as Hook).__maDesk.camera.set({ s, x: window.innerWidth / 2 - cx * s, y: window.innerHeight / 2 - cy * s });
  }, { s, cx: DESK.w / 2, cy: DESK.h / 2 });
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

test('a tile at icon size reads icon, one with widget words at full detail reads content, and zooming out flips it', async ({ page, request }) => {
  // One harness serves every spec in this Playwright process: start from its fresh state, so an earlier spec's apps (a desk
  // app or a third tile, from opentiles.expand) never carry in: the map key then counted 3 tiles (as tilefaces.shell resets since 9a96e57e).
  await harness(request, { reset: true });
  await harness(request, {
    fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }],
    layoutDocs: { [ME]: { version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks: { [PERSONAL]: DESK }, z: [PERSONAL] } } },
  });
  await signIn(page, '/');
  await canvasPainted(page);
  await focusCanvas(page);
  const face = (id: string) => page.locator(`[id="proxy-${id}"]`);
  await zoomTo(page, 1);
  await expect(face(ICON_ID)).toHaveAttribute('data-face', 'icon');
  await expect(face(BIG_ID)).toHaveAttribute('data-face', 'content');
  // The map's key finds both tiles, each with a face, and the desk's own button has none.
  await expect(page.locator(MAP.els['office.tile.face']!.sel).filter({ visible: true })).toHaveCount(2);
  await expect(page.locator('.proxy-layer button[data-kind][data-face]')).toHaveCount(0);
  // Zoomed out past where words are read, the same tile draws its glyph.
  await zoomTo(page, 0.25);
  await expect(face(BIG_ID)).toHaveAttribute('data-face', 'icon');
  await expect(face(ICON_ID)).toHaveAttribute('data-face', 'icon');
  await zoomTo(page, 1);
  await expect(face(BIG_ID)).toHaveAttribute('data-face', 'content');
});
