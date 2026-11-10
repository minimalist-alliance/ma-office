# 0020. Agent runs and usage limits enforced on the desk

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0026](0026-idle-24-hour-rule.md) (keep-awake); 2026-11-07 by [0043](0043-agent-limits-local-time-and-platform-prices.md) (local time, desk over account, Platform prices; noted 2026-11-09)

## Context
- Members want token and dollar caps per agent, desk and period on their own keys. Agents run long tasks that must survive crashes and stops.
- The Agent draft deferred account-wide limits to "budget leases"; Platform's draft ADR 0018 has desks report usage totals and returns `limitsRemaining`.

## Decision
- **Durable runs:** a checkpointed SQLite state machine; tool calls carry idempotency keys; running runs report `agent_tasks_running` and `agent_last_activity_at` in the heartbeat and keep the desk awake while they make progress, with no input-tied cap (ADR 0026); stops checkpoint and pause runs.
- **Limits:** scopes per agent (day/week/month), per desk (month), per run (default $2 or 50 steps) and per key per desk. An LLM gateway (AI SDK middleware plus an image wrapper) reserves a conservative maximum before each call and settles from provider-reported usage, in one SQLite transaction. Prices come from a signed `pricing.json` per release.
- **Account-wide per-key limits:** deskd reports usage totals (tokens, estimated $, per key and feature, never content) every 5 min; Platform aggregates and returns `limitsRemaining` (Platform ADR 0018).
- **Memory:** compacted thread summaries plus explicit, user-editable memories recalled with FTS5; no embeddings in v1.

## Consequences
- Overshoot is bounded by one call; dollar figures are estimates, so the UI pushes provider-side spend limits as the backstop.
- Usage totals leave the desk (metadata only); supersedes the Agent draft's "no usage leaves the desk" and "budget leases".
- Alternatives rejected: Temporal, BullMQ or pg-boss (too heavy for one user); enforcement at Platform (would route LLM traffic through Platform); post-hoc accounting only.
