# 0051. The bandwidth circle, and the Browser pausing at a limit

**Status:** Proposed (subcontractor task 24, for the UI/UX Engineer's review and a brand review). Platform's side is `ma-platform` ADR 0095 and contract `bandwidth.md`.
**Date:** 2026-11-06

## Context
The owner: "Just like how claude has a usage circle, we should put one on the bottom right of the office that shows bandwidth usage limit. We should limit 30% per week of the monthly limit so that members and us get a good feel for it without any of us losing money or being tricked. Once weekly network limits are reached, the user can't use any apps that require it, with the exception of guild apps." Only the Browser and streamed apps stop. The circle must be sleek and minimal, in Light, Dusk and Dark, and work by keyboard, touch and screen reader. Counting is Platform's, never the browser's. Many branches touch `web/`, so the change lives in new files.

## Decision
- **Where:** `web/src/bandwidth/`, mounted by one line in `shell/Shell.tsx`; the Browser is wrapped by one call in `apps/registry.tsx`. Platform's answer is `GET /v1/desks/bandwidth`; a `404` (a Platform without it) shows nothing, so either repo can ship first.
- **The circle:** a 44 px round button level with the zoom control at the bottom right, which moves left 52 px to make room. Inside, a 24 px ring: the track `surface.fillStrong`, the fill `accent`, turning `status.warn` at the warning line (80% by default) and full at the limit. No alarm red, no number on the ring, no new token. The ring shows the week, or the month when the month is nearer its limit.
- **What it says:** hover (mouse), tap, Enter or Space opens a small panel in the menu's style: "This week" and "This month", used of the limit, a 6 px bar each (`role="meter"`), when each resets in the member's own time, and one calm line when there's something to say. Esc or a tap away closes it, and focus stays on the button. The button's name carries the numbers ("Bandwidth: 12.3 GB of 30 GB used this week. Resets Sun 5:00 PM."), so a screen reader hears them without opening it. The real number is always shown, MB under 1 GB, never rounded up to the limit.
- **The heads-up:** one notice above the circle at the warning line, and one when the Browser pauses, each once per week per browser (`localStorage`). Opening the panel dismisses it.
- **The pause:** while Platform says `paused`, the Browser window shows "Browser is paused until Sun 5:00 PM" and that Notebook, Chat and Agent keep working and the tabs are safe, in place of the picture. The Browser's component unmounts, so its driver tells the desk `browser.stream.set off`. At `resumesAt` it mounts again by itself, even with no answer from Platform. Notebook, Chat, Agent and (later) guild apps are never wrapped. Not enforced (prod until the owner turns it on): nothing pauses and the panel says "You're past this week's limit."
- **Never sluggish:** the circle polls once a minute while the tab shows and renders only when the answer changes. The Browser wrapper subscribes only to a pause, so a poll never renders the Browser.

## Consequences
- The pause is the app's until deskd refuses `browser.stream.set live` on `streaming.streamProfile: "paused"` (a follow-up, no `desk-rtc` change). A member who edits their own browser could stream on meanwhile; it's still counted. **Done in task 33 (`sub/desk-followups`):** from that `deskd` on, the desk refuses `live` with `reason: bandwidth_limit` and ends an open stream while the pause is on, and leaves Chromium running (`services/deskd/docs/API.md` §10).
- `.ma-shell:has(> .bw) .bottombar` moves the zoom control; a future bottom bar change should take the circle in as a column instead.
- The colors follow `tokens.ts` today; ADR 0065's kit colors, when they land, reach the circle with no change here.
- Tests: `src/bandwidth/meter.test.ts` (words and numbers) and `tests/e2e/bandwidth.shell.spec.ts` (three themes, keyboard, touch, names, the heads-up, the pause and the reset), on the harness's stand-in (`harness/bandwidth.mjs`).

## Addendum 2026-11-09: the data guard beside the circle (S-35, `ma-platform` ADR 0110)
When the meter answers `dataGuard` (`{ message, since, resumesAt }`, contract `bandwidth.md` 0.3.44), the circle's ring takes the warning colour, its name says "Desks stopped: data use past your plan.", the panel opens with the platform's `message` as given and "Your next billing day is <date>." in the member's zone, and the heads-up says `message` once per flag. The guard is not the weekly pause: it stops the desks themselves, so the Browser's pause screen is unchanged. Nothing is shown for `null` or a Platform without the field. Details: `docs/sub-status/s35-guard-ui.md`.
