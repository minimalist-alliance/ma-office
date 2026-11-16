package com.minimalistalliance.desk.deskd.desks;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Two of the member's desks, each with deskd's own keys and record (draft ADR §14; Security's Q2, Q7 and ATA-I2): the
 * pairing through the office, a message and its answer, and every refusal the bar names: a revoked half refuses the very
 * next envelope (each desk checks its own), an answer on a half A revoked, a forged, wrongly keyed, re-addressed or
 * another account's envelope, the 7-day expiry, the caps, and never on a Guild Desk.
 */
class DeskMessagingTest {

    private static final String GRANT = "dg-abcdefghijklmnopqrst";

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-13T10:00:00Z"));
    private final AtomicReference<String> accountA = new AtomicReference<>("user-1");
    private final AtomicReference<String> accountB = new AtomicReference<>("user-1");
    private final AtomicBoolean guildB = new AtomicBoolean();
    private DeskMessaging a;
    private DeskMessaging b;

    @BeforeEach
    void setUp() throws Exception {
        Files.createDirectories(dir.resolve("a"));
        Files.createDirectories(dir.resolve("b"));
        a = new DeskMessaging(clock, () -> "d-aaaa", accountA::get, () -> false);
        a.keepIn(dir.resolve("a"));
        b = new DeskMessaging(clock, () -> "d-bbbb", accountB::get, guildB::get);
        b.keepIn(dir.resolve("b"));
    }

    /** What the office carries: the envelope as JSON text, parsed again on the other side. */
    private static Map<String, Object> carry(DeskMessaging.Made made) throws Exception {
        return Json.parseObject(Json.bytes(made.envelope()));
    }

    private String refusal(DeskMessaging to, DeskMessaging.Made made) throws Exception {
        try {
            to.open(carry(made));
            return "opened";
        } catch (DeskMessaging.Refused e) {
            return e.reason();
        }
    }

    /** The member switches B on for X on A, B's member allows it with Y: both halves active, keys pinned. */
    private void pair() throws Exception {
        DeskMessaging.Made offer = a.offer(GRANT, "ag-x", "Researcher", "d-bbbb");
        assertThat(offer.kind()).isEqualTo("offer");
        assertThat(a.grants().owed()).extracting(DeskGrants.Owed::id).containsExactly(offer.id());
        Map<String, Object> opened = b.open(carry(offer));
        assertThat(opened).containsEntry("kind", "offer").containsEntry("fromAgentId", "ag-x")
                .containsEntry("fromAgentName", "Researcher").containsEntry("fromDeskId", "d-aaaa");
        assertThat(b.grants().half(GRANT).state()).isEqualTo("pending");
        DeskMessaging.Made accept = b.accept(GRANT, "ag-y", "Helper");
        Map<String, Object> accepted = a.open(carry(accept));
        assertThat(accepted).containsEntry("answeredBy", "ag-y");
        assertThat(a.grants().half(GRANT).active()).isTrue();
        assertThat(b.grants().half(GRANT).active()).isTrue();
    }

    @Test
    void aPairingAMessageAndItsAnswerGoEndToEnd() throws Exception {
        pair();
        DeskMessaging.Made msg = a.message("ag-x", "Researcher", "d-bbbb", "What's on the Work calendar?");
        assertThat(new String(Json.bytes(msg.envelope()), java.nio.charset.StandardCharsets.UTF_8))
                .doesNotContain("calendar");
        Map<String, Object> in = b.open(carry(msg));
        assertThat(in).containsEntry("kind", "msg").containsEntry("agentId", "ag-y")
                .containsEntry("text", "What's on the Work calendar?").containsEntry("private", false);
        // Only Desk Maia's brief is ever private (DMA-M1): from any other agent the word is not taken.
        DeskMessaging.Made held = a.message("ag-x", "Researcher", "d-bbbb", "Our Q3 numbers are in.", true);
        assertThat(b.open(carry(held))).containsEntry("private", false);
        // The offer went with seq 1 on this half; the message follows it.
        assertThat(((Number) in.get("seq")).longValue()).isEqualTo(2L);

        DeskMessaging.Made answer = b.answer("ag-y", "Helper", GRANT, msg.id(), "Two meetings.", null, true);
        Map<String, Object> back = a.open(carry(answer));
        assertThat(back).containsEntry("kind", "answer").containsEntry("replyTo", msg.id())
                .containsEntry("text", "Two meetings.").containsEntry("private", true).containsEntry("agentId", "ag-x");

        // A failure in place of an answer: a word, never text.
        DeskMessaging.Made failed = b.answer("ag-y", "Helper", GRANT, msg.id(), null, "stopped", false);
        assertThat(a.open(carry(failed))).containsEntry("failed", "stopped").doesNotContainKey("text");
    }

    @Test
    void eachEnvelopesSeqFollowsTheLastSoTheOtherDeskKeepsOrderAndARestartNeverReusesOne() throws Exception {
        pair();
        long first = a.message("ag-x", "R", "d-bbbb", "one").seq();
        long second = a.message("ag-x", "R", "d-bbbb", "two").seq();
        assertThat(second).isEqualTo(first + 1);
        // deskd restarts: the record, the counts and the keys are read back from its files.
        DeskMessaging again = new DeskMessaging(clock, () -> "d-aaaa", accountA::get, () -> false);
        again.keepIn(dir.resolve("a"));
        DeskMessaging.Made third = again.message("ag-x", "R", "d-bbbb", "three");
        assertThat(third.seq()).isEqualTo(second + 1);
        assertThat(b.open(carry(third))).containsEntry("text", "three");
    }

    @Test
    void aRevokedHalfRefusesTheVeryNextEnvelopeOnEitherDesk() throws Exception {
        pair();
        DeskMessaging.Made held = a.message("ag-x", "R", "d-bbbb", "sent before the Stop, held by the office");
        // B's member stops it: B refuses the very next message on its own, whatever A or the office do.
        DeskMessaging.Made revokeB = b.revoke(GRANT);
        assertThat(refusal(b, held)).isEqualTo("revoked");
        // A hears of it, and refuses to send on it.
        a.open(carry(revokeB));
        assertThat(a.grants().half(GRANT).revoked()).isTrue();
        assertThat(a.messageRefusal("ag-x", "d-bbbb")).isEqualTo("no_grant");
    }

    @Test
    void aDeskRefusesAnAnswerOnAHalfItRevoked() throws Exception {
        pair();
        DeskMessaging.Made msg = a.message("ag-x", "R", "d-bbbb", "question");
        b.open(carry(msg));
        DeskMessaging.Made answer = b.answer("ag-y", "H", GRANT, msg.id(), "answer", null, false);
        a.revoke(GRANT);
        assertThat(refusal(a, answer)).isEqualTo("revoked");
    }

    @Test
    void forgedWronglyKeyedAndAnotherAccountsEnvelopesAreRefused() throws Exception {
        pair();
        // Forged: a third desk's keys, sealed to B and claiming to be A.
        DeskMessaging mallory = new DeskMessaging(clock, () -> "d-aaaa", () -> "user-1", () -> false);
        mallory.keysForTest(DeskKeys.fresh("d-aaaa"));
        mallory.grants().sendOffered(GRANT, "ag-x", "d-bbbb");
        mallory.grants().accepted(GRANT, "ag-y", b.keys().pub());
        DeskMessaging.Made forged = mallory.message("ag-x", "R", "d-bbbb", "forged");
        assertThat(refusal(b, forged)).isEqualTo("bad_signature");

        // Wrongly keyed: sealed to a key that isn't B's.
        DeskMessaging other = new DeskMessaging(clock, () -> "d-bbbb", () -> "user-1", () -> false);
        DeskMessaging.Made toOther = a.message("ag-x", "R", "d-bbbb", "for B");
        other.keysForTest(DeskKeys.fresh("d-bbbb"));
        assertThat(refusal(other, toOther)).isEqualTo("cannot_open");

        // Another member's account: the same desks, another owner.
        DeskMessaging.Made msg = a.message("ag-x", "R", "d-bbbb", "hello");
        accountB.set("user-2");
        assertThat(refusal(b, msg)).isEqualTo("account");
        // And no account known: refused, never let through.
        accountB.set(null);
        assertThat(refusal(b, msg)).isEqualTo("account");
    }

    @Test
    void anOfferUnderAGrantIdAlreadyPairedWithAnotherKeyIsRefused() throws Exception {
        pair();
        DeskMessaging mallory = new DeskMessaging(clock, () -> "d-aaaa", () -> "user-1", () -> false);
        mallory.keysForTest(DeskKeys.fresh("d-aaaa"));
        DeskMessaging.Made offer = mallory.offer(GRANT, "ag-x", "R", "d-bbbb");
        assertThat(refusal(b, offer)).isEqualTo("bad_signature");
        // The real offer again is the same one: fine, and nothing changes.
        assertThat(b.grants().half(GRANT).peer().sameAs(a.keys().pub())).isTrue();
    }

    @Test
    void anEnvelopeOlderThanSevenDaysIsRefusedNotDeliveredLate() throws Exception {
        pair();
        DeskMessaging.Made msg = a.message("ag-x", "R", "d-bbbb", "late");
        clock.advance(Duration.ofDays(7).plusSeconds(1));
        assertThat(refusal(b, msg)).isEqualTo("expired");
    }

    @Test
    void twentyMessagesAGrantADayEachWayAndARetryCountsOnce() throws Exception {
        pair();
        DeskMessaging.Made first = null;
        for (int i = 0; i < DeskMessaging.PER_DAY; i++) {
            DeskMessaging.Made m = a.message("ag-x", "R", "d-bbbb", "m" + i);
            first = first == null ? m : first;
            b.open(carry(m));
            b.open(carry(m)); // the office's retry: the same envelope counts once
        }
        assertThat(a.messageRefusal("ag-x", "d-bbbb")).isEqualTo("rate");
        try {
            a.message("ag-x", "R", "d-bbbb", "one too many");
            throw new AssertionError("sent past the cap");
        } catch (DeskMessaging.Refused e) {
            assertThat(e.reason()).isEqualTo("rate");
        }
        clock.advance(Duration.ofHours(24));
        assertThat(a.messageRefusal("ag-x", "d-bbbb")).isNull();
        assertThat(first).isNotNull();
    }

    @Test
    void neverOnAGuildDesk() throws Exception {
        DeskMessaging.Made offer = a.offer(GRANT, "ag-x", "R", "d-bbbb");
        guildB.set(true);
        assertThat(refusal(b, offer)).isEqualTo("guild");
        assertThat(b.messageRefusal("ag-y", "d-aaaa")).isEqualTo("guild");
    }

    @Test
    void theRecordFailsClosedATamperedFileHoldsNothing() throws Exception {
        pair();
        Path file = dir.resolve("b").resolve(DeskGrants.FILE);
        Map<String, Object> read = Json.parseObject(Files.readAllBytes(file));
        // Any edit: here a space, as a hand edit would leave.
        read.put("body", read.get("body") + " ");
        Files.write(file, Json.bytes(read));
        DeskMessaging reread = new DeskMessaging(clock, () -> "d-bbbb", () -> "user-1", () -> false);
        reread.keepIn(dir.resolve("b"));
        assertThat(reread.grants().all()).isEmpty();
        assertThat(Files.exists(dir.resolve("b").resolve(DeskGrants.FILE + ".bad"))).isTrue();
        // So the next message is refused: the member pairs the desks again.
        DeskMessaging.Made msg = a.message("ag-x", "R", "d-bbbb", "after");
        assertThat(refusal(reread, msg)).isEqualTo("no_grant");
    }

    @Test
    void aFailedWriteSetsTheLastRecordAsideSoARestartCantReadBackARevokedGrant() throws Exception {
        pair();
        b.grants().writerForTest((file, bytes) -> {
            throw new java.io.IOException("disk full");
        });
        b.revoke(GRANT);
        DeskMessaging reread = new DeskMessaging(clock, () -> "d-bbbb", () -> "user-1", () -> false);
        reread.keepIn(dir.resolve("b"));
        assertThat(reread.grants().half(GRANT)).isNull();
    }

    @Test
    void theToolsClassIsDeskdsOwnSendFromARunHoldingPrivateDataAndOnlyWithARelayedYes() throws Exception {
        pair();
        ToolHost host = new ToolHost(clock, ToolHost.ownerOnly(), () -> false, () -> true);
        host.area(HostedDecls.DESKS, new DeskTools(a, id -> "Researcher"));
        assertThat(host.offered()).contains("desk_message", "desk_answer");

        // A run holding no S: own, and it runs at once.
        Map<String, Object> clean = tcall(1, "run-1", List.of(), Map.of("desk", "d-bbbb", "text", "hi"), null);
        Map<String, Object> look = call(host, withPhase(clean));
        assertThat(((Map<?, ?>) look.get("r")).get("risk")).isEqualTo("own");
        Map<String, Object> ran = call(host, clean);
        assertThat(ran.get("t")).isEqualTo("tres");
        Map<?, ?> made = (Map<?, ?>) ((Map<?, ?>) ran.get("r")).get("content");
        assertThat(made.get("kind")).isEqualTo("msg");
        assertThat(b.open(Json.parseObject(Json.bytes(made.get("envelope"))))).containsEntry("text", "hi");

        // A run holding S: send, refused without the member's relayed yes, whatever desk-agent says.
        Map<String, Object> privateRun = tcall(2, "run-2", List.of("S"), Map.of("desk", "d-bbbb", "text", "secret"),
                null);
        assertThat(((Map<?, ?>) call(host, withPhase(privateRun)).get("r")).get("risk")).isEqualTo("send");
        Map<String, Object> refused = call(host, privateRun);
        assertThat(refused.get("t")).isEqualTo("terr");
        assertThat(((Map<?, ?>) refused.get("details")).get("reason")).isEqualTo("approval_required");

        // No grant to that desk, by deskd's own record: refused before anyone is asked.
        Map<String, Object> elsewhere = tcall(3, "run-1", List.of(), Map.of("desk", "d-cccc", "text", "hi"), null);
        assertThat(((Map<?, ?>) call(host, withPhase(elsewhere)).get("r")).get("refusal")).isEqualTo("no_grant");
        assertThat(((Map<?, ?>) call(host, elsewhere).get("details")).get("reason")).isEqualTo("no_grant");
    }

    @Test
    void aGuildDesksAgentsHaveNoDesksArea() {
        ToolHost host = new ToolHost(clock, ToolHost.ownerOnly(), () -> true, () -> true);
        host.area(HostedDecls.DESKS, new DeskTools(a, id -> null));
        assertThat(host.offered()).doesNotContain("desk_message", "desk_answer");
    }

    /** One tcall through ToolHost as the agent socket sends it, waiting for its tres or terr. */
    private static Map<String, Object> call(ToolHost host, Map<String, Object> message) throws Exception {
        java.util.concurrent.CompletableFuture<Map<String, Object>> reply = new java.util.concurrent.CompletableFuture<>();
        host.onCall(message, reply::complete);
        return reply.get(10, java.util.concurrent.TimeUnit.SECONDS);
    }

    private static Map<String, Object> tcall(long id, String runId, List<String> taint, Map<String, Object> args,
            Map<String, Object> approval) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", id);
        m.put("runId", runId);
        m.put("agentId", "ag-x");
        m.put("tool", "desk_message");
        m.put("args", args);
        m.put("taint", taint);
        if (approval != null) {
            m.put("approval", approval);
        }
        return m;
    }

    private static Map<String, Object> withPhase(Map<String, Object> call) {
        Map<String, Object> look = new LinkedHashMap<>(call);
        look.put("phase", "look");
        return look;
    }
}
