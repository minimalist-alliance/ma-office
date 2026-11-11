package com.minimalistalliance.desk.agent.memory;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A long thread (S-14): before, every run sent the last 100 messages whatever their size, so a thread past the model's
 * context failed every send for good. Now a run sends the summary and what fits after it, and a compaction after the
 * run folds the rest into the summary, which the member sees and may delete for good.
 */
class CompactionTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);
    private static final String LEAD = AgentStore.MANAGER;
    private static final String SUMMARY = "SUMMARY-ALPHA: the member is planning a vegetable garden.";

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private TeamDesk desk;
    private int written;

    @BeforeEach
    void start() throws Exception {
        desk = new TeamDesk(data, clock);
        desk.bindLead();
    }

    @AfterEach
    void stop() {
        desk.close();
    }

    /** {@code pairs} exchanges straight into the thread, each turn about 1,000 estimated tokens, marked by number. */
    private void history(int pairs) throws SQLException {
        List<MessageRow> rows = new ArrayList<>();
        for (int i = 0; i < pairs; i++) {
            String n = String.format("%04d", written++);
            long at = clock.millis();
            rows.add(MessageRow.user("u-" + n, LEAD, "row-" + n + " " + "a".repeat(3_000), at));
            rows.add(new MessageRow("r-" + n, LEAD, "assistant", "reply-" + n + " " + "b".repeat(3_000), at, "run-" + n,
                    null, null, null, "end_turn", "done", null, null));
        }
        desk.store.addMessages(rows);
    }

    /** The member asks; the run answers {@code answer}, and a compaction, if one runs, writes {@code summary}. */
    private ChatRequest ask(String text, Step summary) throws Exception {
        long before = desk.service.compactor().finished();
        desk.provider.then(Step.answer(USAGE, "Answer."));
        if (summary != null) {
            desk.provider.then(summary);
        }
        int seen = desk.requests().size();
        desk.ask(LEAD, text);
        await().atMost(Duration.ofSeconds(15)).until(() -> desk.service.compactor().finished() > before);
        return desk.requests().get(seen);
    }

    private ChatRequest compaction() {
        return desk.requests().stream().filter(r -> r.system().equals(Compactor.INSTRUCTIONS)).reduce((a, b) -> b)
                .orElseThrow();
    }

    private static long estimate(ChatRequest request) {
        long bytes = 0;
        for (ChatMessage message : request.messages()) {
            bytes += message.text().getBytes(StandardCharsets.UTF_8).length;
        }
        return bytes / 3;
    }

    private Map<String, Object> summaryView() throws Exception {
        Object summary = desk.call("agent.memory.list", "agentId", LEAD).get("summary");
        return summary == null ? null : map(summary);
    }

    private List<String> decisions(String action) throws SQLException {
        return desk.audit.readBefore(null, 500).stream().map(AuditLog.Row::entry)
                .filter(entry -> entry.action().equals(action)).map(AuditLog.Entry::decision).toList();
    }

    @Test
    void aLongThreadGoesOutWithinTheBudgetAndIsFoldedIntoASummaryAfterTheRun() throws Exception {
        history(60);

        ChatRequest first = ask("What's next?", Step.answer(USAGE, SUMMARY));

        assertThat(first.messages().getFirst().text()).isEqualTo(Compactor.NOT_SHOWN);
        assertThat(first.messages().getLast().text()).isEqualTo("What's next?");
        assertThat(estimate(first)).isLessThanOrEqualTo(Compactor.BUDGET_TOKENS + 1_000);
        assertThat(String.join("\n", first.messages().stream().map(ChatMessage::text).toList()))
                .as("the oldest turns aren't sent").doesNotContain("row-0000");

        ChatRequest folding = compaction();
        assertThat(folding.tools()).isEmpty();
        assertThat(folding.maxOutputTokens()).isEqualTo(Compactor.SUMMARY_OUTPUT_TOKENS);
        assertThat(folding.messages()).singleElement().satisfies(message -> assertThat(message.text())
                .contains("{\"from\":\"member\",\"text\":\"row-").contains("{\"from\":\"agent\",\"text\":\"reply-"));
        assertThat(estimate(folding)).isLessThanOrEqualTo(Compactor.BUDGET_TOKENS + 1_000);

        Map<String, Object> view = summaryView();
        assertThat(view).containsEntry("text", SUMMARY).containsEntry("untrusted", false);
        assertThat((String) view.get("id")).startsWith("sum-");
        assertThat((int) view.get("messages")).isGreaterThan(50);
        assertThat(decisions("thread.compact")).containsExactly("ok");

        ChatRequest next = ask("And then?", null);
        assertThat(next.messages().getFirst().text()).startsWith(Compactor.HEADER).contains(SUMMARY);
        assertThat(estimate(next)).isLessThan(Compactor.KEEP_TOKENS + 6_000);
        // The compaction was reserved under the run that set it off: the member's runs today are their two sends.
        assertThat(desk.ledger.runsToday(LEAD)).isEqualTo(2);
    }

    @Test
    void aShortThreadIsNeverCompacted() throws Exception {
        history(3);
        ChatRequest request = ask("Hi", null);
        ask("Hi again", null);

        assertThat(request.messages()).hasSize(7);
        assertThat(request.messages().getFirst().text()).startsWith("row-0000");
        assertThat(desk.requests()).noneMatch(r -> r.system().equals(Compactor.INSTRUCTIONS));
        assertThat(summaryView()).isNull();
    }

    @Test
    void aDeletedSummaryNeverGoesToAModelAgainAndNeitherDoesWhatItHeld() throws Exception {
        history(60);
        ask("What's next?", Step.answer(USAGE, SUMMARY));
        String id = (String) summaryView().get("id");

        assertThat(desk.call("agent.memory.delete", "agentId", LEAD, "memoryId", id)).containsEntry("deleted", true);
        assertThat(summaryView()).isNull();

        ChatRequest next = ask("Go on.", null);
        String sent = String.join("\n", next.messages().stream().map(ChatMessage::text).toList());
        assertThat(sent).doesNotContain("SUMMARY-ALPHA").doesNotContain("row-0000").doesNotContain(Compactor.HEADER);

        history(60);
        ask("More?", Step.answer(USAGE, "SUMMARY-BETA"));
        assertThat(compaction().messages().getFirst().text()).doesNotContain("SUMMARY-ALPHA")
                .doesNotContain("row-0000");
        assertThat(summaryView()).containsEntry("text", "SUMMARY-BETA");
        assertThat(decisions("memory.delete")).containsExactly("ok");
    }

    @Test
    void aFailedCompactionLeavesTheThreadWithinTheBudgetAndTheNextRunTriesAgain() throws Exception {
        history(60);
        ask("What's next?", Step.fail(ProviderException.Kind.UNAVAILABLE, false));
        assertThat(summaryView()).isNull();
        assertThat(decisions("thread.compact")).containsExactly("error:unavailable");

        ChatRequest next = ask("Still there?", Step.answer(USAGE, SUMMARY));
        assertThat(next.messages().getFirst().text()).isEqualTo(Compactor.NOT_SHOWN);
        assertThat(estimate(next)).isLessThanOrEqualTo(Compactor.BUDGET_TOKENS + 1_000);
        assertThat(summaryView()).containsEntry("text", SUMMARY);
    }

    @Test
    void aCompactionThatRacesTheMembersDeleteWritesNothing() throws Exception {
        history(60);
        ask("What's next?", Step.answer(USAGE, SUMMARY));
        String id = (String) summaryView().get("id");
        history(60);

        CountDownLatch hold = new CountDownLatch(1);
        long before = desk.service.compactor().finished();
        desk.provider.then(Step.answer(USAGE, "Answer.")).then(Step.answer(USAGE, "SUMMARY-RACED").heldBy(hold));
        desk.ask(LEAD, "Keep going.");
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.requests().stream()
                .filter(r -> r.system().equals(Compactor.INSTRUCTIONS)).count() == 2);
        desk.call("agent.memory.delete", "agentId", LEAD, "memoryId", id);
        hold.countDown();
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.service.compactor().finished() > before);

        assertThat(summaryView()).isNull();
        assertThat(decisions("thread.compact")).contains("raced");
    }

    @Test
    void aSummaryWithAKeyKeepsNoKey() throws Exception {
        history(60);
        ask("What's next?", Step.answer(USAGE, "They shared sk-abcdefghijklmnopqrst for a test."));
        assertThat((String) summaryView().get("text")).doesNotContain("sk-abc").contains("[a key]");
    }

    @Test
    void clearingMemoryClearsTheSummaryAndKeepsItsPlace() throws Exception {
        history(60);
        ask("What's next?", Step.answer(USAGE, SUMMARY));
        assertThat(desk.call("agent.memory.clear", "agentId", LEAD)).containsEntry("deleted", 1);
        assertThat(summaryView()).isNull();
        MemoryStore.Summary kept = new MemoryStore(desk.store).summary(LEAD);
        assertThat(kept.blank()).isTrue();
        assertThat(kept.throughOrd()).isPositive();
    }

    @Test
    void trimKeepsTheNewestThatFitAndAlwaysTheLast() {
        List<MessageRow> rows = new ArrayList<>();
        for (int i = 0; i < 300; i++) {
            rows.add(MessageRow.user("m" + i, LEAD, "x".repeat(1_500), 0));
        }
        List<MessageRow> kept = Compactor.trim(rows);
        assertThat(kept.getLast().id()).isEqualTo("m299");
        assertThat(kept.size()).isLessThan(300).isGreaterThan(50);
        assertThat(kept.stream().mapToLong(Compactor::estimate).sum()).isLessThanOrEqualTo(Compactor.BUDGET_TOKENS);

        List<MessageRow> huge = List.of(MessageRow.user("a", LEAD, "y".repeat(10), 0),
                MessageRow.user("b", LEAD, "z".repeat(400_000), 0));
        assertThat(Compactor.trim(huge)).extracting(MessageRow::id).containsExactly("b");
    }
}
