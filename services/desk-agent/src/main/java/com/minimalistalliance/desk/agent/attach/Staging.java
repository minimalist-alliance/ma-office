package com.minimalistalliance.desk.agent.attach;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Files the member has begun to attach and not yet sent, held in memory only (ADR 0049). A file arrives in chunks, each
 * one an RPC, into a buffer sized up front from the size the client declared, so nothing is copied to assemble it.
 * Nothing leaves memory: the buffer is zeroed when the member removes the file, when it expires ({@link #TTL} after
 * the last chunk or touch), when the message that uses it is sent, and when desk-agent stops.
 */
public final class Staging implements AutoCloseable {

    /** The largest chunk one call carries, which fits deskd's 1 MiB request as base64. */
    public static final int CHUNK = 512 * 1024;
    public static final long TTL_MILLIS = 10 * 60 * 1000L;
    static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{8,48}");

    /** One file ready for the reader: its cleaned name and its bytes (the staging buffer itself). */
    public record Staged(String name, byte[] bytes) {}

    /** How far an upload has got. */
    public record Receipt(String uploadId, long received, boolean complete) {}

    private static final class Entry {
        final String owner;
        final String agentId;
        final String name;
        final byte[] buffer;
        final boolean picture;
        int filled;
        int next;
        long touched;

        Entry(String owner, String agentId, String name, int size, boolean picture, long now) {
            this.picture = picture;
            this.owner = owner;
            this.agentId = agentId;
            this.name = name;
            this.buffer = new byte[size];
            this.touched = now;
        }

        boolean complete() {
            return filled == buffer.length;
        }
    }

    private final Clock clock;
    private final long maxBytes;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final ScheduledExecutorService sweeper;
    private long held;

    /** @param maxBytes the most all staged files may hold at once, whoever staged them */
    public Staging(Clock clock, long maxBytes) {
        this.clock = clock;
        this.maxBytes = maxBytes;
        this.sweeper = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "attach-staging-sweep");
            thread.setDaemon(true);
            return thread;
        });
        sweeper.scheduleWithFixedDelay(this::sweep, 30, 30, TimeUnit.SECONDS);
    }

    /**
     * Adds a chunk. The first chunk (index 0) checks the declared size against the caps, and every chunk must come in
     * order. A refusal drops the whole upload.
     */
    public synchronized Receipt put(String owner, String agentId, String uploadId, String name, long size, int index,
            byte[] chunk, Caps caps) throws AttachException {
        sweep();
        String clean = cleanName(name);
        if (!ID.matcher(uploadId).matches() || chunk.length == 0 || chunk.length > CHUNK || size < 1) {
            drop(uploadId);
            throw new AttachException("bad_upload", clean);
        }
        long now = clock.millis();
        Entry entry = entries.get(uploadId);
        if (index == 0 && entry == null) {
            Sniff.Kind kind = Sniff.of(clean, chunk);
            long cap = kind.format() == Sniff.Format.IMAGE ? caps.maxImageBytes() : caps.maxFileBytes();
            if (size > cap) {
                throw new AttachException("too_large", clean, cap);
            }
            if (size > Integer.MAX_VALUE - 16 || held + size > maxBytes) {
                throw new AttachException("staging_full", clean);
            }
            int mine = 0;
            long mineBytes = 0;
            for (Entry other : entries.values()) {
                if (other.owner.equals(owner) && other.agentId.equals(agentId)) {
                    mine++;
                    mineBytes += other.buffer.length;
                }
            }
            if (mine >= caps.maxFiles()) {
                throw new AttachException("too_many", clean, (long) caps.maxFiles());
            }
            // Said now rather than after the last file is up: one message's files can't pass the total.
            if (mineBytes + size > caps.maxTotalBytes()) {
                throw new AttachException("total_too_large", clean, caps.maxTotalBytes());
            }
            entry = new Entry(owner, agentId, clean, (int) size, kind.format() == Sniff.Format.IMAGE, now);
            entries.put(uploadId, entry);
            held += size;
        }
        if (entry == null || !entry.owner.equals(owner) || !entry.agentId.equals(agentId) || index != entry.next
                || entry.filled + chunk.length > entry.buffer.length || entry.buffer.length != size) {
            drop(uploadId);
            throw new AttachException("bad_upload", clean);
        }
        System.arraycopy(chunk, 0, entry.buffer, entry.filled, chunk.length);
        entry.filled += chunk.length;
        entry.next++;
        entry.touched = now;
        return new Receipt(uploadId, entry.filled, entry.complete());
    }

    /** The member removed a file, or gave up: its bytes are zeroed. Nothing for an id that isn't there. */
    public synchronized void remove(String owner, String uploadId) {
        Entry entry = entries.get(uploadId);
        if (entry != null && entry.owner.equals(owner)) {
            drop(uploadId);
        }
    }

    /**
     * The files of a message, taken out of staging in the order asked. The caller owns the buffers from here and must
     * wipe them.
     *
     * @throws AttachException {@code missing} if one isn't there, isn't this member's for this agent, or isn't
     *     whole; {@code too_many} past the cap
     */
    public synchronized List<Staged> take(String owner, String agentId, List<String> uploadIds, Caps caps)
            throws AttachException {
        sweep();
        if (uploadIds.size() > caps.maxFiles()) {
            throw new AttachException("too_many", null, (long) caps.maxFiles());
        }
        List<Staged> files = new ArrayList<>();
        for (String id : uploadIds) {
            Entry entry = entries.get(id);
            if (entry == null || !entry.owner.equals(owner) || !entry.agentId.equals(agentId) || !entry.complete()) {
                throw new AttachException("missing", entry == null ? null : entry.name);
            }
        }
        for (String id : uploadIds) {
            Entry entry = entries.remove(id);
            if (entry != null) {
                held -= entry.buffer.length;
                files.add(new Staged(entry.name, entry.buffer));
            }
        }
        return files;
    }

    /** The bytes of the pictures among these files, for those that are this member's for this agent. */
    public synchronized long pictureBytes(String owner, String agentId, List<String> uploadIds) {
        long bytes = 0;
        for (String id : new java.util.LinkedHashSet<>(uploadIds)) {
            Entry entry = entries.get(id);
            if (entry != null && entry.owner.equals(owner) && entry.agentId.equals(agentId) && entry.picture) {
                bytes += entry.buffer.length;
            }
        }
        return bytes;
    }

    /** Drops what no one has touched for {@link #TTL_MILLIS}. */
    public synchronized void sweep() {
        long now = clock.millis();
        Iterator<Map.Entry<String, Entry>> it = entries.entrySet().iterator();
        while (it.hasNext()) {
            Entry entry = it.next().getValue();
            if (now - entry.touched >= TTL_MILLIS) {
                Arrays.fill(entry.buffer, (byte) 0);
                held -= entry.buffer.length;
                it.remove();
            }
        }
    }

    public synchronized int count() {
        return entries.size();
    }

    public synchronized long heldBytes() {
        return held;
    }

    /** Zeroes and forgets everything. */
    /** Every file this member has half attached, wiped: their purge (ADR 0080's addendum of 2026-11-10). @return how many */
    public synchronized int dropOwner(String owner) {
        List<String> theirs = new ArrayList<>();
        for (Map.Entry<String, Entry> entry : entries.entrySet()) {
            if (entry.getValue().owner.equals(owner)) {
                theirs.add(entry.getKey());
            }
        }
        theirs.forEach(this::drop);
        return theirs.size();
    }

    public synchronized void dropAll() {
        for (Entry entry : entries.values()) {
            Arrays.fill(entry.buffer, (byte) 0);
        }
        entries.clear();
        held = 0;
    }

    private void drop(String uploadId) {
        Entry entry = entries.remove(uploadId);
        if (entry != null) {
            Arrays.fill(entry.buffer, (byte) 0);
            held -= entry.buffer.length;
        }
    }

    @Override
    public void close() {
        sweeper.shutdownNow();
        dropAll();
    }

    /** A file name as the thread and the prompt carry it: no path, no control characters or markup, 120 characters. */
    public static String cleanName(String name) {
        String base = name == null ? "" : name;
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        base = base.substring(slash + 1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < base.length(); i++) {
            char c = base.charAt(i);
            if (c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == '<' || c == '>' || c == '"' || c == '`'
                    || c == ' ' || c == ' ' || c == '‮') {
                out.append(' ');
            } else {
                out.append(c);
            }
        }
        String clean = out.toString().replaceAll("\\s+", " ").strip();
        if (clean.length() > 120) {
            int dot = clean.lastIndexOf('.');
            String extension = dot > 0 && clean.length() - dot <= 12 ? clean.substring(dot) : "";
            clean = clean.substring(0, 120 - extension.length()) + extension;
        }
        return clean.isEmpty() ? "file" : clean;
    }
}
