package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assumptions.assumeFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** The volume's record as desk-firstboot and desk-datadirs write it, and as it might be otherwise. */
@ExtendWith(OutputCaptureExtension.class)
class DataVolumeTest {

    private static final String IGNORED = "volume record ignored";

    @TempDir
    Path dir;

    private Path file() {
        return dir.resolve("volume.json");
    }

    private DataVolume.VolumeRecord readBack(String content) throws Exception {
        Files.writeString(file(), content);
        return new DataVolume(dir).volumeRecord();
    }

    private static long ignoredLines(CapturedOutput output) {
        return output.getOut().lines().filter(line -> line.contains(IGNORED)).count();
    }

    @Test
    void noFileIsNoRecordAndNothingToSay(CapturedOutput output) {
        assertThat(new DataVolume(dir).volumeRecord()).isNull();
        assertThat(ignoredLines(output)).isZero();
    }

    @Test
    void noDirectoryIsNoRecordAndNothingToSay(CapturedOutput output) {
        assertThat(new DataVolume(dir.resolve("gone")).volumeRecord()).isNull();
        assertThat(ignoredLines(output)).isZero();
    }

    @Test
    void aVolumeFormattedByFirstbootKeepsItsIdAndTime() throws Exception {
        assertThat(readBack("{\"volumeId\":\"vol-0abc123\",\"formattedAt\":\"2026-11-06T02:00:00Z\",\"image\":\"0.2.3\"}\n"))
                .isEqualTo(new DataVolume.VolumeRecord("vol-0abc123", "2026-11-06T02:00:00Z"));
    }

    @Test
    void aVolumeOlderThanTheRecordHasNoFormatTime() throws Exception {
        assertThat(readBack("{\"volumeId\":\"vol-0abc123\",\"formattedAt\":null,\"firstSeenAt\":\"2026-11-06T02:00:00Z\"}\n"))
                .isEqualTo(new DataVolume.VolumeRecord("vol-0abc123", null));
    }

    @Test
    void anUnknownVolumeIdIsAllowedAsThatOneWord() throws Exception {
        assertThat(readBack("{\"volumeId\":\"unknown\",\"formattedAt\":null,\"firstSeenAt\":\"2026-11-06T02:00:00Z\"}\n"))
                .isEqualTo(new DataVolume.VolumeRecord("unknown", null));
    }

    @Test
    void theLongestVolumeIdFits() throws Exception {
        String longest = "vol-" + "0123456789abcdef".repeat(2);
        assertThat(readBack("{\"volumeId\":\"" + longest + "\",\"formattedAt\":null}").volumeId()).isEqualTo(longest);
    }

    @Test
    void whatsSentIsInstantsOwnTextOfTheTime() throws Exception {
        assertThat(readBack("{\"volumeId\":\"unknown\",\"formattedAt\":\"2026-11-06T04:00:00+02:00\"}").formattedAt())
                .isEqualTo("2026-11-06T02:00:00Z");
    }

    @Test
    void anythingElseIsNoRecordWithOneLineAndNoneOfItsContent(CapturedOutput output) throws Exception {
        List<String> contents = List.of(
                "",
                "not-json SECRETWORD",
                "[\"SECRETWORD\"]",
                "null",
                "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null} SECRETWORD",
                "{\"volumeId\":\"vol-0abc\",\"volumeId\":\"vol-1\",\"formattedAt\":null,\"x\":\"SECRETWORD\"}",
                // Not a volume id: empty, too long, upper case, and things that would pass a looser check.
                "{\"formattedAt\":null,\"x\":\"SECRETWORD\"}",
                "{\"volumeId\":null,\"formattedAt\":null}",
                "{\"volumeId\":7,\"formattedAt\":null}",
                "{\"volumeId\":\"vol-\",\"formattedAt\":null}",
                "{\"volumeId\":\"vol-" + "0".repeat(33) + "\",\"formattedAt\":null}",
                "{\"volumeId\":\"vol-0ABC\",\"formattedAt\":null}",
                "{\"volumeId\":\"vol-0abc\\n\",\"formattedAt\":null}",
                "{\"volumeId\":\"Unknown\",\"formattedAt\":null}",
                "{\"volumeId\":\"SECRETWORD\",\"formattedAt\":null}",
                // Not a time.
                "{\"volumeId\":\"vol-0abc\"}",
                "{\"volumeId\":\"vol-0abc\",\"formattedAt\":\"SECRETWORD\"}",
                "{\"volumeId\":\"vol-0abc\",\"formattedAt\":\"2026-11-06\"}",
                "{\"volumeId\":\"vol-0abc\",\"formattedAt\":1762394400}",
                "{\"volumeId\":\"vol-0abc\",\"formattedAt\":{}}");
        long lines = 0;
        for (String content : contents) {
            assertThat(readBack(content)).as(content).isNull();
            assertThat(ignoredLines(output)).as(content).isEqualTo(++lines);
        }
        assertThat(output.getAll()).doesNotContain("SECRETWORD");
    }

    @Test
    void aRecordPastTheLimitIsntRead(CapturedOutput output) throws Exception {
        String padded = "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null,\"pad\":\"";
        String tooLong = padded + "x".repeat(DataVolume.MAX_RECORD_BYTES - padded.length()) + "\"}";
        assertThat(readBack(tooLong)).isNull();
        assertThat(output.getOut()).contains(IGNORED + ": too large");
    }

    @Test
    void aRecordRightAtTheLimitIsRead() throws Exception {
        String start = "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null,\"pad\":\"";
        String exact = start + "x".repeat(DataVolume.MAX_RECORD_BYTES - start.length() - 2) + "\"}";
        assertThat(exact).hasSize(DataVolume.MAX_RECORD_BYTES);
        assertThat(readBack(exact)).isEqualTo(new DataVolume.VolumeRecord("vol-0abc", null));
    }

    @Test
    void aSymlinkIsNotFollowedEvenToAGoodRecord(CapturedOutput output) throws Exception {
        Path real = dir.resolve("elsewhere.json");
        Files.writeString(real, "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null}");
        Files.createSymbolicLink(file(), real);
        assertThat(new DataVolume(dir).volumeRecord()).isNull();
        assertThat(output.getOut()).contains(IGNORED + ": not a regular file");
    }

    @Test
    void aSymlinkToNothingIsThatToo(CapturedOutput output) throws Exception {
        Files.createSymbolicLink(file(), dir.resolve("nothing"));
        assertThat(new DataVolume(dir).volumeRecord()).isNull();
        assertThat(output.getOut()).contains(IGNORED + ": not a regular file");
    }

    @Test
    void aDirectoryIsntARecord(CapturedOutput output) throws Exception {
        Files.createDirectory(file());
        assertThat(new DataVolume(dir).volumeRecord()).isNull();
        assertThat(output.getOut()).contains(IGNORED + ": not a regular file");
    }

    /** Opening one for reading would park until a writer came, and this is on the heartbeat's thread. */
    @Test
    void aFifoIsntOpened(CapturedOutput output) throws Exception {
        assertThat(new ProcessBuilder("mkfifo", file().toString()).start().waitFor()).isZero();
        assertTimeoutPreemptively(Duration.ofSeconds(10), () -> assertThat(new DataVolume(dir).volumeRecord()).isNull());
        assertThat(output.getOut()).contains(IGNORED + ": not a regular file");
    }

    @Test
    void aFileThatCantBeReadIsNoRecord(CapturedOutput output) throws Exception {
        Files.writeString(file(), "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null}");
        assumeTrue(file().toFile().setReadable(false), "permissions apply here");
        assumeFalse(Files.isReadable(file()), "not as root");
        assertThat(new DataVolume(dir).volumeRecord()).isNull();
        assertThat(output.getOut()).contains(IGNORED + ": unreadable");
    }

    @Test
    void itsReadOnceAndKept(CapturedOutput output) throws Exception {
        DataVolume volume = new DataVolume(dir);
        Files.writeString(file(), "{\"volumeId\":\"vol-0abc\",\"formattedAt\":null}");
        assertThat(volume.volumeRecord().volumeId()).isEqualTo("vol-0abc");
        Files.writeString(file(), "{\"volumeId\":\"vol-0def\",\"formattedAt\":null}");
        assertThat(volume.volumeRecord().volumeId()).isEqualTo("vol-0abc");
        Files.delete(file());
        assertThat(volume.volumeRecord().volumeId()).isEqualTo("vol-0abc");
    }

    @Test
    void aBadOneSaysSoOnceHoweverOftenItsAskedFor(CapturedOutput output) throws Exception {
        DataVolume volume = new DataVolume(dir);
        Files.writeString(file(), "garbage");
        for (int i = 0; i < 3; i++) {
            assertThat(volume.volumeRecord()).isNull();
        }
        assertThat(ignoredLines(output)).isEqualTo(1);
    }
}
