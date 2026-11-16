# 0029. Themes: Light, Dusk and Dark from one semantic token set shared by CSS and Konva

**Status:** Proposed (pending the owner's approval of design v1.1)
**Date:** 2026-11-04
**Values replaced by:** [0065](0065-apps-use-kit-colors-and-nunito.md). The three themes and their structure stand; final values are in `docs/assets/brand/ui/tokens.json`.

## Context
- The owner: "Keep in mind that there should be 3 viewing modes: Light, Dark, and something in between that contrasts and flattens appropriately for pleasant viewing."
- ADR 0004 planned a single `tokens.ts` feeding CSS and Konva, with Light in Phase 1 and Dark in Phase 2.
- Some of v1's mockup-derived values fail WCAG AA:
  - the active ring #7591BA is 2.4:1 against the world's corner color;
  - ink-3 #6E7178 is 4.4:1 on sunken surfaces;
  - the selected scope segment differs from the track by fill only, at 1.2:1.
- Konva draws pre-rendered chrome that must be rebuilt when colors change.

## Decision
- **Three themes:** Light (the mockup, contrast-corrected), **Dusk** and Dark. All ship in Phase 1.
- **Dusk:**
  - surfaces at L* 30–36 (cool slate) and warm off-white text;
  - flat elevation (tone steps and hairlines; a 4 px window shadow);
  - no #000 or #FFF anywhere;
  - text contrast of 4.6–8.1:1, still WCAG AA for every allowed pair.
- **Token layers in `tokens.ts`:** primitives → semantic tokens (surface, text, glyph, accent, border, focus, ring, badge, status, mark, switcher, elevation) → a few component aliases. All themes share identical keys, enforced by TypeScript.
- **DOM:** generated `themes.css`, switched by `data-theme`, with `color-scheme` set per theme. Every app window, modal, menu, toast, widget and the minified view use only these variables.
- **Konva:**
  - A Zustand `themeStore` `{pref, resolved, t, rev}` feeds node props through selectors; no color literals.
  - The chrome cache is keyed by `rev`: visible buckets are rebuilt before the next draw, the rest at idle, and `node.cache()` users are cached again.
- **Switching:** inside `document.startViewTransition` (a 200 ms crossfade of DOM and canvas together; instant under reduced motion), with the update callback ≤ 50 ms.
- **Preference:**
  - `prefs.theme = {mode: system|light|dusk|dark, systemDark: dark|dusk}` in the Platform layout doc (ADR 0005), so the choice persists and syncs.
  - Default `system`, which follows the OS between Light and Dark.
  - Mirrored in localStorage and applied before first paint by a render-blocking `theme-boot.js`.
- **Contrast:** AA is verified by computation for every allowed pair, by a unit test, and by axe-core per theme.
  - Corrections: Light ring #5F7FB0, tertiary text #666970, and a `border.strong` outline plus 600 weight on the selected segment.
  - Count badges in Dusk and Dark use dark text on a lighter red.
- **Content:** provider marks are monochrome on a disc. Notebook colors are stored by name and mapped per theme. The kiosk Chromium gets a matching `prefers-color-scheme` (Dusk → dark).
- **Lint:** an ESLint rule bans color literals outside `tokens.ts`.

## Consequences
- One switch restyles the canvas, windows, the minified view and widgets consistently, and the choice syncs across devices.
- Dusk is the cheapest theme to render.
- Contrast headroom in Dusk is narrow, so every new color needs a value in all three themes and must pass the test.
- Phase 1 takes on the visual QA of three themes.
- Light deviates slightly more from the mockup (darker ring and meta text).
- Normal-mode pixels and images are not themed.
- Replaces ADR 0004's tokens bullet (Light in Phase 1, Dark in Phase 2) and its mockup contrast values.

## Addendum 2026-11-12: the window lift (the owner's pick, option 5)
The owner asked for the app windows to lift off the desk a little, "Maybe a bevel or something?", without simply adding more drop shadow. The Product Designer drew five options on the real office in Light, Zen and Dark (`design-drafts/window-lift`: `pick-sheet.png`, `corners.png`, the values in `src/options.py`), and the owner picked option 5 on Nov 12: **the top-edge highlight plus the contact shadow**. It ships on, with no switch.
- **The contact shadow.** An app window (`.ma-window`) sits on a tight shadow at its base under a short soft one, in place of the menu's shadow at rest and the window's when active or full. Light: rest `0 1px 3px` at 0.14 and `0 6px 18px` at 0.11, active `0 1px 3px` at 0.18 and `0 18px 48px` at 0.15, in `rgba(20, 30, 50, …)`. Zen: rest `0 1px 2px` at 0.45 and `0 2px 6px` at 0.26, active `0 1px 2px` at 0.50 and `0 3px 10px` at 0.26, in `rgba(16, 20, 30, …)`, with the hairline `border.default` round the active one as before. Dark: rest `0 1px 3px` at 0.55 and `0 6px 18px` at 0.38, active `0 1px 3px` at 0.65 and `0 12px 36px` at 0.42, in `rgba(5, 6, 8, …)`, with its hairline as before. Every one reaches less far than the shadow it replaces.
- **The lit edge.** Every window surface (a window, a desk's carousel stage, an open tile) has a 1 px edge inside it, lit from above as the app icons are, from the top left: the top at Light 0.9, Zen 0.16, Dark 0.10 of the theme's own near-white (white, `241, 243, 247`, `236, 237, 239`), the left at a third of that (0.3, 0.053, 0.033). It's a `::after` over the surface's content, because the panes paint their own grounds over an inset shadow on the surface itself, and it takes no press. A window is its own stacking context by its inline z-index, and a stage and a tile by `isolation: isolate`, so each edge sits at z-index 5 inside its own surface: over the app's raised parts (the simplified view's are z-index 1 and up), never over a neighbouring tile. A Files dialog's scrim is at z-index 6, so the edge dims with the window under it. The app inside a stage or a tile draws none of its own.
- **Where it isn't drawn.** A surface that fills the screen has no edge to light: a phone's stage, and a full window on a phone (under 600 px) or a short screen (under 1024 x 480). Under `forced-colors: active` the browser drops every shadow, so the edge's `::after` isn't drawn either. The office doesn't handle `prefers-reduced-transparency` anywhere yet; the edge follows the shadows there.
- **Tokens.** `WINDOW_LIFT` in `tokens.ts` (`rest`, `active`, `edge`), as `--ma-window-lift-*` in `themes.css` for every theme and the no-theme dark fallback. Like `VIEW`, nothing at run time reads it, so it costs the bundle nothing. `elevation.window` and `elevation.menu` are unchanged for the modals, menus and panels that use them. `ShadowLayer` gained `dx` and `inset`, for CSS only.
- **Tests.** `src/theme/windowLift.test.ts` holds the tokens to the Designer's option 5, layer for layer, and to the exact custom properties; `tests/e2e/windowlift.shell.spec.ts` holds what Chromium computes for each surface in each theme, the edge's absence where a surface fills the screen and under forced colours, and axe on the windows and the open tile. `windowlift.shots.shell.spec.ts` (`WINDOW_LIFT_SHOTS`) shoots the Designer's scene for their read.
