package com.minimalistalliance.desk.agent.approval;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.tool.Classified;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.Taint;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * The per-agent approval policy and the low-risk class (the owner's decision of Nov 12: auto-approve for low-risk writes,
 * chosen per agent at setup; ask by default; the draft ADR's §15). The default asks for everything; only a group a member
 * switched on for one agent lets a call through, and only within {@link LowRisk}'s rules, which no map can widen.
 */
class ApprovalPolicyTest {

    /** Every declared tool, in a group of its own name: the widest map there could be. */
    private static final Map<String, String> EVERY = everyTool();

    private static Map<String, String> everyTool() {
        Map<String, String> all = new HashMap<>();
        new ToolRegistry().all().forEach(d -> all.put(d.name(), "g_" + d.name()));
        return Map.copyOf(all);
    }

    private static RunContext run(String agentId, Set<Taint> taint) {
        Caller owner = Caller.isMemberAgent(agentId) ? new Caller(Caller.MEMBER_KIND, agentId, null, List.of(), false)
                : Caller.OWNER;
        return RunContext.of("run-1", agentId, owner, Map.of("kind", "member"), "msg-1", taint, null);
    }

    private static Classified call(String tool, Risk declared, Risk risk, String context, Map<String, Object> payload) {
        ToolDecl decl = new ToolDecl(tool, "Do {path}", null, declared == Risk.DELETE ? "files:trash" : "files:write",
                declared, Set.of(), ToolDecl.Host.DESKD);
        return new Classified(new ToolCall("c1", tool, payload, false, null), decl, risk, context,
                Map.of("kind", "file", "path", "a.txt"), payload, null);
    }

    private static Classified newFile(String text) {
        return call("files_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("path", "Notes/a.txt", "text", text,
                "replace", false));
    }

    private static Classified registered(String tool) {
        ToolDecl decl = new ToolRegistry().decl(tool);
        return new Classified(new ToolCall("c1", tool, Map.of(), false, null), decl, decl.risk(), "agent", null, Map.of(),
                null);
    }

    @Test
    void theDefaultAsksForEverythingAndTheAdrsClassIsExactlyItsAddingTools() {
        // The ADR's §15: Notebook additions, new files and folders (W3); To-do's group (W4), decided per call by deskd's
        // look: a call with no group from deskd asks.
        assertThat(LowRisk.ADR_GROUPS).isEqualTo(Map.of("notebook_write", "notebook", "files_write", "files",
                "files_mkdir", "files", "todo_add", "todos", "todo_update", "todos", "todo_close", "todos"));
        assertThat(LowRisk.ADR.groups()).isEqualTo(LowRisk.ADR_GROUPS);
        assertThat(LowRisk.GROUPS).containsExactlyInAnyOrder("notebook", "files", "todos");
        RunContext clean = run("ag-1", Set.of());
        for (String tool : EVERY.keySet()) {
            Classified c = registered(tool);
            assertThat(ApprovalPolicy.ASK_ALWAYS.allows(c, clean)).as(tool).isNull();
            // Every switch on with no place known: nothing is inside a place that isn't there.
            assertThat(ApprovalPolicy.perAgent(id -> Set.of("notebook", "files", "todos"), LowRisk.ADR).allows(c, clean))
                    .as("no place, nothing through: %s", tool).isNull();
        }
        // Every class tool the ADR maps runs in deskd, which checks it again (Security's AAW-I5).
        for (String tool : LowRisk.ADR_GROUPS.keySet()) {
            assertThat(new ToolRegistry().decl(tool).host()).as(tool).isEqualTo(ToolDecl.Host.DESKD);
        }
    }

    @Test
    void onlyAGroupSwitchedOnForThatAgentLetsAWriteThroughInsideItsPlace() {
        LowRisk files = new LowRisk(Map.of("files_write", "files", "files_mkdir", "files"));
        LowRisk.Switches notes = new LowRisk.Switches(Set.of("files"), null, "Notes");
        ApprovalPolicy policy = ApprovalPolicy.perAgentWithPlaces(id -> id.equals("ag-auto") ? notes
                : LowRisk.Switches.OFF, files);
        assertThat(policy.allows(newFile("x"), run("ag-auto", Set.of()))).isEqualTo("files");
        assertThat(policy.allows(newFile("x"), run("ag-ask", Set.of()))).isNull();
        // Another folder, or the groups with no place: it asks.
        assertThat(ApprovalPolicy.perAgentWithPlaces(id -> new LowRisk.Switches(Set.of("files"), null, "Other"), files)
                .allows(newFile("x"), run("ag-auto", Set.of()))).isNull();
        assertThat(ApprovalPolicy.perAgent(id -> Set.of("files"), files).allows(newFile("x"), run("ag-auto",
                Set.of()))).isNull();
        // Another group on doesn't cover it, and a tool off the map asks for the auto agent too.
        assertThat(ApprovalPolicy.perAgentWithPlaces(id -> new LowRisk.Switches(Set.of("notebook"), "tab-1", null),
                files).allows(newFile("x"), run("ag-auto", Set.of()))).isNull();
        assertThat(policy.allows(call("files_move", Risk.WRITE, Risk.WRITE, "agent", Map.of("from", "a", "to", "b")),
                run("ag-auto", Set.of()))).isNull();
    }

    @Test
    void noMapCanWidenTheClassPastAnAddingWriteOfTheAgentsOwnInACleanRun() {
        LowRisk everything = new LowRisk(EVERY);
        RunContext clean = run("ag-1", Set.of());
        // Every class but write, whatever the map says.
        for (Risk risk : Risk.values()) {
            for (Risk declared : Risk.values()) {
                if (risk.ordinal() < declared.ordinal()) {
                    continue; // a call's class never falls below its declaration's
                }
                boolean covered = everything.covers(call("files_mkdir", declared, risk, "agent", Map.of("path", "d")),
                        clean);
                assertThat(covered).as("declared %s, called %s", declared, risk)
                        .isEqualTo(declared == Risk.WRITE && risk == Risk.WRITE);
            }
        }
        // A read risen to a write (a click in the member's session) is never low-risk, nor is anything there.
        assertThat(everything.covers(call("browser_click", Risk.READ, Risk.WRITE, "agent", Map.of()), clean)).isFalse();
        assertThat(everything.covers(call("files_mkdir", Risk.WRITE, Risk.WRITE, "member:example.com", Map.of()),
                clean)).isFalse();
        // A run that has read untrusted content asks for every write; private data alone doesn't stop it.
        assertThat(everything.covers(newFile("x"), run("ag-1", Set.of(Taint.U)))).isFalse();
        assertThat(everything.covers(newFile("x"), run("ag-1", Set.of(Taint.S)))).isTrue();
        // It only adds: never a replace, and within the unasked size.
        assertThat(everything.covers(call("files_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("path", "a", "text",
                "x", "replace", true)), clean)).isFalse();
        assertThat(everything.covers(newFile("x".repeat(LowRisk.FILE_TEXT_MAX)), clean)).isTrue();
        assertThat(everything.covers(newFile("x".repeat(LowRisk.FILE_TEXT_MAX + 1)), clean)).isFalse();
        // A new page's title counts with its Markdown (Security's AAW-I6); an append's 8,000 are its Markdown.
        Map<String, Object> page = Map.of("tabId", "tab-1", "title", "Trip");
        assertThat(everything.covers(call("notebook_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("op", "create",
                "new", page, "markdown", "m".repeat(LowRisk.MARKDOWN_MAX - 4))), clean)).isTrue();
        assertThat(everything.covers(call("notebook_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("op", "create",
                "new", page, "markdown", "m".repeat(LowRisk.MARKDOWN_MAX - 3))), clean)).isFalse();
        assertThat(everything.covers(call("notebook_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("op", "append",
                "pageId", "p-1", "markdown", "m".repeat(LowRisk.MARKDOWN_MAX))), clean)).isTrue();
        assertThat(everything.covers(call("notebook_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("op", "append",
                "pageId", "p-1", "markdown", "m".repeat(LowRisk.MARKDOWN_MAX + 1))), clean)).isFalse();
        // A tool with no rule of its own never adds, whatever the map says (Security's AAW-L4): a move, a rename.
        assertThat(everything.covers(call("files_move", Risk.WRITE, Risk.WRITE, "agent", Map.of("from", "a", "to",
                "b")), clean)).isFalse();
        assertThat(everything.covers(call("notebook_write", Risk.WRITE, Risk.WRITE, "agent", Map.of("op",
                "replace_text", "markdown", "m", "find", "x")), clean)).isFalse();
        // A timer (it starts future spending), a memory save, a call the policy refused, and nothing at all.
        assertThat(everything.covers(call("follow_up", Risk.WRITE, Risk.WRITE, "agent", Map.of("at", 1L, "prompt",
                "p")), clean)).isFalse();
        ToolDecl memory = new ToolDecl("memory_save", "Remember this", null, "memory:self", Risk.WRITE, Set.of(),
                ToolDecl.Host.DESK_AGENT);
        assertThat(everything.covers(new Classified(new ToolCall("c", "memory_save", Map.of(), false, null), memory,
                Risk.WRITE, "agent", null, Map.of(), null), clean)).isFalse();
        assertThat(everything.covers(newFile("x").refused("exists"), clean)).isFalse();
        assertThat(everything.covers(null, clean)).isFalse();
        // A guild member's own agent never does anything unasked (§15 rule 8).
        assertThat(everything.covers(newFile("x"), run("gm-abcd1234", Set.of()))).isFalse();
    }

    @Test
    void theTaintThatStopsItIsTheRunsLiveSet() {
        LowRisk files = new LowRisk(Map.of("files_write", "files"));
        RunContext r = run("ag-1", Set.of());
        assertThat(files.covers(newFile("x"), r)).isTrue();
        r.add(Set.of(Taint.U));
        assertThat(files.covers(newFile("x"), r)).isFalse();
    }

    @Test
    void switchesThatCantBeReadAreAllOff() {
        LowRisk files = new LowRisk(Map.of("files_write", "files"));
        ApprovalPolicy failing = ApprovalPolicy.perAgent(id -> {
            throw new IllegalStateException("store closed");
        }, files);
        assertThat(failing.allows(newFile("x"), run("ag-1", Set.of()))).isNull();
        assertThat(ApprovalPolicy.perAgent(id -> null, files).allows(newFile("x"), run("ag-1", Set.of()))).isNull();
    }

    /**
     * To-do's class is deskd's per-call decision (API.md §22): a call is in the todos group only when deskd's look put it
     * there, then only with the member's switch, in the agent's own context, never a guild member's agent; and an add after
     * untrusted content passes only because deskd's look (ATA-L1) said so.
     */
    @Test
    void toDosAreInTheirGroupOnlyWhenDesksLookSaysSo() {
        ToolRegistry registry = new ToolRegistry();
        ApprovalPolicy on = ApprovalPolicy.perAgent(id -> Set.of("todos"), LowRisk.ADR);
        ApprovalPolicy off = ApprovalPolicy.perAgent(id -> Set.of("notebook"), LowRisk.ADR);
        RunContext untrusted = run("ag-1", Set.of(Taint.U, Taint.S));
        for (String tool : List.of("todo_add", "todo_update", "todo_close")) {
            ToolDecl decl = registry.decl(tool);
            ToolCall c = new ToolCall("c1", tool, Map.of(), false, null);
            Classified fromDeskd = new Classified(c, decl, Risk.WRITE, "agent", null, Map.of(), null, null, "todos");
            Classified noGroup = new Classified(c, decl, Risk.WRITE, "agent", null, Map.of(), null, null, null);
            assertThat(on.allows(fromDeskd, untrusted)).as(tool).isEqualTo("todos");
            assertThat(on.allows(noGroup, untrusted)).as(tool).isNull();
            assertThat(off.allows(fromDeskd, untrusted)).as(tool).isNull();
            assertThat(on.allows(new Classified(c, decl, Risk.WRITE, "member:example.com", null, Map.of(), null, null,
                    "todos"), untrusted)).as(tool).isNull();
            assertThat(on.allows(fromDeskd, run("gm-member01", Set.of()))).as(tool).isNull();
            assertThat(on.allows(new Classified(c, decl, Risk.WRITE, "agent", null, Map.of(), null, null, "files"),
                    untrusted)).as(tool).isNull();
        }
        // todo_close's floor is own, a suggestion, which never asks and is never "done without asking".
        ToolDecl close = registry.decl("todo_close");
        assertThat(close.risk()).isEqualTo(Risk.OWN);
        Classified suggestion = new Classified(new ToolCall("c1", "todo_close", Map.of(), false, null), close, Risk.OWN,
                "agent", null, Map.of(), null, null, null);
        assertThat(on.allows(suggestion, untrusted)).isNull();
    }

    /** deskd keeps its own copy of the low-risk map; the two must name the same tools in the same groups (today none). */
    @Test
    void deskdsLowRiskMapIsThisOne() throws Exception {
        Path hosted = Path.of("..", "deskd", "src", "main", "java", "com", "minimalistalliance", "desk", "deskd", "tools",
                "HostedDecls.java");
        Assumptions.assumeTrue(Files.exists(hosted), "deskd's sources aren't beside this module");
        String source = Files.readString(hosted);
        Matcher m = Pattern.compile("Map<String, String> LOW_RISK = Map\\.of\\(([^)]*)\\);").matcher(source);
        assertThat(m.find()).as("HostedDecls.LOW_RISK").isTrue();
        String[] parts = m.group(1).isBlank() ? new String[0] : m.group(1).split(",");
        Map<String, String> theirs = new HashMap<>();
        for (int i = 0; i + 1 < parts.length; i += 2) {
            theirs.put(parts[i].strip().replace("\"", ""), parts[i + 1].strip().replace("\"", ""));
        }
        assertThat(theirs).isEqualTo(LowRisk.ADR_GROUPS);
        // And the unasked sizes are the same on both sides.
        assertThat(source).contains("FILE_TEXT_MAX = 64 * 1024;").contains("MARKDOWN_MAX = 8_000;");
        assertThat(LowRisk.FILE_TEXT_MAX).isEqualTo(64 * 1024);
        assertThat(LowRisk.MARKDOWN_MAX).isEqualTo(8_000);
    }

    @Test
    void aCallDoneWithoutAskingRunsWithTheJudgedPayloadAndSaysNothingToTheModelBeforeItRuns() {
        Verdict.Allowed allowed = new Verdict.Allowed("files", "ap-test");
        assertThat(allowed.runs()).isTrue();
        assertThat(allowed.bindsPayload()).isTrue();
        assertThat(allowed.modelText()).isNull();
        assertThat(new Verdict.Approved("ap-x", "0".repeat(64)).bindsPayload()).isTrue();
        assertThat(Verdict.Auto.INSTANCE.bindsPayload()).isFalse();
        assertThat(new Verdict.Refused("x").bindsPayload()).isFalse();
    }
}
