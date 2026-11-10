# 0021. Minified websites: built from page structure, staged, no generative pixels

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0028](0028-quality-bar-never-sluggish.md) (latency bar) and [0030](0030-browser-modes-local-minified-60fps-normal.md) (local rendering, transport); 2026-11-05 by [0041](0041-deskd-drives-cdp-directly.md) (no Playwright; noted 2026-11-09)

## Context
- The vision's selling point: by default, show a "minified" version of every site, keep the real page running in the background, and propagate clicks and typing through Playwright. The owner suspected a "lite transformer or diffuser or both".
- Diffusion can't render exact text, has no link from pixels to DOM elements, misses interactive frame rates, and costs $384–734/month per desk in GPU. A hosted LLM per page takes 2–30 s.

## Decision
- **No generative model in the per-frame or per-click path.** The minified view is built deterministically on the desk VM from the real page's DOM and accessibility tree (Readability for articles, a role/name walker elsewhere) by a script in an isolated world.
- deskd sends a typed **MDoc** JSON tree, never site HTML; the client renders it with Desk React components. Images come through a deskd proxy.
- Actions target refs; deskd hit-tests and sends trusted CDP input. **Zero wrong-target rule:** refuse rather than guess; pay/buy/send/delete never use fallback re-location.
- The full-page pixel stream pauses while a tab is minified; only a live island streams, as a cropped region of the warm encoder on the desk connection's existing video track (design §7.4). Islands exist only where the desk has an encoder, so never on member Guild Desks ("Open on Personal" there). Fallback is automatic (recipe → distilled → islands → normal mode).
- **Stages:** A distilled view and B islands + curated recipes (Phase 3); C async, cached, validated LLM recipes per site template with the member's own key and redacted prompts (Phase 4, if GO); D generative UI (later, if justified). A 2-week spike in Phase 0 gates each stage; Stage A's go/no-go includes the quality bar's MA-overhead budget (≤ 50 ms p50, ≤ 150 ms p95 on top of site time and RTT) and native-speed local rendering (ADRs 0028, 0030).
- The walker and action proxy also back the agent's browser tools and ship with them in Phase 2, after the spike; if the spike finds wrong-target actions, the agent gets read-only browser tools until the action proxy passes.
- BYO key only; an MA-paid LLM option later must never be a Platform content proxy.

## Consequences
- Expected to be near-real-time (~0.1–1 s per page; per click, the site's time plus the round trip plus MA's overhead, with patches streamed from the first mutation; hypotheses until the spike measures them), cheap, accessible, private; scrolling, copy, find and zoom run locally.
- Quality depends on how well a site is built; canvas-heavy apps run as islands or in normal mode, so "minified everywhere" won't hold for them.
- Recipes break when sites change and need re-validation and upkeep.
