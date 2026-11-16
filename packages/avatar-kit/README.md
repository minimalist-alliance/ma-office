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

**Color indexes are 0-based** (`skin: 0` is tone 1). Palettes: skin 12, hair 10, clothing 12 (top, headwear and glasses), metal 4 (earrings, nose ring), background 10. **A recipe stores indexes, never a color's id**, so the slot order is the contract: a later kit may add parts and append colors, and never removes or reorders one. It may recolor a slot in place, renaming its id with it (ids match names), as 1.1.0 did for five backgrounds; a stored recipe then keeps its slot, validates as before and draws the new color.

## Backgrounds (1.1.0: all cool)
The owner's rule is "no green, brown or warm tints in any MA UI", and the disc behind every built avatar is UI. 1.1.0 recolored the five warm or green swatches in their slots and kept the other five as they were:

| Slot | 1.0.0 | 1.1.0 | Top | Bottom |
|---|---|---|---|---|
| 0 | blue | blue (kept) | `#E2EAF4` | `#D1DDEE` |
| 1 | green | **mist** | `#CFD2D5` | `#BDC1C5` |
| 2 | amber | **sky** | `#CDE5F3` | `#B5D7ED` |
| 3 | rose | **periwinkle** | `#C7C9E6` | `#B3B6E0` |
| 4 | violet | violet (kept) | `#E9E5F3` | `#DBD5EC` |
| 5 | slate | slate (kept) | `#E5E7EA` | `#D5D9DD` |
| 6 | steel | steel (kept) | `#CBD9EC` | `#B5C8E2` |
| 7 | pine | **blue-grey** | `#A3A9B0` | `#8D97A0` |
| 8 | ochre | **denim** | `#A3BAD4` | `#86A8CE` |
| 9 | deep-slate | deep-slate (kept) | `#7A8594` | `#667181` |

- **Cool by both of the apps' tests:** every stop has HSL hue 190 to 290 or saturation 0.18 or less (the office's), and blue as its largest channel (the Platform's).
- **Told apart:** the kept pale blue, violet and slate already fill the pale corner (blue and slate are 1.77 apart in OKLab x 100, about one step past just noticeable), so the new five are told apart by lightness as much as hue, the way the initials tints are: mist a soft grey between slate and blue-grey, sky a clear pale blue, periwinkle a soft blue-violet, denim a mid blue and blue-grey a mid grey. Each is 3.4 or more from every other swatch (closest: sky and steel).
- **The art stays readable:** the face rule doesn't depend on the disc (features sit on the skin), and the silhouettes stand off every new swatch at least as well as on the five kept ones: every skin tone against the swatch's middle (4.3 or more), every hair color against its top (0.75), every clothing color against its bottom (4.8). The mid swatches sit where the clothing blues (steel, light steel, slate, silver) aren't, so a blue top still shows its edge. Each gradient steps like 1.0.0's: about 0.04 of OKLab lightness top to bottom on the pale ones and 0.05 to 0.07 on the deeper ones, a little more chroma at the bottom.
- `tests/kit.test.mjs` holds all of it: the ids in slot order, both coolness tests, the distances, the floors, every stored slot still validating and drawing its new color (none of the old warm hexes), and the face rule on every swatch and skin tone at 128, 32 and 24 px.

## Build, test, pack
```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
npm run build     # parts/**/_meta.json + palette.json -> kit-1.json, src/*.generated.mjs
npm test          # builds, then node --test
MA_DESK_WORKTREE=<an ma-desk checkout with web/node_modules> npm run sheet   # contact sheets into sheets/ (Playwright and the brand tokens from it)
npm pack          # @minimalist-alliance/avatar-kit-1.1.0.tgz (runs the build first)
```
`npm run draw` redraws the parts made by `scripts/draw-parts.mjs` (background, neck, head, ears, eyes, mouth, nose, top, glasses, extras). Hair, headwear, facial hair and brows are drawn by hand in `parts/02-back-hair`, `09-front-hair`, `10-headwear`, `08-facial-hair` and `07-face/brows`; the build picks up whatever folders exist.

## Parts
- `parts/<layer>/<id>.svg` (40 px and up), `<id>.md.svg` (32 px), `<id>.sm.svg` (24 px). Each tier falls back to the next larger one. A `_meta.json` per folder lists `{ category, layer, colorSlot, default, parts: [{ id, name, minSize?, hides? }] }`. A part with no file (`none`) draws nothing.
- Colors are `{{slot}}` placeholders (`skin`, `feature`, `hair`, `top`, `glasses`, `metal`, `eye`, `sclera`...).
- Eyes: each eye is its own `<g data-eye="left|right">` with no nested `<g>`. The `wink` mouth carries `<g data-replaces-eye="left">`, which the renderer swaps in for the left eye.
- Face rule: every pupil sits in a sclera; mouth and nose take a color with at least 3:1 against the skin; brows take the hair color. See `../source/README.md`.
- `tests/` also checks that every part is well-formed and has no `<script>`, `on*` attribute, external `href`, `<image>`, `<foreignObject>` or `url(` outside its own ids.

## Using it in an app
**Vendored, never edited in place:** ma-desk and ma-platform each hold a copy at `packages/avatar-kit/` (everything here but `sheets/` and `scratch-hair/`), and import it by relative path (`../packages/avatar-kit/index.mjs`). A new version is copied over whole into both, in the same change. `index.d.mts` is the types they compile against. **Place it as an image:** `<img src={"data:image/svg+xml;charset=utf-8," + encodeURIComponent(render(recipe, size))} alt="">`, or one `blob:` URL per recipe and size, kept in a small cache. An image keeps each avatar's ids to itself, so the same member shown twice on one page (two Forums posts) can't collide. A copy inside a hidden menu can't break the visible one's clip or shadow. And no markup goes into the page. If an app must inline the SVG, it passes a unique `idPrefix` per instance (React's `useId`). The tier seal stays the avatar component's own cut-out on top.

## Changes
- **1.1.0** (2026-11-16): the five warm or green backgrounds recolored cool in their slots (green, amber, rose, pine, ochre became mist, sky, periwinkle, blue-grey, denim; ids renamed with them). Recipes are unchanged: they store indexes, so nothing to migrate. Tests for the backgrounds; `index.d.mts` (the types the vendoring repos already carried) and `sheet.mjs`'s `MA_DESK_WORKTREE` folded in. The before/after sheet is `design-drafts/avatar-kit-cool/`.
- **1.0.0** (2026-11-09): the Cut paper kit, the owner's pick.
