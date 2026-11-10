# 0030. Browser modes: minified rendered locally by default, normal mode streamed at 60 fps

**Status:** Proposed (pending the owner's approval of design v1.1; numbers pending the benchmark and spike)
**Date:** 2026-11-04
**Amended:** 2026-11-05 by [0041](0041-deskd-drives-cdp-directly.md) (no Playwright; noted 2026-11-09)

## Context
- The owner's bar: "sluggish" is a no-go; 60 fps scrolling; low input latency; no VNC-class streaming.
- The coordinator's lean: render minified pages locally from extracted structure, round-trip only the actions, and stream pixels only in normal mode.
- ADR 0021 already renders MDoc as React DOM in the client. But v1:
  - put a fixed ~300 ms settle wait and a 150 ms typing debounce on the visible path;
  - carried MDoc over a desk WebSocket, which the hybrid contract removed;
  - left ADR 0008's frame cap open between 30 and 60 fps.

## Decision
- **Minified mode (default) is rendered locally:**
  - Scrolling, selection, find (over MDoc data), zoom, hover and expand/collapse never touch the network.
  - Delivery is progressive, first viewport first; blocks are keyed by ref; long lists are virtualized; images arrive with known sizes, so nothing shifts.
  - Scroll is anchored by ref.
  - The last 10 MDocs per tab are kept in memory, so Back, Forward and tab switches are instant.
  - Toggles are optimistic and confirmed by the echo; links and buttons never are.
- **Actions round-trip through Playwright and CDP** with the zero-wrong-target rule unchanged.
  - deskd streams patches from the first mutation (16–33 ms coalescing). "Settled" only re-arms the hit-test guard.
  - Typing is local; values are sent once per frame; the site's reformatting is applied on blur or after 600 ms idle.
  - The latency bar is MA overhead on top of site time + RTT (≤ 50 ms p50, ≤ 150 ms p95, pending spike).
- **Transport:** MDoc, patches and actions on the `mdoc` data channel and images on `bulk` (ADR 0023). Interactive messages never queue behind bulk data.
- **Normal mode** streams at 60 fps:
  - H.264 constrained baseline, zerolatency, intra refresh instead of periodic keyframes;
  - the receiver's `jitterBufferTarget` set to 0;
  - the pointer drawn locally;
  - pointer motion on the lossy `input` channel, keys, buttons and wheel on the reliable `keys` channel (ADR 0023);
  - the encoder kept warm while the Browser window is visible (first frame ≤ 300 ms after a switch);
  - under congestion, resolution drops first, then frame rate, with a visible chip.
- **Fallbacks are unchanged:** recipe → distilled → islands → normal. Islands scroll locally, but their contents have stream latency: each is a cropped region of the warm encoder on the existing video track, and the encoder runs only while an island is in view (design §7.4).
- **Member Guild Desks** run the Browser in minified mode only, with no islands (ADR 0025, design Q12). Until minified mode ships (Phase 3, if Stage A is GO) they have no Browser app, only "Open on Personal", and on a Stage A NO-GO that stays so.

## Consequences
- Most browsing feels native: only actions pay the RTT, and Back is instant. That holds only from Phase 3: Phases 1–2 browse in normal mode only (design Q8).
- Normal mode is smooth but not native (~90 ms vs ~40 ms locally, softer HiDPI text). That is documented honestly and put to the owner (design Q8).
- 60 fps raises encode CPU and egress, so t4g.medium's fit depends on the benchmark.
- Recipes, the distiller's quality limits, and sites that need normal mode are unchanged.
- Amends ADR 0021 (transport, settle and debounce off the visible path, latency bar) and ADR 0008 (frame cap fixed at 60 fps, keyframe policy, warm encoder, input model).
