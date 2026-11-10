package com.minimalistalliance.desk.agent.audit;

import com.minimalistalliance.desk.agent.sqlite.SqliteDatabase;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The append-only, hash-chained audit log of design section 9.11 and ADR 0019, in its own SQLite file.
 *
 * <p>Each row is {@code h_n = SHA-256(h_(n-1) || entry_n)}, starting from 32 zero bytes, over the encoding in
 * {@link #encode}, which README.md spells out for an independent checker. Rows hold who, what, on what, a payload
 * hash, the decision and the cost, never a prompt, a reply or a key: bodies stay in conversation tables.
 *
 * <p>Triggers refuse every UPDATE, and every DELETE except of the oldest row, once it's more than a year old and
 * isn't the newest. That's how "append-only" and "kept 1 year" live together: the log loses only a prefix, and
 * the first row left keeps its {@code prev_hash}, so the chain still checks from there. The triggers stop
 * mistakes, not root, who can rewrite the file and the chain with it. Anchoring the head in Platform is what
 * would catch that (design 9.11, "Later").
 */
public final class AuditLog implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(AuditLog.class);

    /** Kept a year (design 9.11). The purge goes by a day more, so it never races the trigger's clock. */
    public static final Duration KEEP = Duration.ofDays(365);

    private static final Duration PURGE_MARGIN = Duration.ofDays(1);
    private static final byte[] GENESIS = new byte[32];
    private static final Pattern ACTOR = Pattern.compile("user|member|support|system|(agent|desk):[a-z0-9][a-z0-9-]{0,63}");
    private static final Pattern WORD = Pattern.compile("[a-z][a-z0-9_.:-]{0,63}");
    private static final int MAX_TARGET = 256;

    private static final List<SqliteDatabase.Step> SCHEMA = List.of(connection -> {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE audit (
                      seq INTEGER PRIMARY KEY,
                      at_ms INTEGER NOT NULL,
                      actor TEXT NOT NULL,
                      action TEXT NOT NULL,
                      target TEXT NOT NULL,
                      payload_sha256 BLOB,
                      decision TEXT NOT NULL,
                      cost_microusd INTEGER,
                      prev_hash BLOB NOT NULL,
                      hash BLOB NOT NULL
                    ) STRICT""");
            statement.execute("""
                    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
                    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END""");
            statement.execute("""
                    CREATE TRIGGER audit_keeps_a_year BEFORE DELETE ON audit
                    WHEN old.at_ms > unixepoch() * 1000 - %d
                      OR old.seq <> (SELECT MIN(seq) FROM audit)
                      OR old.seq = (SELECT MAX(seq) FROM audit)
                    BEGIN SELECT RAISE(ABORT, 'the audit log loses only its oldest rows, after a year'); END"""
                    .formatted(KEEP.toMillis()));
        }
    });

    /** What happened. Never content: the target is an id, and a payload is only its hash. */
    public record Entry(
            String actor, String action, String target, byte[] payloadSha256, String decision, Long costMicroUsd) {

        public Entry {
            require(ACTOR.matcher(actor).matches(), "actor");
            require(WORD.matcher(action).matches(), "action");
            require(target.length() <= MAX_TARGET && target.chars().noneMatch(Character::isISOControl), "target");
            require(payloadSha256 == null || payloadSha256.length == 32, "payload hash");
            require(WORD.matcher(decision).matches(), "decision");
            payloadSha256 = payloadSha256 == null ? null : payloadSha256.clone();
        }

        public static Entry of(String actor, String action, String target, String decision) {
            return new Entry(actor, action, target, null, decision, null);
        }

        @Override
        public byte[] payloadSha256() {
            return payloadSha256 == null ? null : payloadSha256.clone();
        }

        private static void require(boolean ok, String what) {
            if (!ok) {
                throw new IllegalArgumentException("bad audit " + what);
            }
        }
    }

    /** A row as stored. */
    public record Row(long seq, long atMillis, Entry entry, byte[] prevHash, byte[] hash) {

        public String hashHex() {
            return HexFormat.of().formatHex(hash);
        }
    }

    /** What a walk of the chain found. {@code brokenAt} is the first row that doesn't check, or null. */
    public record Verification(long rows, long firstSeq, long lastSeq, Long brokenAt) {

        public boolean intact() {
            return brokenAt == null;
        }
    }

    private final Path file;
    private final Clock clock;
    private volatile SqliteDatabase database;

    public AuditLog(Path file, Clock clock) {
        this.file = file;
        this.clock = clock;
    }

    /** Opens the file, creating or migrating it, and drops rows past a year. */
    public void open() throws SQLException {
        SqliteDatabase opened = SqliteDatabase.open("audit", file, SCHEMA);
        try {
            int purged = opened.transaction(this::purge);
            if (purged > 0) {
                log.info("audit log dropped {} rows older than a year", purged);
            }
        } catch (SQLException | RuntimeException e) {
            opened.close();
            throw e;
        }
        database = opened;
    }

    public boolean isOpen() {
        return database != null;
    }

    /** Appends one row, chained to the last, in one transaction. */
    public Row append(Entry entry) throws SQLException {
        long now = clock.millis();
        return open(database).transaction(connection -> {
            long seq = 1;
            byte[] prev = GENESIS;
            try (Statement statement = connection.createStatement();
                    ResultSet last = statement.executeQuery("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1")) {
                if (last.next()) {
                    seq = last.getLong(1) + 1;
                    prev = last.getBytes(2);
                }
            }
            byte[] hash = chain(prev, encode(seq, now, entry));
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO audit (seq, at_ms, actor, action, target, payload_sha256, decision, cost_microusd,"
                            + " prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setLong(1, seq);
                insert.setLong(2, now);
                insert.setString(3, entry.actor());
                insert.setString(4, entry.action());
                insert.setString(5, entry.target());
                insert.setBytes(6, entry.payloadSha256());
                insert.setString(7, entry.decision());
                if (entry.costMicroUsd() == null) {
                    insert.setNull(8, java.sql.Types.INTEGER);
                } else {
                    insert.setLong(8, entry.costMicroUsd());
                }
                insert.setBytes(9, prev);
                insert.setBytes(10, hash);
                insert.executeUpdate();
            }
            return new Row(seq, now, entry, prev, hash);
        });
    }

    /** Rows after {@code afterSeq}, oldest first: the Activity drawer and the JSON export read through this. */
    public List<Row> read(long afterSeq, int limit) throws SQLException {
        return open(database).call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT seq, at_ms, actor, action, target, payload_sha256, decision, cost_microusd, prev_hash, hash"
                            + " FROM audit WHERE seq > ? ORDER BY seq LIMIT ?")) {
                select.setLong(1, afterSeq);
                select.setInt(2, limit);
                List<Row> rows = new ArrayList<>();
                try (ResultSet result = select.executeQuery()) {
                    while (result.next()) {
                        rows.add(row(result));
                    }
                }
                return rows;
            }
        });
    }

    /**
     * Rows before {@code beforeSeq} (all, when null), newest first: {@code agent.audit.list}, a page at a time.
     */
    public List<Row> readBefore(Long beforeSeq, int limit) throws SQLException {
        return open(database).call(connection -> {
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT seq, at_ms, actor, action, target, payload_sha256, decision, cost_microusd, prev_hash, hash"
                            + " FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT ?")) {
                select.setLong(1, beforeSeq == null ? Long.MAX_VALUE : beforeSeq);
                select.setInt(2, limit);
                List<Row> rows = new ArrayList<>();
                try (ResultSet result = select.executeQuery()) {
                    while (result.next()) {
                        rows.add(row(result));
                    }
                }
                return rows;
            }
        });
    }

    /** The newest row's hash, the chain's head, or null for an empty log. */
    public byte[] head() throws SQLException {
        return open(database).call(connection -> {
            try (Statement statement = connection.createStatement();
                    ResultSet last = statement.executeQuery("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1")) {
                return last.next() ? last.getBytes(1) : null;
            }
        });
    }

    /** Walks the whole chain. The first row left anchors it: 32 zero bytes if it's row 1, its stored hash if not. */
    public Verification verify() throws SQLException {
        return open(database).call(connection -> {
            long rows = 0;
            long first = 0;
            long last = 0;
            byte[] expectedPrev = null;
            try (Statement statement = connection.createStatement();
                    ResultSet result = statement.executeQuery(
                            "SELECT seq, at_ms, actor, action, target, payload_sha256, decision, cost_microusd,"
                                    + " prev_hash, hash FROM audit ORDER BY seq")) {
                while (result.next()) {
                    Row row;
                    try {
                        row = row(result);
                    } catch (IllegalArgumentException e) {
                        return new Verification(rows, first, last, result.getLong(1));
                    }
                    if (rows == 0) {
                        first = row.seq();
                        expectedPrev = row.seq() == 1 ? GENESIS : row.prevHash();
                    } else if (row.seq() != last + 1) {
                        return new Verification(rows, first, last, row.seq());
                    }
                    byte[] recomputed = chain(row.prevHash(), encode(row.seq(), row.atMillis(), row.entry()));
                    if (!Arrays.equals(row.prevHash(), expectedPrev) || !Arrays.equals(row.hash(), recomputed)) {
                        return new Verification(rows, first, last, row.seq());
                    }
                    expectedPrev = row.hash();
                    last = row.seq();
                    rows++;
                }
            }
            return new Verification(rows, first, last, null);
        });
    }

    private int purge(Connection connection) throws SQLException {
        long cutoff = clock.millis() - KEEP.plus(PURGE_MARGIN).toMillis();
        try (PreparedStatement delete = connection.prepareStatement("""
                DELETE FROM audit WHERE seq < (SELECT MIN(seq) FROM audit WHERE at_ms >= ?)
                                    AND seq < (SELECT MAX(seq) FROM audit)""")) {
            delete.setLong(1, cutoff);
            int deleted = delete.executeUpdate();
            if (deleted > 0) {
                return deleted;
            }
        }
        // Everything is older than the cutoff: keep only the newest row, which carries the chain on.
        try (PreparedStatement delete = connection.prepareStatement("""
                DELETE FROM audit WHERE seq < (SELECT MAX(seq) FROM audit)
                  AND NOT EXISTS (SELECT 1 FROM audit WHERE at_ms >= ?)""")) {
            delete.setLong(1, cutoff);
            return delete.executeUpdate();
        }
    }

    private static Row row(ResultSet result) throws SQLException {
        long cost = result.getLong(8);
        Long costMicroUsd = result.wasNull() ? null : cost;
        Entry entry = new Entry(
                result.getString(3),
                result.getString(4),
                result.getString(5),
                result.getBytes(6),
                result.getString(7),
                costMicroUsd);
        return new Row(result.getLong(1), result.getLong(2), entry, result.getBytes(9), result.getBytes(10));
    }

    /**
     * The bytes a row's hash covers, big-endian: u64 seq, u64 at_ms, then actor, action and target as u32 length and
     * UTF-8, u8 payload-hash length (0 or 32) and its bytes, decision as u32 length and UTF-8, u8 1 and i64 cost, or
     * u8 0 and nothing.
     */
    static byte[] encode(long seq, long atMillis, Entry entry) {
        byte[][] strings = {
            utf8(entry.actor()), utf8(entry.action()), utf8(entry.target()), utf8(entry.decision()),
        };
        byte[] payload = entry.payloadSha256() == null ? new byte[0] : entry.payloadSha256();
        int size = 8 + 8 + 4 * 4 + strings[0].length + strings[1].length + strings[2].length + strings[3].length
                + 1 + payload.length + 1 + 8;
        ByteBuffer buffer = ByteBuffer.allocate(size);
        buffer.putLong(seq).putLong(atMillis);
        for (int i = 0; i < 3; i++) {
            buffer.putInt(strings[i].length).put(strings[i]);
        }
        buffer.put((byte) payload.length).put(payload);
        buffer.putInt(strings[3].length).put(strings[3]);
        if (entry.costMicroUsd() == null) {
            buffer.put((byte) 0);
        } else {
            buffer.put((byte) 1).putLong(entry.costMicroUsd());
        }
        return Arrays.copyOf(buffer.array(), buffer.position());
    }

    static byte[] chain(byte[] prev, byte[] encoded) {
        MessageDigest sha256 = sha256();
        sha256.update(prev);
        return sha256.digest(encoded);
    }

    /** SHA-256 of a payload, for {@link Entry#payloadSha256}. */
    public static byte[] sha256(byte[] payload) {
        return sha256().digest(payload);
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static SqliteDatabase open(SqliteDatabase database) throws SQLException {
        if (database == null) {
            throw new SQLException("the audit log isn't open");
        }
        return database;
    }

    @Override
    public void close() {
        SqliteDatabase closing = database;
        database = null;
        if (closing != null) {
            closing.close();
        }
    }
}
