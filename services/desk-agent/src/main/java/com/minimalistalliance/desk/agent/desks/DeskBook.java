package com.minimalistalliance.desk.agent.desks;

import com.minimalistalliance.desk.agent.access.AccessBook;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.team.Canonical;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * desk-agent's rows for messages between the member's desks (draft ADR "the Agent's tools and approvals", §14;
 * {@code store/DeskSchema}): the answer halves and offers here, the outbox the office takes from, and the inbox that makes
 * every envelope count once. Each change is one transaction, so a kill leaves either all of it or none.
 *
 * <ul>
 *   <li><b>Exactly once in.</b> An envelope id already in the inbox is a {@code duplicate}: nothing is done again. One at
 *       or below the last {@code seq} taken on its grant is {@code stale}, so order holds per pair whatever the office
 *       does. The inbox row, the {@code seq}, and what the envelope changes (an offer, an accept, a revoke, a message to
 *       answer) go in one transaction.
 *   <li><b>Exactly once out.</b> An envelope goes in the outbox by its id ({@code INSERT OR IGNORE}), so deskd's push of
 *       one asked again, or a tool's result asked again by its key, adds nothing. The office marks it done; one not taken
 *       in 7 days is {@code expired}.
 *   <li><b>Each desk checks its own half.</b> A message is taken only on an active answer half from the agent the offer
 *       named; an answer only on an active send half, so a desk refuses an answer on a half it has revoked. deskd checked
 *       its own record first; this is desk-agent's own second check.
 * </ul>
 * Nothing here logs content, a name or a desk.
 */
public final class DeskBook {

    static final long WEEK_MS = 7L * 24 * 60 * 60 * 1000;
    static final long DAY_MS = 24L * 60 * 60 * 1000;
    /** Messages taken in on one grant a day, and answers (draft ADR §14's {@code rate}). */
    static final int PER_DAY = 20;
    static final int TAKE_MAX = 100;
    private static final Pattern GRANT_ID = Pattern.compile("dg-[a-z2-7]{20}");
    private static final Pattern ENV_ID = Pattern.compile("env-[a-z2-7]{26}");
    private static final Pattern DESK_ID = Pattern.compile("[a-z0-9-]{1,64}");
    private static final Set<String> ANSWER_STATES = Set.of("offered", "declined", "active", "revoked");

    /** An answer half here, or an offer waiting here. */
    public record AnswerHalf(String grantId, String fromDeskId, String fromAgentId, String fromAgentName, String agentId,
            String state, long createdAt, Long lastUsedAt, int count) {

        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("grantId", grantId);
            out.put("fromDeskId", fromDeskId);
            out.put("fromAgentId", fromAgentId);
            out.put("fromAgentName", fromAgentName);
            out.put("agentId", agentId);
            out.put("state", state);
            out.put("createdAt", createdAt);
            out.put("lastUsedAt", lastUsedAt);
            out.put("count", count);
            return out;
        }

        public boolean active() {
            return "active".equals(state);
        }

        @Override
        public String toString() {
            return "AnswerHalf[" + state + "]";
        }
    }

    /** One envelope of the outbox. {@code agentId} is whose it is: X for a message, Y for an answer. */
    public record OutRow(String envId, String grantId, String toDeskId, String kind, long seq, String envelope,
            String agentId, String replyTo, long createdAt, String state, String reason) {
        @Override
        public String toString() {
            return "OutRow[" + kind + ", " + state + "]";
        }
    }

    /**
     * What a delivery came to, for {@link DeskMessages} to act on once it's committed.
     *
     * @param outcome {@code delivered} or {@code duplicate}
     * @param kind the envelope's kind
     * @param opened deskd's view of it, for a message or an answer
     * @param agentId the agent here it's for: Y for a message, X for an answer, the half's agent for the rest
     */
    public record Delivered(String outcome, String envId, String kind, String grantId, Map<String, Object> opened,
            String agentId) {
        public boolean fresh() {
            return "delivered".equals(outcome);
        }
    }

    /** What the office's {@code done} came to: rows refused, and grants the other desk said are revoked. */
    public record Done(int done, List<OutRow> refused, List<String> revoked) {}

    /** An inbox row waiting to be handled: a message to answer, or one being answered. */
    public record InRow(String envId, String grantId, String fromDeskId, String kind, String agentId, String replyTo,
            Map<String, Object> body, String state, String runId, long sentAt) {
        @Override
        public String toString() {
            return "InRow[" + kind + ", " + state + "]";
        }
    }

    private final AgentStore store;

    public DeskBook(AgentStore store) {
        this.store = Objects.requireNonNull(store);
    }

    private SqliteDatabase db() throws SQLException {
        return store.database();
    }

    // ---------------------------------------------------------------- the outbox

    /** Envelopes deskd made, into the outbox, each once by its id. @return the ids the outbox has now */
    public List<String> queue(List<OutRow> rows) throws SQLException {
        return db().transaction(connection -> {
            List<String> have = new ArrayList<>();
            for (OutRow row : rows) {
                try (PreparedStatement insert = connection.prepareStatement("INSERT OR IGNORE INTO desk_outbox (env_id,"
                        + " grant_id, to_desk_id, kind, seq, envelope, agent_id, reply_to, created_at, state)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')")) {
                    insert.setString(1, row.envId());
                    insert.setString(2, row.grantId());
                    insert.setString(3, row.toDeskId());
                    insert.setString(4, row.kind());
                    insert.setLong(5, row.seq());
                    insert.setString(6, row.envelope());
                    setNullable(insert, 7, row.agentId());
                    setNullable(insert, 8, row.replyTo());
                    insert.setLong(9, row.createdAt());
                    insert.executeUpdate();
                }
                have.add(row.envId());
            }
            return have;
        });
    }

    /**
     * What waits for {@code toDeskId}, oldest first, at most {@code limit}; and whether there's more. Rows past 7 days
     * have been expired first ({@link #expire}), so the office never carries one.
     */
    public List<OutRow> take(String toDeskId, int limit) throws SQLException {
        int n = Math.max(1, Math.min(limit, TAKE_MAX));
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT " + OUT_COLUMNS
                    + " FROM desk_outbox WHERE state = 'queued' AND to_desk_id = ? ORDER BY rowid LIMIT ?")) {
                select.setString(1, toDeskId);
                select.setInt(2, n + 1);
                return outRows(select);
            }
        });
    }

    /** What waits, by desk: {@code [{toDeskId, count, oldestAt}]}. Never content. */
    public List<Map<String, Object>> pending() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT to_desk_id, COUNT(*), MIN(created_at)"
                    + " FROM desk_outbox WHERE state = 'queued' GROUP BY to_desk_id ORDER BY to_desk_id")) {
                List<Map<String, Object>> out = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("toDeskId", r.getString(1));
                        row.put("count", r.getInt(2));
                        row.put("oldestAt", r.getLong(3));
                        out.add(row);
                    }
                }
                return out;
            }
        });
    }

    /**
     * The office's {@code done}: each id {@code delivered} (or {@code duplicate}, already there), or {@code refused} with
     * the other desk's word. Only a queued row changes; the rest are already done. A refusal {@code revoked} names a grant
     * the other desk revoked: this desk's half goes too ({@link Done#revoked}).
     */
    public Done done(List<Map<String, Object>> results, long now) throws SQLException {
        return db().transaction(connection -> {
            int done = 0;
            List<OutRow> refused = new ArrayList<>();
            List<String> revoked = new ArrayList<>();
            for (Map<String, Object> result : results) {
                String id = (String) result.get("id");
                String outcome = (String) result.get("outcome");
                String reason = result.get("reason") instanceof String r ? r : null;
                OutRow row = outRow(connection, id);
                if (row == null || !"queued".equals(row.state())) {
                    continue;
                }
                boolean ok = "delivered".equals(outcome) || "duplicate".equals(outcome);
                try (PreparedStatement update = connection.prepareStatement("UPDATE desk_outbox SET state = ?,"
                        + " reason = ?, done_at = ? WHERE env_id = ? AND state = 'queued'")) {
                    update.setString(1, ok ? "delivered" : "refused");
                    setNullable(update, 2, ok ? null : reason);
                    update.setLong(3, now);
                    update.setString(4, id);
                    done += update.executeUpdate();
                }
                if (!ok) {
                    refused.add(new OutRow(row.envId(), row.grantId(), row.toDeskId(), row.kind(), row.seq(), null,
                            row.agentId(), row.replyTo(), row.createdAt(), "refused", reason));
                    if ("revoked".equals(reason) && !revoked.contains(row.grantId())) {
                        revoked.add(row.grantId());
                        revokeHalves(connection, row.grantId(), now);
                    }
                }
            }
            return new Done(done, refused, revoked);
        });
    }

    /** Queued rows past 7 days: {@code expired}, never carried late. @return them, for the threads' notices */
    public List<OutRow> expire(long now) throws SQLException {
        return db().transaction(connection -> {
            List<OutRow> rows;
            try (PreparedStatement select = connection.prepareStatement("SELECT " + OUT_COLUMNS
                    + " FROM desk_outbox WHERE state = 'queued' AND created_at <= ?")) {
                select.setLong(1, now - WEEK_MS);
                rows = outRows(select);
            }
            try (PreparedStatement update = connection.prepareStatement("UPDATE desk_outbox SET state = 'expired',"
                    + " done_at = ? WHERE state = 'queued' AND created_at <= ?")) {
                update.setLong(1, now);
                update.setLong(2, now - WEEK_MS);
                update.executeUpdate();
            }
            // Settled a week ago: the record goes. Envelopes past 7 days are refused anyway, so no dedupe needs them.
            for (String sql : List.of("DELETE FROM desk_outbox WHERE state <> 'queued' AND done_at <= ?",
                    "DELETE FROM desk_inbox WHERE received_at <= ? AND state IN ('done', 'answered', 'failed',"
                            + " 'posted', 'taken')")) {
                try (PreparedStatement delete = connection.prepareStatement(sql)) {
                    delete.setLong(1, now - WEEK_MS - DAY_MS);
                    delete.executeUpdate();
                }
            }
            return rows;
        });
    }

    /** One outbox row by id, or null. */
    public OutRow out(String envId) throws SQLException {
        return db().call(connection -> outRow(connection, envId));
    }

    /** Messages sent on the grant in the last day, for the sender's cap. */
    public int sentToday(String grantId, long now) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT COUNT(*) FROM desk_outbox"
                    + " WHERE grant_id = ? AND kind = 'msg' AND created_at > ?")) {
                select.setString(1, grantId);
                select.setLong(2, now - DAY_MS);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? r.getInt(1) : 0;
                }
            }
        });
    }

    // ---------------------------------------------------------------- the inbox

    /**
     * deskd's view of an envelope it checked ({@code desk.desks.deliver}), taken in once. The second check of this desk's
     * half is here, and the order per pair: refused {@code stale}, {@code revoked}, {@code no_grant} or {@code rate},
     * with nothing changed.
     */
    public Delivered deliver(Map<String, Object> opened, long now) throws RpcError, SQLException {
        String envId = str(opened, "id");
        String kind = str(opened, "kind");
        String grantId = str(opened, "grantId");
        String fromDesk = str(opened, "fromDeskId");
        if (envId == null || !ENV_ID.matcher(envId).matches() || kind == null || grantId == null
                || !GRANT_ID.matcher(grantId).matches() || fromDesk == null || !DESK_ID.matcher(fromDesk).matches()
                || !(opened.get("seq") instanceof Number seqN) || !(opened.get("sentAt") instanceof Number sentN)) {
            throw RpcError.of("bad_request", "reason", "envelope");
        }
        long seq = seqN.longValue();
        long sentAt = sentN.longValue();
        Refusal[] refusal = new Refusal[1];
        Delivered result = db().transaction(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT kind, agent_id FROM desk_inbox WHERE env_id = ?")) {
                select.setString(1, envId);
                try (ResultSet r = select.executeQuery()) {
                    if (r.next()) {
                        return new Delivered("duplicate", envId, r.getString(1), grantId, opened, r.getString(2));
                    }
                }
            }
            long last = lastSeq(connection, grantId);
            if (seq <= last) {
                refusal[0] = new Refusal("conflict", "stale");
                return null;
            }
            String agentId = null;
            String state = "done";
            String replyTo = null;
            Map<String, Object> body = null;
            switch (kind) {
                case "offer" -> {
                    AnswerHalf half = answerHalf(connection, grantId);
                    if (half != null && "revoked".equals(half.state())) {
                        refusal[0] = new Refusal("forbidden", "revoked");
                        return null;
                    }
                    if (half == null) {
                        String fromAgent = str(opened, "fromAgentId");
                        if (fromAgent == null) {
                            refusal[0] = new Refusal("bad_request", "envelope");
                            return null;
                        }
                        insertAnswerHalf(connection, new AnswerHalf(grantId, fromDesk, fromAgent,
                                str(opened, "fromAgentName"), null, "offered", now, null, 0), now);
                    }
                }
                case "accept" -> {
                    AccessBook.SendHalf half = sendHalf(connection, grantId);
                    if (half == null || !half.toDeskId().equals(fromDesk)) {
                        refusal[0] = new Refusal("forbidden", "no_grant");
                        return null;
                    }
                    if ("revoked".equals(half.state())) {
                        refusal[0] = new Refusal("forbidden", "revoked");
                        return null;
                    }
                    agentId = half.agentId();
                    try (PreparedStatement update = connection.prepareStatement("UPDATE desk_grants SET state = 'active',"
                            + " to_agent_id = ?, to_agent_name = ?, updated_at = ?, sha256 = ? WHERE grant_id = ?")) {
                        update.setString(1, str(opened, "answeredBy"));
                        setNullable(update, 2, str(opened, "answeredByName"));
                        update.setLong(3, now);
                        update.setString(4, AccessBook.halfHash(grantId, half.agentId(), half.toDeskId(), "active"));
                        update.setString(5, grantId);
                        update.executeUpdate();
                    }
                }
                case "revoke" -> {
                    agentId = revokeHalves(connection, grantId, now);
                }
                case "msg" -> {
                    AnswerHalf half = answerHalf(connection, grantId);
                    if (half == null || !half.fromDeskId().equals(fromDesk)) {
                        refusal[0] = new Refusal("forbidden", "no_grant");
                        return null;
                    }
                    if ("revoked".equals(half.state())) {
                        refusal[0] = new Refusal("forbidden", "revoked");
                        return null;
                    }
                    if (!half.active() || half.agentId() == null
                            || !half.fromAgentId().equals(str(opened, "fromAgentId"))) {
                        refusal[0] = new Refusal("forbidden", "no_grant");
                        return null;
                    }
                    if (countIn(connection, grantId, "msg", now) >= PER_DAY) {
                        refusal[0] = new Refusal("forbidden", "rate");
                        return null;
                    }
                    agentId = half.agentId();
                    state = "received";
                    body = new LinkedHashMap<>();
                    body.put("text", str(opened, "text"));
                    body.put("fromAgentName", str(opened, "fromAgentName"));
                    // The sending run held the member's private data on its desk (DMA-M1): the answering run starts S too.
                    body.put("private", Boolean.TRUE.equals(opened.get("private")));
                    try (PreparedStatement update = connection.prepareStatement("UPDATE desk_answers SET"
                            + " count = count + 1, last_used_at = ? WHERE grant_id = ?")) {
                        update.setLong(1, now);
                        update.setString(2, grantId);
                        update.executeUpdate();
                    }
                }
                case "answer" -> {
                    AccessBook.SendHalf half = sendHalf(connection, grantId);
                    if (half == null || !half.toDeskId().equals(fromDesk)) {
                        refusal[0] = new Refusal("forbidden", "no_grant");
                        return null;
                    }
                    if ("revoked".equals(half.state())) {
                        // A desk refuses an answer on a half it has revoked (Security's Q7).
                        refusal[0] = new Refusal("forbidden", "revoked");
                        return null;
                    }
                    replyTo = str(opened, "replyTo");
                    OutRow asked = replyTo == null ? null : outRow(connection, replyTo);
                    if (asked == null || !"msg".equals(asked.kind()) || !grantId.equals(asked.grantId())) {
                        refusal[0] = new Refusal("bad_request", "envelope");
                        return null;
                    }
                    if (countIn(connection, grantId, "answer", now) >= PER_DAY) {
                        refusal[0] = new Refusal("forbidden", "rate");
                        return null;
                    }
                    agentId = half.agentId();
                    state = "arrived";
                    body = new LinkedHashMap<>();
                    body.put("text", str(opened, "text"));
                    body.put("failed", str(opened, "failed"));
                    body.put("private", Boolean.TRUE.equals(opened.get("private")));
                    body.put("answeredBy", str(opened, "answeredBy"));
                    body.put("answeredByName", str(opened, "answeredByName"));
                }
                default -> {
                    refusal[0] = new Refusal("bad_request", "envelope");
                    return null;
                }
            }
            try (PreparedStatement insert = connection.prepareStatement("INSERT INTO desk_inbox (env_id, grant_id,"
                    + " from_desk_id, kind, seq, sent_at, received_at, agent_id, reply_to, body, state)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, envId);
                insert.setString(2, grantId);
                insert.setString(3, fromDesk);
                insert.setString(4, kind);
                insert.setLong(5, seq);
                insert.setLong(6, sentAt);
                insert.setLong(7, now);
                setNullable(insert, 8, agentId);
                setNullable(insert, 9, replyTo);
                setNullable(insert, 10, body == null ? null : json(body));
                insert.setString(11, state);
                insert.executeUpdate();
            }
            try (PreparedStatement upsert = connection.prepareStatement("INSERT INTO desk_seq (grant_id, last)"
                    + " VALUES (?, ?) ON CONFLICT (grant_id) DO UPDATE SET last = excluded.last")) {
                upsert.setString(1, grantId);
                upsert.setLong(2, seq);
                upsert.executeUpdate();
            }
            return new Delivered("delivered", envId, kind, grantId, opened, agentId);
        });
        if (refusal[0] != null) {
            throw RpcError.of(refusal[0].code(), "reason", refusal[0].reason());
        }
        return result;
    }

    private record Refusal(String code, String reason) {}

    /** An inbox row's state: a message {@code running} (with its run), {@code answered} or {@code failed}; an answer {@code taken} or {@code posted}. Its text goes once it's settled. */
    public void settle(String envId, String state, String runId, long now) throws SQLException {
        boolean settled = Set.of("answered", "failed", "taken", "posted", "done").contains(state);
        db().transaction(connection -> {
            try (PreparedStatement update = connection.prepareStatement("UPDATE desk_inbox SET state = ?,"
                    + " run_id = COALESCE(?, run_id), settled_at = ?, body = CASE WHEN ? THEN NULL ELSE body END"
                    + " WHERE env_id = ?")) {
                update.setString(1, state);
                setNullable(update, 2, runId);
                if (settled) {
                    update.setLong(3, now);
                } else {
                    update.setNull(3, Types.INTEGER);
                }
                update.setBoolean(4, settled);
                update.setString(5, envId);
                update.executeUpdate();
            }
            return null;
        });
    }

    /** Inbox rows in one of these states, oldest first: messages to start, or left running at a restart. */
    public List<InRow> inbox(String kind, String state) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT env_id, grant_id, from_desk_id, kind,"
                    + " agent_id, reply_to, body, state, run_id, sent_at FROM desk_inbox WHERE kind = ? AND state = ?"
                    + " ORDER BY received_at, rowid")) {
                select.setString(1, kind);
                select.setString(2, state);
                List<InRow> out = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        out.add(new InRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                                r.getString(5), r.getString(6), parse(r.getString(7)), r.getString(8), r.getString(9),
                                r.getLong(10)));
                    }
                }
                return out;
            }
        });
    }

    /** One inbox row, or null. */
    public InRow in(String envId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT env_id, grant_id, from_desk_id, kind,"
                    + " agent_id, reply_to, body, state, run_id, sent_at FROM desk_inbox WHERE env_id = ?")) {
                select.setString(1, envId);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? new InRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                            r.getString(5), r.getString(6), parse(r.getString(7)), r.getString(8), r.getString(9),
                            r.getLong(10)) : null;
                }
            }
        });
    }

    // ---------------------------------------------------------------- answer halves

    /** Offers waiting here ({@code offered}, {@code declined}) and answer halves ({@code active}). */
    public List<AnswerHalf> answerHalves() throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement("SELECT " + ANSWER_COLUMNS
                    + " FROM desk_answers WHERE state <> 'revoked' ORDER BY created_at, grant_id")) {
                List<AnswerHalf> out = new ArrayList<>();
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        AnswerHalf h = answerHalf(r);
                        if (h != null) {
                            out.add(h);
                        }
                    }
                }
                return out;
            }
        });
    }

    public AnswerHalf answerHalf(String grantId) throws SQLException {
        return db().call(connection -> answerHalf(connection, grantId));
    }

    /**
     * The member allowed an offer here with {@code agentId} answering: {@code active}. Refused {@code not_found} for no
     * such offer, or one revoked.
     */
    public AnswerHalf allow(String grantId, String agentId, long now) throws RpcError, SQLException {
        AnswerHalf after = db().transaction(connection -> {
            AnswerHalf half = answerHalf(connection, grantId);
            if (half == null || "revoked".equals(half.state())) {
                return null;
            }
            writeAnswerState(connection, grantId, half, agentId, "active", now);
            return answerHalf(connection, grantId);
        });
        if (after == null) {
            throw RpcError.notFound("grant");
        }
        return after;
    }

    /** Not now: {@code declined}, still listed, nothing sent. */
    public AnswerHalf decline(String grantId, long now) throws RpcError, SQLException {
        AnswerHalf after = db().transaction(connection -> {
            AnswerHalf half = answerHalf(connection, grantId);
            if (half == null || !"offered".equals(half.state())) {
                return half == null || "revoked".equals(half.state()) ? null : half;
            }
            writeAnswerState(connection, grantId, half, null, "declined", now);
            return answerHalf(connection, grantId);
        });
        if (after == null) {
            throw RpcError.notFound("grant");
        }
        return after;
    }

    /** The member's Stop of an answer half here: {@code revoked}. @return the half before, or null for none live */
    public AnswerHalf revokeAnswer(String grantId, long now) throws SQLException {
        return db().transaction(connection -> {
            AnswerHalf half = answerHalf(connection, grantId);
            if (half == null || "revoked".equals(half.state())) {
                return null;
            }
            writeAnswerState(connection, grantId, half, half.agentId(), "revoked", now);
            return half;
        });
    }

    /** Every live answer half an agent answers, revoked: the agent was deleted. @return their grants */
    public List<String> agentGone(String agentId, long now) throws SQLException {
        return db().transaction(connection -> {
            List<String> grants = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement("SELECT grant_id FROM desk_answers"
                    + " WHERE agent_id = ? AND state <> 'revoked'")) {
                select.setString(1, agentId);
                try (ResultSet r = select.executeQuery()) {
                    while (r.next()) {
                        grants.add(r.getString(1));
                    }
                }
            }
            for (String grantId : grants) {
                AnswerHalf half = answerHalf(connection, grantId);
                if (half != null) {
                    writeAnswerState(connection, grantId, half, agentId, "revoked", now);
                }
            }
            return grants;
        });
    }

    // ---------------------------------------------------------------- inside a transaction

    private static final String OUT_COLUMNS = "env_id, grant_id, to_desk_id, kind, seq, envelope, agent_id, reply_to,"
            + " created_at, state, reason";
    private static final String ANSWER_COLUMNS = "grant_id, from_desk_id, from_agent_id, from_agent_name, agent_id,"
            + " state, created_at, last_used_at, count, sha256";

    private static List<OutRow> outRows(PreparedStatement select) throws SQLException {
        List<OutRow> out = new ArrayList<>();
        try (ResultSet r = select.executeQuery()) {
            while (r.next()) {
                out.add(outRow(r));
            }
        }
        return out;
    }

    private static OutRow outRow(ResultSet r) throws SQLException {
        return new OutRow(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getLong(5), r.getString(6),
                r.getString(7), r.getString(8), r.getLong(9), r.getString(10), r.getString(11));
    }

    private static OutRow outRow(Connection connection, String envId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT " + OUT_COLUMNS
                + " FROM desk_outbox WHERE env_id = ?")) {
            select.setString(1, envId);
            try (ResultSet r = select.executeQuery()) {
                return r.next() ? outRow(r) : null;
            }
        }
    }

    private static long lastSeq(Connection connection, String grantId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT last FROM desk_seq WHERE grant_id = ?")) {
            select.setString(1, grantId);
            try (ResultSet r = select.executeQuery()) {
                return r.next() ? r.getLong(1) : 0;
            }
        }
    }

    private static int countIn(Connection connection, String grantId, String kind, long now) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT COUNT(*) FROM desk_inbox"
                + " WHERE grant_id = ? AND kind = ? AND received_at > ?")) {
            select.setString(1, grantId);
            select.setString(2, kind);
            select.setLong(3, now - DAY_MS);
            try (ResultSet r = select.executeQuery()) {
                return r.next() ? r.getInt(1) : 0;
            }
        }
    }

    /** The answer half's hash: over what decides whether it's in force. */
    static String answerHash(String grantId, String fromDeskId, String fromAgentId, String agentId, String state) {
        Map<String, Object> bound = new LinkedHashMap<>();
        bound.put("v", 1);
        bound.put("grantId", grantId);
        bound.put("fromDeskId", fromDeskId);
        bound.put("fromAgentId", fromAgentId);
        bound.put("agentId", agentId);
        bound.put("state", state);
        return Canonical.sha256(bound);
    }

    private static AnswerHalf answerHalf(Connection connection, String grantId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT " + ANSWER_COLUMNS
                + " FROM desk_answers WHERE grant_id = ?")) {
            select.setString(1, grantId);
            try (ResultSet r = select.executeQuery()) {
                return r.next() ? answerHalf(r) : null;
            }
        }
    }

    /** A row, or null for one whose hash doesn't match: no half. */
    private static AnswerHalf answerHalf(ResultSet r) throws SQLException {
        String grantId = r.getString(1);
        String state = r.getString(6);
        if (!ANSWER_STATES.contains(state) || !answerHash(grantId, r.getString(2), r.getString(3), r.getString(5), state)
                .equals(r.getString(10))) {
            return null;
        }
        long last = r.getLong(8);
        Long lastUsed = r.wasNull() ? null : last;
        return new AnswerHalf(grantId, r.getString(2), r.getString(3), r.getString(4), r.getString(5), state,
                r.getLong(7), lastUsed, r.getInt(9));
    }

    private static void insertAnswerHalf(Connection connection, AnswerHalf half, long now) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("INSERT INTO desk_answers (grant_id, from_desk_id,"
                + " from_agent_id, from_agent_name, agent_id, state, created_at, updated_at, last_used_at, count, sha256)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)")) {
            insert.setString(1, half.grantId());
            insert.setString(2, half.fromDeskId());
            insert.setString(3, half.fromAgentId());
            setNullable(insert, 4, half.fromAgentName());
            setNullable(insert, 5, half.agentId());
            insert.setString(6, half.state());
            insert.setLong(7, now);
            insert.setLong(8, now);
            insert.setString(9, answerHash(half.grantId(), half.fromDeskId(), half.fromAgentId(), half.agentId(),
                    half.state()));
            insert.executeUpdate();
        }
    }

    private static void writeAnswerState(Connection connection, String grantId, AnswerHalf half, String agentId,
            String state, long now) throws SQLException {
        try (PreparedStatement update = connection.prepareStatement("UPDATE desk_answers SET agent_id = ?, state = ?,"
                + " updated_at = ?, sha256 = ? WHERE grant_id = ?")) {
            setNullable(update, 1, agentId);
            update.setString(2, state);
            update.setLong(3, now);
            update.setString(4, answerHash(grantId, half.fromDeskId(), half.fromAgentId(), agentId, state));
            update.setString(5, grantId);
            update.executeUpdate();
        }
    }

    /** A send half, read as {@link AccessBook} reads it: null for one whose hash doesn't match. */
    private static AccessBook.SendHalf sendHalf(Connection connection, String grantId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("SELECT grant_id, agent_id, to_desk_id,"
                + " to_desk_name, to_key, state, created_at, last_used_at, count, sha256 FROM desk_grants"
                + " WHERE grant_id = ?")) {
            select.setString(1, grantId);
            try (ResultSet r = select.executeQuery()) {
                if (!r.next()) {
                    return null;
                }
                String agentId = r.getString(2);
                String toDesk = r.getString(3);
                String state = r.getString(6);
                if (!AccessBook.halfHash(grantId, agentId, toDesk, state).equals(r.getString(10))) {
                    return null;
                }
                long last = r.getLong(8);
                Long lastUsed = r.wasNull() ? null : last;
                return new AccessBook.SendHalf(grantId, agentId, toDesk, r.getString(4), r.getString(5), state,
                        r.getLong(7), lastUsed, r.getInt(9));
            }
        }
    }

    /** Both of this desk's halves of the grant, whichever it holds, revoked. @return the half's agent, or null */
    private static String revokeHalves(Connection connection, String grantId, long now) throws SQLException {
        String agentId = null;
        AccessBook.SendHalf send = sendHalf(connection, grantId);
        if (send != null && !"revoked".equals(send.state())) {
            try (PreparedStatement update = connection.prepareStatement("UPDATE desk_grants SET state = 'revoked',"
                    + " updated_at = ?, sha256 = ? WHERE grant_id = ?")) {
                update.setLong(1, now);
                update.setString(2, AccessBook.halfHash(grantId, send.agentId(), send.toDeskId(), "revoked"));
                update.setString(3, grantId);
                update.executeUpdate();
            }
            agentId = send.agentId();
        }
        AnswerHalf answer = answerHalf(connection, grantId);
        if (answer != null && !"revoked".equals(answer.state())) {
            writeAnswerState(connection, grantId, answer, answer.agentId(), "revoked", now);
            agentId = answer.agentId();
        }
        return agentId;
    }

    /**
     * A {@code desk_message}'s envelope into the outbox and its send half's use (the settings show it, Security's question
     * 4), once: true only the first time this envelope is put there. A call asked again by its key after a restart gets
     * the same envelope back from deskd, and is neither sent nor counted again (release 3's proof: {@code desks.sent}
     * audited twice for one envelope).
     */
    public boolean queueSent(OutRow row, long now) throws SQLException {
        return db().transaction(connection -> {
            int added;
            try (PreparedStatement insert = connection.prepareStatement("INSERT OR IGNORE INTO desk_outbox (env_id,"
                    + " grant_id, to_desk_id, kind, seq, envelope, agent_id, reply_to, created_at, state)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')")) {
                insert.setString(1, row.envId());
                insert.setString(2, row.grantId());
                insert.setString(3, row.toDeskId());
                insert.setString(4, row.kind());
                insert.setLong(5, row.seq());
                insert.setString(6, row.envelope());
                setNullable(insert, 7, row.agentId());
                setNullable(insert, 8, row.replyTo());
                insert.setLong(9, row.createdAt());
                added = insert.executeUpdate();
            }
            if (added == 0) {
                return false;
            }
            try (PreparedStatement update = connection.prepareStatement("UPDATE desk_grants SET count = count + 1,"
                    + " last_used_at = ? WHERE grant_id = ?")) {
                update.setLong(1, now);
                update.setString(2, row.grantId());
                update.executeUpdate();
            }
            return true;
        });
    }

    /** The other desk's answering agent for a send half, once accepted: {@code [agentId, name]}, or null. */
    public String[] peerAgent(String grantId) throws SQLException {
        return db().call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT to_agent_id, to_agent_name FROM desk_grants WHERE grant_id = ?")) {
                select.setString(1, grantId);
                try (ResultSet r = select.executeQuery()) {
                    return r.next() ? new String[] {r.getString(1), r.getString(2)} : null;
                }
            }
        });
    }

    private static void setNullable(PreparedStatement statement, int index, String value) throws SQLException {
        if (value == null) {
            statement.setNull(index, Types.VARCHAR);
        } else {
            statement.setString(index, value);
        }
    }

    private static String str(Map<String, Object> map, String key) {
        return map.get(key) instanceof String s ? s : null;
    }

    static String json(Object value) {
        return new String(Json.bytes(value), StandardCharsets.UTF_8);
    }

    private static Map<String, Object> parse(String text) {
        if (text == null) {
            return null;
        }
        try {
            return Json.parseObject(text.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return null;
        }
    }
}
