package com.minimalistalliance.desk.deskd.courier.store;

import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * What the iMessage transport (the launch plan's Wave 2.6, {@code courier.imessage}) keeps in {@code courier.db} beside the
 * messages, so it commits with them: each Mac chat's conversation here, the guid each message Courier sent got on the Mac,
 * and the Mac's contact cards. The transport speaks to the member's BlueBubbles Server; this is all its SQL.
 *
 * <p><b>Cards make names and suggestions, never conversations</b> (the Designer's flow 11): a card's name fills only a
 * person with no name yet, and only for a number or an Apple ID (never an email address, whose sender line is DMARC's);
 * a card's endpoints never let anyone in, link anyone or move any message. {@link Links#suggest} offers them as
 * "Your Mac's contacts list this number on Dana's card."
 */
public final class ImessageState {

    /** The most cards one read of the Mac's Contacts keeps, and the most endpoints one card keeps. */
    public static final int MAX_CARDS = 20_000;
    public static final int MAX_CARD_ENDPOINTS = 20;

    /** A contact card: its name and its numbers and addresses, as the Mac lists them. */
    public record Card(String name, List<String> phones, List<String> emails) {}

    private final CourierStore store;

    ImessageState(CourierStore store) {
        this.store = store;
    }

    /** Which of these sink keys of a medium are stored already: a page of the Mac's messages downloads no file twice. */
    public Set<String> known(String medium, List<String> externalIds) throws SQLException {
        if (externalIds.isEmpty()) {
            return Set.of();
        }
        return store.db().read(c -> {
            Set<String> out = new HashSet<>();
            for (String id : externalIds) {
                if (Sql.exists(c, "SELECT 1 FROM messages WHERE medium = ? AND external_id = ?", medium, id)) {
                    out.add(id);
                }
            }
            return out;
        });
    }

    /** Whether the message with this guid on the Mac is one Courier sent: its echo is the same message. */
    public boolean sentByCourier(String accountId, String guid) throws SQLException {
        return store.db().read(c -> Sql.exists(c, "SELECT 1 FROM imessage_sent WHERE account_id = ? AND guid = ?", accountId, guid));
    }

    /** The guid a message Courier sent got on the Mac, kept so its echo is known; a second record of one is ignored. */
    public void recordSent(String accountId, String guid, String messageId) throws SQLException {
        store.write((c, changes) -> Sql.update(c,
                "INSERT OR IGNORE INTO imessage_sent (account_id, guid, message_id, created_at) VALUES (?, ?, ?, ?)", accountId, guid,
                messageId, store.now()));
    }

    /**
     * The text of the message a reaction or an edit names, by its guid on the Mac: one that came in through this account, or
     * one Courier sent; null if the desk doesn't have it.
     */
    public String textOf(String accountId, String externalId, String guid) throws SQLException {
        return store.db().read(c -> {
            String t = Sql.stringOne(c, "SELECT body_text FROM messages WHERE medium IN ('imessage', 'sms') AND external_id = ? AND account_id = ?",
                    externalId, accountId);
            if (t == null) {
                t = Sql.stringOne(c, """
                        SELECT m.body_text FROM imessage_sent s JOIN messages m ON m.id = s.message_id
                        WHERE s.account_id = ? AND s.guid = ?""", accountId, guid);
            }
            return t;
        });
    }

    /** The Mac chat a group conversation here came from, for a reply to it; null if none did. */
    public String chatFor(String accountId, String channelId) throws SQLException {
        return store.db().read(c -> Sql.stringOne(c, """
                SELECT chat_guid FROM imessage_chats WHERE account_id = ? AND channel_id = ? ORDER BY updated_at DESC LIMIT 1""",
                accountId, channelId));
    }

    /** The conversation a stored message is in. */
    public String channelOf(String messageId) throws SQLException {
        return store.db().read(c -> Sql.stringOne(c, "SELECT channel_id FROM messages WHERE id = ?", messageId));
    }

    /**
     * Stores a page of the Mac's messages and the transport's place with them, in one transaction ({@link CourierStore#accept}),
     * and remembers, for each one in a group chat, which conversation that chat is here.
     *
     * @param chats one per message: its group chat's guid and service, or null for a one-to-one chat
     */
    public List<Courier.Accepted> accept(String accountId, List<Courier.Inbound> batch, Courier.CursorUpdate cursor, List<String[]> chats)
            throws SQLException, IOException, InterruptedException {
        return store.accept(batch, cursor, (c, answers, changes) -> {
            long now = store.now();
            for (int i = 0; i < answers.size() && i < chats.size(); i++) {
                Courier.Accepted a = answers.get(i);
                String[] chat = chats.get(i);
                if (chat == null || a == null || a.messageId() == null) {
                    continue;
                }
                String channel = Sql.stringOne(c, "SELECT channel_id FROM messages WHERE id = ?", a.messageId());
                if (channel != null) {
                    Sql.update(c, """
                            INSERT INTO imessage_chats (account_id, chat_guid, channel_id, service, updated_at) VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT (account_id, chat_guid) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at""",
                            accountId, chat[0], channel, chat[1], now);
                }
            }
        });
    }

    // ---- cards

    /**
     * Replaces every card from {@code source} ({@code mac:<accountId>}) with these, capped and cleaned, then names the people
     * with no name yet whose number or Apple ID a card lists.
     *
     * @return how many people got a name
     */
    public int putCards(String source, List<Card> cards) throws SQLException {
        return store.write((c, changes) -> {
            long now = store.now();
            Sql.update(c, "DELETE FROM card_endpoints WHERE card_seq IN (SELECT seq FROM cards WHERE source = ?)", source);
            Sql.update(c, "DELETE FROM cards WHERE source = ?", source);
            int kept = 0;
            for (Card card : cards) {
                if (kept >= MAX_CARDS) {
                    break;
                }
                List<String[]> eps = new ArrayList<>();
                Set<String> seen = new HashSet<>();
                for (String p : card.phones() == null ? List.<String>of() : card.phones()) {
                    String v = Norm.phone(p);
                    String m = phoneMatch(v);
                    if (m != null && eps.size() < MAX_CARD_ENDPOINTS && seen.add(m)) {
                        eps.add(new String[] {"phone", v, m});
                    }
                }
                for (String e : card.emails() == null ? List.<String>of() : card.emails()) {
                    String v = Norm.email(e);
                    if (v != null && eps.size() < MAX_CARD_ENDPOINTS && seen.add("e:" + v)) {
                        eps.add(new String[] {"email", v, "e:" + v});
                    }
                }
                if (eps.isEmpty()) {
                    continue;
                }
                long seq = Sql.insert(c, "INSERT INTO cards (source, name, updated_at) VALUES (?, ?, ?)", source,
                        Graph.displayName(card.name()), now);
                for (String[] e : eps) {
                    Sql.update(c, "INSERT OR IGNORE INTO card_endpoints (card_seq, kind, value, match) VALUES (?, ?, ?, ?)", seq, e[0], e[1], e[2]);
                }
                kept++;
            }
            int named = nameFromCards(c, now);
            if (named > 0) {
                changes.accounts = true;
                changes.counts = true;
            }
            return named;
        });
    }

    /** Names people with no name yet from the cards: after new cards, and after new numbers came in. */
    public int nameFromCards() throws SQLException {
        return store.write((c, changes) -> {
            int n = nameFromCards(c, store.now());
            if (n > 0) {
                changes.counts = true;
            }
            return n;
        });
    }

    private static int nameFromCards(Connection c, long now) throws SQLException {
        List<String[]> rows = Sql.list(c, """
                SELECT ct.id, e.kind, e.value FROM contacts ct JOIN endpoints e ON e.contact_id = ct.id
                WHERE ct.named = 0 AND ct.name IS NULL AND e.kind IN ('phone', 'apple') LIMIT 5000""",
                r -> new String[] {r.getString(1), r.getString(2), r.getString(3)});
        int named = 0;
        Set<String> done = new HashSet<>();
        for (String[] r : rows) {
            if (done.contains(r[0])) {
                continue;
            }
            String match = endpointMatch(r[1], r[2]);
            if (match == null) {
                continue;
            }
            // Only a card that alone names it: two cards with two names for one number name nobody.
            Set<String> names = new HashSet<>();
            for (String[] hit : Sql.list(c, """
                    SELECT cd.name, ce.value FROM card_endpoints ce JOIN cards cd ON cd.seq = ce.card_seq
                    WHERE ce.match = ? AND cd.name IS NOT NULL LIMIT 20""", x -> new String[] {x.getString(1), x.getString(2)}, match)) {
                if (samePhone(hit[1], r[2])) {
                    names.add(hit[0]);
                }
            }
            if (names.size() != 1) {
                continue;
            }
            String name = names.iterator().next();
            named += Sql.update(c, "UPDATE contacts SET name = ?, name_key = ?, updated_at = ? WHERE id = ? AND named = 0 AND name IS NULL",
                    name, Senders.nameKey(name), now, r[0]);
            done.add(r[0]);
        }
        return named;
    }

    /** How many cards a source has. */
    public long cards(String source) throws SQLException {
        return store.db().read(c -> {
            Long n = Sql.longOne(c, "SELECT count(*) FROM cards WHERE source = ?", source);
            return n == null ? 0 : n;
        });
    }

    /** What a number is compared by: its last 10 digits ({@code p:...}); null for one too short to tell people apart. */
    static String phoneMatch(String phone) {
        if (phone == null) {
            return null;
        }
        String digits = phone.replace("+", "");
        if (digits.length() < 7) {
            return null;
        }
        return "p:" + (digits.length() > 10 ? digits.substring(digits.length() - 10) : digits);
    }

    /**
     * Whether a card's value and an endpoint's are the same number: equal when both carry a country code, else by their last
     * 10 digits (a card often has none), so a number abroad that shares those digits isn't someone's (Security IM-I1).
     * Addresses are compared by {@code match} alone.
     */
    static boolean samePhone(String cardValue, String endpointValue) {
        if (cardValue == null || endpointValue == null || cardValue.contains("@") || endpointValue.contains("@")) {
            return true;
        }
        if (cardValue.startsWith("+") && endpointValue.startsWith("+")) {
            return cardValue.equals(endpointValue);
        }
        return true;
    }

    /** What an endpoint is compared with a card by; null for a kind cards don't hold. */
    static String endpointMatch(String kind, String value) {
        if (value == null) {
            return null;
        }
        return switch (kind) {
            case "phone" -> phoneMatch(value);
            case "apple" -> value.contains("@") ? "e:" + value : phoneMatch(value);
            case "email", "ma" -> "e:" + value;
            default -> null;
        };
    }

    /** When an account goes: its chats, its sent guids and its Mac's cards. */
    static void forgetAccount(Connection c, String accountId) throws SQLException {
        Sql.update(c, "DELETE FROM imessage_chats WHERE account_id = ?", accountId);
        Sql.update(c, "DELETE FROM imessage_sent WHERE account_id = ?", accountId);
        Sql.update(c, "DELETE FROM card_endpoints WHERE card_seq IN (SELECT seq FROM cards WHERE source = ?)", "mac:" + accountId);
        Sql.update(c, "DELETE FROM cards WHERE source = ?", "mac:" + accountId);
    }
}
