package com.minimalistalliance.desk.deskd.idle;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@code /run/desk/idle.json}: whether the desk is idle, for {@code desk-batch}, a root helper that applies Debian's
 * updates and service batches only while it is (desk-runtime.md section 6.1, "Idle"). desk-batch treats the file as
 * hostile and anything wrong in it as "not idle", so it is small and always whole.
 *
 * <p><b>What it holds, and where each count comes from</b> (all of it already known elsewhere in deskd; nothing is
 * derived again here):
 * <ul>
 *   <li>{@code sessions}: client sessions connected, {@code SessionManager.connectedCount}, the heartbeat's
 *       {@code clients.connected}. <b>A Files transfer always has an open session, so it counts here</b>, and is not
 *       counted again in {@code exports}.
 *   <li>{@code agentTasks}: the Agent runs going, {@code agent.activeTasks} of the heartbeat.
 *   <li>{@code exports}: {@code data.*} exports and moves going: the live transfers of {@code export} sessions and the
 *       sessions that hold the Browser for a copy. A hold a move kept after its session is not counted: it lasts until
 *       the owner lets go, and would hold every update back for good.
 *   <li>{@code downloads}: Browser downloads going. deskd cannot see these (desk-units sees them at the moment of a
 *       freeze, ADR 0045), so it says 0. The contract has them hold only a Chromium close or a root swap, never a service
 *       batch.
 *   <li>{@code idleSince}: since when {@code sessions}, {@code agentTasks} and {@code exports} have all been 0, or null.
 *       Kept in memory only, so a restart of deskd starts it again from its first look. Anything that may have changed a
 *       count ({@link #poke}) moves it to that moment if it is later, so a session that opens and closes between two
 *       looks still restarts the clock.
 *   <li>{@code idleStopSeconds}: the config's {@code autoStop.autoStopMinutes} in seconds, or null if it is null
 *       (never stop, a self-hosted desk) or not yet known.
 *   <li>{@code lastInputAt}: the heartbeat's {@code clients.lastInputAt}, or null.
 * </ul>
 *
 * <p><b>Writing</b> is a temporary file in the same directory, made new each time (nothing is followed: the name is
 * removed first, and a rename replaces a link rather than what it names), set to {@code 0644} and renamed over the file,
 * so a reader sees the whole old file or the whole new one. At least every {@code every} (15 s) and at every
 * {@link #poke}. One virtual thread waits on a condition for the one or the other, so an unchanged desk costs one
 * small write every 15 s and nothing between. A failed write is one log line until a write works again; the old file
 * then goes stale, which desk-batch reads as not idle. The file is removed when deskd stops.
 */
public final class IdleFile {

    public static final String NAME = "idle.json";
    public static final Duration EVERY = Duration.ofSeconds(15);

    private static final Logger log = LoggerFactory.getLogger(IdleFile.class);

    /** The counts and times, each read at the moment of a write. None may block for long or throw. */
    public interface Sources {
        int sessions();

        int agentTasks();

        int exports();

        int downloads();

        /** The config's {@code autoStop.autoStopMinutes} in seconds, or null if there is none. */
        Long idleStopSeconds();

        Instant lastInputAt();
    }

    private final Path file;
    private final Path temporary;
    private final Sources sources;
    private final Clock clock;
    private final Duration every;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    /** One write at a time: the thread's, and the last one. */
    private final ReentrantLock writing = new ReentrantLock();
    /** Guarded by lock. */
    private Thread thread;
    private boolean poked;
    private boolean closed;
    private volatile Instant touchedAt;
    /** Guarded by writing. */
    private Instant idleSince;
    private boolean failing;

    /** @param file usually /run/desk/idle.json */
    public IdleFile(Path file, Sources sources, Clock clock, Duration every) {
        this.file = file;
        this.temporary = file.resolveSibling("." + file.getFileName() + ".tmp");
        this.sources = sources;
        this.clock = clock;
        this.every = every;
    }

    /** Writes the file, then again every {@code every} and at every {@link #poke}. */
    public void start() {
        lock.lock();
        try {
            if (thread != null || closed) {
                return;
            }
            thread = Thread.ofVirtual().name("idle-file").start(this::run);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Something may have changed a count: a session, an Agent run, an export or a hold. Never blocks, and callable under
     * any lock, as it takes only its own.
     */
    public void poke() {
        touchedAt = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        lock.lock();
        try {
            poked = true;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** Stops the thread and removes the file, so the desk is "not idle" at once rather than 60 s on. */
    public void close() {
        Thread stopping;
        lock.lock();
        try {
            closed = true;
            stopping = thread;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (stopping != null) {
            try {
                stopping.join(Duration.ofSeconds(2));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        writing.lock();
        try {
            Files.deleteIfExists(file);
            Files.deleteIfExists(temporary);
        } catch (IOException | RuntimeException e) {
            log.debug("couldn't remove {}: {}", file.getFileName(), e.getClass().getSimpleName());
        } finally {
            writing.unlock();
        }
    }

    private void run() {
        while (true) {
            write();
            lock.lock();
            try {
                long nanos = every.toNanos();
                while (!poked && !closed) {
                    if (nanos <= 0) {
                        break;
                    }
                    nanos = wake.awaitNanos(nanos);
                }
                if (closed) {
                    return;
                }
                poked = false;
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
        }
    }

    /** Takes a look at the counts and writes the file whole. Never throws. */
    void write() {
        writing.lock();
        try {
            byte[] bytes = Json.bytes(document());
            replace(bytes);
            if (failing) {
                log.info("{} is written again", file.getFileName());
                failing = false;
            }
        } catch (IOException | RuntimeException e) {
            if (!failing) {
                log.warn("couldn't write {}, so the desk reads as not idle: {}", file.getFileName(), e.getClass().getSimpleName());
                failing = true;
            }
        } finally {
            writing.unlock();
        }
    }

    /** With writing held. */
    private Map<String, Object> document() {
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        int sessions = Math.max(0, sources.sessions());
        int agentTasks = Math.max(0, sources.agentTasks());
        int exports = Math.max(0, sources.exports());
        int downloads = Math.max(0, sources.downloads());
        Long stop = sources.idleStopSeconds();
        Instant lastInput = sources.lastInputAt();
        if (sessions > 0 || agentTasks > 0 || exports > 0) {
            idleSince = null;
        } else if (idleSince == null) {
            idleSince = now;
        } else {
            Instant touched = touchedAt;
            if (touched != null && touched.isAfter(idleSince)) {
                idleSince = touched.isAfter(now) ? now : touched;
            }
        }
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("at", now.toString());
        document.put("sessions", sessions);
        document.put("agentTasks", agentTasks);
        document.put("exports", exports);
        document.put("downloads", downloads);
        document.put("idleSince", idleSince == null ? null : idleSince.toString());
        document.put("idleStopSeconds", stop);
        document.put("lastInputAt", lastInput == null ? null : lastInput.truncatedTo(ChronoUnit.SECONDS).toString());
        return document;
    }

    /** With writing held: a new temporary file, whole and 0644, renamed over the file. */
    private void replace(byte[] bytes) throws IOException {
        // CREATE_NEW follows no link, and a rename replaces a link rather than what it names.
        Files.deleteIfExists(temporary);
        try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            // The creation mask can narrow a mode given at creation, so it is set on the open file's name before the rename.
            Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-r--r--"));
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) {
                channel.write(buffer);
            }
        } catch (IOException | RuntimeException e) {
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException ignored) {
                // the next write removes it first
            }
            throw e;
        }
        Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
}
