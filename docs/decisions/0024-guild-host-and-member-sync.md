# 0024. Guild host: the leader's Guild Desk hosts guild spaces; member Guild Desks are light replicas synced desk-to-desk

**Status:** Superseded by 0080 (2026-11-07)
**Date:** 2026-11-04

> Superseded by [0080](0080-guild-shared-desk.md): a guild is one shared desk on its own server, so there are no member replicas, no host and no desk-to-desk sync.

## Context
- The owner (2026-11-04, verbatim): "If a member is not part of a guild, they obviously don't need a guild desk and we don't need to charge them for one. But if they are in a guild, their guild desk is mandatory." And: "An officer will have a strong guild desk since their guild desk(s) is essentially the host for their guild. Each member's guild desk can be smaller than their personal or work desks."
- Members join by paying (self-serve); the owner approves only officers (Platform ADR 0029).
- The approved hybrid contract carries only control traffic through Platform's gateway; all content goes directly to desks over WebRTC with DTLS (ADR 0022).
- Design v1 consumed Platform ADR 0019's read-only per-item shares (snapshots in S3 with SSE-S3, readable by MA, titles visible to Platform) and fanned guild chat out to every member's desk with no history backfill (ADR 0017).
- ADR 0015 already uses Yjs and Hocuspocus for Notebook.

## Decision
- **Lifecycle:** Platform's desk list is the source of truth. The Guild Desk exists only while the member is in a guild, has no Remove or Destroy action while they are, and appears or disappears with the gateway's Guild Desk push. Leaving or removal purges the guild replica: at once on a running desk, and on a stopped one at its next boot, since deskd purges `/data/guild` on any boot where config `guild` is `null` (export mode included) before it accepts a session. A member's export never contains guild data; only the leader of an archived guild keeps the host data for export. Platform then retains the desk 30 days.
- **Host:** the guild leader's Guild Desk (Platform's `hostDeskId`) runs `desk-guildhost`: its own systemd unit, Unix user `guild` and data dir `/data/guild/<guildId>/`. It holds guild spaces (shared notebooks as Y.Docs with history, channel logs ordered by `(epoch, seq)` with author-signed messages, content-addressed files) and guild agents. Guild agents use guild-space tools only, with a key the leader assigns and per-member caps. The leader's private Guild-desk data stays in deskd's store.
- **Roles:** Platform roles (leader, officer, member) map to host capabilities. Space access lists live only on the host. Member Guild Desks authenticate with short-lived Platform `guild_access` tokens (ES256, `aud` = host, `cnf` = the member desk's DTLS fingerprint, `exp` ≤ 5 min). Membership or role changes are pushed and applied at once.
- **Sync:** members' clients talk only to their own Guild Desk. Each member Guild Desk holds one desk-to-desk WebRTC connection to the host (design §4.2.15): the member's desk-rtc offers with full ICE, the host is ICE-lite, signaling runs through both desks' gateway links, and the SDPs are signed by both desks' Ed25519 identity keys. On the host, desk-rtc bridges these sessions only to `desk-guildhost`. Data channels: `guild.ctl`, `guild.ydoc` (Hocuspocus message format over the same data-channel adapter as Notebook, ADR 0023), `guild.log`, `guild.blob` and `guild.rpc`.
- **Replica:** the member desk keeps the full space index and page bodies, the last 90 days of channels, file metadata, and pinned or recent files (2 GB LRU). History beyond 7 days, older messages, other files, agent runs and archive search are fetched live.
- **Writes:** offline or host-asleep writes queue, and Yjs merges them on reconnect. Edits rejected after a role change while offline are saved as an "Unsynced copy". Member writes may wake the host (rate-limited). Replication never counts as activity; member input in guild spaces is forwarded to the host as `guild_activity_at` (ADR 0026).
- **Failover:** guild officers' Guild Desks are standbys with full replicas. Planned handover means promote, wait for `host_ready`, then switch. Manual promotion is used in v1. Split brain is safe through Yjs merges and `(epoch, seq)` with dedupe by id. Hosts get snapshots every 6 h plus the daily ones, and member replicas re-push missing updates after a restore.
- **Privacy:** Platform sees roster, roles, host assignment, signaling metadata and byte counts, never content, space names or titles.

## Consequences
- Guild data becomes Platform-blind. Co-editing, history and new-member backfill come for free from the host. Design Q7 and the SSE-S3 caveat disappear.
- The host is a hub. Replicas, wake-on-write, standbys and the 24-hour rule soften that, but single-officer guilds rely on snapshots and replicas.
- Platform must add host assignment, guild tokens and desk-to-desk signaling, and amend its ADR 0019's "no one connects to another member's desk" (design §13.1 #24, #26).
- desk-rtc also acts as the offering, full-ICE peer for desk-to-desk links, and the Hocuspocus data-channel adapter serves both paths.
- More Phase 2 scope; files, guild agents and standbys may slip to Phase 3.
- Replaces design v1 §4.5's read-only per-item shares. Amends ADR 0017: guild channels move from per-member fan-out to the host; the sealed relay stays for member-to-member chat outside the guild and for A2A.

Addendum 2026-11-07 (task 45): "officer" in this ADR meant the guild leader, now the Founder (id `lead`); "guild officers" are the guild's Officers, whom the Founder makes officers (contract `tiers.md` section 7).
