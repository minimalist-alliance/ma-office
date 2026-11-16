package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** What must hold of a store whatever was done to it: one row per key, summaries that match, an index and blobs in step. */
public final class Invariants {

    private Invariants() {}

    public static void check(CourierStore store) throws Exception {
        assertThat(store.integrity()).as("integrity").containsExactly("ok");
        store.collectBlobs();
        store.db().read(c -> {
            // One row per sink key.
            assertThat(Sql.longOne(c, "SELECT count(*) FROM (SELECT medium, external_id FROM messages GROUP BY 1, 2 HAVING count(*) > 1)"))
                    .as("duplicate keys").isZero();
            // The lane summaries are what the messages say.
            Map<String, long[]> expected = new HashMap<>();
            Sql.list(c, """
                    SELECT channel_id, lane, count(*), sum(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END), max(sort_at)
                    FROM messages WHERE channel_id IS NOT NULL GROUP BY channel_id, lane""", r -> {
                expected.put(r.getString(1) + "/" + r.getString(2), new long[] {r.getLong(3), r.getLong(4), r.getLong(5)});
                return null;
            });
            Map<String, long[]> actual = new HashMap<>();
            Sql.list(c, "SELECT channel_id, lane, count, unread, last_at, last_seq FROM channel_lanes", r -> {
                actual.put(r.getString(1) + "/" + r.getString(2), new long[] {r.getLong(3), r.getLong(4), r.getLong(5)});
                Long seq = Sql.longOne(c, "SELECT seq FROM messages WHERE seq = ? AND channel_id = ? AND lane = ?", r.getLong(6),
                        r.getString(1), r.getString(2));
                assertThat(seq).as("last_seq names a message of its lane").isNotNull();
                return null;
            });
            assertThat(actual.keySet()).as("summary rows").isEqualTo(expected.keySet());
            for (Map.Entry<String, long[]> e : expected.entrySet()) {
                assertThat(actual.get(e.getKey())).as("summary " + e.getKey()).containsExactly(e.getValue());
            }
            // Threads: every message's exists, none is empty, each in its message's channel.
            assertThat(Sql.longOne(c, "SELECT count(*) FROM messages m WHERE m.thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = m.thread_id)"))
                    .as("missing threads").isZero();
            assertThat(Sql.longOne(c, "SELECT count(*) FROM threads t WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)"))
                    .as("empty threads").isZero();
            assertThat(Sql.longOne(c, "SELECT count(*) FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.channel_id <> m.channel_id"))
                    .as("threads across channels").isZero();
            // Every message's channel exists; pending ones have none.
            assertThat(Sql.longOne(c, "SELECT count(*) FROM messages WHERE lane <> 'pending' AND channel_id IS NULL")).isZero();
            assertThat(Sql.longOne(c, "SELECT count(*) FROM messages WHERE lane = 'pending' AND channel_id IS NOT NULL")).isZero();
            // Receive order is strict per (received_at, id), and ids are unique.
            assertThat(Sql.longOne(c, "SELECT count(*) FROM (SELECT id FROM messages GROUP BY id HAVING count(*) > 1)")).isZero();
            // Blobs: every one named is there and reads back; nothing else is in place or staged.
            List<String> named = Sql.list(c, "SELECT DISTINCT blob FROM messages WHERE blob IS NOT NULL", r -> r.getString(1));
            Set<String> inline = new HashSet<>(Sql.list(c, "SELECT sha FROM blob_data", r -> r.getString(1)));
            assertThat(new HashSet<>(named)).as("every inline blob is named").containsAll(inline);
            for (String sha : named) {
                byte[] gz = Sql.one(c, "SELECT data FROM blob_data WHERE sha = ?", r -> r.getBytes(1), sha);
                try {
                    byte[] raw = gz != null ? BlobStore.decompress(gz, sha) : store.blobs().read(sha);
                    assertThat(raw).as("blob " + sha).isNotNull();
                } catch (java.io.IOException e) {
                    throw new AssertionError(e);
                }
            }
            try {
                Set<String> onDisk = new HashSet<>(store.blobs().listAll());
                Set<String> files = new HashSet<>(named);
                files.removeAll(inline);
                assertThat(onDisk).as("blob files on disk").isEqualTo(files);
                Path staged = store.root().resolve("blobs/.staged");
                try (var s = Files.list(staged)) {
                    assertThat(s.toList()).as("staged").isEmpty();
                }
            } catch (java.io.IOException e) {
                throw new AssertionError(e);
            }
            assertThat(Sql.longOne(c, "SELECT count(*) FROM blob_gc")).as("blobs owed").isZero();
            // The totals are the sums, and each message has its own place in the search's order.
            assertThat(Sql.longOne(c, "SELECT raw_bytes FROM totals WHERE id = 1")).as("totals")
                    .isEqualTo(Sql.longOne(c, "SELECT coalesce(sum(raw_bytes), 0) FROM messages WHERE blob IS NOT NULL"));
            assertThat(Sql.longOne(c, "SELECT count(*) FROM (SELECT sort_key FROM messages GROUP BY 1 HAVING count(*) > 1)"))
                    .as("sort keys").isZero();
            assertThat(Sql.longOne(c, "SELECT count(*) FROM messages WHERE sort_key / ? < sort_at", Ingest.KEY_SPAN))
                    .as("a key before its time").isZero();
            return null;
        });
    }

    /** How many messages, for tests. */
    public static long messages(CourierStore store) throws Exception {
        return store.db().read(c -> Sql.longOne(c, "SELECT count(*) FROM messages"));
    }

    /** The message id stored under a sink key, or null. */
    public static String idOf(CourierStore store, String medium, String externalId) throws Exception {
        return store.db().read(c -> Sql.stringOne(c, "SELECT id FROM messages WHERE medium = ? AND external_id = ?", medium, externalId));
    }

    /** Runs SQL on a reader, for tests that look inside. */
    public static <T> T read(CourierStore store, SqlWork<T> work) throws Exception {
        return store.db().read(work::run);
    }

    @FunctionalInterface
    public interface SqlWork<T> {
        T run(java.sql.Connection c) throws java.sql.SQLException;
    }

    public static long scalar(CourierStore store, String sql, Object... args) throws Exception {
        return store.db().read(c -> Sql.longOne(c, sql, args));
    }

    public static String text(CourierStore store, String sql, Object... args) throws Exception {
        return store.db().read(c -> Sql.stringOne(c, sql, args));
    }
}
