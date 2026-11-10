package com.minimalistalliance.desk.agent.store;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * {@code /data/agent/agent.db}: the desk's agents, their threads, the metadata of their keys and the desk's limits.
 * No key is ever written here. desk-agent owns this file, so deskd's relay of {@code agent.*} is a pass-through
 * (docs/proposals.md section 5).
 *
 * <p>Opening it creates the manager if it's missing, and ends any reply a crash left {@code streaming}: it becomes
 * {@code failed}, {@code unavailable}, {@code interrupted}, as runs don't resume yet (ADR 0020's durable runs are
 * later).
 */
public final class AgentStore implements AutoCloseable {

    public static final String MANAGER = "manager";

    private static final List<SqliteDatabase.Step> SCHEMA = List.of(connection -> {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE agents (
                      id TEXT PRIMARY KEY,
                      name TEXT NOT NULL,
                      role TEXT NOT NULL CHECK (role IN ('manager', 'staff')),
                      created_at INTEGER NOT NULL,
                      key_id TEXT,
                      provider TEXT,
                      model TEXT,
                      badge_hidden INTEGER NOT NULL DEFAULT 0,
                      badge_notice INTEGER NOT NULL DEFAULT 0,
                      unseen INTEGER NOT NULL DEFAULT 0,
                      limits TEXT
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE messages (
                      id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL REFERENCES agents (id),
                      ord INTEGER NOT NULL,
                      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                      text TEXT NOT NULL,
                      at_ms INTEGER NOT NULL,
                      run_id TEXT,
                      badge TEXT,
                      usage TEXT,
                      cost_microusd INTEGER,
                      stop_reason TEXT,
                      state TEXT,
                      error TEXT,
                      error_detail TEXT
                    ) STRICT""");
            statement.execute("CREATE INDEX messages_agent ON messages (agent_id, ord)");
            statement.execute("""
                    CREATE TABLE keys (
                      key_id TEXT PRIMARY KEY,
                      provider TEXT NOT NULL,
                      label TEXT NOT NULL,
                      last4 TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      created_by_desk TEXT NOT NULL
                    ) STRICT""");
            statement.execute("CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
        }
    });

    private final Path file;
    private final Clock clock;
    private volatile SqliteDatabase database;
    private volatile int interruptedAtOpen;

    public AgentStore(Path file, Clock clock) {
        this.file = file;
        this.clock = clock;
    }

    public void open() throws SQLException {
        SqliteDatabase opened = SqliteDatabase.open("agents", file, SCHEMA);
        try {
            opened.transaction(connection -> {
                TeamSchema.apply(connection);
                return null;
            });
            interruptedAtOpen = opened.transaction(connection -> {
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT OR IGNORE INTO agents (id, name, role, created_at)"
                                + " VALUES (?, 'Lead', 'manager', ?)")) {
                    insert.setString(1, MANAGER);
                    insert.setLong(2, clock.millis());
                    insert.executeUpdate();
                }
                try (Statement statement = connection.createStatement()) {
                    return statement.executeUpdate("UPDATE messages SET state = 'failed', error = 'unavailable',"
                            + " error_detail = 'interrupted' WHERE state = 'streaming'");
                }
            });
        } catch (SQLException | RuntimeException e) {
            opened.close();
            throw e;
        }
        database = opened;
    }

    /** A guild member's own agent, made the first time they use the Agent app there. Nothing if it exists. */
    public void ensureAgent(String id, String name) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT OR IGNORE INTO agents (id, name, role, created_at) VALUES (?, ?, 'manager', ?)")) {
                insert.setString(1, id);
                insert.setString(2, name);
                insert.setLong(3, clock.millis());
                insert.executeUpdate();
            }
            return null;
        });
    }

    public boolean isOpen() {
        return database != null;
    }

    /** Replies a crash left streaming, ended by the last {@link #open}. */
    public int interruptedAtOpen() {
        return interruptedAtOpen;
    }

    public List<AgentRow> agents() throws SQLException {
        return db().call(connection -> {
            try (Statement statement = connection.createStatement();
                    ResultSet result = statement.executeQuery(AGENT_COLUMNS + " ORDER BY created_at, id")) {
                List<AgentRow> rows = new ArrayList<>();
                while (result.next()) {
                    rows.add(agent(result));
                }
                return rows;
            }
        });
    }

    /** @return the agent, or null */
    public AgentRow agent(String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(AGENT_COLUMNS + " WHERE id = ?")) {
                select.setString(1, id);
                try (ResultSet result = select.executeQuery()) {
                    return result.next() ? agent(result) : null;
                }
            }
        });
    }

    /*
     * An agent's row is changed a few columns at a time, each write naming only the columns it changes, so two
     * writes at once never put back an older copy of the other's: there's no whole-row write.
     */

    /** The name and the badge's flags: a null leaves that column as it is. */
    public void setNameAndBadge(String id, String name, Boolean badgeHidden, Boolean badgeNotice) throws SQLException {
        updateAgent("UPDATE agents SET name = COALESCE(?, name), badge_hidden = COALESCE(?, badge_hidden),"
                + " badge_notice = COALESCE(?, badge_notice) WHERE id = ?", update -> {
                    update.setString(1, name);
                    setFlag(update, 2, badgeHidden);
                    setFlag(update, 3, badgeNotice);
                    update.setString(4, id);
                });
    }

    /**
     * Binds the agent to a key and a model. A hidden badge gets its notice back if the provider changes (design 9.4),
     * judged on the row as it is, in the same statement.
     */
    public void setBinding(String id, String keyId, String provider, String model) throws SQLException {
        updateAgent("UPDATE agents SET badge_notice = CASE WHEN badge_hidden = 1 AND provider IS NOT NULL"
                + " AND provider <> ? THEN 1 ELSE badge_notice END, key_id = ?, provider = ?, model = ? WHERE id = ?",
                update -> {
                    update.setString(1, provider);
                    update.setString(2, keyId);
                    update.setString(3, provider);
                    update.setString(4, model);
                    update.setString(5, id);
                });
    }

    /** One more reply the member hasn't seen. */
    public void addUnseen(String id) throws SQLException {
        updateAgent("UPDATE agents SET unseen = unseen + 1 WHERE id = ?", update -> update.setString(1, id));
    }

    /** The member has seen the thread. */
    public void clearUnseen(String id) throws SQLException {
        updateAgent("UPDATE agents SET unseen = 0 WHERE id = ?", update -> update.setString(1, id));
    }

    /** The agent's own limit scopes as JSON, or null for the defaults. */
    public void setLimits(String id, String limits) throws SQLException {
        updateAgent("UPDATE agents SET limits = ? WHERE id = ?", update -> {
            update.setString(1, limits);
            update.setString(2, id);
        });
    }

    @FunctionalInterface
    private interface Binder {
        void bind(PreparedStatement statement) throws SQLException;
    }

    private void updateAgent(String sql, Binder binder) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(sql)) {
                binder.bind(update);
                if (update.executeUpdate() != 1) {
                    throw new SQLException("no such agent");
                }
            }
            return null;
        });
    }

    private static void setFlag(PreparedStatement statement, int index, Boolean value) throws SQLException {
        if (value == null) {
            statement.setNull(index, Types.INTEGER);
        } else {
            statement.setInt(index, value ? 1 : 0);
        }
    }

    /** The last {@code limit} messages of an agent's thread, oldest first. */
    public List<MessageRow> messages(String agentId, int limit) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(MESSAGE_COLUMNS
                    + " WHERE agent_id = ? ORDER BY ord DESC LIMIT ?")) {
                select.setString(1, agentId);
                select.setInt(2, limit);
                List<MessageRow> rows = new ArrayList<>();
                try (ResultSet result = select.executeQuery()) {
                    while (result.next()) {
                        rows.add(message(result));
                    }
                }
                Collections.reverse(rows);
                return rows;
            }
        });
    }

    /**
     * Up to {@code limit} of an agent's messages, newest first: the newest of all, or with {@code beforeId}, those older
     * than that message. A {@code beforeId} that isn't in the thread gives none ({@link #hasMessage} tells which).
     */
    public List<MessageRow> messagesNewestFirst(String agentId, String beforeId, int limit) throws SQLException {
        return db().call(connection -> {
            String where = beforeId == null
                    ? " WHERE agent_id = ?"
                    : " WHERE agent_id = ? AND ord < (SELECT ord FROM messages WHERE agent_id = ? AND id = ?)";
            try (PreparedStatement select = connection.prepareStatement(MESSAGE_COLUMNS + where + " ORDER BY ord DESC LIMIT ?")) {
                int at = 1;
                select.setString(at++, agentId);
                if (beforeId != null) {
                    select.setString(at++, agentId);
                    select.setString(at++, beforeId);
                }
                select.setInt(at, limit);
                List<MessageRow> rows = new ArrayList<>();
                try (ResultSet result = select.executeQuery()) {
                    while (result.next()) {
                        rows.add(message(result));
                    }
                }
                return rows;
            }
        });
    }

    /** The notes of the files attached to a message, as JSON, or null for a message with none. */
    public String filesOf(String messageId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT files FROM message_files WHERE message_id = ?")) {
                select.setString(1, messageId);
                try (ResultSet result = select.executeQuery()) {
                    return result.next() ? result.getString(1) : null;
                }
            }
        });
    }

    /** Whether this message is in the agent's thread. */
    public boolean hasMessage(String agentId, String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT 1 FROM messages WHERE agent_id = ? AND id = ?")) {
                select.setString(1, agentId);
                select.setString(2, id);
                try (ResultSet result = select.executeQuery()) {
                    return result.next();
                }
            }
        });
    }

    /** Adds messages at the end of their threads, in one transaction. */
    public void addMessages(List<MessageRow> rows) throws SQLException {
        addMessages(rows, Map.of());
    }

    /**
     * Adds messages at the end of their threads, in one transaction, with what the thread keeps of the files attached
     * to some of them: {@code files} is a message's id to its {@link FileNote}s as JSON.
     */
    public void addMessages(List<MessageRow> rows, Map<String, String> files) throws SQLException {
        db().transaction(connection -> {
            for (Map.Entry<String, String> entry : files.entrySet()) {
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO message_files (message_id, files) VALUES (?, ?)")) {
                    insert.setString(1, entry.getKey());
                    insert.setString(2, entry.getValue());
                    insert.executeUpdate();
                }
            }
            for (MessageRow row : rows) {
                long ord;
                try (PreparedStatement next = connection.prepareStatement(
                        "SELECT COALESCE(MAX(ord), 0) + 1 FROM messages WHERE agent_id = ?")) {
                    next.setString(1, row.agentId());
                    try (ResultSet result = next.executeQuery()) {
                        ord = result.getLong(1);
                    }
                }
                try (PreparedStatement insert = connection.prepareStatement("INSERT INTO messages (id, agent_id, ord,"
                        + " role, text, at_ms, run_id, badge, usage, cost_microusd, stop_reason, state, error,"
                        + " error_detail, origin, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                    insert.setString(1, row.id());
                    insert.setString(2, row.agentId());
                    insert.setLong(3, ord);
                    insert.setString(4, row.role());
                    bindMessage(insert, row, 5);
                    insert.setString(15, row.origin());
                    insert.setString(16, row.tools());
                    insert.executeUpdate();
                }
            }
            return null;
        });
    }

    /** Replaces a message's text and outcome, by id. */
    public void updateMessage(MessageRow row) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE messages SET text = ?, at_ms = ?,"
                    + " run_id = ?, badge = ?, usage = ?, cost_microusd = ?, stop_reason = ?, state = ?, error = ?,"
                    + " error_detail = ?, tools = ? WHERE id = ?")) {
                bindMessage(update, row, 1);
                update.setString(11, row.tools());
                update.setString(12, row.id());
                update.executeUpdate();
            }
            return null;
        });
    }

    private static void bindMessage(PreparedStatement statement, MessageRow row, int first) throws SQLException {
        statement.setString(first, row.text());
        statement.setLong(first + 1, row.at());
        statement.setString(first + 2, row.runId());
        statement.setString(first + 3, row.badge());
        statement.setString(first + 4, row.usage());
        if (row.costMicroUsd() == null) {
            statement.setNull(first + 5, Types.INTEGER);
        } else {
            statement.setLong(first + 5, row.costMicroUsd());
        }
        statement.setString(first + 6, row.stopReason());
        statement.setString(first + 7, row.state());
        statement.setString(first + 8, row.error());
        statement.setString(first + 9, row.errorDetail());
    }

    public List<KeyRow> keys() throws SQLException {
        return db().call(connection -> {
            try (Statement statement = connection.createStatement();
                    ResultSet result = statement.executeQuery(KEY_COLUMNS + " ORDER BY created_at, key_id")) {
                List<KeyRow> rows = new ArrayList<>();
                while (result.next()) {
                    rows.add(key(result));
                }
                return rows;
            }
        });
    }

    /** @return the key's metadata, or null */
    public KeyRow key(String keyId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(KEY_COLUMNS + " WHERE key_id = ?")) {
                select.setString(1, keyId);
                try (ResultSet result = select.executeQuery()) {
                    return result.next() ? key(result) : null;
                }
            }
        });
    }

    public void addKey(KeyRow row) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO keys (key_id, provider, label,"
                    + " last4, created_at, created_by_desk) VALUES (?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, row.keyId());
                insert.setString(2, row.provider());
                insert.setString(3, row.label());
                insert.setString(4, row.last4());
                insert.setLong(5, row.createdAt());
                insert.setString(6, row.createdByDesk());
                insert.executeUpdate();
            }
            return null;
        });
    }

    /** Deletes the key's metadata and unbinds every agent on it, in one transaction. @return the agents unbound */
    public List<String> deleteKey(String keyId) throws SQLException {
        return db().transaction(connection -> {
            List<String> unbound = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement("SELECT id FROM agents WHERE key_id = ?")) {
                select.setString(1, keyId);
                try (ResultSet result = select.executeQuery()) {
                    while (result.next()) {
                        unbound.add(result.getString(1));
                    }
                }
            }
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE agents SET key_id = NULL, provider = NULL, model = NULL WHERE key_id = ?")) {
                update.setString(1, keyId);
                update.executeUpdate();
            }
            try (PreparedStatement delete = connection.prepareStatement("DELETE FROM keys WHERE key_id = ?")) {
                delete.setString(1, keyId);
                delete.executeUpdate();
            }
            return unbound;
        });
    }

    /** @return a desk setting, or null */
    public String setting(String name) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT value FROM settings WHERE name = ?")) {
                select.setString(1, name);
                try (ResultSet result = select.executeQuery()) {
                    return result.next() ? result.getString(1) : null;
                }
            }
        });
    }

    public void setSetting(String name, String value) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO settings (name, value)"
                    + " VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value")) {
                upsert.setString(1, name);
                upsert.setString(2, value);
                upsert.executeUpdate();
            }
            return null;
        });
    }

    private static final String AGENT_COLUMNS = "SELECT id, name, role, created_at, key_id, provider, model,"
            + " badge_hidden, badge_notice, unseen, limits FROM agents";
    private static final String MESSAGE_COLUMNS = "SELECT id, agent_id, role, text, at_ms, run_id, badge, usage,"
            + " cost_microusd, stop_reason, state, error, error_detail, origin, tools FROM messages";
    private static final String KEY_COLUMNS =
            "SELECT key_id, provider, label, last4, created_at, created_by_desk FROM keys";

    private static AgentRow agent(ResultSet r) throws SQLException {
        return new AgentRow(r.getString(1), r.getString(2), r.getString(3), r.getLong(4), r.getString(5),
                r.getString(6), r.getString(7), r.getInt(8) != 0, r.getInt(9) != 0, r.getInt(10), r.getString(11));
    }

    private static MessageRow message(ResultSet r) throws SQLException {
        long cost = r.getLong(9);
        Long costMicroUsd = r.wasNull() ? null : cost;
        return new MessageRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getLong(5),
                r.getString(6), r.getString(7), r.getString(8), costMicroUsd, r.getString(10), r.getString(11),
                r.getString(12), r.getString(13), r.getString(14), r.getString(15));
    }

    private static KeyRow key(ResultSet r) throws SQLException {
        return new KeyRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getLong(5),
                r.getString(6));
    }

    /** The open database, for the team's tables beside these ({@code TeamStore}, ADR 0047). */
    public SqliteDatabase database() throws SQLException {
        return db();
    }

    private SqliteDatabase db() throws SQLException {
        SqliteDatabase opened = database;
        if (opened == null) {
            throw new SQLException("the agent store isn't open");
        }
        return opened;
    }

    @Override
    public void close() {
        SqliteDatabase closing = database;
        database = null;
        if (closing != null) {
            closing.close();
        }
    }
}
