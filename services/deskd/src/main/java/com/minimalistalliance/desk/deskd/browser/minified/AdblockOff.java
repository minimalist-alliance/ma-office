package com.minimalistalliance.desk.deskd.browser.minified;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The sites the member turned ad blocking off for (ADR 0073's per-site switch), in {@value #FILE} on the data volume:
 * one registrable domain a line, sorted, for the image's {@code desk-adblock} to read into Chromium's policy (Security's
 * {@code T47S-3}, deskd's half).
 *
 * <ul>
 *   <li><b>Not world-readable.</b> Written 0640, as a temporary file beside it, synced, then renamed over it.
 *   <li><b>Cleared with history.</b> {@code browser.minified.sites.clear}, what the member's clear-history calls, empties
 *       it, so the policy file the image makes from it does too.
 *   <li><b>In the export.</b> It's in {@code /data/desk}, the export's {@code desk} part, as the site memory is.
 *   <li><b>Small and untrusted on read.</b> At most {@value #MAX_SITES} sites; only a regular file, no symlink followed,
 *       under {@value #MAX_BYTES} bytes, and only lines that are hosts. Anything else starts empty.
 * </ul>
 * No site is ever logged.
 */
final class AdblockOff {

    static final String FILE = "adblock-off";
    static final int MAX_SITES = 2000;
    static final int MAX_BYTES = 2000 * 254;
    private static final String TEMP = FILE + ".tmp";
    static final Set<PosixFilePermission> MODE = PosixFilePermissions.fromString("rw-r-----");
    private static final Logger log = LoggerFactory.getLogger(AdblockOff.class);

    private final Path file;
    private final ReentrantLock lock = new ReentrantLock();
    private final TreeSet<String> off = new TreeSet<>();

    /** @param directory the data volume's directory, or null to keep it in memory only */
    AdblockOff(Path directory) {
        this.file = directory == null ? null : directory.resolve(FILE);
        if (file != null) {
            lock.lock();
            try {
                load();
            } finally {
                lock.unlock();
            }
        }
    }

    /**
     * @param on whether ads and trackers are blocked on the site: false puts it on the list, true takes it off
     * @return the site, the host's registrable domain
     * @throws IOException if the list couldn't be written, and then nothing changed
     */
    String set(String host, boolean on) throws IOException {
        String site = SiteMemory.registrable(host);
        lock.lock();
        try {
            boolean changed = on ? off.contains(site) : !off.contains(site);
            if (!changed) {
                return site;
            }
            if (!on && off.size() >= MAX_SITES) {
                throw new IOException("full");
            }
            TreeSet<String> next = new TreeSet<>(off);
            if (on) {
                next.remove(site);
            } else {
                next.add(site);
            }
            write(next);
            off.clear();
            off.addAll(next);
            return site;
        } finally {
            lock.unlock();
        }
    }

    /** Whether ads and trackers are blocked on this host's site. */
    boolean on(String host) {
        lock.lock();
        try {
            return !off.contains(SiteMemory.registrable(host));
        } finally {
            lock.unlock();
        }
    }

    List<String> list() {
        lock.lock();
        try {
            return new ArrayList<>(off);
        } finally {
            lock.unlock();
        }
    }

    /** Empties the list, file included: what clear-history does. */
    void clear() throws IOException {
        lock.lock();
        try {
            write(new TreeSet<>());
            off.clear();
        } finally {
            lock.unlock();
        }
    }

    // ---- the file, with the lock held

    private void write(TreeSet<String> sites) throws IOException {
        if (file == null) {
            return;
        }
        StringBuilder text = new StringBuilder();
        for (String site : sites) {
            text.append(site).append('\n');
        }
        Path temp = file.resolveSibling(TEMP);
        try {
            Files.deleteIfExists(temp);
            try (FileChannel channel = FileChannel.open(
                    temp,
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(MODE))) {
                ByteBuffer buffer = ByteBuffer.wrap(text.toString().getBytes(StandardCharsets.US_ASCII));
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            // The umask can take bits off at create: the mode is set again, before the file is in place.
            Files.setPosixFilePermissions(temp, MODE);
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE);
            try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            }
        } catch (IOException | RuntimeException e) {
            log.warn("couldn't write {}, so the old file stands: {}", FILE, e.getClass().getSimpleName());
            try {
                Files.deleteIfExists(temp);
            } catch (IOException | RuntimeException ignored) {
                // The next write removes it first.
            }
            throw e instanceof IOException io ? io : new IOException(e.getClass().getSimpleName());
        }
    }

    private void load() {
        byte[] bytes;
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > MAX_BYTES) {
                log.warn("{} isn't a regular file under the size limit: starting empty", FILE);
                return;
            }
            try (FileChannel channel = FileChannel.open(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                ByteBuffer buffer = ByteBuffer.allocate((int) Math.min(attributes.size() + 1, MAX_BYTES + 1));
                while (buffer.hasRemaining() && channel.read(buffer) > 0) {
                    // To the end, or one past the limit.
                }
                if (buffer.position() > MAX_BYTES) {
                    return;
                }
                bytes = java.util.Arrays.copyOf(buffer.array(), buffer.position());
            }
        } catch (NoSuchFileException e) {
            return;
        } catch (IOException | RuntimeException e) {
            log.warn("couldn't read {}: starting empty: {}", FILE, e.getClass().getSimpleName());
            return;
        }
        for (String line : new String(bytes, StandardCharsets.US_ASCII).split("\n")) {
            String site = line.strip();
            if (SiteMemory.isHost(site) && off.size() < MAX_SITES) {
                off.add(SiteMemory.registrable(site));
            }
        }
    }
}
