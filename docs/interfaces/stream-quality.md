# Stream quality levels: the desk side of the contract

ADR 0039. The levels, their words and their data cost are there; this page is the wire. Platform's half (where the choice is kept, `GET /v1/me` and `PUT /v1/me/stream-quality`) is `ma-platform` `docs/contracts/stream-quality.md`. Built in two phases: the Desk app's menu and Platform first, then `desk-rtc`, `desk-stream` and the player once task 23 (`sub/av-sync`) has merged. *(2026-11-09, from the code on main: both phases are merged, and `desk-rtc` and `desk-stream` with levels are in every image from `ma-desk-0.2.6`, `image/RELEASES.md`.)*

```
Platform (GET /v1/me, PUT /v1/me/stream-quality)
   │  the member's default and per-app overrides
   ▼
Desk app ── keys channel: QUALITY (7) ──▶ desk-rtc ── "level <name>\n" ──▶ desk-stream (x264enc, videoscale)
        ◀── keys channel: QUALITY (0x82) ──      ◀── rtc.sock: stream.limit {level} ── deskd (later)
```

## 1. Levels on the wire

| Name | Number | Default |
|---|---|---|
| `low` | 1 | |
| `medium` | 2 | |
| `high` | 3 | Yes: what a session that never asks, an older app, and an older desk get |
| `max` | 4 | |

Order matters: "highest" and "at most" compare these numbers.

## 2. Which level an app asks for (the Desk app)
- **Its level on a desk** is the first that is set (ADR 0039 "Changed 2026-11-10", `ma-platform` contract 0.3.70): the app's own on that desk (`streamQuality.desks[<desk>].apps[<app>]`), that desk's own (`desks[<desk>].level`), the app's on every desk (`apps[<app>]`), the account's default (`default`, null while not set), then `high` (`levelOnDesk` in `web/src/quality/levels.ts`). App ids are the Desk app's (`browser` today). Only apps that stream have one; Notebook, Chat and Agent don't.
- **Before Platform answers,** use the copy in `localStorage` (`ma.streamQuality.v1`, the member's `sub` alongside it, so another member's choice is never used), then `high`. Never hold the stream back waiting for Platform.
- **When it goes:** on each new session, as soon as `keys` is open and before or with `browser.stream.set {state: "live"}`; and whenever that app's level changes while the session is open. `desk-rtc` forgets everything when a session closes, so a new session always sends it again.
- **A change on `/account`** reaches an open office when it next reads `GET /v1/me`: on load, and when the tab comes back into view (at most once a minute).
- **A change in the app's own menu** is that app's level on that desk (`PUT /v1/me/stream-quality {desks: {<desk>: {apps: {<app>: level | null}}}}`), and under "This desk" the desk's own for every app on it (`{desks: {<desk>: {level: level | null}}}`) (the owner's rule: the account sets a default, a desk overrides it, an app on the desk overrides the desk, and nothing set on one desk reaches another). It sends `QUALITY` at once on that desk's session only, and Platform keeps it, so any browser the member uses has it. `/account` sets the account's default and can put a desk back on it.
- **Against a Platform from before 0.3.70** (no `desks` in its document), the app's level on a desk stays in this browser (`ma.streamQuality.desks.v1`, with the member's `sub`) and "This desk" isn't offered, as before. Once Platform has `desks`, what this browser kept moves there once, under anything Platform already has, and the browser's copy is emptied.

## 3. `keys` (channel 7): `QUALITY`

### Client to desk, type 7
Exactly 16 bytes, like every client event on `keys` (`desk-runtime.md` §8.6).

| Offset | Field | Meaning |
|---|---|---|
| 0 | `u8 type` | 7 `QUALITY` (6 is `HOLD`, ADR 0037) |
| 1 | `u8 level` | 1 to 4 (§1). 0 withdraws this session's ask: it counts as never having asked |
| 2 | `u8 stream` | 0, the desk's one stream (the Browser). Anything else is reserved and dropped |
| 3 | `u8` | 0 |
| 4 | `u32 seq` | The session's event counter, as on every event (`desk-runtime.md` §8.6). `desk-rtc` doesn't order by it |
| 8 to 15 | | 0 |

- Accepted from any session, with or without `input`, and kept. It counts only while the session views, which needs `permissions.video` (§4). It isn't input: no `input.activity`, nothing injected. Like `HOLD`, it never reaches X.
- Any other size, level or stream is dropped and counted in `keysDropped`, as a bad event is today.
- A session that isn't viewing may send it. It's kept and counts once the session views.

### Desk to client, type `0x82`
16 bytes. Sent to a viewing session when it starts viewing, and to every viewing session when the level in effect, the limit, or that session's flags change.

| Offset | Field | Meaning |
|---|---|---|
| 0 | `u8 type` | `0x82` `QUALITY` |
| 1 | `u8 level` | The level the stream is running at, 1 to 4 |
| 2 | `u8 stream` | 0 |
| 3 | `u8 flags` | Bit 0: held below what this session asked, by the desk's ceiling. Bit 1: above what this session asked, because another viewer asked for more |
| 4 | `u8 limit` | The desk's ceiling, 1 to 4, or 0 for none: the lower of `deskd`'s `stream.limit` and the allowance profile's (§4) |
| 5 to 15 | | 0 |

An older Desk app ignores it: its `keys` handler reads only `CURSOR` (`0x81`).

## 4. `desk-rtc`: the level in effect
- **Each session's ask** is its last `QUALITY`, kept until the session closes or sends level 0.
- **The level in effect** is the highest ask among sessions that are viewing (`desk-runtime.md` §8.4), counting a viewing session that never asked as `high`; with nobody viewing, it stays where it was. Then it's lowered to the ceiling, if there is one: the lower of `deskd`'s `stream.limit` and the allowance profile's.
- **The allowance profile** (ADR 0036, `desk-rtc` 0.5.1 on, S-29): past a member's allowance `desk-egress` names `capped` or `deep` in `/run/desk-egress/profile` and restarts `desk-stream`, whose `run` starts that profile's conf. `desk-rtc` reads the same file at start and each time `desk-stream` connects, which is when the two agree, and takes the profile's ceiling: `capped` Medium (its picture is Medium's size and ceiling, 1080p and 4 Mbit, at quantizer 28 against Medium's 27), `deep` Low (540 lines at Low's 2.5 Mbit ceiling, softer than Low's 720). A member on Max past 100 GB is told `medium`, flag held, ceiling `medium`, and the Desk app says "This desk is held at Medium for now." A member on Low keeps Low, which is inside the cap, with no flag. A missing file, `normal` or anything else is no ceiling, as on a self-hosted desk. On a shared host the file is the host's per-slot copy where it's mounted for `desk-rtc` too; where it isn't, `desk-rtc` sees no ceiling and the conf still holds the picture.
- **Pace:** a change goes to `desk-stream` at once if none went in the last 500 ms, otherwise when that 500 ms is up, as the newest value. Each change costs a keyframe.
- **To `desk-stream`:** `level <name>\n` (§5). It's also the first line after `desk-stream` connects, before `resume`, so a new process starts at the right level, with or without viewers.
- **`stats`** adds `stream.level` (a name), `stream.limit` (`deskd`'s, a name, or null), `stream.profile` (`capped` or `deep`, absent for the normal picture, `desk-rtc` 0.5.1 on), and per session `quality` (its ask, absent until it asks).

### `rtc.sock`, from `deskd`: `stream.limit`

| From `deskd` | Reply | Notes |
|---|---|---|
| `stream.limit {level}` | none | `level` is a name from §1, or null for no limit. The level in effect is never above it. Takes effect at once, under the same pace. Kept across sessions; reset to none when `deskd`'s connection is replaced |

`deskd` doesn't send it yet. When it does, it maps Platform's `streaming.streamProfile` (`ma-platform` contract `agent.md`): `normal` is null, `capped` is `low`. Task 24's `paused` isn't a level: it stops the stream (`browser.stream.set off`).

## 5. `desk-stream`: the `level` command and `stream.conf`
`desk-runtime.md` §8.2's command lines gain one: `level low|medium|high|max\n`.

**`stream.conf`** gains one section per level. `[video]` stays the pipeline; a level only changes these values within it:

```ini
[level.low]
max-height = 720        # scale to fit this many lines, aspect kept, even sizes; 0 = the screen's own size
quantizer = 30          # x264enc quantizer (constant quality with pass=qual)
bitrate = 2500          # kbit/s: the VBV ceiling with pass=qual
vbv-buf-capacity = 150  # ms

[level.medium]
max-height = 0
quantizer = 27
bitrate = 4000
vbv-buf-capacity = 150

[level.high]
max-height = 0
quantizer = 23
bitrate = 8000
vbv-buf-capacity = 150

[level.max]
max-height = 0
quantizer = 19
bitrate = 12000
vbv-buf-capacity = 150
```

- **With any `[level.*]` section,** the video branch gains `videoscale ! capsfilter name=size` between `convert` and the one-frame leaky queue. At a full-size level the filter matches the screen, and `videoscale` is in passthrough, costing nothing.
- **Without any,** the pipeline is exactly today's, and `level` lines are logged once and ignored.
- **The allowance profiles** (ADR 0036, `desk-stream` 0.3.5 on, S-29): `stream-capped.conf` has the four levels, each `stream.conf`'s held to its own picture (the fewer lines, the higher quantizer, the lower ceiling): Low is Low, and Medium, High and Max are the capped picture, which its `[video]` line also runs. None asks the encoder for more than the profile itself. `stream-deep.conf` has none, since every level held to it is its own picture; it logs `level` once and changes nothing. Before 0.3.5 the capped conf had none either, so a member on Low got the capped picture past 100 GB, sharper and about 60% more data than Low.
- **Applying a level** happens in the running pipeline, PAUSED (warm) or PLAYING. If the encoder values differ, only x264enc goes to READY and back between two frames (an idle probe on the queue's source pad), with `quantizer`, `bitrate` and `vbv-buf-capacity` set while it's in READY: x264enc ignores a `quantizer` set while PAUSED or PLAYING (GStreamer 1.26.2). Then the size filter's caps change if the size did (x264enc renegotiates), and a keyframe is forced. Either way the encoder starts again on a keyframe with SPS and PPS. `[video]`'s `option-string` doesn't fight a level: x264enc applies `bitrate` and `vbv-buf-capacity` after it whenever it opens. The same level twice does nothing. An unknown name is logged and ignored.
- **A new process** (`desk-stream` 0.3.5 on, S-29) takes a level's size at once, so its first frame is already the level's size, but its encoder values only after that first frame, then at once with a keyframe: the first frame carries `[video]`'s quantizer and ceiling. Reopened while still warm, with `resume` and `keyframe` right behind as `desk-rtc` sends them, x264enc failed 4 of 10 starts at Max on a real desk ("encoder not initialized").
- **`[video]`'s `x264` line** still sets everything else, and is what runs before the first `level` line arrives. It should match `[level.high]`.
- **Kept from task 23:** no new payloader or pipeline. The one video branch keeps its payloader at `timestamp-offset=0`, on the same clock as the audio.

## 6. What a browser sees
- A size change is a keyframe with new SPS: `videoWidth` and `videoHeight` change (1280x720 at Low on today's 1920x1080 screen), with no signaling and no renegotiation (`desk-runtime.md` §8.5 already says the size can change).
- Input is unaffected: it's normalized to the picture's content box, and `desk-rtc` scales it to the X screen, which a level never changes.
- The session, the data channels, the sound and the desk's tabs carry on through a switch.

## 7. Versions
| Part | Without phase 2 | With it |
|---|---|---|
| Desk app (menu) | Shows and saves the choice; sends nothing | Sends `QUALITY`, shows the reply's reason |
| Platform without `desks` (before 0.3.70) | | A desk's level for an app kept in the browser that chose it; no desk-wide level |
| `desk-rtc` | Drops type 7 and counts it | §4 |
| `desk-stream`, `stream.conf` | Ignores `level` | §5 |
| `desk-rtc` before 0.5.1, past the allowance | | Echoes the member's level while the profile's conf holds the picture: Max reads Max on a capped desk |
| `desk-stream` before 0.3.5, past the allowance | | The capped conf ignores `level`: Low gets the capped picture |

Any mix works, and an older piece anywhere means High, as today.
