# @minimalist-alliance/avatar-kit

The avatar parts kit, drawn in the **Cut paper** style (the owner's pick). Framework-free ES modules with no runtime dependencies: it runs in browsers (the React apps) and in Node (the server's recipe check).

```js
import { render, validateRecipe, shuffle, manifest, defaults } from '@minimalist-alliance/avatar-kit';

const svg = render(recipe, 64);          // one SVG string; same input, same output
const v = validateRecipe(body);          // { ok: true, recipe } or { ok: false, errors: [...] }
const random = shuffle(seed);            // a valid random recipe; same seed, same recipe
```

## API
- **`render(recipe, size, idPrefix?)`**: returns an SVG string, `size` x `size` px, clipped to a circle.
  - Size picks the tier: over 32 px the full artwork, 25 to 32 px the bold `md` artwork, 24 px and below the `sm` artwork. Parts whose `minSize` is above the size are left out, inner `data-min-size` details are dropped, and `hides` is applied.
  - Missing fields take the manifest's defaults. A retired or unknown id draws as its category's default. Colors out of range take the default color.
  - The cut-paper lip and shadow are off on the face, ears, glasses and extras below 40 px.
  - Every id inside the SVG is prefixed. The default prefix is a hash of the resolved recipe and size, so output is deterministic and different avatars never collide. The same avatar twice on one page shares a prefix, which is why apps place it as an `<img>` (below). Pass `idPrefix` to choose your own.
  - It reads no files: parts are inlined in `src/parts.generated.mjs`.
- **`validateRecipe(recipe)`**: for the server. Allows only the spec's keys. `kind` must be `"built"` and `kit` must be `1`. Every id must be in the manifest, every color an integer index into its palette, `extras` unique known ids (at most 6), and the JSON at most 512 bytes. Missing fields are allowed (they take defaults).
- **`shuffle(seed?)`**: a valid random recipe. Without a seed it uses `Math.random`.
- **`manifest`** (also `kit-1.json`): ids, names, defaults, palettes, `minSize`, `hides`. **`defaults`**: the default recipe.

**Color indexes are 0-based** (`skin: 0` is tone 1). Palettes: skin 12, hair 10, clothing 12 (top, headwear and glasses), metal 4 (earrings, nose ring), background 10. A later kit may add parts and append colors; it never renames, removes or reorders one.

## Build, test, pack
```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
npm run build     # parts/**/_meta.json + palette.json -> kit-1.json, src/*.generated.mjs
npm test          # builds, then node --test
npm run sheet     # contact sheets into sheets/ (Playwright, from ma-desk's web/node_modules)
npm pack          # @minimalist-alliance/avatar-kit-1.0.0.tgz (runs the build first)
```
`npm run draw` redraws the parts made by `scripts/draw-parts.mjs` (background, neck, head, ears, eyes, mouth, nose, top, glasses, extras). Hair, headwear, facial hair and brows are drawn by hand in `parts/02-back-hair`, `09-front-hair`, `10-headwear`, `08-facial-hair` and `07-face/brows`; the build picks up whatever folders exist.

## Parts
- `parts/<layer>/<id>.svg` (40 px and up), `<id>.md.svg` (32 px), `<id>.sm.svg` (24 px). Each tier falls back to the next larger one. A `_meta.json` per folder lists `{ category, layer, colorSlot, default, parts: [{ id, name, minSize?, hides? }] }`. A part with no file (`none`) draws nothing.
- Colors are `{{slot}}` placeholders (`skin`, `feature`, `hair`, `top`, `glasses`, `metal`, `eye`, `sclera`...).
- Eyes: each eye is its own `<g data-eye="left|right">` with no nested `<g>`. The `wink` mouth carries `<g data-replaces-eye="left">`, which the renderer swaps in for the left eye.
- Face rule: every pupil sits in a sclera; mouth and nose take a color with at least 3:1 against the skin; brows take the hair color. See `../source/README.md`.
- `tests/` also checks that every part is well-formed and has no `<script>`, `on*` attribute, external `href`, `<image>`, `<foreignObject>` or `url(` outside its own ids.

## Using it in an app
Vendor the tarball the way `web/vendor/minimalist-alliance-maia-avatar-*.tgz` is vendored in ma-desk's `web/`: run `npm pack`, copy `minimalist-alliance-avatar-kit-1.0.0.tgz` to `web/vendor/`, and depend on it with `"@minimalist-alliance/avatar-kit": "file:vendor/minimalist-alliance-avatar-kit-1.0.0.tgz"`. The server uses the same tarball for `validateRecipe`. **Place it as an image:** `<img src={"data:image/svg+xml;charset=utf-8," + encodeURIComponent(render(recipe, size))} alt="">`, or one `blob:` URL per recipe and size, kept in a small cache. An image keeps each avatar's ids to itself, so the same member shown twice on one page (two Forums posts) can't collide. A copy inside a hidden menu can't break the visible one's clip or shadow. And no markup goes into the page. If an app must inline the SVG, it passes a unique `idPrefix` per instance (React's `useId`). The tier seal stays the avatar component's own cut-out on top.
