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
                ? NotebookToolsTest.args("pageId", p.get("pageId"), "title", "Plan", "op", p.get("op"), "dryRun", true,
                        "tabId", "tab-1")
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

    /**
     * The seam between the core's auto-approve and the Notebook's edit key (`sub/lsub-agent-tools-notebook`'s note: "core's
     * auto-approve must pass the approval id"): a write desk-agent did without asking, under a switch deskd's own record
     * holds, reaches desk-notebook keyed by that call's own approval id in a space of its own ({@code auto:<id>}, Security's
     * AAW-L2), with the switch's tab for desk-notebook to hold it to where it writes, so it's made once and the draft
     * ADR's undo finds it. Without that id deskd runs nothing.
     */
    @Test
    void aWriteDoneWithoutAskingIsKeyedByItsOwnApprovalIdAndRunsNothingWithoutOne() throws Exception {
        ToolHost host = host(false);
        host.access(new ToolHost.AccessRecord() {
            @Override
            public boolean autoOn(com.minimalistalliance.desk.deskd.rpc.Caller caller, String agentId, String group) {
                return "ag-1".equals(agentId) && "notebook".equals(group);
            }

            @Override
            public String place(String agentId, String group) {
                return "notebook".equals(group) ? "tab-1" : null;
            }
        });
        Map<String, Object> unkeyed = message("ag-1", "notebook_write",
                NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown", "A line."), false);
        unkeyed.put("auto", "notebook");
        Map<String, Object> refused = host.handle(unkeyed);
        assertThat(refused).containsEntry("t", "terr").containsEntry("code", "bad_request");
        assertThat(map(refused.get("details"))).containsEntry("reason", "autoApprovalId");
        assertThat(edits()).isZero();

        Map<String, Object> keyed = new LinkedHashMap<>(unkeyed);
        keyed.put("autoApprovalId", "ap-abcdefghijklmnopqrst");
        assertThat(host.handle(keyed)).containsEntry("t", "tres");
        assertThat(edits()).isEqualTo(1);
        Map<String, Object> edit = asked.stream()
                .filter(a -> "notebook.page.agentEdit".equals(a.get("_method")) && !Boolean.TRUE.equals(a.get("dryRun")))
                .findFirst().orElseThrow();
        assertThat(edit).containsEntry("key", "auto:ap-abcdefghijklmnopqrst").containsEntry("op", "append")
                .containsEntry("pageId", "p-1").containsEntry("untrusted", false).containsEntry("tab", "tab-1");
        // No ticket was asked for: deskd's own record of the switch let it through.
        assertThat(redeemed.get()).isNull();

        // A member's yes still keys by its own id, and an unasked call for an agent with no switch runs nothing.
        Map<String, Object> other = new LinkedHashMap<>(keyed);
        other.put("agentId", "ag-2");
        other.put("runId", "run-2");
        assertThat(map(host.handle(other).get("details"))).containsEntry("reason", "approval_unknown");
        assertThat(edits()).isEqualTo(1);
        Map<String, Object> yes = approved(message("ag-1", "notebook_write",
                NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown", "B line."), false), "ap-ok-1");
        assertThat(host.handle(yes)).containsEntry("t", "tres");
        assertThat(asked.stream().filter(a -> "notebook.page.agentEdit".equals(a.get("_method"))
                && !Boolean.TRUE.equals(a.get("dryRun"))).map(a -> a.get("key")).toList())
                .containsExactly("auto:ap-abcdefghijklmnopqrst", "ap-ok-1");
        host.close();
    }

    /** deskd's record of a Notebook switch on for ag-1 in tab-1, or on a guild desk for the owner's agents. */
    private static ToolHost.AccessRecord notebookSwitch() {
        return new ToolHost.AccessRecord() {
            @Override
            public boolean autoOn(Caller caller, String agentId, String group) {
                return "notebook".equals(group);
            }

            @Override
            public String place(String agentId, String group) {
                return "notebook".equals(group) ? "tab-1" : null;
            }
        };
    }

    private static Map<String, Object> unasked(String agentId, Map<String, Object> args, String id) {
        Map<String, Object> m = message(agentId, "notebook_write", args, false);
        m.put("auto", "notebook");
        m.put("autoApprovalId", id);
        return m;
    }

    /**
     * The draft ADR's §15 for the Notebook (W3): a new page only in the switch's tab, checked here; an append carries the
     * tab for desk-notebook to check where it writes, and its refusal ({@code place}) is {@code approval_unknown}; a key
     * desk-notebook has seen is {@code approval_used}, never "saved"; nothing unasked on a guild desk; and the undo, by
     * deskd's own ledger, names the edit's key and agent.
     */
    @Test
    void anUnaskedWriteStaysInTheSwitchsTabIsDoneOnceAndUndoneByItsOwnKeyAndAgent() throws Exception {
        ToolHost host = host(false);
        host.access(notebookSwitch());
        // A new page in another tab: refused before desk-notebook hears of it.
        Map<String, Object> elsewhere = host.handle(unasked("ag-1", NotebookToolsTest.args("new",
                Map.of("tabId", "tab-2", "title", "Trip"), "op", "create", "markdown", "x"), "ap-aaaaaaaaaaaaaaaaaaab"));
        assertThat(map(elsewhere.get("details"))).containsEntry("reason", "approval_unknown");
        assertThat(edits()).isZero();
        // In the tab: made, with the tab sent along.
        assertThat(host.handle(unasked("ag-1", NotebookToolsTest.args("new", Map.of("tabId", "tab-1", "title", "Trip"),
                "op", "create", "markdown", "x"), "ap-aaaaaaaaaaaaaaaaaaac"))).containsEntry("t", "tres");
        assertThat(asked.get(asked.size() - 1)).containsEntry("tab", "tab-1").containsEntry("key",
                "auto:ap-aaaaaaaaaaaaaaaaaaac");
        // deskd's own look finds the page in another tab (or an older desk-notebook says no tab): refused, no edit.
        long before = edits();
        answer("notebook.page.agentEdit", p -> Boolean.TRUE.equals(p.get("dryRun"))
                ? NotebookToolsTest.args("pageId", "p-8", "title", "Plan", "op", "append", "dryRun", true, "tabId", "tab-2")
                : NotebookToolsTest.args("pageId", "p-8", "title", "Plan", "op", "append"));
        assertThat(map(host.handle(unasked("ag-1", NotebookToolsTest.args("pageId", "p-8", "op", "append", "markdown",
                "y"), "ap-aaaaaaaaaaaaaaaaaaah")).get("details"))).containsEntry("reason", "approval_unknown");
        answer("notebook.page.agentEdit", p -> NotebookToolsTest.args("pageId", "p-8", "title", "Plan", "op", "append",
                "dryRun", true));
        assertThat(map(host.handle(unasked("ag-1", NotebookToolsTest.args("pageId", "p-8", "op", "append", "markdown",
                "y"), "ap-aaaaaaaaaaaaaaaaaaai")).get("details"))).containsEntry("reason", "approval_unknown");
        assertThat(edits()).isEqualTo(before);
        // desk-notebook finds the page moved out of the tab as it writes: approval_unknown, and the model asks.
        answer("notebook.page.agentEdit", p -> new FakeNotebookSocket.Refusal("forbidden", Map.of("reason", "place")));
        assertThat(map(host.handle(unasked("ag-1", NotebookToolsTest.args("pageId", "p-9", "op", "append", "markdown",
                "y"), "ap-aaaaaaaaaaaaaaaaaaad")).get("details"))).containsEntry("reason", "approval_unknown");
        // A key desk-notebook has seen before (a reused id): approval_used, never saved.
        answer("notebook.page.agentEdit", p -> Boolean.TRUE.equals(p.get("dryRun"))
                ? NotebookToolsTest.args("pageId", "p-1", "title", "Plan", "op", "append", "dryRun", true, "tabId", "tab-1")
                : NotebookToolsTest.args("pageId", "p-1", "title", "Plan", "op", "append", "repeated", true));
        assertThat(map(host.handle(unasked("ag-1", NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown",
                "z"), "ap-aaaaaaaaaaaaaaaaaaae")).get("details"))).containsEntry("reason", "approval_used");
        // The undo of the page it made: desk-notebook's undo by its key, naming the agent.
        answer("notebook.page.agentUndo", p -> NotebookToolsTest.args("editId", "ae-1", "pageId", "p-1", "op", "create",
                "undone", true));
        Map<String, Object> undone = host.undoAuto("ap-aaaaaaaaaaaaaaaaaaac", Caller.THE_OWNER, (c, a) -> true, () -> {});
        assertThat(undone).containsEntry("outcome", "ok");
        assertThat(asked.get(asked.size() - 1)).containsEntry("_method", "notebook.page.agentUndo")
                .containsEntry("key", "auto:ap-aaaaaaaaaaaaaaaaaaac").containsEntry("agent", "ag-1");
        host.close();

        // A guild desk: nothing is done unasked, whatever the record says.
        ToolHost guild = host(true);
        guild.access(notebookSwitch());
        assertThat(map(guild.handle(unasked("gm-ana1", NotebookToolsTest.args("pageId", "p-1", "op", "append",
                "markdown", "w"), "ap-aaaaaaaaaaaaaaaaaaaf")).get("details"))).containsEntry("reason", "approval_unknown");
        guild.close();
    }

    @Test
    void anUnaskedEditsUndoThatChangedSinceOffersTheVersionFromBefore() throws Exception {
        ToolHost host = host(false);
        host.access(notebookSwitch());
        assertThat(host.handle(unasked("ag-1", NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown", "x"),
                "ap-aaaaaaaaaaaaaaaaaaag"))).containsEntry("t", "tres");
        answer("notebook.page.agentUndo", p -> new FakeNotebookSocket.Refusal("conflict",
                Map.of("reason", "changed", "versionId", "v-7")));
        try {
            host.undoAuto("ap-aaaaaaaaaaaaaaaaaaag", Caller.THE_OWNER, (c, a) -> true, () -> {});
            throw new AssertionError("undone");
        } catch (ToolFailure e) {
            assertThat(e.code()).isEqualTo("conflict");
            assertThat(e.details()).containsEntry("reason", "changed").containsEntry("versionId", "v-7");
        }
        host.close();
    }

    /** A newer agent edit of the page stands: {@code newer}, the word only (desk-notebook's edit id isn't the member's). */
    @Test
    void anUnaskedEditsUndoUnderANewerAgentEditSaysNewerAndNothingElse() throws Exception {
        ToolHost host = host(false);
        host.access(notebookSwitch());
        assertThat(host.handle(unasked("ag-1", NotebookToolsTest.args("pageId", "p-1", "op", "append", "markdown", "x"),
                "ap-aaaaaaaaaaaaaaaaaaah"))).containsEntry("t", "tres");
        answer("notebook.page.agentUndo", p -> new FakeNotebookSocket.Refusal("conflict",
                Map.of("reason", "newer", "editId", "ae-newer")));
        try {
            host.undoAuto("ap-aaaaaaaaaaaaaaaaaaah", Caller.THE_OWNER, (c, a) -> true, () -> {});
            throw new AssertionError("undone");
        } catch (ToolFailure e) {
            assertThat(e.code()).isEqualTo("conflict");
            assertThat(e.details()).isEqualTo(Map.of("reason", "newer"));
        }
        host.close();
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
        assertThat(host.offered()).containsExactly("notebook_search", "notebook_list", "notebook_read", "notebook_write", "notebook_trash");
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
