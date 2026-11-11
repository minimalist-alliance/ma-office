// The finger's gestures on the Browser's picture (spec (f) section 1), with synthetic pointer events and a clock of our
// own, and the arithmetic that takes a tap through the zoom to the desk's pixel. The DOM round them is
// `browser.touch.shell.spec.ts`'s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentBox, normalized, type Box } from '../desk/rtc/input';
import {
  clampZoom,
  dragAxis,
  deskPixelsPerScreenPixel,
  deskPoint,
  DIRECT_HOLD_MS,
  FIT,
  LONG_PRESS_MS,
  pinchZoom,
  shownMiddle,
  TAP_SLOP_PX,
  TouchGestures,
  touchHintDue,
  touchHintShown,
  unzoomed,
  zoomAbout,
  zoomLimit,
  zoomTransform,
  type Frame,
  type GestureClock,
  type Pt,
  type Zoom,
} from './touchInput';

class FakeClock implements GestureClock {
  now = 1_000;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private frames = new Map<number, (t: number) => void>();

  later(fn: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  cancel(id: number): void {
    this.timers.delete(id);
  }

  frame(fn: (t: number) => void): number {
    const id = this.next++;
    this.frames.set(id, fn);
    return id;
  }

  cancelFrame(id: number): void {
    this.frames.delete(id);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at > this.now) continue;
      this.timers.delete(id);
      t.fn();
    }
  }

  /** One display frame, 16 ms on. */
  tick(): void {
    this.now += 16;
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const fn of due) fn(this.now);
  }

  get framesWaiting(): number {
    return this.frames.size;
  }
}

type Sent =
  | { click: [number, number, number] }
  | { press: [number, number] }
  | { drag: [number, number] }
  | { release: [number, number] }
  | { scroll: [number, number, number, number] }
  | { zoom: Zoom }
  | { mark: string };

/** A phone held upright: the picture 390 wide and 16:9 at the top of a 457 tall surface, 100 px down the screen. */
const EL: Box = { left: 0, top: 100, width: 390, height: 219.375 };
const AREA: Box = { left: 0, top: 100, width: 390, height: 457 };
const FRAME: Frame = { el: EL, area: AREA };
const W = 390;
const H = 844;

let clock: FakeClock;
let sent: Sent[];
let g: TouchGestures;
let direct: boolean;

const down = (id: number, x: number, y: number): void => g.down({ id, x, y, t: clock.now });
const move = (id: number, x: number, y: number): void => g.move({ id, x, y, t: clock.now });
const up = (id: number, x: number, y: number): void => g.up({ id, x, y, t: clock.now });
const tap = (x: number, y: number): void => {
  down(1, x, y);
  clock.advance(60);
  up(1, x, y);
};
/** What reached the desk, or would have: feedback and zoom left out. */
const input = (): Sent[] => sent.filter((s) => !('mark' in s) && !('zoom' in s));
const clicks = (): [number, number, number][] => sent.flatMap((s) => ('click' in s ? [s.click] : []));
const scrolls = (): [number, number, number, number][] => sent.flatMap((s) => ('scroll' in s ? [s.scroll] : []));
const zooms = (): Zoom[] => sent.flatMap((s) => ('zoom' in s ? [s.zoom] : []));
const marks = (): string[] => sent.flatMap((s) => ('mark' in s ? [s.mark] : []));
const sum = (n: number[]): number => n.reduce((a, b) => a + b, 0);

beforeEach(() => {
  clock = new FakeClock();
  sent = [];
  direct = false;
  g = new TouchGestures({
    sink: {
      click: (at: Pt, button) => sent.push({ click: [at.x, at.y, button] }),
      press: (at) => sent.push({ press: [at.x, at.y] }),
      drag: (at) => sent.push({ drag: [at.x, at.y] }),
      release: (at) => sent.push({ release: [at.x, at.y] }),
      scroll: (at: Pt, dx, dy) => sent.push({ scroll: [at.x, at.y, dx, dy] }),
      zoom: (z) => sent.push({ zoom: z }),
      land: () => sent.push({ mark: 'land' }),
      held: () => sent.push({ mark: 'held' }),
      lift: (t) => sent.push({ mark: t ? 'lift tap' : 'lift' }),
      done: () => sent.push({ mark: 'done' }),
    },
    clock,
    frame: () => FRAME,
    maxZoom: () => 4,
    edges: (at) => ({ side: at.x <= 16 || at.x >= W - 16, bottom: at.y >= H - 16 }),
    direct: () => direct,
  });
});

describe('one finger', () => {
  it('a tap is a click at the lift, where the finger landed, and nothing else, then or later', () => {
    down(1, 120, 180);
    clock.advance(60);
    expect(input()).toEqual([]);
    expect(marks()).toEqual(['land']);
    up(1, 120, 182);
    clock.advance(1_000);
    expect(input()).toEqual([{ click: [120, 180, 1] }]);
    expect(marks()).toEqual(['land', 'lift tap', 'done']);
  });

  it('a finger that wobbles less than the slop still taps; one that goes further never presses', () => {
    down(1, 120, 180);
    move(1, 120 + TAP_SLOP_PX - 2, 182);
    up(1, 120 + TAP_SLOP_PX - 2, 182);
    expect(input()).toEqual([{ click: [120, 180, 1] }]);
    sent = [];
    clock.advance(400);
    down(1, 120, 180);
    move(1, 120, 180 + TAP_SLOP_PX + 1);
    up(1, 120, 180 + TAP_SLOP_PX + 1);
    expect(clicks()).toEqual([]);
    expect(marks()).toEqual(['land', 'lift', 'done']);
  });

  it('a drag scrolls the page, which follows the finger: up the screen scrolls down, from where the slop ended', () => {
    down(1, 200, 300);
    for (const y of [295, 285, 260, 235]) {
      clock.advance(40);
      move(1, 200, y);
    }
    clock.advance(200); // a rest before lifting: no fling
    up(1, 200, 235);
    expect(clicks()).toEqual([]);
    const s = scrolls();
    expect(s.length).toBe(2);
    expect(s.every(([, , dx, dy]) => dx === 0 && dy > 0)).toBe(true);
    expect(sum(s.map((e) => e[3]))).toBe(285 - 235);
    expect(clock.framesWaiting).toBe(0);
  });

  it('a drag that starts mostly down keeps to that axis: a finger drifting sideways never slides the page sideways', () => {
    down(1, 200, 300);
    clock.advance(30);
    move(1, 203, 280);
    for (const [x, y] of [[215, 250], [240, 220], [260, 200]] as const) {
      clock.advance(30);
      move(1, x, y);
    }
    expect(scrolls().every(([, , dx]) => dx === 0)).toBe(true);
    expect(sum(scrolls().map((e) => e[3]))).toBe(80);
  });

  it('one that starts sideways keeps sideways; one that starts on a slant goes both ways', () => {
    down(1, 100, 300);
    clock.advance(30);
    move(1, 130, 302);
    clock.advance(30);
    move(1, 170, 330);
    expect(scrolls()).toEqual([[170, 330, -40, 0]]);
    up(1, 170, 330);
    clock.advance(500);
    sent = [];
    down(1, 100, 300);
    clock.advance(30);
    move(1, 112, 312);
    clock.advance(30);
    move(1, 140, 340);
    expect(scrolls()).toEqual([[140, 340, -28, -28]]);
    expect(dragAxis(30, 2)).toBe('x');
    expect(dragAxis(2, -30)).toBe('y');
    expect(dragAxis(20, 20)).toBeNull();
  });

  it('a quick drag carries on after the lift, slowing, on its axis; the next touch stops it and presses nothing', () => {
    down(1, 200, 400);
    for (let i = 1; i <= 6; i += 1) {
      clock.advance(8);
      move(1, 200 + i, 400 - 20 * i);
    }
    up(1, 206, 280);
    const during = scrolls().length;
    clock.tick();
    clock.tick();
    clock.tick();
    const after = scrolls().slice(during);
    expect(after.length).toBe(3);
    expect(after.every(([, , dx, dy]) => dx === 0 && dy > 0)).toBe(true);
    expect(after[2]![3]).toBeLessThan(after[0]![3]);
    tap(100, 150);
    clock.tick();
    expect(scrolls().length).toBe(during + 3);
    expect(clicks()).toEqual([]);
    clock.advance(400);
    tap(100, 150);
    expect(clicks()).toEqual([[100, 150, 1]]);
  });

  it('a fling runs down by itself', () => {
    down(1, 200, 400);
    for (let i = 1; i <= 4; i += 1) {
      clock.advance(10);
      move(1, 200, 400 - 15 * i);
    }
    up(1, 200, 340);
    for (let i = 0; i < 200 && clock.framesWaiting; i += 1) clock.tick();
    expect(clock.framesWaiting).toBe(0);
  });
});

describe('a long press', () => {
  it(`holds at ${LONG_PRESS_MS} ms and sends nothing; lifting then is the right button, at the press point`, () => {
    down(1, 150, 220);
    clock.advance(LONG_PRESS_MS - 1);
    expect(marks()).toEqual(['land']);
    clock.advance(1);
    expect(input()).toEqual([]);
    expect(marks()).toEqual(['land', 'held']);
    clock.advance(800);
    move(1, 154, 223); // still within the slop
    up(1, 154, 223);
    expect(input()).toEqual([{ click: [150, 220, 3] }]);
  });

  it('dragging after it is a left-button drag: down at the press point, following the finger, up at the lift', () => {
    down(1, 150, 220);
    clock.advance(LONG_PRESS_MS);
    move(1, 170, 222);
    move(1, 220, 230);
    up(1, 230, 231);
    expect(input()).toEqual([{ press: [150, 220] }, { drag: [170, 222] }, { drag: [220, 230] }, { release: [230, 231] }]);
  });

  it('a press that moves first is a scroll, never a hold', () => {
    down(1, 150, 220);
    clock.advance(100);
    move(1, 150, 260);
    clock.advance(LONG_PRESS_MS);
    up(1, 150, 260);
    expect(marks()).not.toContain('held');
    expect(clicks()).toEqual([]);
  });

  it('a second finger during a hold or a drag sends nothing more, and a drag lets its button go first', () => {
    down(1, 150, 220);
    clock.advance(LONG_PRESS_MS);
    down(2, 250, 220);
    up(1, 150, 220);
    up(2, 250, 220);
    expect(input()).toEqual([]);
    clock.advance(500);
    down(1, 150, 220);
    clock.advance(LONG_PRESS_MS);
    move(1, 180, 220);
    down(2, 250, 220);
    expect(input()).toEqual([{ press: [150, 220] }, { drag: [180, 220] }, { release: [180, 220] }]);
  });

  it('a cancelled touch sends nothing, then or later; a cancelled drag lets its button go', () => {
    down(1, 150, 220);
    g.cancel({ id: 1, x: 150, y: 220, t: clock.now });
    clock.advance(LONG_PRESS_MS * 2);
    up(1, 150, 220);
    expect(input()).toEqual([]);
    down(1, 150, 220);
    clock.advance(LONG_PRESS_MS);
    move(1, 200, 220);
    g.cancel({ id: 1, x: 200, y: 220, t: clock.now });
    expect(input()).toEqual([{ press: [150, 220] }, { drag: [200, 220] }, { release: [200, 220] }]);
  });
});

describe('a double tap is a double click', () => {
  it("each tap clicks at the first tap's point, so the desk counts two or three; a fourth starts again", () => {
    tap(100, 150);
    clock.advance(150);
    tap(104, 152);
    clock.advance(150);
    tap(98, 149);
    clock.advance(150);
    tap(103, 151);
    expect(clicks()).toEqual([[100, 150, 1], [100, 150, 1], [100, 150, 1], [103, 151, 1]]);
    expect(zooms()).toEqual([]);
  });

  it('two taps far apart in time or place are two clicks, each where it landed', () => {
    tap(100, 150);
    clock.advance(400);
    tap(104, 150);
    clock.advance(100);
    tap(300, 150);
    expect(clicks()).toEqual([[100, 150, 1], [104, 150, 1], [300, 150, 1]]);
  });
});

describe('two fingers zoom and move the picture here, and send nothing', () => {
  it('a spread zooms about the fingers, and moving them pans; under the surface the picture keeps to its top', () => {
    down(1, 100, 200);
    down(2, 200, 200);
    move(1, 50, 200);
    move(2, 250, 200);
    // 2x about the midpoint across; at 438 tall it's still shorter than the 457 surface, so it stays at the top.
    expect(g.zoom).toEqual({ s: 2, x: -150, y: 0 });
    move(1, 80, 200);
    move(2, 280, 200);
    expect(g.zoom).toEqual({ s: 2, x: -120, y: 0 });
    up(1, 80, 200);
    up(2, 280, 200);
    clock.advance(LONG_PRESS_MS);
    expect(input()).toEqual([]);
  });

  it('past the surface it covers it, and the point under the fingers stays there as far as the edges allow', () => {
    down(1, 150, 250);
    down(2, 250, 250);
    move(1, 50, 250);
    move(2, 350, 250);
    // 3x about (200, 150) in the picture: 658 tall, so it may go up, never leaving a gap under it.
    expect(g.zoom).toEqual({ s: 3, x: -400, y: -201.125 });
  });

  it('never under fit or over the most, and a pinch that ends near fit snaps to it', () => {
    down(1, 100, 200);
    down(2, 200, 200);
    move(1, 140, 200);
    move(2, 160, 200);
    expect(g.zoom).toEqual(FIT);
    move(1, -1_000, 200);
    move(2, 1_000, 200);
    expect(g.zoom.s).toBe(4);
    move(1, 96, 200);
    move(2, 202, 200);
    expect(g.zoom.s).toBeCloseTo(1.06, 2);
    up(1, 96, 200);
    expect(g.zoom).toEqual(FIT);
  });

  it('a second finger ends a scroll or a press; the finger left after a pinch does nothing; a third changes nothing', () => {
    down(1, 100, 200);
    clock.advance(20);
    move(1, 100, 240);
    down(2, 200, 240);
    down(3, 300, 240);
    move(3, 300, 100);
    expect(zooms()).toEqual([]);
    up(3, 300, 100);
    up(2, 200, 240);
    move(1, 100, 100);
    clock.advance(LONG_PRESS_MS);
    up(1, 100, 100);
    expect(input()).toEqual([]);
  });
});

describe("the screen's edges are the phone's first", () => {
  it('a sideways drag from a side edge sends nothing: the phone\'s back gesture, or the carousel\'s swipe', () => {
    down(1, 8, 300);
    clock.advance(30);
    move(1, 60, 302);
    clock.advance(30);
    move(1, 160, 304);
    up(1, 160, 304);
    clock.tick();
    expect(input()).toEqual([]);
    down(1, W - 6, 300);
    move(1, W - 120, 300);
    up(1, W - 120, 300);
    expect(input()).toEqual([]);
  });

  it('a drag from a side edge that goes mostly up or down scrolls, as anywhere', () => {
    down(1, 8, 400);
    clock.advance(30);
    move(1, 10, 380);
    clock.advance(30);
    move(1, 12, 340);
    expect(scrolls()).toEqual([[12, 340, 0, 40]]);
  });

  it("a drag up from the bottom edge is the phone's home gesture", () => {
    down(1, 200, H - 6);
    clock.advance(30);
    move(1, 202, H - 40);
    clock.advance(30);
    move(1, 204, H - 120);
    up(1, 204, H - 120);
    expect(input()).toEqual([]);
  });

  it('a tap or a hold at an edge is still the page\'s', () => {
    tap(6, 200);
    clock.advance(500);
    down(1, W - 4, 210);
    clock.advance(LONG_PRESS_MS);
    up(1, W - 4, 210);
    expect(clicks()).toEqual([[6, 200, 1], [W - 4, 210, 3]]);
  });
});

describe("the phone view: a finger goes as it is (deskd's touch emulation makes it one)", () => {
  beforeEach(() => {
    direct = true;
  });

  it('a tap is the press and its release at the lift, where it landed: never WHEEL, never a held right button', () => {
    down(1, 120, 300);
    clock.advance(40);
    expect(input()).toEqual([]);
    up(1, 121, 301);
    clock.advance(LONG_PRESS_MS * 2);
    expect(input()).toEqual([{ press: [120, 300] }, { release: [120, 300] }]);
  });

  it(`a finger held ${DIRECT_HOLD_MS} ms presses then, so the page's own long press comes, and follows it to the lift`, () => {
    down(1, 120, 300);
    clock.advance(DIRECT_HOLD_MS - 1);
    expect(input()).toEqual([]);
    clock.advance(1);
    expect(input()).toEqual([{ press: [120, 300] }]);
    clock.advance(600);
    move(1, 120, 260);
    up(1, 120, 250);
    expect(input()).toEqual([{ press: [120, 300] }, { drag: [120, 260] }, { release: [120, 250] }]);
    expect(scrolls()).toEqual([]);
  });

  it('a drag that starts at once presses where it landed and follows: the page scrolls itself, with its own momentum', () => {
    down(1, 200, 400);
    clock.advance(16);
    move(1, 200, 390);
    clock.advance(16);
    move(1, 200, 360);
    up(1, 200, 340);
    clock.tick();
    expect(input()).toEqual([{ press: [200, 400] }, { drag: [200, 390] }, { drag: [200, 360] }, { release: [200, 340] }]);
  });

  it('a second finger in the first one\'s wait is a pinch, with nothing sent; after it, the press lets go first', () => {
    down(1, 100, 300);
    clock.advance(50);
    down(2, 200, 300);
    move(2, 260, 300);
    up(2, 260, 300);
    up(1, 100, 300);
    expect(input()).toEqual([]);
    expect(g.zoom.s).toBeGreaterThan(1);
    clock.advance(500);
    down(1, 100, 300);
    clock.advance(DIRECT_HOLD_MS);
    down(2, 200, 300);
    expect(input()).toEqual([{ press: [100, 300] }, { release: [100, 300] }]);
  });

  it("a sideways drag from a side edge is still the phone's or the carousel's; up from there, the page's", () => {
    down(1, 6, 300);
    clock.advance(DIRECT_HOLD_MS * 3); // at an edge it waits for the finger to say
    expect(input()).toEqual([]);
    move(1, 60, 302);
    up(1, 120, 302);
    expect(input()).toEqual([]);
    down(1, 6, 400);
    move(1, 7, 360);
    up(1, 7, 340);
    expect(input()).toEqual([{ press: [6, 400] }, { drag: [7, 360] }, { release: [7, 340] }]);
  });

  it('the zoom keeps to the region the phone view fills', () => {
    // The element is the whole desk's screen, scaled; only its top left (the region) is the phone's page, filling the box.
    const f: Frame = { el: { left: 0, top: 100, width: 1512, height: 850 }, area: { left: 0, top: 100, width: 390, height: 457 }, pic: { left: 0, top: 100, width: 390, height: 457 } };
    expect(clampZoom({ s: 2, x: -2000, y: -2000 }, f, 3)).toEqual({ s: 2, x: -390, y: -457 });
    expect(clampZoom({ s: 2, x: 50, y: 50 }, f, 3)).toEqual({ s: 2, x: 0, y: 0 });
    expect(shownMiddle({ s: 2, x: -195, y: -228.5 }, f)).toEqual({ x: 195, y: 228.5 });
  });
});

describe('the zoom, in numbers', () => {
  const VW = 1280;
  const VH = 720;

  it('at fit, a point maps as a click does without touch (`contentBox`, `normalized`)', () => {
    const pic = contentBox(EL, VW, VH);
    const at = { x: 97.5, y: 160 };
    expect(deskPoint(at, EL, FIT, VW, VH)).toEqual({ x: normalized(at.x, pic.left, pic.width), y: normalized(at.y, pic.top, pic.height) });
  });

  it('zoomed 2x about the middle, the box shows the middle half: its corner is the quarter mark, its middle the middle', () => {
    const z = { s: 2, x: -195, y: -109.6875 };
    expect(deskPoint({ x: 0, y: 100 }, EL, z, VW, VH)).toEqual({ x: 16384, y: 16384 });
    expect(deskPoint({ x: 195, y: 100 + 109.6875 }, EL, z, VW, VH)).toEqual({ x: 32768, y: 32768 });
    expect(deskPoint({ x: 390, y: 319.375 }, EL, z, VW, VH)).toEqual({ x: 49151, y: 49151 });
  });

  it('through the letterbox too: a 1280 x 800 desk in a 16:9 box has bars at the sides', () => {
    const pic = contentBox({ left: 0, top: 0, width: EL.width, height: EL.height }, 1280, 800);
    expect(pic.left).toBeGreaterThan(10);
    expect(deskPoint({ x: pic.left, y: 100 }, EL, FIT, 1280, 800).x).toBe(0);
    expect(deskPoint({ x: 2, y: 100 }, EL, FIT, 1280, 800).x).toBe(0); // on a bar: the picture's edge
    expect(deskPoint({ x: pic.left * 2, y: 100 }, EL, { s: 2, x: 0, y: 0 }, 1280, 800).x).toBe(0);
  });

  it('a tap through a zoom lands on the desk pixel that shows under it', () => {
    const z = zoomAbout(FIT, { x: 100, y: 50 }, 2, FRAME, 4);
    expect(z).toEqual({ s: 2, x: -100, y: 0 });
    // 2x keeps to the top here, so the point under (100, 100) is the fit picture's (100, 100) halved from the top left.
    expect(deskPoint({ x: 100, y: 100 }, EL, z, VW, VH)).toEqual(deskPoint({ x: 100, y: 100 }, EL, FIT, VW, VH));
    expect(deskPoint({ x: 140, y: 150 }, EL, z, VW, VH)).toEqual(deskPoint({ x: 120, y: 125 }, EL, FIT, VW, VH));
  });

  it('`unzoomed` undoes what `getBoundingClientRect` gives for a zoomed element', () => {
    const z = { s: 2.5, x: -80, y: -40 };
    const seen = { left: EL.left + z.x, top: EL.top + z.y, width: EL.width * z.s, height: EL.height * z.s };
    expect(unzoomed(seen, z)).toEqual(EL);
    expect(unzoomed(EL, FIT)).toEqual(EL);
  });

  it('a drag moves the page as far as the finger went: desk pixels per screen pixel', () => {
    expect(deskPixelsPerScreenPixel(EL, FIT, VW, VH)).toBeCloseTo(1280 / 390, 6);
    expect(deskPixelsPerScreenPixel(EL, { s: 2, x: 0, y: 0 }, VW, VH)).toBeCloseTo(640 / 390, 6);
    expect(deskPixelsPerScreenPixel(EL, FIT, 0, 0)).toBe(1); // no picture yet
  });

  it('zooms to 4x, or far enough for desk text to reach 1.25 phone px per desk px', () => {
    expect(zoomLimit(EL, 1280, 720)).toBeCloseTo((1.25 * 1280) / 390, 6);
    expect(zoomLimit(EL, 1920, 1080)).toBeCloseTo((1.25 * 1920) / 390, 6);
    expect(zoomLimit(EL, 640, 360)).toBe(4);
    expect(zoomLimit(EL, 0, 0)).toBe(4);
  });

  it('clamps: fit is exactly as laid out; zoomed, it covers the surface, or keeps to its top and centred across', () => {
    expect(clampZoom({ s: 0.5, x: 30, y: 30 }, FRAME, 4)).toEqual(FIT);
    expect(clampZoom({ s: 1, x: -30, y: 30 }, FRAME, 4)).toEqual(FIT);
    expect(clampZoom({ s: 9, x: 0, y: 0 }, FRAME, 4).s).toBe(4);
    expect(clampZoom({ s: 2, x: 50, y: -500 }, FRAME, 4)).toEqual({ s: 2, x: 0, y: 0 });
    expect(clampZoom({ s: 3, x: -900, y: -500 }, FRAME, 4)).toEqual({ s: 3, x: -780, y: -201.125 });
    // A picture narrower than its surface (a phone on its side) centres across until it's wider.
    const wide: Frame = { el: { left: 300, top: 0, width: 244, height: 137.25 }, area: { left: 0, top: 0, width: 844, height: 390 } };
    expect(clampZoom({ s: 2, x: 0, y: 0 }, wide, 4)).toEqual({ s: 2, x: (844 - 488) / 2 - 300, y: 0 });
    expect(clampZoom({ s: 4, x: 0, y: 0 }, wide, 4)).toEqual({ s: 4, x: -300 - 0, y: 0 });
  });

  it('the page row zooms about the middle of what shows', () => {
    expect(shownMiddle(FIT, FRAME)).toEqual({ x: 195, y: 109.6875 });
    expect(shownMiddle({ s: 3, x: -390, y: -201.125 }, FRAME)).toEqual({ x: 195, y: 228.5 });
  });

  it('a pinch keeps the picture under the fingers as they move', () => {
    const start = { zoom: { s: 3, x: -100, y: -50 }, mid: { x: 150, y: 100 }, dist: 100 };
    expect(pinchZoom(start, { x: 170, y: 100 }, 100, FRAME, 4)).toEqual({ s: 3, x: -80, y: -50 });
    const z = pinchZoom(start, { x: 150, y: 100 }, 400 / 3, FRAME, 4);
    expect(z.s).toBe(4);
    expect(z.x).toBeCloseTo(150 - (250 / 3) * 4, 9);
    expect(z.y).toBe(-100);
  });

  it('the transform', () => {
    expect(zoomTransform(FIT)).toBe('');
    expect(zoomTransform({ s: 2, x: -195, y: -109.6875 })).toBe('translate(-195px, -109.6875px) scale(2)');
  });
});

describe('the hint, once per member per browser', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is due until shown, for each member apart', () => {
    expect(touchHintDue('u-1')).toBe(true);
    touchHintShown('u-1');
    expect(touchHintDue('u-1')).toBe(false);
    expect(touchHintDue('u-2')).toBe(true);
    touchHintShown('u-2');
    touchHintShown('u-1');
    expect(JSON.parse(store.get('ma.browser.touchHint.v1')!)).toEqual(['u-2', 'u-1']);
  });

  it('keeps the last 20 members only, and reads anything else as nobody', () => {
    for (let i = 0; i < 25; i += 1) touchHintShown(`u-${i}`);
    expect(JSON.parse(store.get('ma.browser.touchHint.v1')!)).toHaveLength(20);
    expect(touchHintDue('u-0')).toBe(true);
    store.set('ma.browser.touchHint.v1', '{"u-24":true}');
    expect(touchHintDue('u-24')).toBe(true);
  });

  it('with storage refused, it is due, and showing it throws nothing', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(touchHintDue('u-1')).toBe(true);
    expect(() => touchHintShown('u-1')).not.toThrow();
  });
});
