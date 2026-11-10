package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcException;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The desk's clipboard for clients: {@code browser.clipboard.write}, {@code browser.clipboard.read} and the topic
 * {@value #TOPIC} (API.md section 10, "The clipboard"). desk-rtc holds X's CLIPBOARD, text only and never PRIMARY,
 * and this is what gates it. The text only ever travels on a session's own rpc channel, and nothing here logs it, its
 * length or anything that would tell that.
 *
 * <p><b>Who.</b> Owner sessions only. A write needs the token's input, and a read or the topic video and input both,
 * since the clipboard can hold what was never on screen. Each is read live: again once a write's turn comes, and
 * again before a read's text goes out. A page on the desk has no way here: these exist only on the rpc channel of a
 * session whose token deskd checked, and deskd has no TCP listener.
 *
 * <p><b>Writes</b> go one at a time, in the order they came, as rtc.sock wants. At most {@link #MAX_WRITES} wait or
 * run at once, as each holds its request until it's done.
 *
 * <p><b>Reads</b> share. One that comes while another is waiting its turn gets that one's answer, as that get goes
 * after both came. So at most one get is out and one waits, however many sessions ask, and each caller's own token
 * decides whether it gets the text.
 *
 * <p><b>The topic</b> has no state, so no first event, and a {@code changed} lost to a client falling behind stays
 * lost. desk-rtc sends {@code clipboard.changed} only while some session is subscribed, which {@link
 * #subscribersChanged} keeps it told of, on every connection. Events are coalesced to {@code Timing.changedEvery}.
 */
final class BrowserClipboard implements Topic {

    static final String TOPIC = "browser.clipboard";
    /** Writes waiting or running at once on the desk: one for each session's worth of pastes. */
    static final int MAX_WRITES = 4;

    private static final Logger log = LoggerFactory.getLogger(BrowserClipboard.class);
    private static final String OWNER = "owner";

    /**
     * deskd's own waits, for a desk-rtc that says nothing at all, as one too old for the clipboard does. desk-rtc
     * answers by itself within its own bounds (desk-rtc/README.md, "How long to wait"), so these are past them.
     *
     * @param setWait past a set's worst: 5 s for an X server that has stopped answering, and 5 s more for a dial to it
     * @param getWait past a get's worst: a dial's 5 s, then 15 s for a whole transfer
     * @param changedEvery the smallest gap between two {@code changed} events
     */
    record Timing(Duration setWait, Duration getWait, Duration changedEvery) {
        static final Timing DEFAULT = new Timing(Duration.ofSeconds(12), Duration.ofSeconds(25), Duration.ofMillis(250));
    }

    /** A read's answer: the text, null for none, or the error every caller of that round gets. */
    private record Outcome(String text, RpcException error) {}

    /** One get, and everyone who came while it waited its turn. */
    private static final class Round {
        final CompletableFuture<Outcome> done = new CompletableFuture<>();
    }

    private final RtcClient rtc;
    private final EventHub hub;
    private final Timing timing;
    private final ReentrantLock writeTurn = new ReentrantLock(true);
    private final AtomicInteger writes = new AtomicInteger();
    private final ReentrantLock readLock = new ReentrantLock();
    /** Guarded by readLock: the get that's out, and the one that waits for it. */
    private Round reading;
    private Round waiting;
    private final ReentrantLock watchLock = new ReentrantLock();
    private final AtomicBoolean watchDue = new AtomicBoolean();
    private final ReentrantLock changedLock = new ReentrantLock();
    /** Guarded by changedLock. */
    private boolean changedDue;
    private long lastChangedNanos;

    BrowserClipboard(RtcClient rtc, EventHub hub, Timing timing) {
        this.rtc = rtc;
        this.hub = hub;
        this.timing = timing;
        this.lastChangedNanos = System.nanoTime() - timing.changedEvery().toNanos();
        rtc.onClipboardChanged(this::changed);
    }

    /**
     * @param freeze each call is work, and thaws Chromium first, as Chromium may own the selection a read asks for, and a
     *     paste is the member at work (ADR 0045). The topic isn't: desk-rtc watches X for it, which a frozen Chromium
     *     doesn't change
     */
    void register(RpcDispatcher dispatcher, BrowserFreeze freeze) {
        // Neither is a mutation: setting the same text twice is harmless, and the last to arrive wins.
        dispatcher.register("browser.clipboard.write", BrowserMethods.working(freeze, this::write));
        dispatcher.register("browser.clipboard.read", BrowserMethods.working(freeze, this::read));
        hub.topics().register(TOPIC, this);
    }

    // ---- write

    private Object write(RpcContext context, Map<String, Object> params) throws Exception {
        requireWrite(context.principal());
        if (!(params.get("text") instanceof String text)) {
            throw badText();
        }
        ClipboardText.Measure measure = ClipboardText.measure(text);
        if (!measure.wholeCharacters()) {
            throw badText();
        }
        if (measure.utf8Bytes() > ClipboardText.MAX_BYTES) {
            throw tooLarge();
        }
        if (measure.emptyWithoutNul()) {
            return Map.of();
        }
        if (writes.incrementAndGet() > MAX_WRITES) {
            writes.decrementAndGet();
            throw new RpcException(RpcException.RATE_LIMITED, "Too many clipboard writes at once", Map.of("limit", "clipboard"));
        }
        try {
            writeTurn.lockInterruptibly();
            try {
                // The token as it is now, and only now the bytes, so a write waiting its turn holds no more than its request.
                requireWrite(context.principal());
                rtc.clipboardSet(ClipboardText.toDesk(text, measure), timing.setWait());
                return Map.of();
            } catch (RtcException e) {
                // Every failure means the text may not be there, so the client mustn't send the paste key.
                throw display();
            } finally {
                writeTurn.unlock();
            }
        } finally {
            writes.decrementAndGet();
        }
    }

    // ---- read

    private Object read(RpcContext context, Map<String, Object> params) throws Exception {
        requireRead(context.principal());
        Outcome outcome;
        try {
            outcome = join().done.get();
        } catch (ExecutionException e) {
            throw new IllegalStateException("a read round failed", null);
        }
        // A refresh while the get was out may have taken away what this needs, and the text goes nowhere then.
        requireRead(context.principal());
        if (outcome.error() != null) {
            throw outcome.error();
        }
        return Collections.singletonMap("text", outcome.text());
    }

    private Round join() {
        readLock.lock();
        try {
            if (waiting == null) {
                waiting = new Round();
            }
            Round mine = waiting;
            if (reading == null) {
                startWaiting();
            }
            return mine;
        } finally {
            readLock.unlock();
        }
    }

    /** With readLock held. */
    private void startWaiting() {
        Round round = waiting;
        reading = round;
        waiting = null;
        Thread.ofVirtual().name("clipboard-read").start(() -> fetch(round));
    }

    private void fetch(Round round) {
        Outcome outcome = new Outcome(null, display());
        try {
            outcome = outcomeOf(rtc.clipboardGet(ClipboardText.MAX_BYTES, timing.getWait()));
        } catch (RtcException e) {
            outcome = new Outcome(null, readError(e.code()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException | Error e) {
            log.error("clipboard read failed: {}", e.getClass().getName());
            outcome = new Outcome(null, new RpcException(RpcException.INTERNAL, "Internal error"));
        } finally {
            round.done.complete(outcome);
            readLock.lock();
            try {
                reading = null;
                if (waiting != null) {
                    startWaiting();
                }
            } finally {
                readLock.unlock();
            }
        }
    }

    /** Cleaned once for everyone in the round. Over the cap is refused whole: never a cut piece. */
    private static Outcome outcomeOf(byte[] raw) {
        String text = raw == null ? null : ClipboardText.fromDesk(raw);
        if (text == null) {
            return new Outcome(null, null);
        }
        if (ClipboardText.utf8Length(text) > ClipboardText.MAX_BYTES) {
            return new Outcome(null, tooLarge());
        }
        if (ClipboardText.replyJsonBytes(text) > FrameKind.RES.maxMessageBytes()) {
            return new Outcome(null, new RpcException(RpcException.TOO_LARGE, "Result too large"));
        }
        return new Outcome(text, null);
    }

    private static RpcException readError(String code) {
        return switch (code) {
            case "too_large" -> tooLarge();
            // Whatever holds the clipboard didn't answer, or desk-rtc couldn't take this just now.
            case "timeout", "internal" -> new RpcException(
                    RpcException.UNAVAILABLE, "The clipboard's owner didn't answer", Map.of("reason", "clipboard"));
            default -> display();
        };
    }

    // ---- the topic

    @Override
    public boolean coalescible() {
        return true;
    }

    /** Nothing is kept for a client that's away, so since can't be served. */
    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        requireRead(principal);
    }

    /** No state, so no first event, and nothing to stand in for one that was lost. */
    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        return NO_SNAPSHOT;
    }

    /**
     * Tells desk-rtc whether to watch, on a thread of its own, since the caller may hold anything. Each settle reads
     * who's subscribed after clearing its flag, and they take turns, so the last one sent is always the latest.
     */
    @Override
    public void subscribersChanged() {
        if (watchDue.compareAndSet(false, true)) {
            Thread.ofVirtual().name("clipboard-watch").start(this::settleWatch);
        }
    }

    private void settleWatch() {
        watchLock.lock();
        try {
            watchDue.set(false);
            rtc.clipboardWatch(hub.hasSubscribers(TOPIC));
        } finally {
            watchLock.unlock();
        }
    }

    /** On the rtc reader, so it only schedules. The first after a quiet spell goes at once, and the last always goes. */
    private void changed() {
        changedLock.lock();
        try {
            if (changedDue) {
                return;
            }
            changedDue = true;
        } finally {
            changedLock.unlock();
        }
        Thread.ofVirtual().name("clipboard-changed").start(this::publishChanged);
    }

    private void publishChanged() {
        try {
            long wait;
            changedLock.lock();
            try {
                wait = lastChangedNanos + timing.changedEvery().toNanos() - System.nanoTime();
            } finally {
                changedLock.unlock();
            }
            if (wait > 0) {
                TimeUnit.NANOSECONDS.sleep(wait);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            changedLock.lock();
            try {
                changedDue = false;
                lastChangedNanos = System.nanoTime();
            } finally {
                changedLock.unlock();
            }
        }
        hub.publish(TOPIC, "changed", Map.of());
    }

    // ---- checks and errors

    private static void requireWrite(RpcPrincipal principal) throws RpcException {
        if (!OWNER.equals(principal.scope()) || !principal.input()) {
            throw BrowserMethods.forbidden();
        }
    }

    private static void requireRead(RpcPrincipal principal) throws RpcException {
        if (!OWNER.equals(principal.scope()) || !principal.video() || !principal.input()) {
            throw BrowserMethods.forbidden();
        }
    }

    private static RpcException badText() {
        return new RpcException(RpcException.BAD_REQUEST, "text must be a string of whole characters", Map.of("reason", "text"));
    }

    private static RpcException tooLarge() {
        return new RpcException(RpcException.TOO_LARGE, "Text over the cap", Map.of("limit", ClipboardText.MAX_BYTES));
    }

    private static RpcException display() {
        return new RpcException(RpcException.UNAVAILABLE, "The clipboard isn't reachable", Map.of("reason", "display"));
    }
}
