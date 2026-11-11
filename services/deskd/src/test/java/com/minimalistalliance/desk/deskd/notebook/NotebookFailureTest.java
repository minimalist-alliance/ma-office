package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * What the relay does when desk-notebook isn't there, restarts, or stalls: the failure replies, {@code reset}, and that
 * only the session using it notices. {@code NotebookIsolationTest} has the same stall against the whole application.
 */
@ExtendWith(OutputCaptureExtension.class)
class NotebookFailureTest {

    private static final String MARKER = "zebra-marker-text";
    private static final int MIB_4 = 4 << 20;

    @TempDir
    Path dir;

    private FakeNotebookSocket service;
    private NotebookRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (service != null) {
            service.close();
        }
    }

    private Path socket() {
        return dir.resolve("notebook.sock");
    }

    private void withService() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket());
    }

    private static void assertUnavailable(Map<String, Object> reply) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(reply.get("details")).isEqualTo(Map.of("reason", "notebook"));
    }

    private static void assertMayHaveApplied(Map<String, Object> reply) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(reply.get("details")).isEqualTo(Map.of("reason", "notebook", "mayHaveApplied", true));
    }

    /** Replies by id, as they don't come in any order. */
    private static Map<Long, Map<String, Object>> replies(TestClient client, int count) throws Exception {
        Map<Long, Map<String, Object>> byId = new HashMap<>();
        for (int i = 0; i < count; i++) {
            Map<String, Object> reply = client.nextReply();
            byId.put((Long) reply.get("_id"), reply);
        }
        return byId;
    }

    // ---- absent

    @Test
    void withNoServiceACallIsUnavailableAndHealthSaysWaiting() throws Exception {
        rig = new NotebookRig(dir, socket());
        TestClient client = rig.connect("a");

        assertUnavailable(rig.call(client, "notebook.tree", Map.of()));
        assertThat(rig.module.health()).containsEntry("notebook", "waiting");
        assertThat(rig.sessions.isLive("a")).isTrue();
    }

    @Test
    void withNoServiceAMutationHasNoFlagAndTheSameKeyRunsOnceItsBack() throws Exception {
        rig = new NotebookRig(dir, socket());
        TestClient client = rig.connect("a");
        String idem = UUID.randomUUID().toString();

        assertUnavailable(rig.call(client, "notebook.page.trash", Map.of("pageId", "p1"), idem));

        service = new FakeNotebookSocket(socket());
        service.handlers.put("notebook.page.trash", p -> Map.of("trashed", true));
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            Map<String, Object> reply = rig.call(client, "notebook.page.trash", Map.of("pageId", "p1"), idem);
            return "RES".equals(reply.get("_kind")) && Boolean.TRUE.equals(reply.get("trashed"));
        });
        assertThat(service.last().received.stream().filter(m -> "req".equals(m.get("t")))).hasSize(1);
    }

    /** What an older image gives: run's mount makes an empty root-owned directory, and it just waits. */
    @Test
    void anEmptyDirectoryOrOneItCantEnterJustWaitsAndLogsOnce(CapturedOutput output) throws Exception {
        Path empty = Files.createDirectory(dir.resolve("empty"));
        rig = new NotebookRig(dir, empty.resolve("notebook.sock"));
        TestClient client = rig.connect("a");
        for (int i = 0; i < 3; i++) {
            assertUnavailable(rig.call(client, "notebook.tree", Map.of()));
        }
        client.subscribe("notebook.tree", null);
        Thread.sleep(300);
        assertThat(output.getAll().lines().filter(line -> line.contains("notebook link"))).hasSize(1);
        rig.close();

        Path shut = Files.createDirectory(dir.resolve("shut"));
        Files.setPosixFilePermissions(shut, PosixFilePermissions.fromString("---------"));
        Path other = Files.createDirectory(dir.resolve("other"));
        rig = new NotebookRig(other, shut.resolve("notebook.sock"));
        try {
            assertUnavailable(rig.call(rig.connect("b"), "notebook.tree", Map.of()));
        } finally {
            Files.setPosixFilePermissions(shut, PosixFilePermissions.fromString("rwx------"));
        }
    }

    @Test
    void aSubWhileItsAwayIsQuietUntilItsBack() throws Exception {
        rig = new NotebookRig(dir, socket());
        TestClient client = rig.connect("a");

        assertThat(client.subscribe("notebook.tree", null)).containsEntry("_kind", "RES");
        assertThat(rig.rtcFake.pollFrame(client.handle(), Channels.EVENTS, 150)).isNull();

        service = new FakeNotebookSocket(socket());
        service.tree = Map.of("rev", 3);

        assertThat(rig.nextEvent(client)).containsEntry("type", "snapshot").containsEntry("data", Map.of("rev", 3));
        assertThat(rig.module.health()).containsEntry("notebook", "connected");
        // The first connection is the session's; health's read of the storage state is one of its own, with no hello.
        assertThat(service.connections.get(0).next("hello")).containsEntry("sessionId", "a");
    }

    @Test
    void collabDataWhileItsAwayGetsOneReset() throws Exception {
        rig = new NotebookRig(dir, socket());
        TestClient client = rig.connect("a");

        rig.sendCollab(client, new byte[] {1, 2, 3});

        assertThat(rig.nextData(client).isReset()).isTrue();
        assertThat(rig.rtcFake.pollFrame(client.handle(), Channels.COLLAB, 150)).isNull();
        assertThat(rig.sessions.isLive("a")).isTrue();

        // The provider comes back with its own backoff, and the service is there this time.
        service = new FakeNotebookSocket(socket());
        rig.sendCollab(client, new byte[] {4});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly(4);
    }

    @Test
    void aFullBacklogIsJustNotConnectedYet() throws Exception {
        withService();
        service.stopAccepting();
        List<SocketChannel> crowd = new ArrayList<>();
        try {
            // Far past what's listen()ed for, so that connecting fails with EAGAIN.
            for (int i = 0; i < 300; i++) {
                try {
                    SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX);
                    crowd.add(channel);
                    channel.configureBlocking(false);
                    channel.connect(UnixDomainSocketAddress.of(socket()));
                } catch (java.io.IOException e) {
                    break;
                }
            }
            TestClient client = rig.connect("a");
            long started = System.nanoTime();
            assertUnavailable(rig.call(client, "notebook.tree", Map.of()));
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(2));
        } finally {
            for (SocketChannel channel : crowd) {
                channel.close();
            }
        }
    }

    // ---- restarts

    @Test
    void aRestartFailsWhatsInFlightSendsResetOnceAndResubscribes() throws Exception {
        withService();
        service.tree = Map.of("rev", 5);
        TestClient client = rig.connect("a");
        client.subscribe("notebook.tree", null);
        assertThat(rig.nextEvent(client)).containsEntry("data", Map.of("rev", 5));
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();

        String idem = UUID.randomUUID().toString();
        long read = rig.send(client, "notebook.search", Map.of("query", "x"), null);
        long mutation = rig.send(client, "notebook.page.create", Map.of("tabId", "t1"), idem);
        // Both have gone out.
        service.requests.poll(5, TimeUnit.SECONDS);
        service.requests.poll(5, TimeUnit.SECONDS);
        FakeNotebookSocket.Connection first = service.last();
        service.tree = Map.of("rev", 6);

        service.restart();

        Map<Long, Map<String, Object>> failed = replies(client, 2);
        assertUnavailable(failed.get(read));
        assertMayHaveApplied(failed.get(mutation));
        assertThat(rig.nextData(client).isReset()).isTrue();
        assertThat(rig.rtcFake.pollFrame(client.handle(), Channels.COLLAB, 100)).isNull();

        // A new connection, with its hello first, and the session's topic again.
        rig.awaitRev(client, 6);
        FakeNotebookSocket.Connection second = service.last();
        assertThat(second).isNotSameAs(first);
        assertThat(second.received.take()).containsEntry("t", "hello");
        assertThat(second.received.take()).containsEntry("t", "sub");
        service.publish(Map.of("rev", 7));
        rig.awaitRev(client, 7);

        // API.md section 4: the same key replays what it said, and doesn't run the method again.
        Map<String, Object> retried = rig.call(client, "notebook.page.create", Map.of("tabId", "t1"), idem);
        assertMayHaveApplied(retried);
        assertThat(service.requests).isEmpty();
    }

    @Test
    void whatWasOnItsWayToTheClientComesBeforeTheReset() throws Exception {
        withService();
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        byte[] long1 = new byte[1 << 20];
        long1[0] = 7;

        service.last().sendCollab(long1);
        service.last().sendCollab(new byte[] {8});
        service.last().drop();

        assertThat(rig.nextData(client).bytes()).isEqualTo(long1);
        assertThat(rig.nextData(client).bytes()).containsExactly(8);
        assertThat(rig.nextData(client).isReset()).isTrue();
    }

    @Test
    void withCollabNotInUseAConnectionGoingSendsNoReset() throws Exception {
        withService();
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        rig.call(client, "notebook.tree", Map.of());

        service.restart();

        assertThat(rig.rtcFake.pollFrame(client.handle(), Channels.COLLAB, 150)).isNull();
    }

    @Test
    void onlyASubscriptionKeepsItTryingAndAnyUseConnectsAgain() throws Exception {
        withService();
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        rig.call(client, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection first = service.last();

        first.drop();
        await().until(() -> !first.isOpen());
        Thread.sleep(200);
        assertThat(service.connections).hasSize(1);

        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(service.connections).hasSize(2);
    }

    @Test
    void itBacksOffWhileASubscriptionWaitsAndItsNotThere() throws Exception {
        rig = new NotebookRig(dir, socket());
        TestClient client = rig.connect("a");
        client.subscribe("notebook.tree", null);
        Thread.sleep(400);

        service = new FakeNotebookSocket(socket());

        // At most the longest gap, 100 ms here, as a try comes that often.
        await().atMost(Duration.ofMillis(1500)).until(() -> service.connections.size() == 1);
        assertThat(rig.nextEvent(client)).containsEntry("type", "snapshot");
    }

    // ---- stalled

    /** A stalled peer fails its own link, with what's waiting on it, while the other session carries on. */
    @Test
    void aStalledWriteFailsOnlyThisLink() throws Exception {
        withService();
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient stuck = rig.connect("stuck");
        TestClient other = rig.connect("other");
        rig.sendCollab(stuck, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        rig.call(other, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection stuckConnection = service.connections.get(0);
        FakeNotebookSocket.Connection otherConnection = service.connections.get(1);
        stuckConnection.stall();

        long started = System.nanoTime();
        rig.sendCollab(stuck, new byte[MIB_4]);
        await().until(() -> rig.module.writingForTest("stuck"));
        String idem = UUID.randomUUID().toString();
        long mutation = rig.send(stuck, "notebook.page.trash", Map.of("pageId", "p1"), idem);
        long read = rig.send(stuck, "notebook.tree", Map.of(), null);

        // Nothing here waits on the stall, before the 2 s it takes or after.
        for (int i = 0; i < 20; i++) {
            assertThat(rig.call(other, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        }

        assertThat(rig.nextData(stuck).isReset()).isTrue();
        Map<Long, Map<String, Object>> failed = replies(stuck, 2);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(8));
        // Neither of these went out, behind the message that stalled, so nothing says it may have.
        assertUnavailable(failed.get(mutation));
        assertUnavailable(failed.get(read));
        assertThat(otherConnection.isOpen()).isTrue();
        assertThat(rig.call(other, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(rig.sessions.isLive("stuck")).isTrue();
        assertThat(service.connections.stream().filter(c -> c == otherConnection)).hasSize(1);
    }

    @Test
    void aMutationAlreadyWrittenWhenTheLinkStallsSaysItMayHaveApplied() throws Exception {
        withService();
        TestClient client = rig.connect("a");
        String idem = UUID.randomUUID().toString();
        long id = rig.send(client, "notebook.page.trash", Map.of("pageId", "p1"), idem);
        service.requests.take();
        service.last().stall();

        rig.sendCollab(client, new byte[MIB_4]);

        Map<String, Object> reply = client.nextReply();
        assertThat(reply).containsEntry("_id", id);
        assertMayHaveApplied(reply);
    }

    /** Audit D7: a subscription's link started its backoff again at each connect, so this went four times a second. */
    @Test
    void aDeskNotebookThatAcceptsAndDropsAtOnceIsTriedWithTheBackoff() throws Exception {
        try (com.minimalistalliance.desk.deskd.testing.AcceptAndDrop peer =
                new com.minimalistalliance.desk.deskd.testing.AcceptAndDrop(socket(), 0)) {
            rig = new NotebookRig(dir, socket(), new NotebookModule.Timing(
                    Duration.ofMillis(20), Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofSeconds(2), Duration.ofSeconds(2)));
            TestClient client = rig.connect("a");
            client.subscribe("notebook.tree", null);
            Thread.sleep(1500);
            // 20, 40, 80, 160, 320, 640 ms: about 7 in 1.5 s, where it was one every 20 ms.
            assertThat(peer.accepts.size()).isBetween(2, 14);
        }
    }

    /** The defect in review of AgentLink: stuck calls took all 32 slots, and then every RPC was rate_limited. */
    @Test
    void callsStuckOnItCantFillTheSessionsSlots() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket(), new NotebookModule.Timing(
                Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofSeconds(60), Duration.ofSeconds(60), Duration.ofSeconds(60)));
        rig.dispatcher.register("test.ping", (context, params) -> Map.of("pong", true));
        TestClient client = rig.connect("a");
        rig.send(client, "notebook.tree", Map.of(), null);
        service.requests.poll(5, TimeUnit.SECONDS);
        service.stallAll();

        for (int i = 0; i < 39; i++) {
            rig.send(client, "notebook.search", Map.of("query", "x"), null);
        }

        // 16 are out at most, so the rest are refused at once, and those are all the replies there are for a while. In a
        // burst this fast, some of them don't get as far as the relay: RpcSession counts a call till its thread has ended.
        for (int i = 0; i < 40 - NotebookLink.MAX_CALLS; i++) {
            assertThat(client.nextReply()).containsEntry("_kind", "ERR").extracting("code").isIn("unavailable", "rate_limited");
        }
        for (int i = 0; i < 40; i++) {
            Map<String, Object> pong = client.call("test.ping", Map.of());
            assertThat(pong).containsEntry("_kind", "RES").containsEntry("pong", true);
        }
        assertThat(rig.sessions.isLive("a")).isTrue();
    }

    @Test
    void aMutationPastTheLimitIsRefusedWithNoFlagAndNotKept() throws Exception {
        withService();
        TestClient client = rig.connect("a");
        for (int i = 0; i < NotebookLink.MAX_CALLS; i++) {
            rig.send(client, "notebook.search", Map.of("query", "x"), null);
        }
        for (int i = 0; i < NotebookLink.MAX_CALLS; i++) {
            service.requests.poll(5, TimeUnit.SECONDS);
        }
        String idem = UUID.randomUUID().toString();

        assertUnavailable(rig.call(client, "notebook.page.trash", Map.of("pageId", "p1"), idem));

        assertThat(service.last().received).noneMatch(m -> "notebook.page.trash".equals(m.get("m")));
    }

    @Test
    void aCallCancelledWhileItWaitsBehindAStallNeverGoesOut() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket(), new NotebookModule.Timing(
                Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofSeconds(20), Duration.ofSeconds(60), Duration.ofSeconds(60)));
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        FakeNotebookSocket.Connection connection = service.last();
        connection.stall();
        service.handlers.put("notebook.settings.set", p -> Map.of());
        rig.sendCollab(client, new byte[MIB_4]);
        await().until(() -> rig.module.writingForTest("a"));

        long read = rig.send(client, "notebook.search", Map.of("query", "x"), null);
        long mutation = rig.send(client, "notebook.page.trash", Map.of("pageId", "p1"), UUID.randomUUID().toString());
        Thread.sleep(50);
        client.send(Channels.RPC, FrameKind.CANCEL, read, 0, new byte[0]);
        client.send(Channels.RPC, FrameKind.CANCEL, mutation, 0, new byte[0]);
        assertThat(replies(client, 2).values()).allSatisfy(reply -> assertThat(reply).containsEntry("code", "cancelled"));

        connection.resume();

        assertThat(service.collabReceived.poll(20, TimeUnit.SECONDS)).hasSize(MIB_4);
        rig.call(client, "notebook.settings.set", Map.of("timeZone", "UTC"), UUID.randomUUID().toString());
        assertThat(connection.received).noneMatch(m -> "req".equals(m.get("t")) && !"notebook.settings.set".equals(m.get("m")));
        assertThat(connection.received).noneMatch(m -> "cancel".equals(m.get("t")));
    }

    /** The other defect: an interrupt on a thread doing socket I/O closes the channel for everyone on it. */
    @Test
    void cancelsAndDeadlinesNeverTouchTheConnection() throws Exception {
        withService();
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        for (int i = 0; i < 100; i++) {
            long id = rig.send(client, "notebook.search", Map.of("query", "x"), null);
            if (i % 2 == 0) {
                client.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);
            } else {
                rig.send(client, "notebook.activity", Map.of(), null, 1L);
            }
        }
        // A few long frames going at once, so a write is usually under way.
        for (int i = 0; i < 10; i++) {
            long id = rig.send(client, "notebook.search", Map.of("query", "x".repeat(100_000)), null);
            rig.sendCollab(client, new byte[1 << 20]);
            client.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);
        }

        await().until(() -> service.requests.stream().count() >= 1);
        assertThat(service.connections).hasSize(1);
        assertThat(service.last().isOpen()).isTrue();
    }

    @Test
    void closeNeverWaitsOnAStalledPeer() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket(), new NotebookModule.Timing(
                Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofSeconds(30), Duration.ofSeconds(30), Duration.ofSeconds(30)));
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        service.stallAll();
        Thread sender = Thread.ofVirtual().start(() -> rig.sendCollab(client, new byte[MIB_4]));
        sender.join(Duration.ofSeconds(10));
        Thread.sleep(50);
        FakeNotebookSocket.Connection connection = service.last();

        long started = System.nanoTime();
        rig.sessions.stop(false);
        rig.module.close();
        long took = System.nanoTime() - started;

        assertThat(Duration.ofNanos(took)).isLessThan(Duration.ofSeconds(2));
        assertThat(rig.module.linkCount()).isZero();
        service.resumeAll();
        await().until(() -> !connection.isOpen());
    }

    /** It mustn't queue for a client that isn't reading, or stop desk-notebook for ever waiting on one. */
    @Test
    void aClientThatStopsReadingCollabLosesOnlyItsLink() throws Exception {
        withService();
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient deaf = rig.connect("deaf");
        TestClient other = rig.connect("other");
        rig.sendCollab(deaf, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        rig.call(other, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection deafConnection = service.connections.get(0);
        FakeNotebookSocket.Connection otherConnection = service.connections.get(1);
        // desk-rtc stops granting credit for what deskd sends.
        rig.rtcFake.autoCredit(false);

        Thread flood = Thread.ofVirtual().start(() -> {
            for (int i = 0; i < 12 && deafConnection.isOpen(); i++) {
                deafConnection.sendCollab(new byte[1 << 20]);
            }
        });

        await().atMost(Duration.ofSeconds(15)).until(() -> !deafConnection.isOpen());
        flood.join(Duration.ofSeconds(5));
        assertThat(otherConnection.isOpen()).isTrue();
        assertThat(rig.call(other, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(rig.sessions.isLive("deaf")).isTrue();
    }

    /** With the reader waiting on a client that isn't reading, it's still the stall that ends the link, in its own time. */
    @Test
    void aStallEndsTheLinkWhileItsReaderWaitsOnTheClient() throws Exception {
        service = new FakeNotebookSocket(socket());
        rig = new NotebookRig(dir, socket(), new NotebookModule.Timing(
                Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofSeconds(60), Duration.ofMillis(300), Duration.ofSeconds(60)));
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        FakeNotebookSocket.Connection connection = service.last();
        rig.rtcFake.autoCredit(false);
        Thread flood = Thread.ofVirtual().start(() -> {
            for (int i = 0; i < 8 && connection.isOpen(); i++) {
                connection.sendCollab(new byte[1 << 20]);
            }
        });
        // Past what CollabOut takes, so the link's reader is waiting with the socket unread.
        Thread.sleep(300);

        connection.stall();
        rig.sendCollab(client, new byte[MIB_4]);

        // The 60 s it could wait for the client is nothing to do with it. Stalled, the fake won't see the close itself.
        await().atMost(Duration.ofSeconds(10)).until(() -> "waiting".equals(rig.module.health().get("notebook")));
        flood.join(Duration.ofSeconds(5));
    }

    // ---- the log

    @Test
    void noPayloadReachesTheLogOnAnyPath(CapturedOutput output) throws Exception {
        withService();
        service.tree = Map.of("rev", 1, "note", MARKER);
        service.handlers.put("notebook.search", p -> Map.of("hits", List.of(Map.of("text", MARKER))));
        service.handlers.put("notebook.notebook.rename", p -> new FakeNotebookSocket.Refusal("bad_request", Map.of("reason", MARKER)));
        service.handlers.put("notebook.page.content", p -> new FakeNotebookSocket.Refusal(MARKER, Map.of("reason", MARKER)));
        TestClient client = rig.connect("a");
        byte[] text = MARKER.getBytes(java.nio.charset.StandardCharsets.UTF_8);

        client.subscribe("notebook.tree", null);
        rig.nextEvent(client);
        rig.call(client, "notebook.search", Map.of("query", MARKER));
        rig.call(client, "notebook.notebook.rename", Map.of("id", "n1", "title", MARKER));
        rig.call(client, "notebook.page.content", Map.of("pageId", MARKER));
        rig.sendCollab(client, text);
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isEqualTo(text);
        service.last().sendCollab(text);
        rig.nextData(client);

        // A reply that can't be read, one too long, a frame over its limit, a stall, and it going away.
        service.last().sendRaw(1 + text.length, (byte) 0x01, text);
        assertThat(rig.nextData(client).isReset()).isTrue();
        rig.sendCollab(client, text);
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isEqualTo(text);
        service.last().sendCollab(new byte[MIB_4 + 1]);
        assertThat(rig.nextData(client).isReset()).isTrue();
        rig.sendCollab(client, text);
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isEqualTo(text);
        service.last().stall();
        rig.sendCollab(client, new byte[MIB_4]);
        assertThat(rig.nextData(client).isReset()).isTrue();
        rig.call(client, "notebook.search", Map.of("query", MARKER));
        client.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));

        assertThat(output.getAll()).doesNotContain(MARKER);
    }

    @Test
    void aMissingServiceIsOneLineAndItsReturnAnother(CapturedOutput output) throws Exception {
        rig = new NotebookRig(dir, socket());
        TestClient client = rig.connect("a");
        client.subscribe("notebook.tree", null);
        Thread.sleep(300);
        assertThat(output.getAll().lines().filter(line -> line.contains("waiting for desk-notebook"))).hasSize(1);

        service = new FakeNotebookSocket(socket());
        rig.nextEvent(client);

        assertThat(output.getAll().lines().filter(line -> line.contains("desk-notebook is back"))).hasSize(1);
    }
}
