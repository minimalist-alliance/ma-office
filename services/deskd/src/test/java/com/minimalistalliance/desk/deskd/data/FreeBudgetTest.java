package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** The free budget alone: its sums, its window on a clock the test moves, and its file. */
@ExtendWith(OutputCaptureExtension.class)
class FreeBudgetTest {

    private static final Instant START = Instant.parse("2026-11-07T12:00:00Z");
    private static final Duration NEVER = Duration.ofHours(1);
    private static final Duration SOON = Duration.ofMillis(20);

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(START);
    private final List<FreeBudget> made = new ArrayList<>();

    private Path file() {
        return dir.resolve(FreeBudget.NAME);
    }

    private FreeBudget budget(long volumeBytes, Duration every) {
        FreeBudget budget = new FreeBudget(file(), () -> volumeBytes, clock, every);
        made.add(budget);
        return budget;
    }

    /** A budget of exactly 300 bytes, whose timer never fires in a test. */
    private FreeBudget budget() {
        return budget(100, NEVER);
    }

    @AfterEach
    void closeThem() {
        made.forEach(FreeBudget::close);
    }

    private Map<String, Object> onDisk() throws Exception {
        return Json.parseObject(Files.readAllBytes(file()));
    }

    @Test
    void theCapIsThreeTimesTheVolume() {
        assertThat(budget(32_000_000_000L, NEVER).capBytes()).isEqualTo(96_000_000_000L);
    }

    @Test
    void itsFreeUpToTheCapAndNotPast() {
        FreeBudget budget = budget();
        assertThat(budget.take(100)).isEqualTo(100);
        assertThat(budget.take(200)).isEqualTo(200);
        assertThat(budget.hasRoom()).isFalse();
        assertThat(budget.take(1)).isZero();
        assertThat(budget.usedBytes()).isEqualTo(300);
    }

    @Test
    void aFrameCrossingTheCapIsFreeOnlyUpToIt() {
        FreeBudget budget = budget();
        assertThat(budget.take(290)).isEqualTo(290);
        assertThat(budget.take(25)).isEqualTo(10);
        assertThat(budget.take(25)).isZero();
        assertThat(budget.usedBytes()).isEqualTo(300);
    }

    @Test
    void manyTransfersAtOnceAreFreeForExactlyTheCap() throws Exception {
        FreeBudget budget = budget(1_000_000, NEVER);
        AtomicLong free = new AtomicLong();
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            threads.add(Thread.ofVirtual().start(() -> {
                for (int frame = 0; frame < 20_000; frame++) {
                    free.addAndGet(budget.take(16_384));
                }
            }));
        }
        for (Thread thread : threads) {
            thread.join();
        }
        assertThat(free).hasValue(3_000_000);
        assertThat(budget.usedBytes()).isEqualTo(3_000_000);
    }

    @Test
    void theWindowStartsAtTheFirstFreeByteAndResetsAfter30Days() {
        FreeBudget budget = budget();
        // Nothing counted yet: time passing starts nothing.
        clock.advance(Duration.ofDays(29));
        assertThat(budget.take(300)).isEqualTo(300);

        clock.advance(Duration.ofDays(30).minusSeconds(1));
        assertThat(budget.take(1)).as("one second before the end").isZero();
        assertThat(budget.hasRoom()).isFalse();

        clock.advance(Duration.ofSeconds(1));
        assertThat(budget.hasRoom()).isTrue();
        assertThat(budget.usedBytes()).isZero();
        assertThat(budget.take(50)).isEqualTo(50);

        // The new window began with that byte, not with the last one's end.
        clock.advance(Duration.ofDays(29));
        assertThat(budget.usedBytes()).isEqualTo(50);
        clock.advance(Duration.ofDays(1));
        assertThat(budget.usedBytes()).isZero();
    }

    @Test
    void lookingForRoomCountsNothingAndStartsNoWindow() {
        FreeBudget budget = budget();
        assertThat(budget.hasRoom()).isTrue();
        clock.advance(Duration.ofDays(31));
        assertThat(budget.hasRoom()).isTrue();
        assertThat(budget.usedBytes()).isZero();
        budget.close();
        assertThat(file()).doesNotExist();
    }

    @Test
    void aRestartDoesNotRefillIt() throws Exception {
        FreeBudget first = budget();
        first.take(250);
        first.close();
        assertThat(onDisk()).containsEntry("startedAt", START.toString()).containsEntry("usedBytes", 250);
        assertThat(dir.resolve("." + FreeBudget.NAME + ".tmp")).doesNotExist();

        clock.advance(Duration.ofDays(10));
        FreeBudget second = budget();
        assertThat(second.usedBytes()).isEqualTo(250);
        assertThat(second.take(100)).isEqualTo(50);

        // And its window is the same one, which started 10 days before this process did.
        clock.advance(Duration.ofDays(20));
        assertThat(second.usedBytes()).isZero();
    }

    @Test
    void theTimerWritesWhileCountingSoACrashForgetsOnlyTheLast() throws Exception {
        FreeBudget budget = budget(100, SOON);
        budget.take(10);
        await().atMost(Duration.ofSeconds(5)).until(() -> Files.exists(file()));
        assertThat(onDisk()).containsEntry("usedBytes", 10);

        budget.take(20);
        await().atMost(Duration.ofSeconds(5)).until(() -> Integer.valueOf(30).equals(onDisk().get("usedBytes")));

        // No close(), as after a crash.
        FreeBudget afterCrash = budget(100, NEVER);
        assertThat(afterCrash.usedBytes()).isEqualTo(30);
    }

    @Test
    void anUntouchedBudgetWritesNoFile() throws Exception {
        FreeBudget budget = budget(100, SOON);
        Thread.sleep(100);
        budget.close();
        assertThat(file()).doesNotExist();
    }

    @Test
    void aFileThatCantBeBelievedStartsFresh(CapturedOutput output) throws Exception {
        String goodStart = START.toString();
        for (String corrupt : List.of(
                "",
                "not json",
                "[]",
                "{}",
                "{\"startedAt\":\"yesterday\",\"usedBytes\":1}",
                "{\"startedAt\":5,\"usedBytes\":1}",
                "{\"startedAt\":\"" + goodStart + "\"}",
                "{\"startedAt\":\"" + goodStart + "\",\"usedBytes\":-1}",
                "{\"startedAt\":\"" + goodStart + "\",\"usedBytes\":\"many\"}",
                "{\"startedAt\":\"" + goodStart + "\",\"usedBytes\":1.5}",
                "{\"usedBytes\":1,\"pad\":\"" + "x".repeat(5000) + "\"}")) {
            Files.writeString(file(), corrupt);
            FreeBudget budget = budget();
            assertThat(budget.usedBytes()).as(corrupt).isZero();
            assertThat(budget.take(300)).as(corrupt).isEqualTo(300);
            // The next write replaces it.
            budget.close();
            assertThat(onDisk()).as(corrupt).containsEntry("usedBytes", 300);
        }
        assertThat(output).contains(FreeBudget.NAME + " ignored").doesNotContain("yesterday");
    }

    @Test
    void aDirectoryOrALinkAtTheNameIsNotReadAndALinksTargetIsLeftAlone() throws Exception {
        Files.createDirectory(file());
        assertThat(budget().usedBytes()).isZero();
        Files.delete(file());

        Path elsewhere = dir.resolve("elsewhere.json");
        String record = "{\"startedAt\":\"" + START + "\",\"usedBytes\":200}";
        Files.writeString(elsewhere, record);
        Files.createSymbolicLink(file(), elsewhere);
        FreeBudget budget = budget();
        assertThat(budget.usedBytes()).isZero();
        budget.take(5);
        budget.close();
        assertThat(Files.isSymbolicLink(file())).isFalse();
        assertThat(onDisk()).containsEntry("usedBytes", 5);
        assertThat(elsewhere).hasContent(record);
    }

    @Test
    void aStartInTheFutureKeepsTheCountAndIsTakenAsNow() throws Exception {
        Files.writeString(file(), "{\"startedAt\":\"" + START.plus(Duration.ofDays(400)) + "\",\"usedBytes\":200}");
        FreeBudget budget = budget();
        assertThat(budget.usedBytes()).isEqualTo(200);
        clock.advance(Duration.ofDays(30).minusSeconds(1));
        assertThat(budget.usedBytes()).isEqualTo(200);
        clock.advance(Duration.ofSeconds(1));
        assertThat(budget.usedBytes()).isZero();
    }

    @Test
    void aWindowThatEndedWhileDeskdWasDownIsOver() throws Exception {
        Files.writeString(file(), "{\"startedAt\":\"" + START.minus(Duration.ofDays(30)) + "\",\"usedBytes\":300}");
        FreeBudget budget = budget();
        assertThat(budget.hasRoom()).isTrue();
        assertThat(budget.take(300)).isEqualTo(300);
    }

    @Test
    void aFailedSaveIsOneLogLineAndCountingGoesOnAndItRecovers(CapturedOutput output) throws Exception {
        // A rename can't replace a directory.
        Files.createDirectory(file());
        FreeBudget budget = budget(100, SOON);
        budget.take(1);
        await().atMost(Duration.ofSeconds(5)).until(() -> output.toString().contains("couldn't write " + FreeBudget.NAME));
        for (int i = 0; i < 5; i++) {
            assertThat(budget.take(1)).isEqualTo(1);
            Thread.sleep(40);
        }
        assertThat(output.toString().split("couldn't write " + FreeBudget.NAME, -1)).hasSize(2);
        await().until(() -> !Files.exists(dir.resolve("." + FreeBudget.NAME + ".tmp")));
        assertThat(budget.usedBytes()).isEqualTo(6);

        Files.delete(file());
        budget.take(1);
        await().atMost(Duration.ofSeconds(5)).until(() -> Files.isRegularFile(file()) && Integer.valueOf(7).equals(onDisk().get("usedBytes")));
    }

    @Test
    void aDirectoryThatIsntThereNeverStopsTheCount() {
        FreeBudget budget = new FreeBudget(dir.resolve("gone").resolve(FreeBudget.NAME), () -> 100, clock, NEVER);
        assertThat(budget.take(10)).isEqualTo(10);
        budget.close();
        assertThat(budget.usedBytes()).isEqualTo(10);
    }

    @Test
    void aVolumeThatCantSayGetsTheDesksUsualSizeUntilItDoes() {
        AtomicLong volume = new AtomicLong(0);
        FreeBudget budget = new FreeBudget(file(), volume::get, clock, SOON);
        made.add(budget);
        assertThat(budget.capBytes()).isEqualTo(3 * FreeBudget.DEFAULT_VOLUME_BYTES);

        volume.set(1000);
        budget.take(1);
        await().atMost(Duration.ofSeconds(5)).until(() -> budget.capBytes() == 3000);
    }

    @Test
    void aVolumeTooLargeToCountDoesntOverflow() {
        FreeBudget budget = budget(Long.MAX_VALUE, NEVER);
        assertThat(budget.take(1000)).isEqualTo(1000);
        assertThat(budget.capBytes()).isEqualTo(Long.MAX_VALUE);
    }

    @Test
    void aFrameNeverWaitsOnASlowDisk() throws Exception {
        CountDownLatch inTheVolume = new CountDownLatch(1);
        CountDownLatch letGo = new CountDownLatch(1);
        AtomicBoolean madeYet = new AtomicBoolean();
        FreeBudget budget = new FreeBudget(file(), () -> {
            if (madeYet.get()) {
                inTheVolume.countDown();
                try {
                    letGo.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            return 100;
        }, clock, SOON);
        made.add(budget);
        madeYet.set(true);
        budget.take(1);
        assertThat(inTheVolume.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();

        // The timer is stuck on the volume. These come back all the same.
        Thread frames = Thread.ofVirtual().start(() -> {
            budget.take(1);
            budget.hasRoom();
        });
        assertThat(frames.join(Duration.ofSeconds(5))).isTrue();
        letGo.countDown();
    }
}
