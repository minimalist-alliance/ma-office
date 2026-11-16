// A new avatar comes in place (the owner, Nov 16: "I had to refresh the page to see my avatar"): when `/v1/me` brings a
// new picture or a new built avatar, the one drawn stays until the new one's image is decoded, then the new one takes its
// place in one frame. Never the initials in between, never an empty circle. The rule is `nextDrawn`, pure; `decode` is
// the browser's part.

/** Image addresses this page has decoded, so a second avatar (the menu's, after the button's) draws one at once. */
const decoded = new Set<string>();
const MAX = 16;

export const isDecoded = (src: string): boolean => decoded.has(src);

function remember(src: string): void {
  if (decoded.has(src)) return;
  if (decoded.size >= MAX) decoded.delete(decoded.values().next().value as string);
  decoded.add(src);
}

/**
 * What the avatar draws now, and which image to decode first. `want` is the image it should show, null for the initials
 * (no picture or built avatar, or theirs failed), or undefined while it isn't known yet (a built avatar still being drawn
 * by the kit). An image that isn't decoded yet waits behind the one drawn; the initials need nothing, so they come at once.
 */
export function nextDrawn(drawn: string | null, want: string | null | undefined, ready: (src: string) => boolean): { draw: string | null; load: string | null } {
  if (want === undefined) return { draw: drawn, load: null };
  if (want === null) return { draw: null, load: null };
  if (want === drawn || ready(want)) return { draw: want, load: null };
  return { draw: drawn, load: want };
}

/** Fetches and decodes an image off screen: true once it can be drawn in one frame, false if it can't be drawn at all. */
export function decode(src: string): Promise<boolean> {
  if (decoded.has(src)) return Promise.resolve(true);
  const img = new Image();
  img.referrerPolicy = 'no-referrer'; // as the avatar's own `<img>`
  img.decoding = 'async';
  img.src = src;
  return img
    .decode()
    .then(
      () => true,
      () => img.complete && img.naturalWidth > 0,
    )
    .then((ok) => {
      if (ok) remember(src);
      return ok;
    });
}
