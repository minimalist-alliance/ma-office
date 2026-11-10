# 0062. The desk's surface: etched name, cleanup, and nothing else unless there's a problem

**Status:** Accepted (the owner's feedback on the real desk, 2026-11-05; design choices by the Product Designer)
**Date:** 2026-11-05
**Partly replaced by:** [0064](0064-desk-stacking-hidden-items-and-etch.md): the etch's look and size, the no-overlap rule, the keyboard's overlap jump, and "nothing shows in the strip at rest". Where they differ, 0064 wins.
**Amends:** [0003](0003-canvas-interaction-model.md) (cell-grid desks, Arrange mode), design §3.3, §3.4, §3.5, §3.7

## Context
The owner, on the real desk:
- "Wherever product designer thinks, we should put a small magic cleanup button that reorganizes the desk without shrinking things. Obviously apps can't overlap each other..."
- "I don't like the text "Personal" above the desk. There must be an elegant way to "etch" that into the desk."
- "We should only show something on the desk if there's a problem". Also: app icons are freely resizable and movable, and growing a desk doesn't snap.

## Decision

### The desk's surface
- A desk is a work area above a **44-unit strip** along its bottom edge. Apps stay in the work area, so they can never cover the name or the controls.
- Top padding can drop from 40 to 24, matching the sides, since nothing sits there now.
- Nothing shows in the strip at rest except the name.

### Etched name
Preview: `docs/assets/desk-surface/etched-name-and-cleanup.png`. The name goes where a laptop's maker engraves its name: bottom center. It replaces the label above the desk.

- **Type:** the desk's name in capitals, Jost 500, 14 units, tracking 0.16 em, centered in the strip with its baseline 17 up from the desk's bottom edge. Jost matches the full logo (ADR 0061), and spaced capitals read as engraving. Names Jost can't draw fall back to the app font. Self-host it (free, SIL Open Font License).
- **Depth:** three draws with no blur: top edge at y−1, bottom edge at y+1, then the fill at y. On a light surface the cut reads darker; on dark ones it reads lighter, as a laser mark on anodized metal does.

| Token | Light | Dusk | Dark |
|---|---|---|---|
| `etch.fill` | `#8E929A` | `#A9AEB6` | `#737983` |
| `etch.top` | `rgba(20,30,50,.30)` | `rgba(20,24,30,.60)` | `rgba(0,0,0,.70)` |
| `etch.bottom` | `#FFFFFF` | `rgba(250,250,250,.10)`, since ADR 0050 rejects pure white in Dusk | `rgba(255,255,255,.08)` |
| Fill against the panel | 3.07:1 | 3.65:1 | 3.42:1 |

- **Legibility:** the fill clears 3:1 in every theme. That meets WCAG's large-text bar only if treated as large text, which 14 units is not, so the name must also stay in the proxy layer as the desk's accessible name. With `prefers-contrast: more`, use `text.secondary` with no edges.
- **No state changes.** The name looks the same whether or not the desk has focus. The ring already shows focus.
- **Rendering:** a small cached bitmap per name, theme, size and raster scale, blitted at the strip's center, so it costs no blur and no per-frame text.
- **Zoomed out:** below full detail, draw it at twice the size, switching when the camera settles, as `lod-text` does. This is how desks are told apart in the overview.
- **Long names:** ellipsis at the strip's width minus 64 at each side.

### Cleanup button
- **Where:** in the strip, just left of the resize grip. It's on the desk it acts on, and the strip is the one place an app can't be under it.
- **When:** only while the pointer is over that desk or the desk has focus, and only if cleanup would change something. On a tidy desk it isn't there. Touch: while the desk is focused. Also in the desk's context menu and, when built, the palette: "Clean up desk".
- **Look:** a 28-unit ghost button (44 on touch) with a small sparkle glyph in `text.secondary`, `surface.fill` behind it on hover, tooltip "Clean up", accessible name "Clean up ‹desk› desk", mirrored in the proxy layer.
- **What it does:**
  1. Takes the apps in reading order of where they are now, top then left, so what was near stays near.
  2. Places each at the top-left-most free spot in the work area, 16 between apps and 24 from the edges.
  3. Keeps every app's width and height exactly. **Never shrinks.** No overlap, by construction.
  4. Keeps the desk's size. If the apps need more room, the desk grows downward. It never gets smaller. It pushes any desk below it aside (ADR 0064).
  5. Moves all the apps together over 240 ms with the standard ease; instantly under reduced motion. App windows and the camera stay put, including when the desk grows.
- **Undo:** yes. The button becomes "Undo" for 10 s, and "Undo clean up" stays in the context menu until the next change on that desk. One level, restoring every position and the desk's size exactly. Not kept across a reload.
- **Announce:** "Desk cleaned up", through the live region.
- **Tests:** no overlap; every size unchanged; running it twice changes nothing; undo restores exactly.
- **Phones:** none. Phones keep the cell grid (see the follow-up decisions below).

### Only show something if there's a problem
The status line appears in the strip, at the left, only for these. If it would touch the name, the name hides until the problem clears.

| Shown | Hidden |
|---|---|
| waiting for capacity, waking, connecting (after 2 s, so it doesn't flash) | asleep, including the Give Back wording |
| reconnecting, can't reach desk | agent online |
| going to sleep · countdown | working · task |
| couldn't wake · Retry | no key |
| needs you, paused · limit reached, agent error | |

This split is the Product Designer's reading of "a problem". Waiting states stay because the desk can't be used yet and a click would otherwise seem dead; a warning about going to sleep stays because the member can still act. Hidden information can live on the Agent tile or in "About this desk".

### Free placement
Per the owner, apps are freely movable and resizable, with no overlap, and a desk resizes without snapping. An overlapping drop moves to the nearest free spot. This replaces the cell grid and first-fit reflow on larger screens, the four fixed sizes as the only choices, and Arrange as a separate mode (which was never built). Widget content picks its detail from the app's size.

## Follow-up decisions (2026-11-05)
1. **Detail levels.** An app shows the largest level that fits in both directions: small from 168 x 168, wide from 352 x 168, large from 352 x 352. Below small it's an icon. These are the old cell sizes (two cells is 168, four is 352).
2. **Minimum app size:** 56 x 56, so the glyph and pointer target stay usable.
3. **The 2 s delay** applies to `connecting` only. Waiting and waking show at once, as the design promises.
4. **Phones** keep the cell grid, with no free placement and no cleanup.
5. **Add and remove:** the `−` and `+` controls are unchanged.
6. **Keyboard moving and resizing.** Required before apps become movable for real, since dragging needs a keyboard alternative.
   - On a focused app, press `m` to move or `r` to resize, or choose Move or Resize from its context menu (`.` or the menu key).
   - Arrows change it by 8 units; Shift+arrows by 40. Enter keeps the change; Esc restores where it started.
   - An arrow that would cause an overlap jumps past that app to the next free spot in that direction. At the edge of the work area it stops.
   - Each step announces through the live region: the position or size after moving, or "Can't go further".
   - A focused desk uses the same pattern: arrows already move it, and `r` resizes it.
   - Cleanup is reachable from the desk's context menu, and the button is in the proxy layer.
   - These use single keys and a mode because Alt+arrows and Mod+arrows are browser back and forward on some systems, and plain arrows already cycle desks. Single keys act only while an app or desk on the canvas has focus, never inside an app window.
7. **Default desk:** 584 wide and 236 tall: six reference tiles wide, 24 padding at the top and sides, 168 of work height, then the 44 strip. Apps start in one row at the top, with a free band under them. Apps may reach the strip's top edge. This replaces 144 tall, found in the build to leave apps only 16 units of vertical room: by mouse they could only slide sideways and couldn't pass each other, and no app could reach widget height. Moving and resizing freely is what the owner asked for, so a fresh desk has to allow it without resizing the desk first. A desk someone has already sized keeps its size.
8. **Provider marks.** When the strip shows an agent's status (needs you, paused, agent error), that agent's provider mark sits beside it, since the vision asks for the mark on every agent. Otherwise marks stay on the Agent tile and widgets.
9. **Cleanup motion:** apps move together for 240 ms and may cross on the way, by up to 68 units, when reading order changes. The no-overlap rule covers apps at rest. A stagger wouldn't stop them crossing, and a fade would lose where each app went.
10. **Smallest desk:** 232 wide, so every status line fits.

## Consequences
- The layout must store each app's position and size, and the desk's size in units rather than cells. Contract `PUT /v1/me/desk-layout` needs that when layout sync is connected (Platform and UI/UX). Until then the layout is per browser.
- Jost joins the Desk app's bundle for this one use; the app's UI font is still open (ADR 0060).
- Sharing the etch's tokens with `tokens.ts` keeps the no-literals rule.
- The design doc needs §1 (glossary), §3.1, §3.3, §3.4, §3.5, §3.7 and §3.8 updated. Only the System Engineer writes that file, so the edits go through them.
