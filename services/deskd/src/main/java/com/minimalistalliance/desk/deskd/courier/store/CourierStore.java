package com.minimalistalliance.desk.deskd.courier.store;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.sqlite.SqliteDatabase;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Courier's store on the desk: {@code /data/courier/courier.db} and {@code /data/courier/blobs} (draft ADR "Courier's
 * store"). It is the one idempotent sink every transport hands messages to ({@link #accept}), and what {@code courier.*}
 * and the agent read tools read.
 *
 * <p>Writes go through one platform thread (SQLite is JNI), reads through two readers that see the last commit. A
 * transport commits its cursor with the messages it brought ({@link #accept(List, Courier.CursorUpdate)}), so it
 * acknowledges its source only for what is on disk, and a message that comes again is stored once.
 */
public final class CourierStore implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(CourierStore.class);
    private static final Pattern ACCOUNT_ID = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final int GC_BATCH = 500;

    /** Retention (plan §2.9) and the queue's timings. */
    public record Settings(Duration trashKeep, Duration requestsKeep, Duration undo, Duration giveUp, int readers) {
        public static final Settings DEFAULT =
                new Settings(Duration.ofDays(30), Duration.ofDays(90), Duration.ofSeconds(10), Duration.ofDays(4), 2);
    }

    private final Path root;
    private final SqliteDatabase db;
    private final BlobStore blobs;
    private final CourierParser parser;
    private final Clock clock;
    private final Settings settings;
    private final Ulid ids = new Ulid();
    private final Ingest ingest;
    private final SpamFilter filter;
    private volatile java.util.function.BooleanSupplier filterOn = () -> true;
    private final List<Courier.ChangeListener> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    /** A checkpoint after a delete for good that a reader kept from emptying the WAL: the next sweep retries it. */
    private volatile boolean checkpointOwed;
    final Queries queries;
    final Actions actions;
    final Links links;
    final Outbox outbox;
    final LinkedState linked;
    final RelayState relay;
    final ImessageState imessage;

    private CourierStore(Path root, SqliteDatabase db, BlobStore blobs, CourierParser parser, Clock clock, Settings settings,
            long lastReceived) {
        this.root = root;
        this.db = db;
        this.blobs = blobs;
        this.parser = parser;
        this.clock = clock;
        this.settings = settings;
        this.filter = new SpamFilter(() -> filterOn.getAsBoolean());
        this.ingest = new Ingest(ids, lastReceived, filter);
        this.queries = new Queries(this);
        this.actions = new Actions(this);
        this.links = new Links(this);
        this.outbox = new Outbox(this);
        this.linked = new LinkedState(this);
        this.relay = new RelayState(this);
        this.imessage = new ImessageState(this);
    }

    /**
     * Opens or creates the store under {@code root} (made {@code 0700} if missing), migrates its schema, and finishes what
     * a crash left: staged blobs placed or removed, blobs owed to the purge removed, sends that were going out put back in
     * the queue.
     *
     * @throws IOException if the directory can't be used
     * @throws SQLException if the database can't be opened or its schema is newer than this build's
     */
    public static CourierStore open(Path root, CourierParser parser, Clock clock, Settings settings) throws IOException, SQLException {
        if (Files.isSymbolicLink(root)) {
            throw new IOException("the store's directory is a link");
        }
        BlobStore.createDir(root);
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) || !Files.isWritable(root)) {
            throw new IOException("the store's directory can't be written");
        }
        SqliteDatabase db = SqliteDatabase.open("courier", root.resolve("courier.db"), Schema.STEPS,
                new SqliteDatabase.Options(settings.readers(), 4096, 2048));
        try {
            BlobStore blobs = new BlobStore(root.resolve("blobs"));
            blobs.recover(sha -> {
                try {
                    return db.call(c -> Sql.exists(c, "SELECT 1 FROM messages WHERE blob = ?", sha));
                } catch (SQLException e) {
                    // Unsure: keep it, it's placed and named or swept next time.
                    return true;
                }
            });
            Long last = db.call(c -> Sql.longOne(c, "SELECT max(received_at) FROM messages"));
            String newest = db.call(c -> Sql.stringOne(c, "SELECT max(id) FROM messages"));
            // A millisecond past the last receive time: nothing stored from now on shares one with what was before, so the
            // agent cursor's (received_at, id) order holds across a restart whatever the clock says.
            CourierStore store = new CourierStore(root, db, blobs, parser, clock, settings, last == null ? 0 : last + 1);
            if (newest != null) {
                store.ids.seed(newest);
            }
            store.collectBlobs();
            store.outbox.recover();
            return store;
        } catch (IOException | SQLException | RuntimeException e) {
            db.close();
            throw e;
        }
    }

    // ---- what the other parts share

    SqliteDatabase db() {
        return db;
    }

    BlobStore blobs() {
        return blobs;
    }

    Ulid ids() {
        return ids;
    }

    Clock clock() {
        return clock;
    }

    Settings settings() {
        return settings;
    }

    long now() {
        return clock.millis();
    }

    Path root() {
        return root;
    }

    /** Where a download's bytes are staged, unlinked, for its transfer's life ({@code parts/}, plan §2.3). */
    public Path partsDir() {
        return root.resolve("parts");
    }

    public Queries queries() {
        return queries;
    }

    public Actions actions() {
        return actions;
    }

    /** One person across channels: links, unlinks, "not them" and suggestions (flow 11). */
    public Links links() {
        return links;
    }

    public Outbox outbox() {
        return outbox;
    }

    /** The learning filter (Wave 3.2), which the member's actions teach and which judges strangers' mail as it arrives. */
    SpamFilter filter() {
        return filter;
    }

    /** The learning filter's kill switch ({@code filter-off} in {@code courier-switch}): off, it judges nothing and learns on. */
    public void filterSwitch(java.util.function.BooleanSupplier on) {
        this.filterOn = on == null ? () -> true : on;
    }

    /** A spam report owed to the platform's suppression list: the sender of mail to this desk's own address. */
    public record Report(String id, String accountId, String address, long createdAt) {}

    /**
     * Reports the mail door's transport owes the platform (Wave 2.5's seam), oldest first. A report holds the sender's
     * address only; the message itself never goes.
     */
    public List<Report> owedReports(int limit) throws SQLException {
        return db.read(c -> Sql.list(c, "SELECT id, account_id, address, created_at FROM reports WHERE state = 'owed' ORDER BY created_at LIMIT ?",
                r -> new Report(r.getString(1), r.getString(2), r.getString(3), r.getLong(4)), Math.max(1, Math.min(500, limit))));
    }

    /** The transport delivered a report: it's kept as sent for 30 days, then the sweep drops it. */
    public void reportDelivered(String reportId) throws SQLException {
        write((c, changes) -> Sql.update(c, "UPDATE reports SET state = 'sent', updated_at = ? WHERE id = ?", now(), reportId));
    }

    /** Linked mailboxes' places at their providers, and the member's changes owed to them (Wave 2.1). */
    public LinkedState linked() {
        return linked;
    }

    /** The relay's transports' pins, held messages and envelope tombstones (Wave 2.5). */
    public RelayState relay() {
        return relay;
    }

    /** The iMessage transport's chats, sent guids and the Mac's contact cards (Wave 2.6). */
    public ImessageState imessage() {
        return imessage;
    }

    public void onChange(Courier.ChangeListener listener) {
        listeners.add(listener);
    }

    void publish(Courier.ChangeSet changes) {
        Courier.Change change = changes.done();
        if (change.empty()) {
            return;
        }
        for (Courier.ChangeListener l : listeners) {
            try {
                l.changed(change);
            } catch (RuntimeException e) {
                log.warn("courier change listener failed: {}", e.getClass().getSimpleName());
            }
        }
    }

    /** Runs member work in one transaction and tells the listeners what changed. */
    <T> T write(Work<T> work) throws SQLException {
        Courier.ChangeSet changes = new Courier.ChangeSet();
        T result = db.transaction(c -> {
            T r = work.run(c, changes);
            ingest.restamp(c, changes.surfaced, now());
            return r;
        });
        publish(changes);
        return result;
    }

    @FunctionalInterface
    interface Work<T> {
        T run(Connection c, Courier.ChangeSet changes) throws SQLException;
    }

    // ---- the sink

    /** One message: {@link #accept(List, Courier.CursorUpdate)} with no cursor. */
    public Courier.Accepted accept(Courier.Inbound in) throws SQLException, IOException, InterruptedException {
        return accept(List.of(in), null).get(0);
    }

    /**
     * Stores a batch, idempotently, and the transport's cursor with it, in one transaction: either all of it is on disk
     * when this returns, or nothing is (an exception), and the transport keeps its place. Duplicates are found before any
     * parse. An email whose parser can't be reached is kept as {@code PENDING}, with its raw bytes.
     *
     * @return one answer per message, in order
     * @throws SQLException or IOException if the store couldn't write (a full disk, say): nothing was kept, and the cursor
     *     didn't move
     */
    public List<Courier.Accepted> accept(List<Courier.Inbound> batch, Courier.CursorUpdate cursor)
            throws SQLException, IOException, InterruptedException {
        return accept(batch, cursor, null);
    }

    /**
     * Work a transport does in the sink's own transaction, after the batch is stored: a linked mailbox records where each
     * message sits at its provider ({@link LinkedState}), so the place and the message commit together or not at all.
     * {@code answers} has one per message of the batch, in order, duplicates found before the transaction included.
     */
    @FunctionalInterface
    interface Sidecar {
        void run(Connection c, List<Courier.Accepted> answers, Courier.ChangeSet changes) throws SQLException;
    }

    List<Courier.Accepted> accept(List<Courier.Inbound> batch, Courier.CursorUpdate cursor, Sidecar sidecar)
            throws SQLException, IOException, InterruptedException {
        List<Courier.Accepted> answers = new ArrayList<>(batch.size());
        List<Ingest.Prepared> prepared = new ArrayList<>(batch.size());
        List<Integer> slots = new ArrayList<>(batch.size());
        // Duplicates first, on a reader, so a re-sync parses nothing it already has.
        List<String> known = db.read(c -> {
            List<String> out = new ArrayList<>(batch.size());
            for (Courier.Inbound in : batch) {
                out.add(in == null || !Accounts.MEDIA.contains(in.medium()) || !ExternalIds.valid(in.externalId()) ? null
                        : Sql.stringOne(c, "SELECT id FROM messages WHERE medium = ? AND external_id = ?", in.medium(), in.externalId()));
            }
            return out;
        });
        Set<String> staged = new LinkedHashSet<>();
        try {
            for (int i = 0; i < batch.size(); i++) {
                Courier.Inbound in = batch.get(i);
                String refusal = refusal(in);
                if (refusal != null) {
                    answers.add(Courier.Accepted.refused(refusal));
                    continue;
                }
                if (known.get(i) != null) {
                    answers.add(Courier.Accepted.duplicate(known.get(i)));
                    continue;
                }
                answers.add(null);
                Ingest.Prepared p = prepare(in, staged);
                prepared.add(p);
                slots.add(i);
            }
            if (prepared.isEmpty() && cursor == null && sidecar == null) {
                return answers;
            }
            Courier.ChangeSet changes = new Courier.ChangeSet();
            List<Courier.Accepted> stored = db.transaction(c -> {
                List<Courier.Accepted> out = new ArrayList<>(prepared.size());
                long now = now();
                for (Ingest.Prepared p : prepared) {
                    out.add(ingest.store(c, p, now, changes));
                }
                if (cursor != null) {
                    putCursor(c, cursor, now);
                }
                if (sidecar != null) {
                    List<Courier.Accepted> all = new ArrayList<>(answers);
                    for (int k = 0; k < out.size(); k++) {
                        all.set(slots.get(k), out.get(k));
                    }
                    sidecar.run(c, all, changes);
                }
                ingest.restamp(c, changes.surfaced, now);
                return out;
            });
            for (int k = 0; k < stored.size(); k++) {
                answers.set(slots.get(k), stored.get(k));
            }
            publish(changes);
            return answers;
        } finally {
            place(staged);
        }
    }

    private static String refusal(Courier.Inbound in) {
        if (in == null || !Accounts.MEDIA.contains(in.medium())) {
            return "medium";
        }
        if (!ExternalIds.valid(in.externalId())) {
            return "external_id";
        }
        if (in.accountId() == null || !ACCOUNT_ID.matcher(in.accountId()).matches()) {
            return "account";
        }
        if ("email".equals(in.medium()) && in.raw() == null && in.parsed() == null) {
            return "content";
        }
        if (!"email".equals(in.medium()) && in.parsed() == null) {
            return "content";
        }
        return null;
    }

    /** Parses and stages one message, off the writer's thread. */
    private Ingest.Prepared prepare(Courier.Inbound in, Set<String> staged) throws IOException, InterruptedException {
        byte[] raw = in.raw();
        if (raw == null) {
            return Ingest.Prepared.of(in, in.parsed(), "ok", null, null, 0);
        }
        if (raw.length > BlobStore.MAX_RAW) {
            // Not kept: too large to read safely, and the source still has it.
            return Ingest.Prepared.of(in, in.parsed(), "refused", "too_large", null, raw.length);
        }
        ParsedMessage parsed = in.parsed();
        String state = "ok";
        String reason = null;
        byte[] small = BlobStore.compressSmall(raw, BlobStore.INLINE_MAX);
        if (parsed == null) {
            try {
                CourierParser.Result result = parser.parse(raw);
                if (result instanceof CourierParser.Parsed ok) {
                    parsed = ok.message();
                } else if (result instanceof CourierParser.Refused refused) {
                    state = "refused";
                    reason = Norm.line(refused.reason(), 32);
                }
            } catch (CourierParser.Unavailable e) {
                state = "pending";
            }
        }
        if (small != null) {
            return Ingest.Prepared.of(in, parsed, state, reason, BlobStore.sha256(raw), raw.length).withInline(small);
        }
        String sha = blobs.stage(raw);
        staged.add(sha);
        return Ingest.Prepared.of(in, parsed, state, reason, sha, raw.length);
    }

    /** A blob's raw bytes, from the database or its file; null if there's none or it doesn't match its hash. */
    byte[] readBlob(String sha) throws SQLException, IOException {
        if (sha == null) {
            return null;
        }
        byte[] gz = db.read(c -> Sql.one(c, "SELECT data FROM blob_data WHERE sha = ?", r -> r.getBytes(1), sha));
        return gz != null ? BlobStore.decompress(gz, sha) : blobs.read(sha);
    }

    /** After the commit, on the writer's thread: each staged blob placed if a row names it, dropped if none does. */
    private void place(Set<String> shas) {
        if (shas.isEmpty()) {
            return;
        }
        try {
            db.call(c -> {
                for (String sha : shas) {
                    try {
                        blobs.place(sha, Sql.exists(c, "SELECT 1 FROM messages WHERE blob = ?", sha));
                    } catch (IOException e) {
                        // Left staged: the next open places or removes it.
                        log.warn("courier blob placement failed: {}", e.getClass().getSimpleName());
                    }
                }
                return null;
            });
        } catch (SQLException e) {
            log.warn("courier blob placement failed: {}", e.getClass().getSimpleName());
        } finally {
            for (String sha : shas) {
                blobs.release(sha);
            }
        }
    }

    /**
     * Reads emails that waited for the parser, oldest first, up to {@code max}. Each gets a new id and receive time as it
     * joins its lane, so an agent cursor that moved on while it waited out of every list still sees it. While the parser
     * still can't be reached, the rest wait.
     *
     * @return how many were read (refusals included)
     */
    public int reparsePending(int max) throws SQLException, IOException, InterruptedException {
        record Waiting(long seq, String id, String medium, String externalId, String accountId, String blob, long received,
                Long sentAt, boolean read, boolean outgoing, String origin, String labels, String auth) {}
        List<Waiting> waiting = db.read(c -> Sql.list(c, """
                SELECT seq, id, medium, external_id, account_id, blob, received_at, sent_at, read, direction, origin, labels, auth
                FROM messages WHERE lane = 'pending' ORDER BY seq LIMIT ?""",
                r -> new Waiting(r.getLong(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6),
                        r.getLong(7), Sql.nullableLong(r, "sent_at"), r.getInt(9) == 1, "out".equals(r.getString(10)),
                        r.getString(11), r.getString(12), r.getString(13)), max));
        int done = 0;
        for (Waiting w : waiting) {
            byte[] raw = readBlob(w.blob());
            CourierParser.Result result;
            if (raw == null) {
                result = new CourierParser.Refused("blob");
            } else {
                try {
                    result = parser.parse(raw);
                } catch (CourierParser.Unavailable e) {
                    break;
                }
            }
            Courier.Origin origin = "backfill".equals(w.origin()) ? Courier.Origin.BACKFILL
                    : "catchup".equals(w.origin()) ? Courier.Origin.CATCHUP : Courier.Origin.LIVE;
            Courier.Verdicts verdicts = Courier.Verdicts.NONE;
            if (w.auth() != null) {
                try {
                    // As the transport gave them, the provider's authserv-id and the DMARC domain included: resolved now
                    // that the message is read (Courier.Verdicts.resolve).
                    verdicts = Courier.Verdicts.fromWire(com.minimalistalliance.desk.deskd.protocol.Json.parseObject(
                            w.auth().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                } catch (com.minimalistalliance.desk.deskd.protocol.JsonFormatException | ClassCastException e) {
                    verdicts = Courier.Verdicts.NONE;
                }
            }
            Courier.Inbound in = new Courier.Inbound(w.accountId(), w.medium(), w.externalId(), origin, null, null, verdicts,
                    w.read(), w.outgoing(), w.labels() == null ? List.of() : List.of(w.labels().split("\n")), w.sentAt());
            String state = result instanceof CourierParser.Parsed ? "ok" : "refused";
            String reason = result instanceof CourierParser.Refused r ? Norm.line(r.reason(), 32) : null;
            ParsedMessage parsed = result instanceof CourierParser.Parsed ok ? ok.message() : null;
            // A new id and receive time: the agent cursor may have passed the old ones while it waited out of every list.
            Ingest.Prepared p = Ingest.Prepared.of(in, parsed, state, reason, w.blob(), raw == null ? 0 : raw.length);
            Courier.ChangeSet changes = new Courier.ChangeSet();
            db.transaction(c -> {
                // Still waiting? Another reparse may have read it meanwhile.
                if (!Sql.exists(c, "SELECT 1 FROM messages WHERE seq = ? AND lane = 'pending'", w.seq())) {
                    return null;
                }
                Sql.update(c, "DELETE FROM messages WHERE seq = ?", w.seq());
                ingest.store(c, p, now(), changes);
                ingest.restamp(c, changes.surfaced, now());
                return null;
            });
            publish(changes);
            done++;
        }
        return done;
    }

    /**
     * A message's raw bytes as they came, checked against their hash: for the member's raw download and the export. Null
     * if it has none (a chat message, a stub too large to keep) or the message doesn't exist.
     */
    public byte[] raw(String messageId) throws SQLException, IOException {
        String sha = db.read(c -> Sql.stringOne(c, "SELECT blob FROM messages WHERE id = ?", messageId));
        return readBlob(sha);
    }

    // ---- accounts and cursors

    /**
     * Adds or updates an account, and its own addresses (the member's, for telling in from out). The row is the vault's
     * commit point: a sign-in is sealed to {@code keys/<id>.sealed} first, then this is written (plan §3.6).
     */
    public void putAccount(Courier.Account account, List<String[]> ownAddresses) throws SQLException {
        if (account == null || !ACCOUNT_ID.matcher(account.id()).matches() || !Accounts.KINDS.contains(account.kind())) {
            throw new IllegalArgumentException("account");
        }
        String label = Norm.line(account.label(), 80);
        write((c, changes) -> {
            long now = now();
            Sql.update(c, """
                    INSERT INTO accounts (id, kind, label, address, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET label = excluded.label, address = excluded.address, state = excluded.state,
                      updated_at = excluded.updated_at""",
                    account.id(), account.kind(), label == null ? account.kind() : label, Norm.line(account.address(), Norm.MAX_ADDRESS),
                    account.state() == null ? "ok" : account.state(), now, now);
            Sql.update(c, "DELETE FROM own_addresses WHERE account_id = ?", account.id());
            for (String[] own : ownAddresses) {
                String value = Norm.endpoint(own[0], own[1]);
                if (value != null) {
                    Sql.update(c, "INSERT OR REPLACE INTO own_addresses (kind, value, account_id) VALUES (?, ?, ?)", own[0], value, account.id());
                }
            }
            changes.accounts = true;
            return null;
        });
    }

    /**
     * Removes an account and its cursors. With {@code keepMail} false its messages go too, for good (plan §2.9: "then asks
     * whether to keep the mail already on the desk"); kept, they stay where they are.
     *
     * @return whether there was such an account
     */
    public boolean removeAccount(String accountId, boolean keepMail) throws SQLException {
        boolean had = write((c, changes) -> {
            boolean was = Sql.update(c, "DELETE FROM accounts WHERE id = ?", accountId) > 0;
            Sql.update(c, "DELETE FROM cursors WHERE account_id = ?", accountId);
            LinkedState.forgetAccount(c, accountId);
            ImessageState.forgetAccount(c, accountId);
            if (!keepMail) {
                List<Long> seqs = Sql.list(c, "SELECT seq FROM messages WHERE account_id = ?", r -> r.getLong(1), accountId);
                purge(c, seqs, changes);
            }
            changes.accounts = true;
            return was;
        });
        forgetDeleted();
        return had;
    }

    public List<Courier.Account> accounts() throws SQLException {
        return db.read(c -> Sql.list(c, "SELECT id, kind, label, address, state FROM accounts ORDER BY created_at, id",
                r -> new Courier.Account(r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5))));
    }

    /** A transport's last committed place, or null. */
    public String cursor(String accountId, String stream) throws SQLException {
        return db.read(c -> Sql.stringOne(c, "SELECT value FROM cursors WHERE account_id = ? AND stream = ?", accountId, stream));
    }

    private static void putCursor(Connection c, Courier.CursorUpdate cursor, long now) throws SQLException {
        if (cursor.value() == null || cursor.value().length() > 4096 || cursor.stream() == null || cursor.stream().length() > 128) {
            throw new SQLException("cursor");
        }
        Sql.update(c, """
                INSERT INTO cursors (account_id, stream, value, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (account_id, stream) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
                cursor.accountId(), cursor.stream(), cursor.value(), now);
    }

    // ---- deleting for good

    /**
     * Deletes messages for good, inside the caller's transaction: their rows, index rows, recipients, refs and attachments
     * (cascades and the FTS trigger), lanes counted again, empty threads gone, and each blob nothing names any more owed to
     * the collector, which removes it after the commit.
     */
    void purge(Connection c, List<Long> seqs, Courier.ChangeSet changes) throws SQLException {
        if (seqs.isEmpty()) {
            return;
        }
        Set<Graph.Pair> pairs = new LinkedHashSet<>();
        Set<String> shas = new LinkedHashSet<>();
        Set<String> threads = new LinkedHashSet<>();
        for (int from = 0; from < seqs.size(); from += GC_BATCH) {
            List<Long> part = seqs.subList(from, Math.min(seqs.size(), from + GC_BATCH));
            String in = Sql.marks(part.size());
            Object[] args = part.toArray();
            Sql.list(c, "SELECT channel_id, lane, blob, thread_id FROM messages WHERE seq IN (" + in + ")", r -> {
                pairs.add(new Graph.Pair(r.getString(1), r.getString(2)));
                if (r.getString(3) != null) {
                    shas.add(r.getString(3));
                }
                if (r.getString(4) != null) {
                    threads.add(r.getString(4));
                }
                return null;
            }, args);
            Sql.update(c, "DELETE FROM messages WHERE seq IN (" + in + ")", args);
        }
        for (String sha : shas) {
            if (!Sql.exists(c, "SELECT 1 FROM messages WHERE blob = ?", sha)) {
                Sql.update(c, "INSERT OR IGNORE INTO blob_gc (sha) VALUES (?)", sha);
            }
        }
        for (String t : threads) {
            if (!Sql.exists(c, "SELECT 1 FROM messages WHERE thread_id = ?", t)) {
                Sql.update(c, "DELETE FROM threads WHERE id = ?", t);
            }
        }
        for (Graph.Pair p : pairs) {
            Graph.refresh(c, p.channelId(), p.lane());
            changes.lane(p.channelId(), p.lane());
        }
    }

    /**
     * Removes the blobs owed to the collector, on the writer's thread, so no placement can race it. A blob a write in flight
     * may name is left for next time.
     *
     * @return how many were removed
     */
    int collectBlobs() throws SQLException {
        return db.call(c -> {
            int removed = 0;
            List<String> owed = Sql.list(c, "SELECT sha FROM blob_gc LIMIT 10000", r -> r.getString(1));
            for (String sha : owed) {
                if (blobs.inFlight(sha)) {
                    continue;
                }
                if (!Sql.exists(c, "SELECT 1 FROM messages WHERE blob = ?", sha)) {
                    try {
                        Sql.update(c, "DELETE FROM blob_data WHERE sha = ?", sha);
                        blobs.delete(sha);
                        removed++;
                    } catch (IOException e) {
                        log.warn("courier blob removal failed: {}", e.getClass().getSimpleName());
                        continue;
                    }
                }
                Sql.update(c, "DELETE FROM blob_gc WHERE sha = ?", sha);
            }
            return removed;
        });
    }

    /**
     * Retention (plan §2.9): Trash and Spam after 30 days there, Requests nobody answered after 90, finished sends' queue
     * rows after 7 days; then the blobs, and a checkpoint so nothing deleted stays in the WAL.
     *
     * @return how many messages were deleted
     */
    public int sweep() throws SQLException {
        long now = now();
        long trashBefore = now - settings.trashKeep().toMillis();
        long requestsBefore = now - settings.requestsKeep().toMillis();
        int total = 0;
        while (true) {
            int n = write((c, changes) -> {
                List<Long> seqs = Sql.list(c, """
                        SELECT seq FROM messages WHERE (lane IN ('trash', 'spam') AND lane_at < ?) OR (lane = 'requests' AND lane_at < ?)
                        LIMIT ?""", r -> r.getLong(1), trashBefore, requestsBefore, GC_BATCH);
                purge(c, seqs, changes);
                return seqs.size();
            });
            total += n;
            if (n < GC_BATCH) {
                break;
            }
        }
        write((c, changes) -> {
            int gone = Sql.update(c, "DELETE FROM outbound WHERE state IN ('sent', 'failed') AND updated_at < ?", now - Duration.ofDays(7).toMillis());
            changes.outbound |= gone > 0;
            return null;
        });
        write((c, changes) -> {
            filter.prune(c);
            // Reports the door delivered, after 30 days; ones still owed stay until it can.
            Sql.update(c, "DELETE FROM reports WHERE state = 'sent' AND updated_at < ?", now - Duration.ofDays(30).toMillis());
            return null;
        });
        relay.sweep(now);
        int removed = collectBlobs();
        if (total > 0 || removed > 0 || checkpointOwed) {
            checkpointOwed = !db.checkpoint();
        }
        return total;
    }

    /**
     * After a delete for good (draft ADR §13; Security CS-L1): the blobs nothing names, then a checkpoint that empties the
     * WAL, so no older copy of a deleted page stays in it. A reader holding part of the WAL leaves the checkpoint owed, and
     * the next sweep tries again.
     */
    void forgetDeleted() throws SQLException {
        collectBlobs();
        checkpointOwed = !db.checkpoint();
    }

    /**
     * The store's size as a cap would count it: the database and its WAL, and each kept raw message at its full size (the
     * blobs are smaller, compressed). From the totals the triggers keep, so it's one row for every {@code courier.status}.
     */
    public long bytes() throws SQLException {
        long total = 0;
        for (String f : new String[] {"courier.db", "courier.db-wal"}) {
            try {
                total += Files.size(root.resolve(f));
            } catch (IOException e) {
                // not there
            }
        }
        Long raw = db.read(c -> Sql.longOne(c, "SELECT raw_bytes FROM totals WHERE id = 1"));
        return total + (raw == null ? 0 : raw);
    }

    /** Bytes the store holds on the drive: the database and its WAL, and the blob files. Walks the files: for tests. */
    public long bytesOnDisk() {
        long total = 0;
        for (String f : new String[] {"courier.db", "courier.db-wal"}) {
            try {
                total += Files.size(root.resolve(f));
            } catch (IOException e) {
                // not there
            }
        }
        try {
            total += blobs.bytesOnDisk();
        } catch (IOException e) {
            // a partial count
        }
        return total;
    }

    /** The database's own checks, for tests and the crash rig: SQLite's integrity check and FTS5's. */
    public List<String> integrity() throws SQLException {
        return db.call(c -> {
            List<String> out = new ArrayList<>(Sql.list(c, "PRAGMA integrity_check", r -> r.getString(1)));
            try {
                Sql.update(c, "INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
            } catch (SQLException e) {
                out.add("fts: " + e.getMessage());
            }
            return out;
        });
    }

    @Override
    public void close() {
        outbox.close();
        db.close();
    }
}
