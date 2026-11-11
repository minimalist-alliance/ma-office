package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;

/**
 * Whether anyone is looking at the desk ({@code desk.attention.set} and the topic {@code desk.attention}, API.md section
 * 10), and what that changes (ADR 0045). Nobody looking for {@code unseenGrace} cuts the stream's media, so nothing is
 * captured or encoded ({@link BrowserStream#mediaAllowed}). Somebody looking sends the media again and thaws Chromium at
 * once ({@link BrowserFreeze#wake}). The freeze follows whether anyone views the Browser, which is looking at the desk with
 * a Browser window open, a session wanting {@code warm} or {@code live} ({@link BrowserFreeze#viewed}): a desk looked at
 * for its Notebook, with the Browser closed, freezes too. There's one of these per desk.
 *
 * <p><b>The rule.</b> The desk is looked at if any session says so. A session that has never sent
 * {@code desk.attention.set} counts as looking while it wants {@code warm} or {@code live}, which is what a client from
 * before this means by them ({@link BrowserStream#legacySeen}). With nobody saying so, or nobody connected, nobody is.
 * Owner sessions only: the dispatcher and the topic registry refuse an {@code export} one.
 *
 * <p><b>Locks.</b> {@code lock} comes first: the stream's and the freeze's are taken under it, and neither calls in here
 * under its own. The tabs are woken, and the topic published, outside it.
 */
final class DeskAttention implements Topic {

    static final String METHOD = "desk.attention.set";
    static final String TOPIC = "desk.attention";

    /** @param unseenGrace how long nobody has to have looked before the media goes */
    record Timing(Duration unseenGrace) {
        static final Timing DEFAULT = new Timing(Duration.ofSeconds(5));
    }

    private final BrowserStream stream;
    private final BrowserFreeze freeze;
    private final EventHub hub;
    private final Predicate<String> sessionLive;
    private final Runnable lookChanged;
    private final Said device;
    private final Timing timing;
    /** What each session last said, by session id. Read under the stream's lock, so it's never locked itself. */
    private final Map<String, Boolean> said = new ConcurrentHashMap<>();
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition moved = lock.newCondition();
    private final ReentrantLock publishing = new ReentrantLock();
    private volatile boolean seen;
    /** What the freeze was last told. */
    private boolean viewed;
    /** What the stream was last told. */
    private boolean mediaOn = true;
    private long unseenSince;
    private Thread timer;
    private boolean closed;
    private Map<String, Object> lastPublished;

    /** Hears what each session says, its device included, for the phone view ({@link BrowserView#said}). Must not block. */
    @FunctionalInterface
    interface Said {
        void said(String sessionId, boolean seen, BrowserView.Device device);
    }

    /**
     * @param sessionLive so a call that loses a race with its session's end leaves nothing behind
     * @param lookChanged runs, outside any lock here, after {@link #seen} has changed. Must not block
     * @param device hears each call, outside any lock here, before the desk's look is worked out again
     */
    DeskAttention(
            BrowserStream stream,
            BrowserFreeze freeze,
            EventHub hub,
            Predicate<String> sessionLive,
            Runnable lookChanged,
            Said device,
            Timing timing) {
        this.stream = stream;
        this.freeze = freeze;
        this.hub = hub;
        this.sessionLive = sessionLive;
        this.lookChanged = lookChanged;
        this.device = device;
        this.timing = timing;
        this.unseenSince = System.nanoTime();
    }

    void register(RpcDispatcher dispatcher) {
        // Not a mutation: saying the same twice is harmless, and the last word stands.
        dispatcher.register(METHOD, this::set);
        hub.topics().register(TOPIC, this);
    }

    /** Nobody is looking yet, so the media goes in {@code unseenGrace} unless someone does. */
    void start() {
        lock.lock();
        try {
            startTimer();
        } finally {
            lock.unlock();
        }
    }

    void close() {
        lock.lock();
        try {
            closed = true;
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** Somebody is looking at the desk. Never blocks. */
    boolean seen() {
        return seen;
    }

    /** Whether this session has ever said. Never blocks, and takes no lock. */
    boolean attended(String sessionId) {
        return said.containsKey(sessionId);
    }

    private Object set(RpcContext context, Map<String, Object> params) throws RpcException {
        if (!(params.get("seen") instanceof Boolean looking)) {
            throw new RpcException(RpcException.BAD_REQUEST, "seen must be true or false", Map.of("reason", "seen"));
        }
        // Checked before anything changes, so a bad device leaves the call as if it never came.
        BrowserView.Device on = BrowserView.Device.parse(params.get("device"));
        String sessionId = context.principal().sessionId();
        boolean first = said.put(sessionId, looking) == null;
        // Its end may have come first, and then nothing else would take this away.
        if (!sessionLive.test(sessionId)) {
            said.remove(sessionId);
        } else {
            device.said(sessionId, looking, on);
        }
        if (first) {
            stream.attendedChanged();
        }
        recompute();
        return state();
    }

    /** A session has ended: it says nothing any more. */
    void sessionEnded(String sessionId) {
        said.remove(sessionId);
        recompute();
    }

    /** What sessions say, or what they want of the stream, may have changed. Returns quickly. */
    void recompute() {
        boolean changed;
        lock.lock();
        try {
            boolean now = said.containsValue(Boolean.TRUE) || stream.legacySeen();
            changed = now != seen;
            if (changed) {
                seen = now;
                if (now) {
                    setMedia(true);
                    freeze.wake();
                } else {
                    unseenSince = System.nanoTime();
                    startTimer();
                }
                moved.signalAll();
            }
            boolean nowViewed = now && stream.hasViewer();
            if (nowViewed != viewed) {
                viewed = nowViewed;
                freeze.viewed(nowViewed);
            }
        } finally {
            lock.unlock();
        }
        if (changed) {
            lookChanged.run();
            publish();
        }
    }

    /** Sends {@code desk.attention} if what it says has changed. Runs on whatever thread changed it, outside its locks. */
    void publish() {
        publishing.lock();
        try {
            Map<String, Object> now = state();
            if (now.equals(lastPublished)) {
                return;
            }
            lastPublished = now;
            hub.publish(TOPIC, "snapshot", now);
        } finally {
            publishing.unlock();
        }
    }

    private Map<String, Object> state() {
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("seen", seen);
        state.put("frozen", freeze.frozen());
        return state;
    }

    /** With the lock held. */
    private void setMedia(boolean on) {
        if (mediaOn != on) {
            mediaOn = on;
            stream.mediaAllowed(on);
        }
    }

    /** With the lock held. One timer at most, and only while the media is on and nobody looks. */
    private void startTimer() {
        if (timer == null && !closed) {
            timer = Thread.ofVirtual().name("desk-attention").start(this::timeout);
        }
    }

    private void timeout() {
        lock.lock();
        try {
            while (!closed && !seen && mediaOn) {
                long left = unseenSince + timing.unseenGrace().toNanos() - System.nanoTime();
                if (left <= 0) {
                    setMedia(false);
                    break;
                }
                moved.awaitNanos(left);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            timer = null;
            lock.unlock();
        }
    }

    // ---- the topic

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        return state();
    }
}
