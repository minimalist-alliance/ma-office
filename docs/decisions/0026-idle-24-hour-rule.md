# 0026. Idle stop: the 24-hour rule, activity signals and wake

**Status:** Proposed (pending the owner's approval of design v1.1)
**Date:** 2026-11-04
**Amended (ISSUE-64, docs only):** 24 hours is the default, not the rule for every desk. An Alliance desk stops after 20 idle minutes and a free desk after 30 by default, the free tier's setting (`ma-platform` ADRs 0097, 0111), and "idle" means no open session: an open tab holds a session until it has been hidden 60 minutes or untouched 2 hours (free and Alliance desks, ISS-64b) or 24 hours (any other) (`web/src/desk/idle.ts`). Pre-warm is not built. Design section 10.5 has the corrected rule.

## Context
- The owner (2026-11-04, verbatim): "We should not be shutting down desks that are idle, unless they have been inactive for more than 24 hours." Unattended agent work counts as activity, and a cold start may be slower if it shows a clear waking state.
- ADR 0013 let members choose shorter thresholds, capped agent keep-awake at 2 h past the last input, and deleted a per-desk DNS record at each stop.
- Under the hybrid contract (ADR 0022) content no longer crosses the gateway, but the gateway still opens and closes every session. Platform's ADR 0016 makes its session count the authoritative client signal and doesn't count `clients.lastInputAt`.
- The approved contract's heartbeat carries `{client_connected, last_user_input_at, agent_tasks_running}`.

## Decision
- **Platform's sweeper decides** (every 15 min); deskd only reports. A desk is active while any of these holds:
  - **Client present:** at least one open desk session. The gateway's session count is authoritative (including its 60 s resume hold); the desk's `client_connected` is the cross-check. Clients close a desk's sessions once their tab has been hidden for 60 min. Watches and badge counts never count.
  - **User input** (`last_user_input_at`): input on that desk's panel or windows, including scrolling a locally rendered minified page (reported on `ctl` as `ACTIVITY`), visible media and file transfers.
  - **Agent work** (`agent_tasks_running`, `agent_last_activity_at`): running agent runs that made progress in the last 60 min, unattended runs included, with no input-tied cap.
  - **Guild host only** (`guild_activity_at`): member input in guild spaces forwarded by member Guild Desks, or guild agent runs.
- **Never activity:** watches, keepalives, ICE consent checks, replication, inbound messages, health checks, snapshots, updates and untouched pre-warms.
- **Stop rule:** a desk stops after 24 h inactive (`autoStopMinutes` 1440) for every desk kind, Guild Desks and hosts included. There is no shorter default; a member can put a desk to sleep by hand. Dev/test desks keep their own rules.
- **Stop:** graceful, with `prepare_stop` ≥ 60 s ahead, a `stopReason`, and `ready_to_stop`. Plain stop, never hibernation (ADR 0007). There is no DNS record to remove; a recycled IP cannot impersonate the desk (ADR 0022).
- **Wake:** Platform `connect` or `start` only. Focusing a desk or opening an app wakes it; app open pre-warms the current scope (10-min stop if untouched); guild members may wake their host (rate-limited). The member-facing waking state is ADR 0031.
- **Cold-start targets:** stopped → app-ready p50 ≤ 35 s, p95 ≤ 60 s; first Browser +3–5 s; new desk 60–120 s (measured in Phase 0).

## Consequences
- Daily-use desks are effectively always on, so costs are planned at 730 h (ADR 0027).
- Reading a minified page or leaving an agent working keeps a desk up.
- Image upgrades can't wait for an idle stop on daily desks, so Platform schedules upgrade stops, announced with `stopReason: upgrade`.
- Asks Platform to count `last_user_input_at` and `guild_activity_at` in its ADR 0016 (design §13.2).
- Supersedes ADR 0013.
