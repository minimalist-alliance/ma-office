// The vendored avatar kit (`packages/avatar-kit`, never edited here), loaded on demand: its renderer and parts are a lazy
// chunk of their own, so none of it is in the first load. A built avatar is placed as an <img> with a data: address
// (the page policy has `img-src data:`), never inline SVG, so each avatar keeps its ids to itself.
const cache = new Map<string, string>();

/** The data: image address for a recipe at a size, or null if the kit fails to load or throws. */
export async function builtAvatarSrc(recipe: Record<string, unknown>, size: number): Promise<string | null> {
  const key = `${size}:${JSON.stringify(recipe)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const kit = await import('../../../../../packages/avatar-kit/index.mjs');
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(kit.render(recipe, size))}`;
    if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
    cache.set(key, src);
    return src;
  } catch {
    return null;
  }
}
