package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The workspace tools every agent has, and the RPCs for the member ({@code multi-agent.md} sections 5 and 8). */
class WorkspaceToolsTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private TeamDesk desk;
    private String a;
    private String b;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data);
        a = desk.agent("Alice");
        b = desk.agent("Bob");
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    /** One model step of tool calls, then an answer; the results the model read afterwards. */
    private List<ToolResult> run(String agentId, com.minimalistalliance.desk.agent.provider.ToolCall... calls)
            throws Exception {
        desk.provider.then(Step.calls(USAGE, List.of(calls))).then(Step.answer(USAGE, "Done."));
        desk.ask(agentId, "Work in your workspace.");
        return TeamDesk.toolResults(desk.lastRequest());
    }

    private static void assertOk(ToolResult result) {
        assertThat(result.error()).as(result.content()).isFalse();
    }

    private static void assertRefused(ToolResult result) {
        assertThat(result.error()).as(result.content()).isTrue();
    }

    private List<String> filesOutsideTheAgents() throws IOException {
        try (Stream<Path> walk = Files.walk(data)) {
            return walk.filter(Files::isRegularFile)
                    .map(p -> data.relativize(p).toString())
                    .filter(p -> !p.startsWith("workspaces/") && !p.startsWith("keys/") && !p.contains("agent.db")
                            && !p.contains("audit.db") && !p.contains("usage.db"))
                    .toList();
        }
    }

    // ---------------------------------------------------------------- an agent's own workspace

    @Test
    void anAgentWritesAndReadsItsOwnFiles() throws Exception {
        List<ToolResult> results = run(a,
                call("w1", "workspace_write", "path", "notes/a.txt", "text", "hello"),
                call("w2", "workspace_read", "path", "notes/a.txt"),
                call("w3", "workspace_write", "path", "notes/a.txt", "text", " world", "append", true),
                call("w4", "workspace_read", "path", "notes/a.txt"),
                call("w5", "workspace_list"),
                call("w6", "workspace_list", "path", "notes"));

        assertThat(results).hasSize(6).noneMatch(ToolResult::error);
        assertThat(results.get(0).content()).contains("Saved").contains("8192 bytes");
        assertThat(results.get(1).content()).isEqualTo("hello");
        assertThat(results.get(3).content()).isEqualTo("hello world");
        assertThat(results.get(4).content()).contains("notes").contains("\"usedBytes\":8192").contains("quotaBytes");
        assertThat(results.get(5).content()).contains("notes/a.txt").contains("\"bytes\":11");
        assertThat(Files.readString(data.resolve("workspaces").resolve(a).resolve("notes/a.txt"))).isEqualTo("hello world");
        assertThat(map(desk.agentView(a).get("workspace"))).containsEntry("usedBytes", 8192L);
    }

    @Test
    void theRepliesToolChipsListWhatRanAndWhatWasRefused() throws Exception {
        run(a, call("w1", "workspace_write", "path", "n.txt", "text", "x"), call("w2", "workspace_read",
                "path", "../x"), call("w3", "workspace_list"));

        List<Map<String, Object>> chips = list(desk.lastReply(a).get("tools"));

        assertThat(chips).extracting(c -> c.get("name")).containsExactly("workspace_write", "workspace_read",
                "workspace_list");
        assertThat(chips).extracting(c -> c.get("summary")).containsExactly("Wrote a file: n.txt",
                "Read a file: ../x (refused)", "Listed the workspace");
        assertThat(chips).extracting(c -> c.get("ok")).containsExactly(true, false, true);
    }

    @Test
    void pathsOutsideTheWorkspaceAreRefusedAsErrorResults() throws Exception {
        List<ToolResult> results = run(a,
                call("p1", "workspace_write", "path", "../x", "text", "x"),
                call("p2", "workspace_write", "path", "/etc/passwd", "text", "x"),
                call("p3", "workspace_write", "path", "notes/../../x", "text", "x"),
                call("p4", "workspace_read", "path", "../" + b + "/secret.txt"),
                call("p5", "workspace_write", "path", "./a.txt", "text", "x"),
                call("p6", "workspace_write", "path", "a\0b", "text", "x"),
                call("p7", "workspace_write", "path", "d/".repeat(17) + "f", "text", "x"),
                call("p8", "workspace_list", "path", ".."),
                call("p9", "workspace_read", "path", "nothing-here.txt"),
                call("p10", "workspace_write", "path", "a.txt"),
                call("p11", "workspace_read"));

        assertThat(results).hasSize(11).allMatch(ToolResult::error);
        assertThat(results.get(0).content()).startsWith("Refused:");
        assertThat(results.get(8).content()).contains("not_found");
        assertThat(filesOutsideTheAgents()).isEmpty();
        assertThat(data.resolve("x")).doesNotExist();
        assertThat(data.resolve("workspaces/x")).doesNotExist();
        try (Stream<Path> files = Files.walk(data.resolve("workspaces").resolve(a))) {
            assertThat(files.filter(Files::isRegularFile)).isEmpty();
        }
    }

    @Test
    void aSymbolicLinkPlacedInAWorkspaceLeadsNowhere() throws Exception {
        Path outside = Files.createDirectory(data.resolve("outside"));
        Files.writeString(outside.resolve("secret.txt"), "outside");
        Files.createSymbolicLink(data.resolve("workspaces").resolve(a).resolve("link"), outside);

        List<ToolResult> results = run(a, call("l1", "workspace_read", "path", "link/secret.txt"),
                call("l2", "workspace_write", "path", "link/new.txt", "text", "x"));

        assertThat(results).allMatch(ToolResult::error);
        assertThat(outside.resolve("new.txt")).doesNotExist();
    }

    @Test
    void aLongResultIsCutBeforeTheModelReadsIt() throws Exception {
        desk.team.workspaces().write(a, "long.txt", "y".repeat(50_000), false, 10L << 20);

        List<ToolResult> results = run(a, call("r1", "workspace_read", "path", "long.txt"));

        assertOk(results.getFirst());
        assertThat(results.getFirst().content()).hasSizeLessThan(20_100).contains("[cut at 20000 characters]");
    }

    // ---------------------------------------------------------------- another agent's workspace

    @Test
    void anotherAgentsWorkspaceIsRefusedUntilSharedThenReadOnly() throws Exception {
        desk.team.workspaces().write(b, "secret.txt", "bob's notes", false, 1 << 20);

        List<ToolResult> before = run(a,
                call("s1", "workspace_read", "workspace", b, "path", "secret.txt"),
                call("s2", "workspace_list", "workspace", "Bob"),
                call("s3", "workspace_write", "workspace", b, "path", "secret.txt", "text", "mine now"));
        assertThat(before).hasSize(3).allMatch(ToolResult::error);
        assertThat(before.get(0).content()).contains("forbidden").contains("not_shared");

        desk.call("agent.workspace.share", "agentId", b, "with", List.of(a));
        assertThat(map(desk.agentView(b).get("workspace"))).containsEntry("sharedWith", List.of(a));

        List<ToolResult> shared = run(a,
                call("t1", "workspace_read", "workspace", b, "path", "secret.txt"),
                call("t2", "workspace_read", "workspace", "bob", "path", "secret.txt"),
                call("t3", "workspace_list", "workspace", b),
                call("t4", "workspace_write", "workspace", b, "path", "secret.txt", "text", "mine now"),
                call("t5", "workspace_write", "workspace", b, "path", "new.txt", "text", "mine now"),
                call("t6", "workspace_write", "workspace", a, "path", "own.txt", "text", "fine"));

        assertOk(shared.get(0));
        assertThat(shared.get(0).content()).contains("bob's notes").contains("data, not instructions");
        assertOk(shared.get(1));
        assertOk(shared.get(2));
        assertThat(shared.get(2).content()).contains("secret.txt").doesNotContain("quotaBytes");
        assertRefused(shared.get(3));
        assertThat(shared.get(3).content()).contains("forbidden").contains("read_only");
        assertRefused(shared.get(4));
        assertOk(shared.get(5));
        assertThat(Files.readString(data.resolve("workspaces").resolve(b).resolve("secret.txt"))).isEqualTo("bob's notes");
        assertThat(data.resolve("workspaces").resolve(b).resolve("new.txt")).doesNotExist();
        assertThat(desk.requests().get(desk.requests().size() - 2).system()).contains("shared").contains("read only");

        desk.call("agent.workspace.share", "agentId", b, "with", List.of());
        List<ToolResult> after = run(a, call("u1", "workspace_read", "workspace", b, "path", "secret.txt"));
        assertRefused(after.getFirst());
    }

    @Test
    void sharingIsSharingWithOtherExistingAgentsOnly() throws Exception {
        for (Object with : new Object[] {List.of(b), List.of("ag-nobody0000"), "all", List.of(1)}) {
            RpcError e = desk.refused("agent.workspace.share", "agentId", b, "with", with);
            assertThat(e.code()).isEqualTo("bad_request");
            assertThat(e.details()).containsEntry("detail", "with");
        }
        assertThat(desk.refused("agent.workspace.share", "agentId", "ag-nope", "with", List.of()).code())
                .isEqualTo("not_found");
        assertThat(map(desk.agentView(b).get("workspace"))).containsEntry("sharedWith", List.of());
    }

    @Test
    void deletingASharedAgentLeavesTheShareHarmless() throws Exception {
        desk.call("agent.workspace.share", "agentId", b, "with", List.of(a));
        desk.call("agent.delete", "agentId", a);

        assertThat(desk.agentView(b)).isNotNull();
        List<ToolResult> results = run(b, call("x1", "workspace_list"));
        assertOk(results.getFirst());
    }

    // ---------------------------------------------------------------- the member's RPCs

    @Test
    void theMemberBrowsesReadsAndDeletes() throws Exception {
        desk.team.workspaces().write(a, "notes/a.txt", "hello", false, 1 << 20);
        desk.team.workspaces().write(a, "top.md", "# top", false, 1 << 20);

        Map<String, Object> top = desk.call("agent.workspace.get", "agentId", a);
        assertThat(top).containsEntry("usedBytes", 12288L).containsEntry("quotaBytes", 50L << 20)
                .containsEntry("sharedWith", List.of());
        assertThat(list(top.get("entries"))).extracting(e -> e.get("path")).containsExactlyInAnyOrder("notes", "top.md");
        assertThat(list(top.get("entries"))).filteredOn(e -> e.get("path").equals("notes"))
                .singleElement().satisfies(e -> assertThat(e).containsEntry("dir", true));

        Map<String, Object> inNotes = desk.call("agent.workspace.get", "agentId", a, "path", "notes");
        assertThat(list(inNotes.get("entries"))).singleElement().satisfies(e -> {
            assertThat(e).containsEntry("path", "notes/a.txt").containsEntry("dir", false).containsEntry("bytes", 5L);
            assertThat(e.get("modifiedAt")).isInstanceOf(Long.class);
        });

        assertThat(desk.call("agent.workspace.read", "agentId", a, "path", "notes/a.txt")).containsEntry("text", "hello")
                .containsEntry("bytes", 5L).containsEntry("truncated", false).containsEntry("path", "notes/a.txt");

        assertThat(desk.call("agent.workspace.delete", "agentId", a, "path", "notes/a.txt")).containsEntry("usedBytes",
                8192L);
        assertThat(desk.refused("agent.workspace.read", "agentId", a, "path", "notes/a.txt").code())
                .isEqualTo("not_found");
        assertThat(desk.call("agent.workspace.delete", "agentId", a, "path", "top.md")).containsEntry("usedBytes", 4096L);
        assertThat(list(desk.call("agent.workspace.get", "agentId", a).get("entries")))
                .extracting(e -> e.get("path")).containsExactly("notes");
        assertThat(desk.audit.readBefore(null, 100)).anyMatch(r -> r.entry().action().equals("workspace.delete"));
    }

    @Test
    void theMembersRpcsRefuseBadAndMissingPaths() throws Exception {
        for (String method : new String[] {"agent.workspace.get", "agent.workspace.read", "agent.workspace.delete"}) {
            RpcError bad = desk.refused(method, "agentId", a, "path", "../" + b);
            assertThat(bad.code()).as(method).isEqualTo("bad_request");
            assertThat(bad.details()).containsEntry("detail", "path");
            RpcError absolute = desk.refused(method, "agentId", a, "path", "/etc/passwd");
            assertThat(absolute.details()).containsEntry("detail", "path");
            assertThat(desk.refused(method, "agentId", "ag-nope", "path", "x").code()).isEqualTo("not_found");
        }
        RpcError missing = desk.refused("agent.workspace.read", "agentId", a, "path", "nope.txt");
        assertThat(missing.code()).isEqualTo("not_found");
        assertThat(missing.details()).containsEntry("detail", "path");
        assertThat(desk.refused("agent.workspace.get", "agentId", a, "path", "nofolder").code()).isEqualTo("not_found");
    }

    // ---------------------------------------------------------------- the quota

    @Test
    void theQuotaIsTheTiersUnlessTheAgentHasItsOwn() throws Exception {
        desk.tier(m("workspaceMb", 1));
        String roomy = desk.agent("Roomy", "workspaceMb", 3);
        String tiny = desk.agent("Tiny"); // the tier's default is stored when the agent is made
        String chunk = "z".repeat(600_000);

        List<ToolResult> small = run(tiny, call("q1", "workspace_write", "path", "one.txt", "text", chunk),
                call("q2", "workspace_write", "path", "two.txt", "text", chunk));
        assertOk(small.get(0));
        assertRefused(small.get(1));
        assertThat(small.get(1).content()).contains("quota");
        assertThat(data.resolve("workspaces").resolve(tiny).resolve("two.txt")).doesNotExist();
        assertThat(map(desk.agentView(tiny).get("workspace"))).containsEntry("quotaBytes", 1L << 20)
                .containsEntry("usedBytes", 600_000L);

        List<ToolResult> big = run(roomy, call("q3", "workspace_write", "path", "one.txt", "text", chunk),
                call("q4", "workspace_write", "path", "two.txt", "text", chunk));
        assertThat(big).noneMatch(ToolResult::error);
        assertThat(map(desk.agentView(roomy).get("workspace"))).containsEntry("quotaBytes", 3L << 20)
                .containsEntry("usedBytes", 1_200_000L);
        assertThat(desk.requests().get(desk.requests().size() - 2).system()).contains("3 MB");
    }

    @Test
    void aSingleWriteOverOneMegabyteIsRefused() throws Exception {
        desk.tier(m("workspaceMb", 50));

        List<ToolResult> results = run(a, call("big", "workspace_write", "path", "huge.txt", "text",
                "h".repeat((1 << 20) + 1)));

        assertRefused(results.getFirst());
        assertThat(results.getFirst().content()).contains("too_large");
    }

    // ---------------------------------------------------------------- the disk budget, clamping, paging

    private long capsMb(String key) throws Exception {
        return ((Number) map(desk.call("agent.caps").get("caps")).get(key)).longValue();
    }

    @Test
    void theQuotasTogetherStayInHalfTheVolume() throws Exception {
        desk.tier(m("workspaceMb", 100, "workspaceMaxMb", 400));
        desk.volume.set((capsMb("workspaceTotalMb") + 150) * 2 * (1L << 20)); // 150 MB of budget left
        assertThat(capsMb("workspaceBudgetMb")).isEqualTo(capsMb("workspaceTotalMb") + 150);

        assertThat(desk.refused("agent.create", "name", "Big", "workspaceMb", 151).details())
                .containsEntry("reason", "disk_budget");
        String c = desk.agent("Cee", "workspaceMb", 100);
        String d = desk.agent("Dee"); // no size: the tier's 100 MB would pass what is left, so it takes 50
        assertThat(map(desk.agentView(d).get("workspace"))).containsEntry("quotaBytes", 50L << 20);
        assertThat(capsMb("workspaceTotalMb")).isEqualTo(capsMb("workspaceBudgetMb"));
        assertThat(desk.refused("agent.create", "name", "Eee").details()).containsEntry("reason", "disk_budget");
        assertThat(desk.refused("agent.create", "name", "Eee", "workspaceMb", 1).details())
                .containsEntry("reason", "disk_budget");

        // A raise that passes the budget is refused, a lower one is not, and room freed can be taken.
        assertThat(desk.refused("agent.update", "agentId", c, "workspaceMb", 101).details())
                .containsEntry("reason", "disk_budget");
        desk.call("agent.update", "agentId", c, "workspaceMb", 60);
        desk.call("agent.update", "agentId", d, "workspaceMb", 90);
        assertThat(capsMb("workspaceTotalMb")).isEqualTo(capsMb("workspaceBudgetMb"));
        // The same check for the lead's proposal when it is confirmed.
        assertThat(desk.refused("agent.update", "agentId", d, "workspaceMb", 91).details())
                .containsEntry("reason", "disk_budget");
    }

    @Test
    void aQuotaIsStoredAtCreateAndClampedToTheTiersMax() throws Exception {
        desk.tier(m("workspaceMb", 80, "workspaceMaxMb", 400));
        String e = desk.agent("Eve", "workspaceMb", 300);
        String f = desk.agent("Fay");
        desk.tier(m("workspaceMb", 20, "workspaceMaxMb", 100));
        assertThat(map(desk.agentView(f).get("workspace"))).containsEntry("quotaBytes", 80L << 20); // not shrunk
        assertThat(map(desk.agentView(e).get("workspace"))).containsEntry("quotaBytes", 100L << 20); // clamped
        assertThat(map(desk.call("agent.workspace.get", "agentId", e)).get("quotaBytes")).isEqualTo(100L << 20);
        desk.tier(m("workspaceMb", 20, "workspaceMaxMb", 400));
        assertThat(map(desk.agentView(e).get("workspace"))).containsEntry("quotaBytes", 300L << 20);
    }

    @Test
    void aBigFileIsReadInPagesOfCharacters() throws Exception {
        desk.team.workspaces().write(a, "big.txt", "x".repeat(300_000), false, 1 << 20);
        Map<String, Object> first = desk.call("agent.workspace.read", "agentId", a, "path", "big.txt");
        assertThat((String) first.get("text")).hasSize(131_072);
        assertThat(first).containsEntry("offset", 0L).containsEntry("remaining", 300_000L - 131_072)
                .containsEntry("truncated", true).containsEntry("bytes", 300_000L);
        Map<String, Object> rest = desk.call("agent.workspace.read", "agentId", a, "path", "big.txt", "offset",
                131_072, "length", 1_000_000);
        assertThat((String) rest.get("text")).hasSize(131_072); // never more than a page
        assertThat(rest).containsEntry("offset", 131_072L).containsEntry("remaining", 300_000L - 262_144);
        Map<String, Object> end = desk.call("agent.workspace.read", "agentId", a, "path", "big.txt", "offset", 262_144);
        assertThat((String) end.get("text")).hasSize(300_000 - 262_144);
        assertThat(end).containsEntry("remaining", 0L).containsEntry("truncated", false);
        assertThat(desk.refused("agent.workspace.read", "agentId", a, "path", "big.txt", "offset", -1).code())
                .isEqualTo("bad_request");

        List<ToolResult> results = run(a, call("r1", "workspace_read", "path", "big.txt", "length", 100),
                call("r2", "workspace_read", "path", "big.txt", "offset", 299_990));
        assertThat(results.get(0).content()).startsWith("x".repeat(100)).contains("299900 more characters")
                .contains("offset 100");
        assertThat(results.get(1).content()).isEqualTo("x".repeat(10));
    }

    @Test
    void anAgentMayNameItsOwnWorkspaceAndFoldersAreCapped() throws Exception {
        for (int i = 0; i < 2000; i++) {
            Files.createDirectory(data.resolve("workspaces").resolve(a).resolve("d" + i));
        }
        desk.team.workspaces().create(a); // counted afresh
        List<ToolResult> results = run(a,
                call("n1", "workspace_write", "path", "me.txt", "text", "mine", "workspace", "Alice"),
                call("n2", "workspace_read", "path", "me.txt", "workspace", "Alice"),
                call("n3", "workspace_write", "path", "x.txt", "text", "no", "workspace", "Bob"));
        assertOk(results.get(0));
        assertThat(results.get(1).content()).isEqualTo("mine");
        assertRefused(results.get(2));

        ToolResult refused = run(a, call("n4", "workspace_write", "path", "new/f.txt", "text", "x")).getFirst();
        assertRefused(refused);
        assertThat(refused.content()).contains("too_many_folders");
    }
}
