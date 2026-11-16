package com.minimalistalliance.desk.deskd.courier.store;

import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What the relay's transports (the launch plan's Wave 2.5: {@code ma} and the mail door) keep in {@code courier.db} beside
 * the messages, so it commits with them: the identity keys pinned for other members' addresses, messages held back while a
 * pinned key changed, and the sink keys of envelopes already taken in (draft ADR "Courier's transports"). The transport
 * ({@code courier.relay}) speaks to the relay and does the crypto; this is all its SQL.
 *
 * <p><b>Replay.</b> The relay keeps an envelope's ciphertext until it's acked or expires, so it could hand one back after
 * the member deleted its message, when the sink no longer knows the key (Security CK-I6). Every envelope taken in leaves
 * its key here ({@code relay_seen}) in the sink's own transaction, kept until a replay of it would fail the transport's
 * age check anyway.
 */
public final class RelayState {

    /** Trusted on first use: the directory's keys, never checked by the member. */
    public static final String UNVERIFIED = "unverified";
    /** Checked: an invite's fingerprint matched, or the member compared the safety number. */
    public static final String VERIFIED = "verified";
    /** Another identity showed up for this address: nothing is sealed to it until the member checks the new number. */
    public static final String CHANGED = "changed";

    /**
     * Messages held for one address at most, and for the desk, by count and by bytes (Security CT-L1); past any, a new one
     * isn't held: it waits in the relay.
     */
    public static final int HELD_PER_ADDRESS = 200;
    public static final int HELD_TOTAL = 2000;
    public static final long HELD_BYTES_PER_ADDRESS = 64L * 1024 * 1024;
    public static final long HELD_BYTES_TOTAL = 256L * 1024 * 1024;

    /** What {@link #hold} did. */
    public enum Hold {
        HELD,
        /** Held already (a copy). */
        ALREADY,
        /** Past a cap: nothing written. */
        FULL
    }
    /** A held message nobody accepted is deleted after this. */
    public static final long HELD_KEEP_MS = 30L * 24 * 3600 * 1000;

    /**
     * One pinned address. Keys are base64url, as the directory gives them. {@code new*} is the other identity a change
     * showed, while {@code state} is {@link #CHANGED}.
     */
    public record Pin(String address, String identityKey, String boxKey, String binding, long keysVersion, String oldBoxKeys, String state,
            String source, String newIdentityKey, String newBoxKey, String newBinding, Long newKeysVersion, long pinnedAt, Long verifiedAt,
            Long changedAt, Long lookedUpAt) {

        /** Box keys kept in {@code oldBoxKeys}. */
        static final int OLD_BOX_KEYS = 4;

        /** The same identity's new box key: the old one joins {@code oldBoxKeys}, the last few kept. */
        public Pin withKeys(String box, String bind, long version) {
            String old = oldBoxKeys;
            if (!box.equals(boxKey)) {
                java.util.List<String> keys = new java.util.ArrayList<>();
                keys.add(boxKey);
                if (oldBoxKeys != null) {
                    for (String k : oldBoxKeys.split(",")) {
                        if (!k.isEmpty() && !k.equals(box) && !keys.contains(k) && keys.size() < OLD_BOX_KEYS) {
                            keys.add(k);
                        }
                    }
                }
                old = String.join(",", keys);
            }
            return new Pin(address, identityKey, box, bind, version, old, state, source, newIdentityKey, newBoxKey, newBinding, newKeysVersion,
                    pinnedAt, verifiedAt, changedAt, lookedUpAt);
        }

        /** Every box key this identity had here: the current one first. */
        public java.util.List<String> boxKeys() {
            java.util.List<String> out = new java.util.ArrayList<>();
            out.add(boxKey);
            if (oldBoxKeys != null) {
                for (String k : oldBoxKeys.split(",")) {
                    if (!k.isEmpty()) {
                        out.add(k);
                    }
                }
            }
            return out;
        }

        public Pin withState(String s, Long verified) {
            return new Pin(address, identityKey, boxKey, binding, keysVersion, oldBoxKeys, s, source, newIdentityKey, newBoxKey, newBinding,
                    newKeysVersion, pinnedAt, verified, changedAt, lookedUpAt);
        }

        /** The same address, another identity seen: held as {@code new*} until the member checks it. */
        public Pin changedTo(String identity, String box, String bind, long version, long now) {
            return new Pin(address, identityKey, boxKey, binding, keysVersion, oldBoxKeys, CHANGED, source, identity, box, bind, version,
                    pinnedAt, verifiedAt, now, lookedUpAt);
        }

        public Pin lookedUp(long now) {
            return new Pin(address, identityKey, boxKey, binding, keysVersion, oldBoxKeys, state, source, newIdentityKey, newBoxKey, newBinding,
                    newKeysVersion, pinnedAt, verifiedAt, changedAt, now);
        }

        /** No keys in logs: the address's state only. */
        @Override
        public String toString() {
            return "Pin[" + state + "]";
        }
    }

    /** A held message: what the sender signed ({@code payload}, verified under {@code identityKey}) and a drop's body. */
    public record Held(long seq, String address, String externalId, String identityKey, String payload, byte[] body, long receivedAt) {
        @Override
        public String toString() {
            return "Held[" + seq + "]";
        }
    }

    /** One of a channel's people, with every endpoint they have: what the delivery picker reads. */
    public record Person(String contactId, List<String[]> endpoints) {}

    /**
     * What the delivery picker needs about a channel (design §8.3): its people, the last message received from any of them
     * (its medium and the account it came through), and the channel's preferred medium.
     */
    public record PickFacts(String channelKind, List<Person> people, String lastMedium, String lastAccount, Long lastAt, String preferred) {}

    private final CourierStore store;

    RelayState(CourierStore store) {
        this.store = store;
    }

    // ---- pins

    public Pin pin(String address) throws SQLException {
        return store.db().read(c -> pin(c, address));
    }

    private static Pin pin(Connection c, String address) throws SQLException {
        return Sql.one(c, """
                SELECT address, identity_key, box_key, binding, keys_version, old_box_keys, state, source, new_identity_key, new_box_key,
                  new_binding, new_keys_version, pinned_at, verified_at, changed_at, looked_up_at FROM ma_pins WHERE address = ?""",
                r -> new Pin(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getLong(5), r.getString(6), r.getString(7),
                        r.getString(8), r.getString(9), r.getString(10), r.getString(11), Sql.nullableLong(r, "new_keys_version"), r.getLong(13),
                        Sql.nullableLong(r, "verified_at"), Sql.nullableLong(r, "changed_at"), Sql.nullableLong(r, "looked_up_at")), address);
    }

    /** Writes a pin as given (new, or replaced whole), and tells the office a contact's keys changed. */
    public void putPin(Pin p) throws SQLException {
        store.write((c, changes) -> {
            Sql.update(c, """
                    INSERT INTO ma_pins (address, identity_key, box_key, binding, keys_version, old_box_keys, state, source, new_identity_key,
                      new_box_key, new_binding, new_keys_version, pinned_at, verified_at, changed_at, looked_up_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (address) DO UPDATE SET identity_key = excluded.identity_key, box_key = excluded.box_key,
                      binding = excluded.binding, keys_version = excluded.keys_version, old_box_keys = excluded.old_box_keys,
                      state = excluded.state, source = excluded.source,
                      new_identity_key = excluded.new_identity_key, new_box_key = excluded.new_box_key, new_binding = excluded.new_binding,
                      new_keys_version = excluded.new_keys_version, verified_at = excluded.verified_at, changed_at = excluded.changed_at,
                      looked_up_at = excluded.looked_up_at""",
                    p.address(), p.identityKey(), p.boxKey(), p.binding(), p.keysVersion(), p.oldBoxKeys(), p.state(), p.source(), p.newIdentityKey(),
                    p.newBoxKey(), p.newBinding(), p.newKeysVersion(), p.pinnedAt(), p.verifiedAt(), p.changedAt(), p.lookedUpAt());
            String contact = Sql.stringOne(c, "SELECT contact_id FROM endpoints WHERE kind = 'ma' AND value = ?", p.address());
            String channel = contact == null ? null
                    : Sql.stringOne(c, "SELECT id FROM channels WHERE key = ?", "direct:" + contact);
            changes.lane(channel, null);
            changes.accounts = true;
            return null;
        });
    }

    /** Every pinned address in a changed state: what blocks sending. */
    public Set<String> changed() throws SQLException {
        return store.db().read(c -> new LinkedHashSet<>(Sql.list(c, "SELECT address FROM ma_pins WHERE state = ?", r -> r.getString(1), CHANGED)));
    }

    /**
     * Sends that waited because a pinned key changed are due now: the member just checked the number (or an invite vouched
     * for the keys), so they go at once rather than after their backoff.
     *
     * @return how many
     */
    public int keyChecked() throws SQLException {
        return store.write((c, changes) -> {
            int n = Sql.update(c, "UPDATE outbound SET not_before = ?, updated_at = ? WHERE state = 'retry' AND last_error = 'key_changed'",
                    store.now(), store.now());
            changes.outbound |= n > 0;
            return n;
        });
    }

    // ---- envelopes already taken in

    /** Whether an envelope with this sink key was taken in and its tombstone is still kept. */
    public boolean seen(String medium, String externalId) throws SQLException {
        return store.db().read(c -> Sql.exists(c, "SELECT 1 FROM relay_seen WHERE medium = ? AND external_id = ? AND until > ?",
                medium, externalId, store.now()));
    }

    /**
     * The sink, for envelopes: stores the batch (idempotent on {@code (medium, externalId)}) and, in the same transaction,
     * a tombstone for each one the sink kept, until {@code until[i]} (epoch ms), and deletes the held messages
     * {@code releasedHeld} names. Either all of it is on disk when this returns, or none of it.
     */
    public List<Courier.Accepted> accept(List<Courier.Inbound> batch, List<Long> until, List<Long> releasedHeld)
            throws SQLException, IOException, InterruptedException {
        return accept(batch, until, releasedHeld, List.of());
    }

    /**
     * As {@link #accept(List, List, List)}, with the relay's ids of the envelopes the batch came in, tombstoned in the same
     * transaction ({@code [relayId, until]}), so a copy after a lost ack is acked without being downloaded again.
     */
    public List<Courier.Accepted> accept(List<Courier.Inbound> batch, List<Long> until, List<Long> releasedHeld, List<String[]> relayIds)
            throws SQLException, IOException, InterruptedException {
        if (batch.size() != until.size()) {
            throw new IllegalArgumentException("until");
        }
        return store.accept(batch, null, (c, answers, changes) -> {
            for (String[] r : relayIds) {
                if (r[0] != null) {
                    tombstone(c, "relay", r[0], Long.parseLong(r[1]));
                }
            }
            for (int i = 0; i < answers.size(); i++) {
                Courier.Accepted a = answers.get(i);
                Courier.Inbound in = batch.get(i);
                if (a != null && a.kept() && in != null) {
                    tombstone(c, in.medium(), in.externalId(), until.get(i));
                }
            }
            for (Long seq : releasedHeld) {
                Sql.update(c, "DELETE FROM ma_held WHERE seq = ?", seq);
            }
            if (!releasedHeld.isEmpty()) {
                changes.accounts = true;
            }
        });
    }

    private static void tombstone(Connection c, String medium, String externalId, long until) throws SQLException {
        Sql.update(c, """
                INSERT INTO relay_seen (medium, external_id, until) VALUES (?, ?, ?)
                ON CONFLICT (medium, external_id) DO UPDATE SET until = MAX(until, excluded.until)""", medium, externalId, until);
    }

    /** A tombstone alone, for an envelope refused for good (so a second copy is refused without opening it again). */
    public void tombstone(String medium, String externalId, long until) throws SQLException {
        store.db().transaction(c -> {
            tombstone(c, medium, externalId, until);
            return null;
        });
    }

    // ---- held messages

    /**
     * Holds a message verified under a new identity for a pinned address, with its tombstone, until the member checks the
     * new safety number. {@code FULL} past the caps (nothing written: the envelope waits in the relay).
     */
    public Hold hold(String address, String externalId, String identityKey, String payload, byte[] body, long until)
            throws SQLException {
        long size = payload.length() * 2L + (body == null ? 0 : body.length);
        return store.write((c, changes) -> {
            if (Sql.exists(c, "SELECT 1 FROM ma_held WHERE external_id = ?", externalId)) {
                return Hold.ALREADY;
            }
            Object[] mine = Sql.one(c, "SELECT count(*), coalesce(sum(length(payload) * 2 + coalesce(length(body), 0)), 0) FROM ma_held WHERE address = ?",
                    r -> new Object[] {r.getLong(1), r.getLong(2)}, address);
            Object[] all = Sql.one(c, "SELECT count(*), coalesce(sum(length(payload) * 2 + coalesce(length(body), 0)), 0) FROM ma_held",
                    r -> new Object[] {r.getLong(1), r.getLong(2)});
            if ((Long) mine[0] >= HELD_PER_ADDRESS || (Long) all[0] >= HELD_TOTAL || (Long) mine[1] + size > HELD_BYTES_PER_ADDRESS
                    || (Long) all[1] + size > HELD_BYTES_TOTAL) {
                return Hold.FULL;
            }
            Sql.update(c, "INSERT INTO ma_held (address, external_id, identity_key, payload, body, received_at) VALUES (?, ?, ?, ?, ?, ?)",
                    address, externalId, identityKey, payload, body, store.now());
            tombstone(c, "ma", externalId, until);
            changes.accounts = true;
            return Hold.HELD;
        });
    }

    public List<Held> held(String address) throws SQLException {
        return store.db().read(c -> Sql.list(c, """
                SELECT seq, address, external_id, identity_key, payload, body, received_at FROM ma_held WHERE address = ? ORDER BY seq""",
                r -> new Held(r.getLong(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getBytes(6), r.getLong(7)), address));
    }

    public int heldCount(String address) throws SQLException {
        Long n = store.db().read(c -> Sql.longOne(c, "SELECT count(*) FROM ma_held WHERE address = ?", address));
        return n == null ? 0 : n.intValue();
    }

    /** Deletes held messages for good (the member didn't accept the new key, or they're the wrong one's). */
    public int dropHeld(String address, String identityKey) throws SQLException {
        return store.write((c, changes) -> {
            int n = identityKey == null ? Sql.update(c, "DELETE FROM ma_held WHERE address = ?", address)
                    : Sql.update(c, "DELETE FROM ma_held WHERE address = ? AND identity_key <> ?", address, identityKey);
            changes.accounts |= n > 0;
            return n;
        });
    }

    // ---- the member's contacts

    /**
     * The contact for a member address, made if it's new, and let in: what opening someone's invite link does (writing to
     * them would do the same). {@code display} (the name the link carried) is a hint on the endpoint, never identity, and
     * names the contact only if the member hasn't.
     *
     * @return {@code [contactId, channelId]} (its direct channel, made if new), or null if the address (or its contact, or
     *     its domain) is blocked
     */
    public String[] contact(String address, String display) throws SQLException {
        String value = Norm.endpoint("ma", address);
        if (value == null) {
            throw new IllegalArgumentException("address");
        }
        return store.write((c, changes) -> {
            long now = store.now();
            Graph.Endpoint found = Graph.findEndpoint(c, "ma", value);
            if ((found != null && Lanes.BLOCKED.equals(found.standing())) || Graph.blocked(c, "ma", value)) {
                return null;
            }
            Graph.Endpoint e = Graph.endpoint(c, store.ids(), "ma", value, display, now, true);
            if (Lanes.BLOCKED.equals(e.standing())) {
                return null;
            }
            if (found == null) {
                // The member added it (an invite's Add): the person view says "you added it" (flow 11's sources).
                Sql.update(c, "UPDATE endpoints SET source = 'added' WHERE id = ?", e.id());
            }
            Graph.letIn(c, e.contactId(), now, changes);
            String channel = Graph.channel(c, store.ids(), "direct:" + e.contactId(), "direct", null, List.of(e.id()), now);
            changes.lane(channel, null);
            return new String[] {e.contactId(), channel};
        });
    }

    /** {@link #contact(String, String)} with no name: its contact id, or null if blocked. */
    public String contact(String address) throws SQLException {
        String[] r = contact(address, null);
        return r == null ? null : r[0];
    }

    /** The {@code ma} addresses of a contact. */
    public List<String> addressesOf(String contactId) throws SQLException {
        return store.db().read(c -> Sql.list(c, "SELECT value FROM endpoints WHERE contact_id = ? AND kind = 'ma' ORDER BY first_seen_at",
                r -> r.getString(1), contactId));
    }

    /** The contact an {@code ma} or {@code email} endpoint with this address belongs to, or null. */
    public String contactOf(String address) throws SQLException {
        return store.db().read(c -> Sql.stringOne(c,
                "SELECT contact_id FROM endpoints WHERE kind IN ('ma', 'email') AND value = ? ORDER BY kind = 'ma' DESC LIMIT 1", address));
    }

    /** Whether an address or its domain is blocked, or its endpoint is. */
    public boolean blocked(String kind, String value) throws SQLException {
        return store.db().read(c -> {
            Graph.Endpoint e = Graph.findEndpoint(c, kind, value);
            return (e != null && Lanes.BLOCKED.equals(e.standing())) || Graph.blocked(c, kind, value);
        });
    }

    // ---- delivery notes

    /**
     * A delivery note from the platform's sending provider (sealed back by the mail door): sets the status of the recipient
     * {@code recipient} of the member's message with {@code rfcMessageId} that went out through {@code accountId}. A message
     * every recipient of which bounced or complained is {@code failed}.
     *
     * @return whether such a message and recipient were found
     */
    public boolean deliveryNote(String accountId, String rfcMessageId, String recipient, String status) throws SQLException {
        String msgid = Norm.msgid("<" + rfcMessageId + ">");
        String value = Norm.email(recipient);
        if (msgid == null || value == null) {
            return false;
        }
        return store.write((c, changes) -> {
            Object[] m = Sql.one(c, "SELECT seq, channel_id FROM messages WHERE msgid = ? AND direction = 'out' AND account_id = ?",
                    r -> new Object[] {r.getLong(1), r.getString(2)}, msgid, accountId);
            if (m == null) {
                return false;
            }
            int n = Sql.update(c, """
                    UPDATE recipients SET status = ? WHERE message_seq = ? AND endpoint_id IN (SELECT id FROM endpoints WHERE value = ?)""",
                    status, m[0], value);
            if (n == 0) {
                return false;
            }
            Long left = Sql.longOne(c, """
                    SELECT count(*) FROM recipients WHERE message_seq = ? AND coalesce(status, '') NOT IN ('bounced', 'complained', 'refused')""",
                    m[0]);
            if (left != null && left == 0) {
                Sql.update(c, "UPDATE messages SET status = 'failed' WHERE seq = ?", m[0]);
            }
            changes.outbound = true;
            changes.lane((String) m[1], null);
            return true;
        });
    }

    // ---- the delivery picker

    /** A channel's facts for the picker; null if there's no such channel. */
    public PickFacts pickFacts(String channelId) throws SQLException {
        return store.db().read(c -> {
            Object[] ch = Sql.one(c, "SELECT kind, preferred_medium FROM channels WHERE id = ?", r -> new Object[] {r.getString(1), r.getString(2)},
                    channelId);
            if (ch == null) {
                return null;
            }
            List<String> contacts = Sql.list(c, """
                    SELECT DISTINCT e.contact_id FROM channel_members cm JOIN endpoints e ON e.id = cm.endpoint_id WHERE cm.channel_id = ?""",
                    r -> r.getString(1), channelId);
            List<Person> people = new ArrayList<>();
            for (String contact : contacts) {
                people.add(new Person(contact, endpointsOf(c, contact)));
            }
            Object[] last = Sql.one(c, """
                    SELECT medium, account_id, sort_at FROM messages WHERE channel_id = ? AND direction = 'in' AND lane NOT IN ('spam', 'trash', 'pending')
                    ORDER BY sort_at DESC, seq DESC LIMIT 1""", r -> new Object[] {r.getString(1), r.getString(2), r.getLong(3)}, channelId);
            return new PickFacts((String) ch[0], people, last == null ? null : (String) last[0], last == null ? null : (String) last[1],
                    last == null ? null : (Long) last[2], (String) ch[1]);
        });
    }

    /** The people behind a list of addresses typed in a draft's To: each value's contact and endpoints, or itself alone. */
    public List<Person> people(List<String[]> kindValues) throws SQLException {
        return store.db().read(c -> {
            Map<String, Person> out = new LinkedHashMap<>();
            for (String[] kv : kindValues) {
                Graph.Endpoint e = Graph.findEndpoint(c, kv[0], kv[1]);
                if (e == null && ("email".equals(kv[0]) || "ma".equals(kv[0]))) {
                    e = Graph.findEndpoint(c, "email".equals(kv[0]) ? "ma" : "email", kv[1]);
                }
                if (e == null) {
                    out.put(kv[0] + ":" + kv[1], new Person(null, List.<String[]>of(kv)));
                } else {
                    out.putIfAbsent(e.contactId(), new Person(e.contactId(), endpointsOf(c, e.contactId())));
                }
            }
            return new ArrayList<>(out.values());
        });
    }

    private static List<String[]> endpointsOf(Connection c, String contactId) throws SQLException {
        return Sql.list(c, "SELECT kind, value FROM endpoints WHERE contact_id = ? ORDER BY first_seen_at",
                r -> new String[] {r.getString(1), r.getString(2)}, contactId);
    }

    // ---- upkeep

    /** Expired tombstones, held messages nobody accepted in 30 days, and held messages from senders since blocked. */
    int sweep(long now) throws SQLException {
        return store.write((c, changes) -> {
            int n = Sql.update(c, "DELETE FROM relay_seen WHERE until <= ?", now);
            int held = Sql.update(c, "DELETE FROM ma_held WHERE received_at < ?", now - HELD_KEEP_MS);
            held += Sql.update(c, """
                    DELETE FROM ma_held WHERE address IN (SELECT value FROM endpoints WHERE kind = 'ma' AND standing = 'blocked')
                      OR address IN (SELECT value FROM blocks WHERE kind = 'address')""");
            changes.accounts |= held > 0;
            return n + held;
        });
    }
}
