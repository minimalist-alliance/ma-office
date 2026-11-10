package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** {@code /data/desk/age-band}, whose bytes the image reads as root, and what each answer of the Platform does to it. */
@ExtendWith(OutputCaptureExtension.class)
class AgeBandTest {

    private static final Map<String, Object> TEEN = Map.of("ageBand", "teen");
    private static final Map<String, Object> ADULT = Map.of("ageBand", "adult");
    private static final Map<String, Object> NO_FIELD = Map.of("configVersion", 1);

    @TempDir
    Path dir;

    private Path file() {
        return dir.resolve(AgeBand.FILE);
    }

    private AgeBand band() {
        return new AgeBand(file());
    }

    private String onDisk() throws IOException {
        return new String(Files.readAllBytes(file()), StandardCharsets.ISO_8859_1);
    }

    private void withDirectoryReadOnly(ThrowingRunnable body) throws Exception {
        Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("r-xr-xr-x"));
        try {
            // Root writes anywhere, so a read-only directory proves nothing there.
            assumeFalse(Files.isWritable(dir));
            body.run();
        } finally {
            Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
        }
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static int count(String text, String part) {
        return text.split(java.util.regex.Pattern.quote(part), -1).length - 1;
    }

    // ---- the file

    @Test
    void theBytesAndModeAreExactlyWhatTheImageReads() throws Exception {
        AgeBand band = band();
        band.fromConfig(TEEN);
        assertThat(Files.readAllBytes(file())).containsExactly('t', 'e', 'e', 'n', '\n');
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file()))).isEqualTo("rw-------");

        band.fromConfig(ADULT);
        assertThat(Files.readAllBytes(file())).containsExactly('a', 'd', 'u', 'l', 't', '\n');
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file()))).isEqualTo("rw-------");

        try (var left = Files.list(dir)) {
            assertThat(left).containsExactly(file());
        }
    }

    @Test
    void aFileThatAlreadySaysItIsLeftAlone() throws Exception {
        band().fromConfig(ADULT);
        Object before = Files.readAttributes(file(), java.nio.file.attribute.BasicFileAttributes.class).fileKey();
        band().fromConfig(ADULT);
        assertThat(Files.readAttributes(file(), java.nio.file.attribute.BasicFileAttributes.class).fileKey()).isEqualTo(before);
    }

    @Test
    void aTempFileACrashLeftBehindIsNoObstacle() throws Exception {
        Files.writeString(dir.resolve(".age-band.tmp"), "adu");
        band().fromConfig(TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(dir.resolve(".age-band.tmp")).doesNotExist();
    }

    @Test
    void aFileThatChangedBehindItsBackIsWrittenAgain() throws Exception {
        AgeBand band = band();
        band.fromConfig(TEEN);
        Files.delete(file());
        band.fromConfig(TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
    }

    // ---- at startup

    @Test
    void itSurvivesARestart() {
        AgeBand first = band();
        first.fromConfig(TEEN);
        assertThat(band().band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(band().browserMayStart()).isTrue();

        first.fromConfig(ADULT);
        assertThat(band().band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(band().browserMayStart()).isTrue();
    }

    @Test
    void aMissingFileIsUnknownAndChromiumWaits() {
        AgeBand band = band();
        assertThat(band.band()).isNull();
        assertThat(band.browserMayStart()).isFalse();
        assertThat(band.wantsAnotherRead()).isTrue();
    }

    @Test
    void anythingButExactlyOneOfTheTwoLinesIsTeen() throws Exception {
        for (String junk : List.of("", "teen", "adult", "TEEN\n", "teen\n\n", " adult\n", "adult\r\n", "adult\nmore", "unknown\n")) {
            Files.writeString(file(), junk);
            assertThat(band().band()).as("%s", junk).isEqualTo(AgeBand.Band.TEEN);
            // As the image locks it too.
            assertThat(band().browserMayStart()).as("%s", junk).isTrue();
        }
        Files.write(file(), new byte[100_000]);
        assertThat(band().band()).isEqualTo(AgeBand.Band.TEEN);
    }

    @Test
    void aLinkOrADirectoryIsTeen() throws Exception {
        Path other = dir.resolve("other");
        Files.writeString(other, "adult\n");
        Files.createSymbolicLink(file(), other);
        assertThat(band().band()).isEqualTo(AgeBand.Band.TEEN);

        Files.delete(file());
        Files.createDirectory(file());
        assertThat(band().band()).isEqualTo(AgeBand.Band.TEEN);
    }

    @Test
    void aFileItCantReadIsTeen() throws Exception {
        Files.writeString(file(), "adult\n");
        Files.setPosixFilePermissions(file(), PosixFilePermissions.fromString("---------"));
        try {
            // Root reads anything, so this proves nothing there.
            assumeFalse(Files.isReadable(file()));
            assertThat(band().band()).isEqualTo(AgeBand.Band.TEEN);
        } finally {
            Files.setPosixFilePermissions(file(), PosixFilePermissions.fromString("rw-------"));
        }
    }

    @Test
    void writingOverALinkReplacesItAndLeavesWhatItNamed() throws Exception {
        Path other = dir.resolve("other");
        Files.writeString(other, "something of its own\n");
        Files.createSymbolicLink(file(), other);
        band().fromConfig(TEEN);
        assertThat(Files.isSymbolicLink(file())).isFalse();
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(Files.readString(other)).isEqualTo("something of its own\n");
    }

    // ---- what the Platform says

    @Test
    void noFieldInHellosCopySaysNothingAndWritesNothing() throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand band = band();
        assertThat(band.fromHello(NO_FIELD)).isFalse();
        assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
    }

    @Test
    void hellosCopyIsBelievedWhenItHasTheField() throws Exception {
        AgeBand band = band();
        assertThat(band.fromHello(TEEN)).isTrue();
        assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
    }

    @Test
    void anyOtherValueIsIgnoredLoggedOnceAndWhatsOnDiskStands(CapturedOutput output) throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand band = band();
        Map<String, Object> isNull = new HashMap<>();
        isNull.put("ageBand", null);
        band.fromConfig(isNull);
        band.fromConfig(Map.of("ageBand", "zebra-value"));
        band.fromConfig(Map.of("ageBand", 17));
        assertThat(band.fromHello(Map.of("ageBand", "zebra-value"))).isTrue();

        assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(count(output.getAll(), "isn't one deskd knows")).isEqualTo(1);
        assertThat(output.getAll()).doesNotContain("zebra-value").doesNotContain("age band:");
    }

    @Test
    void anOddValueOnAnUnknownDeskLeavesItUnknownAndAsksAgain() {
        AgeBand band = band();
        band.fromConfig(Map.of("ageBand", "zebra-value"));
        assertThat(band.band()).isNull();
        assertThat(band.browserMayStart()).isFalse();
        assertThat(band.wantsAnotherRead()).isTrue();
        assertThat(file()).doesNotExist();
    }

    // ---- a missing field never lowers the band (TD-2)

    @Test
    void aTeensFileOutlastsAConfigWithNoField() throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand band = band();
        Object before = Files.readAttributes(file(), java.nio.file.attribute.BasicFileAttributes.class).fileKey();
        band.fromConfig(NO_FIELD);
        band.fromConfig(NO_FIELD);
        assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(Files.readAttributes(file(), java.nio.file.attribute.BasicFileAttributes.class).fileKey()).isEqualTo(before);
        assertThat(band.browserMayStart()).isTrue();
        assertThat(band.wantsAnotherRead()).isFalse();
        // And after a restart, as the file is the same.
        assertThat(band().band()).isEqualTo(AgeBand.Band.TEEN);
    }

    @Test
    void aTeenSaidInThisProcessOutlastsAConfigWithNoField() throws Exception {
        AgeBand band = band();
        band.fromConfig(TEEN);
        band.fromConfig(NO_FIELD);
        assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(band.wantsAnotherRead()).isFalse();
    }

    @Test
    void aTeenComesDownOnlyOnAnExplicitAdult() throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand fromTheGet = band();
        fromTheGet.fromConfig(NO_FIELD);
        fromTheGet.fromConfig(ADULT);
        assertThat(fromTheGet.band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(onDisk()).isEqualTo("adult\n");

        Files.writeString(file(), "teen\n");
        AgeBand fromHello = band();
        assertThat(fromHello.fromHello(NO_FIELD)).isFalse();
        assertThat(fromHello.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(fromHello.fromHello(ADULT)).isTrue();
        assertThat(fromHello.band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(onDisk()).isEqualTo("adult\n");
    }

    @Test
    void anExplicitTeenRaisesAnAdultAtOnce() throws Exception {
        Files.writeString(file(), "adult\n");
        AgeBand fromTheGet = band();
        List<String> locks = new ArrayList<>();
        fromTheGet.onLockBegins(() -> locks.add("get"));
        fromTheGet.fromConfig(TEEN);
        assertThat(fromTheGet.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");

        Files.writeString(file(), "adult\n");
        AgeBand fromHello = band();
        fromHello.onLockBegins(() -> locks.add("hello"));
        assertThat(fromHello.fromHello(TEEN)).isTrue();
        assertThat(fromHello.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(locks).containsExactly("get", "hello");
    }

    @Test
    void noFileAndNoFieldIsAnAdultAsOnMainAndTheDefaultIsWritten(CapturedOutput output) throws Exception {
        AgeBand band = band();
        band.fromConfig(NO_FIELD);
        band.fromConfig(NO_FIELD);
        assertThat(band.band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(band.browserMayStart()).isTrue();
        assertThat(band.wantsAnotherRead()).isFalse();
        assertThat(onDisk()).isEqualTo("adult\n");
        assertThat(count(output.getAll(), "from the default")).isEqualTo(1);
        // After a restart the file says it.
        assertThat(band().band()).isEqualTo(AgeBand.Band.ADULT);
    }

    @Test
    void anAdultsFileStaysAdultOnAConfigWithNoField() throws Exception {
        Files.writeString(file(), "adult\n");
        AgeBand band = band();
        band.fromConfig(NO_FIELD);
        assertThat(band.band()).isEqualTo(AgeBand.Band.ADULT);
        assertThat(band.browserMayStart()).isTrue();
        assertThat(onDisk()).isEqualTo("adult\n");
    }

    @Test
    void noFieldInHellosCopyOnADeskWithNoFileWritesNothingAndLeavesItToTheGet() throws Exception {
        AgeBand band = band();
        assertThat(band.fromHello(NO_FIELD)).isFalse();
        assertThat(band.band()).isNull();
        assertThat(file()).doesNotExist();
    }

    @Test
    void aCorruptFileIsTeenUntilAnExplicitAnswer() throws Exception {
        for (String junk : List.of("", "adult", "ADULT\n", "adult\r\n", "adult\n\n", "adult\nmore", "unknown\n")) {
            Files.writeString(file(), junk);
            AgeBand band = band();
            assertThat(band.band()).as("%s", junk).isEqualTo(AgeBand.Band.TEEN);
            // The image locks anything but exactly adult, so Chromium may start.
            assertThat(band.browserMayStart()).as("%s", junk).isTrue();

            band.fromConfig(NO_FIELD);
            assertThat(band.band()).as("%s", junk).isEqualTo(AgeBand.Band.TEEN);
            assertThat(onDisk()).as("%s", junk).isEqualTo(junk);
            assertThat(band.wantsAnotherRead()).as("%s", junk).isFalse();
            assertThat(band.fromHello(NO_FIELD)).isFalse();
            assertThat(band.band()).as("%s", junk).isEqualTo(AgeBand.Band.TEEN);

            band.fromConfig(ADULT);
            assertThat(band.band()).as("%s", junk).isEqualTo(AgeBand.Band.ADULT);
            assertThat(onDisk()).as("%s", junk).isEqualTo("adult\n");
        }

        Files.writeString(file(), "garbage");
        AgeBand band = band();
        List<String> locks = new ArrayList<>();
        band.onLockBegins(() -> locks.add("lock"));
        assertThat(band.fromHello(TEEN)).isTrue();
        assertThat(onDisk()).isEqualTo("teen\n");
        // It was teen already, and the image had it locked.
        assertThat(locks).isEmpty();
    }

    @Test
    void aFileThatTurnedTeenBehindItsBackIsTeenAtTheNextConfigWithNoField() throws Exception {
        Files.writeString(file(), "adult\n");
        AgeBand band = band();
        List<String> locks = new ArrayList<>();
        band.onLockBegins(() -> locks.add("lock"));
        band.fromConfig(NO_FIELD);
        assertThat(band.band()).isEqualTo(AgeBand.Band.ADULT);

        Files.writeString(file(), "teen\n");
        band.fromConfig(NO_FIELD);
        assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(locks).containsExactly("lock");
    }

    @Test
    void aConfigWithNoFieldLogsTheBandOnceAndNothingElse(CapturedOutput output) throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand band = band();
        band.fromConfig(NO_FIELD);
        band.fromConfig(NO_FIELD);
        assertThat(count(output.getAll(), "age band: teen, kept")).isEqualTo(1);
        assertThat(output.getAll()).doesNotContain("to adult");

        band.fromConfig(ADULT);
        band.fromConfig(NO_FIELD);
        assertThat(count(output.getAll(), "age band: teen to adult")).isEqualTo(1);
        assertThat(count(output.getAll(), "age band: adult, kept")).isEqualTo(1);
    }

    // ---- who hears what

    @Test
    void onlyBecomingTeenBeginsALockAndItComesBeforeTheFileChanges() throws Exception {
        Files.writeString(file(), "adult\n");
        AgeBand band = band();
        List<String> seen = new ArrayList<>();
        band.onLockBegins(() -> {
            try {
                seen.add("lock, file says " + onDisk().trim() + ", band " + band.band().wire() + ", may start " + band.browserMayStart());
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        });
        band.onSettled(() -> seen.add("settled, may start " + band.browserMayStart()));

        band.fromConfig(ADULT);
        assertThat(seen).containsExactly("settled, may start true");
        seen.clear();

        band.fromConfig(TEEN);
        assertThat(seen).containsExactly("lock, file says adult, band teen, may start false", "settled, may start true");
        seen.clear();

        band.fromConfig(TEEN);
        assertThat(seen).containsExactly("settled, may start true");
        seen.clear();

        band.fromConfig(ADULT);
        assertThat(seen).containsExactly("settled, may start true");
    }

    @Test
    void unknownToTeenBeginsALockAsTheRunningChromiumCouldBeOnAnything() {
        AgeBand band = band();
        List<String> seen = new ArrayList<>();
        band.onLockBegins(() -> seen.add("lock"));
        band.fromConfig(TEEN);
        assertThat(seen).containsExactly("lock");
    }

    @Test
    void teenOnDiskToldTeenBeginsNoLock() throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand band = band();
        List<String> seen = new ArrayList<>();
        band.onLockBegins(() -> seen.add("lock"));
        band.fromConfig(TEEN);
        assertThat(seen).isEmpty();
    }

    // ---- a write that fails

    @Test
    void aFailedWriteLogsOnceLeavesTheOldFileAndKeepsATeensDeskGated(CapturedOutput output) throws Exception {
        Files.writeString(file(), "adult\n");
        AgeBand band = band();
        withDirectoryReadOnly(() -> {
            band.fromConfig(TEEN);
            band.fromConfig(TEEN);
            assertThat(onDisk()).isEqualTo("adult\n");
            assertThat(band.band()).isEqualTo(AgeBand.Band.TEEN);
            assertThat(band.browserMayStart()).isFalse();
            assertThat(band.wantsAnotherRead()).isTrue();
        });
        assertThat(count(output.getAll(), "couldn't write")).isEqualTo(1);
        try (var left = Files.list(dir)) {
            assertThat(left).containsExactly(file());
        }

        band.fromConfig(TEEN);
        assertThat(onDisk()).isEqualTo("teen\n");
        assertThat(band.browserMayStart()).isTrue();
        assertThat(band.wantsAnotherRead()).isFalse();
    }

    @Test
    void aFailedWriteOnTheSafeSideDoesntHoldTheBrowser() throws Exception {
        Files.writeString(file(), "teen\n");
        AgeBand band = band();
        withDirectoryReadOnly(() -> {
            band.fromConfig(ADULT);
            assertThat(onDisk()).isEqualTo("teen\n");
            assertThat(band.band()).isEqualTo(AgeBand.Band.ADULT);
            // The image reads teen, which is stricter than an adult needs, until a write works.
            assertThat(band.browserMayStart()).isTrue();
            assertThat(band.wantsAnotherRead()).isTrue();
        });
    }

    @Test
    void aTeenWithNoFileAndAFailedWriteIsLockedByTheImageSoTheBrowserStarts() throws Exception {
        AgeBand band = band();
        withDirectoryReadOnly(() -> {
            band.fromConfig(TEEN);
            assertThat(file()).doesNotExist();
            assertThat(band.browserMayStart()).isTrue();
            assertThat(band.wantsAnotherRead()).isTrue();
        });
    }

    @Test
    void aTargetThatCantBeReplacedFailsTheSameWay(CapturedOutput output) throws Exception {
        Files.createDirectory(file());
        Files.writeString(file().resolve("in-the-way"), "x");
        AgeBand band = band();
        band.fromConfig(TEEN);
        assertThat(Files.isDirectory(file(), LinkOption.NOFOLLOW_LINKS)).isTrue();
        assertThat(dir.resolve(".age-band.tmp")).doesNotExist();
        assertThat(output.getAll()).contains("couldn't write");
    }

    // ---- the log

    @Test
    void theLogHasTheTransitionAndNothingElse(CapturedOutput output) {
        AgeBand band = band();
        band.fromConfig(ADULT);
        band.fromConfig(ADULT);
        band.fromConfig(TEEN);
        band.fromConfig(ADULT);
        assertThat(count(output.getAll(), "age band: unknown to adult")).isEqualTo(1);
        assertThat(count(output.getAll(), "age band: adult to teen")).isEqualTo(1);
        assertThat(count(output.getAll(), "age band: teen to adult")).isEqualTo(1);
    }
}
