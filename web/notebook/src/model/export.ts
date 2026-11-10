// Export a page (design 5.6, Phase 1): GitHub-flavoured Markdown and self-contained HTML. Pure.
// PDF is the browser's own print of the page (ui/print.ts). Notebook ZIPs are Phase 2.
import { LINK_PROTOCOLS, type PMNode } from './schema.ts';

type Mark = NonNullable<PMNode['marks']>[number];

/** Only these hrefs survive export; anything else becomes plain text. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim());
  return m && LINK_PROTOCOLS.includes((m[1] ?? '').toLowerCase()) ? href.trim() : null;
}

// ------------------------------------------------------------------ Markdown

const MD_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'highlight', 'code'];
const MD_OPEN: Record<string, (m: Mark) => string> = {
  bold: () => '**',
  italic: () => '_',
  strike: () => '~~',
  underline: () => '<u>',
  highlight: () => '<mark>',
  code: () => '`',
  link: () => '[',
};
const MD_CLOSE: Record<string, (m: Mark) => string> = {
  bold: () => '**',
  italic: () => '_',
  strike: () => '~~',
  underline: () => '</u>',
  highlight: () => '</mark>',
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
function mdInline(nodes: PMNode[] = []): string {
  let out = '';
  const open: Mark[] = [];
  const closeTo = (n: number) => {
    while (open.length > n) {
      const m = open.pop() as Mark;
      out += MD_CLOSE[m.type]?.(m) ?? '';
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
      out += MD_OPEN[m.type]?.(m) ?? '';
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

export function toMarkdown(doc: PMNode): string {
  const blocks = mdBlocks(doc.content).filter((b, i, all) => b !== '' || (i > 0 && all[i - 1] !== ''));
  return `${blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
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
  highlight: ['<mark>', '</mark>'],
};

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
          const tags = HTML_MARK[m.type];
          if (tags) s = `${tags[0]}${s}${tags[1]}`;
        }
      }
      return s;
    })
    .join('');
}

function htmlBlock(node: PMNode): string {
  const inner = () => (node.content ?? []).map(htmlBlock).join('');
  switch (node.type) {
    case 'heading': {
      const l = Math.min(6, Math.max(1, Number(node.attrs?.['level'] ?? 1)));
      return `<h${l}>${htmlInline(node.content)}</h${l}>`;
    }
    case 'paragraph':
      return `<p>${htmlInline(node.content)}</p>`;
    case 'bulletList':
      return `<ul>${inner()}</ul>`;
    case 'orderedList': {
      const start = Number(node.attrs?.['start'] ?? 1);
      return start === 1 ? `<ol>${inner()}</ol>` : `<ol start="${start}">${inner()}</ol>`;
    }
    case 'listItem':
      return `<li>${inner()}</li>`;
    case 'taskList':
      return `<ul class="tasks">${inner()}</ul>`;
    case 'taskItem': {
      const checked = !!node.attrs?.['checked'];
      return `<li class="task${checked ? ' done' : ''}"><input type="checkbox" disabled${checked ? ' checked' : ''}><div>${inner()}</div></li>`;
    }
    case 'blockquote':
      return `<blockquote>${inner()}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml((node.content ?? []).map((c) => c.text ?? '').join(''))}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    default:
      return inner();
  }
}

/** The page body as HTML, without a document around it. */
export function toHtmlBody(doc: PMNode): string {
  return (doc.content ?? []).map(htmlBlock).join('\n');
}

/** A complete HTML file that opens anywhere, with its stylesheet inside and nothing fetched. */
export function toHtmlDocument(doc: PMNode, title: string, css: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title || 'Note')}</title>`,
    `<style>${css}</style>`,
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
