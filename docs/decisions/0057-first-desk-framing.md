# 0057. A desk's first framing, and a new desk's size

**Status:** Proposed (the owner's rule, 2026-11-12; the calls are the UI/UX Engineer's). Built on `sub/first-office`, finished on `sub/lsub-first-office`. Desk app only; no contract change.
**Date:** 2026-11-12
**Builds on:** [0003](0003-canvas-interaction-model.md) (overview and desk focus), [0062](0062-desk-surface-etched-name-and-cleanup.md) (free placement, a new desk's default), [0053](0053-open-tiles.md) (open tiles need room on screen)

## Context
The owner, on a prod test account's first visit (Nov 12): "When I first went to test＠'s office, the desk is unnaturally dimensioned and too small so everything is super zoomed in and kind of ugly."

What a first visit drew:
- A desk with nothing saved was `defaultDesk()`: 584 x 236 (2.47:1), with the four apps (five with Files) as icons in one row.
- Arriving with one desk focuses it (`fitDesk`). The desk fit filled the screen up to `DESK_MAX_SCALE`, 1.75. At 1440 x 900 and 1920 x 1080 it stopped at 175 %, with 133 px icons.
- Platform's read-only copy of that account's layout shows the default's icons at their default places on a 781.96 x 402.12 frame: the member had resized the desk by hand within two minutes. No camera is kept on the server; it is per browser.

The owner's rule: "By default when a desk is first introduced I want it to be only 50% of a browser's width in a 16:9 layout. 4:3 and others are obviously different".

## Decisions

### 1. The rule: half a 16:9 screen's width, the same share of the area on any other shape
At 16:9 a desk first appears at 50 % of the viewport's width, centred. On any other shape it keeps the same visual weight, the same share of the viewport's area. For a desk of aspect a (its width over its height), at 16:9 that share is (W/2 · W/(2a)) / (W · 9W/16) = **4/(9a)**. Kept on a screen of W x H CSS px, the desk's width on screen is:

> **framed width = (2/3) · √(W · H)**

whatever the screen's shape (`framedDeskWidth` in `canvas/camera.ts`). At 16:9 that is exactly W/2. For the new desk (decision 3, a = 1.79) the share is 24.8 % of the screen.

| Screen (CSS px) | Framed width | Share of the width | Zoom |
|---|---|---|---|
| 1920 x 1080 (16:9) | 960 | 50.0 % | 112 % |
| 1440 x 900 (16:10) | 759 | 52.7 % | 88 % |
| 1024 x 768 (4:3) | 591 | 57.7 % | 69 % |
| 3440 x 1440 (21:9) | 1484 | 43.1 % | 173 % |
| 2880 x 1800 (16:10) | 1518 | 52.7 % | 176 % |

It is centred between the bars: across the width, and in the height between the top bar (72) and the bottom bar (64).

**Margins.** The fit's own: 48 desk units round the desk (48 px at 100 %), inside the bars. Where the rule's width doesn't fit inside them (a narrow screen), the desk fits inside them instead, as large as they allow. On the five screens above they never bind. A short screen has its own fit (decision 4).

**CSS pixels, so the browser's zoom doesn't enlarge it.** W and H are the viewport in CSS pixels, as "50% of a browser's width" means: at 150 % browser zoom a 1920-px-wide window is 1280 CSS px, and the desk is still half of it, the same on screen. That's consistent with the rule. To see a desk larger the member zooms the office's canvas (`+`, the wheel, a pinch, the zoom pill), and that zoom is kept (free mode).

### 2. When a desk is "first introduced"
A desk is as introduced while it is the size the office gives a new desk (`DEFAULT_DESK`, 860 x 480): `asIntroduced` in `canvas/layout.ts`. The office makes one in three ways, all through `freshDesk` (`reconcileLayout`):
- **A new member:** nothing saved, so every listed desk is new.
- **A desk added later** (a Work desk, a Guild Desk), at the next free spot.
- **The next member in the same browser:** the layout mirror is the last member's, so it is wiped (`layoutMirrorFor`, or at sign-out) and the new member's desks are new. The camera (`ma.camera.v1`) and the view's scope, desk and mode (`ma.view.v1`) are kept per device and survive a sign-out (ISS-67), so each is stamped with the member it was written for (`state/deviceOwner.ts`), and only while their id may be kept here, by the layout mirror's own guard (`layoutMirrorWritable()`, ISS-89). **No member's id outlives a sign-out** (ISS-67, ISS-89; `memberCaches.shell.spec.ts`): every signed-out state, and another account's sign-in, leave both keys in place, as the device's own, but stamped `false`, left at a sign-out, with no id (`unstampDeviceKeys`, from `forgetLayoutMirror`), and a page that may no longer keep the id (it signed out, another tab did, or another account owns the storage now) writes them so too (`deviceStamp`). A view or camera left so, or stamped for someone else, is nobody's to start on: the next member's arrival drops it (`forgetDeviceView`) and won't restore the camera (`takeSaved`), so their first desk is framed by the rule. The same member after a reload finds their own; after a sign-out they start as a first visit does too, since nothing left here may say who they were. A change of member inside a tab (a sign-in elsewhere in this browser) makes the new member's list's arrival an arrival again (`refit`). Nothing else in the account-change path changed: the owner key, `wasThis` and the era counter are as they were. (Nov 12: the first merge, `790d950c`, kept the id in both keys through a sign-out, which `memberCaches` caught; fixed by `sub/lsub-first-office-wipe`.)

The office has no "reset the layout" control, so there is no fourth way.

While a desk keeps that size, every framing of that desk alone follows the rule: arriving, a reload, a click or key that focuses it, Fit and `0`. So its first look doesn't jump at the next refit. Moving its apps around doesn't change that; the frame is about the desk. The overview never comes in closer than the rule while such a desk is in scope (min(100 %, the rule)), so zooming out never zooms in on a lone new desk.

A desk added later appears where the member is looking, as before: the office doesn't move the camera to it by itself. Focused, it is framed by the rule.

### 3. A saved layout doesn't move
Nothing saved changes size or place. A desk at any other size (the old 584 x 236 or 584 x 144 default, the test account's 781.96 x 402.12, anything a member resized) is a member's arrangement and is framed as before: it fills the screen inside the margins, up to 175 %. That keeps open tiles (ADR 0053) at the size on screen they had, so they stay live. Once a member resizes a new desk, it is theirs and framed the same way. The member's own zoom and pan (free mode) are kept and restored as before.

**The rule never stops a placed tile working.** An open tile goes live at 480 x 320 CSS px or more on screen (ADR 0053), and the rule's zoom can be under that: 88 % at 1440 x 900 makes a 536-wide tile 473 px. So when a tile on the desk in front newly reaches `open` and is too small to go live at the camera's zoom, the office frames that desk again once the member lets go (the drop, or the keyboard edit's end: `watchOpenTiles` in `shell/actions.ts`). The desk has grown past a new desk's size to hold it, so it's framed as any arranged desk, and the tile goes live with no Fit. Only in desk mode, where the office frames the desk; a free camera's zoom is the member's.

### 4. Phones and short screens keep their own fit
On a phone in portrait (a viewport under 600 px wide) a desk is the four-column cell grid (ADR 0062), whatever its saved size. Its framing fills the screen's width inside 16 px margins, up to 175 %, as before: about 90 % on a 390 x 844 phone, with 68 px tiles. A tile opens its app in the phone's carousel, unchanged.

A short screen (under 400 CSS px high, the bars' short-viewport mode: a phone on its side, or 400 % zoom) takes the phone's fit by height, not the rule: a new desk fills the room between the one-row bars (52 px above, 60 below) with the phone's 16-unit margin, up to 175 %. At 844 x 390 that's 54 %, 41 px tiles (the rule would give 33; `main`'s lower 584 x 236 desk had 58 at 2.47:1). The whole desk stays on screen and clear of the bars; tiles as large as `main`'s would need the phone's cell grid there, which is a larger change (the phone layout, the carousel, the thumb row) left as a question. A tablet is taller than 400 px and 600 px wide or more, so it takes the rule within the margins.

### 5. A new desk is 860 x 480
`DEFAULT_DESK` in `canvas/layout.ts` is 860 x 480, 1.79:1 (about 16:9), the proportions of a real desk's top. 860 is nine cells.
- With the rule it lands near 100 % on common laptop and desktop screens (the table above).
- Apps start as icons in a row along the top, where ADR 0062 put them. The free field under them takes a 4 x 4 widget without the desk growing.
- Only a desk with nothing saved gets it.
- A desk at an older first visit's size (584 x 236 or 584 x 144), untouched, still counts as untouched (`isUntouched`), so that browser sends nothing. It keeps its size and is framed as before.

## Consequences
- A new member's first office is a desk of natural proportions at half a 16:9 screen's width, at about 100 %.
- Every member's saved desks look as they did.
- Specs that focus a fixture or harness default desk now see the rule's zoom (88 % at the 1440 x 900 default), not 175 %.
- `firstOffice.shell.spec.ts` holds the rule at 1920 x 1080, 1440 x 900, 1024 x 768, 3440 x 1440, 2880 x 1800, 1440 x 900 at DPR 2, 390 x 844 and 844 x 390, a saved desk framed as before, the next member in the same browser, and an open tile on a new desk going live. `shell/framing.test.ts` holds the choices in unit form.
- ma-platform's fleet-mcp office tests read a new desk's 860 x 480 (a large tile fits; open needs `growDesk`).
