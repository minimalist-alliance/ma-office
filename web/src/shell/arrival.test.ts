import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutDesk } from '../canvas/layout';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { setView, useViewStore } from '../state/viewStore';

// How a page load arrives (`refit`): a phone with several desks lands on its desk, anything larger on the overview.
const cam = vi.hoisted(() => ({ fits: [] as string[], animated: 0, woken: [] as string[], saved: null as unknown }));
vi.mock('../canvas/controller', () => ({
  camera: {
    fit: (r: { x: number }, mode: string) => ({ at: r.x, mode }),
    animateTo: (to: { at: number; mode: string }) => {
      cam.animated += 1;
      cam.fits.push(`${to.mode}@${to.at}`);
    },
    takeSaved: () => cam.saved,
    set: () => undefined,
    hasMoved: () => false,
    cam: { x: 0, y: 0, s: 1 },
    vp: { w: 390, h: 844 },
  },
}));
const closed = vi.hoisted(() => ({ ids: {} as Record<string, string> }));
vi.mock('../desk/liveStore', () => ({ wakeDesk: (id: string) => cam.woken.push(id), deskClosed: (id: string) => closed.ids[id] ?? null }));
vi.mock('./announce', () => ({ announce: () => undefined }));
const { refit, resetArrival } = await import('./actions');

const desk = (id: string, x: number): LayoutDesk => ({ id, x, y: 0, w: 584, h: 236, items: [] });
const vms: Record<string, string> = {};
const info = (id: string): DeskInfo => ({ id, name: id, kind: 'work', vm: vms[id] ?? 'running', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} }) as DeskInfo;

const store: Record<string, string> = {};
function windowOf(width: number): void {
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) }, innerWidth: width, innerHeight: 844, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id), matchMedia: (q: string) => ({ matches: width <= Number(/max-width: (\d+)px/.exec(q)?.[1] ?? 0) }) });
}
function setup(width: number, status: 'ready' | 'loading', view: Parameters<typeof setView>[0], count = 3): void {
  windowOf(width);
  const ids = ['a', 'b', 'c'].slice(0, count);
  useLayoutStore.setState({ desks: Object.fromEntries(ids.map((id, i) => [id, desk(id, i * 700)])), z: ids });
  useDeskStore.setState({ status, desks: ids.map(info) });
  setView({ scope: 'all', ...view });
}
const view = () => useViewStore.getState();

beforeEach(() => {
  resetArrival();
  cam.fits.length = 0;
  cam.animated = 0;
  cam.woken.length = 0;
  cam.saved = null;
  for (const k of Object.keys(vms)) delete vms[k];
  closed.ids = {};
  for (const k of Object.keys(store)) delete store[k];
});

describe('arriving', () => {
  it('a phone with three desks lands on the remembered one and wakes it', () => {
    setup(390, 'ready', { mode: 'overview', activeDesk: 'b' });
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'b' });
    expect(cam.woken).toEqual(['b']);
    expect(cam.fits).toEqual(['desk@700']);
  });
  it('a phone whose remembered desk is gone lands on the first running one, which is already awake', () => {
    setup(390, 'ready', { mode: 'overview', activeDesk: 'gone' });
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
    expect(cam.woken).toEqual([]);
  });
  it('a phone that saved a free camera still lands on its desk', () => {
    setup(390, 'ready', { mode: 'free', activeDesk: 'c' });
    cam.saved = { x: 5, y: 5, s: 1 };
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'c' });
  });
  it('a phone before the list answers paints the remembered desk, and changes and wakes nothing', () => {
    setup(390, 'loading', { mode: 'overview', activeDesk: 'b' });
    refit(false);
    expect(cam.fits).toEqual(['desk@700']);
    expect(view().mode).toBe('overview');
    expect(cam.woken).toEqual([]);
    // The answer then arrives on the desk.
    useDeskStore.setState({ status: 'ready' });
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'b' });
    expect(cam.woken).toEqual(['b']);
  });
  it('a larger screen with three desks still lands on the overview, waking nothing', () => {
    setup(1440, 'ready', { mode: 'desk', activeDesk: 'b' });
    setView({ mode: 'overview' });
    refit(false);
    expect(view().mode).toBe('overview');
    expect(cam.woken).toEqual([]);
    expect(cam.fits).toEqual(['overview@0']);
  });
  it('a phone with one desk lands on it, as before', () => {
    setup(390, 'ready', { mode: 'overview', activeDesk: null }, 1);
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
  });
  it('a resize after arriving brings back neither a zoomed-out member nor a wake', () => {
    setup(390, 'ready', { mode: 'overview', activeDesk: 'b' });
    refit(false);
    cam.woken.length = 0;
    setView({ mode: 'overview' });
    refit(false);
    expect(view().mode).toBe('overview');
    expect(cam.woken).toEqual([]);
  });
  it('a phone that arrived, then re-fits for a resize or a list change, leaves the saved stacking alone', () => {
    setup(390, 'ready', { mode: 'overview', activeDesk: null });
    refit(false);
    expect(useLayoutStore.getState().z).toEqual(['a', 'b', 'c']);
    refit(true);
    refit(true);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
    expect(useLayoutStore.getState().z).toEqual(['a', 'b', 'c']);
  });
});

describe('a phone with nothing remembered never starts a desk the member did not pick', () => {
  const arrive = (): void => {
    setup(390, 'ready', { mode: 'overview', activeDesk: null });
    refit(false);
  };
  it('lands on the running second desk, waking nothing', () => {
    vms['a'] = 'stopped';
    arrive();
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'b' });
    expect(cam.woken).toEqual([]);
  });
  it('with none running lands on the first, waking nothing', () => {
    vms['a'] = vms['b'] = vms['c'] = 'stopped';
    arrive();
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
    expect(cam.woken).toEqual([]);
  });
  it('with none running and the first closed lands on the first that can open, waking nothing', () => {
    vms['a'] = 'setting-up';
    vms['b'] = vms['c'] = 'stopped';
    closed.ids['a'] = 'setting-up';
    arrive();
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'b' });
    expect(cam.woken).toEqual([]);
  });
  it('with none able to open lands on the first, waking nothing', () => {
    vms['a'] = vms['b'] = vms['c'] = 'held';
    closed.ids['a'] = closed.ids['b'] = closed.ids['c'] = 'held';
    arrive();
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
    expect(cam.woken).toEqual([]);
  });
  it('a remembered stopped desk still lands and wakes, as every screen does', () => {
    vms['a'] = 'stopped';
    setup(390, 'ready', { mode: 'overview', activeDesk: 'a' });
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
    expect(cam.woken).toEqual(['a']);
  });
  it('one desk, stopped: unchanged, it wakes', () => {
    vms['a'] = 'stopped';
    setup(390, 'ready', { mode: 'overview', activeDesk: null }, 1);
    refit(false);
    expect(cam.woken).toEqual(['a']);
  });
  it('the pre-list paint frames the desk the arrival will pick, once the list is known', () => {
    vms['a'] = 'stopped';
    setup(390, 'loading', { mode: 'overview', activeDesk: null });
    useDeskStore.setState({ desks: ['a', 'b', 'c'].map(info) });
    refit(false);
    expect(cam.fits).toEqual(['desk@700']);
    expect(cam.woken).toEqual([]);
  });
  it('a desk the office framed asleep is not remembered on the next visit, so it still wakes nothing', () => {
    vms['a'] = vms['b'] = vms['c'] = 'stopped';
    arrive();
    resetArrival();
    refit(false);
    expect(view()).toMatchObject({ mode: 'desk', activeDesk: 'a' });
    expect(cam.woken).toEqual([]);
  });
});
