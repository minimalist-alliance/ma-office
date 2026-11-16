package com.minimalistalliance.desk.deskd.courier.store;

import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Storing one message, inside the writer's transaction: the sink's key, routing to a channel (design §8.4: a thread match,
 * else one sender's direct channel, else a group), threading (JWZ by Message-ID, In-Reply-To and References, in any order
 * of arrival, with a subject fallback for replies only), the lane, and the summary rows.
 *
 * <p><b>A thread match never lets a stranger into a channel.</b> A Message-ID isn't secret (it travels in every reply, list
 * archive and forward), so a References header could otherwise put a stranger's mail into a contact's channel among
 * People. A thread joins only if its channel already has the sender as a member, or the message is the member's own. The
 * member's own is what the transport flags as theirs, or an email from their address that passed DMARC: never a From
 * header alone.
 */
final class Ingest {

    private static final long SUBJECT_WINDOW_MS = 30L * 24 * 3600 * 1000;
    /** The most messages one of the member's sent messages teaches the filter, through the senders it lets in. */
    static final int LET_IN_TEACHES = 20;
    private static final String NOBODY = "nobody@invalid";

    private final Ulid ids;
    private final SpamFilter filter;
    private long lastReceived;

    Ingest(Ulid ids, long lastReceived, SpamFilter filter) {
        this.ids = ids;
        this.lastReceived = lastReceived;
        this.filter = filter;
    }

    /**
     * A message ready for the writer: parsed (or known to wait), its blob staged or compressed.
     *
     * @param inline the blob's gzip bytes when it goes in the database, written with the row; null for a file or none
     */
    record Prepared(Courier.Inbound in, ParsedMessage parsed, String parseState, String parseReason, String blob, long rawBytes,
            String reuseId, Long reuseReceivedAt, byte[] inline) {

        static Prepared of(Courier.Inbound in, ParsedMessage parsed, String parseState, String parseReason, String blob, long rawBytes) {
            return new Prepared(in, parsed, parseState, parseReason, blob, rawBytes, null, null, null);
        }

        Prepared withInline(byte[] gz) {
            return new Prepared(in, parsed, parseState, parseReason, blob, rawBytes, reuseId, reuseReceivedAt, gz);
        }
    }

    /** A millisecond's room in {@code sort_key}: a million messages. */
    static final long KEY_SPAN = 1L << 20;
    private static final long KEY_MAX_MS = Long.MAX_VALUE / KEY_SPAN - 2;

    /**
     * A message's place in the search's order (draft ADR §6): its {@code sort_at} in the high bits and its arrival among
     * that millisecond's messages in the low ones, so it's unique and newest is largest. A millisecond with a million
     * already takes the next one's room. {@code sort_at} never changes, so neither does this.
     */
    static long sortKey(Connection c, long sortAt) throws SQLException {
        for (long ms = keyMs(sortAt); ms <= KEY_MAX_MS; ms++) {
            long base = ms * KEY_SPAN;
            Long max = Sql.longOne(c, "SELECT max(sort_key) FROM messages WHERE sort_key >= ? AND sort_key < ?", base, base + KEY_SPAN);
            if (max == null) {
                return base;
            }
            if (max + 1 < base + KEY_SPAN) {
                return max + 1;
            }
        }
        throw new SQLException("no sort key");
    }

    /** The first {@code sort_key} at or after a time: a search's bound. */
    static long keyAt(long ms) {
        return keyMs(ms) * KEY_SPAN;
    }

    private static long keyMs(long ms) {
        return Math.max(0, Math.min(KEY_MAX_MS, ms));
    }

    /** A small blob goes in with the row that names it, in the same transaction. */
    private static void writeInline(Connection c, Prepared p) throws SQLException {
        if (p.inline() != null && p.blob() != null) {
            Sql.update(c, "INSERT OR IGNORE INTO blob_data (sha, data) VALUES (?, ?)", p.blob(), p.inline());
        }
    }

    /** The desk's receive time: never below the last one, so the agent cursor's order holds when the clock goes back. */
    long receivedAt(long now) {
        lastReceived = Math.max(now, lastReceived);
        return lastReceived;
    }

    /**
     * Gives messages that just became visible to agents (let in, out of Spam or Trash) a receive time past every other, so
     * an agent's {@code courier_new} cursor, which may have passed their first one, sees them (draft agent tools ADR §12).
     */
    void restamp(Connection c, List<Long> seqs, long now) throws SQLException {
        for (Long seq : seqs) {
            lastReceived = Math.max(now, lastReceived + 1);
            Sql.update(c, "UPDATE messages SET received_at = ? WHERE seq = ?", lastReceived, seq);
        }
        seqs.clear();
    }

    Courier.Accepted store(Connection c, Prepared p, long now, Courier.ChangeSet changes) throws SQLException {
        Courier.Inbound in = p.in();
        String existing = Sql.stringOne(c, "SELECT id FROM messages WHERE medium = ? AND external_id = ?", in.medium(), in.externalId());
        if (existing != null) {
            return Courier.Accepted.duplicate(existing);
        }
        String accountKind = Sql.stringOne(c, "SELECT kind FROM accounts WHERE id = ?", in.accountId());
        if (accountKind == null) {
            return Courier.Accepted.refused("account");
        }
        long received = p.reuseReceivedAt() != null ? p.reuseReceivedAt() : receivedAt(now);
        String id = p.reuseId() != null ? p.reuseId() : ids.next(received);
        if ("pending".equals(p.parseState())) {
            writeInline(c, p);
            Sql.insert(c, """
                    INSERT INTO messages (id, medium, external_id, account_id, channel_id, direction, author_kind, lane, lane_at,
                      bulk, sender_known, status, read, sent_at, received_at, sort_at, sort_key, parse_state, auth, labels, blob,
                      raw_bytes, origin)
                    VALUES (?, ?, ?, ?, NULL, ?, 'human', 'pending', ?, 0, 0, 'received', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)""",
                    id, in.medium(), in.externalId(), in.accountId(), in.outgoing() ? "out" : "in", received, in.seen() || in.outgoing(),
                    in.sentAt(), received, received, sortKey(c, received), auth(in.verdicts()), labels(in.labels(), List.of()), p.blob(), p.rawBytes(), in.origin().wire);
            changes.counts = true;
            return Courier.Accepted.pending(id);
        }
        ParsedMessage m = p.parsed() != null ? p.parsed() : empty();
        String medium = in.medium();
        // The transport's results as they stand for this message: a provider's read from its own Authentication-Results,
        // and a DMARC pass kept only for the From's own domain (Security CP-L2; Courier.Verdicts.resolve).
        Courier.Verdicts verdicts = Courier.Verdicts.resolve(in.verdicts(), p.parsed(), medium);

        // Who sent it, and whether it's the member's own.
        ParsedMessage.Address from = m.from();
        String fromValue = from == null ? null : Norm.endpoint(Accounts.endpointKind(medium, from.address()), from.address());
        String fromKind = Accounts.endpointKind(medium, fromValue);
        // The member's own mail is what the transport says is theirs (a Sent folder, Courier's own echo), or an email from
        // one of their addresses whose DMARC passed. A From header alone is anyone's to write (Security CS-M1): mail that only
        // claims the member's address is a stranger's, joins no thread by id, lets no one in and attaches no bytes.
        boolean outgoing = in.outgoing() || (fromValue != null && "email".equals(medium) && verdicts.dmarcPassed()
                && Graph.isOwn(c, fromKind, fromValue));

        // An echo of a message the member sent from Courier, from a Sent folder or a list: the same message.
        if (outgoing && m.messageId() != null) {
            String[] sent = Sql.one(c, "SELECT id, blob FROM messages WHERE msgid = ? AND direction = 'out' AND origin = 'member'",
                    r -> new String[] {r.getString(1), r.getString(2)}, m.messageId());
            if (sent != null) {
                if (sent[1] == null && p.blob() != null) {
                    writeInline(c, p);
                    Sql.update(c, "UPDATE messages SET blob = ?, raw_bytes = ? WHERE id = ?", p.blob(), p.rawBytes(), sent[0]);
                }
                return Courier.Accepted.duplicate(sent[0]);
            }
        }

        Graph.Endpoint sender = null;
        if (!outgoing) {
            String value = fromValue != null ? fromValue : NOBODY;
            sender = Graph.endpoint(c, ids, fromValue != null ? fromKind : "email", value, from == null ? null : from.name(), now, false);
        }

        // Recipients, and the tags of the member's own +addresses as labels.
        List<String[]> recipients = new ArrayList<>(); // endpointId, role
        Set<String> participants = new LinkedHashSet<>(); // endpoint ids other than the member
        List<String> tags = new ArrayList<>();
        StringBuilder searchTo = new StringBuilder();
        addRecipients(c, m.to(), "to", medium, outgoing, now, recipients, participants, tags, searchTo);
        addRecipients(c, m.cc(), "cc", medium, outgoing, now, recipients, participants, tags, searchTo);
        addRecipients(c, m.bcc(), "bcc", medium, outgoing, now, recipients, participants, tags, searchTo);
        if (sender != null) {
            participants.remove(sender.id());
        }

        // Threading candidates by id, in any order of arrival.
        List<String> refs = Norm.parents(m.references(), m.inReplyTo(), m.messageId());
        ThreadRow chosen = null;
        List<ThreadRow> others = new ArrayList<>();
        String[] listKey = m.listId() == null ? null : Graph.listKey(m.listId());
        if (!refs.isEmpty() || m.messageId() != null) {
            for (ThreadRow t : candidates(c, refs, m.messageId())) {
                if (!admits(c, t, outgoing, sender, listKey)) {
                    continue;
                }
                if (chosen == null) {
                    chosen = t;
                } else if (t.channelId().equals(chosen.channelId())) {
                    others.add(t);
                }
            }
        }

        // The channel.
        String channelId;
        Set<String> members = new LinkedHashSet<>(participants);
        if (sender != null) {
            members.add(sender.id());
        }
        if (chosen != null) {
            channelId = chosen.channelId();
        } else if (in.group() != null && !"email".equals(medium)) {
            // A chat's group conversation (an iMessage group): one conversation per group, whoever joins or leaves it.
            channelId = Graph.channel(c, ids, "chat:" + in.group().key(), "group", in.group().title(), members, now);
            if (in.group().title() != null) {
                Sql.update(c, "UPDATE channels SET title = ? WHERE id = ? AND (title IS NULL OR title <> ?)", in.group().title(), channelId,
                        in.group().title());
            }
        } else if (listKey != null) {
            channelId = Graph.channel(c, ids, listKey[0], "group", listKey[1], members, now);
        } else if (members.isEmpty()) {
            channelId = Graph.channel(c, ids, "self", "self", null, List.of(), now);
        } else if (members.size() == 1) {
            String only = members.iterator().next();
            Graph.Endpoint e = Graph.endpointById(c, only);
            channelId = Graph.channel(c, ids, "direct:" + e.contactId(), "direct", null, members, now);
        } else {
            channelId = Graph.channel(c, ids, Graph.groupKey(members), "group", null, members, now);
        }

        // The email thread inside it.
        String subjectNorm = Norm.subject(m.subject());
        long sentAt = m.date() != null ? m.date() : in.sentAt() != null ? in.sentAt() : received;
        long sortAt = Math.max(0, Math.min(sentAt, received));
        String threadId = null;
        boolean memberThread = false;
        boolean newThread = false;
        boolean email = "email".equals(medium);
        if (email) {
            if (chosen == null && subjectNorm != null && Norm.isReplySubject(m.subject())) {
                chosen = Sql.one(c, """
                        SELECT id, channel_id, started_by_member, created_at FROM threads
                        WHERE channel_id = ? AND subject_norm = ? AND last_at >= ? ORDER BY last_at DESC LIMIT 1""",
                        r -> new ThreadRow(r.getString(1), r.getString(2), r.getInt(3) == 1, r.getLong(4)),
                        channelId, subjectNorm, sortAt - SUBJECT_WINDOW_MS);
            }
            if (chosen == null) {
                newThread = true;
                threadId = ids.next(now);
                Sql.update(c, """
                        INSERT INTO threads (id, channel_id, subject_norm, started_by_member, last_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)""", threadId, channelId, subjectNorm, outgoing, sortAt, now);
                memberThread = outgoing;
            } else {
                threadId = chosen.id();
                memberThread = chosen.startedByMember();
                for (ThreadRow t : others) {
                    Sql.update(c, "UPDATE messages SET thread_id = ? WHERE thread_id = ?", threadId, t.id());
                    memberThread |= t.startedByMember();
                    Sql.update(c, "DELETE FROM threads WHERE id = ?", t.id());
                }
                Sql.update(c, "UPDATE threads SET last_at = MAX(last_at, ?), started_by_member = ? WHERE id = ?", sortAt, memberThread, threadId);
            }
        }

        // The lane.
        boolean bulk = m.listUnsubscribe() || isBulkPrecedence(m.precedence());
        String standing = sender == null ? Lanes.KNOWN : sender.standing();
        boolean blocked = sender != null && Graph.blocked(c, sender.kind(), sender.value());
        // Only a thread the sender was admitted to counts: a new thread a stranger starts was never the member's.
        boolean joinedMemberThread = memberThread && threadId != null && !newThread;
        // A known sender's email whose DMARC failed only claims to be them: a Request, with its card (not mail that merely
        // can't be confirmed, which stays theirs, marked "Couldn't confirm").
        boolean dmarcFailed = "email".equals(medium) && "fail".equalsIgnoreCase(verdicts.dmarc() == null ? null : verdicts.dmarc().strip());
        Lanes.Facts facts = new Lanes.Facts(outgoing, blocked, verdicts.spam() || verdicts.virus(), standing, bulk,
                joinedMemberThread, accountKind, false, dmarcFailed);
        // The learning filter judges only a stranger's mail that would otherwise be a Request or Other (SpamFilter).
        boolean filterSpam = false;
        if (filter != null && sender != null && facts.filterMayJudge()) {
            List<String[]> named = new ArrayList<>();
            for (ParsedMessage.Part part : m.attachments()) {
                if (named.size() == 50) {
                    break;
                }
                named.add(new String[] {part.name(), part.type(), part.danger()});
            }
            Double score = filter.score(c, SpamFilter.features(m.subject(), fromValue, from == null ? null : from.name(),
                    m.text(), named, bulk, Norm.line(verdicts.dmarc(), 16)));
            filterSpam = score != null && score >= SpamFilter.SPAM_CUTOFF;
        }
        String lane = Lanes.pick(new Lanes.Facts(facts.outgoing(), facts.blocked(), facts.spamVerdict(), facts.standing(),
                facts.bulk(), facts.memberThread(), facts.accountKind(), filterSpam, facts.dmarcFailed()));
        String screen = filterSpam && Lanes.SPAM.equals(lane) ? "filter" : null;
        // Where "Not spam" puts it back: where it would have been without the filter (a Request, or Other).
        String laneBefore = screen != null ? Lanes.pick(facts) : null;
        // The sender warnings (plan §3.5), for a stranger's mail: a contact's name on another address, a lookalike domain.
        String warn = null;
        if (sender != null && !Lanes.KNOWN.equals(standing) && fromValue != null) {
            warn = Senders.wire(Senders.warnings(c, fromKind, fromValue, Graph.displayName(from.name()), from.name(), sender.contactId()));
        }
        boolean read = in.seen() || outgoing;

        // The row, then what hangs off it.
        String text = m.text() == null ? "" : m.text();
        StringBuilder attachNames = new StringBuilder();
        int attachmentCount = 0;
        for (ParsedMessage.Part part : m.attachments()) {
            if (!part.inline()) {
                attachmentCount++;
            }
            if (part.name() != null) {
                attachNames.append(part.name()).append(' ');
            }
        }
        String searchFrom = from == null ? null : ((from.name() == null ? "" : from.name() + " ") + from.address());
        writeInline(c, p);
        long seq = Sql.insert(c, """
                INSERT INTO messages (id, medium, external_id, account_id, channel_id, thread_id, direction, author_kind,
                  from_endpoint, lane, lane_before, lane_at, bulk, sender_known, status, read, sent_at, received_at, sort_at, sort_key, msgid,
                  subject, subject_norm, snippet, body_text, body_html, text_truncated, search_from, search_to, search_attach,
                  attachment_count, parse_state, parse_reason, auth, labels, list_id, blob, raw_bytes, origin, screen, warn)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                id, medium, in.externalId(), in.accountId(), channelId, threadId, outgoing ? "out" : "in",
                sender == null ? null : sender.id(), lane, laneBefore, now, bulk, Lanes.KNOWN.equals(standing), outgoing ? "sent" : "received",
                read, sentAt, received, sortAt, sortKey(c, sortAt), m.messageId(), m.subject(), subjectNorm, snippet(text), text, m.html(),
                m.textTruncated(), searchFrom, searchTo.isEmpty() ? null : searchTo.toString().strip(),
                attachNames.isEmpty() ? null : attachNames.toString().strip(), attachmentCount, p.parseState(), p.parseReason(),
                auth(verdicts), labels(in.labels(), tags), m.listId(), p.blob(), p.rawBytes(), in.origin().wire, screen, warn);
        for (String ref : refs) {
            Sql.update(c, "INSERT OR IGNORE INTO message_refs (message_seq, ref) VALUES (?, ?)", seq, ref);
        }
        for (String[] r : recipients) {
            Sql.update(c, "INSERT OR IGNORE INTO recipients (message_seq, endpoint_id, role, status) VALUES (?, ?, ?, NULL)", seq, r[0], r[1]);
        }
        int n = 0;
        for (ParsedMessage.Part part : m.attachments()) {
            n++;
            Sql.update(c, """
                    INSERT OR IGNORE INTO attachments (message_seq, part, name, type, bytes, content_id, inline, danger)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", seq, part.part() == null ? Integer.toString(n) : part.part(), part.name(),
                    part.type(), part.bytes(), part.contentId(), part.inline(), part.danger());
        }
        if (sender != null) {
            Sql.update(c, "UPDATE endpoints SET last_inbound_at = MAX(coalesce(last_inbound_at, 0), ?), last_inbound_medium = ? WHERE id = ?",
                    sortAt, medium, sender.id());
        }
        Graph.bump(c, channelId, lane, sortAt, seq, !read && !outgoing);
        changes.lane(channelId, lane);

        // Writing to someone lets them in: their Requests and Other move to People.
        if (outgoing) {
            Set<String> contacts = new LinkedHashSet<>();
            for (String e : participants) {
                Sql.update(c, "UPDATE endpoints SET written_to = 1 WHERE id = ?", e);
                Graph.Endpoint ep = Graph.endpointById(c, e);
                if (ep != null && !Lanes.BLOCKED.equals(ep.standing())) {
                    contacts.add(ep.contactId());
                }
            }
            // Writing to someone says their mail is wanted: what it moved teaches the filter (a few, as the sink is hot).
            List<Long> wanted = new ArrayList<>();
            for (String contact : contacts) {
                wanted.addAll(Graph.letIn(c, contact, now, changes));
            }
            if (filter != null && !wanted.isEmpty()) {
                filter.train(c, wanted.size() > LET_IN_TEACHES ? wanted.subList(0, LET_IN_TEACHES) : wanted, SpamFilter.HAM, now);
            }
        }
        return Courier.Accepted.stored(id);
    }

    private void addRecipients(Connection c, List<ParsedMessage.Address> list, String role, String medium, boolean outgoing,
            long now, List<String[]> recipients, Set<String> participants, List<String> tags, StringBuilder searchTo)
            throws SQLException {
        for (ParsedMessage.Address a : list) {
            String kind = Accounts.endpointKind(medium, a.address());
            String value = Norm.endpoint(kind, a.address());
            if (value == null) {
                continue;
            }
            if (a.name() != null) {
                searchTo.append(a.name()).append(' ');
            }
            searchTo.append(value).append(' ');
            if (Graph.isOwn(c, kind, value)) {
                String tag = Norm.tag(value);
                if (tag != null && !tags.contains(tag)) {
                    tags.add(tag);
                }
                continue;
            }
            // Someone the member writes to is known from now on; a stranger's other recipients aren't.
            Graph.Endpoint e = Graph.endpoint(c, ids, kind, value, a.name(), now, outgoing);
            recipients.add(new String[] {e.id(), role});
            participants.add(e.id());
        }
    }

    /**
     * Whether a thread may take this message: the member's own always; otherwise its sender must be a member of the
     * thread's channel, someone a message in the thread was addressed to (a contact's reply-all that brought them in), or,
     * for a list's thread, a poster to the same list. A Message-ID alone admits no one.
     */
    private static boolean admits(Connection c, ThreadRow t, boolean outgoing, Graph.Endpoint sender, String[] listKey) throws SQLException {
        if (outgoing) {
            return true;
        }
        if (sender == null) {
            return false;
        }
        if (Graph.isMember(c, t.channelId(), sender.id())) {
            return true;
        }
        if (listKey != null && listKey[0].equals(Sql.stringOne(c, "SELECT key FROM channels WHERE id = ?", t.channelId()))) {
            return true;
        }
        return Sql.exists(c, """
                SELECT 1 FROM recipients r JOIN messages m ON m.seq = r.message_seq
                WHERE m.thread_id = ? AND r.endpoint_id = ? LIMIT 1""", t.id(), sender.id());
    }

    /** An email thread a message could join. */
    record ThreadRow(String id, String channelId, boolean startedByMember, long createdAt) {}

    /**
     * Threads that hold one of the message's parents, a message naming one of the same parents (a sibling whose parent never
     * came), a message naming this one (a child that came first), or a message with this one's id (the same message through
     * another account). Oldest first.
     */
    private static List<ThreadRow> candidates(Connection c, List<String> refs, String msgid) throws SQLException {
        Set<String> threadIds = new LinkedHashSet<>();
        if (!refs.isEmpty()) {
            String in = Sql.marks(refs.size());
            Object[] args = refs.toArray();
            threadIds.addAll(Sql.list(c, "SELECT DISTINCT thread_id FROM messages WHERE msgid IN (" + in + ") AND thread_id IS NOT NULL",
                    r -> r.getString(1), args));
            threadIds.addAll(Sql.list(c, """
                    SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.seq = r.message_seq
                    WHERE r.ref IN (""" + in + ") AND m.thread_id IS NOT NULL", r -> r.getString(1), args));
        }
        if (msgid != null) {
            threadIds.addAll(Sql.list(c, """
                    SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.seq = r.message_seq
                    WHERE r.ref = ? AND m.thread_id IS NOT NULL""", r -> r.getString(1), msgid));
            // The same message through another account (or a mailer that reuses ids): the same thread.
            threadIds.addAll(Sql.list(c, "SELECT DISTINCT thread_id FROM messages WHERE msgid = ? AND thread_id IS NOT NULL",
                    r -> r.getString(1), msgid));
        }
        List<ThreadRow> out = new ArrayList<>();
        for (String t : threadIds) {
            ThreadRow thread = Sql.one(c, "SELECT id, channel_id, started_by_member, created_at FROM threads WHERE id = ?",
                    r -> new ThreadRow(r.getString(1), r.getString(2), r.getInt(3) == 1, r.getLong(4)), t);
            if (thread != null) {
                out.add(thread);
            }
        }
        out.sort((a, b) -> a.createdAt() != b.createdAt() ? Long.compare(a.createdAt(), b.createdAt()) : a.id().compareTo(b.id()));
        return out;
    }

    static boolean isBulkPrecedence(String precedence) {
        if (precedence == null) {
            return false;
        }
        String p = precedence.toLowerCase(Locale.ROOT).strip();
        return p.equals("bulk") || p.equals("list") || p.equals("junk");
    }

    /** The first 200 characters of what's new: quoted lines and the line introducing them left out. */
    static String snippet(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        StringBuilder out = new StringBuilder(220);
        for (String line : text.split("\n", 400)) {
            String l = line.strip();
            if (l.startsWith(">")) {
                continue;
            }
            if (!out.isEmpty()) {
                out.append(' ');
            }
            out.append(l);
            if (out.length() >= 260) {
                break;
            }
        }
        return Norm.line(out.toString(), 200);
    }

    /** The results as kept: resolved for a parsed message, as the transport gave them for one waiting for the parser. */
    private static String auth(Courier.Verdicts v) {
        if (v == null || v.equals(Courier.Verdicts.NONE)) {
            return null;
        }
        return new String(Json.bytes(v.wire()), StandardCharsets.UTF_8);
    }

    static String labels(List<String> source, List<String> tags) {
        Set<String> all = new LinkedHashSet<>();
        for (String l : source) {
            String clean = Norm.line(l, 120);
            if (clean != null && all.size() < 50) {
                all.add(clean);
            }
        }
        for (String t : tags) {
            if (all.size() < 50) {
                all.add(t);
            }
        }
        return all.isEmpty() ? null : String.join("\n", all);
    }

    private static ParsedMessage empty() {
        return new ParsedMessage(null, List.of(), List.of(), List.of(), List.of(), null, null, null, List.of(), List.of(), null,
                false, null, null, "", false, null, List.of(), List.of());
    }

    /** For tests: the facts the store keeps about a message's routing. */
    static Map<String, Object> describe(Connection c, String id) throws SQLException {
        return Sql.one(c, "SELECT channel_id, thread_id, lane, direction FROM messages WHERE id = ?", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("channel", r.getString(1));
            m.put("thread", r.getString(2));
            m.put("lane", r.getString(3));
            m.put("direction", r.getString(4));
            return m;
        }, id);
    }
}
