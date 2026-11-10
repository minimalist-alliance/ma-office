package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * The topic {@code files.changes} (files.md section 7): a snapshot of {@code {}} first, then {@code changed} events
 * {@code {dirs, usage, trash}} naming the folders whose listing changed, after any change by any session, merged to at
 * most twice a second. Over 50 folders, {@code dirs} is null and the client refreshes what it shows. Owner only. The
 * sweep's changes use it too.
 */
final class ChangeFeed implements Topic {

    static final String TOPIC = "files.changes";
    static final int MAX_DIRS = 50;
    static final long MERGE_MS = 500;

    private final EventHub hub;
    private final ScheduledExecutorService timer;
    private final Object lock = new Object();
    private final Set<String> dirs = new LinkedHashSet<>();
    private boolean usage;
    private boolean trash;
    private boolean overflow;
    private boolean scheduled;
    private long lastSent = Long.MIN_VALUE;
    private boolean closed;

    ChangeFeed(EventHub hub, ScheduledExecutorService timer) {
        this.hub = hub;
        this.timer = timer;
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
    public Object snapshot(String topicKey, Map<String, Object> params) {
        return Map.of();
    }

    /** A folder's listing changed ({@code ""} for the root). */
    void dir(String path) {
        synchronized (lock) {
            if (dirs.size() >= MAX_DIRS) {
                overflow = true;
            } else {
                dirs.add(path);
            }
            usage = true;
            arm();
        }
    }

    void trash() {
        synchronized (lock) {
            trash = true;
            usage = true;
            arm();
        }
    }

    void usage() {
        synchronized (lock) {
            usage = true;
            arm();
        }
    }

    void close() {
        synchronized (lock) {
            closed = true;
        }
    }

    private void arm() {
        if (scheduled || closed) {
            return;
        }
        scheduled = true;
        long now = System.nanoTime();
        long wait = lastSent == Long.MIN_VALUE ? 0 : Math.max(0, MERGE_MS - TimeUnit.NANOSECONDS.toMillis(now - lastSent));
        try {
            timer.schedule(this::flush, wait, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            scheduled = false;
        }
    }

    /** Sends what has piled up. */
    void flush() {
        List<String> sendDirs;
        boolean over;
        boolean u;
        boolean t;
        synchronized (lock) {
            scheduled = false;
            sendDirs = new ArrayList<>(dirs);
            over = overflow;
            u = usage;
            t = trash;
            dirs.clear();
            overflow = false;
            usage = false;
            trash = false;
            lastSent = System.nanoTime();
        }
        if (sendDirs.isEmpty() && !over && !u && !t) {
            return;
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("dirs", over ? null : sendDirs);
        data.put("usage", u);
        data.put("trash", t);
        hub.publish(TOPIC, "changed", data);
    }
}
