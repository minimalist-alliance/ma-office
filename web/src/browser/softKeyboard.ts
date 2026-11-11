// The phone's own keyboard on the Browser's picture (#12 part 2; spec (f) section 3). `streamInput.ts` binds it to the
// hidden `keys` and hands it the textarea's events while a finger's screen types there; the run itself is `softKeys.ts`.
//
// - **It opens** from the page row's Keyboard button, synchronously in its click (iOS raises a keyboard only for a focus
//   inside the tap), or when deskd says a field took focus in the phone's view (`browser.view`; not on iOS, where the
//   button stays the way in). `keys` takes the field's keyboard (`keysLook`), or one that corrects and learns nothing.
// - **Only `input` and `beforeinput` send text** while it's up: each edit as Backspaces and new text, all as KEY on
//   channel 7 in one ordered path; more than 32 characters at once go by `browser.text.insert`, and the next KEY waits
//   for its answer, since `keys` and `rpc` aren't ordered. `keydown` sends only what changes no text (arrows, Esc, Tab,
//   F-keys, chords), from a keyboard paired to the phone; iOS sends a real `keydown` for a letter, which would type twice.
// - **Enter** is KEY Return and a new run; the newline never stays in `keys`.
// - **Ctrl and Alt stick** (the key row's toggles): on for the next key, from the row or the phone's keyboard, which goes as
//   a chord and never into the run; a second tap within 300 ms locks it on. Ctrl and C or X is a copy gesture.
// - **Hide** blurs `keys`, which sends RELEASE_ALL as ever.
import type { BrowserInput } from '../desk/deskLink';
import { diff, GUARD, INSERT_PAST, KEY, SoftRun, textKeys, type KeysLook, type Op } from './softKeys';

export type Mod = 'off' | 'once' | 'lock';

export interface SoftState {
  /** `keys` has the focus on a finger's screen: the phone's keyboard is up, or about to be. */
  typing: boolean;
  ctrl: Mod;
  alt: Mod;
}

export const NOT_TYPING: SoftState = { typing: false, ctrl: 'off', alt: 'off' };

export interface SoftKeyboardOptions {
  keys: HTMLTextAreaElement;
  input(): BrowserInput | null;
  /** `browser.text.insert`, settled either way. */
  insertText(text: string): Promise<unknown> | void;
  onInput(): void;
  onCopyGesture(chord: boolean): void;
  onChange(state: SoftState): void;
}

export interface SoftKeyboard {
  /** On a finger's screen, while `keys` has the focus. */
  active(): boolean;
  /** Raise the keyboard: call inside the member's own tap. */
  open(look: KeysLook): void;
  /** The field changed while it's up. */
  look(look: KeysLook): void;
  hide(): void;
  /** A key from the key row, with whatever modifier is on. */
  press(keysym: number): void;
  toggle(mod: 'ctrl' | 'alt'): void;
  /** A tap on the page: the next edit starts a new run. */
  newRun(): void;
  // ----- from `streamInput.ts`'s listeners on `keys`
  focus(): void;
  blur(): void;
  /** True when it took the event (and prevented it). */
  beforeInput(e: InputEvent): boolean;
  inputEvent(e: Event): void;
  /** True when the key is the run's to see, as text: `streamInput.ts` then leaves it alone. */
  textKey(e: KeyboardEvent): boolean;
  /** A key `streamInput.ts` sent (an arrow, Esc, Tab): the run starts again. */
  sentKey(key: string): void;
  dispose(): void;
}

/** A second tap on Ctrl or Alt this soon locks it on. */
const LOCK_MS = 300;
const MOVES_RUN = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Tab', 'Home', 'End', 'PageUp', 'PageDown']);
const RUN_KEYS = new Set<number>([KEY.Escape, KEY.Tab, KEY.Left, KEY.Right, KEY.Up, KEY.Down, KEY.Home, KEY.End, KEY.PageUp, KEY.PageDown, KEY.Return]);
const COPY_KEYS = new Set([0x63, 0x78, 0x43, 0x58]); // c, x, C, X

const coarse = (): boolean => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

export function bindSoftKeyboard(o: SoftKeyboardOptions): SoftKeyboard {
  const { keys } = o;
  const run = new SoftRun();
  let state: SoftState = NOT_TYPING;
  let lastTap: { mod: 'ctrl' | 'alt'; at: number } | null = null;
  /** Steps waiting behind a `browser.text.insert` on its way. */
  const queue: Op[] = [];
  let busy = false;

  const set = (p: Partial<SoftState>): void => {
    const next = { ...state, ...p };
    if (next.typing === state.typing && next.ctrl === state.ctrl && next.alt === state.alt) return;
    state = next;
    o.onChange(state);
  };

  const tap = (sym: number): void => {
    const sink = o.input();
    sink?.key(true, sym);
    sink?.key(false, sym);
  };

  /** One key, with the modifiers that are on, which then go off unless locked. */
  const chord = (sym: number): void => {
    const sink = o.input();
    if (!sink) return;
    const mods = [state.ctrl !== 'off' ? KEY.Control : 0, state.alt !== 'off' ? KEY.Alt : 0].filter(Boolean);
    for (const m of mods) sink.key(true, m);
    tap(sym);
    for (const m of [...mods].reverse()) sink.key(false, m);
    if (state.ctrl !== 'off' && COPY_KEYS.has(sym)) o.onCopyGesture(true);
    set({ ctrl: state.ctrl === 'lock' ? 'lock' : 'off', alt: state.alt === 'lock' ? 'lock' : 'off' });
    o.onInput();
  };

  const pump = (): void => {
    while (!busy && queue.length) {
      const op = queue.shift()!;
      if ('key' in op) {
        for (let i = 0; i < op.n; i += 1) tap(op.key);
      } else if ([...op.text].length > INSERT_PAST) {
        busy = true;
        void Promise.resolve(o.insertText(op.text)).finally(() => {
          busy = false;
          pump();
        });
        return;
      } else {
        for (const sym of textKeys(op.text)) tap(sym);
      }
    }
  };

  const send = (ops: Op[]): void => {
    if (!ops.length) return;
    queue.push(...ops);
    pump();
    o.onInput();
  };

  /** `keys` holds the run's value, with its caret where the run's is. */
  const sync = (): void => {
    const v = run.value();
    if (keys.value !== v) keys.value = v;
    const at = GUARD.length + run.caret;
    if (keys.selectionStart !== at || keys.selectionEnd !== at) keys.setSelectionRange(at, at);
  };

  const fresh = (): void => {
    run.reset();
    sync();
  };

  const apply = (look: KeysLook): void => {
    keys.setAttribute('inputmode', look.inputMode);
    keys.setAttribute('autocapitalize', look.autocapitalize);
    keys.setAttribute('autocorrect', look.corrects ? 'on' : 'off');
    keys.spellcheck = look.corrects;
    keys.setAttribute('autocomplete', look.autocomplete);
    keys.setAttribute('enterkeyhint', look.enterKeyHint);
  };

  /** The phone's caret moved with nothing typed. */
  const onSelection = (): void => {
    if (!state.typing || document.activeElement !== keys || keys.value !== run.value()) return;
    send(run.moveTo(keys.selectionEnd ?? keys.value.length));
  };
  document.addEventListener('selectionchange', onSelection);

  return {
    active: () => state.typing,
    open(look) {
      apply(look);
      // Inside the surface's foot, so the phone doesn't scroll the office to bring it into view.
      keys.style.left = '0px';
      keys.style.top = '';
      keys.style.bottom = '0px';
      fresh();
      keys.focus({ preventScroll: true });
    },
    look: apply,
    hide: () => keys.blur(),
    press(sym) {
      if (state.ctrl !== 'off' || state.alt !== 'off') chord(sym);
      else {
        tap(sym);
        o.onInput();
      }
      if (RUN_KEYS.has(sym)) fresh();
    },
    toggle(mod) {
      const now = performance.now();
      const was = state[mod];
      const quick = lastTap?.mod === mod && now - lastTap.at <= LOCK_MS;
      lastTap = { mod, at: now };
      // Off: on for the next key. On for one: a quick second tap locks it, a slow one turns it off. Locked: off.
      const next: Mod = was === 'off' ? 'once' : was === 'once' && quick ? 'lock' : 'off';
      set(mod === 'ctrl' ? { ctrl: next } : { alt: next });
    },
    newRun: () => {
      if (state.typing) fresh();
      else run.reset();
    },
    focus() {
      if (!coarse()) return;
      fresh();
      set({ typing: true });
    },
    blur() {
      queue.length = 0;
      busy = false;
      set({ typing: false, ctrl: 'off', alt: 'off' });
    },
    beforeInput(e) {
      if (!state.typing) return false;
      if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return false;
      e.preventDefault();
      if (state.ctrl !== 'off' || state.alt !== 'off') chord(KEY.Return);
      else send([{ key: KEY.Return, n: 1 }]);
      fresh();
      return true;
    },
    inputEvent() {
      if (!state.typing) return;
      const before = run.value();
      const d = diff(before, keys.value);
      // A modifier is on and one character came: it goes as a chord, and the run stays as it was.
      if ((state.ctrl !== 'off' || state.alt !== 'off') && !d.removed && [...d.added].length === 1) {
        const sym = textKeys(d.added)[0];
        sync();
        if (sym !== undefined) chord(sym);
        return;
      }
      send(run.edit(keys.value, keys.selectionEnd ?? keys.value.length));
      sync();
    },
    textKey(e) {
      if (!state.typing) return false;
      if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process') return true;
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      return e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter';
    },
    sentKey(key) {
      if (state.typing && MOVES_RUN.has(key)) fresh();
    },
    dispose() {
      document.removeEventListener('selectionchange', onSelection);
      queue.length = 0;
    },
  };
}
