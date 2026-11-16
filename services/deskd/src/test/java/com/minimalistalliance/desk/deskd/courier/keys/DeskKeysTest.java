package com.minimalistalliance.desk.deskd.courier.keys;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

@SuppressWarnings("unchecked")
class DeskKeysTest {

    private static final long DAY = 86_400_000L;
    private static final String ME = "sam@courier.example";

    @TempDir
    Path tmp;
    Path dir;
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-14T12:00:00Z"));
    final List<PublishedKeys> published = new ArrayList<>();
    KeyPublisher.Result next = null;
    final AtomicBoolean may = new AtomicBoolean(true);
    final KeyPublisher publisher = keys -> {
        published.add(keys);
        return next != null ? next : new KeyPublisher.Result(KeyPublisher.Outcome.PUBLISHED, published.size(), keys.fingerprint(), null, null);
    };

    @BeforeEach
    void makeDirectory() throws IOException {
        dir = tmp.resolve("keys");
        Files.createDirectory(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    }

    private DeskKeys keys() {
        return new DeskKeys(DeskKeys.Settings.defaults(dir), clock, publisher, may::get);
    }

    private static String mode(Path p) throws IOException {
        return PosixFilePermissions.toString(Files.getPosixFilePermissions(p, java.nio.file.LinkOption.NOFOLLOW_LINKS));
    }

    private List<Path> files() throws IOException {
        try (Stream<Path> s = Files.list(dir)) {
            return s.sorted().toList();
        }
    }

    @Test
    void aFirstStartMakesTheKeysAndALaterOneLoadsTheSame() throws Exception {
        DeskKeys k = keys();
        assertThat(k.available()).isTrue();
        PublishedKeys first = k.publicKeys();
        assertThat(first.bindingValid()).isTrue();
        assertThat(files()).extracting(p -> p.getFileName().toString())
                .containsExactlyInAnyOrder(DeskKeyStore.IDENTITY, DeskKeyStore.boxName(k.recipient().boxKeys().get(0)));
        for (Path f : files()) {
            assertThat(mode(f)).isEqualTo("rw-------");
            assertThat(Files.size(f)).isEqualTo(DeskKeyStore.FILE_BYTES);
        }
        assertThat(mode(dir)).isEqualTo("rwx------");
        DeskKeys again = keys();
        assertThat(again.publicKeys().sameKeys(first)).isTrue();
        assertThat(again.status().get("replacedAt")).isNull();
    }

    @Test
    void noDirectoryMeansNoKeysAndNothingElseBreaks() throws Exception {
        Files.delete(dir);
        DeskKeys k = keys();
        assertThat(k.available()).isFalse();
        assertThat(k.status()).containsEntry("available", false).containsEntry("reason", "no_directory");
        assertThat(k.publicKeys()).isNull();
        assertThat(k.identity()).isNull();
        assertThat(k.recipient().boxKeys()).isEmpty();
        k.maintain();
        assertThat(published).isEmpty();
        assertThat(Files.exists(dir)).isFalse();
    }

    @Test
    void modesAreTightenedAndACrashsTemporaryFilesRemoved() throws Exception {
        keys();
        Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwxr-xr-x"));
        Path identity = dir.resolve(DeskKeyStore.IDENTITY);
        Files.setPosixFilePermissions(identity, PosixFilePermissions.fromString("rw-r--r--"));
        Files.writeString(dir.resolve("identity.key.0011223344556677.tmp"), "half");
        keys();
        assertThat(mode(dir)).isEqualTo("rwx------");
        assertThat(mode(identity)).isEqualTo("rw-------");
        assertThat(files()).noneMatch(p -> p.toString().endsWith(".tmp"));
    }

    @Test
    void aDamagedIdentityIsSetAsideAndANewOneSaysSo() throws Exception {
        DeskKeys first = keys();
        PublishedKeys before = first.publicKeys();
        BoxKeyPair oldBox = first.recipient().boxKeys().get(0);
        Path identity = dir.resolve(DeskKeyStore.IDENTITY);
        byte[] b = Files.readAllBytes(identity);
        b[20] ^= 1;
        Files.write(identity, b);
        DeskKeys after = keys();
        assertThat(after.available()).isTrue();
        assertThat(after.publicKeys().identityKey()).isNotEqualTo(before.identityKey());
        assertThat(after.status().get("replacedAt")).isEqualTo(clock.millis());
        assertThat(Files.exists(dir.resolve("identity.key.bad-1"))).isTrue();
        // The old box key stays, to open what's waiting; the new identity binds a new current one.
        List<BoxKeyPair> boxes = after.recipient().boxKeys();
        assertThat(boxes).hasSize(2);
        assertThat(boxes.get(1).publicKey()).isEqualTo(oldBox.publicKey());
        assertThat(after.publicKeys().boxKey()).isNotEqualTo(oldBox.publicKey());
        // A link in its place is set aside too, never followed.
        Files.delete(identity);
        Files.createSymbolicLink(identity, tmp.resolve("elsewhere"));
        assertThat(keys().available()).isTrue();
        assertThat(Files.isSymbolicLink(dir.resolve("identity.key.bad-2"))).isTrue();
    }

    @Test
    void aDamagedOrMisnamedBoxKeyIsSetAside() throws Exception {
        DeskKeys k = keys();
        Path box = dir.resolve(DeskKeyStore.boxName(k.recipient().boxKeys().get(0)));
        Files.move(box, dir.resolve("box-00000000000000000000000000000000.key"));
        DeskKeys again = keys();
        assertThat(again.available()).isTrue();
        assertThat(files()).anyMatch(p -> p.getFileName().toString().equals("box-00000000000000000000000000000000.key.bad-1"));
        assertThat(again.recipient().boxKeys()).hasSize(1);
        Path now = dir.resolve(DeskKeyStore.boxName(again.recipient().boxKeys().get(0)));
        Files.write(now, new byte[] {1, 2, 3});
        assertThat(keys().recipient().boxKeys()).hasSize(1);
        assertThat(Files.exists(Path.of(now + ".bad-1"))).isTrue();
    }

    @Test
    void theBoxKeyRotatesOnScheduleOldOnesOpenUntilTheyExpire() throws Exception {
        DeskKeys k = keys();
        k.addresses(ME, List.of());
        k.maintain();
        assertThat(published).hasSize(1);
        PublishedKeys first = k.publicKeys();
        IdentityKeyPair dana = IdentityKeyPair.generate(new SecureRandom());
        Envelope.Sealed early = Signed.seal(dana, first, payload("before"));

        clock.advance(Duration.ofDays(179));
        k.maintain();
        assertThat(k.publicKeys().sameKeys(first)).isTrue();
        assertThat(published).hasSize(1);

        clock.advance(Duration.ofDays(1));
        k.maintain();
        PublishedKeys second = k.publicKeys();
        assertThat(second.identityKey()).isEqualTo(first.identityKey());
        assertThat(second.boxKey()).isNotEqualTo(first.boxKey());
        assertThat(published).hasSize(2).last().isEqualTo(second);
        assertThat(k.recipient().boxKeys()).hasSize(2);
        assertThat(Signed.open("ma", k.recipient(), early.enc(), early.ct()).payload().get("text")).isEqualTo("before");

        clock.advance(Duration.ofMillis(DeskKeyStore.RETAIN - 1));
        k.maintain();
        assertThat(k.recipient().boxKeys()).hasSize(2);
        clock.advance(Duration.ofMillis(1));
        k.maintain();
        assertThat(k.recipient().boxKeys()).hasSize(1);
        assertThat(files()).hasSize(2);
        assertThatThrownBy(() -> Signed.open("ma", k.recipient(), early.enc(), early.ct()))
                .isInstanceOfSatisfying(EnvelopeException.class, e -> assertThat(e.reason()).isEqualTo(EnvelopeException.CANNOT_OPEN));
        // The current key is never expired, however old.
        clock.advance(Duration.ofDays(5000));
        assertThat(keys().recipient().boxKeys()).isNotEmpty();
    }

    @Test
    void publishingRetriesWaitsAndStops() throws Exception {
        DeskKeys k = keys();
        may.set(false);
        k.maintain();
        assertThat(published).isEmpty();
        may.set(true);
        next = new KeyPublisher.Result(KeyPublisher.Outcome.LATER, -1, null, Duration.ofMinutes(30), "courier_paused");
        k.maintain();
        assertThat(published).hasSize(1);
        assertThat((Map<String, Object>) k.status().get("published")).containsEntry("current", false).containsEntry("problem", "courier_paused");
        k.maintain();
        assertThat(published).hasSize(1);
        clock.advance(Duration.ofMinutes(31));
        next = null;
        k.maintain();
        assertThat(published).hasSize(2);
        assertThat((Map<String, Object>) k.status().get("published")).containsEntry("current", true).containsEntry("keysVersion", 2L);
        k.maintain();
        assertThat(published).hasSize(2);

        DeskKeys guild = new DeskKeys(DeskKeys.Settings.defaults(dir), clock, keys -> {
            published.add(keys);
            return new KeyPublisher.Result(KeyPublisher.Outcome.NEVER, -1, null, null, "desk_kind");
        }, () -> true);
        guild.maintain();
        guild.maintain();
        assertThat(published).hasSize(3);
    }

    @Test
    void aResetMakesANewIdentityAndKeepsTheOldBoxKeys() throws Exception {
        DeskKeys k = keys();
        k.addresses(ME, List.of());
        k.maintain();
        PublishedKeys before = k.publicKeys();
        Envelope.Sealed waiting = Signed.seal(IdentityKeyPair.generate(new SecureRandom()), before, payload("waiting"));
        k.resetIdentity();
        assertThat(k.publicKeys().identityKey()).isNotEqualTo(before.identityKey());
        assertThat(published).last().isEqualTo(k.publicKeys());
        assertThat(Signed.open("ma", k.recipient(), waiting.enc(), waiting.ct()).payload().get("text")).isEqualTo("waiting");
        assertThat(keys().publicKeys().sameKeys(k.publicKeys())).isTrue();
    }

    @Test
    void closedAddressesStillOpen() throws Exception {
        DeskKeys k = keys();
        k.addresses(ME, List.of());
        Envelope.Sealed s = Signed.seal(IdentityKeyPair.generate(new SecureRandom()), k.publicKeys(), payload("hi"));
        k.addresses("samuel@courier.example", List.of("SAM@courier.example"));
        assertThat(Signed.open("ma", k.recipient(), s.enc(), s.ct()).to()).isEqualTo(ME);
    }

    @Test
    void aWriteThatFailsLeavesNothingAndNoKeys() throws Exception {
        DeskKeyStore failing = new DeskKeyStore(dir, new SecureRandom(), channel -> {
            throw new IOException("disk full");
        });
        DeskKeys k = new DeskKeys(failing, DeskKeys.Settings.defaults(dir), clock, publisher, may::get);
        assertThat(k.available()).isFalse();
        assertThat(k.status()).containsEntry("reason", "unreadable");
        assertThat(files()).isEmpty();
    }

    @Test
    void noKeyMaterialReachesALogOrTheStatus() throws Exception {
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        Level was = root.getLevel();
        root.setLevel(Level.TRACE);
        List<String> secrets = new ArrayList<>();
        String status;
        try {
            DeskKeys k = keys();
            k.maintain();
            clock.advance(Duration.ofDays(181));
            k.maintain();
            byte[] b = Files.readAllBytes(dir.resolve(DeskKeyStore.IDENTITY));
            b[30] ^= 1;
            Files.write(dir.resolve(DeskKeyStore.IDENTITY), b);
            DeskKeys again = keys();
            again.resetIdentity();
            status = String.valueOf(again.status()) + k.status();
            for (DeskKeys d : List.of(k, again)) {
                byte[] seed = d.identity().seed();
                secrets.add(HexFormat.of().formatHex(seed));
                secrets.add(Base64.getEncoder().encodeToString(seed));
                secrets.add(Base64.getUrlEncoder().withoutPadding().encodeToString(seed));
                for (BoxKeyPair box : d.recipient().boxKeys()) {
                    byte[] s = box.secret();
                    secrets.add(HexFormat.of().formatHex(s));
                    secrets.add(Base64.getEncoder().encodeToString(s));
                    secrets.add(Base64.getUrlEncoder().withoutPadding().encodeToString(s));
                }
            }
        } finally {
            root.detachAppender(logs);
            root.setLevel(was);
        }
        StringBuilder all = new StringBuilder(status);
        for (ILoggingEvent e : logs.list) {
            all.append(e.getFormattedMessage()).append(' ');
            if (e.getThrowableProxy() != null) {
                all.append(e.getThrowableProxy().getMessage());
            }
        }
        assertThat(logs.list).isNotEmpty();
        for (String s : secrets) {
            assertThat(all.toString()).doesNotContain(s);
        }
    }

    private static Map<String, Object> payload(String text) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", "message");
        p.put("id", "01JCQ4V9X3M7K2P8R5T6W0Y1Z2");
        p.put("from", "dana@courier.example");
        p.put("to", ME);
        p.put("at", "2026-11-14T12:00:00.000Z");
        p.put("text", text);
        return p;
    }

    @Test
    void aKeyFileFromALaterReleaseLeavesTheKeysWaitingAndUntouched() throws Exception {
        keys();
        Path identity = dir.resolve(DeskKeyStore.IDENTITY);
        byte[] b = Files.readAllBytes(identity);
        b[4] = 2;   // a later format's version
        Files.write(identity, b);
        DeskKeys k = keys();
        assertThat(k.available()).isFalse();
        assertThat(Files.readAllBytes(identity)).isEqualTo(b);
        assertThat(files()).noneMatch(p -> p.toString().contains(".bad-"));
        // A later format of another size, too.
        byte[] longer = java.util.Arrays.copyOf(b, 120);
        Files.write(identity, longer);
        assertThat(keys().available()).isFalse();
        assertThat(Files.readAllBytes(identity)).isEqualTo(longer);
    }

    @Test
    void aMissingIdentityBesideBoxKeysIsAReplacementAndSaysSo() throws Exception {
        DeskKeys first = keys();
        BoxKeyPair oldBox = first.recipient().boxKeys().get(0);
        Files.delete(dir.resolve(DeskKeyStore.IDENTITY));
        DeskKeys after = keys();
        assertThat(after.status().get("replacedAt")).isEqualTo(clock.millis());
        assertThat(after.recipient().boxKeys()).hasSize(2);
        assertThat(after.publicKeys().boxKey()).isNotEqualTo(oldBox.publicKey());
    }
}
