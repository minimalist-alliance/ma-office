package com.minimalistalliance.desk.deskd.courier.store;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The outbound queue on the desk (plan §2.10): a member's send waits 10 seconds for Undo ({@code held}), then goes to its
 * transport, and a failure that can pass retries with backoff for 4 days ({@code retry}), the member seeing "Waiting to
 * send", until it's {@code sent} or {@code failed}. A desk that stops mid-send takes the queue up at the next open: a row
 * left {@code sending} goes back in the queue marked {@code interrupted}, so its transport can check whether the first try
 * got out before sending again (an SMTP submission can't be taken back, a Sent folder can be looked in).
 *
 * <p><b>Courier never sends by itself.</b> A row exists only for {@link #send}, which only the member's own
 * {@code courier.send} calls. No auto-reply, no vacation reply, no read receipt.
 */
public final class Outbox {

    private static final Logger log = LoggerFactory.getLogger(Outbox.class);
    /** Backoff after each failed try, about as a mail server's; the last repeats until the 4 days are up. */
    static final long[] BACKOFF_MS = {60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000};

    /** What a transport is given: the message as the member wrote it, and to whom. */
    public record Outgoing(String outboundId, String messageId, String medium, String accountId, int attempt,
            boolean maybeSentBefore, String rfcMessageId, String inReplyTo, List<String> references, String subject, String text,
            List<Recipient> to) {
        /** No text in logs. */
        @Override
        public String toString() {
            return "Outgoing[" + outboundId + ", " + medium + ", attempt " + attempt + ", " + to.size() + " to]";
        }
    }

    public record Recipient(String endpointId, String kind, String value, String name, String role) {}

    /** How a try ended. */
    public sealed interface Result permits Sent, Retry, Failed {}

    /** Out, with each recipient's status by endpoint id ({@code sent}, {@code delivered}, {@code refused}), if known. */
    public record Sent(Map<String, String> recipients) implements Result {}

    /**
     * Not out, and worth trying again: {@code error} is a short code (no_transport, unavailable, throttled, ...).
     * {@code unclear} says it may have gone (an SMTP submission whose answer to the message's end was lost): the row is
     * marked {@code interrupted}, so the next try is told {@code maybeSentBefore} and can look first (Security's condition
     * on the store's question 3, draft ADR §8).
     */
    public record Retry(String error, boolean unclear) implements Result {
        public Retry(String error) {
            this(error, false);
        }
    }

    /** Not out, and never will be (a refusal, an address that doesn't exist): {@code error} is a short code. */
    public record Failed(String error) implements Result {}

    /** A transport's sending half. Interrupted means the desk is stopping: the row goes back in the queue. */
    @FunctionalInterface
    public interface Sender {
        Result send(Outgoing item) throws InterruptedException;
    }

    private final CourierStore store;
    private final Map<String, Sender> senders = new ConcurrentHashMap<>();
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private volatile boolean poked;
    private volatile boolean closed;
    private volatile BooleanSupplier on = () -> true;
    private Thread runner;

    Outbox(CourierStore store) {
        this.store = store;
    }

    /** A medium's sender for one account ({@code medium:accountId}), or for every account of the medium ({@code medium}). */
    public void register(String medium, String accountId, Sender sender) {
        senders.put(accountId == null ? medium : medium + ":" + accountId, sender);
        poke();
    }

    public void unregister(String medium, String accountId) {
        senders.remove(accountId == null ? medium : medium + ":" + accountId);
    }

    /** Whether a send on this medium and account has a transport now. */
    public boolean canSend(String medium, String accountId) {
        return senders.containsKey(medium + ":" + accountId) || senders.containsKey(medium);
    }

    private Sender senderFor(String medium, String accountId) {
        Sender s = senders.get(medium + ":" + accountId);
        return s != null ? s : senders.get(medium);
    }

    // ---- the member's send

    /**
     * Turns a draft into a message on its way: in the channel at once (direction {@code out}, status {@code queued}), and
     * in the queue {@code held} for the undo window. The draft goes. Writing to someone lets them in.
     *
     * @return {messageId, outboundId, undoUntil}
     */
    public Object[] send(String draftId) throws SQLException, Actions.Refused {
        Actions.Refused[] refused = new Actions.Refused[1];
        Object[] out = store.write((c, changes) -> {
            Map<String, Object> d = Sql.one(c, """
                    SELECT channel_id, medium, account_id, to_list, subject, text, reply_to FROM drafts WHERE id = ?""", r -> {
                Map<String, Object> m = new java.util.HashMap<>();
                m.put("channel", r.getString(1));
                m.put("medium", r.getString(2));
                m.put("account", r.getString(3));
                m.put("to", r.getString(4));
                m.put("subject", r.getString(5));
                m.put("text", r.getString(6));
                m.put("replyTo", r.getString(7));
                return m;
            }, draftId);
            if (d == null) {
                refused[0] = new Actions.Refused("not_found", "draft");
                return null;
            }
            String medium = (String) d.get("medium");
            String accountId = (String) d.get("account");
            if (medium == null || accountId == null) {
                refused[0] = new Actions.Refused("bad_request", "medium");
                return null;
            }
            String accountAddress = Sql.stringOne(c, "SELECT address FROM accounts WHERE id = ?", accountId);
            if (!Sql.exists(c, "SELECT 1 FROM accounts WHERE id = ?", accountId)) {
                refused[0] = new Actions.Refused("not_found", "account");
                return null;
            }
            if (!canSend(medium, accountId)) {
                refused[0] = new Actions.Refused("unavailable", "medium");
                return null;
            }
            String text = (String) d.get("text");
            String subject = (String) d.get("subject");
            if ((text == null || text.isBlank()) && (subject == null || subject.isBlank())) {
                refused[0] = new Actions.Refused("bad_request", "empty");
                return null;
            }
            long now = store.now();
            // Recipients: the draft's own, or the channel's members reachable on this medium.
            Set<String> endpoints = new LinkedHashSet<>();
            String toList = (String) d.get("to");
            if (toList != null) {
                for (String v : toList.split("\n")) {
                    String kind = Accounts.endpointKind(medium, v);
                    String value = Norm.endpoint(kind, v);
                    if (value != null && !Graph.isOwn(c, kind, value)) {
                        endpoints.add(Graph.endpoint(c, store.ids(), kind, value, null, now, true).id());
                    }
                }
            }
            String channelId = (String) d.get("channel");
            if (endpoints.isEmpty() && channelId != null) {
                // iMessage reaches a person by number or Apple ID: the one they last wrote from on this medium, else a number.
                for (String e : Sql.list(c, """
                        SELECT (SELECT e3.id FROM endpoints e3 WHERE e3.contact_id = e.contact_id AND e3.kind IN (?, ?)
                          ORDER BY (e3.last_inbound_medium = ?) DESC, coalesce(e3.last_inbound_at, 0) DESC, e3.kind = 'phone' DESC, e3.id LIMIT 1)
                        FROM channel_members cm JOIN endpoints e ON e.id = cm.endpoint_id
                        WHERE cm.channel_id = ? GROUP BY e.contact_id ORDER BY min(cm.rowid)""",
                        r -> r.getString(1), endpointKindFor(medium), endpointAltKindFor(medium), medium, channelId)) {
                    if (e != null) {
                        endpoints.add(e);
                    }
                }
            }
            if (endpoints.isEmpty() && !"self".equals(Sql.stringOne(c, "SELECT kind FROM channels WHERE id = ?", channelId))) {
                refused[0] = new Actions.Refused("bad_request", "to");
                return null;
            }
            if (endpoints.size() > 50) {
                refused[0] = new Actions.Refused("bad_request", "to");
                return null;
            }
            for (String e : endpoints) {
                Graph.Endpoint ep = Graph.endpointById(c, e);
                if (ep != null && (Lanes.BLOCKED.equals(ep.standing()) || Graph.blocked(c, ep.kind(), ep.value()))) {
                    refused[0] = new Actions.Refused("forbidden", "blocked");
                    return null;
                }
            }
            if (channelId == null) {
                if (endpoints.size() == 1) {
                    Graph.Endpoint e = Graph.endpointById(c, endpoints.iterator().next());
                    channelId = Graph.channel(c, store.ids(), "direct:" + e.contactId(), "direct", null, endpoints, now);
                } else {
                    channelId = Graph.channel(c, store.ids(), Graph.groupKey(endpoints), "group", null, endpoints, now);
                }
            }
            // A reply keeps its subject and its place in the email thread (In-Reply-To, References), plan §1.5.
            String replyTo = (String) d.get("replyTo");
            String inReplyTo = null;
            List<String> references = new ArrayList<>();
            String threadId = null;
            if (replyTo != null) {
                Object[] parent = Sql.one(c, "SELECT seq, msgid, thread_id, channel_id FROM messages WHERE id = ?",
                        r -> new Object[] {r.getLong(1), r.getString(2), r.getString(3), r.getString(4)}, replyTo);
                if (parent != null) {
                    inReplyTo = (String) parent[1];
                    references.addAll(Sql.list(c, "SELECT ref FROM message_refs WHERE message_seq = ? ORDER BY rowid",
                            r -> r.getString(1), parent[0]));
                    if (inReplyTo != null) {
                        references.remove(inReplyTo);
                        references.add(inReplyTo);
                    }
                    // A private reply from a group's thread is a new thread in the person's channel.
                    threadId = channelId.equals(parent[3]) ? (String) parent[2] : null;
                }
            }
            String id = store.ids().next(now);
            String domain = accountAddress == null ? null : Norm.domain(Norm.email(accountAddress));
            String rfcId = "email".equals(medium) ? id.toLowerCase(java.util.Locale.ROOT) + "@" + (domain == null ? "courier.invalid" : domain) : null;
            String subjectNorm = Norm.subject(subject);
            if ("email".equals(medium) && threadId == null) {
                threadId = store.ids().next(now);
                Sql.update(c, """
                        INSERT INTO threads (id, channel_id, subject_norm, started_by_member, last_at, created_at)
                        VALUES (?, ?, ?, 1, ?, ?)""", threadId, channelId, subjectNorm, now, now);
            } else if (threadId != null) {
                Sql.update(c, "UPDATE threads SET last_at = MAX(last_at, ?) WHERE id = ?", now, threadId);
            }
            StringBuilder searchTo = new StringBuilder();
            List<Recipient> recipients = new ArrayList<>();
            for (String e : endpoints) {
                Graph.Endpoint ep = Graph.endpointById(c, e);
                searchTo.append(ep.value()).append(' ');
                recipients.add(new Recipient(e, ep.kind(), ep.value(), null, "to"));
            }
            long seq = Sql.insert(c, """
                    INSERT INTO messages (id, medium, external_id, account_id, channel_id, thread_id, direction, author_kind,
                      from_endpoint, lane, lane_at, bulk, sender_known, status, read, sent_at, received_at, sort_at, sort_key, msgid,
                      subject, subject_norm, snippet, body_text, search_to, parse_state, origin)
                    VALUES (?, ?, ?, ?, ?, ?, 'out', 'human', NULL, 'people', ?, 0, 1, 'queued', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 'member')""",
                    id, medium, "out:" + id, accountId, channelId, threadId, now, now, now, now, Ingest.sortKey(c, now), rfcId, subject, subjectNorm,
                    Ingest.snippet(text), text == null ? "" : text, searchTo.toString().strip());
            for (String ref : references) {
                Sql.update(c, "INSERT OR IGNORE INTO message_refs (message_seq, ref) VALUES (?, ?)", seq, ref);
            }
            for (Recipient r : recipients) {
                Sql.update(c, "INSERT OR IGNORE INTO recipients (message_seq, endpoint_id, role, status) VALUES (?, ?, 'to', 'queued')", seq, r.endpointId());
            }
            String outboundId = store.ids().next(now);
            long undoUntil = now + store.settings().undo().toMillis();
            Sql.update(c, """
                    INSERT INTO outbound (id, message_seq, draft_id, state, not_before, give_up_at, attempts, interrupted, created_at, updated_at)
                    VALUES (?, ?, ?, 'held', ?, ?, 0, 0, ?, ?)""", outboundId, seq, draftId, undoUntil,
                    now + store.settings().giveUp().toMillis(), now, now);
            Sql.update(c, "DELETE FROM drafts WHERE id = ?", draftId);
            Graph.bump(c, channelId, Lanes.PEOPLE, now, seq, false);
            changes.lane(channelId, Lanes.PEOPLE);
            Set<String> contacts = new LinkedHashSet<>();
            for (String e : endpoints) {
                Sql.update(c, "UPDATE endpoints SET written_to = 1 WHERE id = ?", e);
                contacts.add(Graph.endpointById(c, e).contactId());
            }
            for (String contact : contacts) {
                Graph.letIn(c, contact, now, changes);
            }
            changes.drafts = true;
            changes.outbound = true;
            return new Object[] {id, outboundId, undoUntil};
        });
        if (refused[0] != null) {
            throw refused[0];
        }
        poke();
        return out;
    }

    private static String endpointKindFor(String medium) {
        return switch (medium) {
            case "ma" -> "ma";
            case "imessage", "sms" -> "phone";
            default -> "email";
        };
    }

    /** The other kind a medium reaches a person by: an Apple ID for iMessage; none (the same kind again) otherwise. */
    private static String endpointAltKindFor(String medium) {
        return "imessage".equals(medium) ? "apple" : endpointKindFor(medium);
    }

    /**
     * Takes a send back while it hasn't started going: inside the undo window, or waiting to retry, or failed. The message
     * leaves the channel and becomes the draft again.
     *
     * @return the draft's id
     */
    public String undo(String outboundId) throws SQLException, Actions.Refused {
        Actions.Refused[] refused = new Actions.Refused[1];
        String draftId = store.write((c, changes) -> {
            Object[] row = Sql.one(c, """
                    SELECT o.state, o.message_seq, o.draft_id, m.channel_id, m.medium, m.account_id, m.subject, m.body_text, m.thread_id
                    FROM outbound o JOIN messages m ON m.seq = o.message_seq WHERE o.id = ?""",
                    r -> new Object[] {r.getString(1), r.getLong(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6),
                            r.getString(7), r.getString(8), r.getString(9)}, outboundId);
            if (row == null) {
                refused[0] = new Actions.Refused("not_found", "outbound");
                return null;
            }
            String state = (String) row[0];
            if (state.equals("sending") || state.equals("sent")) {
                refused[0] = new Actions.Refused("conflict", "too_late");
                return null;
            }
            long now = store.now();
            List<String> to = Sql.list(c, "SELECT e.value FROM recipients r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.message_seq = ?",
                    r -> r.getString(1), row[1]);
            String replyTo = Sql.stringOne(c, """
                    SELECT p.id FROM message_refs mr JOIN messages p ON p.msgid = mr.ref WHERE mr.message_seq = ?
                    ORDER BY mr.rowid DESC LIMIT 1""", row[1]);
            String draft = (String) row[2];
            Sql.update(c, """
                    INSERT OR REPLACE INTO drafts (id, channel_id, medium, account_id, to_list, subject, text, reply_to, version, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""", draft, row[3], row[4], row[5], to.isEmpty() ? null : String.join("\n", to),
                    row[6], row[7] == null ? "" : row[7], replyTo, now, now);
            store.purge(c, List.of((Long) row[1]), changes);
            changes.drafts = true;
            changes.outbound = true;
            return draft;
        });
        if (refused[0] != null) {
            throw refused[0];
        }
        return draftId;
    }

    // ---- the runner

    /** At open: a row a stopped desk left going goes back in the queue, marked so its transport checks first. */
    void recover() throws SQLException {
        store.db().transaction(c -> Sql.update(c, """
                UPDATE outbound SET state = 'queued', interrupted = 1, updated_at = ? WHERE state = 'sending'""", store.now()));
    }

    /** Starts the runner, a virtual thread that waits for the next due row. {@code on} is Courier's switch. */
    public void start(BooleanSupplier on) {
        this.on = on;
        lock.lock();
        try {
            if (runner != null || closed) {
                return;
            }
            runner = Thread.ofVirtual().name("courier-outbox").start(this::run);
        } finally {
            lock.unlock();
        }
    }

    /** Something may be due sooner: a send, an undo, a sender registered. */
    public void poke() {
        lock.lock();
        try {
            poked = true;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    private void run() {
        while (!closed) {
            try {
                long wait = runDue();
                lock.lock();
                try {
                    // Nothing queued: no timer at all until a send, an undo or a sender pokes it.
                    if (!poked && !closed) {
                        if (wait == Long.MAX_VALUE) {
                            wake.await();
                        } else {
                            wake.await(Math.max(10, wait), TimeUnit.MILLISECONDS);
                        }
                    }
                    poked = false;
                } finally {
                    lock.unlock();
                }
            } catch (InterruptedException e) {
                return;
            } catch (SQLException | RuntimeException e) {
                log.warn("courier outbox: {}", e.getClass().getSimpleName());
                try {
                    Thread.sleep(5_000);
                } catch (InterruptedException ie) {
                    return;
                }
            }
        }
    }

    /**
     * Sends every row that's due, one at a time: the runner's step, and a drain for tests.
     *
     * @return ms until the next one is due, or {@code Long.MAX_VALUE} with nothing queued
     */
    public long runDue() throws SQLException, InterruptedException {
        boolean sending = on.getAsBoolean();
        while (!closed && sending) {
            Outgoing item = claim();
            if (item == null) {
                break;
            }
            Sender sender = senderFor(item.medium(), item.accountId());
            Result result;
            if (sender == null) {
                result = new Retry("no_transport");
            } else {
                try {
                    result = sender.send(item);
                } catch (InterruptedException e) {
                    // Stopping: it goes back, marked, as a crash would leave it.
                    store.db().transaction(c -> Sql.update(c,
                            "UPDATE outbound SET state = 'queued', interrupted = 1, updated_at = ? WHERE id = ?", store.now(), item.outboundId()));
                    throw e;
                } catch (RuntimeException e) {
                    log.warn("courier sender failed: {}", e.getClass().getSimpleName());
                    result = new Retry("transport");
                }
            }
            finish(item, result == null ? new Retry("transport") : result);
            sending = on.getAsBoolean();
        }
        Long next = store.db().read(c -> Sql.longOne(c, "SELECT min(not_before) FROM outbound WHERE state IN ('held', 'queued', 'retry')"));
        if (next == null) {
            return Long.MAX_VALUE;
        }
        // Switched off with sends waiting: the switch is a file nothing signals, so look again in a minute.
        return sending ? Math.max(0, next - store.now()) : 60_000;
    }

    /** The next due row, as {@code sending}, with one more attempt; null if none is due. The runner's first step. */
    public Outgoing claim() throws SQLException {
        return store.db().transaction(c -> {
            long now = store.now();
            Object[] row = Sql.one(c, """
                    SELECT o.id, o.message_seq, o.attempts, o.interrupted FROM outbound o
                    WHERE o.state IN ('held', 'queued', 'retry') AND o.not_before <= ? ORDER BY o.not_before, o.id LIMIT 1""",
                    r -> new Object[] {r.getString(1), r.getLong(2), r.getInt(3), r.getInt(4) == 1}, now);
            if (row == null) {
                return null;
            }
            Sql.update(c, "UPDATE outbound SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?", now, row[0]);
            Sql.update(c, "UPDATE messages SET status = 'sending' WHERE seq = ?", row[1]);
            return outgoing(c, (String) row[0], (Long) row[1], (Integer) row[2] + 1, (Boolean) row[3]);
        });
    }

    private static Outgoing outgoing(Connection c, String outboundId, long seq, int attempt, boolean interrupted) throws SQLException {
        Object[] m = Sql.one(c, "SELECT id, medium, account_id, msgid, subject, body_text FROM messages WHERE seq = ?",
                r -> new Object[] {r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6)}, seq);
        List<String> refs = Sql.list(c, "SELECT ref FROM message_refs WHERE message_seq = ? ORDER BY rowid", r -> r.getString(1), seq);
        List<Recipient> to = Sql.list(c, """
                SELECT r.endpoint_id, e.kind, e.value, ct.name, r.role FROM recipients r JOIN endpoints e ON e.id = r.endpoint_id
                JOIN contacts ct ON ct.id = e.contact_id WHERE r.message_seq = ?""",
                r -> new Recipient(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5)), seq);
        String inReplyTo = refs.isEmpty() ? null : refs.get(refs.size() - 1);
        return new Outgoing(outboundId, (String) m[0], (String) m[1], (String) m[2], attempt, interrupted, (String) m[3], inReplyTo,
                refs, (String) m[4], (String) m[5], to);
    }

    /** Records how a try ended. */
    void finish(Outgoing item, Result result) throws SQLException {
        Courier.ChangeSet changes = new Courier.ChangeSet();
        store.db().transaction(c -> {
            long now = store.now();
            Object[] row = Sql.one(c, "SELECT message_seq, give_up_at, attempts FROM outbound WHERE id = ?",
                    r -> new Object[] {r.getLong(1), r.getLong(2), r.getInt(3)}, item.outboundId());
            if (row == null) {
                return null;
            }
            long seq = (Long) row[0];
            String channel = Sql.stringOne(c, "SELECT channel_id FROM messages WHERE seq = ?", seq);
            if (result instanceof Sent sent) {
                Sql.update(c, "UPDATE outbound SET state = 'sent', last_error = NULL, interrupted = 0, updated_at = ? WHERE id = ?", now, item.outboundId());
                Sql.update(c, "UPDATE messages SET status = 'sent' WHERE seq = ?", seq);
                Sql.update(c, "UPDATE recipients SET status = 'sent' WHERE message_seq = ?", seq);
                if (sent.recipients() != null) {
                    for (Map.Entry<String, String> e : sent.recipients().entrySet()) {
                        Sql.update(c, "UPDATE recipients SET status = ? WHERE message_seq = ? AND endpoint_id = ?",
                                Norm.line(e.getValue(), 32), seq, e.getKey());
                    }
                }
            } else if (result instanceof Retry retry && now < (Long) row[1]) {
                int attempts = (Integer) row[2];
                long base = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, attempts - 1))];
                long jitter = ThreadLocalRandom.current().nextLong(base / 10 + 1);
                // An unclear end keeps the row interrupted until a try ends clearly sent (it may already have gone).
                Sql.update(c, """
                        UPDATE outbound SET state = 'retry', not_before = ?, last_error = ?, interrupted = MAX(interrupted, ?),
                          updated_at = ? WHERE id = ?""",
                        Math.min(now + base + jitter, (Long) row[1]), Norm.line(retry.error(), 32), retry.unclear() ? 1 : 0, now,
                        item.outboundId());
                Sql.update(c, "UPDATE messages SET status = 'queued' WHERE seq = ?", seq);
            } else {
                String error = result instanceof Failed f ? f.error() : ((Retry) result).error();
                Sql.update(c, "UPDATE outbound SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
                        Norm.line(error, 32), now, item.outboundId());
                Sql.update(c, "UPDATE messages SET status = 'failed' WHERE seq = ?", seq);
            }
            changes.outbound = true;
            changes.lane(channel, null);
            return null;
        });
        store.publish(changes);
    }

    void close() {
        Thread t;
        lock.lock();
        try {
            closed = true;
            wake.signalAll();
            t = runner;
        } finally {
            lock.unlock();
        }
        if (t != null) {
            t.interrupt();
            try {
                t.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
