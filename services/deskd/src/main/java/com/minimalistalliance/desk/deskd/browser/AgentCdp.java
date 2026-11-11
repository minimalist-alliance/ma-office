package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.browser.minified.AgentView;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * <b>The CDP allow-list for the Agent</b> (draft ADR "the Agent's tools and approvals", section 5; Security's ask): every
 * command deskd sends on an Agent path goes through {@link #send} here, and nowhere else. That's the run's own
 * off-the-record context and its tabs, the tab in the member's own session, and the walker and the action proxy while
 * they act for the Agent ({@code browser/minified}'s {@code AgentView}, through {@link AgentBrowsing}'s tab access).
 *
 * <p><b>What it never holds.</b> No method that clears or writes storage, cookies, cache or history: no {@code Storage.*},
 * no {@code Network.*} at all (so no {@code Network.clearBrowserCookies}, {@code Network.clearBrowserCache},
 * {@code Network.deleteCookies} or {@code Network.setCookie(s)}), no {@code DOMStorage.*}, {@code IndexedDB.*} or
 * {@code CacheStorage.*}, no {@code Page.resetNavigationHistory}, no {@code Browser.reset*}. {@code AgentCdpTest} pins
 * {@link #ALLOWED} exactly, so adding a method means editing that test, and fails if any member matches a pattern of a
 * cookie, storage, cache or history writer. The member's profile is never cleared or changed by deskd (ADR 0035):
 * browsing in their session adds history and cookies as their own browsing would, and nothing is removed.
 *
 * <p><b>What a method can't say</b> ({@link #check}, S-14). {@code Runtime.evaluate} and {@code Runtime.callFunctionOn}
 * run script, which in principle could do anything a page can, so here they carry only deskd's own constants
 * ({@link Scope#script}: the walker's and the action proxy's, {@code Scripts} and {@code PageWorld}'s), and only into a
 * world deskd made ({@code Page.createIsolatedWorld} named {@link AgentView#WORLD}, its context learned from the reply on
 * that same session): never an {@code objectId}, so never the page's own world, and never a function or an expression a
 * model, a client or a page wrote. What a model chose (a ref, typed text, a key) goes only as a call's JSON argument.
 * {@code Page.addScriptToEvaluateOnNewDocument} likewise takes only deskd's own script and deskd's world's name, never the
 * main world's. No trusted input: no {@code Input.dispatchMouseEvent} or {@code Input.dispatchKeyEvent}, which never
 * reach a hidden tab on a desk's Chromium anyway; the Agent's clicks and keys are deskd's half's own (ActionProxy).
 * Typing is {@code Input.insertText}, whose text is a parameter, never script.
 *
 * <p><b>Where a method may go</b> ({@link Scope}). A session's command only to a session of the Agent's own: one of its
 * tabs, or a frame Chromium attached under one. The browser itself only for {@link #BROWSER_LEVEL}, and each of those only
 * with what the Agent made: a target is created {@code hidden} and in the background, in an Agent context or the member's
 * own; a target is attached, closed, or asked for its title or window only if it's the Agent's; a context is disposed of, or has its
 * downloads set, only if it's the Agent's, and its downloads only to {@code deny}; a context is made only to go when the
 * connection does. So no command here can touch a member's tab, the member's context, or the member's downloads.
 */
public final class AgentCdp {

    /** Every CDP method an Agent path may send. A test pins this set: see the class's comment before adding to it. */
    public static final Set<String> ALLOWED = Set.of(
            // The run's own off-the-record context and its hidden targets, and the tab in the member's session.
            "Target.createBrowserContext",
            "Target.disposeBrowserContext",
            "Target.createTarget",
            "Target.closeTarget",
            "Target.attachToTarget",
            "Target.getTargets",
            "Target.getTargetInfo",
            "Target.setAutoAttach",
            // A frame that isn't a web page's (an extension's menu) let go by the walker: only a frame of the Agent's own.
            "Target.detachFromTarget",
            "Browser.setDownloadBehavior",
            "Browser.getWindowForTarget",
            // A tab's page, its viewport and its navigation, forward and back. Nothing that rewrites history.
            "Page.enable",
            "Page.navigate",
            "Page.getNavigationHistory",
            "Page.navigateToHistoryEntry",
            "Page.getFrameTree",
            "Emulation.setDeviceMetricsOverride",
            "Emulation.setFocusEmulationEnabled",
            // Its document requests: an off-site navigation in the member's session cancelled, a local host refused.
            "Fetch.enable",
            "Fetch.continueRequest",
            "Fetch.failRequest",
            // The walker and the action proxy, in deskd's own isolated world, with deskd's own constants only.
            "Page.createIsolatedWorld",
            "Page.addScriptToEvaluateOnNewDocument",
            "Page.removeScriptToEvaluateOnNewDocument",
            "Runtime.callFunctionOn",
            "Runtime.evaluate",
            "Runtime.releaseObject",
            "Runtime.runIfWaitingForDebugger",
            "DOM.describeNode",
            "DOM.getBoxModel",
            "DOM.getFrameOwner",
            // Typing: the text is a parameter. No trusted mouse or key input ever goes on an Agent path.
            "Input.insertText");

    /** Of {@link #ALLOWED}, the ones sent to the browser itself, with no session. */
    public static final Set<String> BROWSER_LEVEL = Set.of(
            "Target.createBrowserContext",
            "Target.disposeBrowserContext",
            "Target.createTarget",
            "Target.closeTarget",
            "Target.attachToTarget",
            "Target.getTargets",
            "Target.getTargetInfo",
            "Browser.setDownloadBehavior",
            "Browser.getWindowForTarget");

    /** deskd itself tried to send what the Agent's paths never send: a bug, refused before anything goes out. */
    public static final class NotAllowed extends IllegalStateException {
        private static final long serialVersionUID = 1L;

        NotAllowed(String method) {
            // The method's name only: it's deskd's own constant, never content.
            super("not on the agent's CDP allow-list: " + method);
        }
    }

    /** What's the Agent's own. Must not block: it's asked before every command. */
    public interface Scope {
        /** A session of one of its tabs, or of a frame Chromium attached under one. */
        boolean session(String sessionId);

        /** One of its targets: a tab of a run, or one a tab opened that's being closed. */
        boolean target(String targetId);

        /** One of its off-the-record contexts. */
        boolean context(String contextId);

        /** A world deskd made on this session ({@code Page.createIsolatedWorld}), by its execution context. */
        default boolean world(String sessionId, Number contextId) {
            return false;
        }

        /** One of deskd's own scripts or functions for its world, and nothing a model, a client or a page wrote. */
        default boolean script(String source) {
            return false;
        }
    }

    /** Worlds learned at once, past which the oldest is forgotten: a world goes with its document anyway. */
    static final int WORLDS = 8192;

    private final CdpClient cdp;
    private final Scope scope;
    /** {@code session|context} of each world deskd made, from Chromium's replies; access-ordered, at most {@link #WORLDS}. */
    private final Map<String, Boolean> worlds = new LinkedHashMap<>(64, 0.75f, true) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > WORLDS;
        }
    };

    AgentCdp(CdpClient cdp, Scope scope) {
        this.cdp = cdp;
        Scope outer = scope;
        this.scope = new Scope() {
            @Override
            public boolean session(String sessionId) {
                return outer.session(sessionId);
            }

            @Override
            public boolean target(String targetId) {
                return outer.target(targetId);
            }

            @Override
            public boolean context(String contextId) {
                return outer.context(contextId);
            }

            @Override
            public boolean world(String sessionId, Number contextId) {
                synchronized (worlds) {
                    return worlds.get(worldKey(sessionId, contextId)) != null;
                }
            }

            @Override
            public boolean script(String source) {
                return outer.script(source);
            }
        };
    }

    /**
     * The one check: on the list; to a session of the Agent's, or to the browser for a browser-level method; and a
     * browser-level method only with what's the Agent's ({@link Scope}).
     *
     * @throws NotAllowed otherwise, with nothing sent
     */
    public static void check(String sessionId, String method, Map<String, Object> params, Scope scope) {
        if (method == null || !ALLOWED.contains(method)) {
            throw new NotAllowed(method);
        }
        Map<String, Object> p = params == null ? Map.of() : params;
        if (sessionId != null) {
            // The browser's own methods go to the browser, never through a page's session.
            if (BROWSER_LEVEL.contains(method) || !scope.session(sessionId) || !said(sessionId, method, p, scope)) {
                throw new NotAllowed(method);
            }
            return;
        }
        if (!BROWSER_LEVEL.contains(method)) {
            throw new NotAllowed(method);
        }
        boolean ok = switch (method) {
            case "Target.createBrowserContext" -> Boolean.TRUE.equals(p.get("disposeOnDetach"));
            case "Target.createTarget" -> Boolean.TRUE.equals(p.get("hidden")) && Boolean.TRUE.equals(p.get("background"))
                    && !Boolean.TRUE.equals(p.get("newWindow")) && !Boolean.TRUE.equals(p.get("forTab"))
                    && (p.get("browserContextId") == null || p.get("browserContextId") instanceof String c && scope.context(c));
            case "Target.attachToTarget", "Target.closeTarget", "Target.getTargetInfo", "Browser.getWindowForTarget" ->
                    p.get("targetId") instanceof String t && scope.target(t);
            case "Target.disposeBrowserContext" -> p.get("browserContextId") instanceof String c && scope.context(c);
            case "Browser.setDownloadBehavior" -> "deny".equals(p.get("behavior"))
                    && p.get("browserContextId") instanceof String c && scope.context(c);
            case "Target.getTargets" -> true;
            default -> false;
        };
        if (!ok) {
            throw new NotAllowed(method);
        }
    }

    /**
     * What a session's script-carrying method says (S-14): deskd's own script, into deskd's own world, and never the
     * page's. Every other method's parameters are deskd's to choose and say nothing that runs.
     */
    private static boolean said(String sessionId, String method, Map<String, Object> p, Scope scope) {
        return switch (method) {
            case "Runtime.callFunctionOn" -> p.get("objectId") == null
                    && p.get("executionContextId") instanceof Number context && scope.world(sessionId, context)
                    && p.get("functionDeclaration") instanceof String function && scope.script(function);
            case "Runtime.evaluate" -> p.get("uniqueContextId") == null
                    && p.get("contextId") instanceof Number context && scope.world(sessionId, context)
                    && p.get("expression") instanceof String expression && scope.script(expression);
            case "Page.addScriptToEvaluateOnNewDocument" -> AgentView.WORLD.equals(p.get("worldName"))
                    && p.get("source") instanceof String source && scope.script(source);
            case "Page.createIsolatedWorld" -> AgentView.WORLD.equals(p.get("worldName"))
                    && !Boolean.TRUE.equals(p.get("grantUniveralAccess"));
            case "Target.detachFromTarget" -> p.get("sessionId") instanceof String child && scope.session(child)
                    && p.get("targetId") == null;
            default -> true;
        };
    }

    private static String worldKey(String sessionId, Number contextId) {
        return sessionId + "|" + contextId.longValue();
    }

    /** One command, parked on until its reply, as {@link CdpClient#call}. */
    Map<String, Object> send(String sessionId, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        check(sessionId, method, params, scope);
        return learned(sessionId, method, cdp.call(sessionId, method, params, timeout));
    }

    /** As {@link #send}, with a long string allowed in the reply ({@link CdpClient#callLong}). */
    Map<String, Object> sendLong(String sessionId, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        check(sessionId, method, params, scope);
        return learned(sessionId, method, cdp.callLong(sessionId, method, params, timeout));
    }

    /** A world deskd just made is one its scripts may go to, on that session alone. */
    private Map<String, Object> learned(String sessionId, String method, Map<String, Object> reply) {
        if (sessionId != null && "Page.createIsolatedWorld".equals(method) && reply != null
                && reply.get("executionContextId") instanceof Number context) {
            synchronized (worlds) {
                worlds.put(worldKey(sessionId, context), Boolean.TRUE);
            }
        }
        return reply;
    }

    /** A browser-level command whose reply is taken on the read path, in its place among the events ({@link CdpClient#call}). */
    Map<String, Object> sendBrowser(String method, Map<String, Object> params, Duration timeout, Consumer<Map<String, Object>> onReply)
            throws CdpException, InterruptedException {
        check(null, method, params, scope);
        return cdp.call(method, params, timeout, onReply);
    }

    boolean connected() {
        return cdp.isConnected();
    }
}
