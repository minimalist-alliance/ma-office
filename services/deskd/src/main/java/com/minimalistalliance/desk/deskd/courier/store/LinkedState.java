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
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A linked mailbox's state at its provider, kept in {@code courier.db} beside the messages so both commit together (the
 * launch plan's Wave 2.1; draft ADR "Courier's store" §15): the folders, where each message sits in them (folder, UID,
 * {@code \Seen}, the provider's labels), messages that lost their last place and may turn up again, and the member's
 * changes the provider is owed. The transport ({@code courier.linked}) speaks IMAP; this is all its SQL.
 *
 * <p><b>Both ways, without echoes.</b> The member's read, Trash, Spam, restore and delete on the desk are written here as
 * ops in the member's own transaction ({@link #recordOps}, called by {@link Actions}); the transport applies them at the
 * provider and never writes an op itself. What the provider says (a flag, a move to Trash or Junk, a delete) changes the
 * desk with no op, and is held off a message while an op of the member's is still owed for it, so the member's last word
 * wins.
 *
 * <p><b>No message twice, none missed.</b> A place is recorded in the sink's own transaction ({@link #arrive}), so a UID
 * the desk has is never fetched again. A message whose last place goes (a move, a UIDVALIDITY reset, a folder renamed) is
 * kept as an orphan with its Gmail id, Message-ID, size and date, so where it turns up it's matched without a fetch; only
 * after a whole pass of every folder hasn't found it ({@link #settle}) is it gone at the provider: to Trash on the desk,
 * or deleted for good if it was in Trash. Whatever a match misses, the sink's own key (account, Message-ID, the bytes'
 * hash) stores once.
 */
public final class LinkedState {

    /** What a folder is for, from SPECIAL-USE or its name. */
    public static final String INBOX = "inbox";
    public static final String SENT = "sent";
    public static final String JUNK = "junk";
    public static final String TRASH = "trash";
    public static final String DRAFTS = "drafts";
    public static final String ARCHIVE = "archive";
    public static final String ALL = "all";
    public static final String OTHER = "other";
    public static final Set<String> ROLES = Set.of(INBOX, SENT, JUNK, TRASH, DRAFTS, ARCHIVE, ALL, OTHER);

    /** The member's changes a provider is owed. */
    public static final String OP_READ = "read";
    public static final String OP_UNREAD = "unread";
    public static final String OP_TRASH = "trash";
    public static final String OP_SPAM = "spam";
    public static final String OP_RESTORE = "restore";
    public static final String OP_DELETE = "delete";
    public static final Set<String> OPS = Set.of(OP_READ, OP_UNREAD, OP_TRASH, OP_SPAM, OP_RESTORE, OP_DELETE);
    /** Tries before an op the provider keeps failing is dropped (the desk's state stands). */
    public static final int OP_TRIES = 8;

    private static final String NORMAL = "normal";

    private final CourierStore store;
    private final AtomicBoolean opsWritten = new AtomicBoolean();
    private volatile Runnable opsListener = () -> {};

    LinkedState(CourierStore store) {
        this.store = store;
        store.onChange(change -> {
            if (opsWritten.getAndSet(false)) {
                opsListener.run();
            }
        });
    }

    /** Tells {@code courier.changed}'s listeners that an account's state changed (its sync's), with nothing written. */
    public void announce() {
        Courier.ChangeSet ch = new Courier.ChangeSet();
        ch.accounts = true;
        store.publish(ch);
    }

    /** Told after a commit that wrote ops: the transport wakes its accounts. It must only queue work. */
    public void onOps(Runnable listener) {
        this.opsListener = listener == null ? () -> {} : listener;
    }

    // ---- folders

    /**
     * A folder and how far the desk has it. {@code topUid}: every UID up to it the live path has handled.
     * {@code lowUid}: the first sync has handled every UID from it up to {@code topUid}; {@code backfilled} once nothing
     * below it is left. {@code modseq}: the highest CONDSTORE change applied (0 with none). {@code recentUid}: the lowest UID
     * of the last 12 months, for the first sync's two passes.
     */
    public record Folder(long id, String accountId, String name, String role, long uidValidity, long uidNext, long topUid,
            long lowUid, boolean backfilled, Long recentUid, long modseq, Long oldestAt, Long syncedAt) {

        public Folder withSelected(long uidNext, long modseq) {
            return new Folder(id, accountId, name, role, uidValidity, uidNext, topUid, lowUid, backfilled, recentUid, modseq, oldestAt, syncedAt);
        }

        public Folder withTop(long top) {
            return new Folder(id, accountId, name, role, uidValidity, uidNext, top, lowUid, backfilled, recentUid, modseq, oldestAt, syncedAt);
        }

        public Folder withLow(long low, boolean done, Long oldest) {
            Long o = oldest == null ? oldestAt : oldestAt == null ? oldest : Long.valueOf(Math.min(oldestAt, oldest));
            return new Folder(id, accountId, name, role, uidValidity, uidNext, topUid, low, done, recentUid, modseq, o, syncedAt);
        }

        public Folder withRecent(Long recent) {
            return new Folder(id, accountId, name, role, uidValidity, uidNext, topUid, lowUid, backfilled, recent, modseq, oldestAt, syncedAt);
        }

        public Folder withModseq(long m) {
            return new Folder(id, accountId, name, role, uidValidity, uidNext, topUid, lowUid, backfilled, recentUid, m, oldestAt, syncedAt);
        }

        public Folder withRole(String r) {
            return new Folder(id, accountId, name, r, uidValidity, uidNext, topUid, lowUid, backfilled, recentUid, modseq, oldestAt, syncedAt);
        }

        public Folder synced(long at) {
            return new Folder(id, accountId, name, role, uidValidity, uidNext, topUid, lowUid, backfilled, recentUid, modseq, oldestAt, at);
        }
    }

    private static final String FOLDER_COLS =
            "id, account_id, name, role, uid_validity, uid_next, top_uid, low_uid, backfilled, recent_uid, modseq, oldest_at, synced_at";

    private static Folder folder(java.sql.ResultSet r) throws SQLException {
        return new Folder(r.getLong(1), r.getString(2), r.getString(3), r.getString(4), r.getLong(5), r.getLong(6), r.getLong(7),
                r.getLong(8), r.getInt(9) == 1, Sql.nullableLong(r, "recent_uid"), r.getLong(11), Sql.nullableLong(r, "oldest_at"),
                Sql.nullableLong(r, "synced_at"));
    }

    public List<Folder> folders(String accountId) throws SQLException {
        return store.db().read(c -> Sql.list(c, "SELECT " + FOLDER_COLS + " FROM linked_folders WHERE account_id = ? ORDER BY id",
                LinkedState::folder, accountId));
    }

    /**
     * A folder seen for the first time: nothing of it handled yet. The live path starts above {@code uidNext - 1} and the
     * first sync works down from there.
     */
    public Folder addFolder(String accountId, String name, String role, long uidValidity, long uidNext) throws SQLException {
        if (!ROLES.contains(role) || name == null || name.isEmpty() || name.length() > 1024) {
            throw new IllegalArgumentException("folder");
        }
        long top = Math.max(0, uidNext - 1);
        return store.write((c, changes) -> {
            Sql.update(c, """
                    INSERT INTO linked_folders (account_id, name, role, uid_validity, uid_next, top_uid, low_uid, backfilled, modseq)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)""", accountId, name, role, uidValidity, uidNext, top, top + 1, top == 0);
            changes.accounts = true;
            return Sql.one(c, "SELECT " + FOLDER_COLS + " FROM linked_folders WHERE account_id = ? AND name = ?", LinkedState::folder,
                    accountId, name);
        });
    }

    /** A folder's own state, on its own. */
    public void putFolder(Folder f) throws SQLException {
        store.write((c, changes) -> {
            put(c, f);
            changes.accounts = true;
            return null;
        });
    }

    private static void put(Connection c, Folder f) throws SQLException {
        Sql.update(c, """
                UPDATE linked_folders SET role = ?, uid_validity = ?, uid_next = ?, top_uid = ?, low_uid = ?, backfilled = ?, recent_uid = ?,
                  modseq = ?, oldest_at = ?, synced_at = ? WHERE id = ?""",
                f.role(), f.uidValidity(), f.uidNext(), f.topUid(), f.lowUid(), f.backfilled(), f.recentUid(), f.modseq(), f.oldestAt(),
                f.syncedAt(), f.id());
    }

    /**
     * A folder the provider no longer lists (deleted, renamed): its places go, and a message left with none is an orphan
     * that a later pass finds again (a rename) or settles.
     */
    public void removeFolder(Folder f) throws SQLException {
        long now = store.now();
        store.write((c, changes) -> {
            List<Long> uids = Sql.list(c, "SELECT uid FROM linked_locations WHERE folder_id = ?", r -> r.getLong(1), f.id());
            drop(c, f, uids, now, changes);
            Sql.update(c, "DELETE FROM linked_folders WHERE id = ?", f.id());
            changes.accounts = true;
            return null;
        });
    }

    /**
     * The folder's UIDVALIDITY changed: every place the desk knew in it is void. Each becomes an orphan (matched again as
     * the folder is read anew, so nothing is fetched twice), and the folder starts over with its new numbering.
     */
    public Folder resetFolder(Folder f, long uidValidity, long uidNext) throws SQLException {
        long now = store.now();
        long top = Math.max(0, uidNext - 1);
        return store.write((c, changes) -> {
            List<Long> uids = Sql.list(c, "SELECT uid FROM linked_locations WHERE folder_id = ?", r -> r.getLong(1), f.id());
            drop(c, f, uids, now, changes);
            Folder fresh = new Folder(f.id(), f.accountId(), f.name(), f.role(), uidValidity, uidNext, top, top + 1, top == 0, null, 0,
                    null, f.syncedAt());
            put(c, fresh);
            changes.accounts = true;
            return fresh;
        });
    }

    // ---- places

    /** One message's place: its UID in a folder, and what the provider says of it there. */
    public record Place(long uid, String messageId, boolean seen, String labels) {}

    /** The UIDs the desk has in a folder within {@code [from, to]}, ascending. */
    public long[] uids(long folderId, long from, long to) throws SQLException {
        List<Long> list = store.db().read(c -> Sql.list(c,
                "SELECT uid FROM linked_locations WHERE folder_id = ? AND uid BETWEEN ? AND ? ORDER BY uid", r -> r.getLong(1),
                folderId, from, to));
        long[] out = new long[list.size()];
        for (int i = 0; i < out.length; i++) {
            out[i] = list.get(i);
        }
        return out;
    }

    /** How many places the desk has in a folder. */
    public long count(long folderId) throws SQLException {
        Long n = store.db().read(c -> Sql.longOne(c, "SELECT count(*) FROM linked_locations WHERE folder_id = ?", folderId));
        return n == null ? 0 : n;
    }

    /** The desk's places for these UIDs of a folder; a UID it doesn't have is absent. */
    public Map<Long, Place> places(long folderId, long[] uids) throws SQLException {
        Map<Long, Place> out = new LinkedHashMap<>();
        if (uids.length == 0) {
            return out;
        }
        store.db().read(c -> {
            for (int from = 0; from < uids.length; from += 500) {
                int to = Math.min(uids.length, from + 500);
                Object[] args = new Object[to - from + 1];
                args[0] = folderId;
                for (int i = from; i < to; i++) {
                    args[i - from + 1] = uids[i];
                }
                Sql.list(c, "SELECT uid, message_id, seen, labels FROM linked_locations WHERE folder_id = ? AND uid IN (" + Sql.marks(to - from) + ")",
                        r -> out.put(r.getLong(1), new Place(r.getLong(1), r.getString(2), r.getInt(3) == 1, r.getString(4))), args);
            }
            return null;
        });
        return out;
    }

    /**
     * A message the desk already has, by what the provider shows of a UID it doesn't: Gmail's own id (any folder, or an
     * orphan), or else the Message-ID with the same size and date, among orphans first and then the account's other places
     * (a copy in two folders). Only a single answer counts: two candidates and the transport fetches, and the sink's key
     * decides. Null for no match.
     */
    public String match(String accountId, String gmId, String msgid, long size, Long internalAt) throws SQLException {
        return store.db().read(c -> {
            if (gmId != null) {
                String m = unique(Sql.list(c, "SELECT DISTINCT message_id FROM linked_orphans WHERE account_id = ? AND gm_id = ?",
                        r -> r.getString(1), accountId, gmId));
                if (m != null) {
                    return m;
                }
                return unique(Sql.list(c, """
                        SELECT DISTINCT message_id FROM linked_locations WHERE account_id = ? AND gm_id = ? AND message_id IS NOT NULL""",
                        r -> r.getString(1), accountId, gmId));
            }
            if (msgid == null || internalAt == null) {
                return null;
            }
            String m = unique(Sql.list(c, """
                    SELECT DISTINCT message_id FROM linked_orphans WHERE account_id = ? AND msgid = ? AND size = ? AND internal_at = ?""",
                    r -> r.getString(1), accountId, msgid, size, internalAt));
            if (m != null) {
                return m;
            }
            return unique(Sql.list(c, """
                    SELECT DISTINCT message_id FROM linked_locations WHERE account_id = ? AND msgid = ? AND size = ? AND internal_at = ?
                      AND message_id IS NOT NULL""", r -> r.getString(1), accountId, msgid, size, internalAt));
        });
    }

    private static String unique(List<String> ids) {
        return ids.size() == 1 ? ids.get(0) : null;
    }

    /**
     * A UID read from a folder: a message for the sink ({@code inbound}), one already on the desk ({@code matched}), or a
     * place kept for nothing ({@code skip}: a draft). {@code labels} are the provider's for it (Gmail's labels, or a user
     * folder's name), {@code laneHint} nothing yet but the folder's role decides.
     */
    public record Arrival(long uid, boolean seen, String labels, long size, Long internalAt, String msgid, String gmId,
            Courier.Inbound inbound, String matched, boolean skip) {
        @Override
        public String toString() {
            return "Arrival[" + uid + "]";
        }
    }

    /**
     * Stores what a folder brought and records each place, with the folder's new state, in one transaction: the sink's.
     * Answers are one per arrival: the sink's for a message, {@code DUPLICATE} with the id for a match, null for a skip.
     */
    public List<Courier.Accepted> arrive(Folder after, List<Arrival> arrivals) throws SQLException, IOException, InterruptedException {
        return arrive(after, arrivals, null);
    }

    /** {@link #arrive(Folder, List)} with a cursor of the transport's own (its daily download count), in the same commit. */
    public List<Courier.Accepted> arrive(Folder after, List<Arrival> arrivals, Courier.CursorUpdate cursor)
            throws SQLException, IOException, InterruptedException {
        List<Courier.Inbound> batch = new ArrayList<>();
        List<Integer> slots = new ArrayList<>();
        for (int i = 0; i < arrivals.size(); i++) {
            if (arrivals.get(i).inbound() != null) {
                batch.add(arrivals.get(i).inbound());
                slots.add(i);
            }
        }
        List<Courier.Accepted> out = new ArrayList<>(arrivals.size());
        for (int i = 0; i < arrivals.size(); i++) {
            Arrival a = arrivals.get(i);
            out.add(a.matched() != null ? new Courier.Accepted(Courier.Accepted.Kind.DUPLICATE, a.matched(), null) : null);
        }
        long now = store.now();
        List<Courier.Accepted> answers = store.accept(batch, cursor, (c, sunk, changes) -> {
            for (int k = 0; k < sunk.size(); k++) {
                out.set(slots.get(k), sunk.get(k));
            }
            for (int i = 0; i < arrivals.size(); i++) {
                Arrival a = arrivals.get(i);
                Courier.Accepted ans = out.get(i);
                String messageId = a.skip() ? null : ans != null && ans.kept() ? ans.messageId() : null;
                if (!a.skip() && messageId == null) {
                    // Refused by the sink (the account just went): no place, so the next pass tries again.
                    continue;
                }
                place(c, after, a, messageId, a.inbound() == null || ans.kind() == Courier.Accepted.Kind.DUPLICATE, now, changes);
            }
            put(c, after);
            changes.accounts = true;
        });
        for (int k = 0; k < answers.size(); k++) {
            out.set(slots.get(k), answers.get(k));
        }
        return out;
    }

    private void place(Connection c, Folder f, Arrival a, String messageId, boolean existing, long now, Courier.ChangeSet changes)
            throws SQLException {
        String before = messageId == null ? null : providerLane(c, f.accountId(), messageId);
        Set<String> labelsBefore = messageId == null ? Set.of() : providerLabels(c, f.accountId(), messageId);
        Sql.update(c, """
                INSERT OR REPLACE INTO linked_locations (folder_id, uid, account_id, message_id, seen, labels, size, internal_at, msgid, gm_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", f.id(), a.uid(), f.accountId(), messageId, a.seen(), Norm.line(a.labels(), 2000),
                a.size(), a.internalAt(), Norm.line(a.msgid(), Norm.MAX_MSGID), a.gmId());
        if (messageId == null) {
            return;
        }
        Sql.update(c, "DELETE FROM linked_orphans WHERE account_id = ? AND message_id = ?", f.accountId(), messageId);
        Long seq = Sql.longOne(c, "SELECT seq FROM messages WHERE id = ?", messageId);
        if (seq == null) {
            // A message deleted on the desk, found again at the provider: the place stays, so it's never brought back.
            return;
        }
        relabel(c, f.accountId(), messageId, seq, labelsBefore);
        // A message the desk had (matched again after a move or a renumbering, or the same bytes in a second folder): the
        // provider's \Seen there now is its state, unless the member has a change owed.
        if (existing && !owed(c, messageId)) {
            Object[] m = Sql.one(c, "SELECT read, direction, channel_id, lane FROM messages WHERE seq = ?",
                    r -> new Object[] {r.getInt(1) == 1, r.getString(2), r.getString(3), r.getString(4)}, seq);
            if (m != null && "in".equals(m[1]) && (Boolean) m[0] != a.seen() && !Lanes.PENDING.equals(m[3])) {
                Sql.update(c, "UPDATE messages SET read = ? WHERE seq = ?", a.seen(), seq);
                if (m[2] != null) {
                    Graph.refresh(c, (String) m[2], (String) m[3]);
                    changes.lane((String) m[2], (String) m[3]);
                }
            }
        }
        transition(c, f.accountId(), messageId, seq, before, providerLane(c, f.accountId(), messageId), now, changes);
    }

    /** A flag or labels the provider changed for a UID the desk has. {@code labels} null: unchanged. */
    public record Change(long uid, boolean seen, String labels) {}

    /**
     * Applies the provider's changes to UIDs of a folder: {@code \Seen} to the message's read state and labels to its own,
     * unless the member has an op owed for it; with the folder's new state (its MODSEQ), in one transaction.
     *
     * @return how many messages changed on the desk
     */
    public int changed(Folder after, List<Change> list) throws SQLException {
        return store.write((c, changes) -> {
            int n = 0;
            Set<Graph.Pair> pairs = new LinkedHashSet<>();
            for (Change ch : list) {
                String messageId = Sql.stringOne(c, "SELECT message_id FROM linked_locations WHERE folder_id = ? AND uid = ?", after.id(), ch.uid());
                if (messageId == null) {
                    continue;
                }
                Set<String> labelsBefore = providerLabels(c, after.accountId(), messageId);
                if (ch.labels() != null) {
                    Sql.update(c, "UPDATE linked_locations SET seen = ?, labels = ? WHERE folder_id = ? AND uid = ?", ch.seen(),
                            Norm.line(ch.labels(), 2000), after.id(), ch.uid());
                } else {
                    Sql.update(c, "UPDATE linked_locations SET seen = ? WHERE folder_id = ? AND uid = ?", ch.seen(), after.id(), ch.uid());
                }
                Object[] m = Sql.one(c, "SELECT seq, read, direction, channel_id, lane FROM messages WHERE id = ?",
                        r -> new Object[] {r.getLong(1), r.getInt(2) == 1, r.getString(3), r.getString(4), r.getString(5)}, messageId);
                if (m == null || owed(c, messageId)) {
                    continue;
                }
                long seq = (Long) m[0];
                if (ch.labels() != null && relabel(c, after.accountId(), messageId, seq, labelsBefore)) {
                    pairs.add(new Graph.Pair((String) m[3], (String) m[4]));
                    n++;
                }
                if ("in".equals(m[2]) && (Boolean) m[1] != ch.seen() && !Lanes.PENDING.equals(m[4])) {
                    Sql.update(c, "UPDATE messages SET read = ? WHERE seq = ?", ch.seen(), seq);
                    pairs.add(new Graph.Pair((String) m[3], (String) m[4]));
                    n++;
                }
            }
            for (Graph.Pair p : pairs) {
                if (p.channelId() != null) {
                    Graph.refresh(c, p.channelId(), p.lane());
                    changes.lane(p.channelId(), p.lane());
                }
            }
            put(c, after);
            changes.accounts = true;
            return n;
        });
    }

    /**
     * UIDs gone from a folder (EXPUNGE, VANISHED, missing from a full listing): their places go, a message moved within the
     * provider follows its places' new lane, and one left with none is an orphan until {@link #settle}. With the folder's
     * new state, in one transaction.
     */
    public int vanished(Folder after, long[] uids) throws SQLException {
        long now = store.now();
        List<Long> list = new ArrayList<>(uids.length);
        for (long u : uids) {
            list.add(u);
        }
        return store.write((c, changes) -> {
            int n = drop(c, after, list, now, changes);
            put(c, after);
            changes.accounts = true;
            return n;
        });
    }

    /** Drops places, in the caller's transaction. */
    private int drop(Connection c, Folder f, List<Long> uids, long now, Courier.ChangeSet changes) throws SQLException {
        int n = 0;
        for (Long uid : uids) {
            Object[] row = Sql.one(c, "SELECT message_id, msgid, size, internal_at, gm_id FROM linked_locations WHERE folder_id = ? AND uid = ?",
                    r -> new Object[] {r.getString(1), r.getString(2), r.getLong(3), Sql.nullableLong(r, "internal_at"), r.getString(5)},
                    f.id(), uid);
            if (row == null) {
                continue;
            }
            String messageId = (String) row[0];
            String before = messageId == null ? null : providerLane(c, f.accountId(), messageId);
            Set<String> labelsBefore = messageId == null ? Set.of() : providerLabels(c, f.accountId(), messageId);
            Sql.update(c, "DELETE FROM linked_locations WHERE folder_id = ? AND uid = ?", f.id(), uid);
            n++;
            if (messageId == null) {
                continue;
            }
            String after = providerLane(c, f.accountId(), messageId);
            if (after == null) {
                // Its last place: kept as an orphan, a deleted one too, so where it turns up it's matched, not fetched.
                Sql.update(c, """
                        INSERT OR REPLACE INTO linked_orphans (account_id, message_id, msgid, size, internal_at, gm_id, since)
                        VALUES (?, ?, ?, ?, ?, ?, ?)""", f.accountId(), messageId, row[1], row[2], row[3], row[4], now);
                continue;
            }
            Long seq = Sql.longOne(c, "SELECT seq FROM messages WHERE id = ?", messageId);
            if (seq != null) {
                relabel(c, f.accountId(), messageId, seq, labelsBefore);
                transition(c, f.accountId(), messageId, seq, before, after, now, changes);
            }
        }
        return n;
    }

    /**
     * Orphans from before {@code before} that no pass since has found: gone at the provider. One in Trash on the desk is
     * deleted for good (the provider's Trash was emptied); any other goes to Trash on the desk, for its 30 days. A deleted
     * one's record just goes. Called after a whole pass of every folder that began after {@code before}.
     *
     * @return how many messages changed
     */
    public int settle(String accountId, long before) throws SQLException {
        long now = store.now();
        int[] purged = new int[1];
        int n = store.write((c, changes) -> {
            List<String> ids = Sql.list(c, "SELECT message_id FROM linked_orphans WHERE account_id = ? AND since < ?", r -> r.getString(1),
                    accountId, before);
            int moved = 0;
            List<Long> gone = new ArrayList<>();
            List<Long> toTrash = new ArrayList<>();
            for (String id : ids) {
                Sql.update(c, "DELETE FROM linked_orphans WHERE account_id = ? AND message_id = ?", accountId, id);
                if (owed(c, id)) {
                    continue;
                }
                Object[] m = Sql.one(c, "SELECT seq, lane FROM messages WHERE id = ?", r -> new Object[] {r.getLong(1), r.getString(2)}, id);
                if (m == null) {
                    continue;
                }
                if (Lanes.TRASH.equals(m[1])) {
                    gone.add((Long) m[0]);
                } else if (!Lanes.PENDING.equals(m[1])) {
                    toTrash.add((Long) m[0]);
                }
                moved++;
            }
            Graph.move(c, toTrash, Lanes.TRASH, now, changes);
            store.purge(c, gone, changes);
            purged[0] = gone.size();
            return moved;
        });
        if (purged[0] > 0) {
            store.forgetDeleted();
        }
        return n;
    }

    /** How many orphans an account has waiting: a pass's worth of moves still settling. */
    public long orphans(String accountId) throws SQLException {
        Long n = store.db().read(c -> Sql.longOne(c, "SELECT count(*) FROM linked_orphans WHERE account_id = ?", accountId));
        return n == null ? 0 : n;
    }

    // ---- what the provider's places mean on the desk

    /**
     * Where the provider keeps a message, as a lane: {@code normal} if any place is a folder of mail, else {@code spam} for
     * Junk, else {@code trash}; null with no place (or only drafts).
     */
    private static String providerLane(Connection c, String accountId, String messageId) throws SQLException {
        List<String> roles = Sql.list(c, """
                SELECT DISTINCT f.role FROM linked_locations l JOIN linked_folders f ON f.id = l.folder_id
                WHERE l.message_id = ? AND l.account_id = ?""", r -> r.getString(1), messageId, accountId);
        boolean junk = false;
        boolean trash = false;
        for (String r : roles) {
            switch (r) {
                case JUNK -> junk = true;
                case TRASH -> trash = true;
                case DRAFTS -> { }
                default -> {
                    return NORMAL;
                }
            }
        }
        return junk ? Lanes.SPAM : trash ? Lanes.TRASH : null;
    }

    /**
     * The desk follows a move at the provider: into Trash or Junk, the message goes to Trash or Spam; out of them, it comes
     * back where it was (as Restore does), a blocked sender's staying in Spam. Never while the member has an op owed for it.
     */
    private static void transition(Connection c, String accountId, String messageId, long seq, String before, String after, long now,
            Courier.ChangeSet changes) throws SQLException {
        if (after == null || after.equals(before) || owed(c, messageId)) {
            return;
        }
        String[] m = Sql.one(c, """
                SELECT m.lane, m.lane_before, e.standing, e.kind, e.value FROM messages m LEFT JOIN endpoints e ON e.id = m.from_endpoint
                WHERE m.seq = ?""", r -> new String[] {r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5)}, seq);
        if (m == null || Lanes.PENDING.equals(m[0])) {
            return;
        }
        String lane = m[0];
        switch (after) {
            case Lanes.TRASH -> {
                if (!Lanes.TRASH.equals(lane)) {
                    Graph.move(c, List.of(seq), Lanes.TRASH, now, changes);
                }
            }
            case Lanes.SPAM -> {
                if (!Lanes.SPAM.equals(lane)) {
                    Graph.move(c, List.of(seq), Lanes.SPAM, now, changes);
                }
            }
            default -> {
                boolean wasOut = Lanes.TRASH.equals(before) || Lanes.SPAM.equals(before);
                if (!wasOut || !(Lanes.TRASH.equals(lane) || Lanes.SPAM.equals(lane))) {
                    return;
                }
                boolean blocked = Lanes.BLOCKED.equals(m[2]) || (m[3] != null && Graph.blocked(c, m[3], m[4]));
                String target;
                if (blocked) {
                    target = Lanes.SPAM;
                } else {
                    target = m[1] != null && Lanes.valid(m[1]) && !Lanes.SPAM.equals(m[1]) && !Lanes.TRASH.equals(m[1]) ? m[1] : Lanes.PEOPLE;
                    if ((Lanes.REQUESTS.equals(target) || Lanes.OTHER.equals(target)) && Lanes.KNOWN.equals(m[2])) {
                        target = Lanes.PEOPLE;
                    }
                }
                if (!target.equals(lane)) {
                    Graph.move(c, List.of(seq), target, now, changes);
                }
            }
        }
    }

    /** The provider's labels for a message: the union over its places. */
    private static Set<String> providerLabels(Connection c, String accountId, String messageId) throws SQLException {
        Set<String> out = new LinkedHashSet<>();
        for (String l : Sql.list(c, "SELECT labels FROM linked_locations WHERE message_id = ? AND account_id = ? AND labels IS NOT NULL",
                r -> r.getString(1), messageId, accountId)) {
            for (String one : l.split("\n")) {
                if (!one.isBlank()) {
                    out.add(one);
                }
            }
        }
        return out;
    }

    /**
     * The message's labels follow its provider's: what it had less the provider's labels before, plus the provider's now.
     * Its own +address tags stay. @return whether they changed
     */
    private static boolean relabel(Connection c, String accountId, String messageId, long seq, Set<String> before) throws SQLException {
        Set<String> now = providerLabels(c, accountId, messageId);
        if (now.equals(before)) {
            return false;
        }
        String current = Sql.stringOne(c, "SELECT labels FROM messages WHERE seq = ?", seq);
        List<String> kept = new ArrayList<>();
        if (current != null) {
            for (String l : current.split("\n")) {
                if (!l.isBlank() && !before.contains(l)) {
                    kept.add(l);
                }
            }
        }
        String labels = Ingest.labels(new ArrayList<>(now), kept);
        if (java.util.Objects.equals(labels, current)) {
            return false;
        }
        Sql.update(c, "UPDATE messages SET labels = ? WHERE seq = ?", labels, seq);
        return true;
    }

    private static boolean owed(Connection c, String messageId) throws SQLException {
        return Sql.exists(c, "SELECT 1 FROM linked_ops WHERE message_id = ? LIMIT 1", messageId);
    }

    // ---- the member's changes, owed to the provider

    /**
     * Records the member's change to messages for their providers, in the member's own transaction: every message that came
     * through a linked mailbox, placed or not (one between a move and being found again is placed again later, and its op
     * waits for that). Called by {@link Actions}; the transport never writes an op.
     */
    void recordOps(Connection c, List<Long> seqs, String op, Courier.ChangeSet changes) throws SQLException {
        if (!OPS.contains(op) || seqs.isEmpty()) {
            return;
        }
        long now = store.now();
        int n = 0;
        for (Long seq : seqs) {
            n += Sql.update(c, """
                    INSERT INTO linked_ops (account_id, message_id, op, attempts, created_at)
                    SELECT m.account_id, m.id, ?, 0, ? FROM messages m JOIN accounts a ON a.id = m.account_id
                    WHERE m.seq = ? AND a.kind = 'imap'""", op, now, seq);
        }
        if (n > 0) {
            opsWritten.set(true);
            changes.counts = true;
        }
    }

    /** Where a message is, for applying an op: each folder and UID, the folder's role and the place's {@code \Seen}. */
    public record Where(long folderId, String folder, String role, long uidValidity, long uid, boolean seen) {}

    /** An op owed to a provider, in the order the member made them. */
    public record Op(long seq, String messageId, String op, int attempts, List<Where> where) {}

    /** The account's oldest owed ops, up to {@code max}, each with where its message is. */
    public List<Op> ops(String accountId, int max) throws SQLException {
        return store.db().read(c -> {
            List<Object[]> rows = Sql.list(c, "SELECT seq, message_id, op, attempts FROM linked_ops WHERE account_id = ? ORDER BY seq LIMIT ?",
                    r -> new Object[] {r.getLong(1), r.getString(2), r.getString(3), r.getInt(4)}, accountId, max);
            List<Op> out = new ArrayList<>(rows.size());
            for (Object[] r : rows) {
                List<Where> where = Sql.list(c, """
                        SELECT f.id, f.name, f.role, f.uid_validity, l.uid, l.seen FROM linked_locations l
                        JOIN linked_folders f ON f.id = l.folder_id WHERE l.message_id = ? AND l.account_id = ? ORDER BY f.id, l.uid""",
                        x -> new Where(x.getLong(1), x.getString(2), x.getString(3), x.getLong(4), x.getLong(5), x.getInt(6) == 1), r[1],
                        accountId);
                out.add(new Op((Long) r[0], (String) r[1], (String) r[2], (Integer) r[3], where));
            }
            return out;
        });
    }

    /** Whether a message lost its places and may still be found again: an op for it waits rather than doing nothing. */
    public boolean orphan(String accountId, String messageId) throws SQLException {
        return store.db().read(c -> Sql.exists(c, "SELECT 1 FROM linked_orphans WHERE account_id = ? AND message_id = ?", accountId, messageId));
    }

    public boolean hasOps(String accountId) throws SQLException {
        return store.db().read(c -> Sql.exists(c, "SELECT 1 FROM linked_ops WHERE account_id = ? LIMIT 1", accountId));
    }

    /** An op the provider took (or that has nothing left to do): gone. */
    public void opDone(long seq) throws SQLException {
        store.db().transaction(c -> Sql.update(c, "DELETE FROM linked_ops WHERE seq = ?", seq));
    }

    /** An op that failed: tried again later, and dropped after {@value #OP_TRIES} tries. @return whether it's kept */
    public boolean opFailed(long seq) throws SQLException {
        return store.db().transaction(c -> {
            Sql.update(c, "UPDATE linked_ops SET attempts = attempts + 1 WHERE seq = ?", seq);
            Long a = Sql.longOne(c, "SELECT attempts FROM linked_ops WHERE seq = ?", seq);
            if (a != null && a >= OP_TRIES) {
                Sql.update(c, "DELETE FROM linked_ops WHERE seq = ?", seq);
                return false;
            }
            return a != null;
        });
    }

    /** The provider now has a place's {@code \Seen} as the transport set it. */
    public void seen(long folderId, long uid, boolean seen) throws SQLException {
        store.db().transaction(c -> Sql.update(c, "UPDATE linked_locations SET seen = ? WHERE folder_id = ? AND uid = ?", seen, folderId, uid));
    }

    /**
     * The transport moved a message (MOVE, with UIDPLUS's COPYUID): its place is now {@code toUid} in {@code to}. Without
     * the new UID ({@code toUid} 0) the old place just goes, and the message is matched where it turns up.
     */
    public void moved(long fromFolderId, long fromUid, Folder to, long toUid) throws SQLException {
        moved(fromFolderId, fromUid, to, toUid, to == null ? 0 : to.uidValidity());
    }

    /**
     * As {@link #moved(long, long, Folder, long)}, with the UIDVALIDITY the server's COPYUID named: a new UID under another
     * numbering than the desk has for {@code to} isn't recorded (the folder was renumbered meanwhile; its sync matches it).
     */
    public void moved(long fromFolderId, long fromUid, Folder to, long toUid, long toValidity) throws SQLException {
        if (to != null && toValidity != to.uidValidity()) {
            toUid = 0;
        }
        long newUid = toUid;
        long now = store.now();
        store.write((c, changes) -> {
            Object[] row = Sql.one(c, """
                    SELECT account_id, message_id, seen, labels, size, internal_at, msgid, gm_id FROM linked_locations WHERE folder_id = ? AND uid = ?""",
                    r -> new Object[] {r.getString(1), r.getString(2), r.getInt(3) == 1, r.getString(4), r.getLong(5),
                            Sql.nullableLong(r, "internal_at"), r.getString(7), r.getString(8)}, fromFolderId, fromUid);
            if (row == null) {
                return null;
            }
            if (to != null && newUid > 0) {
                Sql.update(c, """
                        INSERT OR REPLACE INTO linked_locations (folder_id, uid, account_id, message_id, seen, labels, size, internal_at, msgid, gm_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", to.id(), newUid, row[0], row[1], row[2], TRASH.equals(to.role())
                        || JUNK.equals(to.role()) ? null : row[3], row[4], row[5], row[6], row[7]);
            }
            Folder from = Sql.one(c, "SELECT " + FOLDER_COLS + " FROM linked_folders WHERE id = ?", LinkedState::folder, fromFolderId);
            if (from != null) {
                drop(c, from, List.of(fromUid), now, changes);
            }
            return null;
        });
    }

    /** The transport deleted a UID at the provider for good (Delete forever, from Trash): its place goes, no orphan. */
    public void expunged(long folderId, long uid) throws SQLException {
        store.db().transaction(c -> Sql.update(c, "DELETE FROM linked_locations WHERE folder_id = ? AND uid = ?", folderId, uid));
    }

    /** Everything of an account's, in the caller's transaction (removing the account). */
    static void forgetAccount(Connection c, String accountId) throws SQLException {
        Sql.update(c, "DELETE FROM linked_locations WHERE account_id = ?", accountId);
        Sql.update(c, "DELETE FROM linked_folders WHERE account_id = ?", accountId);
        Sql.update(c, "DELETE FROM linked_orphans WHERE account_id = ?", accountId);
        Sql.update(c, "DELETE FROM linked_ops WHERE account_id = ?", accountId);
    }

    /** For the account's status: messages it has places for, and the oldest date the first sync has reached. */
    public record Progress(long messages, Long oldestAt, boolean backfilled, long opsOwed) {}

    public Progress progress(String accountId) throws SQLException {
        return store.db().read(c -> {
            Long n = Sql.longOne(c, "SELECT count(DISTINCT message_id) FROM linked_locations WHERE account_id = ? AND message_id IS NOT NULL", accountId);
            Long oldest = Sql.longOne(c, "SELECT min(oldest_at) FROM linked_folders WHERE account_id = ?", accountId);
            boolean done = !Sql.exists(c, "SELECT 1 FROM linked_folders WHERE account_id = ? AND backfilled = 0 AND role <> 'drafts'", accountId);
            Long ops = Sql.longOne(c, "SELECT count(*) FROM linked_ops WHERE account_id = ?", accountId);
            return new Progress(n == null ? 0 : n, oldest, done, ops == null ? 0 : ops);
        });
    }
}
