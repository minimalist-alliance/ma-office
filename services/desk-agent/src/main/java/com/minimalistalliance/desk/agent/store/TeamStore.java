package com.minimalistalliance.desk.agent.store;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.nio.charset.StandardCharsets;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Task 49's rows in {@code agent.db} (ADR 0047, {@link TeamSchema}): each agent's look, purpose, messaging and
 * workspace settings, the links between agents, the lead's proposals, the agent-message log and timers. Every write
 * names only the columns it changes, as {@link AgentStore}'s do.
 */
public final class TeamStore {

    /** An agent's task 49 settings. {@code workspaceMb} null follows the tier. */
    public record Extras(String id, String purpose, String icon, String tone, Integer pngVersion, boolean solo,
            Integer workspaceMb, List<String> sharedWith) {

        @Override
        public String toString() {
            return "Extras[" + id + ", " + icon + ", " + tone + ", solo " + solo + "]";
        }
    }

    public record Link(String from, String to, String rules, long createdAt) {
        @Override
        public String toString() {
            return "Link[" + from + " -> " + to + "]";
        }
    }

    /**
     * A lead's proposal. {@code origin} (JSON) is what started the run that made it; {@code before} (JSON, or null) is
     * the current state of what it changes, read when it was made. Neither is part of the hash.
     */
    public record ProposalRow(String id, String agentId, String messageId, String action, String summary,
            String payload, String sha256, String state, String detail, String result, long createdAt, long expiresAt,
            Long answeredAt, String runId, String origin, String before) {
        @Override
        public String toString() {
            return "ProposalRow[" + id + ", " + action + ", " + state + "]";
        }
    }

    public record A2aRow(String id, String from, String to, String chainId, int depth, String text, String rules,
            long at, String state, String reason, String reply, Long costMicroUsd, String runId) {
        @Override
        public String toString() {
            return "A2aRow[" + id + ", " + from + " -> " + to + ", " + state + " " + reason + "]";
        }
    }

    public record TimerRow(String id, String agentId, String label, String kind, String days, String time,
            Integer everyMinutes, Long atMs, String prompt, boolean enabled, Long nextMs, Long lastMs, String lastState,
            int retries, long spentMicroUsd, long createdAt) {
        @Override
        public String toString() {
            return "TimerRow[" + id + ", " + agentId + ", " + kind + ", next " + nextMs + "]";
        }
    }

    /**
     * Icon ids the library no longer has, each to the one that took its place (Design H4, M13). {@link TeamSchema}
     * moves stored rows once at open, and desk-agent maps one wherever it comes in.
     */
    public static final Map<String, String> RETIRED_ICONS = Map.of("globe", "plane", "chat", "person", "heart",
            "wallet", "star", "bulb", "puzzle", "terminal", "briefcase", "document");

    /** Tone ids the wheel no longer has, each to the one that took its place. */
    public static final Map<String, String> RETIRED_TONES = Map.of("moss", "green", "sky", "blue");

    private final AgentStore store;

    public TeamStore(AgentStore store) {
        this.store = store;
    }

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    // ---------------------------------------------------------------- agents

    private static final String EXTRAS = "SELECT id, purpose, icon, tone, png_version, solo, workspace_mb, shared_with"
            + " FROM agents";

    public Map<String, Extras> extras() throws SQLException {
        return db().call(connection -> {
            Map<String, Extras> all = new LinkedHashMap<>();
            try (PreparedStatement select = connection.prepareStatement(EXTRAS);
                    ResultSet r = select.executeQuery()) {
                while (r.next()) {
                    Extras e = extras(r);
                    all.put(e.id(), e);
                }
            }
            return all;
        });
    }

    public Extras extras(String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(EXTRAS + " WHERE id = ?")) {
                select.setString(1, id);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? extras(r) : null;
                }
            }
        });
    }

    private static Extras extras(ResultSet r) throws SQLException {
        long png = r.getLong(5);
        Integer pngVersion = r.wasNull() ? null : (int) png;
        long mb = r.getLong(7);
        Integer workspaceMb = r.wasNull() ? null : (int) mb;
        return new Extras(r.getString(1), r.getString(2), r.getString(3), r.getString(4), pngVersion,
                r.getInt(6) != 0, workspaceMb, stringList(r.getString(8)));
    }

    /** A new staff agent, with its settings, in one transaction. */
    public void createAgent(String id, String name, long at, Extras extras) throws SQLException {
        createAgent(id, name, at, extras, List.of());
    }

    /** A new staff agent, with its settings and its outgoing links, in one transaction. */
    public void createAgent(String id, String name, long at, Extras extras, Collection<Link> links)
            throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO agents (id, name, role,"
                    + " created_at, purpose, icon, tone, solo, workspace_mb) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, id);
                insert.setString(2, name);
                insert.setLong(3, at);
                insert.setString(4, extras.purpose());
                insert.setString(5, extras.icon());
                insert.setString(6, extras.tone());
                insert.setInt(7, extras.solo() ? 1 : 0);
                setInt(insert, 8, extras.workspaceMb());
                insert.executeUpdate();
            }
            for (Link link : links) {
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO links (from_id, to_id, rules, created_at) VALUES (?, ?, ?, ?)")) {
                    insert.setString(1, id);
                    insert.setString(2, link.to());
                    insert.setString(3, link.rules());
                    insert.setLong(4, at);
                    insert.executeUpdate();
                }
            }
            return null;
        });
    }

    /** Changes any of these; a null leaves that column. {@code clearWorkspaceMb} sets the tier's default back. */
    public void updateExtras(String id, String purpose, String icon, String tone, Boolean solo, Integer workspaceMb,
            boolean clearWorkspaceMb) throws SQLException {
        update("UPDATE agents SET purpose = COALESCE(?, purpose), icon = COALESCE(?, icon), tone = COALESCE(?, tone),"
                + " solo = COALESCE(?, solo), workspace_mb = CASE WHEN ? THEN NULL ELSE COALESCE(?, workspace_mb) END"
                + " WHERE id = ?", s -> {
                    s.setString(1, purpose);
                    s.setString(2, icon);
                    s.setString(3, tone);
                    if (solo == null) {
                        s.setNull(4, Types.INTEGER);
                    } else {
                        s.setInt(4, solo ? 1 : 0);
                    }
                    s.setInt(5, clearWorkspaceMb ? 1 : 0);
                    setInt(s, 6, workspaceMb);
                    s.setString(7, id);
                });
    }

    /**
     * Changes the name and any of these in one statement; a null leaves that column. A new icon drops an uploaded
     * one's version, as the library's icon is shown again. {@code clearWorkspaceMb} sets the tier's default back.
     */
    public void changeAgent(String id, String name, String purpose, String icon, String tone, Boolean solo,
            Integer workspaceMb, boolean clearWorkspaceMb) throws SQLException {
        update("UPDATE agents SET name = COALESCE(?, name), purpose = COALESCE(?, purpose), icon = COALESCE(?, icon),"
                + " png_version = CASE WHEN ? IS NULL THEN png_version ELSE NULL END, tone = COALESCE(?, tone),"
                + " solo = COALESCE(?, solo), workspace_mb = CASE WHEN ? THEN NULL ELSE COALESCE(?, workspace_mb) END"
                + " WHERE id = ?", s -> {
                    s.setString(1, name);
                    s.setString(2, purpose);
                    s.setString(3, icon);
                    s.setString(4, icon);
                    s.setString(5, tone);
                    if (solo == null) {
                        s.setNull(6, Types.INTEGER);
                    } else {
                        s.setInt(6, solo ? 1 : 0);
                    }
                    s.setInt(7, clearWorkspaceMb ? 1 : 0);
                    setInt(s, 8, workspaceMb);
                    s.setString(9, id);
                });
    }

    /** The uploaded icon's version, or null back to the library's. */
    public void setPng(String id, Integer version, String icon) throws SQLException {
        update("UPDATE agents SET png_version = ?, icon = ? WHERE id = ?", s -> {
            setInt(s, 1, version);
            s.setString(2, icon);
            s.setString(3, id);
        });
    }

    public void setSharedWith(String id, List<String> agents) throws SQLException {
        update("UPDATE agents SET shared_with = ? WHERE id = ?", s -> {
            s.setString(1, new String(Json.bytes(agents), StandardCharsets.UTF_8));
            s.setString(2, id);
        });
    }

    /**
     * Removes a staff agent and everything of it in {@code agent.db}, in one transaction: its thread, proposals, links
     * both ways, timers, and its id from every other agent's shares. The agent-message log keeps its rows, as the
     * audit log does.
     */
    public void deleteAgent(String id) throws SQLException {
        db().transaction(connection -> {
            for (String sql : List.of(
                    "DELETE FROM message_files WHERE message_id IN (SELECT id FROM messages WHERE agent_id = ?)",
                    "DELETE FROM messages WHERE agent_id = ?", "DELETE FROM proposals WHERE agent_id = ?",
                    "DELETE FROM links WHERE from_id = ? OR to_id = ?", "DELETE FROM timers WHERE agent_id = ?",
                    "DELETE FROM agents WHERE id = ? AND role = 'staff'")) {
                try (PreparedStatement delete = connection.prepareStatement(sql)) {
                    delete.setString(1, id);
                    if (sql.contains("OR to_id")) {
                        delete.setString(2, id);
                    }
                    delete.executeUpdate();
                }
            }
            List<String[]> shared = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement("SELECT id, shared_with FROM agents");
                    ResultSet r = select.executeQuery()) {
                while (r.next()) {
                    List<String> with = stringList(r.getString(2));
                    if (with.remove(id)) {
                        shared.add(new String[] {r.getString(1), new String(Json.bytes(with), StandardCharsets.UTF_8)});
                    }
                }
            }
            for (String[] row : shared) {
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE agents SET shared_with = ? WHERE id = ?")) {
                    update.setString(1, row[1]);
                    update.setString(2, row[0]);
                    update.executeUpdate();
                }
            }
            return null;
        });
    }

    // ---------------------------------------------------------------- links

    public List<Link> links() throws SQLException {
        return db().call(connection -> {
            List<Link> all = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT from_id, to_id, rules, created_at FROM links ORDER BY from_id, created_at, rowid");
                    ResultSet r = select.executeQuery()) {
                while (r.next()) {
                    all.add(new Link(r.getString(1), r.getString(2), r.getString(3), r.getLong(4)));
                }
            }
            return all;
        });
    }

    /** Replaces an agent's outgoing links and sets its solo flag, in one transaction. */
    public void setLinks(String from, boolean solo, Collection<Link> links) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement("DELETE FROM links WHERE from_id = ?")) {
                delete.setString(1, from);
                delete.executeUpdate();
            }
            for (Link link : links) {
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO links (from_id, to_id, rules, created_at) VALUES (?, ?, ?, ?)")) {
                    insert.setString(1, from);
                    insert.setString(2, link.to());
                    insert.setString(3, link.rules());
                    insert.setLong(4, link.createdAt());
                    insert.executeUpdate();
                }
            }
            try (PreparedStatement update = connection.prepareStatement("UPDATE agents SET solo = ? WHERE id = ?")) {
                update.setInt(1, solo ? 1 : 0);
                update.setString(2, from);
                if (update.executeUpdate() != 1) {
                    throw new SQLException("no such agent");
                }
            }
            return null;
        });
    }

    // ---------------------------------------------------------------- proposals

    private static final String PROPOSALS = "SELECT id, agent_id, message_id, action, summary, payload, sha256, state,"
            + " detail, result, created_at, expires_at, answered_at, run_id, origin, before_json FROM proposals";

    public void addProposal(ProposalRow p) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO proposals (id, agent_id,"
                    + " message_id, action, summary, payload, sha256, state, created_at, expires_at, run_id, origin,"
                    + " before_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, p.id());
                insert.setString(2, p.agentId());
                insert.setString(3, p.messageId());
                insert.setString(4, p.action());
                insert.setString(5, p.summary());
                insert.setString(6, p.payload());
                insert.setString(7, p.sha256());
                insert.setString(8, p.state());
                insert.setLong(9, p.createdAt());
                insert.setLong(10, p.expiresAt());
                insert.setString(11, p.runId());
                insert.setString(12, p.origin());
                insert.setString(13, p.before());
                insert.executeUpdate();
            }
            return null;
        });
    }

    /** Proposals still waiting for the member's answer: pending and not past their time. */
    public int pendingProposals(long nowMs) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT COUNT(*) FROM proposals WHERE state = 'pending' AND expires_at >= ?")) {
                select.setLong(1, nowMs);
                try (ResultSet r = select.executeQuery()) {
                    return r.getInt(1);
                }
            }
        });
    }

    /** How many proposals this run made. */
    public int proposalsOfRun(String runId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT COUNT(*) FROM proposals WHERE run_id = ?")) {
                select.setString(1, runId);
                try (ResultSet r = select.executeQuery()) {
                    return r.getInt(1);
                }
            }
        });
    }

    public boolean hasProposals() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT 1 FROM proposals LIMIT 1");
                    ResultSet r = select.executeQuery()) {
                return r.next();
            }
        });
    }

    public ProposalRow proposal(String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(PROPOSALS + " WHERE id = ?")) {
                select.setString(1, id);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? proposal(r) : null;
                }
            }
        });
    }

    /** Each message's proposals, oldest first. */
    public Map<String, List<ProposalRow>> proposalsFor(Collection<String> messageIds) throws SQLException {
        if (messageIds.isEmpty()) {
            return Map.of();
        }
        return db().call(connection -> {
            Map<String, List<ProposalRow>> byMessage = new HashMap<>();
            List<String> ids = List.copyOf(messageIds);
            for (int from = 0; from < ids.size(); from += 200) {
                List<String> batch = ids.subList(from, Math.min(ids.size(), from + 200));
                String marks = String.join(",", java.util.Collections.nCopies(batch.size(), "?"));
                try (PreparedStatement select = connection.prepareStatement(
                        PROPOSALS + " WHERE message_id IN (" + marks + ") ORDER BY created_at, rowid")) {
                    for (int i = 0; i < batch.size(); i++) {
                        select.setString(i + 1, batch.get(i));
                    }
                    try (ResultSet r = select.executeQuery()) {
                        while (r.next()) {
                            ProposalRow row = proposal(r);
                            byMessage.computeIfAbsent(row.messageId(), k -> new ArrayList<>()).add(row);
                        }
                    }
                }
            }
            return byMessage;
        });
    }

    /**
     * Answers a pending proposal: its new state, only if it is still {@code pending}. @return whether this call answered
     * it
     */
    public boolean answerProposal(String id, String state, String detail, String result, long at) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE proposals SET state = ?, detail = ?,"
                    + " result = ?, answered_at = ? WHERE id = ? AND state = 'pending'")) {
                update.setString(1, state);
                update.setString(2, detail);
                update.setString(3, result);
                update.setLong(4, at);
                update.setString(5, id);
                return update.executeUpdate() == 1;
            }
        });
    }

    /** A run's pending proposals expire, with this detail (the run was stopped). @return how many */
    public int expireRun(String runId, String detail, long at) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE proposals SET state = 'expired',"
                    + " detail = ?, answered_at = ? WHERE run_id = ? AND state = 'pending'")) {
                update.setString(1, detail);
                update.setLong(2, at);
                update.setString(3, runId);
                return update.executeUpdate();
            }
        });
    }

    /** Every proposal left {@code applying} (desk-agent stopped while one applied) becomes failed. @return their ids */
    public List<String> failApplying(String detail) throws SQLException {
        return db().transaction(connection -> {
            List<String> ids = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT id FROM proposals WHERE state = 'applying'"); ResultSet r = select.executeQuery()) {
                while (r.next()) {
                    ids.add(r.getString(1));
                }
            }
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE proposals SET state = 'failed', detail = ? WHERE state = 'applying'")) {
                update.setString(1, detail);
                update.executeUpdate();
            }
            return ids;
        });
    }

    /** Marks a claimed proposal's outcome, after {@link #answerProposal} took it to {@code applying}. */
    public void settleProposal(String id, String state, String detail, String result) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE proposals SET state = ?, detail = ?, result = ? WHERE id = ?")) {
                update.setString(1, state);
                update.setString(2, detail);
                update.setString(3, result);
                update.setString(4, id);
                update.executeUpdate();
            }
            return null;
        });
    }

    private static ProposalRow proposal(ResultSet r) throws SQLException {
        long answered = r.getLong(13);
        Long answeredAt = r.wasNull() ? null : answered;
        return new ProposalRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5),
                r.getString(6), r.getString(7), r.getString(8), r.getString(9), r.getString(10), r.getLong(11),
                r.getLong(12), answeredAt, r.getString(14), r.getString(15), r.getString(16));
    }

    // ---------------------------------------------------------------- the agent-message log

    private static final String A2A = "SELECT id, from_id, to_id, chain_id, depth, text, rules, at_ms, state, reason,"
            + " reply, cost_microusd, run_id FROM a2a";

    public void addA2a(A2aRow row) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO a2a (id, from_id, to_id, chain_id,"
                    + " depth, text, rules, at_ms, state, reason, reply, cost_microusd, run_id)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, row.id());
                insert.setString(2, row.from());
                insert.setString(3, row.to());
                insert.setString(4, row.chainId());
                insert.setInt(5, row.depth());
                insert.setString(6, row.text());
                insert.setString(7, row.rules());
                insert.setLong(8, row.at());
                insert.setString(9, row.state());
                insert.setString(10, row.reason());
                insert.setString(11, row.reply());
                setLong(insert, 12, row.costMicroUsd());
                insert.setString(13, row.runId());
                insert.executeUpdate();
            }
            return null;
        });
    }

    public void settleA2a(String id, String state, String reason, String reply, Long cost, String runId)
            throws SQLException {
        db().transaction(connection -> {
            // A cost already recorded when the run ended stays, so settling a stopped run never erases it.
            try (PreparedStatement update = connection.prepareStatement("UPDATE a2a SET state = ?, reason = ?,"
                    + " reply = ?, cost_microusd = COALESCE(?, cost_microusd), run_id = COALESCE(?, run_id)"
                    + " WHERE id = ?")) {
                update.setString(1, state);
                update.setString(2, reason);
                update.setString(3, reply);
                setLong(update, 4, cost);
                update.setString(5, runId);
                update.setString(6, id);
                update.executeUpdate();
            }
            return null;
        });
    }

    /** Messages from {@code from} to {@code to} since then that weren't refused: the rate limit's count. */
    public int a2aSent(String from, String to, long sinceMs) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT COUNT(*) FROM a2a WHERE from_id = ?"
                    + " AND to_id = ? AND at_ms >= ? AND state <> 'refused'")) {
                select.setString(1, from);
                select.setString(2, to);
                select.setLong(3, sinceMs);
                try (ResultSet r = select.executeQuery()) {
                    return r.getInt(1);
                }
            }
        });
    }

    /** What a message's run cost, whenever it ended: done, stopped or failed, so all of it counts toward the share. */
    public void a2aCost(String id, long costMicroUsd) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE a2a SET cost_microusd = ?"
                    + " WHERE id = ?")) {
                update.setLong(1, costMicroUsd);
                update.setString(2, id);
                update.executeUpdate();
            }
            return null;
        });
    }

    /** Messages between any two of the desk's agents since then that weren't refused: the desk-wide rate's count. */
    public int a2aSentDesk(long sinceMs) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT COUNT(*) FROM a2a WHERE at_ms >= ?"
                    + " AND state <> 'refused'")) {
                select.setLong(1, sinceMs);
                try (ResultSet r = select.executeQuery()) {
                    return r.getInt(1);
                }
            }
        });
    }

    /** What runs started by any agent's message cost since then, in µ$: the desk-wide share's spend. */
    public long a2aSpentDesk(long sinceMs) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT COALESCE(SUM(cost_microusd), 0)"
                    + " FROM a2a WHERE at_ms >= ?")) {
                select.setLong(1, sinceMs);
                try (ResultSet r = select.executeQuery()) {
                    return r.getLong(1);
                }
            }
        });
    }

    /** What runs started by messages to this agent cost since then, in µ$. */
    public long a2aSpent(String to, long sinceMs) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT COALESCE(SUM(cost_microusd), 0)"
                    + " FROM a2a WHERE to_id = ? AND at_ms >= ?")) {
                select.setString(1, to);
                select.setLong(2, sinceMs);
                try (ResultSet r = select.executeQuery()) {
                    return r.getLong(1);
                }
            }
        });
    }

    /** Newest first: every message to or from {@code agentId} (or all), older than {@code beforeMs}. */
    public List<A2aRow> a2a(String agentId, Long beforeMs, int limit) throws SQLException {
        return db().call(connection -> {
            StringBuilder sql = new StringBuilder(A2A).append(" WHERE 1 = 1");
            if (agentId != null) {
                sql.append(" AND (from_id = ? OR to_id = ?)");
            }
            if (beforeMs != null) {
                sql.append(" AND at_ms < ?");
            }
            sql.append(" ORDER BY at_ms DESC, rowid DESC LIMIT ?");
            try (PreparedStatement select = connection.prepareStatement(sql.toString())) {
                int at = 1;
                if (agentId != null) {
                    select.setString(at++, agentId);
                    select.setString(at++, agentId);
                }
                if (beforeMs != null) {
                    select.setLong(at++, beforeMs);
                }
                select.setInt(at, limit);
                List<A2aRow> rows = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        long cost = r.getLong(12);
                        Long costMicroUsd = r.wasNull() ? null : cost;
                        rows.add(new A2aRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getInt(5), r.getString(6), r.getString(7), r.getLong(8), r.getString(9),
                                r.getString(10), r.getString(11), costMicroUsd, r.getString(13)));
                    }
                }
                return rows;
            }
        });
    }

    /** The log's rows older than this go, as the usage ledger's do (100 days). */
    public int pruneA2a(long beforeMs) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement("DELETE FROM a2a WHERE at_ms < ?")) {
                delete.setLong(1, beforeMs);
                return delete.executeUpdate();
            }
        });
    }

    // ---------------------------------------------------------------- timers

    private static final String TIMERS = "SELECT id, agent_id, label, kind, days, time, every_minutes, at_ms, prompt,"
            + " enabled, next_ms, last_ms, last_state, retries, spent_microusd, created_at FROM timers";

    public List<TimerRow> timers(String agentId) throws SQLException {
        return db().call(connection -> {
            String sql = TIMERS + (agentId == null ? "" : " WHERE agent_id = ?") + " ORDER BY created_at, rowid";
            try (PreparedStatement select = connection.prepareStatement(sql)) {
                if (agentId != null) {
                    select.setString(1, agentId);
                }
                List<TimerRow> rows = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        rows.add(timer(r));
                    }
                }
                return rows;
            }
        });
    }

    public TimerRow timer(String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(TIMERS + " WHERE id = ?")) {
                select.setString(1, id);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? timer(r) : null;
                }
            }
        });
    }

    /** The enabled timers due at or before {@code nowMs}, soonest first. */
    public List<TimerRow> dueTimers(long nowMs) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(TIMERS
                    + " WHERE enabled = 1 AND next_ms IS NOT NULL AND next_ms <= ? ORDER BY next_ms, id")) {
                select.setLong(1, nowMs);
                List<TimerRow> rows = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        rows.add(timer(r));
                    }
                }
                return rows;
            }
        });
    }

    /** The soonest enabled timer's time, or null. */
    public Long nextTimerAt() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT MIN(next_ms) FROM timers WHERE enabled = 1 AND next_ms IS NOT NULL");
                    ResultSet r = select.executeQuery()) {
                long next = r.getLong(1);
                return r.wasNull() ? null : next;
            }
        });
    }

    /** Inserts or replaces a timer whole: its settings and its schedule. */
    public void putTimer(TimerRow t) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO timers (id, agent_id, label, kind,"
                    + " days, time, every_minutes, at_ms, prompt, enabled, next_ms, last_ms, last_state, retries,"
                    + " spent_microusd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    + " ON CONFLICT (id) DO UPDATE SET label = excluded.label, kind = excluded.kind, days = excluded.days,"
                    + " time = excluded.time, every_minutes = excluded.every_minutes, at_ms = excluded.at_ms,"
                    + " prompt = excluded.prompt, enabled = excluded.enabled, next_ms = excluded.next_ms,"
                    + " retries = excluded.retries")) {
                upsert.setString(1, t.id());
                upsert.setString(2, t.agentId());
                upsert.setString(3, t.label());
                upsert.setString(4, t.kind());
                upsert.setString(5, t.days());
                upsert.setString(6, t.time());
                setInt(upsert, 7, t.everyMinutes());
                setLong(upsert, 8, t.atMs());
                upsert.setString(9, t.prompt());
                upsert.setInt(10, t.enabled() ? 1 : 0);
                setLong(upsert, 11, t.nextMs());
                setLong(upsert, 12, t.lastMs());
                upsert.setString(13, t.lastState());
                upsert.setInt(14, t.retries());
                upsert.setLong(15, t.spentMicroUsd());
                upsert.setLong(16, t.createdAt());
                upsert.executeUpdate();
            }
            return null;
        });
    }

    /** After a fire: when it ran, how, the next time (or none), whether it's still on, and its retries. */
    public void timerFired(String id, long lastMs, String lastState, Long nextMs, boolean enabled, int retries)
            throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE timers SET last_ms = ?,"
                    + " last_state = ?, next_ms = ?, enabled = ?, retries = ? WHERE id = ?")) {
                update.setLong(1, lastMs);
                update.setString(2, lastState);
                setLong(update, 3, nextMs);
                update.setInt(4, enabled ? 1 : 0);
                update.setInt(5, retries);
                update.setString(6, id);
                update.executeUpdate();
            }
            return null;
        });
    }

    public void addTimerSpend(String id, long microUsd) throws SQLException {
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE timers SET spent_microusd = spent_microusd + ? WHERE id = ?")) {
                update.setLong(1, microUsd);
                update.setString(2, id);
                update.executeUpdate();
            }
            return null;
        });
    }

    public boolean deleteTimer(String agentId, String id) throws SQLException {
        return db().transaction(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM timers WHERE id = ? AND agent_id = ?")) {
                delete.setString(1, id);
                delete.setString(2, agentId);
                return delete.executeUpdate() == 1;
            }
        });
    }

    private static TimerRow timer(ResultSet r) throws SQLException {
        long every = r.getLong(7);
        Integer everyMinutes = r.wasNull() ? null : (int) every;
        long at = r.getLong(8);
        Long atMs = r.wasNull() ? null : at;
        long next = r.getLong(11);
        Long nextMs = r.wasNull() ? null : next;
        long last = r.getLong(12);
        Long lastMs = r.wasNull() ? null : last;
        return new TimerRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5),
                r.getString(6), everyMinutes, atMs, r.getString(9), r.getInt(10) != 0, nextMs, lastMs, r.getString(13),
                r.getInt(14), r.getLong(15), r.getLong(16));
    }

    // ---------------------------------------------------------------- messages

    /** One message, by id, or null. */
    public MessageRow message(String id) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT id, agent_id, role, text, at_ms,"
                    + " run_id, badge, usage, cost_microusd, stop_reason, state, error, error_detail, origin, tools"
                    + " FROM messages WHERE id = ?")) {
                select.setString(1, id);
                try (ResultSet r = select.executeQuery()) {
                    if (!r.next()) {
                        return null;
                    }
                    long cost = r.getLong(9);
                    Long costMicroUsd = r.wasNull() ? null : cost;
                    return new MessageRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                            r.getLong(5), r.getString(6), r.getString(7), r.getString(8), costMicroUsd,
                            r.getString(10), r.getString(11), r.getString(12), r.getString(13), r.getString(14),
                            r.getString(15));
                }
            }
        });
    }

    // ---------------------------------------------------------------- helpers

    @FunctionalInterface
    private interface Binder {
        void bind(PreparedStatement statement) throws SQLException;
    }

    private void update(String sql, Binder binder) throws SQLException {
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

    private static void setInt(PreparedStatement s, int index, Integer value) throws SQLException {
        if (value == null) {
            s.setNull(index, Types.INTEGER);
        } else {
            s.setInt(index, value);
        }
    }

    private static void setLong(PreparedStatement s, int index, Long value) throws SQLException {
        if (value == null) {
            s.setNull(index, Types.INTEGER);
        } else {
            s.setLong(index, value);
        }
    }

    /** A JSON list of strings; anything else reads as empty. */
    static List<String> stringList(String json) {
        List<String> out = new ArrayList<>();
        if (json == null || json.isEmpty()) {
            return out;
        }
        try {
            Object parsed = Json.parseObject(("{\"v\":" + json + "}").getBytes(StandardCharsets.UTF_8)).get("v");
            if (parsed instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof String s) {
                        out.add(s);
                    }
                }
            }
        } catch (JsonFormatException | RuntimeException e) {
            // Unreadable reads as empty: a share is only ever added by the member.
        }
        return out;
    }
}
