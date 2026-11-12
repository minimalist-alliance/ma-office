# 0090. The free tier on the desk: Browser time a day, a Files cap, limits that change live

**Status:** Proposed. Built in `deskd` on `sub/free-tier-desk` (S-119), in no release and on no desk.
**Date:** 2026-11-09
**Implements:** `ma-platform` ADR 0111 and contract 0.3.46: `agent.md` `tierLimits`, `tiers.md` section 11. Builds on ADR 0045 (media only to a desk someone looks at), ADR 0035 (the Browser's session is never cleared), ADR 0048 (Files), ADR 0043 (the member's own midnight) and the bandwidth pause (`ma-platform` ADR 0095).
**Shapes:** the Desk app's side is built (`sub/free-tier-office`), and sections 2, 5 and 9 take its shapes, as the coordinator asked: Browser use is `live`, the refusal is the bandwidth pause's, the heartbeat carries the count, and `desk.contention` says when the desk is held back.
**Number:** the Desk Engineer's range, 0041 to 0049, is used up, and 0050 to 0059 are the UI/UX Engineer's, so this takes 0090, which no range names.

## Context
The owner, Nov 9: a free tier with "lots of encouragement to upgrade without being annoyed", Browser time only ("Browser time only": 30 to 60 minutes a day, a console dial, 45 to start), Chat and Agent and Files never limited by time, 2 GB for Files, a stop after 30 idle minutes, and an upgrade that "automatically raise[s] their limits and remove[s] restrictions so they can keep the same desk". The Platform sends a free desk `tierLimits` `{tier, browserMinutesPerDay, filesGb, idleStopMinutes}` in its config, never absent on a free desk, and absent on every other. After an upgrade in place it's gone at a new `configVersion`. "We are betting on not every free user to be online at the same time and if they are then they will just experience some slowness."

## Decision

### 1. Where the limits come from, and what a bad read does
- `tierLimits` on `GET /v1/agent/config`, or in hello's copy, is read by `platform/TierLimits` on the boot thread, with every config, and kept in `/data/desk/tier-limits.json` (temp file, fsync, rename), as `agentDefaults` and the age band are.
- **A complete config with no field is no limits,** as the contract says, and they lift there and then (section 6).
- **A failed read changes nothing** (Security's `TD-2` lesson): a `503`, a timeout or a body that isn't a config never reaches the class. Hello's copy with `configVersion: 0`, which is the Platform's mark for a config it couldn't finish, changes nothing either, unless the desk holds no word at all yet.
- **A field that's there but isn't an object** (a null, a string) keeps what's held, none included, or with nothing held, the tier's built-in values (45 minutes, 2 GB, 30 minutes), as the field's being there says the desk is a free one. **A field that's bad inside a good object** keeps that field's held value, or its built-in one. Numbers are whole, and taken in wide bounds (1 to 1440 minutes, 1 to 1024 GB), so a Platform that widens a dial needs no desk release.
- **A file that's junk** holds the built-in values until the next config, failing closed as the age band's does. No file is "never told": no limits, which is every desk before its first config, and no session can come before then.

### 2. What counts as Browser use: `live` to any session, or the simplified view in use
Two things count, as one: **the Browser's video going to at least one session**, and **the simplified view in use** (ADR 0046, `browser.minified.*`).
- **`live`:** the seconds the Browser's video goes to at least one session: a session wants `live`, and the desk is looked at, as ADR 0045 cuts every session's media 5 s after nobody is. deskd sees it at the one place it tells `desk-rtc` (`session.video`), so it's exact.
- **The simplified view in use** (added after the Desk app began showing it on every desk, Nov 9; it browses with the Browser `warm`, so it cost the desk and the member's time without being counted): the desk is looked at (`desk.attention`) **and** any session holds a `browser.minified:` subscription; **or** for 15 s after an answered `get`, `act`, `image` or `island`, so a client that reads without subscribing is counted. The subscription is what a Desk app holds while a Browser window shows a page, and "looked at" is what stops a hidden tab's subscription from costing the member anything. A call's 15 s lease counts even when nobody has said they look, because a call is activity in itself. A refused call gives no lease.
- **One count:** both feed one flag, "the Browser is in use", which is on while the video goes to any session **or** the view is in use. Time is counted once per desk on the monotonic clock, so `live` and the view together are never twice, and the heartbeat's `media.browserLiveSeconds` is that one count.
- **Why this measure:** `warm` is the wrong signal, since a session wants `warm` for a Browser window that is merely open. What costs, and what the member does, is looking at a page: a stream, or a page deskd distils and answers calls and patches for. A subscription plus looking is the exact analogue of "video to a session plus looking". Counting every `get` alone would charge nothing for the view's idle patches and a lot for a burst.
- **Why not Chromium running:** it runs, or sits frozen, with nobody looking.
- **Not counted:** `warm` on its own, the desk not looked at (unless a call was answered in the last 15 s), the Browser window closed, data export, the clipboard, the tab list, the site memory methods, and the Files, Notebook, Chat and Agent apps.
- **A limit of the measure:** a client that never says it isn't looking is taken as looking while a session wants `warm` or `live` (DeskAttention's legacy rule), and one that reads without a subscription is counted for 15 s per call. A custom client that uses neither is not counted, and is not the Desk app.

### 3. The day
- **It resets at midnight in the account's zone,** `agentDefaults.timeZone` (ADR 0043), or UTC with none, the same rule the agents' limits use, so the desk and the Platform can work out the same day from what both already know.
- **A day's reset is fixed when the day opens,** at its first counted second, so a zone changed mid-day applies from the next day.
- **A new day never begins less than 23 hours after the last one ended** (money audit D1, Nov 10; was 20 hours, with a sooner midnight skipped to the one after): if the next midnight is sooner, it's the midnight after, so days stay on the member's midnight. A DST day is 23 to 25 hours, so this never binds on a real day; hopping zones daily gains at most an hour a day, and a member who moves 2 hours or more east gets one longer day instead of a short one. **A second desk counts on its own:** a desk can't see the member's other desks, so the cutoff across desks is the Platform's `browserTime`, from the heartbeats' `browserLiveSeconds` (a free member has one desk). A DST day is 23 to 25 hours, so this never binds on a real day, and it stops a member who changes zones from opening a fresh day every few hours.
- Most members never set a zone, and UTC ends an American's day in the afternoon or evening. The fix is the Platform's: set `agentDefaults.timeZone` from the browser at sign-up, or when a member goes free.

### 4. Kept across a restart and a stop, and told to the Platform
- **The day** is in `/data/desk/browser-time.json` (`openedAt`, `resetsAt`, its zone, milliseconds used), on the desk's own volume, so a stop, a restart of `deskd` and a move to another host keep it.
- **The count since boot** is in `/run/desk/browser-live.json`, beside `units.sock`, with the boot's ID, so a restart of `deskd` keeps it and a reboot starts it at 0. The heartbeat carries it as `media.browserLiveSeconds`, whole seconds, on every desk, so the Platform's meter can fill the member's `browserTime` the way it counts `bytesSent`.
- Both are written every 10 s while live, whenever counting stops and at the moment the time runs out, so a crash loses at most 10 s, in the member's favour. A day file that can't be read is a fresh day, with one log line.

### 5. Running out, calmly
- **At the day's limit,** every session that's `live` has its video cut at once and is left `off`, by the bandwidth pause's own path (`BrowserStream.endLiveForPause`'s, shared), and `desk-stream` stops once nobody wants `warm`. **Chromium isn't stopped:** nothing is closed, cleared or reloaded (ADR 0035), and it freezes 60 s later as any unviewed Browser does (ADR 0045). Tabs, cookies, history and sign-ins wait for tomorrow exactly as they were.
- **The refusal** is the bandwidth pause's, so every Desk app already pauses correctly: `browser.stream.set {state: "live"}` gets `unavailable` with `{reason: "bandwidth_limit", resumesAt, limit: "browser_time"}`, `resumesAt` being the member's next midnight (section 3) and `limit` telling the two apart. Nothing is asked of the units. `warm`, `off`, the tabs, Notebook, Chat and Agent carry on. With both the pause and the day's limit on, the pause's refusal comes first.
- **Back** at `resumesAt` by itself, with no reply needed, or as soon as the limits lift or grow past what's used. Sessions were left `off`, so the client asks again.
- **No method of deskd's own says the time left.** The Desk app reads it from the Platform's meter, which the heartbeat feeds, and the refusal says when it ends; warnings are the app's, from those.

### 5a. The simplified view at the limit
At the day's limit the view is held as `live` is, with the same words, so every Desk app pauses on what it already knows:
- **Refused:** `browser.minified.get`, `act`, `image`, `island` and a SUB to a `browser.minified:` topic get `unavailable` with `{reason: "bandwidth_limit", resumesAt, limit: "browser_time"}`, after the permission check and before any work (Chromium isn't thawed for them). The site memory methods (`site.get`, `site.set`, `sites.list`, `sites.clear`, `browser.adblock.site.set`) are not page reads and carry on.
- **Ended:** every open `browser.minified:` subscription gets an `error` event `{code: "unavailable"}` as the time runs out (`EventHub.endTopics`, as the live pause leaves its sessions `off`), and the client's next SUB gets the refusal and `resumesAt`. Any call's lease ends too. The watchers stop when nobody is subscribed.
- **Never touched:** tabs, cookies, history, sign-ins and the session (ADR 0035); Chromium isn't stopped and freezes after its grace as any unviewed one does.
- **Back** at `resumesAt` with nothing said, and at once when the limits lift or grow past what's used (section 6). A desk with no limits is never refused.

### 6. Limits change live
- **Lifted** (an upgrade, a config with no field): the Browser's gate opens and the Files cap goes at once, with nothing restarted. A desk out of time for the day can go `live` straight away.
- **Appearing** (a downgrade, or the first config of a free desk) on a running desk: counting starts from that moment, and a desk that's live is counted from then. Time from earlier the same day while limited still counts, so a day already used ends the stream at once; time while unlimited never does.
- **Changed** (the console's dial): what's left is worked out again at once.

### 7. Files: capped at `filesGb`, on top of the 2 GiB floor
- **What the cap counts:** the tree, the trash (or a member could keep anything there for 30 days), and the full declared size of every unfinished upload, running or parked, as any of them can resume.
- **The cap** is `filesGb` GiB (2^30 bytes), the floor's own unit, which is a little more than "2 GB" says and never less.
- **A new upload is refused** past the cap with `no_space` and `details.reason: "cap"`, `{reason, capBytes, capUsedBytes, needBytes}`; the floor's refusal is unchanged and has no `reason`. A client that doesn't know `reason` shows "no space", which is true. The cap is checked first, as it's the member's own and the one an upgrade lifts. The check and the new upload's reservation (its sidecar) are made under one lock, so two uploads racing for the last bytes can't both have them; that lock now covers the floor's check too, which before could let two begins past it at once.
- **Nothing is deleted or hidden** when a desk is over its cap (a downgrade, a lowered dial): listing, reading, renaming, deleting and restoring from the trash all work; only new bytes are refused. An upload admitted before the cap came finishes.
- **`files.usage`** adds `capBytes` and `capUsedBytes` (null with no cap), and `uploadableBytes` is the smaller of the floor's room and the cap's. The count is the walk `files.usage` already makes, kept for 60 s; an upload's finish now adds its size to the kept walk (before its sidecar goes, so it's never counted in neither) rather than throwing the walk away, so a run of uploads doesn't walk the tree for each. Anything that frees bytes still throws it away, so the count is high for a moment, never low.
- A change of the cap sends `files.changes {usage: true}`, so the Files app refreshes what it shows.

### 8. The idle stop: nothing on the desk changes
The Platform stops a free desk `autoStop.autoStopMinutes` (30) after its last activity, from its own sweep, by the contract's rule (`agent.md`, "Auto-stop semantics"): an open session at the gateway, or an agent busy or active. `deskd`'s side of that is already right for 30 minutes:
- **A Files transfer** needs an owner session, which the gateway counts, and `deskd` also notes it as input once a minute (`SessionManager.noteTransferActivity`).
- **An agent run** reports `agent.busyUntil` (now + 10 min while any agent is `working`), `activeTasks` and `lastActivityAt` in every heartbeat (`AgentModule.heartbeatFields`), which the Platform counts.
- **`clients.lastInputAt`** is display only by the contract, so nothing on the desk needs to change for it.

What does make 30 minutes come out longer is the office's own rule (`web/src/desk/idle.ts`): it rests a desk's sessions after 60 minutes hidden, or 24 hours with no input, and until then the open session keeps the desk awake. On a free desk the stop then comes after 90 minutes hidden, or 2 hours and 30 minutes on a visible tab nobody touches (it was 24 hours and 30 minutes before ISS-64b, below). That's the UI/UX Engineer's to shorten for a free desk (resting its sessions after `idleStopMinutes` with no input, unless a transfer or sound is going); and the Platform's 5-minute sweep (`terraform/desks.tf`; corrected from 15 by ISS-64) puts the stop between 30 and 35 minutes after the last activity.

### 9. `desk.contention`: held back, from the desk's own cgroup
- **The topic** `desk.contention` carries `{held}`: a snapshot on SUB and a `patch` on each change, for any owner session. `held` is true while the desk's whole cgroup is held back from the CPU for long enough to feel. Never from a client's numbers.
- **The signal is pressure, not throttling.** No size class has a CPU cap (a free desk is `cpu.idle`, the rest a weight: ADR 0072, `sub/host-size-classes`), so `cpu.stat`'s `throttled_usec` never moves, and being held back shows as the cgroup's `cpu.pressure` `some`: the share of time some task in the desk was runnable and waiting for a CPU. Held from `some avg10` (the kernel's 10-second average) at 25%, let go below 10%, so it doesn't flicker; `throttled_usec` over 10 s counts the same, should a class ever get a cap. A quarter of the time waiting for a CPU, over 10 s, is where a page's frames and keys visibly slow; the thresholds are a judgement, to be checked on a host under load.
- **What deskd can see:** nothing of it. On a shared host `deskd` is a runc container of its own, `desk-<k>/svc-deskd`, with its own cgroup namespace, beside the desk's `desk-<k>/desk` (ADR 0072), so its `/sys/fs/cgroup` is its own cgroup only. So the host must give it the desk's: read-only, `cpu.pressure` and `cpu.stat` of `desk-<k>` in `/run/desk-host/cgroup/` (`DESKD_CONTENTION_DIR`). Until `cpu.pressure` is there, a SUB is refused with `unavailable` and `reason: source`, which is also every desk of its own. The exact ask is in `docs/sub-status/free-tier-desk.md`.
- **Cost:** two small files read every 2 s while anyone is subscribed, and nothing otherwise.

## Consequences
- An upgrade lifts the Browser's limit and the Files cap at the next config, within a heartbeat, with nothing restarted, and a downgrade brings them the same way.
- A free desk's Browser costs nothing once its time is used: no stream, and Chromium frozen.
- The Desk app needs nothing new to pause a free Browser: it already handles `bandwidth_limit`, and reads `limit` for its words.
- The Platform gains a heartbeat field to meter, and the desk and the Platform each work out the member's day: they agree as long as both go by the account's zone, or UTC.
- The simplified view is counted and held with `live` (sections 2 and 5a), so it can't browse past the day's minutes. The heartbeat's `media.browserLiveSeconds` now means the Browser in use, live or the view; the Platform's text is in `docs/sub-status/free-tier-desk.md`.
- Agent timers on a free desk fire only while it's up, which after 30 idle minutes it isn't, as on every tier with its own stop: the contract has no wake for scheduled work.
- `desk.contention` says nothing until the host gives `deskd` the desk's cgroup files.
- **Addendum (ISS-64b, `sub/lsub-iss64b-visible-idle`, for UI/UX and the System Engineer):** the office now rests a free or an Alliance desk's sessions after 2 hours with no input on a visible tab, not 24, so the Platform's 30-minute (free, by default) or 20-minute (Alliance) stop follows about 2 hours 30 or 2 hours 20 minutes after the last touch (`web/src/desk/idle.ts`, `LIMITED_NO_INPUT_CLOSE_MS`; the tier comes from `startsWithOffice` and the free flag the office already holds, `desk/limited.ts`). The hidden tab's 60 minutes and the 24 hours of every other desk are unchanged. While the desk plays sound the 2 hours wait (the hidden rule's signal, ADR 0038); the 24 hours still close it.
