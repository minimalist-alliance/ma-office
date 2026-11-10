# 0068. One app icon: the white-ribbon mark on a light tile

**Status:** Accepted (the owner, 2026-11-06)
**Date:** 2026-11-06
**Amends:** [0066](0066-the-ribbon-mark.md), for icons only; the mark and which logo goes on which theme stand

## Context
- The owner: "The favicon in the browser tab and any app like icon for MA should be the dusk variant. But I do need more drop shadow between the darkest blue part of the icon and the dusk background color (nothing crazy) though."
- From shadows A, B and C they chose: "Medium but we gotta make the background color lighter".
- They then turned down `#444B57` through `#687080`: "Much lighter. it still blends in with the icon too much".
- From seven much lighter rows they chose row 3: "Lets go with 3". I had recommended the graphite mark on `#C4CAD2`, which separates more, and offered this row as the way to keep the white ribbon.

## Decision
- **There is one icon,** in `docs/assets/brand/app-icons/`: the `on-dark` mark, unchanged, over a soft drop shadow on a `#A8B0BB` tile. It replaces the `light` and `dark` tiles, which are deleted from the kit.
- **The filenames sites already link stay,** so no HTML has to change: `favicon.svg`, `favicon-32.png`, `favicon.ico`. New: `apple-touch-icon.png`, full-bleed with no alpha, and `maskable-{512,192}.png`.
- **`favicon.svg` is the tab-size drawing, not the large tile,** because Chromium prefers it over the PNG.
- **`export.py` generates every file, each drawn at its own size.** The shadow and contrast figures are in `app-icons/README.md`.

## Consequences
- **The mark's contrast on this tile is low by number.** The left ribbon is 2.19 at its lightest and 1.33 at its darkest, and the top of the right ribbon is 1.45. The shadow and the dark foot, 4.09, do the separating. The owner chose this by eye.
- **A tab is softer than the kit's 16 px frame.** Chromium 156 rasterizes the SVG at 32 and scales it on a 1x screen, and the left leg is soft at 16. Only a page linking `favicon.ico` gets the exact frames.
- **Not tested:** Firefox, Safari, a real iOS or Android home screen, or Cognito with an SVG that has a filter.
- **Avatars are unchanged.** Profile pictures aren't app icons.
- **`theme-color` is unchanged,** since it wasn't part of the request.
- **Rollout isn't part of this commit.** Other repos hold their own copies, and the disguised page inlines its icons, so it has to follow in one door apply to stay identical to the real 404.
