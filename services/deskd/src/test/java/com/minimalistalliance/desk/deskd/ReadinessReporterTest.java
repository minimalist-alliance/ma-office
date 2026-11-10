package com.minimalistalliance.desk.deskd;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ReadinessReporterTest {

    /** The shape of a real /proc/self/stat line, with starttime (field 22) as given. */
    private static String stat(String command, long startTicks) {
        return "4242 (" + command + ") S 4100 4242 4100 34816 4242 4194304 1893 0 0 0 12 3 0 0 20 0 1 0 "
                + startTicks + " 12718080 556 18446744073709551615 94 95 140 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0\n";
    }

    @Test
    void itIsTheUptimeLessTheProcessStartInTicksOfTenMilliseconds() {
        assertThat(ReadinessReporter.millisSinceStart(stat("java", 12_345), "130.50 300.25\n")).isEqualTo(7050);
    }

    /** A fraction of a second that a whole-second boot time would get wrong. */
    @Test
    void itKeepsHundredthsAtEachEnd() {
        assertThat(ReadinessReporter.millisSinceStart(stat("java", 12_345), "123.46 1.00\n")).isEqualTo(10);
        assertThat(ReadinessReporter.millisSinceStart(stat("java", 182_345_678), "1823457.13 1.00\n")).isEqualTo(350);
    }

    @Test
    void aCommandWithSpacesAndBracketsDoesntMoveTheFields() {
        assertThat(ReadinessReporter.millisSinceStart(stat("a b) c (d)", 1000), "11.00 1.00\n")).isEqualTo(1000);
    }

    @Test
    void itMatchesTheRealProcessToWithinWhatTheOldClockCouldBeOff() {
        long fromProc = ReadinessReporter.measure(Path.of("/proc/self/stat"), Path.of("/proc/uptime"));
        Instant now = Instant.now();
        long fromJdk = Duration.between(ProcessHandle.current().info().startInstant().orElseThrow(), now).toMillis();
        assertThat(fromProc).isPositive();
        assertThat(Math.abs(fromProc - fromJdk)).isLessThan(2000);
    }

    @Test
    void itSaysSoWhenProcCantTell(@TempDir Path dir) throws Exception {
        assertThat(ReadinessReporter.measure(dir.resolve("missing"), dir.resolve("missing"))).isEqualTo(-1);
        Path garbage = Files.writeString(dir.resolve("garbage"), "not what /proc writes");
        assertThat(ReadinessReporter.measure(garbage, garbage)).isEqualTo(-1);
    }
}
