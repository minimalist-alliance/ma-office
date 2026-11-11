// Real input on the stream: native listeners that write straight to the channels (docs/interfaces/desk-runtime.md
// 8.6). No React state here, and nothing per event but two numbers until the next display frame. The arithmetic
// and the wire format are `desk/rtc/input.ts`, which is pure and unit tested. This is the DOM around it.
//
// Keys go to a hidden textarea, because only an editable element gets composition and paste events. Focus on it
// is what "the stream has focus" means, so the address bar and the shell's own shortcuts can't leak in.
//
// A finger is `touchInput.ts`'s: every `pointerType: 'touch'` event goes there, and none of it comes through here. A phone's
// own keyboard is `softKeyboard.ts`'s while a finger's screen types: text then goes only by `input` events, as a run.
import type { BrowserInput } from '../desk/deskLink';
import { buttonChanges, contentBox, HeldKeys, isCopyChord, keyAction, normalized, pasteKeys, wheelPixels, WheelSum, type Box } from '../desk/rtc/input';
import { keysToDesk } from '../shell/keyLock';
import { bindSoftKeyboard, type SoftKeyboard, type SoftState } from './softKeyboard';
import { bindTouchControl, type TouchControl, type ZoomState } from './touchInput';

/** The X number for the primary button, which is how a click reaches a page's Copy button or a menu's Copy. */
const PRIMARY_BUTTON = 1;

export interface StreamInputOptions {
  video: HTMLVideoElement;
  keys: HTMLTextAreaElement;
  /** Null while there's no session: the event goes nowhere. */
  input(): BrowserInput | null;
  isMac: boolean;
  /** Ctrl+L or Alt+D: leave the stream for the address bar. */
  onAddress(): void;
  /** Composed text, for `browser.text.insert`. Settles once the desk has answered, either way. */
  onText(text: string): void | Promise<unknown>;
  /** A real paste. `pressKey` sends the paste key, for once the text is on the desk. `repeat`: the paste key is being held. */
  onPaste(text: string, pressKey: () => void, repeat: boolean): void;
  /** A copy or cut chord (`chord`), or a click, has just gone to the stream. Called in the event, so the member's browser sees their gesture. */
  onCopyGesture(chord: boolean): void;
  onFocusChange(focused: boolean): void;
  /** Real input on this desk. Called on every event, so it has to be cheap. */
  onInput(): void;
  /** The first finger on the picture since it was bound: the touch hint's moment. */
  onTouch(): void;
  /** Every finger is up after a gesture on the picture. */
  onTouchGesture?(): void;
  /** The picture's zoom, for the page row, told only when what it shows changes. */
  onZoom?(state: ZoomState): void;
  /** Touch control's handle for the page row's zoom buttons, and null as it goes. */
  onTouchControl?(control: TouchControl | null): void;
  /** The phone view's region of the picture while it's this phone's (`phoneView.ts`), or null. */
  region?(): { x: number; y: number; width: number; height: number; screenWidth: number; screenHeight: number } | null;
  /** The phone keyboard's handle for the page row, and null as it goes. */
  onSoftKeyboard?(keyboard: SoftKeyboard | null): void;
  onSoftState?(state: SoftState): void;
}

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function bindStreamInput(o: StreamInputOptions): () => void {
  const { video, keys, isMac } = o;
  const held = new HeldKeys();
  const wheel = new WheelSum();
  let frame = 0;
  let lastX = 0;
  let lastY = 0;
  let moved = false;
  let pressed = 0;
  let composing = false;
  /** The keydown that led to the coming `paste` was the key held down. */
  let pasteRepeat = false;
  const soft = bindSoftKeyboard({ keys, input: o.input, insertText: o.onText, onInput: o.onInput, onCopyGesture: o.onCopyGesture, onChange: (st) => o.onSoftState?.(st) });
  const touch = bindTouchControl({
    video,
    input: o.input,
    onInput: o.onInput,
    onCopyGesture: o.onCopyGesture,
    onTouch: o.onTouch,
    onGesture: o.onTouchGesture,
    onZoom: o.onZoom,
    onFinger: soft.newRun,
    ...(o.region ? { region: o.region } : {}),
  });
  o.onTouchControl?.(touch);
  o.onSoftKeyboard?.(soft);
  /** When a pointer last went down here: a click with none just before it is a screen reader's. */
  let pointerAt = -Infinity;

  // Read when it's needed, so a window drag or a new remote size is never stale.
  const picture = (): Box => contentBox(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);

  const flush = (): void => {
    frame = 0;
    const sink = o.input();
    if (!sink) {
      moved = false;
      wheel.reset();
      return;
    }
    const b = picture();
    const x = normalized(lastX, b.left, b.width);
    const y = normalized(lastY, b.top, b.height);
    const scroll = wheel.take();
    if (scroll) {
      sink.wheel(x, y, scroll.dx, scroll.dy);
      moved = false; // it carries its position
    }
    // A MOVE that can't go now is dropped, not queued: only the newest position is ever kept.
    if (moved && sink.move(x, y)) moved = false;
    if (moved || wheel.hasMore()) schedule();
  };

  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  /** Anything waiting goes before a button, so a scroll and a click can't swap. */
  const flushNow = (): void => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    flush();
  };

  const syncButtons = (e: PointerEvent): void => {
    const changes = buttonChanges(pressed, e.buttons);
    if (!changes.length) return;
    pressed = e.buttons;
    lastX = e.clientX;
    lastY = e.clientY;
    moved = false; // the BUTTON carries its position
    flushNow();
    const sink = o.input();
    if (!sink) return;
    const b = picture();
    const x = normalized(lastX, b.left, b.width);
    const y = normalized(lastY, b.top, b.height);
    for (const c of changes) {
      sink.button(c.down, c.button, x, y);
      // A page's own Copy button or Chromium's menu copies on the release of a click (deskd API.md section 10).
      if (c.button === PRIMARY_BUTTON && !c.down) o.onCopyGesture(false);
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      touch.move(e);
      return;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    // A chord shows only here. With nothing of ours pressed, a held button is a drag from outside, and it's not ours.
    if (pressed && e.buttons !== pressed) syncButtons(e);
    moved = true;
    schedule();
    o.onInput();
  };

  const onPointerDown = (e: PointerEvent): void => {
    pointerAt = e.timeStamp;
    if (e.pointerType === 'touch') {
      touch.down(e);
      return;
    }
    video.setPointerCapture(e.pointerId); // an up outside still arrives
    // An input method's popup opens at the caret, so put the caret where the click was. One write, per click.
    const r = video.getBoundingClientRect();
    keys.style.left = `${e.clientX - r.left}px`;
    keys.style.top = `${e.clientY - r.top}px`;
    keys.focus({ preventScroll: true });
    syncButtons(e);
    o.onInput();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') touch.up(e);
    else syncButtons(e);
  };

  /** A finger's capture goes as it lifts, every time: that's `pointerup`'s, so it's nothing here. */
  const onPointerGone = (e: PointerEvent): void => {
    if (!pressed || e.pointerType === 'touch') return;
    const sink = o.input();
    const b = picture();
    const x = normalized(lastX, b.left, b.width);
    const y = normalized(lastY, b.top, b.height);
    for (const c of buttonChanges(pressed, 0)) sink?.button(c.down, c.button, x, y);
    pressed = 0;
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') touch.cancel(e);
    else onPointerGone(e);
  };

  /**
   * VoiceOver's or TalkBack's double tap is a `click` with no pointer before it (`detail` 0). It never reaches the page (it
   * would press the middle of it); it gives the keys focus, so a keyboard paired to the phone drives the page.
   */
  const onClick = (e: MouseEvent): void => {
    if (e.detail !== 0 || e.timeStamp - pointerAt < 1_000) return;
    keys.focus({ preventScroll: true });
  };

  // The defaults that would act on this page, not the remote one: focus moving off the keys, text selection,
  // middle-click autoscroll, back and forward, the context menu.
  const preventDefault = (e: Event): void => e.preventDefault();
  const onMouseUp = (e: MouseEvent): void => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // so the app doesn't zoom or swipe
    lastX = e.clientX;
    lastY = e.clientY;
    const height = e.deltaMode === 2 ? picture().height : 0;
    wheel.add(wheelPixels(e.deltaX, e.deltaMode, height), wheelPixels(e.deltaY, e.deltaMode, height));
    schedule();
    o.onInput();
  };

  const consume = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (soft.textKey(e)) return; // the phone's keyboard: its text comes as `input`, in the run
    if (e.isComposing) return; // its text comes at compositionend
    const action = keyAction(e, isMac, keysToDesk());
    if (action === 'leave') return;
    if (action === 'paste') {
      pasteRepeat = e.repeat;
      e.stopPropagation(); // the browser now fires `paste` here, and the remote page sees the key only once the text is there
      return;
    }
    if (action === 'address') {
      consume(e);
      o.onAddress();
      return;
    }
    const sym = held.down(e.key, e.code, isMac);
    if (sym === null) return; // CapsLock, Dead, Process, Unidentified
    consume(e);
    const sink = o.input();
    sink?.key(true, sym);
    if (sink && !e.repeat && isCopyChord(e, isMac)) o.onCopyGesture(true);
    soft.sentKey(e.key);
    o.onInput();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const sym = held.up(e.key, e.code);
    if (sym === null) return;
    consume(e);
    const sink = o.input();
    if (isMac && e.key === 'Meta') {
      // macOS sends no keyup for keys released while Cmd is down.
      for (const other of held.releaseAll()) sink?.key(false, other);
    }
    sink?.key(false, sym);
  };

  const releaseEverything = (): void => {
    touch.stop();
    held.clear();
    pressed = 0;
    wheel.reset();
    moved = false;
    o.input()?.releaseAll();
  };

  const onKeysFocus = (): void => {
    soft.focus();
    o.onFocusChange(true);
  };

  const onKeysBlur = (): void => {
    soft.blur();
    o.onFocusChange(false);
    releaseEverything(); // their keyups go elsewhere now
  };

  const onVisibility = (): void => {
    if (document.hidden) releaseEverything();
  };

  const onCompositionStart = (): void => {
    composing = true;
  };

  const onCompositionEnd = (e: CompositionEvent): void => {
    composing = false;
    if (soft.active()) return; // the run has had it as it was typed
    keys.value = '';
    if (e.data) void o.onText(e.data);
  };

  const onBeforeInput = (e: InputEvent): void => {
    soft.beforeInput(e);
  };

  /** Text that came with no key: an emoji picker, dictation, a virtual keyboard's `Unidentified`. */
  const onTextInput = (e: Event): void => {
    if (soft.active()) {
      soft.inputEvent(e);
      return;
    }
    if (composing || !keys.value) return;
    const text = keys.value;
    keys.value = '';
    void o.onText(text);
  };

  /** What a real paste does on the desk, once `browser.clipboard.write` has answered. Read now: the member may have let go. */
  const pressPaste = (): void => {
    const sink = o.input();
    if (!sink) return;
    for (const k of pasteKeys(held.controlHeld())) sink.key(k.down, k.keysym);
    o.onInput();
  };

  /** The one place the member's clipboard is read, and only because they pasted. It needs no permission prompt. */
  const onPaste = (e: ClipboardEvent): void => {
    consume(e);
    const repeat = pasteRepeat;
    pasteRepeat = false;
    const text = e.clipboardData?.getData('text/plain');
    if (text) o.onPaste(text, pressPaste, repeat);
  };

  const add = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): (() => void) => {
    el.addEventListener(type, fn, options);
    return () => el.removeEventListener(type, fn, options);
  };

  const off = [
    add(video, 'pointermove', onPointerMove),
    add(video, 'pointerdown', onPointerDown),
    add(video, 'pointerup', onPointerUp),
    add(video, 'pointercancel', onPointerCancel),
    add(video, 'lostpointercapture', onPointerGone),
    add(video, 'mousedown', preventDefault),
    add(video, 'mouseup', onMouseUp),
    add(video, 'auxclick', preventDefault),
    add(video, 'contextmenu', preventDefault),
    add(video, 'click', onClick),
    add(video, 'wheel', onWheel, { passive: false }),
    add(keys, 'keydown', onKeyDown),
    add(keys, 'keyup', onKeyUp),
    add(keys, 'focus', onKeysFocus),
    add(keys, 'blur', onKeysBlur),
    add(keys, 'compositionstart', onCompositionStart),
    add(keys, 'compositionend', onCompositionEnd),
    add(keys, 'beforeinput', onBeforeInput),
    add(keys, 'input', onTextInput),
    add(keys, 'paste', onPaste),
  ];
  window.addEventListener('blur', releaseEverything);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    for (const fn of off) fn();
    o.onTouchControl?.(null);
    o.onSoftKeyboard?.(null);
    touch.dispose();
    soft.dispose();
    window.removeEventListener('blur', releaseEverything);
    document.removeEventListener('visibilitychange', onVisibility);
    cancelAnimationFrame(frame);
  };
}
