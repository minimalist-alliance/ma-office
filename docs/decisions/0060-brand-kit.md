# 0060. Brand: adopt the owner's brand kit

**Status:** Accepted (the owner, 2026-11-05); lockups amended by [0061](0061-full-logo-jost-caps.md); the mark, the "as supplied" rule and the table below replaced by [0066](0066-the-ribbon-mark.md)
**Date:** 2026-11-05

## Context
- The owner and the Product Designer tried redrawing the mark as a handshake on 2026-11-05. Those drafts are on the local branch `wip/logo-handshake-drafts`, not pushed.
- The owner then ended that work: "Let's just go with minimalist-alliance-brand-kit.zip".

## Decision
- `docs/assets/brand/` holds the kit, byte for byte as supplied. It is the source of truth for the mark, lockups, app icons and logo colors, and the rules in its `README.md` apply. Don't redraw the mark.
- Mark per Desk theme:

| Theme | Ground | Variant | Contrast with ground |
|---|---|---|---|
| Light | `#eef0f3` | `primary` | graphite 8.9:1, steel blue 3.8:1 |
| Dark | `#1a1d21` | `on-dark` | light 14.0:1, steel blue 3.9:1 |
| Dusk | `#474d56` | `on-dark` | light 7.1:1, steel blue 1.9:1 |

- On Dusk, `primary` is out because its graphite is only 1.2:1. `mono-white` is out because Dusk allows no pure white (design §3.12).
- The UI/UX Engineer applies the kit to the landing page and the apps.

## Consequences
- The placeholder mark in the landing page's `Logo.astro` and the favicons gets replaced.
- Still open, and not decided here:
  - **App colors and font.** The kit gives UI colors (`#2A2E35`, `#5B7FB0`, `#F5F5F2`, `#15171B`) and Nunito for UI text. Desk's tokens differ (ADR 0029; Light accent `#466a9e`, Dark ground `#1a1d21`), and the design self-hosts Inter (§3.10). Changing them needs the owner's call. The kit has no Dusk colors.
  - **Steel blue on Dusk.** At 1.9:1 it's below the 3:1 usually wanted for graphics. The arms carry the mark, but the kit has no version made for mid-tone grounds.
  - **Seam in the mono variants.** `mono-black` and `mono-white` are two same-color paths that touch, which leaves a faint hairline: on `mono-white` the darkest pixel inside the left leg is 207–230 out of 255, at widths from 32 to 1830 px. Merging the two paths would fix it. It's left as supplied because the kit says not to redraw the mark.
  - **App name.** The kit calls the app "Minimalist Home"; these docs call it the Desk app. The owner later retired the kit's name: members call it "your office" (ADR 0063).
- `GITHUB-DESCRIPTION.md` is in the kit but hasn't been applied to any repo.
