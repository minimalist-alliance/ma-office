package com.minimalistalliance.desk.agent.approval;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code approvals} and {@code run_marks} rows in {@code agent.db} ({@code store.ApprovalSchema}). Every state
 * change names the state it leaves, so two writers can never both move one approval: the one whose update changed a row
 * did it.
 */
public final class ApprovalStore {

    /** One approval as stored. JSON columns stay text here. */
    record Row(String id, String agentId, String runId, String messageId, String tool, String risk, String title,
            String context, String target, String payload, String before, String sha256, boolean untrusted,
            String origin, String state, String detail, long createdAt, long expiresAt, Long decidedAt,
            String decidedBy, String note, Long startedAt, String result) {

        /** No content in logs. */
        @Override
        public String toString() {
            return "Approval[" + id + ", " + tool + ", " + risk + ", " + state + "]";
        }
    }

    /** A reply's run marks. */
    public record Marks(boolean untrusted, boolean privateData, int egress) {
        static final Marks NONE = new Marks(false, false, 0);
    }

    private static final String COLUMNS = "id, agent_id, run_id, message_id, tool, risk, title, context, target,"
            + " payload, before_json, sha256, untrusted, origin, state, detail, created_at, expires_at, decided_at,"
            + " decided_by, note, started_at, result";

    private final AgentStore store;

    ApprovalStore(AgentStore store) {
        this.store = store;
    }

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    void insert(List<Row> rows) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO approvals (" + COLUMNS
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                for (Row row : rows) {
                    insert.setString(1, row.id());
                    insert.setString(2, row.agentId());
                    insert.setString(3, row.runId());
                    insert.setString(4, row.messageId());
                    insert.setString(5, row.tool());
                    insert.setString(6, row.risk());
                    insert.setString(7, row.title());
                    insert.setString(8, row.context());
                    insert.setString(9, row.target());
                    insert.setString(10, row.payload());
                    insert.setString(11, row.before());
                    insert.setString(12, row.sha256());
                    insert.setInt(13, row.untrusted() ? 1 : 0);
                    insert.setString(14, row.origin());
                    insert.setString(15, row.state());
                    insert.setString(16, row.detail());
                    insert.setLong(17, row.createdAt());
                    insert.setLong(18, row.expiresAt());
                    setLong(insert, 19, row.decidedAt());
                    insert.setString(20, row.decidedBy());
                    insert.setString(21, row.note());
                    setLong(insert, 22, row.startedAt());
                    insert.setString(23, row.result());
                    insert.addBatch();
                }
                insert.executeBatch();
            }
            return null;
        });
    }

    Row get(String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT " + COLUMNS + " FROM approvals WHERE id = ?")) {
                select.setString(1, id);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? row(r) : null;
                }
            }
        });
    }

    /** Pending to decided: {@code approved} or {@code declined}. @return whether this call moved it */
    boolean decide(String id, String state, long at, String by, String note) throws SQLException {
        return update("UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?"
                + " AND state = 'pending'", s -> {
                    s.setString(1, state);
                    s.setLong(2, at);
                    s.setString(3, by);
                    s.setString(4, note);
                    s.setString(5, id);
                });
    }

    /** Pending, or approved and never started, to {@code expired} with a detail. @return whether it moved */
    boolean expire(String id, String detail, long at) throws SQLException {
        return update("UPDATE approvals SET state = 'expired', detail = ?, decided_at = COALESCE(decided_at, ?)"
                + " WHERE id = ? AND (state = 'pending' OR (state = 'approved' AND started_at IS NULL))", s -> {
                    s.setString(1, detail);
                    s.setLong(2, at);
                    s.setString(3, id);
                });
    }

    /** An approved call's tool is starting. */
    boolean started(String id, long at) throws SQLException {
        return update("UPDATE approvals SET started_at = ? WHERE id = ? AND state = 'approved' AND started_at IS NULL",
                s -> {
                    s.setLong(1, at);
                    s.setString(2, id);
                });
    }

    /** Approved to {@code done}, {@code failed} or {@code interrupted}, with the result's JSON. */
    boolean settle(String id, String state, String result) throws SQLException {
        return update("UPDATE approvals SET state = ?, result = ? WHERE id = ? AND state = 'approved'", s -> {
            s.setString(1, state);
            s.setString(2, result);
            s.setString(3, id);
        });
    }

    /**
     * At open, with no run going: every {@code pending} approval, and every {@code approved} one whose tool never
     * started, becomes {@code expired} with {@code detail: "restart"}; an approved one whose tool had started becomes
     * {@code interrupted}. Nothing re-runs. @return the rows as they were, for the audit
     */
    List<Row> sweepAtOpen(long at) throws SQLException {
        return db().transaction(connection -> {
            List<Row> rows = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT " + COLUMNS + " FROM approvals WHERE state IN ('pending', 'approved')");
                    ResultSet r = select.executeQuery()) {
                while (r.next()) {
                    rows.add(row(r));
                }
            }
            try (PreparedStatement expire = connection.prepareStatement("UPDATE approvals SET state = 'expired',"
                    + " detail = 'restart', decided_at = COALESCE(decided_at, ?) WHERE state = 'pending'"
                    + " OR (state = 'approved' AND started_at IS NULL)");
                    PreparedStatement interrupt = connection.prepareStatement("UPDATE approvals SET state ="
                            + " 'interrupted' WHERE state = 'approved' AND started_at IS NOT NULL")) {
                expire.setLong(1, at);
                expire.executeUpdate();
                interrupt.executeUpdate();
            }
            return rows;
        });
    }

    /** The approvals of these replies, oldest first, by message id. */
    Map<String, List<Row>> forMessages(Collection<String> messageIds) throws SQLException {
        Map<String, List<Row>> out = new HashMap<>();
        if (messageIds.isEmpty()) {
            return out;
        }
        List<String> ids = List.copyOf(messageIds);
        return db().call(connection -> {
            for (int from = 0; from < ids.size(); from += 200) {
                List<String> part = ids.subList(from, Math.min(ids.size(), from + 200));
                try (PreparedStatement select = connection.prepareStatement("SELECT " + COLUMNS
                        + " FROM approvals WHERE message_id IN (" + placeholders(part.size())
                        + ") ORDER BY created_at, id")) {
                    for (int i = 0; i < part.size(); i++) {
                        select.setString(i + 1, part.get(i));
                    }
                    try (ResultSet r = select.executeQuery()) {
                        while (r.next()) {
                            Row row = row(r);
                            out.computeIfAbsent(row.messageId(), k -> new ArrayList<>()).add(row);
                        }
                    }
                }
            }
            return out;
        });
    }

    /**
     * Newest first, older than {@code before} when given, of one agent or of all, only {@code pending} ones not yet
     * past their time when {@code pendingOnly}.
     */
    List<Row> newestFirst(String agentId, boolean pendingOnly, Row before, long now, int limit) throws SQLException {
        StringBuilder sql = new StringBuilder("SELECT ").append(COLUMNS).append(" FROM approvals WHERE 1 = 1");
        List<Object> args = new ArrayList<>();
        if (agentId != null) {
            sql.append(" AND agent_id = ?");
            args.add(agentId);
        }
        if (pendingOnly) {
            sql.append(" AND state = 'pending' AND expires_at > ?");
            args.add(now);
        }
        if (before != null) {
            sql.append(" AND (created_at < ? OR (created_at = ? AND id < ?))");
            args.add(before.createdAt());
            args.add(before.createdAt());
            args.add(before.id());
        }
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT ?");
        args.add(limit);
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(sql.toString())) {
                bind(select, args);
                List<Row> rows = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        rows.add(row(r));
                    }
                }
                return rows;
            }
        });
    }

    void putMarks(String messageId, String agentId, String runId, Marks marks) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO run_marks (message_id, agent_id,"
                    + " run_id, untrusted, private, egress) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (message_id) DO"
                    + " UPDATE SET untrusted = MAX(untrusted, excluded.untrusted), private = MAX(private,"
                    + " excluded.private), egress = MAX(egress, excluded.egress)")) {
                upsert.setString(1, messageId);
                upsert.setString(2, agentId);
                upsert.setString(3, runId);
                upsert.setInt(4, marks.untrusted() ? 1 : 0);
                upsert.setInt(5, marks.privateData() ? 1 : 0);
                upsert.setInt(6, marks.egress());
                upsert.executeUpdate();
            }
            return null;
        });
    }

    /** Whether any reply has marks. */
    boolean anyMarks() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT 1 FROM run_marks LIMIT 1");
                    ResultSet r = select.executeQuery()) {
                return r.next();
            }
        });
    }

    /** The marks of these replies; a reply with none isn't in the map. */
    Map<String, Marks> marks(Collection<String> messageIds) throws SQLException {
        Map<String, Marks> out = new HashMap<>();
        if (messageIds.isEmpty()) {
            return out;
        }
        List<String> ids = List.copyOf(messageIds);
        return db().call(connection -> {
            for (int from = 0; from < ids.size(); from += 200) {
                List<String> part = ids.subList(from, Math.min(ids.size(), from + 200));
                try (PreparedStatement select = connection.prepareStatement("SELECT message_id, untrusted, private,"
                        + " egress FROM run_marks WHERE message_id IN (" + placeholders(part.size()) + ")")) {
                    for (int i = 0; i < part.size(); i++) {
                        select.setString(i + 1, part.get(i));
                    }
                    try (ResultSet r = select.executeQuery()) {
                        while (r.next()) {
                            out.put(r.getString(1), new Marks(r.getInt(2) != 0, r.getInt(3) != 0, r.getInt(4)));
                        }
                    }
                }
            }
            return out;
        });
    }

    @FunctionalInterface
    private interface Binder {
        void bind(PreparedStatement statement) throws SQLException;
    }

    private boolean update(String sql, Binder binder) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(sql)) {
                binder.bind(update);
                return update.executeUpdate() == 1;
            }
        });
    }

    private static String placeholders(int n) {
        return String.join(", ", java.util.Collections.nCopies(n, "?"));
    }

    private static void bind(PreparedStatement statement, List<Object> args) throws SQLException {
        for (int i = 0; i < args.size(); i++) {
            Object arg = args.get(i);
            if (arg instanceof Long l) {
                statement.setLong(i + 1, l);
            } else if (arg instanceof Integer n) {
                statement.setInt(i + 1, n);
            } else {
                statement.setString(i + 1, (String) arg);
            }
        }
    }

    private static void setLong(PreparedStatement statement, int index, Long value) throws SQLException {
        if (value == null) {
            statement.setNull(index, Types.INTEGER);
        } else {
            statement.setLong(index, value);
        }
    }

    private static Long longOrNull(ResultSet r, String column) throws SQLException {
        long value = r.getLong(column);
        return r.wasNull() ? null : value;
    }

    private static Row row(ResultSet r) throws SQLException {
        return new Row(r.getString("id"), r.getString("agent_id"), r.getString("run_id"), r.getString("message_id"),
                r.getString("tool"), r.getString("risk"), r.getString("title"), r.getString("context"),
                r.getString("target"), r.getString("payload"), r.getString("before_json"), r.getString("sha256"),
                r.getInt("untrusted") != 0, r.getString("origin"), r.getString("state"), r.getString("detail"),
                r.getLong("created_at"), r.getLong("expires_at"), longOrNull(r, "decided_at"),
                r.getString("decided_by"), r.getString("note"), longOrNull(r, "started_at"), r.getString("result"));
    }
}
