# 0005. Client state and storage: layout doc in Platform, desk content in memory only

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04

## Context
- The canvas layout spans desks and must render while desk VMs are stopped, so it can't live on a desk VM.
- Desk content must stay on the desk VMs, and members may sign in from shared or borrowed machines.
- The drafts disagreed on badges for stopped desks: blank (Canvas draft) vs last counts (VM and Agent drafts, Platform's design).
- State updates arrive from rAF loops and WebSocket handlers outside React.

## Decision
- **Layout doc** (desk positions, grids, items and sizes, scope tags, pins, prefs including provider-badge visibility) is one JSON doc ≤ 64 KB in Platform (`/v1/me/desk-layout`, ETag/If-Match), mirrored to localStorage. Metadata only. This also replaces a separate "account preferences store".
- **Device view state** (camera, scope, active desk, window rects) stays in localStorage per device.
- **Desk content** (widget data, previews, snapshots, notes, chats) is held in memory only. IndexedDB caching is opt-in per device ("Trust this device", Phase 2) and wiped on sign-out and revocation.
- **Stopped desks show the last badge counts** that Platform holds from heartbeats and relay queues. Numbers only, never content.
- Zustand slices with per-desk and per-item selectors for UI and live state; TanStack Query for Platform REST.

## Consequences
- Platform learns which apps sit on which desk and the badge counts, but no content.
- Cold opens on untrusted devices always hit the desk VM.
- Two devices arranging at once resolve last-writer-wins; a rare lost arrangement is possible.
- Alternatives rejected: layout on the Personal desk VM (fails while it sleeps); always caching in the browser (leaks on shared machines); Redux Toolkit (heavier); blank badges for sleeping desks (hides real activity).

## Addendum, 2026-11-12: the layout's mirror goes on every signed-out state, and is kept per account (ISS-67)
The layout doc's mirror in localStorage is the account's, not the device's, so it doesn't outlive the session it was written under.
- **What the mirror is:** `ma.layout.v2` (and `ma.layout.v1` from before it), `ma.layout.sync.v1` (the version, ETag and desks not yet on Platform), the document's preferences mirrored for a reload or the first frame (`ma.free.prefs.v1`, `ma.setup.prefs.v1`, `ma.prefs.background`), and `ma.layout.owner.v1`, the token's `sub`. One copy for all of the member's desks, whatever the scope. `LAYOUT_MIRROR_KEYS` in `web/src/state/layoutStore.ts` lists them.
- **Wiped on every signed-out state:** Sign out and Sign out everywhere (after their last words save the layout), `/signed-out`, a start with nobody signed in, a failed `/auth/callback`, a dead session either way, a 401 a refresh can't mend, a refused account, and another tab's sign-out or refused refresh (the token's BroadcastChannel). A page that has signed out writes none of it again, and none of it is written while no refresh token is kept in the browser.
- **Per account:** a sign-in as anyone else wipes another account's copy from storage and from the tab's memory. A copy with no owner, from a build before this, is the first account's.
- **Consequence:** a dead session's unsaved arrangement no longer waits through the trip to sign in; Platform's document stands. Device view state (camera, scope, active desk, window rects) is still per device and stays.
