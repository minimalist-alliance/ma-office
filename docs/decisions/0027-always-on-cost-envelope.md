# 0027. Always-on cost envelope under flat pricing: plan at 730 h, contain CPU surplus on the desk, never throttle

**Status:** Proposed (pending the owner's approval of design v1.1; numbers pending the benchmark)
**Date:** 2026-11-04

Cost, price and margin figures are kept out of the public repository. This record keeps the engineering decision.

## Context
- Membership is a flat price. Under the 24-hour rule (ADR 0026), desks used daily are always on.
- Platform ADR 0032 includes an egress allowance per member and bills CPU surplus and egress above it as extras.
- t4g unlimited mode bills CPU surplus. Platform's ADR 0022 has a daily guard that switches a desk to `standard`, which throttles it, and the owner rules out sluggishness.

## Decision
- **Planning:** every desk is planned always on (730 h), with per-desk public IPv4, EBS and snapshots, and egress at the allowance's worst case, using Platform's fee model.
- **Contain surplus on the desk, never throttle:**
  - When no client is watching, deskd freezes member tabs and stops `desk-stream`.
  - The encoder runs only while a Browser window is visible (paused but warm in minified mode).
  - desk-agent and guild agents run under a CPU quota.
  - Minified-local stays the default mode (ADR 0030).
  - Primaries and hosts stay in unlimited mode with no `standard` guard. Any surplus left is a billed extra (Platform ADR 0032). Platform alerts per account on high surplus or egress.
- **Savings Plan:** recommend a 1-yr EC2 Instance Savings Plan (No Upfront, t4g family) for part of the always-on floor after about 3 months of history (design Q15).
- **Escalation:** if the benchmark forces larger primaries, Desk takes the data to the owner (design Q9) rather than degrading the desk.
- All instance choices are pending benchmark confirmation.

## Consequences
- Heavy users are neither throttled nor a loss: their surplus and overage are billed extras.
- Tab freezing means background pages don't tick while no one is watching. Agent browser contexts are not frozen, only CPU-capped.
- Amends ADR 0014's reliance on Platform's surplus guard; asks Platform to drop the guard on primaries and hosts (design §13.2).
