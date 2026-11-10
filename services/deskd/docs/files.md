# deskd: the `files.*` wire contract (Files app)

**Status:** Built in deskd on `sub/files-app-deskd`, 2026-11-08, from `docs/decisions/0048-files-app.md` (read its decisions first). Normative for the web builder and for deskd. `API.md` section 16 is the short table (who may call what, the configuration); this file stays the exact wire. Where the build had to choose, section 10 says what it chose. Conventions are `API.md` sections 3 and 4 (frames, `idem`, `deadlineMs`, CANCEL) and the export draft's section 7 (`data.read`), which this reuses.

## 0. Scope, tree, names
- **Scope:** `owner` sessions only. An `export` session, a `guild_member` one, or a desk of kind `guild` gets `forbidden` with `{reason: "scope"}`. (An old deskd answers `not_found`: the client treats that as "this desk can't do Files yet".)
- **The tree:** `/data/files`, uid 1100, `0700`. deskd creates it when missing (the image creates it first, see the ADR). Every path in this contract is relative to it.
- **Path:** a string of `/`-separated components, NFC, UTF-8, at most 1024 bytes, no leading or trailing `/`. The root is `""` (only where a method says so). A component is 1 to 255 bytes, not `.` or `..`, with no `\`, no control character (U+0000 to U+001F, U+007F, U+0080 to U+009F), no bidi override (U+202A to U+202E, U+2066 to U+2069). Anything else is `invalid` with `{reason}` one of `empty`, `length`, `chars`, `nfc`, `dots`, `reserved`. deskd never rewrites a name: a non-NFC one is refused (the web normalizes before it sends).
- **Reserved:** at the root, `.uploads` and `.trash` can't be created, renamed to, listed, searched or named (`invalid`, `reserved`). Any other dot name is an ordinary name.
- **What exists:** regular files and directories only. A symlink, a device, FIFO or socket, a file with `nlink` over 1, and a name that isn't valid UTF-8 or isn't NFC are skipped everywhere: never listed or searched, `not_found` if named, counted in `list`'s `skipped`. Names are case-sensitive.
- **Mutations** (`mkdir`, `rename`, `delete`, `trash.*`, `upload.*`) need `idem`. All namespace changes run under one lock, so two sessions can't interleave.

## 1. Errors
`API.md` section 4 codes, plus five this feature adds to the closed list: `exists`, `no_space`, `check_required`, `check_invalid`, `hash_mismatch`. Details are always an object; `reason` is a short code, never a path or a name.

| Code | When | `details` |
|---|---|---|
| `forbidden` | scope or desk kind | `{reason: "scope"}` |
| `invalid` | a path rule (section 0), a bad `cursor`, `permanent` outside the trash, moving a folder into itself | `{reason}`, plus `into_self`, `not_a_folder`, `is_a_folder`, `permanent`, `cursor` |
| `not_found` | no such file, folder, upload, trash item | `{}` |
| `exists` | the target is taken and `replace` isn't true, or a folder is in the way of a file | `{kind: "file"|"dir"}`; `restore` adds `{suggest}`, a free name |
| `no_space` | an upload or restore would take free space under the floor | `{freeBytes, floorBytes, needBytes}` |
| `too_many` | transfers past 8 in the session or 12 on the desk (shared with `data.read`) | `{limit, reason: "session"|"desk"}` |
| `too_large` | a RES over 1 MiB that can't shrink (never for list, it pages) | |
| `conflict` | `upload.finish` before all bytes arrived `{reason: "incomplete", committed}`; an upload driven by another session `{reason: "attached"}` | |
| `check_required` | an image reached `finish` with no token | `{format}` |
| `check_invalid` | the token fails | `{reason}`: `signature`, `expired`, `desk`, `member`, `hash`, `size`, `state`, `feature`, `kind` |
| `hash_mismatch` | the SHA-256 at `finish` isn't what the desk holds; the partial is deleted | `{committed: 0}` |
| `unavailable` | the tree can't be used (`{reason: "tree"}`: wrong mode or owner, or no safe-open support on this filesystem); `files.read` while the member is paused at the bandwidth limit `{reason: "bandwidth_limit", resumesAt}` (as `data.read`); the session ended | |
| `rate_limited`, `deadline_exceeded`, `cancelled`, `internal`, `bad_request` | as `API.md` | `bad_request` has `{reason: "<param>"}` |

## 2. Entries and reads of the tree
**Entry:** `{name, type: "file"|"dir", size, mtimeMs}`. `size` is bytes for a file and `null` for a folder (folders are never summed on a list). `mtimeMs` is a whole number of milliseconds since 1970.

**`files.list {path, cursor?, limit?}`** → `{entries, next, skipped}`. `path` is `""` for the root. Sorted: folders first, then files; within each, by name case-folded (Unicode simple case folding of the NFC name), then by the name's UTF-8 bytes. `limit` 1 to 2000, default 2000; deskd may return fewer; follow `next` (opaque, `null` on the last page). A cursor is stable while nothing changes and never repeats or skips an entry that didn't change. Not a folder: `invalid`, `not_a_folder`. Errors: `not_found`, `invalid`.

**`files.stat {path}`** → `{entry, sniff}`. `sniff` is `{kind: "image", format}` with `format` one of `jpeg png gif webp heic heif avif bmp tiff svg`, or `{kind: "other"}`, from the file's first 4 KiB by magic bytes (SVG: the root element, XML prolog and comments skipped), never from the name. A folder has `sniff: null`. `path` `""` stats the root: `{entry: {name: "", type: "dir", size: null, mtimeMs}, sniff: null}`.

**`files.search {q, under?, limit?}`** → `{entries, truncated}`. `q` 1 to 255 bytes, NFC, matched as a case-folded substring of the name. `under` is a folder path, default `""`. Each hit is an entry plus `path` (full, relative to the root). `limit` 1 to 200, default 100. Order: folders first, then shallower first, then by path as in `list`. Bounded at 200,000 entries visited or 3 s: `truncated: true` then. Never enters `.uploads` or `.trash`. A new search from a session cancels its running one. Not a mutation.

**`files.usage {}`** → `{drive: {totalBytes, usedBytes, freeBytes}, files: {bytes, approx}, trash: {bytes, items}, floorBytes, uploadableBytes, computedAt}`. `drive` is `statvfs` of `/data` (usable blocks, as `FileStore.getUsableSpace`): everything from every app. `files.bytes` is the tree without `.uploads`, `.trash` and the trash's contents; `trash.bytes` the trash; partials are in `drive.usedBytes` only. `approx: true` when the walk was cached (at most 60 s old, kept up to date by deskd's own changes) or capped at 1,000,000 entries. `floorBytes` is `2147483648`. `uploadableBytes = max(0, freeBytes - floorBytes - bytes still owed to running uploads)`.

## 3. Changes
**`files.mkdir {path, parents?}`** → `{created}`. `parents: true` makes missing folders on the way and is fine with the folder already existing (`created: false`). Without it, the parent must exist and the path must be free (`exists`). A file on the way: `invalid`, `not_a_folder`.

**`files.rename {from, to, replace?}`** → `{path, replaced}`. Renames and moves in one: `to` is the full new path. The parent of `to` must exist. Same filesystem, so it's one atomic rename and takes no space. `to` taken: `exists` unless `replace: true`, and `replace` replaces a file with a file only (a folder is never replaced: `exists`, and a file onto a folder is `exists`). The replaced file goes to the trash (`replaced: <trashId>`), never straight away. A folder into itself or its own subtree: `invalid`, `into_self`. `from` equal to `to`: `{path, replaced: null}` and nothing happens.

**`files.delete {paths, permanent?}`** → `{results: [{path, ok, trashId?, code?}]}`. `paths` 1 to 200. Without `permanent`, each path moves into the trash (a rename, so a huge folder is instant) as `.trash/<trashId>/`; `trashId` is 26 characters of `[0-9A-Za-z]`, time-ordered. Each path succeeds or fails alone, in order. `permanent: true` is only for `trash:<trashId>` pseudo-paths, which delete that item for good; any real path with `permanent`, or a `trash:` path without it, is `invalid` (`permanent`). Deleting the root is `invalid` (`empty`).

**Trash.** Items stay 30 days from deletion, then deskd removes them (a sweep at start and hourly). They count toward the drive's used space. Nothing else ever empties it.
- **`files.trash.list {cursor?, limit?}`** → `{items: [{id, name, originalPath, type, bytes, deletedAt, purgeAt}], next}`. Newest first. `bytes` is `null` when the item had over 1,000,000 entries. `limit` 1 to 500, default 500.
- **`files.trash.restore {id, to?}`** → `{path}`. To `originalPath`, or `to`. Missing folders on the way are made. Taken: `exists` with `{suggest}`. Needs room (`no_space`) only if it can't be a rename, which it always can.
- **`files.trash.empty {}`** → `{deleted, freedBytes}`. For good, everything. The client asks the member first. Allow a long `deadlineMs`; once started it finishes.

## 4. Download: `files.read`
**`files.read {path, offset?}`** → `{transferId, size, mtimeMs}`, then CHUNK frames on `bulk` exactly as `data.read` (export draft section 7): CHUNK kind 15, `id` = `transferId`, `seq` from 0, up to 16,372 bytes each, the first window 1 MiB, CREDIT from the client in steps of at least 256 KiB, the last CHUNK flagged END with a 40-byte payload (32 bytes SHA-256 of the whole file from byte 0, `u64be` size), an empty END meaning it failed, 5 minutes without credit ends it. deskd opens the file once (no-follow) and reads that handle, so a rename or delete during the read doesn't change what is sent. **`files.read.stop {transferId}`** ends one early; a session's end ends its transfers. `transferId` is per session, from 1, never reused. One table with `data.read`: 8 per session, 12 per desk, `too_many`. Owner sessions' bytes are metered like any the desk sends (they are not `freeBytesSent`).

## 5. Upload
Client to desk on `bulk` (channel 5), the new direction. No new frame kind and no change to `desk-rtc` or the gateway (ADR, section 6).

### 5.1 Calls
**`files.upload.begin {path, size, replace?, sha256?, token?, mtimeMs?}`** → `{uploadId, transferId, offset: 0, window, size, expiresAt}`.
- `size` 0 to 2^53-1. `sha256` (64 hex) is optional here: pass it when known (an image always), and deskd refuses early (`check_*`) if `token` is given and doesn't fit. `mtimeMs` is the local file's modified time, used when the file lands, clamped to between 1970 and one day from now.
- Refuses at once: `invalid` (path), `exists` (the destination is a folder, or a file and `replace` isn't true), `no_space` (size over `uploadableBytes`), `too_many`. Missing parent folders are not an error: they are made at `finish`.
- Creates `.uploads/<uploadId>.part` and `.uploads/<uploadId>.json`, and takes the credit. `uploadId` is 26 characters of `[0-9A-Za-z]` and is the only handle that survives a lost session. `window` is `1048576`, the first credit. `expiresAt` is 24 h after the last progress.
- Quota: `no_space` is raised when `size > freeBytes - floorBytes - sum(size - committed of every running upload)`. Checked again as bytes arrive (section 5.4).

**`files.upload.status {uploadId}`** → `{uploadId, path, size, committed, transferId, window, expiresAt}`. Picks an upload up, in this or a later session or after a deskd restart. deskd truncates the partial to the last durable offset (5.4), hashes what is left so the final digest covers the file as it is on disk, makes a new `transferId` for this session and grants a new first window. The client sends from `committed`. Another session still attached is detached: its transfer gets the terminal CREDIT `error: "superseded"`. `not_found` when it never was, finished, aborted or expired.

**`files.upload.finish {uploadId, sha256, size, token?}`** → `{path, size, mtimeMs, sha256, replaced}`. In this order:
1. Waits until `committed == size` (frames on `bulk` and this call on `rpc` aren't ordered), for up to 30 s since the last byte; else `conflict`, `incomplete`, `{committed}`.
2. Compares `sha256` with the digest of what is on disk: `hash_mismatch` and the partial is deleted.
3. **The image gate** (section 6): sniffs the first 4 KiB. An image format needs a valid `token` for exactly this `sha256` and `size`.
4. Checks `exists` again, and room again.
5. `fsync` the file, makes missing parent folders, renames the partial into place (replacing a file goes via the trash, as `rename`), `fsync`s the parent, sets the mtime, removes the sidecar.
Nothing before step 5 shows in the tree: **no half file is ever visible.** A retry with the same `idem` gets the same reply; a retry after the reply was lost, with a new key, finds no upload and gets `not_found` — the client then `stat`s the path and compares the size and its own hash.

**`files.upload.abort {uploadId}`** → `{}`. Deletes the partial. Idempotent (a missing id is `{}`). Ends its transfer.

Uploads with no progress for 24 h are removed by the sweep (start and hourly), with their sidecar.

### 5.2 Frames
- **Client to desk, data:** CHUNK, kind 15, flags `BIN` (2), `id` = `transferId`, `seq` = 0 for the first frame of this attachment (`begin` or `status`), +1 for each next, payload up to 16,372 bytes of the file in order. The offset of a frame is `startOffset` plus the lengths of every earlier payload of this attachment, where `startOffset` is `0` after `begin` and `committed` after `status`. No END flag, no trailer: `finish` says the hash. Empty payloads are not sent. A zero-byte file sends no frame.
- **Desk to client, progress and credit:** CREDIT, kind 16, JSON on `bulk`, `id` = `transferId`: `{"bytes": n, "committed": c}`. `bytes` is more credit (file bytes the client may now send; it can be 0 for a pure acknowledgement); `committed` is the offset written to the partial. Sent when at least 256 KiB more has been written, and at least once a second while bytes arrive. Credit never goes past `size`.
- **Desk to client, terminal:** `{"bytes": 0, "committed": c, "error": "<code>"}` where `<code>` is `no_space`, `credit_violation`, `seq`, `superseded`, `aborted`, `io` or `expired`. The transfer is over and the session stays up. The partial is kept for every code except `aborted`, so the client can `status` and carry on.
- **Rules for the client:** never send past the credit it has; stop and wait when it is out; respect `RTCDataChannel.bufferedAmount` (pause above 1 MiB, resume at 256 KiB). A frame past the credit, a `seq` that isn't the next, or a frame for an id deskd doesn't know is dropped, and past credit or out of sequence ends that transfer with the terminal CREDIT (never a session close). Frames for an unknown id are ignored silently.
- **Rules for deskd:** the `bulk` handler only queues a chunk to the transfer's writer (bounded by the window, 1 MiB) and returns, **never touching the disk**, because the handler's return is what gives `desk-rtc` its credit back and a slow disk must not hold up the same session's downloads and CREDITs on the same channel. One writer thread per running upload. At most 8 transfers per session, 12 per desk, counting `data.read` and `files.read`.

### 5.3 Resume
After a lost session or tab: the client keeps `{uploadId, path, size, a handle to the local file}` (browser storage; the file handle needs the File System Access API or the member picking it again). It calls `files.upload.status`, reads `committed`, hashes the local file's first `committed` bytes (local only, no network), and sends from there. Its running SHA-256 then covers the whole file for `finish`.

### 5.4 Durability and quota while bytes arrive
- Every 64 MiB written, and at `finish`, the writer `fsync`s and rewrites the sidecar atomically with `durable` (the fsynced length) and `lastProgressAt`. `status` truncates to `durable`. So a power loss costs at most 64 MiB of resend, and the digest can't cover a torn tail.
- Every 8 MiB or 5 s the writer reads free space; if `freeBytes - floorBytes` is under what is still to come for this upload, it ends the transfer with `no_space` and keeps the partial. Chromium or an app growing meanwhile can cause it.

## 6. The image gate
- **What is an image:** `sniff` says so (list in `files.stat`), whatever the name. Checked on the completed partial at `finish`, never on a prefix alone.
- **Token:** a JWS (compact), ES256 only, from the platform. Header `typ: "ma-image-verdict+jwt"`, `kid` in the JWKS deskd caches for desk tokens (`auth/JwksCache`). Claims, all required: `iss` (the issuer deskd's desk tokens use), `aud` = this desk's id, `sub` = the session's member, `iat`, `exp` (at most 30 min after `iat`), `jti`, `ma_feature: "files"`, `ma_img` (the image-check id), `ma_sha256` (lowercase hex of the exact bytes to be written), `ma_bytes`, `ma_state: "ok"|"unchecked"`. There is no `scope` claim, so `DeskTokenVerifier` can never take one for a desk token.
- **deskd checks** in this order and answers `check_invalid` with the first reason that fails: `signature` (algorithm, `typ`, `kid`, ES256), `desk` (`aud`, `iss`), `member` (`sub`), `expired`, `feature`, `state`, `size` (`ma_bytes` equals `size`), `hash` (`ma_sha256` equals the digest deskd computed itself). No token: `check_required`. The token is checked at `finish`, not trusted at `begin`. A token may be used again for the same bytes (a retry); it proves nothing for other bytes.
- **Not images:** every other file needs no token, including images inside archives or documents, which are not checked.
- **Test stand-in:** with the environment variable `DESKD_FILES_IMAGE_GATE=stub` (no release image sets it; only the test rig and a test desk's own env file do) deskd accepts the string `stub.<sha256>` as a valid token. Everything else behaves as above.

## 7. Topic `files.changes`
SUB (owner only), a `snapshot` of `{}` first, then EVT `{dirs: [path], usage: bool, trash: bool}`: the folders whose listing changed (at most 50; over that, `dirs` is `null` and the client refreshes what it shows), after any change by any session, at most twice a second (merged). No replay: on a new session the client refreshes what it shows. Changes from the desk's own sweep (trash purge, partial removal) use it too.

## 8. Limits
200 requests a second and 32 running per session (API.md section 4). `list` and `search` are cheap but `usage` may walk: at most one walk at a time, and the cached answer for 60 s. A path or name over the limits is `invalid`, never truncated. `files.delete` and `files.trash.empty` of very large trees run to the end once started, as any mutation.

## 9. Golden examples
```
REQ {"m":"files.upload.begin","p":{"path":"Photos/2026/a.jpg","size":482113,"mtimeMs":1762560000000},"idem":"…"}
RES {"uploadId":"01JC8XK3M6N1Q9T2VWB5Z7RHDA","transferId":3,"offset":0,"window":1048576,"size":482113,"expiresAt":"2026-11-09T18:00:00Z"}
bulk  client→desk  CHUNK id=3 seq=0 flags=BIN  <16372 bytes>
bulk  desk→client  CREDIT id=3  {"bytes":262144,"committed":262144}
REQ {"m":"files.upload.finish","p":{"uploadId":"01JC8XK3M6N1Q9T2VWB5Z7RHDA","sha256":"<64 hex>","size":482113,"token":"<jws>"},"idem":"…"}
RES {"path":"Photos/2026/a.jpg","size":482113,"mtimeMs":1762560000000,"sha256":"<64 hex>","replaced":null}
ERR {"code":"check_required","message":"…","details":{"format":"jpeg"}}
ERR {"code":"no_space","message":"…","details":{"freeBytes":2500000000,"floorBytes":2147483648,"needBytes":482113000}}
```
`services/deskd/docs/files-vectors.json` (the deskd builder's first commit) holds these as byte-exact frames for the web builder's mock to test against.

## 10. Choices the build made (deskd, 2026-11-08)
The contract was silent or ambiguous in these places; deskd does the following, and the web builder can rely on it.
- **Times.** A field named `...At` (`expiresAt`, `deletedAt`, `purgeAt`, `computedAt`) is an ISO-8601 UTC string; a field named `...Ms` is a whole number of milliseconds since 1970.
- **Credit never passes the size.** The last CREDIT of a small upload can be `{"bytes": 0, "committed": n}`, a pure acknowledgement.
- **A token on a file that sniffs as not an image** is `check_invalid` with `{reason: "kind"}` (a token proves nothing for other kinds). An image with no token is `check_required`. A token given at `begin` is checked at once against what is known then (its own claims, and the `sha256` and `size` if given).
- **`unavailable` `{reason: "keys"}`** when the verdict keys can't be loaded yet; the client retries `finish`, which keeps the partial.
- **`files.delete`** checks the whole request first: with `permanent`, every entry must be `trash:<id>`; without it, none may be. A mix, or an empty path, is `invalid` for the request. Then each path succeeds or fails alone.
- **Trash.** `.trash/<trashId>/item` holds the deleted entry and `meta.json` where it came from. `bytes` and `usage.trash.bytes` count the items, not the records. `trash.restore`'s `suggest` is `name (restored).ext`, then `name (restored 2).ext`.
- **Names.** A name holding U+FFFD is refused (`chars`) and skipped in listings: it is how a name that is not valid UTF-8 shows once decoded. Sorting folds case by upper-casing then lower-casing the NFC name (Java has no simple case folding), then compares the UTF-8 bytes.
- **Cursors** are opaque; a bad one is `invalid` `{reason: "cursor"}`. A `list` page may be smaller than `limit` (a hard-linked file found while paging is skipped), and is halved until its RES fits 1 MiB.
- **A search** that finds more than `limit` is not `truncated`; `truncated` means the 200,000-entry or 3-second bound.
- **`upload.finish` and room.** The partial's bytes are already on the drive, so `finish` checks the name again but not the floor; the floor is checked at `begin` and as bytes arrive.
- **`upload.status`** of an upload this deskd process was running uses the length it had written; after a restart it truncates to the sidecar's durable length. Either way the digest is recomputed from the file's start.
- **Unusable tree.** Checked once when deskd starts. If it fails, every `files.*` is `unavailable` `{reason: "tree"}` until deskd restarts.
