import { describe, expect, it } from 'vitest';
import { encodeQuality } from '../../quality/levels';
import { buttonChanges, contentBox, cursorCss, EVENT_BYTES, HeldKeys, InputEncoder, isCopyChord, keyAction, keysymFor, normalized, pasteKeys, wheelPixels, WheelSum, type KeyLike } from './input';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('InputEncoder, byte for byte against docs/interfaces/desk-runtime.md 8.6', () => {
  it('MOVE: type 1, seq at 4, x at 8, y at 10, the rest 0', () => {
    expect(hex(new InputEncoder().move(0x1234, 0xfedc))).toBe('01 00 00 00 00 00 00 01 12 34 fe dc 00 00 00 00');
  });

  it('BUTTON: type 2, down at 1, X button at 2, position', () => {
    expect(hex(new InputEncoder().button(true, 3, 100, 200))).toBe('02 01 03 00 00 00 00 01 00 64 00 c8 00 00 00 00');
    expect(hex(new InputEncoder().button(false, 9, 0, 65535))).toBe('02 00 09 00 00 00 00 01 00 00 ff ff 00 00 00 00');
  });

  it('WHEEL: type 3, position, signed dx at 12 and dy at 14', () => {
    expect(hex(new InputEncoder().wheel(1, 2, -1, 53))).toBe('03 00 00 00 00 00 00 01 00 01 00 02 ff ff 00 35');
  });

  it('KEY: type 4, down at 1, position 0, keysym at 12', () => {
    expect(hex(new InputEncoder().key(true, 0xff0d))).toBe('04 01 00 00 00 00 00 01 00 00 00 00 00 00 ff 0d');
    expect(hex(new InputEncoder().key(false, 0x0101f600))).toBe('04 00 00 00 00 00 00 01 00 00 00 00 01 01 f6 00');
  });

  it('RELEASE_ALL: type 5 and a seq', () => {
    expect(hex(new InputEncoder().releaseAll())).toBe('05 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00');
  });

  it('HOLD: type 6, the hold in ms at 12 (ADR 0037)', () => {
    expect(hex(new InputEncoder().hold(57))).toBe('06 00 00 00 00 00 00 01 00 00 00 00 00 39 00 00');
    expect(hex(new InputEncoder().hold(0))).toBe('06 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00');
  });

  it('QUALITY made elsewhere takes the next seq of the one counter, and nothing else of it changes (stream-quality.md 3)', () => {
    const e = new InputEncoder();
    e.move(1, 2);
    expect(hex(e.stamp(encodeQuality('low')))).toBe('07 01 00 00 00 00 00 02 00 00 00 00 00 00 00 00');
    expect(hex(e.key(true, 0x61)).slice(0, 23)).toBe('04 01 00 00 00 00 00 03');
  });

  it('every event is exactly 16 bytes', () => {
    const e = new InputEncoder();
    for (const b of [e.move(1, 1), e.button(true, 1, 1, 1), e.wheel(1, 1, 1, 1), e.key(true, 65), e.releaseAll()]) {
      expect(b.length).toBe(EVENT_BYTES);
      expect(b.buffer.byteLength).toBe(16);
    }
  });

  it('one seq across event types, starting at 1 and going up by 1', () => {
    const e = new InputEncoder();
    const seqs = [e.move(1, 1), e.key(true, 65), e.button(true, 1, 1, 1), e.wheel(1, 1, 1, 1), e.releaseAll(), e.move(2, 2)]
      .map((b) => new DataView(b.buffer).getUint32(4));
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a new session starts over at 1', () => {
    const first = new InputEncoder();
    first.move(1, 1);
    first.move(1, 1);
    expect(new DataView(new InputEncoder().move(1, 1).buffer).getUint32(4)).toBe(1);
  });

  it('seq wraps as a u32', () => {
    const e = new InputEncoder();
    (e as unknown as { seq: number }).seq = 0xffffffff;
    expect(new DataView(e.move(1, 1).buffer).getUint32(4)).toBe(0);
    expect(new DataView(e.move(1, 1).buffer).getUint32(4)).toBe(1);
  });

  it('clamps what would not fit, rather than wrapping', () => {
    const e = new InputEncoder();
    const v = new DataView(e.wheel(-5, 70000, -40000, 40000).buffer);
    expect(v.getUint16(8)).toBe(0);
    expect(v.getUint16(10)).toBe(65535);
    expect(v.getInt16(12)).toBe(-32768);
    expect(v.getInt16(14)).toBe(32767);
  });
});

describe('contentBox: object-fit contain', () => {
  const el = { left: 10, top: 20, width: 1000, height: 1000 };

  it('wide picture: bars above and below', () => {
    const b = contentBox(el, 1920, 1080);
    expect(b.left).toBeCloseTo(10);
    expect(b.width).toBeCloseTo(1000);
    expect(b.height).toBeCloseTo(562.5);
    expect(b.top).toBeCloseTo(20 + 218.75);
  });

  it('tall picture: bars left and right', () => {
    const b = contentBox(el, 1080, 1920);
    expect(b.top).toBeCloseTo(20);
    expect(b.height).toBeCloseTo(1000);
    expect(b.width).toBeCloseTo(562.5);
    expect(b.left).toBeCloseTo(10 + 218.75);
  });

  it('a 1280x800 picture on a smaller desk: 16:10, in a 16:9 element and a 16:10 one', () => {
    const wide = contentBox({ left: 0, top: 0, width: 1600, height: 900 }, 1280, 800);
    expect(wide.height).toBeCloseTo(900);
    expect(wide.width).toBeCloseTo(1440);
    expect(wide.left).toBeCloseTo(80);
    expect(contentBox({ left: 0, top: 0, width: 1280, height: 800 }, 1280, 800)).toEqual({ left: 0, top: 0, width: 1280, height: 800 });
  });

  it('same shape: no bars', () => {
    expect(contentBox({ left: 0, top: 0, width: 1920, height: 1080 }, 1280, 720)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it('no picture yet: the whole element', () => {
    expect(contentBox(el, 0, 0)).toEqual(el);
  });

  it('a remote size change moves the box with no signaling at all', () => {
    expect(contentBox(el, 1000, 500).height).toBe(500);
    expect(contentBox(el, 500, 1000).width).toBe(500);
  });
});

describe('normalized', () => {
  it('follows the formula', () => {
    expect(normalized(0, 0, 100)).toBe(0);
    expect(normalized(100, 0, 100)).toBe(65535);
    expect(normalized(50, 0, 100)).toBe(Math.round(65535 / 2));
    expect(normalized(133, 100, 66)).toBe(Math.round((65535 * 33) / 66));
  });

  it('clamps a position on the letterbox bars to the picture edge', () => {
    expect(normalized(5, 10, 100)).toBe(0);
    expect(normalized(500, 10, 100)).toBe(65535);
  });

  it('has an answer for an element with no size', () => {
    expect(normalized(5, 0, 0)).toBe(0);
  });
});

describe('buttonChanges', () => {
  it('maps the DOM bits to X buttons, right and middle included', () => {
    expect(buttonChanges(0, 1)).toEqual([{ button: 1, down: true }]);
    expect(buttonChanges(0, 2)).toEqual([{ button: 3, down: true }]);
    expect(buttonChanges(0, 4)).toEqual([{ button: 2, down: true }]);
    expect(buttonChanges(0, 8)).toEqual([{ button: 8, down: true }]);
    expect(buttonChanges(0, 16)).toEqual([{ button: 9, down: true }]);
    expect(buttonChanges(16, 0)).toEqual([{ button: 9, down: false }]);
  });

  it('catches a chord, which pointerdown never reports', () => {
    expect(buttonChanges(1, 3)).toEqual([{ button: 3, down: true }]);
    expect(buttonChanges(3, 1)).toEqual([{ button: 3, down: false }]);
    expect(buttonChanges(1, 2)).toEqual([{ button: 1, down: false }, { button: 3, down: true }]);
  });

  it('nothing changed, nothing to send', () => {
    expect(buttonChanges(5, 5)).toEqual([]);
  });
});

describe('wheel', () => {
  it('multiplies lines by 16 and pages by the picture height', () => {
    expect(wheelPixels(3, 0, 800)).toBe(3);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(-1, 2, 800)).toBe(-800);
  });

  it('adds up a frame and sends it once', () => {
    const w = new WheelSum();
    w.add(0, 10);
    w.add(1, 20);
    expect(w.take()).toEqual({ dx: 1, dy: 30 });
    expect(w.take()).toBeNull();
  });

  it('keeps fractions for the next frame, so a trackpad loses no distance', () => {
    const w = new WheelSum();
    w.add(0, 0.6);
    expect(w.take()).toBeNull();
    w.add(0, 0.6);
    expect(w.take()).toEqual({ dx: 0, dy: 1 });
    w.add(0, -0.4);
    expect(w.take()).toBeNull();
    w.add(0, -0.5);
    expect(w.take()).toBeNull();
    w.add(0, -0.5);
    expect(w.take()).toEqual({ dx: 0, dy: -1 });
  });

  it('holds anything past an i16 for the next frame', () => {
    const w = new WheelSum();
    w.add(0, 40000);
    expect(w.take()).toEqual({ dx: 0, dy: 32767 });
    expect(w.hasMore()).toBe(true);
    expect(w.take()).toEqual({ dx: 0, dy: 7233 });
    expect(w.hasMore()).toBe(false);
  });
});

describe('keysymFor', () => {
  const sym = (key: string, code = ''): number | null => keysymFor(key, code, false);

  it.each([
    ['Backspace', 0xff08], ['Tab', 0xff09], ['Enter', 0xff0d], ['Pause', 0xff13], ['ScrollLock', 0xff14], ['Escape', 0xff1b], ['Delete', 0xffff],
    ['F1', 0xffbe], ['F12', 0xffc9], ['Home', 0xff50], ['ArrowLeft', 0xff51], ['ArrowUp', 0xff52], ['ArrowRight', 0xff53], ['ArrowDown', 0xff54],
    ['PageUp', 0xff55], ['PageDown', 0xff56], ['End', 0xff57], ['Shift', 0xffe1], ['Control', 0xffe3], ['Alt', 0xffe9], ['Meta', 0xffeb],
    ['AltGraph', 0xfe03], ['ContextMenu', 0xff67], ['Insert', 0xff63], ['PrintScreen', 0xff61],
  ] as [string, number][])('%s is in the table', (key, want) => {
    expect(sym(key)).toBe(want);
  });

  it('a character below U+0100 is its code point', () => {
    expect(sym('a')).toBe(0x61);
    expect(sym('A')).toBe(0x41);
    expect(sym(' ')).toBe(0x20);
    expect(sym('é')).toBe(0xe9);
    expect(sym('ÿ')).toBe(0xff);
  });

  it('any other character is 0x01000000 + its code point', () => {
    expect(sym('Ā')).toBe(0x01000100);
    expect(sym('€')).toBe(0x010020ac);
  });

  it('an astral character is one code point, not two surrogates', () => {
    expect(sym('😀')).toBe(0x0101f600);
    expect('😀'.length).toBe(2);
  });

  it.each(['CapsLock', 'NumLock', 'Dead', 'Process', 'Unidentified', 'AudioVolumeUp', 'F13', ''])('%s is not sent', (key) => {
    expect(sym(key)).toBeNull();
  });

  it('right-hand modifiers come from code', () => {
    expect(sym('Shift', 'ShiftRight')).toBe(0xffe2);
    expect(sym('Control', 'ControlRight')).toBe(0xffe4);
    expect(sym('Alt', 'AltRight')).toBe(0xffea);
    expect(sym('Shift', 'ShiftLeft')).toBe(0xffe1);
    expect(sym('AltGraph', 'AltRight')).toBe(0xfe03);
  });

  it('on a Mac, Cmd is Control, and plain Meta stays Meta elsewhere', () => {
    expect(keysymFor('Meta', 'MetaLeft', true)).toBe(0xffe3);
    expect(keysymFor('Meta', 'MetaRight', true)).toBe(0xffe4);
    expect(keysymFor('Meta', 'MetaLeft', false)).toBe(0xffeb);
    expect(keysymFor('Control', 'ControlLeft', true)).toBe(0xffe3);
  });
});

describe('HeldKeys', () => {
  it('keyup sends what keydown sent, even if Shift changed in between', () => {
    const k = new HeldKeys();
    expect(k.down('a', 'KeyA', false)).toBe(0x61);
    expect(k.up('A', 'KeyA')).toBe(0x61);
  });

  it('a repeat sends what the first keydown did', () => {
    const k = new HeldKeys();
    expect(k.down('a', 'KeyA', false)).toBe(0x61);
    expect(k.down('A', 'KeyA', false)).toBe(0x61);
    expect(k.up('A', 'KeyA')).toBe(0x61);
    expect(k.up('A', 'KeyA')).toBeNull();
  });

  it('a keyup with no keydown here sends nothing', () => {
    expect(new HeldKeys().up('a', 'KeyA')).toBeNull();
  });

  it('a key that is not sent is not remembered', () => {
    const k = new HeldKeys();
    expect(k.down('Dead', 'Quote', false)).toBeNull();
    expect(k.up('Dead', 'Quote')).toBeNull();
  });

  it('with no code, the key itself is the name', () => {
    const k = new HeldKeys();
    expect(k.down('a', '', false)).toBe(0x61);
    expect(k.up('a', '')).toBe(0x61);
  });

  it('releaseAll gives back everything held, for Cmd coming up on a Mac', () => {
    const k = new HeldKeys();
    k.down('Meta', 'MetaLeft', true);
    k.down('c', 'KeyC', true);
    expect(k.releaseAll()).toEqual([0xffe3, 0x63]);
    expect(k.up('c', 'KeyC')).toBeNull();
  });
});

describe('the clipboard\'s keys', () => {
  const press = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('a copy or cut chord, and nothing that only looks like one', () => {
    for (const key of ['c', 'C', 'x', 'X', 'Insert']) expect(isCopyChord(press(key, { ctrlKey: true }), false)).toBe(true);
    expect(isCopyChord(press('Delete', { shiftKey: true }), false)).toBe(true);
    expect(isCopyChord(press('c'), false)).toBe(false);
    expect(isCopyChord(press('v', { ctrlKey: true }), false)).toBe(false);
    expect(isCopyChord(press('a', { ctrlKey: true }), false)).toBe(false);
    expect(isCopyChord(press('c', { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isCopyChord(press('c', { ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isCopyChord(press('Delete'), false)).toBe(false);
    expect(isCopyChord(press('Insert', { shiftKey: true }), false)).toBe(false);
    expect(isCopyChord(press('Delete', { shiftKey: true, ctrlKey: true }), false)).toBe(false);
  });

  it('on a Mac Cmd is Control, and physical Control does the same on the desk. Elsewhere Meta is nothing', () => {
    expect(isCopyChord(press('c', { metaKey: true }), true)).toBe(true);
    expect(isCopyChord(press('x', { metaKey: true }), true)).toBe(true);
    expect(isCopyChord(press('c', { ctrlKey: true }), true)).toBe(true);
    expect(isCopyChord(press('c', { metaKey: true }), false)).toBe(false);
  });

  it('the paste key brings its own Control only if nothing is holding one', () => {
    const v = [{ down: true, keysym: 0x76 }, { down: false, keysym: 0x76 }];
    expect(pasteKeys(true)).toEqual(v);
    expect(pasteKeys(false)).toEqual([{ down: true, keysym: 0xffe3 }, ...v, { down: false, keysym: 0xffe3 }]);
  });

  it('knows when Control is held, either side, and Cmd on a Mac counts', () => {
    const k = new HeldKeys();
    expect(k.controlHeld()).toBe(false);
    k.down('a', 'KeyA', false);
    expect(k.controlHeld()).toBe(false);
    k.down('Control', 'ControlLeft', false);
    expect(k.controlHeld()).toBe(true);
    k.up('Control', 'ControlLeft');
    expect(k.controlHeld()).toBe(false);
    k.down('Control', 'ControlRight', false);
    expect(k.controlHeld()).toBe(true);
    k.clear();
    k.down('Meta', 'MetaLeft', true);
    expect(k.controlHeld()).toBe(true);
    k.clear();
    k.down('Meta', 'MetaLeft', false);
    expect(k.controlHeld()).toBe(false);
  });
});

describe('keyAction', () => {
  const press = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('sends ordinary keys, and Esc is the web page\'s', () => {
    expect(keyAction(press('a'), false)).toBe('send');
    expect(keyAction(press('Escape'), false)).toBe('send');
    expect(keyAction(press('Tab'), false)).toBe('send');
    expect(keyAction(press('Tab', { shiftKey: true }), false)).toBe('send');
    expect(keyAction(press('r', { ctrlKey: true }), false)).toBe('send');
    expect(keyAction(press('f', { ctrlKey: true }), false)).toBe('send');
    expect(keyAction(press('c', { ctrlKey: true }), false)).toBe('send');
    expect(keyAction(press('F5'), false)).toBe('send');
  });

  it('Shift+Esc always leaves', () => {
    expect(keyAction(press('Escape', { shiftKey: true }), false)).toBe('leave');
  });

  it.each(['w', 't', 'n', 'W', 'T', 'N'])('Ctrl+%s stays with the member\'s browser', (key) => {
    expect(keyAction(press(key, { ctrlKey: true }), false)).toBe('leave');
    expect(keyAction(press(key, { metaKey: true }), true)).toBe('leave');
    expect(keyAction(press(key, { ctrlKey: true, shiftKey: true }), false)).toBe('leave');
  });

  it('Ctrl+Tab and Ctrl+PageUp switch the member\'s own tabs', () => {
    expect(keyAction(press('Tab', { ctrlKey: true }), false)).toBe('leave');
    expect(keyAction(press('PageUp', { ctrlKey: true }), false)).toBe('leave');
    expect(keyAction(press('PageDown', { ctrlKey: true }), false)).toBe('leave');
  });

  it('on a Mac the command key is Cmd, so Ctrl+W goes to the page', () => {
    expect(keyAction(press('w', { ctrlKey: true }), true)).toBe('send');
    expect(keyAction(press('q', { metaKey: true }), true)).toBe('leave');
    expect(keyAction(press('h', { metaKey: true }), true)).toBe('leave');
    expect(keyAction(press('q', { ctrlKey: true }), false)).toBe('send');
  });

  it('Ctrl+L and Alt+D are the way to the address bar', () => {
    expect(keyAction(press('l', { ctrlKey: true }), false)).toBe('address');
    expect(keyAction(press('L', { ctrlKey: true }), false)).toBe('address');
    expect(keyAction(press('d', { altKey: true }), false)).toBe('address');
    expect(keyAction(press('l', { metaKey: true }), true)).toBe('address');
    expect(keyAction(press('d', { altKey: true }), true)).toBe('send'); // Option+D types a character
  });

  it('paste keys become a paste event, not a key', () => {
    expect(keyAction(press('v', { ctrlKey: true }), false)).toBe('paste');
    expect(keyAction(press('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
    expect(keyAction(press('v', { metaKey: true }), true)).toBe('paste');
    expect(keyAction(press('Insert', { shiftKey: true }), false)).toBe('paste');
    expect(keyAction(press('Insert'), false)).toBe('send');
  });

  it('leaves the member\'s fullscreen and developer tools alone', () => {
    expect(keyAction(press('F11'), false)).toBe('leave');
    expect(keyAction(press('F12'), false)).toBe('leave');
    expect(keyAction(press('I', { ctrlKey: true, shiftKey: true }), false)).toBe('leave');
    expect(keyAction(press('i', { metaKey: true, altKey: true }), true)).toBe('leave');
  });
});

describe('cursorCss', () => {
  const message = (hotX: number, hotY: number, w: number, h: number, png: number[] = []): Uint8Array => {
    const b = new Uint8Array(10 + png.length);
    const v = new DataView(b.buffer);
    b[0] = 0x81;
    v.setUint16(2, hotX);
    v.setUint16(4, hotY);
    v.setUint16(6, w);
    v.setUint16(8, h);
    b.set(png, 10);
    return b;
  };

  it('0 by 0 means hidden', () => {
    expect(cursorCss(message(0, 0, 0, 0))).toBe('none');
  });

  it('a size with no PNG did not fit: auto', () => {
    expect(cursorCss(message(1, 2, 64, 64))).toBe('auto');
  });

  it('builds the value from the hot spot and the PNG', () => {
    expect(cursorCss(message(4, 7, 16, 16, [0x89, 0x50, 0x4e, 0x47]))).toBe('url(data:image/png;base64,iVBORw==) 4 7, auto');
  });

  it('refuses anything that is not a CURSOR', () => {
    expect(cursorCss(new Uint8Array(9))).toBeNull();
    const other = message(0, 0, 0, 0);
    other[0] = 0x01;
    expect(cursorCss(other)).toBeNull();
  });

  it('reads from a view into a bigger buffer', () => {
    const outer = new Uint8Array(20);
    outer.set(message(3, 5, 0, 0), 5);
    expect(cursorCss(outer.subarray(5, 15))).toBe('none');
  });

  it('nothing from the wire can break out of the CSS value', () => {
    const quote = [...new TextEncoder().encode(');}body{background:red')];
    const css = cursorCss(message(0, 0, 16, 16, quote)) ?? '';
    expect(css).toMatch(/^url\(data:image\/png;base64,[A-Za-z0-9+/=]+\) 0 0, auto$/);
  });
});
