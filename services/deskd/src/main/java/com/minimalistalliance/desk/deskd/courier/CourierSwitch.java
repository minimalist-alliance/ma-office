package com.minimalistalliance.desk.deskd.courier;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Courier's kill switch, {@value #FILE} in deskd's directory on the data volume, read while deskd runs (the owner's
 * prelaunch rule: features ship on, and switches only turn things off). No file: Courier is on. {@code off}: every
 * {@code courier.*} but {@code courier.status} answers {@code unavailable} with {@code reason: switched_off}, the queue
 * sends nothing, and the agent tools aren't offered. {@code send-off}: the queue sends nothing, and the rest works. Each
 * channel's transport reads its own word, {@code <medium>-off} ({@code email-off}, {@code ma-off}, {@code imessage-off}).
 * A file that isn't a plain small file deskd can read counts as {@code off}. Written by the desk's operator as root;
 * deskd only reads it, at most once a second, as {@code AppsSwitch} does.
 */
public final class CourierSwitch {

    public static final String FILE = "courier-switch";
    private static final int MAX_BYTES = 1024;
    private static final long EVERY_NANOS = 1_000_000_000L;

    private final Path file;
    private volatile Set<String> words = Set.of();
    private volatile long checkedAt;
    private final ReentrantLock lock = new ReentrantLock();

    /** For tests: a switch that never changes, or none. */
    public static CourierSwitch fixed(String... words) {
        CourierSwitch s = new CourierSwitch(null);
        s.words = Set.copyOf(Arrays.asList(words));
        return s;
    }

    public CourierSwitch(Path directory) {
        this.file = directory == null ? null : directory.resolve(FILE);
        refresh();
    }

    public boolean on() {
        return !words().contains("off");
    }

    public boolean sending() {
        Set<String> now = words();
        return !now.contains("off") && !now.contains("send-off");
    }

    /** A channel's own word: {@code <medium>-off}. */
    public boolean channelOn(String medium) {
        Set<String> now = words();
        return !now.contains("off") && !now.contains(medium + "-off");
    }

    private Set<String> words() {
        if (file != null && System.nanoTime() - checkedAt >= EVERY_NANOS) {
            refresh();
        }
        return words;
    }

    private void refresh() {
        if (file == null || !lock.tryLock()) {
            return;
        }
        checkedAt = System.nanoTime();
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > MAX_BYTES) {
                words = Set.of("off");
                return;
            }
            String text = Files.readString(file, StandardCharsets.US_ASCII).strip();
            words = text.isEmpty() ? Set.of() : Set.copyOf(Arrays.asList(text.split("\\s+")));
        } catch (NoSuchFileException e) {
            words = Set.of();
        } catch (IOException | RuntimeException e) {
            words = Set.of("off");
        } finally {
            lock.unlock();
        }
    }
}
