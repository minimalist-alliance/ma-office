package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A restart of Chromium that the owner's age band owes, kept across a restart of deskd ({@link BrowserStream#restartForPolicy},
 * {@link BrowserStream#restartWhenUnused}). The image's {@code desk-browser-policy} sets the teen lock or the adult
 * allowlist only as Chromium starts, so a deskd that forgot a restart it owed would leave a running Chromium on the band it
 * had: a teen's on the adult allowlist, if the lock's stop hadn't worked yet.
 *
 * <p>{@value #LOCK}: a restart for the teen lock is owed, and goes at once. {@value #UNLOCK}: one for the band
 * {@code adult} is owed, and goes once nobody is using the Browser, or with its next start.
 *
 * <p><b>Where.</b> Beside {@code age-band}, in deskd's own data directory ({@code /data/desk}), which only deskd writes. Not
 * in {@code /run/desk}: rtc can write that directory, so it could make, remove or rename anything there, a subdirectory of
 * deskd's included (Security, Nov 11). {@code /data/desk} outlives a reboot, which Chromium doesn't, so each file holds the
 * boot it was written in, {@code /proc/sys/kernel/random/boot_id} and a newline, and counts only in that boot: one from
 * before a reboot, or carried to another machine by a restore, a move or an export, counts for nothing, and is removed. With
 * no boot id nothing is kept, as nothing could tell this boot's from another's.
 *
 * <p>Read without following a link, a regular file only, and at most a line. Written as a temporary file and a rename, so a
 * reader sees a whole line or none; not synced, as only a power loss could lose it, and that's a reboot. These are calls
 * on a file, so never make them under the stream's lock, and one caller at a time. A failure is one log line with the
 * exception's class only, and the state in memory stands.
 */
final class PolicyRestartMarker {

    static final String LOCK = "browser-lock-owed";
    static final String UNLOCK = "browser-unlock-owed";

    private static final Logger log = LoggerFactory.getLogger(PolicyRestartMarker.class);
    private static final FileAttribute<Set<PosixFilePermission>> OWNER_ONLY =
            PosixFilePermissions.asFileAttribute(EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
    /** A boot id is 36 characters: a line, and a byte more to tell a longer file. */
    private static final int MAX_BYTES = 40;

    /** What an earlier deskd of this boot owed. */
    record Owed(boolean lock, boolean unlock) {}

    private final Path lock;
    private final Path unlock;
    private final byte[] line;
    /** What the files said when last read or written, so an unchanged state costs no call. */
    private boolean lockThere;
    private boolean unlockThere;

    /**
     * @param directory deskd's data directory, where {@code age-band} is
     * @param bootId this boot's id, or null if it couldn't be read: then nothing is kept
     */
    PolicyRestartMarker(Path directory, String bootId) {
        this.lock = directory.resolve(LOCK);
        this.unlock = directory.resolve(UNLOCK);
        this.line = bootId == null || bootId.isBlank() ? null : (bootId.strip() + "\n").getBytes(StandardCharsets.US_ASCII);
    }

    /** Looks once: a file of this boot counts, and anything else at either name is removed. */
    Owed read() {
        if (line == null) {
            log.warn("no boot id, so a restart of Chromium the band owes isn't kept across a restart of deskd");
        }
        lockThere = thisBoots(lock);
        unlockThere = thisBoots(unlock);
        return new Owed(lockThere, unlockThere);
    }

    /** Makes the files say this. Never throws. */
    void write(boolean lockOwed, boolean unlockOwed) {
        if (line == null) {
            return;
        }
        if (lockOwed != lockThere && set(lock, lockOwed)) {
            lockThere = lockOwed;
        }
        if (unlockOwed != unlockThere && set(unlock, unlockOwed)) {
            unlockThere = unlockOwed;
        }
    }

    /** Whether the file holds exactly this boot's line. Anything else there, a link included, is taken away. */
    private boolean thisBoots(Path file) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (line != null && attributes.isRegularFile() && attributes.size() == line.length) {
                ByteBuffer bytes = ByteBuffer.allocate(MAX_BYTES);
                try (SeekableByteChannel channel = Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                    while (bytes.hasRemaining() && channel.read(bytes) >= 0) {
                        // To the end of the file, or a byte past a line.
                    }
                }
                if (Arrays.equals(line, Arrays.copyOf(bytes.array(), bytes.position()))) {
                    return true;
                }
            }
        } catch (NoSuchFileException e) {
            return false;
        } catch (IOException | RuntimeException e) {
            // Taken as another boot's, below.
        }
        set(file, false);
        return false;
    }

    private boolean set(Path file, boolean owed) {
        Path temp = file.resolveSibling("." + file.getFileName() + ".tmp");
        try {
            if (!owed) {
                Files.deleteIfExists(file);
                return true;
            }
            // One a crash left behind. Removing it takes away a link, and not what it names.
            Files.deleteIfExists(temp);
            try (FileChannel channel = FileChannel.open(
                    temp, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS), OWNER_ONLY)) {
                ByteBuffer bytes = ByteBuffer.wrap(line);
                while (bytes.hasRemaining()) {
                    channel.write(bytes);
                }
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (IOException | RuntimeException e) {
            try {
                Files.deleteIfExists(temp);
            } catch (IOException | RuntimeException ignored) {
                // The next write removes it first.
            }
            // The class only: a message can carry the path, and that's all it would add.
            log.warn("couldn't {} {}, so a restart of deskd would {}: {}",
                    owed ? "write" : "remove",
                    file.getFileName(),
                    owed ? "forget the restart Chromium owes" : "restart Chromium once more",
                    e.getClass().getSimpleName());
            return false;
        }
    }
}
