package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Notebook tools against a scripted desk-notebook on a real Unix socket ({@link FakeNotebookSocket}): what each tool
 * asks it, as whom, and what the model gets back; the write's dry-run look; and that a refusal is desk-notebook's word
 * and nothing else it said.
 */
@SuppressWarnings("unchecked")
class NotebookToolsTest {

    static final Caller ANA = new Caller(Caller.GUILD_MEMBER, "gm-ana1", Caller.MEMBER, List.of(), "Ana", null, false);

    @TempDir
    Path dir;

    private FakeNotebookSocket service;
    private NotebookCalls calls;
    /** Every request desk-notebook was sent, as {@code method} then its params. */
    private final List<Map<String, Object>> asked = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        service = new FakeNotebookSocket(dir.resolve("n.sock"));
        calls = new NotebookCalls(service.socket(), () -> null, Duration.ofSeconds(5));
    }

    @AfterEach
    void tearDown() throws Exception {
        service.close();
    }

    private void answer(String method, java.util.function.Function<Map<String, Object>, Object> handler) {
        service.handlers.put(method, p -> {
            Map<String, Object> seen = new LinkedHashMap<>(p);
            seen.put("_method", method);
            asked.add(seen);
            return handler.apply(p);
        });
    }

    static Map<String, Object> args(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static HostedCall call(String tool, Map<String, Object> args, boolean look, Caller caller) {
        return new HostedCall(7, "run-1", caller.isGuildMember() ? caller.memberId() : "ag-1", tool, args, null, look, caller, null);
    }

    private static RunLedger.Run run(Caller caller) throws ToolFailure {
        return new RunLedger(Clock.systemUTC(), id -> { }).join("run-1", caller.isGuildMember() ? caller.memberId() : "ag-1", caller, List.of());
    }

    private NotebookTools tools(boolean guild) {
        return new NotebookTools(calls, () -> guild);
    }

    private Map<String, Object> helloOfLast() throws InterruptedException {
        return service.last().next("hello");
    }

    @Test
    void searchAsksAsTheOwnerAndGivesAtMostTwentyHitsWithTitlesAndSnippetsOnly() throws Exception {
        answer("notebook.search", p -> {
            List<Object> hits = new ArrayList<>();
            for (int i = 0; i < 25; i++) {
                hits.add(args("pageId", "p" + i, "score", 1.5, "title", "T" + i, "titleMatches", List.of(), "snippet", "s" + i, "snippetMatches", List.of()));
            }
            return Map.of("hits", hits);
        });
        HostedTool.Result r = tools(false).run(call("notebook_search", args("query", "trip", "tabId", "t-1"), false, Caller.THE_OWNER), run(Caller.THE_OWNER));
        List<Object> hits = (List<Object>) ((Map<String, Object>) r.content()).get("hits");
        assertThat(hits).hasSize(20);
        assertThat((Map<String, Object>) hits.get(0)).containsOnlyKeys("pageId", "title", "snippet").containsEntry("title", "T0");
        assertThat(asked.get(0)).containsEntry("query", "trip").containsEntry("tabId", "t-1").containsEntry("limit", 20);
        assertThat(r.taints()).isEmpty();
        Map<String, Object> caller = (Map<String, Object>) helloOfLast().get("caller");
        assertThat(caller).containsEntry("kind", "owner").containsEntry("memberId", null);
    }

    @Test
    void readGivesTheMarkdownPageAndSaysWhenThereIsMore() throws Exception {
        answer("notebook.page.markdown", p -> args("pageId", p.get("pageId"), "title", "Plan", "markdown", "# Plan\n", "from", 0, "next", 7, "length", 30, "trashed", false));
        HostedTool.Result r = tools(false).run(call("notebook_read", args("pageId", "p-1", "from", 0), false, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat((Map<String, Object>) r.content()).containsEntry("markdown", "# Plan\n").containsEntry("next", 7).containsKey("note");
        assertThat(asked.get(0)).containsEntry("pageId", "p-1").containsEntry("from", 0);
    }

    @Test
    void aWritesLookIsADryRunOfExactlyThePayloadAndGivesTheTitleAsTheBefore() throws Exception {
        answer("notebook.page.agentEdit", p -> args("pageId", p.get("pageId"), "title", "Plan", "op", p.get("op"), "dryRun", true));
        Map<String, Object> given = args("pageId", "p-1", "op", "replace_text", "markdown", "Friday", "find", "Monday", "extra", "dropped");
        HostedTool.Look look = tools(false).look(call("notebook_write", given, true, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat(look.risk()).isEqualTo(ToolRisk.WRITE);
        assertThat(look.context()).isEqualTo("agent");
        assertThat(look.payload()).containsExactly(
                Map.entry("pageId", "p-1"), Map.entry("op", "replace_text"), Map.entry("markdown", "Friday"), Map.entry("find", "Monday"));
        assertThat(look.target()).containsEntry("kind", "page").containsEntry("pageId", "p-1").containsEntry("title", "Plan");
        assertThat(look.before()).isEqualTo(Map.of("title", "Plan"));
        assertThat(asked.get(0)).containsEntry("dryRun", true).containsEntry("agentName", "ag-1").containsEntry("find", "Monday").doesNotContainKey("extra");
    }

    @Test
    void aNewPagesLookHasNoPageIdAndNothingBefore() throws Exception {
        answer("notebook.page.agentEdit", p -> args("pageId", null, "title", "Trip", "op", "create", "dryRun", true));
        Map<String, Object> made = args("tabId", "t-1", "title", "Trip");
        HostedTool.Look look = tools(false).look(call("notebook_write", args("new", made, "op", "create", "markdown", "- tickets"), true, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat(look.target()).containsEntry("pageId", null).containsEntry("title", "Trip");
        assertThat(look.before()).isNull();
        assertThat(look.payload()).containsEntry("new", made).doesNotContainKey("pageId");
    }

    @Test
    void theLookBeforeARunAsksDeskNotebookNothing() throws Exception {
        HostedTool.Look look = tools(false).look(call("notebook_write", args("pageId", "p-1", "op", "append", "markdown", "x"), false, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat(look.risk()).isEqualTo(ToolRisk.WRITE);
        tools(false).look(call("notebook_trash", args("pageId", "p-1"), false, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat(service.connections).isEmpty();
    }

    @Test
    void anEditTheDryRunRefusesIsRefusedAtTheLookWithDeskNotebooksWord() throws Exception {
        for (String word : List.of("ambiguous", "not_found", "trashed")) {
            answer("notebook.page.agentEdit", p -> new FakeNotebookSocket.Refusal("conflict", Map.of("reason", word)));
            assertThatThrownBy(() -> tools(false).look(call("notebook_write", args("pageId", "p-1", "op", "replace_text", "markdown", "x", "find", "y"), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                    .isInstanceOfSatisfying(ToolFailure.class, e -> {
                        assertThat(e.code()).isEqualTo("conflict");
                        assertThat(e.reason()).isEqualTo(word);
                    });
        }
        answer("notebook.page.agentEdit", p -> new FakeNotebookSocket.Refusal("forbidden", Map.of("reason", "budget")));
        assertThatThrownBy(() -> tools(false).look(call("notebook_write", args("pageId", "p-1", "op", "append", "markdown", "x"), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.details()).isEqualTo(Map.of("reason", "budget")));
    }

    @Test
    void aWriteRunsWithTheAgentsIdAsItsNameAndSaysAVersionWasKept() throws Exception {
        answer("notebook.page.agentEdit", p -> args("pageId", "p-1", "title", "Plan", "op", "append", "versionId", "v-9"));
        HostedTool.Result r = tools(false).run(call("notebook_write", args("pageId", "p-1", "op", "append", "markdown", "More."), false, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat((Map<String, Object>) r.content()).containsEntry("saved", true).containsEntry("versionId", "v-9").containsKey("note");
        assertThat(asked.get(0)).containsEntry("agentName", "ag-1").containsEntry("markdown", "More.").doesNotContainKey("dryRun");
    }

    @Test
    void trashsLookGivesTheTitleAndATrashedPageIsRefused() throws Exception {
        answer("notebook.page.markdown", p -> args("pageId", p.get("pageId"), "title", "Old notes", "markdown", "", "from", 0, "next", 0, "length", 9, "trashed", false));
        HostedTool.Look look = tools(false).look(call("notebook_trash", args("pageId", "p-1"), true, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat(look.risk()).isEqualTo(ToolRisk.DELETE);
        assertThat(look.before()).isEqualTo(Map.of("title", "Old notes"));
        assertThat(asked.get(0)).containsEntry("max", 0);
        answer("notebook.page.markdown", p -> args("pageId", p.get("pageId"), "title", "Old notes", "markdown", "", "from", 0, "next", 0, "length", 9, "trashed", true));
        assertThatThrownBy(() -> tools(false).look(call("notebook_trash", args("pageId", "p-1"), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("trashed"));
        answer("notebook.page.trash", p -> Map.of());
        HostedTool.Result r = tools(false).run(call("notebook_trash", args("pageId", "p-1"), false, Caller.THE_OWNER), run(Caller.THE_OWNER));
        assertThat((Map<String, Object>) r.content()).containsEntry("trashed", "p-1");
    }

    @Test
    void aRefusalIsACodeAndAWordAndNeverAnythingElseDeskNotebookSaid() {
        String secret = "Title Of A Private Note";
        assertThat(NotebookTools.failure(new RpcException("forbidden", "x", Map.of("reason", "grant"))).details()).isEqualTo(Map.of("reason", "grant"));
        assertThat(NotebookTools.failure(new RpcException("bad_request", "x", Map.of("reason", "page_full"))).reason()).isEqualTo("page_full");
        ToolFailure odd = NotebookTools.failure(new RpcException("bad_request", secret, Map.of("reason", secret, "detail", secret)));
        assertThat(odd.reason()).isEqualTo("bad_request");
        assertThat(odd.details().toString() + odd.getMessage()).doesNotContain(secret);
        assertThat(NotebookTools.failure(new RpcException("not_found", "x", Map.of())).reason()).isEqualTo("not_found");
        assertThat(NotebookTools.failure(new RpcException("too_large", "x", Map.of("reason", "markdown"))).code()).isEqualTo("too_large");
        assertThat(NotebookTools.failure(new RpcException("internal", "x", Map.of())).code()).isEqualTo("internal");
        assertThat(NotebookTools.failure(new RpcException("unavailable", "x", Map.of("reason", "storage_full"))).reason()).isEqualTo("storage_full");
        // A desk-notebook from before the agent methods: the method isn't there, which says nothing of the page.
        ToolFailure older = NotebookTools.failure(new RpcException("not_found", "x", Map.of("reason", "method")));
        assertThat(older.code()).isEqualTo("unavailable");
        assertThat(older.reason()).isEqualTo("notebook");
    }

    @Test
    void argumentsAreCheckedBeforeAnythingIsAsked() {
        NotebookTools tools = tools(false);
        List<Map<String, Object>> bad = List.of(
                args("pageId", "p-1", "op", "move", "markdown", "x"),
                args("pageId", "p-1", "op", "append"),
                args("pageId", "p 1", "op", "append", "markdown", "x"),
                args("pageId", "p-1", "op", "append", "markdown", "x", "find", "y"),
                args("pageId", "p-1", "op", "replace_text", "markdown", "x"),
                args("pageId", "p-1", "op", "create", "markdown", "x", "new", args("tabId", "t", "title", "T")),
                args("op", "create", "markdown", "x", "new", args("tabId", "t", "title", " ")),
                args("pageId", "p-1", "op", "append", "markdown", "x", "new", args("tabId", "t", "title", "T")));
        for (Map<String, Object> a : bad) {
            assertThatThrownBy(() -> tools.look(call("notebook_write", a, true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                    .as(a.toString()).isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.code()).isEqualTo("bad_request"));
        }
        assertThatThrownBy(() -> tools.look(call("notebook_write", args("pageId", "p-1", "op", "append", "markdown", "x".repeat(65_537)), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("too_large"));
        assertThatThrownBy(() -> tools.look(call("notebook_search", args("query", "  "), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOf(ToolFailure.class);
        assertThatThrownBy(() -> tools.look(call("notebook_search", args("query", "a", "limit", 21), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOf(ToolFailure.class);
        assertThatThrownBy(() -> tools.look(call("notebook_read", args("pageId", "p-1", "from", -1), true, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOf(ToolFailure.class);
        assertThat(service.connections).isEmpty();
    }

    @Test
    void deskNotebookAwayIsUnavailable() throws Exception {
        service.close();
        assertThatThrownBy(() -> tools(false).run(call("notebook_read", args("pageId", "p-1"), false, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> {
                    assertThat(e.code()).isEqualTo("unavailable");
                    assertThat(e.details()).isEqualTo(Map.of("reason", "notebook"));
                });
        assertThat(new NotebookTools(new NotebookCalls(null, null, Duration.ofSeconds(1)), () -> false).available()).isFalse();
        assertThat(tools(false).available()).isTrue();
    }

    @Test
    void anEditThatGetsNoAnswerMayHaveHappenedAndAReadThatGetsNoneIsJustUnavailable() throws Exception {
        calls = new NotebookCalls(service.socket(), () -> null, Duration.ofMillis(300));
        // No handler: the request waits for the test, which never answers.
        assertThatThrownBy(() -> tools(false).run(call("notebook_write", args("pageId", "p-1", "op", "append", "markdown", "x"), false, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.details()).isEqualTo(Map.of("reason", "notebook", "mayHaveApplied", true)));
        assertThatThrownBy(() -> tools(false).run(call("notebook_read", args("pageId", "p-1"), false, Caller.THE_OWNER), run(Caller.THE_OWNER)))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.details()).isEqualTo(Map.of("reason", "notebook")));
        assertThat(service.requests.poll(5, TimeUnit.SECONDS)).isNotNull();
    }

    @Test
    void onAGuildDeskTheMemberIsTheCallerWithTheEditBudgetAndEveryResultIsUntrusted() throws Exception {
        Map<String, Object> budget = Map.of("editBudget", Map.of("chars", 200, "windowMinutes", 5));
        calls = new NotebookCalls(service.socket(), () -> budget, Duration.ofSeconds(5));
        answer("notebook.page.agentEdit", p -> args("pageId", "p-1", "title", "Plan", "op", "append", "versionId", "v-1"));
        HostedTool.Result r = tools(true).run(call("notebook_write", args("pageId", "p-1", "op", "append", "markdown", "x"), false, ANA), run(ANA));
        assertThat(r.taints()).containsExactly("U");
        Map<String, Object> hello = helloOfLast();
        assertThat(hello).containsEntry("sub", "gm-ana1").containsEntry("settings", budget);
        assertThat((Map<String, Object>) hello.get("caller")).containsEntry("kind", "guild_member").containsEntry("memberId", "gm-ana1")
                .containsEntry("role", "member").containsEntry("grants", List.of());
        assertThat(asked.get(0)).containsEntry("agentName", "gm-ana1");
    }

    @Test
    void deskdsOwnCallsAreOnlyTheToolsMethods() {
        assertThatThrownBy(() -> calls.call(Caller.THE_OWNER, "notebook.page.restore", Map.of("pageId", "p-1"), true))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> calls.call(Caller.THE_OWNER, "notebook.version.restore", Map.of(), true))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(NotebookCalls.METHODS).containsExactlyInAnyOrder(
                "notebook.search", "notebook.page.markdown", "notebook.page.agentEdit", "notebook.page.trash");
    }
}
