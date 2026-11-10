package com.minimalistalliance.desk.deskd.browser.minified;

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
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The simplified view's memory of sites (task 47, Security T47-9): per site, which is its registrable domain whatever
 * host a caller names, whether the member chose the stream or the simplified view, whether they marked it sensitive,
 * and why its pages last fell back by themselves. It lives only on
 * the desk, in {@value #FILE} on the data volume: the office keeps none of it and asks.
 *
 * <ul>
 *   <li><b>Small.</b> At most {@value #MAX_SITES} hosts, the oldest going first, and only hosts that differ from the
 *       default are kept at all. The file stays under {@value #MAX_BYTES} bytes, so the next load reads it: past that,
 *       the oldest go, and sites marked sensitive last.
 *   <li><b>No longer than Chromium's history.</b> A host untouched for 90 days goes, as Chromium's history does, and an
 *       automatic fallback is forgotten after 7. Those days count at load too, which writes the file again without
 *       them. {@link #clear} is what the member's clear-history calls.
 *   <li><b>Atomic.</b> A temporary file beside it, synced, then renamed over it, so a crash leaves the old file or the
 *       new one. A write that fails leaves the old file, and the memory goes on in deskd until the next write works.
 *   <li><b>Untrusted on read.</b> Only a regular file, reached with no symlink followed, under {@value #MAX_BYTES}
 *       bytes. Anything else, or anything unreadable in it, starts empty.
 * </ul>
 * No host is ever logged. One writer thread, which exists only while a write is owed.
 */
final class SiteMemory {

    private static final Logger log = LoggerFactory.getLogger(SiteMemory.class);

    static final String FILE = "minified-sites.json";
    private static final String TEMP = FILE + ".tmp";
    static final int MAX_SITES = 2000;
    static final int MAX_BYTES = 512 * 1024;
    /** Chromium keeps 90 days of history, and this nothing longer. */
    static final Duration KEEP = Duration.ofDays(90);
    static final Duration FALLBACK_KEEP = Duration.ofDays(7);
    /** How many pages of a site have to fall back by themselves before the site opens as the stream. */
    static final int REMEMBER_AFTER = 2;
    private static final Set<java.nio.file.attribute.PosixFilePermission> OWNER_ONLY = PosixFilePermissions.fromString("rw-------");
    private static final Pattern HOST = Pattern.compile(
            "(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*|\\[[0-9a-f:.]{2,45}]");

    enum View {
        SIMPLIFIED,
        STREAM;

        String wire() {
            return name().toLowerCase(Locale.ROOT);
        }

        static View parse(Object wire) {
            for (View view : values()) {
                if (view.wire().equals(wire)) {
                    return view;
                }
            }
            return null;
        }
    }

    /**
     * @param view what the member chose, or null for nothing
     * @param fallback the last automatic fallback, or null
     * @param fallbacks how many pages fell back since that kept count began
     * @param fallbackAt when the last did, in epoch millis
     * @param at when this host was last touched, in epoch millis
     */
    record Site(String host, View view, boolean sensitive, Fallback fallback, int fallbacks, long fallbackAt, long at) {

        boolean isDefault() {
            return view == null && !sensitive && fallback == null;
        }

        Map<String, Object> wire() {
            Map<String, Object> wire = new LinkedHashMap<>();
            wire.put("host", host);
            if (view != null) {
                wire.put("view", view.wire());
            }
            wire.put("sensitive", sensitive);
            if (fallback != null) {
                wire.put("lastFallback", fallback.wire());
            }
            return wire;
        }
    }

    private final Path file;
    private final Clock clock;
    private final int maxBytes;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition writtenChanged = lock.newCondition();
    private final Map<String, Site> sites = new HashMap<>();
    private Thread writer;
    private long requested;
    private long written;
    private boolean failureLogged;

    /** @param directory the data volume's directory, or null to keep it in memory only */
    SiteMemory(Path directory, Clock clock) {
        this(directory, clock, MAX_BYTES);
    }

    /** With a smaller file limit, for tests: with hosts kept to their registrable domain, the real one is hard to reach. */
    SiteMemory(Path directory, Clock clock, int maxBytes) {
        this.maxBytes = maxBytes;
        this.file = directory == null ? null : directory.resolve(FILE);
        this.clock = clock;
        if (file != null) {
            lock.lock();
            try {
                load();
            } finally {
                lock.unlock();
            }
        }
    }

    static boolean isHost(String host) {
        return host != null && HOST.matcher(host).matches();
    }

    /** The host a URL is on, for the memory's key, or null if it isn't http or https. */
    static String hostOf(String url) {
        try {
            java.net.URI uri = new java.net.URI(url);
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
                return null;
            }
            String raw = uri.getHost();
            if (raw == null && uri.getRawAuthority() != null) {
                // java.net.URI leaves a host that isn't ASCII to the authority: take it from there.
                String authority = uri.getRawAuthority().substring(uri.getRawAuthority().lastIndexOf('@') + 1);
                raw = authority.startsWith("[") ? authority : authority.replaceFirst(":[0-9]*$", "");
            }
            if (raw == null || raw.isEmpty()) {
                return null;
            }
            String host = java.net.IDN.toASCII(raw, java.net.IDN.ALLOW_UNASSIGNED).toLowerCase(Locale.ROOT);
            return isHost(host) ? host : null;
        } catch (java.net.URISyntaxException | IllegalArgumentException e) {
            return null;
        }
    }

    /** Second-level labels under a country's code that are themselves public, as in example.co.uk. */
    private static final java.util.Set<String> PUBLIC_SECOND = java.util.Set.of(
            "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "sch", "ltd", "plc");

    /**
     * The site a host is part of, as close to its registrable domain (eTLD+1) as deskd gets without the public suffix
     * list: the last two labels, or three under a country code's public second level (example.co.uk). It errs toward
     * grouping more hosts, which is the safe way for what it's used for: sensitivity only ever adds (T47-7).
     */
    static String registrable(String host) {
        if (host == null || host.startsWith("[") || host.chars().allMatch(c -> c == '.' || Character.isDigit(c))) {
            return host;
        }
        String[] labels = host.split("\\.");
        int n = labels.length;
        if (n <= 2) {
            return host;
        }
        boolean countrySecond = labels[n - 1].length() == 2 && PUBLIC_SECOND.contains(labels[n - 2]);
        int keep = countrySecond ? 3 : 2;
        return String.join(".", java.util.Arrays.copyOfRange(labels, n - keep, n));
    }

    /** @return what's kept of the host's site (its registrable domain), or a default if nothing is */
    Site get(String host) {
        host = registrable(host);
        lock.lock();
        try {
            Site site = current(host);
            return site != null ? site : new Site(host, null, false, null, 0, 0, 0);
        } finally {
            lock.unlock();
        }
    }

    /**
     * What the member said of a site.
     *
     * @param setView whether to set the view at all
     * @param view what they chose, or null to forget a choice
     * @param sensitive null to leave it as it is
     */
    Site set(String host, boolean setView, View view, Boolean sensitive) {
        host = registrable(host);
        lock.lock();
        try {
            Site old = current(host);
            if (!setView) {
                view = old == null ? null : old.view();
            }
            boolean marked = sensitive != null ? sensitive : old != null && old.sensitive();
            // A choice of the simplified view is the member's answer to an automatic fallback, so that goes.
            boolean keepFallback = old != null && view != View.SIMPLIFIED;
            Site site = new Site(host, view, marked,
                    keepFallback ? old.fallback() : null, keepFallback ? old.fallbacks() : 0, keepFallback ? old.fallbackAt() : 0, now());
            put(site);
            return site;
        } finally {
            lock.unlock();
        }
    }

    /** A page of this site fell back by itself, for a reason worth remembering. */
    void noteFallback(String host, Fallback reason) {
        if (!reason.rememberable) {
            return;
        }
        host = registrable(host);
        lock.lock();
        try {
            Site old = current(host);
            if (old != null && old.view() == View.SIMPLIFIED) {
                return;
            }
            int count = old == null || old.fallback() == null ? 1 : Math.min(old.fallbacks() + 1, 1000);
            long now = now();
            put(new Site(host, old == null ? null : old.view(), old != null && old.sensitive(), reason, count, now, now));
        } finally {
            lock.unlock();
        }
    }

    /** @return the reason its pages fell back, if enough of them did lately and the member chose nothing, else null */
    Fallback remembered(String host) {
        host = registrable(host);
        lock.lock();
        try {
            Site site = current(host);
            return site != null && site.view() == null && site.fallback() != null && site.fallbacks() >= REMEMBER_AFTER
                    ? site.fallback()
                    : null;
        } finally {
            lock.unlock();
        }
    }

    List<Site> list() {
        lock.lock();
        try {
            List<Site> list = new ArrayList<>();
            for (String host : new ArrayList<>(sites.keySet())) {
                Site site = current(host);
                if (site != null) {
                    list.add(site);
                }
            }
            list.sort(Comparator.comparing(Site::host));
            return list;
        } finally {
            lock.unlock();
        }
    }

    /** Forgets every site, as the member's clear-history does. */
    void clear() {
        lock.lock();
        try {
            sites.clear();
            requestWrite();
        } finally {
            lock.unlock();
        }
    }

    /** Parks until every change made before this call is on disk, or failed to be. For tests and shutdown. */
    boolean awaitWritten(Duration wait) throws InterruptedException {
        long remaining = wait.toNanos();
        lock.lock();
        try {
            long target = requested;
            while (written < target && remaining > 0) {
                remaining = writtenChanged.awaitNanos(remaining);
            }
            return written >= target;
        } finally {
            lock.unlock();
        }
    }

    // ---- with the lock held

    /** The host's entry with what has expired taken off, or null. */
    private Site current(String host) {
        Site site = sites.get(host);
        if (site == null) {
            return null;
        }
        long now = now();
        if (now - site.at() > KEEP.toMillis()) {
            sites.remove(host);
            requestWrite();
            return null;
        }
        if (site.fallback() != null && now - site.fallbackAt() > FALLBACK_KEEP.toMillis()) {
            site = new Site(host, site.view(), site.sensitive(), null, 0, 0, site.at());
            if (site.isDefault()) {
                sites.remove(host);
                requestWrite();
                return null;
            }
            sites.put(host, site);
            requestWrite();
        }
        return site;
    }

    private void put(Site site) {
        if (site.isDefault()) {
            sites.remove(site.host());
        } else {
            sites.put(site.host(), site);
            while (sites.size() > MAX_SITES) {
                sites.values().stream().min(Comparator.comparingLong(Site::at)).map(Site::host).ifPresent(sites::remove);
            }
        }
        requestWrite();
    }

    private long now() {
        return clock.millis();
    }

    private void requestWrite() {
        requested++;
        if (file == null) {
            written = requested;
            writtenChanged.signalAll();
            return;
        }
        if (writer == null) {
            writer = Thread.ofVirtual().name("minified-sites-write").start(this::writeLoop);
        }
    }

    // ---- the file

    private void writeLoop() {
        while (true) {
            long target;
            byte[] bytes;
            lock.lock();
            try {
                if (written >= requested) {
                    writer = null;
                    return;
                }
                target = requested;
                bytes = encode();
            } finally {
                lock.unlock();
            }
            write(bytes);
            lock.lock();
            try {
                written = Math.max(written, target);
                writtenChanged.signalAll();
            } finally {
                lock.unlock();
            }
        }
    }

    /**
     * The file's bytes, kept under {@link #MAX_BYTES} (review 9): long hosts could pass it, and the next load would then
     * start empty, the member's sensitive marks with it. What doesn't fit goes from memory too: the oldest, sensitive
     * marks last.
     */
    private byte[] encode() {
        List<Site> byKeep = new ArrayList<>(sites.values());
        byKeep.sort(Comparator.comparing((Site site) -> !site.sensitive()).thenComparing(Comparator.comparingLong(Site::at).reversed()));
        int total = Json.bytes(Map.of("v", 1, "sites", List.of())).length;
        for (Site site : byKeep) {
            int size = Json.bytes(entryOf(site)).length + 1;
            if (total + size > maxBytes) {
                sites.remove(site.host());
            } else {
                total += size;
            }
        }
        List<Map<String, Object>> list = new ArrayList<>(sites.size());
        for (Site site : sites.values()) {
            list.add(entryOf(site));
        }
        return Json.bytes(Map.of("v", 1, "sites", list));
    }

    private static Map<String, Object> entryOf(Site site) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("host", site.host());
        if (site.view() != null) {
            entry.put("view", site.view().wire());
        }
        if (site.sensitive()) {
            entry.put("sensitive", true);
        }
        if (site.fallback() != null) {
            entry.put("fallback", site.fallback().wire());
            entry.put("fallbacks", site.fallbacks());
            entry.put("fallbackAt", site.fallbackAt());
        }
        entry.put("at", site.at());
        return entry;
    }

    private void write(byte[] bytes) {
        Path temp = file.resolveSibling(TEMP);
        try {
            Files.deleteIfExists(temp);
            try (FileChannel channel = FileChannel.open(
                    temp,
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(OWNER_ONLY))) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE);
            try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            }
            failureLogged = false;
        } catch (IOException | RuntimeException e) {
            if (!failureLogged) {
                failureLogged = true;
                log.warn("couldn't write {}, so the old file stands: {}", FILE, e.getClass().getSimpleName());
            }
            try {
                Files.deleteIfExists(temp);
            } catch (IOException | RuntimeException ignored) {
                // The next write removes it first.
            }
        }
    }

    private void load() {
        byte[] bytes;
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > maxBytes) {
                log.warn("{} isn't a regular file under the size limit: starting empty", FILE);
                return;
            }
            try (FileChannel channel = FileChannel.open(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                ByteBuffer buffer = ByteBuffer.allocate((int) Math.min(attributes.size() + 1, maxBytes + 1));
                while (buffer.hasRemaining() && channel.read(buffer) > 0) {
                    // Reads to the end, or one past the limit.
                }
                if (buffer.position() > maxBytes) {
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
        try {
            Map<String, Object> root = Json.parseObject(bytes);
            if (!(root.get("sites") instanceof List<?> list)) {
                return;
            }
            long now = now();
            boolean pruned = false;
            for (Object item : list) {
                if (item instanceof Map<?, ?> raw && sites.size() < MAX_SITES) {
                    @SuppressWarnings("unchecked")
                    Site site = parse((Map<String, Object>) raw);
                    if (site != null && now - site.at() > KEEP.toMillis()) {
                        // Past Chromium's history at load too, not only once touched (review 9).
                        pruned = true;
                    } else if (site != null) {
                        sites.put(site.host(), site);
                    }
                }
            }
            if (pruned) {
                requestWrite();
            }
        } catch (JsonFormatException e) {
            log.warn("{} is unreadable: starting empty", FILE);
        }
    }

    private static Site parse(Map<String, Object> raw) {
        String host = Json.string(raw, "host");
        if (!isHost(host) || !(raw.get("at") instanceof Number at)) {
            return null;
        }
        View view = View.parse(raw.get("view"));
        boolean sensitive = Boolean.TRUE.equals(raw.get("sensitive"));
        Fallback fallback = Fallback.parse(Json.string(raw, "fallback"));
        if (fallback != null && !fallback.rememberable) {
            fallback = null;
        }
        int fallbacks = raw.get("fallbacks") instanceof Number n ? (int) Math.max(0, Math.min(1000, n.longValue())) : 0;
        long fallbackAt = raw.get("fallbackAt") instanceof Number n ? n.longValue() : 0;
        Site site = new Site(host, view, sensitive, fallback, fallback == null ? 0 : fallbacks, fallback == null ? 0 : fallbackAt, at.longValue());
        return site.isDefault() ? null : site;
    }
}
