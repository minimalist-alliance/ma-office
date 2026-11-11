// Desks never overlap (ADR 0064), by real mouse and keyboard. A moved or growing desk pushes its neighbours aside.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, signIn, watchConsole } from './helpers';

const A = 'd-personal00001';
const B = 'd-work000000001';
const C = 'd-guild00000001';
const D = 'd-extra00000001';
const NAMES: Record<string, [string, string]> = { [A]: ['Personal', 'personal'], [B]: ['Work', 'work'], [C]: ['Guild', 'guild'], [D]: ['Extra', 'work'] };
const GAP = 24;

interface Box { x: number; y: number; w: number; h: number }
interface Item extends Box { id: string; app: string }
type Layout = Record<string, Box & { items?: Item[] }>;

const fleet = (ids: string[]) => ids.map((deskId) => ({ deskId, name: NAMES[deskId]![0], kind: NAMES[deskId]![1], state: 'running' }));
const doc = (layout: Layout, z = Object.keys(layout)) => ({
  desks: Object.fromEntries(Object.entries(layout).map(([id, d]) => [id, { id, x: d.x, y: d.y, w: d.w, h: d.h, items: d.items ?? [] }])),
  z,
});

/** Only the first load seeds it, so a reload shows what was saved. */
async function open(page: Page, request: Parameters<typeof harness>[0], layout: Layout, key = 'ma.layout.v2'): Promise<void> {
  await page.addInitScript(({ d, k }) => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem(k, d);
  }, { d: JSON.stringify(doc(layout)), k: key });
  await harness(request, { fleet: fleet(Object.keys(layout)) });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(800); // the camera lands
}

// What Konva has, which is what's on the screen, and what the proxies have, which came from the store.
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; getStage(): { find(q: string): { id(): string; x(): number; y(): number; isVisible(): boolean }[]; getLayers(): { draw(): unknown }[] } } } };
const nodes = (page: Page): Promise<Record<string, { x: number; y: number }>> => page.evaluate(() => Object.fromEntries((window as unknown as Hook).__maDesk.camera.getStage().find('.desk').map((n) => [n.id().slice(5), { x: n.x(), y: n.y() }])));
const visible = (page: Page, id: string): Promise<boolean> => page.evaluate((did) => (window as unknown as Hook).__maDesk.camera.getStage().find('.desk').find((n) => n.id().slice(5) === did)!.isVisible(), id);
const cam = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }));
const proxy = (page: Page, id: string) => page.locator(`[id="proxy-${id}"]`);
const proxied = (page: Page, id: string): Promise<Box> => proxy(page, id).evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
const saved = (page: Page): Promise<{ desks: Record<string, Box>; z: string[] }> => page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? 'null'));

const toScreen = async (page: Page, x: number, y: number): Promise<{ x: number; y: number }> => {
  const c = await cam(page);
  return { x: x * c.s + c.x, y: y * c.s + c.y };
};

function gapBetween(a: Box, b: Box): number {
  return Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
}

/** No two of these overlap, and none is closer than the gap. Sizes come from what the proxies say. */
async function expectAllClear(page: Page, ids: string[]): Promise<void> {
  const boxes = await Promise.all(ids.map((id) => proxied(page, id)));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) expect(gapBetween(boxes[i]!, boxes[j]!), `${ids[i]} and ${ids[j]}`).toBeGreaterThanOrEqual(GAP - 0.011);
  }
}

/** Press a desk well inside its panel, at this world point, and hand back how to move the pointer in world units. */
async function grab(page: Page, x: number, y: number): Promise<{ to(dx: number, dy: number): Promise<void>; release(): Promise<void>; from: { x: number; y: number }; s: number }> {
  const from = await toScreen(page, x, y);
  const { s } = await cam(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  return {
    from,
    s,
    to: (dx, dy) => page.mouse.move(from.x + dx * s, from.y + dy * s),
    release: () => page.mouse.up(),
  };
}

/** Walk the pointer there in small steps, so Konva sees a real drag. */
async function walk(hand: Awaited<ReturnType<typeof grab>>, from: [number, number], to: [number, number], steps = 10): Promise<void> {
  for (let i = 1; i <= steps; i += 1) await hand.to(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
}

const ROW: Layout = {
  [A]: { x: 0, y: 0, w: 400, h: 200 },
  [B]: { x: 500, y: 0, w: 400, h: 200 },
  [C]: { x: 1000, y: 0, w: 400, h: 200 },
};

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('dragging a desk into another', () => {
  test('pushes it aside, keeps the gap, and the desk in hand stays exactly under the pointer', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [300, 0], 12);
    const live = await nodes(page);
    expect(live[A]!.x).toBeCloseTo(300, 0);
    expect(live[A]!.y).toBeCloseTo(0, 0);
    expect(live[B]!.x).toBeCloseTo(300 + 400 + GAP, 0);
    expect(live[B]!.y).toBe(0);
    const held = await toScreen(page, live[A]!.x + 200, live[A]!.y + 100);
    expect(Math.abs(held.x - (hand.from.x + 300 * hand.s))).toBeLessThan(1);
    await page.screenshot({ path: 'test-results/desks-push-in-progress.png' });
    await hand.release();
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'test-results/desks-push-after-drop.png' });
    expect(errors).toEqual([]);
  });

  test('a retreat in the same drag brings it back, and a drop there changes nothing', async ({ page, request }) => {
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [300, 0], 10);
    expect((await nodes(page))[B]!.x).toBeGreaterThan(600);
    await walk(hand, [300, 0], [0, 0], 10);
    expect((await nodes(page))[B]).toEqual({ x: 500, y: 0 });
    await hand.release();
    await page.waitForTimeout(200);
    expect((await nodes(page))[B]).toEqual({ x: 500, y: 0 });
    expect(await proxied(page, B)).toMatchObject({ x: 500, y: 0 });
  });

  test('a chain of three moves on together, with every gap kept', async ({ page, request }) => {
    await open(page, request, ROW);
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [400, 0], 16);
    const live = await nodes(page);
    expect(live[A]!.x).toBeCloseTo(400, 0);
    expect(live[B]!.x).toBeCloseTo(400 + 424, 0);
    expect(live[C]!.x).toBeCloseTo(400 + 848, 0);
    await page.screenshot({ path: 'test-results/desks-chain-in-progress.png' });
    await hand.release();
    await page.waitForTimeout(200);
    await expectAllClear(page, [A, B, C]);
    await page.screenshot({ path: 'test-results/desks-chain-after-drop.png' });
  });

  test('no hops: at every step of a real drag, no neighbour moves more than the pointer did', async ({ page, request }) => {
    await open(page, request, ROW);
    const hand = await grab(page, 200, 100);
    const path: [number, number][] = [];
    for (let i = 1; i <= 30; i += 1) path.push([i * 16, 0]); // into them, along the row
    for (let i = 1; i <= 15; i += 1) path.push([480 + i * 4, -i * 20]); // rising away, and still going
    for (let i = 1; i <= 15; i += 1) path.push([540 - i * 16, -300 + i * 20]); // back in on a slant
    for (let i = 1; i <= 15; i += 1) path.push([300 - i * 20, 0]); // and home
    let was = await nodes(page);
    let last: [number, number] = [0, 0];
    let moved = 0;
    for (const p of path) {
      await hand.to(p[0], p[1]);
      const now = await nodes(page);
      const allowed = Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]);
      for (const id of [B, C]) {
        const step = Math.max(Math.abs(now[id]!.x - was[id]!.x), Math.abs(now[id]!.y - was[id]!.y));
        moved = Math.max(moved, step);
        expect(step, `${id} at ${p.join()}`).toBeLessThanOrEqual(allowed + 2 / hand.s); // a pixel of rounding each way, at this zoom
      }
      was = now;
      last = p;
    }
    expect(moved).toBeGreaterThan(5); // they really were pushed
    await hand.release();
  });

  test('a real pointer flick right past a neighbour pushes it ahead: no swap by speed', async ({ page, request }) => {
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    const hand = await grab(page, 200, 100);
    await hand.to(20, 0);
    await hand.to(1500, 0); // one event
    const live = await nodes(page);
    expect(live[B]!.x).toBeGreaterThan(live[A]!.x + 400);
    await hand.release();
  });

  test('going round: a neighbour touched and left stays home, and the desk lands beyond it', async ({ page, request }) => {
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [90, 0], 6); // touches it
    await walk(hand, [90, 0], [90, -400], 10); // up and off
    expect((await nodes(page))[B]).toEqual({ x: 500, y: 0 });
    await walk(hand, [90, -400], [1000, -400], 10); // over
    await walk(hand, [1000, -400], [1000, 0], 10); // down beyond it
    const live = await nodes(page);
    expect(live[B]).toEqual({ x: 500, y: 0 });
    expect(live[A]!.x).toBeCloseTo(1000, 0);
    await hand.release();
    await page.waitForTimeout(200);
    await expectAllClear(page, [A, B]);
  });

  test('the drop survives a reload, with exactly what was on the screen', async ({ page, request }) => {
    await open(page, request, ROW);
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [317, 13], 14);
    await hand.release();
    await page.waitForTimeout(200);
    const dropped = { [A]: await proxied(page, A), [B]: await proxied(page, B), [C]: await proxied(page, C) };
    expect(dropped[B]!.x).toBeGreaterThan(500);
    await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(400);
    expect(await proxied(page, A)).toEqual(dropped[A]);
    expect(await proxied(page, B)).toEqual(dropped[B]);
    expect(await proxied(page, C)).toEqual(dropped[C]);
    await expectAllClear(page, [A, B, C]);
  });

  test('one store write at the drop, no React render and no extra draw while it moves', async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w['__commits'] = 0;
      w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
        isDisabled: false, supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE: () => {},
        onScheduleFiberRoot: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: () => { w['__commits'] = (w['__commits'] as number) + 1; },
      };
    });
    await open(page, request, ROW);
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & Hook;
      const layer = w.__maDesk.camera.getStage().getLayers()[0]!;
      const draw = layer.draw.bind(layer);
      w['__draws'] = 0;
      layer.draw = () => { w['__draws'] = (w['__draws'] as number) + 1; return draw(); };
      w['__frames'] = 0;
      const tick = (): void => { w['__frames'] = (w['__frames'] as number) + 1; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const read = (k: string): Promise<number> => page.evaluate((key) => (window as unknown as Record<string, number>)[key]!, k);
    const hand = await grab(page, 200, 100);
    await hand.to(20, 0); // past the drag threshold: the raise is the one render a drag starts with
    await page.waitForTimeout(100);
    const commits = await read('__commits');
    const draws = await read('__draws');
    const frames = await read('__frames');
    await walk(hand, [20, 0], [500, 0], 30);
    expect(await read('__commits') - commits).toBe(0);
    expect((await nodes(page))[C]!.x).toBeGreaterThan(1000); // the chain really moved
    expect(await read('__draws') - draws).toBeLessThanOrEqual(await read('__frames') - frames + 1); // one batched draw a frame at most
    await hand.release();
    await page.waitForTimeout(200);
    expect(await read('__commits') - commits).toBeGreaterThan(0);
  });

  test('the proxies and the keyboard\'s order follow after a drop', async ({ page, request }) => {
    const layout: Layout = {
      [A]: { x: 0, y: 0, w: 400, h: 200 },
      [B]: { x: 0, y: 260, w: 400, h: 200 },
      [C]: { x: 500, y: 450, w: 400, h: 124 },
    };
    await open(page, request, layout);
    // Reading order: A, B, C. Dragging A down pushes B below C's row, which makes it A, C, B.
    await focusCanvas(page);
    await page.keyboard.press('2');
    await page.waitForTimeout(700);
    await expect(page.getByRole('status').first()).toContainText('Work desk');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [0, 400], 16);
    await hand.release();
    await page.waitForTimeout(300);
    const pushed = await proxied(page, B);
    expect(pushed.y).toBeCloseTo(400 + 200 + GAP, 0);
    const b = (await proxy(page, B).boundingBox())!;
    const at = await toScreen(page, pushed.x, pushed.y);
    expect(Math.abs(b.x - at.x)).toBeLessThan(1);
    expect(Math.abs(b.y - at.y)).toBeLessThan(1);
    await page.keyboard.press('2');
    await page.waitForTimeout(700);
    await expect(page.getByRole('status').first()).toContainText('Guild desk');
  });

  test('a desk pushed out of view stops drawing, and shows again when it comes back', async ({ page, request }) => {
    await open(page, request, { [A]: { x: 0, y: 0, w: 400, h: 300 }, [B]: { x: 500, y: 0, w: 400, h: 300 } });
    await focusCanvas(page);
    await page.keyboard.press('1');
    await page.waitForTimeout(800);
    const c = await cam(page);
    const box = (await proxy(page, A).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(start.x + 200, start.y, { steps: 8 });
    await page.mouse.move(1430, start.y, { steps: 20 });
    expect(c.s).toBeGreaterThan(1);
    expect(await visible(page, B)).toBe(false);
    await page.mouse.move(start.x, start.y, { steps: 24 });
    expect(await visible(page, B)).toBe(true);
    await page.mouse.up();
    expect((await nodes(page))[B]).toEqual({ x: 500, y: 0 });
  });
});

test.describe('desks the screen doesn\'t show', () => {
  test('a desk the filter hides is pushed too, so clearing the filter shows no overlap', async ({ page, request }) => {
    await open(page, request, {
      [B]: { x: 0, y: 0, w: 400, h: 200 },
      [A]: { x: 500, y: 0, w: 400, h: 200 }, // Personal, about to be hidden
      [D]: { x: 1500, y: 0, w: 400, h: 200 },
    });
    await page.getByRole('radio', { name: 'Work' }).or(page.getByRole('button', { name: 'Work', exact: true })).first().click();
    await page.waitForTimeout(800);
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [600, 0], 20);
    await hand.release();
    await page.waitForTimeout(300);
    expect((await nodes(page))[A]!.x).toBeGreaterThanOrEqual(600 + 400 + GAP);
    await page.getByRole('radio', { name: 'All' }).or(page.getByRole('button', { name: 'All', exact: true })).first().click();
    await page.waitForTimeout(800);
    await expectAllClear(page, [A, B, D]);
  });

  test('a desk that arrives from the list in the middle of a drag is clear of everything after the drop', async ({ page, request }) => {
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [500, 0], 10);
    await harness(request, { fleet: fleet([A, B, C]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // polls the list
    await expect(proxy(page, C)).toHaveCount(1);
    await walk(hand, [500, 0], [700, 0], 8);
    await hand.release();
    await page.waitForTimeout(300);
    await expectAllClear(page, [A, B, C]);
  });

  test('a desk that leaves the list in the middle of a drag leaves the drop working', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, ROW);
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [500, 0], 10);
    await harness(request, { fleet: fleet([A, C]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(proxy(page, B)).toHaveCount(0);
    await walk(hand, [500, 0], [600, 0], 6);
    await hand.release();
    await page.waitForTimeout(300);
    await expectAllClear(page, [A, C]);
    expect(errors).toEqual([]);
  });
});

test.describe('growing a desk into another', () => {
  async function corner(page: Page, id: string): Promise<{ to(dx: number, dy: number): Promise<void>; release(): Promise<void>; s: number }> {
    const b = (await proxy(page, id).boundingBox())!;
    const from = { x: b.x + b.width - 12, y: b.y + b.height - 12 };
    const { s } = await cam(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    return { s, to: (dx, dy) => page.mouse.move(from.x + dx * s, from.y + dy * s), release: () => page.mouse.up() };
  }

  test('pushes what\'s right of the corner rightward and what\'s below downward, and the corner stays under the pointer', async ({ page, request }) => {
    await open(page, request, {
      [A]: { x: 0, y: 0, w: 400, h: 200 },
      [B]: { x: 460, y: 0, w: 400, h: 200 },
      [C]: { x: 0, y: 260, w: 400, h: 200 },
    });
    const hand = await corner(page, A);
    for (let i = 1; i <= 16; i += 1) await hand.to(i * 20, i * 15);
    const live = await nodes(page);
    expect(live[A]).toEqual({ x: 0, y: 0 });
    expect(live[B]!.y).toBe(0);
    expect(live[B]!.x).toBeCloseTo(400 + 320 + GAP, 0);
    expect(live[C]!.x).toBe(0);
    expect(live[C]!.y).toBeCloseTo(200 + 240 + GAP, 0);
    await page.screenshot({ path: 'test-results/desks-grow-in-progress.png' });
    await hand.release();
    await page.waitForTimeout(200);
    const grown = await proxied(page, A);
    expect(grown.w).toBeCloseTo(720, 0);
    expect(grown.h).toBeCloseTo(440, 0);
    await expectAllClear(page, [A, B, C]);
    await page.screenshot({ path: 'test-results/desks-grow-after-drop.png' });
  });

  test('shrinking in the same drag brings them back', async ({ page, request }) => {
    await open(page, request, { [A]: { x: 0, y: 0, w: 400, h: 200 }, [B]: { x: 460, y: 0, w: 400, h: 200 } });
    const hand = await corner(page, A);
    for (let i = 1; i <= 10; i += 1) await hand.to(i * 20, 0);
    expect((await nodes(page))[B]!.x).toBeGreaterThan(460);
    for (let i = 9; i >= 0; i -= 1) await hand.to(i * 20, 0);
    expect((await nodes(page))[B]).toEqual({ x: 460, y: 0 });
    await hand.release();
  });

  test('no hops growing either', async ({ page, request }) => {
    await open(page, request, { [A]: { x: 0, y: 0, w: 400, h: 200 }, [B]: { x: 460, y: 0, w: 400, h: 200 }, [C]: { x: 960, y: 0, w: 400, h: 200 } });
    const hand = await corner(page, A);
    let was = await nodes(page);
    let last = 0;
    for (let i = 1; i <= 30; i += 1) {
      const dx = i * 24;
      await hand.to(dx, 0);
      const now = await nodes(page);
      for (const id of [B, C]) expect(Math.abs(now[id]!.x - was[id]!.x), `${id}`).toBeLessThanOrEqual(dx - last + 2 / hand.s);
      was = now;
      last = dx;
    }
    await hand.release();
  });

  test('at the screen\'s edge the camera pans and neighbours keep going under a still pointer', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, { [A]: { x: 0, y: 0, w: 400, h: 200 }, [B]: { x: 460, y: 0, w: 400, h: 200 } });
    const b = (await proxy(page, A).boundingBox())!;
    await page.mouse.move(b.x + b.width - 12, b.y + b.height - 12);
    await page.mouse.down();
    await page.mouse.move(1432, b.y + b.height - 12, { steps: 16 });
    await page.waitForTimeout(100);
    const before = (await nodes(page))[B]!.x;
    const camBefore = await cam(page);
    await page.waitForTimeout(500);
    const after = (await nodes(page))[B]!.x;
    const camAfter = await cam(page);
    expect(camAfter.x).toBeLessThan(camBefore.x - 30);
    expect(after).toBeGreaterThan(before + 30);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expectAllClear(page, [A, B]);
    expect(errors).toEqual([]);
  });
});

test.describe('no walls', () => {
  test('pushed into negative coordinates: it draws, the proxy follows, Fit shows it, and arrival shows it', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, { [A]: { x: 0, y: 0, w: 400, h: 200 }, [B]: { x: 500, y: 0, w: 400, h: 200 } });
    const hand = await grab(page, 700, 100);
    await walk(hand, [0, 0], [-700, 0], 24); // B drags left, through A's place, shoving it far past zero
    await hand.release();
    await page.waitForTimeout(300);
    const pushed = await proxied(page, A);
    expect(pushed.x).toBeLessThan(-300);
    const held = await proxied(page, B);
    expect(pushed.x + pushed.w + GAP).toBeCloseTo(held.x, 0);
    const box = (await proxy(page, A).boundingBox())!;
    const at = await toScreen(page, pushed.x, pushed.y);
    expect(Math.abs(box.x - at.x)).toBeLessThan(1);

    // Fit brings the whole office onto the screen, negative part and all.
    await page.getByRole('button', { name: /^Fit/ }).click();
    await page.waitForTimeout(800);
    for (const id of [A, B]) {
      const b = (await proxy(page, id).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1440);
    }
    // Keyboard focus lands on it, with the whole desk on the screen.
    await focusCanvas(page);
    await page.keyboard.press('1');
    await page.waitForTimeout(800);
    await expect(page.getByRole('status').first()).toContainText('Personal desk');
    const focused = (await proxy(page, A).boundingBox())!;
    expect(focused.x).toBeGreaterThanOrEqual(0);
    expect(focused.x + focused.width).toBeLessThanOrEqual(1440);
    await page.keyboard.press('Escape');

    // And after a reload the arrival fits it.
    await page.waitForTimeout(1_200);
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(800);
    expect((await proxied(page, A)).x).toBe(pushed.x);
    const back = (await proxy(page, A).boundingBox())!;
    expect(back.x).toBeGreaterThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});

test.describe('the keyboard follows the same rule', () => {
  const said = (page: Page) => page.getByRole('status').first();

  test('m and the arrows push, Esc restores every desk, Enter keeps them', async ({ page, request }) => {
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    await proxy(page, A).focus();
    await page.keyboard.press('m');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowRight'); // 160: past the 76 to contact
    expect(await proxied(page, A)).toMatchObject({ x: 160, y: 0 });
    expect(await proxied(page, B)).toMatchObject({ x: 160 + 400 + GAP, y: 0 });
    await expect(said(page)).toHaveText('Personal desk at 160, 0, Work desk pushed aside');
    await page.keyboard.press('Escape');
    expect(await proxied(page, A)).toMatchObject({ x: 0, y: 0 });
    expect(await proxied(page, B)).toMatchObject({ x: 500, y: 0 });

    await page.keyboard.press('m');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowLeft'); // a retreat brings it back
    expect(await proxied(page, B)).toMatchObject({ x: 500 });
    await expect(said(page)).toHaveText('Personal desk at 40, 0');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Enter');
    expect(await proxied(page, B)).toMatchObject({ x: 584, y: 0 });
    await expectAllClear(page, [A, B]);
  });

  test('r and the arrows push, Esc restores every desk, and a chain follows', async ({ page, request }) => {
    await open(page, request, ROW);
    await proxy(page, A).focus();
    await page.keyboard.press('r');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowRight'); // 640 wide
    expect(await proxied(page, A)).toMatchObject({ x: 0, w: 640 });
    expect((await proxied(page, B)).x).toBe(640 + GAP);
    expect((await proxied(page, C)).x).toBe(640 + GAP + 400 + GAP);
    await expect(said(page)).toHaveText('Personal desk, 640 by 200, 2 desks pushed aside');
    await page.keyboard.press('Escape');
    expect(await proxied(page, A)).toMatchObject({ x: 0, w: 400 });
    expect((await proxied(page, B)).x).toBe(500);
    expect((await proxied(page, C)).x).toBe(1000);
    await page.keyboard.press('r');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    expect(await proxied(page, A)).toMatchObject({ h: 440 });
    await expectAllClear(page, [A, B, C]);
  });

  test('the context menu\'s Move and Resize are the same edit', async ({ page, request }) => {
    await open(page, request, { [A]: ROW[A]!, [B]: ROW[B]! });
    await proxy(page, A).focus();
    await page.keyboard.press('.');
    await page.getByRole('menuitem', { name: 'Resize' }).click();
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Enter');
    expect((await proxied(page, B)).x).toBe(400 + 160 + GAP);
  });
});

test.describe('cleanup growing a desk', () => {
  const ITEMS = (id: string): Item[] => [
    { id: `${id}:chat`, app: 'chat', x: 8, y: 8, w: 180, h: 130 },
    { id: `${id}:notebook`, app: 'notebook', x: 200, y: 8, w: 180, h: 130 },
    { id: `${id}:browser`, app: 'browser', x: 8, y: 146, w: 372, h: 110 },
  ];
  // Cleanup makes it 470 tall, from 300. What's below is 30 under it.
  const LAYOUT: Layout = {
    [A]: { x: 0, y: 36, w: 400, h: 300, items: ITEMS(A) },
    [B]: { x: 0, y: 366, w: 400, h: 200 },
    [C]: { x: 0, y: 596, w: 400, h: 200 },
    [D]: { x: 460, y: 36, w: 400, h: 200 },
  };
  const clean = (page: Page) => page.getByRole('button', { name: 'Clean up Personal desk', exact: true });
  const undo = (page: Page) => page.getByRole('button', { name: 'Undo clean up Personal desk', exact: true });
  const trackY = (page: Page, id: string, ms: number): Promise<number[]> => page.evaluate(([did, t]) => new Promise<number[]>((res) => {
    const seen: number[] = [];
    const start = performance.now();
    const node = (window as unknown as Hook).__maDesk.camera.getStage().find('.desk').find((n) => n.id().slice(5) === did)!;
    const tick = (): void => {
      seen.push(node.y());
      if (performance.now() - start < (t as number)) requestAnimationFrame(tick);
      else res(seen);
    };
    requestAnimationFrame(tick);
  }), [id, ms] as const);

  test('neighbours move with it over its 240 ms, and Undo brings them back with the camera still', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, LAYOUT);
    const camera = await cam(page);
    await clean(page).focus();
    const track = trackY(page, B, 420);
    await page.keyboard.press('Enter');
    const ys = await track;
    expect(await proxied(page, A)).toMatchObject({ h: 470 });
    expect(await proxied(page, B)).toMatchObject({ x: 0, y: 36 + 470 + GAP });
    expect(await proxied(page, C)).toMatchObject({ x: 0, y: 36 + 470 + GAP + 200 + GAP });
    expect(await proxied(page, D)).toMatchObject({ x: 460, y: 36 }); // not in the way
    const between = ys.filter((y) => y > 366.5 && y < 529.5);
    expect(between.length, `saw ${ys.join()}`).toBeGreaterThan(3); // gliding, not a jump
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]! - 0.01); // never backward
    expect(ys[ys.length - 1]).toBeCloseTo(36 + 470 + GAP, 5);
    await expectAllClear(page, [A, B, C, D]);
    expect(await cam(page)).toEqual(camera);

    await undo(page).focus();
    const back = trackY(page, B, 420);
    await page.keyboard.press('Enter');
    const returning = await back;
    expect(returning.filter((y) => y > 366.5 && y < 529.5).length).toBeGreaterThan(3);
    expect(await proxied(page, A)).toMatchObject({ y: 36, h: 300 });
    expect(await proxied(page, B)).toMatchObject({ x: 0, y: 366 });
    expect(await proxied(page, C)).toMatchObject({ x: 0, y: 596 });
    expect(await cam(page)).toEqual(camera);
    expect(errors).toEqual([]);
  });

  test('undo leaves a neighbour that has been moved since where it now is', async ({ page, request }) => {
    await open(page, request, LAYOUT);
    await clean(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const pushed = await proxied(page, C);
    // The member moves the lowest desk well away by hand. The undo is on the other desk, so it's still good.
    const hand = await grab(page, 200, pushed.y + 100);
    await walk(hand, [0, 0], [1200, 300], 16);
    await hand.release();
    await page.waitForTimeout(300);
    const moved = await proxied(page, C);
    await undo(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await proxied(page, A)).toMatchObject({ h: 300 });
    expect(await proxied(page, B)).toMatchObject({ y: 366 });
    expect(await proxied(page, C)).toEqual(moved);
    await expectAllClear(page, [A, B, C, D]);
  });

  test('reduced motion: its neighbours move at once, and a drag still tracks the pointer', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, request, LAYOUT);
    await clean(page).focus();
    const track = trackY(page, B, 300);
    await page.keyboard.press('Enter');
    const ys = await track;
    expect(ys.filter((y) => y > 366.5 && y < 529.5)).toEqual([]);
    expect(await proxied(page, B)).toMatchObject({ y: 530 });
    await undo(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    expect((await nodes(page))[B]).toEqual({ x: 0, y: 366 });

    // During a drag it isn't timed, so it still follows, step by step.
    const box = await proxied(page, D);
    const hand = await grab(page, box.x + 100, box.y + 100);
    let was = (await nodes(page))[A]!.x;
    let pushedAt = 0;
    for (let i = 1; i <= 12; i += 1) {
      await hand.to(-i * 30, 0);
      const now = (await nodes(page))[A]!.x;
      expect(Math.abs(now - was)).toBeLessThanOrEqual(30 + 2 / hand.s);
      if (now !== was) pushedAt = i;
      was = now;
    }
    expect(pushedAt).toBe(12);
    expect(was).toBeLessThan(0);
    await hand.release();
  });
});

test.describe('a saved layout', () => {
  const OVERLAPPING: Layout = {
    [A]: { x: 0, y: 0, w: 600, h: 400 },
    [B]: { x: 500, y: 100, w: 400, h: 200 },
    [C]: { x: 40, y: 60, w: 300, h: 150 }, // wholly inside A
    [D]: { x: 2000, y: 0, w: 400, h: 200 },
  };

  test('that overlaps loads clear before anything paints, is written back, and stays that way', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.addInitScript(() => {
      // Every position the very first frame with desks could have drawn: the first paint is what a member would see.
      // A fresh browser can paint the ground before the list has answered (as it does through our own sign-in
      // pages), and a frame with no desks shows no overlap, so this is the first frame that has any.
      const w = window as unknown as Record<string, unknown>;
      w['__firstPaint'] = null;
      const watch = (): void => {
        const hook = (window as unknown as Partial<Hook>).__maDesk;
        if (hook && !w['__firstPaint'] && performance.getEntriesByName('ma:first-canvas-paint').length) {
          const desks = hook.camera.getStage().find('.desk');
          if (desks.length) w['__firstPaint'] = Object.fromEntries(desks.map((n) => [n.id().slice(5), { x: n.x(), y: n.y() }]));
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    await open(page, request, OVERLAPPING);
    const boxes = await Promise.all([A, B, C, D].map((id) => proxied(page, id)));
    await expectAllClear(page, [A, B, C, D]);
    expect(boxes[3]).toMatchObject({ x: 2000, y: 0 }); // it overlapped nothing
    const moved = await page.evaluate(() => (window as unknown as { __firstPaint: Record<string, { x: number; y: number }> }).__firstPaint);
    expect(moved[B]).toEqual({ x: boxes[1]!.x, y: boxes[1]!.y });
    expect(moved[C]).toEqual({ x: boxes[2]!.x, y: boxes[2]!.y });
    const stored = await saved(page);
    expect(stored.desks[B]).toMatchObject({ x: boxes[1]!.x, y: boxes[1]!.y });
    await page.screenshot({ path: 'test-results/desks-saved-overlap-loaded.png' });
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(400);
    expect(await Promise.all([A, B, C, D].map((id) => proxied(page, id)))).toEqual(boxes);
    expect(errors).toEqual([]);
  });

  test('with no overlaps comes through byte for byte, close and touching desks included, and isn\'t written back', async ({ page, request }) => {
    const layout: Layout = {
      [A]: { x: -40.25, y: 0, w: 400, h: 200 },
      [B]: { x: 369.75, y: 0, w: 400, h: 200 }, // 10 from A, under the gap
      [C]: { x: 769.75, y: 0, w: 400, h: 200 }, // touching B
    };
    const text = JSON.stringify(doc(layout));
    await open(page, request, layout);
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2'))).toBe(text);
    await page.waitForTimeout(1_200); // past the mirror's debounce
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2'))).toBe(text);
    expect(await proxied(page, B)).toMatchObject({ x: 369.75, y: 0 });
    expect(await proxied(page, C)).toMatchObject({ x: 769.75, y: 0 });
  });

  test('desks closer than the gap don\'t jump when one is next dragged', async ({ page, request }) => {
    await open(page, request, { [A]: { x: 0, y: 0, w: 400, h: 200 }, [B]: { x: 410, y: 0, w: 400, h: 200 } });
    const hand = await grab(page, 200, 100);
    await hand.to(6, 0);
    await hand.to(12, 0);
    const live = await nodes(page);
    expect(live[B]!.x).toBeLessThanOrEqual(410 + 13);
    expect(live[B]!.x - (live[A]!.x + 400)).toBeCloseTo(10, 0); // the gap it already had
    await hand.release();
  });

  test('version 1 that overlaps migrates clear, and version 1 stays as it was for a rollback', async ({ page, request }) => {
    const v1 = {
      desks: {
        [A]: { id: A, x: 0, y: 36, cols: 6, rows: 1, items: [] },
        [B]: { id: B, x: 100, y: 60, cols: 6, rows: 1, items: [] },
      },
      z: [A, B],
    };
    const text = JSON.stringify(v1);
    await page.addInitScript((d) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v1', d);
    }, text);
    await harness(request, { fleet: fleet([A, B]) });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(400);
    await expectAllClear(page, [A, B]);
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v1'))).toBe(text);
    const stored = await saved(page);
    expect(gapBetween(stored.desks[A]!, stored.desks[B]!)).toBeGreaterThanOrEqual(GAP);
  });

  test('a stored size that grows on the way in is counted', async ({ page, request }) => {
    // B is stored too small for what it holds, so it grows into A's place when read.
    const items: Item[] = [{ id: `${B}:chat`, app: 'chat', x: 24, y: 24, w: 400, h: 300 }];
    await open(page, request, { [A]: { x: 300, y: 200, w: 400, h: 200 }, [B]: { x: 0, y: 0, w: 280, h: 180, items } });
    await expectAllClear(page, [A, B]);
  });
});

test.describe('new and removed desks', () => {
  test('a new desk from the list lands clear of a tall desk from another row, and a new desk in an open row 72 along', async ({ page, request }) => {
    await open(page, request, {
      [A]: { x: 0, y: 500, w: 400, h: 200 },
      [B]: { x: 500, y: -500, w: 400, h: 1100 }, // a tall one, its foot beside where the next desk would go
    });
    await harness(request, { fleet: fleet([A, B, C]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // polls the list
    await expect(proxy(page, C)).toHaveCount(1);
    await expectAllClear(page, [A, B, C]);
    const c = await proxied(page, C);
    expect(c.y).toBe(500);
    expect(c.x).toBe(900 + 72); // right of the tall one, with a new desk's room

    await harness(request, { fleet: fleet([A, B, C, D]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(proxy(page, D)).toHaveCount(1);
    expect((await proxied(page, D)).x).toBe(c.x + c.w + 72);
    await expectAllClear(page, [A, B, C, D]);
  });

  test('a removed desk leaves its gap, and nothing else moves', async ({ page, request }) => {
    await open(page, request, ROW);
    await harness(request, { fleet: fleet([A, C]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(proxy(page, B)).toHaveCount(0);
    expect(await proxied(page, A)).toMatchObject({ x: 0, y: 0 });
    expect(await proxied(page, C)).toMatchObject({ x: 1000, y: 0 });
  });
});

test.describe('phones', () => {
  test('keep their own grid: four columns, no corner, and a clean layout untouched', async ({ browser, request }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const layout: Layout = { [A]: { x: 0, y: 0, w: 584, h: 236 }, [B]: { x: 656, y: 0, w: 584, h: 236 } };
    const text = JSON.stringify(doc(layout));
    await open(page, request, layout);
    const count = await page.evaluate(() => (window as unknown as { __maDesk: { camera: { getStage(): { find(q: string): unknown[] } } } }).__maDesk.camera.getStage().find('.resize-handle').length);
    expect(count).toBe(0);
    expect((await proxied(page, A)).w).toBe(400); // the phone grid's width, not the stored 584
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2'))).toBe(text);
    await ctx.close();
  });

  test('a desk dragged on a phone pushes by what\'s stored, and the grid inside it doesn\'t change', async ({ browser, request }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await open(page, request, { [A]: { x: 0, y: 0, w: 584, h: 236 }, [B]: { x: 656, y: 0, w: 584, h: 236 } });
    // A phone arrives at its desk; the drag is about both desks, so start from the overview.
    await page.getByRole('button', { name: 'Your office, show all desks' }).tap();
    await page.waitForTimeout(800);
    const hand = await grab(page, 200, 100);
    await walk(hand, [0, 0], [300, 0], 14);
    await hand.release();
    await page.waitForTimeout(300);
    const live = await nodes(page);
    expect(Math.abs(live[A]!.x - 300)).toBeLessThan(2 / hand.s); // a pixel is several units this far out
    expect(live[B]!.x - (live[A]!.x + 584)).toBeCloseTo(GAP, 1);
    await page.waitForTimeout(1_200);
    const stored = await saved(page);
    expect(gapBetween(stored.desks[A]!, stored.desks[B]!)).toBeGreaterThanOrEqual(GAP);
    expect((await proxied(page, A)).w).toBe(400);
    await ctx.close();
  });
});
