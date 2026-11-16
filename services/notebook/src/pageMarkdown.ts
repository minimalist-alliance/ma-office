// A page as Markdown for the Agent's Notebook tools (agent.ts, `notebook.page.markdown`): exactly what the page holds,
// so that markdown.ts reads it back as the same page, every block, mark, color, attribute and character of it. An agent
// that reads a page and writes part of it back loses nothing.
//
// Plain Markdown where it can say a thing: headings, paragraphs, lists with their numbers and boxes, quotes, fenced code
// with its language, rules, bold (`**`), italic (`*`), strikethrough (`~~`), code, links with their titles. HTML where
// Markdown can't, as the member's export does: `<u>`, `<mark>` and `<span>` with the Notebook's colors' names
// (`<mark data-color="blue">`, `<span data-text-color="blue">`), `<br>` for a line break. A block's color is a line
// `{color=blue}` just before it, or `{color=blue}` just after a list item's marker; an empty line of the page is `<p></p>`.
// A space at a block's start or end, and a line break inside text, are entities, as Markdown would drop them.
//
// Each block's text is written in the plainest form and read back with markdown.ts's own `inline`; if that isn't the
// same text with the same marks, it's written again with every special character escaped, and then with every mark as
// a tag, which always reads back. So what's written is checked as it's written, not trusted.
//
// What it can't carry, and so isn't kept (each is rare, and none is something the editor makes): a link's `target`,
// `rel` or `class`, a numbered list's `type`, a color on a list item's first paragraph (the item has its own), a code
// block's language past its first word, a line break inside inline code, links of over 2,000 characters, NUL and CR
// characters in code, and anything the schema doesn't have. Pure.
import { inline, safeHref } from './markdown.ts';
import { isPaletteId, type PMNode } from './model.ts';

type Mark = NonNullable<PMNode['marks']>[number];

/** What a highlight with no color reads as, and what `<mark>` with none writes. */
const DEFAULT_HIGHLIGHT = 'amber';
/** The only highlight value before colors' names, kept as stored (colors.ts). */
const LEGACY_HIGHLIGHT = 'yellow';
/** Outermost first. Code takes no other mark in the schema, so it's always alone; a link is innermost of the rest. */
const ORDER = ['bold', 'italic', 'strike', 'underline', 'highlight', 'textColor', 'link', 'code'];
const COLORED = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'taskList']);
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

// ------------------------------------------------------------------ marks

function highlightColor(m: Mark): string {
  const c = m.attrs?.['color'];
  return c === LEGACY_HIGHLIGHT || isPaletteId(c) ? (c as string) : DEFAULT_HIGHLIGHT;
}

/** A mark as markdown.ts makes it, for comparing: a link by its address and title, a color by its name. Null: none. */
function markKey(m: Mark): string | null {
  switch (m.type) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'underline':
    case 'code':
      return m.type;
    case 'highlight':
      return `highlight=${highlightColor(m)}`;
    case 'textColor':
      return isPaletteId(m.attrs?.['color']) ? `textColor=${m.attrs?.['color'] as string}` : null;
    case 'link': {
      const href = typeof m.attrs?.['href'] === 'string' ? safeHref(m.attrs['href']) : null;
      const title = typeof m.attrs?.['title'] === 'string' && m.attrs['title'] ? m.attrs['title'] : '';
      return href ? `link=${href}\u0000${title}` : null;
    }
    default:
      return null;
  }
}

/** The marks markdown.ts can say, outermost first. */
function marksOf(node: PMNode): Mark[] {
  const marks = (node.marks ?? []).filter((m) => markKey(m) !== null);
  if (marks.some((m) => m.type === 'code')) return [{ type: 'code' }];
  return marks.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

/** Inline content as runs of text with the same marks, and breaks: the shape two blocks' text are compared in. */
function canonical(nodes: PMNode[]): string {
  const runs: [string, string][] = [];
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      runs.push(['\u0001br', '']);
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const key = marksOf(n)
      .map((m) => markKey(m) as string)
      .sort()
      .join('\u0002');
    const last = runs[runs.length - 1];
    if (last && last[0] === key) last[1] += n.text;
    else runs.push([key, n.text]);
  }
  return JSON.stringify(runs);
}

// ------------------------------------------------------------------ text

/** A character as a numeric entity, which markdown.ts reads as that character wherever it is. */
const entity = (ch: string): string => `&#${ch.codePointAt(0) as number};`;
/** `&` that could read as an entity. */
const ENTITY_LIKE = /^&(?:#\d|#[xX][0-9a-fA-F]|[a-zA-Z][a-zA-Z0-9]{0,31};)/;
const WORD = /[\p{L}\p{N}]/u;
const WHITE = /\s/u;

/** As few backslashes as plain text needs where it stands. What it gets wrong, the check finds. */
function escapePlain(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] as string;
    const prev = s[i - 1] ?? '';
    const next = s[i + 1] ?? '';
    switch (c) {
      case '\\':
      case '`':
      case '[':
      case ']':
        out += `\\${c}`;
        break;
      case '*':
        out += WHITE.test(prev) && WHITE.test(next) ? c : `\\${c}`;
        break;
      case '_':
        out += WORD.test(prev) && WORD.test(next) ? c : `\\${c}`;
        break;
      case '~':
        out += prev === '~' || next === '~' || !prev || !next ? `\\${c}` : c;
        break;
      case '<':
        out += /[a-zA-Z/!?]/.test(next) || !next ? `\\${c}` : c;
        break;
      case '&':
        out += ENTITY_LIKE.test(s.slice(i, i + 40)) ? '\\&' : c;
        break;
      case '\n':
      case '\r':
        out += entity(c);
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** Every character that means anything inline, escaped. */
function escapeAll(s: string): string {
  return s.replace(/[\\`*_[\]<>~|&!{}#+-]/g, '\\$&').replace(/[\n\r]/g, entity);
}

/** Inline code: a run of backticks longer than any inside, and a space each side when the text needs one kept. */
function codeSpan(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  // A backslash just before the closing run would hide its first backtick from markdown.ts, so it gets the space too.
  const pad = text.startsWith('`') || text.endsWith('`') || text.endsWith('\\') || (text.length > 0 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A link's destination: as it is, with `<…>` around it if it has a space, else with its parentheses escaped. */
function destination(href: string): string {
  if (/\s/.test(href) && !/[<>\n]/.test(href)) return `<${href}>`;
  return href.replace(/[\\()<>]/g, '\\$&').replace(/\s/g, (c) => encodeURIComponent(c));
}

/** A link's title in whichever quotes it doesn't hold; none if it holds all three. */
function titlePart(title: string): string {
  if (!title || title.includes('\n')) return '';
  if (!title.includes('"')) return ` "${title}"`;
  if (!title.includes("'")) return ` '${title}'`;
  if (!title.includes(')') && !title.includes('(')) return ` (${title})`;
  return '';
}

type Form = { tags: boolean; escape: (s: string) => string };
const FORMS: Form[] = [
  { tags: false, escape: escapePlain },
  { tags: false, escape: escapeAll },
  { tags: true, escape: escapeAll },
];

function openOf(m: Mark, tags: boolean): string {
  switch (m.type) {
    case 'bold':
      return tags ? '<b>' : '**';
    case 'italic':
      return tags ? '<i>' : '*';
    case 'strike':
      return tags ? '<s>' : '~~';
    case 'underline':
      return '<u>';
    case 'highlight': {
      const c = highlightColor(m);
      return c === DEFAULT_HIGHLIGHT ? '<mark>' : `<mark data-color="${c}">`;
    }
    case 'textColor':
      return `<span data-text-color="${m.attrs?.['color'] as string}">`;
    case 'link':
      return '[';
    default:
      return '';
  }
}

function closeOf(m: Mark, tags: boolean): string {
  switch (m.type) {
    case 'bold':
      return tags ? '</b>' : '**';
    case 'italic':
      return tags ? '</i>' : '*';
    case 'strike':
      return tags ? '</s>' : '~~';
    case 'underline':
      return '</u>';
    case 'highlight':
      return '</mark>';
    case 'textColor':
      return '</span>';
    case 'link': {
      const href = safeHref(m.attrs?.['href'] as string) as string;
      const title = typeof m.attrs?.['title'] === 'string' ? m.attrs['title'] : '';
      return `](${destination(href)}${titlePart(title)})`;
    }
    default:
      return '';
  }
}

/** Text and breaks, neighbours with the same marks as one run, as the editor holds them: two runs of code side by side would read as one run of backticks. */
function runsOf(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  let lastKey: string | null = null;
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out.push(n);
      lastKey = null;
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const marks = marksOf(n);
    const key = marks.map((m) => markKey(m) as string).join('\u0002');
    const last = out[out.length - 1];
    if (last && lastKey === key) last.text = (last.text ?? '') + n.text;
    else out.push({ type: 'text', text: n.text, marks });
    lastKey = key;
  }
  return out;
}

/** One block's inline content in one form. A space at the block's very start or end is an entity, so it stays. */
function render(nodes: PMNode[], form: Form): string {
  const content = runsOf(nodes);
  let out = '';
  const open: Mark[] = [];
  const closeTo = (n: number): void => {
    while (open.length > n) out += closeOf(open.pop() as Mark, form.tags);
  };
  content.forEach((node, index) => {
    if (node.type === 'hardBreak') {
      // Marks close before a break and open again after it: `*a*<br>*b*` reads back as written, `*a<br>*b` doesn't.
      closeTo(0);
      out += '<br>';
      return;
    }
    const marks = marksOf(node);
    if (marks[0]?.type === 'code') {
      closeTo(0);
      const code = node.text ?? '';
      // Inline code turns a line break into a space, so code with one is a tag, its breaks entities, as text is.
      if (/[\n\r]/.test(code)) {
        let body = escapeAll(code);
        if (index === 0 && /^[ \t]/.test(code)) body = entity(code[0] as string) + escapeAll(code.slice(1));
        if (index === content.length - 1 && /[ \t]$/.test(code)) body = body.slice(0, -1) + entity(code[code.length - 1] as string);
        out += `<code>${body}</code>`;
      } else out += codeSpan(code);
      return;
    }
    let keep = 0;
    while (keep < open.length && keep < marks.length && markKey(open[keep] as Mark) === markKey(marks[keep] as Mark)) keep += 1;
    closeTo(keep);
    for (const m of marks.slice(keep)) {
      out += openOf(m, form.tags);
      open.push(m);
    }
    let text = node.text ?? '';
    let head = '';
    let tail = '';
    if (index === 0 && /^[ \t]/.test(text)) {
      head = entity(text[0] as string);
      text = text.slice(1);
    }
    if (index === content.length - 1 && /[ \t]$/.test(text)) {
      tail = entity(text[text.length - 1] as string);
      text = text.slice(0, -1);
    }
    out += head + form.escape(text) + tail;
  });
  closeTo(0);
  return out;
}

/** A block's inline content in the plainest form that markdown.ts reads back as exactly this. */
function inlineOf(nodes: PMNode[] = []): string {
  const want = canonical(nodes);
  for (const form of FORMS) {
    const s = render(nodes, form);
    if (canonical(inline(s)) === want) return s;
  }
  return render(nodes, FORMS[FORMS.length - 1] as Form);
}

/** A line that would read as some other block where a block starts gets a backslash on its first character. */
function guardStart(s: string): string {
  // Text never starts with a backtick that isn't inline code's, and inline code is never a fence: its run comes again.
  if (/^(?:#{1,6}|[-+*>])(?=[ \t]|$)/.test(s) || /^[>{]/.test(s) || /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s) || /^~{3,}/.test(s)) return `\\${s}`;
  const n = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(s);
  if (n) return `${n[1] as string}\\${s.slice((n[1] as string).length)}`;
  return s;
}

// ------------------------------------------------------------------ blocks

const colorOf = (node: PMNode): string | null => (isPaletteId(node.attrs?.['color']) ? (node.attrs?.['color'] as string) : null);

/** Blocks, a blank line between each: as lines. Two lists of a kind in a row take turns with their markers, as CommonMark ends a list at a new one. */
function blocks(nodes: PMNode[] = []): string[] {
  const out: string[] = [];
  let prev: PMNode | null = null;
  let flip = false;
  for (const node of nodes) {
    flip = LISTS.has(node.type) && prev?.type === node.type ? !flip : false;
    const lines = block(node, flip);
    if (lines) {
      if (out.length) out.push('');
      out.push(...lines);
    }
    prev = node;
  }
  return out;
}

const indent = (lines: string[], pad: string): string[] => lines.map((l) => (l ? pad + l : l));

function block(node: PMNode, flip: boolean): string[] | null {
  const color = COLORED.has(node.type) ? colorOf(node) : null;
  const lines = blockLines(node, flip);
  if (!lines) return null;
  return color ? [`{color=${color}}`, ...lines] : lines;
}

function blockLines(node: PMNode, flip: boolean): string[] | null {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.['level'] ?? 1) || 1));
      // A `#` at the end, unless escaped already, would read as the heading's closing sequence.
      let text = inlineOf(node.content);
      if (/(?:^|[^\\])(?:\\\\)*#$/.test(text)) text = `${text.slice(0, -1)}\\#`;
      return [text ? `${'#'.repeat(level)} ${text}` : '#'.repeat(level)];
    }
    case 'paragraph': {
      const content = (node.content ?? []).filter((n) => n.type === 'hardBreak' || (n.type === 'text' && n.text));
      return [content.length ? guardStart(inlineOf(content)) : '<p></p>'];
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      const language = typeof node.attrs?.['language'] === 'string' ? (node.attrs['language'] as string).split(/\s+/)[0] ?? '' : '';
      const ch = language.includes('`') ? '~' : '`';
      let longest = 2;
      for (const m of text.matchAll(ch === '`' ? /`+/g : /~+/g)) longest = Math.max(longest, m[0].length);
      const fence = ch.repeat(longest + 1);
      // A language that starts with the fence's character would read as part of the fence.
      return [`${fence}${language.startsWith(ch) ? ' ' : ''}${language}`, ...(text ? text.split('\n') : []), fence];
    }
    case 'horizontalRule':
      return ['---'];
    case 'blockquote': {
      const inner = blocks(node.content);
      return (inner.length ? inner : ['<p></p>']).map((l) => (l ? `> ${l}` : '>'));
    }
    case 'bulletList':
    case 'taskList':
      return items(node, (_i, item) => (flip ? '*' : '-') + (node.type === 'taskList' ? ` [${item.attrs?.['checked'] ? 'x' : ' '}]` : ''));
    case 'orderedList': {
      const start = Math.max(0, Math.floor(Number(node.attrs?.['start'] ?? 1)) || 0);
      return items(node, (i) => `${start + i}${flip ? ')' : '.'}`);
    }
    default:
      // A node the schema doesn't have: its blocks, if any.
      return node.content ? blocks(node.content) : null;
  }
}

/**
 * A list's items: the marker, the item's color, its first paragraph on that line, then its other blocks indented to
 * where the content starts (the marker's width and a space), a blank line before each.
 */
function items(list: PMNode, markerOf: (i: number, item: PMNode) => string): string[] {
  const out: string[] = [];
  (list.content ?? []).forEach((item, i) => {
    const marker = markerOf(i, item);
    // A task's box is the start of its paragraph's text, so what's under it lines up with the bullet's content.
    const width = (/^\d/.test(marker) ? marker.length : 1) + 1;
    const pad = ' '.repeat(width);
    const [first, ...rest] = item.content ?? [];
    const color = colorOf(item);
    const children = blocks(first?.type === 'paragraph' ? rest : (item.content ?? []));
    let text = first?.type === 'paragraph' ? guardStart(inlineOf(first.content)) : '';
    // An empty first line before other blocks is said, or the next block would read as the item's first line.
    if (!text && children.length) text = '<p></p>';
    const head = [marker, color ? `{color=${color}}` : '', text].filter(Boolean).join(' ');
    out.push(head);
    if (children.length) out.push('', ...indent(children, pad));
  });
  return out;
}

/** The page as Markdown, ending with one line break. Nothing in it is an empty string. */
export function pageMarkdown(doc: PMNode): string {
  const lines = blocks(doc.content);
  return lines.length ? `${lines.join('\n')}\n` : '';
}
