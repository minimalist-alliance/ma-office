package com.minimalistalliance.desk.deskd.courier.store;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads, on the store's readers: what {@code courier.*} shows the member (API.md §21) and what the agent read tools see
 * ({@link AgentView}). Every result is a map of JSON values, sized to fit a RES: a thread's messages carry their first
 * 2,000 characters, a message's text comes a slice at a time.
 */
public final class Queries {

    public static final int LIST_MAX = 100;
    public static final int THREAD_MAX = 100;
    public static final int SEARCH_MAX = 100;
    /** A thread page's text per message; the rest through {@code courier.message}. */
    public static final int THREAD_TEXT = 2_000;
    /** One slice of a message's text or HTML, in characters. */
    public static final int SLICE = 150_000;
    static final int ATTACHMENTS_SHOWN = 500;

    private final CourierStore store;

    Queries(CourierStore store) {
        this.store = store;
    }

    /** A page's place: the last row's time and id, opaque to clients. */
    record Cursor(long at, String id) {
        String wire() {
            return at + "." + id;
        }

        static Cursor parse(Object o) {
            if (o == null) {
                return null;
            }
            if (!(o instanceof String s) || s.length() > 80) {
                throw new IllegalArgumentException("before");
            }
            int dot = s.indexOf('.');
            if (dot <= 0) {
                throw new IllegalArgumentException("before");
            }
            try {
                long at = Long.parseLong(s.substring(0, dot));
                String id = s.substring(dot + 1);
                if (!Ulid.valid(id) && !id.matches("[0-9]{1,19}")) {
                    throw new IllegalArgumentException("before");
                }
                return new Cursor(at, id);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException("before");
            }
        }
    }

    // ---- counts

    /** Per lane: how many people (channels) and how many unread messages. Done rows don't count. */
    public Map<String, Object> counts() throws java.sql.SQLException {
        return store.db().read(c -> {
            Map<String, Object> lanes = new LinkedHashMap<>();
            for (String lane : Lanes.ALL) {
                lanes.put(lane, Map.of("count", 0L, "unread", 0L));
            }
            Sql.list(c, """
                    SELECT lane, count(*), coalesce(sum(unread), 0) FROM channel_lanes
                    WHERE done_at IS NULL OR last_at > done_at GROUP BY lane""", r -> {
                if (Lanes.valid(r.getString(1))) {
                    lanes.put(r.getString(1), Map.of("count", r.getLong(2), "unread", r.getLong(3)));
                }
                return null;
            });
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("lanes", lanes);
            out.put("drafts", Sql.longOne(c, "SELECT count(*) FROM drafts"));
            out.put("waiting", Sql.longOne(c, "SELECT count(*) FROM outbound WHERE state IN ('held', 'queued', 'sending', 'retry')"));
            out.put("failed", Sql.longOne(c, "SELECT count(*) FROM outbound WHERE state = 'failed'"));
            out.put("pending", Sql.longOne(c, "SELECT count(*) FROM messages WHERE lane = 'pending'"));
            // The learning filter: learning, on or off, and how much the member's own decisions have taught it.
            out.put("filter", store.filter().status(c));
            return out;
        });
    }

    // ---- lists

    /**
     * A lane's list, newest first: one row per person or group, with its last message in that lane.
     *
     * @param accountId only channels with mail in this lane from this account, or null
     */
    public Map<String, Object> list(String lane, String accountId, Object before, int limit, boolean includeDone)
            throws SQLException {
        Cursor cursor = Cursor.parse(before);
        int n = Math.max(1, Math.min(LIST_MAX, limit));
        return store.db().read(c -> {
            StringBuilder sql = new StringBuilder("""
                    SELECT channel_id, lane, last_at, last_seq, count, unread, done_at FROM channel_lanes cl WHERE lane = ?""");
            List<Object> args = new ArrayList<>(List.of(lane));
            if (!includeDone) {
                sql.append(" AND (done_at IS NULL OR last_at > done_at)");
            }
            if (accountId != null) {
                sql.append(" AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = cl.channel_id AND m.lane = cl.lane AND m.account_id = ?)");
                args.add(accountId);
            }
            if (cursor != null) {
                sql.append(" AND (last_at, channel_id) < (?, ?)");
                args.add(cursor.at());
                args.add(cursor.id());
            }
            sql.append(" ORDER BY last_at DESC, channel_id DESC LIMIT ?");
            args.add(n + 1);
            List<Map<String, Object>> rows = new ArrayList<>();
            List<Object[]> raw = Sql.list(c, sql.toString(), r -> new Object[] {r.getString(1), r.getString(2), r.getLong(3),
                    r.getLong(4), r.getLong(5), r.getLong(6), Sql.nullableLong(r, "done_at")}, args.toArray());
            for (int i = 0; i < Math.min(n, raw.size()); i++) {
                Object[] row = raw.get(i);
                rows.add(channelRow(c, (String) row[0], (String) row[1], (Long) row[2], (Long) row[3], (Long) row[4], (Long) row[5],
                        (Long) row[6]));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("rows", rows);
            out.put("next", raw.size() > n ? new Cursor((Long) raw.get(n - 1)[2], (String) raw.get(n - 1)[0]).wire() : null);
            return out;
        });
    }

    /** At most this many threads in {@link #attention}. */
    public static final int ATTENTION_MAX = 50;
    static final long DAY_MS = 86_400_000L;

    /**
     * {@code courier.attention}: the People lane's threads with something unread, newest first, as structure only, for the
     * focus shield on the member's home desk (API.md §21 and §23). Never a subject, a snippet, a name or an address;
     * Requests, Spam and Trash never; a note to self never. Per thread: its kind, up to 8 contact ids, whether the
     * newest unread message's sender is known, confirmed (as {@link #senderConfirmed}) or bulk, since when they've been
     * waiting on the member (their first message after the member's last, or null when the member wrote last), the
     * member's reply band (messages the member sent there in 30 days: 0 none, 1 one to 4, 2 five to 12, 3 more), the
     * unread count and the newest message's time.
     */
    public Map<String, Object> attention(long now) throws SQLException {
        return store.db().read(c -> {
            List<Object[]> rows = Sql.list(c, """
                    SELECT cl.channel_id, cl.unread, cl.last_at, ch.kind FROM channel_lanes cl JOIN channels ch ON ch.id = cl.channel_id
                    WHERE cl.lane = 'people' AND cl.unread > 0 AND (cl.done_at IS NULL OR cl.last_at > cl.done_at)
                      AND ch.kind != 'self'
                    ORDER BY cl.last_at DESC, cl.channel_id DESC LIMIT ?""",
                    r -> new Object[] {r.getString(1), r.getLong(2), r.getLong(3), r.getString(4)}, ATTENTION_MAX);
            List<Map<String, Object>> threads = new ArrayList<>();
            for (Object[] row : rows) {
                String channelId = (String) row[0];
                Msg newest = Sql.one(c, "SELECT " + Msg.COLS + " FROM messages m WHERE m.channel_id = ? AND m.lane = 'people'"
                        + " AND m.direction = 'in' AND m.read = 0 ORDER BY m.sort_at DESC, m.seq DESC LIMIT 1", Msg::of, channelId);
                if (newest == null) {
                    continue;
                }
                List<String> contacts = Sql.list(c, """
                        SELECT DISTINCT e.contact_id FROM channel_members cm JOIN endpoints e ON e.id = cm.endpoint_id
                        WHERE cm.channel_id = ? ORDER BY e.first_seen_at, e.id LIMIT 8""", r -> r.getString(1), channelId);
                Long lastOut = Sql.longOne(c, "SELECT max(sort_at) FROM messages WHERE channel_id = ? AND direction = 'out'"
                        + " AND lane NOT IN ('spam', 'trash')", channelId);
                Long lastAny = Sql.longOne(c, "SELECT max(sort_at) FROM messages WHERE channel_id = ? AND lane NOT IN ('spam', 'trash')"
                        + " AND parse_state != 'pending'", channelId);
                Long waitingSince = null;
                if (lastAny != null && (lastOut == null || lastAny > lastOut)) {
                    waitingSince = Sql.longOne(c, "SELECT min(sort_at) FROM messages WHERE channel_id = ? AND direction = 'in'"
                            + " AND lane = 'people' AND sort_at > ?", channelId, lastOut == null ? Long.MIN_VALUE : lastOut);
                }
                Long sent = Sql.longOne(c, "SELECT count(*) FROM messages WHERE channel_id = ? AND direction = 'out' AND sort_at >= ?",
                        channelId, now - 30 * DAY_MS);
                long n = sent == null ? 0 : sent;
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("channelId", channelId);
                t.put("kind", "group".equals(row[3]) ? "group" : "direct");
                t.put("contactIds", contacts);
                t.put("known", newest.senderKnown());
                t.put("confirmed", Boolean.TRUE.equals(senderConfirmed(newest)));
                t.put("bulk", newest.bulk());
                t.put("theyWroteLastAt", waitingSince);
                t.put("replyBand", n == 0 ? 0 : n <= 4 ? 1 : n <= 12 ? 2 : 3);
                t.put("unread", row[1]);
                t.put("newestAt", row[2]);
                threads.add(t);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("threads", threads);
            return out;
        });
    }

    private Map<String, Object> channelRow(Connection c, String channelId, String lane, long lastAt, long lastSeq, long count,
            long unread, Long doneAt) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        Map<String, Object> channel = channel(c, channelId);
        row.put("channelId", channelId);
        row.put("kind", channel.get("kind"));
        row.put("title", channel.get("title"));
        row.put("contacts", channel.get("contacts"));
        row.put("lane", lane);
        row.put("lastAt", lastAt);
        row.put("count", count);
        row.put("unread", unread);
        row.put("done", doneAt != null && lastAt <= doneAt);
        Map<String, Object> last = Sql.one(c, "SELECT " + Msg.COLS + " FROM messages m WHERE m.seq = ?", r -> brief(c, Msg.of(r)), lastSeq);
        row.put("last", last);
        row.put("medium", last == null ? null : last.get("medium"));
        return row;
    }

    /** A channel: kind, title, and its people (at most 50). */
    Map<String, Object> channel(Connection c, String channelId) throws SQLException {
        Map<String, Object> out = new LinkedHashMap<>();
        Object[] ch = Sql.one(c, "SELECT kind, title, preferred_medium FROM channels WHERE id = ?",
                r -> new Object[] {r.getString(1), r.getString(2), r.getString(3)}, channelId);
        if (ch == null) {
            return null;
        }
        List<Map<String, Object>> contacts = Sql.list(c, """
                SELECT ct.id, ct.name, e.kind, e.value, e.standing FROM channel_members cm
                JOIN endpoints e ON e.id = cm.endpoint_id JOIN contacts ct ON ct.id = e.contact_id
                WHERE cm.channel_id = ? ORDER BY e.first_seen_at, e.id LIMIT 50""", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("contactId", r.getString(1));
            m.put("name", r.getString(2));
            m.put("endpoint", Map.of("kind", r.getString(3), "value", r.getString(4)));
            m.put("known", Lanes.KNOWN.equals(r.getString(5)));
            return m;
        }, channelId);
        String title = (String) ch[1];
        if (title == null && "self".equals(ch[0])) {
            title = null;
        }
        out.put("channelId", channelId);
        out.put("kind", ch[0]);
        out.put("title", title);
        out.put("preferredMedium", ch[2]);
        out.put("contacts", contacts);
        return out;
    }

    // ---- a thread

    /**
     * A channel's messages, a page at a time from the newest: the page is oldest first. Without a lane, everything but
     * Spam, Trash and what waits for the parser.
     */
    public Map<String, Object> thread(String channelId, String lane, Object before, int limit) throws SQLException {
        Cursor cursor = Cursor.parse(before);
        int n = Math.max(1, Math.min(THREAD_MAX, limit));
        return store.db().read(c -> {
            Map<String, Object> channel = channel(c, channelId);
            if (channel == null) {
                return null;
            }
            StringBuilder sql = new StringBuilder("SELECT " + Msg.COLS + ", substr(m.body_text, 1, " + THREAD_TEXT
                    + ") FROM messages m WHERE m.channel_id = ?");
            List<Object> args = new ArrayList<>(List.of(channelId));
            if (lane != null) {
                sql.append(" AND m.lane = ?");
                args.add(lane);
            } else {
                sql.append(" AND m.lane IN ('people', 'requests', 'updates', 'other')");
            }
            if (cursor != null) {
                sql.append(" AND (m.sort_at, m.seq) < (?, ?)");
                args.add(cursor.at());
                args.add(seqOf(c, cursor.id()));
            }
            sql.append(" ORDER BY m.sort_at DESC, m.seq DESC LIMIT ?");
            args.add(n + 1);
            List<Object[]> rows = Sql.list(c, sql.toString(), r -> new Object[] {Msg.of(r), r.getString(Msg.COUNT + 1)}, args.toArray());
            List<Map<String, Object>> messages = new ArrayList<>();
            for (int i = Math.min(n, rows.size()) - 1; i >= 0; i--) {
                Msg m = (Msg) rows.get(i)[0];
                Map<String, Object> full = full(c, m, 20);
                String text = (String) rows.get(i)[1];
                full.put("text", text == null ? "" : text);
                full.put("textMore", m.textLength() > THREAD_TEXT);
                messages.add(full);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("channel", channel);
            out.put("messages", messages);
            out.put("next", rows.size() > n ? new Cursor(((Msg) rows.get(n - 1)[0]).sortAt(), ((Msg) rows.get(n - 1)[0]).id()).wire() : null);
            return out;
        });
    }

    private static Long seqOf(Connection c, String id) throws SQLException {
        Long seq = Sql.longOne(c, "SELECT seq FROM messages WHERE id = ?", id);
        return seq == null ? Long.MAX_VALUE : seq;
    }

    // ---- one message

    /**
     * One message whole: its text from {@code from} (characters), a slice at a time, and whether there's HTML (read with
     * {@link #html}). Null if there's no such message, or it's waiting for the parser.
     */
    public Map<String, Object> message(String messageId, int from) throws SQLException {
        return store.db().read(c -> {
            Msg m = Sql.one(c, "SELECT " + Msg.COLS + " FROM messages m WHERE m.id = ? AND m.lane <> 'pending'", Msg::of, messageId);
            if (m == null) {
                return null;
            }
            Map<String, Object> out = full(c, m, ATTACHMENTS_SHOWN);
            int start = Math.max(0, from);
            String text = Sql.stringOne(c, "SELECT substr(body_text, ?, ?) FROM messages WHERE seq = ?", start + 1, SLICE, m.seq());
            out.put("text", text == null ? "" : text);
            out.put("textFrom", start);
            out.put("textNext", start + SLICE < m.textLength() ? start + SLICE : null);
            out.put("recipients", recipients(c, m.seq()));
            out.put("threadId", m.threadId());
            return out;
        });
    }

    /** The sanitized HTML, a slice at a time; null if there's none. */
    public Map<String, Object> html(String messageId, int from) throws SQLException {
        return store.db().read(c -> {
            Object[] row = Sql.one(c, "SELECT seq, length(body_html) FROM messages WHERE id = ? AND body_html IS NOT NULL",
                    r -> new Object[] {r.getLong(1), r.getLong(2)}, messageId);
            if (row == null) {
                return null;
            }
            int start = Math.max(0, from);
            String html = Sql.stringOne(c, "SELECT substr(body_html, ?, ?) FROM messages WHERE seq = ?", start + 1, SLICE, row[0]);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("messageId", messageId);
            out.put("html", html == null ? "" : html);
            out.put("from", start);
            out.put("next", start + SLICE < (Long) row[1] ? start + SLICE : null);
            return out;
        });
    }

    private static List<Map<String, Object>> recipients(Connection c, long seq) throws SQLException {
        return Sql.list(c, """
                SELECT r.role, e.kind, e.value, ct.id, ct.name FROM recipients r
                JOIN endpoints e ON e.id = r.endpoint_id JOIN contacts ct ON ct.id = e.contact_id
                WHERE r.message_seq = ? ORDER BY r.role, e.value LIMIT 500""", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("role", r.getString(1));
            m.put("endpoint", Map.of("kind", r.getString(2), "value", r.getString(3)));
            m.put("contactId", r.getString(4));
            m.put("name", r.getString(5));
            return m;
        }, seq);
    }

    /** A message's columns, as one row of {@link #COLS}. */
    record Msg(long seq, String id, String medium, String accountId, String channelId, String threadId, String direction,
            String authorKind, String fromEndpoint, String lane, boolean bulk, boolean senderKnown, String status, boolean read,
            Long sentAt, long receivedAt, long sortAt, String subject, String snippet, int attachmentCount, String parseState,
            String parseReason, String auth, String labels, boolean textTruncated, long textLength, boolean hasHtml,
            Long rawBytes, String msgid, String screen, String warn) {

        static final String COLS = "m.seq, m.id, m.medium, m.account_id, m.channel_id, m.thread_id, m.direction, m.author_kind, "
                + "m.from_endpoint, m.lane, m.bulk, m.sender_known, m.status, m.read, m.sent_at, m.received_at, m.sort_at, "
                + "m.subject, m.snippet, m.attachment_count, m.parse_state, m.parse_reason, m.auth, m.labels, m.text_truncated, "
                + "coalesce(length(m.body_text), 0), m.body_html IS NOT NULL, m.raw_bytes, m.msgid, m.screen, m.warn";
        static final int COUNT = 31;

        static Msg of(ResultSet r) throws SQLException {
            long sent = r.getLong(15);
            Long sentAt = r.wasNull() ? null : sent;
            long raw = r.getLong(28);
            Long rawBytes = r.wasNull() ? null : raw;
            return new Msg(r.getLong(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6),
                    r.getString(7), r.getString(8), r.getString(9), r.getString(10), r.getInt(11) == 1, r.getInt(12) == 1,
                    r.getString(13), r.getInt(14) == 1, sentAt, r.getLong(16), r.getLong(17), r.getString(18), r.getString(19),
                    r.getInt(20), r.getString(21), r.getString(22), r.getString(23), r.getString(24), r.getInt(25) == 1,
                    r.getLong(26), r.getInt(27) == 1, rawBytes, r.getString(29), r.getString(30), r.getString(31));
        }
    }

    /** The sender, from the contact record of the endpoint the transport verified, never a name in the message. */
    static Map<String, Object> sender(Connection c, Msg m) throws SQLException {
        if (m.fromEndpoint() == null) {
            return "out".equals(m.direction()) ? Map.of("me", true) : null;
        }
        return Sql.one(c, """
                SELECT ct.id, ct.name, e.kind, e.value, e.standing FROM endpoints e JOIN contacts ct ON ct.id = e.contact_id
                WHERE e.id = ?""", r -> {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("contactId", r.getString(1));
            f.put("name", r.getString(2));
            f.put("endpoint", Map.of("kind", r.getString(3), "value", r.getString(4)));
            f.put("known", Lanes.KNOWN.equals(r.getString(5)));
            return f;
        }, m.fromEndpoint());
    }

    /** A list row's last message. */
    Map<String, Object> brief(Connection c, Msg m) throws SQLException {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("messageId", m.id());
        out.put("medium", m.medium());
        out.put("direction", m.direction());
        out.put("from", sender(c, m));
        out.put("subject", m.subject());
        out.put("snippet", m.snippet());
        out.put("at", m.sortAt());
        out.put("read", m.read());
        out.put("accountId", m.accountId());
        out.put("warned", m.warn() != null);
        return out;
    }

    /** Everything about a message but its text. */
    Map<String, Object> full(Connection c, Msg m, int maxAttachments) throws SQLException {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("messageId", m.id());
        out.put("channelId", m.channelId());
        out.put("threadId", m.threadId());
        out.put("rfcMessageId", m.msgid());
        out.put("direction", m.direction());
        out.put("medium", m.medium());
        out.put("accountId", m.accountId());
        out.put("from", sender(c, m));
        out.put("at", m.sortAt());
        out.put("sentAt", m.sentAt());
        out.put("receivedAt", m.receivedAt());
        out.put("subject", m.subject());
        out.put("snippet", m.snippet());
        out.put("lane", m.lane());
        out.put("read", m.read());
        out.put("bulk", m.bulk());
        out.put("senderKnown", m.senderKnown());
        out.put("authorKind", m.authorKind());
        out.put("status", m.status());
        out.put("hasHtml", m.hasHtml());
        out.put("textTruncated", m.textTruncated());
        out.put("textLength", m.textLength());
        out.put("parse", "ok".equals(m.parseState()) ? null : Map.of("state", m.parseState(), "reason", m.parseReason() == null ? "" : m.parseReason()));
        out.put("auth", auth(m.auth()));
        out.put("labels", m.labels() == null ? List.of() : List.of(m.labels().split("\n")));
        out.put("rawBytes", m.rawBytes());
        out.put("attachmentCount", m.attachmentCount());
        out.put("attachments", attachments(c, m.seq(), maxAttachments));
        // Why the desk itself put it in Spam ("filter": the learning filter), and the sender warnings made as it came (§17).
        out.put("screen", m.screen());
        out.put("warnings", Senders.read(m.warn()));
        return out;
    }

    static Map<String, Object> auth(String json) {
        if (json == null) {
            return null;
        }
        try {
            Map<String, Object> a = Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
            Map<String, Object> out = new LinkedHashMap<>(a);
            // The sender line comes from authentication (plan §3.5): confirmed only when DMARC passed.
            Object dmarc = a.get("dmarc");
            out.put("senderConfirmed", dmarc == null ? null : "pass".equalsIgnoreCase(dmarc.toString().strip()));
            return out;
        } catch (JsonFormatException e) {
            return null;
        }
    }

    /**
     * Whether a message's sender is confirmed, for the agent tools (Security CS-L3): the member's own mail is; an email only
     * when its transport's DMARC result was {@code pass}, so a missing result is unconfirmed; a text ({@code sms}) never is,
     * as its sender can be spoofed, and an iMessage always is, as Apple's own; {@code ma} says null (its envelope's signature
     * names the sender).
     */
    static Boolean senderConfirmed(Msg m) {
        if ("out".equals(m.direction())) {
            return true;
        }
        // A text's sender can be spoofed, an iMessage's is Apple's (Security IM-L1, Wave 2.6).
        if ("sms".equals(m.medium())) {
            return false;
        }
        if ("imessage".equals(m.medium())) {
            return true;
        }
        if (!"email".equals(m.medium())) {
            return null;
        }
        Map<String, Object> a = auth(m.auth());
        return a != null && Boolean.TRUE.equals(a.get("senderConfirmed"));
    }

    /** One attachment of a message, with what Save to Files names its folder by. */
    public record Attachment(String messageId, String part, String name, String type, long bytes, String danger, boolean inline,
            String subject, long at) {}

    /** A message's attachment by its part id; null if there's no such message (or it waits for the parser) or part. */
    public Attachment attachment(String messageId, String part) throws SQLException {
        return store.db().read(c -> Sql.one(c, """
                SELECT m.id, a.part, a.name, a.type, a.bytes, a.danger, a.inline, m.subject, m.sort_at
                FROM messages m JOIN attachments a ON a.message_seq = m.seq
                WHERE m.id = ? AND a.part = ? AND m.lane <> 'pending' AND m.parse_state = 'ok'""",
                r -> new Attachment(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getLong(5), r.getString(6),
                        r.getInt(7) == 1, r.getString(8), r.getLong(9)), messageId, part));
    }

    /**
     * Documents (deskd API.md §24): the attachments of mail in the lanes documents follow (People, Updates and Other; never
     * Requests, Spam or Trash), in the order each message entered its lane, after a cursor ({@code laneAt.seq}), whole
     * messages at a time. Structure only: names, types, sizes, danger, the lane and the sender, never a body.
     */
    public record DocAttachment(long seq, long laneAt, String messageId, String part, String name, String type, long bytes,
            String danger, String lane, boolean bulk, boolean senderKnown, String origin, String threadRef, String subject,
            long receivedAt, String fromAddress, String fromName, String channelId, String contactId) {}

    public List<DocAttachment> documentsAfter(long laneAt, long seq, int messages) throws SQLException {
        return store.db().read(c -> Sql.list(c, """
                SELECT m.seq, m.lane_at, m.id, a.part, a.name, a.type, a.bytes, a.danger, m.lane, m.bulk, m.sender_known, m.origin,
                       coalesce(m.thread_id, m.channel_id), m.subject, m.received_at, e.value, coalesce(ct.name, e.display),
                       m.channel_id, e.contact_id
                FROM messages m JOIN attachments a ON a.message_seq = m.seq
                LEFT JOIN endpoints e ON e.id = m.from_endpoint
                LEFT JOIN contacts ct ON ct.id = e.contact_id
                WHERE m.seq IN (SELECT seq FROM messages WHERE (lane_at > ? OR (lane_at = ? AND seq > ?))
                                AND direction = 'in' AND parse_state = 'ok' AND lane IN ('people', 'updates', 'other')
                                AND attachment_count > 0 ORDER BY lane_at, seq LIMIT ?)
                  AND a.inline = 0
                ORDER BY m.lane_at, m.seq, a.part""",
                r -> new DocAttachment(r.getLong(1), r.getLong(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6),
                        r.getLong(7), r.getString(8), r.getString(9), r.getInt(10) == 1, r.getInt(11) == 1, r.getString(12),
                        r.getString(13), r.getString(14), r.getLong(15), r.getString(16), r.getString(17), r.getString(18),
                        r.getString(19)),
                laneAt, laneAt, seq, messages));
    }

    /** The first danger word among all of a message's attachments, however many it has; null for none. */
    public String anyDanger(String messageId) throws SQLException {
        return store.db().read(c -> Sql.stringOne(c, """
                SELECT a.danger FROM attachments a JOIN messages m ON m.seq = a.message_seq
                WHERE m.id = ? AND a.danger IS NOT NULL LIMIT 1""", messageId));
    }

    static List<Map<String, Object>> attachments(Connection c, long seq, int max) throws SQLException {
        return Sql.list(c, """
                SELECT part, name, type, bytes, content_id, inline, danger FROM attachments WHERE message_seq = ?
                ORDER BY rowid LIMIT ?""", r -> {
            Map<String, Object> a = new LinkedHashMap<>();
            a.put("part", r.getString(1));
            a.put("name", r.getString(2));
            a.put("type", r.getString(3));
            a.put("bytes", r.getLong(4));
            a.put("contentId", r.getString(5));
            a.put("inline", r.getInt(6) == 1);
            a.put("danger", r.getString(7));
            return a;
        }, seq, max);
    }

    // ---- search

    /** One search: hits newest first, each with a snippet and where its words are in it. */
    public Map<String, Object> search(SearchQuery q, List<String> lanes, String channelId, Object before, int limit, ZoneId zone)
            throws SQLException {
        Cursor cursor = Cursor.parse(before);
        int n = Math.max(1, Math.min(SEARCH_MAX, limit));
        return store.db().read(c -> {
            List<Object[]> rows = searchRows(c, q, lanes, channelId, cursor, n + 1, zone, null);
            List<Map<String, Object>> hits = new ArrayList<>();
            for (int i = 0; i < Math.min(n, rows.size()); i++) {
                Msg m = (Msg) rows.get(i)[0];
                String snippet = snippetFor((String) rows.get(i)[1], m);
                Map<String, Object> hit = brief(c, m);
                hit.put("channelId", m.channelId());
                hit.put("lane", m.lane());
                hit.put("snippet", snippet);
                hit.put("matches", matches(snippet, q.highlights()));
                hits.add(hit);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("hits", hits);
            out.put("next", rows.size() > n ? new Cursor((Long) rows.get(n - 1)[2], ((Msg) rows.get(n - 1)[0]).id()).wire() : null);
            return out;
        });
    }

    /**
     * The search's rows: {Msg, snippet, sort_key}. {@code lanes} limit it (an {@code in:} in the query narrows within
     * them; one outside them finds nothing). {@code range} is the agent tools' days, from and to in ms, or null.
     */
    List<Object[]> searchRows(Connection c, SearchQuery q, Collection<String> lanes, String channelId, Cursor cursor, int limit,
            ZoneId zone, long[] range) throws SQLException {
        Statement st = searchStatement(q, lanes, channelId, cursor, limit, zone, range);
        if (st == null) {
            return List.of();
        }
        return Sql.list(c, st.sql(), r -> new Object[] {Msg.of(r), r.getString(Msg.COUNT + 1), r.getLong(Msg.COUNT + 2)}, st.args());
    }

    /** The plan SQLite takes for a search ({@code EXPLAIN QUERY PLAN}'s lines), for the test that no search sorts. */
    List<String> searchPlan(Connection c, SearchQuery q, Collection<String> lanes, String channelId, Cursor cursor, ZoneId zone,
            long[] range) throws SQLException {
        Statement st = searchStatement(q, lanes, channelId, cursor, 51, zone, range);
        return st == null ? List.of() : Sql.list(c, "EXPLAIN QUERY PLAN " + st.sql(), r -> r.getString(4), st.args());
    }

    private record Statement(String sql, Object[] args) {}

    private static Statement searchStatement(SearchQuery q, Collection<String> lanes, String channelId, Cursor cursor, int limit,
            ZoneId zone, long[] range) {
        String match = q.match();
        List<String> use = new ArrayList<>(lanes);
        if (q.in != null && !q.in.equals("all") && !q.in.equals("sent")) {
            use.retainAll(List.of(q.in));
        }
        if (use.isEmpty()) {
            return null;
        }
        // Newest first by sort_key, which is the full-text index's rowid: the index hands its matches over in that order
        // and the query stops at a page, with no sort and a snippet only for the rows it returns. Each match's lane,
        // channel and flags are read from messages_key, so one that doesn't pass costs an index probe, not a row. With no
        // words, messages_key does the same, or one lane's index, or the channel's.
        StringBuilder sql = new StringBuilder("SELECT " + Msg.COLS);
        List<Object> args = new ArrayList<>();
        String key;
        if (match != null) {
            sql.append(", snippet(messages_fts, -1, '', '', '…', 40), m.sort_key FROM messages_fts"
                    + " JOIN messages m INDEXED BY messages_key ON m.sort_key = messages_fts.rowid WHERE messages_fts MATCH ?");
            args.add(match);
            key = "messages_fts.rowid";
        } else {
            // Several lanes and no channel: the key's index, whose columns answer each filter without the row.
            sql.append(", NULL, m.sort_key FROM messages m").append(use.size() > 1 && channelId == null ? " INDEXED BY messages_key" : "")
                    .append(" WHERE 1 = 1");
            key = "m.sort_key";
        }
        sql.append(" AND m.lane IN (").append(Sql.marks(use.size())).append(")");
        args.addAll(use);
        if ("sent".equals(q.in)) {
            sql.append(" AND m.direction = 'out'");
        }
        if (channelId != null) {
            sql.append(" AND m.channel_id = ?");
            args.add(channelId);
        }
        if (q.hasAttachment) {
            sql.append(" AND m.attachment_count > 0");
        }
        if (q.unread) {
            sql.append(" AND m.read = 0 AND m.direction = 'in'");
        }
        if (q.before != null) {
            sql.append(" AND ").append(key).append(" < ?");
            args.add(Ingest.keyAt(SearchQuery.startOf(q.before, zone)));
        }
        if (q.after != null) {
            sql.append(" AND ").append(key).append(" >= ?");
            args.add(Ingest.keyAt(SearchQuery.startOf(q.after, zone)));
        }
        if (range != null) {
            sql.append(" AND ").append(key).append(" >= ? AND ").append(key).append(" < ?");
            args.add(Ingest.keyAt(range[0]));
            args.add(Ingest.keyAt(range[1]));
        }
        if (cursor != null) {
            // A search's cursor carries the last hit's sort_key, so a page after a delete still starts where it was.
            sql.append(" AND ").append(key).append(" < ?");
            args.add(cursor.at());
        }
        sql.append(" ORDER BY ").append(key).append(" DESC LIMIT ?");
        args.add(limit);
        return new Statement(sql.toString(), args.toArray());
    }

    private static String snippetFor(String fts, Msg m) {
        String s = fts == null || fts.isBlank() ? m.snippet() : Norm.line(fts, 400);
        if (s == null) {
            return m.subject() == null ? "" : m.subject();
        }
        return s.length() > 200 ? s.substring(0, 199) + "…" : s;
    }

    /** Where each word starts a word in the text, as {@code [start, end]} pairs, folded as the index folds. */
    static List<List<Integer>> matches(String text, Collection<String> words) {
        List<List<Integer>> out = new ArrayList<>();
        if (text == null || words.isEmpty()) {
            return out;
        }
        String hay = foldKeepingLength(text);
        for (String w : words) {
            int i = hay.indexOf(w);
            while (i >= 0 && out.size() < 64) {
                if (i == 0 || !Character.isLetterOrDigit(hay.charAt(i - 1))) {
                    out.add(List.of(i, i + w.length()));
                }
                i = hay.indexOf(w, i + 1);
            }
        }
        out.sort((a, b) -> Integer.compare(a.get(0), b.get(0)));
        return out;
    }

    /** As Notebook's {@code fold}: one character in, one out, so offsets map back. */
    static String foldKeepingLength(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            String f = Norm.fold(String.valueOf(ch));
            out.append(f.length() == 1 ? f.charAt(0) : ch);
        }
        return out.toString();
    }

    // ---- contacts, drafts, the queue

    public Map<String, Object> contacts(String q, Object after, int limit) throws SQLException {
        int n = Math.max(1, Math.min(LIST_MAX, limit));
        String afterId = after == null ? "" : (after instanceof String s && Ulid.valid(s) ? s : null);
        if (afterId == null) {
            throw new IllegalArgumentException("after");
        }
        String like = q == null || q.isBlank() ? null : "%" + Norm.fold(q.strip()).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        return store.db().read(c -> {
            List<String> ids = like == null
                    ? Sql.list(c, "SELECT id FROM contacts WHERE id > ? ORDER BY id LIMIT ?", r -> r.getString(1), afterId, n + 1)
                    : Sql.list(c, """
                            SELECT DISTINCT ct.id FROM contacts ct LEFT JOIN endpoints e ON e.contact_id = ct.id
                            WHERE ct.id > ? AND (lower(ct.name) LIKE ? ESCAPE '\\' OR e.value LIKE ? ESCAPE '\\')
                            ORDER BY ct.id LIMIT ?""", r -> r.getString(1), afterId, like, like, n + 1);
            List<Map<String, Object>> rows = new ArrayList<>();
            for (int i = 0; i < Math.min(n, ids.size()); i++) {
                rows.add(contact(c, ids.get(i)));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("contacts", rows);
            out.put("next", ids.size() > n ? ids.get(n - 1) : null);
            return out;
        });
    }

    public Map<String, Object> contactById(String contactId) throws SQLException {
        return store.db().read(c -> contact(c, contactId));
    }

    static Map<String, Object> contact(Connection c, String contactId) throws SQLException {
        Map<String, Object> out = Sql.one(c, "SELECT id, name, named FROM contacts WHERE id = ?", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("contactId", r.getString(1));
            m.put("name", r.getString(2));
            m.put("named", r.getInt(3) == 1);
            return m;
        }, contactId);
        if (out == null) {
            return null;
        }
        out.put("endpoints", Sql.list(c, """
                SELECT kind, value, standing, last_inbound_at, last_inbound_medium, source FROM endpoints WHERE contact_id = ?
                ORDER BY first_seen_at, id""", r -> {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("kind", r.getString(1));
            e.put("value", r.getString(2));
            e.put("standing", r.getString(3));
            e.put("lastInboundAt", Sql.nullableLong(r, "last_inbound_at"));
            e.put("lastInboundMedium", r.getString(5));
            // Where it came from (flow 11's person view): added, card, mac, provider, or a message. No provider is linked yet.
            e.put("source", r.getString(6) == null ? "message" : r.getString(6));
            e.put("provider", null);
            return e;
        }, contactId));
        return out;
    }

    public List<Map<String, Object>> drafts() throws SQLException {
        return store.db().read(c -> Sql.list(c, """
                SELECT id, channel_id, medium, account_id, to_list, subject, substr(text, 1, 200), version, updated_at
                FROM drafts ORDER BY updated_at DESC LIMIT 200""", Queries::draftRow));
    }

    public Map<String, Object> draft(String draftId) throws SQLException {
        return store.db().read(c -> Sql.one(c, """
                SELECT id, channel_id, medium, account_id, to_list, subject, text, version, updated_at, reply_to
                FROM drafts WHERE id = ?""", r -> {
            Map<String, Object> d = draftRow(r);
            d.put("replyTo", r.getString(10));
            return d;
        }, draftId));
    }

    private static Map<String, Object> draftRow(ResultSet r) throws SQLException {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("draftId", r.getString(1));
        d.put("channelId", r.getString(2));
        d.put("medium", r.getString(3));
        d.put("accountId", r.getString(4));
        String to = r.getString(5);
        d.put("to", to == null ? List.of() : List.of(to.split("\n")));
        d.put("subject", r.getString(6));
        d.put("text", r.getString(7));
        d.put("version", r.getLong(8));
        d.put("updatedAt", r.getLong(9));
        return d;
    }

    public List<Map<String, Object>> outbound() throws SQLException {
        return store.db().read(c -> Sql.list(c, """
                SELECT o.id, m.id, m.channel_id, o.state, o.not_before, o.attempts, o.last_error, o.give_up_at, m.medium, m.subject
                FROM outbound o JOIN messages m ON m.seq = o.message_seq ORDER BY o.created_at DESC LIMIT 200""", r -> {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("outboundId", r.getString(1));
            o.put("messageId", r.getString(2));
            o.put("channelId", r.getString(3));
            o.put("state", r.getString(4));
            o.put("notBefore", r.getLong(5));
            o.put("attempts", r.getLong(6));
            o.put("error", r.getString(7));
            o.put("giveUpAt", r.getLong(8));
            o.put("medium", r.getString(9));
            o.put("subject", r.getString(10));
            return o;
        }));
    }
}
