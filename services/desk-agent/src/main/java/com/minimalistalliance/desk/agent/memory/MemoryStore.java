package com.minimalistalliance.desk.agent.memory;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

/**
 * An agent's memory in {@code agent.db} (S-14, design 9.10): the lines it saved about its member, and the summary of the
 * part of its thread that no longer goes to the model whole. The tables are made with the team's, additive, so
 * {@code user_version} stays 1 ({@code TeamSchema}). Every write names its own columns, as {@link AgentStore}'s do, and
 * nothing here logs a line's text.
 */
public final class MemoryStore {

    /**
     * One line an agent saved. {@code untrusted}: saved in a run that had read untrusted content, so a run that reads
     * it is untrusted too (the tools and approvals draft, section 6).
     */
    public record Item(String id, String agentId, String text, long createdAt, boolean untrusted) {
        /** No text in logs. */
        @Override
        public String toString() {
            return "Item[" + id + ", " + agentId + "]";
        }
    }

    /**
     * The thread's summary: it covers every message up to {@code throughOrd} (that message is {@code throughId}), which
     * no run sends whole again. {@code id} changes with every write, so a compaction that read an older one can't
     * replace a newer one, or bring back one the member deleted. Empty {@code text} is a summary the member deleted: the
     * place it covers to stays, so the messages it held aren't sent or summarized again.
     */
    public record Summary(String id, String agentId, long throughOrd, String throughId, String text, long at,
            int turns, boolean untrusted) {
        public boolean blank() {
            return text.isEmpty();
        }

        /** No text in logs. */
        @Override
        public String toString() {
            return "Summary[" + id + ", " + agentId + ", through " + throughOrd + ", " + turns + " turns]";
        }
    }

    /** What a save did. */
    public enum Outcome {
        SAVED,
        /** The same line is already there: {@code id} is its. */
        ALREADY,
        /** The agent has as many lines as it may keep. */
        FULL,
        /** The agent is gone. */
        NO_AGENT
    }

    public record Saved(Outcome outcome, String id) {}

    private final AgentStore agents;

    public MemoryStore(AgentStore agents) {
        this.agents = agents;
    }

    /** The agent's lines, newest first. */
    public List<Item> list(String agentId) throws SQLException {
        return db().call(connection -> items(connection, agentId));
    }

    /**
     * Saves a line, unless the same line is there already ({@link Memories#same}) or the agent has {@code max}, in one
     * transaction, so two saves at once can't pass the limit. Never for an agent that's gone.
     */
    public Saved add(String agentId, String id, String text, long at, String runId, int max, boolean untrusted)
            throws SQLException {
        return db().transaction(connection -> {
            if (!agentExists(connection, agentId)) {
                return new Saved(Outcome.NO_AGENT, null);
            }
            List<Item> items = items(connection, agentId);
            for (Item item : items) {
                if (Memories.same(item.text(), text)) {
                    if (untrusted && !item.untrusted()) {
                        // The same words from an untrusted run: the line now carries the mark too.
                        try (PreparedStatement mark = connection.prepareStatement(
                                "UPDATE memories SET untrusted = 1 WHERE id = ?")) {
                            mark.setString(1, item.id());
                            mark.executeUpdate();
                        }
                    }
                    return new Saved(Outcome.ALREADY, item.id());
                }
            }
            if (items.size() >= max) {
                return new Saved(Outcome.FULL, null);
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO memories (id, agent_id, text, created_at, run_id, untrusted)"
                            + " VALUES (?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, id);
                insert.setString(2, agentId);
                insert.setString(3, text);
                insert.setLong(4, at);
                insert.setString(5, runId);
                insert.setInt(6, untrusted ? 1 : 0);
                insert.executeUpdate();
            }
            return new Saved(Outcome.SAVED, id);
        });
    }

    /**
     * Deletes one line, or with the summary's id, the summary's text (keeping where it covers to). The WAL is emptied
     * after, so with {@code secure_delete} the text is gone from the file too.
     *
     * @return whether there was such a line or summary
     */
    public boolean delete(String agentId, String id, String newSummaryId) throws SQLException {
        boolean deleted = db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM memories WHERE agent_id = ? AND id = ?")) {
                delete.setString(1, agentId);
                delete.setString(2, id);
                if (delete.executeUpdate() == 1) {
                    return true;
                }
            }
            try (PreparedStatement blank = connection.prepareStatement("UPDATE thread_summaries SET text = '', id = ?"
                    + " WHERE agent_id = ? AND id = ? AND text <> ''")) {
                blank.setString(1, newSummaryId);
                blank.setString(2, agentId);
                blank.setString(3, id);
                return blank.executeUpdate() == 1;
            }
        });
        if (deleted) {
            checkpointQuietly();
        }
        return deleted;
    }

    /** One line, by the agent that saved it ({@code memory_forget}): never the summary. @return whether it was there */
    public boolean forget(String agentId, String id) throws SQLException {
        boolean deleted = db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM memories WHERE agent_id = ? AND id = ?")) {
                delete.setString(1, agentId);
                delete.setString(2, id);
                return delete.executeUpdate() == 1;
            }
        });
        if (deleted) {
            checkpointQuietly();
        }
        return deleted;
    }

    /** Every line, and the summary's text. @return how many lines went, and 1 more for a summary */
    public int clear(String agentId, String newSummaryId) throws SQLException {
        int cleared = db().transaction(connection -> {
            int n;
            try (PreparedStatement delete = connection.prepareStatement("DELETE FROM memories WHERE agent_id = ?")) {
                delete.setString(1, agentId);
                n = delete.executeUpdate();
            }
            try (PreparedStatement blank = connection.prepareStatement(
                    "UPDATE thread_summaries SET text = '', id = ? WHERE agent_id = ? AND text <> ''")) {
                blank.setString(1, newSummaryId);
                blank.setString(2, agentId);
                n += blank.executeUpdate();
            }
            return n;
        });
        if (cleared > 0) {
            checkpointQuietly();
        }
        return cleared;
    }

    /** The thread's summary, blank or not, or null if it has never been compacted. */
    public Summary summary(String agentId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT id, agent_id, through_ord, through_id,"
                    + " text, at_ms, turns, untrusted FROM thread_summaries WHERE agent_id = ?")) {
                select.setString(1, agentId);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? new Summary(r.getString(1), r.getString(2), r.getLong(3), r.getString(4),
                            r.getString(5), r.getLong(6), r.getInt(7), r.getInt(8) != 0) : null;
                }
            }
        });
    }

    /**
     * Writes a new summary, only if the one there is still {@code expectedId} (null: none), it covers further than that
     * one, and the agent still exists: a compaction that raced a delete, a purge or another compaction writes nothing.
     *
     * @return whether it was written
     */
    public boolean replaceSummary(String expectedId, Summary next) throws SQLException {
        return db().transaction(connection -> {
            if (!agentExists(connection, next.agentId())) {
                return false;
            }
            Long coveredTo = null;
            String current = null;
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT id, through_ord FROM thread_summaries WHERE agent_id = ?")) {
                select.setString(1, next.agentId());
                try (ResultSet r = select.executeQuery()) {
                    if (r.next()) {
                        current = r.getString(1);
                        coveredTo = r.getLong(2);
                    }
                }
            }
            if (expectedId == null ? current != null : !expectedId.equals(current)) {
                return false;
            }
            if (coveredTo != null && next.throughOrd() <= coveredTo) {
                return false;
            }
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO thread_summaries (agent_id, id,"
                    + " through_ord, through_id, text, at_ms, turns, untrusted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                    + " ON CONFLICT (agent_id) DO UPDATE SET id = excluded.id, through_ord = excluded.through_ord,"
                    + " through_id = excluded.through_id, text = excluded.text, at_ms = excluded.at_ms,"
                    + " turns = excluded.turns, untrusted = excluded.untrusted")) {
                upsert.setString(1, next.agentId());
                upsert.setString(2, next.id());
                upsert.setLong(3, next.throughOrd());
                upsert.setString(4, next.throughId());
                upsert.setString(5, next.text());
                upsert.setLong(6, next.at());
                upsert.setInt(7, next.turns());
                upsert.setInt(8, next.untrusted() ? 1 : 0);
                upsert.executeUpdate();
            }
            return true;
        });
    }

    /** How many messages of the agent's thread are at or before {@code ord}. */
    public long messagesThrough(String agentId, long ord) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT COUNT(*) FROM messages WHERE agent_id = ? AND ord <= ?")) {
                select.setString(1, agentId);
                select.setLong(2, ord);
                try (ResultSet r = select.executeQuery()) {
                    r.next();
                    return r.getLong(1);
                }
            }
        });
    }

    private static List<Item> items(Connection connection, String agentId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT id, agent_id, text, created_at, untrusted"
                + " FROM memories WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC")) {
            select.setString(1, agentId);
            List<Item> items = new ArrayList<>();
            try (ResultSet r = select.executeQuery()) {
                while (r.next()) {
                    items.add(new Item(r.getString(1), r.getString(2), r.getString(3), r.getLong(4),
                            r.getInt(5) != 0));
                }
            }
            return items;
        }
    }

    private static boolean agentExists(Connection connection, String agentId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT 1 FROM agents WHERE id = ?")) {
            select.setString(1, agentId);
            try (ResultSet r = select.executeQuery()) {
                return r.next();
            }
        }
    }

    /** A delete is done once committed; emptying the WAL only makes the old page unreadable sooner. */
    private void checkpointQuietly() {
        try {
            db().checkpoint();
        } catch (SQLException | RuntimeException e) {
            // The next checkpoint takes it, as SQLite does on its own.
        }
    }

    private SqliteDatabase db() throws SQLException {
        return agents.database();
    }
}
