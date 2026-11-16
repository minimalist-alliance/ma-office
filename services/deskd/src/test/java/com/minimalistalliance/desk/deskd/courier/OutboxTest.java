package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.courier.store.Actions;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The outbound queue (plan §2.10): Undo, retries over 4 days, a stop mid-send, and Courier never sending by itself. */
class OutboxTest {

    private static String draft(StoreRig rig, String to, String text) throws Exception {
        return (String) rig.store.actions().saveDraft(null, null, "email", StoreRig.GMAIL, List.of(to), "Plans", text, null, null)[0];
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> row(StoreRig rig) throws Exception {
        List<Map<String, Object>> all = rig.store.queries().outbound();
        assertThat(all).hasSize(1);
        return all.get(0);
    }

    @Test
    void aSendIsHeldForUndoAndThenGoes(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            List<Outbox.Outgoing> sent = Collections.synchronizedList(new ArrayList<>());
            rig.store.outbox().register("email", null, item -> {
                sent.add(item);
                return new Outbox.Sent(Map.of());
            });
            Object[] s = rig.store.outbox().send(draft(rig, "dana@example.com", "See you at 6"));
            assertThat((Long) s[2]).isEqualTo(rig.clock.millis() + 10_000);
            assertThat(row(rig).get("state")).isEqualTo("held");
            assertThat(rig.store.queries().drafts()).isEmpty();
            // Shown at once in the channel, as the member's own.
            Map<String, Object> m = rig.store.queries().message((String) s[0], 0);
            assertThat(m.get("direction")).isEqualTo("out");
            assertThat(m.get("status")).isEqualTo("queued");
            assertThat(m.get("lane")).isEqualTo("people");
            // Not due yet.
            rig.store.outbox().runDue();
            assertThat(sent).isEmpty();
            rig.clock.advance(Duration.ofSeconds(10));
            rig.store.outbox().runDue();
            assertThat(sent).hasSize(1);
            Outbox.Outgoing item = sent.get(0);
            assertThat(item.text()).isEqualTo("See you at 6");
            assertThat(item.to()).extracting(Outbox.Recipient::value).containsExactly("dana@example.com");
            assertThat(item.rfcMessageId()).endsWith("@gmail.example");
            assertThat(item.attempt()).isEqualTo(1);
            assertThat(item.maybeSentBefore()).isFalse();
            assertThat(row(rig).get("state")).isEqualTo("sent");
            assertThat(rig.store.queries().message((String) s[0], 0).get("status")).isEqualTo("sent");
            Invariants.check(rig.store);
        }
    }

    @Test
    void undoInsideTheWindowMakesItADraftAgain(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.outbox().register("email", null, item -> new Outbox.Sent(Map.of()));
            String d = draft(rig, "dana@example.com", "Oops");
            Object[] s = rig.store.outbox().send(d);
            assertThat(rig.store.outbox().undo((String) s[1])).isEqualTo(d);
            assertThat(rig.store.queries().message((String) s[0], 0)).isNull();
            assertThat(rig.store.queries().draft(d).get("text")).isEqualTo("Oops");
            assertThat(rig.store.queries().draft(d).get("to")).isEqualTo(List.of("dana@example.com"));
            assertThat(rig.store.queries().outbound()).isEmpty();
            Invariants.check(rig.store);
        }
    }

    @Test
    void aSentMessageCantBeTakenBack(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.outbox().register("email", null, item -> new Outbox.Sent(Map.of()));
            Object[] s = rig.store.outbox().send(draft(rig, "dana@example.com", "x"));
            rig.clock.advance(Duration.ofSeconds(11));
            rig.store.outbox().runDue();
            assertThatThrownBy(() -> rig.store.outbox().undo((String) s[1]))
                    .isInstanceOfSatisfying(Actions.Refused.class, r -> assertThat(r.reason()).isEqualTo("too_late"));
        }
    }

    @Test
    void failuresRetryWithBackoffAndGiveUpAfterFourDays(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            AtomicInteger tries = new AtomicInteger();
            rig.store.outbox().register("email", null, item -> {
                tries.incrementAndGet();
                return new Outbox.Retry("unavailable");
            });
            rig.store.outbox().send(draft(rig, "dana@example.com", "x"));
            rig.clock.advance(Duration.ofSeconds(10));
            rig.store.outbox().runDue();
            assertThat(tries.get()).isEqualTo(1);
            Map<String, Object> r = row(rig);
            assertThat(r.get("state")).isEqualTo("retry");
            assertThat(r.get("error")).isEqualTo("unavailable");
            long wait = (Long) r.get("notBefore") - rig.clock.millis();
            assertThat(wait).isBetween(60_000L, 66_001L);
            // Nothing before its time.
            rig.store.outbox().runDue();
            assertThat(tries.get()).isEqualTo(1);
            for (int i = 0; i < 200 && !"failed".equals(row(rig).get("state")); i++) {
                rig.clock.advance(Duration.ofHours(1));
                rig.store.outbox().runDue();
            }
            assertThat(row(rig).get("state")).isEqualTo("failed");
            assertThat(tries.get()).isBetween(20, 40);
            assertThat(rig.clock.millis() - (Long) row(rig).get("giveUpAt")).isLessThan(Duration.ofHours(2).toMillis());
        }
    }

    @Test
    void aRefusalFailsAtOnceAndAFailedSendCanBeEditedAgain(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.outbox().register("email", null, item -> new Outbox.Failed("no_such_user"));
            String d = draft(rig, "nobody@example.com", "x");
            Object[] s = rig.store.outbox().send(d);
            rig.clock.advance(Duration.ofSeconds(10));
            rig.store.outbox().runDue();
            assertThat(row(rig).get("state")).isEqualTo("failed");
            assertThat(rig.store.queries().message((String) s[0], 0).get("status")).isEqualTo("failed");
            assertThat(rig.store.outbox().undo((String) s[1])).isEqualTo(d);
        }
    }

    @Test
    void aStopMidSendGoesBackInTheQueueMarked(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.outbox().register("email", null, item -> new Outbox.Sent(Map.of()));
            rig.store.outbox().send(draft(rig, "dana@example.com", "x"));
            rig.clock.advance(Duration.ofSeconds(10));
            // The claim, as the runner makes it, and then the desk stops before the answer.
            assertThat(rig.store.outbox().claim()).isNotNull();
            assertThat(row(rig).get("state")).isEqualTo("sending");
            rig.reopen();
            assertThat(row(rig).get("state")).isEqualTo("queued");
            List<Outbox.Outgoing> seen = new ArrayList<>();
            rig.store.outbox().register("email", null, item -> {
                seen.add(item);
                return new Outbox.Sent(Map.of());
            });
            rig.store.outbox().runDue();
            assertThat(seen).singleElement().satisfies(i -> {
                assertThat(i.maybeSentBefore()).isTrue();
                assertThat(i.attempt()).isEqualTo(2);
            });
        }
    }

    @Test
    void sendingNeedsATransportAndNeverReachesABlockedAddress(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String d = draft(rig, "dana@example.com", "x");
            assertThatThrownBy(() -> rig.store.outbox().send(d))
                    .isInstanceOfSatisfying(Actions.Refused.class, r -> assertThat(r.reason()).isEqualTo("medium"));
            rig.store.outbox().register("email", StoreRig.GMAIL, item -> new Outbox.Sent(Map.of()));
            rig.store.actions().block("address", "pest@spam.example");
            String p = draft(rig, "pest@spam.example", "x");
            assertThatThrownBy(() -> rig.store.outbox().send(p))
                    .isInstanceOfSatisfying(Actions.Refused.class, r -> assertThat(r.reason()).isEqualTo("blocked"));
            assertThat(rig.store.outbox().send(d)).isNotNull();
        }
    }

    @Test
    void aReplyKeepsItsPlaceInTheEmailThreadAndLetsThemIn(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            List<Outbox.Outgoing> sent = new ArrayList<>();
            rig.store.outbox().register("email", null, item -> {
                sent.add(item);
                return new Outbox.Sent(Map.of());
            });
            String in = rig.accept(Mail.from("Dana <dana@example.com>").to("me@gmail.example").id("q1@example.com").subject("Question"),
                    StoreRig.GMAIL).messageId();
            assertThat(rig.lane(in)).isEqualTo("other");
            String channel = rig.channel(in);
            String d = (String) rig.store.actions().saveDraft(null, channel, "email", StoreRig.GMAIL, null, "Re: Question", "Answer", in, null)[0];
            Object[] s = rig.store.outbox().send(d);
            assertThat(rig.channel((String) s[0])).isEqualTo(channel);
            assertThat(rig.thread((String) s[0])).isEqualTo(rig.thread(in));
            assertThat(rig.lane(in)).isEqualTo("people");
            rig.clock.advance(Duration.ofSeconds(10));
            rig.store.outbox().runDue();
            assertThat(sent.get(0).inReplyTo()).isEqualTo("q1@example.com");
            assertThat(sent.get(0).references()).containsExactly("q1@example.com");
        }
    }

    @Test
    void draftsKeepTheLatestAndRefuseAStaleSave(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Object[] a = rig.store.actions().saveDraft(null, null, "email", StoreRig.GMAIL, List.of("dana@example.com"), "S", "one", null, null);
            Object[] b = rig.store.actions().saveDraft((String) a[0], null, "email", StoreRig.GMAIL, List.of("dana@example.com"), "S", "two", null, 1L);
            assertThat(b[1]).isEqualTo(2L);
            assertThatThrownBy(() -> rig.store.actions().saveDraft((String) a[0], null, "email", StoreRig.GMAIL, List.of(), "S", "stale", null, 1L))
                    .isInstanceOfSatisfying(Actions.Refused.class, r -> assertThat(r.code()).isEqualTo("conflict"));
            assertThat(rig.store.queries().draft((String) a[0]).get("text")).isEqualTo("two");
            assertThatThrownBy(() -> rig.store.actions().saveDraft(null, null, "email", null, List.of("not an address"), null, "x", null, null))
                    .isInstanceOf(Actions.Refused.class);
            assertThat(rig.store.actions().discardDraft((String) a[0])).isTrue();
        }
    }
}
