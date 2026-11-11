// Where a menu goes (src/ui/menu/placement.ts). On a phone it never covers what it acts on.
import { describe, expect, it } from 'vitest';
import { COMPACT_WIDTH, EDGE, overlaps, placeCompact, placeMenu, placeSubmenu, pointRect, type Rect } from '../../src/ui/menu/placement.ts';

const view = { w: 1280, h: 800 };
const box = (p: { left: number; top: number; maxHeight?: number; width?: number }, w: number, h: number): Rect => ({
  left: p.left,
  top: p.top,
  right: p.left + (p.width ?? w),
  bottom: p.top + Math.min(h, p.maxHeight ?? h),
});

describe('desktop', () => {
  it('opens at the pointer', () => {
    expect(placeMenu(pointRect(300, 200), { w: 220, h: 300 }, view)).toEqual({ left: 300, top: 200 });
  });

  it('flips left and up at the edges, staying on screen', () => {
    const p = placeMenu(pointRect(1200, 700), { w: 220, h: 300 }, view);
    expect(p).toEqual({ left: 980, top: 400 });
  });

  it('opens under an element from the keyboard, or above it at the bottom', () => {
    expect(placeMenu({ left: 20, top: 100, right: 260, bottom: 140 }, { w: 220, h: 300 }, view)).toEqual({ left: 20, top: 144 });
    expect(placeMenu({ left: 20, top: 600, right: 260, bottom: 640 }, { w: 220, h: 300 }, view)).toEqual({ left: 20, top: 296 });
  });

  it('scrolls when taller than the screen', () => {
    const p = placeMenu(pointRect(10, 10), { w: 200, h: 2000 }, view);
    expect(p.maxHeight).toBe(view.h - 2 * EDGE);
    expect(p.top).toBe(EDGE);
  });

  it('a submenu opens to the right, or to the left with no room, level with its item', () => {
    const menu = { left: 300, top: 100, right: 520, bottom: 400 };
    const item = { left: 300, top: 160, right: 520, bottom: 192 };
    expect(placeSubmenu(item, menu, { w: 180, h: 200 }, view)).toEqual({ left: 516, top: 154 });
    const right = { left: 1100, top: 100, right: 1270, bottom: 400 };
    expect(placeSubmenu({ ...item, left: 1100, right: 1270 }, right, { w: 180, h: 200 }, view).left).toBe(924);
  });
});

describe('phone: never over the selection', () => {
  const phone = { w: 390, h: 844 };

  it('goes below a selection near the top', () => {
    const sel = { left: 40, top: 120, right: 200, bottom: 142 };
    const p = placeCompact(sel, 300, phone);
    expect(p.top).toBeGreaterThanOrEqual(sel.bottom);
    expect(p.width).toBe(Math.min(COMPACT_WIDTH, phone.w - 2 * EDGE));
    expect(overlaps(box(p, 0, 300), sel)).toBe(false);
  });

  it('goes above a selection near the bottom', () => {
    const sel = { left: 40, top: 700, right: 200, bottom: 722 };
    const p = placeCompact(sel, 300, phone);
    expect(p.top + 300).toBeLessThanOrEqual(sel.top);
  });

  it('shortens and scrolls rather than cover it when neither side has room', () => {
    const sel = { left: 0, top: 300, right: 390, bottom: 500 };
    const p = placeCompact(sel, 500, phone);
    expect(p.maxHeight).toBeDefined();
    expect(overlaps(box(p, 0, 500), sel)).toBe(false);
  });

  it('holds for any selection and any menu height', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let n = 0; n < 2000; n += 1) {
      const w = 320 + Math.floor(rnd() * 400);
      const h = 480 + Math.floor(rnd() * 500);
      const top = Math.floor(rnd() * h);
      const bottom = Math.min(h, top + 1 + Math.floor(rnd() * h * 0.9));
      const left = Math.floor(rnd() * w);
      const sel = { left, top, right: Math.min(w, left + 1 + Math.floor(rnd() * w)), bottom };
      const height = 40 + Math.floor(rnd() * 600);
      const p = placeCompact(sel, height, { w, h });
      const b = box(p, 0, height);
      expect(overlaps(b, sel), JSON.stringify({ w, h, sel, height, p })).toBe(false);
      expect(b.left).toBeGreaterThanOrEqual(EDGE);
      expect(b.right).toBeLessThanOrEqual(w - EDGE);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.bottom).toBeLessThanOrEqual(h);
    }
  });
});
