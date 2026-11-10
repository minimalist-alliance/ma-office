# 0006. Desk daemon (deskd): Node 24 + TypeScript, SQLite per app

**Status:** Superseded by [0040](0040-desk-services-spring-boot-docker.md)
Why: The owner's direction (2026-11-05) puts every backend service on the desk EC2 on Java 21, Spring Boot and Docker, which replaces Node 24, TypeScript, `better-sqlite3` and the systemd-only deskd.
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) and [0023](0023-desk-data-channel-protocol.md) (API surface)

## Context
- Every desk VM needs one process that serves Notebook, Chat, Agent and Browser data, enforces policy, drives Playwright and talks to Platform.
- Playwright, TipTap's headless schema, Hocuspocus and AI SDK are all TypeScript/Node. The drafts named Node 22 and Node 24.
- Desks are single-user VMs with 4 GiB of RAM.

## Decision
- **deskd** is one Node 24 LTS + TypeScript process per desk (systemd unit `deskd`, Unix user `desk`), with modules for each app plus blobs, search, events, collab, Platform and migrations.
- **Storage:** SQLite in WAL mode via `better-sqlite3`, one file per app under `/data/desk/` (`notebook.db`, `chat.db`, `agent.db`, `settings.db`), FTS5 for search, and content-addressed blobs under `/data/desk/blobs/sha256/`. IDs are UUIDv7; order uses fractional indexes.
- **API surface:** no network listener. Every client ⇄ desk API is RPC and subscriptions over the desk's WebRTC data channels, bridged from desk-rtc over a Unix socket (ADRs 0022, 0023): app methods on `rpc`, the canvas summary and app events on `events`, Hocuspocus on `collab`, minified pages on `mdoc`, transfers on `bulk`.
- deskd migrates `/data` at boot and refuses to run against a newer schema than it knows. It reports a `deskApi` version for web-app compatibility gating.

## Consequences
- One language across client, daemon and agent runtime; shared schema packages.
- Backup is EBS snapshots plus user export; search is local and fast.
- Notebook makes deskd a stateful collab server, not just a data API.
- Alternatives rejected: Postgres on the VM (more RAM and upkeep for one user); a Platform-hosted database (privacy); Node 22 (older maintenance line).
