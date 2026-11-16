// The office tour's steps (ADR 0056): Next, Back, the end, a step whose target isn't there passed over and left out of the
// count, phone variants and conditions, where the card goes (the Product Designer's section 2), and Sales' words exactly.
import { describe, expect, it } from 'vitest';
import { arrival, back, cssRadius, first, grow, holeRadius, next, onScreenShare, phoneDock, placeCard, position, stepsFor, union, type Present, type TourStep } from './engine';
import { STEPS, WORDS } from './steps';

const step = (id: string, extra: Partial<TourStep> = {}): TourStep => ({ id, anchor: `#${id}`, title: id, body: id, ...extra });
const FOUR = [step('a', { anchor: null }), step('b'), step('c'), step('d')];
const all: Present = () => true;
const without = (...gone: string[]): Present => (s) => !gone.includes(s.id);
const VIEW = { w: 1280, h: 800 };
const CARD = { w: 320, h: 150 };

describe('moving through the steps', () => {
  it('Next goes one at a time to the end, where it says done (-1)', () => {
    expect(first(FOUR, all)).toBe(0);
    expect(next(FOUR, 0, all)).toBe(1);
    expect(next(FOUR, 2, all)).toBe(3);
    expect(next(FOUR, 3, all)).toBe(-1);
  });
  it('Back goes one at a time, and stays put at the first step', () => {
    expect(back(FOUR, 3, all)).toBe(2);
    expect(back(FOUR, 0, all)).toBe(0);
  });
  it('a step whose target is missing is passed over both ways, and left out of the count', () => {
    const p = without('b');
    expect(next(FOUR, 0, p)).toBe(2);
    expect(back(FOUR, 2, p)).toBe(0);
    expect(position(FOUR, 0, p)).toEqual({ n: 1, total: 3 });
    expect(position(FOUR, 2, p)).toEqual({ n: 2, total: 3 });
    expect(position(FOUR, 3, p)).toEqual({ n: 3, total: 3 });
  });
  it('the last step that is there is the end, even with steps after it that are not', () => {
    expect(next(FOUR, 2, without('d'))).toBe(-1);
    expect(position(FOUR, 2, without('d'))).toEqual({ n: 3, total: 3 });
  });
  it('a step showing whose target has just gone still counts itself, so the count never reads "3 of 2"', () => {
    expect(position(FOUR, 1, without('b'))).toEqual({ n: 2, total: 4 });
  });
  it('nothing there at all: no first step', () => {
    expect(first(FOUR, () => false)).toBe(-1);
  });
});

describe('stepsFor', () => {
  const holds = (c: string): boolean => c === 'oneDesk';
  it('keeps a step only where its condition holds', () => {
    const ids = stepsFor(STEPS, { phone: false, holds }).map((s) => s.id);
    expect(ids).toEqual(['intro', 'desk', 'guild', 'scope', 'app', 'move', 'maia', 'setup', 'shield', 'bell', 'account', 'help']);
    expect(stepsFor(STEPS, { phone: false, holds: (c) => c === 'personalAndWork' }).map((s) => s.id)).toEqual(['intro', 'desks', 'guild', 'scope', 'app', 'move', 'maia', 'setup', 'shield', 'bell', 'account', 'help']);
  });
  it('a phone takes a step\'s own variant, leaves out one marked false, and keeps the rest as they are', () => {
    const list = [step('a'), step('b', { phone: false }), step('c', { phone: { anchor: '#c-phone', placement: 'above' } })];
    expect(stepsFor(list, { phone: true, holds }).map((s) => [s.id, s.anchor, s.placement])).toEqual([
      ['a', '#a', undefined],
      ['c', '#c-phone', 'above'],
    ]);
    expect(stepsFor(list, { phone: false, holds }).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
  it('the steps are the same on a phone (no phone variants; a target a phone lacks is left out live)', () => {
    expect(stepsFor(STEPS, { phone: true, holds }).map((s) => s.id)).toEqual(stepsFor(STEPS, { phone: false, holds }).map((s) => s.id));
  });
});

describe('the steps and words (the owner, Nov 13: the whole office, not four things)', () => {
  it('every step, in order, with its title, and a body that says what the thing is for', () => {
    expect(STEPS.map((s) => [s.id, s.title])).toEqual([
      ['intro', 'Welcome to your office'],
      ['desk', 'Your desk'],
      ['desks', 'Your desks'],
      ['guild', "Your guild's desk"],
      ['scope', 'Switch desks'],
      ['app', 'Apps'],
      ['move', 'Move around'],
      ['maia', 'Ask Maia'],
      ['setup', 'Finish setting up'],
      ['shield', 'Privacy shield'],
      ['bell', 'Notifications'],
      ['account', 'Your account'],
      ['help', 'The rest of the Alliance'],
    ]);
    const body = Object.fromEntries(STEPS.map((s) => [s.id, s.body]));
    // A desk and an app are explained, not just pointed at; the old "Open it from any browser" is gone.
    expect(body['desk']).toMatch(/^A desk is a desktop in the cloud/);
    expect(body['desks']).toMatch(/desktop in the cloud/);
    expect(body['app']).toMatch(/^Apps are the tools on your desk/);
    expect(STEPS.map((s) => s.body).join(' ')).not.toMatch(/Open it from any browser/);
    // The tour's only way back in is the logo's menu.
    expect(body['help']).toMatch(/logo/);
  });
  it('each target, and the corners: measured from the target unless a step says otherwise', () => {
    const by = Object.fromEntries(STEPS.map((s) => [s.id, [s.anchor, s.pad, s.radius]]));
    expect(by).toEqual({
      intro: [null, undefined, undefined],
      desk: ['@desks', 10, undefined],
      desks: ['@desks', 10, undefined],
      guild: ['@guild', 10, undefined],
      scope: ['.topbar .segmented.scope:not(.scope-ghost)', 4, undefined],
      app: ['@app', 8, undefined],
      move: ['.bottombar .zoom-ctl', 4, undefined],
      maia: ['.maia-launcher', 6, 'circle'],
      setup: ['.setup-circle .su-btn', 4, undefined],
      shield: ['.topbar button[aria-label="Privacy shield"]', 4, undefined],
      bell: ['.topbar [data-testid="bell"]', 4, undefined],
      account: ['.topbar .account-btn', 4, undefined],
      help: ['.home-mark-btn[aria-controls="mark-menu"]', 4, undefined],
    });
  });
  it('the labels, and the note naming the logo\'s menu, the only place the tour lives', () => {
    expect([WORDS.next, WORDS.back, WORDS.done, WORDS.skip, WORDS.off, WORDS.close, WORDS.count(2, 5)]).toEqual(['Next', 'Back', 'Done', 'Skip', "Don't show this again", 'Close the tour', '2 of 5']);
    expect(WORDS.offNote).toBe("Turned off. You can take the tour again from the logo's menu, top left.");
  });
  it('no exclamation marks, no "click" or "tap" alone, never a computer or machine (Sales\' voice)', () => {
    for (const s of [...STEPS.flatMap((x) => [x.title, x.body]), WORDS.offNote]) {
      expect(s).not.toMatch(/!|\bclick\b|\btap\b|\bcomputer\b|\bmachine\b/i);
    }
  });
});

describe('the hole\'s corners follow the target\'s', () => {
  it('the target\'s radius grown by the pad, so the edges run parallel', () => {
    // A desk at 100 % (22) with a 10 px pad: 32.
    expect(holeRadius(22, 10, { w: 600, h: 260 })).toBe(32);
    // A square corner still gets the pad's curve.
    expect(holeRadius(0, 4, { w: 100, h: 40 })).toBe(4);
  });
  it('never more than half the short side: a pill stays a pill; circle is exactly that', () => {
    expect(holeRadius(999, 4, { w: 120, h: 40 })).toBe(20);
    expect(holeRadius(0, 6, { w: 56, h: 56 }, 'circle')).toBe(28);
  });
  it('a number on the step overrides the measure', () => {
    expect(holeRadius(22, 10, { w: 600, h: 260 }, 12)).toBe(12);
  });
  it('reads CSS radii: px, scaled px, %, elliptical, and nothing', () => {
    const box = { w: 40, h: 40 };
    expect(cssRadius('10px', box)).toBe(10);
    expect(cssRadius('18px', { w: 200, h: 200 }, 0.5)).toBe(9);
    expect(cssRadius('50%', box)).toBe(20);
    expect(cssRadius('999px', box)).toBe(20);
    expect(cssRadius('12px 8px', box)).toBe(12);
    expect(cssRadius('0px', box)).toBe(0);
    expect(cssRadius('', box)).toBe(0);
  });
});

describe('geometry', () => {
  it('grow and union', () => {
    expect(grow({ x: 10, y: 20, w: 30, h: 40 }, 8)).toEqual({ x: 2, y: 12, w: 46, h: 56 });
    expect(union([{ x: 10, y: 10, w: 10, h: 10 }, { x: 40, y: 0, w: 10, h: 50 }])).toEqual({ x: 10, y: 0, w: 40, h: 50 });
  });
  it('how much is on screen: 60 % is the line', () => {
    expect(onScreenShare({ x: 0, y: 0, w: 100, h: 100 }, VIEW)).toBe(1);
    expect(onScreenShare({ x: -50, y: 0, w: 100, h: 100 }, VIEW)).toBe(0.5);
    expect(onScreenShare({ x: 1240, y: 0, w: 100, h: 100 }, VIEW)).toBeCloseTo(0.4);
    expect(onScreenShare({ x: 0, y: 0, w: 0, h: 10 }, VIEW)).toBe(0);
  });
});

describe('where the card goes', () => {
  it('the intro: centred, no caret', () => {
    expect(placeCard(null, { w: 360, h: 150 }, VIEW)).toEqual({ x: 460, y: 325, side: null, caret: null });
  });
  it('below first, 14 px off the hole, the caret at the target\'s centre', () => {
    const p = placeCard({ x: 600, y: 100, w: 80, h: 80 }, CARD, VIEW);
    expect(p.side).toBe('below');
    expect(p.y).toBe(194);
    expect(p.x).toBe(480);
    expect(p.caret).toBe(153); // 640 - 480 - 7
  });
  it('kept 16 px from the window\'s edges, with the caret clamped 18 px from the card\'s corners', () => {
    const p = placeCard({ x: 0, y: 100, w: 40, h: 40 }, CARD, VIEW);
    expect(p.x).toBe(16);
    expect(p.caret).toBe(18);
    const q = placeCard({ x: 1250, y: 100, w: 30, h: 30 }, CARD, VIEW);
    expect(q.x).toBe(1280 - 16 - 320);
    expect(q.caret).toBe(320 - 18 - 14);
  });
  it('above when below has no room (Maia\'s round button at the bottom right), then right, then left', () => {
    expect(placeCard({ x: 1200, y: 720, w: 60, h: 60 }, CARD, VIEW).side).toBe('above');
    const tall = { x: 100, y: 20, w: 200, h: 760 };
    expect(placeCard(tall, CARD, VIEW).side).toBe('right');
    expect(placeCard({ ...tall, x: 900, w: 360 }, CARD, VIEW).side).toBe('left');
  });
  it('a side asked for first is taken when it has room', () => {
    expect(placeCard({ x: 600, y: 300, w: 80, h: 80 }, CARD, VIEW, 'above').side).toBe('above');
  });
  it('no side with room (one desk filling the screen): inside the hole at its lower right, 24 px in, with no caret', () => {
    expect(placeCard({ x: 10, y: 10, w: 1260, h: 780 }, CARD, VIEW)).toEqual({ x: 1264 - 320 - 24, y: 784 - 150 - 24, side: null, caret: null });
  });
  it('a phone: the bottom, or the top when the hole\'s bottom comes within 24 px of the card (Maia\'s step)', () => {
    const phone = { w: 390, h: 844 };
    expect(phoneDock(null, 200, phone)).toBe('bottom');
    expect(phoneDock({ x: 20, y: 100, w: 350, h: 300 }, 200, phone)).toBe('bottom');
    expect(phoneDock({ x: 320, y: 760, w: 56, h: 56 }, 200, phone)).toBe('top');
  });
  it('the card comes 6 px toward its target; with no caret, it rises', () => {
    expect(arrival('below')).toEqual({ dx: 0, dy: 6 });
    expect(arrival('above')).toEqual({ dx: 0, dy: -6 });
    expect(arrival('right')).toEqual({ dx: 6, dy: 0 });
    expect(arrival('left')).toEqual({ dx: -6, dy: 0 });
    expect(arrival(null)).toEqual({ dx: 0, dy: 6 });
  });
});
