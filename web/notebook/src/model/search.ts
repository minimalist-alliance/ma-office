// Search over page titles and text (design 5.6), in memory. Pure.
// The desk will use SQLite FTS5 with bm25 and the title weighted x5; this follows the same rules
// closely enough for a local backend: every word must match, words match by prefix at a word
// start, case and accents are ignored, a title hit counts five times a body hit.
import type { MatchRange, SearchHit } from './types.ts';

export interface ParsedQuery {
  terms: string[];
  hasChecklist: boolean;
}

/** Lower-cases and strips accents one character at a time, so offsets in the result are offsets in the input. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    // Keep one UTF-16 unit per input unit, so ranges map back exactly.
    out += f.length === ch.length ? f : (f[0] ?? ch).padEnd(ch.length, ' ');
  }
  return out;
}

export function parseQuery(q: string): ParsedQuery {
  let hasChecklist = false;
  const terms: string[] = [];
  for (const raw of q.split(/\s+/)) {
    if (!raw) continue;
    if (raw.toLowerCase() === 'has:checklist') {
      hasChecklist = true;
      continue;
    }
    const t = fold(raw).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (t) terms.push(t);
  }
  return { terms: [...new Set(terms)], hasChecklist };
}

const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}]/u.test(c);

/** Where `term` starts a word in `hay` (both folded). */
export function findMatches(hay: string, term: string, max = Infinity): MatchRange[] {
  const out: MatchRange[] = [];
  let i = hay.indexOf(term);
  while (i >= 0 && out.length < max) {
    if (!isWordChar(hay[i - 1])) out.push([i, i + term.length]);
    i = hay.indexOf(term, i + 1);
  }
  return out;
}

interface Entry {
  title: string;
  text: string;
  titleF: string;
  textF: string;
  /** Where the text after the title line starts. */
  bodyStart: number;
}

export const SNIPPET_WINDOW = 160;

export class SearchIndex {
  private entries = new Map<string, Entry>();

  set(pageId: string, title: string, text: string): void {
    this.entries.set(pageId, { title, text, titleF: fold(title), textF: fold(text), bodyStart: text.includes('\n') ? text.indexOf('\n') + 1 : text.length });
  }

  delete(pageId: string): void {
    this.entries.delete(pageId);
  }

  has(pageId: string): boolean {
    return this.entries.has(pageId);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Ranked hits. `accept` filters pages (trash, notebook, dates, has:checklist) before scoring. */
  query(parsed: ParsedQuery, accept: (pageId: string) => boolean, limit = 50): SearchHit[] {
    if (!parsed.terms.length && !parsed.hasChecklist) return [];
    const hits: SearchHit[] = [];
    for (const [pageId, e] of this.entries) {
      if (!accept(pageId)) continue;
      let score = 0;
      let ok = true;
      const titleMatches: MatchRange[] = [];
      let firstBody = -1;
      for (const term of parsed.terms) {
        const inTitle = findMatches(e.titleF, term);
        const inBody = findMatches(e.textF, term, 200);
        if (!inTitle.length && !inBody.length) {
          ok = false;
          break;
        }
        titleMatches.push(...inTitle);
        score += 5 * inTitle.length + Math.log2(1 + inBody.length);
        const first = inBody.find((r) => r[0] >= e.bodyStart);
        if (first && (firstBody < 0 || first[0] < firstBody)) firstBody = first[0];
      }
      if (!ok) continue;
      const { snippet, snippetMatches } = this.snippet(e, parsed.terms, firstBody);
      hits.push({ pageId, score, title: e.title, titleMatches: merge(titleMatches), snippet, snippetMatches });
    }
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return hits.slice(0, limit);
  }

  private snippet(e: Entry, terms: string[], at: number): { snippet: string; snippetMatches: MatchRange[] } {
    // The text starts with the title line, which hits show apart, so a snippet is from the body.
    const { bodyStart } = e;
    const anchor = at >= 0 ? at : bodyStart;
    let start = Math.max(bodyStart, anchor - 40);
    if (start > bodyStart) {
      const space = e.text.lastIndexOf(' ', start);
      if (space > start - 20 && space >= 0) start = space + 1;
    }
    let end = Math.min(e.text.length, start + SNIPPET_WINDOW);
    if (end < e.text.length) {
      const space = e.text.lastIndexOf(' ', end);
      if (space > start + SNIPPET_WINDOW / 2) end = space;
    }
    const raw = e.text.slice(start, end);
    const lead = start > bodyStart ? '…' : '';
    const tail = end < e.text.length ? '…' : '';
    const flat = raw.replace(/\n/g, ' ');
    const folded = e.textF.slice(start, end);
    const matches: MatchRange[] = [];
    for (const t of terms) for (const [a, b] of findMatches(folded, t)) matches.push([a + lead.length, b + lead.length]);
    return { snippet: `${lead}${flat}${tail}`, snippetMatches: merge(matches) };
  }
}

export function merge(ranges: MatchRange[]): MatchRange[] {
  const s = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: MatchRange[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
