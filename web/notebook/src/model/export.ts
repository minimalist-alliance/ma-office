// Export a page (design 5.6, Phase 1): GitHub-flavoured Markdown and self-contained HTML. Pure.
// PDF is the browser's own print of the page (ui/print.ts). Notebook ZIPs are Phase 2.
//
// Colors (ADR 0091), as each format allows. The page stores colors' names; `palette` says what each looks like at export
// time. HTML keeps the names as `data-*` attributes, so pasting it back into a page keeps them, and draws them from a
// stylesheet made from `palette`. Markdown has no colors: a highlight stays `<mark>`, and with `palette` the inline HTML GitHub drops and most
// other readers draw (`style`). Block colors and labels are only in HTML and the notebook file (`notebookFile.ts`).
import { DEFAULT_HIGHLIGHT, highlightId, isPaletteId, type PaletteColors, type PaletteId } from './colors.ts';
import { LINK_PROTOCOLS, type PMNode } from './schema.ts';

export interface ExportOptions {
  /** Light-theme values for each color, from the UI's palette. Without it, Markdown has no colors and HTML only the names. */
  palette?: PaletteColors | undefined;
}

/** A palette value as CSS, or null: only `#rgb`/`#rrggbb`, so nothing from a palette can break out of a style. */
function cssColor(palette: PaletteColors | undefined, id: PaletteId | null, role: 'highlight' | 'text' | 'callout' | 'label'): string | null {
  const v = id && palette?.[id]?.[role];
  return typeof v === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : null;
}

type Mark = NonNullable<PMNode['marks']>[number];

/** Only these hrefs survive export; anything else becomes plain text. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim());
  return m && LINK_PROTOCOLS.includes((m[1] ?? '').toLowerCase()) ? href.trim() : null;
}

// ------------------------------------------------------------------ Markdown

const MD_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'highlight', 'textColor', 'code'];
type MdTag = (m: Mark, palette?: PaletteColors) => string;
const MD_OPEN: Record<string, MdTag> = {
  bold: () => '**',
  italic: () => '_',
  strike: () => '~~',
  underline: () => '<u>',
  highlight: (m, palette) => {
    const bg = cssColor(palette, highlightId(m.attrs?.['color']), 'highlight');
    return bg ? `<mark style="background-color: ${bg}">` : '<mark>';
  },
  textColor: (m, palette) => {
    const fg = cssColor(palette, isPaletteId(m.attrs?.['color']) ? m.attrs['color'] : null, 'text');
    return fg ? `<span style="color: ${fg}">` : '';
  },
  code: () => '`',
  link: () => '[',
};
const MD_CLOSE: Record<string, MdTag> = {
  bold: () => '**',
  italic: () => '_',
  strike: () => '~~',
  underline: () => '</u>',
  highlight: () => '</mark>',
  textColor: (m, palette) => (cssColor(palette, isPaletteId(m.attrs?.['color']) ? m.attrs['color'] : null, 'text') ? '</span>' : ''),
  code: () => '`',
  link: (m) => `](${(safeHref(m.attrs?.['href']) ?? '').replace(/[()\s]/g, encodeURIComponent)})`,
};

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]<>~|])/g, '\\$1');
}

function sortedMarks(node: PMNode): Mark[] {
  return (node.marks ?? [])
    .filter((m) => MD_ORDER.includes(m.type) && (m.type !== 'link' || safeHref(m.attrs?.['href'])))
    .sort((a, b) => MD_ORDER.indexOf(a.type) - MD_ORDER.indexOf(b.type));
}

const sameMark = (a: Mark, b: Mark): boolean => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

/** Inline content with marks opened and closed across neighbouring text nodes, as prosemirror-markdown does. */
let mdPalette: PaletteColors | undefined;

function mdInline(nodes: PMNode[] = []): string {
  let out = '';
  const open: Mark[] = [];
  const closeTo = (n: number) => {
    while (open.length > n) {
      const m = open.pop() as Mark;
      out += MD_CLOSE[m.type]?.(m, mdPalette) ?? '';
    }
  };
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      closeTo(0);
      out += '\\\n';
      continue;
    }
    if (node.type !== 'text') continue;
    const marks = sortedMarks(node);
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep] as Mark, marks[keep] as Mark)) keep += 1;
    closeTo(keep);
    for (const m of marks.slice(keep)) {
      out += MD_OPEN[m.type]?.(m, mdPalette) ?? '';
      open.push(m);
    }
    const inCode = open.some((m) => m.type === 'code');
    out += inCode ? (node.text ?? '').replace(/`/g, 'ˋ') : escapeMd(node.text ?? '');
  }
  closeTo(0);
  return out;
}

/** A line that would read as Markdown syntax at the start of a block gets a backslash. */
function guardLineStart(s: string): string {
  return s.replace(/^(\s*)([#+-]|\d+[.)])(\s)/, '$1\\$2$3');
}

function mdBlocks(nodes: PMNode[] = [], indent = ''): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const block = mdBlock(node, indent);
    if (block !== null) out.push(block);
  }
  return out;
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

function mdListItems(items: PMNode[] = [], indent: string, bullet: (i: number, item: PMNode) => string): string {
  return items
    .map((item, i) => {
      const lead = bullet(i, item);
      const pad = indent + ' '.repeat(lead.length);
      const blocks = item.content ?? [];
      const first = blocks[0];
      const inlineFirst = first?.type === 'paragraph' || first?.type === 'heading';
      const lines = [`${indent}${lead}${inlineFirst ? mdInline(first?.content) : ''}`];
      for (const c of inlineFirst ? blocks.slice(1) : blocks) {
        const b = mdBlock(c, pad);
        if (b === null) continue;
        // A nested list indents itself; anything else is indented here, every line of it.
        lines.push(LISTS.has(c.type) ? b : b.split('\n').map((l) => (l ? pad + l : l)).join('\n'));
      }
      return lines.join('\n');
    })
    .join('\n');
}

function mdBlock(node: PMNode, indent: string): string | null {
  switch (node.type) {
    case 'heading': {
      const level = Number(node.attrs?.['level'] ?? 1);
      const text = mdInline(node.content);
      return text ? `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${text}` : '';
    }
    case 'paragraph':
      return guardLineStart(mdInline(node.content));
    case 'bulletList':
      return mdListItems(node.content, indent, () => '- ');
    case 'orderedList': {
      const start = Number(node.attrs?.['start'] ?? 1);
      return mdListItems(node.content, indent, (i) => `${start + i}. `);
    }
    case 'taskList':
      return mdListItems(node.content, indent, (_i, item) => (item.attrs?.['checked'] ? '- [x] ' : '- [ ] '));
    case 'blockquote':
      return mdBlocks(node.content)
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      const fence = text.includes('```') ? '~~~' : '```';
      const lang = typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : '';
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    default:
      return node.content ? mdBlocks(node.content, indent).join('\n\n') : null;
  }
}

export function toMarkdown(doc: PMNode, o: ExportOptions = {}): string {
  mdPalette = o.palette;
  try {
    const blocks = mdBlocks(doc.content).filter((b, i, all) => b !== '' || (i > 0 && all[i - 1] !== ''));
    return `${blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  } finally {
    mdPalette = undefined;
  }
}

// ------------------------------------------------------------------ HTML

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const HTML_MARK: Record<string, [string, string]> = {
  bold: ['<strong>', '</strong>'],
  italic: ['<em>', '</em>'],
  strike: ['<s>', '</s>'],
  underline: ['<u>', '</u>'],
  code: ['<code>', '</code>'],
};

/** A highlight's or text color's tags, carrying the name as the editor renders it, so the HTML pastes back with its colors. */
function htmlColorMark(m: Mark): [string, string] | null {
  if (m.type === 'highlight') return [`<mark data-color="${highlightId(m.attrs?.['color']) ?? DEFAULT_HIGHLIGHT}">`, '</mark>'];
  if (m.type === 'textColor' && isPaletteId(m.attrs?.['color'])) return [`<span data-text-color="${m.attrs['color']}">`, '</span>'];
  return null;
}

/** ` data-block-color="green"` for a colored block (a callout), else nothing. */
const blockColorAttr = (node: PMNode): string => (isPaletteId(node.attrs?.['color']) ? ` data-block-color="${node.attrs['color']}"` : '');

function htmlInline(nodes: PMNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '<br>';
      if (n.type !== 'text') return '';
      let s = escapeHtml(n.text ?? '');
      for (const m of [...sortedMarks(n)].reverse()) {
        if (m.type === 'link') {
          const href = safeHref(m.attrs?.['href']);
          if (href) s = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${s}</a>`;
        } else {
          const tags = HTML_MARK[m.type] ?? htmlColorMark(m);
          if (tags) s = `${tags[0]}${s}${tags[1]}`;
        }
      }
      return s;
    })
    .join('');
}

function htmlBlock(node: PMNode): string {
  const inner = () => (node.content ?? []).map(htmlBlock).join('');
  const c = blockColorAttr(node);
  switch (node.type) {
    case 'heading': {
      const l = Math.min(6, Math.max(1, Number(node.attrs?.['level'] ?? 1)));
      return `<h${l}${c}>${htmlInline(node.content)}</h${l}>`;
    }
    case 'paragraph':
      return `<p${c}>${htmlInline(node.content)}</p>`;
    case 'bulletList':
      return `<ul${c}>${inner()}</ul>`;
    case 'orderedList': {
      const start = Number(node.attrs?.['start'] ?? 1);
      return start === 1 ? `<ol${c}>${inner()}</ol>` : `<ol start="${start}"${c}>${inner()}</ol>`;
    }
    case 'listItem':
      return `<li${c}>${inner()}</li>`;
    case 'taskList':
      return `<ul class="tasks"${c}>${inner()}</ul>`;
    case 'taskItem': {
      const checked = !!node.attrs?.['checked'];
      return `<li class="task${checked ? ' done' : ''}"${c}><input type="checkbox" disabled${checked ? ' checked' : ''}><div>${inner()}</div></li>`;
    }
    case 'blockquote':
      return `<blockquote${c}>${inner()}</blockquote>`;
    case 'codeBlock':
      return `<pre${c}><code>${escapeHtml((node.content ?? []).map((x) => x.text ?? '').join(''))}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    default:
      return inner();
  }
}

/** The stylesheet for the palette's colors, for a file that has no theme: the values `palette` gives, light. */
export function paletteCss(palette: PaletteColors | undefined): string {
  if (!palette) return '';
  const rules: string[] = [];
  for (const id of Object.keys(palette) as PaletteId[]) {
    if (!isPaletteId(id)) continue;
    const hl = cssColor(palette, id, 'highlight');
    const fg = cssColor(palette, id, 'text');
    const bg = cssColor(palette, id, 'callout');
    const rule = cssColor(palette, id, 'label');
    if (hl) rules.push(`mark[data-color="${id}"]{background:${hl}}`);
    if (fg) rules.push(`[data-text-color="${id}"]{color:${fg}}`);
    // A callout: its background, and the spec's 3 px rule on the left in the color's label value.
    if (bg) rules.push(`[data-block-color="${id}"]{background:${bg};${rule ? `border-left:3px solid ${rule};` : ''}border-radius:6px;padding:4px 8px}`);
  }
  // An old page's highlight is "yellow", which is amber.
  const amber = cssColor(palette, DEFAULT_HIGHLIGHT, 'highlight');
  if (amber) rules.push(`mark[data-color="yellow"]{background:${amber}}`);
  return rules.join('\n');
}

/** The page body as HTML, without a document around it. */
export function toHtmlBody(doc: PMNode): string {
  return (doc.content ?? []).map(htmlBlock).join('\n');
}

/** A complete HTML file that opens anywhere, with its stylesheet inside and nothing fetched. */
export function toHtmlDocument(doc: PMNode, title: string, css: string, o: ExportOptions = {}): string {
  const colors = paletteCss(o.palette);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title || 'Note')}</title>`,
    `<style>${colors ? `${css}\n${colors}` : css}</style>`,
    '</head>',
    '<body>',
    '<main>',
    toHtmlBody(doc),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A file name from a page title: no path characters, never empty. */
export function fileName(title: string, ext: string): string {
  const base = title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'Note'}.${ext}`;
}
