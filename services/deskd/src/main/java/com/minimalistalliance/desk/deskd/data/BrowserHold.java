package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.browser.UnitException;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Who holds the Browser for the last pass of a copy (data.browser.hold, draft ADR decision 5), and until when. Each
 * session's hold lasts until its release, its end, or {@code holdFor}, whichever comes first, and the Browser is held
 * while any session holds it. A second hold from the same session starts its time again.
 *
 * <p><b>Kept after a move</b> (data.browser.keep, Security's NE-2). Once a move has copied the Browser under a hold, its
 * session keeps that hold past its own end, with no time limit, until the owner lets go ({@link #releaseKept}). So this
 * desk's Chromium never runs again on the cookies the member's other desk now has, where a site that rotates its sign-in
 * tokens would sign the member out there. The keep is in {@link #KEPT_FILE}, in deskd's own directory of the data
 * volume, written before it's answered, so it outlives a restart of deskd and a reboot: {@link #restoreKept} holds the
 * Browser again as deskd starts. Nothing here touches {@code /data/browser/profile} (ADR 0035).
 *
 * <p>The Browser module does the holding ({@code BrowserStream.hold}): Chromium is stopped through units.sock and
 * stays stopped, and {@code live} and {@code warm} are refused with {@code reason: held}, or {@code moved} while kept.
 * This only says when.
 *
 * <p>Nothing here blocks under {@link #lock}: the Browser's calls only change its state, and the stop runs on its
 * worker. The kept file is written and removed under {@link #keeping} alone, which is taken before {@link #lock} and
 * never while it's held, so the rtc reader, which ends sessions here, never waits on the disk.
 */
final class BrowserHold {

    /** The file that keeps a move's hold, beside deskd's other files on the data volume: /data/desk/browser-moved.json. */
    static final String KEPT_FILE = "browser-moved.json";
    /** The real one is about 40 bytes. */
    private static final int MAX_KEPT_BYTES = 4096;

    private static final Logger log = LoggerFactory.getLogger(BrowserHold.class);

    /** The Browser module's side. Neither call blocks. */
    interface Browser {
        /** @return completes once Chromium has stopped, or with the unit's failure */
        CompletableFuture<Void> hold();

        void release();
    }

    private static final class Holder {
        final Instant until;
        Thread timer;

        Holder(Instant until) {
            this.until = until;
        }
    }

    private final Browser browser;
    private final Predicate<String> sessionLive;
    private final Duration holdFor;
    private final Duration stopWait;
    private final Path keptFile;
    private final Path keptTemporary;
    private final ReentrantLock lock = new ReentrantLock();
    /** One change of the kept file at a time. Taken before {@link #lock}, never while it's held. */
    private final ReentrantLock keeping = new ReentrantLock();
    private final Map<String, Holder> holders = new HashMap<>();
    /** Told after a session's hold begins or ends, under {@link #lock}. Must not block. */
    private volatile Runnable holdsChanged = () -> {};
    /** When a move kept the Browser held, or null. Written under {@link #lock}, read anywhere. */
    private volatile Instant keptSince;
    /** How many times the Browser has been let go. Guarded by {@link #lock}. */
    private long lettingsGo;

    /**
     * @param holdFor how long a hold lasts without a release: 30 minutes
     * @param stopWait how long a hold waits for Chromium to stop, past units.sock's own limit
     * @param keptFile usually /data/desk/browser-moved.json
     */
    BrowserHold(Browser browser, Predicate<String> sessionLive, Duration holdFor, Duration stopWait, Path keptFile) {
        this.browser = browser;
        this.sessionLive = sessionLive;
        this.holdFor = holdFor;
        this.stopWait = stopWait;
        this.keptFile = keptFile;
        this.keptTemporary = keptFile.resolveSibling("." + KEPT_FILE + ".tmp");
    }

    /**
     * As deskd starts, once everything is wired and before anything can call: a move's hold that an earlier deskd kept
     * holds the Browser again. The stop goes out on the Browser's worker, and does nothing to a Chromium that isn't
     * running, as after a reboot. A stop that fails leaves it held all the same, as a start is what it must never ask for.
     */
    void restoreKept() {
        Instant since = loadKept();
        if (since == null) {
            return;
        }
        CompletableFuture<Void> stopped;
        lock.lock();
        try {
            keptSince = since;
            stopped = browser.hold();
        } finally {
            lock.unlock();
        }
        log.info("the Browser stays held: this desk was moved at {}, and only its owner can let go", since);
        stopped.whenComplete((ok, failure) -> {
            if (failure != null) {
                log.warn("the stop for a moved desk's hold failed, so Chromium may still be up; it isn't started: {}",
                        failure.getClass().getSimpleName());
            }
        });
    }

    /**
     * Holds the Browser for this session and waits for Chromium to have stopped. The caller has called beginEffect.
     *
     * @return {@code {held: true, until}}
     * @throws RpcException unavailable, {@code reason: chromium}, if the stop failed, and then this session doesn't hold it
     */
    Map<String, Object> hold(String sessionId) throws RpcException, InterruptedException {
        Holder holder;
        CompletableFuture<Void> stopped;
        lock.lock();
        try {
            // Its end has been heard already, or will be once this lets go, and that would let go of this hold.
            if (!sessionLive.test(sessionId)) {
                throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
            }
            boolean first = holders.isEmpty() && keptSince == null;
            Holder previous = holders.remove(sessionId);
            if (previous != null) {
                previous.timer.interrupt();
            }
            holder = new Holder(Instant.now().plus(holdFor).truncatedTo(ChronoUnit.SECONDS));
            Holder armed = holder;
            holder.timer = Thread.ofVirtual().name("browser-hold").start(() -> expire(sessionId, armed));
            holders.put(sessionId, holder);
            holdsChanged.run();
            stopped = browser.hold();
            if (first) {
                log.info("the Browser is held for a copy of its profile");
            }
        } finally {
            lock.unlock();
        }
        try {
            stopped.get(stopWait.toNanos(), TimeUnit.NANOSECONDS);
        } catch (ExecutionException | TimeoutException e) {
            drop(sessionId, holder);
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("reason", "chromium");
            if (e.getCause() instanceof UnitException failure) {
                details.put("code", failure.code());
            }
            throw new RpcException(RpcException.UNAVAILABLE, "Chromium couldn't be stopped", details);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("held", true);
        result.put("until", holder.until.toString());
        return result;
    }

    /**
     * Keeps this session's hold after the session, with no time limit, until the owner lets go: what a move does once
     * its last pass over the Browser is done. The file is written first, and the keep counts only if the Browser was held
     * by this session the whole time, so Chromium can't have run between the copy and the keep. Kept again, it's the same
     * keep, from now. The caller has called beginEffect.
     *
     * @return {@code {held: true, kept: true, since}}
     * @throws RpcException unavailable, {@code reason: not_held}, if this session doesn't hold the Browser, or lost its hold
     *     while this ran; {@code reason: disk} if the file couldn't be written. Either way nothing is kept
     */
    Map<String, Object> keep(String sessionId) throws RpcException {
        Instant since = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        keeping.lock();
        try {
            long letGoBefore;
            lock.lock();
            try {
                if (!holders.containsKey(sessionId)) {
                    throw notHeld();
                }
                letGoBefore = lettingsGo;
            } finally {
                lock.unlock();
            }
            Instant before = keptSince;
            try {
                writeKept(since);
            } catch (IOException | RuntimeException e) {
                removeQuietly(keptTemporary);
                log.warn("couldn't write {}, so the Browser isn't kept held: {}", KEPT_FILE, e.getClass().getSimpleName());
                throw new RpcException(RpcException.UNAVAILABLE, "The desk couldn't record the keep", Map.of("reason", "disk"));
            }
            lock.lock();
            try {
                if (holders.containsKey(sessionId) && lettingsGo == letGoBefore) {
                    keptSince = since;
                    log.info("the Browser stays held after a move, until its owner lets go");
                    Map<String, Object> result = new LinkedHashMap<>();
                    result.put("held", true);
                    result.put("kept", true);
                    result.put("since", since.toString());
                    return result;
                }
            } finally {
                lock.unlock();
            }
            // Let go of while the file was written, so Chromium may have started: the file goes back to what it was.
            try {
                if (before == null) {
                    removeKept();
                } else {
                    writeKept(before);
                }
            } catch (IOException | RuntimeException e) {
                log.warn("couldn't put {} back after a keep that came too late: {}", KEPT_FILE, e.getClass().getSimpleName());
            }
            throw notHeld();
        } finally {
            keeping.unlock();
        }
    }

    /**
     * Lets go of this session's hold, if it has one.
     *
     * @return {@code {held}}: whether the Browser is still held, which only another session's hold or a kept one makes so
     */
    Map<String, Object> release(String sessionId) {
        lock.lock();
        try {
            Holder holder = holders.remove(sessionId);
            if (holder != null) {
                letGo(holder);
            }
            return Map.of("held", isHeld());
        } finally {
            lock.unlock();
        }
    }

    /**
     * The owner lets go of a move's kept hold, if there is one: the file goes first, so a restart can't bring it back.
     * Chromium comes back as after any hold, unless a session still holds it. Only the owner's sessions may ask
     * (DataMethods).
     *
     * @throws RpcException unavailable, {@code reason: disk}, if the file couldn't be removed, and then it's still kept
     */
    void releaseKept() throws RpcException {
        keeping.lock();
        try {
            if (keptSince == null && !Files.exists(keptFile, LinkOption.NOFOLLOW_LINKS)) {
                return;
            }
            try {
                removeKept();
            } catch (IOException | RuntimeException e) {
                log.warn("couldn't remove {}, so the Browser stays held: {}", KEPT_FILE, e.getClass().getSimpleName());
                throw new RpcException(RpcException.UNAVAILABLE, "The desk couldn't record the release", Map.of("reason", "disk"));
            }
            lock.lock();
            try {
                if (keptSince == null) {
                    return;
                }
                keptSince = null;
                log.info("the owner let go of the Browser's hold after a move");
                if (holders.isEmpty()) {
                    lettingsGo++;
                    browser.release();
                    log.info("the Browser's hold has ended");
                }
            } finally {
                lock.unlock();
            }
        } finally {
            keeping.unlock();
        }
    }

    /** The session has ended. May run on the rtc reader, and never blocks. A kept hold stays. */
    void sessionEnded(String sessionId) {
        release(sessionId);
    }

    void onHoldsChange(Runnable action) {
        holdsChanged = action;
    }

    /** How many sessions hold the Browser now. A hold a move kept past its session is not one: it has no end of its own. */
    int holders() {
        lock.lock();
        try {
            return holders.size();
        } finally {
            lock.unlock();
        }
    }

    /** True while any session holds the Browser, or a move kept it held. */
    boolean held() {
        lock.lock();
        try {
            return isHeld();
        } finally {
            lock.unlock();
        }
    }

    /** When a move kept the Browser held, or null. Takes no lock, so the Browser module may ask under its own. */
    Instant keptSince() {
        return keptSince;
    }

    /** With the lock held. */
    private boolean isHeld() {
        return !holders.isEmpty() || keptSince != null;
    }

    private void expire(String sessionId, Holder holder) {
        try {
            Thread.sleep(holdFor);
        } catch (InterruptedException e) {
            return;
        }
        if (drop(sessionId, holder)) {
            log.info("a hold of the Browser ran out");
        }
    }

    /** @return true if this was still the session's hold */
    private boolean drop(String sessionId, Holder holder) {
        lock.lock();
        try {
            if (!holders.remove(sessionId, holder)) {
                return false;
            }
            letGo(holder);
            return true;
        } finally {
            lock.unlock();
        }
    }

    /** With the lock held, once the holder is out of the table. */
    private void letGo(Holder holder) {
        holdsChanged.run();
        if (holder.timer != Thread.currentThread()) {
            holder.timer.interrupt();
        }
        if (holders.isEmpty()) {
            lettingsGo++;
            if (keptSince == null) {
                browser.release();
                log.info("the Browser's hold has ended");
            }
        }
    }

    private static RpcException notHeld() {
        return new RpcException(RpcException.UNAVAILABLE, "This session doesn't hold the Browser", Map.of("reason", "not_held"));
    }

    /** Whole, through a temporary file, synced and renamed over it, and the directory synced, so a crash keeps one or the other. */
    private void writeKept(Instant since) throws IOException {
        ByteBuffer bytes = ByteBuffer.wrap(Json.bytes(Map.of("since", since.toString())));
        // CREATE_NEW follows no link, and a rename replaces a link rather than what it names.
        Files.deleteIfExists(keptTemporary);
        try (FileChannel channel = FileChannel.open(keptTemporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            while (bytes.hasRemaining()) {
                channel.write(bytes);
            }
            channel.force(true);
        }
        Files.move(keptTemporary, keptFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        syncDirectory();
    }

    private void removeKept() throws IOException {
        Files.deleteIfExists(keptFile);
        syncDirectory();
    }

    private void syncDirectory() {
        try (FileChannel directory = FileChannel.open(keptFile.getParent(), StandardOpenOption.READ)) {
            directory.force(true);
        } catch (IOException | RuntimeException e) {
            // The rename or the removal is done; a crash before the journal has it is all this would have covered.
        }
    }

    private static void removeQuietly(Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException | RuntimeException e) {
            // The next write removes it first.
        }
    }

    /**
     * @return when the desk was moved, or null with no file. A file that's there but can't be read still holds the
     *     Browser, from its modification time or now, as starting Chromium is what this must never get wrong
     */
    private Instant loadKept() {
        BasicFileAttributes attributes;
        try {
            attributes = Files.readAttributes(keptFile, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (IOException | RuntimeException e) {
            return Files.exists(keptFile, LinkOption.NOFOLLOW_LINKS) ? Instant.now().truncatedTo(ChronoUnit.SECONDS) : null;
        }
        Instant fallback = attributes.lastModifiedTime().toInstant().truncatedTo(ChronoUnit.SECONDS);
        if (!attributes.isRegularFile() || attributes.size() > MAX_KEPT_BYTES) {
            log.warn("{} isn't a small regular file, so the Browser stays held from its time", KEPT_FILE);
            return fallback;
        }
        try {
            String since = Json.string(Json.parseObject(Files.readAllBytes(keptFile)), "since");
            if (since != null) {
                return Instant.parse(since);
            }
        } catch (IOException | JsonFormatException | RuntimeException e) {
            // A date Instant can't parse is a RuntimeException too. Below.
        }
        log.warn("{} can't be read, so the Browser stays held from its time", KEPT_FILE);
        return fallback;
    }
}
