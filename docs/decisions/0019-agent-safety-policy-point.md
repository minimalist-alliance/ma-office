# 0019. Agent safety: deskd as the single policy point, sandboxed runtime, confirmed egress, audit log

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04

## Context
- Agents read untrusted web and chat content and can act on the desk. Prompt injection is unsolved, so approvals must hold even if the model is manipulated.
- Agents must never reach other desks. The drafts disagreed: the Chat draft allowed opt-in auto-send per channel and agent trashing without confirmation; the Agent draft confirmed both.

## Decision
- **deskd is the only policy enforcement point.** The agent runtime runs as Unix user `agent` under a hardened systemd unit, with no direct access to desk data; every tool call goes through deskd's local RPC, where deskd applies policy, holds approvals, executes and audits. nftables limits `agent` to deskd's egress proxy (provider API hostnames only) and blocks IMDS.
- **Tool classes:** read (auto); local-write (auto, versioned, attributed, undoable); destructive (confirm), including `notebook.trash_page`; egress (always confirm in v1, no auto-approve), including `chat.send`, `browser.submit` and `a2a.ask`.
- **Approvals** bind to a hash of the exact payload, are single-use, expire after 24 h, and are given through the member's own desk session.
- **Taint (Rule of Two):** runs are marked U (untrusted input) and S (sensitive data read). With both, every browser action that can carry data to a site is egress and needs confirmation: `browser.open` and any navigation (any origin, including same-origin and query-string changes), `browser.type` into any page, and `browser.click`. Memory writes while U is set also need confirmation. To browse without prompts, the agent forks a fresh sub-run with S clear that returns only its extracted result (the parent becomes U). The CI injection fixture covers a same-origin query-string leak and typing desk data into a page. Remote images in model output are never auto-loaded.
- **Audit log:** append-only, hash-chained SQLite table on each desk (key use, tool calls, approvals, limits, support sessions, grants, A2A), kept 1 year.

## Consequences
- The agent can't skip confirmations or exfiltrate except through confirmed tools: once a run holds both untrusted input and desk data, every browser action that could carry that data out is confirmed. Approval fatigue is the main residual risk; S-free sub-runs reduce it.
- Per-channel auto-send is deferred until there is evidence it is safe.
- Root on the desk could rewrite the audit log until chain-head anchoring in Platform ships.
