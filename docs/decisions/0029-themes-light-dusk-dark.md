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
