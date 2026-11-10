# 0003. Canvas interaction model: scope filter, cell-grid desks, per-desk windows, Arrange mode

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Note, 2026-11-09:** [ADR 0062](0062-desk-surface-etched-name-and-cleanup.md) amends the cell-grid desks and Arrange mode below: on a computer a desk has a size of its own and its apps have positions and sizes (`web/src/canvas/layout.ts`); only phones keep the first-fit cell grid (pitch 92). The decision text is kept as written. Not confirmed against the code: "up to 4 windows per desk" and "the 3 most recent desks keep their windows mounted" (`windows/WindowLayer.tsx` keeps every parked window mounted and the store shows no limit).

## Context
- The vision: click a desk to zoom, center and focus it; cycle through desks; resize desks; shrink or enlarge apps "like apps vs widgets on iOS"; open apps in a modal; no mandatory apps. Compartmentalization and anti-stress come first.
- The mockup shows a Personal / Work / All switcher, but it is ambiguous: Work is selected while Personal is still visible.
- Apps can't move between desks without moving data between VMs. Phones need a different column count than desktops.

## Decision
- **Scopes are filters over stable desk positions.** Personal / Work / Guild / All (plus up to 3 pinned custom desks and a `⋯` overflow) decide which desks render, hit-test and badge. The camera fits what remains; desks never move. Cross-scope activity is only a dot on a segment. The Guild segment shows only while the member has a Guild desk. The owner confirms filter vs focus (design Q6).
- **Desks are cell grids** (pitch 92 = 76 tile + 16 gap). Items are an ordered list of `{app, size}` with size icon 1×1, small 2×2, wide 4×2 or large 4×4. Positions come from first-fit packing and are never stored; desks grow to fit; an item too wide renders at the next smaller size.
- **App windows are screen-space React DOM**, in window or full mode, grouped into a window set per desk that is parked when another desk becomes active. Up to 4 per desk. Shift+Esc always leaves a window.
- **Explicit Arrange mode** (Done/Cancel) is the only way to move or resize desks and items. Items can't be dragged between desks.
- **Keyboard model within browser limits:** single keys outside editable fields (`[` `]`, arrows, 1–9, Enter, Esc), Mod+K palette, `\` privacy shield, Keyboard Lock in Chromium full screen, and a visible control for every Esc action.

## Consequences
- One layout works at any width; reflow is deterministic.
- Switching desks switches workspaces; parked Browser streams pause; the 3 most recent desks keep their windows mounted.
- Panning and clicking are never ambiguous, and Cancel is a free undo.
- Alternatives rejected: a focus-only switcher (leaks Personal badges into Work, doesn't scale to custom desks); freeform item placement (breaks on resize and phones); windows that zoom with the canvas (blurry text, broken IME and accessibility); always-on direct manipulation.

## Amendment 2026-11-09: a click outside moves the camera only from a desk in focus
The owner: with one desk, every click on the empty office re-centered and re-zoomed it, because arriving with one desk focuses it and the click went to the overview from desk mode and from `free`. He wants that only when a desk is focused: he clicked it, or zoomed in enough that it's plainly the focus.
- **A desk is in focus** when the member focused it (a click or tap on it, a key, a Maia card, a link), or when the camera is zoomed in on it by hand: at least `FOCUS_ZOOM` (1.1) times the scale focusing it gives, with the desk under the middle of the screen (`zoomedInOn` in `web/src/canvas/camera.ts`). Focusing lands on exactly 1, so one wheel notch or one `+` in from there counts, and a pan or a zoom out never does. The zoom is measured against the desk's own focus scale, not the screen it fills, so it reads the same at any window size and desk size.
- **Not focused by the member:** a desk the office focused for them, on arriving (with one desk, or desk mode kept from the last visit) and with a scope or the Fit button when the scope has one desk. These still fill the screen and still wake the desk.
- **A click on empty background** goes to the overview from a desk in focus, as before, still held by an open window. From any other view it does nothing, with one desk or several. Esc, the breadcrumb, Fit, the keys, pans, the wheel and pinches are unchanged.
- **Consequences:** a member's own pan or zoom is never undone by a stray click. Leaving a desk the office focused takes Esc, the breadcrumb or a click on the desk first. "Chosen" isn't kept across a reload, so a reload counts as arriving.
