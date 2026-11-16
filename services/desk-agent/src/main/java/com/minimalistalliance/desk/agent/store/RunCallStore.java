package com.minimalistalliance.desk.agent.store;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Tool calls' records ({@link RunSchema}'s {@code run_calls}): ids, names, classes and states only, never an argument
 * or a result.
 */
public final class RunCallStore {

    /** One call's record. */
    public record Call(String key, String runId, String agentId, String messageId, int step, String callId,
            String tool, String risk, String host, String restart, String approvalId, String auto, String state,
            String detail, long startedAt, Long settledAt) {
        public Call {
            Objects.requireNonNull(key, "key");
            Objects.requireNonNull(runId, "runId");
            Objects.requireNonNull(agentId, "agentId");
            Objects.requireNonNull(messageId, "messageId");
            Objects.requireNonNull(callId, "callId");
            Objects.requireNonNull(tool, "tool");
            Objects.requireNonNull(risk, "risk");
            Objects.requireNonNull(host, "host");
            Objects.requireNonNull(restart, "restart");
            Objects.requireNonNull(state, "state");
        }
    }

    private static final String COLUMNS = "key, run_id, agent_id, message_id, step, call_id, tool, risk, host, restart,"
            + " approval_id, auto, state, detail, started_at, settled_at";

    private final AgentStore store;

    public RunCallStore(AgentStore store) {
        this.store = store;
    }

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    /** A call that is about to be sent: its row, {@code started}. */
    public void started(Call call) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO run_calls (" + COLUMNS
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, call.key());
                insert.setString(2, call.runId());
                insert.setString(3, call.agentId());
                insert.setString(4, call.messageId());
                insert.setInt(5, call.step());
                insert.setString(6, call.callId());
                insert.setString(7, call.tool());
                insert.setString(8, call.risk());
                insert.setString(9, call.host());
                insert.setString(10, call.restart());
                insert.setString(11, call.approvalId());
                insert.setString(12, call.auto());
                insert.setString(13, call.state());
                insert.setString(14, call.detail());
                insert.setLong(15, call.startedAt());
                if (call.settledAt() == null) {
                    insert.setNull(16, Types.INTEGER);
                } else {
                    insert.setLong(16, call.settledAt());
                }
                insert.executeUpdate();
            }
            return null;
        });
    }

    /** A started call to {@code done}, {@code failed} or {@code interrupted}. @return whether this moved it */
    public boolean settle(String key, String state, String detail, long at) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE run_calls SET state = ?, detail = ?,"
                    + " settled_at = ? WHERE key = ? AND state = 'started'")) {
                update.setString(1, state);
                update.setString(2, detail);
                update.setLong(3, at);
                update.setString(4, key);
                return update.executeUpdate() == 1;
            }
        });
    }

    /** The record, or null. */
    public Call get(String key) throws SQLException {
        List<Call> rows = select("SELECT " + COLUMNS + " FROM run_calls WHERE key = ?", key);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** A run's records, in the order they started. */
    public List<Call> ofRun(String runId) throws SQLException {
        return select("SELECT " + COLUMNS + " FROM run_calls WHERE run_id = ? ORDER BY started_at, step, rowid", runId);
    }

    /** A run's calls still {@code started}. */
    public List<Call> startedOf(String runId) throws SQLException {
        return select("SELECT " + COLUMNS + " FROM run_calls WHERE run_id = ? AND state = 'started'"
                + " ORDER BY started_at, rowid", runId);
    }

    /** Every call still {@code started}: at open, what a kill left in flight. */
    public List<Call> started() throws SQLException {
        return select("SELECT " + COLUMNS + " FROM run_calls WHERE state = 'started' ORDER BY started_at, rowid");
    }

    /**
     * Calls that came back ({@code done} or {@code failed}) whose approval is still {@code approved}: the process ended
     * between the call's record and its approval's. At open, the approval settles from the record, not as interrupted.
     */
    public List<Call> settledWithApprovalOpen() throws SQLException {
        return select("SELECT " + prefixed("c") + " FROM run_calls c JOIN approvals a ON a.id = c.approval_id"
                + " WHERE a.state = 'approved' AND c.state IN ('done', 'failed') ORDER BY c.started_at, c.rowid");
    }

    /** Records that settled before {@code before}: they go. @return how many */
    public int prune(long before) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM run_calls WHERE settled_at IS NOT NULL AND settled_at < ?")) {
                delete.setLong(1, before);
                return delete.executeUpdate();
            }
        });
    }

    private static String prefixed(String alias) {
        StringBuilder out = new StringBuilder();
        for (String column : COLUMNS.split(", ")) {
            if (!out.isEmpty()) {
                out.append(", ");
            }
            out.append(alias).append('.').append(column);
        }
        return out.toString();
    }

    private List<Call> select(String sql, String... args) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(sql)) {
                for (int i = 0; i < args.length; i++) {
                    select.setString(i + 1, args[i]);
                }
                List<Call> rows = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        long settled = r.getLong(16);
                        Long settledAt = r.wasNull() ? null : settled;
                        rows.add(new Call(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getInt(5),
                                r.getString(6), r.getString(7), r.getString(8), r.getString(9), r.getString(10),
                                r.getString(11), r.getString(12), r.getString(13), r.getString(14), r.getLong(15),
                                settledAt));
                    }
                }
                return rows;
            }
        });
    }
}
