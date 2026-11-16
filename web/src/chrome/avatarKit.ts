// The vendored avatar kit (`packages/avatar-kit`, the Designer's kit 1.1.0; never edited here), loaded on demand so its
// renderer and parts are their own chunk and none of it is in the initial JS. A built avatar is placed as an `<img>`
// with a data: address (the page CSP already allows `img-src data:`), never inline SVG: an image keeps each avatar's
// ids to itself. One address per recipe and size is kept.
const cache = new Map<string, string>();
const MAX = 64;

const keyOf = (recipe: Record<string, unknown>, size: number): string => `${size}:${JSON.stringify(recipe)}`;

/** The address already made for a recipe at a size, or null: what a new avatar can draw in its first frame. */
export function cachedBuiltSrc(recipe: Record<string, unknown>, size: number): string | null {
  return cache.get(keyOf(recipe, size)) ?? null;
}

/** The `data:` image address for a recipe at a size (the kit's artwork for that size), or null if the kit fails to load or throws. */
export async function builtAvatarSrc(recipe: Record<string, unknown>, size: number): Promise<string | null> {
  const key = keyOf(recipe, size);
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const kit = await import('../../../packages/avatar-kit/index.mjs');
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(kit.render(recipe, size))}`;
    if (cache.size >= MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, src);
    return src;
  } catch {
    return null;
  }
}
