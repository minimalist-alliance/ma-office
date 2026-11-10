package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * How much of an export costs the member nothing (the draft ADR, decision 8): frame bytes of {@code export}-scope
 * transfers, up to {@value #VOLUMES} times the data volume's size in 30 days, which covers a full export, a move and
 * retries. Any member can get an {@code export} token, so without this a client looping data.read would never reach a
 * bandwidth limit. A byte past it isn't added to {@link FreeBytes}, so it reaches the Platform's meter. It's kept here on
 * the desk, so neither the Platform nor the contract has to change.
 *
 * <p><b>The window</b> starts at the first free byte and ends 30 days later, and the next free byte starts another.
 *
 * <p><b>The file</b> keeps a restart from refilling it. It's written whole through a temporary file, synced and renamed
 * over it, at most once per {@code every} while bytes are counted, by a one-shot timer that exists only then, and on the
 * way out. So a crash forgets at most that long's count. It's believed only as far as it's checked: one that's missing or
 * can't be read starts a new window, and a start in the future is taken as now, which keeps the count and never makes a
 * window longer than 30 days. A failure to write is one log line until a write works again, and never stops a transfer.
 *
 * <p><b>The volume's size</b> is read as this is made and on each timer, never for a frame. Until it's known, the budget
 * goes by {@link #DEFAULT_VOLUME_BYTES}, as an export has to work on a desk that can't say.
 */
final class FreeBudget {

    static final String NAME = "free-export.json";
    static final int VOLUMES = 3;
    static final Duration WINDOW = Duration.ofDays(30);
    static final Duration EVERY = Duration.ofMinutes(1);
    /** The size of a desk's data volume today: pricing#current's deskDataVolumeGb. */
    static final long DEFAULT_VOLUME_BYTES = 32L * 1024 * 1024 * 1024;
    /** The real one is about 60 bytes. */
    private static final int MAX_FILE_BYTES = 4096;

    private static final Logger log = LoggerFactory.getLogger(FreeBudget.class);

    private record Window(Instant startedAt, long usedBytes) {}

    private final Path file;
    private final Path temporary;
    private final LongSupplier volumeBytes;
    private final Clock clock;
    private final Duration every;
    /** Only ever held for the sums below, so {@link #take} never waits on the disk. */
    private final ReentrantLock lock = new ReentrantLock();
    /** One write at a time: the timer's, or the last one. Taken before {@link #lock}, never while it's held. */
    private final ReentrantLock writing = new ReentrantLock();
    /** Guarded by lock. */
    private long capBytes = VOLUMES * DEFAULT_VOLUME_BYTES;
    /** Null while no window is open. */
    private Instant startedAt;
    private long usedBytes;
    private Thread timer;
    private boolean saidUsedUp;
    /** Guarded by writing. */
    private Window written;
    private boolean failing;

    /**
     * Reads the file, once, here: this is made as deskd starts, and nothing is sent yet.
     *
     * @param file usually /data/desk/free-export.json
     * @param volumeBytes the data volume's size, or 0 if it can't be known. May be slow
     * @param every the least time between two writes of the file
     */
    FreeBudget(Path file, LongSupplier volumeBytes, Clock clock, Duration every) {
        this.file = file;
        this.temporary = file.resolveSibling("." + NAME + ".tmp");
        this.volumeBytes = volumeBytes;
        this.clock = clock;
        this.every = every;
        readVolume();
        written = load();
        if (written != null) {
            Instant now = clock.instant();
            startedAt = written.startedAt().isAfter(now) ? now : written.startedAt();
            usedBytes = written.usedBytes();
        }
    }

    /**
     * Counts a frame that has just been handed over, for as much of it as the budget has room for. Runs for each frame of
     * an export, so it's sums under a lock nothing slow ever holds.
     *
     * @return how many of these bytes are free: all of them, none, or the part before the cap
     */
    long take(long bytes) {
        long free;
        Instant usedUpUntil = null;
        lock.lock();
        try {
            Instant now = clock.instant();
            endIfOver(now);
            free = Math.min(bytes, Math.max(0, capBytes - usedBytes));
            if (free > 0) {
                if (startedAt == null) {
                    startedAt = now;
                }
                usedBytes += free;
                armTimer();
            }
            if (free < bytes && !saidUsedUp) {
                saidUsedUp = true;
                usedUpUntil = startedAt.plus(WINDOW);
            }
        } finally {
            lock.unlock();
        }
        if (usedUpUntil != null) {
            log.info("free export budget used up: export bytes reach the bandwidth meter until {}", usedUpUntil);
        }
        return free;
    }

    /** Whether the next export byte would be free. Doesn't count anything or start a window. Never waits on the disk. */
    boolean hasRoom() {
        lock.lock();
        try {
            endIfOver(clock.instant());
            return usedBytes < capBytes;
        } finally {
            lock.unlock();
        }
    }

    long capBytes() {
        lock.lock();
        try {
            return capBytes;
        } finally {
            lock.unlock();
        }
    }

    long usedBytes() {
        lock.lock();
        try {
            endIfOver(clock.instant());
            return usedBytes;
        } finally {
            lock.unlock();
        }
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
        save();
    }

    /** With the lock held. */
    private void endIfOver(Instant now) {
        if (startedAt != null && !now.isBefore(startedAt.plus(WINDOW))) {
            startedAt = null;
            usedBytes = 0;
            saidUsedUp = false;
        }
    }

    /** With the lock held. */
    private void armTimer() {
        if (timer != null) {
            return;
        }
        timer = Thread.ofVirtual().name("free-budget").start(() -> {
            try {
                Thread.sleep(every);
            } catch (InterruptedException e) {
                // close() writes instead.
                return;
            }
            fire();
        });
    }

    /** The timer's end. A byte counted from here on sets the next timer, so nothing counted is left unwritten. */
    private void fire() {
        lock.lock();
        try {
            timer = null;
        } finally {
            lock.unlock();
        }
        readVolume();
        save();
    }

    private void readVolume() {
        long size = volumeBytes.getAsLong();
        if (size <= 0) {
            return;
        }
        lock.lock();
        try {
            // The JDK says Long.MAX_VALUE for a file system too large to count.
            capBytes = size > Long.MAX_VALUE / VOLUMES ? Long.MAX_VALUE : VOLUMES * size;
        } finally {
            lock.unlock();
        }
    }

    /** Writes what's counted now, if it isn't what's there. A window that has ended needs nothing: the file says it has. */
    private void save() {
        writing.lock();
        try {
            Window now;
            lock.lock();
            try {
                now = new Window(startedAt, usedBytes);
            } finally {
                lock.unlock();
            }
            if (now.startedAt() == null || now.equals(written)) {
                return;
            }
            write(now);
            written = now;
            failing = false;
        } catch (IOException | RuntimeException e) {
            if (!failing) {
                failing = true;
                // The class only: a message can carry the path, and that's all it would add.
                log.warn("couldn't write {}, so a restart could refill part of the free export budget: {}", NAME, e.getClass().getSimpleName());
            }
            removeTemporary();
        } finally {
            writing.unlock();
        }
    }

    private void write(Window window) throws IOException {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("startedAt", window.startedAt().toString());
        fields.put("usedBytes", window.usedBytes());
        ByteBuffer bytes = ByteBuffer.wrap(Json.bytes(fields));
        // CREATE_NEW follows no link, and a rename replaces a link rather than what it names.
        Files.deleteIfExists(temporary);
        try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            while (bytes.hasRemaining()) {
                channel.write(bytes);
            }
            channel.force(true);
        }
        Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    /** It's in the desk part, so it shouldn't linger for an export to list. */
    private void removeTemporary() {
        try {
            Files.deleteIfExists(temporary);
        } catch (IOException | RuntimeException e) {
            // The next write removes it first, and the log line has been said.
        }
    }

    /** @return null to start fresh: no file, or one that isn't what this writes, which logs one line and no contents */
    private Window load() {
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > MAX_FILE_BYTES) {
                return ignored("not a small regular file");
            }
            Map<String, Object> fields = Json.parseObject(Files.readAllBytes(file));
            String started = Json.string(fields, "startedAt");
            long used = DataHelperClient.wholeNumber(fields.get("usedBytes"));
            if (started == null || used < 0) {
                return ignored("missing fields");
            }
            return new Window(Instant.parse(started), used);
        } catch (NoSuchFileException e) {
            return null;
        } catch (JsonFormatException e) {
            return ignored("not a JSON object");
        } catch (IOException | RuntimeException e) {
            return ignored(e.getClass().getSimpleName());
        }
    }

    private static Window ignored(String why) {
        log.warn("{} ignored, so the free export budget starts again: {}", NAME, why);
        return null;
    }
}
