# 0009. Browser process model: sandboxed kiosk Chromium, Playwright over local CDP, separate agent context

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) (kiosk blocklist) and by the design v1.1 review (the browser stack stays running on primaries; design §6.1, B18); 2026-11-05 by [0041](0041-deskd-drives-cdp-directly.md) (`deskd` drives CDP directly, with no Playwright; noted 2026-11-09)

## Context
- Neko's own Chromium image runs `--no-sandbox`. Chromium launched by Playwright flags itself as automated, which triggers more bot challenges and can block Google sign-in.
- Minified mode and agent tools need Playwright to own the page; restarting the daemon must not kill tabs.
- The kiosk Chromium holds the member's logged-in sessions, and agents read untrusted web content.

## Decision
- `desk-browser.service` (user `kiosk`) runs Debian Chromium as a normal process: `--kiosk`, profile on `/data/browser/profile`, **sandbox on**, remote debugging bound to 127.0.0.1:9222, disk cache capped at 1 GB, policies denying microphone and camera and blocking MA's own hosts (`app.`, `api.`, `auth.`, `gw.`).
- deskd attaches with Playwright `connectOverCDP`; nftables lets only uid `desk` reach port 9222.
- The browser stack (Xorg dummy, PulseAudio, Chromium) starts on the first Browser use after boot and **stays running on primaries**. With no Browser window open, deskd freezes member tabs (CDP page lifecycle `frozen`) and stops capture and encode, so reopening the Browser thaws live tabs within the window-open budget (design B4) instead of a 3–5 s cold start that reloads tabs and loses scroll and in-page state. Tab discarding handles memory pressure. (v1.1 stopped the stack after 15 min unused; desks are now always-on, so the ~1.5 GB it freed isn't worth a cold open.)
- **Cold open** (after a desk wake or a Chromium crash): the window paints each tab's last snapshot, kept on `/data/browser`, at once under a "restoring" state (design B18, ≤ 250 ms), and live tabs replace it when session restore finishes.
- **Session restore:** Chromium runs with the `RestoreOnStartup` policy set to restore the last session and is always stopped gracefully, so tabs and session-only cookies survive a desk stop or a Chromium restart (verified in Phase 0). This replaces hibernation as the way tabs survive (ADR 0007).
- **The agent browses in its own `BrowserContext`** with no member cookies, shown as "Agent tabs" with Stop and Take over. It reads the member's tab only when shared. Driving the member's logged-in context comes later behind a per-task grant.

## Consequences
- Chromium's sandbox is kept and isolated by uid and cgroup. Chromium's memory (1–2.6 GB with tabs) stays resident on primaries while the Browser is closed; frozen tabs use no CPU, zram compresses them and tab discarding sheds them under pressure. Members stay logged in to session-cookie sites; only in-page state (e.g. unsent form text) is lost on a desk stop.
- `connectOverCDP` is slightly lower fidelity than a Playwright-launched browser.
- An unconfirmed agent click can only act in anonymous browsing.
- Alternatives rejected: Neko's Chromium container (no sandbox); `launchPersistentContext` inside deskd (browser dies with the daemon, automation-flagged); letting the agent drive the member's context.
