package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class EventFitTest {

    private static Map<String, Object> message(String id, String text) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("role", "assistant");
        m.put("text", text);
        m.put("state", "done");
        return m;
    }

    @Test
    void whatFitsIsLeftAlone() {
        Map<String, Object> data = Map.of("messageId", "m", "runId", "r", "text", "Hi");
        assertThat(EventFit.fit("delta", data)).containsExactly(new EventFit.Event("delta", data));
    }

    @Test
    void aLargeDeltaSplitsInOrderWithoutBreakingAPair() {
        String text = "ab😀".repeat(20_000) + "\u0001".repeat(9000);
        List<EventFit.Event> parts = EventFit.fit("delta", Map.of("messageId", "m", "runId", "r", "text", text));

        StringBuilder joined = new StringBuilder();
        for (EventFit.Event part : parts) {
            String piece = (String) part.data().get("text");
            assertThat(Character.isHighSurrogate(piece.charAt(piece.length() - 1))).isFalse();
            assertThat(EventFit.size(part.type(), part.data())).isLessThanOrEqualTo(EventFit.LIMIT);
            assertThat(part.data()).containsEntry("messageId", "m").containsEntry("runId", "r");
            joined.append(piece);
        }
        assertThat(joined.toString()).isEqualTo(text);
    }

    @Test
    void aSnapshotKeepsItsNewestMessagesAndSaysHowManyItLeftOut() {
        List<Object> messages = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            messages.add(message("m" + i, "y".repeat(2000)));
        }
        Map<String, Object> fitted = EventFit.snapshot(Map.of("messages", messages));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> kept = (List<Map<String, Object>>) fitted.get("messages");
        assertThat(EventFit.size("snapshot", fitted)).isLessThanOrEqualTo(EventFit.LIMIT);
        assertThat(kept.getLast()).containsEntry("id", "m99");
        assertThat(kept.getFirst().get("id")).isEqualTo("m" + (100 - kept.size()));
        assertThat(fitted).containsEntry("omitted", 100 - kept.size()).containsEntry("older", true);
        assertThat(kept.size()).isBetween(25, 33);
    }

    /** desk-agent's own flag, for a thread longer than what it sent, comes through whether or not deskd cuts more. */
    @Test
    void deskAgentsOlderFlagIsKept() {
        Map<String, Object> small = Map.of("messages", List.of(message("m1", "hi")), "older", true);
        assertThat(EventFit.snapshot(small)).isSameAs(small);
        Map<String, Object> notOlder = Map.of("messages", List.of(message("m1", "hi")), "older", false);
        assertThat(EventFit.snapshot(notOlder)).containsEntry("older", false);

        List<Object> messages = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            messages.add(message("m" + i, "y".repeat(2000)));
        }
        Map<String, Object> cut = EventFit.snapshot(Map.of("messages", messages, "older", false));
        assertThat(cut).containsEntry("older", true);
        assertThat(EventFit.size("snapshot", cut)).isLessThanOrEqualTo(EventFit.LIMIT);
    }

    @Test
    void aMessageTooLargeKeepsTheStartOfItsText() {
        String text = "z".repeat(100_000);
        List<EventFit.Event> events = EventFit.fit("message", Map.of("message", message("m1", text)));

        assertThat(events).hasSize(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) events.getFirst().data().get("message");
        assertThat(m).containsEntry("truncated", true).containsEntry("id", "m1").containsEntry("state", "done");
        assertThat(text).startsWith((String) m.get("text"));
        assertThat(((String) m.get("text")).length()).isGreaterThan(60_000);
        assertThat(EventFit.size("message", events.getFirst().data())).isLessThanOrEqualTo(EventFit.LIMIT);
    }

    @Test
    void aSnapshotWhoseNewestMessageAloneIsTooLargeKeepsItCut() {
        Map<String, Object> fitted = EventFit.snapshot(Map.of("messages", List.of(message("old", "a"), message("new", "b".repeat(90_000)))));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> kept = (List<Map<String, Object>>) fitted.get("messages");
        assertThat(kept).hasSize(1);
        assertThat(kept.getFirst()).containsEntry("id", "new").containsEntry("truncated", true);
        assertThat(fitted).containsEntry("omitted", 1).containsEntry("older", true);
        assertThat(EventFit.size("snapshot", fitted)).isLessThanOrEqualTo(EventFit.LIMIT);
    }

    @Test
    void anythingElseTooLargeIsDropped() {
        assertThat(EventFit.fit("snapshot", Map.of("agents", List.of("q".repeat(70_000))))).isEmpty();
        assertThat(EventFit.fit("other", Map.of("text", "q".repeat(70_000)))).isEmpty();
    }
}
