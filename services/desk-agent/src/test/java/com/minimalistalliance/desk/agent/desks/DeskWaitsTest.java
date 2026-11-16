package com.minimalistalliance.desk.agent.desks;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.Test;

/** {@code desk_message}'s wait (draft ADR §14): one answer goes to exactly one place, the waiting call or the thread. */
class DeskWaitsTest {

    private final DeskWaits.Memory waits = new DeskWaits.Memory(Clock.systemUTC());

    @Test
    void anAnswerBeforeTheCallWaitsStillGoesToIt() throws Exception {
        DeskWaits.Wait wait = waits.expect("run-1", null, "ag-1", "env-1", System.currentTimeMillis() + 5_000);
        assertThat(waits.waiting("ag-1")).isTrue();
        assertThat(waits.answer("env-1", Map.of("text", "early"))).isTrue();
        assertThat(wait.await()).containsEntry("text", "early");
        assertThat(waits.waiting("ag-1")).isFalse();
        // A second copy of the answer has no one to go to: the thread's.
        assertThat(waits.answer("env-1", Map.of("text", "again"))).isFalse();
    }

    @Test
    void aWaitThatRunsOutLeavesTheAnswerToTheThreadAndACancelLikewise() throws Exception {
        DeskWaits.Wait wait = waits.expect("run-1", null, "ag-1", "env-2", System.currentTimeMillis() + 20);
        assertThat(wait.await()).isNull();
        assertThat(waits.answer("env-2", Map.of("text", "late"))).isFalse();
        DeskWaits.Wait cancelled = waits.expect("run-2", null, "ag-2", "env-3", System.currentTimeMillis() + 5_000);
        cancelled.cancel();
        assertThat(waits.answer("env-3", Map.of())).isFalse();
    }

    /** An answer as the time runs out: 2,000 races, each answer either the call's or the thread's, never both or neither. */
    @Test
    void anAnswerAtTheDeadlineGoesToExactlyOnePlace() throws Exception {
        int calls = 0;
        int threads = 0;
        for (int i = 0; i < 2_000; i++) {
            String ref = "env-race-" + i;
            DeskWaits.Wait wait = waits.expect("run-" + i, null, "ag-1", ref, System.currentTimeMillis() + 2);
            AtomicReference<Map<String, Object>> got = new AtomicReference<>();
            CompletableFuture<Void> waiting = CompletableFuture.runAsync(() -> {
                try {
                    got.set(wait.await());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            LockSupport.parkNanos((i % 7) * 300_000L);
            boolean taken = waits.answer(ref, Map.of("n", i));
            waiting.get(5, TimeUnit.SECONDS);
            assertThat(taken).as("race %d", i).isEqualTo(got.get() != null);
            if (taken) {
                calls++;
            } else {
                threads++;
            }
        }
        assertThat(calls + threads).isEqualTo(2_000);
        assertThat(waits.waiting("ag-1")).isFalse();
    }
}
