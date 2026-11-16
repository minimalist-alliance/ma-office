package com.minimalistalliance.desk.agent.store;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Runs' checkpoints ({@link RunSchema}'s {@code runs}, {@code run_steps}, {@code run_results} and {@code run_waits};
 * durable runs, Design 1). JSON columns stay text here; {@code run.RunCheckpoints} reads and writes them. Every write
 * that adds to a checkpoint adds its bytes to the run's count, and refuses ({@link Full}) past the cap, so a run's
 * checkpoint is bounded whatever it does.
 */
public final class RunStore {

    /** A run's row. {@code start} and {@code book} are JSON, null once it can't resume or has ended. */
    public record Run(String runId, String agentId, String messageId, String state, String detail, boolean resumable,
            int step, String start, String book, long bytes, int resumes, long createdAt, long updatedAt,
            Long endedAt) {
        public Run {
            Objects.requireNonNull(runId, "runId");
            Objects.requireNonNull(agentId, "agentId");
            Objects.requireNonNull(messageId, "messageId");
            Objects.requireNonNull(state, "state");
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "Run[" + runId + ", " + state + ", step " + step + ", " + bytes + " bytes]";
        }
    }

    /** One step's plan, and its verdicts once admitted. */
    public record Step(int step, String plan, String verdicts, long plannedAt) {}

    /** One call's result in a step. */
    public record Result(int step, int index, String result) {}

    /** One kept wait. */
    public record Wait(String runId, String callKey, String agentId, String kind, String ref, String state,
            long deadlineAt, String answer, long createdAt) {}

    /** A checkpoint write that would take the run past its cap: nothing was written, and it can't resume now. */
    public static final class Full extends SQLException {
        private static final long serialVersionUID = 1L;

        Full() {
            super("the run's checkpoint is full");
        }
    }

    private static final String RUN_COLUMNS = "run_id, agent_id, message_id, state, detail, resumable, step, start,"
            + " book, bytes, resumes, created_at, updated_at, ended_at";

    private final AgentStore store;

    public RunStore(AgentStore store) {
        this.store = store;
    }

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    private static long bytes(String... texts) {
        long n = 0;
        for (String t : texts) {
            n += t == null ? 0 : t.getBytes(StandardCharsets.UTF_8).length;
        }
        return n;
    }

    /** A run begins: its row, {@code running}, with its start context. Past {@code cap} it's kept unresumable. */
    public void begin(Run run, long cap) throws SQLException {
        long size = bytes(run.start(), run.book());
        boolean fits = size <= cap;
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT OR REPLACE INTO runs (" + RUN_COLUMNS
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, run.runId());
                insert.setString(2, run.agentId());
                insert.setString(3, run.messageId());
                insert.setString(4, run.state());
                insert.setString(5, run.detail());
                insert.setInt(6, fits && run.resumable() ? 1 : 0);
                insert.setInt(7, run.step());
                insert.setString(8, fits ? run.start() : null);
                insert.setString(9, fits ? run.book() : null);
                insert.setLong(10, fits ? size : 0);
                insert.setInt(11, run.resumes());
                insert.setLong(12, run.createdAt());
                insert.setLong(13, run.updatedAt());
                insert.setNull(14, Types.INTEGER);
                insert.executeUpdate();
            }
            return null;
        });
    }

    /**
     * A step's plan, in one transaction with the run's step, book and state: {@code running}. @throws Full past the
     * cap, after which the run can't resume (its checkpoint is gone)
     */
    public void planned(String runId, Step step, String book, long at, long cap) throws SQLException {
        long add = bytes(step.plan(), book);
        write(runId, add, cap, at, connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT OR REPLACE INTO run_steps (run_id,"
                    + " step, plan, verdicts, planned_at) VALUES (?, ?, ?, NULL, ?)")) {
                insert.setString(1, runId);
                insert.setInt(2, step.step());
                insert.setString(3, step.plan());
                insert.setLong(4, step.plannedAt());
                insert.executeUpdate();
            }
            try (PreparedStatement update = connection.prepareStatement("UPDATE runs SET step = ?, state = 'running',"
                    + " detail = NULL, updated_at = ? WHERE run_id = ?")) {
                update.setInt(1, step.step());
                update.setLong(2, at);
                update.setString(3, runId);
                update.executeUpdate();
            }
            book(connection, runId, book, at);
        });
    }

    /** The step's verdicts once the gate admitted it, with the run's book as it then was. */
    public void admitted(String runId, int step, String verdicts, String book, long at, long cap)
            throws SQLException {
        write(runId, bytes(verdicts, book), cap, at, connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE run_steps SET verdicts = ? WHERE run_id = ? AND step = ?")) {
                update.setString(1, verdicts);
                update.setString(2, runId);
                update.setInt(3, step);
                update.executeUpdate();
            }
            book(connection, runId, book, at);
        });
    }

    /**
     * A call's result, with its record's outcome ({@code run_calls}, by {@code key}; null for a call that never ran) and
     * the run's book, in one transaction: a kill can't leave one without the other.
     */
    public void result(String runId, Result result, String key, String state, String detail, String book, long at,
            long cap) throws SQLException {
        try {
            boolean wrote = write(runId, bytes(result.result(), book), cap, at, connection -> {
                try (PreparedStatement insert = connection.prepareStatement("INSERT OR REPLACE INTO run_results"
                        + " (run_id, step, idx, result) VALUES (?, ?, ?, ?)")) {
                    insert.setString(1, runId);
                    insert.setInt(2, result.step());
                    insert.setInt(3, result.index());
                    insert.setString(4, result.result());
                    insert.executeUpdate();
                }
                settleCall(connection, key, state, detail, at);
                book(connection, runId, book, at);
            });
            if (!wrote && key != null) {
                // A run with no checkpoint (attachments, the kill switch, past the cap): its record settles all the same.
                db().transaction(connection -> {
                    settleCall(connection, key, state, detail, at);
                    return null;
                });
            }
        } catch (Full full) {
            // The record still settles, alone: the trace never waits on the checkpoint.
            if (key != null) {
                db().transaction(connection -> {
                    settleCall(connection, key, state, detail, at);
                    return null;
                });
            }
            throw full;
        }
    }

    private static void settleCall(Connection connection, String key, String state, String detail, long at)
            throws SQLException {
        if (key == null) {
            return;
        }
        try (PreparedStatement update = connection.prepareStatement("UPDATE run_calls SET state = ?, detail = ?,"
                + " settled_at = ? WHERE key = ? AND state = 'started'")) {
            update.setString(1, state);
            update.setString(2, detail);
            update.setLong(3, at);
            update.setString(4, key);
            update.executeUpdate();
        }
    }

    /** The run's book alone, as its counts change between checkpoints. */
    public void book(String runId, String book, long at) throws SQLException {
        write(runId, 0, Long.MAX_VALUE, at, connection -> book(connection, runId, book, at));
    }

    /**
     * The run's book, merged with what's kept, in the write's own transaction: counts take the larger, sets the union.
     * So a write computed from an older view (a decline's on the member's thread, racing the run's own) never lowers
     * the run's taint or counts (Security's DR-L4).
     */
    private static void book(Connection connection, String runId, String book, long at) throws SQLException {
        String kept = null;
        try (PreparedStatement select = connection.prepareStatement("SELECT book FROM runs WHERE run_id = ?")) {
            select.setString(1, runId);
            try (ResultSet r = select.executeQuery()) {
                if (r.next()) {
                    kept = r.getString(1);
                }
            }
        }
        String merged = mergeBooks(kept, book);
        try (PreparedStatement update = connection.prepareStatement(
                "UPDATE runs SET book = ?, updated_at = ? WHERE run_id = ?")) {
            update.setString(1, merged);
            update.setLong(2, at);
            update.setString(3, runId);
            update.executeUpdate();
        }
    }

    /** Two books as one: each count the larger, each list the union in order. A side that doesn't read is ignored. */
    static String mergeBooks(String kept, String book) {
        java.util.Map<String, Object> a = parseBook(kept);
        java.util.Map<String, Object> b = parseBook(book);
        if (a == null) {
            return book;
        }
        if (b == null) {
            return kept;
        }
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>(a);
        for (java.util.Map.Entry<String, Object> e : b.entrySet()) {
            Object old = out.get(e.getKey());
            Object now = e.getValue();
            if (old instanceof Number x && now instanceof Number y) {
                out.put(e.getKey(), Math.max(x.longValue(), y.longValue()));
            } else if (old instanceof List<?> x && now instanceof List<?> y) {
                java.util.LinkedHashSet<Object> union = new java.util.LinkedHashSet<>(x);
                union.addAll(y);
                out.put(e.getKey(), new ArrayList<>(union));
            } else {
                out.put(e.getKey(), now);
            }
        }
        return new String(com.minimalistalliance.desk.agent.json.Json.bytes(out), StandardCharsets.UTF_8);
    }

    private static java.util.Map<String, Object> parseBook(String json) {
        if (json == null) {
            return null;
        }
        try {
            return com.minimalistalliance.desk.agent.json.Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (com.minimalistalliance.desk.agent.json.JsonFormatException e) {
            return null;
        }
    }

    @FunctionalInterface
    private interface Write {
        void run(Connection connection) throws SQLException;
    }

    /**
     * One checkpoint write, in one transaction, only while the run can resume; past the cap its checkpoint goes instead
     * and {@link Full} is thrown.
     */
    private boolean write(String runId, long add, long cap, long at, Write work) throws SQLException {
        int[] outcome = {0};
        db().transaction(connection -> {
            long bytes;
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT bytes FROM runs WHERE run_id = ? AND resumable = 1 AND ended_at IS NULL")) {
                select.setString(1, runId);
                try (ResultSet r = select.executeQuery()) {
                    if (!r.next()) {
                        return null;
                    }
                    bytes = r.getLong(1);
                }
            }
            if (bytes + add > cap) {
                drop(connection, runId, "full", at);
                outcome[0] = 2;
                return null;
            }
            work.run(connection);
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE runs SET bytes = bytes + ? WHERE run_id = ?")) {
                update.setLong(1, add);
                update.setString(2, runId);
                update.executeUpdate();
            }
            outcome[0] = 1;
            return null;
        });
        if (outcome[0] == 2) {
            throw new Full();
        }
        return outcome[0] == 1;
    }

    /** The run can't resume any more: its checkpoint goes, its row stays as it is with {@code detail}. */
    private static void drop(Connection connection, String runId, String detail, long at) throws SQLException {
        try (PreparedStatement update = connection.prepareStatement("UPDATE runs SET resumable = 0, start = NULL,"
                + " book = NULL, bytes = 0, detail = ?, updated_at = ? WHERE run_id = ?")) {
            update.setString(1, detail);
            update.setLong(2, at);
            update.setString(3, runId);
            update.executeUpdate();
        }
        deleteCheckpoint(connection, runId);
    }

    private static void deleteCheckpoint(Connection connection, String runId) throws SQLException {
        for (String sql : List.of("DELETE FROM run_steps WHERE run_id = ?", "DELETE FROM run_results WHERE run_id = ?",
                "DELETE FROM run_waits WHERE run_id = ?")) {
            try (PreparedStatement delete = connection.prepareStatement(sql)) {
                delete.setString(1, runId);
                delete.executeUpdate();
            }
        }
    }

    /** The run can't resume (a write that couldn't go, attachments): its checkpoint goes. */
    public void unresumable(String runId, String detail, long at) throws SQLException {
        db().transaction(connection -> {
            drop(connection, runId, detail, at);
            return null;
        });
    }

    /** ADR 0020's state while it runs: {@code running}, {@code waiting_approval}, {@code waiting_<kind>}, {@code paused}. */
    public void state(String runId, String state, String detail, long at) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE runs SET state = ?, detail = ?,"
                    + " updated_at = ? WHERE run_id = ? AND ended_at IS NULL")) {
                update.setString(1, state);
                update.setString(2, detail);
                update.setLong(3, at);
                update.setString(4, runId);
                update.executeUpdate();
            }
            return null;
        });
    }

    /**
     * The run ended ({@code done}, {@code failed}, {@code stopped} or {@code interrupted}): its checkpoint goes, the
     * tool results with it, and its row keeps ids, the state and the resumes count until it's pruned.
     */
    public void ended(String runId, String state, String detail, long at) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE runs SET state = ?, detail = ?,"
                    + " resumable = 0, start = NULL, book = NULL, bytes = 0, updated_at = ?, ended_at = ?"
                    + " WHERE run_id = ?")) {
                update.setString(1, state);
                update.setString(2, detail);
                update.setLong(3, at);
                update.setLong(4, at);
                update.setString(5, runId);
                update.executeUpdate();
            }
            deleteCheckpoint(connection, runId);
            return null;
        });
    }

    /**
     * A reply whose run won't resume ends as every reply a restart left did before durable runs: {@code failed},
     * {@code unavailable}, {@code interrupted}, with the text and chips its steps wrote.
     */
    public void interruptReply(String messageId) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE messages SET state = 'failed', error ="
                    + " 'unavailable', error_detail = 'interrupted' WHERE id = ? AND state = 'streaming'")) {
                update.setString(1, messageId);
                update.executeUpdate();
            }
            return null;
        });
    }

    /**
     * At open: runs a restart left that can't resume (past the cap, a failed write, attachments, the kill switch) end
     * {@code interrupted}, as their replies did. @return how many
     */
    public int endUnresumable(long at) throws SQLException {
        return db().transaction(connection -> {
            int ended;
            try (PreparedStatement update = connection.prepareStatement("UPDATE runs SET state = 'interrupted',"
                    + " detail = COALESCE(detail, 'restart'), start = NULL, book = NULL, bytes = 0, updated_at = ?,"
                    + " ended_at = ? WHERE ended_at IS NULL AND resumable = 0")) {
                update.setLong(1, at);
                update.setLong(2, at);
                ended = update.executeUpdate();
            }
            // Nothing of an ended run's checkpoint stays: its steps, results and waits go with it (DR-L9).
            for (String sql : List.of("DELETE FROM run_steps WHERE run_id IN (SELECT run_id FROM runs WHERE"
                    + " ended_at IS NOT NULL)", "DELETE FROM run_results WHERE run_id IN (SELECT run_id FROM runs"
                    + " WHERE ended_at IS NOT NULL)", "DELETE FROM run_waits WHERE run_id NOT IN (SELECT run_id FROM"
                    + " runs WHERE ended_at IS NULL)")) {
                try (PreparedStatement delete = connection.prepareStatement(sql)) {
                    delete.executeUpdate();
                }
            }
            return ended;
        });
    }

    /** One more resume of the run, on its row and its reply's ({@code messages.resumed}). */
    public void resumed(String runId, String messageId, long at) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE runs SET resumes = resumes + 1,"
                    + " updated_at = ? WHERE run_id = ?")) {
                update.setLong(1, at);
                update.setString(2, runId);
                update.executeUpdate();
            }
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE messages SET resumed = COALESCE(resumed, 0) + 1 WHERE id = ?")) {
                update.setString(1, messageId);
                update.executeUpdate();
            }
            return null;
        });
    }

    public Run run(String runId) throws SQLException {
        List<Run> rows = runs("SELECT " + RUN_COLUMNS + " FROM runs WHERE run_id = ?", runId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The runs a restart left that can resume: not ended, resumable, their reply still streaming. Oldest first. */
    public List<Run> resumable() throws SQLException {
        return runs("SELECT " + prefixed() + " FROM runs r JOIN messages m ON m.id = r.message_id WHERE r.resumable = 1"
                + " AND r.ended_at IS NULL AND m.state = 'streaming' ORDER BY r.created_at, r.run_id");
    }

    /** Runs a restart left neither ended nor resumable: their replies ended interrupted at open. */
    public List<Run> unended() throws SQLException {
        return runs("SELECT " + RUN_COLUMNS + " FROM runs WHERE ended_at IS NULL AND resumable = 0"
                + " ORDER BY created_at, run_id");
    }

    public List<Step> steps(String runId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT step, plan, verdicts, planned_at"
                    + " FROM run_steps WHERE run_id = ? ORDER BY step")) {
                select.setString(1, runId);
                List<Step> out = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        out.add(new Step(r.getInt(1), r.getString(2), r.getString(3), r.getLong(4)));
                    }
                }
                return out;
            }
        });
    }

    public List<Result> results(String runId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT step, idx, result FROM run_results"
                    + " WHERE run_id = ? ORDER BY step, idx")) {
                select.setString(1, runId);
                List<Result> out = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        out.add(new Result(r.getInt(1), r.getInt(2), r.getString(3)));
                    }
                }
                return out;
            }
        });
    }

    /** How often each of these replies' runs was picked up after a restart, for those that were. */
    public Map<String, Integer> resumes(Collection<String> messageIds) throws SQLException {
        Map<String, Integer> out = new HashMap<>();
        if (messageIds.isEmpty()) {
            return out;
        }
        List<String> ids = List.copyOf(messageIds);
        return db().call(connection -> {
            for (int from = 0; from < ids.size(); from += 200) {
                List<String> part = ids.subList(from, Math.min(ids.size(), from + 200));
                StringBuilder marks = new StringBuilder();
                for (int i = 0; i < part.size(); i++) {
                    marks.append(i == 0 ? "?" : ", ?");
                }
                try (PreparedStatement select = connection.prepareStatement("SELECT id, resumed FROM messages WHERE"
                        + " resumed > 0 AND id IN (" + marks + ")")) {
                    for (int i = 0; i < part.size(); i++) {
                        select.setString(i + 1, part.get(i));
                    }
                    try (ResultSet r = select.executeQuery()) {
                        while (r.next()) {
                            out.put(r.getString(1), r.getInt(2));
                        }
                    }
                }
            }
            return out;
        });
    }

    /** Whether any reply was ever resumed, so a desk where none was reads nothing for it. */
    public boolean anyResumed() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT 1 FROM messages WHERE resumed > 0 LIMIT 1"); ResultSet r = select.executeQuery()) {
                return r.next();
            }
        });
    }

    /** Ended runs' rows older than {@code before} go. @return how many */
    public int prune(long before) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?")) {
                delete.setLong(1, before);
                return delete.executeUpdate();
            }
        });
    }

    // ---------------------------------------------------------------- waits

    /** A wait begins, or is the one already kept for this call: @return the kept one */
    public Wait await(Wait wait) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT OR IGNORE INTO run_waits (run_id,"
                    + " call_key, agent_id, kind, ref, state, deadline_at, answer, created_at)"
                    + " VALUES (?, ?, ?, ?, ?, 'waiting', ?, NULL, ?)")) {
                insert.setString(1, wait.runId());
                insert.setString(2, wait.callKey());
                insert.setString(3, wait.agentId());
                insert.setString(4, wait.kind());
                insert.setString(5, wait.ref());
                insert.setLong(6, wait.deadlineAt());
                insert.setLong(7, wait.createdAt());
                insert.executeUpdate();
            }
            return waitOf(connection, wait.runId(), wait.callKey());
        });
    }

    public Wait wait(String runId, String callKey) throws SQLException {
        return db().call(connection -> waitOf(connection, runId, callKey));
    }

    private static Wait waitOf(Connection connection, String runId, String callKey) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT run_id, call_key, agent_id, kind, ref,"
                + " state, deadline_at, answer, created_at FROM run_waits WHERE run_id = ? AND call_key = ?")) {
            select.setString(1, runId);
            select.setString(2, callKey);
            try (ResultSet r = select.executeQuery()) {
                return r.next() ? new Wait(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                        r.getString(5), r.getString(6), r.getLong(7), r.getString(8), r.getLong(9)) : null;
            }
        }
    }

    /**
     * An answer for every wait on {@code kind} and {@code ref} still waiting: kept with it. @return the waits it
     * answered
     */
    public List<Wait> answer(String agentId, String kind, String ref, String answer, long at) throws SQLException {
        return db().transaction(connection -> {
            List<Wait> answered = new ArrayList<>();
            // The agent's own wait, still in its time: a late answer, or one naming another agent's wait, takes none.
            try (PreparedStatement select = connection.prepareStatement("SELECT run_id, call_key FROM run_waits"
                    + " WHERE agent_id = ? AND kind = ? AND ref = ? AND state = 'waiting' AND deadline_at >= ?")) {
                select.setString(1, agentId);
                select.setString(2, kind);
                select.setString(3, ref);
                select.setLong(4, at);
                List<String[]> keys = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        keys.add(new String[] {r.getString(1), r.getString(2)});
                    }
                }
                for (String[] k : keys) {
                    try (PreparedStatement update = connection.prepareStatement("UPDATE run_waits SET state ="
                            + " 'answered', answer = ? WHERE run_id = ? AND call_key = ? AND state = 'waiting'")) {
                        update.setString(1, answer);
                        update.setString(2, k[0]);
                        update.setString(3, k[1]);
                        update.executeUpdate();
                    }
                    answered.add(waitOf(connection, k[0], k[1]));
                }
            }
            return answered;
        });
    }

    /** A run's waits, oldest first. */
    public List<Wait> waitsOf(String runId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT run_id, call_key, agent_id, kind, ref,"
                    + " state, deadline_at, answer, created_at FROM run_waits WHERE run_id = ? ORDER BY created_at")) {
                select.setString(1, runId);
                List<Wait> out = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        out.add(new Wait(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getString(6), r.getLong(7), r.getString(8), r.getLong(9)));
                    }
                }
                return out;
            }
        });
    }

    /**
     * The wait is over ({@code timed_out}, {@code taken}, {@code cancelled}); it stays until its run ends. Only from
     * {@code from}, so a wait an answer took can't then time out, and the reverse: one answer, one place.
     * @return whether it moved
     */
    public boolean waitState(String runId, String callKey, String from, String state) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE run_waits SET state = ? WHERE run_id = ? AND call_key = ? AND state = ?")) {
                update.setString(1, state);
                update.setString(2, runId);
                update.setString(3, callKey);
                update.setString(4, from);
                return update.executeUpdate() == 1;
            }
        });
    }

    // ---------------------------------------------------------------- reading

    private static String prefixed() {
        StringBuilder out = new StringBuilder();
        for (String column : RUN_COLUMNS.split(", ")) {
            if (!out.isEmpty()) {
                out.append(", ");
            }
            out.append("r.").append(column);
        }
        return out.toString();
    }

    private List<Run> runs(String sql, String... args) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(sql)) {
                for (int i = 0; i < args.length; i++) {
                    select.setString(i + 1, args[i]);
                }
                List<Run> rows = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        long ended = r.getLong(14);
                        Long endedAt = r.wasNull() ? null : ended;
                        rows.add(new Run(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getInt(6) == 1, r.getInt(7), r.getString(8), r.getString(9),
                                r.getLong(10), r.getInt(11), r.getLong(12), r.getLong(13), endedAt));
                    }
                }
                return rows;
            }
        });
    }
}
