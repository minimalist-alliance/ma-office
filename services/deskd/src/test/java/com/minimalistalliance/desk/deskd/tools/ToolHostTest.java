package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/**
 * deskd's checks before any area runs a tool for desk-agent (draft ADR "the Agent's tools and approvals", sections 3, 5,
 * 6 and 8): only declared tools, the caller by deskd's own stamp, the run's taint only growing, a class never below its
 * declaration and the Rule of Two, and an approval redeemed once for exactly what runs.
 */
class ToolHostTest {

    /** An area that looks as the test says and records what it ran. */
    static final class FakeArea implements HostedTool {
        volatile ToolRisk risk;
        volatile String context = "agent";
        volatile String refusal;
        volatile Set<String> resultTaints = Set.of();
        final List<HostedCall> ran = new CopyOnWriteArrayList<>();
        final List<String> ended = new CopyOnWriteArrayList<>();
        final List<Caller> callers = new CopyOnWriteArrayList<>();

        @Override
        public Look look(HostedCall call, RunLedger.Run run) {
            callers.add(call.caller());
            return new Look(risk, context, Map.of("kind", "test"), call.args(), null, refusal);
        }

        @Override
        public Result run(HostedCall call, RunLedger.Run run) {
            ran.add(call);
            return new Result("ok", resultTaints, Map.of("session", "agent"));
        }

        @Override
        public void runEnded(String runId) {
            ended.add(runId);
        }
    }

    private final FakeArea files = new FakeArea();
    private final FakeArea browser = new FakeArea();
    private final FakeArea notebook = new FakeArea();
    private final AtomicBoolean guild = new AtomicBoolean();
    private final AtomicBoolean adult = new AtomicBoolean(true);
    private final Map<String, Caller> members = new LinkedHashMap<>();
    private final List<List<Object>> redeemed = new ArrayList<>();
    private final AtomicReference<String> ledgerSays = new AtomicReference<>(null);
    private final ToolHost host = new ToolHost(Clock.systemUTC(), id -> id.startsWith("gm-") ? members.get(id)
            : Caller.THE_OWNER, guild::get, adult::get);

    {
        host.area(HostedDecls.FILES, files).area(HostedDecls.BROWSER, browser).area(HostedDecls.NOTEBOOK, notebook);
        host.tickets((approvalId, sha, agentId, runId, tool, context, args) -> {
            redeemed.add(List.of(approvalId, sha, agentId, runId, tool, context, args));
            return ledgerSays.get();
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
    private static Map<String, Object> r(Map<String, Object> reply) {
        assertThat(reply.get("t")).as(String.valueOf(reply)).isEqualTo("tres");
        return (Map<String, Object>) reply.get("r");
    }

    @SuppressWarnings("unchecked")
    private static String refusal(Map<String, Object> reply) {
        assertThat(reply.get("t")).isEqualTo("terr");
        return (String) ((Map<String, Object>) reply.get("details")).get("reason");
    }

    @Test
    void onlyDeclaredToolsRunAndTheHelloListsThem() {
        assertThat(refusal(host.handle(tcall("files_delete_forever", Map.of())))).isEqualTo("tool");
        assertThat(refusal(host.handle(tcall("shell", Map.of())))).isEqualTo("tool");
        assertThat(host.offered()).containsAll(HostedDecls.ALL.keySet());
        assertThat(host.hello()).containsEntry("v", 1);
        assertThat(refusal(host.handle(tcall("files_list", Map.of(), "runId", "bad id with spaces")))).isEqualTo("runId");
    }

    @Test
    void aGuildDeskHasNotebookOnlyAndAMembersAgentRunsAsThatMember() {
        guild.set(true);
        members.put("gm-abcd1234", new Caller(Caller.GUILD_MEMBER, "gm-abcd1234", Caller.MEMBER, List.of(), "M", null,
                false));
        assertThat(host.offered()).allMatch(name -> name.startsWith("notebook_"));
        assertThat(refusal(host.handle(tcall("files_list", Map.of(), "agentId", "gm-abcd1234")))).isEqualTo("scope");
        assertThat(refusal(host.handle(tcall("browser_open", Map.of(), "agentId", "gm-abcd1234")))).isEqualTo("scope");
        r(host.handle(tcall("notebook_read", Map.of("pageId", "p1"), "agentId", "gm-abcd1234")));
        assertThat(notebook.callers.get(0).memberId()).isEqualTo("gm-abcd1234");
        // A member who has left has no agent to run as.
        assertThat(refusal(host.handle(tcall("notebook_read", Map.of(), "agentId", "gm-gone0000")))).isEqualTo("member");
        // A teen member, and a teen's desk, get nothing.
        members.put("gm-teen0001", new Caller(Caller.GUILD_MEMBER, "gm-teen0001", Caller.MEMBER, List.of(), "T", null,
                true));
        assertThat(refusal(host.handle(tcall("notebook_read", Map.of(), "agentId", "gm-teen0001")))).isEqualTo("age_band");
        guild.set(false);
        adult.set(false);
        assertThat(refusal(host.handle(tcall("files_list", Map.of())))).isEqualTo("age_band");
    }

    @Test
    void aRunBelongsToOneAgentAndItsTaintOnlyGrows() {
        files.resultTaints = Set.of();
        Map<String, Object> first = host.handle(tcall("files_read", Map.of("path", "a")));
        assertThat((List<Object>) (List<?>) r(first).get("taints")).containsExactlyInAnyOrder("S", "U");
        assertThat((List<Object>) (List<?>) first.get("taint")).containsExactlyInAnyOrder("U", "S");
        // desk-agent sending fewer flags never clears deskd's.
        Map<String, Object> next = host.handle(tcall("files_list", Map.of("path", ""), "taint", List.of()));
        assertThat((List<Object>) (List<?>) next.get("taint")).containsExactlyInAnyOrder("U", "S");
        assertThat(refusal(host.handle(tcall("files_list", Map.of(), "agentId", "ag-2")))).isEqualTo("run");
    }

    @Test
    void aClassNeverFallsAndTheRuleOfTwoMakesBrowsingEgress() {
        files.risk = ToolRisk.READ;
        Map<String, Object> look = r(host.handle(tcall("files_write", Map.of("path", "a"), "phase", "look")));
        assertThat(look.get("risk")).isEqualTo("write");
        assertThat(files.ran).isEmpty();

        browser.risk = ToolRisk.SEND;
        assertThat(r(host.handle(tcall("browser_click", Map.of(), "phase", "look"))).get("risk")).isEqualTo("send");
        browser.risk = null;
        assertThat(r(host.handle(tcall("browser_open", Map.of(), "phase", "look"))).get("risk")).isEqualTo("read");
        Map<String, Object> tainted = r(host.handle(tcall("browser_open", Map.of(), "phase", "look", "runId", "run-2",
                "taint", List.of("U", "S"))));
        assertThat(tainted.get("risk")).isEqualTo("egress");
        // Reading isn't a browse action.
        assertThat(r(host.handle(tcall("browser_read", Map.of(), "phase", "look", "runId", "run-2"))).get("risk"))
                .isEqualTo("read");
        // And without an approval, the browse action doesn't run.
        assertThat(refusal(host.handle(tcall("browser_open", Map.of(), "runId", "run-2")))).isEqualTo("approval_required");
        assertThat(browser.ran).isEmpty();
    }

    @Test
    void aCallThatAsksRunsOnlyOnARedeemedApprovalForExactlyIt() {
        Map<String, Object> args = Map.of("path", "Plans/trip.md", "text", "Lisbon", "replace", false);
        assertThat(refusal(host.handle(tcall("files_write", args)))).isEqualTo("approval_required");

        String sha = ToolHost.hash("ag-1", "run-1", "files_write", "agent", args);
        Map<String, Object> wrongHash = Map.of("approvalId", "ap-aaaaaaaaaaaaaaaaaaaa", "sha256", "0".repeat(64));
        assertThat(refusal(host.handle(tcall("files_write", args, "approval", wrongHash)))).isEqualTo("approval_mismatch");
        Map<String, Object> approval = Map.of("approvalId", "ap-aaaaaaaaaaaaaaaaaaaa", "sha256", sha);
        // Changed arguments are another call: the hash over what deskd received doesn't match.
        assertThat(refusal(host.handle(tcall("files_write", Map.of("path", "Plans/trip.md", "text", "Porto",
                "replace", false), "approval", approval)))).isEqualTo("approval_mismatch");
        // desk-agent's context must be deskd's own.
        assertThat(refusal(host.handle(tcall("files_write", args, "approval", approval, "context",
                "member:example.test")))).isEqualTo("approval_mismatch");
        assertThat(files.ran).isEmpty();
        assertThat(redeemed).isEmpty();

        ledgerSays.set("approval_unknown");
        assertThat(refusal(host.handle(tcall("files_write", args, "approval", approval)))).isEqualTo("approval_unknown");
        assertThat(files.ran).isEmpty();

        ledgerSays.set(null);
        r(host.handle(tcall("files_write", args, "approval", approval, "context", "agent")));
        assertThat(files.ran).hasSize(1);
        assertThat(redeemed.get(redeemed.size() - 1)).isEqualTo(List.of("ap-aaaaaaaaaaaaaaaaaaaa", sha, "ag-1", "run-1",
                "files_write", "agent", args));

        // Used once: the ledger says so the second time.
        ledgerSays.set("approval_used");
        assertThat(refusal(host.handle(tcall("files_write", args, "approval", approval)))).isEqualTo("approval_used");
        assertThat(files.ran).hasSize(1);
    }

    @Test
    void aRefusalDecidedAtTheLookRefusesTheRunToo() {
        browser.refusal = "sensitive";
        Map<String, Object> look = r(host.handle(tcall("browser_type", Map.of(), "phase", "look")));
        assertThat(look.get("refusal")).isEqualTo("sensitive");
        assertThat(refusal(host.handle(tcall("browser_type", Map.of())))).isEqualTo("sensitive");
        assertThat(browser.ran).isEmpty();
    }

    @Test
    void theRunsEndReachesEveryArea() {
        r(host.handle(tcall("files_list", Map.of())));
        assertThat(host.ledger().size()).isEqualTo(1);
        r(host.handle(tcall("run_end", null)));
        assertThat(host.ledger().size()).isZero();
        assertThat(files.ended).containsExactly("run-1");
        assertThat(browser.ended).containsExactly("run-1");
        assertThat(notebook.ended).containsExactly("run-1");
    }

    @Test
    void theHashIsTheAppsAndDeskAgents() {
        // The same canonical JSON as desk-agent's and the Agent app's: keys sorted, no whitespace.
        assertThat(Canonical.json(Map.of("v", 1, "b", List.of("x", true), "a", "é\n"))).isEqualTo(
                "{\"a\":\"é\\n\",\"b\":[\"x\",true],\"v\":1}");
    }
}
