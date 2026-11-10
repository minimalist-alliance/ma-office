package com.minimalistalliance.desk.agent.audit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.testing.MutableClock;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AuditLogTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-04T10:00:00Z"));
    private AuditLog audit;

    @BeforeEach
    void open() throws SQLException {
        audit = new AuditLog(dir.resolve("audit.db"), clock);
        audit.open();
    }

    @AfterEach
    void close() {
        audit.close();
    }

    @Test
    void aGuildMemberIsAnActor() throws Exception {
        // AgentService.limitsSet audits a guild member's change as "member"; a refused actor threw after the change was saved.
        AuditLog.Row row = audit.append(AuditLog.Entry.of("member", "limits.set", "agent:a1", "ok"));
        org.assertj.core.api.Assertions.assertThat(row.entry().actor()).isEqualTo("member");
    }

    @Test
    void rowsChainFromZerosAndVerify() throws SQLException {
        AuditLog.Row first = audit.append(AuditLog.Entry.of("system", "service.start", "desk-agent:1", "ok"));
        clock.advance(Duration.ofSeconds(1));
        AuditLog.Row second = audit.append(new AuditLog.Entry("agent:manager", "llm.call", "key:k1 model:fake/m",
                AuditLog.sha256(new byte[] {1}), "ok", 1234L));

        assertThat(first.seq()).isEqualTo(1);
        assertThat(first.prevHash()).isEqualTo(new byte[32]);
        assertThat(second.prevHash()).isEqualTo(first.hash());
        assertThat(audit.verify()).isEqualTo(new AuditLog.Verification(2, 1, 2, null));
    }

    /** The encoding README.md documents, computed here by hand, so a checker in another language can match it. */
    @Test
    void theHashIsTheDocumentedEncoding() throws Exception {
        AuditLog.Row row = audit.append(new AuditLog.Entry("user", "a", "t", null, "ok", 5L));
        java.io.ByteArrayOutputStream expected = new java.io.ByteArrayOutputStream();
        java.io.DataOutputStream out = new java.io.DataOutputStream(expected);
        out.write(new byte[32]); // h_0
        out.writeLong(1);
        out.writeLong(clock.millis());
        for (String s : new String[] {"user", "a", "t"}) {
            out.writeInt(s.length());
            out.writeBytes(s);
        }
        out.writeByte(0); // no payload hash
        out.writeInt(2);
        out.writeBytes("ok");
        out.writeByte(1);
        out.writeLong(5);
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(expected.toByteArray());
        assertThat(HexFormat.of().formatHex(row.hash())).isEqualTo(HexFormat.of().formatHex(digest));
    }

    @Test
    void updatesAndDeletesAreRefused() throws SQLException {
        audit.append(AuditLog.Entry.of("system", "service.start", "x", "ok"));
        audit.append(AuditLog.Entry.of("system", "service.stop", "x", "ok"));
        try (Connection other = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("audit.db"));
                Statement statement = other.createStatement()) {
            assertThatThrownBy(() -> statement.execute("UPDATE audit SET decision = 'refused' WHERE seq = 2"))
                    .hasMessageContaining("append-only");
            // Too young, and not the oldest either.
            assertThatThrownBy(() -> statement.execute("DELETE FROM audit WHERE seq = 2"))
                    .hasMessageContaining("oldest rows, after a year");
            assertThatThrownBy(() -> statement.execute("DELETE FROM audit WHERE seq = 1"))
                    .hasMessageContaining("oldest rows, after a year");
        }
        assertThat(audit.verify().rows()).isEqualTo(2);
    }

    /** What root could do: drop the trigger and change a row. The walk finds the row. */
    @Test
    void anEditedRowBreaksTheChainThere() throws SQLException {
        for (int i = 0; i < 5; i++) {
            audit.append(AuditLog.Entry.of("agent:manager", "llm.call", "key:k1 model:fake/m", "ok"));
        }
        try (Connection other = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("audit.db"));
                Statement statement = other.createStatement()) {
            statement.execute("DROP TRIGGER audit_no_update");
            statement.execute("UPDATE audit SET decision = 'refused' WHERE seq = 3");
        }
        AuditLog.Verification verification = audit.verify();
        assertThat(verification.intact()).isFalse();
        assertThat(verification.brokenAt()).isEqualTo(3);
    }

    @Test
    void aDeletedRowInTheMiddleBreaksTheChain() throws SQLException {
        for (int i = 0; i < 4; i++) {
            audit.append(AuditLog.Entry.of("system", "x", "y", "ok"));
        }
        try (Connection other = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("audit.db"));
                Statement statement = other.createStatement()) {
            statement.execute("DROP TRIGGER audit_keeps_a_year");
            statement.execute("DELETE FROM audit WHERE seq = 2");
        }
        assertThat(audit.verify().brokenAt()).isEqualTo(3);
    }

    /**
     * "Kept 1 year": reopening a year on drops the old prefix, and the chain still checks from the first left. The
     * trigger reads SQLite's own clock, so these rows are written in the real past.
     */
    @Test
    void aYearOnTheOldestRowsGoAndTheRestStillVerify() throws SQLException {
        clock.set(Instant.parse("2024-01-01T00:00:00Z"));
        audit.append(AuditLog.Entry.of("system", "old", "1", "ok"));
        audit.append(AuditLog.Entry.of("system", "old", "2", "ok"));
        clock.advance(Duration.ofDays(200));
        audit.append(AuditLog.Entry.of("system", "newer", "3", "ok"));
        clock.advance(Duration.ofDays(167));
        audit.close();
        audit.open();

        assertThat(audit.read(0, 10)).extracting(AuditLog.Row::seq).containsExactly(3L);
        assertThat(audit.verify()).isEqualTo(new AuditLog.Verification(1, 3, 3, null));
        AuditLog.Row next = audit.append(AuditLog.Entry.of("system", "next", "4", "ok"));
        assertThat(next.seq()).isEqualTo(4);
        assertThat(audit.verify()).isEqualTo(new AuditLog.Verification(2, 3, 4, null));
    }

    @Test
    void theNewestRowStaysEvenWhenEverythingIsOld() throws SQLException {
        clock.set(Instant.parse("2024-01-01T00:00:00Z"));
        audit.append(AuditLog.Entry.of("system", "a", "1", "ok"));
        audit.append(AuditLog.Entry.of("system", "a", "2", "ok"));
        clock.advance(Duration.ofDays(800));
        audit.close();
        audit.open();
        assertThat(audit.read(0, 10)).extracting(AuditLog.Row::seq).containsExactly(2L);
        assertThat(audit.append(AuditLog.Entry.of("system", "a", "3", "ok")).seq()).isEqualTo(3);
        assertThat(audit.verify().intact()).isTrue();
    }

    @Test
    void entriesCarryIdsNotContent() {
        assertThatThrownBy(() -> AuditLog.Entry.of("someone", "x", "y", "ok")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AuditLog.Entry.of("system", "Bad Action", "y", "ok"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AuditLog.Entry.of("system", "x", "line\nbreak", "ok"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AuditLog.Entry.of("system", "x", "t".repeat(257), "ok"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AuditLog.Entry("system", "x", "y", new byte[3], "ok", null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aClosedLogRefusesAppends() {
        audit.close();
        assertThat(audit.isOpen()).isFalse();
        assertThatThrownBy(() -> audit.append(AuditLog.Entry.of("system", "x", "y", "ok")))
                .isInstanceOf(SQLException.class);
    }
}
