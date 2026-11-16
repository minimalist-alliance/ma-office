package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Maia Mode's rows in {@code agent.db} (deskd {@code API.md} §23): additive tables, made at the first open and
 * idempotent, as the desk's other schemas are, so {@code user_version} stays 1 and a desk-agent from before still opens
 * the file. None of them holds desk content from another desk: names and titles the office sends stay in memory
 * ({@link Room}).
 *
 * <ul>
 *   <li>{@code maia_grants}: her grant for each of the member's other desks (scopes, expiry, "keeps to itself"),
 *       the mirror of deskd's own record, which is the boundary.
 *   <li>{@code maia_counts}: counts a day ({@code brief} per desk, {@code note}, {@code todo} per desk), for the caps,
 *       and her {@code credits} a day, in hundredths of a credit, for the member's own day cap on her.
 *   <li>{@code maia_replies}: what code adds to one of her replies (its choices, its note chips, a show), by message id.
 *   <li>{@code maia_notes}: her note log. A note's text is kept only while it's held (unsure, or waiting to file), and
 *       wiped once it's filed, dropped or undone: the Notebook holds it then.
 *   <li>{@code maia_pages}: the day's page in the "From Maia" tab for each area.
 *   <li>{@code maia_items}: the member's snoozes and dismissals of list items, by the item's key.
 *   <li>{@code maia_todo_jobs}: which agents file to-dos from Courier, and their last run.
 * </ul>
 * The settings ({@code maia.mode}) and the choice counts ({@code maia.choices}) are rows of {@code settings}.
 */
public final class MaiaStore {

    static final String MODE = "maia.mode";
    static final String CHOICES = "maia.choices";

    private final AgentStore agents;
    private final Clock clock;
    private volatile boolean ready;

    public MaiaStore(AgentStore agents, Clock clock) {
        this.agents = agents;
        this.clock = clock;
    }

    /** The agent store these rows live in (the focus shield keeps its own rows there too, {@link FocusStore}). */
    AgentStore agents() {
        return agents;
    }

    static void apply(Connection connection) throws SQLException {
        try (Statement s = connection.createStatement()) {
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_grants (
                      desk_id TEXT PRIMARY KEY,
                      grant_id TEXT NOT NULL,
                      desk_name TEXT NOT NULL,
                      scopes TEXT NOT NULL,
                      keeps INTEGER NOT NULL DEFAULT 0,
                      expires_at INTEGER NOT NULL,
                      created_at INTEGER NOT NULL,
                      last_used_at INTEGER
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_counts (
                      day TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      key TEXT NOT NULL,
                      n INTEGER NOT NULL,
                      PRIMARY KEY (day, kind, key)
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_replies (
                      message_id TEXT PRIMARY KEY,
                      extras TEXT NOT NULL,
                      at INTEGER NOT NULL
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_notes (
                      id TEXT PRIMARY KEY,
                      day TEXT NOT NULL,
                      area TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      state TEXT NOT NULL,
                      text TEXT,
                      due TEXT,
                      approval_id TEXT,
                      page_id TEXT,
                      message_id TEXT,
                      at INTEGER NOT NULL
                    ) STRICT""");
            s.execute("CREATE INDEX IF NOT EXISTS maia_notes_day ON maia_notes (day, at)");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_pages (
                      day TEXT NOT NULL,
                      area TEXT NOT NULL,
                      page_id TEXT NOT NULL,
                      PRIMARY KEY (day, area)
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_items (
                      item_key TEXT PRIMARY KEY,
                      snoozed_until INTEGER,
                      dismissed_at INTEGER,
                      at INTEGER NOT NULL
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_todo_jobs (
                      agent_id TEXT PRIMARY KEY,
                      on_ INTEGER NOT NULL,
                      last_run_at INTEGER,
                      last_filed INTEGER NOT NULL DEFAULT 0
                    ) STRICT""");
        }
    }

    private SqliteDatabase db() throws SQLException {
        SqliteDatabase db = agents.database();
        if (!ready) {
            synchronized (this) {
                if (!ready) {
                    db.transaction(connection -> {
                        apply(connection);
                        return null;
                    });
                    ready = true;
                }
            }
        }
        return db;
    }

    // ------------------------------------------------------------ settings

    String setting(String name) throws SQLException {
        db();
        return agents.setting(name);
    }

    void setSetting(String name, String value) throws SQLException {
        db();
        agents.setSetting(name, value);
    }

    /** Her agent row, role {@code staff}, made once. Nothing if it exists. */
    void ensureAgent() throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT OR IGNORE INTO agents (id, name, role, created_at) VALUES (?, ?, 'staff', ?)")) {
                insert.setString(1, MaiaAgent.ID);
                insert.setString(2, MaiaAgent.NAME);
                insert.setLong(3, clock.millis());
                insert.executeUpdate();
            }
            return null;
        });
    }

    // ------------------------------------------------------------ grants

    /** One grant as kept here. */
    public record Grant(String deskId, String grantId, String deskName, List<String> scopes, boolean keepsToItself,
            long expiresAt, long createdAt, Long lastUsedAt) {
        public Grant {
            scopes = List.copyOf(scopes);
        }

        public boolean live(long now) {
            return expiresAt > now;
        }

        public boolean allows(String scope, long now) {
            return live(now) && scopes.contains(scope);
        }
    }

    List<Grant> grants() throws SQLException {
        return db().call(connection -> {
            List<Grant> out = new ArrayList<>();
            try (PreparedStatement q = connection.prepareStatement("SELECT desk_id, grant_id, desk_name, scopes, keeps,"
                    + " expires_at, created_at, last_used_at FROM maia_grants ORDER BY created_at")) {
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        long used = r.getLong(8);
                        Long lastUsed = r.wasNull() ? null : used;
                        out.add(new Grant(r.getString(1), r.getString(2), r.getString(3),
                                List.of(r.getString(4).isEmpty() ? new String[0] : r.getString(4).split(",")),
                                r.getInt(5) != 0, r.getLong(6), r.getLong(7), lastUsed));
                    }
                }
            }
            return out;
        });
    }

    Grant grant(String deskId) throws SQLException {
        for (Grant g : grants()) {
            if (g.deskId().equals(deskId)) {
                return g;
            }
        }
        return null;
    }

    void putGrant(Grant g) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_grants (desk_id, grant_id,"
                    + " desk_name, scopes, keeps, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                    + " ON CONFLICT (desk_id) DO UPDATE SET desk_name = excluded.desk_name, scopes = excluded.scopes,"
                    + " keeps = excluded.keeps, expires_at = excluded.expires_at")) {
                up.setString(1, g.deskId());
                up.setString(2, g.grantId());
                up.setString(3, g.deskName());
                up.setString(4, String.join(",", g.scopes()));
                up.setInt(5, g.keepsToItself() ? 1 : 0);
                up.setLong(6, g.expiresAt());
                up.setLong(7, g.createdAt());
                if (g.lastUsedAt() == null) {
                    up.setNull(8, Types.INTEGER);
                } else {
                    up.setLong(8, g.lastUsedAt());
                }
                up.executeUpdate();
            }
            return null;
        });
    }

    boolean deleteGrant(String deskId) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM maia_grants WHERE desk_id = ?")) {
                del.setString(1, deskId);
                return del.executeUpdate() > 0;
            }
        });
    }

    int deleteAllGrants() throws SQLException {
        return db().transaction(connection -> {
            try (Statement s = connection.createStatement()) {
                return s.executeUpdate("DELETE FROM maia_grants");
            }
        });
    }

    void grantUsed(String deskId, long at) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement(
                    "UPDATE maia_grants SET last_used_at = ? WHERE desk_id = ?")) {
                up.setLong(1, at);
                up.setString(2, deskId);
                up.executeUpdate();
            }
            return null;
        });
    }

    // ------------------------------------------------------------ counts

    int count(String day, String kind, String key) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT n FROM maia_counts WHERE day = ? AND kind = ? AND key = ?")) {
                q.setString(1, day);
                q.setString(2, kind);
                q.setString(3, key);
                try (ResultSet r = q.executeQuery()) {
                    return r.next() ? r.getInt(1) : 0;
                }
            }
        });
    }

    /** Adds one if the count is under {@code cap}; @return whether it did, in one transaction. */
    boolean take(String day, String kind, String key, int cap) throws SQLException {
        return db().transaction(connection -> {
            int now;
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT n FROM maia_counts WHERE day = ? AND kind = ? AND key = ?")) {
                q.setString(1, day);
                q.setString(2, kind);
                q.setString(3, key);
                try (ResultSet r = q.executeQuery()) {
                    now = r.next() ? r.getInt(1) : 0;
                }
            }
            if (now >= cap) {
                return false;
            }
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_counts (day, kind, key, n)"
                    + " VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, key) DO UPDATE SET n = n + 1")) {
                up.setString(1, day);
                up.setString(2, kind);
                up.setString(3, key);
                up.executeUpdate();
            }
            // Counts older than 40 days go.
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM maia_counts WHERE day < ?")) {
                del.setString(1, java.time.LocalDate.parse(day).minusDays(40).toString());
                del.executeUpdate();
            }
            return true;
        });
    }

    /** A day's count as a sum ({@code credits} in hundredths of a credit), or 0. */
    long sum(String day, String kind, String key) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT n FROM maia_counts WHERE day = ? AND kind = ? AND key = ?")) {
                q.setString(1, day);
                q.setString(2, kind);
                q.setString(3, key);
                try (ResultSet r = q.executeQuery()) {
                    return r.next() ? r.getLong(1) : 0L;
                }
            }
        });
    }

    /** Adds {@code amount} to a day's count: her briefs' estimated µ$ per desk ({@link Wallet}), her credits in hundredths. */
    void add(String day, String kind, String key, long amount) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_counts (day, kind, key, n)"
                    + " VALUES (?, ?, ?, ?) ON CONFLICT (day, kind, key) DO UPDATE SET n = n + excluded.n")) {
                up.setString(1, day);
                up.setString(2, kind);
                up.setString(3, key);
                up.setLong(4, Math.max(0, amount));
                up.executeUpdate();
            }
            return null;
        });
    }

    /** A count summed over the days from {@code fromDay} on, by key. */
    Map<String, Long> sums(String kind, String fromDay) throws SQLException {
        return db().call(connection -> {
            Map<String, Long> out = new java.util.HashMap<>();
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT key, SUM(n) FROM maia_counts WHERE kind = ? AND day >= ? GROUP BY key")) {
                q.setString(1, kind);
                q.setString(2, fromDay);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        out.put(r.getString(1), r.getLong(2));
                    }
                }
            }
            return out;
        });
    }

    /** Gives one back (a call that was refused after its count was taken). */
    void giveBack(String day, String kind, String key) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement(
                    "UPDATE maia_counts SET n = max(0, n - 1) WHERE day = ? AND kind = ? AND key = ?")) {
                up.setString(1, day);
                up.setString(2, kind);
                up.setString(3, key);
                up.executeUpdate();
            }
            return null;
        });
    }

    // ------------------------------------------------------------ replies

    /** A reply's extras, or null: tests and the room's checks. */
    public Map<String, Object> extrasOf(String messageId) throws SQLException {
        return extras(messageId);
    }

    Map<String, Object> extras(String messageId) throws SQLException {
        String json = db().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT extras FROM maia_replies WHERE message_id = ?")) {
                q.setString(1, messageId);
                try (ResultSet r = q.executeQuery()) {
                    return r.next() ? r.getString(1) : null;
                }
            }
        });
        return json == null ? null : parse(json);
    }

    public void putExtras(String messageId, Map<String, Object> extras) throws SQLException {
        String json = new String(Json.bytes(extras), StandardCharsets.UTF_8);
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_replies (message_id, extras, at)"
                    + " VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET extras = excluded.extras")) {
                up.setString(1, messageId);
                up.setString(2, json);
                up.setLong(3, clock.millis());
                up.executeUpdate();
            }
            return null;
        });
    }

    /** The newest of her replies that has open choices, or null. */
    String openChoices() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement("SELECT message_id, extras FROM maia_replies"
                    + " ORDER BY at DESC LIMIT 20")) {
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        Map<String, Object> extras = parse(r.getString(2));
                        if (extras.get("choices") instanceof Map<?, ?> c && "open".equals(c.get("state"))) {
                            return r.getString(1);
                        }
                    }
                }
            }
            return null;
        });
    }

    // ------------------------------------------------------------ notes

    /** One note in her log. {@code text} only while it's held. */
    public record Note(String id, String day, String area, String kind, String state, String text, String due,
            String approvalId, String pageId, String messageId, long at) {}

    void putNote(Note n) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_notes (id, day, area, kind,"
                    + " state, text, due, approval_id, page_id, message_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    + " ON CONFLICT (id) DO UPDATE SET area = excluded.area, state = excluded.state,"
                    + " text = excluded.text, approval_id = excluded.approval_id, page_id = excluded.page_id")) {
                up.setString(1, n.id());
                up.setString(2, n.day());
                up.setString(3, n.area());
                up.setString(4, n.kind());
                up.setString(5, n.state());
                setNullable(up, 6, n.text());
                setNullable(up, 7, n.due());
                setNullable(up, 8, n.approvalId());
                setNullable(up, 9, n.pageId());
                setNullable(up, 10, n.messageId());
                up.setLong(11, n.at());
                up.executeUpdate();
            }
            return null;
        });
    }

    Note note(String id) throws SQLException {
        List<Note> found = notesWhere("id = ?", id);
        return found.isEmpty() ? null : found.get(0);
    }

    List<Note> notesOfDay(String day) throws SQLException {
        return notesWhere("day = ?", day);
    }

    List<Note> notesInState(String state) throws SQLException {
        return notesWhere("state = ?", state);
    }

    List<Note> notesOfMessage(String messageId) throws SQLException {
        return notesWhere("message_id = ?", messageId);
    }

    Note noteByApproval(String approvalId) throws SQLException {
        List<Note> found = notesWhere("approval_id = ?", approvalId);
        return found.isEmpty() ? null : found.get(0);
    }

    private List<Note> notesWhere(String where, String value) throws SQLException {
        return db().call(connection -> {
            List<Note> out = new ArrayList<>();
            try (PreparedStatement q = connection.prepareStatement("SELECT id, day, area, kind, state, text, due,"
                    + " approval_id, page_id, message_id, at FROM maia_notes WHERE " + where + " ORDER BY at, id")) {
                q.setString(1, value);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        out.add(new Note(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getString(6), r.getString(7), r.getString(8), r.getString(9),
                                r.getString(10), r.getLong(11)));
                    }
                }
            }
            return out;
        });
    }

    /** Held notes older than {@code beforeMs} are dropped, their text wiped; and every note older than 90 days goes. */
    int sweepNotes(long heldBeforeMs, String oldestDay) throws SQLException {
        return db().transaction(connection -> {
            int n;
            try (PreparedStatement up = connection.prepareStatement("UPDATE maia_notes SET state = 'dropped',"
                    + " text = NULL WHERE state = 'held' AND at < ?")) {
                up.setLong(1, heldBeforeMs);
                n = up.executeUpdate();
            }
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM maia_notes WHERE day < ?")) {
                del.setString(1, oldestDay);
                del.executeUpdate();
            }
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM maia_pages WHERE day < ?")) {
                del.setString(1, oldestDay);
                del.executeUpdate();
            }
            return n;
        });
    }

    String page(String day, String area) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT page_id FROM maia_pages WHERE day = ? AND area = ?")) {
                q.setString(1, day);
                q.setString(2, area);
                try (ResultSet r = q.executeQuery()) {
                    return r.next() ? r.getString(1) : null;
                }
            }
        });
    }

    void putPage(String day, String area, String pageId) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_pages (day, area, page_id)"
                    + " VALUES (?, ?, ?) ON CONFLICT (day, area) DO UPDATE SET page_id = excluded.page_id")) {
                up.setString(1, day);
                up.setString(2, area);
                up.setString(3, pageId);
                up.executeUpdate();
            }
            return null;
        });
    }

    void forgetPage(String day, String area) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement del = connection.prepareStatement(
                    "DELETE FROM maia_pages WHERE day = ? AND area = ?")) {
                del.setString(1, day);
                del.setString(2, area);
                del.executeUpdate();
            }
            return null;
        });
    }

    // ------------------------------------------------------------ items

    /** The member's choice for a list item: {snoozedUntil, dismissedAt}, or null. */
    Map<String, Long> item(String key) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT snoozed_until, dismissed_at FROM maia_items WHERE item_key = ?")) {
                q.setString(1, key);
                try (ResultSet r = q.executeQuery()) {
                    if (!r.next()) {
                        return null;
                    }
                    Map<String, Long> out = new LinkedHashMap<>();
                    long s = r.getLong(1);
                    out.put("snoozedUntil", r.wasNull() ? null : s);
                    long d = r.getLong(2);
                    out.put("dismissedAt", r.wasNull() ? null : d);
                    return out;
                }
            }
        });
    }

    Map<String, Map<String, Long>> items() throws SQLException {
        return db().call(connection -> {
            Map<String, Map<String, Long>> out = new LinkedHashMap<>();
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT item_key, snoozed_until, dismissed_at FROM maia_items")) {
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        Map<String, Long> one = new LinkedHashMap<>();
                        long s = r.getLong(2);
                        one.put("snoozedUntil", r.wasNull() ? null : s);
                        long d = r.getLong(3);
                        one.put("dismissedAt", r.wasNull() ? null : d);
                        out.put(r.getString(1), one);
                    }
                }
            }
            return out;
        });
    }

    void putItem(String key, Long snoozedUntil, Long dismissedAt) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_items (item_key, snoozed_until,"
                    + " dismissed_at, at) VALUES (?, ?, ?, ?) ON CONFLICT (item_key) DO UPDATE SET snoozed_until ="
                    + " excluded.snoozed_until, dismissed_at = excluded.dismissed_at, at = excluded.at")) {
                up.setString(1, key);
                if (snoozedUntil == null) {
                    up.setNull(2, Types.INTEGER);
                } else {
                    up.setLong(2, snoozedUntil);
                }
                if (dismissedAt == null) {
                    up.setNull(3, Types.INTEGER);
                } else {
                    up.setLong(3, dismissedAt);
                }
                up.setLong(4, clock.millis());
                up.executeUpdate();
            }
            // Choices about items older than 7 days go.
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM maia_items WHERE at < ?")) {
                del.setLong(1, clock.millis() - 7L * 86_400_000L);
                del.executeUpdate();
            }
            return null;
        });
    }

    // ------------------------------------------------------------ to-do jobs

    /** Who files to-dos from Courier on this desk. */
    public record TodoJob(String agentId, boolean on, Long lastRunAt, int lastFiled) {}

    List<TodoJob> todoJobs() throws SQLException {
        return db().call(connection -> {
            List<TodoJob> out = new ArrayList<>();
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT agent_id, on_, last_run_at, last_filed FROM maia_todo_jobs ORDER BY agent_id")) {
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        long last = r.getLong(3);
                        out.add(new TodoJob(r.getString(1), r.getInt(2) != 0, r.wasNull() ? null : last,
                                r.getInt(4)));
                    }
                }
            }
            return out;
        });
    }

    void putTodoJob(String agentId, boolean on) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement("INSERT INTO maia_todo_jobs (agent_id, on_)"
                    + " VALUES (?, ?) ON CONFLICT (agent_id) DO UPDATE SET on_ = excluded.on_")) {
                up.setString(1, agentId);
                up.setInt(2, on ? 1 : 0);
                up.executeUpdate();
            }
            return null;
        });
    }

    void todoJobRan(String agentId, long at, int filed) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement up = connection.prepareStatement(
                    "UPDATE maia_todo_jobs SET last_run_at = ?, last_filed = ? WHERE agent_id = ?")) {
                up.setLong(1, at);
                up.setInt(2, filed);
                up.setString(3, agentId);
                up.executeUpdate();
            }
            return null;
        });
    }

    // ------------------------------------------------------------ forget

    /**
     * "Delete Maia Mode history": her note log, her pages' record, her replies' extras and her list choices. Her
     * thread goes through the agent store ({@link MaiaMode#forget}).
     */
    void forget() throws SQLException {
        db().transaction(connection -> {
            try (Statement s = connection.createStatement()) {
                s.executeUpdate("DELETE FROM maia_notes");
                s.executeUpdate("DELETE FROM maia_pages");
                s.executeUpdate("DELETE FROM maia_replies");
                s.executeUpdate("DELETE FROM maia_items");
                s.executeUpdate("DELETE FROM settings WHERE name = '" + CHOICES + "'");
            }
            return null;
        });
    }

    /**
     * Her chats older than {@code beforeMs} go (the disclosure's "Chats are removed after 90 days"): her thread's messages
     * and everything kept by them (files' notes, run marks and plans, approvals with their payloads, run records and
     * checkpoints, her replies' extras), and her thread's summary once any of it went, as it may fold their words. A
     * reply still streaming stays. In one transaction. {@code Long.MAX_VALUE} is all of it ("Delete Maia Mode history").
     *
     * @return how many messages went
     */
    int pruneChats(long beforeMs) throws SQLException {
        return db().transaction(connection -> {
            String old = "SELECT id FROM messages WHERE agent_id = 'maia' AND at_ms < ?1 AND (state IS NULL OR state <> 'streaming')";
            for (String sql : List.of(
                    "DELETE FROM message_files WHERE message_id IN (" + old + ")",
                    "DELETE FROM run_marks WHERE message_id IN (" + old + ")",
                    "DELETE FROM run_plans WHERE message_id IN (" + old + ")",
                    "DELETE FROM approvals WHERE agent_id = 'maia' AND (message_id IN (" + old + ") OR created_at < ?1)",
                    "DELETE FROM run_calls WHERE message_id IN (" + old + ")",
                    "DELETE FROM run_steps WHERE run_id IN (SELECT run_id FROM runs WHERE agent_id = 'maia'"
                            + " AND ended_at IS NOT NULL AND (message_id IN (" + old + ") OR ended_at < ?1))",
                    "DELETE FROM run_results WHERE run_id IN (SELECT run_id FROM runs WHERE agent_id = 'maia'"
                            + " AND ended_at IS NOT NULL AND (message_id IN (" + old + ") OR ended_at < ?1))",
                    "DELETE FROM runs WHERE agent_id = 'maia' AND ended_at IS NOT NULL AND (message_id IN (" + old
                            + ") OR ended_at < ?1)",
                    "DELETE FROM maia_replies WHERE message_id IN (" + old + ") OR at < ?1")) {
                String table = sql.substring("DELETE FROM ".length(), sql.indexOf(' ', "DELETE FROM ".length()));
                if (exists(connection, table)) {
                    try (PreparedStatement del = connection.prepareStatement(sql)) {
                        del.setLong(1, beforeMs);
                        del.executeUpdate();
                    }
                }
            }
            int n;
            try (PreparedStatement del = connection.prepareStatement(
                    "DELETE FROM messages WHERE agent_id = 'maia' AND at_ms < ? AND (state IS NULL OR state <> 'streaming')")) {
                del.setLong(1, beforeMs);
                n = del.executeUpdate();
            }
            if (n > 0 && exists(connection, "thread_summaries")) {
                try (PreparedStatement del = connection.prepareStatement(
                        "DELETE FROM thread_summaries WHERE agent_id = 'maia'")) {
                    del.executeUpdate();
                }
            }
            return n;
        });
    }

    /** The desks whose private answers came into runs of hers whose replies are this recent ("keeps to itself"). */
    java.util.Set<String> replyOrigins(long sinceMs) throws SQLException {
        return db().call(connection -> {
            java.util.Set<String> out = new java.util.HashSet<>();
            try (PreparedStatement q = connection.prepareStatement(
                    "SELECT extras FROM maia_replies WHERE at >= ? AND extras LIKE '%deskOrigins%'")) {
                q.setLong(1, sinceMs);
                try (ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        if (parse(r.getString(1)).get("deskOrigins") instanceof List<?> l) {
                            for (Object o : l) {
                                if (o instanceof String s) {
                                    out.add(s);
                                }
                            }
                        }
                    }
                }
            }
            return out;
        });
    }

    /** Her thread's messages, removed (her row stays): the store has no delete of a thread, so it's done here. */
    int deleteThread() throws SQLException {
        return db().transaction(connection -> {
            int n;
            try (PreparedStatement del = connection.prepareStatement("DELETE FROM messages WHERE agent_id = ?")) {
                del.setString(1, MaiaAgent.ID);
                n = del.executeUpdate();
            }
            for (String table : List.of("thread_summaries", "memories")) {
                if (exists(connection, table)) {
                    try (PreparedStatement del = connection.prepareStatement(
                            "DELETE FROM " + table + " WHERE agent_id = ?")) {
                        del.setString(1, MaiaAgent.ID);
                        del.executeUpdate();
                    }
                }
            }
            return n;
        });
    }

    private static boolean exists(Connection connection, String table) throws SQLException {
        try (PreparedStatement q = connection.prepareStatement(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")) {
            q.setString(1, table);
            try (ResultSet r = q.executeQuery()) {
                return r.next();
            }
        }
    }

    private static void setNullable(PreparedStatement p, int i, String v) throws SQLException {
        if (v == null) {
            p.setNull(i, Types.VARCHAR);
        } else {
            p.setString(i, v);
        }
    }

    static Map<String, Object> parse(String json) {
        try {
            return new LinkedHashMap<>(Json.parseObject(json.getBytes(StandardCharsets.UTF_8)));
        } catch (RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException e) {
            return new LinkedHashMap<>();
        }
    }
}
