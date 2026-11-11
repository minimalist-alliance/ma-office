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

/**
 * The address of a member's checked picture, or null (acct-picture; ma-platform contract profile-picture.md section 5).
 * Only ever Platform's own public avatar route over https: `https://api.<host>/v1/public/avatars/im_...`. Anything else (another
 * path, http, a data: or blob: address, a different shape) is initials, so the app can't be made to show a picture the
 * image check did not pass.
 */
const PICTURE_PATH = /^\/v1\/public\/avatars\/im_[a-z2-7]{26}$/;
export function pictureUrlOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !PICTURE_PATH.test(u.pathname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** A `Me`'s picture: `avatarUrl`, else the `avatar` object when its kind is `upload`. Other kinds are not a picture address (a built avatar is `builtRecipeOf`). */
export function pictureOf(me: { avatarUrl?: unknown; avatar?: unknown } | null | undefined): string | null {
  if (!me) return null;
  const direct = pictureUrlOf(me.avatarUrl);
  if (direct) return direct;
  const a = me.avatar as { kind?: unknown; url?: unknown } | null | undefined;
  return a && typeof a === 'object' && a.kind === 'upload' ? pictureUrlOf(a.url) : null;
}

/**
 * A member's built avatar (acct-avatar): the recipe of `/v1/me` `avatar` when its kind is `built`. Checked again here, as
 * the server did: a plain object, `kind: 'built'`, `kit: 1`, at most 600 bytes of JSON. Ids inside are not checked: the
 * kit draws an unknown one as its category's default. Anything else is null, which is the initials.
 */
export const BUILT_MAX_BYTES = 600;
export function builtRecipeOf(me: { avatar?: unknown } | null | undefined): Record<string, unknown> | null {
  const a = me?.avatar as { kind?: unknown; config?: unknown } | null | undefined;
  if (!a || typeof a !== 'object' || a.kind !== 'built') return null;
  const c = a.config as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.getPrototypeOf(c) !== Object.prototype) return null;
  if (c['kind'] !== 'built' || c['kit'] !== 1) return null;
  try {
    const json = JSON.stringify(c);
    return new TextEncoder().encode(json).length <= BUILT_MAX_BYTES ? c : null;
  } catch {
    return null;
  }
}
