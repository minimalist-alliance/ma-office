# 0039. Stream quality levels: Low, Medium, High and Max, an account default and per-app overrides

**Status:** Proposed (task 29), built on `sub/stream-quality` in `ma-desk` and `ma-platform`: Platform's setting, the `/account` card, the Desk app's menu, `desk-rtc` 0.3.3 and `desk-stream` 0.2.4. Measured on the test desk 2026-11-06 (`e2e/stream-quality/`, run `sq-1`) and rolled back there; on no other desk yet.
**Date:** 2026-11-06
**Amends:** [0033](0033-normal-mode-stream-profiles-and-member-desk-size.md) (one fixed default profile becomes four levels the member picks), [0034](0034-desk-media-path.md) (a fourth command on the `desk-stream` socket). Contract: [`docs/interfaces/stream-quality.md`](../interfaces/stream-quality.md) here, and `ma-platform` `docs/contracts/stream-quality.md`.

## Context
- The owner: "Users should be able to select low, medium, high, and max quality levels for apps that stream. Their account settings should have a default for all apps but individual stream-using apps can have an override."
- Apps that stream are the ones that reach the member as video from the desk: the Browser today, native apps such as Claude later. Notebook, Chat and Agent don't stream and get no setting.
- **Never sluggish** (ADR 0028, `README.md`): 60 fps and low input latency are never traded for bandwidth. A level may only change how sharp the picture is and how much data it uses.
- Task 24's bandwidth meter caps each week at 30% of the month (100 GB a month and 30 GB a week for a member). Choosing Low should make a week last longer, and say by how much.
- Today there's one encode for the desk (`desk-stream`, ADR 0034), at 1920x1080 and 60 fps, x264 constant quality 23 capped at 8 Mbps, with variable frame rate (a still page sends almost nothing). `desk-rtc` copies it to every session viewing. Changing `stream.conf` means a restart of `desk-stream`.
- `deskd` releases are off limits this weekend, and `desk-rtc` is allowed for this task.

## Decision

### 1. The four levels
Every level keeps 60 frames a second, the same input path and latency, and the same sound (Opus, 64 kbit/s). Only the picture's sharpness and the data change.

| Level | What the member reads | Picture sent | Frame rate | x264 quality (`quantizer`) | Ceiling | Data an hour, at most (video filling the window), measured | Scrolling, measured | A still page, measured |
|---|---|---|---|---|---|---|---|---|
| **Low** | Uses the least data. Text and video look softer. | Fits 1280x720 (the screen scaled down, then up again on yours) | 60 | 30 | 2.5 Mbit/s | **1.2 GB** (1.13 + 0.03 sound) | 1.13 GB | 0.15 GB |
| **Medium** | Sharp text, softer video. About half the data of High. | Full size (1920x1080 today) | 60 | 27 | 4 Mbit/s | **1.8 GB** (1.80 + 0.03) | 1.20 GB | 0.30 GB |
| **High** (the default) | Sharp text and clear video. | Full size | 60 | 23 | 8 Mbit/s | **3.6 GB** (3.60 + 0.03) | 1.47 GB | 0.37 GB |
| **Max** | The sharpest picture, for photos and fine detail. Uses the most data and needs a fast connection. | Full size | 60 | 19 | 12 Mbit/s | **5.4 GB** (5.41 + 0.03) | 1.68 GB | 0.47 GB |

- **"At most"** is the ceiling plus sound, over an hour: (Mbit/s + 0.064) x 450. GB is 10^9 bytes, as the meter counts. **Measured** (test desk, c7g.large, 1920x1080, `e2e/stream-quality/runs/sq-1.json`): a 1080p60 clip with motion filled each ceiling exactly, so the column is what a member sees with video full screen. Payload only; the transport adds about 5%.
- **Scrolling** is a long page scrolled continuously for 30 s. Low saves only about a quarter of High's here: scaled text moving a fraction of a pixel a frame is hard for x264's motion search, so Low sits at its ceiling.
- **A still page** costs 0.15 to 0.47 GB an hour, not the 0.02 ADR 0033 measured: the client drops a frame about every 2 s and asks for a keyframe each time, at every level, High included, with no packet loss (the "0.5 dropped frames/s with VFR" in `stream.conf`'s notes). It isn't caused by the levels; it's a follow-up for the System Engineer, and fixing it would cut a still page to near nothing at every level.
- **What a week covers** (a member's 30 GB, task 24), at most: Low about 26 hours of full-screen video, Medium 16, High 8, Max 5.5. Scrolling nonstop: Low about 26 hours, High 20. Reading, with the page mostly still, goes further. The menus say "Up to 1.2 GB an hour" and "Uses the least data", and the bandwidth meter's panel is the right place to suggest Low when a week runs short (a suggestion for task 24, not built here).
- **What Low trades away:** sharpness. The picture goes out at 1280x720 and the member's browser scales it up, so small text is softer and fast motion is blockier. It never trades frame rate, input latency or sound.
- **High is today's stream,** unchanged. A member who never chooses gets exactly what they get now, and so does an older Desk app or desk.
- **The gate:** a level ships only if, on the test desk, its input-to-frame latency (p50 and p95) and its page and stream fps are no worse than High's beyond the run-to-run noise (`desk-rtc/README.md`, "Measured"). If Low's scaling costs latency there, Low keeps full size and drops to quantizer 32 instead. If Max costs page fps on a `c7g.large`, its quantizer goes up until it doesn't.
- **The gate held (run `sq-1`, High run first and last for the noise, client RTT 47 to 55 ms).** Every level decoded 60 fps for video and scrolling, and the desk's page held 60.0 fps (p5 at least 59) at every level. Input to frame, idle and with the clip playing, p50 / p95 ms: High 75.4 / 97.0 and 103.9 / 116.9, then 83.0 / 96.7 and 107.7 / 123.6; Low 78.5 / 92.1 and 102.6 / 115.7; Medium 86.4 / 104.4 and 90.4 / 110.7; Max 75.9 / 93.5 and 106.2 / 115.1. Medium's idle p50 is 3.4 ms past High's slower run while its loaded figures are the best of all, so it reads as noise. Switches: the desk's reply in 50 to 57 ms, Low's first 1280x720 frame 83 ms after sending, a keyframe in 102 to 110 ms, never a reconnect. **To watch:** at Max the desk's own Chromium dropped 6.8% of the clip's frames against 3.2 to 3.5% at High (`desk-stream` 74% of a core against 70%): one run, page fps unaffected. If a repeat shows the same, Max's quantizer goes to 20.
- The numbers live in `stream.conf` (section 4), so tuning a level is a `desk-stream` release, not code.

### 2. Where the choice is kept: Platform, one document per member
- **One account default and a map of per-app overrides,** on the member's `users` row: `{default, apps: {browser: "low"}, updatedAt}`. Never set means `{default: "high", apps: {}}`. An override is per app, for that app on every desk the member has. "Use my default" removes the app's entry.
- **Read** from `GET /v1/me` (`streamQuality`), which both apps already call. **Write** with `PUT /v1/me/stream-quality`, a merge: `{default}`, `{apps: {browser: "low"}}` or `{apps: {browser: null}}`. Contract `ma-platform` `docs/contracts/stream-quality.md`. It's a viewing preference, not desk content, so the privacy rule is untouched: Platform never sees the stream.
- **The account default** is its own **"Picture quality" card on `/account`** (named "Streaming" until the brand review, so both apps use one term), between billing's cards and "Sign-in and privacy" (agreed with task 26's author), on that page's brand-kit styles. **The override** is in each streaming app's own menu in the Desk app, on the Desk app's current tokens: for the Browser, a button at the end of its bar, with "Use my default (High)" first.

### 3. How it reaches the desk: the client tells `desk-rtc` directly
- The Desk app works out each app's level (its override, else the default, else High) and sends it to its desk on the **`keys` data channel**, which `desk-rtc` already terminates itself: a 16-byte `QUALITY` event (type 7; type 6 is task 23's `HOLD`, ADR 0037). `desk-rtc` answers on the same channel with the level in effect (type `0x82`). No new channel, no renegotiation, no `deskd` change.
- It goes when a session starts viewing and whenever the level changes. The Desk app keeps the member's choice in `localStorage` too, so the first frame of a new session is already right without waiting for Platform, and re-reads `GET /v1/me` when the tab comes back into view, so a change on `/account` reaches an open office within seconds of looking at it.
- **One encode, several viewers:** the stream runs at the highest level any viewing session asks for, so no one's picture is worse than they chose. A session that never asks counts as High. A phone on Low beside a laptop on Max gets Max (and its data) while both watch; the reply's flags tell the phone why.
- **A ceiling from the desk:** `deskd` may send `desk-rtc` `stream.limit {level}` on `rtc.sock`, and the level in effect is never above it. That's where Platform's capped stream (`streaming.streamProfile: capped`, `ma-platform` ADR 0043) and task 24's limits belong, so a member who edits their own browser can't get round them. `deskd` doesn't send it yet (a follow-up once `deskd` releases open); the client's choice is trusted until then, which costs nothing the member doesn't already control.

### 4. How the desk switches in a second or two, with no reconnect
- `desk-rtc` sends `desk-stream` one more ASCII line on the existing socket: `level low|medium|high|max`. It sends it again first thing whenever `desk-stream` connects, before `resume`, so a restarted process starts at the right level. Changes are applied at most every 500 ms (the newest wins), because each one costs a keyframe.
- `desk-stream` reads `[level.<name>]` sections from `stream.conf` and applies one **inside the running pipeline**. x264enc takes a new `quantizer` only in READY (GStreamer 1.26: only `bitrate` and `vbv-buf-capacity` change while playing, and a quantizer set then is silently dropped), so `desk-stream` takes just the encoder to READY and back between two frames, with the new values, from an idle probe on the queue ahead of it: the same element, pipeline, payloader and clock. The size is a `capsfilter` after a `videoscale`, whose new caps make x264enc start again too. Either way it starts on a keyframe with new SPS and PPS. Measured in GStreamer 1.26.2 on x86: 13 to 29 ms from the command to the new level's keyframe, 60 fps throughout, and 81 switches 50 to 150 ms apart with no gap in the RTP sequence. The target at the member's screen is well inside 1 to 2 s. The session, the data channels, the sound and the browser's tabs carry on.
- **The browser needs nothing new for a size change:** an H.264 keyframe with new SPS is a normal mid-stream resolution change in WebRTC. Input is normalized to the picture, and `desk-rtc` scales it to the X screen, which doesn't change, so clicks land in the same place.
- **Task 23's rule holds:** no new payloader or pipeline; the one video branch keeps `timestamp-offset=0` on the same clock.
- **Older parts:** an older `desk-stream` logs `unknown command: level …` and keeps its one profile; a `stream.conf` without `[level.*]` sections builds exactly today's pipeline, with no `videoscale`. An older `desk-rtc` drops type 7 as a bad event and counts it. An older Desk app never sends it, so its desk stays at High.

## Consequences
- Members get four honest choices with their data cost in words, and the stream never gets slower to answer at any of them.
- Low, with the meter, lets a week stretch from about 8 to about 26 hours of full-screen video.
- A per-viewer encode (simulcast or a second encoder) would let two devices differ; it costs CPU on the desk and isn't done. The highest-level rule is the price.
- `desk-rtc` gains a small policy: the level per session, the highest of the viewers, the ceiling, and a 500 ms pace. `desk-stream` gains one command and a `videoscale` that sits in passthrough except at Low.
- Platform's capped profile (ADR 0043's `targetKbps`, 1500 as a placeholder) should map to Low's 2.5 Mbit/s ceiling through `stream.limit`. That's `deskd`'s follow-up, written down in the contract.
- Two sessions review this after the Monday reset: the UI/UX Engineer (the menu and the card) and the System Engineer (`desk-rtc`, `desk-stream`, the numbers).
