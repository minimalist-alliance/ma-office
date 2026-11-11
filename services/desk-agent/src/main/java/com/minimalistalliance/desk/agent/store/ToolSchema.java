package com.minimalistalliance.desk.agent.store;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * The tools' rows in {@code agent.db} (draft ADR "the Agent's tools and approvals", sections 2 and 6): additive, applied
 * at every open and idempotent, as {@link TeamSchema} and {@link ApprovalSchema} are, so {@code user_version} stays 1.
 *
 * <ul>
 *   <li>{@code workspace_marks}: a workspace file a run holding {@code U} wrote (Security's finding 3 on the protocol):
 *       a later run that reads it holds {@code U}, as a memory line saved under {@code U} carries its mark
 *       ({@code memories.untrusted}). By agent and the path as the workspace takes it; it goes with the file.
 *   <li>{@code run_plans}: a reply's checklist from {@code plan_update}, by its message, as JSON. It goes with the
 *       thread.
 * </ul>
 */
final class ToolSchema {

    private ToolSchema() {}

    static void apply(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS workspace_marks (
                      agent_id TEXT NOT NULL,
                      path TEXT NOT NULL,
                      PRIMARY KEY (agent_id, path)
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS run_plans (
                      message_id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      plan TEXT NOT NULL
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS run_plans_agent ON run_plans (agent_id)");
        }
    }
}
