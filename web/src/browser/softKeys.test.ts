// The phone keyboard's run (spec (f) section 3): each edit as the Backspaces and new text that make the desk's field
// match, with arrows for the caret. Every row is something a phone keyboard really does.
import { describe, expect, it } from 'vitest';
import { diff, GUARD, KEY, keysLook, RUN_MAX, SoftRun, textKeys, type Op } from './softKeys';

/** Types `after` (the run, without the guard) with the caret at its end, or at `caret` in the run. */
function edit(run: SoftRun, after: string, caret = after.length): Op[] {
  return run.edit(GUARD + after, GUARD.length + caret);
}
const typed = (text: string, caret = text.length): SoftRun => {
  const r = new SoftRun();
  edit(r, text, caret);
  return r;
};

describe('the run', () => {
  it('letters as they come, each as itself', () => {
    const r = new SoftRun();
    expect(edit(r, 'h')).toEqual([{ text: 'h' }]);
    expect(edit(r, 'hi')).toEqual([{ text: 'i' }]);
    expect(r.value()).toBe(`${GUARD}hi`);
    expect(r.caret).toBe(2);
  });

  it('Backspace takes one character away, and at the start of the run still sends one, with the guard put back', () => {
    const r = typed('ab');
    expect(edit(r, 'a')).toEqual([{ key: KEY.BackSpace, n: 1 }]);
    expect(edit(r, '')).toEqual([{ key: KEY.BackSpace, n: 1 }]);
    // Now the guard itself goes, as when the member keeps pressing: the desk still hears a Backspace.
    expect(r.edit('', 0)).toEqual([{ key: KEY.BackSpace, n: 1 }]);
    expect(r.value()).toBe(GUARD);
    expect(r.caret).toBe(0);
  });

  it('autocorrect fixes the word before: back to its end, take it away, put the fix, and back to the caret', () => {
    const r = typed('teh ');
    expect(edit(r, 'the ')).toEqual([{ key: KEY.Left, n: 1 }, { key: KEY.BackSpace, n: 2 }, { text: 'he' }, { key: KEY.Right, n: 1 }]);
    expect(r.text).toBe('the ');
    expect(r.caret).toBe(4);
  });

  it('a prediction finishes the word and adds the space', () => {
    const r = typed('helo');
    expect(edit(r, 'hello ')).toEqual([{ key: KEY.BackSpace, n: 1 }, { text: 'lo ' }]);
  });

  it('swipe typing and dictation: a whole word or sentence at once, as one piece of text', () => {
    const r = typed('Hi ');
    expect(edit(r, 'Hi there, how was the trip back from the coast?')).toEqual([{ text: 'there, how was the trip back from the coast?' }]);
  });

  it('an emoji is one character to take away', () => {
    const r = typed('ok 👍');
    expect(edit(r, 'ok ')).toEqual([{ key: KEY.BackSpace, n: 1 }]);
    expect(diff('a👍b', 'a👎b')).toEqual({ at: 1, removed: '👍', added: '👎' });
  });

  it("the caret moved with nothing typed (a space bar drag): the desk's goes with it, by characters", () => {
    const r = typed('hello');
    expect(r.moveTo(GUARD.length + 2)).toEqual([{ key: KEY.Left, n: 3 }]);
    expect(edit(r, 'heXllo', 3)).toEqual([{ text: 'X' }]);
    expect(r.moveTo(GUARD.length + 6)).toEqual([{ key: KEY.Right, n: 3 }]);
    expect(r.moveTo(GUARD.length + 6)).toEqual([]);
  });

  it(`a run longer than ${RUN_MAX} starts again`, () => {
    const r = typed('x'.repeat(RUN_MAX));
    edit(r, 'x'.repeat(RUN_MAX + 1));
    expect(r.value()).toBe(GUARD);
  });

  it('text as keys: a line break is Return, a tab is Tab, the rest by keysym', () => {
    expect(textKeys('a\nb\tÄ€')).toEqual([0x61, KEY.Return, 0x62, KEY.Tab, 0xc4, 0x01000000 + 0x20ac]);
  });
});

describe("keys' keyboard for the field", () => {
  it('a message corrects and capitalizes; a search says search', () => {
    expect(keysLook('plain', null)).toEqual({ inputMode: 'text', autocapitalize: 'sentences', corrects: true, autocomplete: 'off', enterKeyHint: 'enter' });
    expect(keysLook('query', null)).toMatchObject({ inputMode: 'search', corrects: true, enterKeyHint: 'search' });
    expect(keysLook('multiline', 'send')).toMatchObject({ corrects: true, enterKeyHint: 'send' });
  });

  it('addresses, numbers and passwords correct nothing and learn nothing', () => {
    expect(keysLook('email_address', 'next')).toEqual({ inputMode: 'email', autocapitalize: 'off', corrects: false, autocomplete: 'off', enterKeyHint: 'next' });
    expect(keysLook('web_address', 'go')).toMatchObject({ inputMode: 'url', corrects: false, enterKeyHint: 'go' });
    expect(keysLook('phone_number', null)).toMatchObject({ inputMode: 'tel', corrects: false });
    expect(keysLook('numeric', null)).toMatchObject({ inputMode: 'numeric', corrects: false });
    expect(keysLook('decimal', null)).toMatchObject({ inputMode: 'decimal', corrects: false });
    expect(keysLook('secret', 'done')).toEqual({ inputMode: 'text', autocapitalize: 'off', corrects: false, autocomplete: 'off', enterKeyHint: 'done' });
  });

  it("with no signal yet, or a field deskd can't see into, nothing is corrected or learned", () => {
    expect(keysLook(null, null)).toEqual({ inputMode: 'text', autocapitalize: 'off', corrects: false, autocomplete: 'off', enterKeyHint: 'enter' });
    expect(keysLook('unknown', 'weird')).toMatchObject({ corrects: false, enterKeyHint: 'enter' });
  });
});
