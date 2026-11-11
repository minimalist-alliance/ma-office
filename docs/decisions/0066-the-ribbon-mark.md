# 0066. The logo is the ribbon M

**Status:** Accepted (the owner, 2026-11-05)
**Date:** 2026-11-05
**Amends:** [0060](0060-brand-kit.md), for the mark and the kit as a source; [0061](0061-full-logo-jost-caps.md), for the mark inside the full logo; its name, ratios and minimum widths stand

## Context
- The owner reopened the kit's mark: "Ribbon the middle too", and "I want the "right" separated from the left like one ribbon wrapping over the other". They then drew it: "This is what I'm expecting the logo to look like but obviously stylized correctly".
- A measured trace of the owner's sketch was "super close now". The later rounds followed their notes:
  - The right ribbon became "completely distinct in color", with space kept between its tail and the left ribbon.
  - One ribbon became "dominant blue steel" and the other "graphite or white depending on background".
  - The curl and soft gradient came back, then more contrast and "a bit of a subtle shadow" at the folds.
  - The tail got "a bit rounder at the edge", with its curl "parallel with the other ribbon".
- The owner then approved the last round, `trace7` option 3: "Option 3 is perfect". Their next words were "PLease remake the whole branding kit and get this rolled out everywhere".

## Decision
- **The mark** is `docs/assets/brand/logo/source/mark-3-{light,dark}.svg`. Don't edit it without the owner's approval.
  - The right ribbon is steel blue and passes over the left one.
  - The left ribbon is graphite on light grounds and `#FAFAFA` on dark ones.
  - The tail ends in a rounded cap and runs parallel to the left ribbon, 26 units away in a drawing 915 wide.
  - The gradients and fold shadows are part of the mark. This replaces the kit's "no gradients or shadows on the mark" rule.
- **The kit is generated, not as supplied.** `docs/assets/brand/export.py` makes every logo file from that source. This replaces ADR 0060's "byte for byte as supplied".
- **There's one full logo.** `lockups/` now holds the Jost capitals from ADR 0061 under its old filenames, so no file shows the old Nunito wordmark.
- **The sign-in ground follows the mark.** The large faint shape behind the sign-in card is now the two ribbons as flat silhouettes, the right over the left, in the old ground's tones. Our own pages inline `docs/assets/signin/signin-ground-inline.svg`.
- **`app-ui/` follows ADR 0063.** The files are renamed `office-*`. The overviews are new renders of the prototype. The icon sets keep the same pixels, since they show neither the mark nor the name.
- **Mark per theme**, with contrast against the theme's `surface.worldBase`:

| Theme | Ground | Variant | Left ribbon | Right ribbon: high, middle, foot |
|---|---|---|---|---|
| Light | `#E9E9E5` | `primary` | 7.9 to 13.4 | 2.4, 3.6, 8.2 |
| Dusk | `#444B57` | `on-dark` | 8.4, or 6.3 at its darkest | 3.0, 2.0, 1.13 |
| Dark | `#15171B` | `on-dark` | 17.2 | 6.1, 4.1, 1.8 |

## Consequences
- **Mono is my derivation, not something the owner drew.** One color can't separate the ribbons, so `mono-black` and `mono-white` have a transparent knockout along the crossing, 20 units wide. The owner sees it on the brand sheet. Nothing in the apps uses mono today.
- **Dusk passes by eye, not by number.** The right ribbon's foot is 1.13:1 in luminance, but its blue hue keeps it visible against the grey ground at every size checked. This closes the "steel blue on Dusk" question ADR 0060 left open, unless the owner objects.
- **Small sizes lose detail.** The tail's gap is one soft pixel at 32 px and barely reads at 24. The fold shadow is gone at 24. The 16 px favicon is a two-tone M, with the tail and crossing blurred.
- **Worst contrast at the crossing:** 3.29 on light and 2.81 on dark.
- **The files are heavier and need more of a renderer.** `ma-mark-primary.svg` goes from 3.4 KB to 8.9 KB and uses masks, clip paths and gradients. Use it through `<img>`. Ids differ per variant, but inlining the same file twice with the first copy hidden makes the mark vanish.
- **Same shape box.** The viewBox stays 915 by 568, so code that sized the old mark doesn't change. The lockup PNGs do change size, to 2400 x 316 and 2400 x 751.
- **Tested in Chromium only.** Cognito accepts the lockups with their masks and gradients: the hosted sign-in page has shown the new logo since 2026-11-05, checked by eye in light and dark.
- **`ui/before-after.png` keeps the old mark,** as ADR 0065's record, and stays out of the kit's zip.
- **Rollout:** the UI/UX and Platform Engineers swap their copies. The exact files are in `~/ma-coord/product-designer.md`. Earlier rounds are on branch `wip/design-drafts`.

## Addendum, 2026-11-11: the Zen variant
The owner approved a Zen variant of the on-dark mark: "Ship it" (about 2 am MT, Nov 11, after seeing the Zen still and the Designer's ribbon sheet). Left ribbon, shading and shape are the on-dark mark's; the right ribbon is `#B3CBE8`, `#97B6DE`, `#7D9ECC` and the fold `#7F9DC8`, `#6B8BB8`. It is `web/src/assets/brand/ma-mark-zen.svg`, used on Zen only (ADR 0093).
