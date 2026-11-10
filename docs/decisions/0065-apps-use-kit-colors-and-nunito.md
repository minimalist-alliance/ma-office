# 0065. The apps use the kit's colors and Nunito

**Status:** Accepted (the owner, 2026-11-05, relayed by the coordinator; tracker T25; values by the Product Designer)
**Date:** 2026-11-05
**Settles:** the open UI font in [0060](0060-brand-kit.md). **Amends:** [0029](0029-themes-light-dusk-dark.md)'s values, and [0064](0064-desk-stacking-hidden-items-and-etch.md)'s etch values. **Keeps:** [0050](0050-dusk-neutral-whites.md) and [0061](0061-full-logo-jost-caps.md).

## Context
The owner asked to see the kit's colors and Nunito against today's look on the real app. The Product Designer recommended keeping Inter and today's colors. The owner decided: "Nunito version is a go". They asked for the problems found to be fixed, not accepted: Light's link and button text at 4.11:1, desks losing their separation from the ground, and Nunito reading thin at small sizes. Dark keeps its blacker ground.

## Decision
- **Scope:** the Desk, Platform and Guild apps, the sign-in pages and the landing page. The owner first left the landing page out, then decided it moves too.
- **Colors:** `docs/assets/brand/ui/tokens.json` holds every token for all three themes, and the sign-in extras under `signin_only`. Contrast for every key pair is in `docs/assets/brand/ui/contrast.txt`.
  - **Kit values where they pass:** graphite text, off-white character, near-black ground. Where a kit color failed AA, the token moves within steel blue instead: Light `accent.default` is `#5076AA` and `text.link` `#476C9E`; Dark `accent.default` is `#6A8DBF`.
  - **Panel to ground:** Light 1.20:1, up from 1.17 today, with the ground stepped down to `#E9E9E5`. Dark 1.32:1, up from 1.13, on `#15171B`.
  - **Dusk** is derived, since the kit has none, and keeps ADR 0050's neutral whites. The owner asked for whites that look "truly white", so `#FAFAFA`, `#E2E2E2` and `#DADADA` stay instead of the kit's `#E8EAED`.
  - **Status and badge colors** don't change.
- **Type:** Nunito, self-hosted through a pinned `@fontsource-variable/nunito`, with no CDN and no CSP change. It costs less than today's Inter. Details: `docs/assets/brand/ui/type.txt`.
  - **Weights:** 600 at 11 to 14 px, 700 for titles at those sizes, 500 at 24 px. Nunito at 400 or 500 reads thin at 1x.
  - **Canvas text** uses the same family and weights.
  - **The wordmark and etched name stay Jost.**
- **Previews:** `docs/assets/brand/ui/before-after.png`, `small-text.png`, and `docs/assets/signin/signin-kit.png`.

## Alternatives rejected
- **Keep Inter and today's colors:** the Product Designer's recommendation, which the owner saw and decided against.
- **Kit colors exactly as listed:** Light's text fails AA, and white desks fade into `#F5F5F2`.

## Consequences
- `tokens.ts` and `app.css` change, and so do `tokens.test.ts`'s value pins. Inter leaves `web/` once this lands.
- **The landing page** follows the same tokens. `web/landing/src/styles/tokens.css` already names the Desk token behind each value, so each takes its `final` value from `tokens.json`.
  - **Its Light page stays white:** `--ma-bg` is `surface.tile`, `#FFFFFF`, so the warm ground appears only in the product images and world backgrounds. This respects the owner's "truly white (not cream)".
  - **Landing-only values:** `--ma-dim`, `--ma-ad`, `--ma-ad-2`, `--ma-night` and `--ma-nav` have no entry in `tokens.json`. Derive them in the same hue, keeping their stated contrast, and `npm run check:contrast` still decides.
  - **Type:** the same package, with the same weights by size. 500 for running text at 15 to 18 px, 600 at 11 to 14 px, 700 for headings. Inter's negative tracking on headings needs relaxing, as it did on sign-in. Large headings haven't been judged in Nunito yet.
  - **Images:** the product renders and `og.png` must change with it. Otherwise the page shows the old look and old name inside the new one. They're rendered once the logo is decided, so the page ships with them.
- Nunito beside Jost's logo is softer than Inter was. It's the owner's call, made with both in view.
- Maia's colors were set against the old surfaces, so they get rechecked before her art is finalized.
- **Under the bar:** Google's border on Dusk's card is 2.39:1. Its dark fill and label identify the button; judge it on staging, with `#F2F2F2` as the fallback.
- **Not checked:** the Platform and Guild apps, since their tokens are carried over unseen; Safari, Firefox and Windows text rendering, which can make Nunito look lighter or heavier; `npm run perf`. The Google G in the mock was typed from memory, so use Google's own file. The preview images show Dusk with `#E8EAED`, before the change to ADR 0050's whites.
- The design doc's §3.12 and the ADR index go through the System Engineer.

## Addendum, 2026-11-07: `/account` adopts the kit early
- `/account` on Platform adopts the kit's colors and Nunito ahead of the rest of Platform (task 26), as the start of this ADR's rollout there. The Product Designer decided this for the owner on 2026-11-06, in the task 26 row of the decisions log.
