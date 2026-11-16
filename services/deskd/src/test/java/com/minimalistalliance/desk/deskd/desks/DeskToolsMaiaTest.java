package com.minimalistalliance.desk.deskd.desks;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.agent.MaiaRecord;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia's briefs through deskd's own tool host (Maia Mode, API.md §23): {@code desk_message} from {@code maia} goes
 * by deskd's own record of her grants as well as W6's half, is {@code own} under her grant even from a run holding
 * {@code S} (the concept's {@code delegate}), and asks again ({@code send}) when her run holds {@code S} and has read an
 * answer from another desk that keeps to itself or that she has no live grant for. Every other agent keeps W6's rule.
 */
class DeskToolsMaiaTest {

    private static final String GRANT = "dg-abcdefghijklmnopqrst";
    private static final String GRANT_X = "dg-bbcdefghijklmnopqrst";

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-14T10:00:00Z"));
    private DeskMessaging a;
    private DeskMessaging b;
    private MaiaRecord record;
    private ToolHost host;
    private long nextId = 1;

    @BeforeEach
    void setUp() throws Exception {
        Files.createDirectories(dir.resolve("a"));
        Files.createDirectories(dir.resolve("b"));
        a = new DeskMessaging(clock, () -> "d-aaaa", () -> "user-1", () -> false);
        a.keepIn(dir.resolve("a"));
        b = new DeskMessaging(clock, () -> "d-bbbb", () -> "user-1", () -> false);
        b.keepIn(dir.resolve("b"));
        // W6's halves for Maia (agent maia on A) and for an ordinary agent (ag-x on A), both to B.
        pair(GRANT, "maia", "Maia");
        pair(GRANT_X, "ag-x", "Researcher");
        record = new MaiaRecord(clock);
        record.keepIn(dir.resolve("a"));
        host = new ToolHost(clock, ToolHost.ownerOnly(), () -> false, () -> true);
        host.area(HostedDecls.DESKS, new DeskTools(a, id -> "Maia").maia(record));
    }

    private void pair(String grant, String agentId, String name) throws Exception {
        DeskMessaging.Made offer = a.offer(grant, agentId, name, "d-bbbb");
        b.open(Json.parseObject(Json.bytes(offer.envelope())));
        DeskMessaging.Made accept = b.accept(grant, "ag-y", "Helper");
        a.open(Json.parseObject(Json.bytes(accept.envelope())));
        assertThat(a.grants().half(grant).active()).isTrue();
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private void maiaOn() {
        record.recordAnswer("agent.maia.set", m("on", true), m("maia", m("on", true)));
    }

    private void grant(String deskId, List<String> scopes, boolean keeps) {
        long expires = clock.millis() + Duration.ofDays(7).toMillis();
        record.recordAnswer("agent.maia.grant.set", m("deskId", deskId, "deskName", "Desk", "scopes", scopes,
                "keepsToItself", keeps), m("grant", m("deskId", deskId, "scopes", scopes, "keepsToItself", keeps,
                "expiresAt", expires)));
    }

    /** The look's {@code r}: {@code risk} and {@code refusal}. */
    private Map<?, ?> look(String agentId, String runId, List<String> taint, String desk) throws Exception {
        Map<String, Object> call = tcall(agentId, runId, taint, desk);
        call.put("phase", "look");
        Map<String, Object> reply = call(call);
        assertThat(reply.get("t")).as("look %s", reply).isEqualTo("tres");
        return (Map<?, ?>) reply.get("r");
    }

    private Map<String, Object> run(String agentId, String runId, List<String> taint, String desk) throws Exception {
        return call(tcall(agentId, runId, taint, desk));
    }

    private Map<String, Object> tcall(String agentId, String runId, List<String> taint, String desk) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", runId);
        m.put("agentId", agentId);
        m.put("tool", "desk_message");
        m.put("args", m("desk", desk, "text", "Find three laptops under $1,000."));
        m.put("taint", new ArrayList<>(taint));
        return m;
    }

    private Map<String, Object> call(Map<String, Object> message) throws Exception {
        java.util.concurrent.CompletableFuture<Map<String, Object>> reply = new java.util.concurrent.CompletableFuture<>();
        host.onCall(message, reply::complete);
        return reply.get(10, java.util.concurrent.TimeUnit.SECONDS);
    }

    private static String reason(Map<String, Object> terr) {
        assertThat(terr.get("t")).as("%s", terr).isEqualTo("terr");
        return (String) ((Map<?, ?>) terr.get("details")).get("reason");
    }

    @Test
    void withNoGrantForThatDeskHerBriefIsRefusedMaiaGrantAtTheLookAndTheRun() throws Exception {
        maiaOn();
        assertThat(look("maia", "run-1", List.of(), "d-bbbb").get("refusal")).isEqualTo("maia_grant");
        assertThat(reason(run("maia", "run-1", List.of(), "d-bbbb"))).isEqualTo("maia_grant");
        // A grant with show only is no brief.
        grant("d-bbbb", List.of("show"), false);
        assertThat(look("maia", "run-1", List.of(), "d-bbbb").get("refusal")).isEqualTo("maia_grant");
    }

    @Test
    void maiaModeOffOrNeverOnRefusesEveryBrief() throws Exception {
        grant("d-bbbb", List.of("brief"), false);
        assertThat(look("maia", "run-1", List.of(), "d-bbbb").get("refusal")).isEqualTo("maia_grant");
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        assertThat(look("maia", "run-2", List.of(), "d-bbbb").get("refusal")).isNull();
        // Off: before desk-agent even hears, and every grant goes with it.
        record.recordNarrowing("agent.maia.set", m("on", false));
        assertThat(look("maia", "run-3", List.of(), "d-bbbb").get("refusal")).isEqualTo("maia_grant");
        assertThat(record.grant("d-bbbb")).isNull();
    }

    @Test
    void anExpiredGrantIsNoGrant() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        assertThat(look("maia", "run-1", List.of(), "d-bbbb").get("refusal")).isNull();
        clock.advance(Duration.ofDays(7).plusSeconds(1));
        assertThat(look("maia", "run-2", List.of(), "d-bbbb").get("refusal")).isEqualTo("maia_grant");
        assertThat(reason(run("maia", "run-2", List.of(), "d-bbbb"))).isEqualTo("maia_grant");
    }

    @Test
    void underHerGrantABriefIsOwnEvenFromARunHoldingPrivateDataAndRunsWithNoYes() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief", "show"), false);
        grant("d-cccc", List.of("brief"), false);
        Map<?, ?> found = look("maia", "run-1", List.of("U", "S", "D:d-cccc"), "d-bbbb");
        assertThat(found.get("risk")).isEqualTo("own");
        assertThat(found.get("refusal")).isNull();
        Map<String, Object> ran = run("maia", "run-1", List.of("U", "S", "D:d-cccc"), "d-bbbb");
        assertThat(ran.get("t")).isEqualTo("tres");
        Map<?, ?> made = (Map<?, ?>) ((Map<?, ?>) ran.get("r")).get("content");
        assertThat(made.get("kind")).isEqualTo("msg");
    }

    @Test
    void whatADeskThatKeepsToItselfToldHerAsksBeforeItGoesToAnotherDesk() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        grant("d-dddd", List.of("brief"), true);
        // Her run read Work's (d-dddd, keeps to itself) answer and holds S: briefing B asks.
        assertThat(look("maia", "run-1", List.of("S", "D:d-dddd"), "d-bbbb").get("risk")).isEqualTo("send");
        assertThat(reason(run("maia", "run-1", List.of("S", "D:d-dddd"), "d-bbbb"))).isEqualTo("approval_required");
        // Without S there's nothing private to carry: own.
        assertThat(look("maia", "run-2", List.of("D:d-dddd"), "d-bbbb").get("risk")).isEqualTo("own");
    }

    @Test
    void briefingTheDeskThatToldHerIsOwnEvenWhenItKeepsToItself() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), true);
        assertThat(look("maia", "run-1", List.of("S", "D:d-bbbb"), "d-bbbb").get("risk")).isEqualTo("own");
    }

    @Test
    void anAnswerFromADeskSheHasNoGrantForAsks() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        assertThat(look("maia", "run-1", List.of("S", "D:d-eeee"), "d-bbbb").get("risk")).isEqualTo("send");
        // A grant revoked since counts the same.
        grant("d-eeee", List.of("brief"), false);
        assertThat(look("maia", "run-2", List.of("S", "D:d-eeee"), "d-bbbb").get("risk")).isEqualTo("own");
        record.recordNarrowing("agent.maia.grant.revoke", m("deskId", "d-eeee"));
        assertThat(look("maia", "run-3", List.of("S", "D:d-eeee"), "d-bbbb").get("risk")).isEqualTo("send");
    }

    @Test
    void anAnswerDeskdItselfGaveTheRunCountsWhateverDeskAgentSays() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        grant("d-dddd", List.of("brief"), true);
        // desk-agent sends no D: flag, but deskd gave the run an answer from d-dddd (DeskSources' record).
        assertThat(look("maia", "run-1", List.of("S"), "d-bbbb").get("risk")).isEqualTo("own");
        RunLedger.Run run = host.ledger().find("run-1");
        run.gave("desk:d-dddd:env-1", "desk", Map.of("deskId", "d-dddd", "messageId", "env-1"), "Answer", "desk:d-dddd");
        assertThat(look("maia", "run-1", List.of("S"), "d-bbbb").get("risk")).isEqualTo("send");
    }

    @Test
    void desksOriginsOnlyGrowAndOnlyNameDesks() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        grant("d-dddd", List.of("brief"), true);
        assertThat(look("maia", "run-1", List.of("S", "D:d-dddd"), "d-bbbb").get("risk")).isEqualTo("send");
        // A later call of the run that names no origin doesn't clear it.
        assertThat(look("maia", "run-1", List.of("S"), "d-bbbb").get("risk")).isEqualTo("send");
        RunLedger.Run run = host.ledger().find("run-1");
        assertThat(run.deskOrigins()).containsExactly("d-dddd");
        run.add(List.of("D:", "D:D-UPPER", "D:../x", "D d-ffff", "X:d-ffff", "U"));
        assertThat(run.deskOrigins()).containsExactly("d-dddd");
        assertThat(run.flags()).containsExactly("U", "S");
    }

    @Test
    void pastSixtyFourOriginsTheRunNamesOneNoGrantCovers() {
        RunLedger ledger = new RunLedger(clock, id -> {});
        RunLedger.Run run;
        try {
            run = ledger.join("run-1", "maia", com.minimalistalliance.desk.deskd.rpc.Caller.THE_OWNER, List.of());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 70; i++) {
            many.add("D:d-x" + i);
        }
        run.add(many);
        assertThat(run.deskOrigins()).contains(RunLedger.TOO_MANY).hasSize(65);
        // "*" is no desk: whatever her grants say, it keeps to itself.
        assertThat(record.keepsToItself(RunLedger.TOO_MANY)).isTrue();
    }

    @Test
    void everyOtherAgentKeepsW6sRuleExactly() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        // No Maia grant applies to ag-x: own without S, send with it, whatever Maia's record holds.
        assertThat(look("ag-x", "run-x1", List.of(), "d-bbbb").get("risk")).isEqualTo("own");
        assertThat(look("ag-x", "run-x1", List.of(), "d-bbbb").get("refusal")).isNull();
        assertThat(look("ag-x", "run-x2", List.of("S"), "d-bbbb").get("risk")).isEqualTo("send");
        // And Maia Mode off changes nothing for it.
        record.recordNarrowing("agent.maia.set", m("on", false));
        assertThat(look("ag-x", "run-x3", List.of(), "d-bbbb").get("refusal")).isNull();
    }

    /** desk B's host: its own ledger, with deskd's desk sources as the production wiring has them. */
    private ToolHost hostOf(DeskMessaging desk) {
        ToolHost other = new ToolHost(clock, ToolHost.ownerOnly(), () -> false, () -> true);
        other.area(HostedDecls.DESKS, new DeskTools(desk, id -> "Helper"));
        other.origins(desk.sources()::origin);
        return other;
    }

    private Map<?, ?> answerLook(ToolHost on, String runId, String grant, String replyTo) throws Exception {
        return answerLook(on, runId, grant, replyTo, List.of("U", "S"));
    }

    private Map<?, ?> answerLook(ToolHost on, String runId, String grant, String replyTo, List<String> taint)
            throws Exception {
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("t", "tcall");
        answer.put("id", nextId++);
        answer.put("runId", runId);
        answer.put("agentId", "ag-y");
        answer.put("tool", "desk_answer");
        answer.put("args", m("grantId", grant, "replyTo", replyTo, "text", "Three, all under $900."));
        answer.put("taint", new ArrayList<>(taint));
        answer.put("origin", m("kind", "desk", "envelopeId", replyTo));
        answer.put("phase", "look");
        java.util.concurrent.CompletableFuture<Map<String, Object>> reply = new java.util.concurrent.CompletableFuture<>();
        on.onCall(answer, reply::complete);
        Map<String, Object> r = reply.get(10, java.util.concurrent.TimeUnit.SECONDS);
        assertThat(r.get("t")).as("look %s", r).isEqualTo("tres");
        return (Map<?, ?>) r.get("r");
    }

    /**
     * Security's DMA-M1: her brief from a run holding {@code S} goes {@code private}, so desk B's answering run starts
     * with {@code S} and its browsing asks; its answer back to her desk stays {@code own}. No other agent's message is
     * private, and an answer to one keeps W6's rule: {@code send} from a run holding {@code S}.
     */
    @Test
    void herPrivateBriefsAnswerBackToHerDeskStaysOwnAndNothingElseChanges() throws Exception {
        maiaOn();
        grant("d-bbbb", List.of("brief"), false);
        Map<String, Object> ran = run("maia", "run-1", List.of("U", "S"), "d-bbbb");
        Map<?, ?> made = (Map<?, ?>) ((Map<?, ?>) ran.get("r")).get("content");
        Map<String, Object> opened = b.open(Json.parseObject(Json.bytes(made.get("envelope"))));
        assertThat(opened).containsEntry("private", true).containsEntry("agentId", "ag-y");
        // From her run holding no S, it isn't private.
        Map<?, ?> plain = (Map<?, ?>) ((Map<?, ?>) run("maia", "run-2", List.of("U"), "d-bbbb").get("r"))
                .get("content");
        assertThat(b.open(Json.parseObject(Json.bytes(plain.get("envelope"))))).containsEntry("private", false);
        // An ordinary agent's message from a run holding S (the member said yes to its card) isn't private either.
        DeskMessaging.Made theirs = a.message("ag-x", "Researcher", "d-bbbb", "Our numbers are in.", true);
        Map<String, Object> other = b.open(Json.parseObject(Json.bytes(theirs.envelope())));
        assertThat(other).containsEntry("private", false);

        ToolHost onB = hostOf(b);
        String brief = (String) opened.get("id");
        assertThat(answerLook(onB, "run-b1", GRANT, brief).get("risk")).isEqualTo("own");
        // Another run that doesn't have her brief as its origin: W6's rule.
        assertThat(answerLook(onB, "run-b2", GRANT, brief).get("risk")).isEqualTo("send");
        // The ordinary agent's message, answered from a run holding S: W6's rule.
        assertThat(answerLook(onB, "run-b3", GRANT_X, (String) other.get("id")).get("risk")).isEqualTo("send");
        // deskd gives the run its own S for her brief, whatever desk-agent sends (DMA-I8).
        assertThat(onB.ledger().find("run-b1").privateData()).isTrue();
        // A run a tool here gave this desk's private data (Files, Notebook): W6's card (DMA-L5).
        onB.ledger().find("run-b1").addFromTool(List.of("S"));
        assertThat(answerLook(onB, "run-b1", GRANT, brief).get("risk")).isEqualTo("send");
        // A fresh brief, answered from a run with only U from desk-agent: S from deskd, and own back to her desk.
        Map<?, ?> again = (Map<?, ?>) ((Map<?, ?>) run("maia", "run-3", List.of("S"), "d-bbbb").get("r"))
                .get("content");
        String second = (String) b.open(Json.parseObject(Json.bytes(again.get("envelope")))).get("id");
        assertThat(answerLook(onB, "run-b4", GRANT, second, List.of("U")).get("risk")).isEqualTo("own");
        assertThat(onB.ledger().find("run-b4").privateData()).isTrue();
        // Past seven days the record is gone: W6's rule.
        clock.advance(Duration.ofDays(8));
        assertThat(answerLook(onB, "run-b4", GRANT, second).get("risk")).isEqualTo("send");
    }

    @Test
    void maiaNeverAnswersAnotherDesksMessage() throws Exception {
        maiaOn();
        Map<String, Object> answer = tcall("maia", "run-1", List.of(), "d-bbbb");
        answer.put("tool", "desk_answer");
        answer.put("args", m("grantId", GRANT, "replyTo", "env-1", "text", "hi"));
        answer.put("phase", "look");
        assertThat(reason(call(answer))).isEqualTo("maia_grant");
    }
}
