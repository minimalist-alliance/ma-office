# ADR 0098: Theme sliders, laid over the tokens at runtime

**Status:** accepted, 2026-11-14. **Owner:** UI/UX Engineer.

## Context
The owner approved two sliders under the theme picker, in the office and the Forums (Nov 14, about 5 pm MT): "a blue adjuster slider and a contrast slider", in place of the old "Plain background", remembered per member across devices, in every theme, shared by both apps. The Designer drew three blue ranges and one contrast range on a sheet (`~/ma-coord/design-drafts/theme-sliders/`); about 10 pm the owner picked **blue range A** (grey to today's: the greys' chroma times s, hue and lightness kept, the accent fixed) and **the sheet's contrast range**. Platform keeps the two integers on the account (ma-platform contract `appearance.md`, `PUT /v1/me/appearance`).

The office draws with the same token objects in two places: `themes.css` (generated at build time from `tokens.ts`) and the Konva canvas, which reads the objects from `themeStore` and identifies a theme by object identity (`THEMES[id] === t`).

## Decision
1. **One colour transform, shared byte for byte** with the Forums (`web/src/theme/tune/xf.ts` = ma-platform `web/forums/src/tune/xf.ts`, pinned by a SHA-256 test in each repo). Blue then contrast in OKLCH, one rounding to 8 bits that keeps the hue and never lands on a neighbour whose blue channel is below its red or green, then the 4.5:1 floor for text on the window, panel, fill, sunken, tile and overlay. At the default it returns the input itself.
2. **Laid at runtime, never rebuilt:** each theme's changed tokens are written into the token objects in place (anything that kept a group, such as a Plain desk's etch, follows), the changed theme's top-level object is replaced with a shallow copy (selectors of `t` draw again, identity checks still hold), Plain's and the flat look's copied base and text are re-pointed, and the same values go on `<html>` as custom properties, which win over `themes.css`. A theme switch swaps the properties in the same frame.
3. **Lazy:** the math, the save and the easing are their own chunk (3.6 KB gz). The first load carries only the laying (`apply.ts`), this browser's copy (`mirror.ts`) and the watcher (`watch.ts`): about +1.2 KB gz.
4. **No desk layer.** The office is one page across desks; the setting is the account's (HANDOFF section 4's settings layer has no desk level for it).

## Consequences
- The default is today's office exactly: nothing laid, nothing kept, nothing sent.
- A slider's live move re-renders the theme's consumers and redraws the canvas once a frame: 10 to 24 ms a frame on the harness office (Zen to Light), about 40 to 60 fps while dragging.
- Colours computed at module load from token strings (outside `tokens.ts`'s objects) don't follow unless re-pointed as Plain's are. `VIEW`, `WINDOW_LIFT`, `MAIA_MODE`, the app inks and the wood styles stay as they are, as the sheet says.
- **The glass follows too (release 6.11, the owner, Nov 16: "Yes, do it"; `docs/sub-status/office-glass.md`):** `tune/glass.ts` in the same chunk lays the DOM recipe (`glass.*`) and the canvas's glass (`tile*`, into `GLASS_FACE` and `TILE_TINT`) in the same flats and mirror, Blue through `tuneFlat` itself as pseudo-tokens (xf.ts unchanged), Contrast as the light's multipliers and the body's pull, held to the floors; the canvas's tiles raster once when a slider rests, never per frame. Each app tile's accent tint stays as it is.
