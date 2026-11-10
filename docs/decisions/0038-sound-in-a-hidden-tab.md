# 0038. Sound in a hidden tab: the stream stays live while the desk plays sound

**Status:** Proposed (task 22, 2026-11-06). Built on `sub/sound-hidden-tab`, in the Desk app only, and checked on the staging test desk. On no member's desk.
**Date:** 2026-11-06
**Amends:** design §4.2.8 and §10.5 (the 60-minute rule), `desk-runtime.md` 8.4 (the `warm` row). Reuses [0037](0037-sound-and-picture-sync.md)'s sound detection.

## Context
The owner was asked "Should sound keep playing in a hidden tab? ... it keeps playing while the desk is sending sound", and said "yes". Asked to keep a hidden tab's session open past 60 minutes while sound plays, with the 24-hour no-input rule still closing it: "yes that sounds good".

Before this, a Browser window in a tab hidden for 5 minutes asked for `warm` (`HIDDEN_LIVE_MS` in `web/src/browser/driver.ts`). `deskd` then sends `session.video {view: false}`, and `desk-rtc` stops forwarding both tracks to that session, and pauses `desk-stream` if it was the last viewer. So music on the desk cut out after 5 minutes, and the tab's sessions closed after 60 minutes hidden (`web/src/desk/idle.ts`) even if it had kept playing.

Sound alone can't be asked for today. `session.video` has one bit, and `desk-rtc`'s viewer forwards audio and video together. `desk-rtc` is a core part and was off limits to this task.

## Decision
1. **"The desk is playing sound"** is what 0037's picture hold already measures: the audio receiver's `getStats`, with packets arriving and a mean square level above 1e-7 between two samples (the desk's null sink sends digital zero when nothing plays). `peer.ts` now samples while the tab is hidden too, without holding anything: twice a second, or once a second where the browser throttles a hidden tab. `PictureHold.heardAt` is the last sample with sound, and `BrowserMedia.silentFor()` says how long ago that was.
2. **Silent for 60 s, the sound has stopped** (`SOUND_QUIET_MS` in `web/src/desk/sound.ts`). That's longer than a gap between tracks or a player's countdown to the next video, and a still page costs about as much picture as the sound while it waits (below).
3. **The 5-minute rule waits for the sound.** At 5 minutes hidden, a window whose desk is playing sound stays `live`. It looks again when the sound could have gone quiet, and goes `warm` a minute after it does. Once `warm` no sound reaches the tab, so it stays `warm` until the tab shows again. Coming back is instant while it plays, since nothing stopped, and as fast as today's `warm` to `live` after.
4. **The 60-minute rule waits for the sound too.** A hidden tab's sessions stay open while their desk plays sound. Once it stops, a tab hidden for over an hour closes them within three minutes: the rule checks once a minute, and allows a check's gap on top of the quiet minute, so a session replaced between two checks isn't taken for silence. **The 24-hour no-input rule is unchanged** and closes a session with music playing.
5. **A reconnect isn't the sound stopping.** `LastSound` keeps when sound was last heard across sessions, asking the old session before it goes.
6. **Until `desk-rtc` can send sound alone, the picture keeps coming too**, unseen in a hidden tab, while the sound plays. That costs data: on a still music page about as much as the sound itself (measured: 57 to 63 kbps of picture beside 65 kbps of sound, about 27 MB an hour), and up to 1.3 to 3.2 GB an hour while a video plays (`stream.conf`'s measurements), against a member's 30 GB week. The owner's call, in `~/subcontractor-tasks/DECISIONS.md`; the default is this, as the owner asked for the sound.
7. **Proposed for `desk-rtc`, so the picture stops while the sound goes on** (for the System Engineer; not built): a `keys` event, type 8 `PICTURE`, byte 1 `on` 0 or 1, per session like `HOLD`. With `on` 0 the session's viewer drops video packets and keeps forwarding audio, and `desk-stream` stays resumed. With `on` 1 the viewer waits for a keyframe again and asks for one (`waitKey`, `forceKeyLocked`), which is today's `warm` to `live` path. The app would send `PICTURE 0` where it now stays `live` for the sound past 5 minutes, and `PICTURE 1` first thing when the tab shows. An older `desk-rtc` drops type 8 as unknown (`keysDropped`), which is exactly what this ADR ships. Later, `desk-stream` could skip encoding while every viewer has the picture off.

## Alternatives
- **A `sound` level for `browser.stream.set`.** `deskd` would need a second bit in `session.video`, so `desk-rtc` changes anyway, plus `deskd` and its API. The `keys` event keeps it to `desk-rtc` and the app, as `HOLD` did.
- **A second session with an audio-only offer** (no H.264 gets `m=video 0` today), so sound needs no change on the desk. Rejected: two PeerConnections and sessions per hidden tab, a gap or a doubling of the sound at each switch, and the desk would count two clients.
- **Renegotiating the video transceiver to `inactive`.** Nothing renegotiates (`desk-runtime.md` 8.5), and the way back would be slower than `warm` to `live`.

## Consequences
- Music keeps playing in a hidden tab for as long as the desk plays it. A tab left hidden with a playlist that never ends keeps its desk awake until the 24-hour rule, as the owner chose.
- While it plays, the desk streams as if the tab were visible: the same desk CPU and, until point 7, the picture's data.
- The Desk app alone ships it. No `deskd`, `desk-rtc` or image change, and an older app or desk behaves as before.
- Tests: `sound.test.ts`, `driver.test.ts`, `idle.test.ts`, `pictureHold.test.ts`, and `browser.rtc.spec.ts` on a real `desk-rtc` with a fast clock; `tests/real-desk/rt-sound-hidden.mjs` on the test desk.

## Results (staging test desk, 2026-11-06; `desk-rtc` 0.3.2, `desk-stream` 0.2.3, `deskd` `4781fc1`, image 0.2.4)
`web/tests/real-desk/rt-sound-hidden.mjs`, as `desk-1`, with this branch's bundle routed in place of staging's, headless Chrome here (about 50 ms from us-east-1). Music is an arpeggio on a still page in the desk's Browser, from a page server of the run's own. Three runs. Run 3, on the merged branch, passed every step. Runs 1 and 2, before the merge, failed only two of the test's own checks, which were wrong and are fixed: which bundle had loaded, and how it saw the reopened session's first frame.

| | Run 3 (runs 1 and 2) |
|---|---|
| Hidden 340 s with music: what the app sent | nothing, so still `live`; the desk's `/health` says `live` |
| Sound arriving while hidden, each 20 s | 2,000 packets (100 a second), 65 kbps, energy steady |
| Picture arriving while hidden, unseen | 57 to 63 kbps (the page's counter changes each second) |
| Music ends, to `warm` | 60 s (60, 60); then no packets of either kind, and the desk says `warm` |
| Tab shown again, to a new frame | 84 ms (70, 79) |
| 62 fake minutes hidden with music, in 88 s (45 s steps, each with a real second) | session open, sound arriving, nothing sent |
| Music ends: 45 s, 75 s, about 135 s later | still `live`; `warm`; session closed |
| Tab shown again, to the new session's first frame | 1,978 ms, one `connect` with `start: false` |
| The desk once the run had closed its tab | silent; versions as found |

Locally, `browser.rtc.spec.ts` on a real `desk-rtc` with `fakeDeskStream` (11 of 11): past 66 fake minutes with sound it's `live` with no `pause` sent to `desk-stream`; with silence, `warm` and `pause` between 45 and 75 s, then the session closes; and coming back while it plays sends no `browser.stream.set` at all.

Not covered: a hidden tab in a real headed browser (headless Chromium never hides a page, so "hidden" here is `document.hidden`, as in the app's own specs), Safari and Firefox, and a real output device.
