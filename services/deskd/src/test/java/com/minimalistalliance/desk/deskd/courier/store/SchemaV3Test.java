package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.sqlite.SqliteDatabase;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Path;
import java.sql.Statement;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Schema 3 over a store made at schema 2: the keys of what's already there are made by the migration. */
class SchemaV3Test {

    @Test
    void aSchemaTwoStoreGetsItsNameAndDomainKeys(@TempDir Path dir) throws Exception {
        Path root = dir.resolve("courier");
        java.nio.file.Files.createDirectories(root);
        SqliteDatabase v2 = SqliteDatabase.open("courier", root.resolve("courier.db"), Schema.STEPS.subList(0, 2));
        v2.call(c -> {
            try (Statement s = c.createStatement()) {
                s.execute("INSERT INTO contacts (id, name, named, created_at, updated_at) VALUES ('c1', 'Dana Smith', 0, 0, 0)");
                s.execute("INSERT INTO contacts (id, name, named, created_at, updated_at) VALUES ('c2', 'Support', 0, 0, 0)");
                s.execute("INSERT INTO endpoints (id, kind, value, contact_id, standing, written_to, first_seen_at) "
                        + "VALUES ('e1', 'email', 'dana@mail.acme-corp.example', 'c1', 'known', 0, 0)");
                s.execute("INSERT INTO endpoints (id, kind, value, contact_id, standing, written_to, first_seen_at) "
                        + "VALUES ('e2', 'phone', '+15550001111', 'c2', 'unknown', 0, 0)");
            }
            return null;
        });
        v2.close();
        CourierStore store = CourierStore.open(root, com.minimalistalliance.desk.deskd.courier.parse.CourierParser.NONE,
                new MutableClock(Instant.parse("2026-11-14T12:00:00Z")), CourierStore.Settings.DEFAULT);
        try {
            store.db().read(c -> {
                assertThat(Sql.stringOne(c, "SELECT name_key FROM contacts WHERE id = 'c1'")).isEqualTo(Senders.nameKey("Dana Smith"));
                assertThat(Sql.stringOne(c, "SELECT name_key FROM contacts WHERE id = 'c2'")).isNull();
                assertThat(Sql.stringOne(c, "SELECT skel FROM endpoints WHERE id = 'e1'")).isEqualTo(Senders.skeleton("acme-corp.example"));
                assertThat(Sql.stringOne(c, "SELECT skel FROM endpoints WHERE id = 'e2'")).isNull();
                assertThat(Sql.longOne(c, "SELECT length(salt) FROM filter_state WHERE id = 1")).isEqualTo(16L);
                return null;
            });
        } finally {
            store.close();
        }
    }
}
