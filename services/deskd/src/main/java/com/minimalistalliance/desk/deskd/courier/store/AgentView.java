package com.minimalistalliance.desk.deskd.courier.store;

import com.minimalistalliance.desk.deskd.courier.CourierRead;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * {@link CourierRead} on the real store: the agent tools' view (draft ADR §12, with the Courier plan's §6 amendments,
 * accepted by Security's stand-in read on Nov 13). Only the lanes {@link Lanes#AGENT_VISIBLE} (or
 * {@link Lanes#AGENT_VISIBLE_STRICT}, by the setting) are ever read, in SQL, so no path can return a Request, Spam or
 * Trash. A blocked sender's mail is in Spam; it reaches an agent only if the member moves it out themselves (Security
 * CS-I1).
 */
public final class AgentView implements CourierRead {

    public static final int LIST_PAGE = 50;
    public static final int SEARCH_HITS = 25;
    public static final int NEW_MAX = 100;
    public static final int PAGE_CHARS = 20_000;
    public static final int SNIPPET = 200;

    private final CourierStore store;
    private final BooleanSupplier on;
    private final Supplier<List<String>> lanes;

    /**
     * @param on whether Courier is on (its switch, the band): off means {@link #available} is false
     * @param otherVisible whether agents see the Other lane (the plan's amendment 2): the setting, read at each call
     */
    public AgentView(CourierStore store, BooleanSupplier on, BooleanSupplier otherVisible) {
        this.store = store;
        this.on = on;
        this.lanes = () -> otherVisible.getAsBoolean() ? Lanes.AGENT_VISIBLE : Lanes.AGENT_VISIBLE_STRICT;
    }

    @Override
    public boolean available() {
        return store != null && on.getAsBoolean();
    }

    private void check() {
        if (!available()) {
            throw new IllegalStateException("courier");
        }
    }

    @Override
    public Map<String, Object> list(String kind, Boolean unread, String before) throws SQLException {
        check();
        if (kind != null && !List.of("direct", "group", "self").contains(kind)) {
            throw new IllegalArgumentException("kind");
        }
        Queries.Cursor cursor = Queries.Cursor.parse(before);
        List<String> visible = lanes.get();
        return store.db().read(c -> {
            StringBuilder sql = new StringBuilder("SELECT cl.channel_id, max(cl.last_at) AS la, sum(cl.unread) AS un FROM channel_lanes cl");
            List<Object> args = new ArrayList<>();
            if (kind != null) {
                sql.append(" JOIN channels ch ON ch.id = cl.channel_id AND ch.kind = ?");
                args.add(kind);
            }
            sql.append(" WHERE cl.lane IN (").append(Sql.marks(visible.size())).append(") GROUP BY cl.channel_id HAVING 1 = 1");
            args.addAll(visible);
            if (Boolean.TRUE.equals(unread)) {
                sql.append(" AND un > 0");
            } else if (Boolean.FALSE.equals(unread)) {
                sql.append(" AND un = 0");
            }
            if (cursor != null) {
                sql.append(" AND (la, cl.channel_id) < (?, ?)");
                args.add(cursor.at());
                args.add(cursor.id());
            }
            sql.append(" ORDER BY la DESC, cl.channel_id DESC LIMIT ?");
            args.add(LIST_PAGE + 1);
            List<Object[]> rows = Sql.list(c, sql.toString(), r -> new Object[] {r.getString(1), r.getLong(2), r.getLong(3)}, args.toArray());
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i = 0; i < Math.min(LIST_PAGE, rows.size()); i++) {
                String channelId = (String) rows.get(i)[0];
                Map<String, Object> ch = store.queries.channel(c, channelId);
                Queries.Msg last = Sql.one(c, "SELECT " + Queries.Msg.COLS + " FROM messages m WHERE m.channel_id = ? AND m.lane IN ("
                        + Sql.marks(visible.size()) + ") ORDER BY m.sort_at DESC, m.seq DESC LIMIT 1", Queries.Msg::of,
                        Sql.args(visible, channelId));
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("channelId", channelId);
                row.put("kind", ch.get("kind"));
                row.put("title", ch.get("title"));
                List<String> names = new ArrayList<>();
                for (Object o : (List<?>) ch.get("contacts")) {
                    Map<?, ?> contact = (Map<?, ?>) o;
                    Object name = contact.get("name");
                    names.add(name != null ? (String) name : (String) ((Map<?, ?>) contact.get("endpoint")).get("value"));
                }
                row.put("contacts", names);
                row.put("medium", last == null ? null : last.medium());
                row.put("lastAt", rows.get(i)[1]);
                row.put("unread", rows.get(i)[2]);
                row.put("lane", last == null ? null : last.lane());
                row.put("accountLabel", last == null ? null : accountLabel(c, last.accountId()));
                out.add(row);
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("channels", out);
            result.put("next", rows.size() > LIST_PAGE
                    ? new Queries.Cursor((Long) rows.get(LIST_PAGE - 1)[1], (String) rows.get(LIST_PAGE - 1)[0]).wire() : null);
            return result;
        });
    }

    @Override
    public Map<String, Object> search(String q, String channelId, String from, String fromDay, String toDay, String zone)
            throws SQLException {
        check();
        String query = (q == null ? "" : q) + (from == null || from.isBlank() ? "" : " from:\"" + from.replace("\"", "") + "\"");
        SearchQuery parsed = SearchQuery.parse(query);
        if (parsed.empty) {
            throw new IllegalArgumentException("q");
        }
        ZoneId z = zone(zone);
        long[] range = null;
        if (fromDay != null || toDay != null) {
            long start = fromDay == null ? Long.MIN_VALUE : SearchQuery.startOf(day(fromDay), z);
            long end = toDay == null ? Long.MAX_VALUE : SearchQuery.startOf(day(toDay).plusDays(1), z);
            range = new long[] {start, end};
        }
        long[] r = range;
        List<String> visible = lanes.get();
        return store.db().read(c -> {
            List<Object[]> rows = store.queries.searchRows(c, parsed, visible, channelId, null, SEARCH_HITS, z, r);
            List<Map<String, Object>> hits = new ArrayList<>();
            for (Object[] row : rows) {
                Queries.Msg m = (Queries.Msg) row[0];
                String fts = (String) row[1];
                String snippet = Norm.line(AgentText.shape(fts == null || fts.isBlank() ? (m.snippet() == null ? "" : m.snippet()) : fts), 400);
                if (snippet != null && snippet.length() > SNIPPET) {
                    snippet = snippet.substring(0, SNIPPET - 1) + "…";
                }
                Map<String, Object> hit = new LinkedHashMap<>();
                hit.put("messageId", m.id());
                hit.put("channelId", m.channelId());
                hit.put("from", from(c, m));
                hit.put("at", m.sortAt());
                hit.put("medium", m.medium());
                hit.put("subject", m.subject());
                hit.put("snippet", snippet == null ? "" : snippet);
                hit.put("lane", m.lane());
                hit.put("accountLabel", accountLabel(c, m.accountId()));
                hit.put("bulk", m.bulk());
                hit.put("senderKnown", m.senderKnown());
                hit.put("senderConfirmed", Queries.senderConfirmed(m));
                hits.add(hit);
            }
            return Map.of("hits", hits);
        });
    }

    @Override
    public Map<String, Object> read(String messageId, int from) throws SQLException {
        check();
        List<String> visible = lanes.get();
        return store.db().read(c -> {
            Queries.Msg m = Sql.one(c, "SELECT " + Queries.Msg.COLS + " FROM messages m WHERE m.id = ? AND m.lane IN ("
                    + Sql.marks(visible.size()) + ")", Queries.Msg::of, Sql.args(visible, messageId));
            if (m == null) {
                return null;
            }
            String text = AgentText.shape(Sql.stringOne(c, "SELECT body_text FROM messages WHERE seq = ?", m.seq()));
            int start = Math.max(0, Math.min(from, text.length()));
            int end = Math.min(text.length(), start + PAGE_CHARS);
            Map<String, Object> out = shape(c, m, text.substring(start, end));
            out.put("textFrom", start);
            out.put("textNext", end < text.length() ? end : null);
            return out;
        });
    }

    @Override
    public Map<String, Object> readChannel(String channelId, String before) throws SQLException {
        check();
        Queries.Cursor cursor = Queries.Cursor.parse(before);
        List<String> visible = lanes.get();
        return store.db().read(c -> {
            StringBuilder sql = new StringBuilder("SELECT " + Queries.Msg.COLS + " FROM messages m WHERE m.channel_id = ? AND m.lane IN ("
                    + Sql.marks(visible.size()) + ")");
            List<Object> args = new ArrayList<>();
            args.add(channelId);
            args.addAll(visible);
            if (cursor != null) {
                sql.append(" AND (m.sort_at, m.id) < (?, ?)");
                args.add(cursor.at());
                args.add(cursor.id());
            }
            sql.append(" ORDER BY m.sort_at DESC, m.id DESC LIMIT 200");
            List<Queries.Msg> rows = Sql.list(c, sql.toString(), Queries.Msg::of, args.toArray());
            if (rows.isEmpty() && cursor == null) {
                return null;
            }
            List<Map<String, Object>> page = new ArrayList<>();
            int chars = 0;
            Queries.Msg lastTaken = null;
            for (Queries.Msg m : rows) {
                String text = AgentText.shape(Sql.stringOne(c, "SELECT body_text FROM messages WHERE seq = ?", m.seq()));
                int room = PAGE_CHARS - chars;
                if (room <= 0) {
                    break;
                }
                boolean cut = text.length() > room;
                Map<String, Object> shaped = shape(c, m, cut ? text.substring(0, room) : text);
                shaped.put("textMore", cut);
                page.add(0, shaped);
                chars += Math.min(text.length(), room);
                lastTaken = m;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("channelId", channelId);
            out.put("messages", page);
            boolean more = lastTaken != null && rows.indexOf(lastTaken) < rows.size() - 1;
            out.put("next", more ? new Queries.Cursor(lastTaken.sortAt(), lastTaken.id()).wire() : null);
            return out;
        });
    }

    @Override
    public Map<String, Object> newSince(CourierRead.Cursor cursor, int max) throws SQLException {
        check();
        int n = Math.max(1, Math.min(NEW_MAX, max));
        List<String> visible = new ArrayList<>(lanes.get());
        visible.remove(Lanes.UPDATES);
        long at = cursor == null ? Long.MIN_VALUE : cursor.receivedAt();
        String id = cursor == null ? "" : cursor.messageId();
        return store.db().read(c -> {
            // By the cursor's own index, from the cursor on: with the lanes' index SQLite read every row of the lanes and
            // sorted them, about 60 ms a call at 50,000 messages (W5's measurement). The index leaves out a linked mailbox's
            // first sync of its old mail (origin backfill): years of it aren't new, and an agent turning mail into to-dos
            // mustn't be handed them as if they'd just come (Wave 2.1). Mail of the last day before the link is "catchup".
            List<Queries.Msg> rows = Sql.list(c, "SELECT " + Queries.Msg.COLS + " FROM messages m INDEXED BY messages_received_new"
                    + " WHERE (m.received_at, m.id) > (?, ?) AND m.origin <> 'backfill'"
                    + " AND m.direction = 'in' AND m.bulk = 0 AND m.lane IN (" + Sql.marks(visible.size())
                    + ") ORDER BY m.received_at, m.id LIMIT ?", Queries.Msg::of,
                    concat(new Object[] {at, id}, visible.toArray(), new Object[] {n}));
            List<Map<String, Object>> out = new ArrayList<>();
            CourierRead.Cursor last = cursor;
            for (Queries.Msg m : rows) {
                String text = AgentText.shape(Sql.stringOne(c, "SELECT body_text FROM messages WHERE seq = ?", m.seq()));
                Map<String, Object> shaped = shape(c, m, text.length() > PAGE_CHARS ? text.substring(0, PAGE_CHARS) : text);
                shaped.put("textMore", text.length() > PAGE_CHARS);
                out.add(shaped);
                last = new CourierRead.Cursor(m.receivedAt(), m.id());
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("messages", out);
            result.put("cursor", last == null ? null : last.wire());
            return result;
        });
    }

    private static Object[] concat(Object[]... parts) {
        int n = 0;
        for (Object[] p : parts) {
            n += p.length;
        }
        Object[] out = new Object[n];
        int i = 0;
        for (Object[] p : parts) {
            System.arraycopy(p, 0, out, i, p.length);
            i += p.length;
        }
        return out;
    }

    @Override
    public CourierRead.Cursor now() throws SQLException {
        return store.db().read(c -> Sql.one(c, "SELECT received_at, id FROM messages ORDER BY received_at DESC, id DESC LIMIT 1",
                r -> new CourierRead.Cursor(r.getLong(1), r.getString(2))));
    }

    @Override
    public CourierRead.Cursor cursor(String agentId) throws SQLException {
        return store.db().read(c -> Sql.one(c, "SELECT received_at, message_id FROM agent_cursors WHERE agent_id = ?",
                r -> new CourierRead.Cursor(r.getLong(1), r.getString(2)), agentId));
    }

    @Override
    public void saveCursor(String agentId, CourierRead.Cursor cursor) throws SQLException {
        if (agentId == null || agentId.isEmpty() || agentId.length() > 128 || cursor == null || cursor.messageId() == null
                || cursor.messageId().length() > 64) {
            throw new IllegalArgumentException("cursor");
        }
        store.db().transaction(c -> {
            CourierRead.Cursor stored = Sql.one(c, "SELECT received_at, message_id FROM agent_cursors WHERE agent_id = ?",
                    r -> new CourierRead.Cursor(r.getLong(1), r.getString(2)), agentId);
            if (stored != null && !cursor.after(stored)) {
                return null;
            }
            Sql.update(c, """
                    INSERT INTO agent_cursors (agent_id, received_at, message_id, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (agent_id) DO UPDATE SET received_at = excluded.received_at, message_id = excluded.message_id,
                      updated_at = excluded.updated_at""", agentId, cursor.receivedAt(), cursor.messageId(), store.now());
            return null;
        });
    }

    @Override
    public boolean names(CourierRead.Cursor cursor) throws SQLException {
        if (cursor == null || cursor.messageId() == null || cursor.messageId().isEmpty()) {
            return false;
        }
        // Only a message courier_new could have given: inbound, not bulk, in a lane it reads (Security's CR-I1).
        List<String> visible = new ArrayList<>(lanes.get());
        visible.remove(Lanes.UPDATES);
        return store.db().read(c -> Sql.exists(c, "SELECT 1 FROM messages m WHERE m.id = ? AND m.received_at = ?"
                + " AND m.origin <> 'backfill' AND m.direction = 'in' AND m.bulk = 0 AND m.lane IN (" + Sql.marks(visible.size()) + ")",
                concat(new Object[] {cursor.messageId(), cursor.receivedAt()}, visible.toArray())));
    }

    @Override
    public void forgetCursor(String agentId) throws SQLException {
        store.db().transaction(c -> Sql.update(c, "DELETE FROM agent_cursors WHERE agent_id = ?", agentId));
    }

    /** §12's message: {messageId, channelId, direction, from, at, medium, subject?, text, attachments, bulk, authorKind}. */
    private Map<String, Object> shape(Connection c, Queries.Msg m, String text) throws SQLException {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("messageId", m.id());
        out.put("channelId", m.channelId());
        out.put("direction", m.direction());
        out.put("from", from(c, m));
        out.put("at", m.sortAt());
        out.put("receivedAt", m.receivedAt());
        out.put("medium", m.medium());
        out.put("subject", m.subject());
        out.put("text", text);
        List<Map<String, Object>> attachments = new ArrayList<>();
        for (Map<String, Object> a : Queries.attachments(c, m.seq(), 100)) {
            if (Boolean.TRUE.equals(a.get("inline"))) {
                continue;
            }
            Map<String, Object> named = new LinkedHashMap<>();
            named.put("name", a.get("name"));
            named.put("type", a.get("type"));
            named.put("bytes", a.get("bytes"));
            attachments.add(named);
        }
        out.put("attachments", attachments);
        out.put("bulk", m.bulk());
        out.put("authorKind", m.authorKind());
        out.put("lane", m.lane());
        out.put("senderKnown", m.senderKnown());
        out.put("senderConfirmed", Queries.senderConfirmed(m));
        out.put("accountLabel", accountLabel(c, m.accountId()));
        return out;
    }

    /** {contactId, name, endpoint}: the contact record, never the message's own words. The member's own is {me: true}. */
    private static Map<String, Object> from(Connection c, Queries.Msg m) throws SQLException {
        if (m.fromEndpoint() == null) {
            return Map.of("me", true);
        }
        return Sql.one(c, """
                SELECT ct.id, ct.name, e.value FROM endpoints e JOIN contacts ct ON ct.id = e.contact_id WHERE e.id = ?""", r -> {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("contactId", r.getString(1));
            f.put("name", r.getString(2));
            f.put("endpoint", r.getString(3));
            return f;
        }, m.fromEndpoint());
    }

    private static String accountLabel(Connection c, String accountId) throws SQLException {
        if (accountId == null) {
            return null;
        }
        String[] a = Sql.one(c, "SELECT kind, label FROM accounts WHERE id = ?", r -> new String[] {r.getString(1), r.getString(2)}, accountId);
        return a == null ? null : Accounts.agentLabel(a[0], a[1]);
    }

    private static ZoneId zone(String zone) {
        if (zone == null || zone.isBlank()) {
            return ZoneOffset.UTC;
        }
        try {
            return ZoneId.of(zone);
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("zone");
        }
    }

    private static LocalDate day(String day) {
        try {
            return LocalDate.parse(day);
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("day");
        }
    }
}
