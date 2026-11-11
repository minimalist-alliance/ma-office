package com.minimalistalliance.desk.deskd.status;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The topic {@code desk.contention} (API.md section 5, ADR 0090): {@code {held}}, true while the desk's whole cgroup, on its
 * shared host, is being held back from the CPU for long enough to feel. Only the desk's own cgroup says so, never a
 * client's numbers.
 *
 * <p><b>The source.</b> deskd's own container is a cgroup of its own beside the desk's, with a cgroup namespace of its own
 * (ADR 0072), so it can't see the desk's. The host gives it, read-only, the desk's {@code cpu.pressure} and {@code cpu.stat}
 * in one directory ({@code /run/desk-host/cgroup} by default, {@code DESKD_CONTENTION_DIR}). Until {@code cpu.pressure}
 * is there, a SUB is refused with {@code unavailable} and {@code reason: source}, which is also every desk of its own.
 *
 * <p><b>The rule.</b> A desk's class has no CPU cap ({@code cpu.idle} for a free desk, a weight for the rest), so
 * {@code cpu.stat}'s throttling never moves, and being held back shows as pressure: the share of time some task in the
 * desk was runnable and waiting for a CPU ({@code some avg10}, the kernel's 10-second average). Held from
 * {@link #HOLD_AT} percent, let go below {@link #LET_GO_BELOW}, so it doesn't flicker; the same thresholds apply to
 * {@code throttled_usec} over 10 s, should a class ever have a cap. A quarter of the time waiting for a CPU, averaged over
 * 10 s, is where a page's frames and keys visibly slow: a 60 fps frame needs the CPU within 16 ms. The thresholds are a
 * judgement, to be checked on a host under load.
 *
 * <p><b>Cost.</b> Two small files read every {@link Timing#sample} while anyone is subscribed, and nothing otherwise.
 */
public final class DeskContention implements Topic {

    public static final String TOPIC = "desk.contention";
    public static final String DEFAULT_DIR = "/run/desk-host/cgroup";
    public static final String PRESSURE = "cpu.pressure";
    public static final String STAT = "cpu.stat";
    static final double HOLD_AT = 25.0;
    static final double LET_GO_BELOW = 10.0;
    static final Duration THROTTLE_WINDOW = Duration.ofSeconds(10);

    private static final Logger log = LoggerFactory.getLogger(DeskContention.class);
    private static final int MAX_FILE_BYTES = 4096;

    public record Timing(Duration sample) {
        public static final Timing DEFAULT = new Timing(Duration.ofSeconds(2));
    }

    /** One read of the two files. @param someAvg10 percent @param throttledUsec cumulative, 0 with none */
    record Reading(double someAvg10, long throttledUsec) {}

    private final EventHub hub;
    private final Path pressure;
    private final Path stat;
    private final Timing timing;
    private final LongSupplier nanos;
    private final ReentrantLock lock = new ReentrantLock();
    /** {@code [nanos, throttledUsec]} over the last {@link #THROTTLE_WINDOW}, and one before it as the base. */
    private final Deque<long[]> throttled = new ArrayDeque<>();
    private boolean held;
    private Thread sampler;
    private boolean readFailureLogged;

    public DeskContention(EventHub hub, Path dir, Timing timing) {
        this(hub, dir, timing, System::nanoTime);
    }

    DeskContention(EventHub hub, Path dir, Timing timing, LongSupplier nanos) {
        this.hub = hub;
        this.pressure = dir.resolve(PRESSURE);
        this.stat = dir.resolve(STAT);
        this.timing = timing;
        this.nanos = nanos;
    }

    public void register() {
        hub.topics().register(TOPIC, this);
    }

    /** Stops sampling. */
    public void close() {
        Thread running;
        lock.lock();
        try {
            running = sampler;
            sampler = null;
        } finally {
            lock.unlock();
        }
        if (running != null) {
            running.interrupt();
        }
    }

    /** Whether the host gives the desk's cgroup: without it there's nothing to say. Doesn't block for long: a stat on a tmpfs. */
    public boolean available() {
        return Files.isReadable(pressure);
    }

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!available()) {
            throw new RpcException(RpcException.UNAVAILABLE, "This desk can't see its CPU share", Map.of("reason", "source"));
        }
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        sampleOnce();
        lock.lock();
        try {
            return Map.of("held", held);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void subscribersChanged() {
        boolean wanted = hub.hasSubscribers(TOPIC);
        lock.lock();
        try {
            if (wanted && sampler == null) {
                sampler = Thread.ofVirtual().name("desk-contention").start(this::run);
            } else if (!wanted && sampler != null) {
                sampler.interrupt();
                sampler = null;
            }
        } finally {
            lock.unlock();
        }
    }

    private void run() {
        try {
            while (!Thread.currentThread().isInterrupted()) {
                Thread.sleep(timing.sample());
                sampleOnce();
            }
        } catch (InterruptedException e) {
            // Nobody is subscribed any more.
        }
    }

    /** Reads, moves {@link #held} by the rule, and publishes a change. A read that fails is not held. */
    void sampleOnce() {
        Reading reading;
        try {
            reading = read();
            readFailureLogged = false;
        } catch (IOException | RuntimeException e) {
            if (!readFailureLogged) {
                readFailureLogged = true;
                log.warn("the desk's CPU share can't be read ({}), so it isn't said to be held back", e.getClass().getSimpleName());
            }
            reading = null;
        }
        boolean changed;
        boolean now;
        lock.lock();
        try {
            boolean next = reading != null && decide(reading, nanos.getAsLong());
            if (reading == null) {
                throttled.clear();
            }
            changed = next != held;
            held = next;
            now = held;
        } finally {
            lock.unlock();
        }
        if (changed) {
            log.info("desk contention: {}", now ? "held back" : "not held back");
            hub.publish(TOPIC, "patch", Map.of("held", now));
        }
    }

    /** With the lock held. */
    private boolean decide(Reading reading, long at) {
        throttled.addLast(new long[] {at, reading.throttledUsec()});
        // The oldest goes once the next one is a whole window old, so the base is always at least a window back.
        while (throttled.size() > 2) {
            java.util.Iterator<long[]> samples = throttled.iterator();
            samples.next();
            if (at - samples.next()[0] < THROTTLE_WINDOW.toNanos()) {
                break;
            }
            throttled.removeFirst();
        }
        double throttledShare = 0;
        long[] base = throttled.peekFirst();
        long span = at - base[0];
        if (span >= THROTTLE_WINDOW.toNanos() / 2) {
            throttledShare = Math.max(0, reading.throttledUsec() - base[1]) * 1000.0 / span * 100.0;
        }
        if (!held) {
            return reading.someAvg10() >= HOLD_AT || throttledShare >= HOLD_AT;
        }
        return reading.someAvg10() >= LET_GO_BELOW || throttledShare >= LET_GO_BELOW;
    }

    private Reading read() throws IOException {
        double some = someAvg10(small(pressure));
        long throttledUsec = 0;
        if (Files.isReadable(stat)) {
            throttledUsec = throttledUsec(small(stat));
        }
        return new Reading(some, throttledUsec);
    }

    private static String small(Path file) throws IOException {
        byte[] bytes = Files.readAllBytes(file);
        if (bytes.length > MAX_FILE_BYTES) {
            throw new IOException("too large");
        }
        return new String(bytes, StandardCharsets.US_ASCII);
    }

    /** {@code some avg10=1.23 avg60=... total=...}: the first number. */
    static double someAvg10(String text) throws IOException {
        for (String line : text.split("\n")) {
            if (!line.startsWith("some ")) {
                continue;
            }
            for (String field : line.split(" ")) {
                if (field.startsWith("avg10=")) {
                    try {
                        double value = Double.parseDouble(field.substring("avg10=".length()));
                        if (value >= 0 && value <= 100) {
                            return value;
                        }
                    } catch (NumberFormatException e) {
                        break;
                    }
                }
            }
        }
        throw new IOException("no some avg10");
    }

    /** {@code throttled_usec N}, or 0 if the line isn't there. */
    static long throttledUsec(String text) {
        for (String line : text.split("\n")) {
            if (line.startsWith("throttled_usec ")) {
                try {
                    return Math.max(0, Long.parseLong(line.substring("throttled_usec ".length()).trim()));
                } catch (NumberFormatException e) {
                    return 0;
                }
            }
        }
        return 0;
    }
}
