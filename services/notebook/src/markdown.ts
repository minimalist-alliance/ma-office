// Markdown into a page body, for the Agent's Notebook tools (agent.ts): the CommonMark and GFM that the Notebook's
// schema can hold, as ProseMirror JSON. Blocks: ATX and setext headings (levels past 3 are 3), paragraphs, bulleted,
// numbered and task lists, nested, quotes, fenced code with its language, rules. Inline: bold, italic, strikethrough,
// code, links with their titles, <u>, <mark> and <span> with the Notebook's colors' names, <br> and the other few tags
// pageMarkdown.ts writes, backslash escapes, entities and hard breaks. A block's color is a line `{color=blue}` just before
// it, or `{color=blue}` just after a list item's marker; `<p></p>` alone on a line is an empty line of the page. What the
// schema has no node for is converted and said so (`readMarkdown`'s `converted`): a table's rows become paragraphs, an
// image a link to it (its alt text the link's text), other HTML stays as written, levels past 3 are 3. It reads what
// pageMarkdown.ts writes back as exactly the same page.
//
// Pure, and it never throws on any input. Nothing it makes reaches a page before cleanDoc checks it against the schema
// and drops links that aren't http, https or mailto. Its work is linear in the input, apart from emphasis, which is
// skipped past MAX_DELIMS delimiters in one block, and nesting, which stops at MAX_DEPTH.
import { isPaletteId, type PMNode } from './model.ts';

type Mark = NonNullable<PMNode['marks']>[number];

/** Quotes and lists deeper than this are read as text. */
const MAX_DEPTH = 32;
/** Links inside link text, and the like. */
const MAX_INLINE_DEPTH = 4;
/** More emphasis delimiters than this in one block are text: the pairing is quadratic in them. */
const MAX_DELIMS = 1000;
/** Heading levels the schema has: Title, Heading, Subheading. */
const MAX_LEVEL = 3;

// ------------------------------------------------------------------ blocks

const BLANK = /^[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;

/** A line `{color=blue}` just before a block gives it that color; just after a list item's marker, the item. */
const COLOR_LINE = /^ {0,3}\{color=([a-z]{1,16})\}[ \t]*$/;
const COLOR_AFTER_MARKER = /^\{color=([a-z]{1,16})\}(?:[ \t]+|$)/;
/** An empty line of the page, which Markdown has no other way to say. */
const EMPTY_PARAGRAPH = /^ {0,3}<p\s*\/?>(?:\s*<\/p>)?[ \t]*$/i;
/** Blocks that take a color (ADR 0091). A list's items take theirs after the marker. */
const COLORED = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'taskList']);

/**
 * How far in a line's text starts, in columns: a tab to the next multiple of 4. Lines are kept as written, so a tab in a
 * code block stays a tab; only indentation is counted this way.
 */
function leading(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** The line less its first `n` columns of indentation. A tab across the cut leaves the rest of its width as spaces. */
function dropColumns(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') col += 1;
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (col + width > n) return ' '.repeat(col + width - n) + line.slice(i + 1);
      col += width;
    } else break;
    i += 1;
  }
  return line.slice(i);
}

/** What a parse converted because the schema has nothing for it, for `readMarkdown`. Set only while one runs. */
let converted: Set<Conversion> | null = null;
export type Conversion = 'table' | 'image' | 'html' | 'heading_level';
const note = (what: Conversion): void => {
  converted?.add(what);
};

/** A fence that opens a code block. A backtick fence's info string can't hold a backtick. */
function fenceOf(line: string): { indent: number; fence: string; info: string } | null {
  const m = FENCE.exec(line);
  if (!m) return null;
  const fence = m[2] as string;
  const info = m[3] as string;
  if (fence[0] === '`' && info.includes('`')) return null;
  return { indent: (m[1] as string).length, fence, info: info.trim() };
}

function closesFence(line: string, fence: string): boolean {
  const t = line.trimEnd();
  if (leading(t) > 3) return false;
  const run = t.trimStart();
  return run.length >= fence.length && [...run].every((c) => c === fence[0]);
}

/** An item marker that can start a list here: a bullet with something after it, or a number. */
function itemOf(line: string): { indent: number; marker: string; spaces: string; rest: string } | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  return { indent: (m[1] as string).length, marker: m[2] as string, spaces: m[3] ?? '', rest: m[4] ?? '' };
}

type ListKind = 'bullet' | 'task' | 'ordered';

function kindOf(item: { marker: string; rest: string }): ListKind {
  if (/^\d/.test(item.marker)) return 'ordered';
  return TASK.test(item.rest) ? 'task' : 'bullet';
}

/** A table's first two lines: a row with a pipe, then a delimiter row with one. */
function tableAt(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  return head !== undefined && sep !== undefined && head.includes('|') && sep.includes('|') && TABLE_SEP.test(sep);
}

/** Whether a line starts a block, so it ends a paragraph rather than continuing it. */
function interrupts(line: string): boolean {
  if (BLANK.test(line)) return true;
  if (ATX.test(line) || HR.test(line) || QUOTE.test(line) || fenceOf(line) || EMPTY_PARAGRAPH.test(line)) return true;
  const item = itemOf(line);
  return item !== null && item.rest.trim() !== '';
}

/** Spaces and tabs only: a no-break space or any other is text, as CommonMark has it. */
const trimStartSpaces = (s: string): string => s.replace(/^[ \t]+/, '');
const trimSpaces = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');

/** What keeps a list going: the same bullet, or the same delimiter after a number (CommonMark). */
const markerKey = (marker: string): string => (/^\d/.test(marker) ? marker.slice(-1) : marker);

function paragraph(content: PMNode[]): PMNode {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < r.length; i += 1) {
    const c = r[i];
    if (c === '\\' && r[i + 1] === '|') {
      cell += '\\|';
      i += 1;
    } else if (c === '|') {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

function parseBlocks(lines: string[], depth: number): PMNode[] {
  const out: PMNode[] = [];
  // A `{color=…}` line gives the next block its color.
  let color: string | null = null;
  const push = (block: PMNode): void => {
    if (color && COLORED.has(block.type)) block.attrs = { ...(block.attrs ?? {}), color };
    color = null;
    out.push(block);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (BLANK.test(line)) {
      i += 1;
      continue;
    }

    const colorLine = COLOR_LINE.exec(line);
    if (colorLine && isPaletteId(colorLine[1]) && i + 1 < lines.length && !BLANK.test(lines[i + 1] as string)) {
      color = colorLine[1] as string;
      i += 1;
      continue;
    }

    if (EMPTY_PARAGRAPH.test(line)) {
      push(paragraph([]));
      i += 1;
      continue;
    }

    const fence = fenceOf(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i] as string, fence.fence)) {
        const l = lines[i] as string;
        body.push(dropColumns(l, Math.min(fence.indent, leading(l))));
        i += 1;
      }
      i += 1; // the closing fence, or the end
      const language = fence.info.split(/\s+/)[0] || null;
      const text = body.join('\n');
      push({ type: 'codeBlock', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const text = trimSpaces(trimSpaces(atx[2] as string).replace(/(?:^|[ \t]+)#+$/, ''));
      const hashes = (atx[1] as string).length;
      if (hashes > MAX_LEVEL) note('heading_level');
      push({ type: 'heading', attrs: { level: Math.min(MAX_LEVEL, hashes) }, content: inline(text) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      push({ type: 'horizontalRule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        if (QUOTE.test(l)) inner.push(l.replace(/^ {0,3}> ?/, ''));
        else if (!BLANK.test(l) && inner.length && !BLANK.test(inner[inner.length - 1] as string) && !interrupts(l)) inner.push(l);
        else break;
        i += 1;
      }
      const content = parseBlocks(inner, depth + 1);
      push({ type: 'blockquote', content: content.length ? content : [paragraph([])] });
      continue;
    }

    const first = itemOf(line);
    if (first && depth < MAX_DEPTH) {
      const kind = kindOf(first);
      const key = markerKey(first.marker);
      const items: PMNode[] = [];
      const start = kind === 'ordered' ? Number.parseInt(first.marker, 10) : 1;
      while (i < lines.length) {
        // A rule ends the list, though `- - -` reads as an item too.
        const item = HR.test(lines[i] as string) ? null : itemOf(lines[i] as string);
        if (!item || kindOf(item) !== kind || markerKey(item.marker) !== key || item.indent >= 4) break;
        // The item's content starts after its marker and up to 4 spaces; past that, one space, and the rest is the text's.
        const gap = item.spaces.length === 0 ? 1 : item.spaces.length > 4 ? 1 : item.spaces.length;
        const width = item.indent + item.marker.length + gap;
        let firstLine = item.spaces.length > 4 ? ' '.repeat(item.spaces.length - 1) + item.rest : item.rest;
        let checked = false;
        const box = kind === 'task' ? TASK.exec(item.rest) : null;
        if (box) {
          checked = box[1] !== ' ';
          firstLine = item.rest.slice(box[0].length);
        }
        let itemColor: string | null = null;
        const colorAt = COLOR_AFTER_MARKER.exec(firstLine);
        if (colorAt && isPaletteId(colorAt[1])) {
          itemColor = colorAt[1] as string;
          firstLine = firstLine.slice(colorAt[0].length);
        }
        const body: string[] = [firstLine];
        i += 1;
        while (i < lines.length) {
          const l = lines[i] as string;
          if (BLANK.test(l)) {
            // A line of spaces past the item's indent is a code block's line of spaces.
            body.push(dropColumns(l, width));
            i += 1;
            continue;
          }
          if (leading(l) >= width) {
            body.push(dropColumns(l, width));
            i += 1;
            continue;
          }
          // A lazy line: it carries on the paragraph just above it.
          const prev = body[body.length - 1] as string;
          if (prev !== '' && !interrupts(l) && !itemOf(l)) {
            body.push(trimStartSpaces(l));
            i += 1;
            continue;
          }
          break;
        }
        while (body.length > 1 && BLANK.test(body[body.length - 1] as string)) body.pop();
        const content = parseBlocks(body, depth + 1);
        // An item's first child is a paragraph in this schema.
        const head = content[0];
        if (!head) content.push(paragraph([]));
        else if (head.type === 'heading') content[0] = paragraph(head.content ?? []);
        else if (head.type !== 'paragraph') content.unshift(paragraph([]));
        const attrs: Record<string, unknown> = kind === 'task' ? { checked } : {};
        if (itemColor) attrs['color'] = itemColor;
        const type = kind === 'task' ? 'taskItem' : 'listItem';
        items.push(Object.keys(attrs).length ? { type, attrs, content } : { type, content });
        // Blank lines between items keep the list going.
        let j = i;
        while (j < lines.length && BLANK.test(lines[j] as string)) j += 1;
        const next = j < lines.length && !HR.test(lines[j] as string) ? itemOf(lines[j] as string) : null;
        if (!next || kindOf(next) !== kind || markerKey(next.marker) !== key || next.indent >= 4) break;
        i = j;
      }
      if (kind === 'ordered') push({ type: 'orderedList', attrs: { start }, content: items });
      else push({ type: kind === 'task' ? 'taskList' : 'bulletList', content: items });
      continue;
    }

    if (tableAt(lines, i)) {
      // The schema has no tables: each row is a paragraph, its cells apart, and the delimiter row goes.
      note('table');
      push(paragraph(inline(cells(line).join(' | '))));
      i += 2;
      while (i < lines.length && !BLANK.test(lines[i] as string) && (lines[i] as string).includes('|') && !interrupts(lines[i] as string)) {
        push(paragraph(inline(cells(lines[i] as string).join(' | '))));
        i += 1;
      }
      continue;
    }

    // A paragraph: until a blank line or another block, or a setext underline that makes it a heading.
    const text: string[] = [trimStartSpaces(line)];
    i += 1;
    let level = 0;
    while (i < lines.length) {
      const l = lines[i] as string;
      const setext = SETEXT.exec(l);
      if (setext) {
        level = (setext[1] as string)[0] === '=' ? 1 : 2;
        i += 1;
        break;
      }
      if (interrupts(l) || tableAt(lines, i)) break;
      text.push(trimStartSpaces(l));
      i += 1;
    }
    const body = text.join('\n');
    if (level) push({ type: 'heading', attrs: { level }, content: inline(trimSpaces(body)) });
    else push(paragraph(inline(body)));
  }
  return out;
}

const linesOf = (md: string): string[] => md.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n');

/** A whole document. The blocks may be none, for Markdown with nothing in it. */
export function fromMarkdown(md: string): PMNode {
  return { type: 'doc', content: parseBlocks(linesOf(md), 0) };
}

/** A whole document, and what in the Markdown the schema has nothing for, so was converted (in this order). */
export function readMarkdown(md: string): { doc: PMNode; converted: Conversion[] } {
  const seen = new Set<Conversion>();
  converted = seen;
  try {
    const doc = fromMarkdown(md);
    return { doc, converted: (['table', 'image', 'html', 'heading_level'] as Conversion[]).filter((c) => seen.has(c)) };
  } finally {
    converted = null;
  }
}

/** The blocks of a few lines, as a block in a page holds them: for pageMarkdown.ts's check of what it writes. */
export function blocksOf(md: string): PMNode[] {
  return parseBlocks(linesOf(md), 0);
}

/** A node's text, inline content joined, hard breaks as spaces, blocks on their own lines. */
export function plainText(node: PMNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  const inner = (node.content ?? []).map(plainText);
  const isTextblock = (node.content ?? []).every((c) => c.type === 'text' || c.type === 'hardBreak');
  return inner.join(isTextblock ? '' : '\n');
}

// ------------------------------------------------------------------ inline

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;

type Item =
  // `keep`: a space an entity wrote, which the block's trimming leaves.
  | { kind: 'text'; text: string; marks: Mark[]; keep?: boolean }
  | { kind: 'delim'; char: string; count: number; length: number; canOpen: boolean; canClose: boolean; marks: Mark[] }
  | { kind: 'nodes'; nodes: PMNode[] }
  // `html`: a `<br>`, which HTML shows even at a block's end; a backslash's or two spaces' there is nothing (CommonMark).
  | { kind: 'break'; html?: boolean }
  | { kind: 'tag'; mark: string; attrs?: Record<string, unknown>; open: boolean; raw: string; marks: Mark[] };

/** HTML tags that become marks or breaks, as pageMarkdown.ts and export.ts write them. Any other tag stays as text. */
const TAGS: Record<string, string> = { u: 'underline', ins: 'underline', mark: 'highlight', s: 'strike', del: 'strike', strike: 'strike', b: 'bold', strong: 'bold', i: 'italic', em: 'italic', code: 'code', span: 'textColor' };
/** A color's name in a tag, as pageMarkdown.ts writes it: `<mark data-color="blue">`, `<span data-text-color="blue">`. */
const DATA_COLOR = /\sdata-color\s*=\s*(?:"([a-z]{1,16})"|'([a-z]{1,16})')/;
const DATA_TEXT_COLOR = /\sdata-text-color\s*=\s*(?:"([a-z]{1,16})"|'([a-z]{1,16})')/;
/** The only highlight value before colors' names, kept as it is (colors.ts). */
const LEGACY_HIGHLIGHT = 'yellow';

/** A tag's mark attributes: a highlight's or a text color's name, when it's one of the palette's. */
function tagAttrs(mark: string, raw: string): Record<string, unknown> | undefined {
  if (mark === 'highlight') {
    const m = DATA_COLOR.exec(raw);
    const name = m ? (m[1] ?? m[2]) : undefined;
    return name && (isPaletteId(name) || name === LEGACY_HIGHLIGHT) ? { color: name } : undefined;
  }
  if (mark === 'textColor') {
    const m = DATA_TEXT_COLOR.exec(raw);
    const name = m ? (m[1] ?? m[2]) : undefined;
    return name && isPaletteId(name) ? { color: name } : undefined;
  }
  return undefined;
}
// Sticky, so each is tried where it stands without copying the rest of the text.
const TAG = /<(\/?)([a-zA-Z]{1,16})\b[^<>]{0,512}?\/?>/y;
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]{0,2048})>/y;
const EMAIL = /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?){0,16})>/y;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/y;
/** A link's destination and title are looked for this far, no further. */
const MAX_DESTINATION = 2048;

/** Where `ch` is in [from, to), or -1, looking no further. */
function within(src: string, ch: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) if (src[i] === ch) return i;
  return -1;
}

function stickyAt(re: RegExp, src: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(src);
}
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/** An http, https or mailto address, trimmed, or null: the only links a page holds. */
export function safeHref(href: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim());
  return m && LINK_SCHEMES.has((m[1] as string).toLowerCase()) ? href.trim() : null;
}

/** For each `[` the `]` that closes it, ignoring escaped ones, in one pass. */
function bracketPairs(src: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') i += 1;
    else if (c === '[') open.push(i);
    else if (c === ']' && open.length) pairs.set(open.pop() as number, i);
  }
  return pairs;
}

/** Backtick runs by length, each list in order, so a code span finds its closer without scanning again. */
function backtickRuns(src: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < src.length; ) {
    if (src[i] !== '`') {
      i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    let j = i;
    while (src[j] === '`') j += 1;
    const list = runs.get(j - i) ?? [];
    list.push(i);
    runs.set(j - i, list);
    i = j;
  }
  return runs;
}

/** A link's `(destination "title")` at `at`, just after its `]`: the destination, its title and where it ends, or null. */
function destinationAt(src: string, at: number): { href: string; title: string | null; end: number } | null {
  if (src[at] !== '(') return null;
  let i = at + 1;
  while (src[i] === ' ' || src[i] === '\n') i += 1;
  let href = '';
  const limit = Math.min(src.length, at + MAX_DESTINATION);
  if (src[i] === '<') {
    const close = within(src, '>', i, limit);
    if (close < 0 || src.slice(i + 1, close).includes('\n')) return null;
    href = src.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const from = i;
    for (; i < limit; i += 1) {
      const c = src[i] as string;
      if (c === '\\' && i + 1 < src.length) {
        i += 1;
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (SPACE.test(c)) break;
    }
    if (i >= limit) return null;
    href = src.slice(from, i).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (src[i] === ' ' || src[i] === '\n') i += 1;
  const q = src[i];
  let title: string | null = null;
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    const close = within(src, closer, i + 1, limit);
    if (close < 0) return null;
    title = src.slice(i + 1, close);
    i = close + 1;
    while (src[i] === ' ' || src[i] === '\n') i += 1;
  }
  if (src[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

function flanking(before: string, after: string): { left: boolean; right: boolean } {
  const bs = SPACE.test(before);
  const as = SPACE.test(after);
  const bp = PUNCT.test(before);
  const ap = PUNCT.test(after);
  return { left: !as && (!ap || bs || bp), right: !bs && (!bp || as || ap) };
}

function tokenize(src: string, depth: number): Item[] {
  const items: Item[] = [];
  const pairs = bracketPairs(src);
  const runs = backtickRuns(src);
  const used = new Map<number, number>(); // per run length, how far into its list a search has got
  let text = '';
  const flush = (): void => {
    if (text) items.push({ kind: 'text', text, marks: [] });
    text = '';
  };
  // A link's text keeps its own spaces: only a block's ends are trimmed.
  const linkNodes = (inner: string, link: Mark | null, plain: boolean): PMNode[] => {
    let nodes = depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1, false) : [{ type: 'text', text: inner }];
    if (plain) nodes = nodes.filter((n) => n.type === 'text').map((n) => ({ type: 'text', text: n.text ?? '' }));
    if (!link) return nodes;
    return nodes.map((n) => (n.type === 'text' && !(n.marks ?? []).some((m) => m.type === 'link') ? { ...n, marks: [...(n.marks ?? []), link] } : n));
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') {
        flush();
        items.push({ kind: 'break' });
        i += 2;
        while (src[i] === ' ') i += 1;
        continue;
      }
      if (n !== undefined && ASCII_PUNCT.test(n)) {
        text += n;
        i += 2;
        continue;
      }
      text += c;
      i += 1;
      continue;
    }
    if (c === '\n') {
      const trailing = / {2,}$/.exec(text);
      if (trailing) {
        text = text.slice(0, -trailing[0].length);
        flush();
        items.push({ kind: 'break' });
      } else text = `${text.replace(/ +$/, '')} `;
      i += 1;
      while (src[i] === ' ') i += 1;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (src[j] === '`') j += 1;
      const len = j - i;
      const list = runs.get(len) ?? [];
      let k = used.get(len) ?? 0;
      while (k < list.length && (list[k] as number) <= i) k += 1;
      used.set(len, k);
      if (k < list.length) {
        const close = list[k] as number;
        used.set(len, k + 1);
        let code = src.slice(j, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        flush();
        if (code) items.push({ kind: 'nodes', nodes: [{ type: 'text', text: code, marks: [{ type: 'code' }] }] });
        i = close + len;
        continue;
      }
      text += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (src[j] === c) j += 1;
      // The start and end of the block count as spaces.
      const before = i > 0 ? (src[i - 1] as string) : ' ';
      const after = j < src.length ? (src[j] as string) : ' ';
      const { left, right } = flanking(before, after);
      const canOpen = c === '_' ? left && (!right || PUNCT.test(before)) : left;
      const canClose = c === '_' ? right && (!left || PUNCT.test(after)) : right;
      flush();
      items.push({ kind: 'delim', char: c, count: j - i, length: j - i, canOpen, canClose, marks: [] });
      i = j;
      continue;
    }
    if ((c === '[' || (c === '!' && src[i + 1] === '[')) && pairs.has(c === '!' ? i + 1 : i)) {
      const open = c === '!' ? i + 1 : i;
      const close = pairs.get(open) as number;
      const dest = destinationAt(src, close + 1);
      if (dest) {
        flush();
        const inner = src.slice(open + 1, close);
        const href = safeHref(dest.href);
        if (c === '!') {
          // An image has no node here: it's a link to the image, its alt text the link's text (the address if none).
          note('image');
          const image = href && /^https?:/i.test(href) ? href : null;
          const alt = linkNodes(inner, image ? { type: 'link', attrs: { href: image } } : null, true);
          items.push({ kind: 'nodes', nodes: alt.length || !image ? alt : [{ type: 'text', text: image, marks: [{ type: 'link', attrs: { href: image } }] }] });
        } else {
          const link: Mark | null = href ? { type: 'link', attrs: dest.title ? { href, title: dest.title } : { href } } : null;
          items.push({ kind: 'nodes', nodes: linkNodes(inner, link, false) });
        }
        i = dest.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = stickyAt(AUTOLINK, src, i);
      if (auto) {
        const href = safeHref(auto[1] as string);
        flush();
        items.push({ kind: 'nodes', nodes: [{ type: 'text', text: auto[1] as string, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }] });
        i += auto[0].length;
        continue;
      }
      const email = stickyAt(EMAIL, src, i);
      if (email) {
        flush();
        items.push({ kind: 'nodes', nodes: [{ type: 'text', text: email[1] as string, marks: [{ type: 'link', attrs: { href: `mailto:${email[1] as string}` } }] }] });
        i += email[0].length;
        continue;
      }
      const tag = stickyAt(TAG, src, i);
      const name = tag ? (tag[2] as string).toLowerCase() : '';
      if (tag && (name === 'br' || Object.hasOwn(TAGS, name))) {
        flush();
        if (name === 'br') items.push({ kind: 'break', html: true });
        else {
          const mark = TAGS[name] as string;
          const open = tag[1] !== '/';
          const attrs = open ? tagAttrs(mark, tag[0]) : undefined;
          items.push({ kind: 'tag', mark, ...(attrs ? { attrs } : {}), open, raw: tag[0], marks: [] });
        }
        i += tag[0].length;
        continue;
      }
      // Any other tag stays as written, as text.
      if (tag) note('html');
    }
    if (c === '&') {
      const e = stickyAt(ENTITY, src, i);
      if (e) {
        const code = e[1] ? Number.parseInt(e[1], 10) : e[2] ? Number.parseInt(e[2], 16) : -1;
        const ch = code >= 0 ? (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\uFFFD') : (NAMED[e[3] as string] as string);
        // A space or a line break an entity wrote is text, and stays where the block's own are trimmed or joined.
        if (SPACE.test(ch)) {
          flush();
          items.push({ kind: 'text', text: ch, marks: [], keep: true });
        } else text += ch;
        i += e[0].length;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return items;
}

const sameMark = (a: Mark, b: Mark): boolean => a.type === b.type;

function addMark(item: Item, mark: Mark): void {
  if (item.kind === 'text' || item.kind === 'delim' || item.kind === 'tag') {
    if (!item.marks.some((m) => sameMark(m, mark))) item.marks.push(mark);
  } else if (item.kind === 'nodes') {
    item.nodes = item.nodes.map((n) => (n.type !== 'text' || (n.marks ?? []).some((m) => sameMark(m, mark)) ? n : { ...n, marks: [...(n.marks ?? []), mark] }));
  }
}

const asText = (item: Item): Item => {
  if (item.kind === 'delim') return { kind: 'text', text: item.char.repeat(item.count), marks: item.marks };
  if (item.kind === 'tag') return { kind: 'text', text: item.raw, marks: item.marks };
  return item;
};

/** CommonMark's pairing of `*`, `_` and GFM's `~~`, closers left to right, each with the nearest opener that fits. */
function emphasis(items: Item[]): void {
  if (items.filter((it) => it.kind === 'delim').length > MAX_DELIMS) return;
  for (let c = 0; c < items.length; c += 1) {
    const closer = items[c] as Item;
    if (closer.kind !== 'delim' || !closer.canClose) continue;
    while (closer.count > 0) {
      let found = -1;
      for (let o = c - 1; o >= 0; o -= 1) {
        const op = items[o] as Item;
        if (op.kind !== 'delim' || op.char !== closer.char || !op.canOpen || op.count === 0) continue;
        if (closer.char === '~') {
          if (op.count >= 2 && closer.count >= 2) found = o;
          break;
        }
        if ((op.canClose || closer.canOpen) && (op.length + closer.length) % 3 === 0 && !(op.length % 3 === 0 && closer.length % 3 === 0)) continue;
        found = o;
        break;
      }
      if (found < 0) break;
      const op = items[found] as Extract<Item, { kind: 'delim' }>;
      const use = closer.char === '~' ? 2 : op.count >= 2 && closer.count >= 2 ? 2 : 1;
      const mark: Mark = { type: closer.char === '~' ? 'strike' : use === 2 ? 'bold' : 'italic' };
      for (let k = found + 1; k < c; k += 1) {
        // A delimiter inside can't pair with anything outside any more: it's text.
        items[k] = asText(items[k] as Item);
        addMark(items[k] as Item, mark);
      }
      op.count -= use;
      closer.count -= use;
    }
  }
}

/** `<u>…</u>` and the like: each opening tag with the next closing one of its kind; the rest stay as written. */
function tags(items: Item[]): void {
  for (let c = 0; c < items.length; c += 1) {
    const close = items[c] as Item;
    if (close.kind !== 'tag' || close.open) continue;
    let o = c - 1;
    while (o >= 0 && !((items[o] as Item).kind === 'tag' && (items[o] as Extract<Item, { kind: 'tag' }>).open && (items[o] as Extract<Item, { kind: 'tag' }>).mark === close.mark)) o -= 1;
    if (o < 0) continue;
    const opener = items[o] as Extract<Item, { kind: 'tag' }>;
    const mark: Mark = opener.attrs ? { type: close.mark, attrs: opener.attrs } : { type: close.mark };
    for (let k = o + 1; k < c; k += 1) addMark(items[k] as Item, mark);
    items[o] = { kind: 'text', text: '', marks: [] };
    items[c] = { kind: 'text', text: '', marks: [] };
  }
}

/** Code excludes every other mark in the schema; a highlight takes the default color. */
function normalMarks(marks: Mark[]): Mark[] | undefined {
  if (!marks.length) return undefined;
  if (marks.some((m) => m.type === 'code')) return [{ type: 'code' }];
  return marks;
}

function flatten(raw: Item[], block: boolean): PMNode[] {
  const items = raw.map(asText);
  if (block) {
    // A block's text starts and ends with no space it wrote as one, and a break at its end is nothing unless it's a
    // `<br>`. Only an entity keeps a space there (pageMarkdown.ts writes one so).
    while (items.length) {
      const end = items[items.length - 1] as Item;
      if (end.kind === 'break' && !end.html) items.pop();
      else if (end.kind === 'text' && !end.text) items.pop();
      else break;
    }
    for (const it of items) {
      if (it.kind !== 'text' || it.keep) break;
      it.text = it.text.replace(/^[ \t]+/, '');
      if (it.text) break;
    }
    for (let k = items.length - 1; k >= 0; k -= 1) {
      const it = items[k] as Item;
      if (it.kind !== 'text' || it.keep) break;
      it.text = it.text.replace(/[ \t]+$/, '');
      if (it.text) break;
    }
  }
  const out: PMNode[] = [];
  const push = (n: PMNode): void => {
    if (n.type === 'text') {
      if (!n.text) return;
      const marks = normalMarks(n.marks ?? []);
      const last = out[out.length - 1];
      if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks ?? [])) {
        last.text = (last.text ?? '') + n.text;
        return;
      }
      out.push(marks ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text });
    } else out.push(n);
  };
  for (const it of items) {
    if (it.kind === 'text') push({ type: 'text', text: it.text, marks: it.marks });
    else if (it.kind === 'break') push({ type: 'hardBreak' });
    else if (it.kind === 'nodes') it.nodes.forEach(push);
  }
  return out.filter((n) => n.type !== 'text' || n.text);
}

function parseInline(src: string, depth: number, block: boolean): PMNode[] {
  const items = tokenize(src, depth);
  tags(items);
  emphasis(items);
  return flatten(items, block);
}

/** One block's inline Markdown as text nodes and hard breaks. */
export function inline(src: string, depth = 0): PMNode[] {
  return parseInline(src, depth, true);
}
