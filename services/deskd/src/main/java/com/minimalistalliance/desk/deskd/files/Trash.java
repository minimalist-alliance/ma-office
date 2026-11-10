package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The trash (files.md section 3): {@code .trash/<trashId>/item} is the deleted file or folder, moved there by one rename
 * so a huge folder is instant, and {@code meta.json} says where it came from. Items stay 30 days and count toward the
 * drive's used space. Only the member empties it, or the 30-day sweep does. Everything here runs with the tree's lock held.
 */
final class Trash {

    static final String ITEM = "item";
    static final String META = "meta.json";
    static final long ENTRY_CAP = 1_000_000;
    /** How long one listing may spend adding up folders it hasn't added up before. */
    private static final long LIST_BUDGET_NANOS = Duration.ofSeconds(2).toNanos();

    /** @param bytes null when the item has over 1,000,000 entries, or adding it up took too long */
    record Item(String id, String name, String originalPath, boolean dir, Long bytes, long deletedAt, long purgeAt) {}

    private final SafeTree tree;
    private final Clock clock;
    private final Duration keep;
    private final Map<String, Long> sizes = new ConcurrentHashMap<>();

    Trash(SafeTree tree, Clock clock, Duration keep) {
        this.tree = tree;
        this.clock = clock;
        this.keep = keep;
    }

    private static String[] dir(String id) {
        return new String[] {PathRules.TRASH, id};
    }

    /** Moves a file or folder into the trash. @return its trashId */
    String put(String[] from, String originalPath, boolean isDir) throws SafeTree.TreeException {
        long now = clock.millis();
        String id = Ids.next(now);
        tree.mkdir(dir(id));
        try {
            Map<String, Object> meta = new LinkedHashMap<>();
            meta.put("originalPath", originalPath);
            meta.put("name", from[from.length - 1]);
            meta.put("type", isDir ? "dir" : "file");
            meta.put("deletedAt", now);
            tree.replaceSmall(dir(id), META, Json.bytes(meta));
            tree.move(from, SafeTree.append(dir(id), ITEM));
        } catch (SafeTree.TreeException e) {
            tree.deleteTree(dir(id));
            throw e;
        }
        return id;
    }

    private Item read(String id, boolean sizeIt, long[] budget) {
        byte[] raw = tree.readSmall(SafeTree.append(dir(id), META), 8192);
        if (raw == null) {
            return null;
        }
        Map<String, Object> meta;
        try {
            meta = Json.parseObject(raw);
        } catch (JsonFormatException e) {
            return null;
        }
        String path = Json.string(meta, "originalPath");
        String name = Json.string(meta, "name");
        boolean isDir = "dir".equals(Json.string(meta, "type"));
        long deletedAt = meta.get("deletedAt") instanceof Number n ? n.longValue() : 0;
        if (path == null || name == null) {
            return null;
        }
        Long bytes = null;
        if (sizeIt) {
            bytes = sizeOf(id, isDir, budget);
        }
        return new Item(id, name, path, isDir, bytes, deletedAt, deletedAt + keep.toMillis());
    }

    private Long sizeOf(String id, boolean isDir, long[] budget) {
        Long known = sizes.get(id);
        if (known != null) {
            return known < 0 ? null : known;
        }
        String[] item = SafeTree.append(dir(id), ITEM);
        if (!isDir) {
            try {
                SafeTree.Entry e = tree.stat(item);
                if (e == null) {
                    return null;
                }
                sizes.put(id, e.size());
                return e.size();
            } catch (SafeTree.TreeException e) {
                return null;
            }
        }
        if (System.nanoTime() > budget[0]) {
            return null;
        }
        SafeTree.Tally tally = tree.tally(item, ENTRY_CAP, () -> System.nanoTime() > budget[0], false);
        if (tally.capped()) {
            if (System.nanoTime() <= budget[0]) {
                sizes.put(id, -1L);
            }
            return null;
        }
        sizes.put(id, tally.bytes());
        return tally.bytes();
    }

    /** Ids of every item, newest first. */
    private List<String> ids() {
        List<String> ids = new ArrayList<>();
        for (String name : tree.names(new String[] {PathRules.TRASH})) {
            if (Ids.valid(name)) {
                ids.add(name);
            }
        }
        ids.sort(Comparator.reverseOrder());
        return ids;
    }

    /** One page, newest first. The cursor is the last id of the page before. */
    List<Item> list(String after, int limit) {
        long[] budget = {System.nanoTime() + LIST_BUDGET_NANOS};
        List<Item> out = new ArrayList<>();
        for (String id : ids()) {
            if (after != null && id.compareTo(after) >= 0) {
                continue;
            }
            Item item = read(id, true, budget);
            if (item != null) {
                out.add(item);
                if (out.size() >= limit) {
                    break;
                }
            }
        }
        return out;
    }

    /** Whether more items follow this id. */
    boolean moreAfter(String lastId) {
        for (String id : ids()) {
            if (id.compareTo(lastId) < 0) {
                return true;
            }
        }
        return false;
    }

    Item get(String id) {
        if (!Ids.valid(id)) {
            return null;
        }
        return read(id, false, new long[] {System.nanoTime()});
    }

    String[] itemPath(String id) {
        return SafeTree.append(dir(id), ITEM);
    }

    /** Takes the item out of the trash and drops its record; the caller has moved the item itself. */
    void forget(String id) throws SafeTree.TreeException {
        sizes.remove(id);
        tree.deleteTree(dir(id));
    }

    /** Deletes one item for good. @return its bytes, if known */
    long deleteForGood(String id) throws SafeTree.TreeException {
        Item item = read(id, true, new long[] {System.nanoTime() + LIST_BUDGET_NANOS});
        long freed = item == null || item.bytes() == null ? 0 : item.bytes();
        forget(id);
        return freed;
    }

    /** Everything, for good. @return {deleted, freedBytes} */
    long[] empty() throws SafeTree.TreeException {
        long deleted = 0;
        long freed = 0;
        for (String name : tree.names(new String[] {PathRules.TRASH})) {
            if (!Ids.valid(name)) {
                continue;
            }
            Item item = read(name, true, new long[] {System.nanoTime() + LIST_BUDGET_NANOS});
            if (item != null && item.bytes() != null) {
                freed += item.bytes();
            }
            forget(name);
            deleted++;
        }
        return new long[] {deleted, freed};
    }

    /** What the trash holds, for usage: the items themselves, not their records. @return {bytes, items, capped} */
    long[] totals(java.util.function.BooleanSupplier stop) {
        long bytes = 0;
        long items = 0;
        long entries = 0;
        boolean capped = false;
        for (String name : tree.names(new String[] {PathRules.TRASH})) {
            if (!Ids.valid(name)) {
                continue;
            }
            items++;
            if (capped) {
                continue;
            }
            SafeTree.Entry e = null;
            try {
                e = tree.stat(itemPath(name));
            } catch (SafeTree.TreeException ex) {
                // Half-made: the sweep removes it.
            }
            if (e == null) {
                continue;
            }
            if (!e.dir()) {
                bytes += e.size();
                entries++;
            } else {
                SafeTree.Tally t = tree.tally(itemPath(name), ENTRY_CAP - entries, stop, false);
                bytes += t.bytes();
                entries += t.entries();
                capped = t.capped();
            }
        }
        return new long[] {bytes, items, capped ? 1 : 0};
    }

    /** Removes items older than the keep time, and any directory with no item or record in it. @return how many */
    int purgeExpired() {
        int purged = 0;
        long now = clock.millis();
        for (String name : tree.names(new String[] {PathRules.TRASH})) {
            try {
                if (!Ids.valid(name)) {
                    tree.deleteTree(dir(name));
                    continue;
                }
                Item item = read(name, false, new long[] {System.nanoTime()});
                boolean hasItem = tree.rawAttrs(itemPath(name)) != null;
                if (item == null || !hasItem || item.purgeAt() <= now) {
                    forget(name);
                    purged++;
                }
            } catch (SafeTree.TreeException e) {
                // Try again next hour.
            }
        }
        return purged;
    }
}
