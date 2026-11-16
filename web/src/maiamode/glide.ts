// Her words glide in (the owner, Nov 15: "the words didn't glide in, fade in and write naturally, they appeared instantly and
// abruptly"). Her service answers a step whole, so the reveal is the room's own: a schedule of when each word fades in, at a calm
// reading pace with a breath after each sentence, started a moment after the words arrive and never tied to how they arrived.
// The browser runs it: each word is a span with its own animation delay (opacity and transform only), so nothing here runs per
// frame. Reduced motion shows the words at once.
//
// Her longer part (the owner, Nov 15): after a line with only `<more>`, folded under "More" until the member opens it.

/** The line that starts her longer part (desk-agent's `Restated.MORE`). */
export const MORE = '<more>';

/** Her reply's short part and its longer part, if any. A marker still arriving at the very end isn't shown. */
export function splitMore(text: string): { brief: string; more: string | null } {
  const at = text.indexOf(MORE);
  if (at < 0) {
    // "<", "<m", … "<more" at the end, after a line break: the marker on its way.
    const tail = /\n[ \t]*<(?:m(?:o(?:r(?:e)?)?)?)?$/.exec(text);
    return { brief: (tail ? text.slice(0, tail.index) : text).trim(), more: null };
  }
  const more = text.slice(at + MORE.length).split('</more>').join('').split(MORE).join('').trim();
  return { brief: text.slice(0, at).trim(), more: more || null };
}

/** Paragraphs: a blank line apart. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The pace, in ms. About 11 words a second, a breath after a sentence and a shorter one after a comma. */
export const PACE = {
  /** Words arrive; the first fades in this long after, so a burst settles before anything moves. */
  start: 120,
  word: 90,
  comma: 70,
  sentence: 220,
  paragraph: 320,
  /** Each word's own fade. */
  fade: 460,
  /** A beat after the last word before her choices or "More" come. */
  settle: 160,
  /** However long the reply, the last word starts within this of the first: long replies speed up, never crawl. */
  most: 3200,
} as const;

/** One word as shown: its text, its paragraph and when it starts to fade in, from the first word's start. */
export interface Timed {
  word: string;
  para: number;
  at: number;
}

/**
 * Each word of these paragraphs with its start, in ms after the first: a word's gap is the pace's, plus a breath after a
 * sentence, a comma or a paragraph. When the whole would run past `PACE.most`, every gap shrinks by the same share.
 */
export function schedule(paras: readonly string[]): Timed[] {
  const out: Timed[] = [];
  let t = 0;
  let gaps: number[] = [];
  paras.forEach((p, pi) => {
    const words = p.split(' ').filter(Boolean);
    words.forEach((w, wi) => {
      out.push({ word: w, para: pi, at: 0 });
      const last = wi === words.length - 1;
      const pause = last && pi < paras.length - 1 ? PACE.paragraph : /[.!?…]["”’)]?$/.test(w) ? PACE.sentence : /[,;:]["”’)]?$/.test(w) ? PACE.comma : 0;
      gaps.push(PACE.word + pause);
    });
  });
  gaps = gaps.slice(0, Math.max(0, out.length - 1));
  const total = gaps.reduce((a, b) => a + b, 0);
  const k = total > PACE.most ? PACE.most / total : 1;
  for (let i = 0; i < out.length; i++) {
    out[i]!.at = Math.round(t);
    t += (gaps[i] ?? 0) * k;
  }
  return out;
}

/** When the last word has finished fading in, in ms after the first starts. */
export function finishAt(timed: readonly Timed[]): number {
  const last = timed[timed.length - 1];
  return last ? last.at + PACE.fade : 0;
}

/** Whether the member asked for less motion: the words show at once. */
export function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
