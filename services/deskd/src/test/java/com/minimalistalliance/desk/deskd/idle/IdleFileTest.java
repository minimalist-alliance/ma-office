package com.minimalistalliance.desk.deskd.idle;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** /run/desk/idle.json: its fields, when idleSince moves, its rewrites, and that a reader never sees half of it. */
class IdleFileTest {

    private static final Instant T0 = Instant.parse("2026-11-09T18:00:00Z");

    /** A clock the test moves. */
    private static final class TestClock extends Clock {
        private volatile Instant now = T0;

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }
    }

    private static class Counts implements IdleFile.Sources {
        volatile int sessions;
        volatile int agentTasks;
        volatile int exports;
        volatile int downloads;
        volatile Long idleStopSeconds;
        volatile Instant lastInputAt;
        final AtomicInteger looks = new AtomicInteger();

        @Override
        public int sessions() {
            looks.incrementAndGet();
            return sessions;
        }

        @Override
        public int agentTasks() {
            return agentTasks;
        }

        @Override
        public int exports() {
            return exports;
        }

        @Override
        public int downloads() {
            return downloads;
        }

        @Override
        public Long idleStopSeconds() {
            return idleStopSeconds;
        }

        @Override
        public Instant lastInputAt() {
            return lastInputAt;
        }
    }

    @TempDir
    Path dir;

    private final TestClock clock = new TestClock();
    private final Counts counts = new Counts();
    private IdleFile running;

    @AfterEach
    void stop() {
        if (running != null) {
            running.close();
        }
    }

    private IdleFile idle(Duration every) {
        return new IdleFile(dir.resolve("idle.json"), counts, clock, every);
    }

    private Map<String, Object> read() throws Exception {
        return Json.parseObject(Files.readAllBytes(dir.resolve("idle.json")));
    }

    @Test
    void everyFieldIsThereAndHasTheContractsType() throws Exception {
        counts.idleStopSeconds = 1200L;
        counts.lastInputAt = Instant.parse("2026-11-09T17:55:30.789Z");
        IdleFile idle = idle(Duration.ofHours(1));
        idle.write();
        Map<String, Object> file = read();
        assertThat(file.keySet()).containsExactly(
                "at", "sessions", "agentTasks", "exports", "downloads", "idleSince", "idleStopSeconds", "lastInputAt");
        assertThat(file.get("at")).isEqualTo("2026-11-09T18:00:00Z");
        assertThat(file.get("sessions")).isEqualTo(0);
        assertThat(file.get("agentTasks")).isEqualTo(0);
        assertThat(file.get("exports")).isEqualTo(0);
        assertThat(file.get("downloads")).isEqualTo(0);
        assertThat(file.get("idleSince")).isEqualTo("2026-11-09T18:00:00Z");
        assertThat(file.get("idleStopSeconds")).isEqualTo(1200);
        assertThat(file.get("lastInputAt")).isEqualTo("2026-11-09T17:55:30Z");
        assertThat(Files.size(dir.resolve("idle.json"))).isLessThan(1024);
    }

    @Test
    void idleStopSecondsAndLastInputAreNullWhenUnknown() throws Exception {
        idle(Duration.ofHours(1)).write();
        Map<String, Object> file = read();
        assertThat(file).containsEntry("idleStopSeconds", null).containsEntry("lastInputAt", null);
        assertThat(file.containsKey("idleStopSeconds")).isTrue();
    }

    @Test
    void eachCountShowsItsOwnState() throws Exception {
        IdleFile idle = idle(Duration.ofHours(1));
        counts.sessions = 2;
        idle.write();
        assertThat(read()).containsEntry("sessions", 2).containsEntry("agentTasks", 0).containsEntry("idleSince", null);
        counts.sessions = 0;
        counts.agentTasks = 3;
        idle.write();
        assertThat(read()).containsEntry("sessions", 0).containsEntry("agentTasks", 3).containsEntry("idleSince", null);
        counts.agentTasks = 0;
        counts.exports = 1;
        idle.write();
        assertThat(read()).containsEntry("exports", 1).containsEntry("idleSince", null);
        // Downloads are reported, but they don't move idleSince: they hold a Chromium close, not a service batch.
        counts.exports = 0;
        counts.downloads = 1;
        idle.write();
        assertThat(read()).containsEntry("downloads", 1).containsEntry("idleSince", "2026-11-09T18:00:00Z");
    }

    @Test
    void idleSinceIsSetAtTheFirstLookAndHeldWhileNothingHappens() throws Exception {
        IdleFile idle = idle(Duration.ofHours(1));
        idle.write();
        assertThat(read()).containsEntry("idleSince", "2026-11-09T18:00:00Z");
        clock.advance(Duration.ofMinutes(20));
        idle.write();
        assertThat(read()).containsEntry("at", "2026-11-09T18:20:00Z").containsEntry("idleSince", "2026-11-09T18:00:00Z");
    }

    @Test
    void idleSinceIsClearedBySessionsAndStartsAgainWhenTheyAreGone() throws Exception {
        IdleFile idle = idle(Duration.ofHours(1));
        idle.write();
        clock.advance(Duration.ofMinutes(10));
        counts.sessions = 1;
        idle.poke();
        idle.write();
        assertThat(read()).containsEntry("idleSince", null).containsEntry("sessions", 1);
        clock.advance(Duration.ofMinutes(5));
        counts.sessions = 0;
        idle.poke();
        idle.write();
        assertThat(read()).containsEntry("idleSince", "2026-11-09T18:15:00Z");
        clock.advance(Duration.ofMinutes(30));
        idle.write();
        assertThat(read()).containsEntry("idleSince", "2026-11-09T18:15:00Z");
    }

    @Test
    void aSessionThatOpensAndClosesBetweenTwoLooksStillRestartsTheClock() throws Exception {
        IdleFile idle = idle(Duration.ofHours(1));
        idle.write();
        clock.advance(Duration.ofMinutes(10));
        // Opened and closed before the writer looked: only the poke saw it.
        idle.poke();
        clock.advance(Duration.ofMinutes(1));
        idle.write();
        assertThat(read()).containsEntry("sessions", 0).containsEntry("idleSince", "2026-11-09T18:10:00Z");
    }

    @Test
    void aRestartOfDeskdStartsIdleSinceFresh() throws Exception {
        IdleFile first = idle(Duration.ofHours(1));
        first.write();
        clock.advance(Duration.ofHours(2));
        first.write();
        assertThat(read()).containsEntry("idleSince", "2026-11-09T18:00:00Z");
        first.close();
        assertThat(dir.resolve("idle.json")).doesNotExist();
        clock.advance(Duration.ofSeconds(7));
        IdleFile second = idle(Duration.ofHours(1));
        second.write();
        assertThat(read()).containsEntry("idleSince", "2026-11-09T20:00:07Z");
    }

    @Test
    void theFileIsMode0644AndLeavesNoTemporaryFile() throws Exception {
        IdleFile idle = idle(Duration.ofHours(1));
        idle.write();
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("idle.json")))).isEqualTo("rw-r--r--");
        idle.write();
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("idle.json")))).isEqualTo("rw-r--r--");
        try (Stream<Path> files = Files.list(dir)) {
            assertThat(files.map(p -> p.getFileName().toString())).containsExactly("idle.json");
        }
    }

    @Test
    void aLeftoverTemporaryNameOrALinkInItsPlaceIsReplacedNotFollowed() throws Exception {
        Path victim = dir.resolve("victim");
        Files.writeString(victim, "keep");
        Files.createSymbolicLink(dir.resolve(".idle.json.tmp"), victim);
        idle(Duration.ofHours(1)).write();
        assertThat(Files.readString(victim)).isEqualTo("keep");
        assertThat(read()).containsKey("at");
    }

    @Test
    void aReaderNeverSeesAPartialFileWhileItIsRewrittenOften() throws Exception {
        IdleFile idle = idle(Duration.ofHours(1));
        idle.write();
        AtomicBoolean done = new AtomicBoolean();
        AtomicReference<String> bad = new AtomicReference<>();
        AtomicInteger reads = new AtomicInteger();
        Thread reader = Thread.ofPlatform().start(() -> {
            while (!done.get()) {
                try {
                    Map<String, Object> file = Json.parseObject(Files.readAllBytes(dir.resolve("idle.json")));
                    if (file.size() != 8) {
                        bad.set("fields: " + file);
                    }
                    reads.incrementAndGet();
                } catch (Exception e) {
                    bad.set(e.toString());
                }
            }
        });
        for (int i = 0; i < 2000; i++) {
            counts.sessions = i % 3;
            counts.lastInputAt = T0.plusSeconds(i);
            idle.write();
        }
        done.set(true);
        reader.join();
        assertThat(bad.get()).isNull();
        assertThat(reads.get()).isPositive();
    }

    @Test
    void itIsRewrittenEveryIntervalWithNothingChanging() throws Exception {
        CountDownLatch looked = new CountDownLatch(4);
        Counts watched = new Counts() {
            @Override
            public int sessions() {
                looked.countDown();
                return super.sessions();
            }
        };
        running = new IdleFile(dir.resolve("idle.json"), watched, clock, Duration.ofMillis(20));
        running.start();
        assertThat(looked.await(10, TimeUnit.SECONDS)).as("four writes with no change and no poke").isTrue();
        assertThat(read()).containsEntry("sessions", 0);
    }

    @Test
    void aPokeWritesAtOnceNotAtTheNextInterval() throws Exception {
        CountDownLatch first = new CountDownLatch(1);
        AtomicReference<CountDownLatch> next = new AtomicReference<>(new CountDownLatch(1));
        Counts watched = new Counts() {
            @Override
            public int sessions() {
                first.countDown();
                next.get().countDown();
                return super.sessions();
            }
        };
        running = new IdleFile(dir.resolve("idle.json"), watched, clock, Duration.ofHours(1));
        running.start();
        assertThat(first.await(10, TimeUnit.SECONDS)).isTrue();
        CountDownLatch second = new CountDownLatch(1);
        next.set(second);
        watched.sessions = 1;
        running.poke();
        assertThat(second.await(10, TimeUnit.SECONDS)).isTrue();
        running.close();
        running = null;
        assertThat(watched.looks.get()).isEqualTo(2);
    }

    @Test
    void aFailedWriteIsNotAnError() throws IOException {
        IdleFile idle = new IdleFile(dir.resolve("missing").resolve("idle.json"), counts, clock, Duration.ofHours(1));
        idle.write();
        idle.write();
        assertThat(dir.resolve("missing")).doesNotExist();
        assertThat(List.of(dir.toFile().list())).isEmpty();
    }
}
