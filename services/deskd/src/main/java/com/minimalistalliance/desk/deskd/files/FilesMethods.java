package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.data.Transfer;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * The {@code files.*} RPCs (files.md sections 0 to 4 and 8), for the owner's sessions on a personal desk. Every handler
 * checks the desk kind and the tree first. A path is checked by {@link PathRules} before anything touches the tree, and
 * the namespace changes run under the tree's one lock.
 */
final class FilesMethods {

    static final int LIST_MAX = 2000;
    static final int SEARCH_MAX = 200;
    static final long SEARCH_ENTRIES = 200_000;
    static final long SEARCH_NANOS = 3_000_000_000L;
    private static final String BANDWIDTH_LIMIT = "bandwidth_limit";
    private static final int MAX_CURSOR_CHARS = 16 * 1024;

    private final SafeTree tree;
    private final Trash trash;
    private final Quota quota;
    private final Uploads uploads;
    private final Transfers transfers;
    private final ChangeFeed feed;
    private final Runnable activity;
    private final BooleanSupplier guildDesk;
    private final Clock clock;
    private final Map<String, AtomicBoolean> searches = new ConcurrentHashMap<>();
    private volatile Supplier<Instant> pausedUntil = () -> null;

    FilesMethods(
            SafeTree tree, Trash trash, Quota quota, Uploads uploads, Transfers transfers, ChangeFeed feed,
            Runnable activity, BooleanSupplier guildDesk, Clock clock) {
        this.tree = tree;
        this.trash = trash;
        this.quota = quota;
        this.uploads = uploads;
        this.transfers = transfers;
        this.feed = feed;
        this.activity = activity;
        this.guildDesk = guildDesk;
        this.clock = clock;
    }

    void pauseFrom(Supplier<Instant> until) {
        pausedUntil = until;
    }

    /** A method of an unusable tree: every call says why, and nothing is registered to run. */
    static void registerUnavailable(RpcDispatcher d, BooleanSupplier guildDesk) {
        RpcHandler refuse = (c, p) -> {
            if (guildDesk.getAsBoolean()) {
                throw scope();
            }
            throw new RpcException(RpcException.UNAVAILABLE, "The Files tree can't be used", Map.of("reason", "tree"));
        };
        for (String m : new String[] {"files.list", "files.stat", "files.search", "files.usage", "files.trash.list", "files.read", "files.read.stop"}) {
            d.register(m, refuse);
        }
        for (String m : new String[] {"files.mkdir", "files.rename", "files.delete", "files.trash.restore", "files.trash.empty", "files.upload.finish", "files.upload.abort"}) {
            d.registerMutation(m, refuse);
        }
        for (String m : new String[] {"files.upload.begin", "files.upload.status"}) {
            d.registerSessionMutation(m, RpcDispatcher.OWNER_ONLY, refuse);
        }
    }

    private static RpcException scope() {
        return new RpcException(RpcException.FORBIDDEN, "Files is not available on this desk", Map.of("reason", "scope"));
    }

    private RpcHandler guarded(RpcHandler handler) {
        return (context, params) -> {
            if (guildDesk.getAsBoolean()) {
                throw scope();
            }
            return handler.handle(context, params);
        };
    }

    void register(RpcDispatcher d) {
        d.register("files.list", guarded(this::list));
        d.register("files.stat", guarded(this::stat));
        d.register("files.search", guarded(this::search));
        d.register("files.usage", guarded(this::usage));
        d.registerMutation("files.mkdir", guarded(this::mkdir));
        d.registerMutation("files.rename", guarded(this::rename));
        d.registerMutation("files.delete", guarded(this::delete));
        d.register("files.trash.list", guarded(this::trashList));
        d.registerMutation("files.trash.restore", guarded(this::trashRestore));
        d.registerMutation("files.trash.empty", guarded(this::trashEmpty));
        d.registerSessionMutation("files.upload.begin", RpcDispatcher.OWNER_ONLY, guarded(uploads::begin));
        d.registerSessionMutation("files.upload.status", RpcDispatcher.OWNER_ONLY, guarded(uploads::status));
        d.registerMutation("files.upload.finish", guarded(uploads::finish));
        d.registerMutation("files.upload.abort", guarded(uploads::abort));
        d.register("files.read", guarded(this::read));
        d.register("files.read.stop", guarded(this::readStop));
    }

    // ---- reads of the tree

    private static Map<String, Object> entryMap(SafeTree.Entry e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", e.name());
        m.put("type", e.dir() ? "dir" : "file");
        m.put("size", e.dir() ? null : e.size());
        m.put("mtimeMs", e.mtimeMs());
        return m;
    }

    private Object list(RpcContext context, Map<String, Object> params) throws Exception {
        String[] comps = PathRules.parse(params.get("path"), true, "path");
        SafeTree.Entry after = null;
        Object cursor = params.get("cursor");
        if (cursor != null) {
            if (!(cursor instanceof String text) || text.length() > MAX_CURSOR_CHARS || (after = SafeTree.parseCursor(text)) == null) {
                throw Errs.invalid("cursor");
            }
        }
        int limit = LIST_MAX;
        if (params.get("limit") != null) {
            limit = (int) Uploads.whole(params.get("limit"), "limit", LIST_MAX);
            if (limit < 1) {
                throw Errs.badRequest("limit");
            }
        }
        // A page of long names could be past what a RES carries, so a smaller one is made. 2000, 500, 125, 31, 7, 1.
        for (; limit > 0; limit /= 4) {
            SafeTree.Page page;
            try {
                page = tree.list(comps, after, limit, true);
            } catch (SafeTree.TreeException e) {
                throw Errs.of(e);
            }
            List<Object> entries = new ArrayList<>(page.entries().size());
            for (SafeTree.Entry e : page.entries()) {
                entries.add(entryMap(e));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("entries", entries);
            out.put("next", page.next());
            out.put("skipped", page.skipped());
            if (Json.bytes(out).length <= FrameKind.RES.maxMessageBytes()) {
                return out;
            }
        }
        throw new RpcException(RpcException.TOO_LARGE, "A page does not fit", Map.of());
    }

    private Object stat(RpcContext context, Map<String, Object> params) throws Exception {
        String[] comps = PathRules.parse(params.get("path"), true, "path");
        SafeTree.Entry entry;
        try {
            entry = tree.stat(comps);
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        }
        if (entry == null) {
            throw Errs.notFound();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("entry", entryMap(entry));
        out.put("sniff", entry.dir() ? null : sniff(comps));
        return out;
    }

    private Map<String, Object> sniff(String[] comps) throws RpcException {
        try (FileChannel channel = tree.openRead(comps).channel()) {
            ByteBuffer head = ByteBuffer.allocate(ImageSniff.HEAD_BYTES);
            while (head.hasRemaining() && channel.read(head, head.position()) > 0) {
                // Filling.
            }
            String format = ImageSniff.format(head.array(), head.position());
            Map<String, Object> out = new LinkedHashMap<>();
            if (format == null) {
                out.put("kind", "other");
            } else {
                out.put("kind", "image");
                out.put("format", format);
            }
            return out;
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        } catch (IOException e) {
            throw Errs.io(e);
        }
    }

    private Object usage(RpcContext context, Map<String, Object> params) throws Exception {
        try {
            return quota.usage();
        } catch (IOException e) {
            throw Errs.io(e);
        }
    }

    // ---- search

    private Object search(RpcContext context, Map<String, Object> params) throws Exception {
        if (!(params.get("q") instanceof String q) || q.isEmpty() || q.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 255
                || !java.text.Normalizer.isNormalized(q, java.text.Normalizer.Form.NFC)) {
            throw Errs.badRequest("q");
        }
        String[] under = params.get("under") == null ? PathRules.ROOT : PathRules.parse(params.get("under"), true, "under");
        int limit = 100;
        if (params.get("limit") != null) {
            limit = (int) Uploads.whole(params.get("limit"), "limit", SEARCH_MAX);
            if (limit < 1) {
                throw Errs.badRequest("limit");
            }
        }
        String sessionId = context.principal().sessionId();
        AtomicBoolean mine = new AtomicBoolean();
        AtomicBoolean previous = searches.put(sessionId, mine);
        if (previous != null) {
            previous.set(true);
        }
        try {
            return runSearch(PathRules.fold(q), under, limit, mine);
        } finally {
            searches.remove(sessionId, mine);
        }
    }

    /** A hit and where it sits in the order: folders first, then shallower, then by path as a listing sorts. */
    private record Hit(SafeTree.Entry entry, String path, int depth) {}

    private static int compareHits(Hit a, Hit b) {
        if (a.entry().dir() != b.entry().dir()) {
            return a.entry().dir() ? -1 : 1;
        }
        if (a.depth() != b.depth()) {
            return Integer.compare(a.depth(), b.depth());
        }
        int c = SafeTree.compareBytes(PathRules.fold(a.path()), PathRules.fold(b.path()));
        return c != 0 ? c : SafeTree.compareBytes(a.path(), b.path());
    }

    private Object runSearch(String needle, String[] under, int limit, AtomicBoolean cancelled) throws Exception {
        long deadline = System.nanoTime() + SEARCH_NANOS;
        long[] visited = {0};
        boolean[] truncated = {false};
        boolean[] stopped = {false};
        PriorityQueue<Hit> best = new PriorityQueue<>(Comparator.comparing((Hit h) -> h, FilesMethods::compareHits).reversed());
        List<String[]> level = new ArrayList<>();
        level.add(under);
        int depth = 0;
        while (!level.isEmpty() && !stopped[0]) {
            List<String[]> next = new ArrayList<>();
            final int hitDepth = depth;
            for (String[] dirPath : level) {
                try (SafeTree.Dir dir = tree.openDir(dirPath)) {
                    tree.eachChild(dir, e -> {
                        if (dirPath.length == 0 && PathRules.isReserved(e.name())) {
                            return true;
                        }
                        if (cancelled.get() || Thread.currentThread().isInterrupted()) {
                            stopped[0] = true;
                            return false;
                        }
                        if (++visited[0] > SEARCH_ENTRIES || System.nanoTime() > deadline) {
                            truncated[0] = true;
                            stopped[0] = true;
                            return false;
                        }
                        String[] childPath = SafeTree.append(dirPath, e.name());
                        if (PathRules.fold(e.name()).contains(needle)) {
                            Hit hit = new Hit(e, PathRules.join(childPath), hitDepth);
                            if (best.size() < limit) {
                                best.add(hit);
                            } else if (compareHits(hit, best.peek()) < 0) {
                                best.poll();
                                best.add(hit);
                            }
                        }
                        if (e.dir()) {
                            next.add(childPath);
                        }
                        return true;
                    });
                } catch (SafeTree.TreeException e) {
                    if (e.kind() != SafeTree.Kind.NOT_FOUND && e.kind() != SafeTree.Kind.NOT_A_DIR) {
                        throw Errs.of(e);
                    }
                    if (depth == 0) {
                        throw Errs.of(e);
                    }
                }
                if (stopped[0]) {
                    break;
                }
            }
            if (cancelled.get() || Thread.currentThread().isInterrupted()) {
                throw new RpcException(RpcException.CANCELLED, "Cancelled");
            }
            level = next;
            depth++;
        }
        List<Hit> sorted = new ArrayList<>(best);
        sorted.sort(FilesMethods::compareHits);
        List<Object> entries = new ArrayList<>();
        for (Hit h : sorted) {
            Map<String, Object> m = entryMap(h.entry());
            m.put("path", h.path());
            entries.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("entries", entries);
        out.put("truncated", truncated[0]);
        return out;
    }

    // ---- changes

    private static String parentPath(String[] comps) {
        return PathRules.join(java.util.Arrays.copyOf(comps, Math.max(0, comps.length - 1)));
    }

    /** The folder a path sits in must exist, as a folder. */
    private void requireParent(String[] comps) throws RpcException, SafeTree.TreeException {
        if (comps.length <= 1) {
            return;
        }
        SafeTree.Entry parent = tree.stat(java.util.Arrays.copyOf(comps, comps.length - 1));
        if (parent == null) {
            throw Errs.notFound();
        }
        if (!parent.dir()) {
            throw Errs.invalid("not_a_folder");
        }
    }

    private Object mkdir(RpcContext context, Map<String, Object> params) throws Exception {
        String[] comps = PathRules.parse(params.get("path"), false, "path");
        boolean parents = params.get("parents") != null && bool(params.get("parents"), "parents");
        tree.lock.lock();
        try {
            SafeTree.Entry existing = tree.stat(comps);
            if (existing != null) {
                if (parents && existing.dir()) {
                    return Map.of("created", false);
                }
                throw Errs.exists(existing.dir());
            }
            if (parents) {
                for (int i = 1; i < comps.length; i++) {
                    SafeTree.Entry e = tree.stat(java.util.Arrays.copyOf(comps, i));
                    if (e != null && !e.dir()) {
                        throw Errs.invalid("not_a_folder");
                    }
                }
            } else {
                requireParent(comps);
            }
            context.beginEffect();
            int firstMissing = 0;
            for (int i = 1; i <= comps.length; i++) {
                if (tree.stat(java.util.Arrays.copyOf(comps, i)) == null) {
                    firstMissing = i;
                    break;
                }
            }
            if (parents) {
                tree.mkdirs(comps);
            } else {
                tree.mkdir(comps);
            }
            for (int i = Math.max(1, firstMissing); i <= comps.length; i++) {
                feed.dir(parentPath(java.util.Arrays.copyOf(comps, i)));
            }
            return Map.of("created", true);
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        } finally {
            tree.lock.unlock();
        }
    }

    private Object rename(RpcContext context, Map<String, Object> params) throws Exception {
        String[] from = PathRules.parse(params.get("from"), false, "from");
        String[] to = PathRules.parse(params.get("to"), false, "to");
        boolean replace = params.get("replace") != null && bool(params.get("replace"), "replace");
        if (java.util.Arrays.equals(from, to)) {
            Map<String, Object> same = new LinkedHashMap<>();
            same.put("path", PathRules.join(to));
            same.put("replaced", null);
            return same;
        }
        if (PathRules.startsWith(to, from)) {
            throw Errs.invalid("into_self");
        }
        tree.lock.lock();
        try {
            SafeTree.Entry source = tree.stat(from);
            if (source == null) {
                throw Errs.notFound();
            }
            requireParent(to);
            SafeTree.Entry target = tree.stat(to);
            String replaced = null;
            if (target != null) {
                if (target.dir() || source.dir() || !replace) {
                    throw Errs.exists(target.dir());
                }
            }
            context.beginEffect();
            if (target != null) {
                replaced = trash.put(to, PathRules.join(to), false);
            }
            tree.move(from, to);
            feed.dir(parentPath(from));
            feed.dir(parentPath(to));
            if (replaced != null) {
                feed.trash();
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("path", PathRules.join(to));
            out.put("replaced", replaced);
            return out;
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        } finally {
            tree.lock.unlock();
        }
    }

    private Object delete(RpcContext context, Map<String, Object> params) throws Exception {
        if (!(params.get("paths") instanceof List<?> paths) || paths.isEmpty() || paths.size() > 200) {
            throw Errs.badRequest("paths");
        }
        boolean permanent = params.get("permanent") != null && bool(params.get("permanent"), "permanent");
        for (Object p : paths) {
            if (!(p instanceof String s)) {
                throw Errs.badRequest("paths");
            }
            if (s.isEmpty()) {
                throw Errs.invalid("empty");
            }
            if (permanent != s.startsWith(PathRules.TRASH_PREFIX)) {
                throw Errs.invalid("permanent");
            }
        }
        context.beginEffect();
        List<Object> results = new ArrayList<>();
        tree.lock.lock();
        try {
            for (Object p : paths) {
                String path = (String) p;
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("path", path);
                try {
                    if (permanent) {
                        String id = path.substring(PathRules.TRASH_PREFIX.length());
                        if (!Ids.valid(id) || trash.get(id) == null) {
                            throw Errs.notFound();
                        }
                        trash.deleteForGood(id);
                        feed.trash();
                        r.put("ok", true);
                    } else {
                        String[] comps = PathRules.parse(path, false, "path");
                        SafeTree.Entry e = tree.stat(comps);
                        if (e == null) {
                            throw Errs.notFound();
                        }
                        String id = trash.put(comps, PathRules.join(comps), e.dir());
                        feed.dir(parentPath(comps));
                        feed.trash();
                        r.put("ok", true);
                        r.put("trashId", id);
                    }
                } catch (RpcException e) {
                    r.put("ok", false);
                    r.put("code", e.code());
                } catch (SafeTree.TreeException e) {
                    r.put("ok", false);
                    r.put("code", Errs.of(e).code());
                }
                results.add(r);
            }
        } finally {
            tree.lock.unlock();
        }
        quota.forget();
        return Map.of("results", results);
    }

    // ---- trash

    private Object trashList(RpcContext context, Map<String, Object> params) throws Exception {
        String after = null;
        if (params.get("cursor") != null) {
            if (!Ids.valid(params.get("cursor"))) {
                throw Errs.invalid("cursor");
            }
            after = (String) params.get("cursor");
        }
        int limit = 500;
        if (params.get("limit") != null) {
            limit = (int) Uploads.whole(params.get("limit"), "limit", 500);
            if (limit < 1) {
                throw Errs.badRequest("limit");
            }
        }
        tree.lock.lock();
        try {
            List<Trash.Item> items = trash.list(after, limit);
            List<Object> out = new ArrayList<>();
            for (Trash.Item i : items) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", i.id());
                m.put("name", i.name());
                m.put("originalPath", i.originalPath());
                m.put("type", i.dir() ? "dir" : "file");
                m.put("bytes", i.bytes());
                m.put("deletedAt", Instant.ofEpochMilli(i.deletedAt()).toString());
                m.put("purgeAt", Instant.ofEpochMilli(i.purgeAt()).toString());
                out.add(m);
            }
            Map<String, Object> reply = new LinkedHashMap<>();
            reply.put("items", out);
            reply.put("next", items.size() >= limit && trash.moreAfter(items.get(items.size() - 1).id()) ? items.get(items.size() - 1).id() : null);
            return reply;
        } finally {
            tree.lock.unlock();
        }
    }

    private Object trashRestore(RpcContext context, Map<String, Object> params) throws Exception {
        if (!Ids.valid(params.get("id"))) {
            throw Errs.badRequest("id");
        }
        String id = (String) params.get("id");
        tree.lock.lock();
        try {
            Trash.Item item = trash.get(id);
            if (item == null) {
                throw Errs.notFound();
            }
            String[] dest = PathRules.parse(params.get("to") != null ? params.get("to") : item.originalPath(), false, "to");
            for (int i = 1; i < dest.length; i++) {
                SafeTree.Entry e = tree.stat(java.util.Arrays.copyOf(dest, i));
                if (e == null) {
                    break;
                }
                if (!e.dir()) {
                    throw Errs.invalid("not_a_folder");
                }
            }
            SafeTree.Entry taken = tree.stat(dest);
            if (taken != null) {
                throw Errs.exists(taken.dir(), freeName(dest));
            }
            context.beginEffect();
            tree.mkdirs(java.util.Arrays.copyOf(dest, dest.length - 1));
            tree.move(trash.itemPath(id), dest);
            trash.forget(id);
            feed.dir(parentPath(dest));
            feed.trash();
            return Map.of("path", PathRules.join(dest));
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        } finally {
            tree.lock.unlock();
        }
    }

    /** A free name beside a taken one: {@code name (restored).ext}, then {@code name (restored 2).ext}. */
    private String freeName(String[] taken) throws SafeTree.TreeException {
        String name = taken[taken.length - 1];
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; n < 10_000; n++) {
            String candidate = stem + (n == 1 ? " (restored)" : " (restored " + n + ")") + ext;
            String[] path = SafeTree.append(java.util.Arrays.copyOf(taken, taken.length - 1), candidate);
            if (tree.stat(path) == null && candidate.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= PathRules.MAX_NAME_BYTES) {
                return PathRules.join(path);
            }
        }
        return PathRules.join(taken) + " (restored)";
    }

    private Object trashEmpty(RpcContext context, Map<String, Object> params) throws Exception {
        tree.lock.lock();
        try {
            context.beginEffect();
            long[] r = trash.empty();
            feed.trash();
            quota.forget();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("deleted", r[0]);
            out.put("freedBytes", r[1]);
            return out;
        } catch (SafeTree.TreeException e) {
            throw Errs.of(e);
        } finally {
            tree.lock.unlock();
        }
    }

    // ---- download

    private Object read(RpcContext context, Map<String, Object> params) throws Exception {
        String[] comps = PathRules.parse(params.get("path"), false, "path");
        long offset = params.get("offset") == null ? 0 : Uploads.whole(params.get("offset"), "offset", Uploads.MAX_SIZE);
        refuseIfPaused();
        SafeTree.Opened opened;
        try {
            opened = tree.openRead(comps);
        } catch (SafeTree.TreeException e) {
            if (e.kind() == SafeTree.Kind.NOT_A_DIR) {
                throw Errs.invalid("is_a_folder");
            }
            throw Errs.of(e);
        }
        FileChannel channel = opened.channel();
        Transfer transfer;
        try {
            if (offset > opened.size()) {
                throw Errs.badRequest("offset");
            }
            transfer = transfers.reserve(context.principal().sessionId());
        } catch (RpcException | RuntimeException e) {
            channel.close();
            throw e;
        }
        FileBody body = new FileBody(channel, opened.size(), opened.mtimeMs(), offset, activity);
        if (!transfer.attach(body)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        context.afterReply(transfer::start, transfer::stop);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("transferId", transfer.id());
        out.put("size", body.size());
        out.put("mtimeMs", body.mtimeMs());
        return out;
    }

    private void refuseIfPaused() throws RpcException {
        Instant until = pausedUntil.get();
        if (until == null) {
            return;
        }
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", BANDWIDTH_LIMIT);
        details.put("resumesAt", until.equals(Instant.MAX) ? null : until.toString());
        throw new RpcException(RpcException.UNAVAILABLE, "Paused at the bandwidth limit", details);
    }

    private Object readStop(RpcContext context, Map<String, Object> params) throws Exception {
        long transferId = Uploads.whole(params.get("transferId"), "transferId", 0xFFFFFFFFL);
        transfers.stop(context.principal().sessionId(), transferId);
        return Map.of();
    }

    private static boolean bool(Object value, String param) throws RpcException {
        if (value instanceof Boolean b) {
            return b;
        }
        throw Errs.badRequest(param);
    }
}
