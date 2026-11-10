// The last screen kept in the member's own browser (ma-platform ADR 0097): when the driver keeps it, when it shows it,
// and the size it's kept at. The IndexedDB side is `lastScreen.ts`, run for real in `alliance.shell.spec.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserMedia, DeskLink } from '../desk/deskLink';

const kept = vi.hoisted(() => ({ saves: [] as { deskId: string; source: unknown }[], stored: null as Blob | null, loads: [] as string[] }));
vi.mock('./lastScreen', async (orig) => ({
  ...(await orig<typeof import('./lastScreen')>()),
  saveLastScreen: async (deskId: string, source: unknown) => void kept.saves.push({ deskId, source }),
  loadLastScreen: async (deskId: string) => (kept.loads.push(deskId), kept.stored),
}));

const { BrowserDriver, LAST_SCREEN_EVERY_MS } = await import('./driver');
const { keptSize, MAX_WIDTH } = await import('./lastScreen');

let hidden = false;
let onVisibility: (() => void) | null = null;

class Link {
  private current: BrowserMedia | null = null;
  private readonly fns = new Set<() => void>();
  readonly deskId = 'd-alliance';
  readonly available = true;
  onMedia(fn: () => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  setMedia(m: BrowserMedia | null) {
    this.current = m;
    for (const fn of this.fns) fn();
  }
  media() {
    return this.current;
  }
  onCursor() {
    return () => {};
  }
  subscribe() {
    return () => {};
  }
  async call() {
    return {};
  }
  sendInput() {}
  status() {
    return 'open';
  }
}

function video() {
  return {
    srcObject: null as unknown,
    videoWidth: 1280,
    videoHeight: 800,
    muted: false,
    play: () => Promise.resolve(),
    requestVideoFrameCallback: (cb: () => void) => (queueMicrotask(cb), 1),
    cancelVideoFrameCallback: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
function canvas() {
  const drawn: unknown[] = [];
  return { width: 0, height: 0, hidden: true, drawn, getContext: () => ({ drawImage: (src: unknown) => drawn.push(src) }) };
}
const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  kept.saves = [];
  kept.loads = [];
  kept.stored = null;
  hidden = false;
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (_: string, fn: () => void) => void (onVisibility = fn),
    removeEventListener: () => void (onVisibility = null),
  });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1280, height: 800, close: () => {} }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function open(lastScreen: string | null) {
  const driver = new BrowserDriver();
  const link = new Link();
  driver.mount();
  driver.setLink(link as unknown as DeskLink);
  driver.setLastScreen(lastScreen);
  const v = video();
  const held = canvas();
  driver.attachVideo(v as unknown as HTMLVideoElement, held as unknown as HTMLCanvasElement);
  return { driver, link, v, held };
}
const session = (): BrowserMedia => ({ stream: { getVideoTracks: () => [] } as unknown as MediaStream, canPlayVideo: true });

describe('the last screen', () => {
  it('shows the kept picture at once, under the waking panel, until the first real frame', async () => {
    kept.stored = new Blob(['jpeg']);
    const { driver, link, held } = open('d-alliance');
    await flush();
    expect(kept.loads).toEqual(['d-alliance']);
    expect(held.hidden).toBe(false);
    expect(held.drawn).toHaveLength(1);
    expect(driver.getView()).toMatchObject({ hadFrame: true, lastScreen: true, hasFrame: false });
    link.setMedia(session());
    await flush();
    expect(driver.getView()).toMatchObject({ hasFrame: true, lastScreen: false });
    expect(held.hidden).toBe(true); // the real picture took over
  });

  it('keeps a copy while a frame shows: every 30 s while seen, when the tab hides, when the session goes', async () => {
    const { link, v, held } = open('d-alliance');
    await flush();
    expect(kept.saves).toEqual([]); // nothing of this session has shown yet
    link.setMedia(session());
    await flush();
    await flush(LAST_SCREEN_EVERY_MS);
    expect(kept.saves.map((s) => s.source)).toEqual([v]);
    hidden = true;
    onVisibility?.();
    expect(kept.saves).toHaveLength(2);
    await flush(LAST_SCREEN_EVERY_MS); // not while hidden
    expect(kept.saves).toHaveLength(2);
    hidden = false;
    link.setMedia(null); // the session goes: the held frame is kept
    expect(kept.saves.at(-1)).toEqual({ deskId: 'd-alliance', source: held });
  });

  it('a desk that doesn\'t start with the office keeps and shows nothing', async () => {
    kept.stored = new Blob(['jpeg']);
    const { link, held, driver } = open(null);
    link.setMedia(session());
    await flush(LAST_SCREEN_EVERY_MS * 2);
    link.setMedia(null);
    expect(kept.loads).toEqual([]);
    expect(kept.saves).toEqual([]);
    expect(driver.getView().lastScreen).toBe(false);
    expect(held.drawn).toHaveLength(1); // only the ordinary hold of the last frame
  });

  it('is kept no wider than the stream', () => {
    expect(keptSize(1280, 800)).toEqual({ w: 1280, h: 800 });
    expect(keptSize(2560, 1600)).toEqual({ w: MAX_WIDTH, h: 800 });
    expect(keptSize(1920, 1080)).toEqual({ w: 1280, h: 720 });
  });
});
