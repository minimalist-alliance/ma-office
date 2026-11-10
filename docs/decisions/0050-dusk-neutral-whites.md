# 0050. Dusk uses neutral whites, not warm off-white

**Status:** Accepted for the owner's desk (T12, owned by the UI/UX Engineer, 2026-11-05). The owner can overrule it; see Consequences. Amends [ADR 0029](0029-themes-light-dusk-dark.md).
**Date:** 2026-11-05

## Context
- ADR 0029 and design §3.12 give Dusk "warm off-white text": `text.primary` #F0EDE7, with warm values for the secondary and tertiary text, `glyph`, `switcher.text`, `mark.disc` and the `border.*` rgba bases.
- The owner's only stated view on this is landing story L-1: "I want the whites to look truly white (not cream) so the page feels crisp." That story is on the landing preview as `#fafafa`, `#e2e2e2` and `#dadada`.
- So the landing page's Dusk and the Desk's Dusk disagree, and the product renders on the landing page show cream text beside the neutral page chrome.
- The tracker's default for T12 was "leave as is". The coordinator gave the decision to the UI/UX Engineer when the Desk build started.

## Decision
- **Dusk goes neutral, matching the landing page:** `text.primary` #FAFAFA, `text.secondary` #E2E2E2, `text.tertiary` #DADADA, `glyph` #E2E2E2, `switcher.text` #FAFAFA, `mark.disc` #E6E6E6, and `border.*` on `rgba(250, 250, 250, …)`.
- **Kept:** the slate surfaces, flat elevation and everything else in ADR 0029, including the rule of no #000 or #FFF in Dusk. #FAFAFA is the ceiling, and a unit test rejects pure white in any notation.
- **Why against the tracker's default:** the owner's one statement about Dusk's whites asks for this, and the default predates any look at it on a real desk.

## Consequences
- **Reverting is a change to one file,** `web/src/theme/tokens.ts`, plus one test that pins the values. Nothing else holds a color.
- **Contrast goes up.** Every Dusk text pair still passes the §3.12 table's minimums (`web/src/theme/tokens.test.ts`), and primary text gains contrast.
- **The prototype and `marketing/` renders still show the warm values.** They change only if someone re-renders them.
- **Design §3.12 is out of date on these values** until the System Engineer's docs pass picks up this ADR.
