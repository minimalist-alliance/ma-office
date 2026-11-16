package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.Restart;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.Taint;
import com.minimalistalliance.desk.agent.tool.ToolDecl;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia's part of Documents (deskd API.md §25, "Desk Maia's document tools"; the draft ADR "Documents" decision 7):
 * the four index tools are hers and never a team agent's, {@code office_show} opens the viewer only at a document's id
 * (and a page), her handover puts the card under her reply from the desk's own record, and deskd's reader request runs
 * on her service's {@code read} task only while she's active here.
 */
class MaiaDocsToolsTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String DOC = "d_01JC8Z3K4M5N6P7Q8R9S0T1V2W";
    private static final String OTHER_DOC = "d_01JC8Z3K4M5N6P7Q8R9S0T1V2X";
    private static final String NO_NOTES = "{\"notes\": []}";

    @TempDir
    Path data;

    private MaiaDesk maia;

    @BeforeEach
    void open() throws Exception {
        maia = new MaiaDesk(data);
        // deskd's hello offers Documents' index, as a deskd with §25 does.
        maia.deskd.alsoOffered.addAll(ToolRegistry.DOCS);
        // Her note-taker's request takes the last scripted step only once her run's steps are taken.
        maia.desk.provider.onChat = request -> {
            if (request.system().startsWith("You take notes")) {
                await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.pending() <= 1);
            }
        };
    }

    @AfterEach
    void close() {
        maia.close();
    }

    private List<ChatRequest> herRequests() {
        return maia.desk.provider.requests().stream()
                .filter(r -> r.system().startsWith("The member's home desk adds")).toList();
    }

    private List<ToolResult> herResults() {
        List<ChatRequest> hers = herRequests();
        return TeamDesk.toolResults(hers.get(hers.size() - 1));
    }

    private static List<String> names(List<ToolSpec> specs) {
        return specs.stream().map(ToolSpec::name).toList();
    }

    // ---------------------------------------------------------------- whose tools

    @Test
    void theFourIndexToolsAreReadOnlyUntrustedPrivateAndSafeToAskAgain() {
        ToolRegistry registry = new ToolRegistry();
        assertThat(ToolRegistry.DOCS).containsExactlyInAnyOrder("docs_find", "docs_handover", "docs_ask",
                "docs_offer_rule");
        for (String name : ToolRegistry.DOCS) {
            ToolDecl decl = registry.decl(name);
            assertThat(decl).as(name).isNotNull();
            assertThat(decl.host()).as(name).isEqualTo(ToolDecl.Host.DESKD);
            assertThat(decl.risk()).as(name).isEqualTo(Risk.READ);
            assertThat(decl.taints()).as(name).containsExactlyInAnyOrder(Taint.S, Taint.U);
            assertThat(decl.scope()).as(name).isEqualTo("docs:read");
            assertThat(decl.restart()).as(name).isEqualTo(Restart.SAFE);
            assertThat(decl.schema()).as(name).containsEntry("additionalProperties", false);
        }
        // Nothing of hers changes a place, a rule, a name or a document: only these, and no others named docs_.
        assertThat(registry.all()).extracting(ToolDecl::name).filteredOn(n -> n.startsWith("docs_"))
                .containsExactlyInAnyOrderElementsOf(ToolRegistry.DOCS);
        assertThat(MaiaProfile.AREAS).containsAll(ToolRegistry.DOCS);
        assertThat(MaiaTools.APPS).contains("documents");
    }

    @Test
    void herRunIsOfferedTheFourAndATeamAgentsOrTheLeadsNever() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.answer(USAGE, "Hello.")).then(Step.answer(USAGE, NO_NOTES));
        maia.desk.ask(MaiaAgent.ID, "Hi Maia");
        assertThat(TeamDesk.toolNames(herRequests().get(0))).containsAll(ToolRegistry.DOCS);
        // Her note-taker has taken its step before a team agent's run is scripted on the same stand-in.
        await().atMost(Duration.ofSeconds(15)).until(() -> maia.desk.provider.pending() == 0);

        maia.desk.bindLead();
        String alice = maia.desk.agent("Alice");
        for (String agent : List.of(alice, AgentStore.MANAGER)) {
            List<String> offered = names(maia.desk.service.agentTools().wrap(maia.desk.team.setupFor(agent), agent,
                    false).tools().specs());
            assertThat(offered).as(agent).isNotEmpty().noneMatch(ToolRegistry.DOCS::contains);
        }
        // A team agent's model that names one anyway is refused, and deskd never runs it.
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "docs_find", "words", "contract"),
                Step.call("c2", "docs_handover", "docId", DOC)))).then(Step.answer(USAGE, "Done."));
        maia.desk.ask(alice, "Find Rosa's contract");
        List<ToolResult> results = TeamDesk.toolResults(maia.desk.lastRequest());
        assertThat(results).hasSize(2).allMatch(ToolResult::error);
        assertThat(maia.deskd.runsOf("docs_find")).isEmpty();
        assertThat(maia.deskd.runsOf("docs_handover")).isEmpty();
        assertThat(maia.desk.lastReply(alice).get("doc")).isNull();
    }

    // ---------------------------------------------------------------- the viewer in her room

    @Test
    void aShowInDocumentsNamesADocumentAndAPageNeverAnAddress() {
        for (String ok : List.of(DOC, DOC + "#p1", DOC + "#p3", DOC + "#p999", "")) {
            assertThat(MaiaProfile.refOk(ok) && MaiaProfile.refFits("documents", ok)).as(ok).isTrue();
        }
        for (String bad : List.of("https://evil.example/" + DOC, "http://x", "//evil.example", "www.evil.example",
                "javascript:alert(1)", "data:text/html,x", "/data/desk/docs.db", "../" + DOC, "Files/contract.pdf",
                "Research/notes.md", DOC.toLowerCase(), "D_01JC8Z3K4M5N6P7Q8R9S0T1V2W", DOC.substring(0, 27),
                DOC + "X", "d_01JC8Z3K4M5N6P7Q8R9S0T1V2I", "d_01JC8Z3K4M5N6P7Q8R9S0T1V2U",
                "c_01JC8Z3K4M5N6P7Q8R9S0T1V2W", "v_01JC8Z3K4M5N6P7Q8R9S0T1V2W", DOC + "#p0", DOC + "#p01",
                DOC + "#p1000", DOC + "#page3", DOC + "#p3?x=1", DOC + "?p=3", DOC + "#p3#p4", DOC + "\n",
                DOC + "#p3‮", "pg-123", "needs_you")) {
            assertThat(MaiaProfile.refOk(bad) && MaiaProfile.refFits("documents", bad)).as(bad).isFalse();
        }
        // A document's id belongs to Documents only: no other app takes it as its own.
        assertThat(MaiaProfile.refFits("todo", DOC)).isFalse();
        assertThat(MaiaProfile.refFits("approvals", DOC)).isFalse();
    }

    @Test
    void herShowOpensTheViewerAtADocumentAndRefusesAnAddress() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.calls(USAGE, List.of(
                        Step.call("c1", "office_show", "deskId", MaiaDesk.HOME, "app", "documents", "ref",
                                "https://evil.example/" + DOC),
                        Step.call("c2", "office_show", "deskId", MaiaDesk.HOME, "app", "documents", "ref",
                                "javascript:alert(1)"),
                        Step.call("c3", "office_show", "deskId", MaiaDesk.HOME, "app", "documents", "ref",
                                "/data/desk/docs.db"),
                        Step.call("c4", "office_show", "deskId", MaiaDesk.HOME, "app", "documents", "ref",
                                DOC + "#p3"))))
                .then(Step.answer(USAGE, "Here it is, at page 3."))
                .then(Step.answer(USAGE, NO_NOTES));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Open the contract at page 3");
        List<ToolResult> results = herResults();
        assertThat(results).hasSize(4);
        assertThat(results.subList(0, 3)).allMatch(ToolResult::error)
                .allMatch(r -> r.content().startsWith("Refused: ref."));
        assertThat(results.get(3).error()).isFalse();
        assertThat(map(reply.get("show"))).containsEntry("deskId", MaiaDesk.HOME).containsEntry("app", "documents")
                .containsEntry("ref", DOC + "#p3");
    }

    // ---------------------------------------------------------------- her handover's card

    private void handoverAnswers(String docId) {
        maia.deskd.runs.put("docs_handover", call -> MaiaDeskd.ok(Map.of("docId", docId, "title",
                "12 Nov · Rosa Ortiz · Contract", "place", "needs", "reason", "Page 3 changed"), List.of("U", "S")));
    }

    @Test
    void aHandoverPutsTheCardUnderHerReplyFromHerHomeDesk() throws Exception {
        maia.on();
        handoverAnswers(DOC);
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "docs_handover", "docId", DOC))))
                .then(Step.answer(USAGE, "Here's the contract Rosa sent. Page 3 is the change."))
                .then(Step.answer(USAGE, NO_NOTES));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Where's Rosa's contract?");
        assertThat(herResults()).singleElement().matches(r -> !r.error());
        Map<String, Object> card = new LinkedHashMap<>();
        card.put("deskId", MaiaDesk.HOME);
        card.put("docId", DOC);
        assertThat(map(reply.get("doc"))).isEqualTo(card);
        // Kept with her reply: the room's thread and the reply's own extras, the same card.
        assertThat(map(maia.desk.lastReply(MaiaAgent.ID).get("doc"))).isEqualTo(card);
        assertThat(maia.deskd.runsOf("docs_handover")).hasSize(1);
        // The card names the desk and the document only: nothing of the document rides her reply.
        assertThat(reply.get("doc").toString()).doesNotContain("Rosa").doesNotContain("Contract");
    }

    @Test
    void twoHandoversInOneReplyLeaveTheLastCard() throws Exception {
        maia.on();
        maia.deskd.runs.put("docs_handover", call -> MaiaDeskd.ok(Map.of("docId", String.valueOf(
                ((Map<?, ?>) call.get("args")).get("docId"))), List.of("U", "S")));
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "docs_handover", "docId", DOC))))
                .then(Step.calls(USAGE, List.of(Step.call("c2", "docs_handover", "docId", OTHER_DOC))))
                .then(Step.answer(USAGE, "Actually, it's this one."))
                .then(Step.answer(USAGE, NO_NOTES));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "The contract");
        assertThat(map(reply.get("doc"))).containsEntry("docId", OTHER_DOC).containsEntry("deskId", MaiaDesk.HOME);
    }

    @Test
    void aRefusedHandoverPutsNoCard() throws Exception {
        maia.on();
        maia.deskd.runs.put("docs_handover", call -> MaiaDeskd.refused("not_found", "doc"));
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "docs_handover", "docId", DOC))))
                .then(Step.answer(USAGE, "I couldn't find it."))
                .then(Step.answer(USAGE, NO_NOTES));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Where's Rosa's contract?");
        assertThat(herResults()).singleElement().matches(ToolResult::error);
        assertThat(reply.get("doc")).isNull();
        assertThat(maia.desk.lastReply(MaiaAgent.ID).get("doc")).isNull();
    }

    @Test
    void aHandoverOfSomethingThatIsntADocumentsIdPutsNoCardWhateverDeskdSaid() throws Exception {
        maia.on();
        handoverAnswers(DOC);
        maia.desk.provider.then(Step.calls(USAGE, List.of(Step.call("c1", "docs_handover", "docId",
                        "https://evil.example/" + DOC))))
                .then(Step.answer(USAGE, "Here."))
                .then(Step.answer(USAGE, NO_NOTES));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Hand it over");
        assertThat(reply.get("doc")).isNull();
    }

    // ---------------------------------------------------------------- deskd's reader request

    private static Map<String, Object> readRequest() {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("docId", DOC);
        p.put("versionSha256", "0123456789abcdef".repeat(4));
        p.put("title", "12 Nov · Rosa Ortiz · Contract");
        p.put("pages", List.of(Map.of("n", 1, "text", "Services agreement."), Map.of("n", 2,
                "text", "Signature: ______")));
        return p;
    }

    private List<AuditLog.Row> audit(String action) throws Exception {
        return maia.desk.audit.readBefore(null, 5000).stream().filter(r -> r.entry().action().equals(action))
                .toList();
    }

    @Test
    void theReaderRunsOnHerServicesReadTaskOnlyWhileSheIsActive() throws Exception {
        assertThat(maia.desk.service.call(DocReader.METHOD, readRequest(), Caller.OWNER))
                .isEqualTo(Map.of("skipped", "maia_off"));
        assertThat(maia.desk.provider.requests()).isEmpty();

        maia.on();
        maia.desk.provider.then(Step.answer(USAGE, "{\"what\": \"contract\", \"asks\": [\"sign\"], \"due\": null,"
                + " \"pages\": {\"sign\": 2}, \"line\": \"A contract from Rosa to sign on page 2\", \"sensitive\": false}"));
        Map<String, Object> facts = maia.desk.service.call(DocReader.METHOD, readRequest(), Caller.OWNER);
        assertThat(facts).containsEntry("what", "contract").containsEntry("asks", List.of("sign"))
                .containsEntry("pages", Map.of("sign", 2)).containsEntry("line", "A contract from Rosa to sign on page 2");
        ChatRequest request = maia.desk.provider.requests().get(maia.desk.provider.requests().size() - 1);
        assertThat(request.model()).isEqualTo("read");
        assertThat(request.system()).contains(DocReader.RULE);
        assertThat(request.tools()).isEmpty();
        assertThat(maia.deskd.service.calls.get(maia.deskd.service.calls.size() - 1)).containsEntry("task", "read");
        // The log keeps the document's id and the outcome, never a word of it.
        List<AuditLog.Row> rows = audit("maia.docread");
        assertThat(rows).isNotEmpty();
        AuditLog.Row last = rows.get(rows.size() - 1);
        assertThat(last.entry().target()).isEqualTo("doc:" + DOC);
        assertThat(last.entry().decision()).isEqualTo("ok");
        assertThat(rows.toString()).doesNotContain("Services agreement").doesNotContain("Rosa");

        // Her service refusing: skipped, and deskd sorts from structure.
        maia.deskd.service.refuseNext = Map.of("code", "unavailable", "details", Map.of("reason", "provider"));
        assertThat(maia.desk.service.call(DocReader.METHOD, readRequest(), Caller.OWNER))
                .isEqualTo(Map.of("skipped", "unavailable"));
        // A malformed request never reaches her service.
        int before = maia.deskd.service.calls.size();
        Map<String, Object> bad = readRequest();
        bad.put("docId", "../etc/passwd");
        assertThat(maia.desk.service.call(DocReader.METHOD, bad, Caller.OWNER))
                .isEqualTo(Map.of("skipped", "bad_request"));
        assertThat(maia.deskd.service.calls).hasSize(before);

        // Off again: skipped before her service is asked.
        maia.call("agent.maia.set", "on", false);
        int calls = maia.deskd.service.calls.size();
        assertThat(maia.desk.service.call(DocReader.METHOD, readRequest(), Caller.OWNER))
                .isEqualTo(Map.of("skipped", "maia_off"));
        assertThat(maia.deskd.service.calls).hasSize(calls);
    }
}
