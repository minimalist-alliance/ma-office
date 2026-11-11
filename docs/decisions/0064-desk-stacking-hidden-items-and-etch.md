# 0064. Desks: apps can stack, a hidden count, and a deeper etch at constant size

**Status:** Accepted (the owner's second round on the real desk, 2026-11-05, relayed by the coordinator; design choices by the Product Designer)
**Date:** 2026-11-05
**Amends:** [0062](0062-desk-surface-etched-name-and-cleanup.md): the etch's look and size, the no-overlap rule for apps, the keyboard's overlap jump, "nothing shows in the strip at rest", and desks being able to overlap.

## Context
The owner: "I want the etched text to be more opaque and beveled in and not grow or shrink based on zoom. Forgot my rule about not being able to stack. I should be able to place items over each other. If an item becomes completely hidden and untouchable, at the bottom right we show a hidden icon with a number to indicate that there are hidden items. This icon doesn't appear if everything is visible. Those bottom right icons should be etched just like the desk name".

## Decision

### The etch
**Preview:** `docs/assets/desk-surface/etch-v2.png`: 2x above, 1x below enlarged, drawn in canvas 2D on each panel color, not in the app.

It's a cut, not an outline. Four steps, no blur, cached as one bitmap per string, theme and raster scale:
1. Draw the shape once in `highlight`, 1 px lower, on the panel. This is the cut's lit lower lip.
2. On a clear bitmap, draw the shape in `wall`. This is the shaded upper wall.
3. With `source-atop`, draw the shape again in `fill`, 1 px lower, so only the top band of `wall` stays visible.
4. Draw that bitmap on the panel.

| Token | Light | Dusk | Dark |
|---|---|---|---|
| `etch.fill` | `#70757D` | `#D2D6DB` | `#A6ACB6` |
| `etch.wall` (replaces `etch.top`) | `#3A3F47` | `#20242B` | `#050608` |
| `etch.highlight` (replaces `etch.bottom`) | `#FFFFFF` | `rgba(250,250,250,.30)` | `rgba(255,255,255,.22)` |
| Fill against the panel | 4.56:1 | 5.57:1 | 6.56:1 |

**Superseded by [ADR 0065](0065-apps-use-kit-colors-and-nunito.md):** these values were set against the old panels. `docs/assets/brand/ui/tokens.json` holds the final etch values.

The 1 px is a CSS pixel at every scale. On Light's nearly white panel the highlight barely shows, so the wall carries the depth there.

**Type:** Jost 600, up from 500, because the wall takes part of each stroke. Capitals, tracking 0.16 em.

**Constant size.** The name is 14 CSS px and the icons 16 CSS px at every zoom, with 28 px hit targets (44 on touch). They hang from the desk's bottom edge in screen pixels: the name is centered with its baseline 17 px up, and the icons sit at the right. Only their position follows the camera. Each bitmap no longer depends on zoom. The controller counter-scales those nodes from `controller.ts`, with no React render, and snaps them to whole device pixels at rest so the bevel stays crisp. `npm run perf` must still pass.

**The overview.** ADR 0062 doubled the name below full detail so desks could be told apart. A constant 14 px does the same job, because it grows relative to a small desk, so the doubling is retired.

**When there's no room,** nothing shrinks. In order:
1. The icons hide if the desk is under 290 px wide or 72 px tall on screen. This clears the way for the name in the overview.
2. The name ellipsizes if it would come within 12 px of the status line or any icons still showing, or of the desk's edges. It hides only when fewer than four characters would fit.

A strip that's shorter on screen than the text doesn't hide the name: it stays at its baseline and runs up onto the desk's surface. The etch is part of that surface, so apps draw over it.

### The bottom right icons
From the right, all in this etch: the resize grip, the hidden count, then cleanup's sparkle. Each has a fixed slot, so nothing slides when the pointer enters the desk. The grip's slot stays reserved at rest, and the sparkle appears to the left of the count. The grip and sparkle keep their rules for when they show: on hover or focus, and the sparkle only if cleanup would change something. They keep `surface.fill` behind them on hover. The hidden count shows at rest whenever it's above zero, and is gone at zero. Under the size limit above it hides with the other icons, and its proxy stays for assistive tech.

### Stacking
- **Anything can go over anything** on a desk. Apps and widgets move and resize freely within the work area, and a drop never moves another app. They still stay out of the 44-unit strip, so the name and icons can't be covered by a tile sitting in it.
- **Each desk keeps its own stacking order,** saved with the layout. Existing layouts start in reading order. A new app goes on top, at the first free spot if there is one.
- **Press to raise.** Pressing an app or widget brings it to the front, on press and before any drag, so what you grab is what moves. A click also opens it, as today.
- **Pressing takes the topmost item** under the pointer, and the pressed item is the one that stays in front.
- **Context menu:** Bring to front, Send to back.
- **Keyboard:**
  - Arrows in move mode no longer jump past other apps. They stop only at the edge of the work area.
  - Tab keeps reading order, not stacking order, so hidden items stay reachable.
  - An item that takes keyboard focus comes to the front, so the focus ring is never covered. As built, walking the arrows therefore reshuffles the stack and can change the hidden count. **Follow-up:** raise a focused item only while it has focus, restore it when focus leaves, and count from the saved order, so looking around doesn't rearrange a desk.
- **Depth:** normal tile elevation doesn't separate overlapping tiles: the build measured edges at about 1.2:1, and white on white in Light barely reads. So a tile that overlaps one below it, or is being dragged, uses `elevation.tileStacked` from `docs/assets/brand/ui/tokens.json`: a stronger shadow and edge. This includes Dusk, whose tiles are otherwise flat (ADR 0029), since an edge alone doesn't read there. It's worked out when the layout changes and cached as a bitmap variant, never per frame.

### Hidden items
- **Hidden means** the part of an item not covered by items above it has no area at least 12 by 12 units, so there's nothing left to press. Measured in units, so zoom doesn't change it, and worked out only when the layout changes, never per frame.
- **The icon** is two overlapping rounded squares with the number beside it, in Jost 600 with each digit in a fixed-width cell, since canvas text has no tabular digits. Digits are 16 px, like the icons. I chose this over a crossed-out eye because it's clearer in an etch this small and says these items are underneath, not switched off.
- **Accessible name:** "3 hidden apps on the Personal desk", mirrored in the proxy layer. Tooltip: "3 hidden". Count changes are announced politely, 800 ms late so they don't cut off "Desk cleaned up".
- **Click** opens a small list above the icon, using the normal menu style, not etched: each row is the app's icon and name, at most 6 rows before it scrolls. Choosing one brings it to the front, closes the list and rings the item for 600 ms so the eye finds it. The count doesn't always drop: raising a big item can hide another, and the count stays honest about that. The ring stays static under reduced motion. Enter opens, arrows move, Enter chooses, Esc closes. The list still opens for a single item, so the icon always does the same thing.

### Desks never overlap
The owner, asked whether desks can stack too: "No, never overlap". Stacking is only for apps and widgets on a desk. This replaces ADR 0062's and the design's "a desk goes where it's dropped". A moved or growing desk pushes its neighbors aside:
- **The desk in hand stays under the pointer,** and a grown desk's corner stays under the pointer. Neighbors move away along the shortest way out, cascading through chains. Nothing hops.
- **A neighbor's direction is chosen at first contact** and held for the rest of that drag.
- **Retreating brings neighbors back** during the same drag, because positions are worked out from where everything was when the drag began. On drop they stay. A mistaken drag doesn't scatter the office.
- **The gap between desks is at least 24 units,** one constant, matching a desk's inner padding. New desks are still placed 72 apart, so an office has room until someone chooses to pack it tighter.
- **Desks don't swap on the way past.** To swap two, push one aside and go round. It's predictable, and rearranging desks is rare. If the owner finds it awkward, a swap can be added later.
- **Everything that changes a desk's bounds follows this:** dragging, the corner, the keyboard's arrows and `r`, and cleanup when a desk grows. Cleanup's neighbors move with it over its 240 ms, and its Undo restores them. The camera doesn't move. Under reduced motion, timed moves are instant; moves during a drag still track the pointer.
- **A saved layout that overlaps loads clear,** by the smallest moves, before first paint.

### Cleanup
Cleanup still arranges with no overlap, as the owner told UI/UX. Its layout rules are unchanged. Now:
- Any overlap counts as something it would change, so the sparkle offers.
- The stacking order resets to reading order, and the hidden count goes to zero.
- Undo restores positions, the desk's size and the stacking order.

Phones keep the cell grid, with no free placement, so stacking and the hidden count don't apply.

## Alternatives rejected
- **Blur-based inner shadow:** a live blur breaks the no-blur rule, and cached it's still soft at this size.
- **Outer offset draws only, as in ADR 0062:** tried with stronger values. It reads as bold, not cut in.
- **Going straight to the item when one is hidden:** one fewer click, but an icon that sometimes acts and sometimes opens a list is harder to learn.

## Consequences
- `tokens.ts` renames two etch tokens. Jost 600 joins the bundle in place of 500.
- The layout stores stacking order alongside position and size. The layout document is opaque to Platform, so `PUT /v1/me/desk-layout` needs no contract change.
- **Not checked:** drawn in canvas 2D with placeholder glyphs, not in the app. Overlapping tiles and the list haven't been seen at all. The Light highlight is close to invisible, so Light may read as flatter than the others on some screens.
- The design doc needs §3 updated. Only the System Engineer writes that file and the ADR index.

## Amendment, 2026-11-08: the corner's order and icon
The owner: "On the bottom right of the desk, the hidden icon should be an eye with a slash. And the position of the cleanup button and the hidden button need to be swapped. Theres an awkward space between the cleanup icon and the triangle for resizing the desk."
- **The icon** is now an eye with a slash (`drawHiddenIcon`): a thick outline with a round pupil, the slash corner to corner with a clear gap either side, solid like the others so the cut doesn't eat it. This replaces the two squares chosen above.
- **The order,** from the right, is the grip, cleanup, then the hidden count (`slotRight`), each a gap from the next. The count sits next to whatever is on its right, so there's no empty slot inside the row, which was the awkward space. With a mouse, cleanup's slot is held whenever the desk needs cleaning up, at rest too, so nothing moves when the pointer enters the desk and brings the sparkle; on touch it's held only on the active desk, where the sparkle shows. "Undo" still grows left, and moves the count with it.
- **The arrows** reach the strip left to right as it's drawn: the count's proxy, then cleanup's.
- **The count's slot** is an icon's target plus 18 px for its number (`countSlotW`): 46 px with a mouse, as before, and 62 on touch, so a one-digit count is as far from cleanup as cleanup is from the grip.

## Amendment 2026-11-09: the etched name scales with the desk

The owner, Nov 9 about 10:55 pm MT: "The etched desk name is still growing relative to the desk. When I zoom out that text should get smaller". The constant on-screen size of the etched **name** is withdrawn. The name is part of the desk's surface: it is a fixed size relative to the desk at every zoom (14 px at 100 %, times the zoom, with its baseline `ETCH_BASELINE` times the zoom up from the foot) and it hides when it would be under 7 CSS px (`ETCH_MIN_PX`, `nameShows`), which is under about 50 % zoom. Its look, place at 100 %, wall, highlight and textures are unchanged. The fit (`fitName`) is made at 100 % zoom against the room on screen over the zoom. The bitmap is cached at the device scale, doubled each time the zoom passes a power of two above 100 % (`nameRaster`), and scaled when drawn, so a wheel tick makes no new bitmap. The owner then, Nov 9 about 11:05 pm MT: "Same thing with the etched icons". So the **bottom-right etched icons, the cleanup and Undo control and the hidden count scale with the desk the same way**: every size, gap and offset in the strip (`STRIP`, `ETCH_ICON`, `slotRight`, `stripTarget`) is for 100 % and is multiplied by the zoom, and they hide with the name under 50 % zoom (an icon under 7 CSS px). Their hit boxes and keyboard proxies are in desk units, so a press target is its drawn size at every zoom and is 28 px (44 on touch) at 100 %; where they show, they stay clickable. The corner inset is gone, since the icons and the corner scale together. They use the same scaled cached bitmaps. The trackpad-pinch fix stays.

