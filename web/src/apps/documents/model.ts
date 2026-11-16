// Documents' rules, pure, so each has a test: an item's line, which chips it offers, how "All desks" puts the member's desks'
// lists together in the browser (as To-do's does; nothing of it goes to a server), and the viewer's sums (the page width it
// asks for, the page it opens at, which page is in view).
import type { Chip, Counts, Doc, Place } from './types';
import { W } from './words';

/** A document with the desk it lives on: an item from another desk shows that desk's name. */
export type Located = Doc & { deskId: string };

/**
 * `{who} · {what} · {reason}` (§20.3 `item.one`), from the desk's own title (`{date} · {who} · {what}`, §25) and its reason's
 * words. A title in another shape stands whole as the `what`, with the sender's name as the `who` when there is one.
 */
export function itemParts(d: Doc): { date: string; who: string; what: string; reason: string } {
  const parts = d.title.split(' · ');
  if (parts.length >= 3) return { date: parts[0]!, who: parts[1]!, what: parts.slice(2).join(' · '), reason: d.reason.text };
  return { date: '', who: d.from?.name ?? '', what: d.title, reason: d.reason.text };
}

export function itemLine(d: Doc): string {
  const p = itemParts(d);
  return [p.who, p.what, p.reason].filter(Boolean).join(' · ');
}

/** The chips an item offers (§20.3, the shield's plus Done). Not important on a Record moves nothing, so it's left out there. */
export function chipsFor(d: Doc): Chip[] {
  if (d.place === 'needs') return ['not_now', 'not_important', 'sooner', 'done'];
  if (d.place === 'records') return ['sooner', 'done'];
  return ['not_important', 'sooner', 'done'];
}

export const CHIP_WORDS: Record<Chip, string> = { not_now: W.notNow, not_important: W.notImportant, sooner: W.sooner, done: W.done };

/** What the item shows under its line: the reader's note (italic, hers), or code's fixed words for a sensitive one (§13.2). */
export function noteFor(d: Doc, inViewer = false): { kind: 'summary' | 'sensitive'; text: string } | null {
  if (d.sensitive && !inViewer) return d.sensitiveText ? { kind: 'sensitive', text: d.sensitiveText } : null;
  return d.summary?.line ? { kind: 'summary', text: d.summary.line } : null;
}

export interface DeskList {
  deskId: string;
  items: Doc[];
  counts: Counts | null;
  end: string | null;
  more: boolean;
}

export const ZERO: Counts = { needs: 0, maybe: 0, read: 0, records: 0, working: 0 };

export function sumCounts(all: readonly (Counts | null)[]): Counts {
  const s = { ...ZERO };
  for (const c of all) {
    if (!c) continue;
    s.needs += c.needs;
    s.maybe += c.maybe;
    s.read += c.read;
    s.records += c.records;
    s.working += c.working;
  }
  return s;
}

/** A place's count as its tab shows it: Needs you counts its Maybe too (§25 `docs.list`: "Maybe included, after"). */
export const placeCount = (c: Counts, p: Place): number => (p === 'needs' ? c.needs + c.maybe : c[p]);

/**
 * "All desks": each desk's list as that desk ordered it, this desk's first, then the others in the office's order. In Needs you
 * every desk's sure items come before any desk's Maybe, so the divider stays one line. The end words show only once every desk
 * has said it has nothing more.
 */
export function mergeLists(lists: readonly DeskList[], place: Place): { sure: Located[]; maybe: Located[]; counts: Counts; end: string | null; more: boolean } {
  const sure: Located[] = [];
  const maybe: Located[] = [];
  const seen = new Set<string>();
  for (const l of lists) {
    for (const d of l.items) {
      const key = `${l.deskId}|${d.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at: Located = { ...d, deskId: l.deskId };
      if (place === 'needs' && d.maybe) maybe.push(at);
      else sure.push(at);
    }
  }
  const more = lists.some((l) => l.more);
  const end = !more && lists.length > 0 && lists.every((l) => l.end) ? lists[0]!.end : null;
  return { sure, maybe, counts: sumCounts(lists.map((l) => l.counts)), end, more };
}

/** Search hits from each desk, kept in each desk's own order (deskd's: the same query, the same order for 7 days). */
export function mergeHits(lists: readonly { deskId: string; items: Doc[] }[]): Located[] {
  return lists.flatMap((l) => l.items.map((d) => ({ ...d, deskId: l.deskId })));
}

/** The People view's groups: each sender once, in the order the desk listed them, then the documents with nobody. */
export function byPerson(items: readonly Located[]): { key: string; name: string; items: Located[] }[] {
  const groups = new Map<string, { key: string; name: string; items: Located[] }>();
  for (const d of items) {
    const key = d.from?.personKey ?? (d.from?.name ? `name:${d.from.name}` : '');
    const g = groups.get(key) ?? { key, name: d.from?.name || '', items: [] };
    g.items.push(d);
    groups.set(key, g);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.key), ...all.filter((g) => !g.key)];
}

/** The width a page is asked at: what it shows at times the screen's pixel ratio, in hundreds, from 200 to 1,600 (§25). */
export function pageWidth(cssPx: number, dpr: number): number {
  const want = Math.ceil((Math.max(1, cssPx) * Math.max(1, dpr || 1)) / 100) * 100;
  return Math.min(1600, Math.max(200, want));
}

/** Where the viewer opens: the page asked (a handover's first changed page), else where the member was, within the document. */
export function openingPage(asked: number | null, lastPage: number, pageCount: number | null): number {
  const n = pageCount ?? Math.max(asked ?? 1, lastPage, 1);
  const want = asked ?? lastPage ?? 1;
  return Math.min(Math.max(1, want), Math.max(1, n));
}

/** The page most in view, from each page's visible share (0 to 1): ties go to the earlier page. */
export function pageInView(visible: ReadonlyMap<number, number>, fallback: number): number {
  let best = fallback;
  let share = 0;
  for (const [n, v] of [...visible.entries()].sort((a, b) => a[0] - b[0])) {
    if (v > share + 0.001) {
      best = n;
      share = v;
    }
  }
  return best;
}

/** The page a key moves to (PageUp, PageDown, Home, End), or null for any other key. */
export function pageForKey(key: string, at: number, count: number): number | null {
  switch (key) {
    case 'PageDown':
      return Math.min(count, at + 1);
    case 'PageUp':
      return Math.max(1, at - 1);
    case 'Home':
      return 1;
    case 'End':
      return count;
    default:
      return null;
  }
}

/** Files' View is offered for these, by the name's ending; the desk sniffs the bytes and says what it really is (§25 `type`). */
const VIEWABLE = /\.(pdf|png|jpe?g|gif|bmp|docx|xlsx|pptx|txt|md|markdown|csv)$/i;
export const viewableName = (name: string): boolean => VIEWABLE.test(name);

/** A Download is offered only for a copy in Files and never for a danger type (§20.4, the concept's §8.1). */
export function downloadPath(d: Doc, copies: readonly { path: string | null; gone: boolean; sourceKind: string }[]): string | null {
  if (d.danger) return null;
  return copies.find((c) => !c.gone && c.path && (c.sourceKind === 'files' || c.sourceKind === 'downloads'))?.path ?? null;
}
