package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Notebook tools through {@link ToolHost}: a write or a trash runs only on the member's approval, redeemed once; the
 * look gives the card; a guild member's agent runs as that member, and what it reads there is untrusted.
 */
@SuppressWarnings("unchecked")
class NotebookToolsHostTest {

    @TempDir
    Path dir;

    private FakeNotebookSocket service;
    private final List<Map<String, Object>> asked = new CopyOnWriteArrayList<>();
    private final AtomicReference<String> redeemed = new AtomicReference<>();

    @BeforeEach
    void setUp() throws Exception {
        service = new FakeNotebookSocket(dir.resolve("n.sock"));
        answer("notebook.page.agentEdit", p -> Boolean.TRUE.equals(p.get("dryRun"))
                ? NotebookToolsTest.args("pageId", p.get("pageId"), "title", "Plan", "op", p.get("op"), "dryRun", true)
                : NotebookToolsTest.args("pageId", "p-1", "title", "Plan", "op", p.get("op"), "versionId", "v-1"));
        answer("notebook.page.markdown", p -> NotebookToolsTest.args("pageId", p.get("pageId"), "title", "Plan", "markdown", "# Plan\n", "from", 0, "next", null, "length", 7, "trashed", false));
        answer("notebook.page.trash", p -> Map.of());
        answer("notebook.search", p -> Map.of("hits", List.of()));
    }

    @AfterEach
    void tearDown() throws Exception {
        service.close();
    }

    private void answer(String method, Function<Map<String, Object>, Object> handler) {
        service.handlers.put(method, p -> {
            Map<String, Object> seen = new LinkedHashMap<>(p);
            seen.put("_method", method);
            asked.add(seen);
            return handler.apply(p);
        });
    }

    /** A host for one desk: the owner's, or a guild desk where gm-ana1 is a plain member and gm-gone isn't on the roster. */
    private ToolHost host(boolean guild) {
        Function<String, Caller> callers = guild
                ? agentId -> "gm-ana1".equals(agentId) ? NotebookToolsTest.ANA : null
                : ToolHost.ownerOnly();
        ToolHost host = new ToolHost(Clock.systemUTC(), callers, () -> guild, () -> true);
        host.area(HostedDecls.NOTEBOOK, new NotebookTools(new NotebookCalls(service.socket(), () -> null, Duration.ofSeconds(5)), () -> guild));
        host.tickets((approvalId, sha, agentId, runId, tool, context, args) -> {
            redeemed.set(approvalId + ":" + sha);
            return approvalId.startsWith("ap-ok") ? null : "approval_unknown";
        });
        return host;
    }

    private static Map<String, Object> message(String agentId, String tool, Map<String, Object> args, boolean look) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", 7);
        m.put("tool", tool);
        m.put("runId", "run-1");
        m.put("agentId", agentId);
        m.put("args", args);
        if (look) {
            m.put("phase", "look");
        }
        return m;
    }

    private static Map<String, Object> approved(Map<String, Object> message, String approvalId) {
        Map<String, Object> args = (Map<String, Object>) message.get("args");
        String sha = ToolHost.hash((String) message.get("agentId"), "run-1", (String) message.get("tool"), "agent", args);
        Map<String, Object> m = new LinkedHashMap<>(message);
        m.put("approval", Map.of("approvalId", approvalId, "sha256", sha));
        return m;
    }

    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    private long edits() {
        return asked.stream().filter(a -> "notebook.page.agentEdit".equals(a.get("_method")) && !Boolean.TRUE.equals(a.get("dryRun"))).count();
    }

    @Test
    void aWriteOrATrashWithoutAnApprovalIsForbiddenAndReachesNothing() throws Exception {
        ToolHost host = host(false);
        Map<String, Object> write = host.handle(message("ag-1", "notebook_write", NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown", "x"), false));
        assertThat(write).containsEntry("t", "terr").containsEntry("code", "forbidden");
        assertThat(map(write.get("details"))).containsEntry("reason", "approval_required");
        Map<String, Object> trash = host.handle(message("ag-1", "notebook_trash", NotebookToolsTest.args("pageId", "p-1"), false));
        assertThat(map(trash.get("details"))).containsEntry("reason", "approval_required");
        assertThat(service.connections).isEmpty();
        host.close();
    }

    @Test
    void theLookGivesTheCardAndTheApprovedPayloadRunsOnce() throws Exception {
        ToolHost host = host(false);
        Map<String, Object> look = host.handle(message("ag-1", "notebook_write",
                NotebookToolsTest.args("pageId", "p-1", "op", "replace_text", "markdown", "Friday", "find", "Monday"), true));
        assertThat(look).containsEntry("t", "tres");
        Map<String, Object> r = map(look.get("r"));
        assertThat(r).containsEntry("risk", "write").containsEntry("context", "agent").containsEntry("refusal", null);
        assertThat(map(r.get("target"))).containsEntry("kind", "page").containsEntry("pageId", "p-1").containsEntry("title", "Plan");
        assertThat(map(r.get("before"))).containsEntry("title", "Plan");
        assertThat(edits()).isZero();

        // desk-agent runs exactly the payload the member saw, with the approval deskd relayed.
        Map<String, Object> done = host.handle(approved(message("ag-1", "notebook_write", map(r.get("payload")), false), "ap-ok1"));
        assertThat(done).containsEntry("t", "tres");
        assertThat(map(done.get("r"))).containsEntry("risk", "write");
        assertThat(map(map(done.get("r")).get("content"))).containsEntry("saved", true);
        assertThat(redeemed.get()).startsWith("ap-ok1:");
        assertThat(edits()).isEqualTo(1);

        // An approval deskd never relayed runs nothing.
        Map<String, Object> unknown = host.handle(approved(message("ag-1", "notebook_write", map(r.get("payload")), false), "ap-no1"));
        assertThat(map(unknown.get("details"))).containsEntry("reason", "approval_unknown");
        assertThat(edits()).isEqualTo(1);
        host.close();
    }

    @Test
    void anApprovedTrashRunsAndAReadNeverAsks() throws Exception {
        ToolHost host = host(false);
        Map<String, Object> look = host.handle(message("ag-1", "notebook_trash", NotebookToolsTest.args("pageId", "p-1"), true));
        assertThat(map(map(look.get("r")).get("before"))).containsEntry("title", "Plan");
        assertThat(map(look.get("r"))).containsEntry("risk", "delete");
        Map<String, Object> done = host.handle(approved(message("ag-1", "notebook_trash", NotebookToolsTest.args("pageId", "p-1"), false), "ap-ok2"));
        assertThat(done).containsEntry("t", "tres");
        assertThat(asked.stream().filter(a -> "notebook.page.trash".equals(a.get("_method"))).count()).isEqualTo(1);

        Map<String, Object> read = host.handle(message("ag-1", "notebook_read", NotebookToolsTest.args("pageId", "p-1"), false));
        assertThat(read).containsEntry("t", "tres");
        assertThat((List<Object>) map(read.get("r")).get("taints")).containsExactly("S");
        assertThat((List<Object>) read.get("taint")).containsExactly("S");
        host.close();
    }

    @Test
    void aGuildMembersAgentRunsAsThatMemberAndWhatItReadsIsUntrusted() throws Exception {
        ToolHost host = host(true);
        assertThat(host.offered()).containsExactly("notebook_search", "notebook_read", "notebook_write", "notebook_trash");
        Map<String, Object> read = host.handle(message("gm-ana1", "notebook_read", NotebookToolsTest.args("pageId", "p-1"), false));
        assertThat(read).containsEntry("t", "tres");
        assertThat((List<Object>) map(read.get("r")).get("taints")).containsExactlyInAnyOrder("S", "U");
        assertThat((List<Object>) read.get("taint")).containsExactlyInAnyOrder("S", "U");
        Map<String, Object> hello = service.last().next("hello");
        assertThat(map(hello.get("caller"))).containsEntry("kind", "guild_member").containsEntry("memberId", "gm-ana1").containsEntry("name", "Ana");

        // An approved write runs as Ana too, with her agent's id as its name, and its result is untrusted as well.
        Map<String, Object> args = NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown", "x");
        Map<String, Object> done = host.handle(approved(message("gm-ana1", "notebook_write", args, false), "ap-ok3"));
        assertThat(done).containsEntry("t", "tres");
        assertThat((List<Object>) map(done.get("r")).get("taints")).containsExactly("U");
        assertThat(map(service.last().next("hello").get("caller"))).containsEntry("memberId", "gm-ana1");
        assertThat(asked.get(asked.size() - 1)).containsEntry("agentName", "gm-ana1");

        // A member who isn't on the roster gets nothing; nor does anything but Notebook on a guild desk.
        Map<String, Object> gone = host.handle(message("gm-gone", "notebook_read", NotebookToolsTest.args("pageId", "p-1"), false));
        assertThat(map(gone.get("details"))).containsEntry("reason", "member");
        Map<String, Object> files = host.handle(message("gm-ana1", "files_list", NotebookToolsTest.args("path", ""), false));
        assertThat(map(files.get("details"))).containsEntry("reason", "scope");
        host.close();
    }

    @Test
    void aDryRunRefusalComesBackAtTheLookSoNobodyIsAsked() throws Exception {
        answer("notebook.page.agentEdit", p -> new FakeNotebookSocket.Refusal("conflict", Map.of("reason", "ambiguous")));
        ToolHost host = host(false);
        Map<String, Object> look = host.handle(message("ag-1", "notebook_write",
                NotebookToolsTest.args("pageId", "p-1", "op", "replace_text", "markdown", "x", "find", "the"), true));
        assertThat(look).containsEntry("t", "terr").containsEntry("code", "conflict");
        assertThat(map(look.get("details"))).isEqualTo(Map.of("reason", "ambiguous"));
        host.close();
    }
}
