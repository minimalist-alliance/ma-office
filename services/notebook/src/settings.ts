// The settings deskd sends: in the hello, as `settings`, and after it in `{"t":"settings","settings":{...}}` frames.
// So far one: `editBudget`, how much of other members' text a member without `moderate` may remove from one page in a
// rolling window (owners.ts). A hello without `settings`, and a desk-notebook that never reads them, keep the default.
// Anything out of bounds or malformed is ignored: the connection keeps what it has.

/** How much a member without `moderate` may remove of others' text from one page, over how long. */
export interface EditBudget {
  chars: number;
  windowMs: number;
}

export const MAX_BUDGET_CHARS = 100_000;
export const MAX_BUDGET_MINUTES = 1_440;
/** The default, pending the owner's word: change them here. */
export const DEFAULT_EDIT_BUDGET: EditBudget = Object.freeze({ chars: 500, windowMs: 10 * 60_000 });

/** `{chars, windowMinutes}` as deskd sends it, or null if it isn't one in bounds. `chars` 0 means only moderators remove. */
export function parseEditBudget(v: unknown): EditBudget | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const chars = b['chars'];
  const minutes = b['windowMinutes'];
  if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0 || chars > MAX_BUDGET_CHARS) return null;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BUDGET_MINUTES) return null;
  return Object.freeze({ chars, windowMs: minutes * 60_000 });
}

/** The budget in a hello's or a frame's `settings`, or null if there is none to use. */
export function parseSettings(v: unknown): EditBudget | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return parseEditBudget((v as Record<string, unknown>)['editBudget']);
}
