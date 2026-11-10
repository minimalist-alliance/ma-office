package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Files being attached, held in memory (ADR 0049). */
class StagingTest {

    private MutableClock clock;
    private Staging staging;

    @BeforeEach
    void start() {
        clock = new MutableClock(Rig.START);
        staging = new Staging(clock, 1 << 20);
    }

    @AfterEach
    void stop() {
        staging.close();
    }

    private static byte[] text(int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, (byte) 'a');
        return bytes;
    }

    private static void assertReason(AttachExceptionCall call, String reason) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(AttachException.class,
                e -> assertThat(e.reason()).isEqualTo(reason));
    }

    @FunctionalInterface
    interface AttachExceptionCall {
        void run() throws Exception;
    }

    @Test
    void chunksComeInOrderAndTheFileIsWholeAtTheEnd() throws Exception {
        byte[] file = text(1000);
        Staging.Receipt first = staging.put("owner", "manager", "upload-0001", "a.txt", 1000, 0,
                Arrays.copyOfRange(file, 0, 600), Caps.DEFAULT);
        assertThat(first.complete()).isFalse();
        assertThat(first.received()).isEqualTo(600);
        // A chunk out of order drops the whole upload.
        assertReason(() -> staging.put("owner", "manager", "upload-0001", "a.txt", 1000, 2,
                Arrays.copyOfRange(file, 600, 1000), Caps.DEFAULT), "bad_upload");
        assertThat(staging.count()).isZero();
        assertThat(staging.heldBytes()).isZero();

        staging.put("owner", "manager", "upload-0002", "a.txt", 1000, 0, Arrays.copyOfRange(file, 0, 600), Caps.DEFAULT);
        Staging.Receipt last = staging.put("owner", "manager", "upload-0002", "a.txt", 1000, 1,
                Arrays.copyOfRange(file, 600, 1000), Caps.DEFAULT);
        assertThat(last.complete()).isTrue();
        List<Staging.Staged> taken = staging.take("owner", "manager", List.of("upload-0002"), Caps.DEFAULT);
        assertThat(taken).singleElement().satisfies(staged -> {
            assertThat(staged.name()).isEqualTo("a.txt");
            assertThat(staged.bytes()).isEqualTo(file);
        });
        assertThat(staging.count()).isZero();
        assertThat(staging.heldBytes()).isZero();
    }

    @Test
    void anIncompleteFileCantBeTaken() throws Exception {
        staging.put("owner", "manager", "upload-0003", "a.txt", 1000, 0, text(500), Caps.DEFAULT);
        assertReason(() -> staging.take("owner", "manager", List.of("upload-0003"), Caps.DEFAULT), "missing");
        assertThat(staging.count()).isEqualTo(1);
    }

    @Test
    void takenFilesComeInTheOrderAsked() throws Exception {
        for (String id : List.of("upload-aaaa", "upload-bbbb", "upload-cccc")) {
            staging.put("owner", "manager", id, id + ".txt", 10, 0, text(10), Caps.DEFAULT);
        }
        assertThat(staging.take("owner", "manager", List.of("upload-cccc", "upload-aaaa"), Caps.DEFAULT))
                .extracting(Staging.Staged::name).containsExactly("upload-cccc.txt", "upload-aaaa.txt");
        assertThat(staging.count()).isEqualTo(1);
    }

    @Test
    void aFileExpiresTenMinutesAfterItsLastChunkAndIsZeroed() throws Exception {
        staging.put("owner", "manager", "upload-0004", "a.txt", 1000, 0, text(500), Caps.DEFAULT);
        clock.advance(Duration.ofMinutes(9));
        staging.sweep();
        assertThat(staging.count()).isEqualTo(1);
        // A chunk renews it.
        staging.put("owner", "manager", "upload-0004", "a.txt", 1000, 1, text(500), Caps.DEFAULT);
        clock.advance(Duration.ofMinutes(9));
        staging.sweep();
        assertThat(staging.count()).isEqualTo(1);
        clock.advance(Duration.ofMinutes(2));
        staging.sweep();
        assertThat(staging.count()).isZero();
        assertThat(staging.heldBytes()).isZero();
        assertReason(() -> staging.take("owner", "manager", List.of("upload-0004"), Caps.DEFAULT), "missing");
    }

    @Test
    void aFileBelongsToItsMemberAndItsAgent() throws Exception {
        staging.put("gm-aaaa0001", "gm-aaaa0001", "upload-0005", "a.txt", 10, 0, text(10), Caps.DEFAULT);
        assertReason(() -> staging.take("gm-bbbb0001", "gm-aaaa0001", List.of("upload-0005"), Caps.DEFAULT), "missing");
        assertReason(() -> staging.take("gm-aaaa0001", "manager", List.of("upload-0005"), Caps.DEFAULT), "missing");
        // Another member can't remove it either.
        staging.remove("gm-bbbb0001", "upload-0005");
        assertThat(staging.count()).isEqualTo(1);
        // Nor add to it.
        assertReason(() -> staging.put("gm-bbbb0001", "gm-aaaa0001", "upload-0005", "a.txt", 10, 1, text(1), Caps.DEFAULT),
                "bad_upload");
        staging.remove("gm-aaaa0001", "upload-0005");
        assertThat(staging.count()).isZero();
    }

    @Test
    void theCapsHold() throws Exception {
        Caps small = new Caps(2, 2048, 2048, 4096, 1000, 2000, 5);
        assertReason(() -> staging.put("owner", "manager", "upload-0006", "a.txt", 3000, 0, text(100), small), "too_large");
        staging.put("owner", "manager", "upload-0007", "a.txt", 2000, 0, text(100), small);
        staging.put("owner", "manager", "upload-0008", "b.txt", 2000, 0, text(100), small);
        assertReason(() -> staging.put("owner", "manager", "upload-0009", "c.txt", 50, 0, text(50), small), "too_many");
        assertReason(() -> staging.put("owner", "manager", "upload-0014", "d.txt", 2000, 0, text(100), small),
                "too_many");
        // Another agent has its own count.
        staging.put("owner", "other-agent", "upload-0010", "c.txt", 100, 0, text(100), small);
        assertReason(() -> staging.take("owner", "manager", List.of("upload-0007", "upload-0008", "upload-0010"), small),
                "too_many");
    }

    @Test
    void oneMessagesFilesCantPassTheTotalEvenBeforeTheLastIsUp() throws Exception {
        Caps small = new Caps(5, 3000, 3000, 4000, 1000, 2000, 5);
        staging.put("owner", "manager", "upload-0015", "a.txt", 2500, 0, text(100), small);
        assertReason(() -> staging.put("owner", "manager", "upload-0016", "b.txt", 2500, 0, text(100), small),
                "total_too_large");
        staging.put("owner", "manager", "upload-0017", "c.txt", 1500, 0, text(100), small);
        staging.put("owner", "other-agent", "upload-0018", "d.txt", 2500, 0, text(100), small);
    }

    @Test
    void theWholeStagingHasACapAndAFreedFileMakesRoom() throws Exception {
        // 1 MiB overall.
        staging.put("owner", "a1", "upload-0011", "a.txt", 700_000, 0, text(1000), Caps.DEFAULT);
        assertReason(() -> staging.put("gm-bbbb0001", "gm-bbbb0001", "upload-0012", "b.txt", 700_000, 0, text(1000),
                Caps.DEFAULT), "staging_full");
        staging.remove("owner", "upload-0011");
        staging.put("gm-bbbb0001", "gm-bbbb0001", "upload-0012", "b.txt", 700_000, 0, text(1000), Caps.DEFAULT);
        assertThat(staging.heldBytes()).isEqualTo(700_000);
    }

    @Test
    void dropAllZeroesAndForgetsEverything() throws Exception {
        staging.put("owner", "manager", "upload-0013", "a.txt", 100, 0, text(100), Caps.DEFAULT);
        staging.dropAll();
        assertThat(staging.count()).isZero();
        assertThat(staging.heldBytes()).isZero();
    }

    @Test
    void namesAreCleaned() {
        assertThat(Staging.cleanName("../../etc/<b>pass\u0007wd\".txt")).isEqualTo("b pass wd .txt");
        assertThat(Staging.cleanName("C:\\Users\\x\\report.pdf")).isEqualTo("report.pdf");
        assertThat(Staging.cleanName("")).isEqualTo("file");
        assertThat(Staging.cleanName("a".repeat(300) + ".docx")).hasSize(120).endsWith(".docx");
    }
}
