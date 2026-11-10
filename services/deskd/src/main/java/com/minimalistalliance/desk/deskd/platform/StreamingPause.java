package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.time.Clock;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The Platform's bandwidth pause (ma-platform ADR 0095, contract bandwidth.md, "What a desk hears"). While a heartbeat
 * reply or the config says {@code streaming.streamProfile: "paused"}, the Browser sends no video and refuses
 * {@code live}, until {@code resumesAt}, when the pause ends by itself even if no reply comes. Anything else, a reply
 * with no {@code streaming} included, is no pause, so a Platform without the meter changes nothing. The Browser's stream
 * reads this, and so does data.read, which refuses a new read that would reach the meter (API.md section 12). Input,
 * other data channels, Notebook, Chat and Agent never do, and Chromium is never stopped for it.
 *
 * <p>A pause with no {@code resumesAt} lasts until a reply says otherwise. The contract always sends one.
 */
public final class StreamingPause {

    private static final Logger log = LoggerFactory.getLogger(StreamingPause.class);
    private static final String PAUSED = "paused";

    private final Clock clock;
    private final List<Runnable> began = new CopyOnWriteArrayList<>();
    private final ReentrantLock lock = new ReentrantLock();
    /** When it ends, {@link Instant#MAX} if the Platform didn't say, or null for none. */
    private Instant until;

    public StreamingPause(Clock clock) {
        this.clock = clock;
    }

    /**
     * The Platform's word, from a heartbeat reply or the config: the whole {@code streaming} object, or null if there
     * was none. A pause that begins here runs each {@link #onPause} listener on this thread, after the state has
     * changed, so a {@code live} that comes meanwhile is refused or ended, never let through.
     */
    public void apply(Map<String, Object> streaming) {
        Instant next = parse(streaming);
        boolean begins;
        boolean ends;
        lock.lock();
        try {
            Instant now = clock.instant();
            boolean was = active(until, now);
            until = next;
            boolean is = active(until, now);
            begins = is && !was;
            ends = was && !is;
        } finally {
            lock.unlock();
        }
        if (begins) {
            log.info("bandwidth pause: the Browser's stream is off until {}", next.equals(Instant.MAX) ? "the Platform says" : next);
            began.forEach(Runnable::run);
        } else if (ends) {
            log.info("bandwidth pause lifted by the Platform");
        }
    }

    /** @return when the pause ends, {@link Instant#MAX} if the Platform didn't say, or null if there's none now. Never blocks. */
    public Instant pausedUntil() {
        lock.lock();
        try {
            return active(until, clock.instant()) ? until : null;
        } finally {
            lock.unlock();
        }
    }

    /** Runs each time a pause begins. Must not block. */
    public void onPause(Runnable listener) {
        began.add(listener);
    }

    private static boolean active(Instant until, Instant now) {
        return until != null && now.isBefore(until);
    }

    /** A paused profile's end, or null for anything that isn't a pause. A resumesAt that can't be read is no end. */
    private static Instant parse(Map<String, Object> streaming) {
        if (streaming == null || !PAUSED.equals(Json.string(streaming, "streamProfile"))) {
            return null;
        }
        String resumesAt = Json.string(streaming, "resumesAt");
        if (resumesAt == null) {
            return Instant.MAX;
        }
        try {
            return Instant.parse(resumesAt);
        } catch (DateTimeParseException e) {
            return Instant.MAX;
        }
    }
}
