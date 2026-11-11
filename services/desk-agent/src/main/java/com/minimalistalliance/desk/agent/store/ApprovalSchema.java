package com.minimalistalliance.desk.agent.store;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * The Agent's approvals in {@code agent.db} (draft ADR "the Agent's tools and approvals", section 3): additive, applied
 * at every open and idempotent, as {@link TeamSchema} is, so {@code user_version} stays 1 and a desk-agent from before
 * still opens the file.
 *
 * <ul>
 *   <li>{@code approvals}: one row per card. {@code payload} is the canonical JSON the hash covers; {@code target},
 *       {@code before_json}, {@code origin} and {@code result} are JSON. {@code started_at} is set when an approved
 *       call's tool starts, so a restart can tell {@code interrupted} from never run. The row lives as long as its
 *       reply: it goes with the thread.
 *   <li>{@code run_marks}: what a reply's run held, by its message: {@code untrusted} (U), {@code private} (S) and how
 *       many {@code egress} calls ran. A later run whose context holds a marked reply starts with the same flags.
 * </ul>
 */
final class ApprovalSchema {

    private ApprovalSchema() {}

    static void apply(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS approvals (
                      id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      run_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      tool TEXT NOT NULL,
                      risk TEXT NOT NULL,
                      title TEXT NOT NULL,
                      context TEXT NOT NULL,
                      target TEXT NOT NULL,
                      payload TEXT NOT NULL,
                      before_json TEXT,
                      sha256 TEXT NOT NULL,
                      untrusted INTEGER NOT NULL,
                      origin TEXT NOT NULL,
                      state TEXT NOT NULL,
                      detail TEXT,
                      created_at INTEGER NOT NULL,
                      expires_at INTEGER NOT NULL,
                      decided_at INTEGER,
                      decided_by TEXT,
                      note TEXT,
                      started_at INTEGER,
                      result TEXT
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS approvals_message ON approvals (message_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS approvals_agent ON approvals (agent_id, created_at)");
            statement.execute("CREATE INDEX IF NOT EXISTS approvals_created ON approvals (created_at)");
            statement.execute("CREATE INDEX IF NOT EXISTS approvals_state ON approvals (state)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS run_marks (
                      message_id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      run_id TEXT NOT NULL,
                      untrusted INTEGER NOT NULL DEFAULT 0,
                      private INTEGER NOT NULL DEFAULT 0,
                      egress INTEGER NOT NULL DEFAULT 0
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS run_marks_agent ON run_marks (agent_id)");
        }
    }
}
