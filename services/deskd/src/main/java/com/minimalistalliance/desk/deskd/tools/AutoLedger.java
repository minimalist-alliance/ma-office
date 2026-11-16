package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's own ledger of the calls desk-agent made without asking under a member's switch (draft ADR "the Agent's tools
 * and approvals", §15 "Checked twice"; Security's AAW-L2, AAW-I2, AAW-I3 and AAW-I4). desk-agent's word is never enough,
 * so deskd keeps, from what it ran itself:
 * <ul>
 *   <li><b>each approval id once:</b> a second call naming an id it has run is {@code approval_used}, so a wrong
 *       desk-agent can't reuse one, another agent's included;
 *   <li><b>the counts:</b> {@value #PER_RUN} a run and {@value #PER_DAY} an agent a day (the account's zone, or UTC),
 *       reserved under one lock before the call runs, so calls running at once can't pass them; a call refused or failed
 *       after it keeps its count;
 *   <li><b>what each call made,</b> for its undo: a file's path and the SHA-256 of what was written, a folder's path,
 *       the Notebook edit's key; and who undid it.
 * </ul>
 *
 * <p>Kept in {@code /data/desk/agent-auto.jsonl}, deskd's own (0600; desk-agent's user can't write {@code /data/desk}):
 * one JSON line per call as it ends and one per undo, appended and synced, {@value #KEEP_DAYS} days read back at start,
 * and the file written again without older lines when they pass half of it. A line that doesn't parse is skipped: a lost
 * call can't be undone from here (the member still can, in Files or the Notebook), and nothing else depends on it. Ids,
 * hashes, a group, a path at most: no content.
 */
public final class AutoLedger {

    private static final Logger log = LoggerFactory.getLogger(AutoLedger.class);

    public static final String FILE = "agent-auto.jsonl";
    static final int PER_RUN = 20;
    static final int PER_DAY = 100;
    static final int KEEP_DAYS = 30;
    /** Calls kept in memory at most; past it the oldest go (an agent at its cap makes 3,000 in 30 days). */
    static final int MAX_ENTRIES = 50_000;
    /** Runs whose counts are kept at once; the one idle longest goes first. */
    static final int MAX_RUNS = 512;
    static final int MAX_LINE = 8192;
    /** desk-agent's approval ids, as its gate mints them. */
    public static final Pattern APPROVAL_ID = Pattern.compile("ap-[a-z2-7]{20}");

    /**
     * One call done without asking, as deskd ran it.
     *
     * @param outcome {@code running} until it ends, then {@code done} or a refusal's word
     * @param made what it made, for its undo: {@code {kind: "file", path, sha256}}, {@code {kind: "folder", path}},
     *     {@code {kind: "notebook", key, pageId?, op}}, or null
     */
    public record Entry(String id, String agentId, String runId, String tool, String group, String argsSha256, long at,
            String outcome, Map<String, Object> made, Long undoneAt, String undoneBy) {

        public Entry {
            Objects.requireNonNull(id);
            Objects.requireNonNull(agentId);
            made = made == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(made));
        }

        Entry ended(String newOutcome, Map<String, Object> what) {
            return new Entry(id, agentId, runId, tool, group, argsSha256, at, newOutcome, what, undoneAt, undoneBy);
        }

        Entry undone(long when, String by) {
            return new Entry(id, agentId, runId, tool, group, argsSha256, at, outcome, made, when, by);
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("t", "call");
            out.put("id", id);
            out.put("agent", agentId);
            out.put("run", runId);
            out.put("tool", tool);
            out.put("group", group);
            out.put("sha", argsSha256);
            out.put("at", at);
            out.put("outcome", outcome);
            out.put("made", made);
            return out;
        }

        /** No path in logs. */
        @Override
        public String toString() {
            return "AutoLedger.Entry[" + id + ", " + tool + ", " + outcome + "]";
        }
    }

    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    /** Writes to the file, one at a time, apart from {@link #lock} so a reservation never waits on a disk. */
    private final ReentrantLock file = new ReentrantLock();
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
    /** Each agent's calls today: {dayStart, count}. */
    private final Map<String, long[]> days = new HashMap<>();
    private final LinkedHashMap<String, int[]> runs = new LinkedHashMap<>(16, 0.75f, true);
    private volatile Supplier<ZoneId> zone = () -> ZoneOffset.UTC;
    private volatile Path directory;
    /** Lines in the file now, and how many of them are current, for when to write it again. */
    private int lines;

    public AutoLedger(Clock clock) {
        this.clock = Objects.requireNonNull(clock);
    }

    /** The zone whose midnight ends an agent's day: the account's, or UTC when it's not known. */
    public void zone(Supplier<ZoneId> accountZone) {
        this.zone = accountZone == null ? () -> ZoneOffset.UTC : accountZone;
    }

    /** Reads the ledger from {@code dir} ({@code /data/desk}) and keeps it there from now on. Until then, RAM only. */
    public void keepIn(Path dir) {
        file.lock();
        try {
            lock.lock();
            try {
                this.directory = dir;
                load(dir.resolve(FILE));
            } finally {
                lock.unlock();
            }
        } finally {
            file.unlock();
        }
    }

    // ---------------------------------------------------------------- the call's side

    /**
     * Reserves a call: its id never seen, its run under {@value #PER_RUN} and its agent under {@value #PER_DAY} today, all
     * at once, under one lock; then its line is kept before the call runs (Security's AAB-I1), so a deskd that stops
     * mid-call still counts it and holds its id after a restart. A line that can't be kept (a full {@code /data}) refuses
     * the call, its reservation given back.
     *
     * @return null when reserved; else {@code approval_used} (an id run before), {@code approval_unknown} (a count) or
     *     {@code unavailable} (the line couldn't be kept)
     */
    public String reserve(String id, String agentId, String runId, String tool, String group, String argsSha256) {
        long now = clock.millis();
        long today = dayStart(now);
        Entry reserved;
        lock.lock();
        try {
            if (entries.containsKey(id)) {
                return "approval_used";
            }
            int[] run = runs.computeIfAbsent(runId, r -> new int[1]);
            long[] day = day(agentId, today);
            if (run[0] >= PER_RUN || day[1] >= PER_DAY) {
                return "approval_unknown";
            }
            run[0]++;
            day[1]++;
            while (runs.size() > MAX_RUNS) {
                runs.remove(runs.keySet().iterator().next());
            }
            reserved = new Entry(id, agentId, runId, tool, group, argsSha256, now, "running", null, null, null);
            put(reserved);
        } finally {
            lock.unlock();
        }
        Map<String, Object> line = reserved.toJson();
        line.put("t", "reserve");
        if (!append(line)) {
            lock.lock();
            try {
                entries.remove(id);
                int[] run = runs.get(runId);
                if (run != null && run[0] > 0) {
                    run[0]--;
                }
                long[] day = days.get(agentId);
                if (day != null && day[0] == today && day[1] > 0) {
                    day[1]--;
                }
            } finally {
                lock.unlock();
            }
            return "unavailable";
        }
        return null;
    }

    /** The call ended: {@code done} with what it made, or the word it was refused with. Kept and appended. */
    public void finish(String id, String outcome, Map<String, Object> made) {
        Entry ended;
        lock.lock();
        try {
            Entry e = entries.get(id);
            if (e == null) {
                return;
            }
            ended = e.ended(outcome, made);
            entries.put(id, ended);
        } finally {
            lock.unlock();
        }
        append(ended.toJson());
    }

    /** The call, as deskd ran it, or null for an id it doesn't hold (never one, or over 30 days ago). */
    public Entry get(String id) {
        lock.lock();
        try {
            return id == null ? null : entries.get(id);
        } finally {
            lock.unlock();
        }
    }

    /**
     * The member undid the call: stamped once and appended. @return false when it was already undone
     */
    public boolean undone(String id, String by) {
        long now = clock.millis();
        Entry e;
        lock.lock();
        try {
            e = entries.get(id);
            if (e == null || e.undoneAt() != null) {
                return false;
            }
            entries.put(id, e.undone(now, by));
        } finally {
            lock.unlock();
        }
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("t", "undo");
        line.put("id", id);
        line.put("at", now);
        line.put("by", by);
        append(line);
        return true;
    }

    /** A run ended: its count goes. */
    public void runEnded(String runId) {
        lock.lock();
        try {
            runs.remove(runId);
        } finally {
            lock.unlock();
        }
    }

    /** For tests and /health: calls held. */
    public int size() {
        lock.lock();
        try {
            return entries.size();
        } finally {
            lock.unlock();
        }
    }

    // ---------------------------------------------------------------- counts

    private long dayStart(long now) {
        ZoneId in;
        try {
            in = zone.get();
        } catch (RuntimeException e) {
            in = null;
        }
        if (in == null) {
            in = ZoneOffset.UTC;
        }
        return Instant.ofEpochMilli(now).atZone(in).toLocalDate().atStartOfDay(in).toInstant().toEpochMilli();
    }

    /** Under {@link #lock}: the agent's count today, counted from the entries when the day turns or at the first call. */
    private long[] day(String agentId, long today) {
        long[] day = days.get(agentId);
        if (day == null || day[0] != today) {
            long n = 0;
            for (Entry e : entries.values()) {
                if (e.agentId().equals(agentId) && e.at() >= today) {
                    n++;
                }
            }
            day = new long[] {today, n};
            days.put(agentId, day);
        }
        return day;
    }

    /** Under {@link #lock}. */
    private void put(Entry e) {
        entries.put(e.id(), e);
        while (entries.size() > MAX_ENTRIES) {
            entries.remove(entries.keySet().iterator().next());
        }
    }

    // ---------------------------------------------------------------- the file

    /** Appends one line, synced. @return false when it couldn't be kept (RAM only, before {@link #keepIn}, is kept) */
    private boolean append(Map<String, Object> line) {
        Path dir = directory;
        if (dir == null) {
            return true;
        }
        byte[] json = Json.bytes(line);
        byte[] bytes = new byte[json.length + 1];
        System.arraycopy(json, 0, bytes, 0, json.length);
        bytes[json.length] = '\n';
        file.lock();
        try {
            Path path = dir.resolve(FILE);
            try (FileChannel ch = openAppend(path)) {
                ByteBuffer buf = ByteBuffer.wrap(bytes);
                while (buf.hasRemaining()) {
                    ch.write(buf);
                }
                ch.force(false);
            }
            lines++;
            if (lines > 3 * Math.max(1000, size())) {
                try {
                    compact(path);
                } catch (IOException | RuntimeException e) {
                    log.warn("the unasked calls' ledger wasn't written again: {}", e.getClass().getSimpleName());
                }
            }
            return true;
        } catch (IOException | RuntimeException e) {
            log.warn("an unasked call's line wasn't kept: {}", e.getClass().getSimpleName());
            return false;
        } finally {
            file.unlock();
        }
    }

    private static FileChannel openAppend(Path path) throws IOException {
        if (Files.isSymbolicLink(path)) {
            throw new IOException("link");
        }
        Set<StandardOpenOption> options = EnumSet.of(StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                StandardOpenOption.APPEND);
        try {
            return FileChannel.open(path, options, PosixFilePermissions.asFileAttribute(
                    PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException e) {
            return FileChannel.open(path, options); // not a POSIX file system: only in a test
        }
    }

    /** Under {@link #file}: the current entries written whole, through a temporary file and a rename. */
    private void compact(Path path) throws IOException {
        List<Map<String, Object>> current = new ArrayList<>();
        lock.lock();
        try {
            for (Entry e : entries.values()) {
                current.add(e.toJson());
                if (e.undoneAt() != null) {
                    Map<String, Object> undo = new LinkedHashMap<>();
                    undo.put("t", "undo");
                    undo.put("id", e.id());
                    undo.put("at", e.undoneAt());
                    undo.put("by", e.undoneBy());
                    current.add(undo);
                }
            }
        } finally {
            lock.unlock();
        }
        Path temporary = path.resolveSibling(FILE + ".tmp");
        Files.deleteIfExists(temporary);
        try (FileChannel ch = openAppend(temporary)) {
            for (Map<String, Object> line : current) {
                ByteBuffer buf = ByteBuffer.wrap((new String(Json.bytes(line), StandardCharsets.UTF_8) + "\n")
                        .getBytes(StandardCharsets.UTF_8));
                while (buf.hasRemaining()) {
                    ch.write(buf);
                }
            }
            ch.force(true);
        }
        Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        lines = current.size();
    }

    /** Under both locks: the last {@value #KEEP_DAYS} days, a line that doesn't parse skipped. */
    private void load(Path path) {
        entries.clear();
        days.clear();
        lines = 0;
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            log.warn("the unasked calls' ledger isn't a file, so it's set aside");
            try {
                Files.move(path, path.resolveSibling(FILE + ".bad"), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException e) {
                // The next append fails on it, and says so.
            }
            return;
        }
        long since = clock.millis() - Duration.ofDays(KEEP_DAYS).toMillis();
        int skipped = 0;
        int old = 0;
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String text;
            while ((text = reader.readLine()) != null) {
                lines++;
                if (text.isBlank() || text.length() > MAX_LINE) {
                    skipped++;
                    continue;
                }
                Map<String, Object> line;
                try {
                    line = Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
                } catch (JsonFormatException | RuntimeException e) {
                    skipped++;
                    continue;
                }
                boolean reservation = "reserve".equals(line.get("t"));
                if ((reservation || "call".equals(line.get("t"))) && line.get("id") instanceof String id
                        && APPROVAL_ID.matcher(id).matches()
                        && line.get("agent") instanceof String agent && line.get("at") instanceof Number at) {
                    if (at.longValue() < since) {
                        old++;
                        continue;
                    }
                    @SuppressWarnings("unchecked")
                    Map<String, Object> made = line.get("made") instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
                    Entry before = entries.get(id);
                    if (reservation && before != null) {
                        continue;
                    }
                    // A reservation with no end: counted, its id held, and nothing to undo (it may or may not have run).
                    put(new Entry(id, agent, string(line.get("run")), string(line.get("tool")),
                            string(line.get("group")), string(line.get("sha")), at.longValue(),
                            reservation ? "unknown" : line.get("outcome") instanceof String o ? o : "unknown",
                            reservation ? null : made,
                            before == null ? null : before.undoneAt(), before == null ? null : before.undoneBy()));
                } else if ("undo".equals(line.get("t")) && line.get("id") instanceof String id
                        && line.get("at") instanceof Number at) {
                    Entry e = entries.get(id);
                    if (e != null && e.undoneAt() == null) {
                        entries.put(id, e.undone(at.longValue(), string(line.get("by"))));
                    }
                } else {
                    skipped++;
                }
            }
        } catch (IOException | RuntimeException e) {
            log.warn("the unasked calls' ledger wasn't read whole: {}", e.getClass().getSimpleName());
        }
        if (skipped > 0) {
            log.warn("{} lines of the unasked calls' ledger didn't read", skipped);
        }
        if (old > 0) {
            try {
                compact(path);
            } catch (IOException e) {
                log.warn("the unasked calls' ledger wasn't written again: {}", e.getClass().getSimpleName());
            }
        }
    }

    private static String string(Object value) {
        return value instanceof String s ? s : null;
    }

    @Override
    public String toString() {
        return "AutoLedger[" + size() + "]";
    }
}
