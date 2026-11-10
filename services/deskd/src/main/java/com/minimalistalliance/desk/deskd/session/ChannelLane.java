package com.minimalistalliance.desk.deskd.session;

import java.util.ArrayDeque;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;

/**
 * Frames of one (session, channel), handled in order on a virtual thread that exists only while
 * there's work. The rtc reader only adds to this, so it never waits. Credit bounds the queue: the
 * peer can't send more than its window ahead of what has been handled.
 */
final class ChannelLane {

    private final ReentrantLock lock = new ReentrantLock();
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private final Consumer<byte[]> handler;
    private Thread running;
    private boolean stopped;

    ChannelLane(Consumer<byte[]> handler) {
        this.handler = handler;
    }

    void enqueue(byte[] frame) {
        lock.lock();
        try {
            if (stopped) {
                return;
            }
            queue.addLast(frame);
            if (running == null) {
                running = Thread.ofVirtual().name("session-lane").start(this::drain);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Drops what's queued and wakes the handler if it's parked on something. */
    void stop() {
        lock.lock();
        try {
            stopped = true;
            queue.clear();
            if (running != null && running != Thread.currentThread()) {
                running.interrupt();
            }
        } finally {
            lock.unlock();
        }
    }

    private void drain() {
        while (true) {
            byte[] frame;
            lock.lock();
            try {
                frame = queue.pollFirst();
                if (frame == null) {
                    running = null;
                    return;
                }
            } finally {
                lock.unlock();
            }
            handler.accept(frame);
        }
    }
}
