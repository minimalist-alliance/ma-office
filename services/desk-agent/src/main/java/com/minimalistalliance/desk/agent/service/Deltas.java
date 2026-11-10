package com.minimalistalliance.desk.agent.service;

import java.time.Duration;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;

/**
 * One reply's text as it streams: what came so far, for {@code agent.thread.get}, and the new part sent on at most
 * every 33 ms, which is design 4.2.5's 30 Hz for text deltas. A delta that arrives within 33 ms of the last flush
 * waits for a timer, so a stream that pauses still sends what it had.
 *
 * <p>{@code flush} publishes on the conversation's topic, so it takes the topic's lock, and {@code agent.thread.get}
 * and a subscription's snapshot call {@link #text} under that same lock. So {@code flush} never runs under
 * {@link #lock}: a flush takes what's pending under it, lets it go, and then sends. {@link #sending} keeps flushes one
 * at a time, so they go out in the order they were taken. Nothing takes {@link #sending} while holding a topic's lock
 * or {@link #lock}.
 */
final class Deltas {

    static final Duration EVERY = Duration.ofMillis(33);

    private final ReentrantLock lock = new ReentrantLock();
    /** One flush at a time, held from taking what's pending until it's sent. */
    private final ReentrantLock sending = new ReentrantLock();
    private final Consumer<String> flush;
    private final StringBuilder all = new StringBuilder();
    private final StringBuilder pending = new StringBuilder();
    private long lastFlush;
    private boolean timerArmed;
    private boolean closed;

    Deltas(Consumer<String> flush) {
        this.flush = flush;
    }

    void add(String text) {
        boolean due;
        lock.lock();
        try {
            if (closed) {
                return;
            }
            all.append(text);
            pending.append(text);
            long now = System.nanoTime();
            due = now - lastFlush >= EVERY.toNanos();
            if (due) {
                lastFlush = now;
            } else if (!timerArmed) {
                timerArmed = true;
                long wait = EVERY.toNanos() - (now - lastFlush);
                Thread.ofVirtual().name("deltas").start(() -> {
                    try {
                        Thread.sleep(Duration.ofNanos(wait));
                    } catch (InterruptedException e) {
                        return;
                    }
                    lock.lock();
                    try {
                        timerArmed = false;
                    } finally {
                        lock.unlock();
                    }
                    send(false);
                });
            }
        } finally {
            lock.unlock();
        }
        if (due) {
            send(false);
        }
    }

    /**
     * Takes what's pending under {@link #lock} and sends it after letting that go, under {@link #sending}. With
     * {@code closing}, it's the last: nothing is taken after it.
     */
    private void send(boolean closing) {
        sending.lock();
        try {
            String text;
            lock.lock();
            try {
                if (closed) {
                    return;
                }
                closed = closing;
                if (pending.isEmpty()) {
                    return;
                }
                text = pending.toString();
                pending.setLength(0);
                lastFlush = System.nanoTime();
            } finally {
                lock.unlock();
            }
            flush.accept(text);
        } finally {
            sending.unlock();
        }
    }

    /** Sends what's pending and takes no more: the reply's final message follows, once this returns. */
    void close() {
        send(true);
    }

    String text() {
        lock.lock();
        try {
            return all.toString();
        } finally {
            lock.unlock();
        }
    }
}
