// Markdown into a page body, for the Agent's Notebook tools (agent.ts): the CommonMark and GFM that the Notebook's
// schema can hold, as ProseMirror JSON. Blocks: ATX and setext headings (levels past 3 are 3), paragraphs, bulleted,
// numbered and task lists, nested, quotes, fenced code with its language, rules. Inline: bold, italic, strikethrough,
// code, links, <u>, <mark>, <br> and the other few tags export.ts writes, backslash escapes and hard breaks. What the
// schema has no node for stays as text: a table's rows as paragraphs, an image as its alt text, other HTML as written,
// indented code as a paragraph. It reads what `toMarkdown` (model/export.ts) writes back as the same page.
//
// Pure, and it never throws on any input. Nothing it makes reaches a page before cleanDoc checks it against the schema
// and drops links that aren't http, https or mailto. Its work is linear in the input, apart from emphasis, which is
// skipped past MAX_DELIMS delimiters in one block, and nesting, which stops at MAX_DEPTH.
import type { PMNode } from './model.ts';

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

/** Leading tabs to spaces, to the next multiple of 4, so indentation can be counted. The rest of the line is as written. */
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let i = 0;
  for (; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
    else if (ch === ' ') out += ' ';
    else break;
  }
  return out + line.slice(i);
}

const leading = (line: string): number => line.length - line.trimStart().length;

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
  if (ATX.test(line) || HR.test(line) || QUOTE.test(line) || fenceOf(line)) return true;
  const item = itemOf(line);
  return item !== null && item.rest.trim() !== '';
}

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
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (BLANK.test(line)) {
      i += 1;
      continue;
    }

    const fence = fenceOf(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i] as string, fence.fence)) {
        const l = lines[i] as string;
        body.push(l.slice(Math.min(fence.indent, leading(l))));
        i += 1;
      }
      i += 1; // the closing fence, or the end
      const language = fence.info.split(/\s+/)[0] || null;
      const text = body.join('\n');
      out.push({ type: 'codeBlock', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const text = (atx[2] as string).trim().replace(/(?:^|[ \t]+)#+$/, '').trim();
      out.push({ type: 'heading', attrs: { level: Math.min(MAX_LEVEL, (atx[1] as string).length) }, content: inline(text) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push({ type: 'horizontalRule' });
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
      out.push({ type: 'blockquote', content: content.length ? content : [paragraph([])] });
      continue;
    }

    const first = itemOf(line);
    if (first && depth < MAX_DEPTH) {
      const kind = kindOf(first);
      const items: PMNode[] = [];
      const start = kind === 'ordered' ? Number.parseInt(first.marker, 10) : 1;
      while (i < lines.length) {
        // A rule ends the list, though `- - -` reads as an item too.
        const item = HR.test(lines[i] as string) ? null : itemOf(lines[i] as string);
        if (!item || kindOf(item) !== kind || item.indent >= 4) break;
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
        const body: string[] = [firstLine];
        i += 1;
        while (i < lines.length) {
          const l = lines[i] as string;
          if (BLANK.test(l)) {
            body.push('');
            i += 1;
            continue;
          }
          if (leading(l) >= width) {
            body.push(l.slice(width));
            i += 1;
            continue;
          }
          // A lazy line: it carries on the paragraph just above it.
          const prev = body[body.length - 1] as string;
          if (prev !== '' && !interrupts(l) && !itemOf(l)) {
            body.push(l.trimStart());
            i += 1;
            continue;
          }
          break;
        }
        while (body.length > 1 && body[body.length - 1] === '') body.pop();
        const content = parseBlocks(body, depth + 1);
        // An item's first child is a paragraph in this schema.
        const head = content[0];
        if (!head) content.push(paragraph([]));
        else if (head.type === 'heading') content[0] = paragraph(head.content ?? []);
        else if (head.type !== 'paragraph') content.unshift(paragraph([]));
        items.push(kind === 'task' ? { type: 'taskItem', attrs: { checked }, content } : { type: 'listItem', content });
        // Blank lines between items keep the list going.
        let j = i;
        while (j < lines.length && BLANK.test(lines[j] as string)) j += 1;
        const next = j < lines.length && !HR.test(lines[j] as string) ? itemOf(lines[j] as string) : null;
        if (!next || kindOf(next) !== kind || next.indent >= 4) break;
        i = j;
      }
      if (kind === 'ordered') out.push({ type: 'orderedList', attrs: { start }, content: items });
      else out.push({ type: kind === 'task' ? 'taskList' : 'bulletList', content: items });
      continue;
    }

    if (tableAt(lines, i)) {
      // The schema has no tables: each row is a paragraph, its cells apart, and the delimiter row goes.
      out.push(paragraph(inline(cells(line).join(' | '))));
      i += 2;
      while (i < lines.length && !BLANK.test(lines[i] as string) && (lines[i] as string).includes('|') && !interrupts(lines[i] as string)) {
        out.push(paragraph(inline(cells(lines[i] as string).join(' | '))));
        i += 1;
      }
      continue;
    }

    // A paragraph: until a blank line or another block, or a setext underline that makes it a heading.
    const text: string[] = [line.trimStart()];
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
      text.push(l.trimStart());
      i += 1;
    }
    const body = text.join('\n');
    if (level) out.push({ type: 'heading', attrs: { level }, content: inline(body.trim()) });
    else out.push(paragraph(inline(body)));
  }
  return out;
}

/** A whole document. The blocks may be none, for Markdown with nothing in it. */
export function fromMarkdown(md: string): PMNode {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n').map(expandTabs);
  return { type: 'doc', content: parseBlocks(lines, 0) };
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
  | { kind: 'text'; text: string; marks: Mark[] }
  | { kind: 'delim'; char: string; count: number; length: number; canOpen: boolean; canClose: boolean; marks: Mark[] }
  | { kind: 'nodes'; nodes: PMNode[] }
  | { kind: 'break' }
  | { kind: 'tag'; mark: string; open: boolean; raw: string; marks: Mark[] };

/** HTML tags that become marks or breaks, as export.ts writes some of them. Any other tag stays as text. */
const TAGS: Record<string, string> = { u: 'underline', ins: 'underline', mark: 'highlight', s: 'strike', del: 'strike', strike: 'strike', b: 'bold', strong: 'bold', i: 'italic', em: 'italic', code: 'code', span: '' };
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

function safeHref(href: string): string | null {
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

/** A link's `(destination "title")` at `at`, just after its `]`: the destination and where it ends, or null. */
function destinationAt(src: string, at: number): { href: string; end: number } | null {
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
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    const close = within(src, closer, i + 1, limit);
    if (close < 0) return null;
    i = close + 1;
    while (src[i] === ' ' || src[i] === '\n') i += 1;
  }
  if (src[i] !== ')') return null;
  return { href, end: i + 1 };
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
  const linkNodes = (inner: string, href: string | null, plain: boolean): PMNode[] => {
    const nodes = depth < MAX_INLINE_DEPTH ? inline(inner, depth + 1) : [{ type: 'text', text: inner }];
    if (plain) return nodes.filter((n) => n.type === 'text').map((n) => ({ type: 'text', text: n.text ?? '' }));
    if (!href) return nodes;
    return nodes.map((n) => (n.type === 'text' && !(n.marks ?? []).some((m) => m.type === 'link') ? { ...n, marks: [...(n.marks ?? []), { type: 'link', attrs: { href } }] } : n));
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
        // An image has no node here: its alt text stays, as plain text.
        items.push({ kind: 'nodes', nodes: linkNodes(inner, c === '!' ? null : safeHref(dest.href), c === '!') });
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
        if (name === 'br') items.push({ kind: 'break' });
        else if (TAGS[name]) items.push({ kind: 'tag', mark: TAGS[name] as string, open: tag[1] !== '/', raw: tag[0], marks: [] });
        i += tag[0].length;
        continue;
      }
    }
    if (c === '&') {
      const e = stickyAt(ENTITY, src, i);
      if (e) {
        const code = e[1] ? Number.parseInt(e[1], 10) : e[2] ? Number.parseInt(e[2], 16) : -1;
        text += code >= 0 ? (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�') : (NAMED[e[3] as string] as string);
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
    for (let k = o + 1; k < c; k += 1) addMark(items[k] as Item, { type: close.mark });
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

function flatten(items: Item[]): PMNode[] {
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
  for (const raw of items) {
    const it = asText(raw);
    if (it.kind === 'text') push({ type: 'text', text: it.text, marks: it.marks });
    else if (it.kind === 'break') push({ type: 'hardBreak' });
    else if (it.kind === 'nodes') it.nodes.forEach(push);
  }
  // A block's text starts and ends with no space, and a break at its end is nothing.
  while (out.length && out[out.length - 1]?.type === 'hardBreak') out.pop();
  const first = out[0];
  if (first?.type === 'text') first.text = (first.text ?? '').replace(/^[ \t]+/, '');
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text = (last.text ?? '').replace(/[ \t]+$/, '');
  return out.filter((n) => n.type !== 'text' || n.text);
}

/** One block's inline Markdown as text nodes and hard breaks. */
export function inline(src: string, depth = 0): PMNode[] {
  const items = tokenize(src, depth);
  tags(items);
  emphasis(items);
  return flatten(items);
}
