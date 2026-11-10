# 0061. Full logo: the name in Jost capitals

**Status:** Accepted (the owner, 2026-11-05); ratio and minimum width amended the same day (see Amendment); the mark inside it replaced by [0066](0066-the-ribbon-mark.md)
**Date:** 2026-11-05
**Amends:** [0060](0060-brand-kit.md), for the lockups only

## Context
- The owner asked for a full logo with the icon and the name, in a font that is elegant, professional and on brand.
- The owner rejected serif options as dated ("for old people, not minimalists who like elegance and premium"). Modern sans-serifs were "closer", and they asked to try all caps.
- From five all-caps options they chose: "Jost it is".

## Decision
- The full logo is the kit's mark plus MINIMALIST ALLIANCE in Jost Light (300) capitals with wide tracking (0.16 em); the Amendment changes the weight and tracking. Files are in `docs/assets/full-logo/`: horizontal and stacked, `light` for light grounds and `dark` for dark ones, as SVG and 2400 px transparent PNG.
- These replace the kit's Nunito files in `docs/assets/brand/lockups/` for all new use. The kit stays as supplied.
- The name is converted to outlines, so no font is needed to display it. Letter gaps were evened out by measuring each pair: open pairs such as LI, LL and ST are tighter, and straight pairs such as MI and IN are wider.
- Minimum width (replaced by the Amendment): horizontal 240 px, judged by eye; at 160 px the name gets too thin. Below that, use the mark alone. This replaces the kit's 160 px rule for this logo.
- On Dusk, use `dark`, as with the mark in ADR 0060.

## Consequences
- Jost is by Owen Earl and free under the SIL Open Font License, so there is no cost and no new service.
- This decides the wordmark only. The apps' UI font is still open (ADR 0060 lists Nunito, Inter and the UI colors).
- The UI/UX Engineer uses these files wherever the name appears with the mark.

## Amendment: a better balance between mark and name (2026-11-05)
- **Why:** the owner, on the live header: "The icon is too big compared to the text in the logo", "lets make the icon a little smaller and the text a little bigger", and on a screenshot of the Dark header, "you see the disparity here right?".
- **Cause:** the files, not the page. The page draws the file in proportion, and in the file the mark was 2.6 times the name's cap height. The solid mark also overpowered a hairline name, which looked thinner than the nav links beside it.
- **Tested** in the live header, in a local browser only, in Light, Dusk and Dark at 1x and 2x:
  - Mark at 1.8 times the cap height with the same Light weight (commit `98aa5a7`, never shipped): the mark shrank too much and the name barely grew.
  - Mark at 1.95 times with a larger name in Light: the name still looked hairline, so size alone didn't fix it.
- **New decision:**
  - **Weight:** Jost Regular (400), one step up from Light. Still Jost, still capitals.
  - **Tracking:** 0.13 em, from 0.16, so the letters can grow while the logo stays about the same width. Letter gaps were measured and evened out again.
  - **Horizontal:** the mark is 1.95 times the cap height, from 2.6. The gap between mark and name is 0.72 times the cap height.
  - **Stacked:** the mark is 30% of the name's width, from 40%.
- **In the header at 250 x 33 px** (was 240 x 36): the name's cap height is 10.9 px, up 11%, and the mark is 21.3 px tall, down 16%.
- **New minimum width:** horizontal 225 px, stacked 185 px. Both keep the cap height at about 9.8 px, the same as the old 240 px minimum. Below that, use the mark alone.
- The mark itself is not redrawn or recolored here; its paths are identical to the kit's. ADR 0066 later replaced the mark and kept this name, these ratios and these widths.
