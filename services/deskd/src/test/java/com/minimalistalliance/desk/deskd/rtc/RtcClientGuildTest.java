package com.minimalistalliance.desk.deskd.rtc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A Guild Desk's side of {@code rtc.sock} as desk-rtc 0.4.0 changed it (its README, "Guild mode"), and as 0.3.x still
 * has it: deskd tells them apart by {@code credit} in configured, which only 0.4.0's Guild Desk reply has.
 */
class RtcClientGuildTest {

    private static final int FRAME_BYTES = Frame.MAX_FRAME_BYTES;

    @TempDir
    Path dir;

    private FakeDeskRtc fake;
    private RtcClient client;
    private final List<String> finals = new CopyOnWriteArrayList<>();
    private final List<String> closed = new CopyOnWriteArrayList<>();

    @AfterEach
    void tearDown() throws Exception {
        if (client != null) {
            client.close();
        }
        if (fake != null) {
            fake.close();
        }
    }

    private void start(boolean v04, boolean guild) throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        fake.guildV04(v04);
        fake.autoCredit(false);
        client = new RtcClient(new RtcClient.Config(socket, () -> 600, () -> "203.0.113.7", () -> guild, 3));
        client.start(new RtcListener() {
            @Override
            public void onSessionFinalBytes(String sessionId, String memberId, long bytesSent, long bytesReceived) {
                finals.add(sessionId + "/" + memberId + "/" + bytesSent + "/" + bytesReceived);
            }

            @Override
            public void onSessionClosed(String sessionId, String reason) {
                closed.add(sessionId + "/" + reason);
            }
        });
        await().until(client::isConfigured);
    }

    private long createSession(String id) throws Exception {
        return client.createSession(id, "offer", "ab".repeat(32), false, false, "gm-aaaa0001").handle();
    }

    private static byte[] frameOf(int bytes) {
        return new Frame(FrameKind.DATA, Frame.BIN, 1, 0, new byte[bytes - Frame.HEADER_BYTES]).encode();
    }

    private static long wire(long handle) {
        return handle & 0xFFFFFFFFL;
    }

    private Thread statsCall(CompletableFuture<RtcStats> into) {
        return Thread.ofVirtual().start(() -> {
            try {
                into.complete(client.stats());
            } catch (Exception e) {
                into.completeExceptionally(e);
            }
        });
    }

    @Test
    void aGuildConfigureAsksFor64KiBAndAV04ReplyIsHeldTo() throws Exception {
        start(true, true);
        assertThat(fake.awaitJson("configure")).containsEntry("deskKind", "guild").containsEntry("credit", 65536);
        assertThat(client.deskRtcHasFinalCounts()).isTrue();
        assertThat(client.sessionCredit()).isEqualTo(64 * 1024);
        long handle = createSession("cs-1");
        for (int i = 0; i < 6; i++) {
            client.send(handle, Channels.BULK, frameOf(FRAME_BYTES));
        }
        // 64 KiB goes out and the rest waits for desk-rtc's grants: past the credit would be credit_violation.
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == 64 * 1024);
        await().until(() -> client.queuedBytes(handle, Channels.BULK) == 2L * FRAME_BYTES);
        fake.sendCredit(wire(handle), Channels.BULK, FRAME_BYTES);
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == 5L * FRAME_BYTES);
    }

    @Test
    void aV03GuildReplyHasNoCreditSoDeskdKeeps256KiBAndWaitsForNothing() throws Exception {
        start(false, true);
        // The field is sent anyway: 0.3.x ignores what it does not know.
        assertThat(fake.awaitJson("configure")).containsEntry("credit", 65536);
        assertThat(client.deskRtcHasFinalCounts()).isFalse();
        assertThat(client.sessionCredit()).isEqualTo(RtcClient.INITIAL_CREDIT);
        long handle = createSession("cs-1");
        for (int i = 0; i < 17; i++) {
            client.send(handle, Channels.BULK, frameOf(FRAME_BYTES));
        }
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == RtcClient.INITIAL_CREDIT);
        await().until(() -> client.queuedBytes(handle, Channels.BULK) == FRAME_BYTES);
    }

    @Test
    void anotherKindOfDeskSendsNoCreditAndKeeps256KiB() throws Exception {
        start(true, false);
        assertThat(fake.awaitJson("configure")).doesNotContainKey("credit").doesNotContainKey("deskKind");
        assertThat(client.deskRtcHasFinalCounts()).isFalse();
        assertThat(client.sessionCredit()).isEqualTo(RtcClient.INITIAL_CREDIT);
    }

    @Test
    void aSessionClosedWithFinalCountsReachesTheListenerBeforeTheClose() throws Exception {
        start(true, true);
        createSession("cs-1");
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "over_budget", "memberId", "gm-aaaa0001",
                "bytesSent", 123456, "bytesReceived", 789));
        await().until(() -> closed.size() == 1);
        assertThat(finals).containsExactly("cs-1/gm-aaaa0001/123456/789");
        assertThat(closed).containsExactly("cs-1/over_budget");
    }

    @Test
    void aSessionClosedWithoutCountsIsAsItWas() throws Exception {
        start(false, true);
        createSession("cs-1");
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "closed_by_client"));
        await().until(() -> closed.size() == 1);
        assertThat(finals).isEmpty();
    }

    @Test
    void statsPartsAreJoinedAndCarryTheClosedRows() throws Exception {
        start(true, true);
        CompletableFuture<RtcStats> stats = new CompletableFuture<>();
        statsCall(stats);
        fake.awaitJson("stats.get");
        fake.sendJson(Map.of("t", "stats", "part", 0, "last", false, "bytesSent", 1000, "bytesReceived", 2000, "peerBytesSent", 0,
                "sessions", List.of(Map.of("sessionId", "cs-1", "memberId", "gm-a", "bytesSent", 10, "bytesReceived", 1))));
        assertThat(stats.isDone()).isFalse();
        fake.sendJson(Map.of("t", "stats", "part", 1, "last", true, "bytesSent", 5, "bytesReceived", 5, "peerBytesSent", 0,
                "sessions", List.of(Map.of("sessionId", "cs-2", "memberId", "gm-b", "bytesSent", 99, "bytesReceived", 2,
                        "closed", true))));
        RtcStats result = stats.get(5, TimeUnit.SECONDS);
        // The totals are part 0's.
        assertThat(result.bytesSent()).isEqualTo(1000);
        assertThat(result.sessions()).extracting(RtcStats.SessionStats::sessionId).containsExactly("cs-1", "cs-2");
        assertThat(result.sessions().get(0).closed()).isFalse();
        assertThat(result.sessions().get(1).closed()).isTrue();
        assertThat(result.sessions().get(1).memberId()).isEqualTo("gm-b");
        assertThat(result.sessions().get(1).bytesSent()).isEqualTo(99);
    }

    private static final class Acks implements RtcClient.ClosedRows {
        final List<String> pending = new CopyOnWriteArrayList<>(List.of("cs-1", "cs-2"));
        final List<String> acked = new CopyOnWriteArrayList<>();

        @Override
        public Collection<String> toAck() {
            return new ArrayList<>(pending);
        }

        @Override
        public void acked(Collection<String> sessionIds) {
            acked.addAll(sessionIds);
        }
    }

    @Test
    void aV04StatsGetListsTheRowsToAckAndTheyAreAckedOnlyAfterTheReply() throws Exception {
        start(true, true);
        Acks acks = new Acks();
        client.closedRows(acks);
        CompletableFuture<RtcStats> stats = new CompletableFuture<>();
        statsCall(stats);
        assertThat(fake.awaitJson("stats.get")).containsEntry("ack", List.of("cs-1", "cs-2"));
        assertThat(acks.acked).isEmpty();
        fake.sendJson(Map.of("t", "stats", "bytesSent", 0, "bytesReceived", 0, "peerBytesSent", 0));
        stats.get(5, TimeUnit.SECONDS);
        assertThat(acks.acked).containsExactly("cs-1", "cs-2");
    }

    @Test
    void aV03StatsGetIsTheOldOneWithNoAck() throws Exception {
        start(false, true);
        Acks acks = new Acks();
        client.closedRows(acks);
        CompletableFuture<RtcStats> stats = new CompletableFuture<>();
        statsCall(stats);
        assertThat(fake.awaitJson("stats.get")).doesNotContainKey("ack");
        fake.sendJson(Map.of("t", "stats", "bytesSent", 0, "bytesReceived", 0, "peerBytesSent", 0));
        stats.get(5, TimeUnit.SECONDS);
        assertThat(acks.acked).isEmpty();
    }
}
