package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * deskd's own check of the member's choice for an agent (draft ADR "the Agent's tools and approvals", section 16) before
 * any area sees a call, a look included: an agent not set up gets {@code setup}, an app switched off {@code scope},
 * whatever desk-agent says or brings, a change applies to the very next call, and the hello names the agents deskd holds.
 */
class ToolHostAccessTest {

    private final ToolHostTest.FakeArea files = new ToolHostTest.FakeArea();
    private final ToolHostTest.FakeArea browser = new ToolHostTest.FakeArea();
    private final ToolHostTest.FakeArea notebook = new ToolHostTest.FakeArea();
    /** deskd's record as the test says: agent to the areas it may use. */
    private final Map<String, List<String>> record = new ConcurrentHashMap<>();
    private final AtomicBoolean broken = new AtomicBoolean();
    private final ToolHost host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);

    {
        host.area(HostedDecls.FILES, files).area(HostedDecls.BROWSER, browser).area(HostedDecls.NOTEBOOK, notebook);
        host.tickets((approvalId, sha, agentId, runId, tool, context, args) -> null);
        host.agentApps(new ToolHost.AgentApps() {
            @Override
            public String refusal(String agentId, String area) {
                if (broken.get()) {
                    throw new IllegalStateException("record unreadable");
                }
                List<String> areas = record.get(agentId);
                return areas == null ? "setup" : areas.contains(area) ? null : "scope";
            }

            @Override
            public List<String> recorded() {
                return List.copyOf(new java.util.TreeSet<>(record.keySet()));
            }
        });
    }

    private static Map<String, Object> tcall(String tool, Map<String, Object> args, Object... more) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", 7);
        m.put("runId", "run-1");
        m.put("agentId", "ag-1");
        m.put("tool", tool);
        m.put("args", args);
        m.put("taint", List.of());
        for (int i = 0; i < more.length; i += 2) {
            m.put((String) more[i], more[i + 1]);
        }
        return m;
    }

    @SuppressWarnings("unchecked")
    private static String refusal(Map<String, Object> reply) {
        assertThat(reply.get("t")).as(String.valueOf(reply)).isEqualTo("terr");
        assertThat(reply.get("code")).isEqualTo("forbidden");
        return (String) ((Map<String, Object>) reply.get("details")).get("reason");
    }

    private static void ok(Map<String, Object> reply) {
        assertThat(reply.get("t")).as(String.valueOf(reply)).isEqualTo("tres");
    }

    @Test
    void anAgentTheMemberHasntSetUpGetsNothingNotEvenALook() {
        for (String tool : List.of("files_list", "browser_open", "notebook_read")) {
            assertThat(refusal(host.handle(tcall(tool, Map.of())))).isEqualTo("setup");
            assertThat(refusal(host.handle(tcall(tool, Map.of(), "phase", "look")))).isEqualTo("setup");
        }
        assertThat(files.callers).isEmpty();
        assertThat(browser.callers).isEmpty();
        assertThat(notebook.callers).isEmpty();
    }

    @Test
    void anAppSwitchedOffIsOutOfScopeWhateverDeskAgentBrings() {
        record.put("ag-1", List.of(HostedDecls.NOTEBOOK, HostedDecls.BROWSER));
        ok(host.handle(tcall("notebook_read", Map.of("pageId", "p1"))));
        ok(host.handle(tcall("browser_read", Map.of("tabId", "t1"))));
        assertThat(refusal(host.handle(tcall("files_list", Map.of("path", ""))))).isEqualTo("scope");
        // An approval or a context desk-agent claims doesn't change it.
        files.risk = ToolRisk.WRITE;
        assertThat(refusal(host.handle(tcall("files_write", Map.of("path", "a", "text", "b"), "approval",
                Map.of("approvalId", "ap-abcdefghijklmnopqrst", "sha256", "0".repeat(64)), "context", "agent"))))
                .isEqualTo("scope");
        assertThat(files.callers).isEmpty();
        assertThat(files.ran).isEmpty();
        // Another agent isn't covered by this one's choice.
        assertThat(refusal(host.handle(tcall("notebook_read", Map.of(), "agentId", "ag-2")))).isEqualTo("setup");
    }

    @Test
    void aChangeAppliesToTheVeryNextCallOfARunAlreadyGoing() {
        record.put("ag-1", List.of(HostedDecls.FILES, HostedDecls.NOTEBOOK));
        ok(host.handle(tcall("files_list", Map.of("path", ""))));
        record.put("ag-1", List.of(HostedDecls.NOTEBOOK));
        assertThat(refusal(host.handle(tcall("files_list", Map.of("path", ""))))).isEqualTo("scope");
        record.remove("ag-1");
        assertThat(refusal(host.handle(tcall("notebook_read", Map.of())))).isEqualTo("setup");
        assertThat(files.ran).hasSize(1);
    }

    @Test
    void aRecordThatCantBeReadRefusesAsSetup() {
        record.put("ag-1", List.of(HostedDecls.FILES));
        broken.set(true);
        assertThat(refusal(host.handle(tcall("files_list", Map.of("path", ""))))).isEqualTo("setup");
        assertThat(files.callers).isEmpty();
    }

    @Test
    void theHelloNamesTheAgentsDeskdHoldsAndSaysNothingUnwired() {
        record.put("manager", List.of(HostedDecls.FILES));
        record.put("ag-1", List.of());
        assertThat(host.hello()).containsEntry("access", Map.of("recorded", List.of("ag-1", "manager")));
        ToolHost unwired = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
        assertThat(unwired.hello()).doesNotContainKey("access");
    }

    @Test
    void aGuildDesksOwnScopeRuleComesFirstAndTheMembersChoiceStillHolds() {
        AtomicBoolean guild = new AtomicBoolean(true);
        Caller member = new Caller(Caller.GUILD_MEMBER, "gm-abcd1234", Caller.MEMBER, List.of(), "M", null, false);
        ToolHost guildHost = new ToolHost(Clock.systemUTC(), id -> member, guild::get, () -> true);
        ToolHostTest.FakeArea nb = new ToolHostTest.FakeArea();
        guildHost.area(HostedDecls.NOTEBOOK, nb).area(HostedDecls.FILES, new ToolHostTest.FakeArea());
        Map<String, List<String>> guildRecord = new ConcurrentHashMap<>();
        guildHost.agentApps((agentId, area) -> {
            List<String> areas = guildRecord.get(agentId);
            return areas == null ? "setup" : areas.contains(area) ? null : "scope";
        });
        assertThat(refusal(guildHost.handle(tcall("notebook_read", Map.of(), "agentId", "gm-abcd1234"))))
                .isEqualTo("setup");
        guildRecord.put("gm-abcd1234", List.of(HostedDecls.NOTEBOOK, HostedDecls.FILES));
        ok(guildHost.handle(tcall("notebook_read", Map.of("pageId", "p"), "agentId", "gm-abcd1234")));
        // A Guild Desk has no Files whatever a record says.
        assertThat(refusal(guildHost.handle(tcall("files_list", Map.of(), "agentId", "gm-abcd1234"))))
                .isEqualTo("scope");
    }
}
