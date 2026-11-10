# 0025. Guild Desk sizing: lighter member class and host tiers by member count (pending benchmark)

**Status:** Superseded by 0080 (2026-11-07)
**Date:** 2026-11-04

> Superseded by [0080](0080-guild-shared-desk.md): the guild server is sized by member count (up to 200); there is no lighter member class.

## Context
- Design v1 gave every primary desk, Guild included, the t4g.medium minimum, which made three always-on desks per member costly.
- The owner: members' Guild Desks can be smaller; the officer's Guild Desk is "strong" because it hosts the guild.
- Platform's ADR 0033 already makes the member Guild Desk t4g.small and every officer-tier Guild Desk a fixed c7g.xlarge host.
- Minified mode now renders locally in the Desk app (ADR 0030), so a desk without normal-mode streaming needs no encoder or Xorg.
- The browser benchmark is still running.

## Decision
- **Member Guild Desk: t4g.small** (2 vCPU / 2 GiB). It runs deskd with the replica, desk-agent and headless Chromium for minified mode only (≤ 3 tabs). No Xorg, encoder or normal-mode streaming (design Q12). Data volume 8 GB. Fallback t4g.medium; lever t4g.micro without a Browser.
- **Phase 2 default (design Q16): t4g.micro without a Browser.** The minified view ships only in Phase 3, so a Phase 2 member Guild Desk has no Browser either way ("Open on Personal"). t4g.small with a minified-only Browser applies from Phase 3 if Stage A is GO and the owner accepts its margin. Until the host gate passes at N = 25 on t4g.large, or a Savings Plan is in place, guilds are capped at 10 members (host S).
- **Host tiers by member count N** with guild-agent concurrency C:
  - S (N ≤ 10, C = 2): t4g.large.
  - M (11–25, C = 4): t4g.xlarge.
  - L (26–50, C = 6): t4g.xlarge, only if the owner lifts Platform's 25-member cap.
  - Non-burstable fallbacks: m7g.large, and c7g.xlarge or m7g.xlarge.
  - Host data volumes: 30 GB (S) and 50 GB (M).
- **Who hosts:** only the guild's leader. Guild officers' Guild Desks are standbys, at least host S. An officer-tier account that is a plain member of another guild gets the member class.
- **Load model:**
  - RAM ≈ 3.5 + 0.4 + 0.03·N + 0.35·C GiB (0.6 GiB per browser-tool run).
  - Peak CPU ≈ 1.5 + 0.05·active editors + 0.4·browser-tool runs.
- Platform resizes the host on role change or when N crosses a tier, at a graceful stop.
- **CPU priority:** the leader's interactive services outrank `desk-guildhost` and guild agents (cgroup weights). File transfers share a token bucket.
- **Host load gate,** run before guilds open in Phase 2: N simulated member desks plus C agent runs while the leader runs the 60 fps scroll test. If t4g.large passes at N = 25 with C = 3, tier M becomes t4g.large.
- All instance choices are pending benchmark confirmation.

## Consequences
- Member Guild Desks can't stream normal mode (design Q12).
- Amends ADR 0014 (Guild Desks no longer use the primary minimum; Personal and Work keep it). Asks Platform to amend its ADR 0033 (design §13.1 #34).

Addendum 2026-11-07 (task 45): "officer", "officer-tier" and "Officer with host" mean the Founder tier (id `lead`); "a member" here means the Officer tier (id `officer`); "guild officers" are the guild's Officers. Names are set in Platform's `tier_names` setting.
