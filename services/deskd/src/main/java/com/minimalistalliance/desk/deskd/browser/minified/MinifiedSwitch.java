package com.minimalistalliance.desk.deskd.browser.minified;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The simplified view's kill switch, read while deskd runs, never fixed at build time: Spring's AOT would freeze a
 * condition, and getting out of trouble mustn't wait for a release (API.md section 14).
 *
 * <p>The owner's rule (Nov 7): finished features ship on, and switches are only there to get out of trouble. So with
 * no {@value #FILE} on the data volume, the view is on, media verbs, the consent press and the pre-scroll with it. The
 * file can only turn things off: {@code off} turns off everything, and off is fully inert (nothing of the view reaches
 * Chromium); {@code media-actions-off}, {@code consent-reject-off} and {@code prescroll-off} turn off one action each.
 * One word per line or space; any other word is ignored, so an empty file changes nothing. A file deskd can't read as a plain small file (a symlink,
 * one over 1 KiB, one it can't open) counts as {@code off}: whoever put it there meant to stop something. The desk's
 * operator writes it as root over SSM; deskd only reads it, and Chromium's user can't reach it.
 *
 * <p>Reading it never blocks a caller: a caller gets the last answer, and a stat at most once a second, on a thread of
 * its own, notices a change, so the CDP reader and the sessions' lock never touch the disk.
 */
public interface MinifiedSwitch {

    String FILE = "minified-switch";

    boolean on();

    boolean mediaActions();

    boolean consentReject();

    /** The pre-scroll of a document the view is about to show ({@code prescroll-off} turns it off). */
    default boolean prescroll() {
        return on();
    }

    /** For tests: as given, for good. */
    static MinifiedSwitch fixed(boolean on, boolean mediaActions, boolean consentReject) {
        return new MinifiedSwitch() {
            @Override
            public boolean on() {
                return on;
            }

            @Override
            public boolean mediaActions() {
                return on && mediaActions;
            }

            @Override
            public boolean consentReject() {
                return on && consentReject;
            }
        };
    }

    /** {@value #FILE} in this directory, looked at again at most once a second. */
    static MinifiedSwitch file(Path directory) {
        return file(directory, FILE);
    }

    /**
     * Another switch with the same rules, in the file of this name: only {@link #on} means anything for it. The
     * Browser's protected-media switch is one.
     */
    static MinifiedSwitch file(Path directory, String name) {
        return new FileSwitch(directory.resolve(name));
    }

    /** The file's words, as last read: missing means nothing is off. */
    final class FileSwitch implements MinifiedSwitch {
        private static final long EVERY_NANOS = 1_000_000_000L;
        private static final int MAX_BYTES = 1024;
        private static final Set<String> OFF = Set.of("off");
        private final Path file;
        private final ReentrantLock lock = new ReentrantLock();
        private volatile Set<String> words;
        private volatile long checkedAt;
        private boolean checking;
        /** What the last read saw of the file: its modified time and size, or null if it wasn't there. */
        private String seen;

        FileSwitch(Path file) {
            this.file = file;
            refresh();
        }

        @Override
        public boolean on() {
            return !words().contains("off");
        }

        @Override
        public boolean mediaActions() {
            Set<String> now = words();
            return !now.contains("off") && !now.contains("media-actions-off");
        }

        @Override
        public boolean consentReject() {
            Set<String> now = words();
            return !now.contains("off") && !now.contains("consent-reject-off");
        }

        @Override
        public boolean prescroll() {
            Set<String> now = words();
            return !now.contains("off") && !now.contains("prescroll-off");
        }

        private Set<String> words() {
            if (System.nanoTime() - checkedAt >= EVERY_NANOS) {
                lock.lock();
                try {
                    if (!checking && System.nanoTime() - checkedAt >= EVERY_NANOS) {
                        checking = true;
                        Thread.ofVirtual().name("minified-switch").start(() -> {
                            try {
                                refresh();
                            } finally {
                                lock.lock();
                                try {
                                    checking = false;
                                } finally {
                                    lock.unlock();
                                }
                            }
                        });
                    }
                } finally {
                    lock.unlock();
                }
            }
            return words;
        }

        /** A stat, and a read only if the file changed since the last one. */
        private void refresh() {
            String now;
            try {
                BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                now = attributes.lastModifiedTime().toMillis() + " " + attributes.size() + " " + attributes.isRegularFile();
            } catch (java.nio.file.NoSuchFileException e) {
                now = null;
            } catch (IOException | RuntimeException e) {
                now = "unreadable";
            }
            if (words == null || !java.util.Objects.equals(now, seen)) {
                words = now == null ? Set.of() : "unreadable".equals(now) ? OFF : readWords();
                seen = now;
            }
            checkedAt = System.nanoTime();
        }

        private Set<String> readWords() {
            try {
                BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attributes.isRegularFile() || attributes.size() > MAX_BYTES) {
                    return OFF;
                }
                try (FileChannel channel = FileChannel.open(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                    ByteBuffer buffer = ByteBuffer.allocate(MAX_BYTES + 1);
                    while (buffer.hasRemaining() && channel.read(buffer) > 0) {
                        // To the end, or one past the limit.
                    }
                    if (buffer.position() > MAX_BYTES) {
                        return OFF;
                    }
                    String text = new String(buffer.array(), 0, buffer.position(), StandardCharsets.US_ASCII);
                    // Words may repeat: a set made with Set.of would throw on that.
                    return text.strip().isEmpty() ? Set.of() : Set.copyOf(java.util.Arrays.asList(text.strip().split("\\s+")));
                }
            } catch (java.nio.file.NoSuchFileException e) {
                return Set.of();
            } catch (IOException | RuntimeException e) {
                return OFF;
            }
        }
    }
}
