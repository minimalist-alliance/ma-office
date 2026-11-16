package com.minimalistalliance.desk.agent.store;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Runs' rows in {@code agent.db} (durable runs, Design 1; the draft ADR "the Agent's tools and approvals", §3,
 * "Restarts"): additive, applied at every open and idempotent, as {@link ApprovalSchema} and {@link ToolSchema} are, so
 * {@code user_version} stays 1 and a desk-agent from before still opens the file.
 *
 * <ul>
 *   <li>{@code run_calls} (the seam): one row per tool call that runs, written before it's sent and settled when it
 *       comes back, so a kill in between leaves a trace. {@code key} is the call's own id and, for a call deskd runs,
 *       its idempotency key ({@code tcall}'s {@code key}). {@code approval_id} is the member's approval, or the gate's
 *       own id for a call done without asking ({@code auto} then names the switch's group). {@code state} is
 *       {@code started}, then {@code done}, {@code failed} or {@code interrupted}; {@code detail} one word. No
 *       arguments, result or content. The row goes with its agent, and a week after it settles.
 *   <li>{@code runs} (the resume): one row per run, ADR 0020's state ({@code running}, {@code waiting_approval},
 *       {@code waiting_<kind>}, {@code paused}; then {@code done}, {@code failed}, {@code stopped} or
 *       {@code interrupted}), and while it can resume, its start context: the instructions it was told, the thread it
 *       read, what started it, the run's taint and gate counts, its spend so far. {@code bytes} counts what its
 *       checkpoint holds, and past the cap {@code resumable} goes to 0 and the checkpoint goes: a restart then ends it
 *       {@code interrupted}, as before. Once it ends only the ids, the state and the resumes count stay, a week.
 *   <li>{@code run_steps}: a step's plan, written once its model call is back and before any of its calls runs (its
 *       text, its calls with their reasoning items, each call's class and payload as the policy judged it, or the
 *       answer it got before the gate), then the gate's verdicts once the step is admitted.
 *   <li>{@code run_results}: each call's result as the model reads it and its chip's fields, written in the same
 *       transaction as its record settles.
 *   <li>{@code run_waits}: a call waiting on something outside the run (an answer from another desk, §14), with its
 *       deadline and, once it comes, the answer: so a restart picks the wait up with what's left of its time.
 * </ul>
 *
 * <p><b>The migration</b> ({@link #migrate}): {@code messages} gains {@code resumed}, how often its run was picked up
 * after a restart, added once by {@code ALTER TABLE} when the column isn't there. A desk-agent from before reads and
 * writes {@code messages} by named columns, so it never sees it. And checkpoints a rollback left behind are dropped: a
 * run row whose reply isn't streaming any more (an older desk-agent ended it at its open) can't resume.
 *
 * <p>Steps, results and waits go with their run: when it ends, when its agent goes, and with {@code secure_delete}, so
 * the tool results a run read don't outlast it in the file.
 */
final class RunSchema {

    private RunSchema() {}

    static void apply(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS run_calls (
                      key TEXT PRIMARY KEY,
                      run_id TEXT NOT NULL,
                      agent_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      step INTEGER NOT NULL,
                      call_id TEXT NOT NULL,
                      tool TEXT NOT NULL,
                      risk TEXT NOT NULL,
                      host TEXT NOT NULL,
                      restart TEXT NOT NULL,
                      approval_id TEXT,
                      auto TEXT,
                      state TEXT NOT NULL,
                      detail TEXT,
                      started_at INTEGER NOT NULL,
                      settled_at INTEGER
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS run_calls_run ON run_calls (run_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS run_calls_state ON run_calls (state)");
            statement.execute("CREATE INDEX IF NOT EXISTS run_calls_agent ON run_calls (agent_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS run_calls_approval ON run_calls (approval_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS run_calls_settled ON run_calls (settled_at)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS runs (
                      run_id TEXT PRIMARY KEY,
                      agent_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      state TEXT NOT NULL,
                      detail TEXT,
                      resumable INTEGER NOT NULL DEFAULT 1,
                      step INTEGER NOT NULL DEFAULT 0,
                      start TEXT,
                      book TEXT,
                      bytes INTEGER NOT NULL DEFAULT 0,
                      resumes INTEGER NOT NULL DEFAULT 0,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL,
                      ended_at INTEGER
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS runs_message ON runs (message_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent_id)");
            statement.execute("CREATE INDEX IF NOT EXISTS runs_ended ON runs (ended_at)");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS run_steps (
                      run_id TEXT NOT NULL,
                      step INTEGER NOT NULL,
                      plan TEXT NOT NULL,
                      verdicts TEXT,
                      planned_at INTEGER NOT NULL,
                      PRIMARY KEY (run_id, step)
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS run_results (
                      run_id TEXT NOT NULL,
                      step INTEGER NOT NULL,
                      idx INTEGER NOT NULL,
                      result TEXT NOT NULL,
                      PRIMARY KEY (run_id, step, idx)
                    ) STRICT""");
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS run_waits (
                      run_id TEXT NOT NULL,
                      call_key TEXT NOT NULL,
                      agent_id TEXT NOT NULL,
                      kind TEXT NOT NULL,
                      ref TEXT NOT NULL,
                      state TEXT NOT NULL,
                      deadline_at INTEGER NOT NULL,
                      answer TEXT,
                      created_at INTEGER NOT NULL,
                      PRIMARY KEY (run_id, call_key)
                    ) STRICT""");
            statement.execute("CREATE INDEX IF NOT EXISTS run_waits_ref ON run_waits (kind, ref)");
        }
        migrate(connection);
    }

    /**
     * What a file from before needs, done once and safe to do again: {@code messages.resumed}, and checkpoints whose
     * reply an older desk-agent ended (a rollback, then this one again) dropped.
     */
    static void migrate(Connection connection) throws SQLException {
        boolean has = false;
        try (Statement statement = connection.createStatement();
                ResultSet columns = statement.executeQuery("PRAGMA table_info(messages)")) {
            while (columns.next()) {
                has |= "resumed".equals(columns.getString("name"));
            }
        }
        try (Statement statement = connection.createStatement()) {
            if (!has) {
                statement.execute("ALTER TABLE messages ADD COLUMN resumed INTEGER");
            }
            statement.execute("UPDATE runs SET resumable = 0, start = NULL, book = NULL, bytes = 0"
                    + " WHERE resumable = 1 AND ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages m"
                    + " WHERE m.id = runs.message_id AND m.state = 'streaming')");
            statement.execute("DELETE FROM run_steps WHERE run_id NOT IN (SELECT run_id FROM runs WHERE resumable = 1"
                    + " AND ended_at IS NULL)");
            statement.execute("DELETE FROM run_results WHERE run_id NOT IN (SELECT run_id FROM runs WHERE resumable = 1"
                    + " AND ended_at IS NULL)");
            statement.execute("DELETE FROM run_waits WHERE run_id NOT IN (SELECT run_id FROM runs WHERE ended_at IS"
                    + " NULL)");
        }
    }
}
