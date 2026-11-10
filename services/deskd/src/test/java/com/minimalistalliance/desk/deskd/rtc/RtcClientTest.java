package com.minimalistalliance.desk.deskd.rtc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

@ExtendWith(OutputCaptureExtension.class)
class RtcClientTest {

    private static final int FRAME_BYTES = Frame.MAX_FRAME_BYTES;

    @TempDir
    Path dir;

    private FakeDeskRtc fake;
    private RtcClient client;
    private final Recorder recorder = new Recorder();

    @AfterEach
    void tearDown() throws Exception {
        if (client != null) {
            client.close();
        }
        if (fake != null) {
            fake.close();
        }
    }

    private static final class Recorder implements RtcListener {
        final List<byte[]> data = new CopyOnWriteArrayList<>();
        final List<String> closed = new CopyOnWriteArrayList<>();
        final List<String> states = new CopyOnWriteArrayList<>();
        final List<Object> activity = new CopyOnWriteArrayList<>();
        final AtomicInteger configured = new AtomicInteger();
        final AtomicInteger disconnected = new AtomicInteger();
        final AtomicInteger overruns = new AtomicInteger();
        final AtomicLong drainedCalls = new AtomicLong();
        volatile boolean refuseBinding;

        @Override
        public void onRtcConfigured() {
            configured.incrementAndGet();
        }

        @Override
        public void onRtcDisconnected() {
            disconnected.incrementAndGet();
        }

        @Override
        public boolean onSessionBound(String sessionId, long handle) {
            return !refuseBinding;
        }

        @Override
        public void onSessionState(String sessionId, String state, String transport) {
            states.add(sessionId + "/" + state + "/" + transport);
        }

        @Override
        public void onSessionClosed(String sessionId, String reason) {
            closed.add(sessionId + "/" + reason);
        }

        @Override
        public void onInputActivity(String sessionId, Object at) {
            activity.add(at);
        }

        @Override
        public void onData(long handle, int channel, byte[] frame) {
            data.add(frame);
        }

        @Override
        public void onCreditOverrun(long handle, int channel) {
            overruns.incrementAndGet();
        }

        @Override
        public void onChannelDrained(long handle, int channel) {
            drainedCalls.incrementAndGet();
        }
    }

    private void start() throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        client = new RtcClient(new RtcClient.Config(socket, 4, () -> "203.0.113.7"));
        client.start(recorder);
        await().until(client::isConfigured);
    }

    private long createSession(String id) throws Exception {
        return client.createSession(id, "offer", "ab".repeat(32), true, false).handle();
    }

    private static long wire(long handle) {
        return handle & 0xFFFFFFFFL;
    }

    private static byte[] frameOf(int bytes) {
        return new Frame(FrameKind.DATA, Frame.BIN, 1, 0, new byte[bytes - Frame.HEADER_BYTES]).encode();
    }

    @Test
    void configureGoesFirstAndCarriesTheFacts() throws Exception {
        start();
        Map<String, Object> configure = fake.awaitJson("configure");
        assertThat(configure).containsEntry("publicIpv4", "203.0.113.7").containsEntry("maxSessions", 4);
        assertThat(client.rtcVersion()).isEqualTo("fake-rtc-1");
        assertThat(client.fingerprints()).containsExactly("cd".repeat(32));
        assertThat(client.fingerprintsNotAfter()).isEqualTo("2027-01-01T00:00:00Z");
        await().untilAtomic(recorder.configured, equalTo(1));
    }

    @Test
    void reconfigureSendsConfigureAgain() throws Exception {
        start();
        fake.awaitJson("configure");
        client.reconfigure();
        assertThat(fake.awaitJson("configure")).containsEntry("publicIpv4", "203.0.113.7");
    }

    @Test
    void notConfiguredRefusesSessions() throws Exception {
        Path socket = dir.resolve("rtc.sock");
        fake = new FakeDeskRtc(socket);
        fake.autoConfigure(false);
        client = new RtcClient(new RtcClient.Config(socket, 4, () -> null));
        client.start(recorder);
        fake.awaitJson("configure");
        assertThat(client.isConfigured()).isFalse();
        assertThatThrownBy(() -> createSession("cs-1"))
                .isInstanceOfSatisfying(RtcException.class, e -> assertThat(e.code()).isEqualTo("not_configured"));
    }

    @Test
    void aMissingSocketIsRetriedAndLoggedAtMostOnceAMinute(CapturedOutput output) throws Exception {
        Path socket = dir.resolve("late.sock");
        client = new RtcClient(new RtcClient.Config(socket, 4, () -> "203.0.113.7"));
        client.start(recorder);
        assertThat(client.isLoopAlive()).isTrue();
        assertThatThrownBy(() -> createSession("cs-1"))
                .isInstanceOfSatisfying(RtcException.class, e -> assertThat(e.code()).isEqualTo("unavailable"));

        // Long enough for several attempts at the 0.2 s, 0.4 s and 0.8 s backoff.
        Thread.sleep(1_000);
        assertThat(output.getOut().lines().filter(line -> line.contains("rtc socket not available")))
                .hasSize(1);
        assertThat(client.isLoopAlive()).isTrue();

        fake = new FakeDeskRtc(socket);
        await().atMost(Duration.ofSeconds(8)).until(client::isConfigured);
    }

    @Test
    void createSessionReturnsTheAnswerAndSendsWhatTheSpecSays() throws Exception {
        start();
        RtcClient.Answer answer = client.createSession("cs-1", "the offer", "ab".repeat(32), true, false);
        assertThat(answer.answer()).isEqualTo("v=0 answer for test");
        Map<String, Object> create = fake.awaitJson("session.create");
        assertThat(create)
                .containsEntry("sessionId", "cs-1")
                .containsEntry("offer", "the offer")
                .containsEntry("expectedFingerprint", "ab".repeat(32))
                .containsEntry("permissions", Map.of("video", true, "input", false));
    }

    @Test
    void sessionErrorBecomesAnException() throws Exception {
        start();
        fake.autoAnswer(false);
        CompletableFuture<String> code = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                createSession("cs-1");
                code.complete("none");
            } catch (RtcException e) {
                code.complete(e.code());
            } catch (Exception e) {
                code.completeExceptionally(e);
            }
        });
        fake.awaitJson("session.create");
        fake.sendJson(Map.of("t", "session.error", "sessionId", "cs-1", "code", "identity_mismatch", "message", "no"));
        assertThat(code.get(5, TimeUnit.SECONDS)).isEqualTo("identity_mismatch");
    }

    @Test
    void iceRestartPermissionsAndCloseGoOutAsSpecified() throws Exception {
        start();
        createSession("cs-1");
        assertThat(client.iceRestart("cs-1", "second offer").answer()).isEqualTo("v=0 answer for test");
        assertThat(fake.awaitJson("session.ice_restart")).containsEntry("offer", "second offer");

        client.setPermissions("cs-1", false, true);
        assertThat(fake.awaitJson("session.permissions"))
                .containsEntry("sessionId", "cs-1")
                .containsEntry("video", false)
                .containsEntry("input", true);

        client.closeSession("cs-1", 4401, "token_expired");
        assertThat(fake.awaitJson("session.close"))
                .containsEntry("sessionId", "cs-1")
                .containsEntry("code", 4401)
                .containsEntry("reason", "token_expired");
        await().until(() -> recorder.closed.contains("cs-1/closed"));
    }

    @Test
    void statsAreParsed() throws Exception {
        start();
        CompletableFuture<RtcStats> stats = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                stats.complete(client.stats());
            } catch (Exception e) {
                stats.completeExceptionally(e);
            }
        });
        fake.awaitJson("stats.get");
        fake.sendJson(Map.of(
                "t", "stats",
                "sessions", List.of(Map.of("sessionId", "cs-1", "transport", "udp", "rttMs", 12, "bytesSent", 99, "bytesReceived", 88)),
                "bytesSent", 1000,
                "bytesReceived", 2000,
                "peerBytesSent", 7));
        RtcStats result = stats.get(5, TimeUnit.SECONDS);
        assertThat(result.bytesSent()).isEqualTo(1000);
        assertThat(result.bytesReceived()).isEqualTo(2000);
        assertThat(result.peerBytesSent()).isEqualTo(7);
        assertThat(result.sessions()).containsExactly(new RtcStats.SessionStats("cs-1", "udp", 12.0, 99, 88, false, 0));
    }

    @Test
    void statsCarryWhatDeskRtcSaysAboutTheStream() throws Exception {
        start();
        CompletableFuture<RtcStats> stats = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                stats.complete(client.stats());
            } catch (Exception e) {
                stats.completeExceptionally(e);
            }
        });
        fake.awaitJson("stats.get");
        fake.sendJson(Map.of(
                "t", "stats",
                "sessions", List.of(Map.of(
                        "sessionId", "cs-1", "transport", "udp", "rttMs", 12, "bytesSent", 1, "bytesReceived", 2,
                        "viewing", true, "rtpDropped", 3)),
                "bytesSent", 0,
                "bytesReceived", 0,
                "peerBytesSent", 0,
                "stream", Map.of(
                        "state", "live", "viewers", 1, "videoPackets", 10, "videoBytes", 20, "audioPackets", 30,
                        "keyframeRequests", 4)));
        RtcStats result = stats.get(5, TimeUnit.SECONDS);
        assertThat(result.stream()).isEqualTo(new RtcStats.StreamStats("live", 1, 10, 20, 30, 4));
        assertThat(result.sessions()).containsExactly(new RtcStats.SessionStats("cs-1", "udp", 12.0, 1, 2, true, 3));
    }

    @Test
    void streamStateIsKeptWhileTheSocketIsUpAndOddValuesAreIgnored() throws Exception {
        start();
        assertThat(client.streamState()).isNull();
        fake.sendJson(Map.of("t", "stream.state", "state", "warm"));
        await().until(() -> "warm".equals(client.streamState()));
        fake.sendJson(Map.of("t", "stream.state", "state", "no such state"));
        fake.sendJson(Map.of("t", "stream.state", "state", "live"));
        await().until(() -> "live".equals(client.streamState()));
        fake.drop();
        await().until(() -> client.streamState() == null);
    }

    @Test
    void setVideoSendsSessionVideo() throws Exception {
        start();
        client.setVideo("cs-1", true);
        assertThat(fake.awaitJson("session.video"))
                .containsEntry("sessionId", "cs-1")
                .containsEntry("view", true);
        client.setVideo("cs-1", false);
        assertThat(fake.awaitJson("session.video")).containsEntry("view", false);
    }

    @Test
    void unpromptedMessagesReachTheListener() throws Exception {
        start();
        fake.sendJson(Map.of("t", "session.state", "sessionId", "cs-1", "state", "connected", "transport", "tcp"));
        fake.sendJson(Map.of("t", "input.activity", "sessionId", "cs-1", "at", "2026-11-05T04:46:20Z"));
        fake.sendJson(Map.of("t", "session.closed", "sessionId", "cs-1", "reason", "consent_timeout"));
        await().until(() -> recorder.closed.contains("cs-1/consent_timeout"));
        assertThat(recorder.states).containsExactly("cs-1/connected/tcp");
        assertThat(recorder.activity).containsExactly("2026-11-05T04:46:20Z");
    }

    @Test
    void unknownMessagesAndEnvelopesAreIgnored() throws Exception {
        start();
        fake.sendJson(Map.of("t", "something.new", "extra", 1));
        fake.sendJson(Map.of("t", "error", "code", "bad_request"));
        fake.sendRaw(new byte[] {0, 0, 0, 2, 0x7F, 0});
        fake.sendRaw(new byte[] {0, 0, 0, 2, 0x01, '{'});
        long handle = createSession("cs-1");
        assertThat(wire(handle)).isEqualTo(1);
        assertThat(client.isConfigured()).isTrue();
        assertThat(recorder.disconnected).hasValue(0);
    }

    @Test
    void anEnvelopeOver64KibDropsTheConnection() throws Exception {
        start();
        assertThat(fake.connectionCount()).isEqualTo(1);
        ByteBuffer bad = ByteBuffer.allocate(5);
        bad.putInt(64 * 1024 + 1);
        bad.put((byte) 1);
        fake.sendRaw(bad.array());
        await().untilAtomic(recorder.disconnected, equalTo(1));
        await().until(() -> fake.connectionCount() == 2 && client.isConfigured());
    }

    @Test
    void framesOutStopAtTheInitialCreditAndResumeWhenGranted() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");
        List<byte[]> frames = new ArrayList<>();
        int total = (int) (RtcClient.INITIAL_CREDIT / FRAME_BYTES) + 4;
        for (int i = 0; i < total; i++) {
            frames.add(frameOf(FRAME_BYTES));
        }
        assertThat(client.offer(handle, Channels.BULK, frames)).isTrue();

        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == RtcClient.INITIAL_CREDIT);
        Thread.sleep(100);
        assertThat(fake.bytesFromDeskd(wire(handle), Channels.BULK)).isEqualTo(RtcClient.INITIAL_CREDIT);
        assertThat(client.queuedBytes(handle, Channels.BULK)).isEqualTo(4L * FRAME_BYTES);

        fake.sendCredit(wire(handle), Channels.BULK, 2L * FRAME_BYTES);
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == RtcClient.INITIAL_CREDIT + 2L * FRAME_BYTES);
        assertThat(client.queuedBytes(handle, Channels.BULK)).isEqualTo(2L * FRAME_BYTES);
    }

    @Test
    void uploadCreditStaysInsideTheSpecsCap() {
        assertThat(RtcClient.INITIAL_CREDIT * Channels.COUNT).isLessThanOrEqualTo(2L * 1024 * 1024);
        assertThat(RtcClient.GRANT_THRESHOLD).isGreaterThanOrEqualTo(32L * 1024);
    }

    @Test
    void aFrameNeverGoesOutOnPartialCredit() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");
        int fit = (int) (RtcClient.INITIAL_CREDIT / FRAME_BYTES);
        List<byte[]> frames = new ArrayList<>();
        for (int i = 0; i < fit; i++) {
            frames.add(frameOf(FRAME_BYTES));
        }
        client.offer(handle, Channels.BULK, frames);
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == fit * (long) FRAME_BYTES);

        client.offer(handle, Channels.BULK, List.of(frameOf(1024)));
        fake.sendCredit(wire(handle), Channels.BULK, 1023);
        Thread.sleep(100);
        assertThat(fake.bytesFromDeskd(wire(handle), Channels.BULK)).isEqualTo(fit * (long) FRAME_BYTES);

        fake.sendCredit(wire(handle), Channels.BULK, 1);
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == fit * (long) FRAME_BYTES + 1024);
    }

    @Test
    void aBlockedBulkChannelDoesntHoldUpCtl() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");

        // More bulk than the credit and the queue limit together, so its sender parks.
        int frames = (int) ((RtcClient.INITIAL_CREDIT + RtcClient.QUEUE_LIMIT) / FRAME_BYTES) + 8;
        Thread bulkSender = Thread.ofVirtual().start(() -> {
            try {
                for (int i = 0; i < frames; i++) {
                    client.send(handle, Channels.BULK, frameOf(FRAME_BYTES));
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (RtcHandleGoneException e) {
                throw new IllegalStateException(e);
            }
        });
        await().until(() -> client.queuedBytes(handle, Channels.BULK) >= RtcClient.QUEUE_LIMIT);
        await().until(() -> bulkSender.getState() == Thread.State.WAITING);

        // ctl, and JSON control, still go straight through.
        byte[] ping = new Frame(FrameKind.PONG, 0, 42, 0, new byte[0]).encode();
        client.send(handle, Channels.CTL, ping);
        assertThat(fake.awaitFrame(wire(handle), Channels.CTL).id()).isEqualTo(42);
        client.setPermissions("cs-1", true, true);
        fake.awaitJson("session.permissions");
        assertThat(bulkSender.isAlive()).isTrue();

        // And the bulk sender finishes once credit comes.
        fake.autoCredit(true);
        fake.sendCredit(wire(handle), Channels.BULK, 4L * 1024 * 1024);
        bulkSender.join(Duration.ofSeconds(10));
        assertThat(bulkSender.isAlive()).isFalse();
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == frames * (long) FRAME_BYTES);
    }

    @Test
    void creditOnOneSessionDoesntAffectAnother() throws Exception {
        start();
        fake.autoCredit(false);
        long first = createSession("cs-1");
        long second = createSession("cs-2");
        int fit = (int) (RtcClient.INITIAL_CREDIT / FRAME_BYTES);
        List<byte[]> frames = new ArrayList<>();
        for (int i = 0; i < fit + 2; i++) {
            frames.add(frameOf(FRAME_BYTES));
        }
        client.offer(first, Channels.BULK, frames);
        await().until(() -> client.queuedBytes(first, Channels.BULK) == 2L * FRAME_BYTES);

        client.offer(second, Channels.BULK, List.of(frameOf(1000)));
        await().until(() -> fake.bytesFromDeskd(wire(second), Channels.BULK) == 1000);
    }

    @Test
    void higherPriorityFramesGoFirstWhenTheyAreBothWaiting() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");
        // Fill bulk's credit so frames for it wait.
        int fit = (int) (RtcClient.INITIAL_CREDIT / FRAME_BYTES);
        List<byte[]> filler = new ArrayList<>();
        for (int i = 0; i < fit; i++) {
            filler.add(frameOf(FRAME_BYTES));
        }
        client.offer(handle, Channels.BULK, filler);
        await().until(() -> fake.bytesFromDeskd(wire(handle), Channels.BULK) == fit * (long) FRAME_BYTES);

        // Now both wait in deskd; nothing on bulk can pass until credit comes.
        client.offer(handle, Channels.BULK, List.of(new Frame(FrameKind.DATA, Frame.BIN, 7, 0, new byte[1]).encode()));
        client.offer(handle, Channels.RPC, List.of(new Frame(FrameKind.RES, 0, 8, 0, new byte[1]).encode()));
        assertThat(fake.awaitFrame(wire(handle), Channels.RPC).id()).isEqualTo(8);
    }

    @Test
    void creditIsGrantedAsFramesDrainNotAsTheyArrive() throws Exception {
        start();
        long handle = createSession("cs-1");
        byte[] frame = frameOf(FRAME_BYTES);
        int frames = (int) (RtcClient.GRANT_THRESHOLD / FRAME_BYTES);
        for (int i = 0; i < frames; i++) {
            fake.sendData(wire(handle), Channels.BULK, frame);
        }
        await().until(() -> recorder.data.size() == frames);
        Thread.sleep(50);
        assertThat(fake.creditFromDeskd(wire(handle), Channels.BULK)).isZero();

        for (int i = 0; i < frames; i++) {
            client.consumed(handle, Channels.BULK, frame.length);
        }
        await().until(() -> fake.creditFromDeskd(wire(handle), Channels.BULK) == frames * (long) FRAME_BYTES);
    }

    @Test
    void aPeerThatOverrunsItsCreditIsReported() throws Exception {
        start();
        long handle = createSession("cs-1");
        byte[] frame = frameOf(FRAME_BYTES);
        int fit = (int) (RtcClient.INITIAL_CREDIT / FRAME_BYTES);
        for (int i = 0; i < fit; i++) {
            fake.sendData(wire(handle), Channels.RPC, frame);
        }
        await().until(() -> recorder.data.size() == fit);
        assertThat(recorder.overruns).hasValue(0);

        fake.sendDataIgnoringCredit(wire(handle), Channels.RPC, frame);
        await().untilAtomic(recorder.overruns, equalTo(1));
        assertThat(recorder.data).hasSize(fit);
    }

    @Test
    void frameForAChannelDeskdDoesntServeIsDropped() throws Exception {
        start();
        long handle = createSession("cs-1");
        fake.sendData(wire(handle), 6, frameOf(100));
        fake.sendData(wire(handle), Channels.CTL, frameOf(100));
        await().until(() -> recorder.data.size() == 1);
    }

    @Test
    void aDroppedSocketEndsEverythingAndReconnectsAndConfiguresAgain() throws Exception {
        start();
        long handle = createSession("cs-1");
        fake.awaitJson("configure");
        fake.autoAnswer(false);
        CompletableFuture<String> pending = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                createSession("cs-2");
                pending.complete("answered");
            } catch (RtcException e) {
                pending.complete(e.code());
            } catch (Exception e) {
                pending.completeExceptionally(e);
            }
        });
        fake.awaitJson("session.create");

        fake.drop();
        await().untilAtomic(recorder.disconnected, equalTo(1));
        assertThat(pending.get(5, TimeUnit.SECONDS)).isEqualTo("unavailable");
        assertThatThrownBy(() -> client.send(handle, Channels.RPC, frameOf(100)))
                .isInstanceOf(RtcHandleGoneException.class);

        // Reconnects by itself, and configures again before anything else.
        fake.autoAnswer(true);
        await().until(() -> fake.connectionCount() == 2 && client.isConfigured());
        assertThat(fake.awaitJson("configure")).containsEntry("publicIpv4", "203.0.113.7");
        await().untilAtomic(recorder.configured, equalTo(2));

        // A handle from before the drop can't reach a new session that got the same wire number.
        fake.autoCredit(true);
        long newHandle = createSession("cs-3");
        assertThat(client.offer(handle, Channels.RPC, List.of(frameOf(100)))).isFalse();
        assertThat(client.offer(newHandle, Channels.RPC, List.of(frameOf(100)))).isTrue();
    }

    @Test
    void aSenderParkedOnCreditWakesWhenTheSocketDrops() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");
        CompletableFuture<String> outcome = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> {
            try {
                while (true) {
                    client.send(handle, Channels.BULK, frameOf(FRAME_BYTES));
                }
            } catch (RtcHandleGoneException e) {
                outcome.complete("gone");
            } catch (InterruptedException e) {
                outcome.completeExceptionally(e);
            }
        });
        await().until(() -> client.queuedBytes(handle, Channels.BULK) >= RtcClient.QUEUE_LIMIT);
        fake.drop();
        assertThat(outcome.get(5, TimeUnit.SECONDS)).isEqualTo("gone");
    }

    /**
     * Regression: the limit was per message and the client picks the ids, so replies with new ids
     * never parked, and a client that stopped reading could fill the heap.
     */
    @Test
    void newIdsDontGetPastTheLimitOnAChannelsQueue() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");
        ParkingSender sender = ParkingSender.start(client, handle, Channels.CTL, 16 * 1024, 2000);
        await().until(() -> client.queuedBytes(handle, Channels.CTL) >= RtcClient.CHANNEL_QUEUE_LIMIT);
        sender.awaitParked();
        assertThat(client.queuedBytes(handle, Channels.CTL)).isLessThanOrEqualTo(RtcClient.CHANNEL_QUEUE_LIMIT);

        // Credit lets it go on: it parked, it didn't give up.
        long sent = sender.sent.get();
        fake.sendCredit(wire(handle), Channels.CTL, 1024 * 1024);
        await().until(() -> sender.sent.get() > sent);
    }

    /** Small frames count as more than their bytes: each message has a queue of its own to keep. */
    @Test
    void newIdsDontGetPastTheMessageLimitEither() throws Exception {
        start();
        fake.autoCredit(false);
        long handle = createSession("cs-1");
        // The first 256 KiB goes out on the starting credit, and 40-byte frames then fill the queue.
        ParkingSender sender = ParkingSender.start(client, handle, Channels.RPC, 40, 100_000);
        sender.awaitParked();
        assertThat(client.queuedBytes(handle, Channels.RPC))
                .isLessThanOrEqualTo(RtcClient.CHANNEL_QUEUE_MESSAGES * 40L);
    }

    @Test
    void aSessionsCallsCanQueueTheirLongRepliesWithoutFillingTheChannel() {
        assertThat(RtcClient.CHANNEL_QUEUE_LIMIT)
                .isGreaterThan(RpcDispatcher.Limits.DEFAULT.maxConcurrentRequests() * (RtcClient.QUEUE_LIMIT + FRAME_BYTES));
    }

    /** Sends frames with a new id each, as a flood of replies to a client's new ids would be. */
    private static final class ParkingSender {
        final AtomicLong sent = new AtomicLong();
        final Thread thread;
        final int count;

        private ParkingSender(RtcClient client, long handle, int channel, int frameBytes, int count) {
            this.count = count;
            byte[] payload = new byte[frameBytes - Frame.HEADER_BYTES];
            thread = Thread.ofVirtual().start(() -> {
                try {
                    for (int id = 1; id <= count; id++) {
                        client.send(handle, channel, new Frame(FrameKind.RES, 0, id, 0, payload).encode());
                        sent.incrementAndGet();
                    }
                } catch (RtcHandleGoneException | InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }

        static ParkingSender start(RtcClient client, long handle, int channel, int frameBytes, int count) {
            return new ParkingSender(client, handle, channel, frameBytes, count);
        }

        /** Until it has stopped getting anywhere, short of the end. */
        void awaitParked() throws InterruptedException {
            long seen = -1;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (sent.get() != seen && System.nanoTime() < deadline) {
                seen = sent.get();
                Thread.sleep(200);
            }
            assertThat(sent.get()).as("frames queued before the sender parked").isLessThan(count);
            assertThat(thread.isAlive()).isTrue();
        }
    }

    /**
     * Regression: an answer made a handle before anyone asked whether the session existed, and only
     * a session.closed removed it, so a hostile peer could grow the table without limit.
     */
    @Test
    void anAnswerNobodyWantedLeavesNoHandleBehind() throws Exception {
        start();
        recorder.refuseBinding = true;
        fake.autoClosed(false);
        long handle = createSession("cs-1");
        assertThat(fake.awaitJson("session.close")).containsEntry("sessionId", "cs-1");
        assertThat(client.offer(handle, Channels.CTL, List.of(frameOf(100)))).isFalse();
    }

    @Test
    void anAnswerNamingAnotherSessionsHandleLeavesItWithItsOwner() throws Exception {
        start();
        long handle = createSession("cs-1");
        fake.autoClosed(false);
        fake.sendJson(Map.of("t", "session.answer", "sessionId", "cs-2", "handle", wire(handle), "answer", "x"));
        assertThat(fake.awaitJson("session.close")).containsEntry("sessionId", "cs-2");
        assertThat(client.offer(handle, Channels.CTL, List.of(frameOf(100)))).isTrue();
    }

    /** Regression: with answers coming in and the peer not reading, the closes they caused piled up. */
    @Test
    void aPeerThatStopsReadingTheSocketGetsDroppedRatherThanFillingTheHeap() throws Exception {
        Path socket = dir.resolve("mute.sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socket));
            recorder.refuseBinding = true;
            client = new RtcClient(new RtcClient.Config(socket, 4, () -> "203.0.113.7"));
            client.start(recorder);
            try (SocketChannel peer = server.accept()) {
                // Far more closes than the socket's buffers and the limit on the queue can hold.
                for (int i = 0; i < 40_000 && recorder.disconnected.get() == 0; i++) {
                    byte[] body = Json.bytes(Map.of("t", "session.answer", "sessionId", "cs-" + i, "handle", i, "answer", "x"));
                    ByteBuffer out = ByteBuffer.allocate(5 + body.length);
                    out.putInt(1 + body.length).put((byte) 1).put(body).flip();
                    try {
                        while (out.hasRemaining()) {
                            peer.write(out);
                        }
                    } catch (IOException e) {
                        break;
                    }
                }
                await().untilAtomic(recorder.disconnected, greaterThanOrEqualTo(1));
            }
        }
    }

    @Test
    void anAnswerForASessionDeskdNoLongerWantsIsClosed() throws Exception {
        start();
        recorder.refuseBinding = true;
        createSession("cs-1");
        assertThat(fake.awaitJson("session.close")).containsEntry("sessionId", "cs-1");
    }
}
