import { afterEach, describe, expect, it, vi } from 'vitest';
import { wheelDeltaY, wheelZoomFactor } from './camera';
import { APP_ZOOM, gestureDelta, gesturePinchGoes, gestureStep, listenForPinches, setAppZoom, wheelPinchGoes, type AppZoomInput } from './pinch';

/** An element that's inside whatever `inside` names, as `closest` would find it. */
const el = (inside: string | null = null): Element => ({ closest: (sel: string) => (inside && sel.split(', ').includes(inside) ? {} : null) }) as unknown as Element;
/** An app's frame (ADR 0055), inside a window (`[role="dialog"]`) as a window's is. */
const frame = { app: 'notebook' } as unknown as Element;
/** Something in that app: its frame is what `closest(APP_ZOOM)` finds. */
const inApp = (alsoIn = '[role="dialog"]'): Element => ({ closest: (sel: string) => (sel === APP_ZOOM ? frame : sel.split(', ').includes(alsoIn) ? {} : null) }) as unknown as Element;

describe('where a ctrl+wheel goes', () => {
  it('over the office, a pinch zooms the camera', () => {
    expect(wheelPinchGoes(el(), false, false)).toBe('camera');
  });
  it('one the canvas or a Browser window already took is theirs', () => {
    expect(wheelPinchGoes(el(), true, false)).toBe('browser');
    expect(wheelPinchGoes(el('[role="dialog"]'), true, false)).toBe('browser');
  });
  it('over a window, a menu or a field, a pinch magnifies nothing and moves nothing', () => {
    for (const own of ['[role="dialog"]', '[role="menu"]', '[role="listbox"]', 'input', 'textarea', 'select', '[contenteditable="true"]']) {
      expect(wheelPinchGoes(el(own), false, false)).toBe('stop');
    }
  });
  it('with the real Control key held it is Ctrl and the wheel, the browser\'s own page zoom, outside the canvas', () => {
    expect(wheelPinchGoes(el(), false, true)).toBe('browser');
    expect(wheelPinchGoes(el('[role="dialog"]'), false, true)).toBe('browser');
  });
  it('with no element under it, the browser keeps it', () => {
    expect(wheelPinchGoes(null, false, false)).toBe('browser');
  });
  it('over an app, a pinch and the real key with the wheel both zoom the app (ADR 0055), in a window, a menu or a field of it too', () => {
    expect(wheelPinchGoes(inApp(), false, false)).toBe('app');
    expect(wheelPinchGoes(inApp(), false, true)).toBe('app');
    for (const own of ['[role="menu"]', 'input', '[contenteditable="true"]', '.open-tile']) expect(wheelPinchGoes(inApp(own), false, false)).toBe('app');
  });
  it('over an app, one something in it already took is still theirs (the Browser\'s picture, before its desk zooms)', () => {
    expect(wheelPinchGoes(inApp(), true, false)).toBe('browser');
  });
});

describe('where one of Safari\'s GestureEvents goes', () => {
  it('a trackpad pinch over the office zooms the camera', () => {
    expect(gesturePinchGoes(el(), false)).toBe('camera');
  });
  it('a trackpad pinch over an app zooms the app; a finger\'s pinch there is still the touch\'s own', () => {
    expect(gesturePinchGoes(inApp(), false)).toBe('app');
    expect(gesturePinchGoes(inApp(), true)).toBe('stop');
  });
  it('a touch pinch is the canvas\'s own, and a window keeps its own: both only stop Safari magnifying', () => {
    expect(gesturePinchGoes(el(), true)).toBe('stop');
    expect(gesturePinchGoes(el('[role="dialog"]'), false)).toBe('stop');
    expect(gesturePinchGoes(null, false)).toBe('stop');
  });
  it('steps from the scale since the gesture began', () => {
    expect(gestureStep(1, 1.5)).toBeCloseTo(1.5);
    expect(gestureStep(1.5, 1.8)).toBeCloseTo(1.2);
    expect(gestureStep(2, 1)).toBeCloseTo(0.5);
    // Steps multiply back to the whole gesture's scale.
    let s = 1;
    let last = 1;
    for (const k of [1.1, 1.3, 0.9, 1.6]) {
      s *= gestureStep(last, k);
      last = k;
    }
    expect(s).toBeCloseTo(1.6);
  });
  it('a missing or odd scale moves nothing', () => {
    expect(gestureStep(1, 0)).toBe(1);
    expect(gestureStep(0, 1.2)).toBe(1);
    expect(gestureStep(1, Number.NaN)).toBe(1);
    expect(gestureStep(1, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('a wheel\'s zoom', () => {
  it('is the canvas\'s own step, a pinch\'s bigger than a scroll\'s', () => {
    expect(wheelZoomFactor(-10, true)).toBeCloseTo(Math.exp(0.12));
    expect(wheelZoomFactor(10, false)).toBeCloseTo(Math.exp(-0.016));
    expect(wheelZoomFactor(0, true)).toBe(1);
  });
  it('a burst is capped at 300 px', () => {
    expect(wheelZoomFactor(-5000, true)).toBeCloseTo(wheelZoomFactor(-300, true));
    expect(wheelZoomFactor(5000, false)).toBeCloseTo(wheelZoomFactor(300, false));
  });
  it('lines and pages become pixels', () => {
    expect(wheelDeltaY(3, 0, 900)).toBe(3);
    expect(wheelDeltaY(3, 1, 900)).toBe(48);
    expect(wheelDeltaY(1, 2, 900)).toBe(900);
  });
});

describe('listening on the page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setUp(): { win: EventTarget; zooms: { x: number; y: number; f: number }[]; begins: number; stop: () => void; send: (e: Event, target: Element | null) => Event } {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const zooms: { x: number; y: number; f: number }[] = [];
    const state = { begins: 0 };
    const stop = listenForPinches({
      stageBox: () => ({ left: 10, top: 20 }) as DOMRect,
      begin: () => {
        state.begins += 1;
      },
      zoomAt: (p, f) => zooms.push({ x: p.x, y: p.y, f }),
      wheelFactor: (e) => wheelZoomFactor(e.deltaY, true),
    });
    const send = (e: Event, target: Element | null): Event => {
      Object.defineProperty(e, 'target', { value: target });
      win.dispatchEvent(e);
      return e;
    };
    return { win, zooms, get begins() { return state.begins; }, stop, send };
  }

  const gesture = (type: string, scale: number, x = 110, y = 220): Event => Object.assign(new Event(type, { cancelable: true }), { scale, clientX: x, clientY: y });
  const wheel = (deltaY: number, ctrlKey = true, metaKey = false): Event => Object.assign(new Event('wheel', { cancelable: true }), { deltaY, deltaMode: 0, ctrlKey, metaKey, clientX: 110, clientY: 220 });
  const key = (type: string): Event => Object.assign(new Event(type), { key: 'Control' });

  it('a Safari pinch zooms at the pointer, in the stage\'s pixels, step by step, and is never the page\'s', () => {
    const t = setUp();
    const events = [gesture('gesturestart', 1), gesture('gesturechange', 1.25), gesture('gesturechange', 1.5), gesture('gestureend', 1.5)];
    for (const e of events) t.send(e, el());
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    expect(t.begins).toBe(1);
    expect(t.zooms.map((z) => [z.x, z.y])).toEqual([[100, 200], [100, 200]]);
    expect(t.zooms[0]!.f * t.zooms[1]!.f).toBeCloseTo(1.5);
    t.stop();
  });

  it('a Safari pinch over a window, or with a finger down, moves nothing and still magnifies nothing', () => {
    const t = setUp();
    const overWindow = [gesture('gesturestart', 1), gesture('gesturechange', 2), gesture('gestureend', 2)];
    for (const e of overWindow) t.send(e, el('[role="dialog"]'));
    t.send(Object.assign(new Event('touchstart'), { touches: { length: 2 } }), el());
    const touch = [gesture('gesturestart', 1), gesture('gesturechange', 2), gesture('gestureend', 2)];
    for (const e of touch) t.send(e, el());
    expect([...overWindow, ...touch].every((e) => e.defaultPrevented)).toBe(true);
    expect(t.zooms).toEqual([]);
    t.stop();
  });

  it('a Chromium pinch the canvas didn\'t take zooms the camera; the real Control key leaves it to the browser', () => {
    const t = setUp();
    const pinch = t.send(wheel(-10), el());
    expect(pinch.defaultPrevented).toBe(true);
    expect(t.zooms).toHaveLength(1);
    expect(t.zooms[0]!.f).toBeCloseTo(Math.exp(0.12));
    const scroll = t.send(wheel(-10, false), el());
    expect(scroll.defaultPrevented).toBe(false);
    t.send(key('keydown'), null);
    const ctrlWheel = t.send(wheel(-10), el());
    expect(ctrlWheel.defaultPrevented).toBe(false);
    t.send(key('keyup'), null);
    expect(t.send(wheel(-10), el()).defaultPrevented).toBe(true);
    expect(t.zooms).toHaveLength(2);
    // Leaving the window lets go of Control, whatever the keyup did.
    t.send(key('keydown'), null);
    t.send(new Event('blur'), null);
    expect(t.send(wheel(-10), el()).defaultPrevented).toBe(true);
    t.stop();
  });

  it('one already taken is left alone, and after stopping nothing listens', () => {
    const t = setUp();
    const taken = wheel(-10);
    taken.preventDefault();
    t.send(taken, el());
    expect(t.zooms).toEqual([]);
    t.stop();
    expect(t.send(wheel(-10), el()).defaultPrevented).toBe(false);
    expect(t.send(gesture('gesturestart', 1), el()).defaultPrevented).toBe(false);
  });

  describe('over an app (ADR 0055)', () => {
    afterEach(() => setAppZoom(null));
    const handed = (): AppZoomInput[] => {
      const got: AppZoomInput[] = [];
      setAppZoom((z) => got.push(z));
      return got;
    };

    it('a Chromium pinch goes to the app\'s zoom with its frame and delta, never the camera or the page', () => {
      const t = setUp();
      const got = handed();
      const e = t.send(wheel(-6), inApp());
      expect(e.defaultPrevented).toBe(true);
      expect(got).toEqual([{ frame, dy: -6, pinch: true }]);
      expect(t.zooms).toEqual([]);
      expect(t.begins).toBe(0);
      t.stop();
    });

    it('Ctrl and the wheel, and Cmd and the wheel, zoom the app as a held key, not a pinch', () => {
      const t = setUp();
      const got = handed();
      t.send(key('keydown'), null);
      expect(t.send(wheel(100), inApp()).defaultPrevented).toBe(true);
      t.send(key('keyup'), null);
      expect(t.send(wheel(-100, false, true), inApp()).defaultPrevented).toBe(true);
      expect(got.map((z) => [z.dy, z.pinch])).toEqual([[100, false], [-100, false]]);
      t.stop();
    });

    it('off the apps, Cmd and the wheel stay the browser\'s, and a plain wheel is nobody\'s here', () => {
      const t = setUp();
      const got = handed();
      expect(t.send(wheel(-100, false, true), el()).defaultPrevented).toBe(false);
      expect(t.send(wheel(-100, false, true), el('[role="dialog"]')).defaultPrevented).toBe(false);
      expect(t.send(wheel(-100, false), inApp()).defaultPrevented).toBe(false);
      expect(got).toEqual([]);
      expect(t.zooms).toEqual([]);
      t.stop();
    });

    it('before the zoom chunk is here, a pinch over an app still magnifies nothing', () => {
      const t = setUp();
      expect(t.send(wheel(-6), inApp()).defaultPrevented).toBe(true);
      expect(t.zooms).toEqual([]);
      t.stop();
    });

    it('a Safari pinch over an app goes to its zoom, at the camera\'s pinch rate, and is never the page\'s', () => {
      const t = setUp();
      const got = handed();
      const events = [gesture('gesturestart', 1), gesture('gesturechange', 1.1), gesture('gesturechange', 1.1), gesture('gesturechange', 1.21), gesture('gestureend', 1.21)];
      for (const e of events) t.send(e, inApp());
      expect(events.every((e) => e.defaultPrevented)).toBe(true);
      expect(got.map((z) => z.frame)).toEqual([frame, frame]);
      expect(got.every((z) => z.pinch)).toBe(true);
      expect(got[0]!.dy).toBeCloseTo(gestureDelta(1.1));
      expect(got[0]!.dy).toBeCloseTo(-Math.log(1.1) / 0.012);
      expect(t.zooms).toEqual([]);
      t.stop();
    });
  });
});
