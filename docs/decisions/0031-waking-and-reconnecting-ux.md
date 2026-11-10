# 0031. Waking and reconnecting UX: never block, show Platform's wake phases, capture while waking

**Status:** Proposed (pending the owner's approval of design v1.1)
**Date:** 2026-11-04

## Context
- Under the 24-hour rule (ADR 0026) a daily desk rarely stops. Cold wakes still take ~35–60 s, after time away, Give Back windows, upgrades or billing stops. The owner accepts a slower cold start if the "waking desk" state is clear.
- Platform's gateway exposes the wake phases `queued`, `starting`, `booting`, `connecting`, `ready`, `failed` and `stopped` (`desk.progress`), plus `desk.downtime` notices, and gives ≥ 60 s of `prepare_stop` notice with a `stopReason`.
- Desk content is held only in memory on the client (ADR 0005), and anti-stress is a pillar.

## Decision
- **Response in ≤ 100 ms:** a click on a sleeping desk shows a waking state within 100 ms, and `connect` is called in the same tick.
- **Four steps:** Starting, Booting, Connecting (Platform's phases) and Opening (Desk's session plus first summary).
  - Plus "waiting for capacity · #N" and a Failed state with Retry; `capacity_timeout` is retried automatically once after 60 s.
- **Progress bar:** segmented and weighted by this desk's last 5 wakes on this device (durations only, kept in localStorage). It eases to 90% of each segment, never runs backwards, and says "taking longer than usual" past twice the estimate.
- **Never blocks:** other desks, Arrange, settings and windows on the waking desk all stay usable.
- **Capture while waking:** new notes, chat messages, agent prompts and URLs are held in memory, labelled, and committed when the desk is ready. Nothing is sent automatically, and leaving the page first asks for confirmation.
- **Reconnecting:**
  - Blips under 1 s are silent; data-path resume follows ADR 0023.
  - Local work continues; desk-bound actions are disabled, never queued silently.
  - After 30 s the UI shows "can't reach desk" with details.
- **Stopping:** a countdown toast with the reason, plus Snooze or the fix where one exists.
- **Give Back windows:** inside a window the desk is labelled, and waking asks for confirmation.
- **Accessibility:** progressbar semantics, polite announcements only at start and end, and plain steps under reduced motion.

## Consequences
- A slow cold start becomes a calm, visible process instead of a frozen screen, and members can start working at once.
- Drafts typed during a wake are lost if the tab closes first (memory only), so the app warns before leaving.
- The UI depends on Platform keeping its phase names stable and delivering stop reasons to clients (design §13.1 #27).
- Who decides to wake and to stop is ADR 0026; this ADR covers only what the member sees.
