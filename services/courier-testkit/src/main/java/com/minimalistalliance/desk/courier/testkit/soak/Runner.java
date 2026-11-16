package com.minimalistalliance.desk.courier.testkit.soak;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SplittableRandom;
import java.util.function.Consumer;

/**
 * Runs a {@link Soak.Plan}: spreads its messages over the duration (deterministic for its seed: which channel, which
 * moment, which go in bursts of ten), switches each fault on and off at its window, plans each message in the
 * {@link Ledger} before sending, keeps a message whose source refused it (a fault, say) and tries it again, then waits for
 * the desk to hold everything sent, and reconciles.
 *
 * <p>A run resumed from a ledger sends what's left over what's left of the duration, and reconciles every message, the
 * earlier run's too.
 */
public final class Runner {

    /** How the runner waits, so a test can run a plan faster than the clock. */
    @FunctionalInterface
    public interface Sleeper {
        void sleep(Duration d) throws InterruptedException;
    }

    private final Soak.Plan plan;
    private final Map<String, Soak.Channel> channels;
    private final Map<String, Soak.Fault> faults;
    private final Soak.Observer observer;
    private final Ledger ledger;
    private final Clock clock;
    private final Sleeper sleeper;
    private final Consumer<String> progress;
    private final List<String> faultLog = new ArrayList<>();
    private int retries;
    /** The run's first start, kept by the caller across restarts (CR-4.1's week on staging); null: the run starts now. */
    private Instant origin;

    public Runner(Soak.Plan plan, Map<String, Soak.Channel> channels, Map<String, Soak.Fault> faults, Soak.Observer observer, Ledger ledger,
            Clock clock, Sleeper sleeper, Consumer<String> progress) {
        for (String c : plan.channels()) {
            if (!channels.containsKey(c)) {
                throw new IllegalArgumentException("no channel " + c);
            }
        }
        for (Soak.Window w : plan.faults()) {
            if (!faults.containsKey(w.fault())) {
                throw new IllegalArgumentException("no fault " + w.fault());
            }
        }
        this.plan = plan;
        this.channels = channels;
        this.faults = faults;
        this.observer = observer;
        this.ledger = ledger;
        this.clock = clock;
        this.sleeper = sleeper;
        this.progress = progress == null ? s -> { } : progress;
    }

    /**
     * Anchors the run at its first start, for a run that restarts on its own over days (the staging soak's box or process
     * restarting): each message keeps its moment and each fault its window, counted from {@code origin}, so a resumed run
     * sends what's due at once and the rest on time, re-applies a fault whose window is still open, and never repeats one
     * that ended while it was down. Without it a resumed run spreads what's left over a fresh duration (the default).
     */
    public Runner anchoredAt(Instant origin) {
        this.origin = origin;
        return this;
    }

    /** The moment, from the run's start, at which each message goes: even, with {@code burstShare} of them in tens. */
    static long[] schedule(Soak.Plan plan) {
        SplittableRandom r = new SplittableRandom(plan.seed());
        long[] at = new long[plan.total()];
        long span = plan.duration().toMillis();
        int i = 0;
        while (i < plan.total()) {
            long base = (long) ((double) i / plan.total() * span);
            int n = r.nextDouble() < plan.burstShare() / 10 ? Math.min(10, plan.total() - i) : 1;
            for (int k = 0; k < n; k++) {
                at[i++] = base;
            }
        }
        return at;
    }

    static String channelOf(Soak.Plan plan, long seq) {
        SplittableRandom r = new SplittableRandom(plan.seed() ^ (seq * 0x9E3779B97F4A7C15L));
        return plan.channels().get(r.nextInt(plan.channels().size()));
    }

    static String marker(Soak.Plan plan, long seq) {
        return "soak" + Long.toHexString(plan.seed() & 0xffffffL) + "x" + seq;
    }

    public Soak.Report run() throws Exception {
        Instant started = origin != null ? origin : clock.instant();
        long[] at = schedule(plan);
        long first = ledger.next();
        long remainingSpan = plan.duration().toMillis();
        long firstAt = origin != null ? 0 : first < at.length ? at[(int) first] : 0;
        Deque<Soak.Item> retry = new ArrayDeque<>();
        List<Soak.Window> windows = new ArrayList<>(plan.faults());
        Set<Soak.Window> begun = new HashSet<>();
        Set<Soak.Window> ended = new HashSet<>();
        // Resuming: what the earlier run planned but never confirmed is sent again only if the desk hasn't got it.
        Map<String, Integer> already = first > 0 ? observer.observed() : Map.of();
        for (Soak.Item planned : ledger.planned()) {
            if (!ledger.confirmed(planned.seq()) && !already.containsKey(planned.marker())) {
                retry.add(planned);
            }
        }
        for (long seq = first; seq < plan.total(); seq++) {
            long due = at[(int) seq] - firstAt;
            waitUntil(started, Duration.ofMillis(Math.min(due, remainingSpan)), windows, begun, ended, retry);
            Soak.Item item = new Soak.Item(seq, channelOf(plan, seq), marker(plan, seq), clock.instant());
            ledger.plan(item);
            send(item, retry);
            if (seq % 1000 == 999) {
                progress.accept("sent " + (seq + 1) + " of " + plan.total() + ", " + retry.size() + " waiting to retry");
            }
        }
        // The rest of the faults' windows, then the retries.
        waitUntil(started, Duration.ofMillis(remainingSpan), windows, begun, ended, retry);
        for (Soak.Window w : windows) {
            if (begun.contains(w) && !ended.contains(w)) {
                endFault(w, ended);
            }
        }
        Instant settleBy = clock.instant().plus(plan.settle());
        while (!retry.isEmpty() && clock.instant().isBefore(settleBy)) {
            drainRetries(retry);
            if (!retry.isEmpty()) {
                sleeper.sleep(Duration.ofMillis(200));
            }
        }
        // Settle: wait for the desk to hold every confirmed message.
        Set<String> wanted = new HashSet<>();
        Set<String> unconfirmed = new HashSet<>();
        for (Soak.Item i : ledger.planned()) {
            (ledger.confirmed(i.seq()) ? wanted : unconfirmed).add(i.marker());
        }
        Map<String, Integer> seen = observer.observed();
        while (!seen.keySet().containsAll(wanted) && clock.instant().isBefore(settleBy)) {
            sleeper.sleep(Duration.ofMillis(250));
            seen = observer.observed();
        }
        // A last look a moment later, so a double that lands late is counted.
        sleeper.sleep(Duration.ofMillis(500));
        seen = observer.observed();
        return Soak.reconcile(started, clock.instant(), ledger.planned(), unconfirmed, seen, faultLog, retries);
    }

    private void waitUntil(Instant started, Duration offset, List<Soak.Window> windows, Set<Soak.Window> begun, Set<Soak.Window> ended,
            Deque<Soak.Item> retry) throws Exception {
        Instant due = started.plus(offset);
        while (true) {
            Duration now = Duration.between(started, clock.instant());
            for (Soak.Window w : windows) {
                if (origin != null && !begun.contains(w) && now.compareTo(w.start().plus(w.length())) >= 0) {
                    // Anchored, and this window closed before the run (re)started: it ran then, or the run was down for it.
                    begun.add(w);
                    ended.add(w);
                    continue;
                }
                if (!begun.contains(w) && now.compareTo(w.start()) >= 0) {
                    begun.add(w);
                    faultLog.add(Duration.between(started, clock.instant()) + " begin " + w.fault());
                    progress.accept("fault on: " + w.fault());
                    faults.get(w.fault()).begin();
                }
                if (begun.contains(w) && !ended.contains(w) && now.compareTo(w.start().plus(w.length())) >= 0) {
                    endFault(w, ended);
                }
            }
            drainRetries(retry);
            Duration left = Duration.between(clock.instant(), due);
            if (left.isNegative() || left.isZero()) {
                return;
            }
            sleeper.sleep(left.compareTo(Duration.ofMillis(100)) > 0 ? Duration.ofMillis(100) : left);
        }
    }

    private void endFault(Soak.Window w, Set<Soak.Window> ended) throws Exception {
        ended.add(w);
        faults.get(w.fault()).end();
        faultLog.add(" end " + w.fault());
        progress.accept("fault off: " + w.fault());
    }

    private void send(Soak.Item item, Deque<Soak.Item> retry) throws Exception {
        try {
            channels.get(item.channel()).inject(item);
            ledger.confirm(item.seq());
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            retries++;
            retry.add(item);
        }
    }

    private void drainRetries(Deque<Soak.Item> retry) throws Exception {
        int n = retry.size();
        for (int k = 0; k < n; k++) {
            Soak.Item item = retry.poll();
            try {
                channels.get(item.channel()).inject(item);
                ledger.confirm(item.seq());
            } catch (InterruptedException e) {
                throw e;
            } catch (Exception e) {
                retries++;
                retry.add(item);
                return;
            }
        }
    }
}
