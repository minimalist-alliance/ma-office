package com.minimalistalliance.desk.deskd.courier.store;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One person across channels (the launch plan §1.5; the Designer's flow 11; draft ADR "Courier's store" §18): a person
 * holds endpoints, and has one conversation. <b>Linking</b> moves an endpoint (or a whole person) onto a person, with every
 * message that came or went through it; <b>unlinking</b> moves an endpoint back to a person of its own. An endpoint belongs
 * to one person at a time. Each link, unlink and "not them" is one row in {@code courier.db}.
 *
 * <ul>
 *   <li><b>Never without the member's press:</b> nothing here runs on its own. {@link #suggest} only reads; nothing an
 *       arriving message does links, merges or lets anyone in. There is no merge by name, card or signature.
 *   <li><b>Suggestions</b> come from a contact card the member's Mac lists (Wave 2.6), from an email signature (an email in People from a known sender whose DMARC passed, naming
 *       the number or address in its last lines) and from the same name alone. Never from Requests, Other, Spam or Trash,
 *       an unconfirmed sender, or anything an agent wrote; never a pair the member said "not them" to; never a blocked or
 *       own endpoint; only an endpoint that is a person on its own (one endpoint, or an address's {@code ma} and
 *       {@code email} pair). A card added by hand and a provider's address book come later.
 *   <li><b>A link lets a Requests endpoint in</b> when the person it joins is known: its own Requests and Other mail
 *       goes to People (or Updates), and only its own (never the person's other endpoints).
 *   <li><b>Undo</b> reverses one link exactly (the endpoints, their messages and threads, the person and conversation it
 *       emptied, what letting in moved), while nothing since has moved those endpoints again.
 * </ul>
 */
public final class Links {

    /** The most suggestions one call gives, and the most People emails a call reads for signatures. */
    static final int MAX_SUGGESTIONS = 100;
    static final int SIGNATURE_SCAN = 500;
    static final int SIGNATURE_LINES = 12;
    /** The characters of a text's end a signature is read from, the longest line read, endpoints a mail gives, lookups a call makes. */
    static final int SIGNATURE_TAIL = 4096;
    static final int SIGNATURE_LINE_MAX = 300;
    static final int SIGNATURE_PER_MAIL = 8;
    static final int SIGNATURE_LOOKUPS = 2000;

    private static final Pattern PHONE = Pattern.compile("(?<![\\w@+])\\+?\\(?\\d[\\d\\s().\\-]{5,22}\\d(?![\\w@])");
    private static final Pattern EMAIL = Pattern.compile("[A-Za-z0-9._%+\\-]{1,64}@[A-Za-z0-9.\\-]{1,253}\\.[A-Za-z]{2,24}");
    private static final Pattern QUOTE_HEAD = Pattern.compile("(?i)^(on .{0,200}wrote:|-{2,}\\s*original message\\s*-{2,}|from:\\s.*)$");

    /** A made link: undone by {@code linkId}, into this conversation. */
    public record Linked(String linkId, String channelId) {}

    /** An unlinked endpoint's new person and conversation. */
    public record Unlinked(String contactId, String channelId) {}

    private final CourierStore store;

    Links(CourierStore store) {
        this.store = store;
    }

    // ---- link

    /**
     * {@code courier.links.link}: a whole person ({@code from}) or one endpoint onto {@code into}. An endpoint the desk doesn't
     * have is made on {@code into} ("Add an email or number"). An address's {@code ma} and {@code email} endpoints go
     * together (one desk, plan §1.2).
     *
     * @throws Actions.Refused {@code not_found contact}, {@code bad_request from | endpoint}, {@code conflict already | blocked}
     */
    public Linked link(String into, String from, String kind, String value) throws SQLException, Actions.Refused {
        try {
            return store.write((c, changes) -> {
                try {
                    return linkIn(c, changes, into, from, kind, value);
                } catch (Actions.Refused r) {
                    // Thrown through the transaction so a refusal writes nothing (an endpoint made before it included).
                    throw new RolledBack(r);
                }
            });
        } catch (RolledBack r) {
            throw r.refused;
        }
    }

    /** A refusal carried out of a write so the transaction rolls back whatever it had done (Security's CF2-L1). */
    private static final class RolledBack extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final transient Actions.Refused refused;

        RolledBack(Actions.Refused refused) {
            super(null, null, false, false);
            this.refused = refused;
        }
    }

    private Linked linkIn(Connection c, Courier.ChangeSet changes, String into, String fromId, String kind, String value)
            throws SQLException, Actions.Refused {
        long now = store.now();
        if (!contactExists(c, into)) {
            throw new Actions.Refused("not_found", "contact");
        }
        // Whether the person it joins is known, before anything joins them (a known endpoint moving in doesn't make them so).
        boolean intoKnown = known(c, into);
        String from;
        List<String> eps;
        boolean whole;
        String created = null;
        if (fromId != null) {
            if (fromId.equals(into)) {
                throw new Actions.Refused("bad_request", "from");
            }
            if (!contactExists(c, fromId)) {
                throw new Actions.Refused("not_found", "contact");
            }
            from = fromId;
            eps = endpointsOf(c, from);
            if (eps.isEmpty()) {
                throw new Actions.Refused("bad_request", "from");
            }
            whole = true;
        } else {
            Graph.Endpoint ep = Graph.findEndpoint(c, kind, value);
            if (ep == null) {
                if (Graph.isOwn(c, kind, value)) {
                    throw new Actions.Refused("bad_request", "own");
                }
                if (Graph.blocked(c, kind, value)) {
                    // A blocked address joins no one by a link (Security's CF2-L2): Unblock first.
                    throw new Actions.Refused("conflict", "blocked");
                }
                Graph.Endpoint twin = twinOf(c, kind, value);
                if (twin == null) {
                    // New to this desk: it starts on this person, with nothing to bring in.
                    String standing = intoKnown ? Lanes.KNOWN : Lanes.UNKNOWN;
                    String id = store.ids().next(now);
                    Sql.update(c, """
                            INSERT INTO endpoints (id, kind, value, display, contact_id, standing, written_to, first_seen_at, skel, source)
                            VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, 'added')""", id, kind, value, into, standing, now, Senders.endpointSkel(kind, value));
                    String channel = Graph.channel(c, store.ids(), "direct:" + into, "direct", null, List.of(id), now);
                    String linkId = store.ids().next(now);
                    Sql.update(c, """
                            INSERT INTO links (id, kind, into_contact, from_contact, endpoints, created, created_at)
                            VALUES (?, 'link', ?, ?, ?, ?, ?)""", linkId, into, into, id, id, now);
                    changes.channels.add(channel);
                    changes.counts = true;
                    return new Linked(linkId, channel);
                }
                // Its address's other half is here: made beside it, then both move.
                ep = Graph.endpoint(c, store.ids(), kind, value, null, now, false);
                Sql.update(c, "UPDATE endpoints SET source = 'added' WHERE id = ?", ep.id());
                created = ep.id();
            }
            from = ep.contactId();
            if (from.equals(into)) {
                throw new Actions.Refused("conflict", "already");
            }
            eps = new ArrayList<>(List.of(ep.id()));
            Graph.Endpoint twin = twinOf(c, ep.kind(), ep.value());
            if (twin != null && twin.contactId().equals(from) && !eps.contains(twin.id())) {
                eps.add(twin.id());
            }
            whole = endpointsOf(c, from).size() == eps.size();
        }
        for (String e : eps) {
            Graph.Endpoint ep = Graph.endpointById(c, e);
            if (ep != null && Lanes.BLOCKED.equals(ep.standing())) {
                // A blocked sender joins no one by a link: Unblock first (it would carry the block onto the person, or lift it).
                throw new Actions.Refused("conflict", "blocked");
            }
        }

        String fromChannel = direct(c, from);
        String intoChannel = direct(c, into);
        boolean intoNew = intoChannel == null;
        if (intoNew) {
            intoChannel = Graph.channel(c, store.ids(), "direct:" + into, "direct", null, eps, now);
        }
        List<Long> seqs = fromChannel == null ? List.of()
                : whole ? Sql.list(c, "SELECT seq FROM messages WHERE channel_id = ?", r -> r.getLong(1), fromChannel)
                : withThreads(c, fromChannel, via(c, fromChannel, eps));
        List<String> drafts = whole && fromChannel != null
                ? Sql.list(c, "SELECT id FROM drafts WHERE channel_id = ?", r -> r.getString(1), fromChannel) : List.of();
        Set<String> lanes = moveMessages(c, seqs, fromChannel, intoChannel);
        for (String d : drafts) {
            Sql.update(c, "UPDATE drafts SET channel_id = ? WHERE id = ?", intoChannel, d);
        }
        if (fromChannel != null) {
            Sql.update(c, "DELETE FROM channel_members WHERE channel_id = ? AND endpoint_id IN (" + Sql.marks(eps.size()) + ")",
                    Sql.args(eps, fromChannel));
        }
        Graph.addMembers(c, intoChannel, eps);
        Sql.update(c, "UPDATE endpoints SET contact_id = ? WHERE id IN (" + Sql.marks(eps.size()) + ")", Sql.args(eps, into));

        // The person it emptied, and their conversation, kept in the row so Undo can bring them back as they were.
        Object[] person = null;
        if (!Sql.exists(c, "SELECT 1 FROM endpoints WHERE contact_id = ?", from)) {
            person = Sql.one(c, "SELECT name, named, name_key, created_at FROM contacts WHERE id = ?",
                    r -> new Object[] {r.getString(1), r.getInt(2), r.getString(3), r.getLong(4)}, from);
            Sql.update(c, "DELETE FROM contacts WHERE id = ?", from);
        }
        Object[] channel = null;
        if (fromChannel != null && person != null && !Sql.exists(c, "SELECT 1 FROM messages WHERE channel_id = ?", fromChannel)) {
            channel = Sql.one(c, "SELECT created_at, preferred_medium FROM channels WHERE id = ?",
                    r -> new Object[] {r.getLong(1), r.getString(2)}, fromChannel);
            Sql.update(c, "UPDATE drafts SET channel_id = NULL WHERE channel_id = ?", fromChannel);
            Sql.update(c, "DELETE FROM channel_lanes WHERE channel_id = ?", fromChannel);
            Sql.update(c, "DELETE FROM channels WHERE id = ?", fromChannel);
            changes.channels.add(fromChannel);
        }
        for (String lane : lanes) {
            if (channel == null && fromChannel != null) {
                Graph.refresh(c, fromChannel, lane);
                changes.lane(fromChannel, lane);
            }
            Graph.refresh(c, intoChannel, lane);
            changes.lane(intoChannel, lane);
        }

        // Linking lets a Requests endpoint in, when the person it joins is known: only its own mail, never anyone else's.
        List<String> letIn = new ArrayList<>();
        List<String> laneNotes = new ArrayList<>();
        List<Long> nowKnown = new ArrayList<>();
        if (intoKnown) {
            letIn = Sql.list(c, "SELECT id FROM endpoints WHERE standing = ? AND id IN (" + Sql.marks(eps.size()) + ")", r -> r.getString(1),
                    Sql.args(eps, Lanes.UNKNOWN));
            if (!letIn.isEmpty()) {
                letInEndpoints(c, letIn, now, changes, laneNotes, nowKnown);
            }
        }

        String linkId = store.ids().next(now);
        Sql.update(c, """
                INSERT INTO links (id, kind, into_contact, from_contact, from_name, from_named, from_name_key, from_created_at, endpoints,
                  messages, drafts, from_channel, from_channel_gone, from_channel_created_at, from_channel_medium, into_channel_new, let_in,
                  lanes, known, created, created_at)
                VALUES (?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                linkId, into, from, person == null ? null : person[0], person == null ? 0 : person[1], person == null ? null : person[2],
                person == null ? null : person[3], join(eps), joinLongs(seqs), join(drafts), fromChannel, channel != null,
                channel == null ? null : channel[0], channel == null ? null : channel[1], intoNew, join(letIn), join(laneNotes),
                joinLongs(nowKnown), created, now);
        changes.channels.add(intoChannel);
        changes.counts = true;
        return new Linked(linkId, intoChannel);
    }

    /** Lets these endpoints in (only them): known, their Requests and Other mail (and the filter's Spam) to People or Updates. */
    private static void letInEndpoints(Connection c, List<String> eps, long now, Courier.ChangeSet changes, List<String> laneNotes,
            List<Long> nowKnown) throws SQLException {
        String in = Sql.marks(eps.size());
        nowKnown.addAll(Sql.list(c, "SELECT seq FROM messages WHERE sender_known = 0 AND from_endpoint IN (" + in + ")", r -> r.getLong(1),
                eps.toArray()));
        Sql.update(c, "UPDATE endpoints SET standing = ? WHERE id IN (" + in + ")", Sql.args(eps, Lanes.KNOWN));
        List<Object[]> rows = Sql.list(c, """
                SELECT seq, bulk, lane, lane_before, screen FROM messages
                WHERE from_endpoint IN (%s) AND (lane IN ('requests', 'other') OR (lane = 'spam' AND screen = 'filter'))""".formatted(in),
                r -> new Object[] {r.getLong(1), r.getInt(2), r.getString(3), r.getString(4), r.getString(5)}, eps.toArray());
        List<Long> people = new ArrayList<>();
        List<Long> updates = new ArrayList<>();
        for (Object[] r : rows) {
            laneNotes.add(r[0] + ":" + r[2] + ":" + (r[3] == null ? "" : r[3]) + ":" + (r[4] == null ? "" : r[4]));
            ((Integer) r[1] == 1 ? updates : people).add((Long) r[0]);
        }
        Sql.update(c, "UPDATE messages SET sender_known = 1 WHERE from_endpoint IN (" + in + ")", eps.toArray());
        Graph.move(c, people, Lanes.PEOPLE, now, changes);
        Graph.move(c, updates, Lanes.UPDATES, now, changes);
    }

    // ---- undo

    /**
     * {@code courier.links.undo}: that link reversed exactly. {@code not_found link} for one that isn't there, was undone, or
     * whose endpoints something else moved since (a later link or unlink, or a delete).
     */
    public void undo(String linkId) throws SQLException, Actions.Refused {
        try {
            store.write((c, changes) -> {
                try {
                    undoIn(c, changes, linkId);
                } catch (Actions.Refused r) {
                    throw new RolledBack(r);
                }
                return null;
            });
        } catch (RolledBack r) {
            throw r.refused;
        }
    }

    private void undoIn(Connection c, Courier.ChangeSet changes, String linkId) throws SQLException, Actions.Refused {
        long now = store.now();
        Map<String, Object> row = Sql.one(c, """
                SELECT into_contact, from_contact, from_name, from_named, from_name_key, from_created_at, endpoints, messages, drafts,
                  from_channel, from_channel_gone, from_channel_created_at, from_channel_medium, let_in, lanes, known, created
                FROM links WHERE id = ? AND kind = 'link' AND undone_at IS NULL""", r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            for (int i = 1; i <= 17; i++) {
                m.put(r.getMetaData().getColumnName(i), r.getObject(i));
            }
            return m;
        }, linkId);
        if (row == null) {
            throw new Actions.Refused("not_found", "link");
        }
        String into = (String) row.get("into_contact");
        String from = (String) row.get("from_contact");
        List<String> eps = split((String) row.get("endpoints"));
        for (String e : eps) {
            Graph.Endpoint ep = Graph.endpointById(c, e);
            if (ep == null || !ep.contactId().equals(into)) {
                throw new Actions.Refused("not_found", "link");
            }
        }
        // A later link or unlink of any of them, still standing, is something else that moved them.
        for (String later : Sql.list(c, "SELECT endpoints FROM links WHERE id > ? AND undone_at IS NULL AND kind IN ('link', 'unlink')",
                r -> r.getString(1), linkId)) {
            for (String e : split(later)) {
                if (eps.contains(e)) {
                    throw new Actions.Refused("not_found", "link");
                }
            }
        }
        String intoChannel = direct(c, into);
        String created = (String) row.get("created");
        if (created != null && from.equals(into)) {
            // A new endpoint made on this person: it goes again, while nothing came or went through it.
            if (Sql.exists(c, "SELECT 1 FROM messages WHERE from_endpoint = ?", created)
                    || Sql.exists(c, "SELECT 1 FROM recipients WHERE endpoint_id = ?", created)) {
                throw new Actions.Refused("not_found", "link");
            }
            Sql.update(c, "DELETE FROM channel_members WHERE endpoint_id = ?", created);
            Sql.update(c, "DELETE FROM endpoints WHERE id = ?", created);
            Sql.update(c, "UPDATE links SET undone_at = ? WHERE id = ?", now, linkId);
            if (intoChannel != null) {
                changes.channels.add(intoChannel);
            }
            changes.counts = true;
            return;
        }

        // Letting in, undone first, on the messages as they are now.
        List<String> letIn = split((String) row.get("let_in"));
        if (!letIn.isEmpty()) {
            Sql.update(c, "UPDATE endpoints SET standing = ? WHERE standing = ? AND id IN (" + Sql.marks(letIn.size()) + ")",
                    Sql.args(letIn, Lanes.UNKNOWN, Lanes.KNOWN));
        }
        for (String s : split((String) row.get("known"))) {
            Sql.update(c, "UPDATE messages SET sender_known = 0 WHERE seq = ?", Long.parseLong(s));
        }
        for (String note : split((String) row.get("lanes"))) {
            String[] p = note.split(":", -1);
            long seq = Long.parseLong(p[0]);
            String[] now2 = Sql.one(c, "SELECT channel_id, lane FROM messages WHERE seq = ?", r -> new String[] {r.getString(1), r.getString(2)}, seq);
            if (now2 == null || (!Lanes.PEOPLE.equals(now2[1]) && !Lanes.UPDATES.equals(now2[1]))) {
                continue;
            }
            Sql.update(c, "UPDATE messages SET lane = ?, lane_before = ?, screen = ?, lane_at = ? WHERE seq = ?", p[1], p[2].isEmpty() ? null : p[2],
                    p[3].isEmpty() ? null : p[3], now, seq);
            Graph.refresh(c, now2[0], now2[1]);
            Graph.refresh(c, now2[0], p[1]);
            changes.lane(now2[0], now2[1]);
            changes.lane(now2[0], p[1]);
        }

        // The person and conversation the link emptied, as they were.
        if (!contactExists(c, from)) {
            Sql.update(c, "INSERT INTO contacts (id, name, named, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", from,
                    row.get("from_name"), ((Number) row.get("from_named")).intValue(), row.get("from_name_key"),
                    row.get("from_created_at") == null ? now : ((Number) row.get("from_created_at")).longValue(), now);
        }
        String fromChannel = (String) row.get("from_channel");
        if (fromChannel != null && !Sql.exists(c, "SELECT 1 FROM channels WHERE id = ?", fromChannel)) {
            Sql.update(c, "INSERT INTO channels (id, kind, key, title, preferred_medium, created_at) VALUES (?, 'direct', ?, NULL, ?, ?)",
                    fromChannel, "direct:" + from, row.get("from_channel_medium"),
                    row.get("from_channel_created_at") == null ? now : ((Number) row.get("from_channel_created_at")).longValue());
        }
        Set<Long> moved = new LinkedHashSet<>();
        if (intoChannel != null) {
            for (String s : split((String) row.get("messages"))) {
                moved.add(Long.parseLong(s));
            }
            moved.retainAll(Sql.list(c, "SELECT seq FROM messages WHERE channel_id = ?", r -> r.getLong(1), intoChannel));
            moved.addAll(via(c, intoChannel, eps));
        }
        List<Long> seqs = intoChannel == null ? List.of() : withThreads(c, intoChannel, moved);
        if (fromChannel == null && (!seqs.isEmpty() || intoChannel != null)) {
            fromChannel = Graph.channel(c, store.ids(), "direct:" + from, "direct", null, eps, now);
        }
        Set<String> lanes = fromChannel == null ? Set.of() : moveMessages(c, seqs, intoChannel, fromChannel);
        for (String d : split((String) row.get("drafts"))) {
            Sql.update(c, "UPDATE drafts SET channel_id = ? WHERE id = ? AND channel_id IS ?", fromChannel, d, intoChannel);
        }
        if (intoChannel != null) {
            Sql.update(c, "DELETE FROM channel_members WHERE channel_id = ? AND endpoint_id IN (" + Sql.marks(eps.size()) + ")",
                    Sql.args(eps, intoChannel));
        }
        if (fromChannel != null) {
            Graph.addMembers(c, fromChannel, eps);
        }
        Sql.update(c, "UPDATE endpoints SET contact_id = ? WHERE id IN (" + Sql.marks(eps.size()) + ")", Sql.args(eps, from));
        if (created != null) {
            // Made beside its address's other half for this link: it goes back with it, and stays (it's that person's now).
            Sql.update(c, "UPDATE endpoints SET source = NULL WHERE id = ? AND source = 'added'", created);
        }
        for (String lane : lanes) {
            Graph.refresh(c, intoChannel, lane);
            Graph.refresh(c, fromChannel, lane);
            changes.lane(intoChannel, lane);
            changes.lane(fromChannel, lane);
        }
        Sql.update(c, "UPDATE links SET undone_at = ? WHERE id = ?", now, linkId);
        if (fromChannel != null) {
            changes.channels.add(fromChannel);
        }
        if (intoChannel != null) {
            changes.channels.add(intoChannel);
        }
        changes.counts = true;
    }

    // ---- unlink

    /**
     * {@code courier.links.unlink}: the endpoint (and its address's other half) back to a person of its own, with the messages
     * that came or went through it, in a conversation of its own. Its standing doesn't change; nothing is deleted.
     *
     * @throws Actions.Refused {@code not_found endpoint}, {@code conflict only} for a person's only endpoint
     */
    public Unlinked unlink(String kind, String value) throws SQLException, Actions.Refused {
        Actions.Refused[] refused = new Actions.Refused[1];
        Unlinked out = store.write((c, changes) -> {
            long now = store.now();
            Graph.Endpoint ep = Graph.findEndpoint(c, kind, value);
            if (ep == null) {
                refused[0] = new Actions.Refused("not_found", "endpoint");
                return null;
            }
            String person = ep.contactId();
            List<String> eps = new ArrayList<>(List.of(ep.id()));
            Graph.Endpoint twin = twinOf(c, ep.kind(), ep.value());
            if (twin != null && twin.contactId().equals(person)) {
                eps.add(twin.id());
            }
            if (endpointsOf(c, person).size() <= eps.size()) {
                refused[0] = new Actions.Refused("conflict", "only");
                return null;
            }
            String display = Sql.stringOne(c, "SELECT display FROM endpoints WHERE id = ?", ep.id());
            String contactId = store.ids().next(now);
            Sql.update(c, "INSERT INTO contacts (id, name, name_key, named, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)", contactId, display,
                    Senders.nameKey(display), now, now);
            String personChannel = direct(c, person);
            List<Long> seqs = personChannel == null ? List.of() : withThreads(c, personChannel, via(c, personChannel, eps));
            String channel = Graph.channel(c, store.ids(), "direct:" + contactId, "direct", null, eps, now);
            Set<String> lanes = moveMessages(c, seqs, personChannel, channel);
            if (personChannel != null) {
                Sql.update(c, "DELETE FROM channel_members WHERE channel_id = ? AND endpoint_id IN (" + Sql.marks(eps.size()) + ")",
                        Sql.args(eps, personChannel));
            }
            Sql.update(c, "UPDATE endpoints SET contact_id = ? WHERE id IN (" + Sql.marks(eps.size()) + ")", Sql.args(eps, contactId));
            for (String lane : lanes) {
                Graph.refresh(c, personChannel, lane);
                Graph.refresh(c, channel, lane);
                changes.lane(personChannel, lane);
                changes.lane(channel, lane);
            }
            Sql.update(c, """
                    INSERT INTO links (id, kind, into_contact, from_contact, endpoints, messages, from_channel, created_at)
                    VALUES (?, 'unlink', ?, ?, ?, ?, ?, ?)""", store.ids().next(now), contactId, person, join(eps), joinLongs(seqs), personChannel, now);
            changes.channels.add(channel);
            if (personChannel != null) {
                changes.channels.add(personChannel);
            }
            changes.counts = true;
            return new Unlinked(contactId, channel);
        });
        if (refused[0] != null) {
            throw refused[0];
        }
        return out;
    }

    // ---- not them

    /** {@code courier.links.dismiss}: "Not {first name}", remembered for that pair (the endpoint and the person), never asked again. */
    public void dismiss(String kind, String value, String into) throws SQLException, Actions.Refused {
        Actions.Refused[] refused = new Actions.Refused[1];
        store.write((c, changes) -> {
            Graph.Endpoint ep = Graph.findEndpoint(c, kind, value);
            if (ep == null) {
                refused[0] = new Actions.Refused("not_found", "endpoint");
                return null;
            }
            if (!contactExists(c, into)) {
                refused[0] = new Actions.Refused("not_found", "contact");
                return null;
            }
            long now = store.now();
            if (Sql.update(c, "INSERT OR IGNORE INTO links_not (endpoint_id, contact_id, created_at) VALUES (?, ?, ?)", ep.id(), into, now) > 0) {
                Graph.Endpoint twin = twinOf(c, ep.kind(), ep.value());
                if (twin != null) {
                    Sql.update(c, "INSERT OR IGNORE INTO links_not (endpoint_id, contact_id, created_at) VALUES (?, ?, ?)", twin.id(), into, now);
                }
                changes.counts = true;
            }
            return null;
        });
        if (refused[0] != null) {
            throw refused[0];
        }
    }

    // ---- reads

    /** {@code courier.links.lookup}: what a typed email or number already is here, and how many messages it would bring. */
    public Map<String, Object> lookup(String kind, String value) throws SQLException {
        return store.db().read(c -> {
            Map<String, Object> out = new LinkedHashMap<>();
            Graph.Endpoint ep = Graph.findEndpoint(c, kind, value);
            if (ep == null) {
                out.put("contactId", null);
                out.put("name", null);
                out.put("endpoints", 0);
                out.put("messages", 0);
                return out;
            }
            List<String> eps = new ArrayList<>(List.of(ep.id()));
            Graph.Endpoint twin = twinOf(c, ep.kind(), ep.value());
            if (twin != null && twin.contactId().equals(ep.contactId())) {
                eps.add(twin.id());
            }
            String in = Sql.marks(eps.size());
            Object[] args = new Object[eps.size() * 2];
            for (int i = 0; i < eps.size(); i++) {
                args[i] = eps.get(i);
                args[eps.size() + i] = eps.get(i);
            }
            out.put("contactId", ep.contactId());
            out.put("name", Sql.stringOne(c, "SELECT name FROM contacts WHERE id = ?", ep.contactId()));
            out.put("endpoints", endpointsOf(c, ep.contactId()).size());
            out.put("messages", Sql.longOne(c, """
                    SELECT count(*) FROM messages m WHERE m.lane <> 'pending' AND (m.from_endpoint IN (%s)
                      OR (m.direction = 'out' AND EXISTS (SELECT 1 FROM recipients r WHERE r.message_seq = m.seq AND r.endpoint_id IN (%s))))"""
                    .formatted(in, in), args));
            return out;
        });
    }

    /**
     * {@code courier.links.suggest}: "Is this also {name}?", strongest first, for one endpoint or every one. Reads only: a
     * suggestion is never acted on here.
     */
    public List<Map<String, Object>> suggest(String kind, String value) throws SQLException {
        return store.db().read(c -> {
            Graph.Endpoint only = null;
            if (kind != null) {
                only = Graph.findEndpoint(c, kind, value);
                if (only == null) {
                    return List.of();
                }
            }
            Set<String> onlyIds = null;
            if (only != null) {
                onlyIds = new LinkedHashSet<>(List.of(only.id()));
                Graph.Endpoint twin = twinOf(c, only.kind(), only.value());
                if (twin != null && twin.contactId().equals(only.contactId())) {
                    onlyIds.add(twin.id());
                }
            }
            Map<String, Map<String, Object>> byEndpoint = new LinkedHashMap<>();
            cards(c, onlyIds, byEndpoint);
            signatures(c, onlyIds, byEndpoint);
            names(c, only, byEndpoint);
            List<Map<String, Object>> out = new ArrayList<>();
            for (String strength : List.of("card", "hint", "name")) {
                for (Map<String, Object> s : byEndpoint.values()) {
                    if (strength.equals(s.get("strength")) && out.size() < MAX_SUGGESTIONS) {
                        out.add(s);
                    }
                }
            }
            return out;
        });
    }

    /** The most desk endpoints and card endpoints one call compares. */
    static final int CARD_ENDPOINTS_SCAN = 50_000;
    static final int CARD_ROWS_SCAN = 400_000;

    /**
     * A contact card (Wave 2.6: the Mac's Contacts, through the member's BlueBubbles Server) that lists endpoints of two
     * people here: each one on its own is offered onto the oldest named person among them who is known ("Your Mac's contacts
     * list this number on Dana's card"). A card never names who's known: only someone the member already let in is a target.
     */
    private void cards(Connection c, Set<String> only, Map<String, Map<String, Object>> out) throws SQLException {
        if (!Sql.exists(c, "SELECT 1 FROM cards LIMIT 1")) {
            return;
        }
        Map<String, List<Graph.Endpoint>> byMatch = new LinkedHashMap<>();
        for (Graph.Endpoint e : Sql.list(c, """
                SELECT id, kind, value, contact_id, standing FROM endpoints WHERE kind IN ('phone', 'apple', 'email', 'ma')
                ORDER BY first_seen_at DESC LIMIT ?""", r -> new Graph.Endpoint(r.getString(1), r.getString(2), r.getString(3), r.getString(4),
                r.getString(5)), CARD_ENDPOINTS_SCAN)) {
            String m = ImessageState.endpointMatch(e.kind(), e.value());
            if (m != null) {
                byMatch.computeIfAbsent(m, k -> new ArrayList<>()).add(e);
            }
        }
        if (byMatch.isEmpty()) {
            return;
        }
        Map<Long, List<Graph.Endpoint>> byCard = new LinkedHashMap<>();
        for (Object[] row : Sql.list(c, "SELECT card_seq, match, value FROM card_endpoints ORDER BY card_seq LIMIT ?",
                r -> new Object[] {r.getLong(1), r.getString(2), r.getString(3)}, CARD_ROWS_SCAN)) {
            List<Graph.Endpoint> eps = byMatch.get((String) row[1]);
            if (eps != null) {
                for (Graph.Endpoint e : eps) {
                    if (ImessageState.samePhone((String) row[2], e.value())) {
                        byCard.computeIfAbsent((Long) row[0], k -> new ArrayList<>()).add(e);
                    }
                }
            }
        }
        for (List<Graph.Endpoint> eps : byCard.values()) {
            Set<String> contacts = new LinkedHashSet<>();
            for (Graph.Endpoint e : eps) {
                contacts.add(e.contactId());
            }
            if (contacts.size() < 2) {
                continue;
            }
            String into = Sql.stringOne(c, """
                    SELECT ct.id FROM contacts ct WHERE ct.id IN (%s) AND ct.name IS NOT NULL
                      AND EXISTS (SELECT 1 FROM endpoints k WHERE k.contact_id = ct.id AND k.standing = 'known')
                    ORDER BY ct.created_at, ct.id LIMIT 1""".formatted(Sql.marks(contacts.size())), contacts.toArray());
            if (into == null) {
                continue;
            }
            for (Graph.Endpoint e : eps) {
                if (e.contactId().equals(into) || (only != null && !only.contains(e.id()))) {
                    continue;
                }
                // An email address a card lists is still only as good as its mail: never an unconfirmed sender (CF2-M1).
                if ("email".equals(e.kind()) && !confirmed(c, e)) {
                    continue;
                }
                offer(c, e, into, "mac", "card", out);
            }
        }
    }

    /** A signature: the last lines of People emails from known senders whose DMARC passed, naming another person's endpoint. */
    private void signatures(Connection c, Set<String> only, Map<String, Map<String, Object>> out) throws SQLException {
        // Only each text's tail is read (a signature is in its last lines), and every count is capped (Security's CF2-M2).
        int lookups = 0;
        List<Object[]> mails = Sql.list(c, """
                SELECT substr(m.body_text, -?), e.contact_id, m.auth FROM messages m JOIN endpoints e ON e.id = m.from_endpoint
                WHERE m.lane = 'people' AND m.direction = 'in' AND m.author_kind = 'human' AND m.medium = 'email' AND m.body_text IS NOT NULL
                  AND e.standing = 'known' AND m.auth IS NOT NULL
                ORDER BY m.sort_key DESC LIMIT ?""", r -> new Object[] {r.getString(1), r.getString(2), r.getString(3)}, SIGNATURE_TAIL, SIGNATURE_SCAN);
        for (Object[] m : mails) {
            Map<String, Object> auth = Queries.auth((String) m[2]);
            if (auth == null || !Boolean.TRUE.equals(auth.get("senderConfirmed"))) {
                continue;
            }
            String into = (String) m[1];
            for (String[] found : signatureEndpoints((String) m[0])) {
                if (++lookups > SIGNATURE_LOOKUPS) {
                    return;
                }
                for (Graph.Endpoint e : matching(c, found[0], found[1])) {
                    if (only != null && !only.contains(e.id())) {
                        continue;
                    }
                    offer(c, e, into, "signature", "hint", out);
                }
            }
        }
    }

    /**
     * The same name, and nothing else: a person on their own whose name is an older known person's (the one already had). A
     * display name is anyone's to write, so only for a sender with nothing in Requests, Other, Spam or Trash (a stranger's lanes;
     * CF2-L4 for Other), and for email one whose
     * mail passed DMARC every time it came (Security's CF2-M1): never "Is this also Mom?" for a stranger asking to be let in.
     */
    private void names(Connection c, Graph.Endpoint only, Map<String, Map<String, Object>> out) throws SQLException {
        List<String[]> pairs = Sql.list(c, """
                SELECT e.id, b.id FROM endpoints e JOIN contacts a ON a.id = e.contact_id JOIN contacts b ON b.name_key = a.name_key AND b.id <> a.id
                WHERE a.name_key IS NOT NULL AND e.standing <> 'blocked' AND (b.created_at, b.id) < (a.created_at, a.id)
                  AND EXISTS (SELECT 1 FROM endpoints k WHERE k.contact_id = b.id AND k.standing = 'known')
                  AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.from_endpoint = e.id AND x.lane IN ('requests', 'other', 'spam', 'trash', 'pending'))
                  AND (? IS NULL OR e.id = ?)
                ORDER BY e.first_seen_at DESC, b.created_at, b.id LIMIT 500""", r -> new String[] {r.getString(1), r.getString(2)},
                only == null ? null : only.id(), only == null ? null : only.id());
        for (String[] p : pairs) {
            Graph.Endpoint e = Graph.endpointById(c, p[0]);
            if (e != null && confirmed(c, e)) {
                offer(c, e, p[1], "name", "name", out);
            }
        }
    }

    /** Whether an endpoint's sender is confirmed: an email address whose every inbound message (of its last 50) passed DMARC. */
    private static boolean confirmed(Connection c, Graph.Endpoint e) throws SQLException {
        if (!"email".equals(e.kind())) {
            // A member's desk signs what it sends; a number comes through the member's own Mac. Neither has a name to forge.
            return true;
        }
        List<String> auths = Sql.list(c, "SELECT auth FROM messages WHERE from_endpoint = ? AND direction = 'in' ORDER BY seq DESC LIMIT 50",
                r -> r.getString(1), e.id());
        if (auths.isEmpty()) {
            return false;
        }
        for (String a : auths) {
            Map<String, Object> auth = Queries.auth(a);
            if (auth == null || !Boolean.TRUE.equals(auth.get("senderConfirmed"))) {
                return false;
            }
        }
        return true;
    }

    /** One suggestion of endpoint {@code e} onto person {@code into}, when every rule allows it; the first per endpoint wins. */
    private static void offer(Connection c, Graph.Endpoint e, String into, String source, String strength, Map<String, Map<String, Object>> out)
            throws SQLException {
        if (out.containsKey(e.id()) || e.contactId().equals(into) || Lanes.BLOCKED.equals(e.standing()) || Graph.isOwn(c, e.kind(), e.value())) {
            return;
        }
        if (Sql.exists(c, "SELECT 1 FROM links_not WHERE endpoint_id = ? AND contact_id = ?", e.id(), into)) {
            return;
        }
        // Only a person on their own (one endpoint, or an address's two halves): a whole person is the member's drag, not a suggestion.
        List<String> theirs = endpointsOf(c, e.contactId());
        Graph.Endpoint twin = twinOf(c, e.kind(), e.value());
        int own = 1 + (twin != null && twin.contactId().equals(e.contactId()) ? 1 : 0);
        if (theirs.size() > own) {
            return;
        }
        String name = Sql.stringOne(c, "SELECT name FROM contacts WHERE id = ?", into);
        if (name == null || name.isBlank()) {
            return;
        }
        Map<String, Object> s = new LinkedHashMap<>();
        Map<String, Object> ep = new LinkedHashMap<>();
        ep.put("kind", e.kind());
        ep.put("value", e.value());
        s.put("endpoint", ep);
        s.put("fromContactId", e.contactId());
        s.put("channelId", direct(c, e.contactId()));
        Map<String, Object> to = new LinkedHashMap<>();
        to.put("contactId", into);
        to.put("name", name);
        s.put("into", to);
        s.put("source", source);
        s.put("provider", null);
        s.put("strength", strength);
        out.put(e.id(), s);
        if (twin != null && twin.contactId().equals(e.contactId())) {
            // Its address's other half is the same person: one suggestion for the two.
            out.put(twin.id(), Map.of("strength", "dup"));
        }
    }

    /** The emails and numbers in a message's own last lines (above any quoted mail), each {@code {kind, value}}, normalized. */
    static List<String[]> signatureEndpoints(String text) {
        List<String> lines = new ArrayList<>();
        for (String line : text.split("\\R", -1)) {
            String t = line.strip();
            if (t.startsWith(">") || QUOTE_HEAD.matcher(t).matches()) {
                break;
            }
            if (!t.isEmpty()) {
                lines.add(t);
            }
        }
        List<String[]> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String line : lines.subList(Math.max(0, lines.size() - SIGNATURE_LINES), lines.size())) {
            if (line.length() > SIGNATURE_LINE_MAX || out.size() >= SIGNATURE_PER_MAIL) {
                continue;
            }
            Matcher em = EMAIL.matcher(line);
            while (em.find()) {
                String v = Norm.endpoint("email", em.group());
                if (v != null && seen.add("email " + v) && out.size() < SIGNATURE_PER_MAIL) {
                    out.add(new String[] {"email", v});
                }
            }
            Matcher ph = PHONE.matcher(EMAIL.matcher(line).replaceAll(" "));
            while (ph.find()) {
                String digits = ph.group().replaceAll("[^0-9]", "");
                if (digits.length() < 7 || digits.length() > 15) {
                    continue;
                }
                String v = Norm.endpoint("phone", ph.group());
                if (v != null && seen.add("phone " + v) && out.size() < SIGNATURE_PER_MAIL) {
                    out.add(new String[] {"phone", v});
                }
            }
        }
        return out;
    }

    /** Endpoints a signature's value names: the same address (as email, a member's or an Apple ID), or the same number. */
    private static List<Graph.Endpoint> matching(Connection c, String kind, String value) throws SQLException {
        List<Graph.Endpoint> out = new ArrayList<>();
        if ("email".equals(kind)) {
            for (String k : List.of("email", "ma", "apple")) {
                Graph.Endpoint e = Graph.findEndpoint(c, k, value);
                if (e != null) {
                    out.add(e);
                }
            }
            return out;
        }
        String digits = value.replace("+", "");
        String last10 = digits.length() >= 10 ? digits.substring(digits.length() - 10) : digits;
        out.addAll(Sql.list(c, """
                SELECT id, kind, value, contact_id, standing FROM endpoints
                WHERE kind IN ('phone', 'apple') AND (value = ? OR (length(?) = 10 AND replace(value, '+', '') LIKE '%' || ?))""",
                r -> new Graph.Endpoint(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5)), value, last10, last10));
        return out;
    }

    // ---- shared

    private static boolean contactExists(Connection c, String id) throws SQLException {
        return id != null && Sql.exists(c, "SELECT 1 FROM contacts WHERE id = ?", id);
    }

    private static boolean known(Connection c, String contactId) throws SQLException {
        return Sql.exists(c, "SELECT 1 FROM endpoints WHERE contact_id = ? AND standing = ?", contactId, Lanes.KNOWN);
    }

    private static List<String> endpointsOf(Connection c, String contactId) throws SQLException {
        return Sql.list(c, "SELECT id FROM endpoints WHERE contact_id = ? ORDER BY first_seen_at, id", r -> r.getString(1), contactId);
    }

    private static String direct(Connection c, String contactId) throws SQLException {
        return Sql.stringOne(c, "SELECT id FROM channels WHERE key = ?", "direct:" + contactId);
    }

    /** An address's other half: its {@code ma} endpoint for an {@code email} one and back (one desk, plan §1.2). */
    private static Graph.Endpoint twinOf(Connection c, String kind, String value) throws SQLException {
        String twin = "email".equals(kind) ? "ma" : "ma".equals(kind) ? "email" : null;
        return twin == null ? null : Graph.findEndpoint(c, twin, value);
    }

    /** A conversation's messages that came from or went to these endpoints. */
    private static Set<Long> via(Connection c, String channelId, Collection<String> eps) throws SQLException {
        if (eps.isEmpty()) {
            return new LinkedHashSet<>();
        }
        String in = Sql.marks(eps.size());
        List<Object> args = new ArrayList<>();
        args.add(channelId);
        args.addAll(eps);
        args.addAll(eps);
        return new LinkedHashSet<>(Sql.list(c, """
                SELECT m.seq FROM messages m WHERE m.channel_id = ? AND (m.from_endpoint IN (%s)
                  OR (m.direction = 'out' AND EXISTS (SELECT 1 FROM recipients r WHERE r.message_seq = m.seq AND r.endpoint_id IN (%s))))"""
                .formatted(in, in), r -> r.getLong(1), args.toArray()));
    }

    /** These messages and the rest of each email thread they're in: a thread is in one conversation, whole. */
    private static List<Long> withThreads(Connection c, String channelId, Collection<Long> seqs) throws SQLException {
        Set<Long> out = new LinkedHashSet<>(seqs);
        Set<String> threads = new LinkedHashSet<>();
        for (Long seq : seqs) {
            String t = Sql.stringOne(c, "SELECT thread_id FROM messages WHERE seq = ?", seq);
            if (t != null) {
                threads.add(t);
            }
        }
        for (String t : threads) {
            out.addAll(Sql.list(c, "SELECT seq FROM messages WHERE channel_id = ? AND thread_id = ?", r -> r.getLong(1), channelId, t));
        }
        return new ArrayList<>(out);
    }

    /** Moves messages (and their threads) from one conversation to another; the lanes they were in. */
    private static Set<String> moveMessages(Connection c, List<Long> seqs, String fromChannel, String toChannel) throws SQLException {
        Set<String> lanes = new LinkedHashSet<>();
        Set<String> threads = new LinkedHashSet<>();
        for (Long seq : seqs) {
            String[] r = Sql.one(c, "SELECT lane, thread_id FROM messages WHERE seq = ?", x -> new String[] {x.getString(1), x.getString(2)}, seq);
            if (r == null) {
                continue;
            }
            lanes.add(r[0]);
            if (r[1] != null) {
                threads.add(r[1]);
            }
            Sql.update(c, "UPDATE messages SET channel_id = ? WHERE seq = ?", toChannel, seq);
        }
        for (String t : threads) {
            Sql.update(c, "UPDATE threads SET channel_id = ? WHERE id = ? AND channel_id IS ?", toChannel, t, fromChannel);
        }
        return lanes;
    }

    private static String join(Collection<String> values) {
        return values == null || values.isEmpty() ? null : String.join("\n", values);
    }

    private static String joinLongs(Collection<Long> values) {
        if (values == null || values.isEmpty()) {
            return null;
        }
        StringBuilder b = new StringBuilder();
        for (Long v : values) {
            if (b.length() > 0) {
                b.append('\n');
            }
            b.append(v);
        }
        return b.toString();
    }

    private static List<String> split(String joined) {
        return joined == null || joined.isEmpty() ? List.of() : List.of(joined.split("\n"));
    }
}
