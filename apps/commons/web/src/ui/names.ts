// Small words for people and times.

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = [...parts[0]!][0] ?? '';
  const b = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? '') : '';
  return (a + b).toUpperCase();
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const AVATAR = /^https:\/\/[a-z0-9.-]{1,253}\/v1\/public\/avatars\/im_[a-z2-7]{26}$/;
/** A member's picture address if it is exactly Platform's checked-avatar route; anything else is initials. */
export const pictureOf = (url: unknown): string | null => (typeof url === 'string' && AVATAR.test(url) ? url : null);

/**
 * A member's built avatar: the recipe object if it is a plain object with kind "built", kit 1 and at most 600 bytes of
 * JSON (the server checked it too); anything else is null, which is initials. The kit draws an unknown id as a default.
 */
export function builtRecipeOf(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return null;
  const c = v as Record<string, unknown>;
  if (c['kind'] !== 'built' || c['kit'] !== 1) return null;
  try {
    return new TextEncoder().encode(JSON.stringify(c)).length <= 600 ? c : null;
  } catch {
    return null;
  }
}
