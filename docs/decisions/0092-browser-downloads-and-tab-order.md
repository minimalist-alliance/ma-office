# ADR 0092: The Browser says when a download starts and ends, and keeps its tab order across a stop and a wake

**Status:** Proposed. Built on `sub/ls-31-36` (launch sweep LS-31 and LS-36). deskd and the Desk app; no image change.
**Builds on:** [ADR 0035](0035-browser-session-is-carried-over.md) (nothing touches `/data/browser/profile`), [ADR 0041](0041-deskd-drives-cdp-directly.md) (deskd drives Chromium over CDP), [ADR 0045](0045-unseen-desks-freeze.md) (a download keeps Chromium thawed).
**Date:** 2026-11-10.

## Context
- **LS-31:** a Browser download gave no sign in the window. Kiosk Chromium has no download bar, and the Desk app heard nothing, so a member clicking a download link saw nothing happen. The file lands in the desk's `/data/browser/downloads` (the image's `DownloadDirectory` policy). Files can't show it: the Files app serves `/data/files`, a tree only deskd writes, and deskd's container doesn't see `/data/browser/downloads` (`kiosk:kiosk 0750`).
- **LS-36:** the tab strip reordered itself across a stop and a wake. deskd lists tabs in the order it first sees them, and after a wake it first sees Chromium's restored tabs in Chromium's own order (most recently used first, as seen). Chromium doesn't report its tab strip over CDP. The tabs, cookies and history came back as they should (the owner's rule that the Browser session always carries over); only the order didn't.
- `docs/sub-status/desk-idle-freeze.md` left CDP's download events out because `Browser.setDownloadBehavior` hands downloads to DevTools while a connection lasts. That's true of `allow` and `deny`; `default` leaves Chromium's own handling, and the desk's policy, in place, and still sends the events.

## Decisions

### 1. Downloads: CDP's events, Chromium's own handling
On each CDP connection deskd sends `Browser.setDownloadBehavior {behavior: "default", eventsEnabled: true}` on the browser session. Files still go where the policy says. A Chromium that refuses it works as before, with one log line. deskd hears `Browser.downloadWillBegin` and `Browser.downloadProgress` only while it's connected, which it is while anyone views the Browser, so a download under way when the connection goes is dropped from the list. Nothing is kept on disk: the list is the newest 5, in memory.

### 2. The topic `browser.downloads`
A topic of its own, so a download's progress never resends the whole tab list. SUB with no params; every event is `snapshot` with the whole list, newest first:

```json
{"downloads": [{"id": "0f6c3b7e-…", "name": "report.pdf", "state": "completed", "receivedBytes": 4096, "totalBytes": 4096}]}
```

- `state` is `inProgress`, `completed` or `canceled`. `totalBytes` is 0 when the size isn't known.
- `name` is the file's name, from web content: cleaned as titles are (control and bidi characters out, 128 chars), never logged. On completion it's the name Chromium saved it under (`report (1).pdf`), when Chromium says. The address it came from isn't kept or sent.
- `filesPath` is there only when the finished file is in the Files tree (`/data/files/…`), as a path relative to it. No image puts Browser downloads there today, so it's absent on every desk.
- A start and an end publish at once; progress alone at most twice a second. Only while someone is subscribed; every SUB gets the whole list first, and `since` has no effect, as for `browser.tabs`.
- Needs the token's video, as `browser.tabs` does (`forbidden`, `reason: permission`). A deskd before this answers `not_found`, and the Desk app then shows nothing.
- Additive: `deskApi` stays `1.0`, as for every additive topic before it.

### 3. The window: one quiet line
The Browser window shows one small line at the picture's bottom left: "Downloading report.pdf 42%", then "Saved report.pdf on your desk" for 6 seconds (or "Download canceled: report.pdf"). Start and end are said once through the office's polite live region. A download that had already ended when the window opened says nothing. **"Show in Files"** opens the desk's Files window, the same as its tile, and shows only when `filesPath` says the file is there, so it never leads to a folder without the file. It lights up by itself once an image saves Browser downloads into the Files tree (below).

### 4. The tab order: a small file beside deskd's state, outside the profile
deskd keeps `/data/desk/browser-tab-order.json`: for each tab, in order, Chromium's target id and the first 16 hex characters of the SHA-256 of its address. No address, title or other page data, so no history lands in a second place. It never reads or writes `/data/browser/profile` (ADR 0035).
- **Placing a tab:** by its id while Chromium runs (a restart of deskd included); after a restart of Chromium (a stop and a wake), for 60 s after each new connection, by the first unclaimed entry with its address's hash, which is how Chromium's own restore brings tabs back. A tab with no match goes at the end, as every tab did before. Two tabs with one address take their places in order.
- **Writing:** on any change of the order or of an address, at the tab topic's pace (at most 4 a second), and once more as deskd stops. A temporary file renamed over it, mode 0600, no sync: losing it costs only the order. **Never while a restore may still be under way:** until every entry is claimed or the 60 s pass, the file stays as it was, so a stop in the middle of a wake loses nothing.
- **Reading:** a regular file only, no link followed, at most 64 KiB, version 1, ids and hashes checked; anything else starts with no order.
- The directory is found as deskd's control plane finds it (`deskd.data.dir`, else `DESKD_DATA_DIR`, else `/data/desk`); where that isn't a directory, as on a build machine, the order is kept in memory only. `BrowserModule` doesn't pass the data directory to `BrowserTabs` yet, as that file is on another branch; it can replace the lookup later with no change of behavior.

## Consequences
- A member sees a download start and finish, and the tabs come back in their order after a wake. Cookies, tabs and the session are restored by Chromium exactly as before.
- The file goes with the `desk` part in an export and a move: ids and short hashes, nothing a person could read.
- **Still to do for "Show in Files" to appear:** Browser downloads have to land where Files can show them, which is an image change (the System Engineer's: a `DownloadDirectory` inside the Files tree that both `kiosk` and deskd can use, or a helper that moves finished downloads there) and the Desk Engineer's Files rules for files it didn't write. Until then the line says "on your desk", which is true, and the export ("Download your data") is where a member gets the file.
- Ship order: deskd first, then the Desk app. Either alone is harmless: an older app ignores the topic, and a newer app on an older deskd gets `not_found` and shows nothing. The order needs only deskd.
