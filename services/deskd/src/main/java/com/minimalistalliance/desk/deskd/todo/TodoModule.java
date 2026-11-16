package com.minimalistalliance.desk.deskd.todo;

import com.minimalistalliance.desk.deskd.data.Transfer;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * To-do in deskd (API.md §22; the To-do VISION's Part 2): the store {@code /data/desk/todo.db} ({@link TodoStore}), the
 * member's {@code todo.*} methods, the topic {@code todo}, the nightly tidy, the export, and the store the agent's tools
 * use ({@link #store()}).
 *
 * <p><b>On by default, with a kill switch</b> ({@code /data/desk/todo-switch} saying {@code off}), as every prelaunch
 * feature. A guild desk has none ({@code forbidden}, {@code reason: scope}). A teen's desk has it: it's a plain list there,
 * as the Agent is off. A store that can't open (a schema from a newer release, SQLite's library missing) makes every call
 * {@code unavailable} with {@code reason: store}, and nothing else in deskd changes.
 */
public final class TodoModule implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(TodoModule.class);

    public static final String SWITCH_FILE = "todo-switch";
    static final String TOPIC = "todo";
    static final int SEEN_MAX = 200;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern TIME = Pattern.compile("\\d{2}:\\d{2}");
    private static final Pattern AGENT = Pattern.compile("agent:[A-Za-z0-9_-]{1,64}");

    private final TodoStore store;
    private final BooleanSupplier guildDesk;
    private final Switch todoSwitch;
    private final EventHub hub;
    private final Clock clock;
    private final ScheduledExecutorService timer;
    private volatile Transfers transfers;

    /**
     * @param directory deskd's own directory on the volume ({@code /data/desk}): the store and the switch
     * @param zone the member's IANA zone now, or null for UTC
     */
    public TodoModule(RpcDispatcher dispatcher, EventHub hub, Path directory, BooleanSupplier guildDesk,
            Supplier<ZoneId> zone, Clock clock) {
        this.guildDesk = guildDesk;
        this.hub = hub;
        this.clock = clock;
        this.todoSwitch = new Switch(directory == null ? null : directory.resolve(SWITCH_FILE));
        TodoStore opened = null;
        if (directory != null) {
            try {
                opened = TodoStore.open(directory.resolve(TodoStore.FILE), clock, zone);
            } catch (SQLException | RuntimeException | LinkageError e) {
                log.warn("To-do's store can't be opened: {}", e.getClass().getSimpleName());
            }
        }
        this.store = opened;
        this.timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "todo-tidy");
            t.setDaemon(true);
            return t;
        });
        hub.topics().register(TOPIC, new Feed());
        register(dispatcher);
        if (store != null) {
            store.onChange(changes -> {
                for (TodoStore.Change change : changes) {
                    Map<String, Object> data = new LinkedHashMap<>();
                    data.put("op", change.op());
                    data.put("id", change.id());
                    data.put("rev", change.rev());
                    hub.publish(TOPIC, "changed", data);
                }
            });
            // At start, then nightly: retention (closed a year, the Trash 30 days).
            timer.scheduleWithFixedDelay(this::tidy, 1, TimeUnit.DAYS.toMinutes(1), TimeUnit.MINUTES);
        }
    }

    /** The data module's transfer table, for {@code todo.export} on {@code bulk}. */
    public void exportsThrough(Transfers table) {
        this.transfers = table;
    }

    /** The store for the agent's tools, or null while To-do can't be used (no store, switched off, a guild desk). */
    public TodoStore store() {
        return refusal() == null ? store : null;
    }

    /** Whether the store opened. */
    public boolean available() {
        return store != null;
    }

    private final java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        timer.shutdownNow();
        if (store != null) {
            store.close();
        }
    }

    void tidy() {
        TodoStore s = store;
        if (s == null) {
            return;
        }
        try {
            int removed = s.tidy();
            if (removed > 0) {
                log.info("to-do tidy removed {} items", removed);
            }
        } catch (SQLException | RuntimeException e) {
            log.warn("to-do tidy failed: {}", e.getClass().getSimpleName());
        }
    }

    /** Why a call is refused now, or null: the desk's kind, the store, then the switch. */
    RpcException refusal() {
        if (guildDesk.getAsBoolean()) {
            return new RpcException(RpcException.FORBIDDEN, "No To-do on this desk", Map.of("reason", "scope"));
        }
        if (store == null) {
            return new RpcException(RpcException.UNAVAILABLE, "To-do's store can't be used", Map.of("reason", "store"));
        }
        if (!todoSwitch.on()) {
            return new RpcException(RpcException.UNAVAILABLE, "To-do is switched off", Map.of("reason", "switched_off"));
        }
        return null;
    }

    // ---------------------------------------------------------------- the methods

    private RpcHandler guarded(RpcHandler handler) {
        return (context, params) -> {
            RpcException no = refusal();
            if (no != null) {
                throw no;
            }
            try {
                return handler.handle(context, params);
            } catch (TodoStore.Refused r) {
                throw rpc(r);
            }
        };
    }

    private void register(RpcDispatcher d) {
        d.register("todo.list", guarded(this::list));
        d.register("todo.get", guarded(this::get));
        d.register("todo.summary", guarded((c, p) -> {
            only(p, Set.of());
            return store.summary();
        }));
        d.register("todo.changes", guarded(this::changes));
        d.register("todo.export", guarded(this::export));
        d.registerMutation("todo.add", guarded(this::add));
        d.registerMutation("todo.update", guarded(this::update));
        d.registerMutation("todo.close", guarded((c, p) -> {
            only(p, Set.of("id", "as"));
            String as = p.get("as") instanceof String a && Set.of("done", "not_needed").contains(a) ? a : null;
            if (as == null) {
                throw bad("as");
            }
            String id = id(p, "id");
            c.beginEffect();
            return store.memberClose(idem(c, "todo.close", p), id, as);
        }));
        d.registerMutation("todo.reopen", guarded((c, p) -> {
            only(p, Set.of("id"));
            String id = id(p, "id");
            c.beginEffect();
            return store.memberReopen(idem(c, "todo.reopen", p), id);
        }));
        d.registerMutation("todo.snooze", guarded((c, p) -> {
            only(p, Set.of("id", "until"));
            String id = id(p, "id");
            Long until = null;
            if (p.get("until") != null) {
                if (!(p.get("until") instanceof Number n) || n.doubleValue() != n.longValue()
                        || n.longValue() > clock.millis() + TimeUnit.DAYS.toMillis(400) || n.longValue() < 0) {
                    throw bad("until");
                }
                until = n.longValue();
            } else if (!p.containsKey("until")) {
                throw bad("until");
            }
            c.beginEffect();
            return store.memberSnooze(idem(c, "todo.snooze", p), id, until);
        }));
        d.registerMutation("todo.pin", guarded((c, p) -> {
            only(p, Set.of("id", "on"));
            String id = id(p, "id");
            if (!(p.get("on") instanceof Boolean on)) {
                throw bad("on");
            }
            c.beginEffect();
            return store.memberPin(idem(c, "todo.pin", p), id, on);
        }));
        d.registerMutation("todo.answer", guarded((c, p) -> {
            only(p, Set.of("id", "accept"));
            String id = id(p, "id");
            if (!(p.get("accept") instanceof Boolean accept)) {
                throw bad("accept");
            }
            c.beginEffect();
            return store.memberAnswer(idem(c, "todo.answer", p), id, accept);
        }));
        d.registerMutation("todo.trash", guarded((c, p) -> {
            only(p, Set.of("id"));
            String id = id(p, "id");
            c.beginEffect();
            return store.memberTrash(idem(c, "todo.trash", p), id);
        }));
        d.registerMutation("todo.restore", guarded((c, p) -> {
            only(p, Set.of("id"));
            String id = id(p, "id");
            c.beginEffect();
            return store.memberRestore(idem(c, "todo.restore", p), id);
        }));
        d.registerMutation("todo.undo", guarded((c, p) -> {
            only(p, Set.of("eventId"));
            String eventId = id(p, "eventId");
            c.beginEffect();
            return store.memberUndo(idem(c, "todo.undo", p), eventId);
        }));
        d.registerMutation("todo.seen", guarded((c, p) -> {
            only(p, Set.of("ids"));
            if (!(p.get("ids") instanceof List<?> list) || list.size() > SEEN_MAX) {
                throw bad("ids");
            }
            List<String> ids = new ArrayList<>();
            for (Object o : list) {
                if (!(o instanceof String s) || !ID.matcher(s).matches()) {
                    throw bad("ids");
                }
                ids.add(s);
            }
            c.beginEffect();
            return store.memberSeen(idem(c, "todo.seen", p), ids);
        }));
    }

    private Object list(RpcContext context, Map<String, Object> p) throws Exception {
        only(p, Set.of("view", "by", "source", "q", "cursor", "limit"));
        if (!(p.get("view") instanceof String view) || !Set.of("needs_you", "open", "done", "trash").contains(view)) {
            throw bad("view");
        }
        String by = null;
        if (p.get("by") != null) {
            if (!(p.get("by") instanceof String b) || !(b.equals("member") || b.equals("agents") || AGENT.matcher(b).matches())) {
                throw bad("by");
            }
            by = b;
        }
        String source = null;
        if (p.get("source") != null) {
            if (!(p.get("source") instanceof String s) || !TodoStore.SOURCE_KINDS.contains(s)) {
                throw bad("source");
            }
            source = s;
        }
        String q = null;
        if (p.get("q") != null) {
            if (!(p.get("q") instanceof String text) || text.length() > 100) {
                throw bad("q");
            }
            q = text;
        }
        String cursor = null;
        if (p.get("cursor") != null) {
            if (!(p.get("cursor") instanceof String c) || !c.matches("\\d{1,7}")) {
                throw bad("cursor");
            }
            cursor = c;
        }
        int limit = 50;
        if (p.get("limit") != null) {
            if (!(p.get("limit") instanceof Number n) || n.doubleValue() != n.intValue() || n.intValue() < 1
                    || n.intValue() > 100) {
                throw bad("limit");
            }
            limit = n.intValue();
        }
        return store.list(new TodoStore.ListQuery(view, by, source, q, null, cursor, limit));
    }

    private Object get(RpcContext context, Map<String, Object> p) throws Exception {
        only(p, Set.of("id"));
        Map<String, Object> out = store.get(id(p, "id"), TodoStore.EVENTS_IN_GET);
        if (out == null) {
            throw new RpcException(RpcException.NOT_FOUND, "No such to-do", Map.of("reason", "item"));
        }
        return out;
    }

    private Object changes(RpcContext context, Map<String, Object> p) throws Exception {
        only(p, Set.of("since"));
        if (!(p.get("since") instanceof Number n) || n.doubleValue() != n.longValue() || n.longValue() < 0) {
            throw bad("since");
        }
        return store.changes(n.longValue());
    }

    private Object add(RpcContext context, Map<String, Object> p) throws Exception {
        only(p, Set.of("title", "note", "due", "pinned"));
        String title = p.get("title") instanceof String t ? TodoText.title(t) : null;
        if (title == null) {
            throw bad("title");
        }
        String note = note(p);
        TodoStore.Due due = due(p.get("due"));
        boolean pinned = false;
        if (p.get("pinned") != null) {
            if (!(p.get("pinned") instanceof Boolean b)) {
                throw bad("pinned");
            }
            pinned = b;
        }
        context.beginEffect();
        return store.memberAdd(idem(context, "todo.add", p), title, note, due, pinned);
    }

    private Object update(RpcContext context, Map<String, Object> p) throws Exception {
        only(p, Set.of("id", "rev", "title", "note", "due"));
        String id = id(p, "id");
        if (!(p.get("rev") instanceof Number rev) || rev.doubleValue() != rev.longValue()) {
            throw bad("rev");
        }
        Map<String, Object> changes = new LinkedHashMap<>();
        if (p.containsKey("title")) {
            String title = p.get("title") instanceof String t ? TodoText.title(t) : null;
            if (title == null) {
                throw bad("title");
            }
            changes.put("title", title);
        }
        if (p.containsKey("note")) {
            changes.put("note", note(p));
        }
        if (p.containsKey("due")) {
            TodoStore.Due due = due(p.get("due"));
            changes.put("due", due == null ? null : due.wire());
        }
        context.beginEffect();
        return store.memberUpdate(idem(context, "todo.update", p), id, rev.longValue(), changes);
    }

    /** {@code todo.export}: the whole list as a file on {@code bulk}, as {@code files.read} sends one. */
    private Object export(RpcContext context, Map<String, Object> p) throws Exception {
        only(p, Set.of("format"));
        if (!(p.get("format") instanceof String format) || !Set.of("md", "json").contains(format)) {
            throw bad("format");
        }
        Transfers table = transfers;
        if (table == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Exports aren't ready", Map.of("reason", "export"));
        }
        byte[] bytes = TodoExport.render(store, format, clock);
        Transfer transfer = table.reserve(context.principal().sessionId());
        BytesBody body = new BytesBody(bytes, clock.millis());
        if (!transfer.attach(body)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        context.afterReply(transfer::start, transfer::stop);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("transferId", transfer.id());
        out.put("size", bytes.length);
        out.put("mtimeMs", body.mtimeMs());
        out.put("name", "To-do " + store.today() + ("md".equals(format) ? ".md" : ".json"));
        return out;
    }

    // ---------------------------------------------------------------- params

    private static TodoStore.Idem idem(RpcContext context, String method, Map<String, Object> params) {
        return new TodoStore.Idem(context.idem(), method, params);
    }

    private static String note(Map<String, Object> p) throws RpcException {
        Object raw = p.get("note");
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof String n)) {
            throw bad("note");
        }
        try {
            return TodoText.note(n);
        } catch (IllegalArgumentException e) {
            throw bad("note");
        }
    }

    /** The member's {@code due}: a real day and an optional time, in their zone; null is none. */
    static TodoStore.Due due(Object raw) throws RpcException {
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> due) || !(due.get("date") instanceof String date) || !DATE.matcher(date).matches()) {
            throw bad("due");
        }
        for (Object k : due.keySet()) {
            if (!"date".equals(k) && !"time".equals(k)) {
                throw bad("due");
            }
        }
        try {
            if (!LocalDate.parse(date).toString().equals(date)) {
                throw bad("due");
            }
        } catch (DateTimeParseException e) {
            throw bad("due");
        }
        String time = null;
        if (due.get("time") != null) {
            if (!(due.get("time") instanceof String t) || !TIME.matcher(t).matches()) {
                throw bad("due");
            }
            try {
                LocalTime.parse(t);
            } catch (DateTimeParseException e) {
                throw bad("due");
            }
            time = t;
        }
        return new TodoStore.Due(date, time, "member");
    }

    private static String id(Map<String, Object> p, String key) throws RpcException {
        if (!(p.get(key) instanceof String id) || !ID.matcher(id).matches()) {
            throw bad("id");
        }
        return id;
    }

    private static void only(Map<String, Object> p, Set<String> keys) throws RpcException {
        for (String k : p.keySet()) {
            if (!keys.contains(k)) {
                throw bad(k.length() <= 32 && k.matches("[A-Za-z_]+") ? k : "params");
            }
        }
    }

    static RpcException bad(String reason) {
        return new RpcException(RpcException.BAD_REQUEST, "Bad params", Map.of("reason", reason));
    }

    /** API.md §22's errors for the store's refusals. */
    static RpcException rpc(TodoStore.Refused r) {
        Map<String, Object> details = new LinkedHashMap<>(r.details());
        return switch (r.reason()) {
            case "not_found" -> new RpcException(RpcException.NOT_FOUND, "No such to-do",
                    Map.of("reason", details.getOrDefault("reason", "item")));
            case "rev" -> {
                details.put("reason", "rev");
                yield new RpcException(RpcException.PRECONDITION_FAILED, "Changed since", details);
            }
            case "view", "cursor" -> bad(r.reason());
            default -> {
                details.put("reason", r.reason());
                yield new RpcException(RpcException.CONFLICT, "Not done", details);
            }
        };
    }

    // ---------------------------------------------------------------- the topic

    /** {@code todo}: a snapshot of {@code {rev}}, then {@code changed} events {@code {op, id, rev}}. Ids only. */
    private final class Feed implements Topic {
        @Override
        public boolean coalescible() {
            return true;
        }

        @Override
        public boolean publishesWithNoSubscriber() {
            return false;
        }

        @Override
        public Object snapshot(String topicKey, Map<String, Object> params) throws Exception {
            return Map.of("rev", store == null ? 0 : store.rev());
        }

        @Override
        public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
            if (!RpcPrincipal.OWNER.equals(principal.scope())) {
                throw new RpcException(RpcException.FORBIDDEN, "Not this session's", Map.of("reason", "scope"));
            }
            RpcException no = refusal();
            if (no != null) {
                throw no;
            }
        }
    }

    // ---------------------------------------------------------------- the switch and the export's body

    /**
     * To-do's kill switch, {@value #SWITCH_FILE} in deskd's directory: no file is on; {@code off} turns it off; a file that
     * isn't a small plain file reads as {@code off}. Read at most once a second, as Courier's is.
     */
    static final class Switch {
        private final Path file;
        private volatile boolean on = true;
        private volatile long checkedAt = Long.MIN_VALUE;

        Switch(Path file) {
            this.file = file;
        }

        boolean on() {
            long now = System.nanoTime();
            if (file != null && (checkedAt == Long.MIN_VALUE || now - checkedAt >= 1_000_000_000L)) {
                checkedAt = now;
                on = read();
            }
            return on;
        }

        private boolean read() {
            try {
                BasicFileAttributes a = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!a.isRegularFile() || a.size() > 1024) {
                    return false;
                }
                String text = Files.readString(file, StandardCharsets.US_ASCII).strip();
                return !text.equals("off");
            } catch (NoSuchFileException e) {
                return true;
            } catch (IOException | RuntimeException e) {
                return false;
            }
        }
    }

    /** An export's bytes, sent as {@code files.read}'s: the trailer is their SHA-256 and size. */
    static final class BytesBody implements Transfer.Body {
        private final byte[] bytes;
        private final long mtimeMs;
        private int position;
        private byte[] trailer;

        BytesBody(byte[] bytes, long mtimeMs) {
            this.bytes = bytes;
            this.mtimeMs = mtimeMs;
        }

        @Override
        public long size() {
            return bytes.length;
        }

        @Override
        public long mtimeMs() {
            return mtimeMs;
        }

        @Override
        public boolean atEnd() {
            if (position < bytes.length) {
                return false;
            }
            if (trailer == null) {
                try {
                    ByteBuffer out = ByteBuffer.allocate(40);
                    out.put(MessageDigest.getInstance("SHA-256").digest(bytes));
                    out.putLong(bytes.length);
                    trailer = out.array();
                } catch (NoSuchAlgorithmException e) {
                    throw new IllegalStateException(e);
                }
            }
            return true;
        }

        @Override
        public int read(byte[] into, int length) {
            int n = Math.min(length, bytes.length - position);
            if (n <= 0) {
                return 0;
            }
            System.arraycopy(bytes, position, into, 0, n);
            position += n;
            return n;
        }

        @Override
        public byte[] trailer() {
            return trailer;
        }

        @Override
        public void close() {
            // Nothing held.
        }
    }
}
