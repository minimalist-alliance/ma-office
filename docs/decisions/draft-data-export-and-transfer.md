# Draft: download all my data, and move my desk to my own hardware

**Status:** Draft (task 32, 2026-11-06). The integrator numbers it at merge. The platform's half is `ma-platform` `docs/decisions/draft-data-export-and-transfer.md`; this page is the desk's half and the wire format both sides build to.

## Context
The owner, verbatim: "Once last feature that MUST come before we ship is that for active members and members who's data is being retained after account closure, we must allow them the ability to download all of their private data at no additional cost. We should also provide the courtesy of allowing members to convert their cloud desks into self hosted desks with a script that authenticates and syncs all the data for them."

And: "even with the future Files app, we will not give users full ssh access to the cloud server. We will give them ways to setup bots with a workflow engine instead so there should be no reason someone needs terminal access to their desk's compute unit."

Rules this keeps: the platform can't read desk content, exports included (README, "Privacy is what we sell"); a desk's browser session always carries over (ADR 0035); members never get a terminal on a cloud desk; it's free and outside the bandwidth limit (`ma-platform` ADR 0095).

## Decisions

### 1. The export never touches our storage
The desk reads its own files and streams them **straight to the member's browser over the desk's own WebRTC connection** (the `bulk` channel, design §4.2.5). The browser writes the archive to the member's disk as it arrives. Nothing is uploaded, staged or cached anywhere of ours, so there's nothing to encrypt at rest: the bytes are only ever inside DTLS between the desk and the member, as all desk content is.

**On the member's own computer, an unfinished download is sealed and doesn't linger** (added 2026-11-06, `fb82756`). To carry on after a reload, the browser keeps a working copy and a journal in its private storage, and that computer may be shared. Both are AES-GCM under a key generated non-extractable and kept beside them, so neither is ever there in the clear. All of it is deleted after 6 hours without progress, at sign-out or when a dead session goes to sign in, on Discard or Stop, and once the archive is saved. Details: `web/CLAUDE.md`, "At rest, sealed".

The platform's own records about the member (account, billing history, Maia's memories) come from the platform's API to the same page, and the browser puts them in the same archive.

### 2. One plain ZIP, made in the member's browser
`minimalist-alliance-export-YYYY-MM-DD.zip`. ZIP because every computer opens it with a double-click. Entries are STORED (not compressed), so a dropped connection resumes mid-file and the format stays the simplest there is; ZIP64 when anything passes 4 GiB; UTF-8 names (flag bit 11). Layout:

```
README.txt                      what's here and how to open each part, in plain words
manifest.json                   format 1: every file's path, size and SHA-256, the desks, when it was made
account/account.json            name, email, sign-in method, when you joined
account/membership.json         tier, status, the dates
account/billing-history.json    charges, refunds and invoices we hold
account/maia-memories.json      everything Maia remembers about you
account/desks.json              your desks: names, kinds, where they're hosted
desks/<desk name>/browser/      the Browser's profile, exactly as Chromium keeps it
desks/<desk name>/browser-readable/<profile>/bookmarks.html   importable into any browser
desks/<desk name>/browser-readable/<profile>/history.csv      when, title, address
desks/<desk name>/<part>/       every other part of the desk (section 4), as stored
```

`manifest.json` lets a member, or the transfer script, check every byte. It needs every file's hash, so it's written last and listed second in the ZIP's index. Symbolic links are recorded only in `manifest.json`, never as ZIP entries, and a name with `..`, a backslash or a NUL is left out and listed under `notCopied`, as is a file whose hash still doesn't match after three reads. `README.txt` says the same as the member's guide (`ma-platform` `docs/kb/your-data.md`).

### 3. A root helper reads the files; deskd never gets wider access
`deskd` runs as `desk` and sees only `/data/desk` (`desk-runtime.md` §5). The Browser's profile is `0750 kiosk` with `0600` files, and apps' data is `0700` per app (draft desk app contract). Rather than widen deskd's container, **a new socket-activated root helper, `desk-data`, does the reading**, in the same pattern as `desk-units` (§8.3):

- `/run/desk/data.sock`, mode `0600`, owner `desk`, `Accept=yes`, one root `desk-data` per connection, `SO_PEERCRED` uid 1100 only, no shell.
- **Read-only.** It has no verb that writes, renames or deletes anything under `/data`. The only thing it writes is its own short-lived scratch copy of a SQLite database (below), in `/data/.ma-export-tmp/`, `0700 root`, removed when the connection ends and emptied at every start.
- Paths are confined to the part's root: no `..`, no absolute paths, every component opened with `O_NOFOLLOW` from the part's root directory, symlinks reported as links and never followed.
- `ProtectSystem=strict`, `PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `ReadOnlyPaths=/data` with only `/data/.ma-export-tmp` writable.

The helper's code lives in `tools/desk-data/` with its two unit files. The image carries it from `ma-desk-0.2.6` (task 37: copied into `image/recipe/files`, enabled by `build.sh`, checked by `verify.sh` section 3b3, and `bake.sh` refuses copies that differ from `tools/desk-data/`). Until a desk has it, every `data.*` call answers `unavailable` with `reason: "helper"`, and the Desk app says the export isn't available on that desk yet.

### 4. Parts: everything on `/data`, minus what belongs to the machine
A part is a top-level directory of `/data`. Every directory is a part, so a future app's data is in the export without a change here, except this fixed list of things that belong to the machine, not the member:

| Left out | Why |
|---|---|
| `/data/rtc` | The desk's DTLS identity. A new desk has its own |
| `/data/selfhost` | A self-hosted desk's own key and pairing (task 31). Copying it would make two desks one |
| `/data/desk-egress` | The throttle's budgets |
| `/data/.ma-volume`, `/data/desk/volume.json` | The volume's record (ADR 0035) |
| `/data/apps/*/releases`, `/data/apps/*/current`, `/data/apps/*/previous`, `/data/apps/registry.json` | Installed packages, which a desk installs itself |
| `/data/apps/*/cache` and the Browser's rebuildable caches (below) | Rebuilt on use (ADR 0035 allows only these to be dropped) |
| `lost+found`, `/data/.ma-export-tmp`, `/data/.ma-move` | Not data |

The Browser's caches left out, under `browser/profile/` and each profile directory in it: `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `GrShaderCache`, `GraphiteDawnCache`, `ShaderCache`, `component_crx_cache`, `Crashpad`, plus the lock files `SingletonLock`, `SingletonCookie` and `SingletonSocket`. Never `Cookies`, `History`, `Sessions`, `Login Data`, `Web Data`, `Local Storage`, `IndexedDB`, `Service Worker` or anything else.

Each part has a friendly name in the archive and the guide: `browser` Browser, `desk` Desk settings, Notebook and Chat (deskd keeps them, desk app contract), `agent` Agent, `apps` Apps, `files` Files. An unknown part keeps its directory name.

### 5. A consistent copy while the member keeps working
- **SQLite files** (any regular file starting `SQLite format 3\0`) are sent as one consistent copy made in the helper's scratch directory, never torn. First SQLite's online backup, for up to 1 s. Chromium holds `History`, `Web Data` and `Login Data` with an exclusive lock while it runs, so the backup can't get in; then the helper copies the database with its `-journal` or `-wal` directly, but only when none of them was written in the last 200 ms, and keeps the copy only if nothing changed while it copied (tried every 250 ms). SQLite then rolls that copy forward in scratch, and the one whole file is what's sent. With no clean copy within 10 s, the read is `failed` and the reader tries again later. A SQLite copy is refused unless 2 GiB stays free on `/data` (ADR 0035's floor) after it and after what the copies other connections are making may still write: each helper is its own process, so they keep that count together in their scratch directory, under a lock (`tools/desk-data/README.md`, "Room"). The `-journal`, `-wal` and `-shm` files are never listed. A file with the header that SQLite can't open is sent as it is.
- **Everything else** is read as it is, and never sent torn. The SHA-256 at the end of each file (section 7) is of what was sent, so on its own it can't see a file rewritten in place while it was read from 0: old bytes and new would match their trailer. (Corrected 2026-11-07, data review: this said the hash caught it.) So the helper compares the file's device, inode, size, mtime and ctime before its first byte and after its last, and if any moved, the read ends with no trailer, the failed-read ending, and the reader asks again. A file changed in the last 50 ms waits until it's been still that long first, as timestamps come from a coarse clock. A read carried on from an offset hashes the part before it from the file as it is then, so old bytes there fail the trailer and the reader reads it from 0. LevelDB stores (Local Storage, IndexedDB) recover from their own log, so a copy of one taken file by file is at worst a few seconds behind.
- **The transfer's last pass holds the Browser** (`data.browser.hold`): deskd stops Chromium through `units.sock`, keeps it stopped and every `live` refused with `unavailable`, `reason: "held"`, until `data.browser.release`, the session's end, or 30 minutes. Then nothing is moving, and the copy is exact. The script renews the hold every 10 minutes, and counts the Browser's pass only if one hold lasted from its listing to its last read; a hold lost on the way (the session dropped, a renewal refused, its time run out) means listing the profile again and copying what changed under a new hold. A hold refused 4 times stops the move: the Browser is never copied unheld. The export doesn't hold it: the member keeps browsing while they download.
- **A move keeps the hold** (`data.browser.keep`, Security's `NE-2`). Released after the pass, the cloud desk's Chromium started again on the cookies the new desk now has, and a site that rotates its sign-in tokens would sign the member out there. So the pass that counts ends with a keep on the session that held it: deskd keeps the hold past the session and through restarts, in `/data/desk/browser-moved.json`, never touching the profile (ADR 0035), until the member lets go from the Desk app with `data.browser.release {kept: true}`, which only an owner session may send. While kept, `live` and `warm` get `unavailable` with `reason: "moved"` and `since`. That file is the cloud desk's own, so a move never carries it.

### 6. An export-only desk token
A new desk token scope, **`export`**: `video: false`, `input: false`, and only these methods: `desk.status.get`, `data.parts.list`, `data.manifest`, `data.read`, `data.read.stop`, `data.browser.hold`, `data.browser.keep`, `data.browser.release` (but not with `kept: true`), `data.browser.cookies`. Everything else answers `forbidden`, including every `agent.*` method and topic and every subscription. An `owner` session may call the `data.*` methods too, but only an `export` session's reads are free (section 8), so `export` is what every export gets: the Desk app's, an active member's or a closed account's, and the transfer script's (platform draft, sections 3 and 4).

A `deskd` from before this refuses `export` tokens outright (`invalid_token`, it accepts only `owner`), so a new token can never reach an old desk with more power than it should have.

### 7. The wire: `data.*` on `rpc`, file bytes on `bulk`
Design §4.2.5's transfer pattern, made exact.

**`data.parts.list {}`** → `{parts: [{part, label, files, bytes}], helperVersion}`. Sizes are an estimate, from a walk without hashing.

**`data.manifest {part, cursor?}`** → `{entries: [{path, type, size, mtimeMs, mode, target?}], next}`. `type` is `file`, `dir` or `link` (`target` for a link). `path` is relative to the part, `/`-separated, NFC as stored. At most 2,000 entries a page; `next` is an opaque cursor, `null` on the last page. A SQLite file's `size` is its size on disk, which can differ from what `data.read` sends.

**`data.read {part, path, offset}`** → `{transferId, size, mtimeMs}` straight away. `size` is the length of what will be sent, from `offset` 0 (for SQLite, the backup's). Then on `bulk` (channel 5):
- deskd sends **CHUNK** frames (kind 15, BIN), `id` = `transferId`, `seq` from 0, each carrying up to 16,372 bytes of the file, starting at `offset`, in order.
- Only as far as the reader's credit allows: the reader sends **CREDIT** (kind 16, JSON) `{"bytes": n}` with the same `id`. Credit counts file bytes (CHUNK payloads), and END needs none; a reader that grants frame bytes only grants a little more than it must. The first window is **1 MiB**, granted by `data.read` itself, so a reader sends CREDIT only to grant more. Grant after writing, in steps of at least 256 KiB. A transfer with no credit for 5 minutes ends itself.
- The **last** CHUNK has END and carries no file bytes: its payload is the 32-byte SHA-256 of the whole file from byte 0 to `size`, then `u64be size`. The helper hashes the part before `offset` itself and deskd passes its trailer on unchanged, so a resumed read is checked end to end. An END with an empty payload means the read failed part way: read it again.
- A file that changed while it was read, including one that ended early or grew, ends with an empty END, as above: read it again. (Until 2026-11-07 it ended with a trailer for what was read, which a file rewritten in place matched.) The reader compares the trailer with what it has and the length with `data.read`'s `size`; a mismatch means read it again from 0.
- **`data.read.stop {transferId}`** ends one early. A session's transfers end with it.
- Per session, at most **8 transfers** at once, and **12** across the desk (`too_many` above either), and deskd keeps at most 8 MiB of unsent chunks in all, so a slow reader slows only itself.
- `transferId` is deskd's, unique per session, never reused within one.

**`data.browser.hold {}`** → `{held: true, until}`, once Chromium has stopped; it refuses `warm` as well as `live`. **`data.browser.keep {}`** → `{held: true, kept: true, since}`, from a session that holds it, as a move's last step; `unavailable` with `reason: "not_held"` otherwise. **`data.browser.release {kept?}`** → `{held: false}`, or `held: true` while another session still holds it or a move kept it; `kept: true` lets go of a move's keep too, owner scope only. Idempotent; owner or export scope. A stop that fails is `unavailable`, `reason: "chromium"`.

**`data.browser.cookies {}`** → `{count, items: [{k, v, e}]}`, read over CDP from the running Chromium (`Storage.getCookies`): `k` is the first 16 hex characters of SHA-256 of `domain\tname\tpath`, `v` the same of the value, `e` the expiry in Unix seconds or `-1` for a session cookie. Hashes only, never a cookie. The transfer script reads this before its last pass, and the same from the new desk's Chromium afterwards, to prove the sign-ins decrypt there (section 9).

**Errors** (`API.md` §4): `not_found` (no such part or path), `invalid` (a bad path), `forbidden` (the scope), `too_many`, `unavailable` with `reason` `helper` (no helper, or it failed) or `chromium` (for `cookies` and `hold` when the Browser can't be reached).

### 8. Free, and outside the bandwidth limit
- **No charge** anywhere: there's no billing code on any of these paths.
- **Not counted by the meter.** deskd counts every byte it hands to `desk-rtc` on `bulk` for a free `data.read` (frame bytes, header included), and the heartbeat carries the running total since deskd started as **`media.freeBytesSent`** (a deskd restart starts it again, which the meter takes as a new count) (contract `agent.md`, 0.3.15). The meter takes it off `bytesSent`'s growth before counting (`ma-platform` draft, section 6). `bytesSent` is what ICE carried, DTLS and SCTP included, so the meter takes off 7% more than deskd counted, never more than `bytesSent` grew. Self-hosted desks aren't metered at all (task 31), so this only matters on cloud desks.
- **Free only for an export, and only so far.** Any member can get an `export` token, so a client looping `data.read` would otherwise never reach a bandwidth limit, and only the cost guard's monthly stop would end it. So a byte is free only on an `export` session, and only up to **3 times the data volume's size in 30 days**, which covers a full export, a move and retries: 96 GiB on today's 32 GB volume. An `owner` session's reads and anything past that aren't added to `freeBytesSent`, so they reach the meter, and they still arrive. deskd keeps this itself (`data/FreeBudget`), so neither the Platform nor the contract changes. The window starts at the first free byte. It's kept in `/data/desk/free-export.json`, written through a temporary file about once a minute while it counts and at shutdown, so a restart can't refill it. A missing or corrupt file starts fresh, and a failed write never stops a transfer.
- **A paused member can always export.** While the Platform's bandwidth pause is on, `data.read` answers `unavailable` with `reason: "bandwidth_limit"` and `resumesAt`, as the Browser's `live` does, for an `owner` session. An `export` session is never refused for a pause, within its 3 volumes or past them (Security's `NE-1`: refusing it past them ended the Desk app's download "done" with files skipped), and a closed account's export window is the same. Past them its bytes reach the meter, and the cost guard and the throttle bound what they cost. Transfers already running finish, and the metadata calls and holds are never refused.
- **The cost guard** (ADR 0082) stops at 30 GB in 15 minutes and 150 GB in a day. `bulk` sends at most 35.5 Mbit/s even at 10 ms (`desk-runtime.md` §4.5), about 4 GB in 15 minutes and 380 GB in a day at the very most, so a 32 GB drive can't reach either. Nothing changes there.
- **The outbound throttle** (`desk-egress`, ADR 0036) counts every byte toward its month and 24-hour budgets, so a big export could put that desk's stream on `capped` for the rest of the day. It can't tell an export from a stream, as both are `desk-rtc`'s on 443. Asked of the System Engineer: read `/run/desk/free-bytes`, which deskd would write, and leave those bytes out. Until then, a member who exports 32 GB in a day and then streams heavily may see the lower stream profile sooner. That's the only effect.

### 9. The move: a script on the member's own machine
`ma-move`, in `tools/desk-move/`, a Go program built on Pion like `deskctl`. It runs **as root on the self-hosted desk** (task 31), which is the member's own hardware, never on the cloud desk. The cloud desk is reached only through deskd, with an `export` token, like the Desk app.

1. **Signs in:** the member opens their office's "Download your data", then "Move a desk to your own computer", picks the cloud desk and their self-hosted desk, and gets a one-time code. `sudo ma-move` asks for it (never on the command line, so it isn't in shell history), redeems it once for a move token valid 24 hours, and keeps it `0600` in its state file for a resume (platform draft, section 4).
2. **Pairs** the two desks: the code names both, and the script refuses unless its own desk ID is the target's. It reads its own ID from `/data/selfhost/desk.json` (task 31), and the platform only accepts a cloud desk as the source and a self-hosted desk of the same member as the target.
3. **Copies everything:** every part (section 4) into `/data/.ma-move/<moveId>/stage/<part>/`, with up to 8 reads in flight, each file checked against its trailer. Names are bytes: a name that isn't UTF-8 travels as the helper's `\udcXX` escapes both ways and is staged and journaled as its own bytes, and one the script can't make exactly stops the move rather than being left out. A journal of finished files makes a rerun skip them. Then one last pass over every part, for what changed and for every SQLite file: a write to a `-wal` moves neither the main file's size nor its mtime and the manifest doesn't list the `-wal`, so a database is read again whatever the manifest says. A read that fails leaves that file unverified, so step 4 refuses. The Browser is held on the cloud desk for its part of the pass, renewed while it runs, and kept held after it (section 5); its part is done only once a whole pass over it ran under one hold, and a hold that can't be had stops the move. The other parts aren't held, and the cloud desk keeps running, so what's written after a file's last read stays on the cloud desk.
4. **Checks:** every file's SHA-256; the cloud desk's Chromium version against this desk's (the profile's `Last Version`: an older Chromium here would raze the cookies, ADR 0035, so it refuses before changing anything); this desk's `desk-browser` uses `--password-store=basic`, as cloud desks do (no keyring, a fixed key, so cookies decrypt on any desk with the same setting; with a keyring they wouldn't, and it refuses).
5. **Swaps** with this desk's services stopped (`systemctl stop deskd desk-browser desk-stream`, then `start deskd` afterwards, which starts the rest on demand): each part's current directory goes to `/data/.ma-move/<moveId>/before/<part>/` (kept, never deleted by the script), the staged one takes its place, owned by its part's fixed uid (`browser` 1102, `desk` 1100, `agent` 1103, apps by `registry.json`), and this desk's own machine files (section 4) stay as they were. `/data/rtc`, `/data/selfhost` and `/data/.ma-volume` are never read, moved or written. `browser-readable` isn't copied: it's only for people. Then it starts this desk's services again.
6. **Proves it:** starts this desk's Chromium and compares `data.browser.cookies` from both desks. "312 of 312 sign-in cookies readable here" or the list of what isn't.
7. **Reports:** a summary on screen and in `/data/.ma-move/<moveId>/report.json`, and counts only (parts, files, bytes, checks passed) to the platform, which shows "Moved" in the office. No file names leave the two desks.

**The cloud desk's files stay exactly as they were** until the member chooses to remove it, and its Browser stays stopped from the last pass on, until the member starts it there again (section 5). **A dropped connection resumes:** the script reconnects with a fresh token, finishes the file it was on from its offset, and carries on from the journal. A rerun of `sudo ma-move` finds the state file and resumes the same move.

### 10. Safe on `main`
deskd's `data.*` methods answer `unavailable` on a desk without the helper, and only the desk's owner or an `export` token can call them. The Desk app shows the export and the move only when client-config says `export.enabled` (platform draft, section 7), which is off in prod by default.

## What this asks of others
- **System Engineer:** ~~adopt `tools/desk-data/` into `image/recipe`, add `/run/desk/data.sock` to `desk-runtime.md` §2 and §8~~ (done for image 0.2.6, task 37; `desk-runtime.md` §1, §2 and §8.7), and `/run/desk/free-bytes` to `desk-egress` (section 8).
- **Task 31 (self-hosted desk):** the same uids (1100 to 1104), `--password-store=basic`, the helper installed, and `ma-move` beside the installer.
- **Desk Engineer:** review `data/` in deskd, `API.md` §12.
- **Task 27:** the cancelled card's "Ask for an export" points at the office's export page once this ships.

## Alternatives not taken
- **An archive built on the desk and uploaded encrypted to S3.** Works when the member's browser can't stay open, but puts member content in our storage, needs a key the member keeps, and costs S3. The direct stream needs neither.
- **A tar or a compressed archive.** Windows opens a ZIP without anything extra. Compression would stop a mid-file resume and saves little on photos and video, which is what's big.
- **Widening deskd's container** to `/data` with extra groups. Chromium's `0600` files would still need root, and deskd would then hold read access to everything at all times, not only while a member asks.
- **Copying the volume or a snapshot.** EBS snapshots stay in EC2, and a copy made by us is exactly what the privacy rule forbids.
- **The member's browser moving the desk,** with both desks open in the office. It works without a script, but pushes everything through the member's own connection twice and fails if the laptop sleeps.

## Consequences
- A member can take everything, any time they're a member and for 30 days after, without asking anyone.
- The cloud desk is never changed by an export or a move.
- A desk without the helper can't export: the image needs it before launch.
- Large exports are bounded by `bulk`'s speed, about 8.8 Mbit/s at 50 ms: 32 GB is about 8 hours. Scaling `bulk` with RTT (`desk-runtime.md` §4.5) shortens that.

## Appendix: `data.sock`, between deskd and `desk-data`
One request per connection, then the helper closes it. deskd opens one connection per call, and one per `data.read` for as long as that transfer lasts. With 12 transfers at most across the desk, `desk-data.socket` allows `MaxConnections=24`.

**Request:** one line of UTF-8 JSON, at most 16,384 bytes including the `\n`, with `"v": 1`:
```
{"v":1,"op":"parts"}
{"v":1,"op":"manifest","part":"browser","cursor":null,"limit":2000}
{"v":1,"op":"read","part":"browser","path":"profile/Default/Cookies","offset":0}
```

**Reply header:** one line of JSON ending `\n`. `{"ok":false,"code":"…","message":"…"}` on any refusal, with `code` one of `denied` (not uid 1100), `bad_request`, `not_found`, `invalid` (a path that escapes, or isn't a regular file for `read`), `failed`. Otherwise `{"ok":true,…}`:
- `parts`: `{"ok":true,"helperVersion":"…","parts":[{"part","label","files","bytes"}]}`. `browser-readable` is listed when `browser/profile` exists: it's made by the helper, not stored (decision 2).
- `manifest`: `{"ok":true,"entries":[…],"next":…}`, entries as in `data.manifest`. Entries are in a stable order (a depth-first walk, names sorted by their bytes), and `cursor` is the last path of the previous page, so a page never repeats or skips while nothing changes.
- `read`: `{"ok":true,"size":N,"mtimeMs":M}`, where `N` is what will be sent counting from byte 0 (for SQLite, the backup's size; for `browser-readable`, the generated file's). Then the body: chunks of `u32be length` and that many bytes, from `offset`, each at most 65,536 bytes; then a `u32be 0`; then the trailer, 32 bytes of SHA-256 of bytes 0 to the end, then `u64be` of how many bytes that was. The body never runs past `N`. A file whose device, inode, size, mtime or ctime moved between the first byte read and the last, one that shrank or grew included, gets no `u32be 0` and no trailer: the body stops short and the connection closes, the failed-read ending. deskd turns the chunks into CHUNK frames, the trailer into the END frame unchanged, and a body that stops short into an END with an empty payload. A request that's sent nothing for 30 s is dropped; a body nobody reads for 330 s is, which is past deskd's 5 minutes without credit.

**Readable files** (`browser-readable`): for each profile directory with them, `<profile>/bookmarks.html` (the Netscape bookmark file every browser imports) from `Bookmarks`, and `<profile>/history.csv` (`visited_at` UTC ISO 8601, `title`, `url`, one row per visit, newest first) from a backup of `History`.
