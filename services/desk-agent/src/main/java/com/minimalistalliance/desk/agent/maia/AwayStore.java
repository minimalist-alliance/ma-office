package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Maia while the member is away, kept in {@code agent.db} (Maia Mode Phase 2, draft-desk-maia.md decision 12). Additive,
 * as every Maia table ({@code CREATE TABLE IF NOT EXISTS} at first use), so a rollback still opens the file.
 *
 * <ul>
 *   <li>{@code maia_briefs}: her briefs (the envelope's id, the desk, what she expects back), open until answered;</li>
 *   <li>{@code maia_reports}: what came back, read by code, waiting for her model or filed by code (the durable queue:
 *       a row stays until her run read it, and a batch a stop cut off goes back to waiting at the next start);</li>
 *   <li>{@code maia_checkins}: her check-ins, fired by code at their time, at a start if missed by under a day;</li>
 *   <li>{@code maia_away_log}: what happened while the member was away, code's words and ids, for the summary;</li>
 *   <li>{@code desk_writeups}: on any desk, the full write-ups its agents left for her briefs (90 days).</li>
 * </ul>
 */
public final class AwayStore {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String B32 = "abcdefghijklmnopqrstuvwxyz234567";
    public static final long WRITEUP_DAYS = 90;
    static final long KEEP_READ_MS = 7L * 86_400_000;

    private final AgentStore agents;
    private volatile boolean ready;

    public AwayStore(AgentStore agents) {
        this.agents = agents;
    }

    static void apply(Connection connection) throws SQLException {
        try (Statement s = connection.createStatement()) {
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_briefs (
                      env_id TEXT PRIMARY KEY,
                      desk_id TEXT NOT NULL,
                      expect TEXT NOT NULL,
                      state TEXT NOT NULL,
                      sent_at INTEGER NOT NULL,
                      answered_at INTEGER
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_reports (
                      id TEXT PRIMARY KEY,
                      env_id TEXT,
                      desk_id TEXT NOT NULL,
                      agent TEXT NOT NULL,
                      status TEXT NOT NULL,
                      urgency TEXT NOT NULL,
                      importance TEXT NOT NULL,
                      capped INTEGER NOT NULL DEFAULT 0,
                      writeup_id TEXT,
                      message_id TEXT,
                      state TEXT NOT NULL,
                      batch TEXT,
                      at INTEGER NOT NULL,
                      due_at INTEGER NOT NULL,
                      read_at INTEGER
                    ) STRICT""");
            s.execute("CREATE INDEX IF NOT EXISTS maia_reports_state ON maia_reports (state, due_at)");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_checkins (
                      id TEXT PRIMARY KEY,
                      due_at INTEGER NOT NULL,
                      state TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      fired_at INTEGER
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_away_log (
                      seq INTEGER PRIMARY KEY AUTOINCREMENT,
                      at INTEGER NOT NULL,
                      kind TEXT NOT NULL,
                      desk_id TEXT,
                      line TEXT NOT NULL
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS desk_writeups (
                      id TEXT PRIMARY KEY,
                      env_id TEXT,
                      agent_id TEXT NOT NULL,
                      from_desk_id TEXT,
                      text TEXT NOT NULL,
                      at INTEGER NOT NULL
                    ) STRICT""");
            // Whether the answer that carried it needed no card on this desk (0 until its call says so: fails closed).
            try {
                s.execute("ALTER TABLE desk_writeups ADD COLUMN readable INTEGER NOT NULL DEFAULT 0");
            } catch (SQLException e) {
                // Already there.
            }
        }
    }

    SqliteDatabase db() throws SQLException {
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

    static String id(String prefix) {
        StringBuilder b = new StringBuilder(prefix);
        for (int i = 0; i < 20; i++) {
            b.append(B32.charAt(RANDOM.nextInt(32)));
        }
        return b.toString();
    }

    // ---------------------------------------------------------------- briefs

    public record Brief(String envId, String deskId, Reports.Expect expect, String state, long sentAt, Long answeredAt) {}

    public void briefSent(String envId, String deskId, Reports.Expect expect, long now) throws SQLException {
        String json = new String(Json.bytes(expect.toJson()), StandardCharsets.UTF_8);
        db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("INSERT OR IGNORE INTO maia_briefs (env_id, desk_id, expect,"
                    + " state, sent_at) VALUES (?, ?, ?, 'open', ?)")) {
                p.setString(1, envId);
                p.setString(2, deskId);
                p.setString(3, json);
                p.setLong(4, now);
                return p.executeUpdate();
            }
        });
    }

    public Brief brief(String envId) throws SQLException {
        if (envId == null) {
            return null;
        }
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT env_id, desk_id, expect, state, sent_at, answered_at"
                    + " FROM maia_briefs WHERE env_id = ?")) {
                p.setString(1, envId);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? briefOf(r) : null;
                }
            }
        });
    }

    private static Brief briefOf(ResultSet r) throws SQLException {
        Reports.Expect e;
        try {
            e = Reports.Expect.of(Json.parseObject(r.getString(3).getBytes(StandardCharsets.UTF_8)));
        } catch (RuntimeException | com.minimalistalliance.desk.agent.json.JsonFormatException ex) {
            e = Reports.Expect.NONE;
        }
        long a = r.getLong(6);
        return new Brief(r.getString(1), r.getString(2), e, r.getString(4), r.getLong(5), r.wasNull() ? null : a);
    }

    /** The open brief to this desk an answer answers: by its envelope, else the oldest open one to that desk. */
    public Brief answered(String envId, String deskId, long now) throws SQLException {
        return db().transaction(c -> {
            Brief b = null;
            if (envId != null) {
                try (PreparedStatement p = c.prepareStatement("SELECT env_id, desk_id, expect, state, sent_at,"
                        + " answered_at FROM maia_briefs WHERE env_id = ? AND state = 'open'")) {
                    p.setString(1, envId);
                    try (ResultSet r = p.executeQuery()) {
                        b = r.next() ? briefOf(r) : null;
                    }
                }
            }
            if (b == null && envId == null) {
                try (PreparedStatement p = c.prepareStatement("SELECT env_id, desk_id, expect, state, sent_at,"
                        + " answered_at FROM maia_briefs WHERE desk_id = ? AND state = 'open' ORDER BY sent_at LIMIT 1")) {
                    p.setString(1, deskId);
                    try (ResultSet r = p.executeQuery()) {
                        b = r.next() ? briefOf(r) : null;
                    }
                }
            }
            if (b != null) {
                try (PreparedStatement u = c.prepareStatement("UPDATE maia_briefs SET state = 'answered',"
                        + " answered_at = ? WHERE env_id = ?")) {
                    u.setLong(1, now);
                    u.setString(2, b.envId());
                    u.executeUpdate();
                }
            }
            return b;
        });
    }

    /** Open briefs sent after {@code since}. */
    public int openBriefs(long since) throws SQLException {
        return count("SELECT COUNT(*) FROM maia_briefs WHERE state = 'open' AND sent_at > ?", since);
    }

    // ---------------------------------------------------------------- reports

    public record Row(String id, String envId, String deskId, String agent, String status, String urgency,
            String importance, boolean capped, String writeupId, String messageId, String state, String batch, long at,
            long dueAt) {}

    private static final String ROW = "id, env_id, desk_id, agent, status, urgency, importance, capped, writeup_id,"
            + " message_id, state, batch, at, due_at";

    private static Row rowOf(ResultSet r) throws SQLException {
        return new Row(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6),
                r.getString(7), r.getInt(8) != 0, r.getString(9), r.getString(10), r.getString(11), r.getString(12),
                r.getLong(13), r.getLong(14));
    }

    public void putReport(Row row) throws SQLException {
        db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("INSERT OR IGNORE INTO maia_reports (" + ROW
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                p.setString(1, row.id());
                p.setString(2, row.envId());
                p.setString(3, row.deskId());
                p.setString(4, row.agent());
                p.setString(5, row.status());
                p.setString(6, row.urgency());
                p.setString(7, row.importance());
                p.setInt(8, row.capped() ? 1 : 0);
                p.setString(9, row.writeupId());
                p.setString(10, row.messageId());
                p.setString(11, row.state());
                p.setString(12, row.batch());
                p.setLong(13, row.at());
                p.setLong(14, row.dueAt());
                return p.executeUpdate();
            }
        });
    }

    public List<Row> reports(String state) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT " + ROW + " FROM maia_reports WHERE state = ?"
                    + " ORDER BY at, id")) {
                p.setString(1, state);
                List<Row> out = new ArrayList<>();
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        out.add(rowOf(r));
                    }
                }
                return out;
            }
        });
    }

    /** {@code now} or {@code critical} reports from one desk's agent since then, capped or not. */
    public int urgentFrom(String deskId, String agent, long since) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT COUNT(*) FROM maia_reports WHERE desk_id = ? AND"
                    + " agent = ? AND at > ? AND capped = 0 AND (urgency = 'now' OR importance = 'critical')")) {
                p.setString(1, deskId);
                p.setString(2, agent);
                p.setLong(3, since);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? r.getInt(1) : 0;
                }
            }
        });
    }

    /** Every waiting report into one batch, at once. @return them */
    public List<Row> takeAll(String batch) throws SQLException {
        return db().transaction(c -> {
            List<Row> out = new ArrayList<>();
            try (PreparedStatement p = c.prepareStatement("SELECT " + ROW + " FROM maia_reports WHERE state ="
                    + " 'waiting' ORDER BY at, id")) {
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        out.add(rowOf(r));
                    }
                }
            }
            try (PreparedStatement u = c.prepareStatement("UPDATE maia_reports SET state = 'taken', batch = ? WHERE"
                    + " state = 'waiting'")) {
                u.setString(1, batch);
                u.executeUpdate();
            }
            return out;
        });
    }

    /** A batch her run read: read. A batch her run didn't finish: waiting again, due at {@code dueAt}. */
    public int settleBatch(String batch, boolean read, long now, long dueAt) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement u = c.prepareStatement(read
                    ? "UPDATE maia_reports SET state = 'read', read_at = ? WHERE batch = ? AND state = 'taken'"
                    : "UPDATE maia_reports SET state = 'waiting', batch = NULL, due_at = ? WHERE batch = ? AND state ="
                            + " 'taken'")) {
                u.setLong(1, read ? now : dueAt);
                u.setString(2, batch);
                return u.executeUpdate();
            }
        });
    }

    /** At start: a batch a stop cut off is waiting again (nothing a desk sent her is lost). */
    public int restoreTaken(long dueAt) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement u = c.prepareStatement("UPDATE maia_reports SET state = 'waiting', batch = NULL,"
                    + " due_at = MIN(due_at, ?) WHERE state = 'taken'")) {
                u.setLong(1, dueAt);
                return u.executeUpdate();
            }
        });
    }

    public Long nextDue() throws SQLException {
        return db().call(c -> {
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT MIN(due_at) FROM maia_reports"
                    + " WHERE state = 'waiting'")) {
                long v = r.next() ? r.getLong(1) : 0;
                return r.wasNull() ? null : v;
            }
        });
    }

    public int waiting(String urgency) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement(urgency == null
                    ? "SELECT COUNT(*) FROM maia_reports WHERE state = 'waiting'"
                    : "SELECT COUNT(*) FROM maia_reports WHERE state = 'waiting' AND urgency = ?")) {
                if (urgency != null) {
                    p.setString(1, urgency);
                }
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? r.getInt(1) : 0;
                }
            }
        });
    }

    /** Waiting {@code later} reports come due at once (several piled up). */
    public void bringForward(long now) throws SQLException {
        db().call(c -> {
            try (PreparedStatement u = c.prepareStatement("UPDATE maia_reports SET due_at = ? WHERE state = 'waiting'"
                    + " AND due_at > ?")) {
                u.setLong(1, now);
                u.setLong(2, now);
                return u.executeUpdate();
            }
        });
    }

    // ---------------------------------------------------------------- check-ins

    public String addCheckIn(long dueAt, long now) throws SQLException {
        String id = id("ci-");
        db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("INSERT INTO maia_checkins (id, due_at, state, created_at)"
                    + " VALUES (?, ?, 'waiting', ?)")) {
                p.setString(1, id);
                p.setLong(2, dueAt);
                p.setLong(3, now);
                return p.executeUpdate();
            }
        });
        return id;
    }

    public int checkInsWaiting() throws SQLException {
        return count("SELECT COUNT(*) FROM maia_checkins WHERE state = 'waiting' AND ? = ?", 0L);
    }

    public Long nextCheckIn() throws SQLException {
        return db().call(c -> {
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT MIN(due_at) FROM maia_checkins"
                    + " WHERE state = 'waiting'")) {
                long v = r.next() ? r.getLong(1) : 0;
                return r.wasNull() ? null : v;
            }
        });
    }

    /** The check-ins due now: fired (or {@code missed}, past a day late), each once. @return the ids fired */
    public List<String> fireDue(long now, long grace) throws SQLException {
        return db().transaction(c -> {
            List<String> fired = new ArrayList<>();
            List<String[]> due = new ArrayList<>();
            try (PreparedStatement p = c.prepareStatement("SELECT id, due_at FROM maia_checkins WHERE state ="
                    + " 'waiting' AND due_at <= ?")) {
                p.setLong(1, now);
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        due.add(new String[] {r.getString(1), String.valueOf(r.getLong(2))});
                    }
                }
            }
            for (String[] d : due) {
                boolean missed = now - Long.parseLong(d[1]) > grace;
                try (PreparedStatement u = c.prepareStatement("UPDATE maia_checkins SET state = ?, fired_at = ? WHERE"
                        + " id = ?")) {
                    u.setString(1, missed ? "missed" : "fired");
                    u.setLong(2, now);
                    u.setString(3, d[0]);
                    u.executeUpdate();
                }
                if (!missed) {
                    fired.add(d[0]);
                }
            }
            return fired;
        });
    }

    // ---------------------------------------------------------------- the log

    public record LogLine(long at, String kind, String deskId, String line) {}

    public void log(long at, String kind, String deskId, String line) throws SQLException {
        db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("INSERT INTO maia_away_log (at, kind, desk_id, line) VALUES"
                    + " (?, ?, ?, ?)")) {
                p.setLong(1, at);
                p.setString(2, kind);
                p.setString(3, deskId);
                p.setString(4, MaiaAgent.plain(line, 200));
                return p.executeUpdate();
            }
        });
    }

    /** How many of this kind since then. */
    public int countLog(String kind, long since) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT COUNT(*) FROM maia_away_log WHERE kind = ? AND at > ?")) {
                p.setString(1, kind);
                p.setLong(2, since);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? r.getInt(1) : 0;
                }
            }
        });
    }

    /** When this kind last happened (the member last came back), or 0. */
    public long lastLog(String kind) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT MAX(at) FROM maia_away_log WHERE kind = ?")) {
                p.setString(1, kind);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? r.getLong(1) : 0L;
                }
            }
        });
    }

    public List<LogLine> logSince(long since) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT at, kind, desk_id, line FROM maia_away_log WHERE at"
                    + " > ? ORDER BY seq LIMIT 200")) {
                p.setLong(1, since);
                List<LogLine> out = new ArrayList<>();
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        out.add(new LogLine(r.getLong(1), r.getString(2), r.getString(3), r.getString(4)));
                    }
                }
                return out;
            }
        });
    }

    // ---------------------------------------------------------------- write-ups (any desk)

    public record WriteUp(String id, String envId, String agentId, String fromDeskId, String text, long at) {}

    public String saveWriteUp(String envId, String agentId, String fromDeskId, String text, long now)
            throws SQLException {
        String id = id("wu-");
        db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("INSERT INTO desk_writeups (id, env_id, agent_id,"
                    + " from_desk_id, text, at) VALUES (?, ?, ?, ?, ?, ?)")) {
                p.setString(1, id);
                p.setString(2, envId);
                p.setString(3, agentId);
                p.setString(4, fromDeskId);
                p.setString(5, text);
                p.setLong(6, now);
                return p.executeUpdate();
            }
        });
        return id;
    }

    public void markWriteUp(String id, boolean isPrivate) throws SQLException {
        db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("UPDATE desk_writeups SET readable = ? WHERE id = ?")) {
                p.setInt(1, isPrivate ? 0 : 1);
                p.setString(2, id);
                return p.executeUpdate();
            }
        });
    }

    public boolean writeUpReadable(String id) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT readable FROM desk_writeups WHERE id = ?")) {
                p.setString(1, id);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() && r.getInt(1) == 1;
                }
            }
        });
    }

    public WriteUp writeUp(String id) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT id, env_id, agent_id, from_desk_id, text, at FROM"
                    + " desk_writeups WHERE id = ?")) {
                p.setString(1, id);
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? new WriteUp(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                            r.getString(5), r.getLong(6)) : null;
                }
            }
        });
    }

    /** A write-up kept here, with whether its answer went back without this desk's private data (Documents' index). */
    public record Kept(WriteUp writeUp, boolean readable) {}

    /**
     * Documents' index (deskd API.md §25 "Intake"): write-ups kept after {@code (at, id)}, oldest first, at most
     * {@code limit}; each one's text cut to {@code maxChars}.
     */
    public List<Kept> writeUpsAfter(long at, String id, int limit, int maxChars) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT id, env_id, agent_id, from_desk_id, substr(text, 1, ?), at,"
                    + " readable FROM desk_writeups WHERE at > ? OR (at = ? AND id > ?) ORDER BY at, id LIMIT ?")) {
                p.setInt(1, maxChars);
                p.setLong(2, at);
                p.setLong(3, at);
                p.setString(4, id == null ? "" : id);
                p.setInt(5, limit);
                List<Kept> out = new ArrayList<>();
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        out.add(new Kept(new WriteUp(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getLong(6)), r.getInt(7) == 1));
                    }
                }
                return out;
            }
        });
    }

    /** The ids of every write-up kept here (at most 90 days of them), or only those marked readable. */
    public List<String> writeUpIds(boolean readableOnly) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT id FROM desk_writeups" + (readableOnly ? " WHERE readable = 1" : "")
                    + " ORDER BY at LIMIT 20000")) {
                List<String> out = new ArrayList<>();
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        out.add(r.getString(1));
                    }
                }
                return out;
            }
        });
    }

    /** The newest write-ups for her briefs from {@code fromDeskId}, those holding every word of {@code query} first. */
    public List<WriteUp> searchWriteUps(String fromDeskId, String query, int limit) throws SQLException {
        List<WriteUp> recent = db().call(c -> {
            try (PreparedStatement p = c.prepareStatement("SELECT id, env_id, agent_id, from_desk_id, text, at FROM"
                    + " desk_writeups WHERE from_desk_id = ? ORDER BY at DESC LIMIT 50")) {
                p.setString(1, fromDeskId);
                List<WriteUp> out = new ArrayList<>();
                try (ResultSet r = p.executeQuery()) {
                    while (r.next()) {
                        out.add(new WriteUp(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getLong(6)));
                    }
                }
                return out;
            }
        });
        String[] words = query == null ? new String[0] : query.toLowerCase(Locale.ROOT).split("\\W+");
        List<WriteUp> hits = new ArrayList<>();
        for (WriteUp w : recent) {
            String t = w.text().toLowerCase(Locale.ROOT);
            boolean all = true;
            for (String word : words) {
                if (word.length() > 2 && !t.contains(word)) {
                    all = false;
                    break;
                }
            }
            if (all) {
                hits.add(w);
            }
        }
        return hits.subList(0, Math.min(limit, hits.size()));
    }

    // ---------------------------------------------------------------- upkeep

    /** Read reports a week on, old briefs, the log past 30 days, and write-ups past 90 days go. */
    public void prune(long now) throws SQLException {
        db().transaction(c -> {
            exec(c, "DELETE FROM maia_reports WHERE state = 'read' AND read_at < ?", now - KEEP_READ_MS);
            exec(c, "DELETE FROM maia_briefs WHERE sent_at < ?", now - 30L * 86_400_000);
            exec(c, "DELETE FROM maia_checkins WHERE state != 'waiting' AND created_at < ?", now - KEEP_READ_MS);
            exec(c, "DELETE FROM maia_away_log WHERE at < ?", now - 30L * 86_400_000);
            exec(c, "DELETE FROM desk_writeups WHERE at < ?", now - WRITEUP_DAYS * 86_400_000);
            return null;
        });
    }

    /** "Delete Maia Mode history": her side of it (write-ups are the answering agents', on their desks, and stay). */
    public void forget() throws SQLException {
        db().transaction(c -> {
            for (String t : List.of("maia_briefs", "maia_reports", "maia_checkins", "maia_away_log")) {
                try (Statement s = c.createStatement()) {
                    s.execute("DELETE FROM " + t);
                }
            }
            return null;
        });
    }

    private static void exec(Connection c, String sql, long v) throws SQLException {
        try (PreparedStatement p = c.prepareStatement(sql)) {
            p.setLong(1, v);
            p.executeUpdate();
        }
    }

    private int count(String sql, long v) throws SQLException {
        return db().call(c -> {
            try (PreparedStatement p = c.prepareStatement(sql)) {
                p.setLong(1, v);
                if (sql.contains("? = ?")) {
                    p.setLong(2, v);
                }
                try (ResultSet r = p.executeQuery()) {
                    return r.next() ? r.getInt(1) : 0;
                }
            }
        });
    }

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }
}
