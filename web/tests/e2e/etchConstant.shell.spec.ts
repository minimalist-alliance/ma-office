// The etched name and the hidden count stay one size on screen at every zoom (ADR 0064, amending 0062), read from the
// canvas's own pixels: at the smallest zoom, at 100 %, at the largest, part way through a wheel zoom and after it, the
// zoom pill and the keyboard, and a trackpad pinch, Chromium's (a ctrl+wheel, here from CDP's own pinch) and Safari's
// (GestureEvents), wherever on the office it starts. A pinch the office doesn't take magnifies the whole page, the
// name with it, and that's what the owner saw grow and shrink.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, type ThemeId } from './helpers';

type KNode = { getAttr(k: string): unknown; findOne(q: string): KNode; getIntersection(p: { x: number; y: number }): unknown; getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[] };
/** The read-only hook, in page functions. Not in a production bundle. */
declare const __maDesk: {
  camera: {
    cam: { x: number; y: number; s: number };
    vp: { w: number; h: number };
    dpr(): number;
    isMoving(): boolean;
    animateTo(c: { x: number; y: number; s: number }, duration?: number): number;
    getStage(): KNode;
  };
};

type Box = { x: number; y: number; w: number; h: number };
type Ink = { w: number; h: number; count: number };

const ID = 'd-personal00001';
// Wide enough that the name shows whole beside the hidden count and cleanup's sparkle at the smallest zoom (480 px; the
// icons hide under 290), and off the whole numbers, so its edges land on fractions of a pixel. The notebook lies wholly
// under the chat: one hidden.
const DESK = { id: ID, x: 13.37, y: 7.77, w: 2400, h: 900, items: [
  { id: `${ID}:notebook`, app: 'notebook', x: 24, y: 24, w: 76, h: 76 },
  { id: `${ID}:chat`, app: 'chat', x: 20, y: 20, w: 84, h: 84 },
] };

async function open(page: Page, request: APIRequestContext): Promise<void> {
  await page.addInitScript((d) => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', JSON.stringify({ desks: { [d.id]: d }, z: [d.id] }));
  }, DESK);
  await harness(request, { fleet: [{ deskId: ID, name: 'Personal', kind: 'personal', state: 'running' }] });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(400);
}

const frame = (page: Page): Promise<unknown> => page.evaluate(() => new Promise((done) => { requestAnimationFrame(done); }));
const frames = (page: Page): Promise<unknown> => page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); }));

/**
 * Put the desk's strip at the middle of the screen at this zoom, and let the camera settle: its icons' center line, 22 px
 * up from its bottom edge on screen, and either the middle of its name or its right edge 100 px right of the middle.
 */
async function aim(page: Page, s: number, at: 'name' | 'count'): Promise<void> {
  await page.evaluate(({ zoom, d, at: where }) => {
    const { camera } = __maDesk;
    const right = where === 'name' ? camera.vp.w / 2 + (d.w / 2) * zoom : camera.vp.w / 2 + 100;
    const bottom = camera.vp.h / 2 + 22;
    camera.animateTo({ s: zoom, x: right - (d.x + d.w) * zoom, y: bottom - (d.y + d.h) * zoom }, 0);
  }, { zoom: s, d: DESK, at });
  await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
  await frames(page);
}

/** Where the name was last drawn, in screen CSS pixels: its left end on its baseline. */
const nameAt = (page: Page): Promise<{ x: number; y: number; text: string }> => page.evaluate((id) => {
  const n = __maDesk.camera.getStage().findOne(`#desk-${id}`).findOne('.desk-name');
  return { x: n.getAttr('drawnX') as number, y: n.getAttr('drawnY') as number, text: n.getAttr('drawn') as string };
}, ID);

/** The bounding box of what differs from the box's corner pixel (the desk's surface), in screen CSS pixels. */
const inkIn = (page: Page, box: Box): Promise<Ink> => page.evaluate((b) => {
  const { camera } = __maDesk;
  const d = camera.dpr();
  const ctx = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context;
  const left = Math.round(b.x * d);
  const top = Math.round(b.y * d);
  const width = Math.round(b.w * d);
  const height = Math.round(b.h * d);
  const { data } = ctx.getImageData(left, top, width, height);
  const base = [data[0]!, data[1]!, data[2]!];
  let count = 0;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = (row * width + col) * 4;
      if (Math.abs(data[i]! - base[0]!) + Math.abs(data[i + 1]! - base[1]!) + Math.abs(data[i + 2]! - base[2]!) < 24) continue;
      count += 1;
      x0 = Math.min(x0, col);
      x1 = Math.max(x1, col + 1);
      y0 = Math.min(y0, row);
      y1 = Math.max(y1, row + 1);
    }
  }
  return { w: (x1 - x0) / d, h: (y1 - y0) / d, count };
}, box);

/** The name's ink, wherever it was drawn last. */
async function nameInk(page: Page): Promise<Ink> {
  const at = await nameAt(page);
  expect(at.text).toBe('PERSONAL');
  return inkIn(page, { x: at.x - 6, y: at.y - 18, w: 120, h: 26 });
}

/** The hidden count's ink: its icon and its "1", in its slot, found in the hit graph along the icons' center line. */
async function countInk(page: Page): Promise<Ink> {
  const slot = await page.evaluate(() => {
    const { camera } = __maDesk;
    const y = camera.vp.h / 2;
    let [x0, x1] = [Infinity, -Infinity];
    for (let x = 0; x < camera.vp.w; x += 1) {
      const n = camera.getStage().getIntersection({ x, y }) as { findAncestor(q: string, self?: boolean): unknown } | null;
      if (n?.findAncestor('.desk-hidden', true)) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x + 1);
      }
    }
    return { x0, x1, y };
  });
  expect(slot.x1 - slot.x0).toBeGreaterThan(40); // its 46 px slot, at every zoom
  return inkIn(page, { x: slot.x0 - 2, y: slot.y - 12, w: slot.x1 - slot.x0 + 4, h: 24 });
}

const same = (a: Ink, b: Ink): void => {
  expect(a.count).toBeGreaterThan(40);
  expect(b.count).toBeGreaterThan(40);
  expect(Math.abs(a.w - b.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(a.h - b.h)).toBeLessThanOrEqual(1);
};

const pageZoom = (page: Page): Promise<number> => page.evaluate(() => window.visualViewport?.scale ?? 1);

for (const dpr of [1, 2]) {
  test.describe(`at ${dpr}x`, () => {
    test.use({ deviceScaleFactor: dpr });
    test.beforeEach(async ({ request }) => {
      await harness(request, { reset: true });
    });

    test('the name and the hidden count are one size at the smallest zoom, at 100 % and at the largest', async ({ page, request }) => {
      await open(page, request);
      const names: Record<string, Ink> = {};
      const counts: Record<string, Ink> = {};
      for (const s of [0.2, 1, 3]) {
        await aim(page, s, 'name');
        names[s] = await nameInk(page);
        await aim(page, s, 'count');
        counts[s] = await countInk(page);
      }
      console.log(`NAME ${dpr}x`, JSON.stringify(names), `COUNT ${dpr}x`, JSON.stringify(counts));
      same(names['0.2']!, names['1']!);
      same(names['3']!, names['1']!);
      same(counts['0.2']!, counts['1']!);
      same(counts['3']!, counts['1']!);
      // 14 px capitals: about 10 px of cap height on screen, never the 2.8 px or 30 px a scaled bitmap would be.
      expect(names['1']!.h).toBeGreaterThan(9);
      expect(names['1']!.h).toBeLessThan(15);
    });

    test('through a wheel zoom, the zoom pill and the keyboard, while moving and at rest', async ({ page, request }) => {
      await open(page, request);
      await aim(page, 1, 'name');
      const rest = await nameInk(page);
      const mid = await page.evaluate(() => ({ x: __maDesk.camera.vp.w / 2, y: __maDesk.camera.vp.h / 2 }));
      await page.mouse.move(mid.x, mid.y);
      const seen: Ink[] = [];
      let movingReads = 0;
      // In, then out past the start: read part way, with the camera still moving.
      for (const dy of [-40, 60]) {
        await page.keyboard.down('Control');
        for (let i = 0; i < 6; i += 1) {
          await page.mouse.wheel(0, dy);
          await frame(page);
        }
        // Read at once, with the camera still moving: the camera settles 140 ms after the last wheel.
        const [ink, moving] = await Promise.all([nameInk(page), page.evaluate(() => __maDesk.camera.isMoving())]);
        if (moving) movingReads += 1;
        seen.push(ink);
        await page.keyboard.up('Control');
        await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
        await frames(page);
        seen.push(await nameInk(page));
      }
      // The pill's 220 ms glide, part way and landed, then the keyboard's.
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await frame(page);
      const [glide, gliding] = await Promise.all([nameInk(page), page.evaluate(() => __maDesk.camera.isMoving())]);
      if (gliding) movingReads += 1;
      seen.push(glide);
      await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
      await frames(page);
      seen.push(await nameInk(page));
      await focusCanvas(page);
      await page.keyboard.press('-');
      await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
      await frames(page);
      seen.push(await nameInk(page));
      console.log(`GESTURE ${dpr}x`, JSON.stringify({ rest, seen }));
      for (const ink of seen) same(ink, rest);
      expect(movingReads).toBeGreaterThanOrEqual(2);
      expect(await pageZoom(page)).toBe(1);
    });
  });
}

// For a person to look at: the strip at the smallest zoom, at 100 % and at the largest, in each theme at 2x, cropped to
// the same 320 x 90 CSS pixels round the name, then round the desk's bottom right corner with the hidden count.
test.describe('screenshots', () => {
  test.use({ deviceScaleFactor: 2 });
  test.beforeEach(async ({ request }) => {
    await harness(request, { reset: true });
  });
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`the strip at 20 %, 100 % and 300 % in ${theme}`, async ({ page, request }) => {
      await setTheme(page, theme);
      await open(page, request);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const mid = await page.evaluate(() => ({ x: __maDesk.camera.vp.w / 2, y: __maDesk.camera.vp.h / 2 }));
      for (const s of [0.2, 1, 3]) {
        for (const at of ['name', 'count'] as const) {
          await aim(page, s, at);
          await page.screenshot({ path: `test-results/shots/etch-constant-${theme}-${Math.round(s * 100)}-${at}.png`, clip: { x: mid.x - 160, y: mid.y - 50, width: 320, height: 90 } });
        }
      }
    });
  }
});

// A desk smaller on screen than its name: the fit is held through a zoom, so as not to cut a new bitmap per wheel tick,
// and is cut at the panel's edges until the camera settles, when it ellipsizes or hides (ADR 0064). Never off the desk.
test.describe('a desk smaller on screen than its name', () => {
  const SMALL = { ...DESK, w: 300, h: 300, items: [] as typeof DESK.items };

  /** How many of the etch's dark pixels are in this box: darker than any panel shadow, in Light. */
  const darkIn = (page: Page, box: Box): Promise<number> => page.evaluate((b) => {
    const { camera } = __maDesk;
    const d = camera.dpr();
    const ctx = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context;
    const { data } = ctx.getImageData(Math.round(b.x * d), Math.round(b.y * d), Math.round(b.w * d), Math.round(b.h * d));
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 3 * 170 && data[i + 3]! > 0) n += 1;
    return n;
  }, box);

  test.beforeEach(async ({ request }) => {
    await harness(request, { reset: true });
  });

  test('is cut at the desk\'s edges while the camera moves, then hides, and never shows off the desk', async ({ page, request }) => {
    await page.addInitScript((d) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', JSON.stringify({ desks: { [d.id]: d }, z: [d.id] }));
    }, SMALL);
    await harness(request, { fleet: [{ deskId: ID, name: 'Personal Workspace', kind: 'personal', state: 'running' }] });
    await signIn(page);
    await canvasPainted(page);
    const edges = (): Promise<{ left: number; right: number; bottom: number }> => page.evaluate((d) => {
      const c = __maDesk.camera.cam;
      return { left: d.x * c.s + c.x, right: (d.x + d.w) * c.s + c.x, bottom: (d.y + d.h) * c.s + c.y };
    }, SMALL);
    const place = (s: number, settle: boolean): Promise<void> => page.evaluate(({ zoom, d, still }) => {
      const { camera } = __maDesk;
      const cam = { s: zoom, x: camera.vp.w / 2 - (d.x + d.w / 2) * zoom, y: camera.vp.h / 2 + 22 - (d.y + d.h) * zoom };
      if (still) camera.animateTo(cam, 0);
      else (camera as unknown as { set(c: typeof cam): void }).set(cam);
    }, { zoom: s, d: SMALL, still: settle });
    await place(1.5, true);
    await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
    await frames(page);
    expect((await nameAt(page)).text).toBe('PERSONAL WORKSPACE');
    // Out to 60 px wide in one step, read in the same frame's wake, with the camera still moving and the fit held.
    await place(0.2, false);
    await frame(page);
    expect(await page.evaluate(() => __maDesk.camera.isMoving())).toBe(true);
    expect((await nameAt(page)).text).toBe('PERSONAL WORKSPACE');
    // About 200 px of name on a 60 px desk. Off it means past the active ring and its glow, 8 px out.
    const e = await edges();
    const onDesk = await darkIn(page, { x: e.left + 1, y: e.bottom - 30, w: e.right - e.left - 2, h: 26 });
    const offLeft = await darkIn(page, { x: e.left - 70, y: e.bottom - 30, w: 62, h: 26 });
    const offRight = await darkIn(page, { x: e.right + 8, y: e.bottom - 30, w: 62, h: 26 });
    expect(onDesk).toBeGreaterThan(20);
    expect(offLeft + offRight).toBe(0);
    await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
    await frames(page);
    // At rest the fit runs again: 36 px of room holds fewer than four letters, so it hides.
    expect((await nameAt(page)).text).toBe('');
    const r = await edges();
    expect(await darkIn(page, { x: r.left + 2, y: r.bottom - 30, w: r.right - r.left - 4, h: 26 })).toBe(0);
    expect(await darkIn(page, { x: r.left - 70, y: r.bottom - 30, w: 62, h: 26 }) + await darkIn(page, { x: r.right + 8, y: r.bottom - 30, w: 62, h: 26 })).toBe(0);
  });
});

test.describe('a trackpad pinch zooms the office, never the page', () => {
  test.beforeEach(async ({ request }) => {
    await harness(request, { reset: true });
  });

  // Chromium sends a trackpad pinch as wheel events with ctrlKey, to whatever's under the pointer. Over the bars
  // and notices, nothing took them, so the browser magnified the whole page and the name grew with it.
  for (const where of ['canvas', 'zoom pill', 'top bar']) {
    test(`Chromium, starting over the ${where}`, async ({ page, request }) => {
      await open(page, request);
      await aim(page, 1, 'name');
      const before = await nameInk(page);
      const s0 = await page.evaluate(() => __maDesk.camera.cam.s);
      const box = where === 'canvas'
        ? await page.locator('[data-testid="canvas"]').boundingBox()
        : where === 'zoom pill' ? await page.locator('.zoom-ctl').boundingBox() : await page.locator('header').first().boundingBox();
      const p = where === 'canvas' ? { x: 300, y: 300 } : { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.synthesizePinchGesture', { x: p.x, y: p.y, scaleFactor: 1.5, relativeSpeed: 600, gestureSourceType: 'mouse' });
      await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
      await frames(page);
      expect(await pageZoom(page)).toBe(1);
      expect(await page.evaluate(() => __maDesk.camera.cam.s)).toBeGreaterThan(s0 * 1.2);
      same(await nameInk(page), before);
    });
  }

  // Safari sends a trackpad pinch as GestureEvents and no wheel at all, so the office never zoomed and Safari magnified
  // the page instead. These are the events Safari sends, made by hand, as only Safari on a Mac makes them.
  test('Safari\'s GestureEvents zoom the camera at the pointer, and are the office\'s', async ({ page, request }) => {
    await open(page, request);
    await aim(page, 1, 'name');
    const before = await nameInk(page);
    const send = (type: string, scale: number, x: number, y: number, target: 'canvas' | 'bar'): Promise<boolean> => page.evaluate((e) => {
      const el = e.target === 'canvas' ? document.querySelector('[data-testid="canvas"] canvas')! : document.querySelector('.zoom-ctl')!;
      const ev = new Event(e.type, { bubbles: true, cancelable: true });
      Object.assign(ev, { scale: e.scale, rotation: 0, clientX: e.x, clientY: e.y });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, { type, scale, x, y, target });
    const s0 = await page.evaluate(() => __maDesk.camera.cam.s);
    const prevented: boolean[] = [];
    prevented.push(await send('gesturestart', 1, 400, 300, 'canvas'));
    for (const k of [1.1, 1.25, 1.5]) {
      prevented.push(await send('gesturechange', k, 400, 300, 'canvas'));
      await frames(page);
    }
    // The world point under the pointer stays under it.
    const cam = await page.evaluate(() => __maDesk.camera.cam);
    expect(cam.s).toBeCloseTo(s0 * 1.5, 5);
    prevented.push(await send('gestureend', 1.5, 400, 300, 'canvas'));
    await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
    await frames(page);
    same(await nameInk(page), before);
    // Over the bottom bar too, and back out.
    prevented.push(await send('gesturestart', 1, 1250, 862, 'bar'));
    prevented.push(await send('gesturechange', 0.5, 1250, 862, 'bar'));
    prevented.push(await send('gestureend', 0.5, 1250, 862, 'bar'));
    await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
    expect(await page.evaluate(() => __maDesk.camera.cam.s)).toBeCloseTo(s0 * 0.75, 5);
    expect(prevented.every(Boolean)).toBe(true);
    await frames(page);
    same(await nameInk(page), before);
  });

  test('a pinch over an app window magnifies nothing and leaves the camera where it is', async ({ page, request }) => {
    await open(page, request);
    await aim(page, 1, 'name');
    const tile = page.getByRole('button', { name: /^Chat/ }).first();
    await tile.focus();
    await page.keyboard.press('Enter');
    const win = page.getByRole('dialog', { name: /Chat/ });
    await expect(win).toBeVisible();
    await page.waitForTimeout(400);
    const s0 = await page.evaluate(() => __maDesk.camera.cam.s);
    const b = (await win.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizePinchGesture', { x: b.x + b.width / 2, y: b.y + b.height / 2, scaleFactor: 1.5, relativeSpeed: 600, gestureSourceType: 'mouse' });
    await page.waitForTimeout(300);
    expect(await pageZoom(page)).toBe(1);
    expect(await page.evaluate(() => __maDesk.camera.cam.s)).toBe(s0);
  });
});
