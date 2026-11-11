# 0096. A scope is a filter: Personal, Work and Guild hide the other desks and their badges

**Status:** Accepted (the owner accepted design Q6's default; recorded in the handover of 2026-11-05). Written up 2026-11-11 (TD-49).
**Date:** 2026-11-11

## Context
The office's scope switcher reads **Personal | Work | Guild | All**. The owner's mockup (`docs/assets/desk-inspiration.webp`) shows Work selected with Personal still visible. Design v1.1 asked, as Q6, whether a scope hides the other desks and their badges (a filter), or keeps every desk visible and only zooms to the chosen one (a focus). The vision's pillars are compartmentalization and anti-stress: in Personal, Work should stay quiet.

## Decision
The owner accepted the default, a filter ([ADR 0003](0003-canvas-interaction-model.md), design §3.2):
1. **Out-of-scope desks fade out** over 160 ms and stop rendering, hit-testing and badging. The camera fits the desks that remain.
2. **A scope with one desk** goes straight to desk mode on it, and the member can still zoom out.
3. **All** shows every desk.
4. **Cross-scope activity** shows only as a small dot on the segment whose desks have badges, never a number.
5. The mockup's Work-with-Personal-visible is read as a frame caught mid-transition.

## Where it stands (2026-11-11)
- **Built** in the Desk app: the filter (`web/src/canvas/DeskPanel.tsx`, `WorldStage.tsx`), and the switcher, which shows only with more than one desk and only the scopes the member's desks have (`web/src/chrome/TopBar.tsx`).
- **Not built:** the cross-scope dot (point 4). There's nothing for it in `web/src` yet.
- The Guild segment holds the guild's shared Guild Desk ([ADR 0080](0080-guild-shared-desk.md)).

## Consequences
- A member in Personal sees no Work badges, so Work can't nag. The dot says only that something waits elsewhere.
- Switching scope is a camera move plus a fade (budget B1).
- **Rejected:** focus without hiding. Every desk's badges would stay in view, against compartmentalization and anti-stress.
