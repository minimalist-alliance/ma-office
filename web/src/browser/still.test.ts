// One live picture per member (task 46): an unseen desk's Browser shows a still, with no stream on the element, and
// looked at again it takes the stream back with the still up until the first real frame. Fake elements and clock;
// `browser.attention.shell.spec.ts` has the real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserMedia, DeskLink } from '../desk/deskLink';

const kept = vi.hoisted(() => ({ saves: [] as { deskId: string; source: unknown }[] }));
vi.mock('./lastScreen', async (orig) => ({
  ...(await orig<typeof import('./lastScreen')>()),
  saveLastScreen: async (deskId: string, source: unknown) => void kept.saves.push({ deskId, source }),
  loadLastScreen: async () => null,
}));

const { BACK_MEASURE, BrowserDriver, HIDDEN_LIVE_MS, LAST_SCREEN_EVERY_MS } = await import('./driver');

let hidden = false;
let onVisibility: (() => void) | null = null;

class Link {
  private current: BrowserMedia | null = null;
  private readonly fns = new Set<() => void>();
  readonly deskId = 'd-a';
  states: string[] = [];
  /** The desk said yes to `desk.attention.set` in this session. */
  knows = false;
  knowsAttention() {
    return this.knows;
  }
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
  input() {
    return null;
  }
  onCursor() {
    return () => {};
  }
  subscribe() {
    return () => {};
  }
  async call(method: string, params: { state?: string } = {}) {
    if (method === 'browser.stream.set') this.states.push(params.state ?? '');
    return { state: params.state };
  }
}

/** A `<video>` whose frames come when the test says. */
function video() {
  const callbacks = new Map<number, () => void>();
  let next = 0;
  const v = {
    srcObject: null as unknown,
    videoWidth: 1280,
    videoHeight: 800,
    muted: false,
    plays: 0,
    play: () => {
      v.plays += 1;
      return Promise.resolve();
    },
    requestVideoFrameCallback: (cb: () => void) => {
      next += 1;
      callbacks.set(next, cb);
      return next;
    },
    cancelVideoFrameCallback: (id: number) => void callbacks.delete(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    /** A frame is shown, if the element has a stream to show it from. */
    frame: () => {
      if (!v.srcObject) return;
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const cb of due) cb();
    },
    waiting: () => callbacks.size,
  };
  return v;
}
function canvas() {
  const drawn: unknown[] = [];
  return { width: 0, height: 0, hidden: true, drawn, getContext: () => ({ drawImage: (src: unknown) => drawn.push(src) }) };
}
const session = (silentFor?: () => number): BrowserMedia => ({ stream: { getVideoTracks: () => [] } as unknown as MediaStream, canPlayVideo: true, ...(silentFor ? { silentFor } : {}) });
const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};
const setHidden = (h: boolean) => {
  hidden = h;
  onVisibility?.();
};

beforeEach(() => {
  // Not `performance`: the switch's measure is read from it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  kept.saves = [];
  hidden = false;
  performance.clearMarks();
  performance.clearMeasures();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    addEventListener: (_: string, fn: () => void) => void (onVisibility = fn),
    removeEventListener: () => void (onVisibility = null),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A window with a picture playing: a session up, `live` said yes to, and a first frame shown. */
async function playing(media = session()) {
  const driver = new BrowserDriver();
  const link = new Link();
  const v = video();
  const held = canvas();
  driver.attachVideo(v as unknown as HTMLVideoElement, held as unknown as HTMLCanvasElement);
  driver.mount();
  driver.setLink(link as unknown as DeskLink);
  link.setMedia(media);
  await flush();
  v.frame();
  expect(driver.getView().hasFrame).toBe(true);
  expect(held.hidden).toBe(true);
  return { driver, link, v, held, media };
}

describe('the still of an unseen desk', () => {
  it('parked: the picture as it was, the stream off, and the element lets go of it', async () => {
    const { driver, link, v, held, media } = await playing();
    driver.setParked(true);
    await flush();
    expect(held.hidden).toBe(false);
    expect(held.drawn).toEqual([v]); // one copy of the last frame, in memory
    expect([held.width, held.height]).toEqual([1280, 800]);
    expect(v.srcObject).toBeNull(); // nothing decodes, nothing plays, nothing to click
    expect(link.states).toEqual(['live', 'off']);
    expect(driver.getView()).toMatchObject({ hasFrame: true, hadFrame: true }); // no panel over it, no "starting"
    expect(kept.saves).toEqual([]); // nothing new in storage
    expect(media.stream).toBeTruthy();
  });

  it('looked at again: live goes out, the stream is back on the element, and the still stays until the first real frame', async () => {
    const { driver, link, v, held, media } = await playing();
    driver.setParked(true);
    await flush();
    const plays = v.plays;
    driver.setParked(false);
    expect(v.srcObject).toBe(media.stream);
    expect(v.plays).toBe(plays + 1);
    expect(held.hidden).toBe(false); // the still, at once
    await flush();
    expect(link.states).toEqual(['live', 'off', 'live']);
    expect(held.hidden).toBe(false); // no frame yet: still the still, never a gap
    v.frame();
    expect(held.hidden).toBe(true);
    expect(held.width).toBe(0); // its bitmap let go
    expect(performance.getEntriesByName(BACK_MEASURE)).toHaveLength(1);
  });

  it('switching away and back before a frame shows keeps the one still, and measures from the last return', async () => {
    const { driver, v, held } = await playing();
    driver.setParked(true);
    driver.setParked(false);
    driver.setParked(true);
    expect(held.drawn).toHaveLength(1); // the element had let go, so there was nothing newer to copy
    expect(v.srcObject).toBeNull();
    driver.setParked(false);
    v.frame();
    expect(held.hidden).toBe(true);
    expect(performance.getEntriesByName(BACK_MEASURE)).toHaveLength(1);
  });

  it('a window opened on a desk that isn\'t on screen never takes the stream until it is', async () => {
    const driver = new BrowserDriver();
    const link = new Link();
    const v = video();
    const held = canvas();
    driver.attachVideo(v as unknown as HTMLVideoElement, held as unknown as HTMLCanvasElement);
    driver.mount();
    driver.setLink(link as unknown as DeskLink);
    driver.setParked(true);
    link.setMedia(session());
    await flush();
    expect(v.srcObject).toBeNull();
    expect(held.hidden).toBe(true); // nothing to show yet: no still
    expect(link.states).toEqual([]); // `off` is where a new session starts
    driver.setParked(false);
    await flush();
    expect(link.states).toEqual(['live']);
    v.frame();
    expect(driver.getView().hasFrame).toBe(true);
  });

  it('a session that goes while unseen keeps the still, and a new one waits under it until looked at', async () => {
    const { driver, link, v, held } = await playing();
    driver.setParked(true);
    link.setMedia(null);
    expect(held.hidden).toBe(false);
    const next = session();
    link.setMedia(next);
    await flush();
    expect(v.srcObject).toBeNull();
    driver.setParked(false);
    expect(v.srcObject).toBe(next.stream);
    v.frame();
    expect(held.hidden).toBe(true);
  });

  it('a desk that starts with the office keeps its last screen by its own rule: the still is what it keeps', async () => {
    const { driver, link, held } = await playing();
    driver.setLastScreen('d-a');
    driver.setParked(true);
    await flush(LAST_SCREEN_EVERY_MS * 2);
    expect(kept.saves).toEqual([]); // not every 30 s while unseen: nothing new to keep
    setHidden(true);
    expect(kept.saves).toEqual([{ deskId: 'd-a', source: held }]);
    link.setMedia(null);
    expect(kept.saves.at(-1)).toEqual({ deskId: 'd-a', source: held });
  });
});

describe('a desk that knows `desk.attention` (deskd API.md section 10)', () => {
  it('parked while playing: `live` stands, which the desk holds at `warm` cost, and coming back asks nothing', async () => {
    const { driver, link, v, held, media } = await playing();
    link.knows = true;
    driver.setParked(true);
    await flush();
    expect(link.states).toEqual(['live']);
    expect(v.srcObject).toBeNull(); // the still, all the same
    expect(held.hidden).toBe(false);
    driver.setParked(false);
    await flush();
    expect(link.states).toEqual(['live']); // the desk sends media again on `seen: true`
    expect(v.srcObject).toBe(media.stream);
    v.frame();
    expect(held.hidden).toBe(true);
  });

  it('a window still waiting for its first picture keeps `live` too: its Browser window is open', async () => {
    const driver = new BrowserDriver();
    const link = new Link();
    link.knows = true;
    const v = video();
    driver.attachVideo(v as unknown as HTMLVideoElement, canvas() as unknown as HTMLCanvasElement);
    driver.mount();
    driver.setLink(link as unknown as DeskLink);
    link.setMedia(session());
    await flush();
    driver.setParked(true);
    await flush();
    expect(link.states).toEqual(['live']);
  });

  it('a new session while parked starts `off` and stays so until looked at, so it thaws nothing', async () => {
    const { driver, link } = await playing();
    link.knows = true;
    driver.setParked(true);
    link.setMedia(null);
    link.setMedia(session());
    await flush();
    expect(link.states).toEqual(['live']); // nothing asked of the new session
    driver.setParked(false);
    await flush();
    expect(link.states).toEqual(['live', 'live']);
  });

  it('parked live past 5 minutes in a hidden tab goes `warm`, as an open window does', async () => {
    const { driver, link } = await playing();
    link.knows = true;
    driver.setParked(true);
    setHidden(true);
    await flush(HIDDEN_LIVE_MS + 1_000);
    expect(link.states).toEqual(['live', 'warm']);
  });
});

describe('the desk\'s own word on freezing (`desk.attention`)', () => {
  it('in a visible tab changes nothing: the member is looking, so it\'s about to thaw', async () => {
    const { driver, v, held, media } = await playing();
    driver.setFrozen(true);
    expect(v.srcObject).toBe(media.stream);
    expect(held.hidden).toBe(true);
  });

  it('in a hidden tab, frozen: the still, and back in view the stream returns under it', async () => {
    const { driver, link, v, held, media } = await playing();
    setHidden(true);
    expect(v.srcObject).toBe(media.stream); // hidden alone is no reason: it may be playing sound
    driver.setFrozen(true);
    expect(v.srcObject).toBeNull();
    expect(held.hidden).toBe(false);
    setHidden(false);
    expect(v.srcObject).toBe(media.stream);
    expect(held.hidden).toBe(false);
    v.frame();
    expect(held.hidden).toBe(true);
    expect(link.states).toEqual(['live']); // under 5 minutes hidden, nothing asked of the stream
  });

  it('in a hidden tab with the desk playing sound, it never froze: the stream stays live and on the element (ADR 0038)', async () => {
    const { driver, link, v, media } = await playing(session(() => 0));
    setHidden(true);
    driver.setFrozen(false);
    await flush(HIDDEN_LIVE_MS + 1_000);
    expect(link.states).toEqual(['live']);
    expect(v.srcObject).toBe(media.stream);
  });

  it('thawed while still hidden (the Agent started work): the stream goes back on the element', async () => {
    const { driver, v, media } = await playing();
    setHidden(true);
    driver.setFrozen(true);
    driver.setFrozen(false);
    expect(v.srcObject).toBe(media.stream);
  });
});
