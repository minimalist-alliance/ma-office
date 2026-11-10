package com.minimalistalliance.desk.deskd.events;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rpc.SubscriptionService;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The subscriptions of one client, and the rules for what happens when it can't keep up (design
 * 4.2.5, 4.2.6). This state can outlive a connection: when a session drops it detaches, and a resume
 * attaches it to the new session.
 *
 * <p><b>Flow.</b> Events wait in {@code pending}, oldest first. They move to the channel only while
 * its queue is shallow, so the true backlog stays here, where deltas can still be dropped.
 *
 * <p><b>Falling behind.</b> A coalescible topic stops sending deltas past a 1 MiB backlog, and sends
 * one fresh snapshot once the backlog drains. A stream buffers up to 256 KiB and then gets
 * {@code resync}, also on drain: the client subscribes again with {@code since}.
 *
 * <p><b>Locks.</b> Everything here holds {@code lock} only for queue work. Snapshots run on their own
 * virtual threads, outside it.
 */
public final class SessionEvents implements SubscriptionService {

    private static final Logger log = LoggerFactory.getLogger(SessionEvents.class);

    public static final int MAX_SUBSCRIPTIONS = 64;
    /** Past this backlog, coalescible topics stop sending deltas (design 4.2.6). */
    static final long COALESCE_BACKLOG = 1024 * 1024;
    /** What a stream may have waiting before it gets resync (design 4.2.6). */
    static final long STREAM_BUFFER = 256 * 1024;
    /** No session's streams may hold more than this together, however many it has. */
    static final long MAX_BACKLOG = 2L * 1024 * 1024;
    /** The channel's queue is kept this shallow, and "drained" means a backlog no bigger. */
    static final long SHALLOW = 64 * 1024;
    /**
     * Recent stream events kept per subscription, for replay after a drop or a resync. Twice the
     * stream buffer, so a client that fell just behind can catch up without a snapshot.
     */
    static final long RING_BYTES = 512 * 1024;
    /** The same, across all of a session's subscriptions. */
    static final long TOTAL_RING_BYTES = 1024 * 1024;

    /** Where events go while a session is attached. Neither method blocks. */
    public interface Sink {
        void enqueue(long subId, long seq, byte[] payload);

        long queuedBytes();
    }

    private record Record(long seq, byte[] payload) {}

    private record Pending(Subscription sub, long generation, long seq, byte[] payload) {}

    private static final class Subscription {
        final long id;
        final String topicKey;
        final Topic topic;
        final Map<String, Object> params;
        final String paramsKey;
        final ArrayDeque<Record> ring = new ArrayDeque<>(0);
        final List<Pending> held = new ArrayList<>(0);
        long ringBytes;
        long heldBytes;
        long queuedBytes;
        long seq;
        /** Bumped whenever the client starts over, which voids anything queued or being computed. */
        long generation;
        /** The client has asked for this subscription on the current attachment. */
        boolean active;
        /** Events wait in held until the first event of this attachment has gone out. */
        boolean holding;
        /** Deltas were dropped: a snapshot is owed. */
        boolean dirty;
        /** Stream events were dropped: resync is owed. */
        boolean resync;
        boolean resyncSent;
        boolean closed;

        Subscription(long id, String topicKey, Topic topic, Map<String, Object> params, String paramsKey) {
            this.id = id;
            this.topicKey = topicKey;
            this.topic = topic;
            this.params = params;
            this.paramsKey = paramsKey;
        }
    }

    private final TopicRegistry topics;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<Long, Subscription> subscriptions = new LinkedHashMap<>();
    private final ArrayDeque<Pending> pending = new ArrayDeque<>();
    private long pendingBytes;
    private long totalRingBytes;
    private long nextSubId = 1;
    private Sink sink;

    SessionEvents(TopicRegistry topics) {
        this.topics = topics;
    }

    /** A session has taken over. Kept subscriptions stay dormant until the client asks again. */
    public void attach(Sink newSink) {
        lock.lock();
        try {
            sink = newSink;
        } finally {
            lock.unlock();
        }
    }

    /** The session is gone. Subscriptions are kept, and streams go on filling their rings. */
    public void detach() {
        List<Topic> changed = new ArrayList<>(0);
        lock.lock();
        try {
            sink = null;
            pending.clear();
            pendingBytes = 0;
            for (Subscription sub : subscriptions.values()) {
                if (sub.active) {
                    changed.add(sub.topic);
                }
                sub.active = false;
                sub.holding = false;
                sub.generation++;
                sub.resync = false;
                sub.resyncSent = false;
                sub.queuedBytes = 0;
                sub.held.clear();
                sub.heldBytes = 0;
            }
        } finally {
            lock.unlock();
        }
        tell(changed);
    }

    /** Ends subscriptions the client didn't ask for again after a resume. */
    public void dropDormant() {
        lock.lock();
        try {
            Iterator<Subscription> iterator = subscriptions.values().iterator();
            while (iterator.hasNext()) {
                Subscription sub = iterator.next();
                if (!sub.active) {
                    discard(sub);
                    iterator.remove();
                }
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * The session's token has changed what it may do. A subscription it may no longer have ends now, and
     * the client hears why from an error event, as it would for any dead subscription. What's already in
     * the channel's queue was allowed when it went there.
     */
    public void reauthorize(RpcPrincipal principal) {
        List<Topic> changed = new ArrayList<>(0);
        lock.lock();
        try {
            Iterator<Subscription> iterator = subscriptions.values().iterator();
            while (iterator.hasNext()) {
                Subscription sub = iterator.next();
                try {
                    sub.topic.authorize(principal, sub.topicKey, sub.params);
                } catch (RpcException e) {
                    iterator.remove();
                    discard(sub);
                    changed.add(sub.topic);
                    if (sink != null && sub.active) {
                        sink.enqueue(sub.id, sub.seq, errorEvent(e.code()));
                    }
                }
            }
            pump();
        } finally {
            lock.unlock();
        }
        tell(changed);
    }

    /**
     * Something that isn't the token has taken these topics away from every session ({@link EventHub#endTopics}). Each
     * subscription to one ends as in {@link #reauthorize}, and one kept for a resume just goes.
     */
    void endTopics(Predicate<String> topicKey, String code) {
        List<Topic> changed = new ArrayList<>(0);
        lock.lock();
        try {
            Iterator<Subscription> iterator = subscriptions.values().iterator();
            while (iterator.hasNext()) {
                Subscription sub = iterator.next();
                if (!topicKey.test(sub.topicKey)) {
                    continue;
                }
                iterator.remove();
                discard(sub);
                changed.add(sub.topic);
                if (sink != null && sub.active) {
                    sink.enqueue(sub.id, sub.seq, errorEvent(code));
                }
            }
            pump();
        } finally {
            lock.unlock();
        }
        tell(changed);
    }

    /** After {@link EventHub#release} has taken this session off its list. */
    void close() {
        List<Topic> changed = new ArrayList<>(0);
        lock.lock();
        try {
            sink = null;
            pending.clear();
            pendingBytes = 0;
            for (Subscription sub : subscriptions.values()) {
                discard(sub);
                changed.add(sub.topic);
            }
            subscriptions.clear();
        } finally {
            lock.unlock();
        }
        tell(changed);
    }

    /** {@link Topic#subscribersChanged}, outside the lock: a topic may ask every session who's subscribed. */
    private static void tell(List<Topic> topics) {
        for (int i = 0; i < topics.size(); i++) {
            if (topics.indexOf(topics.get(i)) == i) {
                topics.get(i).subscribersChanged();
            }
        }
    }

    /** The channel took some of its queue, so more can move. */
    public void onChannelDrained() {
        lock.lock();
        try {
            pump();
        } finally {
            lock.unlock();
        }
    }

    public int subscriptionCount() {
        lock.lock();
        try {
            return subscriptions.size();
        } finally {
            lock.unlock();
        }
    }

    long ringBytes() {
        lock.lock();
        try {
            return totalRingBytes;
        } finally {
            lock.unlock();
        }
    }

    /** True if this client, attached now, has asked for this topic. */
    public boolean isSubscribed(String topicKey) {
        lock.lock();
        try {
            if (sink == null) {
                return false;
            }
            for (Subscription sub : subscriptions.values()) {
                if (sub.active && sub.topicKey.equals(topicKey)) {
                    return true;
                }
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    /** Bytes waiting here and in the channel's queue. */
    public long backlogBytes() {
        lock.lock();
        try {
            return backlog();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public Object subscribe(RpcContext context, Map<String, Object> request) throws RpcException {
        String topicKey = Json.string(request, "topic");
        if (topicKey == null || topicKey.isEmpty() || topicKey.length() > 256) {
            throw new RpcException(RpcException.BAD_REQUEST, "SUB needs a topic");
        }
        Map<String, Object> params = request.get("params") == null ? Map.of() : Json.object(request, "params");
        if (params == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "params must be an object");
        }
        Object rawSince = request.get("since");
        if (rawSince != null && !(rawSince instanceof Number)) {
            throw new RpcException(RpcException.BAD_REQUEST, "since must be a number");
        }
        Long since = rawSince instanceof Number number ? number.longValue() : null;
        Topic topic = topics.resolve(topicKey);
        RpcPrincipal principal = context.principal();
        if (principal.isGuildMember() && (topic == null || !topic.forGuildMembers())) {
            throw new RpcException(RpcException.FORBIDDEN, "The token's scope doesn't allow this", Map.of("reason", "scope"));
        }
        if (topic == null) {
            throw new RpcException(RpcException.NOT_FOUND, "No such topic");
        }
        topicKey = topic.keyFor(principal, topicKey);
        String paramsKey = new String(Json.bytes(params), StandardCharsets.UTF_8);

        Map<String, Object> reply = new LinkedHashMap<>();
        lock.lock();
        try {
            // Under the lock, with the token as it is now: a refresh changes the token and then comes
            // through here, so either this sees the new one or that finds this subscription.
            topic.authorize(context.principal(), topicKey, params);
            if (sink == null) {
                throw new RpcException(RpcException.UNAVAILABLE, "Session is closing");
            }
            Subscription sub = find(topicKey, paramsKey);
            if (sub == null) {
                if (subscriptions.size() >= MAX_SUBSCRIPTIONS) {
                    throw new RpcException(RpcException.RATE_LIMITED, "Too many subscriptions",
                            Map.of("limit", "subscriptions", "max", MAX_SUBSCRIPTIONS));
                }
                sub = new Subscription(nextSubId++, topicKey, topic, params, paramsKey);
                subscriptions.put(sub.id, sub);
            }
            sub.active = true;
            sub.generation++;
            sub.holding = true;
            sub.held.clear();
            sub.heldBytes = 0;
            sub.queuedBytes = 0;
            sub.resync = false;
            sub.resyncSent = false;
            reply.put("subId", sub.id);
            reply.put("seq", sub.seq);
            Subscription started = sub;
            long generation = sub.generation;
            if (since != null && canReplay(sub, since)) {
                long upTo = sub.seq;
                context.afterReply(() -> finishReplay(started, generation, since, upTo));
            } else {
                context.afterReply(() -> beginSnapshot(started, generation));
            }
        } finally {
            lock.unlock();
        }
        topic.subscribersChanged();
        return reply;
    }

    @Override
    public Object unsubscribe(RpcContext context, Map<String, Object> request) throws RpcException {
        if (!(request.get("subId") instanceof Number number)) {
            throw new RpcException(RpcException.BAD_REQUEST, "UNSUB needs a subId");
        }
        Subscription sub;
        lock.lock();
        try {
            sub = subscriptions.remove(number.longValue());
            if (sub == null) {
                throw new RpcException(RpcException.NOT_FOUND, "No such subscription");
            }
            discard(sub);
        } finally {
            lock.unlock();
        }
        sub.topic.subscribersChanged();
        return Map.of();
    }

    /** One published event, encoded already, for whichever subscriptions want it. */
    void deliver(String topicKey, byte[] payload) {
        lock.lock();
        try {
            for (Subscription sub : subscriptions.values()) {
                if (sub.topicKey.equals(topicKey)) {
                    if (sub.topic.coalescible()) {
                        deliverCoalescible(sub, payload);
                    } else {
                        deliverStream(sub, payload);
                    }
                }
            }
            pump();
        } finally {
            lock.unlock();
        }
    }

    private void deliverCoalescible(Subscription sub, byte[] payload) {
        if (sub.dirty) {
            return;
        }
        if (sink == null || !sub.active || backlog() > COALESCE_BACKLOG) {
            sub.dirty = true;
            return;
        }
        Pending event = new Pending(sub, sub.generation, ++sub.seq, payload);
        if (!sub.holding) {
            addPending(event);
        } else if (sub.heldBytes + payload.length > STREAM_BUFFER) {
            sub.dirty = true;
            sub.held.clear();
            sub.heldBytes = 0;
        } else {
            hold(sub, event);
        }
    }

    private void deliverStream(Subscription sub, byte[] payload) {
        long seq = ++sub.seq;
        addToRing(sub, new Record(seq, payload));
        if (sink == null || !sub.active || sub.resync) {
            return;
        }
        Pending event = new Pending(sub, sub.generation, seq, payload);
        if (sub.holding) {
            if (sub.heldBytes + payload.length > STREAM_BUFFER) {
                sub.resync = true;
                sub.held.clear();
                sub.heldBytes = 0;
            } else {
                hold(sub, event);
            }
        } else if (sub.queuedBytes + payload.length > STREAM_BUFFER || backlog() + payload.length > MAX_BACKLOG) {
            sub.resync = true;
        } else {
            addPending(event);
        }
    }

    private void hold(Subscription sub, Pending event) {
        sub.held.add(event);
        sub.heldBytes += event.payload().length;
    }

    private void addPending(Pending event) {
        pending.addLast(event);
        pendingBytes += event.payload().length;
        event.sub().queuedBytes += event.payload().length;
    }

    private void addToRing(Subscription sub, Record record) {
        sub.ring.addLast(record);
        sub.ringBytes += record.payload().length;
        totalRingBytes += record.payload().length;
        while (sub.ring.size() > 1 && (sub.ringBytes > RING_BYTES || totalRingBytes > TOTAL_RING_BYTES)) {
            int length = sub.ring.pollFirst().payload().length;
            sub.ringBytes -= length;
            totalRingBytes -= length;
        }
    }

    private void discard(Subscription sub) {
        sub.closed = true;
        totalRingBytes -= sub.ringBytes;
        sub.ring.clear();
        sub.ringBytes = 0;
        sub.held.clear();
    }

    private Subscription find(String topicKey, String paramsKey) {
        for (Subscription sub : subscriptions.values()) {
            if (sub.topicKey.equals(topicKey) && sub.paramsKey.equals(paramsKey)) {
                return sub;
            }
        }
        return null;
    }

    private static boolean canReplay(Subscription sub, long since) {
        if (since < 0 || since > sub.seq) {
            return false;
        }
        if (sub.topic.coalescible()) {
            return since == sub.seq && !sub.dirty && sub.topic.publishesWithNoSubscriber();
        }
        return since == sub.seq || (!sub.ring.isEmpty() && sub.ring.peekFirst().seq() <= since + 1);
    }

    private void finishReplay(Subscription sub, long generation, long since, long upTo) {
        lock.lock();
        try {
            if (sub.closed || sub.generation != generation) {
                return;
            }
            for (Record record : sub.ring) {
                if (record.seq() > since && record.seq() <= upTo) {
                    addPending(new Pending(sub, generation, record.seq(), record.payload()));
                }
            }
            releaseHeld(sub);
            pump();
        } finally {
            lock.unlock();
        }
    }

    private void beginSnapshot(Subscription sub, long generation) {
        lock.lock();
        try {
            if (!sub.closed && sub.generation == generation) {
                startSnapshot(sub);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Takes the seq now, so stream events arriving during the snapshot sort after it. */
    private void startSnapshot(Subscription sub) {
        sub.dirty = false;
        sub.holding = true;
        long generation = sub.generation;
        long seq = ++sub.seq;
        Thread.ofVirtual().name("event-snapshot").start(() -> runSnapshot(sub, generation, seq));
    }

    private void runSnapshot(Subscription sub, long generation, long seq) {
        byte[] payload;
        try {
            Object state = sub.topic.snapshot(sub.topicKey, sub.params);
            if (state == Topic.NO_SNAPSHOT) {
                releaseWithNothingSent(sub, generation);
                return;
            }
            payload = EventHub.encode("snapshot", state);
            if (payload.length > FrameKind.EVT.maxMessageBytes()) {
                log.error("snapshot for a {} topic is over the event limit", prefixOf(sub.topicKey));
                payload = errorEvent(RpcException.TOO_LARGE);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        } catch (Exception | Error e) {
            // The class alone: exception text can quote the payload.
            log.error("snapshot for a {} topic failed: {}", prefixOf(sub.topicKey), e.getClass().getName());
            payload = errorEvent(RpcException.INTERNAL);
        }
        lock.lock();
        try {
            if (sub.closed || sub.generation != generation) {
                return;
            }
            addPending(new Pending(sub, generation, seq, payload));
            releaseHeld(sub);
            pump();
        } finally {
            lock.unlock();
        }
    }

    private void releaseWithNothingSent(Subscription sub, long generation) {
        lock.lock();
        try {
            if (!sub.closed && sub.generation == generation) {
                releaseHeld(sub);
                pump();
            }
        } finally {
            lock.unlock();
        }
    }

    private static byte[] errorEvent(String code) {
        return EventHub.encode("error", Map.of("code", code));
    }

    /** Topic ids can carry member data, so logs get the family only. */
    private static String prefixOf(String topicKey) {
        int colon = topicKey.indexOf(':');
        int scoped = topicKey.indexOf('\0');
        int end = colon < 0 ? scoped : scoped < 0 ? colon : Math.min(colon, scoped);
        return end < 0 ? topicKey : topicKey.substring(0, end);
    }

    private void releaseHeld(Subscription sub) {
        sub.holding = false;
        sub.held.forEach(this::addPending);
        sub.held.clear();
        sub.heldBytes = 0;
    }

    private long backlog() {
        return pendingBytes + (sink == null ? 0 : sink.queuedBytes());
    }

    /** Moves what fits to the channel, then settles anything owed if the backlog has drained. */
    private void pump() {
        if (sink == null) {
            return;
        }
        Pending event;
        while ((event = pending.peekFirst()) != null) {
            Subscription sub = event.sub();
            boolean oldGeneration = sub.generation != event.generation();
            boolean stale = sub.closed || oldGeneration || sub.resync || (sub.dirty && sub.topic.coalescible());
            if (!stale && sink.queuedBytes() >= SHALLOW) {
                return;
            }
            pending.pollFirst();
            pendingBytes -= event.payload().length;
            if (!oldGeneration) {
                sub.queuedBytes -= event.payload().length;
            }
            if (!stale) {
                sink.enqueue(sub.id, event.seq(), event.payload());
            }
        }
        if (sink.queuedBytes() > SHALLOW) {
            return;
        }
        for (Subscription sub : subscriptions.values()) {
            if (sub.active && sub.dirty && !sub.holding) {
                startSnapshot(sub);
            }
            if (sub.active && sub.resync && !sub.resyncSent) {
                sub.resyncSent = true;
                sink.enqueue(sub.id, sub.seq, EventHub.encode("resync", Map.of()));
            }
        }
    }
}
