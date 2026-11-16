package com.minimalistalliance.desk.deskd.courier.store;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What the member does: read and unread, moves between lanes, Done, Requests' "Let in", "Not now" and "Block", blocks by
 * address or domain, delete and Trash, drafts, and contacts. Each is one transaction, and each tells {@code courier.changed}.
 */
public final class Actions {

    public static final int MAX_IDS = 500;
    public static final int MAX_DRAFT_TEXT = 1_000_000;

    /** A refusal the methods turn into an error code. */
    public static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        private final String code;
        private final String reason;

        public Refused(String code, String reason) {
            super(code + ":" + reason, null, false, false);
            this.code = code;
            this.reason = reason;
        }

        public String code() {
            return code;
        }

        public String reason() {
            return reason;
        }
    }

    private final CourierStore store;

    Actions(CourierStore store) {
        this.store = store;
    }

    /** The messages a call names: its ids, or a channel's lane (every message there). Pending ones are never named. */
    private static List<Long> select(Connection c, List<String> messageIds, String channelId, String lane) throws SQLException {
        if (messageIds != null) {
            List<Long> out = new ArrayList<>();
            for (String id : messageIds) {
                Long seq = Sql.longOne(c, "SELECT seq FROM messages WHERE id = ? AND lane <> 'pending'", id);
                if (seq != null) {
                    out.add(seq);
                }
            }
            return out;
        }
        if (lane != null) {
            return Sql.list(c, "SELECT seq FROM messages WHERE channel_id = ? AND lane = ?", r -> r.getLong(1), channelId, lane);
        }
        return Sql.list(c, "SELECT seq FROM messages WHERE channel_id = ? AND lane IN ('people', 'requests', 'updates', 'other')",
                r -> r.getLong(1), channelId);
    }

    /** Marks read or unread. @return how many changed */
    public int setRead(List<String> messageIds, String channelId, String lane, boolean read) throws SQLException {
        return store.write((c, changes) -> {
            List<Long> seqs = select(c, messageIds, channelId, lane);
            Set<Graph.Pair> pairs = new LinkedHashSet<>();
            int n = 0;
            List<Long> changed = new ArrayList<>();
            for (Long seq : seqs) {
                Graph.Pair p = Sql.one(c, "SELECT channel_id, lane FROM messages WHERE seq = ? AND read <> ?",
                        r -> new Graph.Pair(r.getString(1), r.getString(2)), seq, read);
                if (p == null) {
                    continue;
                }
                Sql.update(c, "UPDATE messages SET read = ? WHERE seq = ?", read, seq);
                pairs.add(p);
                changed.add(seq);
                n++;
            }
            // A linked mailbox's provider is told too (\Seen), by its transport.
            store.linked().recordOps(c, changed, read ? LinkedState.OP_READ : LinkedState.OP_UNREAD, changes);
            for (Graph.Pair p : pairs) {
                Graph.refresh(c, p.channelId(), p.lane());
                changes.lane(p.channelId(), p.lane());
            }
            return n;
        });
    }

    /**
     * Moves messages to a lane, or {@code restore} back from Spam or Trash. Moving a stranger's mail to People or Updates
     * lets them in, as "Let in" does.
     *
     * @return how many moved
     */
    public int move(List<String> messageIds, String channelId, String lane, String to) throws SQLException, Refused {
        if (!"restore".equals(to) && !Lanes.MOVABLE.contains(to)) {
            throw new Refused("bad_request", "to");
        }
        return store.write((c, changes) -> {
            List<Long> seqs = select(c, messageIds, channelId, lane);
            long now = store.now();
            int n = 0;
            Set<String> letIn = new LinkedHashSet<>();
            Map<String, List<Long>> owed = new java.util.LinkedHashMap<>();
            // What the member's moves teach the learning filter: into Spam is spam; out of it (not to Trash) is wanted.
            List<Long> spam = new ArrayList<>();
            List<Long> wanted = new ArrayList<>();
            for (Long seq : seqs) {
                String[] row = Sql.one(c, """
                        SELECT m.lane, m.lane_before, e.contact_id, e.standing FROM messages m LEFT JOIN endpoints e ON e.id = m.from_endpoint
                        WHERE m.seq = ?""", r -> new String[] {r.getString(1), r.getString(2), r.getString(3), r.getString(4)}, seq);
                if (row == null) {
                    continue;
                }
                String target = to;
                if ("restore".equals(to)) {
                    if (!Lanes.SPAM.equals(row[0]) && !Lanes.TRASH.equals(row[0])) {
                        continue;
                    }
                    target = row[1] != null && Lanes.valid(row[1]) ? row[1] : Lanes.PEOPLE;
                    if (Lanes.REQUESTS.equals(target) || Lanes.OTHER.equals(target)) {
                        // Back where it was, unless its sender has since been let in.
                        target = Lanes.KNOWN.equals(row[3]) ? Lanes.PEOPLE : target;
                    }
                }
                if (target.equals(row[0])) {
                    if (Lanes.SPAM.equals(target)) {
                        // "Spam" on what the filter already put there: now it's the member's word, and it teaches the filter.
                        Sql.update(c, "UPDATE messages SET screen = NULL WHERE seq = ?", seq);
                        spam.add(seq);
                    }
                    continue;
                }
                Graph.move(c, List.of(seq), target, now, changes);
                n++;
                if (Lanes.SPAM.equals(target)) {
                    spam.add(seq);
                } else if (Lanes.SPAM.equals(row[0]) && !Lanes.TRASH.equals(target)) {
                    wanted.add(seq);
                }
                // A linked mailbox's provider follows Trash and Spam, and a message brought back out of them.
                boolean out = Lanes.SPAM.equals(row[0]) || Lanes.TRASH.equals(row[0]);
                String op = Lanes.TRASH.equals(target) ? LinkedState.OP_TRASH : Lanes.SPAM.equals(target) ? LinkedState.OP_SPAM
                        : out ? LinkedState.OP_RESTORE : null;
                if (op != null) {
                    owed.computeIfAbsent(op, k -> new ArrayList<>()).add(seq);
                }
                boolean intoPeople = Lanes.PEOPLE.equals(target) || Lanes.UPDATES.equals(target);
                boolean fromStrangers = Lanes.REQUESTS.equals(row[0]) || Lanes.OTHER.equals(row[0]) || Lanes.SPAM.equals(row[0]);
                if (intoPeople && fromStrangers && row[2] != null && !"restore".equals(to)) {
                    letIn.add(row[2]);
                }
            }
            // A blocked sender stays blocked: "Unblock" is its own step.
            for (String contact : letIn) {
                wanted.addAll(Graph.letIn(c, contact, now, changes));
            }
            for (Map.Entry<String, List<Long>> e : owed.entrySet()) {
                store.linked().recordOps(c, e.getValue(), e.getKey(), changes);
            }
            store.filter().train(c, spam, SpamFilter.SPAM, now);
            store.filter().train(c, wanted, SpamFilter.HAM, now);
            return n;
        });
    }

    /** "Done": the row leaves its lane's list until a newer message comes. */
    public boolean done(String channelId, String lane, boolean done) throws SQLException {
        return store.write((c, changes) -> {
            int n = done
                    ? Sql.update(c, "UPDATE channel_lanes SET done_at = MAX(last_at, ?) WHERE channel_id = ? AND lane = ?", store.now(), channelId, lane)
                    : Sql.update(c, "UPDATE channel_lanes SET done_at = NULL WHERE channel_id = ? AND lane = ?", channelId, lane);
            if (n > 0) {
                changes.lane(channelId, lane);
            }
            return n > 0;
        });
    }

    /**
     * A Request's card: {@code let_in} (the senders become known, and everything they sent goes to People or Updates),
     * {@code not_now} (the card goes until they write again; their mail stays in Requests, and goes after 90 days), or
     * {@code block} (every endpoint of theirs, and their mail to Spam).
     *
     * @return false if the channel has no Request
     */
    public boolean decide(String channelId, String decision) throws SQLException, Refused {
        if (!List.of("let_in", "not_now", "block").contains(decision)) {
            throw new Refused("bad_request", "decision");
        }
        return store.write((c, changes) -> {
            List<String> contacts = Sql.list(c, """
                    SELECT DISTINCT e.contact_id FROM messages m JOIN endpoints e ON e.id = m.from_endpoint
                    WHERE m.channel_id = ? AND m.lane = 'requests'""", r -> r.getString(1), channelId);
            if (contacts.isEmpty()) {
                return false;
            }
            long now = store.now();
            switch (decision) {
                case "let_in" -> {
                    List<Long> wanted = new ArrayList<>();
                    for (String contact : contacts) {
                        wanted.addAll(Graph.letIn(c, contact, now, changes));
                    }
                    store.filter().train(c, wanted, SpamFilter.HAM, now);
                }
                case "block" -> {
                    List<Long> spam = new ArrayList<>();
                    for (String contact : contacts) {
                        store.linked().recordOps(c, Sql.list(c, """
                                SELECT m.seq FROM messages m JOIN endpoints e ON e.id = m.from_endpoint
                                WHERE e.contact_id = ? AND m.lane NOT IN ('spam', 'trash', 'pending')""", r -> r.getLong(1), contact),
                                LinkedState.OP_SPAM, changes);
                        spam.addAll(Graph.blockContact(c, contact, now, changes));
                    }
                    store.filter().train(c, spam, SpamFilter.SPAM, now);
                    changes.counts = true;
                }
                default -> {
                    Sql.update(c, "UPDATE channel_lanes SET done_at = MAX(last_at, ?) WHERE channel_id = ? AND lane = 'requests'",
                            now, channelId);
                    changes.lane(channelId, Lanes.REQUESTS);
                }
            }
            return true;
        });
    }

    /**
     * Blocks an address (any endpoint with it) or a domain (and its subdomains): their standing is {@code blocked}, their
     * mail outside Trash goes to Spam, and what comes later goes there too.
     */
    public int block(String kind, String value) throws SQLException, Refused {
        String v = blockValue(kind, value);
        return store.write((c, changes) -> {
            long now = store.now();
            Sql.update(c, "INSERT OR IGNORE INTO blocks (kind, value, created_at) VALUES (?, ?, ?)", kind, v, now);
            List<String> endpoints = matching(c, kind, v);
            for (String e : endpoints) {
                Sql.update(c, "UPDATE endpoints SET standing = ? WHERE id = ?", Lanes.BLOCKED, e);
            }
            List<Long> seqs = new ArrayList<>();
            for (String e : endpoints) {
                seqs.addAll(Sql.list(c, "SELECT seq FROM messages WHERE from_endpoint = ? AND lane NOT IN ('spam', 'trash', 'pending')",
                        r -> r.getLong(1), e));
                // What the filter had already put in Spam is the member's now: an Unblock and a Let in don't bring it back.
                Sql.update(c, "UPDATE messages SET sender_known = 0, screen = NULL WHERE from_endpoint = ?", e);
            }
            store.linked().recordOps(c, seqs, LinkedState.OP_SPAM, changes);
            Graph.move(c, seqs, Lanes.SPAM, now, changes);
            store.filter().train(c, seqs, SpamFilter.SPAM, now);
            changes.counts = true;
            return endpoints.size();
        });
    }

    /**
     * Ends a block: its row, and the standing of exactly the senders it covered that no other block still covers, who are
     * strangers again; their mail stays where it is. With no such row, nothing changes and it answers false (Security CS-I2:
     * before, a value with no row still reset the senders it matched, and a Request's Block wrote no row at all).
     */
    public boolean unblock(String kind, String value) throws SQLException, Refused {
        String v = blockValue(kind, value);
        return store.write((c, changes) -> {
            if (Sql.update(c, "DELETE FROM blocks WHERE kind = ? AND value = ?", kind, v) == 0) {
                return false;
            }
            for (String e : matching(c, kind, v)) {
                Graph.Endpoint ep = Graph.endpointById(c, e);
                if (ep != null && Lanes.BLOCKED.equals(ep.standing()) && !Graph.blocked(c, ep.kind(), ep.value())) {
                    Sql.update(c, "UPDATE endpoints SET standing = ? WHERE id = ?", Lanes.UNKNOWN, e);
                }
            }
            changes.counts = true;
            return true;
        });
    }

    /**
     * "Report spam": the messages go to Spam (a linked mailbox's to its provider's Junk too, which is how a provider hears
     * of it), the learning filter learns from them, and each one that came to this desk's own address owes the mail door a
     * report of its sender for the platform's suppression list ({@code reports}, which its transport delivers: Wave 2.5),
     * so the desk never sends to them by mistake. With {@code block}, each sender's address is blocked as well.
     *
     * @return how many messages were reported
     */
    public int report(List<String> messageIds, boolean block) throws SQLException, Refused {
        if (messageIds == null || messageIds.isEmpty() || messageIds.size() > MAX_IDS) {
            throw new Refused("bad_request", "messageIds");
        }
        return store.write((c, changes) -> {
            long now = store.now();
            List<Long> seqs = select(c, messageIds, null, null);
            List<Long> moving = new ArrayList<>();
            List<Long> spam = new ArrayList<>();
            Set<String> senders = new LinkedHashSet<>();
            int n = 0;
            for (Long seq : seqs) {
                String[] row = Sql.one(c, """
                        SELECT m.id, m.lane, m.direction, m.medium, a.kind, m.account_id, e.value, e.kind, m.auth, e.standing FROM messages m
                        LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN endpoints e ON e.id = m.from_endpoint WHERE m.seq = ?""",
                        r -> new String[] {r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5),
                                r.getString(6), r.getString(7), r.getString(8), r.getString(9), r.getString(10)}, seq);
                if (row == null || "out".equals(row[2]) || Lanes.TRASH.equals(row[1])) {
                    // The member's own mail isn't spam; Trash is on its way out already.
                    continue;
                }
                n++;
                spam.add(seq);
                if (!Lanes.SPAM.equals(row[1])) {
                    moving.add(seq);
                } else {
                    // Already in Spam (the filter's, say): now it's the member's word, which a later Let in doesn't undo.
                    Sql.update(c, "UPDATE messages SET screen = NULL WHERE seq = ?", seq);
                }
                // Only a sender the door's DMARC confirmed, never the member's own: a forged From must not put someone
                // else's address on the platform's suppression list (Security CR3-L1).
                Map<String, Object> auth = Queries.auth(row[8]);
                boolean confirmed = auth != null && Boolean.TRUE.equals(auth.get("senderConfirmed"));
                if (Accounts.DESK.equals(row[4]) && "email".equals(row[3]) && row[6] != null && confirmed
                        && !Graph.isOwn(c, row[7], row[6]) && !Sql.exists(c, "SELECT 1 FROM reports WHERE message_id = ?", row[0])) {
                    Sql.update(c, """
                            INSERT INTO reports (id, message_id, account_id, address, state, created_at, updated_at)
                            VALUES (?, ?, ?, ?, 'owed', ?, ?)""", store.ids().next(now), row[0], row[5], row[6], now, now);
                }
                // Block the sender too, unless the message only claimed a known contact's address (an email whose DMARC
                // didn't confirm it): that would block the real person (Security CR3-I2). Their mail is in Spam regardless.
                boolean forgedKnown = "email".equals(row[3]) && Lanes.KNOWN.equals(row[9]) && !confirmed;
                if (block && row[6] != null && row[7] != null && !"nobody@invalid".equals(row[6]) && !forgedKnown) {
                    senders.add(row[6]);
                }
            }
            store.linked().recordOps(c, moving, LinkedState.OP_SPAM, changes);
            Graph.move(c, moving, Lanes.SPAM, now, changes);
            store.filter().train(c, spam, SpamFilter.SPAM, now);
            for (String value : senders) {
                Sql.update(c, "INSERT OR IGNORE INTO blocks (kind, value, created_at) VALUES ('address', ?, ?)", value, now);
                List<Long> theirs = new ArrayList<>();
                for (String e : matching(c, "address", value)) {
                    Sql.update(c, "UPDATE endpoints SET standing = ? WHERE id = ?", Lanes.BLOCKED, e);
                    theirs.addAll(Sql.list(c, "SELECT seq FROM messages WHERE from_endpoint = ? AND lane NOT IN ('spam', 'trash', 'pending')",
                            r -> r.getLong(1), e));
                    Sql.update(c, "UPDATE messages SET sender_known = 0, screen = NULL WHERE from_endpoint = ?", e);
                }
                store.linked().recordOps(c, theirs, LinkedState.OP_SPAM, changes);
                Graph.move(c, theirs, Lanes.SPAM, now, changes);
            }
            changes.counts = true;
            return n;
        });
    }

    public List<String[]> blocks() throws SQLException {
        return store.db().read(c -> Sql.list(c, "SELECT kind, value FROM blocks ORDER BY created_at", r -> new String[] {r.getString(1), r.getString(2)}));
    }

    private static String blockValue(String kind, String value) throws Refused {
        if ("address".equals(kind)) {
            String v = Norm.email(value);
            if (v == null) {
                v = Norm.phone(value);
            }
            if (v == null) {
                throw new Refused("bad_request", "value");
            }
            return v;
        }
        if ("domain".equals(kind)) {
            String d = value == null ? null : value.strip().toLowerCase(java.util.Locale.ROOT);
            if (d != null && d.startsWith("@")) {
                d = d.substring(1);
            }
            if (d == null || d.length() > 253 || !d.matches("[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+")) {
                throw new Refused("bad_request", "value");
            }
            return d;
        }
        throw new Refused("bad_request", "kind");
    }

    private static List<String> matching(Connection c, String kind, String value) throws SQLException {
        if ("address".equals(kind)) {
            return Sql.list(c, "SELECT id FROM endpoints WHERE value = ?", r -> r.getString(1), value);
        }
        String like = "%@" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        String sub = "%." + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        return Sql.list(c, "SELECT id FROM endpoints WHERE kind IN ('email', 'ma', 'apple') AND (value LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')",
                r -> r.getString(1), like, sub);
    }

    /**
     * Deletes: to Trash (30 days there), or for good from Trash or Spam ({@code forever}): the row, its index row and its
     * blob once nothing names it (plan §2.9).
     *
     * @return how many
     */
    public int delete(List<String> messageIds, boolean forever) throws SQLException {
        int n = store.write((c, changes) -> {
            List<Long> seqs = select(c, messageIds, null, null);
            if (!forever) {
                List<Long> moving = new ArrayList<>();
                for (Long seq : seqs) {
                    if (!Sql.exists(c, "SELECT 1 FROM messages WHERE seq = ? AND lane = 'trash'", seq)) {
                        moving.add(seq);
                    }
                }
                store.linked().recordOps(c, moving, LinkedState.OP_TRASH, changes);
                Graph.move(c, seqs, Lanes.TRASH, store.now(), changes);
                return seqs.size();
            }
            List<Long> gone = new ArrayList<>();
            for (Long seq : seqs) {
                if (Sql.exists(c, "SELECT 1 FROM messages WHERE seq = ? AND lane IN ('trash', 'spam')", seq)) {
                    gone.add(seq);
                }
            }
            // Recorded before the rows go: a linked mailbox's places stay until its transport has deleted them too.
            store.linked().recordOps(c, gone, LinkedState.OP_DELETE, changes);
            store.purge(c, gone, changes);
            return gone.size();
        });
        if (forever) {
            store.forgetDeleted();
        }
        return n;
    }

    /** Empties Trash for good. @return how many */
    public int emptyTrash() throws SQLException {
        int total = 0;
        while (true) {
            int n = store.write((c, changes) -> {
                List<Long> seqs = Sql.list(c, "SELECT seq FROM messages WHERE lane = 'trash' LIMIT 500", r -> r.getLong(1));
                store.linked().recordOps(c, seqs, LinkedState.OP_DELETE, changes);
                store.purge(c, seqs, changes);
                return seqs.size();
            });
            total += n;
            if (n < 500) {
                break;
            }
        }
        store.forgetDeleted();
        return total;
    }

    // ---- drafts

    /**
     * Saves a draft (every 2 seconds while the member types, plan §2.6), on the desk, so any device can finish it. With
     * {@code baseVersion}, a save from a device that hasn't seen the latest is refused with {@code conflict}.
     *
     * @return {draftId, version}
     */
    public Object[] saveDraft(String draftId, String channelId, String medium, String accountId, List<String> to, String subject,
            String text, String replyTo, Long baseVersion) throws SQLException, Refused {
        if (medium != null && !Accounts.MEDIA.contains(medium)) {
            throw new Refused("bad_request", "medium");
        }
        if (text == null || text.length() > MAX_DRAFT_TEXT) {
            throw new Refused(text == null ? "bad_request" : "too_large", "text");
        }
        List<String> recipients = new ArrayList<>();
        if (to != null) {
            if (to.size() > 50) {
                throw new Refused("bad_request", "to");
            }
            for (String t : to) {
                String v = Norm.email(t);
                if (v == null) {
                    v = Norm.phone(t);
                }
                if (v == null) {
                    throw new Refused("bad_request", "to");
                }
                recipients.add(v);
            }
        }
        String cleanText = Norm.clean(text, MAX_DRAFT_TEXT, true);
        String cleanSubject = Norm.line(subject, Norm.MAX_SUBJECT);
        Object[] result = new Object[2];
        Refused[] refused = new Refused[1];
        store.write((c, changes) -> {
            long now = store.now();
            if (channelId != null && !Sql.exists(c, "SELECT 1 FROM channels WHERE id = ?", channelId)) {
                refused[0] = new Refused("not_found", "channel");
                return null;
            }
            if (replyTo != null && !Sql.exists(c, "SELECT 1 FROM messages WHERE id = ?", replyTo)) {
                refused[0] = new Refused("not_found", "reply_to");
                return null;
            }
            String id = draftId;
            if (id == null) {
                id = store.ids().next(now);
                Sql.update(c, """
                        INSERT INTO drafts (id, channel_id, medium, account_id, to_list, subject, text, reply_to, version, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""", id, channelId, medium, accountId,
                        recipients.isEmpty() ? null : String.join("\n", recipients), cleanSubject, cleanText, replyTo, now, now);
                result[0] = id;
                result[1] = 1L;
            } else {
                Long version = Sql.longOne(c, "SELECT version FROM drafts WHERE id = ?", id);
                if (version == null) {
                    refused[0] = new Refused("not_found", "draft");
                    return null;
                }
                if (baseVersion != null && !baseVersion.equals(version)) {
                    refused[0] = new Refused("conflict", "version");
                    return null;
                }
                Sql.update(c, """
                        UPDATE drafts SET channel_id = ?, medium = ?, account_id = ?, to_list = ?, subject = ?, text = ?, reply_to = ?,
                          version = version + 1, updated_at = ? WHERE id = ?""", channelId, medium, accountId,
                        recipients.isEmpty() ? null : String.join("\n", recipients), cleanSubject, cleanText, replyTo, now, id);
                result[0] = id;
                result[1] = version + 1;
            }
            changes.drafts = true;
            return null;
        });
        if (refused[0] != null) {
            throw refused[0];
        }
        return result;
    }

    public boolean discardDraft(String draftId) throws SQLException {
        return store.write((c, changes) -> {
            boolean had = Sql.update(c, "DELETE FROM drafts WHERE id = ?", draftId) > 0;
            changes.drafts |= had;
            return had;
        });
    }

    // ---- contacts

    /** The member's own name for a contact, which a display name never replaces. */
    public boolean renameContact(String contactId, String name) throws SQLException, Refused {
        String clean = Norm.line(name, Norm.MAX_NAME);
        if (clean == null) {
            throw new Refused("bad_request", "name");
        }
        return store.write((c, changes) -> {
            boolean had = Sql.update(c, "UPDATE contacts SET name = ?, name_key = ?, named = 1, updated_at = ? WHERE id = ?", clean,
                    Senders.nameKey(clean), store.now(), contactId) > 0;
            changes.counts |= had;
            return had;
        });
    }

    /**
     * Makes two contacts one person (Dana's email and her phone): {@code from}'s endpoints join {@code into}, and so does
     * {@code from}'s own channel, its messages and drafts, so her email and her texts are one thread (plan §1.5). If
     * {@code into} is known, so is {@code from}'s mail.
     */
    public boolean mergeContacts(String into, String from) throws SQLException, Refused {
        if (into == null || from == null || into.equals(from)) {
            throw new Refused("bad_request", "from");
        }
        return store.write((c, changes) -> {
            if (!Sql.exists(c, "SELECT 1 FROM contacts WHERE id = ?", into) || !Sql.exists(c, "SELECT 1 FROM contacts WHERE id = ?", from)) {
                return false;
            }
            long now = store.now();
            Sql.update(c, "UPDATE endpoints SET contact_id = ? WHERE contact_id = ?", into, from);
            String fromChannel = Sql.stringOne(c, "SELECT id FROM channels WHERE key = ?", "direct:" + from);
            if (fromChannel != null) {
                String intoChannel = Sql.stringOne(c, "SELECT id FROM channels WHERE key = ?", "direct:" + into);
                if (intoChannel == null) {
                    Sql.update(c, "UPDATE channels SET key = ? WHERE id = ?", "direct:" + into, fromChannel);
                } else {
                    List<String> lanes = Sql.list(c, "SELECT DISTINCT lane FROM messages WHERE channel_id = ?", r -> r.getString(1), fromChannel);
                    Sql.update(c, "UPDATE messages SET channel_id = ? WHERE channel_id = ?", intoChannel, fromChannel);
                    Sql.update(c, "UPDATE threads SET channel_id = ? WHERE channel_id = ?", intoChannel, fromChannel);
                    Sql.update(c, "UPDATE drafts SET channel_id = ? WHERE channel_id = ?", intoChannel, fromChannel);
                    Sql.update(c, """
                            INSERT OR IGNORE INTO channel_members (channel_id, endpoint_id)
                            SELECT ?, endpoint_id FROM channel_members WHERE channel_id = ?""", intoChannel, fromChannel);
                    Sql.update(c, "DELETE FROM channel_lanes WHERE channel_id = ?", fromChannel);
                    Sql.update(c, "DELETE FROM channels WHERE id = ?", fromChannel);
                    for (String lane : lanes) {
                        Graph.refresh(c, intoChannel, lane);
                        changes.lane(intoChannel, lane);
                    }
                    changes.channels.add(fromChannel);
                }
            }
            Sql.update(c, "DELETE FROM contacts WHERE id = ?", from);
            if (Sql.exists(c, "SELECT 1 FROM endpoints WHERE contact_id = ? AND standing = 'known'", into)) {
                Graph.letIn(c, into, now, changes);
            }
            changes.counts = true;
            return true;
        });
    }
}
