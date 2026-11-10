# 0013. Idle-stop and wake: Platform decides, Desk supplies activity signals

**Status:** Superseded by [0026](0026-idle-24-hour-rule.md)
Why: The owner's 24-hour rule (no shorter default; unattended agent work counts) and the hybrid contract (no DNS step; activity reported by heartbeat) replace this decision (2026-11-04).
**Date:** 2026-11-04

## Context
- Compute is the main cost. The VM draft had deskd power the VM off itself; Platform's draft ADR 0016 runs an idle sweeper on heartbeat signals and counts only input that reaches the desk.
- The owner has since ruled that a desk stops only after 24 hours of inactivity (relayed by the coordinator, 2026-11-04); Platform is redefining "inactive".
- Reading a long minified page involves no input that reaches the VM. Agent runs must not be killed mid-step. The Canvas draft wanted focus to wake a desk and the overview never to; the VM draft wanted to pre-warm desks when the app loads.

## Decision
- **Platform's sweeper decides** when to stop; deskd only reports signals. deskd never powers the VM off by itself.
- **Signals:** `last_input_at` counts any keyboard, pointer, scroll or touch input in the Desk app for that desk (even if it never reaches the VM), visible media playback in an open Browser window, and file transfers; keepalives never count. `agent_busy_until` covers running agent runs, capped at 2 h past the last input.
- **Threshold:** the owner's 24-hour rule by default; members may choose shorter.
- **Wake:** focusing a desk or opening its app wakes it; opening the Desk app wakes stopped desks of the current scope; the All overview never wakes a desk; a desk woken only by that pre-warm and never touched stops after 10 min.
- **Stop:** ≥ 60 s of grace so deskd can checkpoint runs and Chromium can save its session; always a plain stop, never hibernation (ADR 0007). Platform deletes the desk's A record at the start of the stop, before the IP is released (ADR 0010).

## Consequences
- Supersedes the VM draft's self-poweroff. Platform's ADR 0016 needs the broader `last_input_at` definition (design §13.2).
- Under the 24-hour rule, daily-use desks effectively run 24/7; members who want lower bills choose a shorter threshold.
- While stopped, a desk's data, agents and incoming messages are offline; the canvas shows the last counts.
