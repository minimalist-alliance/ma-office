package com.minimalistalliance.desk.agent.store;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Task 49's tables and columns in {@code agent.db} (ADR 0047): additive only, applied at every open and idempotent, so
 * {@code user_version} stays 1. A desk-agent from before reads the same file as it always did: it names its own
 * columns, never selects {@code *}, and ignores tables it doesn't know, so a rollback still starts (README, "Keys": a
 * rollback must never fail to open {@code agent.db}). A column added here has a default or is nullable, so the old
 * code's inserts still work.
 */
final class TeamSchema {

    private TeamSchema() {}

    static void apply(Connection connection) throws SQLException {
        addColumns(connection, "agents",
                "purpose TEXT NOT NULL DEFAULT ''",
                "icon TEXT NOT NULL DEFAULT 'nodes'",
                "tone TEXT NOT NULL DEFAULT 'graphite'",
                "png_version INTEGER",
                "solo INTEGER NOT NULL DEFAULT 1",
                "workspace_mb INTEGER",
                "shared_with TEXT NOT NULL DEFAULT '[]'");
        addColumns(connection, "messages", "origin TEXT", "tools TEXT");
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS links (
                      from_id TEXT NOT NULL,
                      to_id TEXT NOT NULL,
                      rules TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      PRIMARY KEY (from_id, to_id)
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS proposals (
                      id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      action TEXT NOT NULL,
                      summary TEXT NOT NULL,
                      payload TEXT NOT NULL,
                      sha256 TEXT NOT NULL,
                      state TEXT NOT NULL,
                      detail TEXT,
                      result TEXT,
                      created_at INTEGER NOT NULL,
                      expires_at INTEGER NOT NULL,
                      answered_at INTEGER
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS proposals_message ON proposals (message_id)");
            addColumns(connection, "proposals", "run_id TEXT", "origin TEXT", "before_json TEXT");
            statement.execute("CREATE INDEX IF NOT EXISTS proposals_run ON proposals (run_id)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS a2a (
                      id TEXT PRIMARY KEY,
                      from_id TEXT NOT NULL,
                      to_id TEXT NOT NULL,
                      chain_id TEXT NOT NULL,
                      depth INTEGER NOT NULL,
                      text TEXT NOT NULL,
                      rules TEXT NOT NULL,
                      at_ms INTEGER NOT NULL,
                      state TEXT NOT NULL,
                      reason TEXT,
                      reply TEXT,
                      cost_microusd INTEGER,
                      run_id TEXT
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS a2a_at ON a2a (at_ms)");
            statement.execute("CREATE INDEX IF NOT EXISTS a2a_pair ON a2a (from_id, to_id, at_ms)");
            statement.execute("CREATE INDEX IF NOT EXISTS a2a_to ON a2a (to_id, at_ms)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS timers (
                      id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      label TEXT NOT NULL,
                      kind TEXT NOT NULL CHECK (kind IN ('once', 'repeat')),
                      days TEXT,
                      time TEXT,
                      every_minutes INTEGER,
                      at_ms INTEGER,
                      prompt TEXT NOT NULL,
                      enabled INTEGER NOT NULL,
                      next_ms INTEGER,
                      last_ms INTEGER,
                      last_state TEXT,
                      retries INTEGER NOT NULL DEFAULT 0,
                      spent_microusd INTEGER NOT NULL DEFAULT 0,
                      created_at INTEGER NOT NULL
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS timers_agent ON timers (agent_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS timers_next ON timers (next_ms)");
            // Files attached to a member's message (ADR 0049): their names, types and sizes, never their content.
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS message_files (
                      message_id TEXT PRIMARY KEY,
                      files TEXT NOT NULL
                    ) STRICT""");
            // Memory (S-14): what each agent remembers about its member across conversations, one short line each,
            // and the summary of the part of its thread that no longer goes to the model whole. Rows whose agent is
            // gone go at every open, so a purge or delete a rolled-back desk-agent made, without knowing these
            // tables, leaves nothing behind once this one runs again. `untrusted` marks a line saved, or a summary
            // made from messages, in a run that read untrusted content (ADR draft-agent-tools-approvals §6): a run that
            // reads it is untrusted too.
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS memories (
                      id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      text TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      run_id TEXT,
                      untrusted INTEGER NOT NULL DEFAULT 0
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS memories_agent ON memories (agent_id, created_at)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS thread_summaries (
                      agent_id TEXT PRIMARY KEY,
                      id TEXT NOT NULL,
                      through_ord INTEGER NOT NULL,
                      through_id TEXT NOT NULL,
                      text TEXT NOT NULL,
                      at_ms INTEGER NOT NULL,
                      turns INTEGER NOT NULL,
                      untrusted INTEGER NOT NULL DEFAULT 0
                    ) STRICT""");
            statement.execute("DELETE FROM memories WHERE agent_id NOT IN (SELECT id FROM agents)");
            statement.execute("DELETE FROM thread_summaries WHERE agent_id NOT IN (SELECT id FROM agents)");
            // Retired icons and tones (Design H4) become the ones that took their place. It's a no-op once done, and
            // it catches rows a rolled-back desk-agent wrote meanwhile.
            retire(statement, "icon", TeamStore.RETIRED_ICONS);
            retire(statement, "tone", TeamStore.RETIRED_TONES);
            // The manager became the lead: a desk that kept the old default name gets the new one, once.
            statement.execute("INSERT OR IGNORE INTO settings (name, value) VALUES ('team.lead_named', '0')");
            try (ResultSet done = statement.executeQuery(
                    "SELECT value FROM settings WHERE name = 'team.lead_named'")) {
                if (done.next() && "0".equals(done.getString(1))) {
                    statement.execute("UPDATE agents SET name = 'Lead' WHERE id = 'manager' AND name = 'Manager'");
                    statement.execute("UPDATE settings SET value = '1' WHERE name = 'team.lead_named'");
                }
            }
        }
    }

    private static void retire(Statement statement, String column, Map<String, String> retired) throws SQLException {
        StringBuilder sql = new StringBuilder("UPDATE agents SET ").append(column).append(" = CASE ").append(column);
        for (Map.Entry<String, String> entry : new TreeMap<>(retired).entrySet()) {
            sql.append(" WHEN '").append(entry.getKey()).append("' THEN '").append(entry.getValue()).append('\'');
        }
        sql.append(" ELSE ").append(column).append(" END WHERE ").append(column).append(" IN ('")
                .append(String.join("', '", new TreeMap<>(retired).keySet())).append("')");
        statement.execute(sql.toString());
    }

    private static void addColumns(Connection connection, String table, String... columns) throws SQLException {
        Set<String> present = new HashSet<>();
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery("PRAGMA table_info(" + table + ")")) {
            while (result.next()) {
                present.add(result.getString("name"));
            }
        }
        for (String column : columns) {
            String name = column.substring(0, column.indexOf(' '));
            if (!present.contains(name)) {
                try (Statement statement = connection.createStatement()) {
                    statement.execute("ALTER TABLE " + table + " ADD COLUMN " + column);
                }
            }
        }
    }
}
