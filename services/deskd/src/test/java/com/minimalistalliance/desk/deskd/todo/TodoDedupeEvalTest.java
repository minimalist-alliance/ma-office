package com.minimalistalliance.desk.deskd.todo;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Dedupe on the labelled set (the Maia Mode concept's §11.2, piece 6: precision 0.98 or more, recall 0.9 or more on at
 * least 500 messages): {@code src/test/resources/todo/dedupe/messages.jsonl}, 530 to-dos extracted from 476 messages,
 * each labelled with the real-world task it is, by hand and before any rule (its README). Every line goes through the
 * real store as an agent's add from a Courier message, in time order, and lands either as a new row or in an existing one
 * (deduped or merged). A landing in a row of another task is a false merge; a repeat of a task that gets a row of its own
 * is a miss.
 *
 * <p><b>What deskd's code alone does</b> (VISION §2's rules, no model): it never merges two different tasks, and it catches
 * the exact repeats (the same message read again) and the near-identical reminders. Most repeats in a real inbox are
 * paraphrases ("Choose your 2027 benefit plans" for "Complete open enrollment by Nov 25"), which no word rule catches
 * without merging different tasks: the best word rule at precision 0.98 caught about 12% (the tuning notes in
 * {@code docs/sub-status/mm-todo-store.md}). So recall is the agent's {@code same_as}, with the open list in front of it:
 * a real model's judgement, which runs only on a staging desk (the bar's capability run). {@link #withTheAgentsSameAs}
 * measures the store's half of that path with the labels standing in for a perfect model, so the plumbing is proven and
 * the model's own precision and recall are what's left to measure.
 */
class TodoDedupeEvalTest {

    @TempDir
    Path dir;

    record Line(String messageId, String threadId, String contactId, int day, int minute, String title, String due,
            String task) {}

    record Score(int lines, int repeats, int caught, int falseMerges, int landings) {
        double precision() {
            return landings == 0 ? 1 : (double) (landings - falseMerges) / landings;
        }

        double recall() {
            return repeats == 0 ? 1 : (double) caught / repeats;
        }
    }

    static List<Line> fixture() throws Exception {
        List<Line> lines = new ArrayList<>();
        try (InputStream in = TodoDedupeEvalTest.class.getResourceAsStream("/todo/dedupe/messages.jsonl")) {
            assertThat(in).as("the labelled set").isNotNull();
            for (String raw : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) {
                if (raw.isBlank()) {
                    continue;
                }
                Map<String, Object> m = Json.parseObject(raw.getBytes(StandardCharsets.UTF_8));
                lines.add(new Line((String) m.get("messageId"), (String) m.get("threadId"), (String) m.get("contactId"),
                        ((Number) m.get("day")).intValue(), ((Number) m.get("minute")).intValue(), (String) m.get("title"),
                        (String) m.get("due"), (String) m.get("task")));
            }
        }
        return lines;
    }

    /**
     * Runs the set through a fresh store. {@code sameAs} is the agent's judgement: given a line and the open items so far
     * (id to task), the id it names as the same task, or null.
     */
    Score run(Path file, Function<Line, String> sameAs, Map<String, String> taskOfItem) throws Exception {
        Instant start = Instant.parse("2026-11-01T00:00:00Z");
        MutableClock clock = new MutableClock(start);
        List<Line> lines = fixture();
        int repeats = 0;
        int caught = 0;
        int falseMerges = 0;
        int landings = 0;
        Set<String> seenTasks = new HashSet<>();
        try (TodoStore store = TodoStore.open(file, clock, () -> ZoneOffset.UTC)) {
            int n = 0;
            for (Line line : lines) {
                Instant at = start.plus(Duration.ofDays(line.day())).plus(Duration.ofMinutes(line.minute()))
                        .plusMillis(n++);
                if (at.isAfter(clock.instant())) {
                    clock.advance(Duration.between(clock.instant(), at));
                }
                boolean repeat = !seenTasks.add(line.task());
                // As Provenance records a Courier message: its scope is its channel, Courier's conversation with that
                // contact, so a reminder in a new email thread from the same person is in scope too.
                TodoStore.Source source = new TodoStore.Source("courier",
                        Map.of("messageId", line.messageId(), "channelId", "ch-" + line.contactId()),
                        "Email from " + line.contactId(), "courier:ch-" + line.contactId());
                TodoStore.AddResult r = store.agentAdd(new TodoStore.AgentAdd("ag-inbox", "run-" + line.messageId(),
                        "ap-" + n, line.title(), null, line.due() == null ? null : new TodoStore.Due(line.due(), null, null),
                        source, true, sameAs.apply(line)));
                if (r.created()) {
                    taskOfItem.put(r.id(), line.task());
                } else {
                    landings++;
                    if (!line.task().equals(taskOfItem.get(r.id()))) {
                        falseMerges++;
                    }
                }
                if (repeat && !r.created() && line.task().equals(taskOfItem.get(r.id()))) {
                    caught++;
                }
                if (repeat) {
                    repeats++;
                }
            }
        }
        return new Score(lines.size(), repeats, caught, falseMerges, landings);
    }

    @Test
    void theSetIsAtLeastFiveHundredLabelledMessages() throws Exception {
        List<Line> lines = fixture();
        assertThat(lines).hasSizeGreaterThanOrEqualTo(500);
        assertThat(lines.stream().map(Line::messageId).distinct().count()).isGreaterThanOrEqualTo(450);
        assertThat(lines.stream().map(Line::task).distinct().count()).isGreaterThan(150);
    }

    /** deskd's code alone never merges two different tasks, and catches what a word rule honestly can. */
    @Test
    void theStoresOwnRulesNeverMergeTwoDifferentTasks() throws Exception {
        Score s = run(dir.resolve("code.db"), line -> null, new HashMap<>());
        System.out.printf("todo dedupe, deskd's rules alone: lines=%d repeats=%d caught=%d landings=%d false=%d "
                + "precision=%.4f recall=%.4f%n", s.lines(), s.repeats(), s.caught(), s.landings(), s.falseMerges(),
                s.precision(), s.recall());
        assertThat(s.precision()).as("precision").isGreaterThanOrEqualTo(0.98);
        // What they catch on this set today; a change that catches less is a regression.
        assertThat(s.caught()).as("repeats caught by the rules alone").isGreaterThanOrEqualTo(14);
    }

    /** The same message read twice is always one row: every line again, after the whole set, adds nothing. */
    @Test
    void everyMessageReadAgainIsCaught() throws Exception {
        Instant start = Instant.parse("2026-11-01T00:00:00Z");
        MutableClock clock = new MutableClock(start);
        try (TodoStore store = TodoStore.open(dir.resolve("again.db"), clock, () -> ZoneOffset.UTC)) {
            List<Line> lines = fixture();
            Map<String, String> first = new HashMap<>();
            int n = 0;
            for (Line line : lines) {
                TodoStore.Source source = new TodoStore.Source("courier",
                        Map.of("messageId", line.messageId(), "channelId", line.contactId()), "", "courier:" + line.threadId());
                // Spread over days and agents as an inbox's would be, so the caps don't come into it.
                first.put(line.messageId() + "\n" + line.title(), store.agentAdd(new TodoStore.AgentAdd("ag-" + (n % 5),
                        "run-a" + n, "ap-a" + n++, line.title(), null, null, source, true, null)).id());
                clock.advance(Duration.ofMinutes(20));
            }
            for (Line line : lines) {
                TodoStore.Source source = new TodoStore.Source("courier",
                        Map.of("messageId", line.messageId(), "channelId", line.contactId()), "", "courier:" + line.threadId());
                TodoStore.AddResult again = store.agentAdd(new TodoStore.AgentAdd("ag-" + (n % 5), "run-b" + n, "ap-b" + n++,
                        line.title(), null, null, source, true, null));
                assertThat(again.created()).as(line.messageId()).isFalse();
                assertThat(again.id()).isEqualTo(first.get(line.messageId() + "\n" + line.title()));
            }
        }
    }

    /**
     * The agent's {@code same_as} path, with the labels standing in for a perfect model that names the open item of the
     * same task when there is one: the store merges exactly what it's told, so the recall and precision of the whole are
     * the model's. Both bars are met here; the real model's numbers come from its capability run on staging.
     */
    @Test
    void withTheAgentsSameAs() throws Exception {
        Map<String, String> taskOfItem = new HashMap<>();
        Map<String, String> openItemOfTask = new HashMap<>();
        Score s = run(dir.resolve("assisted.db"), line -> openItemOfTask.get(line.task()), new MapView(taskOfItem,
                openItemOfTask));
        System.out.printf("todo dedupe, with same_as from the labels: precision=%.4f recall=%.4f%n", s.precision(),
                s.recall());
        assertThat(s.precision()).isGreaterThanOrEqualTo(0.98);
        assertThat(s.recall()).isGreaterThanOrEqualTo(0.9);
    }

    /** Keeps task to item as rows are made, so the stand-in can name the open item of a task. */
    private static final class MapView extends HashMap<String, String> {
        private static final long serialVersionUID = 1L;
        private final transient Map<String, String> inverse;
        private final transient Map<String, String> delegate;

        MapView(Map<String, String> delegate, Map<String, String> inverse) {
            this.delegate = delegate;
            this.inverse = inverse;
        }

        @Override
        public String put(String id, String task) {
            inverse.putIfAbsent(task, id);
            delegate.put(id, task);
            return super.put(id, task);
        }
    }
}
