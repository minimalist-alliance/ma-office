/** What the desk refused, in the member's words. Restore is the trasher's or a moderator's (`pages.deleted_by`), and the tree can't say whose, so the refusal is what tells. */
export const RESTORE_REFUSED = 'Only the person who deleted this page, or a moderator, can restore it.';

export const restoreRefusal = (err: unknown): string | null => ((err as { code?: unknown } | null)?.code === 'forbidden' ? RESTORE_REFUSED : null);
