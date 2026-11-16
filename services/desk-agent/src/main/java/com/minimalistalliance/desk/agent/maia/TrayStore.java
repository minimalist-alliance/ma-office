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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The decision tray's rows in {@code agent.db} (deskd {@code API.md} §23 "The tray"), additive tables made at first
 * use, as every Maia table, so a rollback still opens the file.
 *
 * <ul>
 *   <li>{@code maia_tray_papers}: each paper's state by its id: the source key's kind and desk, the state, Later's time
 *       and count, the answer's id and its label (code's words or hers), when and on which device, and her line and
 *       answers from {@code paper_note}. <b>Never</b> free-form text, a message's subject or a document's text.</li>
 *   <li>{@code maia_tray_out}: answers waiting for a desk that's asleep, in order per asker: ids and the answer, plus
 *       the member's own words <b>only until sent</b>, then wiped. One older than its source's own expiry is dropped.</li>
 * </ul>
 * Kept in memory too (the room rebuilds often); the file is the record across restarts. Without a store (tests), memory
 * only.
 */
public final class TrayStore {

    private static final Logger log = LoggerFactory.getLogger(TrayStore.class);
    /** Answered or withdrawn papers are kept this long, for "Answered in Writer" and two devices; then they go. */
    static final long KEEP_MS = 30L * 24 * 3_600_000L;
    /** Her line and answers for a paper last this long. */
    static final long NOTE_MS = 7L * 24 * 3_600_000L;

    /**
     * An answer waiting to go to a desk. {@code text}: the member's words, null once sent. {@code reply}: the asking
     * thing's own ids as the paper had them when answered (the office carries from these, never a rebuilt paper);
     * {@code sha256}: an approval's payload hash the member approved (Security's TRAY-M1, TRAY-I1).
     */
    public record Out(String outId, String paperId, String deskId, String replyKind, String answerId, String does,
            String value, String text, long at, Long expiresAt, String state, Map<String, Object> reply,
            String sha256) {

        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("outId", outId);
            v.put("paperId", paperId);
            v.put("deskId", deskId);
            v.put("replyKind", replyKind);
            v.put("answerId", answerId);
            v.put("does", does);
            if (value != null) {
                v.put("value", value);
            }
            v.put("reply", reply == null ? Map.of() : reply);
            if (sha256 != null) {
                v.put("sha256", sha256);
            }
            if (text != null) {
                v.put("text", text);
            }
            v.put("at", at);
            v.put("expiresAt", expiresAt);
            v.put("state", state);
            return v;
        }
    }

    private final AgentStore agents;
    private volatile boolean ready;
    private final Map<String, Tray.State> states = new LinkedHashMap<>();
    private final Map<String, Tray.Note> notes = new LinkedHashMap<>();
    private final Map<String, Out> out = new LinkedHashMap<>();
    private boolean loaded;

    public TrayStore(AgentStore agents) {
        this.agents = agents;
    }

    /** Memory only, for tests. */
    public static TrayStore memory() {
        return new TrayStore(null);
    }

    static void apply(Connection connection) throws SQLException {
        try (Statement s = connection.createStatement()) {
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_tray_papers (
                      paper_id TEXT PRIMARY KEY,
                      source_key TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      desk_id TEXT,
                      state TEXT NOT NULL,
                      later_until INTEGER NOT NULL DEFAULT 0,
                      later_count INTEGER NOT NULL DEFAULT 0,
                      answer_id TEXT,
                      answer_label TEXT,
                      answered_at INTEGER NOT NULL DEFAULT 0,
                      device TEXT,
                      first_shown_at INTEGER NOT NULL DEFAULT 0,
                      note TEXT,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL
                    ) STRICT""");
            s.execute("""
                    CREATE TABLE IF NOT EXISTS maia_tray_out (
                      out_id TEXT PRIMARY KEY,
                      paper_id TEXT NOT NULL,
                      desk_id TEXT NOT NULL,
                      reply_kind TEXT NOT NULL,
                      answer_id TEXT NOT NULL,
                      does TEXT NOT NULL,
                      value TEXT,
                      text TEXT,
                      at INTEGER NOT NULL,
                      expires_at INTEGER,
                      state TEXT NOT NULL,
                      reply TEXT,
                      sha256 TEXT
                    ) STRICT""");
            // A table made by an earlier build of this branch (dev desks only) gains the two columns.
            for (String column : List.of("reply", "sha256")) {
                boolean has = false;
                try (ResultSet r = s.executeQuery("PRAGMA table_info(maia_tray_out)")) {
                    while (r.next()) {
                        has |= column.equals(r.getString("name"));
                    }
                }
                if (!has) {
                    s.execute("ALTER TABLE maia_tray_out ADD COLUMN " + column + " TEXT");
                }
            }
        }
    }

    private SqliteDatabase db() throws SQLException {
        if (agents == null) {
            return null;
        }
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

    private void load() {
        if (loaded) {
            return;
        }
        loaded = true;
        try {
            SqliteDatabase db = db();
            if (db == null) {
                return;
            }
            db.call(connection -> {
                try (PreparedStatement q = connection.prepareStatement("SELECT paper_id, source_key, kind, desk_id,"
                        + " state, later_until, later_count, answer_id, answer_label, answered_at, device,"
                        + " first_shown_at, note, created_at FROM maia_tray_papers");
                        ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        String id = r.getString(1);
                        states.put(id, new Tray.State(id, r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getLong(6), r.getInt(7), r.getString(8), r.getString(9),
                                r.getLong(10), r.getString(11), r.getLong(12), r.getLong(14)));
                        Tray.Note n = noteOf(r.getString(13));
                        if (n != null) {
                            notes.put(id, n);
                        }
                    }
                }
                try (PreparedStatement q = connection.prepareStatement("SELECT out_id, paper_id, desk_id, reply_kind,"
                        + " answer_id, does, value, text, at, expires_at, state, reply, sha256 FROM maia_tray_out ORDER BY"
                        + " at");
                        ResultSet r = q.executeQuery()) {
                    while (r.next()) {
                        long exp = r.getLong(10);
                        Long expires = r.wasNull() ? null : exp;
                        out.put(r.getString(1), new Out(r.getString(1), r.getString(2), r.getString(3),
                                r.getString(4), r.getString(5), r.getString(6), r.getString(7), r.getString(8),
                                r.getLong(9), expires, r.getString(11), replyOf(r.getString(12)), r.getString(13)));
                    }
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("the tray wasn't read: {}", e.getClass().getSimpleName());
        }
    }

    /** A queued answer's reply ids: strings only. */
    private static Map<String, Object> replyOf(String json) {
        if (json == null) {
            return Map.of();
        }
        try {
            Map<String, Object> m = Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
            Map<String, Object> v = new LinkedHashMap<>();
            m.forEach((k, x) -> {
                if (x instanceof String str) {
                    v.put(k, str);
                }
            });
            return v;
        } catch (Exception e) {
            return Map.of();
        }
    }

    private static Tray.Note noteOf(String json) {
        if (json == null) {
            return null;
        }
        try {
            Map<String, Object> m = Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
            List<String> answers = new ArrayList<>();
            if (m.get("answers") instanceof List<?> l) {
                for (Object o : l) {
                    if (o instanceof String s) {
                        answers.add(s);
                    }
                }
            }
            return new Tray.Note(m.get("line") instanceof String s ? s : "", answers,
                    m.get("pick") instanceof Number n ? n.intValue() : 0, m.get("at") instanceof Number a
                    ? a.longValue() : 0);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- papers

    public synchronized Map<String, Tray.State> states() {
        load();
        return new LinkedHashMap<>(states);
    }

    public synchronized Map<String, Tray.Note> notes(long now) {
        load();
        notes.values().removeIf(n -> now - n.at() > NOTE_MS);
        return new LinkedHashMap<>(notes);
    }

    public synchronized Tray.State state(String paperId) {
        load();
        return states.get(paperId);
    }

    public synchronized void put(Tray.State s, long now) {
        load();
        states.put(s.paperId(), s);
        write(s, notes.get(s.paperId()), now);
    }

    /** Her line and answers for a paper, from {@code paper_note}. */
    public synchronized void note(Tray.State s, Tray.Note n, long now) {
        load();
        notes.put(s.paperId(), n);
        states.putIfAbsent(s.paperId(), s);
        write(states.get(s.paperId()), n, now);
    }

    private void write(Tray.State s, Tray.Note n, long now) {
        try {
            SqliteDatabase db = db();
            if (db == null) {
                return;
            }
            String note = null;
            if (n != null) {
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("line", n.line());
                v.put("answers", n.answers());
                v.put("pick", n.pick());
                v.put("at", n.at());
                note = new String(Json.bytes(v), StandardCharsets.UTF_8);
            }
            String noteJson = note;
            db.transaction(connection -> {
                try (PreparedStatement u = connection.prepareStatement("INSERT INTO maia_tray_papers (paper_id,"
                        + " source_key, kind, desk_id, state, later_until, later_count, answer_id, answer_label,"
                        + " answered_at, device, first_shown_at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?,"
                        + " ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET state = excluded.state,"
                        + " later_until = excluded.later_until, later_count = excluded.later_count, answer_id ="
                        + " excluded.answer_id, answer_label = excluded.answer_label, answered_at ="
                        + " excluded.answered_at, device = excluded.device, first_shown_at = excluded.first_shown_at,"
                        + " note = excluded.note, updated_at = excluded.updated_at")) {
                    u.setString(1, s.paperId());
                    u.setString(2, s.key().length() > 300 ? s.key().substring(0, 300) : s.key());
                    u.setString(3, s.kind());
                    u.setString(4, s.deskId());
                    u.setString(5, s.state());
                    u.setLong(6, s.laterUntil());
                    u.setInt(7, s.laterCount());
                    u.setString(8, s.answerId());
                    u.setString(9, s.answerLabel());
                    u.setLong(10, s.answeredAt());
                    u.setString(11, s.device());
                    u.setLong(12, s.firstShownAt());
                    u.setString(13, noteJson);
                    u.setLong(14, s.createdAt());
                    u.setLong(15, now);
                    u.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("a paper wasn't kept: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- answers waiting for a desk

    public synchronized List<Out> out() {
        load();
        return new ArrayList<>(out.values());
    }

    public synchronized void queue(Out o) {
        load();
        out.put(o.outId(), o);
        try {
            SqliteDatabase db = db();
            if (db == null) {
                return;
            }
            db.transaction(connection -> {
                try (PreparedStatement u = connection.prepareStatement("INSERT OR REPLACE INTO maia_tray_out (out_id,"
                        + " paper_id, desk_id, reply_kind, answer_id, does, value, text, at, expires_at, state, reply,"
                        + " sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                    u.setString(1, o.outId());
                    u.setString(2, o.paperId());
                    u.setString(3, o.deskId());
                    u.setString(4, o.replyKind());
                    u.setString(5, o.answerId());
                    u.setString(6, o.does());
                    u.setString(7, o.value());
                    u.setString(8, o.text());
                    u.setLong(9, o.at());
                    if (o.expiresAt() == null) {
                        u.setNull(10, java.sql.Types.INTEGER);
                    } else {
                        u.setLong(10, o.expiresAt());
                    }
                    u.setString(11, o.state());
                    u.setString(12, o.reply() == null ? null
                            : new String(Json.bytes(o.reply()), StandardCharsets.UTF_8));
                    u.setString(13, o.sha256());
                    u.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("an answer wasn't queued: {}", e.getClass().getSimpleName());
        }
    }

    /** An answer went: its row goes, and the member's words with it. */
    public synchronized void sent(String outId) {
        load();
        out.remove(outId);
        delete("DELETE FROM maia_tray_out WHERE out_id = ?", outId);
    }

    /** Every waiting answer of this paper (it was answered elsewhere, or expired). */
    public synchronized void dropFor(String paperId) {
        load();
        out.values().removeIf(o -> o.paperId().equals(paperId));
        delete("DELETE FROM maia_tray_out WHERE paper_id = ?", paperId);
    }

    private void delete(String sql, String id) {
        try {
            SqliteDatabase db = db();
            if (db == null) {
                return;
            }
            db.transaction(connection -> {
                try (PreparedStatement d = connection.prepareStatement(sql)) {
                    d.setString(1, id);
                    d.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("a tray row wasn't removed: {}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- upkeep

    /**
     * Answered, withdrawn and expired papers past 30 days go; her notes past 7, on disk too; a report's paper still
     * open after 7 days goes with its source (the report it came from is gone by then) (Security's TRAY-L2).
     */
    public synchronized void prune(long now) {
        load();
        states.values().removeIf(s -> !s.open() && now - Math.max(s.answeredAt(), s.createdAt()) > KEEP_MS);
        states.values().removeIf(s -> s.open() && "report".equals(s.kind()) && now - s.createdAt() > NOTE_MS);
        notes.values().removeIf(n -> now - n.at() > NOTE_MS);
        notes.keySet().removeIf(id -> !states.containsKey(id));
        try {
            SqliteDatabase db = db();
            if (db == null) {
                return;
            }
            db.transaction(connection -> {
                try (PreparedStatement d = connection.prepareStatement(
                        "DELETE FROM maia_tray_papers WHERE state <> 'open' AND updated_at < ?")) {
                    d.setLong(1, now - KEEP_MS);
                    d.executeUpdate();
                }
                try (PreparedStatement d = connection.prepareStatement(
                        "DELETE FROM maia_tray_papers WHERE state = 'open' AND kind = 'report' AND created_at < ?")) {
                    d.setLong(1, now - NOTE_MS);
                    d.executeUpdate();
                }
                try (PreparedStatement d = connection.prepareStatement(
                        "UPDATE maia_tray_papers SET note = NULL WHERE note IS NOT NULL AND updated_at < ?")) {
                    d.setLong(1, now - NOTE_MS);
                    d.executeUpdate();
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("the tray wasn't pruned: {}", e.getClass().getSimpleName());
        }
    }

    /** "Delete Maia Mode history": every paper's state, her notes and every waiting answer. */
    public synchronized void forget() {
        load();
        states.clear();
        notes.clear();
        out.clear();
        try {
            SqliteDatabase db = db();
            if (db == null) {
                return;
            }
            db.transaction(connection -> {
                try (Statement s = connection.createStatement()) {
                    s.execute("DELETE FROM maia_tray_papers");
                    s.execute("DELETE FROM maia_tray_out");
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("the tray wasn't cleared: {}", e.getClass().getSimpleName());
        }
    }
}
