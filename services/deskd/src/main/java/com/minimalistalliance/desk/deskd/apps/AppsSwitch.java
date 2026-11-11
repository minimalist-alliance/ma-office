package com.minimalistalliance.desk.deskd.apps;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Arrays;
import java.util.Set;

/**
 * The apps' kill switch, {@value #FILE} in deskd's directory on the data volume, read while deskd runs (the house rule:
 * finished features ship on, and switches only turn things off). No file: apps are on. {@code off}: the whole module is
 * inert, every {@code apps.*} answers {@code unavailable} with {@code reason: switched_off}, running apps are stopped, and
 * nothing is fetched. {@code install-off}: nothing new is installed or upgraded, and installed apps keep working. Any other
 * word is ignored. A file that isn't a plain small file deskd can read counts as {@code off}: whoever put it there meant to
 * stop something. The desk's operator writes it as root; deskd only reads it, at most once a second.
 */
final class AppsSwitch {

    static final String FILE = "apps-switch";
    private static final int MAX_BYTES = 1024;
    private static final long EVERY_NANOS = 1_000_000_000L;

    private final Path file;
    private volatile Set<String> words = Set.of();
    private volatile long checkedAt;
    private final java.util.concurrent.locks.ReentrantLock lock = new java.util.concurrent.locks.ReentrantLock();

    /** For tests: a switch that never changes. */
    static AppsSwitch fixed(String... words) {
        AppsSwitch s = new AppsSwitch(null);
        s.words = Set.copyOf(Arrays.asList(words));
        return s;
    }

    AppsSwitch(Path directory) {
        this.file = directory == null ? null : directory.resolve(FILE);
        refresh();
    }

    boolean on() {
        return !words().contains("off");
    }

    boolean installs() {
        Set<String> now = words();
        return !now.contains("off") && !now.contains("install-off");
    }

    private Set<String> words() {
        if (file != null && System.nanoTime() - checkedAt >= EVERY_NANOS) {
            refresh();
        }
        return words;
    }

    private void refresh() {
        if (file == null) {
            return;
        }
        // A caller that finds another one reading takes the last answer rather than wait.
        if (!lock.tryLock()) {
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
