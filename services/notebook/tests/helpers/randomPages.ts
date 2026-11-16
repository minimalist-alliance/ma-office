// Random pages for the Markdown round trip (tests/roundtrip.test.ts): every block, mark, color and attribute the schema
// has, nested, with the text that breaks Markdown writers (delimiters, escapes, entities, spaces at the ends, tabs,
// things that look like a list, a heading, a fence, a color line). From a seed, so a failure names its page. Fake text.
import { TAB_COLORS, type PMNode } from '../../src/model.ts';

type Mark = NonNullable<PMNode['marks']>[number];

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** 0 to n - 1. */
  int(n: number): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s % n;
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)] as T;
  }
  chance(p: number): boolean {
    return this.int(1000) < p * 1000;
  }
}

/** Pieces of text, plain and awkward. */
const PIECES = [
  'plain', 'words here', 'Hello', 'world', 'x', ' ', '  ', '\t', 'a b', 'end.', 'é', 'naïve', '日本語', '😀', ' ', 'Ünïcödé',
  '*', '**', '***', '_', '__', 'snake_case_name', 'a*b*c', '2 * 3', '~', '~~', '~5 min', '`', '``', 'a`b', '\\', '\\*', '[', ']', '[x]',
  '[ ]', '(', ')', '](', '![', '<', '>', '<b>', '</i>', '<br>', '<p></p>', '<div>', 'a < b', '&', '&amp;', '&lt;', '&#32;', '&nbsp;',
  'AT&T', '#', '##', '# not a heading', '#hashtag', 'trail #', '-', '- item', '+', '+ plus', '1.', '2)', '1. one', '|', 'a | b', '!',
  '{color=blue}', '{', '}', '=', '===', '---', '- - -', '___', '>', '> quote', '```', '~~~', 'http://example.com', '<https://x.test>',
  'me@example.com', '\n', 'line\nbreak',
];

const COLORS = [...TAB_COLORS];
const HREFS = [
  'https://example.com',
  'https://example.com/a_(b)?c=1&d=2',
  'http://example.org/path with space',
  'mailto:someone@example.com',
  'https://example.com/<angle>',
  'https://example.com/back\\slash',
];
const TITLES = ['A title', 'with "quotes"', "it's", 'both " and \''];
const LANGUAGES = ['js', 'ts', 'python', 'c++', 'sh', 'go', '`tick', '~tilde', 'x{y}'];

function text(r: Rng): string {
  let s = '';
  const n = 1 + r.int(4);
  for (let i = 0; i < n; i += 1) s += r.pick(PIECES);
  return s;
}

function marks(r: Rng): Mark[] {
  if (r.chance(0.12)) return [{ type: 'code' }];
  const out: Mark[] = [];
  if (r.chance(0.25)) out.push({ type: 'bold' });
  if (r.chance(0.25)) out.push({ type: 'italic' });
  if (r.chance(0.12)) out.push({ type: 'strike' });
  if (r.chance(0.12)) out.push({ type: 'underline' });
  if (r.chance(0.12)) out.push({ type: 'highlight', attrs: { color: r.pick([...COLORS, 'yellow']) } });
  if (r.chance(0.1)) out.push({ type: 'textColor', attrs: { color: r.pick(COLORS) } });
  if (r.chance(0.15)) {
    const attrs: Record<string, unknown> = { href: r.pick(HREFS) };
    if (r.chance(0.3)) attrs['title'] = r.pick(TITLES);
    out.push({ type: 'link', attrs });
  }
  return out;
}

/** A textblock's content: runs of text with marks, and now and then a line break. */
export function inlineContent(r: Rng, max = 6): PMNode[] {
  const out: PMNode[] = [];
  const n = 1 + r.int(max);
  for (let i = 0; i < n; i += 1) {
    if (r.chance(0.08)) out.push({ type: 'hardBreak' });
    else {
      const m = marks(r);
      const t = text(r);
      out.push(m.length ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
    }
  }
  return out;
}

const withColor = (r: Rng, node: PMNode): PMNode => (r.chance(0.12) ? { ...node, attrs: { ...(node.attrs ?? {}), color: r.pick(COLORS) } } : node);

function paragraph(r: Rng): PMNode {
  return withColor(r, r.chance(0.08) ? { type: 'paragraph' } : { type: 'paragraph', content: inlineContent(r) });
}

function codeText(r: Rng): string {
  const lines: string[] = [];
  const n = r.int(5);
  for (let i = 0; i < n; i += 1) lines.push(r.pick(['const a = 1;', '\tindented()', '    four', '', '   ', '```', '````', '~~~', '# not', '- no', '> no', 'x  ', '`a`', '\\n', '<p></p>', '{color=blue}']));
  return lines.join('\n');
}

function item(r: Rng, depth: number, task: boolean): PMNode {
  const content: PMNode[] = [r.chance(0.1) ? { type: 'paragraph' } : { type: 'paragraph', content: inlineContent(r, 4) }];
  if (depth < 4) {
    const extra = r.chance(0.35) ? 1 + r.int(2) : 0;
    for (let i = 0; i < extra; i += 1) content.push(block(r, depth + 1));
  }
  const attrs: Record<string, unknown> = task ? { checked: r.chance(0.5) } : {};
  if (r.chance(0.12)) attrs['color'] = r.pick(COLORS);
  const type = task ? 'taskItem' : 'listItem';
  return Object.keys(attrs).length ? { type, attrs, content } : { type, content };
}

function list(r: Rng, depth: number): PMNode {
  const kind = r.pick(['bulletList', 'orderedList', 'taskList'] as const);
  const n = 1 + r.int(3);
  const items = Array.from({ length: n }, () => item(r, depth, kind === 'taskList'));
  if (kind === 'orderedList') return withColor(r, { type: 'orderedList', attrs: { start: r.pick([1, 1, 1, 0, 3, 9, 10, 99, 123456]) }, content: items });
  return withColor(r, { type: kind, content: items });
}

export function block(r: Rng, depth = 0): PMNode {
  const roll = r.int(100);
  if (roll < 35) return paragraph(r);
  if (roll < 50) return withColor(r, { type: 'heading', attrs: { level: 1 + r.int(3) }, ...(r.chance(0.08) ? {} : { content: inlineContent(r, 4) }) });
  if (roll < 60) {
    const t = codeText(r);
    return withColor(r, { type: 'codeBlock', attrs: { language: r.chance(0.5) ? r.pick(LANGUAGES) : null }, ...(t ? { content: [{ type: 'text', text: t }] } : {}) });
  }
  if (roll < 65) return { type: 'horizontalRule' };
  if (roll < 75 && depth < 4) {
    const n = 1 + r.int(3);
    return withColor(r, { type: 'blockquote', content: Array.from({ length: n }, () => block(r, depth + 1)) });
  }
  if (depth < 4) return list(r, depth);
  return paragraph(r);
}

/** A page: a Title first, as every page has, then blocks. Lists of a kind side by side come up often on purpose. */
export function randomPage(seed: number, blocks = 12): PMNode {
  const r = new Rng(seed);
  const content: PMNode[] = [{ type: 'heading', attrs: { level: 1 }, content: inlineContent(r, 3) }];
  const n = 1 + r.int(blocks);
  for (let i = 0; i < n; i += 1) {
    const b = block(r);
    content.push(b);
    if (b.type.endsWith('List') && r.chance(0.3)) content.push(list(r, 0));
  }
  return { type: 'doc', content };
}
