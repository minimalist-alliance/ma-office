package com.minimalistalliance.desk.agent.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.approval.Approvals;
import com.minimalistalliance.desk.agent.approval.Verdict;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.store.RunCallStore;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The call records on their own (durable runs' seam): a row before a call is sent and its end, the reply's text and
 * chips at each step, a run's end, and what an open after a kill makes of them, on real SQLite files.
 */
class RunCallsTest {

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private final ToolRegistry registry = new ToolRegistry();
    private AgentStore store;
    private AuditLog audit;
    private RunCalls calls;
    private final RunContext run = RunContext.of("run-1", AgentStore.MANAGER, Caller.OWNER, null, "reply-1");

    @BeforeEach
    void open() throws Exception {
        store = new AgentStore(data.resolve("agent.db"), clock);
        audit = new AuditLog(data.resolve("audit.db"), clock);
        store.open();
        audit.open();
        calls = new RunCalls(store, audit, clock);
    }

    @AfterEach
    void close() {
        store.close();
        audit.close();
    }

    /** A kill and a new start on the same files. */
    private void reopen() throws Exception {
        close();
        open();
    }

    private Classified classified(String tool, String id) {
        ToolCall call = new ToolCall(id, tool, Map.of("path", "a.md"));
        return new Classified(call, registry.decl(tool), registry.decl(tool).risk(), "agent", Map.of(), call.input(),
                null);
    }

    private void streamingReply() throws Exception {
        store.addMessages(List.of(MessageRow.user("user-1", AgentStore.MANAGER, "Save it.", clock.millis()),
                new MessageRow("reply-1", AgentStore.MANAGER, "assistant", "", clock.millis() + 1, "run-1", null, null,
                        null, null, "streaming", null, null)), Map.of());
    }

    private List<AuditLog.Row> audited(String action) throws Exception {
        List<AuditLog.Row> out = new ArrayList<>();
        for (AuditLog.Row row : audit.readBefore(null, 1000)) {
            if (row.entry().action().equals(action)) {
                out.add(row);
            }
        }
        return out;
    }

    private void approval(String id, String state, Long startedAt) throws Exception {
        store.database().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO approvals (id, agent_id, run_id,"
                    + " message_id, tool, risk, title, context, target, payload, sha256, untrusted, origin, state,"
                    + " created_at, expires_at, started_at) VALUES (?, 'manager', 'run-1', 'reply-1', 'files_write',"
                    + " 'write', 'Save', 'agent', '{}', '{}', ?, 0, '{}', ?, 1, 2, ?)")) {
                insert.setString(1, id);
                insert.setString(2, "0".repeat(64));
                insert.setString(3, state);
                if (startedAt == null) {
                    insert.setNull(4, java.sql.Types.INTEGER);
                } else {
                    insert.setLong(4, startedAt);
                }
                insert.executeUpdate();
            }
            return null;
        });
    }

    // ---------------------------------------------------------------- tests

    @Test
    void eachCallHasARowBeforeItsSentAndItsEndAfter() throws Exception {
        calls.step(run, 2, "", List.of());
        String key = calls.started(run, classified("files_write", "c1"),
                new Verdict.Approved("ap-aaaaaaaaaaaaaaaaaaaa", "0".repeat(64)));
        assertThat(key).matches("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
        assertThat(calls.current("run-1")).isEqualTo(key);
        RunCallStore.Call row = calls.store().get(key);
        assertThat(row).isEqualTo(new RunCallStore.Call(key, "run-1", AgentStore.MANAGER, "reply-1", 2, "c1",
                "files_write", "write", "deskd", "retry_by_key", "ap-aaaaaaaaaaaaaaaaaaaa", null, "started", null,
                clock.millis(), null));

        clock.advance(Duration.ofSeconds(1));
        calls.settled(run, key, new ToolResult("c1", "Saved.", false));
        assertThat(calls.current("run-1")).isNull();
        assertThat(calls.store().get(key).state()).isEqualTo("done");
        assertThat(calls.store().get(key).settledAt()).isEqualTo(clock.millis());

        // Done without asking: the gate's own id and the switch's group. A failure keeps its word, never content.
        String auto = calls.started(run, classified("files_write", "c2"), new Verdict.Allowed("files",
                "ap-bbbbbbbbbbbbbbbbbbbb"));
        assertThat(calls.store().get(auto).auto()).isEqualTo("files");
        assertThat(calls.store().get(auto).approvalId()).isEqualTo("ap-bbbbbbbbbbbbbbbbbbbb");
        calls.settled(run, auto, new ToolResult("c2", "Refused: exists.", true));
        assertThat(calls.store().get(auto).state()).isEqualTo("failed");
        assertThat(calls.store().get(auto).detail()).isEqualTo("exists");

        // A call its key couldn't confirm after a lost link: interrupted, as it may have happened.
        String lost = calls.started(run, classified("files_write", "c3"), Verdict.Auto.INSTANCE);
        calls.settled(run, lost, AgentToolsResults.interrupted("c3"));
        assertThat(calls.store().get(lost).state()).isEqualTo("interrupted");
        assertThat(calls.store().get(lost).detail()).isEqualTo("lost");
        // A read's rule is safe; an own call in desk-agent is interrupt.
        String read = calls.started(run, classified("files_list", "c4"), Verdict.Auto.INSTANCE);
        assertThat(calls.store().get(read).restart()).isEqualTo("safe");
        String own = calls.started(run, classified("workspace_write", "c5"), Verdict.Auto.INSTANCE);
        assertThat(calls.store().get(own).restart()).isEqualTo("interrupt");
        assertThat(calls.store().get(own).host()).isEqualTo("desk_agent");
        assertThat(calls.store().ofRun("run-1")).extracting(RunCallStore.Call::callId)
                .containsExactly("c1", "c2", "c3", "c4", "c5");
    }

    @Test
    void eachStepWritesTheReplysTextAndChipsWhileItStreamsAndNeverAfter() throws Exception {
        streamingReply();
        List<Map<String, Object>> chips = List.of(Map.of("name", "files_list", "summary", "Looked in your Files",
                "ok", true));
        calls.step(run, 1, "Looking first.", List.of());
        assertThat(store.messages(AgentStore.MANAGER, 10).get(1).text()).isEqualTo("Looking first.");
        assertThat(store.messages(AgentStore.MANAGER, 10).get(1).tools()).isNull();
        calls.step(run, 1, "Looking first.", chips);
        MessageRow row = store.messages(AgentStore.MANAGER, 10).get(1);
        assertThat(row.state()).isEqualTo("streaming");
        assertThat(row.tools()).isEqualTo(new String(Json.bytes(chips), StandardCharsets.UTF_8));

        // A kill: the reply ends interrupted at open, with what its steps wrote.
        reopen();
        row = store.messages(AgentStore.MANAGER, 10).get(1);
        assertThat(row.state()).isEqualTo("failed");
        assertThat(row.errorDetail()).isEqualTo("interrupted");
        assertThat(row.text()).isEqualTo("Looking first.");
        assertThat(row.tools()).isNotNull();
        // A step written after the reply ended changes nothing.
        calls.step(run, 2, "Too late.", List.of());
        assertThat(store.messages(AgentStore.MANAGER, 10).get(1).text()).isEqualTo("Looking first.");
    }

    @Test
    void aRunsEndInterruptsWhatItLeftRunningAndAuditsIt() throws Exception {
        String write = calls.started(run, classified("files_write", "c1"), Verdict.Auto.INSTANCE);
        String read = calls.started(run, classified("files_list", "c2"), Verdict.Auto.INSTANCE);
        calls.ended("run-1");
        assertThat(calls.store().get(write).state()).isEqualTo("interrupted");
        assertThat(calls.store().get(write).detail()).isEqualTo("ended");
        assertThat(calls.store().get(read).state()).isEqualTo("failed");
        assertThat(calls.current("run-1")).isNull();
        assertThat(audited("tool.interrupt")).singleElement().satisfies(r -> {
            assertThat(r.entry().target()).isEqualTo("tool:files_write run:run-1 call:" + write);
            assertThat(r.entry().decision()).isEqualTo("ended");
            assertThat(r.entry().actor()).isEqualTo("agent:manager");
        });
        assertThat(audited("tool.call")).singleElement().satisfies(r ->
                assertThat(r.entry().decision()).isEqualTo("error:ended"));
    }

    @Test
    void anOpenAfterAKillEndsWhatWasInFlightSettlesWhatCameBackAndRunsNothing() throws Exception {
        Approvals approvals = new Approvals(store, audit, clock);
        // In flight at the kill: a write the member approved, one done unasked, an own call and a read.
        approval("ap-aaaaaaaaaaaaaaaaaaaa", "approved", clock.millis());
        String approved = calls.started(run, classified("files_write", "c1"),
                new Verdict.Approved("ap-aaaaaaaaaaaaaaaaaaaa", "0".repeat(64)));
        String auto = calls.started(run, classified("files_write", "c2"), new Verdict.Allowed("files",
                "ap-bbbbbbbbbbbbbbbbbbbb"));
        String own = calls.started(run, classified("message_agent", "c3"), Verdict.Auto.INSTANCE);
        String read = calls.started(run, classified("files_list", "c4"), Verdict.Auto.INSTANCE);
        // Came back, and the kill came before its approval's outcome: one done, one failed.
        approval("ap-cccccccccccccccccccc", "approved", clock.millis());
        String cameBack = calls.started(run, classified("files_write", "c5"),
                new Verdict.Approved("ap-cccccccccccccccccccc", "0".repeat(64)));
        calls.settled(run, cameBack, new ToolResult("c5", "Saved.", false));
        approval("ap-dddddddddddddddddddd", "approved", clock.millis());
        String failed = calls.started(run, classified("files_write", "c6"),
                new Verdict.Approved("ap-dddddddddddddddddddd", "0".repeat(64)));
        calls.settled(run, failed, new ToolResult("c6", "Refused: changed.", true));

        reopen();
        approvals = new Approvals(store, audit, clock);
        calls.restore(approvals);
        approvals.restore();

        RunCallStore store = calls.store();
        for (String key : List.of(approved, auto, own)) {
            assertThat(store.get(key).state()).as(key).isEqualTo("interrupted");
            assertThat(store.get(key).detail()).isEqualTo("restart");
        }
        assertThat(store.get(read).state()).isEqualTo("failed");
        assertThat(store.get(read).detail()).isEqualTo("restart");
        assertThat(store.started()).isEmpty();
        // Every unasked and own call in flight left a trace, ids only.
        List<String> traces = audited("tool.interrupt").stream().map(r -> r.entry().target()).toList();
        assertThat(traces).containsExactlyInAnyOrder(
                "tool:files_write run:run-1 call:" + approved + " approval:ap-aaaaaaaaaaaaaaaaaaaa",
                "tool:files_write run:run-1 call:" + auto + " approval:ap-bbbbbbbbbbbbbbbbbbbb auto:files",
                "tool:message_agent run:run-1 call:" + own);
        assertThat(audited("tool.interrupt")).allSatisfy(r -> assertThat(r.entry().decision()).isEqualTo("restart"));
        // The approvals: the one in flight interrupted; the ones that came back settled from their records.
        assertThat(state("ap-aaaaaaaaaaaaaaaaaaaa")).isEqualTo("interrupted");
        assertThat(state("ap-cccccccccccccccccccc")).isEqualTo("done");
        assertThat(state("ap-dddddddddddddddddddd")).isEqualTo("failed");
        assertThat(result("ap-dddddddddddddddddddd")).isEqualTo("{\"ok\":false,\"error\":\"changed\"}");
        assertThat(audited("tool.call")).extracting(r -> r.entry().decision())
                .containsExactlyInAnyOrder("ok", "error:changed", "error:restart");

        // Again: nothing more moves, and nothing is audited twice.
        int rows = audit.readBefore(null, 1000).size();
        calls.restore(approvals);
        assertThat(audit.readBefore(null, 1000)).hasSize(rows);
    }

    @Test
    void recordsGoAWeekAfterTheySettleAndWithTheirAgent() throws Exception {
        String old = calls.started(run, classified("files_list", "c1"), Verdict.Auto.INSTANCE);
        calls.settled(run, old, new ToolResult("c1", "[]", false));
        clock.advance(Duration.ofDays(7).plusMinutes(1));
        String fresh = calls.started(run, classified("files_list", "c2"), Verdict.Auto.INSTANCE);
        calls.settled(run, fresh, new ToolResult("c2", "[]", false));
        calls.restore(new Approvals(store, audit, clock));
        assertThat(calls.store().get(old)).isNull();
        assertThat(calls.store().get(fresh)).isNotNull();
    }

    private String state(String approvalId) throws Exception {
        return column(approvalId, "state");
    }

    private String result(String approvalId) throws Exception {
        return column(approvalId, "result");
    }

    private String column(String approvalId, String column) throws Exception {
        return store.database().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT " + column
                    + " FROM approvals WHERE id = ?")) {
                select.setString(1, approvalId);
                try (java.sql.ResultSet r = select.executeQuery()) {
                    return r.next() ? r.getString(1) : null;
                }
            }
        });
    }

    /** The interrupted result as {@code AgentTools} makes it. */
    private static final class AgentToolsResults {
        static ToolResult interrupted(String callId) {
            return new ToolResult(callId, "Interrupted: lost. It may or may not have happened: check before you do it"
                    + " again.", true);
        }
    }
}
