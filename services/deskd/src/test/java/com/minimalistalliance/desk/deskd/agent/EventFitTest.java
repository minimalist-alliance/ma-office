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

    private static Map<String, Object> approval(String id, String messageId, String payloadText) {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("id", id);
        a.put("messageId", messageId);
        a.put("tool", "files_write");
        a.put("state", "pending");
        a.put("payload", Map.of("path", "notes.md", "text", payloadText));
        a.put("payloadOmitted", false);
        a.put("sha256", "0".repeat(64));
        return a;
    }

    /** A reply as desk-agent's page lists it: its own approvals in it (§18), the page's copies beside. */
    @SafeVarargs
    private static Map<String, Object> reply(String id, String text, Map<String, Object>... approvals) {
        Map<String, Object> m = message(id, text);
        if (approvals.length > 0) {
            m.put("approvals", List.of(approvals));
        }
        return m;
    }

    @Test
    @SuppressWarnings("unchecked")
    void aSnapshotKeepsTheApprovalsOfTheMessagesItKeepsAndDropsTheRest() {
        List<Object> messages = new ArrayList<>();
        List<Object> approvals = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            Map<String, Object> a = approval("ap-" + i, "m" + i, "x".repeat(1_000));
            messages.add(reply("m" + i, "y".repeat(1_000), a));
            approvals.add(a);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("messages", messages);
        data.put("approvals", approvals);
        data.put("older", false);

        Map<String, Object> fitted = EventFit.snapshot(data);

        List<Map<String, Object>> kept = (List<Map<String, Object>>) fitted.get("messages");
        List<Map<String, Object>> keptApprovals = (List<Map<String, Object>>) fitted.get("approvals");
        assertThat(kept).isNotEmpty().hasSizeLessThan(40);
        assertThat(kept.getLast()).containsEntry("id", "m39");
        // One approval per kept message, the same ones, in the same order, each whole.
        assertThat(keptApprovals).extracting(a -> a.get("messageId"))
                .containsExactlyElementsOf(kept.stream().map(m -> m.get("id")).toList());
        assertThat(keptApprovals).allSatisfy(a -> assertThat(a).containsEntry("payloadOmitted", false));
        assertThat(fitted).containsEntry("omitted", 40 - kept.size()).containsEntry("older", true);
        assertThat(EventFit.size("snapshot", fitted)).isLessThanOrEqualTo(EventFit.LIMIT);
    }

    @Test
    @SuppressWarnings("unchecked")
    void aWaitingCardOfTheNewestReplyStaysWithoutItsPayloadWhenItWouldNotFitWhole() {
        // A card for a 30 KB file: the reply's own copy and the page's do not fit one event together.
        Map<String, Object> card = approval("ap-big", "new", "z".repeat(30_000));
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("messages", List.of(message("old", "a"), reply("new", "b".repeat(10_000), card)));
        data.put("approvals", List.of(card));

        Map<String, Object> fitted = EventFit.snapshot(data);

        List<Map<String, Object>> kept = (List<Map<String, Object>>) fitted.get("messages");
        List<Map<String, Object>> keptApprovals = (List<Map<String, Object>>) fitted.get("approvals");
        assertThat(kept).singleElement().satisfies(m -> assertThat(m).containsEntry("id", "new"));
        // The card is still there to draw and answer (its sha256), its payload left for agent.approval.get.
        assertThat(keptApprovals).singleElement().satisfies(a -> assertThat(a).containsEntry("id", "ap-big")
                .containsEntry("payloadOmitted", true).containsEntry("payload", null)
                .containsEntry("sha256", "0".repeat(64)));
        assertThat((List<Map<String, Object>>) kept.getFirst().get("approvals")).singleElement()
                .satisfies(a -> assertThat(a).containsEntry("payloadOmitted", true));
        assertThat(EventFit.size("snapshot", fitted)).isLessThanOrEqualTo(EventFit.LIMIT);
    }

    /** The newest reply with this many cards, each with a 30 KB payload and a long title, and an older message. */
    private static Map<String, Object> manyCards(int n) {
        List<Map<String, Object>> cards = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Map<String, Object> a = approval("ap-" + i, "new", "z".repeat(30_000));
            a.put("title", "t".repeat(600));
            cards.add(a);
        }
        Map<String, Object> newest = message("new", "b".repeat(5_000));
        newest.put("approvals", cards);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("messages", List.of(message("old", "a"), newest));
        data.put("approvals", cards);
        return data;
    }

    @Test
    @SuppressWarnings("unchecked")
    void theNewestRepliesCardsCountBothCopiesAndGoOnlyIfEvenWithoutPayloadsTheyCannotFit() {
        // 25 cards: both copies fit without payloads, with the start of the text.
        Map<String, Object> some = EventFit.snapshot(manyCards(25));
        assertThat(EventFit.size("snapshot", some)).isLessThanOrEqualTo(EventFit.LIMIT);
        assertThat((List<Map<String, Object>>) some.get("approvals")).hasSize(25)
                .allSatisfy(a -> assertThat(a).containsEntry("payloadOmitted", true));
        // 60 (Security's RF-L1): both copies can't, so the message goes alone, cut, and the app reads the whole page.
        Map<String, Object> many = EventFit.snapshot(manyCards(60));
        assertThat(EventFit.size("snapshot", many)).isLessThanOrEqualTo(EventFit.LIMIT);
        assertThat((List<Map<String, Object>>) many.get("approvals")).isEmpty();
        assertThat((List<Map<String, Object>>) many.get("messages")).singleElement()
                .satisfies(m -> assertThat(m).containsEntry("truncated", true).doesNotContainKey("approvals"));
    }

    @Test
    void aSnapshotThatFitsKeepsItsApprovalsAsTheyAre() {
        Map<String, Object> card = approval("ap-1", "m1", "short");
        Map<String, Object> data = Map.of("messages", List.of(reply("m1", "Hi", card)), "approvals", List.of(card));
        assertThat(EventFit.fit("snapshot", data)).containsExactly(new EventFit.Event("snapshot", data));
    }

    @Test
    void anythingElseTooLargeIsDropped() {
        assertThat(EventFit.fit("snapshot", Map.of("agents", List.of("q".repeat(70_000))))).isEmpty();
        assertThat(EventFit.fit("other", Map.of("text", "q".repeat(70_000)))).isEmpty();
    }
}
