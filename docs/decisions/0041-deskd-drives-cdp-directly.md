# 0041. deskd drives CDP directly

**Status:** Accepted
**Date:** 2026-11-05
**Amends:** [0009](0009-browser-process-model.md), for the Spring Boot rule of [0040](0040-desk-services-spring-boot-docker.md)

## Context
- ADR 0009 has `deskd` attach to Chromium with Playwright's `connectOverCDP`. ADR 0040 makes `deskd` Java, where Playwright runs a bundled Node, and rules that out for footprint.
- Milestone 2 needs a member to see and drive a real browser. That takes a small fixed set of tab operations, not an automation framework.
- Titles and URLs come from web content. Chromium's debugging port can do anything to the member's logged-in browser, so no client may ever reach it.

## Decision
- **No Playwright.** `deskd` speaks CDP itself, on the JDK's HTTP and WebSocket client, with no new dependency.
- **One connection:** the browser-level WebSocket from `GET /json/version`, with flat sessions (`Target.attachToTarget {flatten: true}`) for pages. It sends no `Origin`, which is what lets it through without `--remote-allow-origins`.
- **Three reads of Chromium's own, besides the commands.** `GET /json/version` gives the WebSocket's path, and only the path: the host and port stay the loopback ones `deskd` was told. `GET /json/list` gives only which tab was shown last, as no event does (Consequences); titles and URLs come raw from `Target.getTargets`, because `/json/list` HTML-escapes titles. And one constant script, `document.visibilityState`, runs through `Runtime.evaluate` in an isolated world of `deskd`'s own, which a page can't reach, to tell which tab is on screen when the list's order can't.
- **The RPCs are the only door.** `browser.tab.*`, `browser.text.insert` and the `browser.tabs` topic (`services/deskd/docs/API.md` §10) are the whole surface. None takes a CDP method, a script or a target id it hasn't found in its own model. **No client input ever reaches a script:** the one script is a constant, and what a client types goes through `Input.insertText`, as text. `deskd` checks URLs itself: `http` and `https` only.
- **It checks who it's talking to.** `nftables` limits who connects to `127.0.0.1:9222`, not who binds it, so while Chromium is down any local user could listen there, show false tabs and hear what a client types. Before each request to the port, and again as soon as a WebSocket is open and before anything goes over it, `deskd` reads the listener's uid from `/proc/net/tcp` and `/proc/net/tcp6`, on the host's network namespace as the container uses host networking, and the uid of anyone holding a connection accepted on the port. It has to be `DESKD_CDP_UID`, by default 1102 (`kiosk`, `desk-runtime.md` section 1). Any other uid gets no request, one log line with the uid, `cdp: refused` in `/health`, and `unavailable` for calls. If the table can't be read, nothing connects. If `kiosk` is only on `::1`, because `127.0.0.1` was taken when Chromium started, `deskd` restarts it to give it the port, at most every 5 minutes, since it won't go to an address `nftables` doesn't cover.
- **Kiosk Chromium stays a native unit,** as in 0009 and 0040. `deskd` only attaches. It never launches or stops Chromium through CDP, and restarting `deskd` disturbs nothing in it. `desk-browser` starts through `units.sock`, and `deskd` restarts it that way, at most every 5 minutes, only if it came up on `::1` because something held `127.0.0.1:9222` and that address is free again.
- **The connection exists only while wanted:** a viewer, a `browser.tabs` subscriber, or a call in the last minute. An idle desk has no socket, thread or timer for it.

## Consequences
- **Less fidelity than Playwright gives, and more of it to carry:** navigation waits, frame trees and locators aren't there. Agent tools (ADR 0018) and minified mode (ADR 0030) will need their own CDP code, or a decision to bring something in. Each is a later decision.
- **CDP is an unstable protocol,** so a new Debian Chromium can break this. `ChromiumIT` runs against a real binary when one is named, and is to be run on each new one.
- **CDP has no event for a title changing or a tab becoming active.** `deskd` reads `Target.getTargets` for titles and `/json/list` for the order, which is cheap but isn't quite instant (API.md §10). The list's order can't say which tab is on screen, since a tab opened in the background comes first while hidden, hence the one script. If a page doesn't answer it, a call with no `tabId` gets `unavailable` rather than guess.
- **A uid isn't a program.** The check can't tell Chromium from another `kiosk` process, such as Xorg or PulseAudio. Between a read of the table and the connect there's a moment in which the port could change hands: a connection can't be kept that way, as whoever accepted it stays in the table under their uid, and a single request in that moment sends nothing that matters. `services/CLAUDE.md`, Known gaps, has the details. A process holding the port can still deny the Browser.
- **The rest of 0009 stands:** sandbox on, `nftables` keeping the port to uid `desk` and root, and tabs surviving through session restore. Agent browsing in its own `BrowserContext` isn't built.
- **Alternatives:** Playwright for Java (bundles Node, ruled out by 0040); a third-party Java CDP library (more than the job needs, and another thing that has to track Chromium).
