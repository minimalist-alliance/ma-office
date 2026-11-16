package com.minimalistalliance.desk.agent.store;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashSet;
import java.util.Set;

/**
 * Messages between the member's desks in {@code agent.db} (draft ADR "the Agent's tools and approvals", §14): additive,
 * applied at every open and idempotent, as {@link AccessSchema} is, so {@code user_version} stays 1 and a desk-agent from
 * before still opens the file (it never reads these tables, and reads {@code desk_grants} by named columns).
 *
 * <ul>
 *   <li>{@code desk_grants} gains {@code to_agent_id} and {@code to_agent_name}: the other desk's answering agent, once
 *       its accept came, for the card's words.
 *   <li>{@code desk_answers}: this desk's answer halves and the offers waiting here, by grant: the desk and agent that
 *       sent it, the agent that answers here (null until the member allows it), {@code offered}, {@code declined},
 *       {@code active} or {@code revoked}, how it's been used, and {@code sha256} over what decides whether it's in force.
 *   <li>{@code desk_outbox}: each envelope this desk sends, sealed by deskd, kept until the other desk took it (or
 *       refused it, or 7 days passed), then a week more for the record. Never content beyond the sealed envelope.
 *   <li>{@code desk_inbox}: each envelope taken in, by its id, which is what makes a second delivery of it a
 *       {@code duplicate}; a message's or an answer's text until it's been handled, then wiped.
 *   <li>{@code desk_seq}: the last {@code seq} taken in on each grant, which keeps order per pair: an envelope at or
 *       below it that isn't one already taken in is {@code stale}.
 * </ul>
 * Rows whose agent is gone go at every open; inbox and outbox rows go a week after they're settled.
 */
final class DeskSchema {

    private DeskSchema() {}

    static void apply(Connection connection) throws SQLException {
        Set<String> grantColumns = new HashSet<>();
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery("PRAGMA table_info(desk_grants)")) {
            while (result.next()) {
                grantColumns.add(result.getString("name"));
            }
        }
        try (Statement statement = connection.createStatement()) {
            if (!grantColumns.contains("to_agent_id")) {
                statement.execute("ALTER TABLE desk_grants ADD COLUMN to_agent_id TEXT");
            }
            if (!grantColumns.contains("to_agent_name")) {
                statement.execute("ALTER TABLE desk_grants ADD COLUMN to_agent_name TEXT");
            }
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS desk_answers (
                      grant_id TEXT PRIMARY KEY,
                      from_desk_id TEXT NOT NULL,
                      from_agent_id TEXT NOT NULL,
                      from_agent_name TEXT,
                      agent_id TEXT,
                      state TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL,
                      last_used_at INTEGER,
                      count INTEGER NOT NULL DEFAULT 0,
                      sha256 TEXT NOT NULL
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS desk_outbox (
                      env_id TEXT PRIMARY KEY,
                      grant_id TEXT NOT NULL,
                      to_desk_id TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      seq INTEGER NOT NULL,
                      envelope TEXT NOT NULL,
                      agent_id TEXT,
                      reply_to TEXT,
                      created_at INTEGER NOT NULL,
                      state TEXT NOT NULL,
                      reason TEXT,
                      done_at INTEGER
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS desk_outbox_queued ON desk_outbox (state, to_desk_id)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS desk_inbox (
                      env_id TEXT PRIMARY KEY,
                      grant_id TEXT NOT NULL,
                      from_desk_id TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      seq INTEGER NOT NULL,
                      sent_at INTEGER NOT NULL,
                      received_at INTEGER NOT NULL,
                      agent_id TEXT,
                      reply_to TEXT,
                      body TEXT,
                      state TEXT NOT NULL,
                      run_id TEXT,
                      settled_at INTEGER
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS desk_inbox_state ON desk_inbox (state, kind)");
            statement.execute("CREATE INDEX IF NOT EXISTS desk_inbox_grant ON desk_inbox (grant_id, kind, received_at)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS desk_seq (
                      grant_id TEXT PRIMARY KEY,
                      last INTEGER NOT NULL
                    ) STRICT""");
            // An answer half whose answering agent is gone goes with it, as the send halves do in AccessSchema.
            statement.execute("DELETE FROM desk_answers WHERE agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents)");
        }
    }
}
