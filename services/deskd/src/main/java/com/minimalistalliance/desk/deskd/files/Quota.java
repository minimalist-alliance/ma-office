package com.minimalistalliance.desk.deskd.files;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * The drive's room (files.md section 2, {@code files.usage}, and the ADR's decision 3). The quota is the whole drive's:
 * everything every app has written. Uploads are held to the 2 GiB floor ADR 0035 keeps for the Browser, less what
 * running uploads still owe, so two of them can't both take the last gigabyte.
 */
final class Quota {

    /** ADR 0035's floor, the export draft's too. */
    static final long FLOOR_BYTES = 2L * 1024 * 1024 * 1024;
    static final Duration WALK_CACHE = Duration.ofSeconds(60);
    static final long WALK_CAP = 1_000_000;

    /** The drive, as statvfs says. A test replaces it. */
    interface Space {
        long total() throws IOException;

        /** Usable blocks: what a write can still take. */
        long free() throws IOException;
    }

    private final SafeTree tree;
    private final Space space;
    private final long floor;
    private final LongSupplier owed;
    private final Clock clock;
    private final Trash trash;
    private Map<String, Object> cachedFiles;
    private long cachedAt = Long.MIN_VALUE;

    Quota(SafeTree tree, Trash trash, Space space, long floor, LongSupplier owed, Clock clock) {
        this.tree = tree;
        this.trash = trash;
        this.space = space;
        this.floor = floor;
        this.owed = owed;
        this.clock = clock;
    }

    static Space spaceOf(SafeTree tree) {
        return new Space() {
            @Override
            public long total() throws IOException {
                return tree.store().getTotalSpace();
            }

            @Override
            public long free() throws IOException {
                return tree.store().getUsableSpace();
            }
        };
    }

    long floor() {
        return floor;
    }

    long free() throws IOException {
        return space.free();
    }

    /** What the drive can take for a new upload: free, less the floor, less what running uploads still owe. */
    long uploadable() throws IOException {
        return Math.max(0, space.free() - floor - owed.getAsLong());
    }

    /** What the drive can still take before the floor, for one running upload's own check. */
    long beforeFloor() throws IOException {
        return Math.max(0, space.free() - floor);
    }

    Map<String, Object> noSpaceDetails(long need) throws IOException {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("freeBytes", space.free());
        d.put("floorBytes", floor);
        d.put("needBytes", need);
        return d;
    }

    /** {@code files.usage}'s answer. At most one walk at a time, and a walk's answer is kept for 60 s. */
    synchronized Map<String, Object> usage() throws IOException {
        long total = space.total();
        long free = space.free();
        long now = clock.millis();
        boolean cached = cachedFiles != null && now - cachedAt < WALK_CACHE.toMillis() && now >= cachedAt;
        if (!cached) {
            SafeTree.Tally files = tree.tally(new String[0], WALK_CAP, () -> Thread.currentThread().isInterrupted(), true);
            long[] bin = trash.totals(() -> Thread.currentThread().isInterrupted());
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("bytes", files.bytes());
            f.put("approx", files.capped());
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("bytes", bin[0]);
            t.put("items", bin[1]);
            Map<String, Object> both = new LinkedHashMap<>();
            both.put("files", f);
            both.put("trash", t);
            cachedFiles = both;
            cachedAt = now;
        }
        Map<String, Object> drive = new LinkedHashMap<>();
        drive.put("totalBytes", total);
        drive.put("usedBytes", Math.max(0, total - free));
        drive.put("freeBytes", free);
        @SuppressWarnings("unchecked")
        Map<String, Object> files = new LinkedHashMap<>((Map<String, Object>) cachedFiles.get("files"));
        if (cached) {
            files.put("approx", true);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("drive", drive);
        out.put("files", files);
        out.put("trash", cachedFiles.get("trash"));
        out.put("floorBytes", floor);
        out.put("uploadableBytes", Math.max(0, free - floor - owed.getAsLong()));
        out.put("computedAt", java.time.Instant.ofEpochMilli(cachedAt).toString());
        return out;
    }

    /** The next usage walk is a fresh one: something changed a lot. */
    synchronized void forget() {
        cachedFiles = null;
    }
}
