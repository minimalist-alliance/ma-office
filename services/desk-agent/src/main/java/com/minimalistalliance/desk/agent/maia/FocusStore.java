package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The focus shield's rows in {@code agent.db} (deskd {@code API.md} §23 "What reaches the member"): additive tables
 * made
 * at first use, as every Maia table, so a rollback still opens the file.
 *
 * <ul>
 *   <li>{@code maia_focus_kv}: the member's settings ({@code reach}: the let-through list with any name typed under
 *       "Someone by name…", the only text, the member's own) and the shield's state ({@code state}: items by key with
 *       their level, state and times, learned rules and counts, the hold, the stated task; never a title);</li>
 *   <li>{@code maia_focus_counts}: the day's counts for the measurement signals, 90 days;</li>
 *   <li>{@code maia_focus_misses}: held items that passed their deadline, or the member's "Should have told me sooner",
 *       by key, 90 days.</li>
 * </ul>
 * Focus itself (desk, app, item, people, timing) is never written: it stays in memory ({@link Focus.Tracker}).
 */
public final class FocusStore implements Shield.Store {

    private static final Logger log = LoggerFactory.getLogger(FocusStore.class);
    static final int KEEP_DAYS = 90;

    private final AgentStore agents;
    private volatile boolean ready;

    public FocusStore(AgentStore agents) {
        this.agents = agents;
    }

    static void apply(Connection connection) throws SQLException {
        try (Statement s = connection.createStatement()) {
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_focus_kv (
                      key TEXT PRIMARY KEY,
                      value TEXT NOT NULL,
                      at INTEGER NOT NULL
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_focus_counts (
                      day TEXT NOT NULL,
                      name TEXT NOT NULL,
                      n INTEGER NOT NULL,
                      PRIMARY KEY (day, name)
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_focus_misses (
                      item_key TEXT NOT NULL,
                      kind TEXT,
                      at INTEGER NOT NULL
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

    @Override
    public Reach.Settings settings(long now) {
        Map<String, Object> raw = read("reach");
        if (raw == null) {
            return Reach.Settings.defaults(now);
        }
        try {
            Reach.Settings d = Reach.Settings.defaults(now);
            Map<String, Object> p = new LinkedHashMap<>(raw);
            // Stored as set: re-read through the same checks, so a bad row reads as the default for that field.
            return Reach.set(p, new Reach.Settings(java.util.List.of(), false, d.catchUps(), d.focusHours(),
                    d.quietHours(), d.evenings(), d.detail(), d.showAll()), now, () -> "mr-x" + Long.toString(now,
                    36));
        } catch (Exception e) {
            log.warn("the shield's settings weren't read: {}", e.getClass().getSimpleName());
            return Reach.Settings.defaults(now);
        }
    }

    @Override
    public void putSettings(Reach.Settings s) {
        write("reach", s.view());
    }

    @Override
    public Map<String, Object> state() {
        Map<String, Object> s = read("state");
        return s == null ? new LinkedHashMap<>() : s;
    }

    @Override
    public void putState(Map<String, Object> state) {
        write("state", state);
    }

    private Map<String, Object> read(String key) {
        try {
            return db().call(connection -> {
                try (PreparedStatement q = connection.prepareStatement(
                        "SELECT value FROM maia_focus_kv WHERE key = ?")) {
                    q.setString(1, key);
                    try (ResultSet r = q.executeQuery()) {
                        if (!r.next()) {
                            return null;
                        }
                        return Json.parseObject(r.getString(1).getBytes(StandardCharsets.UTF_8));
                    } catch (Exception e) {
                        return null;
                    }
                }
            });
        } catch (SQLException e) {
            log.warn("the shield's {} wasn't read: {}", key, e.getClass().getSimpleName());
            return null;
        }
    }

    private void write(String key, Map<String, Object> value) {
        String text = new String(Json.bytes(value), StandardCharsets.UTF_8);
        try {
            db().transaction(connection -> {
                try (PreparedStatement u = connection.prepareStatement(
                        "INSERT INTO maia_focus_kv (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE"
                                + " SET value = excluded.value, at = excluded.at")) {
                    u.setString(1, key);
                    u.setString(2, text);
                    u.setLong(3, System.currentTimeMillis());
                    u.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("the shield's {} wasn't written: {}", key, e.getClass().getSimpleName());
        }
    }

    @Override
    public void count(String day, String name, int n) {
        try {
            db().transaction(connection -> {
                try (PreparedStatement u = connection.prepareStatement(
                        "INSERT INTO maia_focus_counts (day, name, n) VALUES (?, ?, ?) ON CONFLICT(day, name) DO"
                                + " UPDATE SET n = n + excluded.n")) {
                    u.setString(1, day);
                    u.setString(2, name);
                    u.setInt(3, n);
                    u.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("a shield count wasn't kept: {}", e.getClass().getSimpleName());
        }
    }

    @Override
    public int sum(String fromDay, String toDay, String name) {
        try {
            return db().call(connection -> {
                try (PreparedStatement q = connection.prepareStatement(
                        "SELECT COALESCE(SUM(n), 0) FROM maia_focus_counts WHERE name = ? AND day >= ? AND day <= ?")) {
                    q.setString(1, name);
                    q.setString(2, fromDay);
                    q.setString(3, toDay);
                    try (ResultSet r = q.executeQuery()) {
                        return r.next() ? r.getInt(1) : 0;
                    }
                }
            });
        } catch (SQLException e) {
            return 0;
        }
    }

    @Override
    public void miss(String itemKey, String kind, long at) {
        try {
            db().transaction(connection -> {
                try (PreparedStatement u = connection.prepareStatement(
                        "INSERT INTO maia_focus_misses (item_key, kind, at) VALUES (?, ?, ?)")) {
                    u.setString(1, itemKey.length() > 200 ? itemKey.substring(0, 200) : itemKey);
                    u.setString(2, kind);
                    u.setLong(3, at);
                    u.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("a shield miss wasn't kept: {}", e.getClass().getSimpleName());
        }
    }

    @Override
    public void forget() {
        try {
            db().transaction(connection -> {
                try (Statement s = connection.createStatement()) {
                    s.execute("DELETE FROM maia_focus_kv WHERE key = 'state'");
                    s.execute("DELETE FROM maia_focus_counts");
                    s.execute("DELETE FROM maia_focus_misses");
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("the shield's history wasn't deleted: {}", e.getClass().getSimpleName());
        }
    }

    /** Counts and misses older than 90 days go (Maia Mode's upkeep). */
    public void prune(LocalDate today) {
        String before = today.minusDays(KEEP_DAYS).toString();
        long beforeMs = System.currentTimeMillis() - KEEP_DAYS * 86_400_000L;
        try {
            db().transaction(connection -> {
                try (PreparedStatement a = connection.prepareStatement(
                        "DELETE FROM maia_focus_counts WHERE day < ?");
                        PreparedStatement b = connection.prepareStatement(
                                "DELETE FROM maia_focus_misses WHERE at < ?")) {
                    a.setString(1, before);
                    a.executeUpdate();
                    b.setLong(1, beforeMs);
                    b.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("the shield's counts weren't pruned: {}", e.getClass().getSimpleName());
        }
    }
}
