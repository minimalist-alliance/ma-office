// Her words' glide and her longer part (`glide.ts`, the owner, Nov 15): the pace, the breath after a sentence, long replies never
// crawling, and the short reply split from the longer part, never showing a marker on its way.
import { describe, expect, it } from 'vitest';
import { MORE, PACE, finishAt, paragraphs, schedule, splitMore } from './glide';

describe('splitMore', () => {
  it('a reply with no longer part is all short', () => {
    expect(splitMore('Welcome. I’m glad you’re here.')).toEqual({ brief: 'Welcome. I’m glad you’re here.', more: null });
  });

  it('the longer part is what follows its line, closing tag or not', () => {
    expect(splitMore(`Three laptops fit.\n${MORE}\nThe Aero is lightest.\n\nThe Swift lasts longest.`)).toEqual({
      brief: 'Three laptops fit.',
      more: 'The Aero is lightest.\n\nThe Swift lasts longest.',
    });
    expect(splitMore(`Short.\n${MORE}\nLonger.</more>`).more).toBe('Longer.');
    expect(splitMore(`Short.\n${MORE}\n  `)).toEqual({ brief: 'Short.', more: null });
  });

  it('a marker still arriving never shows', () => {
    for (const tail of ['<', '<m', '<mo', '<mor', '<more']) expect(splitMore(`Short.\n${tail}`).brief).toBe('Short.');
    expect(splitMore('Use a < b here').brief).toBe('Use a < b here');
  });
});

describe('the pace', () => {
  it('words come at a calm reading pace, with a breath after a sentence and a comma', () => {
    const t = schedule(paragraphs('Welcome. I’m glad you’re here, really. Where would you like to start?'));
    expect(t.map((w) => w.word)).toEqual(['Welcome.', 'I’m', 'glad', 'you’re', 'here,', 'really.', 'Where', 'would', 'you', 'like', 'to', 'start?']);
    expect(t[1]!.at - t[0]!.at).toBe(PACE.word + PACE.sentence);
    expect(t[2]!.at - t[1]!.at).toBe(PACE.word);
    expect(t[5]!.at - t[4]!.at).toBe(PACE.word + PACE.comma);
    // About 11 words a second between plain words: unhurried, never a dump.
    expect(1000 / PACE.word).toBeGreaterThan(9);
    expect(1000 / PACE.word).toBeLessThan(14);
    // The whole first greeting takes about two seconds.
    expect(finishAt(t)).toBeGreaterThan(1200);
    expect(finishAt(t)).toBeLessThan(2600);
  });

  it('a long reply speeds up evenly and never takes longer than the cap', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} has a few more words in it.`).join(' ');
    const t = schedule(paragraphs(long));
    expect(t.length).toBe(300);
    expect(t[t.length - 1]!.at).toBeLessThanOrEqual(PACE.most);
    for (let i = 1; i < t.length; i++) expect(t[i]!.at).toBeGreaterThanOrEqual(t[i - 1]!.at);
  });

  it('paragraphs keep their words and get a longer breath between them', () => {
    const paras = paragraphs('First part here.\n\nSecond part.');
    expect(paras).toEqual(['First part here.', 'Second part.']);
    const t = schedule(paras);
    expect(t.filter((w) => w.para === 1).map((w) => w.word)).toEqual(['Second', 'part.']);
    expect(t[3]!.at - t[2]!.at).toBe(PACE.word + PACE.paragraph);
  });

  it('nothing to show takes no time', () => {
    expect(schedule([])).toEqual([]);
    expect(finishAt([])).toBe(0);
  });
});
