# 0063 Members call the app "your office", and one desk's agents are its "desk team"

Date: 2026-11-05 · Status: Accepted (the owner, relayed by the coordinator; tracker T26) · Product Designer. Updates the kit's naming in ADR 0060.

## Context
The brand kit and prototype call the app "Minimalist Home", and the vision and design call one desk's agents its "office team". Since members now go to `office.minimalistalliance.com`, and an office holds their desks, "office" means the whole space, so "office team" would point at the wrong thing.

## Decision
- **Members call the app "your office",** lower-case in a sentence, under the Minimalist Alliance brand. There is no separate app name or logo.
- **"Minimalist Home" is retired** everywhere members can see it.
- **One desk's agents are its "desk team".**
- **"Desk app" stays in engineering docs.**

**In the interface:**
| Place | Words |
|---|---|
| The logo's accessible name | Minimalist Alliance |
| The button that shows all desks | Your office, show all desks |
| The breadcrumb's first step, in desk mode | Your office › Work |

## Consequences
- `docs/vision.md` stays verbatim, so it keeps the old words. Past entries in `CHANGELOG.md` stay too.
- The brand kit's `app-ui/` mockups were the kit's own artwork and stayed as supplied, until the owner had the whole kit remade (ADR 0066): they're now `office-*`, and the overviews show the new name.
- The System Engineer updates `docs/desk-design.md` and the ADR index; UI/UX updates the apps and the landing page's wording.
- The prototype and `marketing/` renders show the old name at top left, so they get rebuilt. Any landing page image taken from them follows.
