// Cycle order (design 3.1): spatial reading order, rows grouped by vertical overlap, then x. Ties go by id, so two
// things at the same place keep their order however the list they came from was arranged.
import type { LayoutItem, Rect } from '../canvas/layout';

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function readingOrder<T extends { id: string; rect: Rect }>(list: readonly T[]): T[] {
  const sorted = [...list].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || byId(a, b));
  const rows: { bottom: number; items: T[] }[] = [];
  for (const d of sorted) {
    const row = rows.find((r) => d.rect.y < r.bottom);
    if (row) {
      row.items.push(d);
      row.bottom = Math.max(row.bottom, d.rect.y + d.rect.h);
    } else {
      rows.push({ bottom: d.rect.y + d.rect.h, items: [d] });
    }
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y || byId(a, b)));
}

/** The order the keyboard and screen readers meet a desk's apps: by where they are, never by how they're stacked. A phone's list is its grid's order. */
export function appsInOrder(items: readonly LayoutItem[], phone: boolean): readonly LayoutItem[] {
  return phone ? items : readingOrder(items.map((item) => ({ id: item.id, rect: item, item }))).map((r) => r.item);
}
