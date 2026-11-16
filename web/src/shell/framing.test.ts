import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asIntroduced, DEFAULT_DESK, defaultDesk, OLD_DEFAULT_DESK, type LayoutDesk } from '../canvas/layout';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView, setView } from '../state/viewStore';
import { setDeviceOwner } from '../state/deviceOwner';

// Which framing the office asks the camera for (ADR 0057): a desk still as introduced is framed by the owner's rule
// (`framed`); a desk the member resized fills the screen as it always has (`desk`); the overview comes no closer than the
// rule while a desk as introduced is in it.
const cam = vi.hoisted(() => ({ fits: [] as string[], at: { x: 0, y: 0, s: 1 }, moving: false, moved: false }));
vi.mock('../canvas/controller', () => ({
  camera: {
    fit: (r: { x: number }, mode: string, introducedInView = false) => ({ x: 0, y: 0, s: 1, at: r.x, mode: mode === 'overview' && introducedInView ? 'overview+introduced' : mode }),
    animateTo: (to: { at: number; mode: string }) => void cam.fits.push(`${to.mode}@${to.at}`),
    takeSaved: () => null,
    set: () => undefined,
    hasMoved: () => cam.moved,
    isMoving: () => cam.moving,
    onSettle: () => () => undefined,
    get cam() {
      return cam.at;
    },
    vp: { w: 1920, h: 1080 },
  },
}));
vi.mock('../desk/liveStore', () => ({ wakeDesk: () => undefined, deskClosed: () => null }));
vi.mock('./announce', () => ({ announce: () => undefined }));
const { fitScope, focusDesk, goOverview, OPEN_LIVE, refit, resetArrival, watchOpenTiles } = await import('./actions');

const info = (id: string): DeskInfo => ({ id, name: id, kind: 'work', vm: 'running', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} }) as DeskInfo;
const fresh = (id: string, x: number): LayoutDesk => defaultDesk(id, x, 0);
const resized = (id: string, x: number): LayoutDesk => ({ ...defaultDesk(id, x, 0), w: 900.5 });
const saved584 = (id: string, x: number): LayoutDesk => ({ ...defaultDesk(id, x, 0), ...OLD_DEFAULT_DESK });

function office(width: number, desks: LayoutDesk[], view: Parameters<typeof setView>[0] = { mode: 'overview' }): void {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: () => undefined },
    innerWidth: width, innerHeight: 900, setTimeout, clearTimeout,
    matchMedia: (q: string) => ({ matches: width <= Number(/max-width: (\d+)px/.exec(q)?.[1] ?? 0) }),
  });
  useLayoutStore.setState({ desks: Object.fromEntries(desks.map((d) => [d.id, d])), z: desks.map((d) => d.id) });
  useDeskStore.setState({ status: 'ready', desks: desks.map((d) => info(d.id)) });
  setView({ scope: 'all', activeDesk: desks[0]?.id ?? null, ...view });
}

beforeEach(() => {
  resetArrival();
  cam.fits.length = 0;
  cam.at = { x: 0, y: 0, s: 1 };
  cam.moving = false;
  cam.moved = false;
});

describe('a desk as introduced', () => {
  it('is the size a new desk gets, and only that', () => {
    expect(asIntroduced(fresh('a', 0))).toBe(true);
    expect(asIntroduced({ w: DEFAULT_DESK.w, h: DEFAULT_DESK.h })).toBe(true);
    expect(asIntroduced(resized('a', 0))).toBe(false);
    expect(asIntroduced({ ...fresh('a', 0), h: 480.01 })).toBe(false);
    expect(asIntroduced(saved584('a', 0))).toBe(false);
    expect(asIntroduced({ w: 781.96, h: 402.12 })).toBe(false); // the prod test account's resized first desk
  });

  it('keeps that when its apps move: the frame is about the desk', () => {
    const d = fresh('a', 0);
    const moved: LayoutDesk = { ...d, items: d.items.map((i) => ({ ...i, x: i.x + 200, y: i.y + 100 })) };
    expect(asIntroduced(moved)).toBe(true);
  });
});

describe('the framing the office asks for', () => {
  it('a new member arriving on their one desk: the owner\'s rule', () => {
    office(1920, [fresh('a', 0)]);
    refit(false);
    expect(cam.fits).toEqual(['framed@0']);
    expect(getView()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
  });

  it('a saved desk the member arranged, at any other size, fills the screen as before', () => {
    for (const d of [resized('a', 0), saved584('a', 0), { ...fresh('a', 0), w: 781.96, h: 402.12 }]) {
      resetArrival();
      cam.fits.length = 0;
      office(1920, [d]);
      refit(false);
      expect(cam.fits).toEqual(['desk@0']);
    }
  });

  it('a reload in desk mode, a focus and Fit frame a new desk by the rule too, so its first look holds', () => {
    office(1440, [fresh('a', 0)], { mode: 'desk', activeDesk: 'a' });
    refit(false);
    focusDesk('a', false);
    fitScope();
    expect(cam.fits).toEqual(['framed@0', 'framed@0', 'framed@0']);
  });

  it('a desk added later is new too: focused, it takes the rule; the member\'s own desk keeps its framing', () => {
    office(1920, [resized('a', 0), fresh('b', 1000)]);
    focusDesk('b', false);
    focusDesk('a', false);
    expect(cam.fits).toEqual(['framed@1000', 'desk@0']);
  });

  it('the overview never comes closer than the rule while a desk as introduced is in it, and is as before otherwise', () => {
    office(1440, [fresh('a', 0)]);
    goOverview(false);
    office(1440, [resized('a', 0), saved584('b', 1000)]);
    goOverview(false);
    office(1440, [resized('a', 0), fresh('b', 1000)]);
    goOverview(false);
    expect(cam.fits).toEqual(['overview+introduced@0', 'overview@0', 'overview+introduced@0']);
  });

  it('a desk in carousel mode is the carousel\'s stage, new or not', () => {
    office(1920, [{ ...fresh('a', 0), carousel: { on: true, app: 'notebook' } }]);
    refit(false);
    expect(cam.fits).toEqual(['stage@0']);
  });

  it('a phone asks for the same framing; the camera keeps the phone\'s own fit for it', () => {
    office(390, [fresh('a', 0)]);
    refit(false);
    expect(cam.fits).toEqual(['framed@0']);
  });
});

// The next member in this browser (ADR 0057): the view kept here is stamped with its member, and another member's is put back
// to a first visit's as they arrive. A's view showed only Personal desks; B's one desk is a Work desk.
describe('the next member in this browser', () => {
  it('another member\'s kept view goes as they arrive, so their new desk is framed by the rule', () => {
    office(1920, [fresh('b', 0)], { mode: 'free', scope: 'personal', activeDesk: 'gone' });
    setDeviceOwner('member-a');
    setView({ scope: 'personal' }); // kept, stamped with A
    setView({ mode: 'overview' });
    setView({ mode: 'free' });
    setDeviceOwner('member-b');
    refit(false);
    expect(getView()).toMatchObject({ scope: 'all', mode: 'desk', activeDesk: 'b' });
    expect(cam.fits).toEqual(['framed@0']);
  });

  it('the same member keeps theirs', () => {
    office(1920, [fresh('b', 0)], { mode: 'overview', scope: 'all' });
    setDeviceOwner('member-b');
    setView({ scope: 'personal' }); // B's own, stamped with B: B's one desk is out of that scope
    refit(false);
    expect(getView().scope).toBe('personal');
    expect(cam.fits).toEqual([]);
  });

  it('a change of member in this tab is an arrival again, for the new member', () => {
    office(1920, [fresh('b', 0)]);
    setDeviceOwner('member-a');
    refit(false);
    expect(cam.fits).toEqual(['framed@0']);
    focusDesk('b', false);
    setView({ mode: 'free' }); // A zooms away
    cam.moved = true;
    cam.fits.length = 0;
    refit(false); // a later refit keeps A's free camera
    expect(cam.fits).toEqual([]);
    setDeviceOwner('member-b');
    refit(false);
    expect(getView()).toMatchObject({ mode: 'desk', activeDesk: 'b' });
    expect(cam.fits).toEqual(['framed@0']);
  });
});

// An open tile on a new desk (ADR 0057, 0053): it needs 480 x 320 px to go live, and the rule's zoom can be under that.
describe('an open tile on a new desk', () => {
  const OPEN = { w: 536, h: 444 };
  const grown = (): LayoutDesk => ({ ...defaultDesk('a', 0, 0), h: 572 });
  const opened = (d: LayoutDesk): LayoutDesk => ({ ...d, items: d.items.map((i) => (i.app === 'notebook' ? { ...i, ...OPEN } : i)) });
  const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 5));
  let stop: () => void = () => undefined;

  function at(scale: number, view: Parameters<typeof setView>[0] = { mode: 'desk', activeDesk: 'a' }): void {
    office(1440, [grown()], view);
    cam.at = { x: 0, y: 0, s: scale };
    stop = watchOpenTiles();
  }
  const open = (): void => useLayoutStore.setState((st) => ({ desks: { ...st.desks, a: opened(st.desks['a']!) } }));

  it('reads the open tiles\' live size', () => {
    expect(OPEN_LIVE).toEqual({ w: 480, h: 320 });
  });

  it('made open where the rule\'s zoom is too small for it, the desk is framed again, as an arranged desk', async () => {
    at(0.8826); // 1440 x 900's rule: 473 px
    open();
    await tick();
    stop();
    expect(cam.fits).toEqual(['desk@0']);
  });

  it('waits for a keyboard edit to end', async () => {
    at(0.8826, { mode: 'desk', activeDesk: 'a', kbEdit: 'resize' });
    open();
    await tick();
    expect(cam.fits).toEqual([]);
    setView({ kbEdit: null });
    await tick();
    stop();
    expect(cam.fits).toEqual(['desk@0']);
  });

  it('leaves the camera be where the tile is big enough, in free mode, and for a tile that was open already', async () => {
    at(1.2);
    open();
    await tick();
    stop();
    at(0.5, { mode: 'free', activeDesk: 'a' });
    open();
    await tick();
    stop();
    office(1440, [opened(grown())], { mode: 'desk', activeDesk: 'a' });
    cam.at = { x: 0, y: 0, s: 0.5 };
    stop = watchOpenTiles();
    useLayoutStore.setState((st) => ({ desks: { ...st.desks, a: { ...st.desks['a']!, x: 10 } } }));
    await tick();
    stop();
    expect(cam.fits).toEqual([]);
  });
});
