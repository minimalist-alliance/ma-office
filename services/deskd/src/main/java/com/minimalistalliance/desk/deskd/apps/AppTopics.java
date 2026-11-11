package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The topics {@code apps} and {@code app:<id>:<topic>} (deskd's API, section 19).
 *
 * <p><b>{@code apps}</b>: what's installed and how each app is, the same list {@code apps.list} returns, as a {@code snapshot}
 * and then a {@code patch} carrying the whole list again on each change, at most once a second.
 *
 * <p><b>{@code app:<id>:<topic>}</b>: one of an app's declared topics, relayed as {@code agent.*}'s are: while anyone is
 * subscribed, deskd holds one subscription of its own on the app's socket and publishes its events to the hub, which fans
 * them out. A first subscriber's snapshot is that subscription's first event; a later one's, a one-off subscription taken and
 * dropped. Coalescible: an app's patch must carry values, never increments, since one can repeat what a snapshot had. A SUB
 * starts the app if it isn't running. When the app's link goes, subscribers keep their subscriptions; when it's back, each
 * topic still wanted is subscribed again and its first event goes out as a {@code snapshot}.
 *
 * <p><b>Guild members</b> each get their own: the key the subscription is kept under has {@code \0} and their member id after
 * it, which no client sees, and deskd's subscription on the app's socket for that key carries the member's pseudonym, so an
 * app can show each member what's theirs.
 */
final class AppTopics {

    static final String APPS = "apps";
    static final String APP = "app:";
    static final char SCOPED = '\0';
    private static final Duration FIRST_EVENT = Duration.ofSeconds(5);
    private static final long PUBLISH_EVERY_NANOS = 1_000_000_000L;

    /** What the topics need from the module. */
    interface Access {
        /** The owner, or a guild member on a guild desk; anyone else {@code forbidden}. And the switch. */
        void authorize(RpcPrincipal principal) throws RpcException;

        Map<String, Object> list();

        /** {@code not_found} unless the app is installed and declares this topic; {@code forbidden} if it's been revoked. */
        void requireTopic(String id, String topic) throws RpcException;

        AppLink ensureRunning(String id) throws RpcException, InterruptedException;

        /** The app's link if it runs now, else null: never starts it. */
        AppLink ensureRunningIfAlive(String id);

        /** The {@code from} of deskd's subscription for a key: the caller, the member's pseudonym for a guild member's. */
        Map<String, Object> from(String id, String memberId);
    }

    record Key(String id, String topic, String memberId) {}

    private static final class Relay {
        final String key;
        final Key parsed;
        final CompletableFuture<Object> first = new CompletableFuture<>();
        volatile long subId = -1;
        volatile boolean announce;
        volatile boolean firstSeen;

        Relay(String key, Key parsed, boolean announce) {
            this.key = key;
            this.parsed = parsed;
            this.announce = announce;
        }
    }

    private final EventHub hub;
    private final Access access;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Relay> relays = new HashMap<>();
    private final AtomicBoolean settleQueued = new AtomicBoolean();
    private final AtomicBoolean publishQueued = new AtomicBoolean();
    private final AtomicLong lastPublish = new AtomicLong(System.nanoTime() - PUBLISH_EVERY_NANOS);

    AppTopics(EventHub hub, Access access) {
        this.hub = hub;
        this.access = access;
    }

    void register() {
        hub.topics().register(APPS, new AppsTopic());
        hub.topics().register(APP, new AppTopic());
    }

    /** True if anyone attached is subscribed to one of this app's topics. */
    boolean inUse(String id) {
        String prefix = APP + id + ":";
        return hub.hasSubscribersTo(key -> key.startsWith(prefix));
    }

    /** The list changed: published at most once a second, the newest state winning. */
    void changed() {
        if (!publishQueued.compareAndSet(false, true)) {
            return;
        }
        Thread.ofVirtual().name("apps-publish").start(() -> {
            try {
                long wait = PUBLISH_EVERY_NANOS - (System.nanoTime() - lastPublish.get());
                if (wait > 0) {
                    Thread.sleep(Duration.ofNanos(wait));
                }
            } catch (InterruptedException e) {
                return;
            } finally {
                publishQueued.set(false);
            }
            lastPublish.set(System.nanoTime());
            if (hub.hasSubscribers(APPS)) {
                hub.publish(APPS, "patch", access.list());
            }
        });
    }

    // ---- apps

    private final class AppsTopic implements Topic {
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

        @Override
        public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
            access.authorize(principal);
        }

        @Override
        public Object snapshot(String topicKey, Map<String, Object> params) {
            return access.list();
        }
    }

    // ---- app:<id>:<topic>

    private final class AppTopic implements Topic {
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

        @Override
        public String keyFor(RpcPrincipal principal, String topicKey) {
            return principal.isGuildMember() ? topicKey + SCOPED + principal.caller().memberId() : topicKey;
        }

        @Override
        public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
            access.authorize(principal);
            Key key = parse(topicKey);
            if (key == null) {
                throw new RpcException(RpcException.NOT_FOUND, "No such topic");
            }
            access.requireTopic(key.id(), key.topic());
        }

        @Override
        public Object snapshot(String topicKey, Map<String, Object> params) throws Exception {
            Key key = parse(topicKey);
            if (key == null) {
                throw new RpcException(RpcException.NOT_FOUND, "No such topic");
            }
            AppLink link = access.ensureRunning(key.id());
            Relay relay;
            boolean created = false;
            lock.lock();
            try {
                relay = relays.get(topicKey);
                if (relay == null) {
                    relay = new Relay(topicKey, key, false);
                    relays.put(topicKey, relay);
                    created = true;
                }
            } finally {
                lock.unlock();
            }
            if (created) {
                subscribe(link, relay);
                return await(relay.first);
            }
            CompletableFuture<Object> look = new CompletableFuture<>();
            long subId = link.subscribe(key.topic(), access.from(key.id(), key.memberId()), (type, data) -> look.complete(data), FIRST_EVENT);
            try {
                return await(look);
            } finally {
                link.unsubscribe(subId);
            }
        }

        @Override
        public void subscribersChanged() {
            if (settleQueued.compareAndSet(false, true)) {
                Thread.ofVirtual().name("app-topics").start(() -> {
                    settleQueued.set(false);
                    settle();
                });
            }
        }
    }

    private void subscribe(AppLink link, Relay relay) throws RpcException, InterruptedException {
        relay.subId = link.subscribe(relay.parsed.topic(), access.from(relay.parsed.id(), relay.parsed.memberId()),
                (type, data) -> event(relay, type, data), FIRST_EVENT);
    }

    private void event(Relay relay, String type, Object data) {
        if (!relay.firstSeen) {
            relay.firstSeen = true;
            relay.first.complete(data);
            if (!relay.announce) {
                return;
            }
            type = "snapshot";
        }
        try {
            hub.publish(relay.key, type, data);
        } catch (IllegalArgumentException e) {
            // Over an EVT's 64 KiB once deskd wraps it: dropped, and the next snapshot covers it.
        }
    }

    private static Object await(CompletableFuture<Object> first) throws RpcException, InterruptedException {
        try {
            return first.get(FIRST_EVENT.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException | ExecutionException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The app didn't answer", Map.of("reason", "app_stopped"));
        }
    }

    /** Lets go of deskd's subscriptions nobody attached wants any more. */
    private void settle() {
        List<Relay> dropped = new ArrayList<>(0);
        lock.lock();
        try {
            Iterator<Relay> it = relays.values().iterator();
            while (it.hasNext()) {
                Relay relay = it.next();
                if (!hub.hasSubscribers(relay.key)) {
                    it.remove();
                    dropped.add(relay);
                }
            }
        } finally {
            lock.unlock();
        }
        for (Relay relay : dropped) {
            relay.first.completeExceptionally(new IllegalStateException("dropped"));
            if (relay.subId >= 0) {
                try {
                    AppLink link = access.ensureRunningIfAlive(relay.parsed.id());
                    if (link != null) {
                        link.unsubscribe(relay.subId);
                    }
                } catch (RuntimeException e) {
                    // The link is gone, and the subscription with it.
                }
            }
        }
    }

    /** The app's link is up: its topics still wanted are subscribed again, each first event announced as a snapshot. */
    void linkUp(String id) {
        List<Relay> fresh = new ArrayList<>();
        lock.lock();
        try {
            Iterator<Map.Entry<String, Relay>> it = relays.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Relay> entry = it.next();
                Relay old = entry.getValue();
                if (!old.parsed.id().equals(id) || (old.subId >= 0 && old.firstSeen)) {
                    continue;
                }
                if (hub.hasSubscribers(entry.getKey())) {
                    Relay relay = new Relay(entry.getKey(), old.parsed, true);
                    entry.setValue(relay);
                    fresh.add(relay);
                } else {
                    it.remove();
                }
            }
        } finally {
            lock.unlock();
        }
        if (fresh.isEmpty()) {
            return;
        }
        Thread.ofVirtual().name("app-topics-up").start(() -> {
            for (Relay relay : fresh) {
                try {
                    AppLink link = access.ensureRunningIfAlive(id);
                    if (link != null) {
                        subscribe(link, relay);
                    }
                } catch (RpcException e) {
                    // Subscribers hear on the next link.
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        });
    }

    /** The app's link has gone, and deskd's subscriptions on it. Clients keep theirs and hear again once it's back. */
    void linkDown(String id) {
        lock.lock();
        try {
            for (Relay relay : relays.values()) {
                if (relay.parsed.id().equals(id)) {
                    relay.subId = -1;
                    relay.firstSeen = false;
                    relay.announce = true;
                    relay.first.completeExceptionally(new IllegalStateException("link down"));
                }
            }
        } finally {
            lock.unlock();
        }
    }

    /** Ends every subscription to this app's topics with an error event, as at a removal or the switch going off. */
    void endApp(String id, String code) {
        String prefix = APP + id + ":";
        hub.endTopics(key -> key.startsWith(prefix), code);
    }

    /** {@code app:<id>:<topic>}, with a guild member's {@code \0<memberId>} if it's a kept key. */
    static Key parse(String key) {
        if (!key.startsWith(APP)) {
            return null;
        }
        String rest = key.substring(APP.length());
        String memberId = null;
        int scoped = rest.indexOf(SCOPED);
        if (scoped >= 0) {
            memberId = rest.substring(scoped + 1);
            rest = rest.substring(0, scoped);
        }
        int colon = rest.indexOf(':');
        if (colon <= 0 || colon == rest.length() - 1) {
            return null;
        }
        String id = rest.substring(0, colon);
        String topic = rest.substring(colon + 1);
        if (topic.equals("app.summary") || topic.indexOf(':') >= 0) {
            return null;
        }
        return new Key(id, topic, memberId);
    }
}
