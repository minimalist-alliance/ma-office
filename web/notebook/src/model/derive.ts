// What the lists, search and history need from a page body, worked out from ProseMirror JSON.
// Pure: the local backend runs it in this tab; a desk backend gets the same fields from deskd.
import type { PMNode } from './schema.ts';

export interface Derived {
  title: string;
  /** Text after the title, its blocks joined with " · ", trimmed to SNIPPET_CHARS. */
  snippet: string;
  /** All text, blocks on their own lines. What search indexes. */
  text: string;
  wordCount: number;
  hasChecklist: boolean;
}

export const SNIPPET_CHARS = 200;
const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'listItem', 'taskItem', 'horizontalRule']);

/** Plain text of one node, inline content joined, hard breaks as spaces. */
export function inlineText(node: PMNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  let out = '';
  for (const c of node.content ?? []) {
    out += inlineText(c);
    if (BLOCKS.has(c.type) && out && !out.endsWith('\n')) out += '\n';
  }
  return out;
}

/** Words as a member would count them: runs of letters, digits and apostrophes. */
export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}'’]+/gu);
  return m ? m.length : 0;
}

function hasType(node: PMNode, type: string): boolean {
  if (node.type === type) return true;
  return (node.content ?? []).some((c) => hasType(c, type));
}

export function derive(doc: PMNode): Derived {
  const blocks = doc.content ?? [];
  const lines: string[] = [];
  for (const b of blocks) {
    const t = inlineText(b).replace(/\n+$/, '');
    if (t) lines.push(t);
    else lines.push('');
  }
  // Title: the first line with text in it, as in Apple Notes. Empty if the page has none.
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  const firstLine = firstIdx >= 0 ? (lines[firstIdx] ?? '') : '';
  const title = firstLine.split('\n')[0]?.trim() ?? '';
  const rest = firstIdx >= 0 ? [...firstLine.split('\n').slice(1), ...lines.slice(firstIdx + 1)] : [];
  // Each block, and each item of a list, is one part, joined with " · " (the Product Designer's look 8), so a list reads as a list.
  const flat = rest
    .flatMap((r) => r.split('\n'))
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  const snippet = flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : flat;
  const text = lines.join('\n');
  return { title, snippet, text, wordCount: countWords(text), hasChecklist: hasType(doc, 'taskList') };
}
