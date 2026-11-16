package com.minimalistalliance.desk.agent.desks;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * desk-agent's rows for messages between the member's desks (draft ADR §14): every envelope taken in exactly once and in
 * order per grant, through a desk-agent restart at any point, the office's retries and its mistakes; each desk's own
 * check of its half; the outbox; the 7-day expiry. §17's "10,000 envelopes: 0 lost, 0 doubled" at the store.
 */
class DeskBookTest {

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private AgentStore store;
    private DeskBook book;
    private int grants;

    @BeforeEach
    void open() throws Exception {
        store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        book = new DeskBook(store);
    }

    @AfterEach
    void close() throws Exception {
        store.close();
    }

    /** A restart of desk-agent: the file closed and opened again. */
    private void restart() throws Exception {
        store.close();
        store = new AgentStore(data.resolve("agent.db"), clock);
        store.open();
        book = new DeskBook(store);
    }

    /** A fixed-width base-32 id, so no two numbers make the same one. */
    static String base32(long n, int width) {
        String digits = String.format("%" + width + "s", Long.toString(n, 32)).replace(' ', '0');
        return digits.replace('0', 'w').replace('1', 'x').replace('8', 'y').replace('9', 'z');
    }

    private static String grant(int n) {
        return "dg-" + base32(n, 20);
    }

    private static String env(long n) {
        return "env-" + base32(n, 26);
    }

    private Map<String, Object> opened(String id, String kind, String grantId, long seq, Object... more) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("kind", kind);
        m.put("grantId", grantId);
        m.put("fromDeskId", "d-aaaa");
        m.put("seq", seq);
        m.put("sentAt", clock.millis());
        for (int i = 0; i < more.length; i += 2) {
            m.put((String) more[i], more[i + 1]);
        }
        return m;
    }

    /** An offer from desk A's agent X, allowed here with the lead answering. */
    private String paired() throws Exception {
        String grantId = grant(++grants);
        book.deliver(opened(env(grants * 1_000_000L), "offer", grantId, 1, "fromAgentId", "ag-x", "fromAgentName", "X"),
                clock.millis());
        book.allow(grantId, AgentStore.MANAGER, clock.millis());
        return grantId;
    }

    private Map<String, Object> msg(String id, String grantId, long seq) {
        return opened(id, "msg", grantId, seq, "fromAgentId", "ag-x", "fromAgentName", "X", "text", "hello " + seq);
    }

    private String refusal(Map<String, Object> opened) {
        try {
            book.deliver(opened, clock.millis());
            return "delivered";
        } catch (RpcError e) {
            return String.valueOf(e.details().get("reason"));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void anEnvelopeTakenInTwiceCountsOnceAndOneOlderThanTheLastIsStale() throws Exception {
        String grantId = paired();
        assertThat(book.deliver(msg(env(1), grantId, 2), clock.millis()).outcome()).isEqualTo("delivered");
        assertThat(book.deliver(msg(env(1), grantId, 2), clock.millis()).outcome()).isEqualTo("duplicate");
        assertThat(book.deliver(msg(env(3), grantId, 4), clock.millis()).outcome()).isEqualTo("delivered");
        // Seq 3 after 4: never taken in out of order, and never as a new one.
        assertThat(refusal(msg(env(2), grantId, 3))).isEqualTo("stale");
        assertThat(book.inbox("msg", "received")).extracting(DeskBook.InRow::envId).containsExactly(env(1), env(3));
    }

    @Test
    void aRevokedAnswerHalfRefusesTheVeryNextMessage() throws Exception {
        String grantId = paired();
        assertThat(refusal(msg(env(1), grantId, 2))).isEqualTo("delivered");
        book.revokeAnswer(grantId, clock.millis());
        assertThat(refusal(msg(env(2), grantId, 3))).isEqualTo("revoked");
        // And an offer under that grant again can't bring it back.
        assertThat(refusal(opened(env(3), "offer", grantId, 4, "fromAgentId", "ag-x"))).isEqualTo("revoked");
    }

    @Test
    void anOfferNotAllowedYetTakesNoMessagesAndOnlyTheAgentItNamedMaySend() throws Exception {
        String grantId = grant(++grants);
        book.deliver(opened(env(1), "offer", grantId, 1, "fromAgentId", "ag-x"), clock.millis());
        assertThat(book.answerHalves()).extracting(DeskBook.AnswerHalf::state).containsExactly("offered");
        assertThat(refusal(msg(env(2), grantId, 2))).isEqualTo("no_grant");
        book.decline(grantId, clock.millis());
        assertThat(refusal(msg(env(3), grantId, 3))).isEqualTo("no_grant");
        book.allow(grantId, AgentStore.MANAGER, clock.millis());
        Map<String, Object> fromOther = msg(env(4), grantId, 4);
        fromOther.put("fromAgentId", "ag-other");
        assertThat(refusal(fromOther)).isEqualTo("no_grant");
        assertThat(refusal(msg(env(5), grantId, 5))).isEqualTo("delivered");
    }

    @Test
    void aHandEditedAnswerHalfIsNoHalf() throws Exception {
        String grantId = paired();
        store.database().transaction(c -> {
            try (PreparedStatement u = c.prepareStatement("UPDATE desk_answers SET agent_id = 'someone' WHERE grant_id = ?")) {
                u.setString(1, grantId);
                u.executeUpdate();
            }
            return null;
        });
        assertThat(book.answerHalf(grantId)).isNull();
        assertThat(refusal(msg(env(1), grantId, 2))).isEqualTo("no_grant");
    }

    @Test
    void twentyMessagesAGrantADay() throws Exception {
        String grantId = paired();
        for (int i = 0; i < DeskBook.PER_DAY; i++) {
            assertThat(refusal(msg(env(i + 10), grantId, i + 2))).isEqualTo("delivered");
        }
        assertThat(refusal(msg(env(99), grantId, 40))).isEqualTo("rate");
        clock.advance(Duration.ofHours(24).plusSeconds(1));
        assertThat(refusal(msg(env(100), grantId, 41))).isEqualTo("delivered");
    }

    @Test
    void anAnswerIsTakenOnlyOnALiveSendHalfForAMessageThisDeskSent() throws Exception {
        String grantId = grant(++grants);
        long now = clock.millis();
        store.database().transaction(c -> {
            try (PreparedStatement i = c.prepareStatement("INSERT INTO desk_grants (grant_id, agent_id, to_desk_id,"
                    + " to_desk_name, state, created_at, updated_at, count, sha256) VALUES (?, 'manager', 'd-aaaa', 'Work',"
                    + " 'active', ?, ?, 0, ?)")) {
                i.setString(1, grantId);
                i.setLong(2, now);
                i.setLong(3, now);
                i.setString(4, com.minimalistalliance.desk.agent.access.AccessBook.halfHash(grantId, "manager", "d-aaaa",
                        "active"));
                i.executeUpdate();
            }
            return null;
        });
        book.queue(List.of(new DeskBook.OutRow(env(1), grantId, "d-aaaa", "msg", 2, "{}", "manager", null, now,
                "queued", null)));
        Map<String, Object> answer = opened(env(2), "answer", grantId, 2, "replyTo", env(1), "text", "yes",
                "answeredBy", "ag-y");
        // An answer to a message this desk never sent is refused.
        Map<String, Object> stray = opened(env(3), "answer", grantId, 3, "replyTo", env(9), "text", "?");
        assertThat(refusal(stray)).isEqualTo("envelope");
        assertThat(refusal(answer)).isEqualTo("delivered");
        // This desk revokes its half: the next answer on it is refused (Security's Q7).
        store.database().transaction(c -> {
            try (PreparedStatement u = c.prepareStatement("UPDATE desk_grants SET state = 'revoked', sha256 = ?"
                    + " WHERE grant_id = ?")) {
                u.setString(1, com.minimalistalliance.desk.agent.access.AccessBook.halfHash(grantId, "manager",
                        "d-aaaa", "revoked"));
                u.setString(2, grantId);
                u.executeUpdate();
            }
            return null;
        });
        assertThat(refusal(opened(env(4), "answer", grantId, 4, "replyTo", env(1), "text", "again")))
                .isEqualTo("revoked");
    }

    @Test
    void theOutboxGivesEachEnvelopeOnceOldestFirstAndExpiresWhatWaitedSevenDays() throws Exception {
        long now = clock.millis();
        List<DeskBook.OutRow> rows = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            rows.add(new DeskBook.OutRow(env(i), grant(1), "d-bbbb", "msg", i, "{\"n\":" + i + "}", "manager", null,
                    now, "queued", null));
        }
        book.queue(rows);
        book.queue(rows); // deskd's push again, or a call asked again by its key: nothing more
        assertThat(book.pending()).containsExactly(Map.of("toDeskId", "d-bbbb", "count", 5, "oldestAt", now));
        List<DeskBook.OutRow> taken = book.take("d-bbbb", 3);
        assertThat(taken).extracting(DeskBook.OutRow::envId).containsExactly(env(1), env(2), env(3), env(4));
        DeskBook.Done done = book.done(List.of(Map.of("id", env(1), "outcome", "delivered"),
                Map.of("id", env(2), "outcome", "duplicate"),
                Map.of("id", env(3), "outcome", "refused", "reason", "revoked")), now);
        assertThat(done.done()).isEqualTo(3);
        assertThat(done.refused()).extracting(DeskBook.OutRow::envId).containsExactly(env(3));
        assertThat(done.revoked()).containsExactly(grant(1));
        // A done again changes nothing.
        assertThat(book.done(List.of(Map.of("id", env(1), "outcome", "refused", "reason", "x")), now).done()).isZero();

        clock.advance(Duration.ofDays(7).plusSeconds(1));
        assertThat(book.expire(clock.millis())).extracting(DeskBook.OutRow::envId).containsExactly(env(4), env(5));
        assertThat(book.take("d-bbbb", 10)).isEmpty();
    }

    /**
     * §17's bar at the store: 10,000 messages over 500 grants, taken in through an office that retries what it never
     * heard back about and a desk-agent restarted every few hundred: every one in the inbox once, in order per grant.
     */
    @Test
    void tenThousandEnvelopesThroughRetriesAndRestartsNoneLostNoneDoubledInOrder() throws Exception {
        Random random = new Random(1113);
        int grantCount = 500;
        int perGrant = DeskBook.PER_DAY;
        List<String> grantIds = new ArrayList<>();
        for (int g = 0; g < grantCount; g++) {
            grantIds.add(paired());
        }
        // Each grant's envelopes, in the order its sender made them.
        Map<String, List<Map<String, Object>>> queues = new HashMap<>();
        long n = 0;
        for (String grantId : grantIds) {
            List<Map<String, Object>> q = new ArrayList<>();
            for (int i = 0; i < perGrant; i++) {
                q.add(msg(env(++n), grantId, i + 2));
            }
            queues.put(grantId, q);
        }
        Map<String, Integer> next = new HashMap<>();
        int delivered = 0;
        int duplicates = 0;
        int restarts = 0;
        int total = grantCount * perGrant;
        while (delivered < total) {
            String grantId = grantIds.get(random.nextInt(grantCount));
            int at = next.getOrDefault(grantId, 0);
            if (at >= perGrant) {
                continue;
            }
            Map<String, Object> envelope = queues.get(grantId).get(at);
            String outcome;
            try {
                outcome = book.deliver(envelope, clock.millis()).outcome();
            } catch (RpcError e) {
                throw new AssertionError("refused " + e.details() + " at " + at + " of " + grantId + " after "
                        + delivered, e);
            }
            if ("delivered".equals(outcome)) {
                delivered++;
            } else {
                duplicates++;
            }
            // The answer was lost on the way back a fifth of the time: the office delivers the same one again.
            if (random.nextInt(5) == 0) {
                assertThat(book.deliver(envelope, clock.millis()).outcome()).isEqualTo("duplicate");
                duplicates++;
            }
            next.put(grantId, at + 1);
            if (random.nextInt(400) == 0) {
                restart();
                restarts++;
            }
        }
        assertThat(restarts).isPositive();
        assertThat(duplicates).isPositive();
        int[] rows = new int[1];
        Map<String, List<Long>> order = new HashMap<>();
        store.database().call(c -> {
            try (PreparedStatement s = c.prepareStatement("SELECT grant_id, seq FROM desk_inbox WHERE kind = 'msg'"
                    + " ORDER BY rowid"); ResultSet r = s.executeQuery()) {
                while (r.next()) {
                    rows[0]++;
                    order.computeIfAbsent(r.getString(1), k -> new ArrayList<>()).add(r.getLong(2));
                }
            }
            return null;
        });
        assertThat(rows[0]).as("every envelope in once").isEqualTo(total);
        for (List<Long> seqs : order.values()) {
            assertThat(seqs).as("in order per grant").isSorted().doesNotHaveDuplicates().hasSize(perGrant);
        }
    }

    @Test
    void aDeliveryWithAMissingFieldIsNoEnvelope() {
        Map<String, Object> bad = msg(env(1), grant(1), 2);
        bad.remove("seq");
        assertThatThrownBy(() -> book.deliver(bad, clock.millis())).isInstanceOf(RpcError.class);
    }
}
