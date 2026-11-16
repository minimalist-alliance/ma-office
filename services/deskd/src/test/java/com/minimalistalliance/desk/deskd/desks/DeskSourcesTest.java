package com.minimalistalliance.desk.deskd.desks;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.Provenance;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * To-do's source kind {@code desk} (API.md §22 and §18): a message from another of the member's desks is a run's source
 * only by deskd's own record. On the answering desk, the message that started the answering agent's run, one run per
 * message; on the asking desk, an answer the waiting call took, for the run that sent the message.
 */
class DeskSourcesTest {

    private static final String GRANT = "dg-abcdefghijklmnopqrst";

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-13T10:00:00Z"));
    private DeskMessaging a;
    private DeskMessaging b;
    private RunLedger ledgerA;
    private RunLedger ledgerB;

    @BeforeEach
    void setUp() throws Exception {
        Files.createDirectories(dir.resolve("a"));
        Files.createDirectories(dir.resolve("b"));
        a = new DeskMessaging(clock, () -> "d-aaaa", () -> "user-1", () -> false);
        a.keepIn(dir.resolve("a"));
        b = new DeskMessaging(clock, () -> "d-bbbb", () -> "user-1", () -> false);
        b.keepIn(dir.resolve("b"));
        ledgerA = new RunLedger(clock, id -> {});
        ledgerB = new RunLedger(clock, id -> {});
        a.sources().runs(ledgerA::find);
        b.sources().runs(ledgerB::find);
        b.open(carry(a.offer(GRANT, "ag-x", "Researcher", "d-bbbb")));
        a.open(carry(b.accept(GRANT, "ag-y", "Helper")));
    }

    private static Map<String, Object> carry(DeskMessaging.Made made) throws Exception {
        return Json.parseObject(Json.bytes(made.envelope()));
    }

    private RunLedger.Run run(RunLedger ledger, String runId, String agentId) throws Exception {
        return ledger.join(runId, agentId, Caller.THE_OWNER, List.of());
    }

    /** X's run on A sends through deskd's own tool, which records the run; B opens it. @return B's opened view */
    @SuppressWarnings("unchecked")
    private Map<String, Object> send(RunLedger.Run runA, String text) throws Exception {
        HostedCall call = new HostedCall(1, runA.runId(), "ag-x", "desk_message", Map.of("desk", "d-bbbb", "text", text),
                null, false, Caller.THE_OWNER, null);
        HostedTool.Result made = new DeskTools(a, id -> "Researcher").run(call, runA);
        Map<String, Object> envelope = (Map<String, Object>) ((Map<String, Object>) made.content()).get("envelope");
        return b.open(Json.parseObject(Json.bytes(envelope)));
    }

    @Test
    void theMessageThatStartedARunIsThatRunsSourceForItsAgentAndForOneRunOnly() throws Exception {
        Map<String, Object> opened = send(run(ledgerA, "run-a", "ag-x"), "What's on today?");
        String msgId = (String) opened.get("id");
        Map<String, Object> origin = Map.of("kind", "desk", "envelopeId", msgId);

        // Another agent's run naming it gets nothing: the member chose ag-y to answer.
        RunLedger.Run notTheAnswerer = run(ledgerB, "run-z", "ag-other");
        b.sources().origin(notTheAnswerer, origin);
        assertThat(notTheAnswerer.latest("desk")).isNull();

        RunLedger.Run runB = run(ledgerB, "run-b", "ag-y");
        b.sources().origin(runB, origin);
        b.sources().origin(runB, origin);
        RunLedger.Given given = runB.latest("desk");
        assertThat(given).isNotNull();
        assertThat(given.ref()).containsEntry("deskId", "d-aaaa").containsEntry("messageId", msgId);
        assertThat(given.label()).isEqualTo("Message from Researcher on another of your desks");
        assertThat(given.threadKey()).isEqualTo("desk:d-aaaa");
        assertThat(runB.given(Provenance.key("desk", Map.of("messageId", msgId)))).isEqualTo(given);

        // A second run of the same agent naming the same message: one run per message.
        RunLedger.Run second = run(ledgerB, "run-b2", "ag-y");
        b.sources().origin(second, origin);
        assertThat(second.latest("desk")).isNull();

        // An id deskd never opened, an origin of another kind, or none at all: nothing.
        RunLedger.Run third = run(ledgerB, "run-b3", "ag-y");
        b.sources().origin(third, Map.of("kind", "desk", "envelopeId", "env-aaaaaaaaaaaaaaaaaaaaaaaaaa"));
        b.sources().origin(third, Map.of("kind", "member"));
        b.sources().origin(third, "desk");
        assertThat(third.latest("desk")).isNull();
    }

    @Test
    void anAnswerTheWaitingCallTookIsTheSendingRunsSourceAndNoOtherRuns() throws Exception {
        RunLedger.Run runA = run(ledgerA, "run-a", "ag-x");
        RunLedger.Run otherA = run(ledgerA, "run-a2", "ag-x");
        Map<String, Object> opened = send(runA, "What's on today?");
        Map<String, Object> answer = a.open(carry(b.answer("ag-y", "Helper", GRANT, (String) opened.get("id"),
                "Two meetings.", null, false)));
        a.sources().answerTaken(answer);
        RunLedger.Given given = runA.latest("desk");
        assertThat(given).isNotNull();
        assertThat(given.label()).isEqualTo("Answer from Helper on another of your desks");
        assertThat(given.ref()).containsEntry("deskId", "d-bbbb").containsEntry("messageId", answer.get("id"));
        assertThat(otherA.latest("desk")).isNull();

        // A failure word in place of an answer is no source.
        RunLedger.Run runA3 = run(ledgerA, "run-a3", "ag-x");
        Map<String, Object> second = send(runA3, "And tomorrow?");
        Map<String, Object> failed = a.open(carry(b.answer("ag-y", "Helper", GRANT, (String) second.get("id"), null,
                "stopped", false)));
        a.sources().answerTaken(failed);
        assertThat(runA3.latest("desk")).isNull();
        // Past the wait and its margin, desk-agent's word that the call took it gives nothing (Security's DM-I5).
        RunLedger.Run runA4 = run(ledgerA, "run-a4", "ag-x");
        Map<String, Object> third = send(runA4, "And next week?");
        clock.advance(Duration.ofSeconds(151));
        Map<String, Object> late = a.open(carry(b.answer("ag-y", "Helper", GRANT, (String) third.get("id"), "Nothing.",
                null, false)));
        a.sources().answerTaken(late);
        assertThat(runA4.latest("desk")).isNull();
    }

    /**
     * Desk Maia's reports (Maia Mode Phase 2): an answer that came back after her wait is in her thread, and her later run
     * (one the member didn't start, while away) names it; deskd gives it only to her runs, only what it opened for her,
     * with U on its own copy of the run's taint, and S for a private one.
     */
    @Test
    void anAnswerOpenedForMaiaIsHerLaterRunsSourceAndNoOneElses() throws Exception {
        String maiaGrant = "dg-maiaaaaaaaaaaaaaaaaa";
        b.open(carry(a.offer(maiaGrant, "maia", "Maia", "d-bbbb")));
        a.open(carry(b.accept(maiaGrant, "ag-y", "Lead")));
        String brief = "env-" + "a".repeat(26);
        Map<String, Object> report = a.open(carry(b.answer("ag-y", "Lead", maiaGrant, brief, "[report] status=done",
                null, false)));
        String reportId = (String) report.get("id");
        assertThat(report).containsEntry("agentId", "maia");
        // An answer to ag-x's message, and a failure word to hers: neither is ever her source.
        Map<String, Object> others = a.open(carry(b.answer("ag-y", "Helper", GRANT, "env-" + "b".repeat(26), "Two.",
                null, false)));
        Map<String, Object> failed = a.open(carry(b.answer("ag-y", "Lead", maiaGrant, "env-" + "c".repeat(26), null,
                "limit_reached", false)));
        Map<String, Object> origin = Map.of("kind", "maia", "answers", List.of(others.get("id"), failed.get("id"),
                reportId, "not-an-id", 7));

        // Her run, long after the 150 s a waiting call has: given the report, with U from deskd itself.
        clock.advance(Duration.ofMinutes(40));
        RunLedger.Run hers = run(ledgerA, "run-away-1", "maia");
        a.sources().origin(hers, origin);
        RunLedger.Given given = hers.latest("desk");
        assertThat(given).isNotNull();
        assertThat(given.ref()).containsEntry("deskId", "d-bbbb").containsEntry("messageId", reportId);
        assertThat(given.label()).isEqualTo("Answer from Lead on another of your desks");
        assertThat(hers.untrusted()).isTrue();
        assertThat(hers.privateData()).isFalse();
        assertThat(hers.given(Provenance.key("desk", Map.of("messageId", others.get("id"))))).isNull();
        assertThat(hers.given(Provenance.key("desk", Map.of("messageId", failed.get("id"))))).isNull();

        // Another agent's run naming her report gets nothing, nor does a run naming it as a desk origin.
        RunLedger.Run other = run(ledgerA, "run-a9", "ag-x");
        a.sources().origin(other, origin);
        a.sources().origin(other, Map.of("kind", "desk", "envelopeId", reportId));
        assertThat(other.latest("desk")).isNull();
        assertThat(other.untrusted()).isFalse();

        // A private answer (the answering run read the member's private data there): S too.
        Map<String, Object> privateReport = a.open(carry(b.answer("ag-y", "Lead", maiaGrant, "env-" + "d".repeat(26),
                "Your balance is fine.", null, true)));
        RunLedger.Run later = run(ledgerA, "run-away-2", "maia");
        a.sources().origin(later, Map.of("kind", "maia", "answers", List.of(reportId, privateReport.get("id"))));
        assertThat(later.latest("desk").ref()).containsEntry("messageId", privateReport.get("id"));
        assertThat(later.untrusted()).isTrue();
        assertThat(later.privateData()).isTrue();

        // Past seven days, nothing.
        clock.advance(Duration.ofDays(7));
        RunLedger.Run stale = run(ledgerA, "run-away-3", "maia");
        a.sources().origin(stale, origin);
        assertThat(stale.latest("desk")).isNull();
        assertThat(stale.untrusted()).isFalse();
    }

    /** Security's DMA2-L2: the other desk's name for its agent shows as one plain line, nothing hidden in it. */
    @Test
    void aLabelsNameIsOnePlainLineWithNothingHidden() {
        assertThat(DeskSources.labelName("Lead")).isEqualTo("Lead");
        assertThat(DeskSources.labelName("Le‮ad​⁦   One \n\t")).isEqualTo("Lead One");
        assertThat(DeskSources.labelName("​‮")).isEqualTo("an agent");
        assertThat(DeskSources.labelName(null)).isEqualTo("an agent");
        assertThat(DeskSources.labelName("x".repeat(60))).hasSize(DeskSources.LABEL_NAME);
        assertThat(DeskSources.labelName("Café 研究 🙂")).isEqualTo("Café 研究 🙂");
    }

    @Test
    void aMessageOlderThanSevenDaysIsNoRunsSource() throws Exception {
        Map<String, Object> opened = send(run(ledgerA, "run-a", "ag-x"), "Hi");
        clock.advance(Duration.ofDays(7).plusMinutes(1));
        RunLedger.Run runB = run(ledgerB, "run-b", "ag-y");
        b.sources().origin(runB, Map.of("kind", "desk", "envelopeId", opened.get("id")));
        assertThat(runB.latest("desk")).isNull();
    }
}
