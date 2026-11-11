// The desk's phone view, as the Browser window reads it (deskd API.md section 10, "On a phone").
import { describe, expect, it } from 'vitest';
import { normalized } from '../desk/rtc/input';
import { phoneDevice, readView, regionFrame } from './phoneView';
import { deskPoint, FIT } from './touchInput';

const VIEW = { mode: 'phone' as const, sessionId: 'cs-1', width: 390, height: 844, scale: 1.27, region: { x: 0, y: 0, width: 495, height: 1072 }, screen: { width: 1920, height: 1080 }, field: null };

describe('the phone view', () => {
  it("the device is the box in whole CSS pixels, from 160 to 2048, or nothing for a box too small", () => {
    expect(phoneDevice({ width: 390.4, height: 536.6 })).toEqual({ kind: 'phone', width: 390, height: 537 });
    expect(phoneDevice({ width: 3000, height: 400 })).toEqual({ kind: 'phone', width: 2048, height: 400 });
    expect(phoneDevice({ width: 390, height: 100 })).toBeNull();
  });

  it('is ours by its session, or, with no session named, if we asked; another phone is said so', () => {
    expect(readView(VIEW, 'cs-1', true)).toMatchObject({ served: true, mine: true, other: false, region: VIEW.region });
    expect(readView(VIEW, 'cs-2', true)).toMatchObject({ mine: false, other: true, region: null, field: null });
    expect(readView({ ...VIEW, sessionId: undefined }, null, true).mine).toBe(true);
    expect(readView({ ...VIEW, sessionId: undefined }, null, false).other).toBe(true);
    expect(readView({ mode: 'desktop', field: null }, 'cs-1', true)).toMatchObject({ served: true, mine: false, other: false });
    expect(readView({ ...VIEW, region: { x: 0, y: 0, width: 0, height: 0 } }, 'cs-1', true).mine).toBe(false);
  });

  it("shows only the region, filling the box, and a tap at a place in the box lands there in the region, normalized to the whole picture", () => {
    const box = { width: 390, height: 844 };
    const f = regionFrame(VIEW.region, VIEW.screen, box);
    expect(f.left).toBe(-0);
    expect(f.top).toBe(-0);
    const k = Math.min(390 / 495, 844 / 1072);
    expect(f.width).toBeCloseTo(1920 * k, 6);
    // deskd's formula: x = round(65535 * (region.x + fx * region.width) / screen.width), for fx across the box.
    const base = { left: f.left, top: f.top, width: f.width, height: f.height };
    for (const fx of [0, 0.25, 0.5, 1]) {
      const at = deskPoint({ x: fx * 495 * k, y: 0.5 * 1072 * k }, base, FIT, 1920, 1080);
      expect(Math.abs(at.x - normalized(fx * 495, 0, 1920))).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - normalized(0.5 * 1072, 0, 1080))).toBeLessThanOrEqual(1);
    }
  });

  it('a region away from the corner is offset into place', () => {
    const f = regionFrame({ x: 100, y: 50, width: 400, height: 800 }, { width: 1920, height: 1080 }, { width: 400, height: 800 });
    expect(f).toEqual({ left: -100, top: -50, width: 1920, height: 1080 });
  });
});
