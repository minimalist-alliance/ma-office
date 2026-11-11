package com.minimalistalliance.desk.agent.tool;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The registry (draft ADR "the Agent's tools and approvals", sections 1 and 2): complete, fixed, and deskd's twin. */
class ToolRegistryTest {

    private final ToolRegistry registry = new ToolRegistry();

    @TempDir
    Path data;

    @Test
    void theLaunchToolsHaveTheClassesAndTaintsTheAdrGives() {
        Map<String, Risk> classes = new HashMap<>();
        for (String name : List.of("files_list", "files_search", "files_read", "browser_open", "browser_read",
                "browser_click", "browser_type", "browser_press", "browser_back", "browser_close", "browser_tabs",
                "notebook_search", "notebook_read", "desk_agents", "desk_choices")) {
            classes.put(name, Risk.READ);
        }
        for (String name : List.of("workspace_list", "workspace_read", "workspace_write", "workspace_delete",
                "message_agent", "plan_update", "memory_save", "memory_forget")) {
            classes.put(name, Risk.OWN);
        }
        for (String name : List.of("files_write", "files_mkdir", "files_move", "notebook_write", "follow_up")) {
            classes.put(name, Risk.WRITE);
        }
        classes.put("files_trash", Risk.DELETE);
        classes.put("notebook_trash", Risk.DELETE);
        classes.put("browser_use_my_session", Risk.EGRESS);
        classes.forEach((name, risk) -> assertThat(registry.decl(name).risk()).as(name).isEqualTo(risk));

        assertThat(registry.decl("files_read").taints()).containsExactlyInAnyOrder(Taint.S, Taint.U);
        assertThat(registry.decl("files_list").taints()).containsExactly(Taint.S);
        assertThat(registry.decl("notebook_read").taints()).containsExactly(Taint.S);
        assertThat(registry.decl("browser_read").taints()).containsExactly(Taint.U);
        assertThat(registry.decl("browser_use_my_session").taints()).containsExactly(Taint.S);
        assertThat(registry.decl("browser_use_my_session").scope()).startsWith("browser:member:");
        assertThat(registry.decl("memory_save").isMemory()).isTrue();
        // No permanent delete, no trash emptying, no shell: not declared, so no run can have them.
        for (String never : List.of("files_delete", "files_trash_empty", "files_permanent", "shell", "exec",
                "notebook_delete", "email_send")) {
            assertThat(registry.decl(never)).as(never).isNull();
        }
    }

    @Test
    void everyNewToolHasASpecWithItsSchema() {
        for (ToolDecl decl : registry.all()) {
            if (decl.host() == ToolDecl.Host.DESKD || List.of("plan_update", "follow_up", "workspace_delete")
                    .contains(decl.name())) {
                ToolSpec spec = registry.spec(decl.name());
                assertThat(spec).as(decl.name()).isNotNull();
                assertThat(spec.inputSchema()).isEqualTo(decl.schema());
                assertThat(decl.schema()).containsEntry("additionalProperties", false);
            }
        }
    }

    /** deskd keeps its own copy of the tools it runs; the two never drift. */
    @Test
    void deskdsDeclarationsMatchThese() throws Exception {
        Path hosted = Path.of("..", "deskd", "src", "main", "java", "com", "minimalistalliance", "desk", "deskd",
                "tools", "HostedDecls.java");
        assumeTrue(Files.exists(hosted), "deskd's sources aren't beside this module");
        Pattern decl = Pattern.compile(
                "new Decl\\(\"(\\w+)\", \\w+, \"[^\"]+\", ToolRisk\\.(\\w+), (NONE|S|U|SU), (true|false)\\)");
        Matcher m = decl.matcher(Files.readString(hosted));
        Set<String> seen = new HashSet<>();
        while (m.find()) {
            String name = m.group(1);
            seen.add(name);
            ToolDecl mine = registry.decl(name);
            assertThat(mine).as(name).isNotNull();
            assertThat(mine.host()).as(name).isEqualTo(ToolDecl.Host.DESKD);
            assertThat(mine.risk().name()).as(name).isEqualTo(m.group(2));
            Set<Taint> taints = switch (m.group(3)) {
                case "S" -> EnumSet.of(Taint.S);
                case "U" -> EnumSet.of(Taint.U);
                case "SU" -> EnumSet.of(Taint.S, Taint.U);
                default -> EnumSet.noneOf(Taint.class);
            };
            assertThat(mine.taints()).as(name).isEqualTo(taints);
            assertThat(Boolean.parseBoolean(m.group(4))).as(name).isEqualTo(ToolRegistry.BROWSE_ACTIONS.contains(name));
        }
        Set<String> mineHosted = new HashSet<>();
        for (ToolDecl d : registry.all()) {
            if (d.host() == ToolDecl.Host.DESKD) {
                mineHosted.add(d.name());
            }
        }
        assertThat(seen).isEqualTo(mineHosted);
    }

    /** Every tool a run can be offered is declared, so none runs on the unknown-name path. */
    @Test
    void everyToolARunCanHaveIsDeclared() throws Exception {
        try (TeamDesk desk = new TeamDesk(data, new MutableClock(Rig.START))) {
            String a = desk.agent("Alice");
            String b = desk.agent("Bob");
            desk.link(a, b, "Anything.");
            Set<String> offered = new HashSet<>();
            for (String id : List.of("manager", a, b)) {
                for (ToolSpec spec : desk.team.setupFor(id).tools().specs()) {
                    offered.add(spec.name());
                }
            }
            for (ToolSpec spec : desk.service.agentTools().wrap(desk.team.setupFor(a), a, false).tools().specs()) {
                offered.add(spec.name());
            }
            offered.add("memory_save");
            offered.add("memory_forget");
            assertThat(offered).contains("workspace_write", "message_agent", "propose_agent", "plan_update");
            for (String name : offered) {
                assertThat(registry.decl(name)).as(name).isNotNull();
            }
        }
    }

    /** A setting switches a tool off and does nothing else: no class falls, and its calls are refused. */
    @Test
    void switchingOffNeverLowersAClass() {
        Map<String, Risk> before = new HashMap<>();
        Set<String> all = new HashSet<>();
        for (ToolDecl decl : registry.all()) {
            before.put(decl.name(), decl.risk());
            all.add(decl.name());
        }
        registry.switchOff(all);
        RegistryPolicy policy = new RegistryPolicy(registry, new FakeDeskLink(), new MutableClock(Rig.START));
        RunContext run = RunContext.of("run-1", "ag-1", Caller.OWNER, null, "m-1");
        for (ToolDecl decl : registry.all()) {
            assertThat(decl.risk()).isEqualTo(before.get(decl.name()));
            Classified c = policy.classify(new ToolCall("c1", decl.name(), Map.of()), run);
            assertThat(c.refusal()).as(decl.name()).isEqualTo("off");
            assertThat(c.risk()).as(decl.name()).isEqualTo(decl.risk());
        }
        assertThat(ToolRegistry.parseOff(" files_write, browser_open  notebook_trash,")).containsExactly(
                "files_write", "browser_open", "notebook_trash");
    }
}
