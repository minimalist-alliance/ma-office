package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The topics {@code agent.state} and {@code agent.conversation:<agentId>}, relayed from desk-agent.
 *
 * <p><b>One desk-agent subscription per topic.</b> While any attached session is subscribed to a topic, deskd holds
 * one subscription of its own on desk-agent's socket, and publishes that subscription's events to the hub, which fans
 * them out and numbers them per client. The first client's snapshot is that subscription's own first event, so nothing
 * is missed or repeated for it. A later client's snapshot is a one-off subscription, taken and dropped. Events
 * published while that's out follow the snapshot, as for every deskd topic (API.md section 5), and a {@code delta}
 * among them can repeat text already in it until the reply's final {@code message} replaces the whole text.
 *
 * <p><b>Coalescible, and no {@code since}.</b> A snapshot from desk-agent is the whole state, a streaming reply's text
 * included, so it can stand in for anything a client missed, and every SUB gets one, as {@code browser.tabs} does. A
 * thread's snapshot holds its newest messages, with {@code older: true} when there are more, which
 * {@code agent.thread.get} pages through with {@code before}.
 *
 * <p><b>When the link drops,</b> clients keep their subscriptions and hear nothing. When it's back, each topic that
 * still has a subscriber is subscribed again, and its first event goes to them as a {@code snapshot}. A SUB while the
 * link is down gets no first event until then ({@link Topic#NO_SNAPSHOT}).
 *
 * <p><b>Teens.</b> While the owner's band is {@code teen} a SUB is refused with {@code forbidden}, and while it's unknown with
 * {@code unavailable}, both with {@code reason: age_band}, before anything reaches desk-agent. A desk that becomes {@code teen}
 * ends what's subscribed ({@link #endForTeen}), and deskd's own subscriptions go with the last subscriber.
 *
 * <p><b>Guild members</b> (API.md section 14) each have their own: a member's subscription is kept under the topic's key
 * with {@code \0} and their member id after it ({@link #keyFor}), which no client sees, and deskd's subscription on
 * desk-agent's socket for that key carries the member, so desk-agent shows them only their own agents and threads. A
 * member in the teen band is refused as a teen owner is, by their own token's flag; the owner's band doesn't apply to them.
 *
 * <p>Owner and guild member tokens only. Events are made to fit an EVT by {@link EventFit}. Nothing here logs an event's data.
 */
final class AgentTopics implements Topic {

    private static final Logger log = LoggerFactory.getLogger(AgentTopics.class);

    static final String STATE = "agent.state";
    static final String CONVERSATION = "agent.conversation:";
    /** A conversation's first event when desk-agent couldn't send its snapshot: see {@link #tooLargeToSend}. */
    private static final Map<String, Object> LONG_THREAD = Map.of("messages", List.of(), "older", true);
    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    /** Between a topic and the member a guild member's subscription is kept for: no topic or member id has one. */
    static final char SCOPED = '\0';

    /** Raised when the link went while a snapshot was awaited: the topic's first event comes after it's back. */
    private static final class LinkDown extends Exception {
        private static final long serialVersionUID = 1L;

        LinkDown() {
            super(null, null, false, false);
        }
    }

    /** desk-agent knows no such topic, as for an agent that doesn't exist. */
    private static final class Unknown extends Exception {
        private static final long serialVersionUID = 1L;

        Unknown() {
            super(null, null, false, false);
        }
    }

    /** deskd's own subscription to one topic on desk-agent's socket. */
    private static final class Relay {
        final String key;
        final long sid;
        /** Its first event, a snapshot: the creating client's snapshot. */
        final CompletableFuture<Map<String, Object>> first = new CompletableFuture<>();
        /** Its first event also goes to the hub, as clients are waiting without one. */
        volatile boolean announce;
        volatile boolean firstSeen;

        Relay(String key, long sid, boolean announce) {
            this.key = key;
            this.sid = sid;
            this.announce = announce;
        }
    }

    /** A one-off subscription for a later client's snapshot, and its topic. */
    private record Look(String key, CompletableFuture<Map<String, Object>> snapshot) {}

    private final AgentLink link;
    private final EventHub hub;
    private final Duration wait;
    private final Supplier<AgeBand.Band> band;
    private final ReentrantLock lock = new ReentrantLock();
    /** By topic key, while someone may want it. Under the lock. */
    private final Map<String, Relay> relays = new HashMap<>();
    private final Map<Long, Relay> bySid = new ConcurrentHashMap<>();
    /** One-off subscriptions for a later client's snapshot. */
    private final Map<Long, Look> oneOff = new ConcurrentHashMap<>();
    private final AtomicBoolean settleQueued = new AtomicBoolean();

    AgentTopics(AgentLink link, EventHub hub, Duration wait, Supplier<AgeBand.Band> band) {
        this.link = link;
        this.hub = hub;
        this.wait = wait;
        this.band = band;
    }

    void register() {
        hub.topics().register(STATE, this);
        hub.topics().register(CONVERSATION, this);
    }

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    @Override
    public boolean forGuildMembers() {
        return true;
    }

    /** A guild member's own key: see the class's comment. The member id can't change across a refresh. */
    @Override
    public String keyFor(RpcPrincipal principal, String topicKey) {
        return principal.isGuildMember() ? topicKey + SCOPED + principal.caller().memberId() : topicKey;
    }

    /** What desk-agent knows the topic as. */
    static String topicOf(String key) {
        int at = key.indexOf(SCOPED);
        return at < 0 ? key : key.substring(0, at);
    }

    /** Whom deskd's subscription for this key is for: the owner, or a guild member (desk-agent looks only at the id). */
    static Map<String, Object> callerOf(String key) {
        int at = key.indexOf(SCOPED);
        if (at < 0) {
            return null;
        }
        Map<String, Object> caller = new LinkedHashMap<>();
        caller.put("kind", Caller.GUILD_MEMBER);
        caller.put("memberId", key.substring(at + 1));
        return caller;
    }

    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (principal.isGuildMember()) {
            AgentMethods.requireMemberAge(principal.caller());
        } else if (!AgentMethods.OWNER.equals(principal.scope())) {
            throw AgentMethods.forbidden();
        } else {
            // Under the session's lock, and with the band already teen when endForTeen comes, so no SUB slips between them.
            AgentMethods.requireBand(band.get());
        }
        // A refresh reauthorizes with the key the subscription is kept under.
        topicKey = topicOf(topicKey);
        if (!topicKey.equals(STATE)
                && !(topicKey.startsWith(CONVERSATION) && AGENT_ID.matcher(topicKey.substring(CONVERSATION.length())).matches())) {
            throw new RpcException(RpcException.NOT_FOUND, "No such topic");
        }
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) throws Exception {
        Relay relay;
        boolean created = false;
        lock.lock();
        try {
            relay = relays.get(topicKey);
            if (relay == null) {
                relay = new Relay(topicKey, link.newSid(), false);
                relays.put(topicKey, relay);
                bySid.put(relay.sid, relay);
                created = true;
            }
        } finally {
            lock.unlock();
        }
        if (created) {
            if (!link.subscribe(relay.sid, topicOf(topicKey), callerOf(topicKey))) {
                relay.announce = true;
                return NO_SNAPSHOT;
            }
            return await(relay.first, relay);
        }
        long sid = link.newSid();
        CompletableFuture<Map<String, Object>> look = new CompletableFuture<>();
        oneOff.put(sid, new Look(topicKey, look));
        try {
            if (!link.subscribe(sid, topicOf(topicKey), callerOf(topicKey))) {
                return NO_SNAPSHOT;
            }
            return await(look, null);
        } finally {
            oneOff.remove(sid);
            link.unsubscribe(sid);
        }
    }

    private Object await(CompletableFuture<Map<String, Object>> snapshot, Relay relay) throws Exception {
        try {
            return EventFit.snapshot(snapshot.get(wait.toNanos(), TimeUnit.NANOSECONDS));
        } catch (ExecutionException e) {
            if (e.getCause() instanceof LinkDown) {
                return NO_SNAPSHOT;
            }
            throw new RpcException(RpcException.NOT_FOUND, "No such topic");
        } catch (TimeoutException e) {
            if (relay != null) {
                // Whoever is subscribed gets it when it comes.
                relay.announce = true;
            }
            throw new RpcException(RpcException.UNAVAILABLE, "desk-agent didn't answer");
        }
    }

    /** Who's subscribed may have changed: topics nobody attached wants any more are let go, on a thread of its own. */
    @Override
    public void subscribersChanged() {
        if (settleQueued.compareAndSet(false, true)) {
            Thread.ofVirtual().name("agent-topics").start(() -> {
                settleQueued.set(false);
                settle();
            });
        }
    }

    private void settle() {
        List<Relay> dropped = new ArrayList<>(0);
        lock.lock();
        try {
            Iterator<Relay> iterator = relays.values().iterator();
            while (iterator.hasNext()) {
                Relay relay = iterator.next();
                if (!hub.hasSubscribers(relay.key)) {
                    iterator.remove();
                    bySid.remove(relay.sid);
                    dropped.add(relay);
                }
            }
        } finally {
            lock.unlock();
        }
        for (Relay relay : dropped) {
            relay.first.completeExceptionally(new LinkDown());
            link.unsubscribe(relay.sid);
        }
    }

    /**
     * The desk has just become {@code teen}: every subscription ends with an error event, as a refresh that takes away the
     * right does. Each session then says who's left, which lets go of desk-agent's side ({@link #settle}). Returns quickly.
     */
    void endForTeen() {
        // The owner's band: a guild member's subscriptions go by their own token's flag, and a refresh ends those.
        hub.endTopics(key -> key.indexOf(SCOPED) < 0 && (key.equals(STATE) || key.startsWith(CONVERSATION)), RpcException.FORBIDDEN);
    }

    /** The link is up: every topic that still has a subscriber is subscribed again, and its first event announced. */
    void connected() {
        List<Relay> fresh = new ArrayList<>();
        lock.lock();
        try {
            Iterator<Map.Entry<String, Relay>> iterator = relays.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<String, Relay> entry = iterator.next();
                bySid.remove(entry.getValue().sid);
                if (hub.hasSubscribers(entry.getKey())) {
                    Relay relay = new Relay(entry.getKey(), link.newSid(), true);
                    entry.setValue(relay);
                    bySid.put(relay.sid, relay);
                    fresh.add(relay);
                } else {
                    iterator.remove();
                }
            }
        } finally {
            lock.unlock();
        }
        for (Relay relay : fresh) {
            link.subscribe(relay.sid, topicOf(relay.key), callerOf(relay.key));
        }
    }

    /** The link has gone, and every subscription on it. Clients keep theirs, and hear again once it's back. */
    void disconnected() {
        lock.lock();
        try {
            for (Relay relay : relays.values()) {
                relay.announce = true;
                relay.first.completeExceptionally(new LinkDown());
            }
        } finally {
            lock.unlock();
        }
        for (Look look : oneOff.values()) {
            look.snapshot().completeExceptionally(new LinkDown());
        }
    }

    /** One {@code evt} for a subscription of this class's. @return false if it isn't one */
    boolean event(long sid, String type, Map<String, Object> data) {
        Look look = oneOff.get(sid);
        if (look != null) {
            if (tooLargeToSend(look.key(), type, data)) {
                look.snapshot().complete(LONG_THREAD);
            } else if ("snapshot".equals(type)) {
                look.snapshot().complete(data);
            } else if ("error".equals(type)) {
                look.snapshot().completeExceptionally(new Unknown());
            }
            return true;
        }
        Relay relay = bySid.get(sid);
        if (relay == null) {
            return false;
        }
        if (!relay.firstSeen) {
            relay.firstSeen = true;
            if (tooLargeToSend(relay.key, type, data)) {
                type = "snapshot";
                data = LONG_THREAD;
            }
            if ("error".equals(type)) {
                lock.lock();
                try {
                    relays.remove(relay.key, relay);
                    bySid.remove(sid);
                } finally {
                    lock.unlock();
                }
                relay.first.completeExceptionally(new Unknown());
                link.unsubscribe(sid);
                if (relay.announce) {
                    publish(relay.key, "error", Map.of("code", RpcException.NOT_FOUND));
                }
                return true;
            }
            if (relay.announce) {
                publish(relay.key, type, data);
            }
            relay.first.complete(data);
            return true;
        }
        publish(relay.key, type, data);
        return true;
    }

    /**
     * A desk-agent from before snapshots were cut to fit sends an {@code error} with {@code too_large} in place of a long
     * thread's snapshot, and keeps the subscription. That isn't an agent that doesn't exist, so the topic starts empty,
     * saying older messages exist, and what follows is live.
     */
    private static boolean tooLargeToSend(String key, String type, Map<String, Object> data) {
        return "error".equals(type) && topicOf(key).startsWith(CONVERSATION) && RpcException.TOO_LARGE.equals(data.get("code"));
    }

    private void publish(String key, String type, Map<String, Object> data) {
        List<EventFit.Event> events = EventFit.fit(type, data);
        if (events.isEmpty()) {
            log.warn("dropped a {} event on an agent topic: too large to fit", type);
        }
        for (EventFit.Event event : events) {
            try {
                hub.publish(key, event.type(), event.data());
            } catch (IllegalArgumentException e) {
                log.warn("dropped a {} event on an agent topic: {}", type, e.getClass().getSimpleName());
            }
        }
    }

    /** For tests: the topics deskd holds a subscription to on desk-agent's socket. */
    List<String> relayedForTest() {
        lock.lock();
        try {
            return new ArrayList<>(relays.keySet());
        } finally {
            lock.unlock();
        }
    }
}
