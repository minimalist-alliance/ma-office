package com.minimalistalliance.desk.deskd.browser;

import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Freezes Chromium while nobody looks at the desk and nothing works it, and thaws it before anything touches it again
 * (ADR 0045). There is one of these per desk.
 *
 * <p><b>How.</b> units.sock's {@code freeze desk-browser}, which is systemd's cgroup freezer: every process of the unit
 * stops where it is, in one step, and nothing in Chromium or its pages sees a change of state. The profile, the tabs, the
 * cookies and every sign-in stay exactly as they are (ADR 0035), and {@code thaw desk-browser} lets them all carry on.
 *
 * <p><b>When.</b> All of these at once:
 * <ul>
 *   <li>nobody has viewed the Browser for {@code freezeGrace}: looked at the desk with a Browser window open, a session
 *       wanting {@code warm} or {@code live} ({@link #viewed}, from {@link DeskAttention});
 *   <li>nothing has worked Chromium for {@code workGrace}, and nothing is working it now: no call through deskd that
 *       reaches it ({@link #use}), and no input from desk-rtc ({@link #input});
 *   <li>the units are settled: no hold, no start, stop or restart of desk-browser under way or owed, and the age gate open
 *       ({@link BrowserStream#browserSettled});
 *   <li>Chromium is up on its port, and no member tab's main frame is loading, as far as deskd has heard;
 *   <li>and, checked by desk-units at the moment of the freeze, no download is being written and Chromium
 *       isn't moving data over the network. It then answers {@code busy} with its reason, and any {@code busy} is a clear
 *       no: this tries again in {@code busyRetry}.
 * </ul>
 *
 * <p><b>Thaw first.</b> Unless this is {@link State#RUNNING}, deskd has no connection to Chromium and makes none
 * ({@link #cdpAllowed}). Every call that would reach Chromium waits here for a thaw first: a client's, data.browser.*, the
 * clipboard's, a SUB to the tabs, a {@code live}, and every start or stop of desk-browser ({@link #beforeBrowserStep}).
 * Input, and a session that starts looking at the desk, ask for one without waiting ({@link #wake}), so a look has its
 * thaw under way before its {@code live} comes. Any thaw gives Chromium {@code workGrace} before the next freeze, so a desk
 * doesn't flap.
 *
 * <p><b>On any doubt, thaw.</b> A freeze that ends in anything but {@code ok} or a clear no ({@code busy}, {@code inactive},
 * or a desk-units that doesn't know the verb) is followed at once by a thaw, and a thaw that fails is tried again, sooner
 * at first, until one works. Only a thaw that answers {@code ok} ends a freeze: systemd 257 doesn't thaw a unit for a job,
 * it refuses a start or stop of a frozen unit ({@code JOB_FROZEN}), and a start of one that's running answers ok and
 * leaves it frozen. Every deskd thaws once as it starts, before anything touches Chromium, whatever {@link FreezeMarker}
 * says, as a marker that couldn't be written or a deskd from before this would leave no sign. And {@link #close} thaws
 * before deskd stops, as deskd stops before desk-browser on the way down.
 *
 * <p><b>Locks.</b> {@code lock} guards this state alone, and nothing is called out under it: units.sock, the tabs, the
 * stream, the marker and the listener are all called outside it. One worker thread, alive only while a freeze is armed
 * or a thaw is due, makes every freeze and every thaw, so two never overlap.
 */
final class BrowserFreeze implements BrowserStream.BrowserSteps {

    private static final Logger log = LoggerFactory.getLogger(BrowserFreeze.class);

    /** The longest gap between two tries of a thaw that keeps failing. */
    private static final Duration MAX_THAW_RETRY = Duration.ofSeconds(30);
    /**
     * How long {@link #close} waits for its thaw: a Python process and systemctl, with room for a loaded machine, inside the
     * 5 s deskd has from SIGTERM to its last heartbeat, which goes meanwhile.
     */
    static final Duration CLOSE_THAW_WAIT = Duration.ofSeconds(2);

    /** Where Chromium is. */
    enum State {
        /** Not frozen, as far as deskd knows: the only state with a connection to Chromium. */
        RUNNING,
        /** A freeze is on its way: the connection is going or gone, and the verb may be out. */
        FREEZING,
        /** Frozen, or may be. */
        FROZEN,
        /** A thaw is out. */
        THAWING;

        String wire() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /**
     * @param freezeGrace how long nobody has to have viewed the Browser. Longer than the stream's, so a member flipping
     *     between desks doesn't freeze and thaw each one
     * @param workGrace how long after the last work, a thaw or a start of Chromium included. Past deskd's longest call to
     *     Chromium (a navigation's 30 s and a session's 5 s), so a call that began that long ago has ended
     * @param busyRetry when to look again after desk-units said busy, Chromium wasn't up, the units weren't settled or a
     *     tab was loading
     * @param failRetry when to try again after a freeze that failed for another reason, which is thawed at once
     * @param thawRetry the first wait before trying a failed thaw again. It doubles, up to 30 s
     * @param thawWait how long a call waits for a thaw before it goes on and finds Chromium unreachable
     * @param letGo how long the connection to Chromium gets to go before a freeze gives up
     */
    record Timing(
            Duration freezeGrace,
            Duration workGrace,
            Duration busyRetry,
            Duration failRetry,
            Duration thawRetry,
            Duration thawWait,
            Duration letGo) {
        static final Timing DEFAULT = new Timing(
                Duration.ofSeconds(60),
                Duration.ofSeconds(60),
                Duration.ofSeconds(30),
                Duration.ofMinutes(5),
                Duration.ofSeconds(1),
                Duration.ofSeconds(10),
                Duration.ofSeconds(3));
    }

    /** What a freeze needs of the tabs ({@link BrowserTabs}). */
    interface Tabs {
        /** A member tab's main frame is loading, as far as deskd has heard. False with no connection. Doesn't block. */
        boolean loading();

        /** What wants the connection may have changed. Never blocks. */
        void wake();

        /** @return true once the connection to Chromium, and anything trying to make one, has gone within the wait */
        boolean letGo(Duration wait) throws InterruptedException;
    }

    private static final Tabs NO_TABS = new Tabs() {
        @Override
        public boolean loading() {
            return false;
        }

        @Override
        public void wake() {}

        @Override
        public boolean letGo(Duration wait) {
            return true;
        }
    };

    /** A call that may reach Chromium: from {@link #use} until it's closed, Chromium isn't frozen. */
    final class Use implements AutoCloseable {
        private boolean done;

        private Use() {}

        @Override
        public void close() {
            if (!done) {
                done = true;
                ended();
            }
        }
    }

    private final BrowserStream.Units units;
    private final Timing timing;
    private final FreezeMarker marker;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition moved = lock.newCondition();
    private volatile BooleanSupplier settled = () -> false;
    private volatile BooleanSupplier chromiumUp = () -> false;
    private volatile Tabs tabs = NO_TABS;
    private volatile Runnable changed = () -> {};
    /** {@code state == RUNNING}, for whoever asks without the lock. */
    private volatile boolean cdpAllowed = true;
    /** {@code state} is FROZEN or THAWING and the freeze is known, for whoever asks without the lock. */
    private volatile boolean frozenNow;
    /**
     * A freeze answered ok, or may have half worked, or a marker said so: not just the thaw every deskd starts with, which
     * /health, the heartbeat and the topic don't call frozen.
     */
    private boolean knownFrozen;

    private State state = State.RUNNING;
    /** Chromium may be frozen, and nothing need want it for a thaw: after a freeze that failed, or a marker at start. */
    private boolean thawOwed;
    /** Something asked for a thaw and hasn't had one yet. */
    private boolean thawWanted;
    /** False once desk-units has said it doesn't know the verb: this image can't freeze. */
    private boolean supported = true;
    private boolean viewed;
    private long unviewedSince;
    private long lastWork;
    private int inFlight;
    /** Starts and stops of desk-browser under way ({@link #beforeBrowserStep}). */
    private int pins;
    /** No freeze is tried before this. */
    private long notBefore;
    private long nextThawAt;
    private int thawFailures;
    /** Thaws that have ended, either way, so a waiter can tell that one failed while it waited. */
    private long thawsEnded;
    private long frozenAt;
    /** Calls parked in {@link #awaitThawed}, for tests. */
    private int waiting;
    private Thread worker;
    private boolean closed;

    /**
     * Starts in doubt: nothing reaches Chromium until the thaw that {@link #start} sends has answered.
     *
     * @param marker read here, once: it says an earlier deskd of this boot may have left Chromium frozen, which only
     *     changes what /health and the topic say meanwhile, as every start thaws anyway
     */
    BrowserFreeze(BrowserStream.Units units, Timing timing, FreezeMarker marker) {
        this.units = units;
        this.timing = timing;
        this.marker = marker;
        long now = System.nanoTime();
        this.unviewedSince = now;
        this.lastWork = now;
        this.notBefore = now;
        this.nextThawAt = now;
        this.frozenAt = now;
        state = State.FROZEN;
        thawOwed = true;
        knownFrozen = marker.present();
        if (knownFrozen) {
            log.info("an earlier deskd may have left Chromium frozen");
        }
        flagsLocked();
    }

    /**
     * Where the rest comes from. Set once, before {@link #start}.
     *
     * @param settled {@link BrowserStream#browserSettled}. Asked on the worker, outside this lock
     * @param chromiumUp whether Chromium is up on its port. May read /proc
     * @param changed runs after {@link #frozen} may have changed, outside this lock. Must not block
     */
    void follow(BooleanSupplier settled, BooleanSupplier chromiumUp, Tabs tabs, Runnable changed) {
        this.settled = settled;
        this.chromiumUp = chromiumUp;
        this.tabs = tabs;
        this.changed = changed;
    }

    /** Sends the thaw every start begins with, and so arms the first freeze. */
    void start() {
        lock.lock();
        try {
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
    }

    /**
     * No freeze from now on, and Chromium thawed before this returns, or the wait is over. deskd stops before desk-browser
     * on the way down, and systemd won't stop a frozen unit, so a Chromium left frozen would be killed without writing its
     * session. A freeze on its way is waited for, then thawed. Only a freeze that's known or on its way is waited for: the
     * doubt every deskd starts with, while its first thaw keeps failing, gets one more try and no wait, as a units.sock that
     * won't answer won't answer now either, and deskd's shutdown has 5 s.
     *
     * @return true if Chromium isn't frozen
     */
    boolean close(Duration wait) {
        long deadline = System.nanoTime() + wait.toNanos();
        boolean thawed;
        lock.lock();
        try {
            closed = true;
            if (state != State.RUNNING) {
                thawOwed = true;
                nextThawAt = System.nanoTime();
            }
            startWorkerIfDue();
            moved.signalAll();
            boolean worthWaiting = knownFrozen || state == State.FREEZING;
            while (worthWaiting && state != State.RUNNING) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    break;
                }
                moved.awaitNanos(left);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            thawed = state == State.RUNNING;
            lock.unlock();
        }
        if (!thawed) {
            log.warn("Chromium may still be frozen as deskd stops: systemd won't stop it, so the image has to thaw it first");
        }
        return thawed;
    }

    /** Whether deskd may connect to Chromium now. Never blocks. */
    boolean cdpAllowed() {
        return cdpAllowed;
    }

    /** Chromium is frozen, or may be: what /health, the heartbeat and {@code desk.attention} say. Never blocks. */
    boolean frozen() {
        return frozenNow;
    }

    /**
     * For /health: {@code running}, {@code freezing}, {@code frozen}, {@code thawing}, or {@code unsupported}. The thaw every
     * start begins with is {@code thawing}, unless a marker said Chromium was frozen.
     */
    String health() {
        lock.lock();
        try {
            if (state == State.FROZEN && !knownFrozen) {
                return State.THAWING.wire();
            }
            return supported || state != State.RUNNING ? state.wire() : "unsupported";
        } finally {
            lock.unlock();
        }
    }

    /** Starts and stops of desk-browser waiting here or under way, for tests. */
    int pinned() {
        lock.lock();
        try {
            return pins;
        } finally {
            lock.unlock();
        }
    }

    /** Calls parked waiting for a thaw, for tests. */
    int waitingForThaw() {
        lock.lock();
        try {
            return waiting;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Someone views the Browser, or nobody does: a session looking at the desk wants {@code warm} or {@code live}. Viewing
     * thaws at once, without waiting for it, and nobody viewing arms the freeze for {@code freezeGrace} from now. Never
     * blocks.
     */
    void viewed(boolean viewed) {
        lock.lock();
        try {
            if (this.viewed == viewed) {
                return;
            }
            this.viewed = viewed;
            if (!viewed) {
                unviewedSince = System.nanoTime();
            }
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Something will likely want Chromium soon, such as a session that has just started looking at the desk: a thaw now,
     * without waiting for it, and so {@code workGrace} before the next freeze. Never blocks.
     */
    void wake() {
        lock.lock();
        try {
            if (state != State.RUNNING) {
                thawWanted = true;
            }
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** desk-rtc put input on the screen: it's work, and Chromium is thawed to take it. Never blocks. */
    void input() {
        lock.lock();
        try {
            lastWork = System.nanoTime();
            if (state != State.RUNNING) {
                thawWanted = true;
            }
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * A call that may reach Chromium begins: it's work until it's closed, and Chromium is thawed first. Parks for up to
     * {@code thawWait}. If the thaw doesn't come in that time the call goes on anyway, and finds Chromium unreachable, as
     * {@link #cdpAllowed} keeps the connection away until it does.
     */
    Use use() throws InterruptedException {
        lock.lock();
        try {
            inFlight++;
            lastWork = System.nanoTime();
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        Use use = new Use();
        try {
            awaitThawed(timing.thawWait());
        } catch (InterruptedException e) {
            use.close();
            throw e;
        }
        return use;
    }

    private void ended() {
        lock.lock();
        try {
            inFlight--;
            lastWork = System.nanoTime();
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Asks for a thaw if one's needed, and parks until Chromium is running, a thaw has failed, or the wait is over.
     *
     * @return true if Chromium isn't frozen
     */
    boolean awaitThawed(Duration wait) throws InterruptedException {
        long deadline = System.nanoTime() + wait.toNanos();
        lock.lock();
        try {
            if (state == State.RUNNING) {
                return true;
            }
            thawWanted = true;
            startWorkerIfDue();
            moved.signalAll();
            long endedBefore = thawsEnded;
            waiting++;
            try {
                while (state != State.RUNNING) {
                    if (thawsEnded != endedBefore && state == State.FROZEN) {
                        return false;
                    }
                    long left = deadline - System.nanoTime();
                    if (left <= 0) {
                        return false;
                    }
                    moved.awaitNanos(left);
                }
                return true;
            } finally {
                waiting--;
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * On {@link BrowserStream}'s worker, before a start or stop of desk-browser: no freeze begins until {@link
     * #afterBrowserStep}, one already out is waited for, and Chromium is thawed. systemd doesn't thaw for a job, so this is
     * what does. If the thaw fails the step still goes: a stop is then refused, and the failure goes to whoever asked, and
     * a start of a running Chromium answers ok and leaves it frozen, which this goes on saying until a thaw works.
     */
    @Override
    public void beforeBrowserStep() throws InterruptedException {
        lock.lock();
        try {
            pins++;
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        awaitThawed(timing.thawWait());
    }

    /**
     * The step is done. Whatever it answered says nothing of the freeze: only a thaw that answers ok ends one, as a start of
     * a running frozen unit answers ok too.
     */
    @Override
    public void afterBrowserStep(boolean worked) {
        lock.lock();
        try {
            pins--;
            lastWork = System.nanoTime();
            startWorkerIfDue();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    // ---- the worker

    private void flagsLocked() {
        cdpAllowed = state == State.RUNNING;
        frozenNow = knownFrozen && (state == State.FROZEN || state == State.THAWING);
    }

    private boolean thawDueLocked() {
        return state == State.FROZEN && (thawOwed || thawWantedLocked());
    }

    private boolean thawWantedLocked() {
        return thawWanted || viewed || inFlight > 0 || pins > 0;
    }

    private boolean freezeArmedLocked() {
        return state == State.RUNNING && supported && !closed && !thawOwed && !thawWantedLocked();
    }

    /** The latest of the graces and the backoff. */
    private long freezeAtLocked() {
        long at = unviewedSince + timing.freezeGrace().toNanos();
        long afterWork = lastWork + timing.workGrace().toNanos();
        if (afterWork - at > 0) {
            at = afterWork;
        }
        if (notBefore - at > 0) {
            at = notBefore;
        }
        return at;
    }

    private void startWorkerIfDue() {
        if (worker == null && (thawDueLocked() || freezeArmedLocked())) {
            worker = Thread.ofVirtual().name("browser-freeze").start(this::work);
        }
    }

    private void work() {
        while (true) {
            boolean thaw;
            lock.lock();
            try {
                // Closed, it still thaws: freezeArmedLocked is false once closed.
                if (!(thawDueLocked() || freezeArmedLocked())) {
                    worker = null;
                    return;
                }
                long now = System.nanoTime();
                long wait = thawDueLocked() ? nextThawAt - now : freezeAtLocked() - now;
                if (wait > 0) {
                    moved.awaitNanos(wait);
                    continue;
                }
                thaw = thawDueLocked();
                if (thaw) {
                    state = State.THAWING;
                    flagsLocked();
                }
            } catch (InterruptedException e) {
                // Nothing interrupts this thread. If something did, it ends, and the next change starts another.
                worker = null;
                return;
            } finally {
                lock.unlock();
            }
            if (thaw) {
                thaw();
            } else {
                tryFreeze();
            }
        }
    }

    private void tryFreeze() {
        // Outside the lock: the stream's own lock, a read of /proc, and the tabs' lock.
        boolean ready = settled.getAsBoolean() && chromiumUp.getAsBoolean() && !tabs.loading();
        lock.lock();
        try {
            long now = System.nanoTime();
            if (!ready) {
                notBefore = now + timing.busyRetry().toNanos();
                return;
            }
            // Something can have moved while that was asked.
            if (!freezeArmedLocked() || freezeAtLocked() - now > 0) {
                return;
            }
            state = State.FREEZING;
            flagsLocked();
        } finally {
            lock.unlock();
        }
        long began = System.nanoTime();
        boolean gone;
        try {
            tabs.wake();
            gone = tabs.letGo(timing.letGo());
        } catch (InterruptedException e) {
            gone = false;
        }
        boolean stays;
        lock.lock();
        try {
            // A call, a step, input or a look came while the connection went: Chromium stays as it is.
            stays = !gone || thawWantedLocked() || closed;
            if (stays) {
                state = State.RUNNING;
                if (!gone) {
                    notBefore = System.nanoTime() + timing.busyRetry().toNanos();
                }
                thawWanted = false;
                flagsLocked();
                moved.signalAll();
            }
        } finally {
            lock.unlock();
        }
        if (stays) {
            if (!gone) {
                log.info("browser not frozen: the connection to Chromium didn't go in time");
            }
            tabs.wake();
            return;
        }
        marker.write(true);
        UnitException failure = run(UnitsClient.FREEZE);
        long took = System.nanoTime() - began;
        boolean running;
        lock.lock();
        try {
            long now = System.nanoTime();
            if (failure == null) {
                state = State.FROZEN;
                knownFrozen = true;
                frozenAt = now;
            } else if (failure.freezeDeclined()) {
                state = State.RUNNING;
                notBefore = now + timing.busyRetry().toNanos();
            } else if (failure.verbUnknown()) {
                state = State.RUNNING;
                supported = false;
            } else {
                // Not a clear no: some or all of it may be frozen. Thawed at once, and no freeze for a while.
                state = State.FROZEN;
                knownFrozen = true;
                frozenAt = now;
                thawOwed = true;
                notBefore = now + timing.failRetry().toNanos();
            }
            running = state == State.RUNNING;
            flagsLocked();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        if (failure == null) {
            log.info("browser frozen in {} ms", TimeUnit.NANOSECONDS.toMillis(took));
        } else if (failure.freezeDeclined()) {
            // The code only: the text says what the desk was doing.
            log.info("browser not frozen: {}", failure.code());
        } else if (failure.verbUnknown()) {
            log.info("browser not frozen: this image's desk-units can't freeze ({}), so this deskd won't ask again", failure.code());
        } else {
            log.warn("freeze desk-browser failed: {}, so it's thawed now", failure.code());
        }
        if (running) {
            marker.write(false);
            tabs.wake();
        } else {
            changed.run();
        }
    }

    private void thaw() {
        long began = System.nanoTime();
        UnitException failure = run(UnitsClient.THAW);
        // A desk-units that doesn't know the verb can't have frozen anything, and an inactive unit isn't frozen.
        boolean thawed = failure == null || failure.verbUnknown() || UnitException.INACTIVE.equals(failure.code());
        long took = System.nanoTime() - began;
        long frozenFor;
        long retry = 0;
        boolean wasKnown;
        lock.lock();
        try {
            long now = System.nanoTime();
            wasKnown = knownFrozen;
            thawsEnded++;
            frozenFor = now - frozenAt;
            if (failure != null && failure.verbUnknown()) {
                supported = false;
            }
            if (thawed) {
                state = State.RUNNING;
                knownFrozen = false;
                thawOwed = false;
                thawWanted = false;
                thawFailures = 0;
                nextThawAt = now;
                // A thaw is work: whatever asked for it gets Chromium for a while.
                lastWork = now;
            } else {
                state = State.FROZEN;
                thawOwed = true;
                thawFailures++;
                retry = Math.min(
                        timing.thawRetry().toNanos() << Math.min(thawFailures - 1, 16), MAX_THAW_RETRY.toNanos());
                nextThawAt = now + retry;
            }
            flagsLocked();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        if (thawed) {
            log.info("browser thawed in {} ms after {} s {}",
                    TimeUnit.NANOSECONDS.toMillis(took), TimeUnit.NANOSECONDS.toSeconds(frozenFor), wasKnown ? "frozen" : "since deskd started");
            marker.write(false);
            tabs.wake();
        } else {
            log.warn("thaw desk-browser failed: {}, trying again in {} ms", failure.code(), TimeUnit.NANOSECONDS.toMillis(retry));
        }
        changed.run();
    }

    private UnitException run(String verb) {
        try {
            units.run(verb, UnitsClient.DESK_BROWSER);
            return null;
        } catch (UnitException e) {
            return e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new UnitException(UnitsClient.DESK_BROWSER, UnitException.INTERNAL, null);
        } catch (RuntimeException e) {
            log.error("{} desk-browser failed: {}", verb, e.getClass().getName());
            return new UnitException(UnitsClient.DESK_BROWSER, UnitException.INTERNAL, null);
        }
    }
}
