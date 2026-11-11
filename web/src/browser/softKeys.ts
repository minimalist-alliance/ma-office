// A phone's own keyboard, typing into the desk's page (#12 part 2; the Product Designer's spec (f) section 3, "the run").
// A phone keyboard doesn't send keys: it edits text, and corrects words after they're typed. So the hidden `keys` holds
// the run, what's been typed since the last tap on the page, Enter, Tab, Esc, an arrow or the keyboard opening, after one
// invisible guard character. Each edit is compared with the run before it, and goes to the desk as the Backspaces that
// take away what's gone and the text that's new, with arrows first to put the desk's caret at the end of what changed.
// That one rule covers letters, autocorrect, predictions, swipe typing, dictation and emoji, mid-composition too.
// Pure: no DOM. `streamInput.ts` feeds it and sends what it returns; `softKeys.test.ts` is the table.
import { keysymFor } from '../desk/rtc/input';

/** Before the run, so a Backspace at its start still deletes something here, and goes to the desk. */
export const GUARD = '​';
/** A longer run starts again: nothing on the desk lines up with what the phone remembers past this. */
export const RUN_MAX = 200;
/** More text than this at once (a dictated sentence, the keyboard's clipboard) goes by `browser.text.insert`. */
export const INSERT_PAST = 32;

export const KEY = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Menu: 0xff67,
  Delete: 0xffff,
  Control: 0xffe3,
  Alt: 0xffe9,
} as const;

/** One step for the desk: a key pressed `n` times, or text. */
export type Op = { key: number; n: number } | { text: string };

const points = (s: string): number => [...s].length;

/** What an edit did to the whole value: where it starts, what it took away and what it put in. */
export function diff(before: string, after: string): { at: number; removed: string; added: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p += 1;
  // Never split a surrogate pair at the start.
  if (p > 0 && /[\uDC00-\uDFFF]/.test(before[p] ?? '') && /[\uD800-\uDBFF]/.test(before[p - 1] ?? '')) p -= 1;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1;
  if (s > 0 && /[\uD800-\uDBFF]/.test(before[before.length - 1 - s] ?? '')) s -= 1;
  return { at: p, removed: before.slice(p, before.length - s), added: after.slice(p, after.length - s) };
}

/** Arrows from one place in the run to another, by characters the desk counts. */
function arrows(run: string, from: number, to: number): Op[] {
  if (to === from) return [];
  const n = points(run.slice(Math.min(from, to), Math.max(from, to)));
  return n ? [{ key: to > from ? KEY.Right : KEY.Left, n }] : [];
}

export class SoftRun {
  /** What's been typed since the run began, without the guard. */
  text = '';
  /** Where the desk's caret is in it, in UTF-16 units. */
  caret = 0;

  /** The value `keys` holds for this run. */
  value(): string {
    return GUARD + this.text;
  }

  /** A new run: a tap on the page, Enter, Tab, Esc, an arrow, or the keyboard opening. */
  reset(): void {
    this.text = '';
    this.caret = 0;
  }

  /**
   * `keys` now holds `value`, with its caret at `caret` (`selectionEnd`). The steps for the desk, in order. Afterwards
   * `value()` is what `keys` should hold (the guard put back if it was deleted) and `this.caret` where the caret goes.
   */
  edit(value: string, caret: number): Op[] {
    const before = this.value();
    if (value === before) return this.moveTo(caret);
    const { at, removed, added } = diff(before, value);
    const ops: Op[] = [];
    const guardGone = !value.startsWith(GUARD);
    // In the run's own terms: the guard is at -1.
    const end = at + removed.length - 1;
    ops.push(...arrows(this.text, this.caret, Math.max(0, end)));
    const back = points(removed);
    if (back) ops.push({ key: KEY.BackSpace, n: back });
    if (added) ops.push({ text: added });
    this.text = guardGone ? value : value.slice(GUARD.length);
    this.caret = guardGone ? at + added.length : Math.max(0, at - GUARD.length + added.length);
    const want = Math.max(0, Math.min(this.text.length, (guardGone ? caret : caret - GUARD.length)));
    ops.push(...this.moveTo(want + GUARD.length));
    if (this.text.length > RUN_MAX) this.reset();
    return ops;
  }

  /** The phone's caret moved with nothing typed (iOS's space bar drag, Gboard's space slide): the desk's goes with it. */
  moveTo(caret: number): Op[] {
    const want = Math.max(0, Math.min(this.text.length, caret - GUARD.length));
    const ops = arrows(this.text, this.caret, want);
    this.caret = want;
    return ops;
  }
}

/** Text as key presses: printable characters by keysym, a line break as Return and a tab as Tab. */
export function textKeys(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') out.push(KEY.Return);
    else if (ch === '\t') out.push(KEY.Tab);
    else {
      const sym = keysymFor(ch, '', false);
      if (sym !== null) out.push(sym);
    }
  }
  return out;
}

// ----- `keys` for the field

/** What deskd says has focus (API.md section 10, "On a phone"), in the simplified view's words, or null for no signal. */
export type FieldKind = 'plain' | 'query' | 'email_address' | 'phone_number' | 'web_address' | 'numeric' | 'multiline' | 'decimal' | 'secret' | 'unknown' | string;

export interface KeysLook {
  inputMode: string;
  autocapitalize: string;
  /** `autocorrect` and `spellcheck` together. */
  corrects: boolean;
  autocomplete: string;
  enterKeyHint: string;
}

/**
 * The phone keyboard to ask for (spec (f) section 3's table, in deskd's words). With no signal, or for a field deskd can't
 * see into, nothing is corrected or learned: before the signal a password can't be told from a message.
 */
export function keysLook(kind: FieldKind | null, enterKey: string | null): KeysLook {
  const quiet = { autocapitalize: 'off', corrects: false, autocomplete: 'off' };
  const look = ((): Omit<KeysLook, 'enterKeyHint'> => {
    switch (kind) {
      case 'plain':
      case 'multiline':
        return { inputMode: 'text', autocapitalize: 'sentences', corrects: true, autocomplete: 'off' };
      case 'query':
        return { inputMode: 'search', autocapitalize: 'sentences', corrects: true, autocomplete: 'off' };
      case 'email_address':
        return { inputMode: 'email', ...quiet };
      case 'web_address':
        return { inputMode: 'url', ...quiet };
      case 'phone_number':
        return { inputMode: 'tel', ...quiet };
      case 'numeric':
        return { inputMode: 'numeric', ...quiet };
      case 'decimal':
        return { inputMode: 'decimal', ...quiet };
      default:
        // `secret`, `unknown`, anything new, or no signal at all.
        return { inputMode: 'text', ...quiet };
    }
  })();
  const enter = enterKey && ['enter', 'done', 'go', 'next', 'previous', 'search', 'send'].includes(enterKey) ? enterKey : kind === 'query' ? 'search' : 'enter';
  return { ...look, enterKeyHint: enter };
}
