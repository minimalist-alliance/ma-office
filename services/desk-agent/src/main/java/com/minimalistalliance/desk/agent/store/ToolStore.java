package com.minimalistalliance.desk.agent.store;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * The tools' rows ({@link ToolSchema}): workspace files marked untrusted, and replies' plans. No content but a plan's
 * own words, which the member's thread shows.
 */
public final class ToolStore {

    private final AgentStore store;

    public ToolStore(AgentStore store) {
        this.store = store;
    }

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    /**
     * What a write did to a workspace file's mark: a write from a run holding {@code U} marks it; a whole new file from a
     * run without {@code U} clears it; an append from such a run keeps it as it was.
     */
    public void wrote(String agentId, String path, boolean untrusted, boolean append) throws SQLException {
        if (!untrusted && append) {
            return;
        }
        db().transaction(connection -> {
            String sql = untrusted ? "INSERT OR IGNORE INTO workspace_marks (agent_id, path) VALUES (?, ?)"
                    : "DELETE FROM workspace_marks WHERE agent_id = ? AND path = ?";
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                statement.setString(1, agentId);
                statement.setString(2, path);
                statement.executeUpdate();
            }
            return null;
        });
    }

    /** Whether the file was written by a run holding {@code U}. */
    public boolean marked(String agentId, String path) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT 1 FROM workspace_marks WHERE agent_id = ? AND path = ?")) {
                select.setString(1, agentId);
                select.setString(2, path);
                try (ResultSet r = select.executeQuery()) {
                    return r.next();
                }
            }
        });
    }

    /** A file or folder was deleted: its marks, and those of all inside it, go. */
    public void removed(String agentId, String path) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement("DELETE FROM workspace_marks WHERE agent_id = ?"
                    + " AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")) {
                delete.setString(1, agentId);
                delete.setString(2, path);
                delete.setString(3, path);
                delete.setString(4, path);
                delete.executeUpdate();
            }
            return null;
        });
    }

    /** A reply's plan, replacing the last. */
    public void putPlan(String messageId, String agentId, String planJson) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO run_plans (message_id, agent_id,"
                    + " plan) VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET plan = excluded.plan")) {
                upsert.setString(1, messageId);
                upsert.setString(2, agentId);
                upsert.setString(3, planJson);
                upsert.executeUpdate();
            }
            return null;
        });
    }

    /** A reply's plan as JSON, or null. */
    public String plan(String messageId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT plan FROM run_plans WHERE message_id = ?")) {
                select.setString(1, messageId);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? r.getString(1) : null;
                }
            }
        });
    }

    /** Whether any reply has a plan, so a thread with none reads nothing. */
    public boolean anyPlans() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT 1 FROM run_plans LIMIT 1");
                    ResultSet r = select.executeQuery()) {
                return r.next();
            }
        });
    }
}
