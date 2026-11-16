package com.minimalistalliance.desk.agent.harness;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Every tool an agent can call is registered with the harness ({@link ToolCases}), so the fault matrix, the audit
 * canary and the threats reach it. A tool added to {@code ToolRegistry} without its line fails here, naming it.
 */
class HarnessCoverageTest {

    @Test
    void everyDeclaredToolHasItsLineInToolCasesAndNoLineIsStale() {
        ToolRegistry registry = new ToolRegistry();
        List<String> missing = new ArrayList<>();
        for (ToolDecl decl : registry.all()) {
            if (ToolCases.of(decl.name()) == null) {
                missing.add(decl.name());
            }
        }
        assertThat(missing).as("add one line each to harness/ToolCases (W7's harness)").isEmpty();
        assertThat(ToolCases.all().keySet()).as("lines for tools no longer declared").allMatch(t ->
                registry.decl(t) != null);
    }

    @Test
    void eachLineAgreesWithItsDeclaration() {
        ToolRegistry registry = new ToolRegistry();
        for (ToolCases.Case c : ToolCases.all().values()) {
            ToolDecl decl = registry.decl(c.tool());
            assertThat(c.hosted()).as("%s: hosted", c.tool()).isEqualTo(decl.host() == ToolDecl.Host.DESKD);
            if (c.hosted()) {
                assertThat(c.result()).as("%s: deskd's answer", c.tool()).isNotNull();
            }
            // A line's kind is never below the tool's own class: the harness tests it at least as strictly.
            ToolCases.Kind floor = switch (decl.risk()) {
                case READ -> ToolCases.Kind.READ;
                case OWN -> ToolCases.Kind.OWN;
                case WRITE -> ToolCases.Kind.WRITE;
                case DELETE -> ToolCases.Kind.DELETE;
                case SEND, SPEND -> ToolCases.Kind.SEND;
                case EGRESS -> ToolCases.Kind.EGRESS;
            };
            assertThat(c.kind().ordinal() >= floor.ordinal() || decl.risk() == Risk.OWN && c.kind()
                    == ToolCases.Kind.READ).as("%s: kind %s under its class %s", c.tool(), c.kind(), decl.risk())
                    .isTrue();
        }
    }
}
