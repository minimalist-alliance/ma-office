# desk-notebook

The sync and storage service behind the Notebook app on a desk. Hocuspocus 4 on Node 24, in TypeScript, bundled into one file, in its own container with no network. It's the only thing that touches `/data/notebook`, and `deskd` is the only thing that talks to it. Decision: [ADR 0044](../../docs/decisions/0044-notebook-service-hocuspocus-on-node.md). Why Hocuspocus on Node: `spikes/notebook-sync/README.md`.

| Where | What |
|---|---|
| `src/` | The service. `main.ts` starts it, `service.ts` is the order of things, `pages.ts` is page text and the durability rule, `notebook.ts` the tree, `rpc.ts` the method table, `socket.ts` the socket and the collab adapter, `collab.ts` Hocuspocus's hooks, `search.ts` FTS5, `readable.ts` the Markdown copy, `db.ts` the schema. On a guild's desk: `caller.ts` is who's on a connection, `owners.ts` who wrote what inside a page and the delete rule, `members.ts` names |
| `../../web/notebook/src/model/` | Imported as source and bundled: `derive`, `history`, `search`, `tree`, `export`, `schema`. The desk and the client can't disagree about a title or a day |
| `scripts/bundle.mjs` | esbuild into `dist/desk-notebook.mjs`. It fails if the bundle holds two copies of yjs |
| `docker/` | `run`, `health` and `desk-notebook.env`, what a release carries (`desk-runtime.md` section 6) |
| `tests/` | Vitest. Real SQLite on temp directories, and real `@hocuspocus/provider` clients over the real socket. `tests/helpers/provider-bridge.mjs` runs real providers for `deskd`'s `RealDeskNotebookCollabIT`, through the real relay (`services/CLAUDE.md`, Commands) |

## Run and test

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH    # Node 24; the system Node is too old
cd services/notebook && npm ci --ignore-scripts
npm run typecheck
npm test                                       # builds the bundle, then all of it; on a shared box, wrap it in flock
npm run measure                                # the numbers below, printed as one MEASURE line
npm run memory                                 # the same under a real 320 MiB cap; needs a user systemd bus
DESK_NOTEBOOK_DATA_DIR=/tmp/nb DESK_NOTEBOOK_SOCKET=/tmp/nb.sock node --max-old-space-size=192 dist/desk-notebook.mjs
```

Other tests: `python3 -I tools/desk-data/tests/test_desk_data.py`, `go test ./internal/move/` in `tools/desk-move`, `services/scripts/test-release-scripts.sh`.

## Release

`services/scripts/build-on-box.sh <sha> notebook` builds on the arm64 box and downloads `desk-notebook-<version>.tgz`. `<service>` is `notebook` (the directory) and the component is `desk-notebook`, which `build-image.sh`, `package-release.sh` and `build-on-box.sh` map between. Its Docker context is `services/notebook/` and `web/notebook/src/model/`, sent as a tar. The image is `node:24-bookworm-slim` by digest and the bundle, nothing else. It also builds on amd64, for self-hosted desks.

The image side (user `notebook` 1105, `/data/notebook`, `/run/desk-notebook`, the unit, `verify.sh` section 3n) is `sub/notebook-image`, on `main`.

## Storage

`/data/notebook/notebook.db`, SQLite through `node:sqlite`, with no native addon. **FTS5 is in Node 24's build** (`ENABLE_FTS5`, SQLite 3.53.4), and the Dockerfile checks that again in the image, along with zstd and the time zones. WAL, `synchronous=FULL`, migrations by `PRAGMA user_version` that go forward and refuse a newer schema without touching it.

Design 5.4's tables without attachments, plus:
- `page_updates`: client updates not yet in `pages.ydoc`.
- `pages.snippet`, `pages.has_checklist`: what `PageRec` needs without reading the text.
- `settings`: `rev`, `readable_rev`, `time_zone`.
- `pages_fts` has `title` and `body`, without `attachment_names`. A later migration can rebuild it from `pages`.

**Added without a schema bump,** created if missing at every start, because a build without them ignores them and a rollback still opens the file (Personal and Work desks get them empty):
- `page_clients (page_id, client, member_id)`: which member each Yjs client id on a page is. A guild's desk only.
- `page_credits (page_id, client, clock, len, member_id)`: moved text, credited to whoever wrote it.
- `members (member_id, name, updated_at)`: the last `name` deskd sent for each member, for showing who.
- `page_updates.actors`: who made a log row's edits, as JSON. A row without it is the owner's, as every row was.

`/data/notebook/readable/<notebook>/<tab>/<title>.md` is plain Markdown of every live page, from `model/export.ts`, so a member's export reads without SQLite. Written about every 30 s while things change, and at SIGTERM, each file through a temporary name and a rename. Rebuilt in the background at start if it's behind or missing. Names are sanitised for any disk (no path characters, leading dots or Windows' reserved names), and a collision, ignoring case, gets the page id: `Plan (<id>).md`. The oldest page keeps the plain name. Trashed and purged pages leave it. A failure logs one line and never affects notes.

## The durability rule

**Nothing is lost across a restart.**
1. `onChange` puts each update on a queue, and within about 150 ms the queue is committed to `page_updates`, one merged row per page. So SIGKILL or a power cut costs at most that much. An open tab gives even that back when it reconnects.
2. `onLoadDocument` applies `ydoc`, then `page_updates`.
3. `onStoreDocument` (2 s debounce, 10 s maximum) writes `ydoc`, `pm_json`, `plain_text`, FTS, `page_activity` and any version in one transaction, and clears the log. If it fails, nothing changes: the queue, the edits and the log are all still there.
4. SIGTERM stores every open page, as a session that ended, writes `readable/`, checkpoints the WAL and exits. Docker gives it 30 s, and it gives up at 25.
5. A start first folds in any page's log rows, so search and `readable/` catch up without anyone opening the page, and keeps them as a `session` version.

A stored `ydoc` that Yjs can't read is refused (`reason: unavailable` on the provider), never served as an empty page that the next store would write over it. A log row that can't be applied is skipped with one log line. If derived text can't be made, as after damage Yjs absorbed, the `ydoc` is still written and the last text is kept.

What the client sees: `SyncStatus`, and so the provider's `hasUnsyncedChanges`, means applied in memory, not yet on disk. That window is the 150 ms above.

## The socket

`/run/desk-notebook/notebook.sock`, `0660`, in a `2750 notebook:desk` directory. One connection per `deskd` session. `u32be` length of what follows, `u8` type, body, at most 4 MiB + 64 KiB. Type `0x01` is JSON with a `t`, and `0x02` is one collab message. The first frame is `{"t":"hello","sessionId","sub","caller"}`. Then `req`, `cancel`, `sub`, `unsub`, `caller` one way and `res`, `err`, `evt` the other. Until `services/deskd/docs/API.md` takes over, the contract is the working copy.

**The caller** is deskd's verified caller (`docs/sub-status/deskd-guild-sessions.md`, "The verified caller"): `kind`, `memberId`, `role`, `grants`, `name`, `badge`, `teen`. Nothing a client sends sets it.
- **A hello without `caller`** (an older deskd) is the owner, exactly as before. So is `kind: "owner"`.
- **`{"t":"caller","caller":{…}}`** after the hello applies to every frame after it on that connection and to none before: a request takes the caller as of its own frame, and each collab message is stamped with the caller as it arrived, though Hocuspocus handles it some ticks later. A frame that changes `kind` or `memberId`, a `caller` frame with none, and a hello whose caller isn't one, drop the connection.
- **Only `memberId` and `name` are kept,** in `actor` columns and `members`. Never the token, the session, the role or the grants. Logs hold neither.

Beyond the contract:
- **`{"t":"health"}`** gets `{"t":"health","ok":true,"version","schema","pages","open","sessions"}`, with or without a hello. It's for `docker/health`, and `deskd` never relays it.
- **No pings on the wire.** `deskd` closes the connection when a session ends, so that's the liveness, and nothing here idles out. Hocuspocus's `handleConnection` needs neither ping nor pong. A provider with a page open hears its own awareness echoed every 15 s. One with no page open, or with `awareness: null`, hears nothing and closes its socket after 30 s, which on this virtual socket is only its adapter reopening. A client that minds can raise `messageReconnectTimeout`.
- **`cancel`** of a request still running means no reply comes from here. A mutation that has started finishes.
- **Anything malformed** (a bad length, type or JSON, or no hello in 10 s) drops that connection and nothing else. So does a peer that stops reading, at 32 MiB behind.
- **A page closed and opened again on one connection** (`socket.ts`, `sub/notebook-reset-fix`). Hocuspocus 4.8 picks a message's page as it arrives, but closes a page a few ticks later, as it works through that page's queue. So a provider's CLOSE and the next provider's Auth for the same page, read together, both reached the page that was closing: the Auth was taken there as a token refresh and dropped, and the page never synced again on that connection, until `deskd` restarted. The adapter now:
  - **holds what comes for a page while it closes,** and hands it to Hocuspocus once Hocuspocus's own CLOSE for that page goes by, in order. Over 5 MiB held drops the connection, and `deskd`'s `reset` brings the client back.
  - **swallows what Hocuspocus sends for a page while it closes,** its CLOSE included: it all answers the provider that has gone, and a new provider on the page would take it as its own. A stray `provider_initiated` close was how the release check saw this.
  - **drops a CLOSE for a page Hocuspocus has no connection for here,** as its own replies say (Authenticated opens one, CLOSE or a refusal ends it). Hocuspocus would keep such a CLOSE for the next provider's Auth and close that page with it: a CLOSE from a virtual socket `deskd` has since reset, say.

  A provider that starts over on a page it still has open, with no CLOSE first, as after its own socket timeout, was and is fine: Hocuspocus answers its state vector on the page it has.

## RPC

The contract's table, with `LocalBackend`'s rules. `rowVersion` is on the records for information, and last writer wins. Where the table leaves it open:
- **`notebook.tree`:** a reply holds notebooks, then tabs, then up to 1,000 pages, and stops early at 900 KiB. So union the arrays across replies and follow `next`. On a normal desk the first reply has all the notebooks and tabs. `next` and `rev` are in every reply.
- **`part` and `next`:** a part is at most 512 KiB of UTF-8, is cut so that quoting it inside a reply stays under 1 MiB, and never splits a surrogate pair. A long read holds one snapshot, so typing between parts can't tear it. A snapshot lasts 60 s, with 4 per session. A cursor that's gone gets `bad_request`, `reason: cursor`: start again.
- **`notebook.page.content`** of an open page is the live document. Of a closed one, it's what the last store wrote.
- **A blank title** on a rename changes nothing and returns `{}`, as in `LocalBackend`. Over 1,024 characters is `bad_request`, `reason: title`.
- **Unknown rows:** `not_found`, except the two results that have a null for it: `notebook.version.save` gives `{version: null}` and `notebook.version.get` gives `{meta: null, part: "", next: null}`.
- **A reply over 1 MiB** is `too_large`. Only `notebook.activity` over a very wide range can get there, at about 7,000 rows.
- **`actor`** is `user` for the owner's sessions, as in `LocalBackend`. A desk has one owner, and this stays true after a move. `sub` isn't stored. On a guild's desk it's the member's `memberId`, and replies carry names (below).
- **A derived title** is cut at 500 characters, so a tree row fits. The text keeps it all.

## A guild's desk

Everything above, with `caller.kind: "guild_member"` on every connection. The owner's rules (`docs/decisions/draft-guild-shared-desk.md` §1 and §5): every member may read and edit every page, and create, rename and move notebooks, tabs and pages. **Deleting another member's content needs `moderate`**, which inside a page is read as **no wiping others' work**: a member without `moderate` may remove up to a budget of what others wrote (below), so typo fixes, cuts and rewrites work. A lead has every grant, and deskd sends effective grants, so the check is `role === 'lead' || grants.includes('moderate')`. Refusals are `forbidden` with `details: {"reason": "grant"}`, which deskd relays unchanged.

**Methods:**
- **`notebook.page.trash`** without `moderate`: only a page the member made (`pages.created_by`), and only if no live text in it is another member's. Otherwise Trash's purge would delete theirs. Restoring from Trash is anyone's.
- **`notebook.version.restore`** is built on a copy, under a Yjs client id of its own, and judged and charged as any update is (below): without `moderate`, a restore that would take the member past the budget is refused. The text it brings back is the restoring member's.
- **`notebook.settings.set`** needs `role: lead` or `manage_spaces`. deskd checks it first; this is the desk's own copy of the rule.
- There's no method that deletes a notebook or a tab, and the 30-day purge is the desk's, not a member's.
- **Who:** `pages.created_by` and `updated_by`, `page_activity.actors` and versions' `actor` are member ids. A version the desk writes by itself (session end, interval, midnight, recovery) is the last editor's; a save or a restore is the caller's. Replies to a guild member add names: `actorName` on `VersionMeta`, `actorNames` beside an `ActivityRow`'s `actors`, and `createdBy` and `createdByName` on each `PageRec` in `notebook.tree`, inside the reply's budget. An owner's replies are exactly as before.

**Inside a page.** What "another member's content" means there: **text** (`ContentString`) that another member wrote, their blocks, and their embeds and leaf blocks (a rule; an image when there are images). Formatting, attributes (a heading's level, a checked box) and empty blocks are edits anyone may make, free. Moving content is free, and moved text stays its writer's.

**The budget** (`owners.ts` and `settings.ts`; 500 per 10 minutes is the default, and a setting deskd sends, below): a member without `moderate` may remove up to `REMOVAL_BUDGET` = **500** of other members' content **per page, per rolling `REMOVAL_WINDOW_MS` = 10 minutes**. An update that would pass it is refused whole. What counts:
- a character of another member's text, removed and not put back: 1;
- a whole block (the top element the update deletes) none of whose other members' text is put back: its text, at least `BLOCK_MIN` = **50**;
- another member's embed or leaf block, removed and not made again in the same update: 50.

It's kept in memory per page and member (`Removals`), across a page closing and opening again; a restart starts everyone afresh. `moderate` and leads have no budget.

**The budget is a setting** (`settings.ts`). deskd sends the one in force on a guild desk, resolved from the guild's own value, the Platform's and the default, in the hello as `settings: {editBudget: {chars, windowMinutes}}` next to `caller`, and in a `{"t":"settings","settings":{"editBudget":{…}}}` frame on each open connection whenever it changes. `chars` is 0 to 100,000 (0: only moderators remove what another member wrote), `windowMinutes` 1 to 1,440, whole numbers; a hello or frame outside that or malformed is ignored and the connection keeps what it has. The latest applies to that connection's checks from the next update (and to its `notebook.version.restore`), and what it has already counted stays in the window, which is read at the length the connection now has. No `settings` in the hello means 500 in 10 minutes, as an owner's desk has. A desk-notebook older than this ignores `settings` in the hello but drops the connection on a `settings` frame, so it ships before the deskd that sends one.
- **Who wrote what.** Each browser tab's `Y.Doc` writes under a random client id. The first update carrying structs under a new client id says whose it is: the member on that connection (`page_clients`, durable before the update is applied). Text another member's update deletes and puts back in the same update is credited to its writer by range of the new structs (`page_credits`).
- **The check** (`owners.ts`, `judge`), before Yjs applies the update, against the page as the desk has it: every live text item the update deletes, directly or by deleting an element above it, split by writer. Each run of another member's text is looked for in what the update puts back; what isn't found is charged.
  - **First look, no copy:** each run, longest first, must be found whole in the update's new text (structs after a gap in their client's clocks don't count: Yjs holds those back), in text nodes inside elements that the update doesn't also delete, not in a map. This covers what the editor does in one go: Enter in the middle of a paragraph (it deletes the tail and writes it again), Backspace joining two blocks, a new block type, wrapping in a list, indenting, a drag that deletes and re-inserts.
  - **Second look, on a copy** of the page with the update applied, when the first doesn't find everything: the editor rewrites blocks in place when it moves them across blocks of the same type, keeping a common start and end and replacing the middle, so moved text can come back as new characters next to ones already there. Each run, in page order, is looked for in a text node the update writes to, in characters no other run used, with at least one new; failing that, each of its pieces. Only the new characters are credited. It stops at 1 s, and what's left counts as removed.
  - Refused for anyone, `moderate` or not: new structs under another member's client id, and deletes of another member's structs the desk hasn't seen yet (Yjs would keep them and apply them when that member's update arrives).
- **A refused update** is refused whole, before anything is applied, by throwing in `beforeSync`: the provider gets a `close` with `event.reason === 'forbidden'`, that page closes on that connection and nothing else does, and what the provider sends for it is dropped until it sends Auth again, as with `page_full`. An update that can't be judged is refused the same way; one Yjs can't read resets the connection, as any damaged update does.
- **What the app has to do on `forbidden`:** as with `page_full`, stop editing that page and say so ("That removes more of other members' writing than you can at once. A moderator can."), then destroy the provider and open the page again on a **fresh `Y.Doc`**. The same `Y.Doc` would send the same deletion again in its next sync and be refused again. Anything typed on that page after the refused change and before the refusal arrived (about a round trip) is lost with the old `Y.Doc`. An offline batch that would pass the budget is refused whole.
- **Measured** (x86_64, Ryzen 9 5950X, idle, `tests/guild.test.ts`): typing and deleting one's own costs one extra parse of each update. On a 60-printed-page page of one member's text, another member moving half of it is judged in about 100 ms (second look), and deleting all of it is costed (and refused) in about 30 ms. A copy costs about 40 ms at 60 pages and 110 ms at 200.

## Search

FTS5 finds and ranks, with `bm25` and the title weighted five times. The rules are `model/search.ts`'s: every word must match, by prefix at a word start, ignoring case and accents, with `has:checklist`. Words are quoted, so nothing a member types is an FTS5 operator. Snippets are FTS5's `snippet()` on the body, and the offsets to highlight come from the model's `fold` and `findMatches`, on prefixes rather than whole words. `has:checklist` alone lists by title.

## Versions, activity, Trash

As `LocalBackend` has them, from `model/history.ts`: at session end (5 minutes idle, or the last connection leaving), every 30 minutes of continuous editing, on the first edit after local midnight (the page as the day left it), on request, and on restore, which first versions what's there. All kept 30 days, then the last of each day. Trash is purged after 30 days, at start and every 6 hours, except a page someone has open. Days use the last zone the client sent, and rows already written keep their day.

## Damaged input

Yjs throws for about a third of damaged updates and absorbs the rest (the spike's `fuzz.mjs`). y-protocols catches that throw, logs it and carries on, and Hocuspocus then tells the client its update was applied. So `beforeSync` applies each update itself first, where the throw can be seen (y-protocols' own apply after it changes nothing, at the cost of parsing the update twice). A throw there, or anywhere else in Hocuspocus's message loop such as a damaged awareness message, closes that document with `Reset Connection`. The adapter sees that close go by and drops the whole connection instead: `deskd` then sends its `reset`, and the provider resyncs every page from the top. Nothing else notices. Damage that Yjs absorbs can't be told from an edit. `unhandledRejection` and `uncaughtException` log one line and carry on, since what's committed is safe either way, and one session's message mustn't cost everyone their connection.

## `page_full`

A page's Yjs state stops at 3.5 MiB (`DESK_NOTEBOOK_PAGE_FULL_BYTES`), so a new client can always get it inside `DATA`'s 4 MiB. **What happens:**
- **Hocuspocus's `beforeSync` hook** refuses the update before it's applied, by throwing `{code: 4413, reason: 'page_full'}`. That closes this document on this connection, and nothing else.
- **The running figure is an upper bound.** An exact figure is taken before anything is refused, which is one `encodeStateAsUpdate`, about 10 ms at the ceiling.
- **Updates that only delete, and repeats,** are always let through, by comparing the update's clocks with the document's. So a member can make room.
- **The provider** gets a `close` event with `event.reason === 'page_full'`, and `code` always 1000. It **stays attached and stays quiet about it:** no retry, no reconnect, `hasUnsyncedChanges` stays true, and the refused text lives only in that tab's `Y.Doc`. If the socket reconnects for another reason, it's refused once more, once per connection, not in a loop. This is unlike the spike's resend for ever, which came from closing the whole socket for size.
- **Hocuspocus treats later messages for that page as a page opening,** and past 1,000 of them or 5 MiB would close the whole session, as a provider keeps sending while its editor is open. So the adapter drops them until the client sends Auth for that page again.
- **What the app has to do:** on `page_full`, make the editor read-only and say so, then destroy the provider and reopen the page on a fresh `Y.Doc` if the member wants to delete things. Reopening with the same `Y.Doc` sends the refused text again and gets `page_full` again.
- **A restore** that would pass the ceiling is tried on a copy and refused: `bad_request`, `reason: page_full`.

## Rules

- **Logs** hold page ids and counts, and never note text, titles, tab names, search queries, payloads or an error's message (`src/log.ts`, tested with marked strings). Libraries' `console` output is cut down to its first string and each error's class. Sessions are numbered, and `sessionId` and `sub` aren't logged.
- **No network.** `--network none` in `run`. Tests: no TCP, UDP or raw socket in `/proc/<pid>/net` at any point; a preload that ends the process on any non-Unix listen, connect or DNS lookup; and a whole run in a network namespace with no interfaces.
- **Files** are at most `0640`, directories `0750`, the socket `0660`, set by umask before it binds.
- **The socket is trusted.** Only `desk` can enter its directory, and Node has no `SO_PEERCRED`, so nothing checks the peer's uid.

## Measured

This machine: x86_64, a shared Ryzen 5 7600X with 6 vCPUs, load about 4.5 (2026-11-07, with `--max-old-space-size=192`), so **these aren't desk numbers**. The test-desk stage repeats them on arm64. `npm run measure`, from the bundle with `run`'s Node flags. The bundle is 783 KiB.

| | |
|---|---|
| Ready, as the process measures it, on an existing database: median of 6 (range) | 52 ms (49 to 57) |
| RSS at rest (of which anonymous) | 70.9 MiB (22.5 MiB; the rest is Node's own file pages) |
| RSS, 2 clients on a small page | 78.8 MiB |
| RSS, 2 clients on the 100-page page, after typing and stores | 146.3 MiB, staying at 157.1 MiB after it left memory, and reused |
| **One store of the 100-page page** (592 KB of Yjs state, 730 KB of JSON): median of 9 | **32.1 ms**, worst 63.7: encode 3.2, derive 10.5, write 18.9 |
| One store near the ceiling (3.3 MiB of Yjs state): median of 3 | 163.9 ms, worst 166.0 |
| One client's keystroke to another, inside the 100-page page, through the socket: p50 / p99 | 0.34 / 2.16 ms |
| Cold open of the 100-page page | 47 ms |
| SIGTERM to exit: nothing open / with the 100-page page unstored | 4 ms / 156 ms |

The spike's 100-page page was 602,524 bytes, pasted through TipTap. This one is built from JSON by the same recipe.

**Under the real cap.** `npm run memory` runs the bundle in a systemd scope with `MemoryMax=320M` and `MemorySwapMax=0`, the same cgroup limits as `run`'s `--memory` and `--memory-swap`, with `run`'s `--max-old-space-size=192`. Each page is open in 2 clients, typed in and stored, versioned, read back and joined by a third client. Taken 2026-11-07 at load 6 to 9. `MEMORY_PAGES`, `MEMORY_CHUNKS` and `MEMORY_SIZE` choose the case.

| Open at once | Result | Peak anonymous memory | V8 heap used |
|---|---|---|---|
| 1 near the ceiling (560 printed pages, 3.3 MiB of Yjs state) | Fine | 183 MiB | 46 MiB |
| 2 near the ceiling, built in chunks under 1 MiB, as the editor sends them | Fine | 241 MiB | 88 MiB |
| 3 of 280 printed pages | Fine | 155 MiB | 85 MiB |
| 15 of 100 printed pages | Fine | 189 MiB | 120 MiB |
| 2 near the ceiling, the second arriving as **one** 3.3 MiB update, which aborted Node at a 128 MiB heap | Fine | 251 MiB | 105 MiB |
| 3 near the ceiling, each arriving as one 3.3 MiB update | Fine | 262 MiB | 121 MiB |
| 4 near the ceiling, in chunks or each as one update | **Node aborts at its 192 MiB heap** (below) | 255 to 273 MiB | |

The cap itself never stopped it: every abort was V8's heap limit, with the cgroup's 320 MiB still unreached.

## Known limits

**On a guild's desk:**
- **Within the budget, a member can delete anyone's text,** up to 500 a page every 10 minutes, and across pages. It stops a wipe, not a small edit made in bad faith. Versions say who, so a moderator can restore.
- **Cut and paste of another member's text is two updates,** so the cut is charged and the paste is the member's own text. Dragging it is a move, free.
- **A crafted client could get past the charge** by making the same text reappear in the same update from pieces of other text, with at least one new character in each run. The editor doesn't make such updates. Every version is kept as before, and each says who.
- **If a merge leaves a block the editor can't show,** the editor deletes it, and if it holds another member's text, that's charged to whoever's editor deleted it. Past the budget, that editor is refused on that page until someone with `moderate` (or the block's writers) opens it.
- **The budget is in memory,** so a restart refills it, and it's per page.
- **A huge drag on a huge page** by a member without `moderate` may pass the second look's 1 s, be charged as removed, and so be refused. A page's judging blocks the loop while it runs, as a store does.
- **Text from before this build,** or written while a page was edited through a build without it, has no writer, and anyone may delete it. On a Personal or Work desk none of this runs.
- **A `caller` frame's new grants apply to RPC at once,** and to collab from the next message that arrives after it.

- **A store blocks everyone** for the times above, and at the ceiling for about 6 times that. Merging waits behind it.
- **Memory:** past the 192 MiB heap Node aborts, which no code here can catch. The table above is how far that is: 3 pages near the ceiling open at once are fine, even with each arriving as one 3.3 MiB update, and a 4th takes it past the heap, whether or not it comes in chunks. An abort costs what the 150 ms rule says, and the service restarts: after one, the restart had every committed page whole, and an update it died on that was never acknowledged was gone. If what caused it is still open it can happen again, so Notebook would flap for that member, with nothing committed lost. RSS stays at its peak, and is reused.
- **Agent edits** (`pre_agent` and `openDirectConnection`) aren't exposed yet. `notebook.version.save` takes the reason.
- **No images or attachments** (Phase 2 of the Notebook), so no `attachments` table or `attachment_names`.
- **Search inside past versions** and search of Trash aren't here.
- **`y-indexeddb`** on trusted devices (design 5.5) isn't here, by the contract. A tab closed while the desk is down loses its unsent edits.
- **A move or an export taken while pages are being typed in** gets the last commit, by `desk-data`'s consistent copy. `readable/` can be up to 30 s older than `notebook.db`.
- **`page_activity` `added` and `removed`** are the net change in characters per store, as in `LocalBackend`, so typing and deleting within one store cancel out.
- **Not built by Docker yet** on this machine, and these numbers are x86_64. The test-desk stage repeats them on arm64.
