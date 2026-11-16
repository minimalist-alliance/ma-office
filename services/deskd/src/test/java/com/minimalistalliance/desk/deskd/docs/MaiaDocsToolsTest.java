package com.minimalistalliance.desk.deskd.docs;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.DocsTools;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.ToolFailure;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia's document tools (API.md §25): hers alone, only while Maia Mode is on, titles and facts only, passages only
 * within 10 minutes of the member's tap, and nothing that changes a document, a place or a rule.
 */
class MaiaDocsToolsTest {

    @TempDir
    Path dir;
    DocsRig rig;
    final AtomicBoolean maiaOn = new AtomicBoolean(true);
    DocsTools tools;

    @BeforeEach
    void start() throws Exception {
        rig = new DocsRig(dir);
        tools = new DocsTools(() -> rig.module, maiaOn::get, () -> "d-home");
        rig.put("Courier/Contract Rosa.pdf", DocsModuleTest.contract(DocsModuleTest.V1_P3));
        rig.put("Courier/Invoice Northwind 4471.pdf", FakeDocsSandbox.pdf("Northwind\nInvoice 4471\nPayment due on 1 December"));
        rig.scan("Courier");
    }

    @AfterEach
    void stop() throws Exception {
        rig.close();
    }

    HostedTool.Result run(String agent, String tool, Map<String, Object> args) throws Exception {
        HostedCall call = new HostedCall(1, "run-1", agent, tool, args, null, false, Caller.THE_OWNER, "agent");
        tools.look(call, null);
        return tools.run(call, null);
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> content(HostedTool.Result r) {
        return (Map<String, Object>) r.content();
    }

    @Test
    void onlyMaiaAndOnlyWhileMaiaModeIsOn() {
        assertThatThrownBy(() -> run("work-lead", "docs_find", Map.of("words", "contract"))).isInstanceOf(ToolFailure.class)
                .extracting(e -> ((ToolFailure) e).reason()).isEqualTo("maia_only");
        maiaOn.set(false);
        assertThatThrownBy(() -> run("maia", "docs_find", Map.of("words", "contract"))).isInstanceOf(ToolFailure.class)
                .extracting(e -> ((ToolFailure) e).reason()).isEqualTo("maia_off");
        // deskd's own record of an agent's apps: no team agent's app covers Documents.
        assertThat(HostedDecls.ALL.values().stream().filter(d -> HostedDecls.DOCS.equals(d.area())).map(HostedDecls.Decl::name))
                .containsExactlyInAnyOrder("docs_find", "docs_handover", "docs_ask", "docs_offer_rule");
        assertThat(HostedDecls.ALL.values().stream().filter(d -> HostedDecls.DOCS.equals(d.area())))
                .allMatch(d -> d.taints().containsAll(List.of("U", "S")));
    }

    @Test
    @SuppressWarnings("unchecked")
    void findGivesPointersWithTitlesAndHandoverGivesFactsAndACard() throws Exception {
        HostedTool.Result found = run("maia", "docs_find", Map.of("words", "contract"));
        assertThat(found.taints()).containsExactlyInAnyOrder("U", "S");
        List<Map<String, Object>> items = (List<Map<String, Object>>) content(found).get("items");
        assertThat(items).hasSize(1);
        Map<String, Object> hit = items.get(0);
        assertThat(hit).containsKeys("deskId", "docId", "title", "kind", "place", "from", "arrived");
        assertThat(hit.get("deskId")).isEqualTo("d-home");
        Map<String, Object> facts = content(run("maia", "docs_handover", Map.of("docId", hit.get("docId"))));
        assertThat(facts).containsKeys("title", "from", "reason", "changedPages", "card", "say");
        assertThat(facts).doesNotContainKeys("text", "pages", "body");
        assertThat(String.valueOf(facts)).doesNotContain("Clause 1");
        assertThat(content(run("maia", "docs_find", Map.of("words", "zebra"))).get("say")).isEqualTo("Nothing like that on your desks.");
    }

    @Test
    @SuppressWarnings("unchecked")
    void passagesOnlyAfterTheMembersTap() throws Exception {
        String id = rig.idOf("Courier/Invoice Northwind 4471.pdf");
        assertThatThrownBy(() -> run("maia", "docs_ask", Map.of("docId", id, "question", "When is payment due?")))
                .isInstanceOf(ToolFailure.class).extracting(e -> ((ToolFailure) e).reason()).isEqualTo("maia_not_allowed");
        rig.call("docs.ask.allow", Map.of("id", id));
        Map<String, Object> out = content(run("maia", "docs_ask", Map.of("docId", id, "question", "When is payment due?")));
        List<String> passages = (List<String>) out.get("passages");
        assertThat(String.join(" ", passages)).contains("(p. 1)").contains("Payment due on 1 December");
        assertThat(String.join("", passages).length()).isLessThanOrEqualTo(1200);
        rig.advance(java.time.Duration.ofMinutes(11));
        assertThatThrownBy(() -> run("maia", "docs_ask", Map.of("docId", id, "question", "When?")))
                .isInstanceOf(ToolFailure.class);
    }

    @Test
    void argumentsAreStrictAndNothingChanges() throws Exception {
        assertThatThrownBy(() -> run("maia", "docs_find", Map.of("place", "records"))).isInstanceOf(ToolFailure.class);
        assertThatThrownBy(() -> run("maia", "docs_handover", Map.of("docId", "../x"))).isInstanceOf(ToolFailure.class);
        assertThatThrownBy(() -> run("maia", "docs_find", Map.of("from", "yesterday"))).isInstanceOf(ToolFailure.class);
        String id = rig.idOf("Courier/Contract Rosa.pdf");
        Map<String, Object> before = rig.doc(id);
        Map<String, Object> offer = content(run("maia", "docs_offer_rule", Map.of("docId", id)));
        assertThat(offer.get("choices")).isEqualTo(List.of("Needs you", "Read later", "Records", "Ask me each time"));
        assertThat(rig.doc(id).get("place")).isEqualTo(before.get("place"));
        assertThat((List<?>) rig.call("docs.rules", Map.of()).get("rules")).isEmpty();
    }
}
