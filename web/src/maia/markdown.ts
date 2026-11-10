// The Markdown subset Maia's replies may use, parsed to a small tree that `Markdown.tsx` turns into React elements.
// Her text is untrusted (docs/maia.md section 8): there's no raw HTML (a tag is just text), no image of any kind (only
// its alt text shows, and its address is never fetched), and a link only to our own hosts (`links.ts`); any other link
// shows as plain text with its address after it. Pure, and bounded: nesting stops at a fixed depth.
import { ourLink } from './links';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

/** Longer text is cut here, well past any reply. */
const MAX_CHARS = 100_000;
const MAX_BLOCK_DEPTH = 6;
const MAX_INLINE_DEPTH = 8;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

/** Columns of leading whitespace, a tab counting as four. */
function indentOf(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

/** The line less up to `n` columns of leading whitespace. */
function dedent(line: string, n: number): string {
  let w = 0;
  let i = 0;
  while (i < line.length && w < n && (line[i] === ' ' || line[i] === '\t')) {
    w += line[i] === '\t' ? 4 - (w % 4) : 1;
    i += 1;
  }
  return line.slice(i);
}

function isItem(line: string): boolean {
  const m = ITEM.exec(line);
  // A marker alone on its line counts only for a bullet; "1." alone is more likely a number.
  return !!m && (m[3] !== undefined || /^[-*+]$/.test(m[2]!));
}

function fenceOf(line: string): string | null {
  const m = FENCE.exec(line);
  if (!m) return null;
  return m[1]![0] === '`' && m[2]!.includes('`') ? null : m[1]!;
}

function closesFence(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === fence[0] && m[1]!.length >= fence.length;
}

function startsBlock(line: string): boolean {
  return fenceOf(line) !== null || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || isItem(line);
}

export function parseMarkdown(src: string): Block[] {
  const text = String(src ?? '').slice(0, MAX_CHARS).replace(/\r\n?/g, '\n');
  return blocks(text.split('\n'), 0);
}

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i]!, fence)) body.push(lines[i++]!);
      i += 1; // its closing fence; a reply still streaming may not have one yet
      out.push({ t: 'code', v: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: 'h', level: Math.min(3, h[1]!.length) as 1 | 2 | 3, c: parseInline(h[2] ?? '') });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (depth < MAX_BLOCK_DEPTH && QUOTE.test(line)) {
      const body: string[] = [];
      let q: RegExpExecArray | null;
      while (i < lines.length && (q = QUOTE.exec(lines[i]!))) {
        body.push(q[1]!);
        i += 1;
      }
      out.push({ t: 'quote', c: blocks(body, depth + 1) });
      continue;
    }
    if (depth < MAX_BLOCK_DEPTH && isItem(line)) {
      i = list(lines, i, depth, out);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!.trim());
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}

/**
 * One list from line `start`: items of the same kind, each with what's indented under it (more text, code, a nested
 * list) parsed as blocks of its own. Returns the line after it.
 */
function list(lines: string[], start: number, depth: number, out: Block[]): number {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const base = indentOf(first[1]!);
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || !isItem(lines[i]!) || /\d/.test(m[2]!) !== ordered || indentOf(m[1]!) > base + 1) break;
    const indent = indentOf(m[1]!);
    // Where the item's text starts: what's indented under it is read from there.
    const gap = m[3] === undefined ? 1 : lines[i]!.length - m[1]!.length - m[2]!.length - m[3].length;
    const content = indent + m[2]!.length + Math.min(gap, 4);
    const body: string[] = [m[3] ?? ''];
    i += 1;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j]!.trim()) j += 1;
        // A blank line ends the item unless what follows is indented under it.
        if (j < lines.length && indentOf(lines[j]!) > indent + 1) {
          for (; i < j; i += 1) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(line) > indent + 1) {
        body.push(dedent(line, content));
        i += 1;
        continue;
      }
      if (startsBlock(line)) break;
      body.push(line.trim()); // a lazy continuation of the item's text
      i += 1;
    }
    items.push(blocks(body, depth + 1));
    // Blank lines between two items of this list don't end it.
    let j = i;
    while (j < lines.length && !lines[j]!.trim()) j += 1;
    if (j < lines.length && j > i) {
      const next = ITEM.exec(lines[j]!);
      if (next && isItem(lines[j]!) && /\d/.test(next[2]!) === ordered && Math.abs(indentOf(next[1]!) - base) <= 1) i = j;
    }
  }
  out.push({ t: 'list', ordered, start: ordered ? Math.min(Number.parseInt(first[2]!, 10) || 1, 1e9) : 1, items });
  return i;
}

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function runOf(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n += 1;
  return n;
}

/** The end of the code span opened by `n` backticks at `from`, or -1. */
function codeClose(s: string, from: number, n: number): number {
  let j = from;
  while (j < s.length) {
    if (s[j] === '`') {
      const r = runOf(s, j, '`');
      if (r === n) return j;
      j += r;
    } else j += 1;
  }
  return -1;
}

/**
 * Where the emphasis opened by `n` of `ch` closes: a run of exactly `n`, or of three (which closes this and the one
 * inside it), not after a space, and for `_` not inside a word. Code spans and escapes are skipped.
 */
function emphasisClose(s: string, from: number, ch: string, n: number): number {
  let j = from;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const r = runOf(s, j, '`');
      const end = codeClose(s, j + r, r);
      j = end < 0 ? j + r : end + r;
      continue;
    }
    if (c === ch) {
      const r = runOf(s, j, ch);
      const after = s[j + r];
      const closes = j > from && !SPACE.test(s[j - 1]!) && (ch !== '_' || after === undefined || !WORD.test(after));
      if (closes && (r === n || (r === 3 && n < 3))) return j + (r - n);
      j += r;
      continue;
    }
    j += 1;
  }
  return -1;
}

/** `[text](url)` from `i`, the opening bracket: the text, the address and the index after it, or null. */
function linkAt(s: string, i: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j += 1) {
    const c = s[j];
    if (c === '\\') j += 1;
    else if (c === '[') depth += 1;
    else if (c === ']' && --depth === 0) break;
    else if (c === '\n' && s[j + 1] === '\n') return null;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  const m = /^\(\s*<?([^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(j + 1));
  if (!m) return null;
  return { text: s.slice(i + 1, j), url: m[1]!, end: j + 1 + m[0].length };
}

const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Plain text, with bare addresses on our hosts made links and every other one left as it is. */
function pushText(out: Inline[], text: string, inLink: boolean): void {
  if (inLink) {
    out.push({ t: 'text', v: text });
    return;
  }
  let last = 0;
  for (const m of text.matchAll(BARE_URL)) {
    let url = m[0];
    // Sentence punctuation after an address isn't part of it.
    while (/[.,;:!?)\]]$/.test(url) && !(url.endsWith(')') && url.split('(').length > url.split(')').length - 1)) url = url.slice(0, -1);
    const href = ourLink(url);
    if (!href) continue;
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    out.push({ t: 'link', href, c: [{ t: 'text', v: url }] });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
}

/** `inLink`: this is a link's own text, so nothing in it becomes another link. */
export function parseInline(src: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = (): void => {
    if (text) pushText(out, text, inLink);
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }
    if (c === '`') {
      const run = runOf(src, i, '`');
      const close = codeClose(src, i + run, run);
      if (close >= 0) {
        flush();
        let v = src.slice(i + run, close).replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
        out.push({ t: 'code', v });
        i = close + run;
        continue;
      }
      text += src.slice(i, i + run);
      i += run;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      // No image, ever: only its alt text, as plain text. The address is dropped, never fetched or shown as a link.
      const img = linkAt(src, i + 1);
      if (img) {
        text += img.text;
        i = img.end;
        continue;
      }
    }
    if (c === '[' && !inLink) {
      const link = linkAt(src, i);
      if (link) {
        const href = ourLink(link.url);
        const inner = depth < MAX_INLINE_DEPTH ? parseInline(link.text, depth + 1, true) : [{ t: 'text' as const, v: link.text }];
        flush();
        if (href) out.push({ t: 'link', href, c: inner });
        else {
          // Not ours: the words stay, as text, and so does where it pointed, so nothing is hidden.
          out.push(...inner);
          if (link.url && link.url !== link.text) out.push({ t: 'text', v: ` (${link.url})` });
        }
        i = link.end;
        continue;
      }
    }
    if (c === '<' && !inLink) {
      const auto = /^<(https?:\/\/[^\s<>]+)>/.exec(src.slice(i));
      if (auto) {
        const href = ourLink(auto[1]!);
        flush();
        out.push(href ? { t: 'link', href, c: [{ t: 'text', v: auto[1]! }] } : { t: 'text', v: auto[1]! });
        i += auto[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const run = runOf(src, i, c);
      const next = src[i + run];
      const before = i > 0 ? src[i - 1]! : ' ';
      const opens = run <= 3 && next !== undefined && !SPACE.test(next) && (c === '*' || !WORD.test(before));
      if (opens && depth < MAX_INLINE_DEPTH) {
        const close = emphasisClose(src, i + run, c, run);
        if (close > i + run) {
          const inner = parseInline(src.slice(i + run, close), depth + 1, inLink);
          flush();
          out.push(run === 1 ? { t: 'em', c: inner } : run === 2 ? { t: 'strong', c: inner } : { t: 'strong', c: [{ t: 'em', c: inner }] });
          i = close + run;
          continue;
        }
      }
      text += src.slice(i, i + run);
      i += run;
      continue;
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

/** What a screen reader hears when a reply finishes: the words, without the marks. */
export function plainText(nodes: Block[]): string {
  const inline = (c: Inline[]): string => c.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : inline(n.c))).join('');
  return nodes
    .map((b) => {
      switch (b.t) {
        case 'p':
        case 'h':
          return inline(b.c);
        case 'code':
          return b.v;
        case 'list':
          return b.items.map((item) => plainText(item)).join('. ');
        case 'quote':
          return plainText(b.c);
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join(' ');
}
