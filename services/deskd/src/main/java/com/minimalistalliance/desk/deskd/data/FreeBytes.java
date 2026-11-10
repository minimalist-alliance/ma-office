package com.minimalistalliance.desk.deskd.data;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The bytes an export costs the member nothing for (draft ADR, decision 8): every frame byte, header included, that deskd
 * hands to desk-rtc for an {@code export} session's data.read transfer, while {@link FreeBudget} has room, since this
 * process started. The heartbeat carries it as {@code media.freeBytesSent}, and {@code /run/desk/free-bytes} has it for
 * desk-egress, as one line, {@code <bootId> <bytes>}.
 *
 * <p><b>The file</b> is rewritten whole, through a temporary file renamed over it, so a reader sees one line or the one
 * before, and at most once per {@code every} while the count changes, by a one-shot timer that exists only then. Nothing
 * here follows a link: the temporary name is removed first and then made new, and a rename replaces a link, not what it
 * names. rtc owns that directory, so it can change the file, which counts for nothing here, as deskd never reads it.
 * A failure is one log line until a write works again, and never stops a transfer.
 *
 * <p><b>Counted when handed over:</b> a frame counts once it's queued for desk-rtc. A session that ends with frames still
 * queued counts those too, at most a few hundred KiB, as the transfers keep their queues short.
 */
final class FreeBytes {

    static final String NAME = "free-bytes";
    static final Duration EVERY = Duration.ofSeconds(10);

    private static final Logger log = LoggerFactory.getLogger(FreeBytes.class);

    private final Path file;
    private final Path temporary;
    private final Supplier<String> bootId;
    private final Duration every;
    private final AtomicLong total = new AtomicLong();
    /** For the timer. Never held across a write, so {@link #add} never waits on the file. */
    private final ReentrantLock lock = new ReentrantLock();
    /** One write at a time: the timer's, or the last one. */
    private final ReentrantLock writing = new ReentrantLock();
    /** Guarded by lock. */
    private Thread timer;
    private long lastWriteNanos;
    private boolean writtenBefore;
    /** Guarded by writing. */
    private long written = -1;
    private boolean failing;

    /** @param file null to keep no file, as in tests that don't look at one */
    FreeBytes(Path file, Supplier<String> bootId, Duration every) {
        this.file = file;
        this.temporary = file == null ? null : file.resolveSibling("." + NAME + ".tmp");
        this.bootId = bootId;
        this.every = every;
    }

    /** Never blocks. */
    void add(long bytes) {
        total.addAndGet(bytes);
        if (file == null) {
            return;
        }
        lock.lock();
        try {
            if (timer != null) {
                return;
            }
            long now = System.nanoTime();
            long wait = writtenBefore ? Math.max(0, lastWriteNanos + every.toNanos() - now) : 0;
            timer = Thread.ofVirtual().name("free-bytes").start(() -> {
                try {
                    Thread.sleep(Duration.ofNanos(wait));
                } catch (InterruptedException e) {
                    // close() writes instead.
                    return;
                }
                fire();
            });
        } finally {
            lock.unlock();
        }
    }

    long total() {
        return total.get();
    }

    /** The timer's end. A count added from here on sets the next timer, so nothing added is left unwritten. */
    private void fire() {
        lock.lock();
        try {
            timer = null;
            lastWriteNanos = System.nanoTime();
            writtenBefore = true;
        } finally {
            lock.unlock();
        }
        write();
    }

    /** On the way out: the timer goes, and what's counted is written now. */
    void close() {
        Thread pending;
        lock.lock();
        try {
            pending = timer;
            timer = null;
        } finally {
            lock.unlock();
        }
        if (pending != null) {
            pending.interrupt();
        }
        write();
    }

    /** Writes what's counted now, if it isn't what's there. */
    private void write() {
        if (file == null) {
            return;
        }
        writing.lock();
        try {
            long now = total.get();
            if (now == written) {
                return;
            }
            String line = bootId.get() + " " + now + "\n";
            Files.deleteIfExists(temporary);
            Files.write(temporary, line.getBytes(StandardCharsets.US_ASCII),
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            written = now;
            failing = false;
        } catch (IOException | RuntimeException e) {
            if (!failing) {
                failing = true;
                // The class only: a message can carry the path, and that's all it would add.
                log.warn("couldn't write {}, so desk-egress may count export bytes: {}", NAME, e.getClass().getSimpleName());
            }
        } finally {
            writing.unlock();
        }
    }
}
