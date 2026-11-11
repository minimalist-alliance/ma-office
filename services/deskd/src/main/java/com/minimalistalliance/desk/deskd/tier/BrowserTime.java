package com.minimalistalliance.desk.deskd.tier;

import com.minimalistalliance.desk.deskd.platform.TierLimits;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Browser time on this desk (ADR 0090, sections 2 to 6): the seconds the Browser is {@code live} to any session, since
 * boot for the heartbeat, and per the member's day on a free desk, which this holds to its minutes.
 *
 * <p><b>What counts.</b> The Browser's video going to at least one session ({@link #live}, from the stream's
 * {@code session.video}): a session wants {@code live} and the desk is looked at (ADR 0045 cuts the media 5 s after nobody
 * is). Once per desk, however many sessions, on the monotonic clock. {@code warm} isn't counted.
 *
 * <p><b>The day.</b> It resets at midnight in the account's {@code agentDefaults.timeZone}, or UTC with none, as the
 * agents' limits do (ADR 0043). A day's reset is fixed when it opens, at its first counted second, so a zone changed
 * mid-day applies from the next, and a day never ends less than {@link #MIN_DAY} after the previous one did: when the
 * next midnight is sooner, it's the one after. A real day (23 to 25 hours) never meets it, so hopping zones daily gains
 * at most an hour a day (money audit D1); a member who moves 2 hours or more east gets one longer day instead of a
 * short one. A second desk counts on its own: the cutoff across desks is the Platform's ({@code browserTime}).
 *
 * <p><b>Kept.</b> The day in {@code /data/desk/browser-time.json}, and the count since boot in a file beside
 * {@code units.sock} ({@code /run/desk}, which a reboot clears and a restart of deskd doesn't), each every
 * {@link #SAVE_EVERY} while counting and whenever counting stops. A crash loses at most that much, in the member's favour.
 *
 * <p><b>Threads.</b> {@link #live} and {@link #limitsChanged} only change state and wake the timer, so they never block and
 * can be called under other locks. The timer thread saves, and runs {@link #onOut} with nothing here held, when the day's
 * time runs out. {@link #outUntil} takes no lock, so the Browser's stream can ask it under its own.
 */
public final class BrowserTime {

    public static final String FILE = "browser-time.json";
    /** The count since boot, beside units.sock. */
    public static final String LIVE_FILE = "browser-live.json";
    static final Duration SAVE_EVERY = Duration.ofSeconds(10);
    static final Duration MIN_DAY = Duration.ofHours(23);
    /** The longest the timer sleeps, so a moved wall clock is seen within it. */
    static final Duration MAX_SLEEP = Duration.ofSeconds(60);
    private static final int MAX_ZONE_CHARS = 64;

    private static final Logger log = LoggerFactory.getLogger(BrowserTime.class);

    /** A day as kept: when it opened, when it ends, the zone it was opened in, and the milliseconds used. */
    record Day(Instant openedAt, Instant resetsAt, String zone, long usedMillis) {}

    /**
     * Today, as /health and the tests see it. With no limits only {@code limited} and {@code live} mean anything.
     *
     * @param resetsAt when today ends, or would if the Browser went live now
     */
    public record View(boolean limited, long usedMillis, long limitMillis, boolean live, boolean out, Instant resetsAt, String zone) {}

    private final Clock clock;
    private final LongSupplier nanos;
    private final Supplier<String> accountZone;
    private final Path file;
    private final Path liveFile;
    private final String bootId;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private final List<Runnable> outListeners = new CopyOnWriteArrayList<>();
    /** Until when today's time is used up; null otherwise. Read without the lock. */
    private volatile Instant outUntil;
    private volatile long liveMillisSinceBoot;

    // The lock's.
    private TierLimits.Limits limits;
    /** The last day opened, which may have ended. */
    private Day day;
    private boolean live;
    private long accruedAtNanos;
    private boolean dayDirty;
    private boolean liveDirty;
    private long savedAtNanos;
    private boolean outTold;
    private Thread timer;
    private boolean closed;
    private boolean poked;
    /** Only whoever writes touches this. */
    private boolean saveFailureLogged;

    /**
     * Reads the files, once, here. Call {@link #start} for the timer.
     *
     * @param file the day's, on the data volume
     * @param liveFile the count since boot's, on a tmpfs that a reboot clears
     * @param bootId this boot's, so a count left by an earlier boot isn't carried on; null for none
     * @param nanos the monotonic clock, {@link System#nanoTime} on a desk
     * @param accountZone the account's {@code agentDefaults.timeZone}, or null. Must not block
     * @param limits what the desk holds now, null for none
     */
    public BrowserTime(
            Path file, Path liveFile, String bootId, Clock clock, LongSupplier nanos, Supplier<String> accountZone, TierLimits.Limits limits) {
        this.file = file;
        this.liveFile = liveFile;
        this.bootId = bootId;
        this.clock = clock;
        this.nanos = nanos;
        this.accountZone = accountZone;
        this.limits = limits;
        this.accruedAtNanos = nanos.getAsLong();
        this.savedAtNanos = accruedAtNanos;
        loadDay();
        loadLive();
        lock.lock();
        try {
            refreshOutLocked(clock.instant());
        } finally {
            lock.unlock();
        }
    }

    public void start() {
        lock.lock();
        try {
            if (timer == null && !closed) {
                timer = Thread.ofVirtual().name("browser-time").start(this::run);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Stops the timer and keeps what's been counted. */
    public void close() {
        Thread running;
        lock.lock();
        try {
            if (closed) {
                return;
            }
            closed = true;
            accrueLocked(clock.instant(), nanos.getAsLong());
            live = false;
            running = timer;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (running != null) {
            running.interrupt();
            try {
                running.join(Duration.ofSeconds(2));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        save(true);
    }

    /** Runs on the timer thread as the day's time is used up. Set before {@link #start}. Must not block for long. */
    public void onOut(Runnable listener) {
        outListeners.add(listener);
    }

    /** Until when today's time is used up, or null while there's time, or no limits. Never blocks, and takes no lock. */
    public Instant outUntil() {
        Instant until = outUntil;
        return until != null && clock.instant().isBefore(until) ? until : null;
    }

    /** Whole seconds the Browser has been live to any session since the desk booted: the heartbeat's. Never blocks. */
    public long liveSecondsSinceBoot() {
        lock.lock();
        try {
            accrueLocked(clock.instant(), nanos.getAsLong());
            return liveMillisSinceBoot / 1000;
        } finally {
            lock.unlock();
        }
    }

    /** Whether the Browser's video goes to any session now. Never blocks: it only changes state and wakes the timer. */
    public void live(boolean now) {
        lock.lock();
        try {
            if (live == now) {
                return;
            }
            accrueLocked(clock.instant(), nanos.getAsLong());
            live = now;
            pokeLocked();
        } finally {
            lock.unlock();
        }
    }

    /** The desk's limits, null for none. Lifting them, or raising them past what's used, lets the Browser go live at once. */
    public void limitsChanged(TierLimits.Limits next) {
        lock.lock();
        try {
            // What was live until now counts by the limits it was live under.
            Instant now = clock.instant();
            accrueLocked(now, nanos.getAsLong());
            limits = next;
            refreshOutLocked(now);
            pokeLocked();
        } finally {
            lock.unlock();
        }
    }

    /** Today, now. */
    public View view() {
        lock.lock();
        try {
            Instant now = clock.instant();
            accrueLocked(now, nanos.getAsLong());
            ZoneId zone = zoneNowLocked();
            Day today = today(now);
            long used = today == null ? 0 : today.usedMillis();
            long limit = limits == null ? 0 : limits.browserMillisPerDay();
            Instant resetsAt = today != null ? today.resetsAt() : boundaryAfter(now, zone, day == null ? null : day.resetsAt());
            return new View(limits != null, used, limit, live, limits != null && today != null && used >= limit, resetsAt,
                    today != null ? today.zone() : zone.getId());
        } finally {
            lock.unlock();
        }
    }

    /**
     * One pass of the timer's work: counts, notices the time running out, and then, outside the lock, saves and tells the
     * listeners. The timer runs it; a test can too, on its own clock.
     */
    void tick() {
        boolean tellOut;
        lock.lock();
        try {
            Instant now = clock.instant();
            accrueLocked(now, nanos.getAsLong());
            refreshOutLocked(now);
            boolean out = outUntil != null;
            tellOut = out && !outTold;
            outTold = out;
        } finally {
            lock.unlock();
        }
        // The moment it runs out is kept at once, so a restart straight after finds it used.
        save(tellOut);
        if (tellOut) {
            log.info("Browser time: today's is used up, until the day resets");
            for (Runnable listener : outListeners) {
                try {
                    listener.run();
                } catch (RuntimeException e) {
                    log.warn("a Browser time listener failed: {}", e.getClass().getSimpleName());
                }
            }
        }
    }

    private void run() {
        while (true) {
            tick();
            lock.lock();
            try {
                if (closed) {
                    return;
                }
                long wait = nextWaitNanosLocked();
                while (!poked && !closed && wait > 0) {
                    wait = wake.awaitNanos(wait);
                }
                poked = false;
                if (closed) {
                    return;
                }
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
        }
    }

    private void pokeLocked() {
        poked = true;
        wake.signalAll();
    }

    /** How long the timer may sleep: until the time runs out, or the next save, while live; else until something changes. */
    private long nextWaitNanosLocked() {
        if (!live) {
            return limits == null ? TimeUnit.DAYS.toNanos(1) : MAX_SLEEP.toNanos();
        }
        long wait = Math.min(MAX_SLEEP.toNanos(), Math.max(1, savedAtNanos + SAVE_EVERY.toNanos() - nanos.getAsLong()));
        if (limits != null && outUntil == null) {
            Instant now = clock.instant();
            Day today = today(now);
            long remaining = limits.browserMillisPerDay() - (today == null ? 0 : today.usedMillis());
            wait = Math.min(wait, TimeUnit.MILLISECONDS.toNanos(Math.max(0, remaining)) + 1);
            if (today != null) {
                wait = Math.min(wait, Math.max(1, Duration.between(now, today.resetsAt()).toNanos()));
            }
        }
        return wait;
    }

    // ---- counting

    /** Adds what's been live since the last time: to the count since boot, and, with limits, into today. */
    private void accrueLocked(Instant now, long nowNanos) {
        long elapsed = nowNanos - accruedAtNanos;
        if (!live || elapsed <= 0) {
            accruedAtNanos = nowNanos;
            return;
        }
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(elapsed);
        // The fraction of a millisecond waits for the next time, so a run of short calls loses nothing.
        accruedAtNanos = nowNanos - (elapsed - TimeUnit.MILLISECONDS.toNanos(elapsedMillis));
        if (elapsedMillis <= 0) {
            return;
        }
        liveMillisSinceBoot += elapsedMillis;
        liveDirty = true;
        if (limits == null) {
            return;
        }
        Day today = today(now);
        if (today == null) {
            if (day != null && day.resetsAt().isAfter(now.minusMillis(elapsedMillis))) {
                // The day ended part way through: what came before its end was the old day's, which no longer matters.
                elapsedMillis = Math.min(elapsedMillis, Duration.between(day.resetsAt(), now).toMillis());
            }
            today = openDayLocked(now);
        }
        day = new Day(today.openedAt(), today.resetsAt(), today.zone(), today.usedMillis() + elapsedMillis);
        dayDirty = true;
    }

    private Day openDayLocked(Instant now) {
        ZoneId zone = zoneNowLocked();
        Instant previous = day == null ? null : day.resetsAt();
        Day opened = new Day(now, boundaryAfter(now, zone, previous), zone.getId(), 0);
        day = opened;
        dayDirty = true;
        log.info("Browser time: a new day, until {} in {}", opened.resetsAt(), zone.getId());
        return opened;
    }

    /** Today's record, or null if the last day has ended or there's none. */
    private Day today(Instant now) {
        return day != null && now.isBefore(day.resetsAt()) ? day : null;
    }

    /**
     * The next midnight after {@code now} in {@code zone}, but never sooner than {@link #MIN_DAY} after {@code previous}
     * (the last day's end): then the midnight after that, so days stay on the member's midnight.
     */
    static Instant boundaryAfter(Instant now, ZoneId zone, Instant previous) {
        Instant next = nextMidnight(now, zone);
        if (previous != null) {
            Instant floor = previous.plus(MIN_DAY);
            while (next.isBefore(floor)) {
                next = nextMidnight(next, zone);
            }
        }
        return next;
    }

    /** The start of the next local date after this instant: {@code atStartOfDay} takes a gap at midnight into account. */
    static Instant nextMidnight(Instant after, ZoneId zone) {
        return after.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant();
    }

    private void refreshOutLocked(Instant now) {
        Day today = today(now);
        boolean out = limits != null && today != null && today.usedMillis() >= limits.browserMillisPerDay();
        outUntil = out ? today.resetsAt() : null;
        if (!out) {
            outTold = false;
        }
    }

    private ZoneId zoneNowLocked() {
        ZoneId account = zoneOf(accountZone.get());
        return account != null ? account : ZoneOffset.UTC;
    }

    /** A zone the JDK knows by this name, or null. */
    static ZoneId zoneOf(String name) {
        if (name == null || name.isEmpty() || name.length() > MAX_ZONE_CHARS) {
            return null;
        }
        try {
            return ZoneId.of(name);
        } catch (DateTimeException e) {
            return null;
        }
    }

    // ---- the files

    private void loadDay() {
        try {
            Map<String, Object> saved = Json.parseObject(Files.readAllBytes(file));
            Map<String, Object> kept = Json.object(saved, "day");
            if (kept != null) {
                Instant openedAt = Instant.parse(Objects.requireNonNull(Json.string(kept, "openedAt")));
                Instant resetsAt = Instant.parse(Objects.requireNonNull(Json.string(kept, "resetsAt")));
                String zone = Json.string(kept, "zone");
                if (!(kept.get("usedMs") instanceof Number used) || used.longValue() < 0 || zoneOf(zone) == null
                        || !resetsAt.isAfter(openedAt)) {
                    throw new IllegalArgumentException("not a day");
                }
                day = new Day(openedAt, resetsAt, zone, used.longValue());
            }
        } catch (NoSuchFileException e) {
            log.debug("Browser time: no day kept yet");
        } catch (Exception e) {
            day = null;
            log.warn("Browser time: the kept day can't be read ({}), so today starts again", e.getClass().getSimpleName());
        }
    }

    private void loadLive() {
        try {
            Map<String, Object> saved = Json.parseObject(Files.readAllBytes(liveFile));
            if (bootId != null && bootId.equals(Json.string(saved, "bootId")) && saved.get("liveMs") instanceof Number ms
                    && ms.longValue() >= 0) {
                liveMillisSinceBoot = ms.longValue();
            }
        } catch (Exception e) {
            // None, an earlier boot's or junk: the count starts at 0, as at a boot.
            log.debug("Browser time: no count kept for this boot");
        }
    }

    /** @param force save whatever has changed, even within {@link #SAVE_EVERY} of the last */
    private void save(boolean force) {
        Map<String, Object> dayRecord = null;
        Map<String, Object> liveRecord = null;
        lock.lock();
        try {
            long now = nanos.getAsLong();
            if (!force && live && now - savedAtNanos < SAVE_EVERY.toNanos()) {
                return;
            }
            if (dayDirty) {
                dayRecord = dayRecordLocked();
                dayDirty = false;
            }
            if (liveDirty && bootId != null) {
                liveRecord = new LinkedHashMap<>();
                liveRecord.put("bootId", bootId);
                liveRecord.put("liveMs", liveMillisSinceBoot);
                liveDirty = false;
            }
            savedAtNanos = now;
        } finally {
            lock.unlock();
        }
        boolean dayFailed = dayRecord != null && !write(file, dayRecord);
        boolean liveFailed = liveRecord != null && !write(liveFile, liveRecord);
        if (dayFailed || liveFailed) {
            lock.lock();
            try {
                dayDirty |= dayFailed;
                liveDirty |= liveFailed;
            } finally {
                lock.unlock();
            }
        }
    }

    private Map<String, Object> dayRecordLocked() {
        Map<String, Object> record = new LinkedHashMap<>();
        if (day == null) {
            record.put("day", null);
            return record;
        }
        Map<String, Object> kept = new LinkedHashMap<>();
        kept.put("openedAt", day.openedAt().toString());
        kept.put("resetsAt", day.resetsAt().toString());
        kept.put("zone", day.zone());
        kept.put("usedMs", day.usedMillis());
        record.put("day", kept);
        return record;
    }

    /** Temporary file, fsynced, renamed over the real one. The timer writes, or close once it's gone. */
    private synchronized boolean write(Path target, Map<String, Object> record) {
        Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
        try {
            Files.deleteIfExists(temporary);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(Json.bytes(record));
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE);
            saveFailureLogged = false;
            return true;
        } catch (IOException | RuntimeException e) {
            if (!saveFailureLogged) {
                saveFailureLogged = true;
                log.warn("Browser time: can't keep it ({})", e.getClass().getSimpleName());
            }
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException | RuntimeException again) {
                log.debug("Browser time: the temporary file stays until the next save");
            }
            return false;
        }
    }
}
