import { describe, expect, it } from 'vitest';
import { carouselStage, G, type LayoutDesk, type LayoutItem } from '../canvas/layout';
import {
  carouselApps, carouselOn, EDGE_PX, fromScreenEdge, keepsArrows, positionOf, positionWords, shownApp, stageIsLive, stageOnScreen, STAGE_LIVE_MIN_W, stepApp, SWIPE_PX, toggled, touchSwipe,
  WHEEL_QUIET_MS, WHEEL_SWIPE_PX, WheelSwipe,
} from './model';

const item = (app: LayoutItem['app'], x: number, y = 24): LayoutItem => ({ id: `d1:${app}`, app, x, y, w: 76, h: 76 });
// Placed out of list order on purpose: the carousel goes by where they are, as the keyboard does.
const DESK: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 584, h: 236, items: [item('agent', 316), item('chat', 24), item('browser', 224), item('notebook', 124)] };
const on = (app: LayoutItem['app'], d: LayoutDesk = DESK): LayoutDesk => ({ ...d, carousel: { on: true, app } });

describe('which apps, and which shows', () => {
  it('goes through the desk\'s own apps in reading order, each once', () => {
    expect(carouselApps(DESK)).toEqual(['chat', 'notebook', 'browser', 'agent']);
    expect(carouselApps({ items: [...DESK.items, { ...item('chat', 400), id: 'other' }] })).toEqual(['chat', 'notebook', 'browser', 'agent']);
    expect(carouselApps({ items: [item('agent:research', 24), item('files', 124)] })).toEqual(['agent:research', 'files']);
  });

  it('absent is off, and only `on: true` is on', () => {
    expect(carouselOn(DESK)).toBe(false);
    expect(carouselOn(undefined)).toBe(false);
    expect(carouselOn({ carousel: { on: false, app: 'chat' } })).toBe(false);
    expect(carouselOn(on('chat'))).toBe(true);
  });

  it('shows the app it showed last, or the first when that app has gone from the desk', () => {
    expect(shownApp(on('browser'))).toBe('browser');
    expect(shownApp(DESK)).toBe('chat');
    expect(shownApp(on('files'))).toBe('chat');
    expect(shownApp({ items: [] })).toBe(null);
  });

  it('says where it is, as "2 of 4"', () => {
    expect(positionOf(on('notebook'))).toEqual({ index: 1, count: 4 });
    expect(positionWords(1, 4)).toBe('2 of 4');
  });

  it('steps one app at a time and stops at the ends, with no wrap', () => {
    expect(stepApp(on('notebook'), 1)).toBe('browser');
    expect(stepApp(on('notebook'), -1)).toBe('chat');
    expect(stepApp(on('chat'), -1)).toBe(null);
    expect(stepApp(on('agent'), 1)).toBe(null);
  });

  it('the switch turns it on at the app asked for, or the last one shown, and off keeping that one', () => {
    expect(toggled(DESK, null)).toEqual({ on: true, app: 'chat' });
    expect(toggled(DESK, 'browser')).toEqual({ on: true, app: 'browser' });
    expect(toggled({ ...DESK, carousel: { on: false, app: 'agent' } }, null)).toEqual({ on: true, app: 'agent' });
    expect(toggled(on('browser'), null)).toEqual({ on: false, app: 'browser' });
    expect(toggled({ items: [] }, null)).toBe(null);
  });
});

describe('the stage on screen', () => {
  it('at 1x and under, is the canvas\'s card: the panel above the strip, 12 in from the top and sides', () => {
    const st = carouselStage(584, 236);
    expect(st).toEqual({ x: 12, y: 12, w: 560, h: 236 - 12 - G.strip });
    for (const s of [0.4, 0.8, 1]) {
      const box = stageOnScreen({ x: 100, y: 50, w: 584, h: 236 }, { x: 7, y: 9, s });
      expect(box.left).toBeCloseTo((100 + st.x) * s + 7);
      expect(box.top).toBeCloseTo((50 + st.y) * s + 9);
      expect(box.width).toBeCloseTo(st.w * s);
      expect(box.height).toBeCloseTo(st.h * s);
    }
  });

  it('past 1x, leaves the strip the etched row\'s 44 units, times the zoom, and keeps its corners inside the panel\'s', () => {
    for (const s of [1.5, 2.3, 3]) {
      const box = stageOnScreen({ x: 0, y: 0, w: 584, h: 236 }, { x: 0, y: 0, s });
      expect(236 * s - (box.top + box.height)).toBeCloseTo(44 * s);
      // The stage's 16 px corner sits inside the panel's round corner on screen.
      const r = G.panelRadius * s;
      const c = box.left + 16;
      expect(Math.SQRT2 * (r - c)).toBeLessThanOrEqual(r - 16 + 1e-9);
    }
  });

  it('holds the live app only from 480 x 240 on screen', () => {
    expect(STAGE_LIVE_MIN_W).toBe(480);
    expect(stageIsLive(480, 240)).toBe(true);
    expect(stageIsLive(479, 600)).toBe(false);
    expect(stageIsLive(900, 239)).toBe(false);
  });
});

describe('swipes', () => {
  const at = (t: number, deltaX: number, deltaY = 0, ctrlKey = false) => ({ deltaX, deltaY, ctrlKey, timeStamp: t });

  it('a trackpad\'s sideways gesture is one step, its momentum included', () => {
    const w = new WheelSwipe();
    expect(w.feed(at(0, 20))).toBe('held');
    expect(w.feed(at(16, 20))).toBe('held');
    expect(w.feed(at(32, 20))).toBe('next'); // 60 past 48
    for (let t = 48; t < 900; t += 16) expect(w.feed(at(t, 30))).toBe('held'); // the momentum is still this gesture
    expect(w.feed(at(900 + WHEEL_QUIET_MS + 1, -WHEEL_SWIPE_PX))).toBe('prev'); // a new one, the other way
  });

  it('up and down is the app\'s, and so is a pinch', () => {
    const w = new WheelSwipe();
    expect(w.feed(at(0, 4, 40))).toBe('none');
    expect(w.feed(at(16, 30, 30))).toBe('none');
    expect(w.feed(at(32, 200, 0, true))).toBe('none');
  });

  it('lines count as 16 px', () => {
    const w = new WheelSwipe();
    expect(w.feed({ deltaX: 3, deltaY: 0, deltaMode: 1, timeStamp: 0 })).toBe('next');
  });

  it('a finger: far enough and sideways enough, and left is the next app', () => {
    expect(touchSwipe(-SWIPE_PX, 0)).toBe(1);
    expect(touchSwipe(SWIPE_PX, 10)).toBe(-1);
    expect(touchSwipe(-SWIPE_PX + 1, 0)).toBe(0);
    expect(touchSwipe(-80, 60)).toBe(0); // more a scroll than a swipe
  });

  it("the screen's edge: within 16 px of the left or right, the carousel's swipe even over the Browser's picture", () => {
    expect(EDGE_PX).toBe(16);
    expect(fromScreenEdge(0, 390)).toBe(true);
    expect(fromScreenEdge(16, 390)).toBe(true);
    expect(fromScreenEdge(17, 390)).toBe(false);
    expect(fromScreenEdge(195, 390)).toBe(false);
    expect(fromScreenEdge(373, 390)).toBe(false);
    expect(fromScreenEdge(374, 390)).toBe(true);
    expect(fromScreenEdge(389, 390)).toBe(true);
  });

  it('arrows stay with fields and with widgets that move by arrows', () => {
    const el = (match: string | null, editable = false) => ({ closest: (q: string) => (match && q.includes(match) ? {} : null), isContentEditable: editable }) as unknown as Element;
    expect(keepsArrows(el('input'))).toBe(true);
    expect(keepsArrows(el('[role="tablist"]'))).toBe(true);
    expect(keepsArrows(el(null, true))).toBe(true);
    expect(keepsArrows(el(null))).toBe(false);
    expect(keepsArrows(null)).toBe(false);
  });
});
