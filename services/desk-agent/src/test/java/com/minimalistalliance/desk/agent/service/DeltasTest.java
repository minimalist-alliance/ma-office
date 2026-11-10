package com.minimalistalliance.desk.agent.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/** {@link Deltas} on its own: a flush is sent outside its lock, and flushes still go out in order. */
class DeltasTest {

    /**
     * What {@code agent.thread.get} does under the topic's lock, while a flush waits for that lock: it reads the text so
     * far. The flush must not be holding what that read needs.
     */
    @Test
    void theTextCanBeReadWhileAFlushIsBeingSent() throws Exception {
        List<String> failures = new CopyOnWriteArrayList<>();
        Deltas[] deltas = new Deltas[1];
        deltas[0] = new Deltas(piece -> {
            FutureTask<String> read = new FutureTask<>(deltas[0]::text);
            Thread.ofVirtual().start(read);
            try {
                read.get(2, TimeUnit.SECONDS);
            } catch (Exception e) {
                failures.add(e.getClass().getSimpleName());
            }
        });

        deltas[0].add("one");
        Thread.sleep(Deltas.EVERY.toMillis() * 2);
        deltas[0].add(" two");
        deltas[0].close();

        assertThat(failures).isEmpty();
    }

    /**
     * Flushes from the stream's thread and from the timer, each slow to send: what's sent, joined, is exactly the text,
     * in order, and nothing goes after {@link Deltas#close}.
     */
    @Test
    void slowFlushesFromTwoThreadsStayInOrder() throws Exception {
        List<String> sent = new CopyOnWriteArrayList<>();
        Deltas deltas = new Deltas(piece -> {
            sleep(ThreadLocalRandom.current().nextInt(0, 40));
            sent.add(piece);
        });
        StringBuilder expected = new StringBuilder();
        for (int i = 0; i < 300; i++) {
            String piece = i + ",";
            deltas.add(piece);
            expected.append(piece);
            sleep(ThreadLocalRandom.current().nextInt(0, 3));
        }
        deltas.close();
        List<String> atClose = List.copyOf(sent);
        deltas.add("late");
        sleep(Deltas.EVERY.toMillis() * 3);

        assertThat(String.join("", atClose)).isEqualTo(expected.toString());
        assertThat(sent).isEqualTo(atClose);
        assertThat(deltas.text()).isEqualTo(expected.toString());
        assertThat(atClose.size()).as("flushes").isGreaterThan(5);
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
