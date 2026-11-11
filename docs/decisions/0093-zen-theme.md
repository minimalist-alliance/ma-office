# 0093. Dusk becomes Zen: the name, a natural palette, natural desk textures

**Status:** Accepted (the owner, 2026-11-10). Amends [0029](0029-themes-light-dusk-dark.md) and [0050](0050-dusk-neutral-whites.md); neither is removed.
**Date:** 2026-11-10

## Context
- The owner renamed the middle theme **Zen** and asked for it to look natural rather than stylized: "In Zen mode the desks textures and colors would look more natural instead of stylized like they are in dark and light mode."
- Dusk was a cool slate: mid-tone blue-grey surfaces (ADR 0029), neutral whites (ADR 0050), and desk textures made of the owner's grain tinted to the same slates (`desk-styles.json`, the desk-textures spec). Light and Dark stay as they are: stylized, in the kit's graphite and steel blue.
- Members have saved the theme under its id: `prefs.theme` holds `dusk`, the loader paints from `ma.theme.resolved`, CSS selects on `data-theme="dusk"`, and the tile files are `<style>-dusk.webp`. A new id would break every saved choice for nothing a member can see.

## Decision
- **The name.** What a member reads is "Zen": the account menu's theme segment and its switch, "Use Zen when the system is dark". The display name lives in one place, `THEME_LABELS.dusk` in `web/src/theme/tokens.ts`; `AccountMenu` reads it from there. **The id stays `dusk`** everywhere else: `ThemeId`, `data-theme`, localStorage, CSS selectors, `COLOR_SCHEME`, file names, tests' ids.
- **A natural palette** (`tokens.ts` `dusk`, mirrored in `docs/assets/brand/ui/tokens.json`): a warm stone ground, darker stone desks, linen text, MA's blue kept as the accent but softened so it sits with stone, moss for "online", sand for "warn".
  - Surfaces: `worldHi` `#6A645B`, `worldBase` `#645E55`, `worldLo` `#5E584F`, `panel` and `window` `#534D46`, `tile`, `overlay` and `chrome` `#5A544C`, `sunken` `#4B463F`, `fill` `#5D574F`, `fillStrong` and `chip` `#68625A`, `scrim` `rgba(30, 27, 23, 0.45)`.
  - Text: `primary` `#F4F0E8`, `secondary` `#E8E3DA`, `tertiary` `#DCD6CC`, `link` `#C4D7EC`, `onAccent` `#1F2429`, `disabled` `#A39C92`, `danger` `#F8D3CA`. Glyphs `#E4DFD6`, soft `#B5AEA3`, globe `#CBD5DE`, page `#6E675E`.
  - Accent `#B3C9E2` (hover `#C1D4E9`, pressed `#A2BAD6`, subtle `#45505E`); `focus.ring` `#CCDCEF`; `ring.activeDesk` `#CFC7BB` with the glow at 5 %.
  - Borders on linen: hairline `rgba(244, 240, 232, 0.08)`, default at 0.14, strong `#B3ACA1`. Etch: fill `#DAD4C9`, wall `#26221E`, highlight `rgba(244, 240, 232, 0.30)`.
  - Badge `#F3AC9F` on `#2B1A16`; status online `#ADCBA3`, warn `#E8CC8E`, error `#F3AC9F`, offline `#C0B9AF`. Mark disc `#EDE8DF`, fg `#2E2A26`. Switcher track `#4B463F`, selected `#68625A`, text `#F4F0E8`.
  - The six avatar tints keep their hues; their inks warm to the `#2A2622` family and stay at 5:1 or better. The seal keeps its blues on `#5A544C`. Elevation keeps Dusk's flat structure (no tile shadow) with the shadows in `rgba(30, 27, 23, …)`.
  - The Browser's simplified view: `star` `#E8CC8E`, `mediaFg` and `photoWell` `#F4F0E8`, the scrubber's tracks in `rgba(244, 240, 232, …)`. The Files window's "Steel teal" sits on stone: window `#4A5150`, sidebar `#424948`, the teal accent unchanged.
- **ADR 0050's neutral whites are replaced, for Zen only, by warm linen whites:** `#F4F0E8`, `#E8E3DA`, `#DCD6CC`. A cool white on warm stone reads blue. `text.primary` is still at most that value, and the rule of no pure black or white in this theme stands.
- **Natural desk textures.** The four Zen tiles are the same grain as before, graded to real material colour instead of slate, with a little chroma in the grain (wood is warmer in its dark bands): Light oak `#9C8565`, White ash `#B8AA93`, Walnut `#4F3D30`, Linoleum a sage-grey `#7B8574` (tile means; `design-drafts/desk-textures/build_zen.py`). The etch keeps the owner's rule for this theme, medium letters lighter than the desk inside 1.8 to 3:1 of the mean, a darker wall, no lit lip. Text drawn on a desk (`deskText`) is `text.secondary` where it holds 4.5:1, which only walnut does; the three mid-tone desks take a warm near-black, `#1A1816`, as Light's mid-tone desks take a dark ink. Plain follows the new panel and etch.

## Figures
Every pair in `tokens.test.ts` passes. The ones the tests pin:
- Etch fill on the panel: 5.66:1 (was 5.57); Light 4.56 and Dark 6.56 unchanged. `text.primary` 7.34 on the panel and 5.15 on the lightest ground; `text.secondary` 4.58 on the lightest ground.
- `ring.activeDesk` 4.98 on the panel, 3.50 on the lightest ground. `focus.ring` 4.20 on the lightest ground.
- Desk styles (fill on mean, fill on wall, desk text on mean): oak `#D8C5AE` 2.10, 4.33, `#1A1816` 5.02; ash `#EDE3D4` 1.80, 4.02, `#1A1816` 7.76; walnut `#7E6E63` 2.10, 3.07, `#E8E3DA` 8.04; linoleum `#BAC2B5` 2.11, 4.26, `#1A1816` 4.59.
- Tiles: 1024 px, density 2, seamless; 107, 107, 68 and 82 KB.

## Consequences
- Nothing a member saved changes meaning: a browser on `dusk` wakes up in Zen.
- `web/src/theme/tokens.ts` is still the only file with the colours; `tokens.json`'s `dusk` block and `desk-styles.json`'s `dusk` entries mirror it.
- `docs/desk-design.md` §3.12 and older notes say "Dusk" where they mean this theme; the id in code and files is still `dusk`.
- Light and Dark are untouched. The kit's graphite and steel blue remain the brand; Zen is the one place the office is stone, wood and linen.

## Addendum, 2026-11-10, 9:30 pm MT: cool, not brown
The owner, on the stone-and-linen Zen above: "I hate brown. The only thing that should be slightly brown, but only slightly, are the desks." So:
- **The office goes back to a cool slate** in MA's own blue-grey (Oklab hue about 253, the accent's family): `worldBase` `#4D5463` (`worldHi` `#535A69`, `worldLo` `#474E5C`), `panel` and `window` `#404654`, `tile`, `overlay` and `chrome` `#474D5B`, `sunken` `#393F4B`, `fill` `#4A505E`, `fillStrong` and `chip` `#555C6B`, `scrim` `rgba(16, 20, 30, 0.45)`. Text is a cool near-white, `#F1F3F7`, `#DFE3EA`, `#D3D8E0` (these replace the linen whites above; ADR 0050's neutral whites are still not used). Glyphs `#DFE3EA` / `#AEB5C1` / `#C9D5E2` / `#5B6271`; accent `#A9C4E4` (hover `#B8CFEA`, pressed `#98B6DA`, subtle `#3C4D66`); `focus.ring` `#C9DBF0`; `ring.activeDesk` `#C3CBD8`; borders on `rgba(241, 243, 247, …)`, strong `#A9B1BE`; etch fill `#D4DAE3`, wall `#1E222B`; status online `#9CCDB0`, warn a cool gold `#E3C57A`, error and badge `#F2A99C`, offline `#B6BEC9`; mark `#E9ECF1` on `#2A2F38`; switcher `#393F4B` / `#555C6B` / `#F1F3F7`; the avatar inks and the seal are Dusk's originals, which were cool already; shadows in `rgba(16, 20, 30, …)`. The Files window's teal sits on slate again: `#464E51`, sidebar `#3E4649`. `surface.backdropBand` is the same navy, `rgba(12, 16, 26, 0.40)`, in every theme. The bars' pills (`surface.chrome`) are a deep slate, `rgba(26, 32, 44, 0.90)`, the owner's direction mock; its text pairs clear 10:1 over the ground, and it stays at or over the 90 % the backgrounds spec holds pills to.
- **The mark in the top bar was all white on Zen** (`ma-mark-mono-white.svg`; superseded by the addendum below, 2026-11-11). Light keeps the primary mark and Dark the on-dark one.
- **The desks are the one warm thing, and only slightly:** the four tiles keep their grain at about 40 % of the chroma above and a cooler tone. Means: oak `#8B8578`, ash `#A9A69E`, walnut `#4A4541`, linoleum a cool grey (values in `desk-styles.json`; linoleum sits a little darker than first asked so a near-white status line holds 4.5:1 on it, since no ink reaches that on a mid grey).
- Figures: etch fill on the panel 6.72:1; `text.primary` 8.51 on the panel and 6.23 on the lightest ground; `ring.activeDesk` 5.78 on the panel, 4.24 on the lightest ground. Per-tile figures are in `desk-styles.json` `checks`.
- **The avatar's amber tint reads tan on Zen,** so Zen's "amber" member tint is a pale slate (`#C9D1DC` to `#BDC6D3`, ink `#262B34`, 9.2:1 and 8.2:1); the hue's name and its pick by member id are unchanged, and the other five tints stay. It is told from `slate` by lightness (a step of about 1.3:1) and from `blue` by its lower chroma.

## Addendum, 2026-11-11: the Zen mark
The owner: "I don't like the all white logo while in zen mode. I think the right ribbon can be another shade of the brand blue that doesn't fight with the backgrounds". The top bar's Zen mark is `ma-mark-zen.svg`: the on-dark mark (left ribbon white, right ribbon a brand blue, gradients `ma-zen-r` and `ma-zen-g`) in place of `ma-mark-mono-white.svg`. The right ribbon is the Product Designer's softer blue: `ma-zen-r` #B3CBE8, #97B6DE, #7D9ECC; `ma-zen-g` #7F9DC8, #6B8BB8. Backgrounds are Zen only (ADR 0094 addendum).
- **Approved, 2026-11-11, about 2 am MT:** the owner, after seeing the still and the Designer's ribbon sheet: "Ship it". Right ribbon `#B3CBE8`, `#97B6DE`, `#7D9ECC`; fold `#7F9DC8`, `#6B8BB8`.
