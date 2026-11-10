# 0044. Notebook's service: Hocuspocus on Node, its own container, nothing lost across a restart

**Status:** Accepted
**Date:** 2026-11-07
**Amends:** [0015](0015-notebook-editor-tiptap-yjs.md) (where sync runs) and design §5.4, under the addendum to [0040](0040-desk-services-spring-boot-docker.md)

## Context
- ADR 0015 runs Hocuspocus inside `deskd`. ADR 0040 made `deskd` Java, and Hocuspocus has no JVM equivalent.
- The owner, 2026-11-06, in 0040's addendum: core services stay Java, and "an app's own service, such as Notebook sync, may use the best tool".
- The spike (`spikes/notebook-sync/README.md`) built both on equal terms. Yrs through JNI in Java and Hocuspocus 4 on Node 24 sync equally well, with merges under 1 ms on the arm64 box. A damaged update aborts the JVM, within 1,000 to 7,000 of them, and that binding is one person's, three Yrs releases behind. Yjs throws, and Node survived 90,000. Our own protocol layer in Java lost a merge after a fast restart, sometimes; Hocuspocus never did.
- Notes are the thing a member can least afford to lose. The store's 2 s debounce and 10 s ceiling mean a process that dies holds up to 10 s of typing that only an open tab could give back.

## Decision
- **`desk-notebook`:** Hocuspocus 4 on Node 24 in TypeScript, bundled by esbuild into one file, in its own container: uid `notebook` (1105), `--network none`, read-only root, no capabilities, a memory cap. It's the only thing that touches `/data/notebook`. It imports `web/notebook/src/model/` as source, so the desk and the client can't disagree about a title, a day or a version.
- **`deskd` stays the only door.** It checks the session and relays RPC, topics and collab bytes over one Unix socket per session (`services/notebook/README.md`). The service trusts the socket, whose directory only `desk` can reach.
- **Storage is `node:sqlite`:** no native addon, FTS5 included in Node's build, and `node:zlib`'s zstd for versions. WAL, `synchronous=FULL`, `PRAGMA user_version` going forward and refusing a newer schema. Design 5.4's tables without attachments, plus `page_updates`.
- **Durability, in three steps.** Every client update goes on a queue, and the queue is committed to `page_updates` within about 150 ms. Load is `ydoc` plus `page_updates`. The store (2 s debounce, 10 s maximum, as 0015) writes `ydoc`, `pm_json`, `plain_text`, FTS, `page_activity` and any version in one transaction and clears the log. So SIGKILL or a power cut costs at most about 150 ms, and an open tab gives even that back. SIGTERM stores everything and checkpoints the WAL. A start folds any log rows in before it listens.
- **A damaged update is contained.** y-protocols swallows what Yjs throws and Hocuspocus then acknowledges the update, so the service applies each update first where a throw can be seen. That session's connection is dropped, and its client resyncs through `deskd`'s reset. No other session or page notices, and the fuzz test shows it through the socket.
- **`readable/` beside the database:** plain Markdown of every live page, so a member's export reads without SQLite. It's only ever a copy, so a failure there is one log line.
- **A page past about 3.5 MiB of Yjs state takes no more** (`page_full`). What it holds stays, deleting from it still works, and other pages carry on.

## Consequences
- **A second runtime on the desk.** Node 24 is one more thing to patch, in one more image. It takes about 71 MiB at rest and up to about 275 MiB, inside a 320 MiB cap with a 192 MiB heap, tested for real, against a few MiB for Yrs inside `deskd` by the spike's estimate.
- **A store blocks everyone's merging while it runs,** as `node:sqlite` is synchronous and Yjs runs on the one thread: about 32 ms on the 100-page page and 164 ms near the ceiling, on x86_64, with arm64's to come (`services/notebook/README.md`).
- **Agent edits change route.** `desk-agent` will ask this service to apply them through `openDirectConnection`, after a `pre_agent` version. That API isn't built.
- **Trusted-device caching (`y-indexeddb`, design 5.5) isn't here.** Nothing is kept in the browser beyond the open tab, so a tab closed while the desk is down loses its unsent edits, and `beforeunload` warns.
- **Fallback:** the spike's Java server stays in `spikes/notebook-sync/`. To be fit for this it needs a forked binding on Yrs 0.28 with `catch_unwind` at every entry.
- **Alternatives:** Hocuspocus inside `deskd` (no JVM equivalent), Yrs in `deskd` (one panic takes every app down), a separate JVM around Yrs (the same relay at about twice the memory), and a file per page as the spike had (no transaction across text, search and activity).
