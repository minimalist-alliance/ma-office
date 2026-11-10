package com.minimalistalliance.desk.agent.key;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assumptions.assumeThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

class KeyVaultTest {

    private static final String KEY = "sk-fake-vault-0123456789abcdef";
    private static final String PROVIDER = "anthropic";

    @TempDir
    Path data;

    private Path dir;
    private KeyVault vault;

    @BeforeEach
    void prepare() {
        dir = data.resolve("keys");
        vault = new KeyVault(dir);
        vault.prepare();
    }

    @Test
    void aKeyComesBackAsItWasSealed() throws Exception {
        byte[] secret = bytes(KEY);
        vault.seal("k-1", PROVIDER, secret);
        assertThat(secret).as("the caller's to zero, not the vault's").isEqualTo(bytes(KEY));
        assertThat(new KeyVault(dir).unseal("k-1", PROVIDER)).isEqualTo(bytes(KEY));
    }

    @Test
    void theModesAreOwnerOnly() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        assertThat(mode(dir)).isEqualTo("rwx------");
        assertThat(mode(dir.resolve(KeyVault.MASTER))).isEqualTo("rw-------");
        assertThat(mode(dir.resolve("k-1.sealed"))).isEqualTo("rw-------");
        assertThat(Files.size(dir.resolve(KeyVault.MASTER))).isEqualTo(KeyVault.MASTER_BYTES);
    }

    @Test
    void theFileIsMagicVersionNonceCiphertextAndTag() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        vault.seal("k-2", PROVIDER, bytes(KEY));
        byte[] one = Files.readAllBytes(dir.resolve("k-1.sealed"));
        byte[] two = Files.readAllBytes(dir.resolve("k-2.sealed"));
        assertThat(one).hasSize(4 + 1 + 12 + KEY.length() + 16);
        assertThat(new String(one, 0, 4, StandardCharsets.US_ASCII)).isEqualTo("MAKV");
        assertThat(one[4]).isEqualTo((byte) 1);
        assertThat(java.util.Arrays.copyOfRange(one, 5, 17)).isNotEqualTo(java.util.Arrays.copyOfRange(two, 5, 17));
    }

    @Test
    void theMasterIsMadeOnce() throws Exception {
        byte[] master = Files.readAllBytes(dir.resolve(KeyVault.MASTER));
        new KeyVault(dir).prepare();
        vault.seal("k-1", PROVIDER, bytes(KEY));
        assertThat(Files.readAllBytes(dir.resolve(KeyVault.MASTER))).isEqualTo(master);
    }

    @Test
    void aStartTightensWhatAMoveOrARestoreLoosenedAndRemovesTemporaries() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwxr-xr-x"));
        Files.setPosixFilePermissions(dir.resolve(KeyVault.MASTER), PosixFilePermissions.fromString("rw-r--r--"));
        Files.setPosixFilePermissions(dir.resolve("k-1.sealed"), PosixFilePermissions.fromString("rw-rw-rw-"));
        Files.writeString(dir.resolve("k-2.sealed.0123456789abcdef.tmp"), "half a file");
        Files.writeString(dir.resolve("master.key.0123456789abcdef.tmp"), "half a file");

        new KeyVault(dir).prepare();

        assertThat(mode(dir)).isEqualTo("rwx------");
        assertThat(mode(dir.resolve(KeyVault.MASTER))).isEqualTo("rw-------");
        assertThat(mode(dir.resolve("k-1.sealed"))).isEqualTo("rw-------");
        assertThat(names()).containsExactlyInAnyOrder(KeyVault.MASTER, "k-1.sealed");
        assertThat(vault.unseal("k-1", PROVIDER)).isEqualTo(bytes(KEY));
    }

    @Test
    void aFileOpensOnlyForItsOwnKeyIdAndProvider() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        assertThatThrownBy(() -> vault.unseal("k-1", "openai")).isInstanceOf(IOException.class);
        Files.copy(dir.resolve("k-1.sealed"), dir.resolve("k-2.sealed"));
        assertThatThrownBy(() -> vault.unseal("k-2", PROVIDER)).isInstanceOf(IOException.class);
    }

    @Test
    void anyFlippedBitIsRefused() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        Path file = dir.resolve("k-1.sealed");
        byte[] good = Files.readAllBytes(file);
        for (int i = 0; i < good.length; i++) {
            byte[] bad = good.clone();
            bad[i] ^= 0x01;
            Files.write(file, bad);
            assertThatThrownBy(() -> vault.unseal("k-1", PROVIDER)).as("byte " + i).isInstanceOf(IOException.class);
        }
        Files.write(file, good);
        assertThat(vault.unseal("k-1", PROVIDER)).isEqualTo(bytes(KEY));
    }

    @Test
    void aFileOfAnyOtherLengthIsRefused() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        Path file = dir.resolve("k-1.sealed");
        byte[] good = Files.readAllBytes(file);
        Files.write(file, java.util.Arrays.copyOf(good, 20));
        assertThatThrownBy(() -> vault.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);
        Files.write(file, new byte[64 * 1024]);
        assertThatThrownBy(() -> vault.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);
    }

    @Test
    void aMissingMasterIsMadeAgainAndOldFilesFailTheirTag() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        Files.delete(dir.resolve(KeyVault.MASTER));

        KeyVault again = new KeyVault(dir);
        again.prepare();

        assertThat(Files.size(dir.resolve(KeyVault.MASTER))).isEqualTo(KeyVault.MASTER_BYTES);
        assertThatThrownBy(() -> again.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);
        assertThat(dir.resolve("k-1.sealed")).exists();
        again.seal("k-2", PROVIDER, bytes(KEY));
        assertThat(again.unseal("k-2", PROVIDER)).isEqualTo(bytes(KEY));
    }

    @Test
    void aMasterOfTheWrongLengthIsSetAsideAndNeverOverwritten() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        byte[] wrong = {1, 2, 3, 4, 5};
        Files.write(dir.resolve(KeyVault.MASTER), wrong);

        KeyVault again = new KeyVault(dir);
        again.prepare();

        assertThat(Files.readAllBytes(dir.resolve("master.key.bad-1"))).isEqualTo(wrong);
        assertThat(Files.size(dir.resolve(KeyVault.MASTER))).isEqualTo(KeyVault.MASTER_BYTES);
        assertThatThrownBy(() -> again.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);

        Files.write(dir.resolve(KeyVault.MASTER), wrong);
        new KeyVault(dir).prepare();
        assertThat(names()).contains("master.key.bad-1", "master.key.bad-2");
    }

    @Test
    void aLinkInPlaceOfTheMasterIsSetAsideAndItsTargetLeftAlone() throws Exception {
        Path elsewhere = Files.write(data.resolve("elsewhere"), new byte[KeyVault.MASTER_BYTES]);
        Files.setPosixFilePermissions(elsewhere, PosixFilePermissions.fromString("rw-r--r--"));
        Files.delete(dir.resolve(KeyVault.MASTER));
        Files.createSymbolicLink(dir.resolve(KeyVault.MASTER), elsewhere);

        new KeyVault(dir).prepare();

        assertThat(Files.isSymbolicLink(dir.resolve(KeyVault.MASTER))).isFalse();
        assertThat(Files.isSymbolicLink(dir.resolve("master.key.bad-1"))).isTrue();
        assertThat(Files.readAllBytes(elsewhere)).isEqualTo(new byte[KeyVault.MASTER_BYTES]);
        assertThat(mode(elsewhere)).isEqualTo("rw-r--r--");
    }

    /** It may only need its owner fixed, as after a restore: a new one would lose every key for good. */
    @Test
    void aMasterThatCantBeReadIsLeftAloneAndNothingIsSealed() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        Path master = dir.resolve(KeyVault.MASTER);
        byte[] before = Files.readAllBytes(master);
        Files.setPosixFilePermissions(master, PosixFilePermissions.fromString("---------"));
        assumeThat(Files.isReadable(master)).as("not running as root").isFalse();

        assertThatThrownBy(() -> vault.seal("k-2", PROVIDER, bytes(KEY))).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> vault.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);
        assertThat(names()).containsExactlyInAnyOrder(KeyVault.MASTER, "k-1.sealed");

        Files.setPosixFilePermissions(master, PosixFilePermissions.fromString("rw-------"));
        assertThat(Files.readAllBytes(master)).isEqualTo(before);
        assertThat(vault.unseal("k-1", PROVIDER)).isEqualTo(bytes(KEY));
    }

    @Test
    void aFailedFsyncOfTheFileLeavesNothingBehind() throws Exception {
        KeyVault failing = new KeyVault(dir, channel -> {
            throw new IOException("no disk");
        });
        assertThatThrownBy(() -> failing.seal("k-1", PROVIDER, bytes(KEY))).isInstanceOf(IOException.class);
        assertThat(names()).containsExactly(KeyVault.MASTER);
    }

    @Test
    void aFailedFsyncOfTheDirectoryLeavesNothingBehind() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        KeyVault failing = new KeyVault(dir, channel -> {
            if (calls.incrementAndGet() == 2) {
                throw new IOException("no disk");
            }
            channel.force(true);
        });
        assertThatThrownBy(() -> failing.seal("k-1", PROVIDER, bytes(KEY))).isInstanceOf(IOException.class);
        assertThat(calls).hasValue(2);
        assertThat(names()).containsExactly(KeyVault.MASTER);
    }

    @Test
    void aMasterThatCantBeWrittenLeavesNothingBehindAndPrepareStillReturns() throws Exception {
        Path other = data.resolve("other");
        KeyVault failing = new KeyVault(other, channel -> {
            throw new IOException("no disk");
        });
        failing.prepare();
        assertThatThrownBy(() -> failing.seal("k-1", PROVIDER, bytes(KEY))).isInstanceOf(IOException.class);
        try (Stream<Path> files = Files.list(other)) {
            assertThat(files).isEmpty();
        }
    }

    @Test
    void aPathThatIsntADirectoryIsReportedNotRepaired() throws Exception {
        Path notADirectory = Files.writeString(data.resolve("not-a-directory"), "the member's");
        KeyVault bad = new KeyVault(notADirectory);
        bad.prepare();
        assertThatThrownBy(() -> bad.seal("k-1", PROVIDER, bytes(KEY))).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> bad.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);
        assertThat(bad.removeOrphans(Set.of())).isZero();
        assertThat(bad.holds("k-1")).isFalse();
        assertThat(Files.readString(notADirectory)).isEqualTo("the member's");
    }

    @Test
    void aLinkInPlaceOfTheDirectoryIsntFollowed() throws Exception {
        Path real = Files.createDirectory(data.resolve("real"));
        Path link = Files.createSymbolicLink(data.resolve("link"), real);
        KeyVault linked = new KeyVault(link);
        linked.prepare();
        assertThatThrownBy(() -> linked.seal("k-1", PROVIDER, bytes(KEY))).isInstanceOf(IOException.class);
        try (Stream<Path> files = Files.list(real)) {
            assertThat(files).isEmpty();
        }
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS)
    void aFifoForASealedFileDoesntHang() throws Exception {
        Process mkfifo = new ProcessBuilder("mkfifo", dir.resolve("k-1.sealed").toString()).start();
        assumeThat(mkfifo.waitFor(Duration.ofSeconds(5).toSeconds(), TimeUnit.SECONDS)).isTrue();
        assumeThat(mkfifo.exitValue()).isZero();
        assertThatThrownBy(() -> vault.unseal("k-1", PROVIDER)).isInstanceOf(IOException.class);
        new KeyVault(dir).prepare();
        assertThat(vault.removeOrphans(Set.of())).isEqualTo(1);
    }

    @Test
    void aLinkForASealedFileIsntFollowed() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        Files.createSymbolicLink(dir.resolve("k-2.sealed"), dir.resolve("k-1.sealed"));
        assertThatThrownBy(() -> vault.unseal("k-2", PROVIDER)).isInstanceOf(IOException.class);
    }

    @Test
    void aSealedFileIsImmutable() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        byte[] before = Files.readAllBytes(dir.resolve("k-1.sealed"));
        assertThatThrownBy(() -> vault.seal("k-1", PROVIDER, bytes("sk-fake-another-key-0123456")))
                .isInstanceOf(IOException.class);
        assertThat(Files.readAllBytes(dir.resolve("k-1.sealed"))).isEqualTo(before);
    }

    /** A key id comes from a client on delete, so it must never leave the directory. */
    @Test
    void aMalformedIdNeverReachesThePath() throws Exception {
        Path outside = Files.writeString(data.resolve("outside.sealed"), "not ours");
        for (String bad : new String[] {"../outside", "a/b", "", ".hidden", "a b", "k\n"}) {
            assertThat(vault.holds(bad)).as(bad).isFalse();
            vault.delete(bad);
            assertThatThrownBy(() -> vault.seal(bad, PROVIDER, bytes(KEY))).as(bad).isInstanceOf(IOException.class);
            assertThatThrownBy(() -> vault.unseal(bad, PROVIDER)).as(bad).isInstanceOf(IOException.class);
        }
        assertThat(outside).exists();
    }

    @Test
    void whatIsntAKeyIsntSealed() {
        assertThatThrownBy(() -> vault.seal("k-1", PROVIDER, bytes("short"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> vault.seal("k-1", PROVIDER, new byte[1025])).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void deleteUnlinksTheFileAndAMissingOneIsFine() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        assertThat(vault.holds("k-1")).isTrue();
        vault.delete("k-1");
        assertThat(vault.holds("k-1")).isFalse();
        assertThat(dir.resolve("k-1.sealed")).doesNotExist();
        vault.delete("k-1");
    }

    @Test
    void orphansGoAndEverythingElseStays() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        vault.seal("k-2", PROVIDER, bytes(KEY));
        Files.write(dir.resolve("master.key.bad-1"), new byte[] {1});
        assertThat(vault.removeOrphans(Set.of("k-1"))).isEqualTo(1);
        assertThat(names()).containsExactlyInAnyOrder(KeyVault.MASTER, "master.key.bad-1", "k-1.sealed");
    }

    @Test
    void theKeysBytesAreInNoFile() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        vault.seal("k-2", "openai", bytes("sk-fake-second-0123456789abcd"));
        List<Path> files = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(data)) {
            walk.filter(Files::isRegularFile).forEach(files::add);
        }
        assertThat(files).hasSize(3);
        for (Path file : files) {
            String content = new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1);
            assertThat(content).as(file.toString()).doesNotContain(KEY, "sk-fake", "cdef");
        }
    }

    @Test
    void nothingPrintsAKey() throws Exception {
        vault.seal("k-1", PROVIDER, bytes(KEY));
        assertThat(vault.toString()).doesNotContain(KEY).contains("keys");
        byte[] master = Files.readAllBytes(dir.resolve(KeyVault.MASTER));
        assertThat(vault.toString()).doesNotContain(new String(master, StandardCharsets.ISO_8859_1));
        assertThatThrownBy(() -> vault.unseal("k-1", "openai")).satisfies(failure -> {
            assertThat(failure.getMessage()).doesNotContain(KEY);
            assertThat(failure.getCause()).isNull();
        });
    }

    private List<String> names() throws IOException {
        try (Stream<Path> files = Files.list(dir)) {
            return files.map(file -> file.getFileName().toString()).toList();
        }
    }

    private static String mode(Path path) throws IOException {
        return PosixFilePermissions.toString(Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS));
    }

    private static byte[] bytes(String key) {
        return key.getBytes(StandardCharsets.US_ASCII);
    }
}
