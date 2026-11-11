package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * The Browser's RPCs: the fixed set of things a client can ask of it. API.md has the table. Each that can reach Chromium
 * is work while it runs, and thaws Chromium first ({@link BrowserFreeze#use}), and a {@code live} thaws it too.
 */
final class BrowserMethods {

    /** Past any sum of steps. Clients have their own deadline; this is so no call can park for ever. */
    private static final Duration STREAM_WAIT = Duration.ofMinutes(3);
    /** How long a {@code live} waits for a thaw before it goes on regardless: the units' steps thaw it too. */
    private static final Duration STREAM_THAW_WAIT = Duration.ofSeconds(10);
    private static final String CHROMIUM_OLDER_THAN_PROFILE = "chromium_older_than_profile";
    private static final String BANDWIDTH_LIMIT = "bandwidth_limit";
    private static final String AGE_BAND = "age_band";

    private static final String MOVED = "moved";

    private final BrowserStream stream;
    private final BrowserTabs tabs;
    private final BrowserFreeze freeze;
    /** When a move kept the Browser held (data.browser.keep), or null. Takes no lock. */
    private final Supplier<Instant> movedSince;

    BrowserMethods(BrowserStream stream, BrowserTabs tabs, BrowserFreeze freeze, Supplier<Instant> movedSince) {
        this.stream = stream;
        this.tabs = tabs;
        this.freeze = freeze;
        this.movedSince = movedSince;
    }

    void register(RpcDispatcher dispatcher) {
        // No idem: setting a state twice is harmless, and the last one wins.
        dispatcher.register("browser.stream.set", this::streamSet);
        dispatcher.register("browser.tab.list", working(this::tabList));
        dispatcher.registerMutation("browser.tab.navigate", working(this::tabNavigate));
        dispatcher.registerMutation("browser.tab.back", working(onTab(tabs::back, false)));
        dispatcher.registerMutation("browser.tab.forward", working(onTab(tabs::forward, false)));
        dispatcher.registerMutation("browser.tab.reload", working(onTab(tabs::reload, false)));
        dispatcher.registerMutation("browser.tab.activate", working(onTab(tabs::activate, true)));
        dispatcher.registerMutation("browser.tab.open", working(this::tabOpen));
        dispatcher.registerMutation("browser.tab.close", working(this::tabClose));
        dispatcher.registerMutation("browser.text.insert", working(this::textInsert));
    }

    /** Work while it runs, with Chromium thawed first. A thaw that doesn't come leaves the call to find it unreachable. */
    static RpcHandler working(BrowserFreeze freeze, RpcHandler handler) {
        return (context, params) -> {
            try (BrowserFreeze.Use use = freeze.use()) {
                return handler.handle(context, params);
            }
        };
    }

    private RpcHandler working(RpcHandler handler) {
        return working(freeze, handler);
    }

    @FunctionalInterface
    private interface TabAction {
        String on(RpcContext context, String tabId) throws Exception;
    }

    private static RpcHandler onTab(TabAction action, boolean tabRequired) {
        return (context, params) -> {
            requireInput(context);
            return Map.of("tabId", action.on(context, tabRequired ? requiredTab(params) : optionalTab(params)));
        };
    }

    private Object tabList(RpcContext context, Map<String, Object> params) throws Exception {
        requireVideo(context);
        return Map.of("tabs", tabs.list());
    }

    private Object tabNavigate(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        String url = Json.string(params, "url");
        if (url == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "url must be a string", Map.of("reason", "url"));
        }
        // Before anything else: nothing here depends on a tab or on Chromium being up.
        return tabs.navigate(context, optionalTab(params), BrowserUrl.parse(url));
    }

    private Object tabOpen(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        Object url = params.get("url");
        if (url != null && !(url instanceof String)) {
            throw new RpcException(RpcException.BAD_REQUEST, "url must be a string", Map.of("reason", "url"));
        }
        return Map.of("tabId", tabs.open(context, url == null ? null : BrowserUrl.parse((String) url)));
    }

    private Object tabClose(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        tabs.closeTab(context, requiredTab(params));
        return Map.of();
    }

    private Object textInsert(RpcContext context, Map<String, Object> params) throws Exception {
        requireInput(context);
        String text = Json.string(params, "text");
        if (text == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "text must be a string", Map.of("reason", "text"));
        }
        if (text.length() > BrowserTabs.MAX_INSERT_CHARS) {
            throw new RpcException(RpcException.TOO_LARGE, "Text too long", Map.of("limit", BrowserTabs.MAX_INSERT_CHARS));
        }
        String tabId = optionalTab(params);
        if (!text.isEmpty()) {
            tabs.insertText(context, tabId, TabText.insertable(text));
        }
        return Map.of();
    }

    /** @return null if left out, which means the active tab */
    private static String optionalTab(Map<String, Object> params) throws RpcException {
        Object tabId = params.get("tabId");
        if (tabId != null && !(tabId instanceof String)) {
            throw new RpcException(RpcException.BAD_REQUEST, "tabId must be a string", Map.of("reason", "tabId"));
        }
        return (String) tabId;
    }

    private static String requiredTab(Map<String, Object> params) throws RpcException {
        String tabId = optionalTab(params);
        if (tabId == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "tabId is required", Map.of("reason", "tabId"));
        }
        return tabId;
    }

    private static void requireVideo(RpcContext context) throws RpcException {
        if (!context.principal().video()) {
            throw forbidden();
        }
    }

    private static void requireInput(RpcContext context) throws RpcException {
        if (!context.principal().input()) {
            throw forbidden();
        }
    }

    private Object streamSet(RpcContext context, Map<String, Object> params) throws Exception {
        BrowserStream.Level level = BrowserStream.Level.parse(Json.string(params, "state"));
        if (level == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "state must be live, warm or off", Map.of("reason", "state"));
        }
        if (level == BrowserStream.Level.LIVE && !context.principal().video()) {
            throw forbidden();
        }
        if (level == BrowserStream.Level.LIVE) {
            // The picture is X's, and a frozen Chromium's last frame is a real one, but input and the page aren't.
            freeze.awaitThawed(STREAM_THAW_WAIT);
        }
        try {
            BrowserStream.Level result = stream.set(context.principal().sessionId(), level, context.arrival())
                    .get(STREAM_WAIT.toMillis(), TimeUnit.MILLISECONDS);
            return Map.of("state", result.wire());
        } catch (TimeoutException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The stream didn't settle", Map.of());
        } catch (ExecutionException e) {
            if (e.getCause() instanceof UnitException failure && failure.isTimeUsed()) {
                throw timeUsed(failure.resetsAt());
            }
            if (e.getCause() instanceof UnitException failure && failure.isPaused()) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("reason", BANDWIDTH_LIMIT);
                details.put("resumesAt", failure.resumesAt());
                throw new RpcException(RpcException.UNAVAILABLE, "The Browser is paused at the bandwidth limit", details);
            }
            if (e.getCause() instanceof UnitException failure && failure.isHeld()) {
                // A move's kept hold lasts until the owner lets go, so a client should ask them rather than try again.
                Instant moved = movedSince.get();
                if (moved != null) {
                    throw new RpcException(
                            RpcException.UNAVAILABLE, "The Browser was moved to another desk", Map.of("reason", MOVED, "since", moved.toString()));
                }
                throw new RpcException(RpcException.UNAVAILABLE, "The Browser is held for a copy", Map.of("reason", "held"));
            }
            if (e.getCause() instanceof UnitException failure && failure.isAgeBand()) {
                throw new RpcException(RpcException.UNAVAILABLE, "The Browser is waiting for the desk's settings", Map.of("reason", AGE_BAND));
            }
            if (e.getCause() instanceof UnitException failure) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("unit", failure.unit());
                details.put("code", failure.code());
                if (failure.browserRefused()) {
                    details.put("reason", CHROMIUM_OLDER_THAN_PROFILE);
                }
                throw new RpcException(RpcException.UNAVAILABLE, "A unit failed", details);
            }
            throw e;
        }
    }

    /**
     * Today's Browser time is used up on this free desk (ADR 0090): the bandwidth pause's refusal, so every Desk app pauses
     * as it does for that, with {@code limit} to tell the two apart and {@code resumesAt} the member's next midnight.
     */
    static RpcException timeUsed(String resetsAt) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", BANDWIDTH_LIMIT);
        details.put("resumesAt", resetsAt);
        details.put("limit", UnitException.BROWSER_TIME);
        return new RpcException(RpcException.UNAVAILABLE, "Today's Browser time is used up", details);
    }

    static RpcException forbidden() {
        return new RpcException(RpcException.FORBIDDEN, "The token doesn't allow this", Map.of("reason", "permission"));
    }
}
