import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutDesk, LayoutItem } from '../canvas/layout';
import { useLayoutStore } from '../state/layoutStore';
import { openWindow, useWindowStore, windowKey } from '../state/windowStore';
import { phoneApp, usePhoneCarousel } from './phone';

// One instance of each app: on a desk in carousel mode, opening an app's window moves the carousel to it instead, and the
// switch takes the desk's open windows into the carousel. The window and the layout stores against a stand-in window.
const shell = vi.hoisted(() => ({ focused: [] as string[], refit: [] as string[], proxies: [] as string[] }));
vi.mock('../canvas/controller', () => ({ camera: { isMoving: () => false, onSettle: () => () => undefined, onMove: () => () => undefined, cam: { x: 0, y: 0, s: 1 } } }));
vi.mock('../shell/actions', () => ({
  appLabel: (app: string) => app,
  focusDesk: (id: string) => shell.focused.push(id),
  refitDesk: (id: string) => shell.refit.push(id),
  focusProxy: (id: string) => shell.proxies.push(id),
}));
vi.mock('../shell/announce', () => ({ announce: () => undefined }));
const { backToDesk, toggleCarousel, stepCarousel, watchCarouselWindows } = await import('./actions');

const item = (app: LayoutItem['app'], x: number): LayoutItem => ({ id: `d1:${app}`, app, x, y: 24, w: 76, h: 76 });
const DESK: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 584, h: 236, items: [item('chat', 24), item('notebook', 124), item('browser', 224), item('agent', 316)] };
const OTHER: LayoutDesk = { ...DESK, id: 'd2', x: 700, items: DESK.items.map((i) => ({ ...i, id: i.id.replace('d1', 'd2') })) };

function windowOf(width: number): void {
  vi.stubGlobal('window', {
    innerWidth: width,
    innerHeight: 900,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    matchMedia: (query: string) => {
      const max = /max-width: (\d+)px/.exec(query);
      return { matches: !!max && width <= Number(max[1]) };
    },
  });
}

const desk = (id = 'd1'): LayoutDesk => useLayoutStore.getState().desks[id]!;
const open = (): string[] => Object.keys(useWindowStore.getState().windows).sort();

beforeEach(() => {
  vi.useFakeTimers();
  windowOf(1440);
  shell.focused.length = 0;
  shell.refit.length = 0;
  shell.proxies.length = 0;
  usePhoneCarousel.setState({ shown: {} });
  useLayoutStore.setState({ desks: { d1: DESK, d2: OTHER }, z: ['d1', 'd2'] });
  useWindowStore.setState({ windows: {}, active: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the switch', () => {
  it('turns the desk to carousel on its top window\'s app, and its windows go into it', () => {
    openWindow('d1', 'notebook', 'd1:notebook');
    openWindow('d1', 'browser', 'd1:browser');
    openWindow('d2', 'chat', 'd2:chat');
    toggleCarousel('d1');
    expect(desk().carousel).toEqual({ on: true, app: 'browser' });
    expect(open()).toEqual([windowKey('d2', 'chat')]); // only this desk's
    expect(desk('d2').carousel).toBeUndefined(); // and nothing reaches the other desk
    expect(shell.focused).toEqual(['d1']);
  });

  it('with no window open, shows the app it showed last, or the first; and back to the desk keeps that one', () => {
    toggleCarousel('d1');
    expect(desk().carousel).toEqual({ on: true, app: 'chat' });
    stepCarousel('d1', 1);
    toggleCarousel('d1');
    expect(desk().carousel).toEqual({ on: false, app: 'notebook' });
    toggleCarousel('d1');
    expect(desk().carousel).toEqual({ on: true, app: 'notebook' });
  });

  it('does nothing on a phone, whose carousel is its own', () => {
    windowOf(390);
    toggleCarousel('d1');
    expect(desk().carousel).toBeUndefined();
  });
});

describe('on a phone (the thumb row): the phone\'s own carousel, never saved', () => {
  beforeEach(() => windowOf(390));
  const LAPTOP = { on: true, app: 'browser' } as const;
  const laptopHas = (): void => useLayoutStore.setState({ desks: { ...useLayoutStore.getState().desks, d1: { ...DESK, carousel: LAPTOP } } });

  it('a tile opens its app in the phone\'s carousel, never a window, and the desk is left exactly as it was', () => {
    const before = desk();
    expect(openWindow('d1', 'notebook', 'd1:notebook')).toBe('carousel');
    expect(phoneApp(desk())).toBe('notebook');
    expect(openWindow('d1', 'browser', 'd1:browser')).toBe('carousel');
    expect(phoneApp(desk())).toBe('browser');
    stepCarousel('d1', 1);
    expect(phoneApp(desk())).toBe('agent');
    expect(open()).toEqual([]);
    expect(desk()).toBe(before); // the same object: nothing written, so nothing saved
    expect(desk().carousel).toBeUndefined();
    expect(phoneApp(desk('d2'))).toBeNull();
  });

  it('an app the desk doesn\'t hold still opens as a window', () => {
    expect(openWindow('d1', 'files', 'd1:files')).toBe('window');
    expect(open()).toEqual([windowKey('d1', 'files')]);
    expect(phoneApp(desk())).toBeNull();
  });

  it('back to the desk is the phone\'s alone, and gives the keyboard to the app\'s tile', () => {
    openWindow('d1', 'chat', 'd1:chat');
    backToDesk('d1');
    expect(phoneApp(desk())).toBeNull();
    expect(desk().carousel).toBeUndefined();
    expect(shell.proxies).toEqual(['d1:chat']);
    backToDesk('d1'); // already at the desk: nothing more
    expect(shell.proxies).toEqual(['d1:chat']);
  });

  it('reads a larger screen\'s carousel as a convenience, and never writes it', () => {
    laptopHas();
    const before = desk();
    expect(phoneApp(desk())).toBe('browser'); // it opens on the laptop's app
    stepCarousel('d1', -1);
    expect(phoneApp(desk())).toBe('notebook');
    backToDesk('d1');
    expect(phoneApp(desk())).toBeNull(); // the phone's own choice from here
    openWindow('d1', 'agent', 'd1:agent');
    expect(phoneApp(desk())).toBe('agent');
    expect(desk()).toBe(before);
    expect(desk().carousel).toEqual(LAPTOP); // the laptop's desk exactly as it was
  });

  it('the switch does nothing on a phone, and a larger screen\'s carousel closes no window of the phone\'s', () => {
    openWindow('d1', 'files', 'd1:files');
    toggleCarousel('d1');
    expect(desk().carousel).toBeUndefined();
    const off = watchCarouselWindows();
    laptopHas();
    expect(open()).toEqual([windowKey('d1', 'files')]);
    off();
  });
});

describe('one instance of each app', () => {
  it('opening an app\'s window on a carousel desk moves the carousel to it, and opens no window', () => {
    toggleCarousel('d1');
    openWindow('d1', 'agent', 'd1:agent');
    expect(desk().carousel).toEqual({ on: true, app: 'agent' });
    expect(open()).toEqual([]);
    openWindow('d2', 'agent', 'd2:agent'); // another desk is as it was
    expect(open()).toEqual([windowKey('d2', 'agent')]);
  });

  it('an app the desk doesn\'t hold opens as a window, as before', () => {
    toggleCarousel('d1');
    openWindow('d1', 'files', 'd1:files');
    expect(open()).toEqual([windowKey('d1', 'files')]);
  });

  it('a desk turned to carousel elsewhere takes this browser\'s windows on it too', () => {
    openWindow('d1', 'browser', 'd1:browser');
    const off = watchCarouselWindows();
    useLayoutStore.setState({ desks: { ...useLayoutStore.getState().desks, d1: { ...DESK, carousel: { on: true, app: 'browser' } } } });
    expect(open()).toEqual([]);
    off();
  });

  it('steps stop at the ends', () => {
    toggleCarousel('d1');
    expect(stepCarousel('d1', -1)).toBe(false);
    expect(stepCarousel('d1', 1)).toBe(true);
    expect(desk().carousel?.app).toBe('notebook');
  });
});
