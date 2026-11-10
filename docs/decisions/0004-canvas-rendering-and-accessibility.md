# 0004. Canvas rendering, accessibility and visual tokens

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0028](0028-quality-bar-never-sluggish.md) (budgets) and [0029](0029-themes-light-dusk-dark.md) (themes)

## Context
- Target: 60 fps full screen up to 4K on ordinary laptops. Canvas `shadowBlur` on many tiles and React reconciliation on every frame would miss that budget.
- Canvas content is invisible to assistive tech, and the mockup's meta grey (3.3:1) and active ring (2.2:1) fail WCAG AA.
- Privacy is a selling point, so no third-party CDNs or beacons.

## Decision
- **Rendering:** react-konva for structure; camera tweens drive Konva nodes imperatively in rAF and commit to the store at the end. Two layers (world, overlay). Hit-testing pauses while the camera moves. Shadowed chrome is pre-rendered per scale bucket; glyphs are vector paths. Level of detail by on-screen tile size, manual culling, DPR capped at 2 with an adaptive drop during motion. Budget ≤ 8 ms/frame with 24 desks × 12 tiles (budget B1 of the quality bar, ADR 0028).
- **Accessibility:** the canvas is `aria-hidden`; a DOM proxy layer of transparent, focusable, named buttons sits at each desk's and tile's screen rect. Keyboard focus lives there and the canvas draws the ring. Mockup greys that fail contrast are darkened.
- **Tokens:** `tokens.ts` generates both CSS variables and Konva props (semantic colors, radii, elevation, Inter type scale, motion). Light, Dusk and Dark all ship in Phase 1 from one semantic token set (ADR 0029). Material Symbols Rounded glyphs; provider marks from Simple Icons, used nominatively. Everything self-hosted.

## Consequences
- Screen readers, voice control and Playwright `getByRole` all work.
- Visuals deviate slightly from the mockup for contrast.
- Phase 1 needs a stress fixture, a performance overlay and the perf CI to prove the budget (ADR 0028).
- Alternatives rejected: caching whole desk groups (blurry, memory-heavy), WebGL/Pixi (more complex; the owner asked for Konva), a DOM-only canvas, Google Fonts or icon CDNs.
