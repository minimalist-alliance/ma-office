# 0028. Quality bar: "never sluggish" budgets, enforced by a perf CI

**Status:** Proposed (pending the owner's approval of design v1.1; remote numbers pending the benchmark and spike)
**Date:** 2026-11-04

## Context
- The owner: "Minimalists are usually big about quality so if it feels slugish or slow thats a nogo." He also requires 60 fps scrolling and animation and low input latency, and rules out VNC-class streaming.
- Design v1's budgets were incomplete:
  - ADR 0004 budgeted only the canvas.
  - The stream (ADR 0008, ADR 0014) and minified clicks (ADR 0021) had placeholder "working bars".
  - The minified bar (p50 ≤ 500 ms, p95 ≤ 1 s) counted a fixed 300 ms settle wait.
- Privacy is the product, so automatic field telemetry is not acceptable by default.
- CI runners have no GPU.

## Decision
- **Budgets B1–B18** (design §2.2) are product requirements. A feature that misses one ships behind a flag or not at all. Key budgets:
  - canvas: 60 fps floor, ≤ 8 ms per frame, ≤ 1% dropped frames;
  - local input to next paint: ≤ 50 ms p95;
  - keystroke to glyph: ≤ 32 ms p95;
  - window open: first frame ≤ 16 ms, content ≤ 250 ms; a cold Browser open shows each tab's last snapshot within the same 250 ms under a "restoring" state;
  - minified local interactions: native;
  - minified actions: MA overhead ≤ 50 ms p50 and ≤ 150 ms p95 on top of site time + RTT;
  - normal mode: ≥ 58 fps with zero freezes, input to photon p50 ≤ 90 ms and p95 ≤ 150 ms from US-East;
  - running-desk connect: ≤ 1.5 s;
  - visible waking state: ≤ 100 ms.

  Remote numbers are *pending benchmark/spike*.
- **Principles:** local first; feedback in one frame; a progress cue at 100 ms and never earlier; measure MA's overhead, not the site's; 60 fps as the floor.
- **Reference conditions:** the reference devices (design Q10) on US-East broadband.
- **Measurement:**
  - User Timing, Event Timing, Long Animation Frames and rAF deltas;
  - WebRTC `getStats()`;
  - action-id breakdowns stamped by the client and deskd;
  - a photon probe (marker page plus `requestVideoFrameCallback`) for normal mode.
- **Perf CI in three tiers:**
  - `perf-pr`: GitHub-hosted runner, mock desk over loopback WebRTC; fails on a > 10% regression or a calibrated ceiling.
  - `perf-desk`: nightly and before releases, on a `DeskKind=test` desk at RTT profiles of 30, 70 and 90 ms plus a lossy profile, weekly through TURN.
  - `perf-device`: before releases, on the reference devices, with absolute budgets that block the release.
- **No automatic field telemetry.** Members can choose to send numbers-only reports (design Q11).

## Consequences
- "Sluggish" becomes a testable, blocking condition, and regressions are caught per PR.
- Normal mode is held to its own, honest bar (video can't match a local browser), which is why minified is the default once it ships in Phase 3; Phases 1–2 are stream-only (design Q8).
- Costs: ~$1–2/month for nightly desk runs; reference devices must exist and be run before each release. Feature work must budget its frames.
- Absolute frame budgets are proven only on reference devices, and slowdowns on members' machines surface only through nightly runs and reports members send.
- Amends ADR 0004's budget bullet (now B1) and replaces the working bars in ADRs 0008, 0014 and 0021.
