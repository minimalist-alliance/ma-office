package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.session.Session;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Uploads (files.md section 5): begin, status, finish and abort, and the 24-hour sweep. A partial lives in
 * {@code .uploads/<uploadId>.part} with a sidecar {@code <uploadId>.json}, and only {@code finish} makes it a file, by
 * one rename after the checks, so no half file is ever visible. {@link UploadWriter} is the running side.
 */
final class Uploads {

    private static final Logger log = LoggerFactory.getLogger(Uploads.class);

    private static final Pattern HEX64 = Pattern.compile("[0-9a-fA-F]{64}");
    static final long MAX_SIZE = (1L << 53) - 1;
    private static final long ONE_DAY_MS = Duration.ofDays(1).toMillis();

    /** What a sidecar holds that never changes. */
    record Meta(String id, String path, long size, boolean replace, String sha256, Long mtimeMs, String member, long createdAt) {}

    /** What finish needs of an upload whose last byte arrived in this process. */
    private record Done(String sha256, long size) {}

    private final SafeTree tree;
    private final Quota quota;
    private final Trash trash;
    private final Transfers transfers;
    private final SessionManager sessions;
    private final VerdictVerifier verifier;
    private final Clock clock;
    private final ChangeFeed feed;
    private final Runnable activity;
    private final Duration partialKeep;
    private final Duration finishWait;
    private final Map<String, UploadWriter> active = new ConcurrentHashMap<>();
    private final Map<String, Done> completed = new ConcurrentHashMap<>();
    private final Map<String, ReentrantLock> locks = new ConcurrentHashMap<>();

    Uploads(
            SafeTree tree,
            Quota quota,
            Trash trash,
            Transfers transfers,
            SessionManager sessions,
            VerdictVerifier verifier,
            Clock clock,
            ChangeFeed feed,
            Runnable activity,
            Duration partialKeep,
            Duration finishWait) {
        this.tree = tree;
        this.quota = quota;
        this.trash = trash;
        this.transfers = transfers;
        this.sessions = sessions;
        this.verifier = verifier;
        this.clock = clock;
        this.feed = feed;
        this.activity = activity;
        this.partialKeep = partialKeep;
        this.finishWait = finishWait;
    }

    /** Bytes moved for the member: the idle rule hears of it, at most once a minute. */
    void noteActivity() {
        activity.run();
    }

    long nowMs() {
        return clock.millis();
    }

    long keepNanos() {
        return partialKeep.toNanos();
    }

    long roomBeforeFloor() throws IOException {
        return quota.beforeFloor();
    }

    /** What running uploads still owe the drive: the bytes of their files not yet written. */
    long owedBytes() {
        long owed = 0;
        for (UploadWriter w : active.values()) {
            owed += Math.max(0, w.meta.size() - w.committed);
        }
        return owed;
    }

    int runningCount() {
        return active.size();
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String[] part(String id) {
        return new String[] {PathRules.UPLOADS, id + ".part"};
    }

    private static String[] sidecar(String id) {
        return new String[] {PathRules.UPLOADS, id + ".json"};
    }

    private ReentrantLock lockFor(String id) {
        return locks.computeIfAbsent(id, k -> new ReentrantLock());
    }

    // ---- the sidecar

    void writeSidecar(Meta meta, long durable, long lastProgressMs) throws IOException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("uploadId", meta.id());
        m.put("path", meta.path());
        m.put("size", meta.size());
        m.put("replace", meta.replace());
        m.put("sha256", meta.sha256());
        m.put("mtimeMs", meta.mtimeMs());
        m.put("member", meta.member());
        m.put("createdAt", meta.createdAt());
        m.put("durable", durable);
        m.put("lastProgressAt", lastProgressMs);
        try {
            tree.replaceSmall(new String[] {PathRules.UPLOADS}, meta.id() + ".json", Json.bytes(m));
        } catch (SafeTree.TreeException e) {
            throw new IOException(e.kind().name());
        }
    }

    private record Loaded(Meta meta, long durable, long lastProgressAt) {}

    private Loaded load(String id) {
        byte[] raw = tree.readSmall(sidecar(id), 16384);
        if (raw == null) {
            return null;
        }
        try {
            Map<String, Object> m = Json.parseObject(raw);
            Meta meta = new Meta(
                    Json.string(m, "uploadId"),
                    Json.string(m, "path"),
                    ((Number) m.get("size")).longValue(),
                    Boolean.TRUE.equals(m.get("replace")),
                    Json.string(m, "sha256"),
                    m.get("mtimeMs") instanceof Number n ? n.longValue() : null,
                    Json.string(m, "member"),
                    ((Number) m.get("createdAt")).longValue());
            if (!id.equals(meta.id()) || meta.path() == null || meta.member() == null) {
                return null;
            }
            return new Loaded(
                    meta,
                    m.get("durable") instanceof Number d ? d.longValue() : 0,
                    m.get("lastProgressAt") instanceof Number p ? p.longValue() : meta.createdAt());
        } catch (JsonFormatException | RuntimeException e) {
            return null;
        }
    }

    // ---- begin

    Map<String, Object> begin(RpcContext context, Map<String, Object> params) throws Exception {
        RpcPrincipal who = context.principal();
        String[] comps = PathRules.parse(params.get("path"), false, "path");
        long size = whole(params.get("size"), "size", MAX_SIZE);
        boolean replace = bool(params.get("replace"), "replace");
        String sha = params.get("sha256") == null ? null : hex64(params.get("sha256"));
        String token = params.get("token") == null ? null : string(params.get("token"), "token");
        Long mtimeMs = params.get("mtimeMs") == null ? null : clampMtime(whole(params.get("mtimeMs"), "mtimeMs", Long.MAX_VALUE / 4));
        if (token != null) {
            verifyToken(token, who.sub(), sha, size);
        }
        tree.lock.lock();
        try {
            checkDestination(comps, replace);
        } finally {
            tree.lock.unlock();
        }
        long uploadable = quota.uploadable();
        if (size > uploadable) {
            throw Errs.noSpace(quota.noSpaceDetails(size));
        }
        String id = Ids.next(clock.millis());
        Meta meta = new Meta(id, PathRules.join(comps), size, replace, sha, mtimeMs, who.sub(), clock.millis());
        Session session = sessions.session(who.sessionId());
        if (session == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        context.beginEffect();
        lockFor(id).lock();
        try {
            return attach(session, meta, 0, sha256(), true, false);
        } finally {
            lockFor(id).unlock();
        }
    }

    /**
     * Gives an upload a transfer in this session: a slot, the file open for writing from {@code offset}, and its thread.
     * @param fresh true for begin, which makes the partial
     */
    private Map<String, Object> attach(Session session, Meta meta, long offset, MessageDigest digest, boolean fresh, boolean status)
            throws RpcException, InterruptedException {
        FileChannel channel = null;
        Transfers.Slot slot = null;
        UploadWriter[] holder = new UploadWriter[1];
        try {
            slot = transfers.reserveUpload(session.sessionId(), new Transfers.ChunkSink() {
                @Override
                public void chunk(Session s, com.minimalistalliance.desk.deskd.protocol.Message m) throws InterruptedException {
                    UploadWriter w = holder[0];
                    if (w != null) {
                        w.chunk(s, m);
                    }
                }

                @Override
                public void sessionEnded() {
                    UploadWriter w = holder[0];
                    if (w != null) {
                        w.sessionEnded();
                    }
                }
            });
            if (fresh) {
                channel = tree.createNew(part(meta.id()));
                writeSidecar(meta, 0, clock.millis());
            } else {
                channel = tree.openFile(part(meta.id()), true);
            }
            UploadWriter writer = new UploadWriter(this, meta, session, slot, channel, digest, offset, clock.millis());
            holder[0] = writer;
            active.put(meta.id(), writer);
            writer.start();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("uploadId", meta.id());
            if (status) {
                out.put("path", meta.path());
                out.put("size", meta.size());
                out.put("committed", offset);
                out.put("transferId", slot.id());
                out.put("window", UploadWriter.WINDOW);
            } else {
                out.put("transferId", slot.id());
                out.put("offset", offset);
                out.put("window", UploadWriter.WINDOW);
                out.put("size", meta.size());
            }
            out.put("expiresAt", Instant.ofEpochMilli(clock.millis()).plus(partialKeep).toString());
            return out;
        } catch (SafeTree.TreeException e) {
            release(slot, channel);
            throw Errs.of(e);
        } catch (IOException e) {
            release(slot, channel);
            throw Errs.io(e);
        } catch (RpcException | RuntimeException e) {
            release(slot, channel);
            throw e;
        }
    }

    private static void release(Transfers.Slot slot, FileChannel channel) {
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException e) {
                // Abandoned.
            }
        }
        if (slot != null) {
            slot.release();
        }
    }

    // ---- status

    Map<String, Object> status(RpcContext context, Map<String, Object> params) throws Exception {
        RpcPrincipal who = context.principal();
        String id = uploadId(params.get("uploadId"));
        Session session = sessions.session(who.sessionId());
        if (session == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        ReentrantLock lock = lockFor(id);
        lock.lock();
        try {
            UploadWriter running = active.get(id);
            if (running != null) {
                if (!running.meta.member().equals(who.sub())) {
                    throw Errs.notFound();
                }
                // Another session (or this one, after a refresh) still has it: its transfer ends, superseded.
                running.stop("superseded", true);
                awaitEnd(running);
            }
            Loaded loaded = load(id);
            if (loaded == null || !loaded.meta().member().equals(who.sub())) {
                throw Errs.notFound();
            }
            Meta meta = loaded.meta();
            long committed = Math.min(loaded.durable(), meta.size());
            MessageDigest digest = sha256();
            try (FileChannel ch = tree.openFile(part(id), true)) {
                long length = ch.size();
                if (length < committed) {
                    committed = length;
                }
                if (length > committed) {
                    ch.truncate(committed);
                }
                hashInto(ch, committed, digest);
            } catch (SafeTree.TreeException e) {
                throw e.kind() == SafeTree.Kind.NOT_FOUND ? Errs.notFound() : Errs.of(e);
            } catch (IOException e) {
                throw Errs.io(e);
            }
            context.beginEffect();
            completed.remove(id);
            writeSidecar(meta, committed, clock.millis());
            return attach(session, meta, committed, digest, false, true);
        } finally {
            lock.unlock();
        }
    }

    private void awaitEnd(UploadWriter running) throws InterruptedException, RpcException {
        if (!running.ended.await(10, TimeUnit.SECONDS)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The upload is still busy", Map.of("reason", "busy"));
        }
    }

    private static void hashInto(FileChannel ch, long upTo, MessageDigest digest) throws IOException {
        ByteBuffer buf = ByteBuffer.allocate(1 << 20);
        long at = 0;
        while (at < upTo) {
            buf.clear().limit((int) Math.min(buf.capacity(), upTo - at));
            int n = ch.read(buf, at);
            if (n < 0) {
                throw new java.io.EOFException();
            }
            digest.update(buf.array(), 0, n);
            at += n;
        }
    }

    // ---- finish

    Map<String, Object> finish(RpcContext context, Map<String, Object> params) throws Exception {
        RpcPrincipal who = context.principal();
        String id = uploadId(params.get("uploadId"));
        String sha = hex64(params.get("sha256")).toLowerCase(java.util.Locale.ROOT);
        long size = whole(params.get("size"), "size", MAX_SIZE);
        String token = params.get("token") == null ? null : string(params.get("token"), "token");
        ReentrantLock lock = lockFor(id);
        lock.lock();
        try {
            UploadWriter running = active.get(id);
            if (running != null) {
                if (!running.meta.member().equals(who.sub())) {
                    throw Errs.notFound();
                }
                if (!running.sessionId().equals(who.sessionId())) {
                    throw new RpcException(RpcException.CONFLICT, "Another session is sending this upload", Map.of("reason", "attached"));
                }
                waitForLastByte(running);
            }
            Loaded loaded = load(id);
            if (loaded == null || !loaded.meta().member().equals(who.sub())) {
                throw Errs.notFound();
            }
            Meta meta = loaded.meta();
            if (size != meta.size()) {
                throw Errs.badRequest("size");
            }
            Done done = completed.get(id);
            String actual;
            if (done != null && done.size() == meta.size()) {
                actual = done.sha256();
            } else {
                actual = hashFromDisk(id, meta, loaded);
            }
            if (!actual.equals(sha)) {
                discard(id);
                throw new RpcException(Errs.HASH_MISMATCH, "The file is not what was sent", Map.of("committed", 0));
            }
            gate(id, meta, sha, token, who.sub());
            context.beginEffect();
            return place(id, meta, sha);
        } finally {
            lock.unlock();
        }
    }

    /** Waits for the last byte for up to finishWait since the latest one, then says what is missing. */
    private void waitForLastByte(UploadWriter running) throws InterruptedException, RpcException {
        long wait = finishWait.toNanos();
        while (!running.ended.await(Math.min(250, TimeUnit.NANOSECONDS.toMillis(wait) + 1), TimeUnit.MILLISECONDS)) {
            if (System.nanoTime() - running.lastByteNanos > wait) {
                throw incomplete(running.committed);
            }
        }
        if (running.endedWith != null) {
            throw incomplete(running.committed);
        }
    }

    private static RpcException incomplete(long committed) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("reason", "incomplete");
        d.put("committed", committed);
        return new RpcException(RpcException.CONFLICT, "Not every byte has arrived", d);
    }

    /** A partial deskd has no running digest for (a restart, a detached one): hashes what is on disk, if it is whole. */
    private String hashFromDisk(String id, Meta meta, Loaded loaded) throws RpcException, InterruptedException {
        try (FileChannel ch = tree.openFile(part(id), true)) {
            long length = ch.size();
            long committed = Math.min(length, loaded.durable() >= meta.size() ? meta.size() : loaded.durable());
            if (length > committed) {
                ch.truncate(committed);
            }
            if (committed != meta.size()) {
                throw incomplete(committed);
            }
            MessageDigest digest = sha256();
            hashInto(ch, committed, digest);
            return hex(digest.digest());
        } catch (SafeTree.TreeException e) {
            throw e.kind() == SafeTree.Kind.NOT_FOUND ? Errs.notFound() : Errs.of(e);
        } catch (IOException e) {
            throw Errs.io(e);
        }
    }

    /** The image gate (files.md section 6): sniffs the finished partial; an image needs a token for exactly these bytes. */
    private void gate(String id, Meta meta, String sha, String token, String member) throws RpcException, InterruptedException {
        String format;
        try (FileChannel ch = tree.openFile(part(id), false)) {
            ByteBuffer head = ByteBuffer.allocate(ImageSniff.HEAD_BYTES);
            while (head.hasRemaining() && ch.read(head, head.position()) >= 0 && head.position() < meta.size()) {
                // Filling the head.
            }
            format = ImageSniff.format(head.array(), head.position());
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        } catch (IOException e) {
            throw Errs.io(e);
        }
        if (format == null) {
            if (token != null) {
                throw checkInvalid("kind");
            }
            return;
        }
        if (token == null) {
            throw new RpcException(Errs.CHECK_REQUIRED, "An image needs the image check's token", Map.of("format", format));
        }
        verifyToken(token, member, sha, meta.size());
    }

    private void verifyToken(String token, String member, String sha, long size) throws RpcException, InterruptedException {
        try {
            verifier.verify(token, member, sha, size);
        } catch (VerdictVerifier.Invalid e) {
            throw checkInvalid(e.reason());
        }
    }

    private static RpcException checkInvalid(String reason) {
        return new RpcException(Errs.CHECK_INVALID, "The image check's token is not valid", Map.of("reason", reason));
    }

    /** Step 4 and 5 of finish: look again, make the folders, move the partial into place. */
    private Map<String, Object> place(String id, Meta meta, String sha) throws Exception {
        String[] comps = meta.path().split("/", -1);
        tree.lock.lock();
        try {
            SafeTree.Entry existing = checkDestination(comps, meta.replace());
            String replaced = null;
            String[] parent = java.util.Arrays.copyOf(comps, comps.length - 1);
            try {
                tree.mkdirs(parent);
                if (existing != null) {
                    replaced = trash.put(comps, meta.path(), false);
                }
                long mtime = meta.mtimeMs() == null ? clock.millis() : meta.mtimeMs();
                tree.setMtime(part(id), mtime);
                try (FileChannel ch = tree.openFile(part(id), true)) {
                    ch.force(true);
                }
                tree.move(part(id), comps);
                tree.syncDir(parent);
                tree.deleteTree(sidecar(id));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("path", meta.path());
                out.put("size", meta.size());
                out.put("mtimeMs", mtime);
                out.put("sha256", sha);
                out.put("replaced", replaced);
                completed.remove(id);
                locks.remove(id);
                feed.dir(PathRules.join(parent));
                if (replaced != null) {
                    feed.trash();
                }
                quota.forget();
                return out;
            } catch (SafeTree.TreeException e) {
                throw Errs.of(e);
            }
        } finally {
            tree.lock.unlock();
        }
    }

    /** The destination, free to write: no folder there, and no file unless {@code replace}. @return the file to replace, or null */
    SafeTree.Entry checkDestination(String[] comps, boolean replace) throws RpcException {
        try {
            for (int i = 1; i < comps.length; i++) {
                SafeTree.Entry e = tree.stat(java.util.Arrays.copyOf(comps, i));
                if (e == null) {
                    break;
                }
                if (!e.dir()) {
                    throw Errs.invalid("not_a_folder");
                }
            }
            SafeTree.Entry existing = tree.stat(comps);
            if (existing == null) {
                return null;
            }
            if (existing.dir()) {
                throw Errs.exists(true);
            }
            if (!replace) {
                throw Errs.exists(false);
            }
            return existing;
        } catch (SafeTree.TreeException e) {
            if (e.kind() == SafeTree.Kind.NOT_FOUND) {
                return null;
            }
            throw Errs.of(e);
        }
    }

    // ---- abort

    Map<String, Object> abort(RpcContext context, Map<String, Object> params) throws Exception {
        RpcPrincipal who = context.principal();
        String id = uploadId(params.get("uploadId"));
        ReentrantLock lock = lockFor(id);
        lock.lock();
        try {
            UploadWriter running = active.get(id);
            if (running != null) {
                if (!running.meta.member().equals(who.sub())) {
                    return Map.of();
                }
                context.beginEffect();
                running.stop("aborted", true);
                awaitEnd(running);
            } else {
                Loaded loaded = load(id);
                if (loaded != null && !loaded.meta().member().equals(who.sub())) {
                    return Map.of();
                }
                context.beginEffect();
            }
            discard(id);
            return Map.of();
        } finally {
            lock.unlock();
        }
    }

    private void discard(String id) {
        completed.remove(id);
        try {
            tree.deleteTree(part(id));
            tree.deleteTree(sidecar(id));
            tree.deleteTree(new String[] {PathRules.UPLOADS, id + ".json.tmp"});
        } catch (SafeTree.TreeException e) {
            log.warn("upload leftovers could not be removed: {}", e.kind());
        }
        locks.remove(id);
    }

    // ---- the writer's calls

    /** The thread is leaving. @param sha256 the whole file's digest if every byte was written */
    void writerEnded(UploadWriter writer, byte[] sha256) {
        active.remove(writer.meta.id(), writer);
        if (sha256 != null) {
            completed.put(writer.meta.id(), new Done(hex(sha256), writer.meta.size()));
        }
    }

    // ---- the sweep

    /** Removes partials that have seen no progress for the keep time, and leftovers with no partner. @return how many */
    int sweep() {
        int removed = 0;
        long now = clock.millis();
        long keep = partialKeep.toMillis();
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (String name : tree.names(new String[] {PathRules.UPLOADS})) {
            int dot = name.indexOf('.');
            if (dot > 0) {
                ids.add(name.substring(0, dot));
            }
        }
        for (String id : ids) {
            if (!Ids.valid(id) || active.containsKey(id)) {
                continue;
            }
            ReentrantLock lock = lockFor(id);
            if (!lock.tryLock()) {
                continue;
            }
            try {
                long last = 0;
                Loaded loaded = load(id);
                if (loaded != null) {
                    last = loaded.lastProgressAt();
                }
                BasicFileAttributes a = tree.rawAttrs(part(id));
                if (a != null) {
                    last = Math.max(last, a.lastModifiedTime().toMillis());
                }
                BasicFileAttributes s = tree.rawAttrs(sidecar(id));
                if (s != null) {
                    last = Math.max(last, s.lastModifiedTime().toMillis());
                }
                if (last == 0 || now - last >= keep) {
                    discard(id);
                    removed++;
                }
            } finally {
                lock.unlock();
            }
        }
        return removed;
    }

    /** Ends every running upload as deskd goes. */
    void close() {
        for (UploadWriter w : active.values()) {
            w.stop("session", false);
        }
        for (UploadWriter w : active.values()) {
            try {
                w.ended.await(3, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    // ---- parameters

    private static long clampMtime(long ms) {
        return Math.max(0, Math.min(ms, System.currentTimeMillis() + ONE_DAY_MS));
    }

    static long whole(Object value, String param, long max) throws RpcException {
        long n;
        if (value instanceof Long l) {
            n = l;
        } else if (value instanceof Integer i) {
            n = i;
        } else if (value instanceof Double d && d == Math.rint(d) && Math.abs(d) <= 9.007199254740991E15) {
            n = d.longValue();
        } else {
            throw Errs.badRequest(param);
        }
        if (n < 0 || n > max) {
            throw Errs.badRequest(param);
        }
        return n;
    }

    private static boolean bool(Object value, String param) throws RpcException {
        if (value == null) {
            return false;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        throw Errs.badRequest(param);
    }

    private static String string(Object value, String param) throws RpcException {
        if (value instanceof String s && !s.isEmpty() && s.length() <= 8192) {
            return s;
        }
        throw Errs.badRequest(param);
    }

    private static String hex64(Object value) throws RpcException {
        if (value instanceof String s && HEX64.matcher(s).matches()) {
            return s.toLowerCase(java.util.Locale.ROOT);
        }
        throw Errs.badRequest("sha256");
    }

    private static String uploadId(Object value) throws RpcException {
        if (!Ids.valid(value)) {
            throw Errs.badRequest("uploadId");
        }
        return (String) value;
    }
}
