package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Agent's Browser on the whole Browser module, with Chromium's side a fake that behaves as Chrome 156's hidden targets
 * did when probed: in no window, not discovered, not listed by Target.getTargets, and in /json/list as "other". What the
 * real Chromium does is {@link AgentBrowsingChromiumIT}'s.
 */
@SuppressWarnings("unchecked")
class AgentBrowsingTest {

    private static final String MEMBER_TAB = "M1";

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private final Page page = new Page();
    private BrowserRig rig;
    private TestClient client;
    private AgentBrowsing agent;
    private final AtomicBoolean free = new AtomicBoolean();

    /** The page's half, as deskd's proxy.js would answer each op, on whichever tab asks. */
    private static final class Page implements Function<FakeCdp.Command, Object> {
        /** What an Agent click's or key's look says: where it would go, and whether a payment frame is on the page. */
        volatile String clickUrl;
        volatile boolean pay;
        final List<Map<String, Object>> agentOps = new java.util.concurrent.CopyOnWriteArrayList<>();

        @Override
        public Object apply(FakeCdp.Command command) {
            Map<String, Object> value = (Map<String, Object>) ((Map<String, Object>) ((List<Object>) command.params().get("arguments")).get(0)).get("value");
            String op = (String) value.get("op");
            Map<String, Object> answer = switch (op) {
                case "snapshot" -> snapshot();
                case "prepare" -> Map.of("ok", true, "x", 20, "y", 30);
                case "result" -> Map.of("seen", Map.of("pointerdown", 1, "pointerup", 1, "click", 1));
                case "changed" -> Map.of("count", 1, "timeout", true);
                case "agentClick", "agentPress" -> {
                    agentOps.add(value);
                    Map<String, Object> said = new LinkedHashMap<>();
                    said.put("ok", true);
                    said.put("nav", clickUrl == null ? null : "link");
                    said.put("url", clickUrl);
                    said.put("pay", pay);
                    yield Boolean.TRUE.equals(value.get("look")) ? said
                            : Objects.equals(value.get("url"), clickUrl) && (!pay || Boolean.TRUE.equals(value.get("spend")))
                            ? Map.of("ok", true) : Map.of("refused", "changed");
                }
                case "payFrames" -> Map.of("pay", pay);
                default -> Map.of("ok", true);
            };
            Map<String, Object> tagged = new LinkedHashMap<>(answer);
            tagged.put("wid", "w" + command.params().get("executionContextId"));
            return Map.of("result", Map.of("type", "object", "value", tagged));
        }

        private static Map<String, Object> snapshot() {
            String text = "{\"mode\":\"page\"}\nh\t{\"k\":\"h\",\"l\":1,\"c\":[\"News\"]}\nh\t{\"k\":\"p\",\"c\":[\"" + "x".repeat(200)
                    + "\",[\"btn\",\"e.1\",\"More\",0]]}";
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("chunks", List.of(text));
            value.put("nodes", Map.of("e.1", Map.of("fp", "fp1")));
            value.put("media", List.of());
            value.put("signals", List.of());
            value.put("stats", Map.of("ready", "complete", "formControls", 1));
            value.put("extras", Map.of());
            value.put("count", 1);
            return value;
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage(MEMBER_TAB, "https://member.example/", "Member's page");
        cdp.answer("Runtime.callFunctionOn", page);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(2), Duration.ofMillis(800), Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(50),
                Duration.ofSeconds(3)), MinifiedSwitch.fixed(true, false, false));
        agent = (AgentBrowsing) rig.module.enableAgentBrowsing(free::get);
        client = rig.connect("cs-a");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        cdp.close();
    }

    private List<Map<String, Object>> memberTabs() throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        return (List<Map<String, Object>>) reply.get("tabs");
    }

    private List<FakeCdp.Command> onSession(String targetId) {
        List<FakeCdp.Command> on = new ArrayList<>();
        for (FakeCdp.Command command : cdp.commands()) {
            if (FakeCdp.sessionOf(targetId).equals(command.sessionId())) {
                on.add(command);
            }
        }
        return on;
    }

    private FakeCdp.Command last(String method) {
        List<FakeCdp.Command> all = cdp.commands(method);
        assertThat(all).as(method).isNotEmpty();
        return all.get(all.size() - 1);
    }

    private static String reason(RpcException e) {
        return (String) e.details().get("reason");
    }

    @Test
    void anAgentTabIsAHiddenTargetInTheRunsOwnOffTheRecordContext() throws Exception {
        AgentBrowser.Navigated opened = agent.open("run-1", "https://news.example/");
        String id = opened.tabId();

        FakeCdp.Command context = last("Target.createBrowserContext");
        assertThat(context.params()).isEqualTo(Map.of("disposeOnDetach", true));
        String contextId = cdp.contexts().iterator().next();
        assertThat(last("Browser.setDownloadBehavior").params())
                .isEqualTo(Map.of("behavior", "deny", "browserContextId", contextId, "eventsEnabled", true));
        assertThat(last("Target.createTarget").params())
                .isEqualTo(Map.of("url", "about:blank", "hidden", true, "background", true, "browserContextId", contextId));
        assertThat(cdp.hidden(id)).isTrue();
        assertThat(cdp.contextOf(id)).isEqualTo(contextId);
        assertThat(onSession(id)).extracting(FakeCdp.Command::method)
                .contains("Page.enable", "Emulation.setDeviceMetricsOverride", "Fetch.enable", "Page.navigate");
        assertThat(last("Emulation.setDeviceMetricsOverride").params()).containsEntry("width", 1280).containsEntry("height", 800);
        assertThat(last("Fetch.enable").params()).isEqualTo(Map.of("patterns",
                List.of(Map.of("urlPattern", "*", "resourceType", "Document", "requestStage", "Request"))));
        assertThat(agent.tab("run-1", id).url()).isEqualTo("https://news.example/");
        // The run's second tab is in the same context.
        String second = agent.open("run-1", "https://news.example/2").tabId();
        assertThat(cdp.contextOf(second)).isEqualTo(contextId);
        assertThat(cdp.commands("Target.createBrowserContext")).hasSize(1);
    }

    @Test
    void anAgentTabIsNeverInTheMembersListNeverActiveAndNeverActivated() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        String session = agent.useSession("run-1", "shop.example").tabId();
        assertThat(memberTabs()).extracting(t -> t.get("tabId")).containsExactly(MEMBER_TAB);
        assertThat(memberTabs().get(0)).containsEntry("active", true);
        // Even an event Chromium might send of one is the Agent's alone.
        cdp.event("Target.targetInfoChanged", Map.of("targetInfo", Map.of("targetId", id, "type", "page", "url", "https://news.example/",
                "title", "News", "attached", true, "browserContextId", cdp.contextOf(id))), null);
        cdp.event("Target.targetInfoChanged", Map.of("targetInfo", Map.of("targetId", session, "type", "page", "url", "https://shop.example/",
                "title", "Shop", "attached", true, "browserContextId", FakeCdp.DEFAULT_CONTEXT)), null);
        Thread.sleep(200);
        assertThat(memberTabs()).extracting(t -> t.get("tabId")).containsExactly(MEMBER_TAB);
        // The member's tab that leaves out tabId is still the one on screen, and nothing was ever activated.
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("tabId", MEMBER_TAB);
        assertThat(cdp.commands("Target.activateTarget")).isEmpty();
        // No client method reaches an Agent tab by its id: not the Browser's, not the simplified view's.
        for (String tab : List.of(id, session)) {
            assertThat(rig.call(client, "browser.tab.navigate", Map.of("tabId", tab, "url", "https://x.example/")))
                    .containsEntry("_kind", "ERR").containsEntry("code", "not_found");
            assertThat(rig.call(client, "browser.tab.activate", Map.of("tabId", tab))).containsEntry("code", "not_found");
            assertThat(rig.call(client, "browser.text.insert", Map.of("tabId", tab, "text", "x"))).containsEntry("code", "not_found");
            assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", tab))).containsEntry("code", "not_found");
            assertThat(rig.call(client, "browser.minified.get", Map.of("tabId", tab), null)).containsEntry("code", "not_found");
        }
        assertThat(cdp.has(id) && cdp.has(session)).isTrue();
    }

    @Test
    void everyCommandOnAnAgentPathIsOnTheAllowList() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        Map<String, Object> read = agent.read("run-1", id);
        assertThat(read).containsEntry("view", "simplified");
        Map<String, Object> mdoc = Json.object(read, "mdoc");
        Map<String, Object> para = (Map<String, Object>) ((List<Object>) mdoc.get("blocks")).get(1);
        Map<String, Object> button = (Map<String, Object>) ((List<Object>) para.get("runs")).get(1);
        Map<String, Object> done = agent.act("run-1", id, (String) button.get("node"), "click", null, (String) button.get("fp"),
                (String) para.get("key"), ((Number) mdoc.get("rev")).longValue());
        assertThat(done).containsEntry("done", true);
        String session = agent.useSession("run-1", "shop.example").tabId();
        agent.runEnded("run-1");
        await().atMost(Duration.ofSeconds(5)).until(() -> !cdp.has(id) && !cdp.has(session));

        Set<String> agentSessions = Set.of(FakeCdp.sessionOf(id), FakeCdp.sessionOf(session));
        List<String> seen = new ArrayList<>();
        for (FakeCdp.Command command : cdp.commands()) {
            if (command.sessionId() != null && agentSessions.contains(command.sessionId())) {
                assertThat(AgentCdp.ALLOWED).as(command.method()).contains(command.method());
                seen.add(command.method());
            }
        }
        assertThat(seen).contains("Runtime.callFunctionOn", "Page.addScriptToEvaluateOnNewDocument", "Target.setAutoAttach",
                "Page.createIsolatedWorld");
        // The click was deskd's half's own, from deskd's world: no trusted input ever went on an Agent path (S-14).
        assertThat(seen).doesNotContain("Input.dispatchMouseEvent", "Input.dispatchKeyEvent");
        assertThat(page.agentOps).extracting(op -> op.get("op"), op -> op.get("node"), op -> op.get("look"))
                .containsExactly(org.assertj.core.groups.Tuple.tuple("agentClick", button.get("node"), true),
                        org.assertj.core.groups.Tuple.tuple("agentClick", button.get("node"), false));
        // Every script went into a world deskd made, never on an object, and only deskd's own function.
        for (FakeCdp.Command command : cdp.commands("Runtime.callFunctionOn")) {
            if (agentSessions.contains(command.sessionId())) {
                assertThat(command.params()).doesNotContainKey("objectId").containsKey("executionContextId");
                assertThat((String) command.params().get("functionDeclaration")).startsWith("function(a){var p=globalThis.__maProxy;");
            }
        }
        // Nothing of the Agent's ever went to the member's own tab.
        for (FakeCdp.Command command : onSession(MEMBER_TAB)) {
            assertThat(command.method()).isNotIn("Fetch.enable", "Emulation.setDeviceMetricsOverride", "Input.dispatchMouseEvent");
        }
        for (FakeCdp.Command command : cdp.commands()) {
            assertThat(command.method()).doesNotStartWith("Storage.").doesNotStartWith("Network.").doesNotContain("Cookie");
        }
    }

    @Test
    void theRunsEndClosesItsTabsAndDisposesItsContext() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        String session = agent.useSession("run-1", "shop.example").tabId();
        String contextId = cdp.contextOf(id);
        agent.runEnded("run-1");
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.contexts().isEmpty() && !cdp.has(id) && !cdp.has(session));
        assertThat(last("Target.disposeBrowserContext").params()).isEqualTo(Map.of("browserContextId", contextId));
        assertThat(agent.tab("run-1", id)).isNull();
        assertThat(agent.agentTabs()).isZero();
        assertThat(cdp.has(MEMBER_TAB)).isTrue();
    }

    @Test
    void anotherRunHasNoAccessToARunsTabs() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        String session = agent.useSession("run-1", "shop.example").tabId();
        for (String tab : List.of(id, session)) {
            assertThat(agent.tab("run-2", tab)).isNull();
            assertThatThrownBy(() -> agent.read("run-2", tab)).isInstanceOfSatisfying(RpcException.class,
                    e -> assertThat(reason(e)).isEqualTo("not_found"));
            assertThatThrownBy(() -> agent.close("run-2", tab)).isInstanceOf(RpcException.class);
        }
        assertThat(agent.tabs("run-2")).isEmpty();
        assertThat(agent.sites("run-2")).isEmpty();
        assertThat(cdp.has(id)).isTrue();
    }

    @Test
    void twoAgentTabsOnTheDeskAndOneOnAFreeDesk() throws Exception {
        agent.open("run-1", "https://a.example/");
        agent.open("run-2", "https://b.example/");
        assertThatThrownBy(() -> agent.open("run-3", "https://c.example/")).isInstanceOfSatisfying(RpcException.class, e -> {
            assertThat(reason(e)).isEqualTo("tab_cap");
            assertThat(e.details()).containsEntry("limit", 2);
        });
        // A grant's tab isn't one of them.
        agent.useSession("run-1", "shop.example");
        agent.runEnded("run-2");
        await().atMost(Duration.ofSeconds(5)).until(() -> agent.agentTabs() == 1);
        free.set(true);
        assertThatThrownBy(() -> agent.open("run-3", "https://c.example/")).isInstanceOfSatisfying(RpcException.class,
                e -> assertThat(reason(e)).isEqualTo("tab_cap"));
    }

    @Test
    void theMembersSessionTabIsHiddenInTheMembersOwnContextForOneSiteAndAThirdSiteIsAskCap() throws Exception {
        AgentBrowser.Navigated opened = agent.useSession("run-1", "shop.example");
        String id = opened.tabId();
        FakeCdp.Command created = last("Target.createTarget");
        assertThat(created.params()).isEqualTo(Map.of("url", "about:blank", "hidden", true, "background", true));
        assertThat(cdp.contextOf(id)).isEqualTo(FakeCdp.DEFAULT_CONTEXT);
        assertThat(cdp.hidden(id)).isTrue();
        assertThat(agent.tab("run-1", id).site()).isEqualTo("shop.example");
        assertThat(agent.tab("run-1", id).url()).isEqualTo("https://shop.example/");
        assertThat(cdp.commands("Target.createBrowserContext")).isEmpty();
        // The same site again is the same tab.
        assertThat(agent.useSession("run-1", "shop.example").tabId()).isEqualTo(id);
        agent.useSession("run-1", "mail.example");
        assertThatThrownBy(() -> agent.useSession("run-1", "third.example")).isInstanceOfSatisfying(RpcException.class,
                e -> assertThat(reason(e)).isEqualTo("ask_cap"));
        assertThat(agent.sites("run-1")).containsExactlyInAnyOrder("shop.example", "mail.example");
        // Another run starts with none.
        agent.useSession("run-2", "third.example");
    }

    @Test
    void anOffSiteNavigationInTheSessionTabIsCancelledAndAnswersOffSite() throws Exception {
        String id = agent.useSession("run-1", "shop.example").tabId();
        String session = FakeCdp.sessionOf(id);

        // A page's own navigation off the site, and a redirect's hop, are failed at the request; the same site goes on.
        cdp.event("Fetch.requestPaused", Map.of("requestId", "R1", "request", Map.of("url", "https://evil.example/steal"),
                "frameId", id, "resourceType", "Document"), session);
        cdp.event("Fetch.requestPaused", Map.of("requestId", "R2", "request", Map.of("url", "https://www.shop.example/orders"),
                "frameId", id, "resourceType", "Document"), session);
        cdp.event("Fetch.requestPaused", Map.of("requestId", "R3", "request", Map.of("url", "https://ads.example/frame"),
                "frameId", "SUBFRAME", "resourceType", "Document"), session);
        cdp.event("Fetch.requestPaused", Map.of("requestId", "R4", "request", Map.of("url", "https://evil.example/hop"),
                "frameId", id, "resourceType", "Document", "redirectedRequestId", "R2"), session);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Fetch.failRequest").size() == 2
                && cdp.commands("Fetch.continueRequest").size() == 2);
        assertThat(cdp.commands("Fetch.failRequest")).extracting(c -> c.params().get("requestId")).containsExactlyInAnyOrder("R1", "R4");
        assertThat(cdp.commands("Fetch.failRequest")).allSatisfy(c -> {
            assertThat(c.sessionId()).isEqualTo(session);
            assertThat(c.params()).containsEntry("errorReason", "BlockedByClient");
        });
        assertThat(cdp.commands("Fetch.continueRequest")).extracting(c -> c.params().get("requestId")).containsExactlyInAnyOrder("R2", "R3");

        // A call during which one was cancelled says so.
        cdp.answer("Page.navigate", command -> {
            cdp.event("Fetch.requestPaused", Map.of("requestId", "R5", "request", Map.of("url", "https://evil.example/"),
                    "frameId", id, "resourceType", "Document"), command.sessionId());
            return Map.of("frameId", id, "errorText", "net::ERR_BLOCKED_BY_CLIENT");
        });
        assertThatThrownBy(() -> agent.navigate("run-1", id, "https://shop.example/redirects-away"))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("off_site"));
        // And one off the site is refused before anything is sent.
        int sent = cdp.commands("Page.navigate").size();
        assertThatThrownBy(() -> agent.navigate("run-1", id, "https://evil.example/"))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("off_site"));
        assertThat(cdp.commands("Page.navigate")).hasSize(sent);
    }

    /** The first button of the fake page, read once: its node, fingerprint, block and rev. */
    private Object[] firstButton(String tabId) throws Exception {
        Map<String, Object> mdoc = Json.object(agent.read("run-1", tabId), "mdoc");
        Map<String, Object> para = (Map<String, Object>) ((List<Object>) mdoc.get("blocks")).get(1);
        Map<String, Object> button = (Map<String, Object>) ((List<Object>) para.get("runs")).get(1);
        return new Object[] {button.get("node"), button.get("fp"), para.get("key"), ((Number) mdoc.get("rev")).longValue()};
    }

    @Test
    void aClickThatWouldLeaveTheGrantedSiteIsRefusedBeforeItsDoneAndALocalHostInEitherContext() throws Exception {
        String session = agent.useSession("run-1", "shop.example").tabId();
        Object[] b = firstButton(session);
        page.clickUrl = "https://evil.example/steal";
        assertThatThrownBy(() -> agent.act("run-1", session, (String) b[0], "click", null, (String) b[1], (String) b[2], (long) b[3], false))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("off_site"));
        page.clickUrl = "http://10.0.0.1/admin";
        assertThatThrownBy(() -> agent.act("run-1", session, (String) b[0], "click", null, (String) b[1], (String) b[2], (long) b[3], false))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("blocked"));
        page.clickUrl = "mailto:someone@example.com";
        assertThatThrownBy(() -> agent.act("run-1", session, (String) b[0], "click", null, (String) b[1], (String) b[2], (long) b[3], false))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("blocked"));
        // Only looks went to the page: nothing was clicked.
        assertThat(page.agentOps).allSatisfy(op -> assertThat(op).containsEntry("look", true));
        // The site itself goes, the address bound to the act.
        page.clickUrl = "https://www.shop.example/orders";
        assertThat(agent.act("run-1", session, (String) b[0], "click", null, (String) b[1], (String) b[2], (long) b[3], false))
                .containsEntry("done", true);
        assertThat(page.agentOps.get(page.agentOps.size() - 1)).containsEntry("look", false).containsEntry("url", "https://www.shop.example/orders");

        String own = agent.open("run-1", "https://news.example/").tabId();
        Object[] o = firstButton(own);
        page.clickUrl = "https://elsewhere.example/";
        assertThat(agent.act("run-1", own, (String) o[0], "click", null, (String) o[1], (String) o[2], (long) o[3], false))
                .containsEntry("done", true);
        page.clickUrl = "http://127.0.0.1:9222/json/close/M1";
        assertThatThrownBy(() -> agent.act("run-1", own, (String) o[0], "click", null, (String) o[1], (String) o[2], (long) o[3], false))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("blocked"));
    }

    @Test
    void securityTwoAClickOnAPageWithAPaymentFrameIsDoneOnlyAsAnApprovedSpend() throws Exception {
        String id = agent.open("run-1", "https://shop.example/").tabId();
        Object[] b = firstButton(id);
        page.pay = true;
        assertThat(agent.paymentFrame("run-1", id)).isTrue();
        int before = page.agentOps.size();
        assertThatThrownBy(() -> agent.act("run-1", id, (String) b[0], "click", null, (String) b[1], (String) b[2], (long) b[3], false))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(reason(e)).isEqualTo("changed"));
        assertThat(page.agentOps.subList(before, page.agentOps.size())).allSatisfy(op -> assertThat(op).containsEntry("look", true));
        assertThat(agent.act("run-1", id, (String) b[0], "click", null, (String) b[1], (String) b[2], (long) b[3], true))
                .containsEntry("done", true);
        assertThat(page.agentOps.get(page.agentOps.size() - 1)).containsEntry("look", false).containsEntry("spend", true);
        page.pay = false;
        assertThat(agent.paymentFrame("run-1", id)).isFalse();
    }

    @Test
    void securityFourAnOutOfProcessFrameIsHeldUntilItsOwnRequestsStopAndALocalHostIsRefusedThere() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        String tabSession = FakeCdp.sessionOf(id);
        // Frames are attached and held from the tab's start, before any page.
        FakeCdp.Command attach = onSession(id).stream().filter(c -> c.method().equals("Target.setAutoAttach")).findFirst().orElseThrow();
        assertThat(attach.params()).containsEntry("autoAttach", true).containsEntry("waitForDebuggerOnStart", true).containsEntry("flatten", true);
        assertThat(cdp.commands().indexOf(attach)).isLessThan(cdp.commands().indexOf(cdp.commands("Page.navigate").get(0)));

        // A frame of another site, in a process of its own, as Chromium attaches it under the tab.
        cdp.addTarget("OOPIF1", "iframe", null, "https://other.example/embed", "");
        String frame = FakeCdp.sessionOf("OOPIF1");
        cdp.event("Target.attachedToTarget", Map.of("sessionId", frame, "waitingForDebugger", true, "targetInfo",
                Map.of("targetId", "OOPIF1", "type", "iframe", "url", "https://other.example/embed", "attached", true)), tabSession);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Runtime.runIfWaitingForDebugger").stream()
                .anyMatch(c -> frame.equals(c.sessionId())));
        List<FakeCdp.Command> all = cdp.commands();
        int fetch = -1;
        int run = -1;
        for (int i = 0; i < all.size(); i++) {
            if (frame.equals(all.get(i).sessionId()) && all.get(i).method().equals("Fetch.enable") && fetch < 0) {
                fetch = i;
            }
            if (frame.equals(all.get(i).sessionId()) && all.get(i).method().equals("Runtime.runIfWaitingForDebugger") && run < 0) {
                run = i;
            }
        }
        assertThat(fetch).as("the frame's requests stop before it runs").isNotNegative().isLessThan(run);

        // A local host from inside the frame is failed there; anything else goes on.
        cdp.event("Fetch.requestPaused", Map.of("requestId", "F1", "request", Map.of("url", "http://192.168.0.1/"),
                "frameId", "OOPIF1", "resourceType", "Document"), frame);
        cdp.event("Fetch.requestPaused", Map.of("requestId", "F2", "request", Map.of("url", "https://cdn.example/x"),
                "frameId", "OOPIF1", "resourceType", "Document"), frame);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Fetch.failRequest").size() == 1
                && cdp.commands("Fetch.continueRequest").size() == 1);
        assertThat(cdp.commands("Fetch.failRequest").get(0)).satisfies(c -> {
            assertThat(c.sessionId()).isEqualTo(frame);
            assertThat(c.params()).containsEntry("requestId", "F1");
        });
        assertThat(cdp.commands("Fetch.continueRequest").get(0).sessionId()).isEqualTo(frame);
    }

    @Test
    void securityFourAFrameWhoseRequestsCantBeStoppedIsNeverLetRun() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        cdp.forceError("Fetch.enable", -32000);
        cdp.addTarget("OOPIF2", "iframe", null, "https://other.example/embed", "");
        String frame = FakeCdp.sessionOf("OOPIF2");
        cdp.event("Target.attachedToTarget", Map.of("sessionId", frame, "waitingForDebugger", true, "targetInfo",
                Map.of("targetId", "OOPIF2", "type", "iframe", "url", "https://other.example/embed", "attached", true)),
                FakeCdp.sessionOf(id));
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Fetch.enable").stream().filter(c -> frame.equals(c.sessionId())).count() == 2);
        Thread.sleep(500);
        // Tried twice, and held: nothing of the walker's went in, and it was never let go.
        assertThat(cdp.commands()).filteredOn(c -> frame.equals(c.sessionId())).extracting(FakeCdp.Command::method)
                .containsOnly("Fetch.enable");
        cdp.clearForcedErrors();
    }

    @Test
    void aLocalHostIsRefusedInTheAgentsOwnContextToo() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        cdp.event("Fetch.requestPaused", Map.of("requestId", "L1", "request", Map.of("url", "http://127.0.0.1:9222/json/close/M1"),
                "frameId", id, "resourceType", "Document"), FakeCdp.sessionOf(id));
        cdp.event("Fetch.requestPaused", Map.of("requestId", "L2", "request", Map.of("url", "http://169.254.169.254/latest/"),
                "frameId", "SUB", "resourceType", "Document"), FakeCdp.sessionOf(id));
        cdp.event("Fetch.requestPaused", Map.of("requestId", "L3", "request", Map.of("url", "https://elsewhere.example/"),
                "frameId", id, "resourceType", "Document"), FakeCdp.sessionOf(id));
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.commands("Fetch.failRequest").size() == 2
                && cdp.commands("Fetch.continueRequest").size() == 1);
        assertThat(cdp.commands("Fetch.failRequest")).extracting(c -> c.params().get("requestId")).containsExactlyInAnyOrder("L1", "L2");
        assertThatThrownBy(() -> agent.navigate("run-1", id, "http://localhost:8080/")).isInstanceOfSatisfying(RpcException.class,
                e -> assertThat(reason(e)).isEqualTo("blocked"));
    }

    @Test
    void aChromiumThatPutsATargetOnScreenIsRefusedAndTheTargetClosed() throws Exception {
        cdp.ignoreHidden(true);
        assertThatThrownBy(() -> agent.open("run-1", "https://news.example/")).isInstanceOfSatisfying(RpcException.class,
                e -> assertThat(reason(e)).isEqualTo("chromium"));
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.targetIds().equals(List.of(MEMBER_TAB)));
        assertThat(agent.agentTabs()).isZero();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(memberTabs()).extracting(t -> t.get("tabId"))
                .containsExactly(MEMBER_TAB));

        cdp.ignoreHidden(false);
        cdp.listHidden(true);
        assertThatThrownBy(() -> agent.open("run-1", "https://news.example/")).isInstanceOf(RpcException.class);
        await().atMost(Duration.ofSeconds(5)).until(() -> cdp.targetIds().equals(List.of(MEMBER_TAB)));
    }

    @Test
    void aPopUpAnAgentTabOrContextOpensIsClosedOnSightAndNeverListed() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        String session = agent.useSession("run-1", "shop.example").tabId();
        cdp.addPopup("POP1", "https://pop.example/", null, cdp.contextOf(id));
        cdp.addPopup("POP2", "https://pop.example/", session, FakeCdp.DEFAULT_CONTEXT);
        await().atMost(Duration.ofSeconds(5)).until(() -> !cdp.has("POP1") && !cdp.has("POP2"));
        assertThat(cdp.commands("Target.closeTarget")).extracting(c -> c.params().get("targetId")).contains("POP1", "POP2");
        assertThat(memberTabs()).extracting(t -> t.get("tabId")).containsExactly(MEMBER_TAB);
        // A pop-up of the member's own is the member's.
        cdp.addPopup("POP3", "https://pop.example/", MEMBER_TAB, FakeCdp.DEFAULT_CONTEXT);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(memberTabs()).extracting(t -> t.get("tabId")).contains("POP3"));
        assertThat(cdp.has("POP3")).isTrue();
    }

    @Test
    void aLostConnectionTakesTheAgentsTabsWithIt() throws Exception {
        String id = agent.open("run-1", "https://news.example/").tabId();
        cdp.dropConnections();
        await().atMost(Duration.ofSeconds(5)).until(() -> agent.tab("run-1", id) == null);
        assertThat(agent.agentTabs()).isZero();
        // The run goes on with a new context at its next tab.
        String next = agent.open("run-1", "https://news.example/").tabId();
        assertThat(cdp.commands("Target.createBrowserContext")).hasSize(2);
        assertThat(agent.tab("run-1", next)).isNotNull();
    }

    @Test
    void offWhenTheViewsSwitchIsOff() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.enableMinified(dir, Clock.systemUTC(), MinifiedModule.Timing.DEFAULT, MinifiedSwitch.fixed(false, false, false));
        AgentBrowser off = rig.module.enableAgentBrowsing(() -> false);
        assertThat(off.available()).isFalse();
        assertThatThrownBy(() -> off.open("run-1", "https://news.example/")).isInstanceOfSatisfying(RpcException.class,
                e -> assertThat(reason(e)).isEqualTo("disabled"));
        assertThat(cdp.commands("Target.createBrowserContext")).isEmpty();
    }
}
