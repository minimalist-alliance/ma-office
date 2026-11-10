package com.minimalistalliance.desk.agent.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * The {@code agent.*} topics: {@code agent.state} and {@code agent.conversation:<agentId>}. Each has a sequence
 * number. A subscriber gets a {@code snapshot} first, then every later event, in order, with nothing lost or repeated
 * between the two, because both happen under the topic's lock. Delivery must only queue (the socket's writer does).
 */
public final class TopicHub {

    /** Where one subscription's events go. */
    @FunctionalInterface
    public interface Subscriber {
        void event(String topic, long seq, String type, Map<String, Object> data);
    }

    private record Subscription(long sid, Subscriber subscriber) {}

    private static final class Topic {
        final ReentrantLock lock = new ReentrantLock();
        final List<Subscription> subscriptions = new ArrayList<>();
        long seq;
    }

    private final Map<String, Topic> topics = new ConcurrentHashMap<>();
    private final Map<Long, String> topicOf = new ConcurrentHashMap<>();

    /** Subscribes, and sends the snapshot the supplier makes under the topic's lock, at the topic's current seq. */
    public void subscribe(long sid, String topic, Supplier<Map<String, Object>> snapshot, Subscriber subscriber) {
        Topic t = topics.computeIfAbsent(topic, name -> new Topic());
        t.lock.lock();
        try {
            subscriber.event(topic, t.seq, "snapshot", snapshot.get());
            t.subscriptions.add(new Subscription(sid, subscriber));
            topicOf.put(sid, topic);
        } finally {
            t.lock.unlock();
        }
    }

    public void unsubscribe(long sid) {
        String topic = topicOf.remove(sid);
        Topic t = topic == null ? null : topics.get(topic);
        if (t == null) {
            return;
        }
        t.lock.lock();
        try {
            t.subscriptions.removeIf(subscription -> subscription.sid() == sid);
        } finally {
            t.lock.unlock();
        }
    }

    /** Publishes one event to every subscriber of the topic, with the topic's next seq. */
    public void publish(String topic, String type, Map<String, Object> data) {
        Topic t = topics.computeIfAbsent(topic, name -> new Topic());
        t.lock.lock();
        try {
            t.seq++;
            for (Subscription subscription : t.subscriptions) {
                subscription.subscriber().event(topic, t.seq, type, data);
            }
        } finally {
            t.lock.unlock();
        }
    }

    /** Every topic someone is subscribed to now, whose name starts so. */
    public java.util.List<String> subscribed(String prefix) {
        java.util.List<String> names = new java.util.ArrayList<>();
        for (Map.Entry<String, Topic> entry : topics.entrySet()) {
            if (!entry.getKey().startsWith(prefix)) {
                continue;
            }
            Topic t = entry.getValue();
            t.lock.lock();
            try {
                if (!t.subscriptions.isEmpty()) {
                    names.add(entry.getKey());
                }
            } finally {
                t.lock.unlock();
            }
        }
        return names;
    }

    /** The topic's latest seq, for {@code agent.thread.get}. */
    public long seq(String topic) {
        Topic t = topics.get(topic);
        if (t == null) {
            return 0;
        }
        t.lock.lock();
        try {
            return t.seq;
        } finally {
            t.lock.unlock();
        }
    }

    /** Runs the work under the topic's lock, so a snapshot and its seq agree. */
    public <T> T underLock(String topic, Supplier<T> work) {
        Topic t = topics.computeIfAbsent(topic, name -> new Topic());
        t.lock.lock();
        try {
            return work.get();
        } finally {
            t.lock.unlock();
        }
    }
}
