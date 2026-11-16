// Renaming a desk (task 45; contract tiers.md section 8, and the Product Designer's words.md): who may, and the kind beside a
// name. Pure. The name is a label only: the desk's kind never changes with it. What a name may be and every failure in plain
// words are `renameName.ts`, the rename field's own chunk's since `sub/mm-js-budget`.
import { tierRenames, type TierId } from '../platform/tiers';

/** "Personal desk": the kind, which stays visible whatever the name. A desk of no kind we know is just a desk. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'personal':
      return 'Personal desk';
    case 'work':
      return 'Work desk';
    case 'guild':
      return 'Guild desk';
    default:
      return 'Desk';
  }
}

const KIND_WORDS: Record<string, string> = { personal: 'Personal', work: 'Work', guild: 'Guild' };

/**
 * The kind to say beside a desk's name, "Personal desk", where the name doesn't say it already: a desk named for its
 * own kind ("Personal") needs no reminder, and a desk of no kind we know has none to give.
 */
export function kindTipFor(name: string, kind: string): string | null {
  const word = KIND_WORDS[kind];
  if (!word) return null;
  return name.trim().toLowerCase() === word.toLowerCase() ? null : kindLabel(kind);
}

/**
 * Whether Rename is offered on a desk: only where Platform says it would succeed (`allowedActions` has `rename`), and
 * only for a member whose live tier renames, so an Alliance member never sees it, even from an answer that's wrong.
 */
export const mayRename = (desk: { canRename?: boolean } | undefined, tier: TierId | null): boolean => !!desk?.canRename && tierRenames(tier);
