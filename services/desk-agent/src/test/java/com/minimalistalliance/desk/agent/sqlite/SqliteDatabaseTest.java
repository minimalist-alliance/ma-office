package com.minimalistalliance.desk.agent.sqlite;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SqliteDatabaseTest {

    @TempDir
    Path dir;

    private static final SqliteDatabase.Step ONE = c -> {
        try (Statement s = c.createStatement()) {
            s.execute("CREATE TABLE t (x INTEGER)");
        }
    };
    private static final SqliteDatabase.Step TWO = c -> {
        try (Statement s = c.createStatement()) {
            s.execute("ALTER TABLE t ADD COLUMN y INTEGER");
        }
    };

    @Test
    void migratesForwardAndIsOwnerOnlyInWalMode() throws Exception {
        Path file = dir.resolve("t.db");
        try (SqliteDatabase db = SqliteDatabase.open("t", file, List.of(ONE))) {
            db.call(c -> c.createStatement().executeUpdate("INSERT INTO t VALUES (1)"));
        }
        try (SqliteDatabase db = SqliteDatabase.open("t", file, List.of(ONE, TWO))) {
            int version = db.call(c -> query(c.createStatement(), "PRAGMA user_version"));
            int rows = db.call(c -> query(c.createStatement(), "SELECT COUNT(y) + COUNT(x) FROM t"));
            String mode = db.call(c -> c.createStatement().executeQuery("PRAGMA journal_mode").getString(1));
            assertThat(version).isEqualTo(2);
            assertThat(rows).isEqualTo(1);
            assertThat(mode).isEqualTo("wal");
        }
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-------");
    }

    @Test
    void refusesANewerSchema() throws Exception {
        Path file = dir.resolve("t.db");
        SqliteDatabase.open("t", file, List.of(ONE, TWO)).close();
        assertThatThrownBy(() -> SqliteDatabase.open("t", file, List.of(ONE)))
                .isInstanceOf(SqliteDatabase.SchemaTooNewException.class)
                .hasMessageContaining("schema 2, newer than 1");
    }

    @Test
    void aFailedTransactionLeavesNothing() throws Exception {
        try (SqliteDatabase db = SqliteDatabase.open("t", dir.resolve("t.db"), List.of(ONE))) {
            assertThatThrownBy(() -> db.transaction(c -> {
                c.createStatement().executeUpdate("INSERT INTO t VALUES (1)");
                throw new SQLException("no");
            })).hasMessage("no");
            int rows = db.call(c -> query(c.createStatement(), "SELECT COUNT(*) FROM t"));
            assertThat(rows).isZero();
        }
    }

    @Test
    void workRunsOnTheDatabasesOwnPlatformThread() throws Exception {
        try (SqliteDatabase db = SqliteDatabase.open("t", dir.resolve("t.db"), List.of(ONE))) {
            Thread[] ran = new Thread[1];
            Thread.ofVirtual().start(() -> {
                try {
                    db.call(c -> ran[0] = Thread.currentThread());
                } catch (SQLException e) {
                    throw new IllegalStateException(e);
                }
            }).join();
            assertThat(ran[0].isVirtual()).isFalse();
            assertThat(ran[0].getName()).isEqualTo("sqlite-t");
        }
    }

    private static int query(Statement statement, String sql) throws SQLException {
        try (statement; ResultSet result = statement.executeQuery(sql)) {
            return result.getInt(1);
        }
    }
}
