# 0002. Desk is a web app (React + Konva), not Tauri/native

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04

## Context
- The vision asks for a Konva canvas that members use full screen as their "only Operating System", "no matter where they are or what machine they are using". The apps' data and the real browser live on per-desk EC2 VMs, not on the member's machine.
- The pre-v1 design draft listed unconfirmed defaults: Tauri (Rust + React), Linux first, unsigned Linux builds, online-only with a read cache. The owner never approved them, and the coordinator's ownership split says "Runs in any browser. NOT Tauri/native".
- Platform's draft design already assumes a React + Konva web app hosted by Platform at `app.minimalistalliance.com`.

## Decision
- Desk is a browser single-page app: React 19 + TypeScript (Vite). Konva via `react-konva` draws the world canvas; React DOM renders everything text-heavy (top bar, menus, app windows). State in Zustand and TanStack Query; Radix UI primitives; all fonts and icons self-hosted.
- Platform hosts it (immutable bundles, cohort loader) and runs its releases. It ships a web manifest so it can be installed as an app window.
- No native or Tauri client, no app stores, no code signing.
- **This supersedes the unconfirmed "Tauri (Rust + React)" default in the pre-v1 design draft**, together with its "Linux first" and "unsigned Linux builds" defaults. They were never approved and are removed from the design.

## Consequences
- Works on any machine with a modern browser, with nothing to install; a release is a bundle swap that Platform can roll back in seconds.
- No signing or store costs.
- Browser limits apply: Ctrl/Cmd+Tab/W/T/N are reserved, Esc exits full screen, and iPhone Safari has no element full screen (Add to Home Screen instead). Mitigations are in design §3.1 and §3.11.
- Offline use is limited to an opt-in trusted-device cache; desks are online services by nature.
