package com.minimalistalliance.desk.deskd.events;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPeer;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rpc.RpcSession;
import com.minimalistalliance.desk.deskd.rpc.SubscriptionService;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/** SUB and UNSUB go through a real RpcSession, because the reply and first events have an order. */
class SessionEventsTest {

    static {
        TestTiming.pollFast();
    }

    private record Evt(long subId, long seq, String type, Object data) {}

    private static final class FakeSink implements SessionEvents.Sink {
        final List<Evt> sent = new ArrayList<>();
        final AtomicLong queued = new AtomicLong();
        final AtomicLong extraQueued = new AtomicLong();

        @Override
        public synchronized void enqueue(long subId, long seq, byte[] payload) {
            Map<String, Object> body;
            try {
                body = Json.parseObject(payload);
            } catch (JsonFormatException e) {
                throw new IllegalStateException(e);
            }
            sent.add(new Evt(subId, seq, Json.string(body, "type"), body.get("data")));
            queued.addAndGet(payload.length);
        }

        @Override
        public long queuedBytes() {
            return queued.get() + extraQueued.get();
        }

        synchronized List<Evt> events() {
            return new ArrayList<>(sent);
        }

        synchronized List<Evt> take() {
            List<Evt> copy = new ArrayList<>(sent);
            sent.clear();
            return copy;
        }
    }

    private static final class Peer implements RpcPeer {
        final BlockingQueue<Map<String, Object>> replies = new LinkedBlockingQueue<>();
        final SessionEvents events;

        Peer(SessionEvents events) {
            this.events = events;
        }

        @Override
        public boolean ready() {
            return true;
        }

        @Override
        public RpcPrincipal principal() {
            return new RpcPrincipal("user-1", "owner", "cs-1", true, true);
        }

        @Override
        public SubscriptionService subscriptions() {
            return events;
        }

        @Override
        public void send(FrameKind kind, long id, byte[] payload) {
            try {
                Map<String, Object> body = new LinkedHashMap<>(Json.parseObject(payload));
                body.put("_kind", kind.name());
                replies.add(body);
            } catch (JsonFormatException e) {
                throw new IllegalStateException(e);
            }
        }

        @Override
        public void closeRateLimited() {}
    }

    private static class CountingTopic implements Topic {
        final boolean coalescible;
        final AtomicInteger snapshots = new AtomicInteger();
        volatile CountDownLatch gate;

        CountingTopic(boolean coalescible) {
            this.coalescible = coalescible;
        }

        @Override
        public boolean coalescible() {
            return coalescible;
        }

        @Override
        public Object snapshot(String topicKey, Map<String, Object> params) throws Exception {
            int count = snapshots.incrementAndGet();
            if (gate != null) {
                gate.await();
            }
            return Map.of("snapshot", count);
        }
    }

    private final TopicRegistry topics = new TopicRegistry();
    private final EventHub hub = new EventHub(topics);
    private final CountingTopic summary = new CountingTopic(true);
    private final CountingTopic run = new CountingTopic(false);
    private final FakeSink sink = new FakeSink();
    private final SessionEvents events = hub.newSession();
    private final Peer peer = new Peer(events);
    private final RpcSession rpc = new RpcDispatcher().newSession(peer);
    private long nextRequest = 1;

    SessionEventsTest() {
        topics.register("summary", summary);
        topics.register("agent.run:", run);
        events.attach(sink);
    }

    private Map<String, Object> sub(String topic, Long since) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("topic", topic);
        body.put("params", Map.of());
        if (since != null) {
            body.put("since", since);
        }
        rpc.onMessage(new Message(FrameKind.SUB, false, false, nextRequest++, 0, Json.bytes(body)));
        Map<String, Object> reply = peer.replies.poll(5, TimeUnit.SECONDS);
        assertThat(reply).isNotNull();
        return reply;
    }

    private long subscribe(String topic) throws Exception {
        Map<String, Object> reply = sub(topic, null);
        assertThat(reply).containsEntry("_kind", "RES");
        long subId = ((Number) reply.get("subId")).longValue();
        await().until(() -> sink.events().stream().anyMatch(e -> e.subId() == subId && e.type().equals("snapshot")));
        return subId;
    }

    private void publishPatch(String topic, int bytes) {
        hub.publish(topic, "patch", Map.of("padding", "x".repeat(bytes)));
    }

    private void drain() {
        sink.queued.set(0);
        sink.extraQueued.set(0);
        events.onChannelDrained();
    }

    @Test
    void subReturnsSubIdAndSeqThenASnapshotThenEventsInOrder() throws Exception {
        Map<String, Object> reply = sub("summary", null);
        assertThat(reply).containsEntry("_kind", "RES").containsEntry("seq", 0);
        long subId = ((Number) reply.get("subId")).longValue();
        await().until(() -> !sink.events().isEmpty());
        hub.publish("summary", "patch", Map.of("n", 1));
        hub.publish("summary", "patch", Map.of("n", 2));

        await().until(() -> sink.events().size() == 3);
        List<Evt> sent = sink.events();
        assertThat(sent).extracting(Evt::subId).containsOnly(subId);
        assertThat(sent).extracting(Evt::seq).containsExactly(1L, 2L, 3L);
        assertThat(sent).extracting(Evt::type).containsExactly("snapshot", "patch", "patch");
        assertThat(sent.get(0).data()).isEqualTo(Map.of("snapshot", 1));
        assertThat(sent.get(1).data()).isEqualTo(Map.of("n", 1));
    }

    @Test
    void anUnknownTopicIsNotFoundAndBadFieldsAreBadRequest() throws Exception {
        assertThat(sub("no.such.topic", null)).containsEntry("_kind", "ERR").containsEntry("code", "not_found");

        rpc.onMessage(new Message(FrameKind.SUB, false, false, 99, 0, Json.bytes(Map.of("params", Map.of()))));
        assertThat(peer.replies.poll(5, TimeUnit.SECONDS)).containsEntry("code", "bad_request");

        rpc.onMessage(new Message(FrameKind.SUB, false, false, 100, 0, Json.bytes(Map.of("topic", "summary", "since", "x"))));
        assertThat(peer.replies.poll(5, TimeUnit.SECONDS)).containsEntry("code", "bad_request");
    }

    @Test
    void aTopicCanRefuseASubscriber() throws Exception {
        topics.register("private", new CountingTopic(true) {
            @Override
            public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params)
                    throws RpcException {
                throw new RpcException(RpcException.FORBIDDEN, "Not yours");
            }
        });
        assertThat(sub("private", null)).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        assertThat(events.subscriptionCount()).isZero();
    }

    @Test
    void aTopicWithNothingYetSendsNoEventAndItsNextPublishIsTheFirst() throws Exception {
        AtomicInteger snapshots = new AtomicInteger();
        topics.register("waiting", new Topic() {
            @Override
            public boolean coalescible() {
                return true;
            }

            @Override
            public Object snapshot(String topicKey, Map<String, Object> params) {
                snapshots.incrementAndGet();
                return NO_SNAPSHOT;
            }
        });
        Map<String, Object> reply = sub("waiting", null);
        assertThat(reply).containsEntry("_kind", "RES");
        long subId = ((Number) reply.get("subId")).longValue();
        await().until(() -> snapshots.get() == 1);
        // The hold has to be released as well: a publish then goes straight out, and no later one waits.
        await().untilAsserted(() -> {
            hub.publish("waiting", "snapshot", Map.of("tabs", List.of()));
            assertThat(sink.events()).anyMatch(e -> e.subId() == subId && e.type().equals("snapshot"));
        });
        assertThat(sink.events()).noneMatch(e -> e.type().equals("error"));
    }

    /** Records what hasSubscribers says each time it's told, which is how the clipboard keeps desk-rtc's watch. */
    private static final class WatchingTopic extends CountingTopic {
        final List<Boolean> told = new java.util.concurrent.CopyOnWriteArrayList<>();
        final EventHub hub;
        final String name;
        volatile RpcException refusal;

        WatchingTopic(EventHub hub, String name) {
            super(true);
            this.hub = hub;
            this.name = name;
        }

        @Override
        public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
            if (refusal != null) {
                throw refusal;
            }
        }

        @Override
        public void subscribersChanged() {
            told.add(hub.hasSubscribers(name));
        }
    }

    @Test
    void aTopicIsToldWhenItsSubscribersMayHaveChangedOutsideTheLock() throws Exception {
        WatchingTopic watched = new WatchingTopic(hub, "watched");
        topics.register("watched", watched);

        long subId = subscribe("watched");
        assertThat(watched.told).containsExactly(true);
        rpc.onMessage(new Message(FrameKind.UNSUB, false, false, nextRequest++, 0, Json.bytes(Map.of("subId", subId))));
        assertThat(peer.replies.poll(5, TimeUnit.SECONDS)).containsEntry("_kind", "RES");
        assertThat(watched.told).containsExactly(true, false);

        subscribe("watched");
        events.detach();
        assertThat(watched.told).containsExactly(true, false, true, false);
        events.attach(sink);
        subscribe("watched");
        watched.refusal = new RpcException(RpcException.FORBIDDEN, "No");
        events.reauthorize(peer.principal());
        assertThat(watched.told).containsExactly(true, false, true, false, true, false);

        watched.refusal = null;
        subscribe("watched");
        hub.release(events);
        assertThat(watched.told).containsExactly(true, false, true, false, true, false, true, false);
        // A topic nobody had is told nothing.
        assertThat(summary.snapshots).hasValue(0);
    }

    @Test
    void aSubscriberCountsOnlyWhileAttachedAndAsked() throws Exception {
        assertThat(hub.hasSubscribers("summary")).isFalse();
        long subId = subscribe("summary");
        assertThat(hub.hasSubscribers("summary")).isTrue();
        assertThat(hub.hasSubscribers("agent.run:1")).isFalse();

        events.detach();
        assertThat(hub.hasSubscribers("summary")).isFalse();
        events.attach(sink);
        assertThat(hub.hasSubscribers("summary")).isFalse();

        sub("summary", null);
        assertThat(hub.hasSubscribers("summary")).isTrue();
        rpc.onMessage(new Message(FrameKind.UNSUB, false, false, nextRequest++, 0, Json.bytes(Map.of("subId", subId))));
        assertThat(peer.replies.poll(5, TimeUnit.SECONDS)).containsEntry("_kind", "RES");
        assertThat(hub.hasSubscribers("summary")).isFalse();
    }

    @Test
    void only64SubscriptionsPerSession() throws Exception {
        for (int i = 0; i < SessionEvents.MAX_SUBSCRIPTIONS; i++) {
            assertThat(sub("agent.run:" + i, null)).containsEntry("_kind", "RES");
        }
        assertThat(sub("agent.run:one-too-many", null)).containsEntry("_kind", "ERR").containsEntry("code", "rate_limited");
        assertThat(events.subscriptionCount()).isEqualTo(64);
    }

    @Test
    void unsubStopsEvents() throws Exception {
        long subId = subscribe("summary");
        sink.take();
        rpc.onMessage(new Message(FrameKind.UNSUB, false, false, 50, 0, Json.bytes(Map.of("subId", subId))));
        assertThat(peer.replies.poll(5, TimeUnit.SECONDS)).containsEntry("_kind", "RES");
        hub.publish("summary", "patch", Map.of("n", 1));
        assertThat(sink.events()).isEmpty();
        assertThat(events.subscriptionCount()).isZero();

        rpc.onMessage(new Message(FrameKind.UNSUB, false, false, 51, 0, Json.bytes(Map.of("subId", subId))));
        assertThat(peer.replies.poll(5, TimeUnit.SECONDS)).containsEntry("code", "not_found");
    }

    @Test
    void eventsGoOnlyToSubscribersOfThatTopicAcrossSessions() throws Exception {
        FakeSink otherSink = new FakeSink();
        SessionEvents other = hub.newSession();
        other.attach(otherSink);
        Peer otherPeer = new Peer(other);
        RpcSession otherRpc = new RpcDispatcher().newSession(otherPeer);
        otherRpc.onMessage(new Message(FrameKind.SUB, false, false, 1, 0, Json.bytes(Map.of("topic", "summary"))));
        otherPeer.replies.poll(5, TimeUnit.SECONDS);
        await().until(() -> !otherSink.events().isEmpty());
        subscribe("summary");
        subscribe("agent.run:r1");
        sink.take();
        otherSink.take();

        hub.publish("summary", "patch", Map.of("n", 1));
        hub.publish("agent.run:r2", "delta", Map.of("n", 2));

        assertThat(sink.events()).extracting(Evt::type).containsExactly("patch");
        assertThat(otherSink.events()).extracting(Evt::type).containsExactly("patch");
    }

    @Test
    void anEventOver64KibIsThePublishersBug() {
        assertThatThrownBy(() -> publishPatch("summary", 64 * 1024))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void anOversizeOrFailingSnapshotBecomesAnErrorEvent() throws Exception {
        topics.register("oversize", new CountingTopic(true) {
            @Override
            public Object snapshot(String topicKey, Map<String, Object> params) {
                return Map.of("padding", "x".repeat(70 * 1024));
            }
        });
        topics.register("broken", new CountingTopic(true) {
            @Override
            public Object snapshot(String topicKey, Map<String, Object> params) {
                throw new IllegalStateException("secret");
            }
        });
        sub("oversize", null);
        await().until(() -> !sink.events().isEmpty());
        assertThat(sink.take().get(0)).satisfies(event -> {
            assertThat(event.type()).isEqualTo("error");
            assertThat(event.data()).isEqualTo(Map.of("code", "too_large"));
        });
        sub("broken", null);
        await().until(() -> !sink.events().isEmpty());
        assertThat(sink.take().get(0).data()).isEqualTo(Map.of("code", "internal"));
    }

    @Test
    void eventsPublishedDuringASnapshotComeAfterIt() throws Exception {
        CountDownLatch gate = new CountDownLatch(1);
        run.gate = gate;
        Map<String, Object> reply = sub("agent.run:r1", null);
        await().until(() -> run.snapshots.get() == 1);
        hub.publish("agent.run:r1", "delta", Map.of("n", 1));
        assertThat(sink.events()).isEmpty();
        gate.countDown();

        await().until(() -> sink.events().size() == 2);
        assertThat(sink.events()).extracting(Evt::type).containsExactly("snapshot", "delta");
        assertThat(sink.events()).extracting(Evt::seq).containsExactly(1L, 2L);
        assertThat(reply).containsEntry("seq", 0);
    }

    @Test
    void aCoalescibleTopicStopsDeltasPast1MibAndSendsOneSnapshotOnDrain() throws Exception {
        subscribe("summary");
        sink.take();
        assertThat(summary.snapshots).hasValue(1);

        // The channel is stuck: nothing it took has gone anywhere.
        int size = 60 * 1024;
        int published = 0;
        while (events.backlogBytes() <= SessionEvents.COALESCE_BACKLOG) {
            publishPatch("summary", size);
            published++;
            assertThat(published).as("backlog must grow").isLessThan(100);
        }
        long backlogAtLimit = events.backlogBytes();
        int sentBefore = sink.events().size();
        assertThat(sentBefore).isPositive();

        // Past the limit deltas stop, however many come.
        for (int i = 0; i < 50; i++) {
            publishPatch("summary", size);
        }
        assertThat(events.backlogBytes()).isLessThanOrEqualTo(backlogAtLimit);
        assertThat(sink.events()).hasSize(sentBefore);
        assertThat(summary.snapshots).hasValue(1);

        // It drains: no more deltas from before, and exactly one fresh snapshot.
        drain();
        await().until(() -> summary.snapshots.get() == 2);
        await().until(() -> sink.events().stream().anyMatch(e -> e.type().equals("snapshot")));
        drain();
        List<Evt> afterDrain = sink.take();
        assertThat(afterDrain.stream().filter(e -> e.type().equals("snapshot"))).hasSize(1);
        assertThat(afterDrain.subList(sentBefore, afterDrain.size())).extracting(Evt::type).containsExactly("snapshot");
        assertThat(events.backlogBytes()).isLessThanOrEqualTo(SessionEvents.SHALLOW);

        // Deltas flow again, in sequence after the snapshot.
        long snapshotSeq = afterDrain.get(afterDrain.size() - 1).seq();
        drain();
        hub.publish("summary", "patch", Map.of("n", 1));
        assertThat(sink.events()).extracting(Evt::seq).containsExactly(snapshotSeq + 1);
        assertThat(summary.snapshots).hasValue(2);
    }

    @Test
    void theBacklogStaysBoundedUnderAStreamOfDeltas() throws Exception {
        subscribe("summary");
        for (int i = 0; i < 2000; i++) {
            publishPatch("summary", 30 * 1024);
        }
        assertThat(events.backlogBytes())
                .isLessThanOrEqualTo(SessionEvents.COALESCE_BACKLOG + 2 * SessionEvents.SHALLOW);
    }

    @Test
    void aStreamGetsResyncPast256KibAndReplaysFromSince() throws Exception {
        long subId = subscribe("agent.run:r1");
        sink.take();

        // The channel is stuck. After the shallow queue fills, events wait here.
        // Publish past the buffer, but stay within what the ring keeps.
        int size = 20 * 1024;
        long total = 0;
        while (total < SessionEvents.STREAM_BUFFER + 2 * SessionEvents.SHALLOW) {
            publishPatch("agent.run:r1", size);
            total += size;
        }
        assertThat(total).isLessThan(SessionEvents.RING_BYTES);
        List<Evt> beforeResync = sink.events();
        assertThat(beforeResync).isNotEmpty();
        long lastSeen = beforeResync.get(beforeResync.size() - 1).seq();
        assertThat(beforeResync).extracting(Evt::type).doesNotContain("resync");

        // On drain the client hears resync, and nothing else from this stream until it comes back.
        drain();
        await().until(() -> sink.events().stream().anyMatch(e -> e.type().equals("resync")));
        List<Evt> all = sink.take();
        Evt resync = all.get(all.size() - 1);
        assertThat(resync.type()).isEqualTo("resync");
        assertThat(resync.subId()).isEqualTo(subId);
        assertThat(all.stream().filter(e -> e.type().equals("resync"))).hasSize(1);
        drain();
        events.onChannelDrained();
        assertThat(sink.events()).isEmpty();

        // SUB with since gets what it missed and what the ring still has, without a snapshot.
        Map<String, Object> reply = sub("agent.run:r1", lastSeen);
        assertThat(reply).containsEntry("subId", (int) subId);
        assertThat(((Number) reply.get("seq")).longValue()).isGreaterThan(lastSeen);
        await().until(() -> !sink.events().isEmpty());
        List<Evt> replay = new ArrayList<>();
        await().until(() -> {
            drain();
            replay.addAll(sink.take());
            return !replay.isEmpty() && replay.get(replay.size() - 1).seq() == ((Number) reply.get("seq")).longValue();
        });
        assertThat(replay.get(0).seq()).isEqualTo(lastSeen + 1);
        assertThat(replay).extracting(Evt::type).containsOnly("patch");
        assertThat(run.snapshots).hasValue(1);
    }

    @Test
    void sinceOlderThanTheRingGetsASnapshot() throws Exception {
        subscribe("agent.run:r1");
        sink.take();
        // More than the ring holds.
        for (int i = 0; i < 40; i++) {
            publishPatch("agent.run:r1", 30 * 1024);
            drain();
        }
        sink.take();
        sub("agent.run:r1", 1L);
        await().until(() -> run.snapshots.get() == 2);
    }

    @Test
    void afterADropAStreamReplaysAndACoalescibleTopicGetsASnapshot() throws Exception {
        long stream = subscribe("agent.run:r1");
        long coalescible = subscribe("summary");
        hub.publish("agent.run:r1", "delta", Map.of("n", 1));
        hub.publish("summary", "patch", Map.of("n", 1));
        List<Evt> seen = sink.take();
        long streamSeq = seen.stream().filter(e -> e.subId() == stream).mapToLong(Evt::seq).max().orElseThrow();

        events.detach();
        hub.publish("agent.run:r1", "delta", Map.of("n", 2));
        hub.publish("agent.run:r1", "delta", Map.of("n", 3));
        hub.publish("summary", "patch", Map.of("n", 2));
        assertThat(sink.events()).isEmpty();

        FakeSink newSink = new FakeSink();
        events.attach(newSink);
        assertThat(newSink.events()).as("nothing flows before the client asks").isEmpty();

        Map<String, Object> streamReply = sub("agent.run:r1", streamSeq);
        assertThat(((Number) streamReply.get("subId")).longValue()).isEqualTo(stream);
        await().until(() -> newSink.events().size() == 2);
        assertThat(newSink.take()).extracting(Evt::seq).containsExactly(streamSeq + 1, streamSeq + 2);

        Map<String, Object> summaryReply = sub("summary", 2L);
        assertThat(((Number) summaryReply.get("subId")).longValue()).isEqualTo(coalescible);
        await().until(() -> !newSink.events().isEmpty());
        assertThat(newSink.take().get(0).type()).isEqualTo("snapshot");
    }

    @Test
    void sinceAtTheLatestSeqReplaysNothing() throws Exception {
        subscribe("summary");
        sink.take();
        hub.publish("summary", "patch", Map.of("n", 1));
        long latest = sink.take().get(0).seq();

        sub("summary", latest);
        Thread.sleep(50);
        assertThat(sink.events()).isEmpty();
        hub.publish("summary", "patch", Map.of("n", 2));
        assertThat(sink.events()).extracting(Evt::seq).containsExactly(latest + 1);
    }

    @Test
    void aSubscriptionTheClientDoesntAskForAgainIsDropped() throws Exception {
        subscribe("summary");
        subscribe("agent.run:r1");
        events.detach();
        events.attach(new FakeSink());
        sub("summary", null);
        assertThat(events.subscriptionCount()).isEqualTo(2);
        events.dropDormant();
        assertThat(events.subscriptionCount()).isEqualTo(1);
    }

    @Test
    void ringsAreBoundedAcrossASession() throws Exception {
        for (int i = 0; i < 10; i++) {
            subscribe("agent.run:r" + i);
        }
        for (int round = 0; round < 40; round++) {
            for (int i = 0; i < 10; i++) {
                publishPatch("agent.run:r" + i, 30 * 1024);
            }
            drain();
        }
        assertThat(events.ringBytes()).isLessThanOrEqualTo(SessionEvents.TOTAL_RING_BYTES + 10 * 31 * 1024);
    }

    @Test
    void releaseDropsTheSessionFromFanOut() throws Exception {
        subscribe("summary");
        sink.take();
        hub.release(events);
        hub.publish("summary", "patch", Map.of("n", 1));
        assertThat(sink.events()).isEmpty();
        assertThat(events.subscriptionCount()).isZero();
    }

    @Test
    void subscribingOnAClosingSessionIsUnavailable() throws Exception {
        events.detach();
        assertThat(sub("summary", null)).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
    }
}
