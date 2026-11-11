package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The order of the member's tabs, kept on the data volume so a stop and a wake give the strip back as it was (LS-36,
 * ADR 0092). Chromium restores the tabs themselves and their cookies from its own profile, which this never reads or
 * writes (ADR 0035): it only says where each tab goes in the list deskd serves.
 *
 * <p><b>What's kept.</b> {@value #FILE} beside deskd's other state: for each tab, in order, Chromium's target id and a
 * short hash of its address. No address, title or anything else of the page, so no history lands in a second place.
 * The id finds a tab again while Chromium runs, a restart of deskd included. A restarted Chromium gives every tab a new
 * id, so for {@link #restore} after each new connection a tab deskd hasn't placed takes the first unclaimed entry with
 * its address's hash, the way Chromium's own restore brings them back. Past that window, or with no match, a tab goes
 * at the end, as every tab did before this.
 *
 * <p><b>When it's written.</b> On any change of the order or an address, at the pace the tab topic publishes, and
 * once more as deskd stops. Never while a restore may still be under way: until every entry is claimed or the window
 * has passed, the file stays as it was, so a stop in the middle of a wake loses nothing. A temporary file renamed over
 * it, with no sync: an order lost to a crash costs only the order.
 *
 * <p>Not thread-safe: {@link BrowserTabs} calls all but {@link #write} with its lock held, and {@link #write} from one
 * thread at a time.
 */
final class TabOrder {

    static final String FILE = "browser-tab-order.json";
    /** As many as deskd keeps tabs. */
    static final int MAX_ENTRIES = BrowserTabs.MAX_TABS;
    static final int MAX_BYTES = 64 * 1024;
    static final Duration RESTORE = Duration.ofSeconds(60);
    private static final int VERSION = 1;
    private static final int KEY_HEX = 16;
    private static final int MAX_ID_CHARS = 128;
    private static final Logger log = LoggerFactory.getLogger(TabOrder.class);

    /** @param key {@link #key} of the tab's address */
    record Entry(String id, String key) {}

    private final Path file;
    private final Duration restore;
    private final LongSupplier nanos;
    private List<Entry> saved;
    private final Map<String, Integer> rankById = new HashMap<>();
    private boolean[] claimed;
    private long restoreUntilNanos;
    private boolean restoreOpen;
    /** What's on disk as of the last read or write, so an unchanged order isn't written again. */
    private List<Entry> onDisk;
    private boolean warned;

    /**
     * The data volume's file, as deskd's control plane finds the directory ({@code deskd.data.dir}, else
     * {@code DESKD_DATA_DIR}, else {@code /data/desk}). Kept in memory only if that isn't a directory, as on a build
     * machine.
     */
    static TabOrder onDataVolume() {
        String dir = System.getProperty("deskd.data.dir");
        if (dir == null || dir.isBlank()) {
            dir = System.getenv("DESKD_DATA_DIR");
        }
        if (dir == null || dir.isBlank()) {
            dir = "/data/desk";
        }
        Path directory = Path.of(dir);
        return new TabOrder(Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) ? directory.resolve(FILE) : null, RESTORE, System::nanoTime);
    }

    /** @param file null to keep it in memory only */
    TabOrder(Path file, Duration restore, LongSupplier nanos) {
        this.file = file;
        this.restore = restore;
        this.nanos = nanos;
        this.saved = read(file);
        this.onDisk = saved;
        reindex(false);
    }

    /** A new connection to Chromium: every entry can be claimed again, by id at once, and by address for a while. */
    void connected() {
        reindex(false);
        restoreOpen = true;
        restoreUntilNanos = nanos.getAsLong() + restore.toNanos();
    }

    /** @return where the tab goes among those kept, lowest first, or null if it isn't one of them */
    Integer rank(String id) {
        return rankById.get(id);
    }

    /**
     * For a tab deskd hasn't placed: its own entry, or during a restore the first unclaimed one with its address.
     *
     * @param live every tab Chromium has now, as far as deskd knows, so that no tab takes another's entry
     * @return its rank, or null to go at the end
     */
    Integer place(String id, String url, Set<String> live) {
        Integer rank = rankById.get(id);
        if (rank != null) {
            claimed[rank] = true;
            return rank;
        }
        if (!restoring()) {
            return null;
        }
        String key = key(url);
        for (int i = 0; i < saved.size(); i++) {
            Entry entry = saved.get(i);
            if (!claimed[i] && entry.key().equals(key) && !live.contains(entry.id())) {
                claimed[i] = true;
                rankById.put(id, i);
                return i;
            }
        }
        return null;
    }

    /** Within a restore's window, with an entry not yet claimed. */
    boolean holding() {
        if (!restoring()) {
            return false;
        }
        for (boolean c : claimed) {
            if (!c) {
                return true;
            }
        }
        return false;
    }

    private boolean restoring() {
        return restoreOpen && nanos.getAsLong() - restoreUntilNanos < 0;
    }

    /**
     * The tabs as they are now, in order, become the kept order, unless a restore may still be under way.
     *
     * @return what to {@link #write}, or null if nothing changed on disk
     */
    List<Entry> adopt(List<Entry> now) {
        if (holding()) {
            return null;
        }
        List<Entry> next = now.size() > MAX_ENTRIES ? List.copyOf(now.subList(0, MAX_ENTRIES)) : List.copyOf(now);
        if (!next.equals(saved)) {
            saved = next;
            reindex(true);
        }
        return saved.equals(onDisk) ? null : saved;
    }

    /** Never throws: a full or read-only volume costs the order, which is said once. */
    void write(List<Entry> entries) {
        if (file == null) {
            onDisk = entries;
            return;
        }
        List<Map<String, Object>> tabs = new ArrayList<>(entries.size());
        for (Entry entry : entries) {
            Map<String, Object> tab = new LinkedHashMap<>();
            tab.put("id", entry.id());
            tab.put("key", entry.key());
            tabs.add(tab);
        }
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("v", VERSION);
        document.put("tabs", tabs);
        Path temporary = file.resolveSibling(FILE + ".tmp");
        try {
            Files.deleteIfExists(temporary);
            Files.write(temporary, Json.bytes(document), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            try {
                Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException e) {
                // Not a POSIX file system: only in a test.
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            onDisk = entries;
            warned = false;
        } catch (IOException | RuntimeException e) {
            if (!warned) {
                warned = true;
                log.warn("couldn't keep the tab order: {}", e.getClass().getSimpleName());
            }
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException ignored) {
                // Tried.
            }
        }
    }

    /** A short hash of the address, which is all that's kept of it. */
    static String key(String url) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((url == null ? "" : url).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(Arrays.copyOf(digest, KEY_HEX / 2));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** @param allClaimed true once the order is the model's own, so there's nothing left to restore */
    private void reindex(boolean allClaimed) {
        rankById.clear();
        claimed = new boolean[saved.size()];
        for (int i = 0; i < saved.size(); i++) {
            rankById.putIfAbsent(saved.get(i).id(), i);
            claimed[i] = allClaimed;
        }
    }

    /** Anything unreadable, too large or not as written starts with no order, which is how a desk was before this. */
    private static List<Entry> read(Path file) {
        if (file == null) {
            return List.of();
        }
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) {
                return List.of();
            }
            Map<String, Object> document = Json.parseObject(Files.readAllBytes(file));
            if (!(document.get("v") instanceof Number version) || version.intValue() != VERSION
                    || !(document.get("tabs") instanceof List<?> tabs)) {
                return List.of();
            }
            List<Entry> entries = new ArrayList<>();
            for (Object item : tabs) {
                if (entries.size() >= MAX_ENTRIES) {
                    break;
                }
                if (item instanceof Map<?, ?> tab
                        && tab.get("id") instanceof String id
                        && tab.get("key") instanceof String key
                        && isId(id)
                        && isKey(key)) {
                    entries.add(new Entry(id, key));
                }
            }
            return List.copyOf(entries);
        } catch (IOException | JsonFormatException | RuntimeException e) {
            return List.of();
        }
    }

    private static boolean isId(String id) {
        if (id.isEmpty() || id.length() > MAX_ID_CHARS) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && c != '-' && c != '_') {
                return false;
            }
        }
        return true;
    }

    private static boolean isKey(String key) {
        if (key.length() != KEY_HEX) {
            return false;
        }
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) {
                return false;
            }
        }
        return true;
    }
}
