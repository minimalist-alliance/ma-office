# The setup circle, What's new and the upgrade offer (S-121)

The Desk app's quiet guide to what a membership includes. Design: the Product Designer's `design-drafts/setup-circle/README.md` (in `~/ma-coord`). Code: `web/src/setup/`. Build record: `docs/sub-status/setup-circle.md`.

## What a member sees
- **The ring**, in the bottom bar just left of the usage circle, the same size and look. One segment per step, filled in `accent` as each step is done or skipped. Its name is "Setup: 2 of 6 done". It never opens by itself, speaks, badges or pulses; a segment fills once over 300 ms (at once under reduced motion).
- **The panel** (press, Enter or Space; Esc closes): "Set up your office", "2 of 6 done", the steps with the first open one expanded (its line, its button and a quiet Skip), done steps checked, skipped ones with Undo, and "Hide this circle" at the foot.
- **After setup** the ring becomes a star (What's new) or an up-arrow (the offer), and the panel is "Your office": the newest unseen What's new item (Try it, Got it) and one card for the next tier up (See membership, Not now for 30 days). With neither, there's no circle.
- **Hide and show:** "Hide this circle" in every state; the account menu's switch "Show setup and what's new" brings it back. Nothing else ever turns it back on.
- **A Founder with no guild** gets "Found your guild" first, and nothing on the canvas: no Guild Desk, placeholder or Guild scope until the guild exists (the owner, Nov 10: an empty spot kept sticking to the personal desk). The real Guild Desk shows once the guild has one.
- **Under 360 px** the ring leaves the bar, and the account menu has a "Set up your office" row that opens the same panel.

## Steps per tier
| Tier | Steps, in order |
|---|---|
| {free} | browser, agent-key, files, maia-trial |
| {alliance} | browser, agent-key, files, guild-join |
| {officer} | work-desk, browser, agent-key, files, guild-join, name-desks |
| {lead} | found-guild, invite, work-desk, browser, agent-key, files, name-desks |

A teen has no `agent-key`. Guild steps only while client-config `guilds.open` isn't `false`; `files` only while Files is on; `maia-trial` only where Maia's state has a `trial`. A change of tier keeps every done id. Rules: `steps.ts` (pure, `steps.test.ts`).

## How a step gets done (only by using it)
Only from what the office already sees, never from inside a desk: no file names, note text or page addresses.

| Step | Done when | Where it's noticed |
|---|---|---|
| `work-desk` | The Work desk is focused once | the view store (`signals.ts`) |
| `browser` | A Browser window on an own desk shows its first picture | `browser/driver.ts` → `used.ts` |
| `agent-key` | An own desk's `agent.state` has an agent with a key that isn't `no_key` or `error` | `desk/liveStore.ts` → `used.ts` |
| `files` | The desk link's `files.upload.finish` answers (one upload the office carried) | `used.ts` `watchUploads`, wired where `liveStore.ts` makes each link |
| `found-guild` | `GET /v1/guilds` has a guild with `role: "lead"` | the guild store |
| `invite` | That guild has `members >= 2` | the guild store |
| `guild-join` | `GET /v1/guilds` has any guild | the guild store |
| `name-desks` | An own desk's name differs from its kind, for a tier that renames | the desk list |
| `maia-trial` | `GET /v1/maia/state` `trial.status` is `active` or `ended` ({free} only) | `signals.ts`, at most once a minute |

A step done stays done. Done or skipped steps on a Guild Desk never count.

## Where it's kept (follows the member)
The layout document's `prefs` (Platform's one document per member, `PUT /v1/me/desk-layout`; account level, so it reaches every browser): `setup {done, skipped}`, `circleHidden`, `whatsNewSeen`, `offerNotNowUntil`. This browser keeps a mirror (`ma.setup.prefs.v1`, under the member's id) only so a reload doesn't flash what the document hasn't brought back yet; a step noticed before the document is read waits in the mirror and goes up with the document's own (`flushSetup`). No new route.

## Switches
- client-config `setupCircle: { enabled: false }` turns off the circle (absent is on).
- client-config `whatsNew: { enabled: false }` turns off the after-setup state (absent is on).
- What's new items come from client-config `whatsNew.items`, else the repo's `whatsNewManifest.ts` (empty until words are approved).

## Bundle
Only `door.ts` and `used.ts` are in the first load (initial JS 234.7 KB of 250). Everything else is the lazy `core` chunk, fetched once `/v1/me` says the member holds a tier and has an own desk.

## Tests
Vitest: `steps`, `signals` (which signal marks which step, per tier), `prefs`, `config`, `used`. Playwright: `setup.shell.spec.ts` (tiers, done by use, Skip and Undo, Hide and Show across two browsers, keyboard and screen-reader names, the Founder with no guild (no spot, no Guild scope), after setup, kill switches, a teen, axe in Light, Dusk and Dark, reduced motion, 320/375/1024 px) and `setup.shots.shell.spec.ts` (stills, only with `SETUP_SHOTS=<dir>`).
