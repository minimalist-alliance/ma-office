package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Crash safety: a writer in its own JVM ({@link CourierCrashChild}) is killed with SIGKILL at random moments, mid-batch,
 * mid-blob and mid-purge, many times over one store. After each kill the store is reopened here: SQLite's and FTS5's
 * checks pass, the {@link Invariants} hold (no torn or orphan blob, summaries true), and every message the writer was told
 * was committed is there. The writer then starts again from the beginning, as a transport re-syncing does, and at the end
 * every message is there exactly once.
 */
class CourierCrashTest {

    private static final int ROUNDS = Integer.getInteger("courier.crash.rounds", 20);
    private static final int TOTAL = 600;

    @Test
    void killedMidWriteTheStoreReopensWholeAndLosesNothingCommitted(@TempDir Path dir) throws Exception {
        Path store = dir.resolve("courier");
        Random rnd = new Random(7);
        Set<String> everAcked = new HashSet<>();
        int kills = 0;
        for (int round = 0; round <= ROUNDS; round++) {
            boolean last = round == ROUNDS;
            Process p = new ProcessBuilder(javaBinary(), "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-cp", System.getProperty("java.class.path"),
                    CourierCrashChild.class.getName(), store.toString(), Integer.toString(TOTAL))
                    .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            BlockingQueue<String> lines = new LinkedBlockingQueue<>();
            Thread reader = Thread.ofVirtual().start(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        lines.add(line);
                    }
                } catch (java.io.IOException e) {
                    // the process died
                }
                lines.add("EOF");
            });
            Set<String> acked = new HashSet<>();
            Set<String> purging = new HashSet<>();
            // Past what's already stored, so the kill lands among new writes: a blob being staged, a batch committing, a purge.
            int killAfter = last ? Integer.MAX_VALUE : Math.min(TOTAL - 1, everAcked.size() + 3 + rnd.nextInt(60));
            int seen = 0;
            boolean done = false;
            while (true) {
                String line = lines.poll(60, TimeUnit.SECONDS);
                assertThat(line).as("child output, round " + round).isNotNull();
                if (line.equals("EOF")) {
                    break;
                }
                String[] f = line.split(" ");
                switch (f[0]) {
                    case "ACK" -> {
                        acked.add(f[1]);
                        seen++;
                    }
                    case "PURGING" -> purging.add(f[1]);
                    case "PURGED" -> purging.add(f[1]);
                    case "DONE" -> done = true;
                    default -> {
                    }
                }
                if (seen >= killAfter) {
                    Thread.sleep(rnd.nextInt(25));
                    p.destroyForcibly();
                    kills++;
                    killAfter = Integer.MAX_VALUE;
                }
            }
            p.waitFor(30, TimeUnit.SECONDS);
            reader.join();
            if (last) {
                assertThat(done).as("the last run finishes").isTrue();
            }
            everAcked.addAll(acked);
            // Reopen as deskd would, and check everything.
            try (CourierStore s = CourierStore.open(store, TestMime.PARSER, new MutableClock(Instant.now()), CourierStore.Settings.DEFAULT)) {
                Invariants.check(s);
                List<String> lost = new ArrayList<>();
                for (String key : acked) {
                    if (purging.contains(key)) {
                        continue;
                    }
                    long n = Invariants.scalar(s, "SELECT count(*) FROM messages WHERE msgid = ?", key + "@x");
                    if (n != 1) {
                        lost.add(key + "=" + n);
                    }
                }
                assertThat(lost).as("committed messages after round " + round).isEmpty();
                if (last) {
                    assertThat(Invariants.scalar(s, "SELECT count(*) FROM messages WHERE blob IS NOT NULL AND blob NOT IN (SELECT sha FROM blob_data)"))
                            .as("some blobs are files").isPositive();
                    assertThat(Invariants.scalar(s, "SELECT count(*) FROM blob_data")).as("most are rows").isPositive();
                    long rows = Invariants.messages(s);
                    assertThat(rows).isEqualTo(TOTAL - purging.size());
                    assertThat(Invariants.scalar(s, "SELECT count(DISTINCT msgid) FROM messages")).isEqualTo(rows);
                    assertThat(s.cursor("gmail", "INBOX")).isEqualTo(Integer.toString(TOTAL));
                }
            }
        }
        assertThat(kills).isEqualTo(ROUNDS);
        assertThat(everAcked).hasSize(TOTAL);
    }

    private static String javaBinary() {
        return ProcessHandle.current().info().command().orElse(Path.of(System.getProperty("java.home"), "bin", "java").toString());
    }
}
