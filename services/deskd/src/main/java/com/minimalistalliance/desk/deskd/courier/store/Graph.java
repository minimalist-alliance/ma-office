package com.minimalistalliance.desk.deskd.courier.store;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.TreeSet;

/**
 * Who and where, inside a writer's transaction: endpoints and their contacts, channels and their members, the per-lane
 * summary rows, and the standing changes (let in, block) that move a sender's mail between lanes.
 */
final class Graph {

    private Graph() {}

    /** A sender or recipient as stored. */
    record Endpoint(String id, String kind, String value, String contactId, String standing) {}

    static Endpoint findEndpoint(Connection c, String kind, String value) throws SQLException {
        return Sql.one(c, "SELECT id, kind, value, contact_id, standing FROM endpoints WHERE kind = ? AND value = ?",
                r -> new Endpoint(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5)), kind, value);
    }

    static Endpoint endpointById(Connection c, String id) throws SQLException {
        return Sql.one(c, "SELECT id, kind, value, contact_id, standing FROM endpoints WHERE id = ?",
                r -> new Endpoint(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5)), id);
    }

    /**
     * The endpoint, made with a contact of its own if it's new. An {@code ma} endpoint and an {@code email} one with the
     * same address are the same desk (one address does both jobs, plan §1.2), so they share a contact. A display name is
     * kept as a hint and never as identity; one that holds an address is dropped (plan §3.5).
     */
    static Endpoint endpoint(Connection c, Ulid ids, String kind, String value, String display, long now, boolean known)
            throws SQLException {
        Endpoint found = findEndpoint(c, kind, value);
        String name = displayName(display);
        if (found != null) {
            if (name != null) {
                Sql.update(c, "UPDATE endpoints SET display = ? WHERE id = ? AND (display IS NULL OR display <> ?)", name, found.id(), name);
                Sql.update(c, "UPDATE contacts SET name = ?, name_key = ?, updated_at = ? WHERE id = ? AND named = 0 AND name IS NULL",
                        name, Senders.nameKey(name), now, found.contactId());
            }
            if (known && Lanes.UNKNOWN.equals(found.standing())) {
                Sql.update(c, "UPDATE endpoints SET standing = ? WHERE id = ?", Lanes.KNOWN, found.id());
                return new Endpoint(found.id(), kind, value, found.contactId(), Lanes.KNOWN);
            }
            return found;
        }
        String contactId = null;
        String twin = "email".equals(kind) ? "ma" : "ma".equals(kind) ? "email" : null;
        String standing = known ? Lanes.KNOWN : Lanes.UNKNOWN;
        if (twin != null) {
            Endpoint other = findEndpoint(c, twin, value);
            if (other != null) {
                contactId = other.contactId();
                if (!known) {
                    standing = Lanes.BLOCKED.equals(other.standing()) ? Lanes.BLOCKED : other.standing();
                }
            }
        }
        if (contactId == null) {
            contactId = ids.next(now);
            Sql.update(c, "INSERT INTO contacts (id, name, name_key, named, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
                    contactId, name, Senders.nameKey(name), now, now);
        }
        String id = ids.next(now);
        Sql.update(c, """
                INSERT INTO endpoints (id, kind, value, display, contact_id, standing, written_to, first_seen_at, skel)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)""", id, kind, value, name, contactId, standing, now, Senders.endpointSkel(kind, value));
        return new Endpoint(id, kind, value, contactId, standing);
    }

    static String displayName(String display) {
        String name = Norm.line(display, Norm.MAX_NAME);
        if (name == null) {
            return null;
        }
        // Quotes some clients leave in, and a name that's only an address or holds one, which would pass for it.
        if (name.length() > 1 && name.startsWith("\"") && name.endsWith("\"")) {
            name = Norm.line(name.substring(1, name.length() - 1), Norm.MAX_NAME);
        }
        return name == null || name.contains("@") ? null : name;
    }

    static boolean blocked(Connection c, String kind, String value) throws SQLException {
        if (value == null) {
            return false;
        }
        if (Sql.exists(c, "SELECT 1 FROM blocks WHERE kind = 'address' AND value = ?", value)) {
            return true;
        }
        String domain = ("email".equals(kind) || "ma".equals(kind) || "apple".equals(kind)) ? Norm.domain(value) : null;
        if (domain == null) {
            return false;
        }
        // The domain and each parent of it but the last label: a block of example.com covers mail.example.com.
        String d = domain;
        while (d.indexOf('.') > 0) {
            if (Sql.exists(c, "SELECT 1 FROM blocks WHERE kind = 'domain' AND value = ?", d)) {
                return true;
            }
            d = d.substring(d.indexOf('.') + 1);
        }
        return false;
    }

    /** The member's own address: exactly, or without a {@code +tag}. */
    static boolean isOwn(Connection c, String kind, String value) throws SQLException {
        if (value == null) {
            return false;
        }
        String k = "apple".equals(kind) ? "apple" : kind;
        if (Sql.exists(c, "SELECT 1 FROM own_addresses WHERE kind = ? AND value = ?", k, value)) {
            return true;
        }
        String base = Norm.withoutTag(value);
        return base != null && Sql.exists(c, "SELECT 1 FROM own_addresses WHERE kind = ? AND value = ?", k, base);
    }

    /** The channel with this key, made with these members if it's new; the members are added either way. */
    static String channel(Connection c, Ulid ids, String key, String kind, String title, Collection<String> members, long now)
            throws SQLException {
        String id = Sql.stringOne(c, "SELECT id FROM channels WHERE key = ?", key);
        if (id == null) {
            id = ids.next(now);
            Sql.update(c, "INSERT INTO channels (id, kind, key, title, created_at) VALUES (?, ?, ?, ?, ?)", id, kind, key, title, now);
        }
        addMembers(c, id, members);
        return id;
    }

    static void addMembers(Connection c, String channelId, Collection<String> endpointIds) throws SQLException {
        for (String e : endpointIds) {
            Sql.update(c, "INSERT OR IGNORE INTO channel_members (channel_id, endpoint_id) VALUES (?, ?)", channelId, e);
        }
    }

    static boolean isMember(Connection c, String channelId, String endpointId) throws SQLException {
        return endpointId != null
                && Sql.exists(c, "SELECT 1 FROM channel_members WHERE channel_id = ? AND endpoint_id = ?", channelId, endpointId);
    }

    /** {@code group:} and 32 hex digits of the members' sorted ids. */
    static String groupKey(Collection<String> endpointIds) {
        TreeSet<String> sorted = new TreeSet<>(endpointIds);
        return "group:" + BlobStore.sha256(String.join("\n", sorted).getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    /** A mailing list's key and title from its List-Id: {@code Name <id>} or a bare id. */
    static String[] listKey(String listId) {
        String id = listId;
        String title = null;
        int lt = listId.lastIndexOf('<');
        int gt = listId.lastIndexOf('>');
        if (lt >= 0 && gt > lt) {
            id = listId.substring(lt + 1, gt);
            title = Norm.line(listId.substring(0, lt).replace("\"", ""), 120);
        }
        id = id.strip().toLowerCase(Locale.ROOT);
        if (id.isEmpty()) {
            return null;
        }
        return new String[] {"list:" + id, title != null ? title : Norm.line(id, 120)};
    }

    /** One more message in a channel's lane. */
    static void bump(Connection c, String channelId, String lane, long sortAt, long seq, boolean unread) throws SQLException {
        Sql.update(c, """
                INSERT INTO channel_lanes (channel_id, lane, last_at, last_seq, count, unread, done_at)
                VALUES (?, ?, ?, ?, 1, ?, NULL)
                ON CONFLICT (channel_id, lane) DO UPDATE SET
                  count = count + 1,
                  unread = unread + excluded.unread,
                  last_seq = CASE WHEN excluded.last_at > last_at OR (excluded.last_at = last_at AND excluded.last_seq > last_seq)
                                  THEN excluded.last_seq ELSE last_seq END,
                  last_at = MAX(last_at, excluded.last_at)""", channelId, lane, sortAt, seq, unread ? 1 : 0);
    }

    /** Counts a channel's lane again from its messages, after a move, a read or a delete. */
    static void refresh(Connection c, String channelId, String lane) throws SQLException {
        if (channelId == null || lane == null) {
            return;
        }
        long[] counts = Sql.one(c, """
                SELECT count(*), coalesce(sum(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END), 0)
                FROM messages WHERE channel_id = ? AND lane = ?""", r -> new long[] {r.getLong(1), r.getLong(2)}, channelId, lane);
        if (counts == null || counts[0] == 0) {
            Sql.update(c, "DELETE FROM channel_lanes WHERE channel_id = ? AND lane = ?", channelId, lane);
            return;
        }
        long[] last = Sql.one(c, """
                SELECT sort_at, seq FROM messages WHERE channel_id = ? AND lane = ?
                ORDER BY sort_at DESC, seq DESC LIMIT 1""", r -> new long[] {r.getLong(1), r.getLong(2)}, channelId, lane);
        Sql.update(c, """
                INSERT INTO channel_lanes (channel_id, lane, last_at, last_seq, count, unread, done_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT (channel_id, lane) DO UPDATE SET
                  last_at = excluded.last_at, last_seq = excluded.last_seq, count = excluded.count, unread = excluded.unread""",
                channelId, lane, last[0], last[1], counts[0], counts[1]);
    }

    /** A (channel, lane) pair to count again. */
    record Pair(String channelId, String lane) {}

    /**
     * Moves messages to a lane, keeping where each was before Spam or Trash so it can go back, and counts every lane it
     * touched again.
     */
    static void move(Connection c, List<Long> seqs, String to, long now, Courier.ChangeSet changes) throws SQLException {
        java.util.Set<Pair> touched = new java.util.LinkedHashSet<>();
        for (Long seq : seqs) {
            Pair from = Sql.one(c, "SELECT channel_id, lane FROM messages WHERE seq = ?", r -> new Pair(r.getString(1), r.getString(2)), seq);
            if (from == null || from.channelId() == null || from.lane().equals(to) || Lanes.PENDING.equals(from.lane())) {
                continue;
            }
            boolean into = Lanes.SPAM.equals(to) || Lanes.TRASH.equals(to);
            boolean outOf = Lanes.SPAM.equals(from.lane()) || Lanes.TRASH.equals(from.lane());
            String before = into ? (outOf ? null : from.lane()) : null;
            // A move is someone's word: it ends the learning filter's mark (screen), whoever made it.
            if (into && outOf) {
                // From Spam to Trash keeps where it was before Spam.
                Sql.update(c, "UPDATE messages SET lane = ?, lane_at = ?, screen = NULL WHERE seq = ?", to, now, seq);
            } else {
                Sql.update(c, "UPDATE messages SET lane = ?, lane_before = ?, lane_at = ?, screen = NULL WHERE seq = ?", to, before, now, seq);
            }
            touched.add(from);
            touched.add(new Pair(from.channelId(), to));
            if (!Lanes.AGENT_VISIBLE.contains(from.lane()) && Lanes.AGENT_VISIBLE.contains(to)) {
                changes.surfaced.add(seq);
            }
        }
        for (Pair p : touched) {
            refresh(c, p.channelId(), p.lane());
            changes.lane(p.channelId(), p.lane());
        }
    }

    /**
     * Lets a sender in: known from now on, and their mail in Requests or Other goes to People, or Updates for bulk mail, as
     * does what the learning filter alone put in Spam ({@code screen: filter}). Mail of theirs the member, a block, the door
     * or the provider put in Spam stays there: the member moves it.
     *
     * @return the messages it moved, which the caller may teach the filter as wanted
     */
    static List<Long> letIn(Connection c, String contactId, long now, Courier.ChangeSet changes) throws SQLException {
        Sql.update(c, "UPDATE endpoints SET standing = ? WHERE contact_id = ? AND standing = ?", Lanes.KNOWN, contactId, Lanes.UNKNOWN);
        List<long[]> rows = Sql.list(c, """
                SELECT m.seq, m.bulk FROM messages m JOIN endpoints e ON e.id = m.from_endpoint
                WHERE e.contact_id = ? AND (m.lane IN ('requests', 'other') OR (m.lane = 'spam' AND m.screen = 'filter'))""",
                r -> new long[] {r.getLong(1), r.getLong(2)}, contactId);
        List<Long> people = new ArrayList<>();
        List<Long> updates = new ArrayList<>();
        for (long[] r : rows) {
            (r[1] == 1 ? updates : people).add(r[0]);
        }
        Sql.update(c, "UPDATE messages SET sender_known = 1 WHERE from_endpoint IN (SELECT id FROM endpoints WHERE contact_id = ?)", contactId);
        move(c, people, Lanes.PEOPLE, now, changes);
        move(c, updates, Lanes.UPDATES, now, changes);
        List<Long> moved = new ArrayList<>(people);
        moved.addAll(updates);
        return moved;
    }

    /**
     * Blocks a sender's contact: every endpoint of it, each with its own {@code blocks} row (so it's in
     * {@code courier.blocks.list} and Unblock ends exactly it; Security CS-I2), and their mail outside Trash goes to Spam.
     *
     * @return the messages it moved to Spam
     */
    static List<Long> blockContact(Connection c, String contactId, long now, Courier.ChangeSet changes) throws SQLException {
        for (String value : Sql.list(c, "SELECT value FROM endpoints WHERE contact_id = ?", r -> r.getString(1), contactId)) {
            Sql.update(c, "INSERT OR IGNORE INTO blocks (kind, value, created_at) VALUES ('address', ?, ?)", value, now);
        }
        Sql.update(c, "UPDATE endpoints SET standing = ? WHERE contact_id = ?", Lanes.BLOCKED, contactId);
        List<Long> seqs = Sql.list(c, """
                SELECT m.seq FROM messages m JOIN endpoints e ON e.id = m.from_endpoint
                WHERE e.contact_id = ? AND m.lane NOT IN ('spam', 'trash', 'pending')""", r -> r.getLong(1), contactId);
        // What the filter had already put in Spam is the member's now: an Unblock and a Let in don't bring it back (CR3-I3).
        Sql.update(c, "UPDATE messages SET sender_known = 0, screen = NULL WHERE from_endpoint IN (SELECT id FROM endpoints WHERE contact_id = ?)",
                contactId);
        move(c, seqs, Lanes.SPAM, now, changes);
        return seqs;
    }
}
