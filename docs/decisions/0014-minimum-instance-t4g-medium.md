# 0014. Minimum instance for primary desks: t4g.medium, provisional until a benchmark gate

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0025](0025-guild-desk-sizing.md) (Guild Desks), [0027](0027-always-on-cost-envelope.md) (no throttle guard) and [0028](0028-quality-bar-never-sluggish.md) (gate bar)

## Context
- Platform needs the primary-desk minimum for pricing; its draft catalog provisionally uses t4g.medium (2 vCPU / 4 GiB).
- Estimated working set with the Browser open: 1.8–3.2 GB RAM typical, up to ~3.8–4.1 GB worst case (6 member tabs, 2 agent tabs, minified overhead), ~1–1.5 vCPU at peak, ~0.1–0.3 vCPU on average. Any primary desk may hold the Browser app.
- The owner's "no sluggishness" bar is pending; the coordinator's benchmark uses 60 fps as its threshold.
- The Minified draft assumed t3.medium; the VM draft used c7g.large as the non-burstable fallback; Platform's catalog has m7g.large ("Steady").

## Decision
- **Personal and Work minimum = t4g.medium** in unlimited credit mode, with 2 GiB zram and tab discarding. Guild Desks are sized by role (ADR 0025). No `standard`-mode throttle guard (ADR 0027).
- **Benchmark gate** in Phase 0, scripted from a US-East client: The owner's quality bar (ADR 0028) at 1280×800 and 1080p: ≥ 58 fps delivered with zero freezes while scrolling at a 60 fps encode, and input to photon p50 ≤ 90 ms and p95 ≤ 150 ms (30 fps no longer passes); no OOM kills with 6 member tabs, 2 agent tabs and a busy agent; mean CPU ≤ 0.4 vCPU (the baseline) over a 30-min typical session, with surplus cost reported for a heavy one. Memory fail → t4g.large; CPU, frame-rate or latency fail → a non-burstable size (c7g.large or Steady m7g.large).
- **Provisional to Platform:** until the gate runs at the owner's bar, Platform prices on t4g.medium but plans for the fallbacks: t4g.large (~$56/month always-on) on memory, which the worst case makes likely, or c7g.large / m7g.large (~$60–65 always-on) on CPU, frame rate or latency.
- Custom desks without the Browser app may use t4g.small. All sizing work uses t4g, not t3.

## Consequences
- Always-on is the planning basis under the 24-hour rule (ADR 0027).
- A failed gate roughly doubles compute cost per desk; a 60 fps bar makes that more likely.
- A browser benchmark (t4g.medium, c7g.large, c7g.xlarge) is already running; its results confirm or amend this ADR in the revision pass.
