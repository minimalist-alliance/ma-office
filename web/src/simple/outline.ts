// The page's outline (the spec's section 12) and a front page's own h1 (R61). Pure.
import type { KeyedBlock } from './docStore';

/**
 * The page's outline (the spec's section 12): one h1, the page's main heading (its first level 1, else its first),
 * then h2 to h4 in page order with no level skipped. The site's own headings inside a dialog stay out of it.
 */
export function outline(blocks: readonly KeyedBlock[], ownH1 = false): Map<string, number> {
  const heads = blocks.filter((kb) => kb.block.t === 'heading' && !kb.block.dialog);
  // A front page's h1 is the view's own, hidden (R61): its sections are h2, never promoted.
  const main = ownH1 ? undefined : (heads.find((kb) => kb.block.t === 'heading' && kb.block.level === 1) ?? heads[0]);
  const out = new Map<string, number>();
  let last = 1;
  for (const kb of heads) {
    if (kb === main) {
      out.set(kb.key, 1);
      last = 1;
      continue;
    }
    const page = kb.block.t === 'heading' ? kb.block.level : 2;
    const level = Math.max(2, Math.min(page, last + 1, 4));
    out.set(kb.key, level);
    last = level;
  }
  return out;
}

/** A site's front page: its address is the root, and it has no level-1 heading of its own but some of level 2 or below. */
export function isFront(url: string | null, blocks: readonly KeyedBlock[]): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.pathname !== '/' || u.search) return false;
  } catch {
    return false;
  }
  const heads = blocks.filter((kb) => kb.block.t === 'heading' && !kb.block.dialog);
  return heads.length > 0 && !heads.some((kb) => kb.block.t === 'heading' && kb.block.level === 1);
}
