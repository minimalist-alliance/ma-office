package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** What deskd takes from the Platform's {@code streaming} (bandwidth.md, "What a desk hears"). */
class StreamingPauseTest {

    private static final Instant NOW = Instant.parse("2026-11-06T12:00:00Z");
    private static final Instant MONDAY = Instant.parse("2026-11-09T00:00:00Z");

    private final MutableClock clock = new MutableClock(NOW);
    private final StreamingPause pause = new StreamingPause(clock);
    private final AtomicInteger began = new AtomicInteger();

    {
        pause.onPause(began::incrementAndGet);
    }

    private static Map<String, Object> streaming(String profile, String resumesAt) {
        Map<String, Object> streaming = new HashMap<>();
        streaming.put("streamProfile", profile);
        streaming.put("resumesAt", resumesAt);
        return streaming;
    }

    @Test
    void pausedLastsUntilResumesAtAndEndsByItself() {
        pause.apply(streaming("paused", MONDAY.toString()));
        assertThat(pause.pausedUntil()).isEqualTo(MONDAY);
        assertThat(began).hasValue(1);
        clock.advance(Duration.between(NOW, MONDAY).minusSeconds(1));
        assertThat(pause.pausedUntil()).isEqualTo(MONDAY);
        clock.advance(Duration.ofSeconds(1));
        assertThat(pause.pausedUntil()).isNull();
    }

    @Test
    void aPauseBeginsOnceHoweverOftenItsSaid() {
        pause.apply(streaming("paused", MONDAY.toString()));
        pause.apply(streaming("paused", MONDAY.toString()));
        pause.apply(streaming("paused", MONDAY.plusSeconds(60).toString()));
        assertThat(began).hasValue(1);
        assertThat(pause.pausedUntil()).isEqualTo(MONDAY.plusSeconds(60));
    }

    @Test
    void anotherProfileOrNoStreamingAtAllEndsIt() {
        for (Map<String, Object> word : new Map[] {streaming("normal", null), streaming("capped", null), null, Map.of()}) {
            pause.apply(streaming("paused", MONDAY.toString()));
            pause.apply(word);
            assertThat(pause.pausedUntil()).isNull();
        }
        // Each pause after an end is a new one, and ends what's live again.
        assertThat(began).hasValue(4);
    }

    @Test
    void aResumesAtAlreadyPastIsNoPause() {
        pause.apply(streaming("paused", NOW.minusSeconds(1).toString()));
        assertThat(pause.pausedUntil()).isNull();
        assertThat(began).hasValue(0);
    }

    @Test
    void aPauseWithNoResumesAtOrOneThatCantBeReadLastsUntilTheNextWord() {
        pause.apply(streaming("paused", null));
        assertThat(pause.pausedUntil()).isEqualTo(Instant.MAX);
        pause.apply(streaming("paused", "next monday"));
        assertThat(pause.pausedUntil()).isEqualTo(Instant.MAX);
        clock.advance(Duration.ofDays(30));
        assertThat(pause.pausedUntil()).isEqualTo(Instant.MAX);
        pause.apply(streaming("normal", null));
        assertThat(pause.pausedUntil()).isNull();
    }
}
