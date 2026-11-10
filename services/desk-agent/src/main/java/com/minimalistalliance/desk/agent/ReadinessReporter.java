package com.minimalistalliance.desk.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;

/**
 * Logs how long desk-agent took to become ready, counted from the OS process start, and keeps the number.
 *
 * <p>It comes from /proc, because {@code ProcessHandle}'s {@code startInstant()} is built from the
 * whole-second {@code btime} and can read up to 1 s wrong, by an amount that changes with each machine
 * boot. Here both ends are on the kernel's boot clock: the process's start ticks in /proc/self/stat
 * and the uptime in /proc/uptime. So the number is good to about 10 ms, and comparable across boots.
 *
 * <p>A copy of deskd's, until the services share a module (STATUS.md).
 */
final class ReadinessReporter implements ApplicationListener<ApplicationReadyEvent> {

    private static final Logger log = LoggerFactory.getLogger(ReadinessReporter.class);
    private static final Path PROC_STAT = Path.of("/proc/self/stat");
    private static final Path PROC_UPTIME = Path.of("/proc/uptime");
    /** USER_HZ, the unit of /proc's ticks. Linux fixes it at 100 on x86_64 and arm64. */
    private static final long TICKS_PER_SECOND = 100;
    /** Of the fields after the command's closing bracket: state is the first, and starttime the 20th. */
    private static final int START_TICKS_FIELD = 19;

    private volatile long readyMillis = -1;

    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
        long millis = measure(PROC_STAT, PROC_UPTIME);
        readyMillis = millis;
        log.info("desk-agent ready in {} ms", millis);
    }

    /** Milliseconds from process start to ready; -1 before ready, or if /proc couldn't say. */
    long readyMillis() {
        return readyMillis;
    }

    /** @return milliseconds since the process started, or -1 if the files can't be read */
    static long measure(Path procStat, Path procUptime) {
        try {
            return millisSinceStart(
                    Files.readString(procStat, StandardCharsets.ISO_8859_1),
                    Files.readString(procUptime, StandardCharsets.ISO_8859_1));
        } catch (IOException | RuntimeException e) {
            return -1;
        }
    }

    /**
     * @param procStat /proc/self/stat. The command can hold spaces and brackets, so fields count from
     *     the last closing bracket
     * @param procUptime /proc/uptime: seconds since boot with two decimals, then idle time
     */
    static long millisSinceStart(String procStat, String procUptime) {
        String[] fields = procStat.substring(procStat.lastIndexOf(')') + 2).split(" ");
        long startTicks = Long.parseLong(fields[START_TICKS_FIELD]);
        long uptimeMillis = Math.round(Double.parseDouble(procUptime.split(" ")[0]) * 1000);
        return uptimeMillis - startTicks * 1000 / TICKS_PER_SECOND;
    }
}
