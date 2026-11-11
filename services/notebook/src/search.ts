// Search (design 5.6): FTS5, bm25, title weighted five times. The rules are model/search.ts's: every word must match,
// by prefix at a word start, ignoring case and accents, with has:checklist. Highlight offsets come from the same model.
import { type Db } from './db.ts';
import { findMatches, fold, isPaletteId, merge, parseQuery, type SearchHit, type SearchOptions } from './model.ts';

const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

interface Row {
  id: string;
  title: string;
  snippet: string;
  score: number;
  label: string | null;
}

/** ADR 0091: a hit says its page's label, only when it has one. */
const withLabel = (hit: SearchHit, label: string | null): SearchHit => (isPaletteId(label) ? { ...hit, label } : hit);

function ranges(text: string, terms: string[]): [number, number][] {
  const hay = fold(text);
  return merge(terms.flatMap((t) => findMatches(hay, t)));
}

export function search(db: Db, query: string, o: SearchOptions = {}): SearchHit[] {
  const parsed = parseQuery(query);
  const labels = (o.labels ?? []).filter(isPaletteId);
  if (!parsed.terms.length && !parsed.hasChecklist && !labels.length) return [];
  const where = ['p.deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (labels.length) {
    where.push(`p.label IN (${labels.map(() => '?').join(', ')})`);
    params.push(...labels);
  }
  if (o.tabId) {
    where.push('p.tab_id = ?');
    params.push(o.tabId);
  }
  if (o.notebookId) {
    where.push('p.tab_id IN (SELECT id FROM tabs WHERE notebook_id = ?)');
    params.push(o.notebookId);
  }
  if (parsed.hasChecklist) where.push('p.has_checklist = 1');
  if (o.fromDay || o.toDay) {
    where.push('EXISTS (SELECT 1 FROM page_activity a WHERE a.page_id = p.id AND a.day >= ? AND a.day <= ?)');
    params.push(o.fromDay ?? '0000-00-00', o.toDay ?? '9999-99-99');
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, o.limit ?? DEFAULT_LIMIT));

  if (!parsed.terms.length) {
    return db
      .all<Row>(`SELECT p.id, p.title, p.snippet, 0 AS score, p.label FROM pages p WHERE ${where.join(' AND ')} ORDER BY p.title COLLATE NOCASE LIMIT ?`, ...params, limit)
      .map((r) => withLabel({ pageId: r.id, score: 0, title: r.title, titleMatches: [], snippet: r.snippet, snippetMatches: [] }, r.label));
  }

  // Each term is quoted, so nothing a member types is an FTS5 operator, and starred, so it matches by prefix.
  const match = parsed.terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
  const rows = db.all<Row>(
    `SELECT p.id, p.title, snippet(pages_fts, 1, '', '', '…', 32) AS snippet, -bm25(pages_fts, 5.0, 1.0) AS score, p.label
     FROM pages_fts JOIN pages p ON p.pk = pages_fts.rowid
     WHERE pages_fts MATCH ? AND ${where.join(' AND ')}
     ORDER BY bm25(pages_fts, 5.0, 1.0), p.title COLLATE NOCASE
     LIMIT ?`,
    match,
    ...params,
    limit,
  );
  return rows.map((r) => {
    const snippet = r.snippet.replace(/\n/g, ' ');
    return withLabel({ pageId: r.id, score: r.score, title: r.title, titleMatches: ranges(r.title, parsed.terms), snippet, snippetMatches: ranges(snippet, parsed.terms) }, r.label);
  });
}
