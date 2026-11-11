package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.browser.minified.AgentView;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Security's ask (draft ADR "the Agent's tools and approvals", section 5): the Agent's CDP allow-list, pinned. Adding a
 * method means editing {@link #EXACTLY}, and no member may ever be one that clears or writes storage, cookies, cache or
 * history, whatever its name's case.
 */
class AgentCdpTest {

    /** The whole list, as Security read it. */
    private static final Set<String> EXACTLY = Set.of(
            "Target.createBrowserContext",
            "Target.disposeBrowserContext",
            "Target.createTarget",
            "Target.closeTarget",
            "Target.attachToTarget",
            "Target.getTargets",
            "Target.getTargetInfo",
            "Target.setAutoAttach",
            "Target.detachFromTarget",
            "Browser.setDownloadBehavior",
            "Browser.getWindowForTarget",
            "Page.enable",
            "Page.navigate",
            "Page.getNavigationHistory",
            "Page.navigateToHistoryEntry",
            "Page.getFrameTree",
            "Emulation.setDeviceMetricsOverride",
            "Emulation.setFocusEmulationEnabled",
            "Fetch.enable",
            "Fetch.continueRequest",
            "Fetch.failRequest",
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
            "Input.insertText");

    /**
     * What a cookie, storage, cache or history writer looks like. Any method in a storage domain at all, any that names
     * cookies, any that clears, deletes, resets or wipes, and any that sets, writes or removes a store, a cache, history,
     * an entry or site data.
     */
    private static final List<Pattern> NEVER = List.of(
            Pattern.compile("(?i)cookie"),
            Pattern.compile("^(Storage|DOMStorage|IndexedDB|CacheStorage|Network|ServiceWorker|BackgroundService|FileSystem|Database|"
                    + "Autofill|Extensions|Audits)\\."),
            Pattern.compile("(?i)(clear|delete|reset|erase|wipe|purge|truncate)"),
            Pattern.compile("(?i)(set|put|write|update|add|remove|override|grant)[A-Za-z]*(storage|cache|history|cookie|quota|data|entry|entries|"
                    + "permission|credential)"),
            Pattern.compile("(?i)^Browser\\.(reset|grant|setPermission|setContentsSize|close|crash)"),
            Pattern.compile("(?i)^Page\\.(resetNavigationHistory|clearCompilationCache|setDownloadBehavior|close|crash)"),
            Pattern.compile("(?i)^Target\\.(exposeDevToolsProtocol|setRemoteLocations)"));

    @Test
    void theAllowListIsExactlyWhatSecurityRead() {
        assertThat(AgentCdp.ALLOWED).isEqualTo(EXACTLY);
        assertThat(AgentCdp.ALLOWED).containsAll(AgentCdp.BROWSER_LEVEL);
    }

    @Test
    void noMethodOnItClearsOrWritesStorageCookiesCacheOrHistory() {
        for (String method : AgentCdp.ALLOWED) {
            for (Pattern never : NEVER) {
                assertThat(never.matcher(method).find()).as(method + " matches " + never.pattern()).isFalse();
            }
        }
    }

    @Test
    void thePatternsCatchEveryKnownWriter() {
        for (String writer : List.of(
                "Storage.clearDataForOrigin", "Storage.clearDataForStorageKey", "Storage.clearCookies", "Storage.setCookies",
                "Storage.getCookies", "Storage.overrideQuotaForOrigin", "Storage.clearSharedStorageEntries", "Network.clearBrowserCookies",
                "Network.clearBrowserCache", "Network.deleteCookies", "Network.setCookie", "Network.setCookies", "Network.enable",
                "Page.resetNavigationHistory", "DOMStorage.setDOMStorageItem", "DOMStorage.removeDOMStorageItem", "DOMStorage.clear",
                "IndexedDB.deleteDatabase", "IndexedDB.clearObjectStore", "IndexedDB.deleteObjectStoreEntries",
                "CacheStorage.deleteCache", "CacheStorage.deleteEntry", "Browser.resetPermissions", "Browser.grantPermissions",
                "Browser.setPermission", "Browser.close", "Page.close", "Autofill.setAddresses", "ServiceWorker.unregister")) {
            assertThat(NEVER.stream().anyMatch(p -> p.matcher(writer).find())).as(writer).isTrue();
        }
    }

    /** The Agent's own: session AGENT, target AT, context AC. */
    private static final AgentCdp.Scope AGENTS = new AgentCdp.Scope() {
        @Override
        public boolean session(String sessionId) {
            return "AGENT".equals(sessionId);
        }

        @Override
        public boolean target(String targetId) {
            return "AT".equals(targetId);
        }

        @Override
        public boolean context(String contextId) {
            return "AC".equals(contextId);
        }

        @Override
        public boolean world(String sessionId, Number contextId) {
            return "AGENT".equals(sessionId) && contextId.longValue() == 7;
        }

        @Override
        public boolean script(String source) {
            return "function(a){deskd}".equals(source);
        }
    };

    private static void refused(String session, String method, Map<String, Object> params) {
        assertThatThrownBy(() -> AgentCdp.check(session, method, params, AGENTS)).as(method + " " + params)
                .isInstanceOf(AgentCdp.NotAllowed.class);
    }

    @Test
    void anythingElseIsRefusedBeforeItGoesOut() {
        for (String method : List.of("Storage.clearDataForOrigin", "Network.clearBrowserCookies", "Network.setCookie",
                "Page.resetNavigationHistory", "Browser.close", "Target.activateTarget", "Page.bringToFront", "Runtime.enable",
                "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchTouchEvent", "Runtime.compileScript",
                "Runtime.addBinding", "Page.setBypassCSP")) {
            refused("AGENT", method, Map.of());
            refused(null, method, Map.of());
        }
        refused(null, null, Map.of());
    }

    @Test
    void aSessionCommandGoesOnlyToTheAgentsOwnSessions() {
        AgentCdp.check("AGENT", "Page.navigate", Map.of("url", "https://a.example/"), AGENTS);
        refused("MEMBER", "Page.navigate", Map.of("url", "https://a.example/"));
        refused(null, "Page.navigate", Map.of("url", "https://a.example/"));
        refused(null, "Input.insertText", Map.of("text", "x"));
        refused("AGENT", "Target.createBrowserContext", Map.of("disposeOnDetach", true));
        // Letting go of a frame: only one of the Agent's own, from one of its sessions.
        AgentCdp.check("AGENT", "Target.detachFromTarget", Map.of("sessionId", "AGENT"), AGENTS);
        refused("AGENT", "Target.detachFromTarget", Map.of("sessionId", "MEMBER"));
        refused("AGENT", "Target.detachFromTarget", Map.of("targetId", "MEMBER_TAB"));
        refused("MEMBER", "Target.detachFromTarget", Map.of("sessionId", "AGENT"));
        refused(null, "Target.detachFromTarget", Map.of("sessionId", "AGENT"));
    }

    private static Map<String, Object> with(Map<String, Object> base, String key, Object value) {
        Map<String, Object> m = new HashMap<>(base);
        if (value == null) {
            m.remove(key);
        } else {
            m.put(key, value);
        }
        return m;
    }

    /**
     * Security's S-14 ask: script on an Agent path is only deskd's own, only into a world deskd made on that session,
     * never the page's own world; whatever a model chose goes only as a JSON argument, never into the script.
     */
    @Test
    void scriptGoesOnlyAsDeskdsOwnIntoDeskdsOwnWorld() {
        Map<String, Object> call = Map.of("functionDeclaration", "function(a){deskd}", "executionContextId", 7,
                "arguments", List.of(Map.of("value", Map.of("op", "agentClick", "node", "x'); alert(1); //"))), "returnByValue", true);
        AgentCdp.check("AGENT", "Runtime.callFunctionOn", call, AGENTS);
        // Never on an object, which is in whichever world it came from, the page's own included.
        refused("AGENT", "Runtime.callFunctionOn", with(call, "objectId", "1.2.3"));
        refused("AGENT", "Runtime.callFunctionOn", with(with(call, "objectId", "1.2.3"), "executionContextId", null));
        // Never into a world deskd didn't make on that session: the page's main world is just another context id.
        refused("AGENT", "Runtime.callFunctionOn", with(call, "executionContextId", 1));
        refused("AGENT", "Runtime.callFunctionOn", with(call, "executionContextId", null));
        refused("AGENT2", "Runtime.callFunctionOn", call);
        // Never a function anyone but deskd wrote, the model's words in it or not.
        refused("AGENT", "Runtime.callFunctionOn", with(call, "functionDeclaration", "function(a){deskd}" + "x"));
        refused("AGENT", "Runtime.callFunctionOn", with(call, "functionDeclaration", "function(){return document.cookie}"));

        Map<String, Object> evaluate = Map.of("expression", "function(a){deskd}", "contextId", 7, "returnByValue", true);
        AgentCdp.check("AGENT", "Runtime.evaluate", evaluate, AGENTS);
        refused("AGENT", "Runtime.evaluate", with(evaluate, "expression", "document.cookie"));
        refused("AGENT", "Runtime.evaluate", with(evaluate, "contextId", null));
        refused("AGENT", "Runtime.evaluate", with(evaluate, "contextId", 8));
        refused("AGENT", "Runtime.evaluate", with(evaluate, "uniqueContextId", "u-1"));

        // A script for every new document: deskd's own, into deskd's world, never the main world's (no worldName).
        Map<String, Object> add = Map.of("source", "function(a){deskd}", "worldName", AgentView.WORLD);
        AgentCdp.check("AGENT", "Page.addScriptToEvaluateOnNewDocument", add, AGENTS);
        refused("AGENT", "Page.addScriptToEvaluateOnNewDocument", with(add, "worldName", null));
        refused("AGENT", "Page.addScriptToEvaluateOnNewDocument", with(add, "worldName", ""));
        refused("AGENT", "Page.addScriptToEvaluateOnNewDocument", with(add, "source", "alert(1)"));

        // deskd's world only, with no more reach than a page's own.
        Map<String, Object> world = Map.of("frameId", "F1", "worldName", AgentView.WORLD);
        AgentCdp.check("AGENT", "Page.createIsolatedWorld", world, AGENTS);
        refused("AGENT", "Page.createIsolatedWorld", with(world, "worldName", "other"));
        refused("AGENT", "Page.createIsolatedWorld", with(world, "grantUniveralAccess", true));
    }

    @Test
    void theBrowserItselfGetsOnlyWhatTheAgentMade() {
        AgentCdp.check(null, "Target.createBrowserContext", Map.of("disposeOnDetach", true), AGENTS);
        refused(null, "Target.createBrowserContext", Map.of());

        // A target is hidden, in the background, and in an Agent context or the member's own: never a window or a tab strip's.
        AgentCdp.check(null, "Target.createTarget", Map.of("url", "about:blank", "hidden", true, "background", true), AGENTS);
        AgentCdp.check(null, "Target.createTarget", Map.of("url", "about:blank", "hidden", true, "background", true, "browserContextId", "AC"),
                AGENTS);
        refused(null, "Target.createTarget", Map.of("url", "about:blank", "background", true));
        refused(null, "Target.createTarget", Map.of("url", "about:blank", "hidden", true));
        refused(null, "Target.createTarget", Map.of("url", "about:blank", "hidden", true, "background", true, "newWindow", true));
        refused(null, "Target.createTarget", Map.of("url", "about:blank", "hidden", true, "background", true, "browserContextId", "MEMBERS"));

        // A member's tab is never attached to, closed or asked for its window on an Agent path.
        for (String method : List.of("Target.attachToTarget", "Target.closeTarget", "Target.getTargetInfo", "Browser.getWindowForTarget")) {
            AgentCdp.check(null, method, Map.of("targetId", "AT"), AGENTS);
            refused(null, method, Map.of("targetId", "MEMBER_TAB"));
            refused(null, method, Map.of());
        }

        // Only the Agent's contexts are disposed of, and only their downloads set, to deny.
        AgentCdp.check(null, "Target.disposeBrowserContext", Map.of("browserContextId", "AC"), AGENTS);
        refused(null, "Target.disposeBrowserContext", Map.of("browserContextId", "DEFAULT"));
        AgentCdp.check(null, "Browser.setDownloadBehavior", Map.of("behavior", "deny", "browserContextId", "AC", "eventsEnabled", true), AGENTS);
        refused(null, "Browser.setDownloadBehavior", Map.of("behavior", "allow", "browserContextId", "AC"));
        refused(null, "Browser.setDownloadBehavior", Map.of("behavior", "deny"));
        refused(null, "Browser.setDownloadBehavior", Map.of("behavior", "deny", "browserContextId", "DEFAULT"));
    }
}
