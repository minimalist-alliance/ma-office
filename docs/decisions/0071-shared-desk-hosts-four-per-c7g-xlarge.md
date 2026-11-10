# 0071. Shared desk hosts: 4 desks per `c7g.xlarge`

**Status:** Accepted (the owner, 2026-11-07, through the Lead). Nothing is built: S-56 builds the placement with the Platform Engineer.
**Status note, 2026-11-09:** two things have moved since this was accepted. (1) Host test bakes now exist: `image/host/` builds a shared-host image (`ma-desk-test-host-*`, test bakes only, no release; `image/host/RELEASES.md`), and the cloud side is merged but switched off in `ma-platform`. The placement and members on shared hosts are still not live. (2) The seed is now 6 desks per `m7g.xlarge`, not 4 per `c7g.xlarge` (`ma-platform` ADR 0101's addendum, `scripts/hosting-set.sh --seed`). The decision text below is kept as it was written.
**Date:** 2026-11-07

## Context
The owner, on what a member is promised: "We are NOT promising someone their own EC2 and never will". On the stream: "Its okay if sometimes people get less than 60. Below 30 is unacceptable."

So member desks from any members may share a machine behind the tested wall (S-56). The earlier target was 6 desks per `m7g.xlarge`, with 32 GB drives. Shared-host test 3 (`spikes/shared-hosts-test3/README.md`, merged as `163d00c`) disproved it, on today's desk (`ma-desk-0.2.7`), with every desk viewed and two runs of each load:
- 6 per `m7g.xlarge` misses the 30 fps floor by up to 26 fps, and 5 by up to 16.
- CPU decides, not memory: at most 10.1 of 15.7 GB, no swap, no kill.
- 3 per `c7g.xlarge` held 30 fps in every realistic load, and for a 32-minute soak.
- 4 per `c7g.xlarge` passed every load but one: `read-video2`, the realistic peak with two desks playing video, had one flick in 109 at 29.98 fps.

The owner on that result: "4 per c7g.xlarge will have to do".

## Decision
Shared hosts pack **4 desks per `c7g.xlarge`.** The number is a per-env setting that the placement reads, built with the Platform Engineer when S-56 is built, so it can change without a release. 30 fps stays the floor and the goal. 60 fps stays a goal only, never a promise.

**Known edge, stated plainly:** at 4 per `c7g.xlarge` one flick of 109, in the second `read-video2` run, moved 19 frames in 633.7 ms: 29.98 fps, every other frame at 60 Hz. By the rule as written that is a miss of 0.02 fps. At the peak the machine ran 91 to 92% busy, with no margin; a third video at once, the agent working or faster readers would likely take it under. **Not proven:**
- 4 per host wasn't soaked (3 was, for 32 minutes).
- Two runs per load, so one flick in either is the whole evidence.
- The stream was at `high` only.
- No real members' behaviour was measured, only scripted readers and videos.

## Consequences
- **Supersedes the 6-per-`m7g.xlarge` target.**
- S-56 should soak 4 per host before members rely on it, and the setting is the lever if real use shows the edge widening: drop to 3.
- Placement reads the setting per environment, so test can run other packings.

## Alternatives
- **3 per `c7g.xlarge`.** Passes everything with room (lowest number 40, soaked 32 minutes). Kept as the fallback the setting can move to.
- **5 or 6 per `m7g.xlarge`.** Fail clearly (down to 13.8 and 4.4 fps). More memory buys nothing, because CPU runs out first, and the machine costs 13% more than `c7g.xlarge` for the same four cores.
