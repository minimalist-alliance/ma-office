// The vendored avatar kit (`packages/avatar-kit`, the Designer's kit 1.0.0; never edited here), loaded on demand so its
// renderer and parts are their own chunk and none of it is in the initial JS. A built avatar is placed as an `<img>`
// with a data: address (the page CSP already allows `img-src data:`), never inline SVG: an image keeps each avatar's
// ids to itself. One address per recipe and size is kept.
const cache = new Map<string, string>();
const MAX = 64;

/** The `data:` image address for a recipe at a size (32 or 40 px here), or null if the kit fails to load or throws. */
export async function builtAvatarSrc(recipe: Record<string, unknown>, size: number): Promise<string | null> {
  const key = `${size}:${JSON.stringify(recipe)}`;
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
