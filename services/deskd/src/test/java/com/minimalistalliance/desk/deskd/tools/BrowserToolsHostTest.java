package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.browser.AgentBrowser;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The Browser tools through {@link ToolHost}: deskd's own class for each call, the approval it then needs, and taint. */
@SuppressWarnings("unchecked")
class BrowserToolsHostTest {

    private FakeAgentBrowser browser;
    private ToolHost host;
    private final List<String> redeemed = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() {
        browser = new FakeAgentBrowser();
        host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
        host.area(HostedDecls.BROWSER, new BrowserTools(browser));
        host.tickets((approvalId, sha, agentId, runId, tool, context, args) -> {
            redeemed.add(approvalId + " " + context);
            return approvalId.startsWith("ap-ok") ? null : "approval_unknown";
        });
    }

    @AfterEach
    void tearDown() {
        host.close();
    }

    private static Map<String, Object> message(String tool, Map<String, Object> args, boolean look, List<String> taint) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", 9);
        m.put("tool", tool);
        m.put("runId", "run-1");
        m.put("agentId", "ag-1");
        m.put("args", args);
        m.put("taint", taint);
        if (look) {
            m.put("phase", "look");
        }
        return m;
    }

    private static Map<String, Object> approved(Map<String, Object> message, String approvalId, String context) {
        Map<String, Object> args = (Map<String, Object>) message.get("args");
        Map<String, Object> m = new LinkedHashMap<>(message);
        m.put("approval", Map.of("approvalId", approvalId, "sha256", ToolHost.hash("ag-1", "run-1", (String) message.get("tool"), context, args)));
        m.put("context", context);
        return m;
    }

    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @Test
    void aSessionTabOpenWithoutAnApprovalIsApprovalRequiredWhateverTheTaint() throws Exception {
        AgentBrowser.Tab tab = browser.addTab("run-1", "shop.example", "https://shop.example/", "Home");
        Map<String, Object> args = BrowserToolsTest.args("tabId", tab.tabId(), "url", "https://shop.example/orders");

        Map<String, Object> look = host.handle(message("browser_open", args, true, List.of()));
        assertThat(look).containsEntry("t", "tres").containsEntry("taint", List.of());
        assertThat(map(look.get("r"))).containsEntry("risk", "egress").containsEntry("context", "member:shop.example")
                .containsEntry("refusal", null);

        Map<String, Object> reply = host.handle(message("browser_open", args, false, List.of()));
        assertThat(reply).containsEntry("t", "terr").containsEntry("code", "forbidden");
        assertThat(map(reply.get("details"))).containsEntry("reason", "approval_required");
        assertThat(browser.tabs.get(tab.tabId()).url()).isEqualTo("https://shop.example/");
        assertThat(redeemed).isEmpty();
    }

    @Test
    void anApprovedSessionTabOpenRunsInTheMembersContextAndAddsBothTaints() throws Exception {
        AgentBrowser.Tab tab = browser.addTab("run-1", "shop.example", "https://shop.example/", "Home");
        browser.page(tab.tabId(), BrowserToolsTest.formPage(1));
        Map<String, Object> args = BrowserToolsTest.args("tabId", tab.tabId(), "url", "https://shop.example/orders");
        // An approval asked in the agent's context isn't this call's.
        Map<String, Object> wrong = host.handle(approved(message("browser_open", args, false, List.of()), "ap-ok1", "agent"));
        assertThat(map(wrong.get("details"))).containsEntry("reason", "approval_mismatch");

        Map<String, Object> reply = host.handle(approved(message("browser_open", args, false, List.of()), "ap-ok2", "member:shop.example"));
        assertThat(reply).containsEntry("t", "tres");
        Map<String, Object> r = map(reply.get("r"));
        assertThat(r).containsEntry("risk", "egress").containsEntry("session", "member");
        assertThat(r.get("taints")).isEqualTo(List.of("U", "S"));
        assertThat(reply.get("taint")).isEqualTo(List.of("U", "S"));
        assertThat(redeemed).containsExactly("ap-ok2 member:shop.example");
        assertThat(browser.tabs.get(tab.tabId()).url()).isEqualTo("https://shop.example/orders");
    }

    @Test
    void anOffSiteOpenInASessionTabIsRefusedBeforeAnyoneIsAsked() throws Exception {
        AgentBrowser.Tab tab = browser.addTab("run-1", "shop.example", "https://shop.example/", "Home");
        Map<String, Object> args = BrowserToolsTest.args("tabId", tab.tabId(), "url", "https://evil.example/");
        assertThat(map(host.handle(message("browser_open", args, true, List.of())).get("r"))).containsEntry("refusal", "off_site");
        Map<String, Object> reply = host.handle(approved(message("browser_open", args, false, List.of()), "ap-ok3", "member:shop.example"));
        assertThat(reply).containsEntry("code", "forbidden");
        assertThat(map(reply.get("details"))).containsEntry("reason", "off_site");
        assertThat(redeemed).isEmpty();
    }

    @Test
    void theSessionGrantAsksAndAnAgentReadDoesnt() throws Exception {
        Map<String, Object> grant = host.handle(message("browser_use_my_session", BrowserToolsTest.args("site", "shop.example"), false, List.of()));
        assertThat(map(grant.get("details"))).containsEntry("reason", "approval_required");
        assertThat(browser.tabs).isEmpty();

        Map<String, Object> opened = host.handle(message("browser_open", BrowserToolsTest.args("url", "https://news.example/"), false, List.of()));
        assertThat(opened).containsEntry("t", "tres");
        assertThat(map(opened.get("r"))).containsEntry("risk", "read").containsEntry("session", "agent");
        assertThat(opened.get("taint")).isEqualTo(List.of("U"));
    }

    @Test
    void underUAndSEveryBrowseIsEgressAndAsks() throws Exception {
        Map<String, Object> reply = host.handle(message("browser_open", BrowserToolsTest.args("url", "https://news.example/"), false, List.of("U", "S")));
        assertThat(map(reply.get("details"))).containsEntry("reason", "approval_required");
        assertThat(browser.opened).isEmpty();
    }

    @Test
    void theBrowserIsntOfferedWhileTheViewsSwitchIsOff() {
        assertThat(host.offered()).contains("browser_open", "browser_use_my_session");
        browser.available = false;
        assertThat(host.offered()).doesNotContain("browser_open", "browser_read");
        Map<String, Object> reply = host.handle(message("browser_read", BrowserToolsTest.args("tabId", "AT1"), false, List.of()));
        assertThat(reply).containsEntry("code", "unavailable");
    }

    /** Click and press are offered: deskd's half does them, from deskd's own world, where trusted input can't reach (S-14). */
    @Test
    void clickAndPressAreOfferedAndAPlainClickInTheAgentsContextRunsWithoutAsking() {
        assertThat(host.offered()).contains("browser_open", "browser_read", "browser_type", "browser_click", "browser_press");
        AgentBrowser.Tab tab = browser.addTab("run-1", null, BrowserToolsTest.ORIGIN + "/join", "Join");
        browser.page(tab.tabId(), BrowserToolsTest.formPage(3));
        host.handle(message("browser_read", BrowserToolsTest.args("tabId", tab.tabId()), false, List.of()));
        Map<String, Object> reply = host.handle(message("browser_click", BrowserToolsTest.args("tabId", tab.tabId(), "ref", "n7"),
                false, List.of()));
        assertThat(reply).containsEntry("t", "tres");
        assertThat(map(reply.get("r"))).containsEntry("risk", "read");
        assertThat(browser.acts).hasSize(1);
    }

    @Test
    void aSubmitClickAsksAsSendAndASessionLinkAsEgressBeforeAnythingIsDone() {
        AgentBrowser.Tab tab = browser.addTab("run-1", null, BrowserToolsTest.ORIGIN + "/join", "Join");
        browser.page(tab.tabId(), BrowserToolsTest.formPage(3));
        host.handle(message("browser_read", BrowserToolsTest.args("tabId", tab.tabId()), false, List.of()));
        Map<String, Object> submit = BrowserToolsTest.args("tabId", tab.tabId(), "ref", "n2");
        assertThat(map(host.handle(message("browser_click", submit, true, List.of())).get("r"))).containsEntry("risk", "send");
        assertThat(map(host.handle(message("browser_click", submit, false, List.of())).get("details")))
                .containsEntry("reason", "approval_required");

        AgentBrowser.Tab session = browser.addTab("run-1", "shop.example", BrowserToolsTest.ORIGIN + "/links", "Links");
        browser.page(session.tabId(), BrowserToolsTest.linkPage(2));
        host.handle(message("browser_read", BrowserToolsTest.args("tabId", session.tabId()), false, List.of()));
        Map<String, Object> look = map(host.handle(message("browser_click", BrowserToolsTest.args("tabId", session.tabId(), "ref", "n1"),
                true, List.of())).get("r"));
        assertThat(look).containsEntry("risk", "egress").containsEntry("context", "member:shop.example");
        assertThat(browser.acts).isEmpty();

        // The member's yes, for exactly that payload: it runs once.
        Map<String, Object> approved = host.handle(approved(message("browser_click", map(look.get("payload")), false, List.of()),
                "ap-ok-link", "member:shop.example"));
        assertThat(approved).containsEntry("t", "tres");
        assertThat(map(approved.get("r"))).containsEntry("risk", "egress");
        assertThat(browser.acts).hasSize(1);
    }

    @Test
    void aGuildDeskHasNoBrowser() {
        ToolHost guild = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> true, () -> true);
        guild.area(HostedDecls.BROWSER, new BrowserTools(browser));
        assertThat(guild.offered()).isEmpty();
        Map<String, Object> reply = guild.handle(message("browser_open", BrowserToolsTest.args("url", "https://a.example/"), false, List.of()));
        assertThat(map(reply.get("details"))).containsEntry("reason", "scope");
        guild.close();
    }

    @Test
    void theRunsEndReachesTheBrowser() {
        browser.addTab("run-1", null, "https://a.example/", "A");
        host.handle(message("browser_tabs", Map.of(), false, List.of()));
        host.handle(message(HostedDecls.RUN_END, Map.of(), false, List.of()));
        assertThat(browser.ended).containsExactly("run-1");
    }
}
