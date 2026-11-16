package com.minimalistalliance.desk.deskd.courier.vault;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Courier vault (the launch plan §3.6, ADR 0042's format): it round-trips every kind of sign-in, fails closed on any
 * change to a sealed file, and leaves nothing behind when a write fails.
 */
class CourierVaultTest {

    static SignIn password(String secret) {
        return new SignIn(SignIn.APP_PASSWORD, "dana@example.com", secret.getBytes(StandardCharsets.UTF_8), null, 0,
                "{\"imapHost\":\"imap.example.com\",\"imapPort\":993}");
    }

    @Test
    void everyKindRoundTripsAndChangesInPlace(@TempDir Path dir) throws Exception {
        CourierVault v = new CourierVault(dir.resolve("keys"));
        v.prepare();
        try (SignIn s = password("abcd efgh ijkl mnop")) {
            v.seal("imap-1", "imap", s);
        }
        try (SignIn s = v.open("imap-1", "imap")) {
            assertThat(s.kind()).isEqualTo(SignIn.APP_PASSWORD);
            assertThat(s.username()).isEqualTo("dana@example.com");
            assertThat(new String(s.secret(), StandardCharsets.UTF_8)).isEqualTo("abcd efgh ijkl mnop");
            assertThat(s.server()).contains("imap.example.com");
            assertThat(s.toString()).isEqualTo("SignIn[app_password]");
        }
        try (SignIn o = new SignIn(SignIn.OAUTH, "dana@example.com", "access-1".getBytes(StandardCharsets.UTF_8),
                "refresh-1".getBytes(StandardCharsets.UTF_8), 1_800_000_000_000L, null)) {
            v.seal("jmap-1", "jmap", o);
        }
        try (SignIn o = new SignIn(SignIn.OAUTH, "dana@example.com", "access-2".getBytes(StandardCharsets.UTF_8),
                "refresh-2".getBytes(StandardCharsets.UTF_8), 1_800_000_360_000L, null)) {
            v.replace("jmap-1", "jmap", o);
        }
        try (SignIn o = v.open("jmap-1", "jmap")) {
            assertThat(new String(o.secret(), StandardCharsets.UTF_8)).isEqualTo("access-2");
            assertThat(new String(o.refresh(), StandardCharsets.UTF_8)).isEqualTo("refresh-2");
            assertThat(o.expiresAt()).isEqualTo(1_800_000_360_000L);
        }
        // A second seal of the same id is refused and changes nothing.
        try (SignIn s = password("other")) {
            assertThatThrownBy(() -> v.seal("imap-1", "imap", s)).isInstanceOf(java.nio.file.FileAlreadyExistsException.class);
        }
        try (SignIn s = v.open("imap-1", "imap")) {
            assertThat(new String(s.secret(), StandardCharsets.UTF_8)).isEqualTo("abcd efgh ijkl mnop");
        }
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("keys")))).isEqualTo("rwx------");
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("keys/master.key")))).isEqualTo("rw-------");
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("keys/imap-1.sealed")))).isEqualTo("rw-------");
        assertThat(Files.size(dir.resolve("keys/master.key"))).isEqualTo(32);
    }

    @Test
    void anyChangeToASealedFileFailsClosed(@TempDir Path dir) throws Exception {
        CourierVault v = new CourierVault(dir.resolve("keys"));
        try (SignIn s = password("tamper-me-please")) {
            v.seal("imap-1", "imap", s);
            v.seal("imap-2", "imap", s);
        }
        Path file = dir.resolve("keys/imap-1.sealed");
        byte[] good = Files.readAllBytes(file);
        // Every byte changed, one at a time: the magic, the version, the nonce, the ciphertext, the tag.
        for (int i = 0; i < good.length; i++) {
            byte[] bad = good.clone();
            bad[i] ^= 0x01;
            Files.write(file, bad);
            assertThatThrownBy(() -> v.open("imap-1", "imap")).as("byte " + i).isInstanceOf(IOException.class)
                    .satisfies(e -> assertThat(e.getMessage()).doesNotContain("tamper"));
        }
        // Cut short, grown, emptied.
        for (byte[] bad : new byte[][] {java.util.Arrays.copyOf(good, good.length - 1), java.util.Arrays.copyOf(good, good.length + 1), new byte[0]}) {
            Files.write(file, bad);
            assertThatThrownBy(() -> v.open("imap-1", "imap")).isInstanceOf(IOException.class);
        }
        Files.write(file, good);
        // Under another account's id or kind (the AAD), it won't open.
        Files.copy(file, dir.resolve("keys/imap-3.sealed"));
        assertThatThrownBy(() -> v.open("imap-3", "imap")).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> v.open("imap-1", "jmap")).isInstanceOf(IOException.class);
        try (SignIn s = v.open("imap-1", "imap")) {
            assertThat(s.secret()).isNotEmpty();
        }
        // Another master key: nothing sealed under the old one opens, and the bad key is kept aside, never overwritten.
        Files.write(dir.resolve("keys/master.key"), new byte[31]);
        assertThatThrownBy(() -> v.open("imap-1", "imap")).isInstanceOf(IOException.class);
        assertThat(dir.resolve("keys/master.key.bad-1")).exists();
        // A link where a sealed file should be isn't followed.
        Files.delete(dir.resolve("keys/imap-2.sealed"));
        Files.createSymbolicLink(dir.resolve("keys/imap-2.sealed"), file);
        assertThatThrownBy(() -> v.open("imap-2", "imap")).isInstanceOf(IOException.class);
    }

    @Test
    void namesThatCouldEscapeTheDirectoryAreRefused(@TempDir Path dir) {
        CourierVault v = new CourierVault(dir.resolve("keys"));
        for (String id : new String[] {"..", ".", "../x", "a/b", "", "master.key", "x.tmp", "a b", "é"}) {
            try (SignIn s = password("x1234567")) {
                assertThatThrownBy(() -> v.seal(id, "imap", s)).as(id).isInstanceOf(IOException.class);
            }
            assertThat(CourierVault.validId(id)).as(id).isFalse();
        }
    }

    @Test
    void aWriteThatFailsLeavesNothingAndPrepareCleansUp(@TempDir Path dir) throws Exception {
        Path keys = dir.resolve("keys");
        CourierVault ok = new CourierVault(keys);
        ok.prepare();
        CourierVault failing = new CourierVault(keys, channel -> {
            throw new IOException("disk full");
        });
        try (SignIn s = password("never-on-disk")) {
            assertThatThrownBy(() -> failing.seal("imap-9", "imap", s)).isInstanceOf(IOException.class);
        }
        try (var files = Files.list(keys)) {
            assertThat(files.map(p -> p.getFileName().toString())).containsExactly("master.key");
        }
        Files.writeString(keys.resolve("imap-1.sealed.0011223344556677.tmp"), "left by a crash");
        try (SignIn s = password("kept-one")) {
            ok.seal("imap-1", "imap", s);
            ok.seal("imap-orphan", "imap", s);
        }
        ok.prepare();
        assertThat(ok.removeOrphans(Set.of("imap-1"))).isEqualTo(1);
        try (var files = Files.list(keys)) {
            assertThat(files.map(p -> p.getFileName().toString())).containsExactlyInAnyOrder("master.key", "imap-1.sealed");
        }
    }

    @Test
    void aSignInIsZeroedWhenClosedAndRefusesBadParts() {
        byte[] secret = "zero-me".getBytes(StandardCharsets.UTF_8);
        SignIn s = new SignIn(SignIn.PASSWORD, "a@example.com", secret, null, 0, null);
        s.close();
        assertThat(secret).containsOnly(0);
        byte[] refresh = "r".getBytes(StandardCharsets.UTF_8);
        byte[] secret2 = "s".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> new SignIn(SignIn.PASSWORD, "a@example.com", secret2, refresh, 0, null)).hasMessage("secret");
        assertThat(secret2).containsOnly(0);
        assertThatThrownBy(() -> new SignIn("token", "a", "x".getBytes(StandardCharsets.UTF_8), null, 0, null)).hasMessage("kind");
        assertThatThrownBy(() -> new SignIn(SignIn.PASSWORD, "a\nb", "x".getBytes(StandardCharsets.UTF_8), null, 0, null)).hasMessage("username");
        assertThatThrownBy(() -> new SignIn(SignIn.PASSWORD, "a", new byte[0], null, 0, null)).hasMessage("secret");
    }
}
