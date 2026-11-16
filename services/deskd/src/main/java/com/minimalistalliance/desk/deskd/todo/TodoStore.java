package com.minimalistalliance.desk.deskd.todo;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.sqlite.SqliteDatabase;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * To-do's store (API.md §22; the To-do VISION's Part 2 §1 and §2): {@code /data/desk/todo.db}, one SQLite file with
 * {@code items}, {@code sources}, {@code events}, {@code revs}, {@code idem} and {@code todo_fts}. Every write runs on the
 * database's one writer thread in one transaction ({@link SqliteDatabase#transaction}), so a dedupe check and its insert,
 * and a cap's count and the add it allows, can never interleave with another call's: the same message twice at once is
 * one row, and the caps hold under any number of concurrent calls. {@code synchronous=FULL}: a write that returned is on
 * disk, so nothing is lost across a restart.
 *
 * <p>Who did a thing is always the caller's own stamp ({@code member}, or {@code agent:<id>} from deskd's tool host),
 * never anything in the params. Nothing here logs a title, a note, a label or a source's ref.
 */
public final class TodoStore implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(TodoStore.class);

    public static final String FILE = "todo.db";

    /** VISION §2's caps. */
    public static final int ADDS_PER_RUN = 10;
    public static final int ADDS_PER_AGENT_DAY = 30;
    public static final int AGENT_ADDS_PER_DESK_DAY = 100;
    public static final int OPEN_PER_DESK = 2_000;
    public static final int SUGGESTIONS_PER_AGENT_DAY = 20;
    /** Dedupe's windows and threshold. */
    static final Duration SAME_KEY_WINDOW = Duration.ofDays(30);
    static final Duration MERGE_WINDOW = Duration.ofDays(14);
    static final Duration CLOSED_WINDOW = Duration.ofDays(30);
    static final double MERGE_JACCARD = 0.8;
    static final int ALSO_FROM_MAX = 5;
    /** Retention. */
    static final Duration CLOSED_KEEP = Duration.ofDays(365);
    static final Duration TRASH_KEEP = Duration.ofDays(30);
    static final Duration IDEM_KEEP = Duration.ofDays(30);
    static final Duration REVS_KEEP = Duration.ofDays(30);
    static final int REVS_MAX = 50_000;
    static final int NEEDS_YOU_MAX = 5;
    static final int CHANGES_PAGE = 500;
    static final int EVENTS_IN_GET = 50;

    public static final Set<String> SOURCE_KINDS = Set.of("member", "courier", "notebook", "browser", "files",
            "agent_chat", "desk");
    public static final Set<String> STATES = Set.of("open", "done", "not_needed");

    /** A refusal: nothing was changed. {@code reason} is one of the words API.md §22 lists. */
    public static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;
        private final transient Map<String, Object> details;

        public Refused(String reason, Map<String, Object> details) {
            super(reason, null, false, false);
            this.reason = reason;
            this.details = details == null ? Map.of() : Map.copyOf(details);
        }

        public Refused(String reason) {
            this(reason, Map.of());
        }

        public String reason() {
            return reason;
        }

        public Map<String, Object> details() {
            return details;
        }
    }

    /** One change, after it committed: for the topic. */
    public record Change(String op, String id, long rev) {}

    /** A due day in the member's zone, with an optional time; {@code by} is whose date it is. */
    public record Due(String date, String time, String by) {
        public Due {
            Objects.requireNonNull(date, "date");
        }

        Map<String, Object> wire() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("date", date);
            m.put("time", time);
            m.put("by", by);
            return m;
        }
    }

    /** What deskd knows of an item, for the tool host's policy: never its text but the title for the chip. */
    public record Facts(String id, long rev, String title, String by, String runId, String state, boolean trashed,
            boolean untrusted, String sourceKind) {}

    /** A source as deskd recorded it: the kind, the ref (as JSON), the label deskd wrote, and its scope for merging. */
    public record Source(String kind, Map<String, Object> ref, String label, String threadKey) {
        public Source {
            Objects.requireNonNull(kind, "kind");
            ref = ref == null ? null : Map.copyOf(ref);
            label = label == null ? "" : TodoText.label(label);
        }

        String refJson() {
            return ref == null ? null : canonical(ref);
        }

        String refKey() {
            return TodoText.sha256(kind + "\n" + (ref == null ? "" : canonical(ref)));
        }
    }

    /**
     * An agent's add, as the tool host checked it.
     *
     * @param key the call's approval id (a card's, or the unasked call's own): the add is done once under it
     * @param sameAs the id of an open item the agent says this is the same task as, or null
     */
    public record AgentAdd(String agentId, String runId, String key, String title, String note, Due due, Source source,
            boolean untrusted, String sameAs) {}

    /** What an agent's add came to. */
    public record AddResult(String id, boolean created, boolean merged, String title, long rev) {
        public Map<String, Object> wire() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("created", created);
            if (merged) {
                m.put("merged", true);
            }
            return m;
        }
    }

    /** {@code todo.list}'s query. */
    public record ListQuery(String view, String by, String source, String q, String dueBefore, String cursor, int limit) {}

    private final SqliteDatabase db;
    private final Clock clock;
    private final Supplier<ZoneId> zone;
    private final SecureRandom random = new SecureRandom();
    private final List<Consumer<List<Change>>> listeners = new CopyOnWriteArrayList<>();

    private TodoStore(SqliteDatabase db, Clock clock, Supplier<ZoneId> zone) {
        this.db = db;
        this.clock = clock;
        this.zone = zone;
    }

    /**
     * Opens or creates {@code file} (owner-only) and brings its schema up.
     *
     * @param zone the member's IANA zone now, or null for UTC: what "today" and "a day" mean
     */
    public static TodoStore open(Path file, Clock clock, Supplier<ZoneId> zone) throws SQLException {
        SqliteDatabase db = SqliteDatabase.open("todo", file, List.of(TodoStore::schemaV1),
                new SqliteDatabase.Options(2, 2048, 1024));
        return new TodoStore(db, clock, zone == null ? () -> ZoneOffset.UTC : zone);
    }

    private static void schemaV1(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            s.execute("""
                    CREATE TABLE items (
                      id TEXT PRIMARY KEY,
                      rev INTEGER NOT NULL,
                      title TEXT NOT NULL,
                      title_words TEXT NOT NULL,
                      note TEXT,
                      due_date TEXT, due_time TEXT, due_by TEXT,
                      snoozed_until INTEGER,
                      pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER,
                      state TEXT NOT NULL CHECK (state IN ('open', 'done', 'not_needed')),
                      closed_at INTEGER, closed_by TEXT,
                      by TEXT NOT NULL, run_id TEXT,
                      source_kind TEXT NOT NULL, source_ref TEXT, source_label TEXT NOT NULL,
                      thread_key TEXT,
                      merge_count INTEGER NOT NULL DEFAULT 0,
                      untrusted INTEGER NOT NULL DEFAULT 0,
                      suggestion TEXT,
                      seen_at INTEGER,
                      dedupe_key TEXT NOT NULL,
                      add_key TEXT UNIQUE,
                      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER)""");
            s.execute("CREATE INDEX items_open ON items (state, trashed_at, due_date)");
            s.execute("CREATE INDEX items_thread ON items (thread_key, created_at)");
            s.execute("CREATE INDEX items_by ON items (by, created_at)");
            s.execute("CREATE INDEX items_run ON items (run_id)");
            s.execute("CREATE INDEX items_closed ON items (closed_at)");
            s.execute("CREATE INDEX items_trashed ON items (trashed_at)");
            // Every source an item came from, its own first: dedupe looks here, so a merged-in message read again is
            // found as surely as the first.
            s.execute("""
                    CREATE TABLE sources (
                      item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
                      kind TEXT NOT NULL, ref TEXT, ref_key TEXT NOT NULL, label TEXT NOT NULL,
                      dedupe_key TEXT NOT NULL, thread_key TEXT, primary_source INTEGER NOT NULL, at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX sources_dedupe ON sources (dedupe_key, at)");
            s.execute("CREATE INDEX sources_ref ON sources (ref_key)");
            s.execute("CREATE INDEX sources_item ON sources (item_id)");
            s.execute("""
                    CREATE TABLE events (
                      id TEXT PRIMARY KEY,
                      item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
                      at INTEGER NOT NULL, actor TEXT NOT NULL, run_id TEXT, approval_id TEXT,
                      op TEXT NOT NULL, before TEXT, after TEXT)""");
            s.execute("CREATE INDEX events_item ON events (item_id, at)");
            s.execute("CREATE INDEX events_actor ON events (actor, op, at)");
            s.execute("CREATE INDEX events_approval ON events (approval_id)");
            s.execute("""
                    CREATE TABLE revs (
                      rev INTEGER PRIMARY KEY AUTOINCREMENT,
                      item_id TEXT NOT NULL, op TEXT NOT NULL, at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX revs_at ON revs (at)");
            s.execute("""
                    CREATE TABLE idem (
                      key TEXT PRIMARY KEY, method TEXT NOT NULL, params TEXT NOT NULL, result TEXT NOT NULL,
                      at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX idem_at ON idem (at)");
            s.execute("CREATE VIRTUAL TABLE todo_fts USING fts5 (item_id UNINDEXED, title, note, tokenize = 'unicode61')");
        }
    }

    /** Told of every commit's changes, outside the database's thread. Must not block. */
    public void onChange(Consumer<List<Change>> listener) {
        listeners.add(listener);
    }

    @Override
    public void close() {
        db.close();
    }

    // ---------------------------------------------------------------- time

    public ZoneId zone() {
        try {
            ZoneId z = zone.get();
            return z == null ? ZoneOffset.UTC : z;
        } catch (RuntimeException e) {
            return ZoneOffset.UTC;
        }
    }

    public LocalDate today() {
        return LocalDate.ofInstant(clock.instant(), zone());
    }

    /** The member's midnight today, in ms: where "a day" of the caps starts. */
    long dayStart() {
        ZoneId z = zone();
        return today().atStartOfDay(z).toInstant().toEpochMilli();
    }

    long now() {
        return clock.millis();
    }

    // ---------------------------------------------------------------- the member's writes

    /** A mutation's idempotency: its key, method and params' canonical JSON. Null for none. */
    public record Idem(String key, String method, Map<String, Object> params) {}

    /** {@code todo.add}: the member's own to-do. */
    public Map<String, Object> memberAdd(Idem idem, String title, String note, Due due, boolean pinned)
            throws SQLException, Refused {
        return member(idem, c -> {
            requireOpenRoom(c);
            long now = now();
            String id = newId();
            Source source = new Source("member", null, "", null);
            insertItem(c, id, title, note, due, pinned, "member", null, source, false, null, now);
            Map<String, Object> after = fields(c, id);
            event(c, id, "member", null, null, "add", null, after);
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.update}. */
    public Map<String, Object> memberUpdate(Idem idem, String id, long rev, Map<String, Object> changes)
            throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, false);
            if (!"open".equals(row.state)) {
                throw new Refused("closed");
            }
            if (row.rev != rev) {
                throw new Refused("rev", Map.of("rev", row.rev));
            }
            Map<String, Object> set = new LinkedHashMap<>(changes);
            // The member's own words end the untrusted mark (VISION §1; the draft ADR's §13): a title they changed, with a
            // note that's theirs too or none. A note alone, or a title sent back unchanged, leaves it (Security's TD-I2).
            boolean newTitle = set.get("title") instanceof String t && !t.equals(row.title);
            boolean noteTheirs = set.containsKey("note") || row.note == null;
            if (newTitle && noteTheirs) {
                set.put("untrusted", false);
            }
            change(c, id, "member", null, null, "edit", set);
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.close}: a closed item is answered as it is. */
    public Map<String, Object> memberClose(Idem idem, String id, String as) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, false);
            if ("open".equals(row.state)) {
                Map<String, Object> set = new LinkedHashMap<>();
                set.put("state", as);
                set.put("closed", Map.of("at", now(), "by", "member"));
                set.put("suggestion", null);
                change(c, id, "member", null, null, "close", set);
            }
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.reopen}: an open item is answered as it is. */
    public Map<String, Object> memberReopen(Idem idem, String id) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, false);
            if (!"open".equals(row.state)) {
                requireOpenRoom(c);
                Map<String, Object> set = new LinkedHashMap<>();
                set.put("state", "open");
                set.put("closed", null);
                change(c, id, "member", null, null, "reopen", set);
            }
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.snooze}: {@code until} null wakes it. */
    public Map<String, Object> memberSnooze(Idem idem, String id, Long until) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, false);
            if (!"open".equals(row.state)) {
                throw new Refused("closed");
            }
            Map<String, Object> set = new LinkedHashMap<>();
            set.put("snoozedUntil", until);
            change(c, id, "member", null, null, "snooze", set);
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.pin}. */
    public Map<String, Object> memberPin(Idem idem, String id, boolean on) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, false);
            Map<String, Object> set = new LinkedHashMap<>();
            set.put("pinned", on);
            change(c, id, "member", null, null, "pin", set);
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.answer}: a suggestion taken (closed by the member) or turned down ("Not yet"). */
    public Map<String, Object> memberAnswer(Idem idem, String id, boolean accept) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, false);
            Map<String, Object> suggestion = row.suggestion();
            if (suggestion == null || !"open".equals(row.state)) {
                throw new Refused("no_suggestion");
            }
            Map<String, Object> set = new LinkedHashMap<>();
            set.put("suggestion", null);
            if (accept) {
                set.put("state", suggestion.get("as"));
                set.put("closed", Map.of("at", now(), "by", "member"));
            }
            change(c, id, "member", null, null, "answer", set);
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.trash}. */
    public Map<String, Object> memberTrash(Idem idem, String id) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            requireLive(row, true);
            if (row.trashedAt == null) {
                Map<String, Object> set = new LinkedHashMap<>();
                set.put("trashedAt", now());
                change(c, id, "member", null, null, "trash", set);
            }
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.restore}. */
    public Map<String, Object> memberRestore(Idem idem, String id) throws SQLException, Refused {
        return member(idem, c -> {
            Row row = row(c, id);
            if (row == null) {
                throw new Refused("not_found", Map.of("reason", "item"));
            }
            if (row.trashedAt != null) {
                if ("open".equals(row.state)) {
                    requireOpenRoom(c);
                }
                Map<String, Object> set = new LinkedHashMap<>();
                set.put("trashedAt", null);
                change(c, id, "member", null, null, "restore", set);
            }
            return Map.of("item", item(c, id));
        });
    }

    /** {@code todo.seen}: ids that aren't items are skipped. */
    public Map<String, Object> memberSeen(Idem idem, List<String> ids) throws SQLException, Refused {
        return member(idem, c -> {
            long now = now();
            for (String id : new LinkedHashSet<>(ids)) {
                Row row = row(c, id);
                if (row == null || row.seenAt != null) {
                    continue;
                }
                TodoSql.update(c, "UPDATE items SET seen_at = ? WHERE id = ?", now, id);
                rev(c, id, "seen", now);
            }
            return Map.of();
        });
    }

    /**
     * {@code todo.undo}: an event's {@code before} goes back when the fields it changed still hold its {@code after}. An
     * add is undone by closing it as not needed (it stays deduped); a merge by taking its source out again.
     */
    public Map<String, Object> memberUndo(Idem idem, String eventId) throws SQLException, Refused {
        return member(idem, c -> {
            Map<String, Object> event = TodoSql.one(c, "SELECT item_id, op, before, after FROM events WHERE id = ?", r -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("itemId", r.getString(1));
                m.put("op", r.getString(2));
                m.put("before", r.getString(3));
                m.put("after", r.getString(4));
                return m;
            }, eventId);
            if (event == null) {
                throw new Refused("not_found", Map.of("reason", "event"));
            }
            String id = (String) event.get("itemId");
            undo(c, id, "member", null, null, (String) event.get("op"), parse((String) event.get("before")),
                    parse((String) event.get("after")));
            return Map.of("item", item(c, id));
        });
    }

    /**
     * An agent's change undone by its approval id (the draft ADR's §15 {@code agent.approval.undo}): every event that call
     * made, newest first, of that one agent's only ({@code agent:<id>}): deskd's undo of a call done without asking takes
     * back only what that agent did under that call's key (Security's AAB-L2). Null when it did nothing. There's no undo
     * by the id alone: the agent is always checked (auto-approve's Read 6; the one-argument form, which nothing called,
     * was removed).
     */
    public Map<String, Object> undoByApproval(String approvalId, String actor) throws SQLException, Refused {
        if (approvalId == null || actor == null || !actor.startsWith("agent:") || actor.length() == "agent:".length()) {
            throw new IllegalArgumentException("an undo by approval names the call's key and its agent");
        }
        Map<String, Object>[] out = new Map[1];
        List<Change> changes = write(c -> {
            List<Map<String, Object>> events = TodoSql.list(c,
                    "SELECT id, item_id, op, before, after FROM events WHERE approval_id = ? AND actor = ? ORDER BY at DESC, rowid DESC",
                    r -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("itemId", r.getString(2));
                        m.put("op", r.getString(3));
                        m.put("before", r.getString(4));
                        m.put("after", r.getString(5));
                        return m;
                    }, approvalId, actor);
            if (events.isEmpty()) {
                return null;
            }
            String last = null;
            for (Map<String, Object> e : events) {
                last = (String) e.get("itemId");
                undo(c, last, "member", null, null, (String) e.get("op"), parse((String) e.get("before")),
                        parse((String) e.get("after")));
            }
            out[0] = Map.of("item", item(c, last));
            return null;
        });
        publish(changes);
        return out[0];
    }

    /** Whether any event was made under this key: a call done without asking runs once under its own. */
    public boolean keyUsed(String key) throws SQLException {
        return db.read(c -> TodoSql.one(c, "SELECT 1 FROM events WHERE approval_id = ? LIMIT 1", r -> Boolean.TRUE, key)) != null;
    }

    private void undo(Connection c, String id, String actor, String runId, String approvalId, String op,
            Map<String, Object> before, Map<String, Object> after) throws SQLException, Refused {
        Row row = row(c, id);
        if (row == null) {
            throw new Refused("not_found", Map.of("reason", "item"));
        }
        Map<String, Object> now = fields(c, id);
        if ("add".equals(op)) {
            if (!"open".equals(row.state)) {
                throw new Refused("changed");
            }
            Map<String, Object> set = new LinkedHashMap<>();
            set.put("state", "not_needed");
            set.put("closed", Map.of("at", now(), "by", actor));
            set.put("suggestion", null);
            change(c, id, actor, runId, approvalId, "undo", set);
            return;
        }
        if (after == null || before == null) {
            throw new Refused("changed");
        }
        for (Map.Entry<String, Object> e : after.entrySet()) {
            if (e.getKey().startsWith("_")) {
                continue;
            }
            if (!Objects.equals(normal(now.get(e.getKey())), normal(e.getValue()))) {
                throw new Refused("changed");
            }
        }
        Map<String, Object> set = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : before.entrySet()) {
            if (!e.getKey().startsWith("_")) {
                set.put(e.getKey(), e.getValue());
            }
        }
        if (row.trashedAt != null && !set.containsKey("trashedAt")) {
            throw new Refused("trashed");
        }
        // A merge's source comes out again; the undo of that undo puts it back.
        Map<String, Object> extraBefore = new LinkedHashMap<>();
        Map<String, Object> extraAfter = new LinkedHashMap<>();
        if (after.get("_sourceAdded") instanceof Map<?, ?> added) {
            Object key = added.get("refKey");
            Object dedupe = added.get("dedupeKey");
            TodoSql.update(c, "DELETE FROM sources WHERE item_id = ? AND ref_key = ? AND dedupe_key = ? AND primary_source = 0",
                    id, key, dedupe);
            extraAfter.put("_sourceRemoved", added);
        }
        if (after.get("_sourceRemoved") instanceof Map<?, ?> removed) {
            TodoSql.update(c, """
                    INSERT INTO sources (item_id, kind, ref, ref_key, label, dedupe_key, thread_key, primary_source, at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)""", id, removed.get("kind"), removed.get("ref"),
                    removed.get("refKey"), removed.get("label"), removed.get("dedupeKey"), removed.get("threadKey"),
                    removed.get("at"));
            extraAfter.put("_sourceAdded", removed);
        }
        changeWith(c, id, actor, runId, approvalId, "undo", set, extraBefore, extraAfter);
    }

    // ---------------------------------------------------------------- an agent's writes

    /**
     * An agent's add, after the tool host's checks (provenance, the label, the policy): exactly once under {@code key};
     * deduped and merged by VISION §2's rules, then capped. A dedupe hit or a merge isn't a refusal.
     *
     * @throws Refused {@code cap} ({@code which}), {@code not_found} or {@code closed} for a {@code sameAs} that isn't
     *     an open item
     */
    public AddResult agentAdd(AgentAdd add) throws SQLException, Refused {
        AddResult[] out = new AddResult[1];
        List<Change> changes = write(c -> {
            out[0] = add(c, add);
            return null;
        });
        publish(changes);
        return out[0];
    }

    private AddResult add(Connection c, AgentAdd add) throws SQLException, Refused {
        String actor = "agent:" + add.agentId();
        long now = now();
        // Exactly once: the same call again (a retry, a resumed run) answers what it did the first time.
        if (add.key() != null) {
            AddResult again = TodoSql.one(c, """
                    SELECT e.item_id, e.op, i.title, i.rev FROM events e JOIN items i ON i.id = e.item_id
                    WHERE e.approval_id = ? AND e.op IN ('add', 'merge') ORDER BY e.at LIMIT 1""",
                    r -> new AddResult(r.getString(1), false, "merge".equals(r.getString(2)), r.getString(3), r.getLong(4)),
                    add.key());
            if (again != null) {
                return again;
            }
        }
        Set<String> words = TodoText.words(add.title());
        String normal = String.join(" ", words);
        Source source = add.source();
        String dedupeKey = dedupeKey(source, normal);
        // 1. The same source and the same to-do, in any state, made in the last 30 days: nothing is added.
        Row same = TodoSql.one(c, """
                SELECT i.* FROM sources s JOIN items i ON i.id = s.item_id
                WHERE s.dedupe_key = ? AND s.at >= ? ORDER BY s.at LIMIT 1""", Row::of, dedupeKey,
                now - SAME_KEY_WINDOW.toMillis());
        if (same != null) {
            return new AddResult(same.id, false, false, same.title, same.rev);
        }
        // The run's cap counts merges too (Security's TD-M2): checked before any merge or add, after a plain dedupe hit.
        long runWrites = TodoSql.longOne(c,
                "SELECT count(*) FROM events WHERE op IN ('add', 'merge') AND actor = ? AND run_id = ?", actor, add.runId());
        if (runWrites >= ADDS_PER_RUN) {
            throw cap("run", ADDS_PER_RUN);
        }
        // The agent's own judgement that this is the same task as an open item it was shown.
        if (add.sameAs() != null) {
            Row target = row(c, add.sameAs());
            if (target == null || target.trashedAt != null) {
                throw new Refused("not_found");
            }
            if (!"open".equals(target.state)) {
                throw new Refused("closed");
            }
            // From a run holding U, an agent-named merge adds the source only: it never moves the date (TD-M2).
            return merge(c, target, add, source, dedupeKey, now, !add.untrusted());
        }
        // 2. The same thing again from the same source or thread: merged into the open item.
        Row best = null;
        double bestScore = 0;
        for (Row candidate : TodoSql.list(c, """
                SELECT DISTINCT i.* FROM items i LEFT JOIN sources s ON s.item_id = i.id
                WHERE i.state = 'open' AND i.trashed_at IS NULL AND i.created_at >= ?
                  AND ((? IS NOT NULL AND (i.thread_key = ? OR s.thread_key = ?)) OR s.ref_key = ?)
                ORDER BY i.created_at DESC LIMIT 200""", Row::of, now - MERGE_WINDOW.toMillis(),
                source.threadKey(), source.threadKey(), source.threadKey(), source.refKey())) {
            double score = TodoText.jaccard(words, wordsOf(candidate.titleWords));
            if (score >= MERGE_JACCARD && score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        if (best != null) {
            return merge(c, best, add, source, dedupeKey, now, true);
        }
        // 3. Closed in the last 30 days, from the same thread with a similar title: not again, unless the date moved.
        if (source.threadKey() != null) {
            for (Row closed : TodoSql.list(c, """
                    SELECT * FROM items WHERE thread_key = ? AND state <> 'open' AND closed_at >= ?
                    ORDER BY closed_at DESC LIMIT 50""", Row::of, source.threadKey(), now - CLOSED_WINDOW.toMillis())) {
                if (TodoText.jaccard(words, wordsOf(closed.titleWords)) >= MERGE_JACCARD
                        && (add.due() == null || add.due().date().equals(closed.dueDate))) {
                    return new AddResult(closed.id, false, false, closed.title, closed.rev);
                }
            }
        }
        // The day's caps, for an add that would make a row.
        long dayStart = dayStart();
        long agentDay = TodoSql.longOne(c, "SELECT count(*) FROM events WHERE op = 'add' AND actor = ? AND at >= ?",
                actor, dayStart);
        if (agentDay >= ADDS_PER_AGENT_DAY) {
            throw cap("agent_day", ADDS_PER_AGENT_DAY);
        }
        long deskDay = TodoSql.longOne(c,
                "SELECT count(*) FROM events WHERE op = 'add' AND actor LIKE 'agent:%' AND at >= ?", dayStart);
        if (deskDay >= AGENT_ADDS_PER_DESK_DAY) {
            throw cap("desk_day", AGENT_ADDS_PER_DESK_DAY);
        }
        requireOpenRoom(c);
        String id = newId();
        Due due = add.due() == null ? null : new Due(add.due().date(), add.due().time(), actor);
        insertItem(c, id, add.title(), add.note(), due, false, actor, add.runId(), source, add.untrusted(), add.key(), now);
        event(c, id, actor, add.runId(), add.key(), "add", null, fields(c, id));
        Row made = row(c, id);
        return new AddResult(id, true, false, made.title, made.rev);
    }

    private AddResult merge(Connection c, Row target, AgentAdd add, Source source, String dedupeKey, long now,
            boolean mayMoveDate) throws SQLException {
        String actor = "agent:" + add.agentId();
        Map<String, Object> set = new LinkedHashMap<>();
        set.put("mergeCount", target.mergeCount + 1);
        // A later date wins only over an agent's date (or none); the member's is never overwritten.
        if (mayMoveDate && add.due() != null && (target.dueBy == null || target.dueBy.startsWith("agent:"))
                && (target.dueDate == null || add.due().date().compareTo(target.dueDate) > 0)) {
            set.put("due", new Due(add.due().date(), add.due().time(), actor).wire());
        }
        if (add.untrusted() && !target.untrusted) {
            set.put("untrusted", true);
        }
        Map<String, Object> sourceAdded = null;
        long also = TodoSql.longOne(c, "SELECT count(*) FROM sources WHERE item_id = ? AND primary_source = 0", target.id);
        if (also < ALSO_FROM_MAX) {
            insertSource(c, target.id, source, dedupeKey, false, now);
            sourceAdded = new LinkedHashMap<>();
            sourceAdded.put("kind", source.kind());
            sourceAdded.put("ref", source.refJson());
            sourceAdded.put("refKey", source.refKey());
            sourceAdded.put("label", source.label());
            sourceAdded.put("dedupeKey", dedupeKey);
            sourceAdded.put("threadKey", source.threadKey());
            sourceAdded.put("at", now);
        } else {
            // Still found again by its key, but not shown: alsoFrom holds five.
            insertSource(c, target.id, source, dedupeKey, false, now);
            TodoSql.update(c, "UPDATE sources SET primary_source = -1 WHERE rowid = last_insert_rowid()");
        }
        Map<String, Object> extraAfter = new LinkedHashMap<>();
        if (sourceAdded != null) {
            extraAfter.put("_sourceAdded", sourceAdded);
        }
        changeWith(c, target.id, actor, add.runId(), add.key(), "merge", set, Map.of(), extraAfter);
        Row after = row(c, target.id);
        return new AddResult(target.id, false, true, after.title, after.rev);
    }

    /**
     * An agent's update, after the tool host's policy: the item must be open, not trashed, and at {@code rev}
     * ({@code stale} otherwise). Its date becomes the agent's; a run holding U marks the item.
     */
    public Facts agentUpdate(String agentId, String runId, String key, String id, long rev, Map<String, Object> changes,
            boolean untrusted) throws SQLException, Refused {
        Facts[] out = new Facts[1];
        List<Change> list = write(c -> {
            String actor = "agent:" + agentId;
            if (key != null) {
                Facts again = TodoSql.one(c, "SELECT item_id FROM events WHERE approval_id = ? AND op = 'edit' LIMIT 1",
                        r -> facts(row(c, r.getString(1))), key);
                if (again != null) {
                    out[0] = again;
                    return null;
                }
            }
            Row row = row(c, id);
            if (row == null) {
                throw new Refused("not_found");
            }
            if (row.trashedAt != null) {
                throw new Refused("trashed");
            }
            if (!"open".equals(row.state)) {
                throw new Refused("closed");
            }
            if (row.rev != rev) {
                throw new Refused("stale");
            }
            Map<String, Object> set = new LinkedHashMap<>(changes);
            if (set.get("due") instanceof Map<?, ?> due) {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("date", due.get("date"));
                d.put("time", due.get("time"));
                d.put("by", actor);
                set.put("due", d);
            }
            if (untrusted && !row.untrusted) {
                set.put("untrusted", true);
            }
            change(c, id, actor, runId, key, "edit", set);
            out[0] = facts(row(c, id));
            return null;
        });
        publish(list);
        return out[0];
    }

    /** An agent's close, which the tool host's policy allowed (asked or not): the item must be open and not trashed. */
    public Facts agentClose(String agentId, String runId, String key, String id, String as) throws SQLException, Refused {
        Facts[] out = new Facts[1];
        List<Change> list = write(c -> {
            if (key != null) {
                Facts again = TodoSql.one(c, "SELECT item_id FROM events WHERE approval_id = ? AND op = 'close' LIMIT 1",
                        r -> facts(row(c, r.getString(1))), key);
                if (again != null) {
                    out[0] = again;
                    return null;
                }
            }
            Row row = row(c, id);
            if (row == null) {
                throw new Refused("not_found");
            }
            if (row.trashedAt != null) {
                throw new Refused("trashed");
            }
            if (!"open".equals(row.state)) {
                throw new Refused("closed");
            }
            Map<String, Object> set = new LinkedHashMap<>();
            set.put("state", as);
            set.put("closed", Map.of("at", now(), "by", "agent:" + agentId));
            set.put("suggestion", null);
            change(c, id, "agent:" + agentId, runId, key, "close", set);
            out[0] = facts(row(c, id));
            return null;
        });
        publish(list);
        return out[0];
    }

    /** An agent's "Looks done?": one open suggestion an item, the newest; capped per agent per day. Closes nothing. */
    public Facts agentSuggest(String agentId, String runId, String id, String as, String reason, boolean untrusted)
            throws SQLException, Refused {
        Facts[] out = new Facts[1];
        List<Change> list = write(c -> {
            String actor = "agent:" + agentId;
            Row row = row(c, id);
            if (row == null) {
                throw new Refused("not_found");
            }
            if (row.trashedAt != null) {
                throw new Refused("trashed");
            }
            if (!"open".equals(row.state)) {
                throw new Refused("closed");
            }
            long day = TodoSql.longOne(c, "SELECT count(*) FROM events WHERE op = 'suggest' AND actor = ? AND at >= ?",
                    actor, dayStart());
            if (day >= SUGGESTIONS_PER_AGENT_DAY) {
                throw cap("suggest_day", SUGGESTIONS_PER_AGENT_DAY);
            }
            Map<String, Object> suggestion = new LinkedHashMap<>();
            suggestion.put("as", as);
            suggestion.put("by", actor);
            suggestion.put("reason", TodoText.reason(reason));
            suggestion.put("at", now());
            suggestion.put("untrusted", untrusted);
            Map<String, Object> set = new LinkedHashMap<>();
            set.put("suggestion", suggestion);
            if (untrusted && !row.untrusted) {
                // Its reason is the model's words from a run that read untrusted content: whoever reads the item next
                // holds U (Security's TD-M1).
                set.put("untrusted", true);
            }
            change(c, id, actor, runId, null, "suggest", set);
            out[0] = facts(row(c, id));
            return null;
        });
        publish(list);
        return out[0];
    }

    // ---------------------------------------------------------------- reads

    /**
     * The cap an agent's add would meet now, or null: for the tool host's look, so nobody is asked for an add that would
     * be refused. The add checks again in its own transaction, which is what holds under concurrent calls.
     */
    public String capFor(String agentId, String runId) throws SQLException {
        long dayStart = dayStart();
        String actor = "agent:" + agentId;
        return db.read(c -> {
            if (TodoSql.longOne(c, "SELECT count(*) FROM events WHERE op IN ('add', 'merge') AND actor = ? AND run_id = ?",
                    actor, runId) >= ADDS_PER_RUN) {
                return "run";
            }
            if (TodoSql.longOne(c, "SELECT count(*) FROM events WHERE op = 'add' AND actor = ? AND at >= ?", actor,
                    dayStart) >= ADDS_PER_AGENT_DAY) {
                return "agent_day";
            }
            if (TodoSql.longOne(c, "SELECT count(*) FROM events WHERE op = 'add' AND actor LIKE 'agent:%' AND at >= ?",
                    dayStart) >= AGENT_ADDS_PER_DESK_DAY) {
                return "desk_day";
            }
            if (TodoSql.longOne(c, "SELECT count(*) FROM items WHERE state = 'open' AND trashed_at IS NULL")
                    >= OPEN_PER_DESK) {
                return "open";
            }
            return null;
        });
    }

    /** What deskd knows of one item, for the tool host's policy; null for none. */
    public Facts facts(String id) throws SQLException {
        return db.read(c -> facts(row(c, id)));
    }

    /** {@code todo.get}: the item and its newest events; null for none. */
    public Map<String, Object> get(String id, int events) throws SQLException {
        return db.read(c -> {
            if (row(c, id) == null) {
                return null;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("item", item(c, id));
            out.put("events", events(c, id, events));
            return out;
        });
    }

    /** {@code todo.list}. */
    public Map<String, Object> list(ListQuery q) throws SQLException, Refused {
        if (!Set.of("needs_you", "open", "done", "trash").contains(q.view())) {
            throw new Refused("view");
        }
        int offset = 0;
        if (q.cursor() != null) {
            try {
                offset = Integer.parseInt(q.cursor());
            } catch (NumberFormatException e) {
                throw new Refused("cursor");
            }
            if (offset < 0 || offset > 1_000_000) {
                throw new Refused("cursor");
            }
        }
        int from = offset;
        LocalDate today = today();
        long now = now();
        return db.read(c -> {
            Map<String, Object> out = new LinkedHashMap<>();
            if ("needs_you".equals(q.view())) {
                needsYou(c, today, now, out);
            } else {
                page(c, q, from, today, now, out);
            }
            out.put("rev", lastRev(c));
            out.put("today", today.toString());
            out.put("zone", zone().getId());
            return out;
        });
    }

    private void needsYou(Connection c, LocalDate today, long now, Map<String, Object> out) throws SQLException {
        String t = today.toString();
        // Membership and order in code (VISION §2): overdue (oldest first), today with a time (earliest), today, then
        // pinned (latest pin first). Only dates and pins: no text or agent field moves an item in.
        List<String> ids = TodoSql.list(c, """
                SELECT id FROM items
                WHERE state = 'open' AND trashed_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)
                  AND ((due_date IS NOT NULL AND due_date <= ?) OR pinned = 1)
                ORDER BY
                  CASE WHEN due_date < ? THEN 0 WHEN due_date = ? AND due_time IS NOT NULL THEN 1
                       WHEN due_date = ? THEN 2 ELSE 3 END,
                  CASE WHEN due_date < ? THEN due_date END,
                  CASE WHEN due_date = ? THEN due_time END,
                  pinned_at DESC, created_at, id""", r -> r.getString(1), now, t, t, t, t, t, t);
        List<Map<String, Object>> items = new ArrayList<>();
        for (String id : ids.subList(0, Math.min(NEEDS_YOU_MAX, ids.size()))) {
            items.add(item(c, id, today, now));
        }
        Set<String> shown = new HashSet<>(ids.subList(0, Math.min(NEEDS_YOU_MAX, ids.size())));
        long newFromAgents = 0;
        for (String id : TodoSql.list(c, """
                SELECT id FROM items WHERE state = 'open' AND trashed_at IS NULL AND seen_at IS NULL AND by <> 'member'""",
                r -> r.getString(1))) {
            if (!shown.contains(id)) {
                newFromAgents++;
            }
        }
        long toConfirm = TodoSql.longOne(c, """
                SELECT count(*) FROM items WHERE state = 'open' AND trashed_at IS NULL AND suggestion IS NOT NULL""");
        out.put("items", items);
        out.put("more", Math.max(0, ids.size() - NEEDS_YOU_MAX));
        out.put("footer", Map.of("newFromAgents", newFromAgents, "toConfirm", toConfirm));
        out.put("next", null);
    }

    private void page(Connection c, ListQuery q, int offset, LocalDate today, long now, Map<String, Object> out)
            throws SQLException {
        String t = today.toString();
        List<Object> args = new ArrayList<>();
        StringBuilder where = new StringBuilder();
        String order;
        switch (q.view()) {
            case "open" -> {
                where.append("i.state = 'open' AND i.trashed_at IS NULL");
                // overdue, today, upcoming, no date, snoozed; within a group by date, time, then oldest first.
                order = """
                        CASE WHEN i.snoozed_until IS NOT NULL AND i.snoozed_until > %d THEN 4
                             WHEN i.due_date IS NULL THEN 3 WHEN i.due_date < '%s' THEN 0 WHEN i.due_date = '%s' THEN 1
                             ELSE 2 END, i.due_date, i.due_time, i.created_at, i.id""".formatted(now, t, t);
            }
            case "done" -> {
                where.append("i.state <> 'open' AND i.trashed_at IS NULL");
                order = "i.closed_at DESC, i.id DESC";
            }
            case "trash" -> {
                where.append("i.trashed_at IS NOT NULL");
                order = "i.trashed_at DESC, i.id DESC";
            }
            default -> throw new IllegalArgumentException("view");
        }
        if (q.by() != null) {
            switch (q.by()) {
                case "member" -> where.append(" AND i.by = 'member'");
                case "agents" -> where.append(" AND i.by LIKE 'agent:%'");
                default -> {
                    where.append(" AND i.by = ?");
                    args.add(q.by());
                }
            }
        }
        if (q.source() != null) {
            where.append(" AND i.source_kind = ?");
            args.add(q.source());
        }
        if (q.dueBefore() != null) {
            where.append(" AND i.due_date IS NOT NULL AND i.due_date < ?");
            args.add(q.dueBefore());
        }
        if (q.q() != null && !q.q().isBlank()) {
            String match = ftsQuery(q.q());
            if (match == null) {
                out.put("items", List.of());
                out.put("next", null);
                return;
            }
            where.append(" AND i.id IN (SELECT item_id FROM todo_fts WHERE todo_fts MATCH ?)");
            args.add(match);
        }
        int limit = q.limit();
        args.add(limit + 1);
        args.add(offset);
        List<String> ids = TodoSql.list(c, "SELECT i.id FROM items i WHERE " + where + " ORDER BY " + order
                + " LIMIT ? OFFSET ?", r -> r.getString(1), args.toArray());
        List<Map<String, Object>> items = new ArrayList<>();
        for (String id : ids.subList(0, Math.min(limit, ids.size()))) {
            items.add(item(c, id, today, now));
        }
        out.put("items", items);
        out.put("next", ids.size() > limit ? String.valueOf(offset + limit) : null);
    }

    /** Every word, by prefix, in the title or note: Notebook search's rules. Null for nothing to search. */
    static String ftsQuery(String q) {
        List<String> terms = new ArrayList<>();
        for (String w : q.split("[^\\p{L}\\p{N}]+")) {
            if (!w.isEmpty()) {
                terms.add("\"" + w.replace("\"", "") + "\"*");
            }
            if (terms.size() == 16) {
                break;
            }
        }
        return terms.isEmpty() ? null : String.join(" AND ", terms);
    }

    /** {@code todo.summary}. */
    /**
     * Documents (API.md §24): whether an open item's source is this file or message, and when it's due. Returns null for
     * none, {@code -1} for an open item with no due day, else the due time in ms (a day with no time is due at its end).
     *
     * @param kind {@code files} or {@code courier}
     * @param refKey the source ref's field ({@code path}, {@code messageId})
     */
    public Long openDueFor(String kind, String refKey, String refValue) throws SQLException {
        if (!java.util.Set.of("path", "messageId").contains(refKey)) {
            return null;
        }
        // An item an agent made from untrusted content never lifts a document (Security DOC-L2): the member's own, or a
        // trusted source's, only.
        String[] row = db.read(c -> TodoSql.one(c, "SELECT due_date, due_time FROM items WHERE state = 'open' AND trashed_at IS NULL"
                + " AND untrusted = 0 AND source_kind = ? AND json_extract(source_ref, '$." + refKey + "') = ? ORDER BY due_date IS NULL, due_date, due_time LIMIT 1",
                r -> new String[] {r.getString(1), r.getString(2)}, kind, refValue));
        if (row == null) {
            return null;
        }
        if (row[0] == null) {
            return -1L;
        }
        try {
            java.time.LocalDate day = java.time.LocalDate.parse(row[0]);
            java.time.LocalTime time = row[1] == null ? java.time.LocalTime.of(23, 59) : java.time.LocalTime.parse(row[1]);
            return day.atTime(time).atZone(zone.get()).toInstant().toEpochMilli();
        } catch (java.time.DateTimeException e) {
            return -1L;
        }
    }

    public Map<String, Object> summary() throws SQLException {
        LocalDate today = today();
        long now = now();
        return db.read(c -> {
            String t = today.toString();
            String live = "state = 'open' AND trashed_at IS NULL";
            String awake = live + " AND (snoozed_until IS NULL OR snoozed_until <= " + now + ")";
            long open = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE " + live);
            long overdue = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE " + awake + " AND due_date < ?", t);
            long dueToday = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE " + awake + " AND due_date = ?", t);
            long needsYou = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE " + awake
                    + " AND ((due_date IS NOT NULL AND due_date <= ?) OR pinned = 1)", t);
            long newFromAgents = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE " + live
                    + " AND seen_at IS NULL AND by <> 'member'");
            long toConfirm = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE " + live + " AND suggestion IS NOT NULL");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("open", open);
            out.put("needsYou", needsYou);
            out.put("overdue", overdue);
            out.put("dueToday", dueToday);
            out.put("newFromAgents", newFromAgents);
            out.put("toConfirm", toConfirm);
            out.put("badge", overdue + dueToday);
            out.put("rev", lastRev(c));
            out.put("today", t);
            out.put("zone", zone().getId());
            return out;
        });
    }

    /** {@code todo.changes}. */
    public Map<String, Object> changes(long since) throws SQLException {
        return db.read(c -> {
            Map<String, Object> out = new LinkedHashMap<>();
            Long oldest = TodoSql.longOne(c, "SELECT min(rev) FROM revs");
            long last = lastRev(c);
            boolean reset = since < last && (oldest == null || since < oldest - 1);
            List<Map<String, Object>> list = reset ? List.of() : TodoSql.list(c,
                    "SELECT rev, item_id, op FROM revs WHERE rev > ? ORDER BY rev LIMIT ?", r -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("rev", r.getLong(1));
                        m.put("id", r.getString(2));
                        m.put("op", r.getString(3));
                        return m;
                    }, since, CHANGES_PAGE);
            out.put("changes", list);
            out.put("rev", last);
            out.put("reset", reset);
            return out;
        });
    }

    /** Every item, whole, for the export: open first, then closed, then the Trash. */
    public List<Map<String, Object>> everything(boolean withEvents) throws SQLException {
        LocalDate today = today();
        long now = now();
        return db.read(c -> {
            List<Map<String, Object>> out = new ArrayList<>();
            for (String id : TodoSql.list(c, """
                    SELECT id FROM items ORDER BY (trashed_at IS NOT NULL), (state <> 'open'), due_date IS NULL, due_date,
                      created_at, id""", r -> r.getString(1))) {
                Map<String, Object> m = new LinkedHashMap<>(item(c, id, today, now));
                if (withEvents) {
                    m.put("events", events(c, id, Integer.MAX_VALUE));
                }
                out.add(m);
            }
            return out;
        });
    }

    /** The latest {@code rev}, for the topic's snapshot. */
    public long rev() throws SQLException {
        return db.read(TodoStore::lastRev);
    }

    // ---------------------------------------------------------------- the tidy

    /**
     * Retention (VISION §1, API.md §22): closed items a year after they closed, the Trash after 30 days, their events
     * and sources with them; {@code idem} results after 30 days; the change log to 30 days and 50,000 changes.
     *
     * @return how many items went
     */
    public int tidy() throws SQLException {
        int[] removed = new int[1];
        List<Change> changes;
        try {
            changes = tidyOnce(removed);
        } catch (Refused impossible) {
            throw new SQLException("tidy");
        }
        publish(changes);
        return removed[0];
    }

    private List<Change> tidyOnce(int[] removed) throws SQLException, Refused {
        return write(c -> {
            long now = now();
            List<String> gone = TodoSql.list(c, """
                    SELECT id FROM items WHERE (closed_at IS NOT NULL AND closed_at < ? AND state <> 'open')
                      OR (trashed_at IS NOT NULL AND trashed_at < ?) LIMIT 5000""", r -> r.getString(1),
                    now - CLOSED_KEEP.toMillis(), now - TRASH_KEEP.toMillis());
            for (String id : gone) {
                TodoSql.update(c, "DELETE FROM todo_fts WHERE item_id = ?", id);
                TodoSql.update(c, "DELETE FROM items WHERE id = ?", id);
                rev(c, id, "remove", now);
            }
            removed[0] = gone.size();
            TodoSql.update(c, "DELETE FROM idem WHERE at < ?", now - IDEM_KEEP.toMillis());
            long last = lastRev(c);
            TodoSql.update(c, "DELETE FROM revs WHERE at < ? OR rev <= ?", now - REVS_KEEP.toMillis(), last - REVS_MAX);
            return null;
        });
    }

    // ---------------------------------------------------------------- plumbing

    @FunctionalInterface
    private interface Work<T> {
        T run(Connection c) throws SQLException, Refused;
    }

    /** A Refused carried through the database's thread. */
    private static final class Carried extends SQLException {
        private static final long serialVersionUID = 1L;
        final Refused refused;

        Carried(Refused refused) {
            super("refused");
            this.refused = refused;
        }
    }

    /** The changes this transaction made, collected on the writer's thread. */
    private final ThreadLocal<List<Change>> pending = new ThreadLocal<>();

    /** One transaction; its changes, once it committed. */
    private List<Change> write(Work<Void> work) throws SQLException, Refused {
        try {
            return db.transaction(c -> {
                List<Change> changes = new ArrayList<>();
                pending.set(changes);
                try {
                    work.run(c);
                    return changes;
                } catch (Refused r) {
                    throw new Carried(r);
                } finally {
                    pending.remove();
                }
            });
        } catch (Carried e) {
            throw e.refused;
        }
    }

    /** A member's mutation, once under its {@code idem}: a replay answers the stored result. */
    private Map<String, Object> member(Idem idem, Work<Map<String, Object>> work) throws SQLException, Refused {
        Map<String, Object>[] out = new Map[1];
        List<Change> changes = write(c -> {
            String params = idem == null ? null : canonical(idem.params() == null ? Map.of() : idem.params());
            if (idem != null && idem.key() != null) {
                String[] stored = TodoSql.one(c, "SELECT method, params, result FROM idem WHERE key = ?",
                        r -> new String[] {r.getString(1), r.getString(2), r.getString(3)}, idem.key());
                if (stored != null) {
                    if (!stored[0].equals(idem.method()) || !stored[1].equals(params)) {
                        throw new Refused("idem");
                    }
                    out[0] = parse(stored[2]);
                    return null;
                }
            }
            out[0] = work.run(c);
            if (idem != null && idem.key() != null) {
                TodoSql.update(c, "INSERT INTO idem (key, method, params, result, at) VALUES (?, ?, ?, ?, ?)", idem.key(),
                        idem.method(), params, canonical(out[0]), now());
            }
            return null;
        });
        publish(changes);
        return out[0];
    }

    private void publish(List<Change> changes) {
        if (changes == null || changes.isEmpty()) {
            return;
        }
        for (Consumer<List<Change>> listener : listeners) {
            try {
                listener.accept(changes);
            } catch (RuntimeException e) {
                log.warn("a to-do listener failed: {}", e.getClass().getSimpleName());
            }
        }
    }

    private static Refused cap(String which, int limit) {
        return new Refused("cap", Map.of("which", which, "limit", limit));
    }

    private void requireOpenRoom(Connection c) throws SQLException, Refused {
        long open = TodoSql.longOne(c, "SELECT count(*) FROM items WHERE state = 'open' AND trashed_at IS NULL");
        if (open >= OPEN_PER_DESK) {
            throw cap("open", OPEN_PER_DESK);
        }
    }

    private static void requireLive(Row row, boolean trashOk) throws Refused {
        if (row == null) {
            throw new Refused("not_found", Map.of("reason", "item"));
        }
        if (!trashOk && row.trashedAt != null) {
            throw new Refused("trashed");
        }
    }

    static String dedupeKey(Source source, String normalTitle) {
        return TodoText.sha256(source.kind() + "\n" + (source.ref() == null ? "" : canonical(source.ref())) + "\n"
                + normalTitle);
    }

    private void insertItem(Connection c, String id, String rawTitle, String rawNote, Due due, boolean pinned, String by,
            String runId, Source source, boolean untrusted, String key, long now) throws SQLException {
        // Cleaned again here whatever the caller did: the store never holds a hidden or bidi character.
        String title = TodoText.title(rawTitle);
        if (title == null) {
            throw new SQLException("title");
        }
        String note = cleanNote(rawNote);
        String normal = TodoText.normalised(title);
        String dedupeKey = dedupeKey(source, normal);
        TodoSql.update(c, """
                INSERT INTO items (id, rev, title, title_words, note, due_date, due_time, due_by, pinned, pinned_at, state,
                  by, run_id, source_kind, source_ref, source_label, thread_key, untrusted, dedupe_key, add_key,
                  created_at, updated_at, seen_at)
                VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                id, title, normal, note, due == null ? null : due.date(), due == null ? null : due.time(),
                due == null ? null : due.by(), pinned, pinned ? now : null, by, runId, source.kind(), source.refJson(),
                source.label(), source.threadKey(), untrusted, dedupeKey, key, now, now,
                "member".equals(by) ? now : null);
        insertSource(c, id, source, dedupeKey, true, now);
        TodoSql.update(c, "INSERT INTO todo_fts (item_id, title, note) VALUES (?, ?, ?)", id, title,
                note == null ? "" : note);
        bump(c, id, "add", now);
    }

    private void insertSource(Connection c, String itemId, Source source, String dedupeKey, boolean primary, long now)
            throws SQLException {
        TodoSql.update(c, """
                INSERT INTO sources (item_id, kind, ref, ref_key, label, dedupe_key, thread_key, primary_source, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", itemId, source.kind(), source.refJson(), source.refKey(),
                source.label(), dedupeKey, source.threadKey(), primary ? 1 : 0, now);
    }

    /** Applies changed fields, records the event with only what changed, and bumps the rev. */
    private void change(Connection c, String id, String actor, String runId, String approvalId, String op,
            Map<String, Object> set) throws SQLException {
        changeWith(c, id, actor, runId, approvalId, op, set, Map.of(), Map.of());
    }

    private void changeWith(Connection c, String id, String actor, String runId, String approvalId, String op,
            Map<String, Object> set, Map<String, Object> extraBefore, Map<String, Object> extraAfter) throws SQLException {
        Map<String, Object> was = fields(c, id);
        Map<String, Object> before = new LinkedHashMap<>();
        Map<String, Object> after = new LinkedHashMap<>();
        long now = now();
        for (Map.Entry<String, Object> e : set.entrySet()) {
            String field = e.getKey();
            Object value = e.getValue();
            if (Objects.equals(normal(was.get(field)), normal(value))) {
                continue;
            }
            before.put(field, was.get(field));
            after.put(field, value);
            apply(c, id, field, value, now);
        }
        before.putAll(extraBefore);
        after.putAll(extraAfter);
        if (before.isEmpty() && after.isEmpty()) {
            return;
        }
        TodoSql.update(c, "UPDATE items SET updated_at = ? WHERE id = ?", now, id);
        if (after.containsKey("title") || after.containsKey("note")) {
            Row row = row(c, id);
            TodoSql.update(c, "DELETE FROM todo_fts WHERE item_id = ?", id);
            TodoSql.update(c, "INSERT INTO todo_fts (item_id, title, note) VALUES (?, ?, ?)", id, row.title,
                    row.note == null ? "" : row.note);
        }
        event(c, id, actor, runId, approvalId, op, before, after);
        bump(c, id, op, now);
    }

    private void apply(Connection c, String id, String field, Object value, long now) throws SQLException {
        switch (field) {
            case "title" -> {
                String title = TodoText.title((String) value);
                if (title == null) {
                    throw new SQLException("title");
                }
                TodoSql.update(c, "UPDATE items SET title = ?, title_words = ? WHERE id = ?", title,
                        TodoText.normalised(title), id);
            }
            case "note" -> TodoSql.update(c, "UPDATE items SET note = ? WHERE id = ?", cleanNote((String) value), id);
            case "due" -> {
                if (value instanceof Map<?, ?> due) {
                    TodoSql.update(c, "UPDATE items SET due_date = ?, due_time = ?, due_by = ? WHERE id = ?",
                            due.get("date"), due.get("time"), due.get("by"), id);
                } else {
                    TodoSql.update(c, "UPDATE items SET due_date = NULL, due_time = NULL, due_by = NULL WHERE id = ?", id);
                }
            }
            case "state" -> TodoSql.update(c, "UPDATE items SET state = ? WHERE id = ?", value, id);
            case "closed" -> {
                if (value instanceof Map<?, ?> closed) {
                    TodoSql.update(c, "UPDATE items SET closed_at = ?, closed_by = ? WHERE id = ?",
                            ((Number) closed.get("at")).longValue(), closed.get("by"), id);
                } else {
                    TodoSql.update(c, "UPDATE items SET closed_at = NULL, closed_by = NULL WHERE id = ?", id);
                }
            }
            case "snoozedUntil" -> TodoSql.update(c, "UPDATE items SET snoozed_until = ? WHERE id = ?",
                    value == null ? null : ((Number) value).longValue(), id);
            case "pinned" -> TodoSql.update(c, "UPDATE items SET pinned = ?, pinned_at = ? WHERE id = ?",
                    Boolean.TRUE.equals(value), Boolean.TRUE.equals(value) ? now : null, id);
            case "suggestion" -> TodoSql.update(c, "UPDATE items SET suggestion = ? WHERE id = ?",
                    value == null ? null : canonical(value), id);
            case "trashedAt" -> TodoSql.update(c, "UPDATE items SET trashed_at = ? WHERE id = ?",
                    value == null ? null : ((Number) value).longValue(), id);
            case "untrusted" -> TodoSql.update(c, "UPDATE items SET untrusted = ? WHERE id = ?", Boolean.TRUE.equals(value),
                    id);
            case "mergeCount" -> TodoSql.update(c, "UPDATE items SET merge_count = ? WHERE id = ?",
                    ((Number) value).longValue(), id);
            default -> throw new IllegalArgumentException("field");
        }
    }

    private static String cleanNote(String raw) throws SQLException {
        try {
            return TodoText.note(raw);
        } catch (IllegalArgumentException e) {
            throw new SQLException("note");
        }
    }

    /** The fields an event can change, as the wire has them. */
    private static Map<String, Object> fields(Connection c, String id) throws SQLException {
        Row row = row(c, id);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("title", row.title);
        m.put("note", row.note);
        m.put("due", row.dueDate == null ? null : new Due(row.dueDate, row.dueTime, row.dueBy).wire());
        m.put("state", row.state);
        m.put("closed", row.closedAt == null ? null : closed(row));
        m.put("snoozedUntil", row.snoozedUntil);
        m.put("pinned", row.pinned);
        m.put("suggestion", row.suggestion());
        m.put("trashedAt", row.trashedAt);
        m.put("untrusted", row.untrusted);
        m.put("mergeCount", row.mergeCount);
        return m;
    }

    private static Map<String, Object> closed(Row row) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("at", row.closedAt);
        m.put("by", row.closedBy);
        return m;
    }

    /** Values compared as JSON: numbers as longs, maps by their canonical text. */
    private static Object normal(Object value) {
        if (value instanceof Number n) {
            return n.longValue();
        }
        if (value instanceof Map<?, ?> || value instanceof List<?>) {
            return canonical(value);
        }
        return value;
    }

    private void event(Connection c, String id, String actor, String runId, String approvalId, String op,
            Map<String, Object> before, Map<String, Object> after) throws SQLException {
        TodoSql.update(c, """
                INSERT INTO events (id, item_id, at, actor, run_id, approval_id, op, before, after)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", newId(), id, now(), actor, runId, approvalId, op,
                before == null ? null : canonical(before), after == null ? null : canonical(after));
    }

    private void bump(Connection c, String id, String op, long now) throws SQLException {
        long rev = rev(c, id, op, now);
        TodoSql.update(c, "UPDATE items SET rev = ? WHERE id = ?", rev, id);
    }

    private long rev(Connection c, String id, String op, long now) throws SQLException {
        long rev = TodoSql.insert(c, "INSERT INTO revs (item_id, op, at) VALUES (?, ?, ?)", id, op, now);
        List<Change> changes = pending.get();
        if (changes != null) {
            changes.add(new Change(op, id, rev));
        }
        return rev;
    }

    private static long lastRev(Connection c) throws SQLException {
        Long last = TodoSql.longOne(c, "SELECT seq FROM sqlite_sequence WHERE name = 'revs'");
        return last == null ? 0 : last;
    }

    private List<Map<String, Object>> events(Connection c, String id, int max) throws SQLException {
        return TodoSql.list(c, """
                SELECT id, at, actor, run_id, op, before, after FROM events WHERE item_id = ?
                ORDER BY at DESC, rowid DESC LIMIT ?""", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getString(1));
            m.put("at", r.getLong(2));
            m.put("actor", r.getString(3));
            m.put("runId", r.getString(4));
            m.put("op", r.getString(5));
            m.put("before", publicFields(parse(r.getString(6))));
            m.put("after", publicFields(parse(r.getString(7))));
            return m;
        }, id, max);
    }

    /** An event's fields without the store's own bookkeeping keys. */
    private static Map<String, Object> publicFields(Map<String, Object> fields) {
        if (fields == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : fields.entrySet()) {
            if (e.getKey().startsWith("_")) {
                if (e.getValue() instanceof Map<?, ?> source) {
                    Map<String, Object> s = new LinkedHashMap<>();
                    s.put("kind", source.get("kind"));
                    s.put("label", source.get("label"));
                    out.put(e.getKey().substring(1), s);
                }
                continue;
            }
            out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    private Map<String, Object> item(Connection c, String id) throws SQLException {
        return item(c, id, today(), now());
    }

    private Map<String, Object> item(Connection c, String id, LocalDate today, long now) throws SQLException {
        Row row = row(c, id);
        if (row == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", row.id);
        m.put("rev", row.rev);
        m.put("title", row.title);
        m.put("note", row.note);
        m.put("due", row.dueDate == null ? null : new Due(row.dueDate, row.dueTime, row.dueBy).wire());
        m.put("state", row.state);
        m.put("closed", row.closedAt == null ? null : closed(row));
        m.put("snoozedUntil", row.snoozedUntil);
        m.put("pinned", row.pinned);
        m.put("by", row.by);
        m.put("runId", row.runId);
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("kind", row.sourceKind);
        source.put("ref", row.sourceRef == null ? null : parse(row.sourceRef));
        source.put("label", row.sourceLabel);
        m.put("source", source);
        m.put("alsoFrom", TodoSql.list(c, """
                SELECT kind, ref, label, at FROM sources WHERE item_id = ? AND primary_source = 0 ORDER BY at, rowid
                LIMIT 5""", r -> {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("kind", r.getString(1));
            s.put("ref", r.getString(2) == null ? null : parse(r.getString(2)));
            s.put("label", r.getString(3));
            s.put("at", r.getLong(4));
            return s;
        }, id));
        m.put("mergeCount", row.mergeCount);
        m.put("untrusted", row.untrusted);
        // A suggestion keeps its own untrusted mark on the wire, so the app can say so (Security's TD-M1).
        m.put("suggestion", row.suggestion());
        m.put("seen", row.seenAt != null);
        m.put("group", group(row, today, now));
        m.put("createdAt", row.createdAt);
        m.put("updatedAt", row.updatedAt);
        m.put("trashedAt", row.trashedAt);
        return m;
    }

    static String group(Row row, LocalDate today, long now) {
        if (!"open".equals(row.state) || row.trashedAt != null) {
            return null;
        }
        if (row.snoozedUntil != null && row.snoozedUntil > now) {
            return "snoozed";
        }
        if (row.dueDate == null) {
            return "no_date";
        }
        int cmp = row.dueDate.compareTo(today.toString());
        return cmp < 0 ? "overdue" : cmp == 0 ? "today" : "upcoming";
    }

    private static Facts facts(Row row) {
        return row == null ? null : new Facts(row.id, row.rev, row.title, row.by, row.runId, row.state,
                row.trashedAt != null, row.untrusted, row.sourceKind);
    }

    private static Set<String> wordsOf(String normal) {
        return normal == null || normal.isEmpty() ? Set.of() : new LinkedHashSet<>(Arrays.asList(normal.split(" ")));
    }

    static Row row(Connection c, String id) throws SQLException {
        return id == null ? null : TodoSql.one(c, "SELECT * FROM items WHERE id = ?", Row::of, id);
    }

    /** One {@code items} row. */
    record Row(String id, long rev, String title, String titleWords, String note, String dueDate, String dueTime,
            String dueBy, Long snoozedUntil, boolean pinned, String state, Long closedAt, String closedBy, String by,
            String runId, String sourceKind, String sourceRef, String sourceLabel, String threadKey, long mergeCount,
            boolean untrusted, String suggestionJson, Long seenAt, long createdAt, long updatedAt, Long trashedAt) {

        static Row of(ResultSet r) throws SQLException {
            return new Row(r.getString("id"), r.getLong("rev"), r.getString("title"), r.getString("title_words"),
                    r.getString("note"), r.getString("due_date"), r.getString("due_time"), r.getString("due_by"),
                    TodoSql.nullableLong(r, "snoozed_until"), r.getInt("pinned") != 0, r.getString("state"),
                    TodoSql.nullableLong(r, "closed_at"), r.getString("closed_by"), r.getString("by"),
                    r.getString("run_id"), r.getString("source_kind"), r.getString("source_ref"),
                    r.getString("source_label"), r.getString("thread_key"), r.getLong("merge_count"),
                    r.getInt("untrusted") != 0, r.getString("suggestion"), TodoSql.nullableLong(r, "seen_at"),
                    r.getLong("created_at"), r.getLong("updated_at"), TodoSql.nullableLong(r, "trashed_at"));
        }

        Map<String, Object> suggestion() {
            return suggestionJson == null ? null : parse(suggestionJson);
        }

        @Override
        public String toString() {
            return "Row[" + id + "]";
        }
    }

    // ---------------------------------------------------------------- ids and JSON

    /** A UUIDv7: 48 bits of ms, the version, then random. */
    String newId() {
        long ms = clock.millis();
        long high = (ms << 16) | 0x7000L | (random.nextInt() & 0x0FFF);
        long low = (random.nextLong() & 0x3FFFFFFFFFFFFFFFL) | 0x8000000000000000L;
        return new UUID(high, low).toString();
    }

    /** Canonical JSON: keys sorted at every level, as the approvals' hash uses. */
    static String canonical(Object value) {
        return new String(Json.bytes(sorted(value)), StandardCharsets.UTF_8);
    }

    private static Object sorted(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new TreeMap<>();
            map.forEach((k, v) -> out.put(String.valueOf(k), sorted(v)));
            return out;
        }
        if (value instanceof List<?> list) {
            List<Object> out = new ArrayList<>();
            list.forEach(v -> out.add(sorted(v)));
            return out;
        }
        return value;
    }

    static Map<String, Object> parse(String json) {
        if (json == null) {
            return null;
        }
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return null;
        }
    }

    /** For tests and the tidy's schedule: the file's database. */
    SqliteDatabase db() {
        return db;
    }

    /** For tests: an instant as the store's clock has it. */
    Instant instant() {
        return clock.instant();
    }
}
