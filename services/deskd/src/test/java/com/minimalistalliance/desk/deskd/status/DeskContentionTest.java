package com.minimalistalliance.desk.deskd.status;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code desk.contention} (ADR 0090): held from the desk's own cgroup's CPU pressure, or throttling should a class ever
 * have a cap, with a gap between holding and letting go; refused where the host gives no cgroup.
 */
class DeskContentionTest {

    @TempDir
    Path dir;

    private final AtomicLong nanos = new AtomicLong(1_000_000_000L);

    private DeskContention contention() {
        return new DeskContention(new EventHub(new TopicRegistry()), dir, DeskContention.Timing.DEFAULT, nanos::get);
    }

    private void pressure(double avg10) throws IOException {
        Files.writeString(dir.resolve(DeskContention.PRESSURE),
                "some avg10=" + avg10 + " avg60=1.00 avg300=0.50 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
    }

    private void throttled(long usec) throws IOException {
        Files.writeString(dir.resolve(DeskContention.STAT),
                "usage_usec 100\nuser_usec 60\nsystem_usec 40\nnr_periods 10\nnr_throttled 2\nthrottled_usec " + usec + "\n");
    }

    @SuppressWarnings("unchecked")
    private static boolean held(Object snapshot) {
        return (Boolean) ((Map<String, Object>) snapshot).get("held");
    }

    @Test
    void withNoCgroupFromTheHostASubIsRefused() {
        DeskContention contention = contention();
        assertThat(contention.available()).isFalse();
        assertThatThrownBy(() -> contention.authorize(null, DeskContention.TOPIC, Map.of()))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo(RpcException.UNAVAILABLE);
                    assertThat(e.details()).containsEntry("reason", "source");
                });
    }

    @Test
    void pressureHoldsAtAQuarterAndLetsGoUnderATenth() throws Exception {
        DeskContention contention = contention();
        pressure(3.5);
        contention.authorize(null, DeskContention.TOPIC, Map.of());
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isFalse();
        pressure(24.9);
        contention.sampleOnce();
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isFalse();
        pressure(31.2);
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isTrue();
        // Between the two, it stays as it was.
        pressure(15.0);
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isTrue();
        pressure(9.9);
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isFalse();
        pressure(15.0);
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isFalse();
    }

    @Test
    void throttlingOverTenSecondsHoldsTooShouldAClassHaveACap() throws Exception {
        DeskContention contention = contention();
        pressure(0);
        throttled(0);
        contention.sampleOnce();
        for (int i = 1; i <= 5; i++) {
            nanos.addAndGet(Duration.ofSeconds(2).toNanos());
            // 0.6 s throttled in every 2 s: 30%.
            throttled(i * 600_000L);
            contention.sampleOnce();
        }
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isTrue();
        for (int i = 1; i <= 6; i++) {
            nanos.addAndGet(Duration.ofSeconds(2).toNanos());
            throttled(3_000_000L);
            contention.sampleOnce();
        }
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isFalse();
    }

    @Test
    void aFileThatCantBeReadIsNotHeld() throws Exception {
        DeskContention contention = contention();
        pressure(80);
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isTrue();
        Files.writeString(dir.resolve(DeskContention.PRESSURE), "nonsense\n");
        assertThat(held(contention.snapshot(DeskContention.TOPIC, Map.of()))).isFalse();
    }

    @Test
    void theKernelsLinesAreRead() throws Exception {
        assertThat(DeskContention.someAvg10("some avg10=12.34 avg60=1.00 avg300=0.00 total=5\nfull avg10=99.00 avg60=0 avg300=0 total=0"))
                .isEqualTo(12.34);
        assertThat(DeskContention.throttledUsec("usage_usec 1\nthrottled_usec 77\n")).isEqualTo(77);
        assertThat(DeskContention.throttledUsec("usage_usec 1\n")).isZero();
        assertThatThrownBy(() -> DeskContention.someAvg10("full avg10=1.00\n")).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> DeskContention.someAvg10("some avg10=250.00\n")).isInstanceOf(IOException.class);
    }
}
