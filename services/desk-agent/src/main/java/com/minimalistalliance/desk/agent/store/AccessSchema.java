package com.minimalistalliance.desk.agent.store;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Each agent's access in {@code agent.db} (draft ADR "the Agent's tools and approvals", section 16): what the member
 * chose on the agent's setup screen, and the send halves of its grants to the member's other desks (section 14).
 * Additive, applied at every open and idempotent, as {@link TeamSchema} is, so {@code user_version} stays 1 and a
 * desk-agent from before still opens the file (it never reads these tables).
 *
 * <ul>
 *   <li>{@code agent_access}: one row per agent the member has set up, or per agent made before this existed.
 *       {@code body} is the canonical JSON of the choice, {@code chosen} included, and {@code sha256} the hash of
 *       {@code {v: 1, agentId, body}}: a row whose hash doesn't match is read as nothing chosen
 *       ({@code access.AccessBook}). {@code legacy} marks a row made by the upgrade below, with no body.
 *   <li>{@code desk_grants}: the send half of each grant, by its id: the target desk, its state ({@code offered},
 *       {@code active}, {@code revoked}) and how it's been used, with {@code sha256} over its id, agent, target and
 *       state.
 * </ul>
 *
 * <p><b>The upgrade.</b> The first open that makes {@code agent_access} gives every agent already in the file a
 * {@code legacy} row, with no body: such an agent isn't set up, so its next run waits for the member's setup screen,
 * which starts from what it could use until now (Notebook, Files and the Browser). An agent made later, by hand or by a
 * lead's proposal, has no row until the member saves its screen. A rolled-back desk-agent never writes here, so an
 * agent it made comes back with no row, as a new one.
 */
final class AccessSchema {

    private AccessSchema() {}

    static void apply(Connection connection) throws SQLException {
        boolean existed;
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_access'")) {
            existed = result.next();
        }
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS agent_access (
                      agent_id TEXT PRIMARY KEY,
                      body TEXT,
                      sha256 TEXT,
                      legacy INTEGER NOT NULL DEFAULT 0,
                      updated_at INTEGER NOT NULL
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS desk_grants (
                      grant_id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      to_desk_id TEXT NOT NULL,
                      to_desk_name TEXT NOT NULL,
                      to_key TEXT,
                      state TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL,
                      last_used_at INTEGER,
                      count INTEGER NOT NULL DEFAULT 0,
                      sha256 TEXT NOT NULL
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS desk_grants_agent ON desk_grants (agent_id, state)");
            if (!existed) {
                statement.execute("INSERT OR IGNORE INTO agent_access (agent_id, body, sha256, legacy, updated_at)"
                        + " SELECT id, NULL, NULL, 1, created_at FROM agents");
            }
            // Rows whose agent is gone go at every open, as memories' do: a delete or purge a rolled-back desk-agent
            // made, without knowing these tables, leaves nothing behind once this one runs again.
            statement.execute("DELETE FROM agent_access WHERE agent_id NOT IN (SELECT id FROM agents)");
            statement.execute("DELETE FROM desk_grants WHERE agent_id NOT IN (SELECT id FROM agents)");
        }
    }
}
