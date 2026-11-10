// Renaming a desk (task 45; contract tiers.md section 8, and the Product Designer's words.md): who may, what a name may
// be, and every failure in plain words. Pure. The name is a label only: the desk's kind never changes with it.
import { namesList, tierRenames, type TierId, type TierNames } from '../platform/tiers';

export const MAX_DESK_NAME = 40;

/** Control characters, which a name may not hold. A field never types them, but a paste can bring a tab. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`, 'g');
export const withoutControls = (text: string): string => text.replace(CONTROL, ' ');

export const NAME_RULE = 'Use 1 to 40 characters.';
export const DIDNT_SAVE = "That didn't save. Try again in a moment.";

/** A name as Platform keeps it: trimmed, with each run of spaces made one. */
export const cleanName = (typed: string): string => typed.trim().replace(/\s+/g, ' ');

/** What's wrong with a name as typed, cleaned as Platform cleans it, or null: 1 to 40 characters, counted as code points. */
export function nameProblem(typed: string): string | null {
  const name = cleanName(typed);
  const length = Array.from(name).length;
  return length < 1 || length > MAX_DESK_NAME || withoutControls(name) !== name ? NAME_RULE : null;
}

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

export interface FailureLike {
  status?: number;
  code?: string | null;
  details?: Record<string, unknown> | null;
}

/** A failed `PATCH /v1/desks/{deskId}`, in words. Anything not Platform's answer (offline, a timeout) didn't save. */
export function renameFailure(err: FailureLike | null, names: TierNames): string {
  if (!err || typeof err.status !== 'number') return DIDNT_SAVE;
  if (err.code === 'tier_required') {
    const tiers = Array.isArray(err.details?.['tiers']) ? (err.details['tiers'] as unknown[]) : [];
    return `Renaming a desk comes with ${namesList(tiers, names, ['officer', 'lead'])}.`;
  }
  if (err.status === 400) return NAME_RULE;
  if (err.status === 404) return "That desk isn't in your office.";
  if (err.status === 429 || err.status >= 500) return DIDNT_SAVE;
  return "This desk can't be renamed right now.";
}
