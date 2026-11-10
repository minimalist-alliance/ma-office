// The member's initials avatar (task 45; the Product Designer's badge spec, `spec.json` in design-drafts/badges): up
// to two initials on one of six tints. Pure, so the other apps can match it exactly: the same member gets the same tint
// in the Desk, Platform and Guild apps only if each picks it the same way, which is `hueOf` below.

export const HUES = ['blue', 'green', 'amber', 'rose', 'violet', 'slate'] as const;
export type Hue = (typeof HUES)[number];

/**
 * The tint for a member, stable for life: FNV-1a (32 bit) over the UTF-8 bytes of their id, mod 6, into `HUES` in the
 * spec's order. The same hue in every theme; only the theme's values differ.
 */
export function hueOf(id: string): Hue {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return HUES[h % HUES.length] ?? 'slate';
}

const LETTER = /\p{L}/u;

/** The first letter of a word, as a whole character: an accent or a letter outside the BMP stays in one piece. */
function firstLetter(word: string): string {
  const chars = Array.from(word);
  const i = chars.findIndex((c) => LETTER.test(c));
  if (i < 0) return '';
  // Combining marks that follow it belong to it.
  let out = chars[i] ?? '';
  for (let j = i + 1; j < chars.length && /\p{M}/u.test(chars[j] ?? ''); j += 1) out += chars[j];
  return out;
}

/**
 * Up to two initials, upper-cased: the first letter of the first and the last word of the display name (the spec's
 * rule). Without a display name, the words of the email's local part, split at dots, dashes, plus signs and underscores.
 * Words with no letter count for nothing, so "member-1@…" is "M". Empty when there's nothing to go on.
 */
export function initialsOf(displayName: string | null | undefined, email?: string | null): string {
  const name = displayName?.trim();
  const words = name ? name.split(/\s+/) : (email?.split('@')[0] ?? '').split(/[._+\-\s]+/);
  const lettered = words.filter((w) => LETTER.test(w));
  if (!lettered.length) return '';
  const first = firstLetter(lettered[0] ?? '');
  const last = lettered.length > 1 ? firstLetter(lettered[lettered.length - 1] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}
