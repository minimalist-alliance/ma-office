package com.minimalistalliance.desk.deskd.files;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;

/**
 * The drive's room (files.md section 2, {@code files.usage}, and the ADR's decision 3). The quota is the whole drive's:
 * everything every app has written. Uploads are held to the 2 GiB floor ADR 0035 keeps for the Browser, less what
 * running uploads still owe, so two of them can't both take the last gigabyte.
 *
 * <p><b>A free desk's cap</b> (ADR 0090, section 7) is on top of that: the tree, the trash and the whole declared size of
 * every unfinished upload, running or parked, are held to {@code filesGb}. It counts from the same walk {@code files.usage}
 * makes, kept for 60 s, with an upload's finish added to it ({@link #placed}) rather than thrown away, so a run of uploads
 * doesn't walk the tree for each. A change that frees bytes forgets the walk, so the next count is a fresh one; until then
 * the count is high, never low.
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

    /**
     * The last bytes' lock: held by whatever takes room, from its check of the room until what it takes is counted, so two
     * can't both see the same last bytes free (the floor's and a free desk's cap, ADR 0090). An upload's begin holds it
     * until its partial and sidecar exist; an agent's write (the Agent's {@code files_write}) until its file is in place and
     * counted. Taken before {@link SafeTree#lock}, never while holding it.
     */
    final ReentrantLock room = new ReentrantLock();
    private final SafeTree tree;
    private final Space space;
    private final long floor;
    private final LongSupplier owed;
    private final LongSupplier reserved;
    private final Clock clock;
    private final Trash trash;
    /** The cap's bytes, or -1 for none: {@link #capFrom}. */
    private volatile LongSupplier cap = () -> -1;
    private Map<String, Object> cachedFiles;
    private long cachedAt = Long.MIN_VALUE;

    /**
     * @param owed what running uploads still owe the drive, for the floor
     * @param reserved the whole declared size of every unfinished upload, running or parked, for the cap
     */
    Quota(SafeTree tree, Trash trash, Space space, long floor, LongSupplier owed, LongSupplier reserved, Clock clock) {
        this.tree = tree;
        this.trash = trash;
        this.space = space;
        this.floor = floor;
        this.owed = owed;
        this.reserved = reserved;
        this.clock = clock;
    }

    /** Where the cap comes from: its bytes, or -1 for none. Read at each check, so a change applies at once. Must not block. */
    void capFrom(LongSupplier capBytes) {
        cap = capBytes;
    }

    /** The cap's bytes now, or -1 for none. */
    long cap() {
        return cap.getAsLong();
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

    /** What the cap counts now: the tree and the trash, from the walk, and every unfinished upload's whole size. */
    synchronized long capUsed() throws IOException {
        walk();
        return countedLocked();
    }

    private long countedLocked() {
        @SuppressWarnings("unchecked")
        Map<String, Object> files = (Map<String, Object>) cachedFiles.get("files");
        @SuppressWarnings("unchecked")
        Map<String, Object> bin = (Map<String, Object>) cachedFiles.get("trash");
        return ((Number) files.get("bytes")).longValue() + ((Number) bin.get("bytes")).longValue() + reserved.getAsLong();
    }

    /** {@code no_space}'s details for the cap: {@code reason: cap}, the cap, what it counts and what's asked for. */
    Map<String, Object> capDetails(long cap, long used, long need) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("reason", "cap");
        d.put("capBytes", cap);
        d.put("capUsedBytes", used);
        d.put("needBytes", need);
        return d;
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
        boolean cached = walk();
        Map<String, Object> drive = new LinkedHashMap<>();
        drive.put("totalBytes", total);
        drive.put("usedBytes", Math.max(0, total - free));
        drive.put("freeBytes", free);
        @SuppressWarnings("unchecked")
        Map<String, Object> files = new LinkedHashMap<>((Map<String, Object>) cachedFiles.get("files"));
        if (cached) {
            files.put("approx", true);
        }
        long uploadable = Math.max(0, free - floor - owed.getAsLong());
        long capBytes = cap.getAsLong();
        Long capUsed = null;
        if (capBytes >= 0) {
            capUsed = countedLocked();
            uploadable = Math.min(uploadable, Math.max(0, capBytes - capUsed));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("drive", drive);
        out.put("files", files);
        out.put("trash", cachedFiles.get("trash"));
        out.put("floorBytes", floor);
        out.put("uploadableBytes", uploadable);
        out.put("computedAt", java.time.Instant.ofEpochMilli(cachedAt).toString());
        out.put("capBytes", capBytes >= 0 ? capBytes : null);
        out.put("capUsedBytes", capUsed);
        return out;
    }

    /** Walks the tree and the trash unless a walk under 60 s old is kept. @return whether the kept one was used */
    private boolean walk() {
        long now = clock.millis();
        boolean cached = cachedFiles != null && now - cachedAt < WALK_CACHE.toMillis() && now >= cachedAt;
        if (cached) {
            return true;
        }
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
        return false;
    }

    /**
     * An upload's file is in the tree now: its bytes go into the kept walk, which may have seen it already and then counts
     * it twice until the next walk, which is high and never low. With no walk kept there's nothing to add to.
     */
    synchronized void placed(long bytes) {
        if (cachedFiles == null) {
            return;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> files = new LinkedHashMap<>((Map<String, Object>) cachedFiles.get("files"));
        files.put("bytes", ((Number) files.get("bytes")).longValue() + bytes);
        Map<String, Object> both = new LinkedHashMap<>(cachedFiles);
        both.put("files", files);
        cachedFiles = both;
    }

    /** The next usage walk is a fresh one: something changed a lot. */
    synchronized void forget() {
        cachedFiles = null;
    }
}
