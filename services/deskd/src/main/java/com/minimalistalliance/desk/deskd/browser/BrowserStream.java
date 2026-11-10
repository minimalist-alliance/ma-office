package com.minimalistalliance.desk.deskd.browser;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What each session wants of the Browser stream, and getting the desk's units to match
 * (desk-runtime.md 8.4). There is one of these per desk.
 *
 * <p><b>Converging.</b> Requests only change what's wanted. One worker thread, alive only while there's
 * something to do, compares that with where the units are, takes one step, and looks again. So nothing
 * races: an off during a start lets the start finish and then stops, and a live during a stop lets the
 * stop finish and then starts. Each step is up to 45 s on units.sock (95 s for a stop of desk-browser), and nothing else waits for it.
 *
 * <p><b>What a request waits for.</b> Each one waits for steps that began after it came, because the
 * unit it wants could have been stopping when the last step began. So a repeated {@code live} starts
 * the units again, which is harmless, and is how a unit that has stopped by itself comes back. A
 * caller can stop waiting at any time, since the work doesn't depend on it.
 *
 * <p><b>Media.</b> {@code session.video} goes out under the lock, so two of them for one session can't
 * pass each other. Going off, or warm, cuts media before any step. Going live sends it after the steps,
 * as the table says, unless both units are already known to be up: then it goes at once and the steps
 * follow, because B13 gives warm to live 300 ms and each step costs a Python process and systemctl.
 *
 * <p><b>Chromium off its port.</b> It's restarted here too, as a stop and a start in one go, so a request's own
 * steps can't fall between them ({@link #browserDisplaced}).
 *
 * <p><b>A refused Chromium.</b> desk-units can refuse a start of {@code desk-browser} because of what's in the profile
 * ({@link UnitException#browserRefused}), and only a fix on the desk changes that: a newer image, or Chromium updated in
 * place. Each try costs a Python process, setpriv and a crit line in the journal. So a client's request still tries
 * every time, as it's what finds out a fix has come, and so {@link #chromiumRefused} can't stay stale. What deskd does
 * by itself is bounded: a lost Chromium asks for a start at most once per {@code restartEvery} ({@link #browserLost}),
 * a Chromium off its port isn't stopped ({@link #browserDisplaced}), and the CDP connector isn't hurried for a browser
 * that likely won't come. The refusal outlives a restart of deskd ({@link RefusalMarker}).
 *
 * <p><b>Held.</b> {@link #hold} keeps Chromium stopped, so a copy of its profile is exact (data.browser.hold): a stop of
 * {@code desk-browser} goes through the worker like any step, and until {@link #release} no start of it goes out, and a
 * {@code live} or {@code warm} is refused, as are the ones still waiting. What sessions already settled on stays wanted,
 * so a release brings Chromium back for whoever still wants {@code live}. A Chromium off its port isn't restarted while
 * held. Who holds it, and for how long, is the data module's ({@code BrowserHold}).
 *
 * <p><b>Paused.</b> While the Platform's bandwidth pause is on (ma-platform ADR 0095, {@link #pauseFrom}), a {@code live}
 * is refused before anything changes, and {@link #endLiveForPause} leaves every session that wanted it {@code off}, its
 * video cut at once, with desk-stream stopped once nobody wants {@code warm}. Chromium is never stopped or started for
 * it, so its tabs, cookies and history stay as they are (ADR 0035), and {@code warm}, input and every other app go on.
 *
 * <p><b>The age gate.</b> No start of {@code desk-browser} goes out while the gate is shut ({@link #ageGateFrom}): the
 * owner's age band isn't known, or its file would take the teen policy away. That covers every way to a start, as they all
 * come through {@link #nextStep}: a {@code live}, a lost Chromium coming back, the start after a Chromium off its port, and
 * the one after a hold. {@code warm} doesn't start Chromium ({@code desk-stream} needs only Xorg), so it isn't gated. A
 * {@code live} is answered {@link UnitException#ageBand} at once, and it stays wanted, so it starts as the gate opens,
 * and a client that asks again meanwhile is harmless. Its session can still say {@code off}.
 *
 * <p><b>Restarting for the policy.</b> {@link #restartForPolicy} stops Chromium so the next start reads the band's file,
 * and starts it again if it was up. The profile isn't touched, and Chromium writes its session on the stop, so the
 * member's tabs, cookies and history carry over (ADR 0035). It runs even after a refusal: a teen without a Browser is safe,
 * and one on the wrong policy isn't. While a hold is on it waits for the release. Until its stop has worked, the gate
 * stays shut, and a stop that fails is tried again, as there's nothing else to catch a Chromium left on the wrong policy.
 *
 * <p><b>Nobody looking.</b> {@link #mediaAllowed} false, from {@link DeskAttention}, cuts every session's media while
 * what each wants stays as it is, so desk-rtc pauses desk-stream and nothing is captured or encoded: a {@code live} is held
 * at what {@code warm} costs. Back to true, media goes again at once, as from {@code warm}. A session that has never sent
 * {@code desk.attention.set} counts as looking while it wants {@code warm} or more, so a client from before it is never
 * cut ({@link #legacySeen}).
 *
 * <p><b>A frozen Chromium.</b> Every start or stop of {@code desk-browser} goes through {@link BrowserSteps} first, which
 * thaws it and keeps a freeze from beginning until the step is done (ADR 0045). {@link #browserSettled} says when there's
 * nothing of desk-browser under way or owed, which a freeze waits for.
 *
 * <p><b>Locks.</b> Held only for state. No unit call happens under it. The rtc reader calls
 * {@link #sessionEnded}, so everything here returns quickly.
 *
 * <p><b>Timing.</b> A request that changes what its session wants ends in one {@link Transition}, which
 * {@link BrowserModule} logs. A repeat of the same level doesn't, though it does run the steps again.
 */
public final class BrowserStream {

    private static final Logger log = LoggerFactory.getLogger(BrowserStream.class);

    /** How long after a failed stop {@link #restartForPolicy} tries again. Each try is a Python process and systemctl. */
    static final Duration POLICY_RESTART_RETRY = Duration.ofSeconds(10);

    /** What a session asks for. */
    public enum Level {
        OFF,
        WARM,
        LIVE;

        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** @return null if this isn't a state */
        public static Level parse(String wire) {
            return switch (wire == null ? "" : wire) {
                case "off" -> OFF;
                case "warm" -> WARM;
                case "live" -> LIVE;
                default -> null;
            };
        }
    }

    /** {@link UnitsClient#run}. */
    @FunctionalInterface
    public interface Units {
        void run(String verb, String unit) throws UnitException, InterruptedException;
    }

    /** What a start or stop of desk-browser waits for, and tells when it's done: {@link BrowserFreeze}. */
    interface BrowserSteps {
        /** On the worker, outside the lock, right before the step. May park. */
        void beforeBrowserStep() throws InterruptedException;

        /** @param worked the step answered ok */
        void afterBrowserStep(boolean worked);
    }

    private static final BrowserSteps NO_STEPS = new BrowserSteps() {
        @Override
        public void beforeBrowserStep() {}

        @Override
        public void afterBrowserStep(boolean worked) {}
    };

    /** session.video. Must not block. */
    @FunctionalInterface
    public interface Video {
        void set(String sessionId, boolean view);
    }

    /**
     * One request that changed what its session wants, as it came out, for the log. Unit times are what was
     * spent in that step's units.sock call, and -1 if this request needed none.
     *
     * @param started {@link System#nanoTime} when it came
     * @param unitsNanos from then until the request was answered
     * @param outcome {@code ok}, {@code overtaken} by a newer request or the session's end, or a unit's error code
     */
    public record Transition(
            Level from,
            Level to,
            long started,
            long browserStartNanos,
            long streamStartNanos,
            long stopNanos,
            long unitsNanos,
            String outcome) {}

    private static final class Want {
        Level level = Level.OFF;
        long arrival;
        /** deskd's say: this session gets media when the desk is looked at. */
        boolean viewing;
        /** What desk-rtc was last told: {@code viewing}, unless nobody has looked at the desk for a while. */
        boolean sent;
        /** Its {@code live} was answered {@link UnitException#ageBand}, and starts as the gate opens. */
        boolean waitingForGate;
    }

    private static final class Waiter {
        final String sessionId;
        final Level level;
        final Level from;
        final long started;
        final CompletableFuture<Level> result = new CompletableFuture<>();
        boolean needsBrowser;
        boolean needsStream;
        boolean needsStop;
        long browserStartNanos = -1;
        long streamStartNanos = -1;
        long stopNanos = -1;

        Waiter(String sessionId, Level level, Level from, long started) {
            this.sessionId = sessionId;
            this.level = level;
            this.from = from;
            this.started = started;
        }
    }

    /**
     * @param hold completes when this step ends, for the stop that {@link #hold} asked for, and null for any other
     * @param forPolicy this is the stop {@link #restartForPolicy} asked for
     */
    private record Step(String verb, String unit, List<Waiter> covered, CompletableFuture<Void> hold, boolean forPolicy) {
        Step(String verb, String unit, List<Waiter> covered) {
            this(verb, unit, covered, null, false);
        }
    }

    private final Units units;
    private final Video video;
    private final Predicate<String> sessionLive;
    private final Runnable viewersChanged;
    private final Runnable browserStarting;
    private final Consumer<Transition> transitions;
    private final long restartEveryNanos;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Want> wants = new HashMap<>();
    private final List<Waiter> waiters = new ArrayList<>();
    private Thread worker;
    private Step current;
    private boolean browserKnownUp;
    private boolean streamKnownUp;
    /** desk-stream may be running, even halfway, so it needs a stop once nobody wants it. */
    private boolean stopDue;
    /**
     * A stop failed. There's no retrying on a timer, but the next off tries again, and so does any session
     * ending with nobody left who wants the stream.
     */
    private boolean stopFailed;
    /** Chromium went away under a viewer. */
    private boolean browserStartDue;
    /** Chromium is up off its port, so it wants a stop. */
    private boolean browserRestartDue;
    /** That stop has gone, whatever came of it, so a start follows whoever wants what. */
    private boolean browserRestartStarting;
    private boolean restartedBefore;
    private long lastRestartNanos;
    /** A stream desk-rtc reports may be one an earlier deskd left, as this one hasn't started any yet. */
    private boolean leftoverPossible = true;
    /**
     * A start of desk-browser was refused, and none has worked since. A timeout or a lost socket in between says nothing
     * about the profile, so it leaves this alone. {@link #marker} keeps it across a restart of deskd.
     */
    private boolean chromiumRefused;
    /** When desk-browser was last asked to start, for whatever reason, if it has been in this process. */
    private boolean browserStartedBefore;
    private long lastBrowserStartNanos;
    /** Chromium is to stay stopped: {@link #hold}. */
    private boolean held;
    /** The stop that the hold asked for hasn't begun. */
    private boolean holdStopDue;
    /** Completes once that stop has ended. */
    private CompletableFuture<Void> holdStopped;
    /** Chromium was running when the hold stopped it, so the release starts it again, whoever wants what. */
    private boolean startAfterHold;
    private final RefusalMarker marker;
    /** Whether Chromium is up, by its port, asked on the worker just before a hold's stop. May block a little. */
    private final BooleanSupplier chromiumRunning;
    /** When the Platform's bandwidth pause ends, or null with none: {@link #pauseFrom}. Read under the lock. */
    private volatile Supplier<Instant> pausedUntil = () -> null;
    /** Whether the owner's age band lets Chromium start: {@link #ageGateFrom}. Read under the lock. */
    private volatile BooleanSupplier ageGate = () -> true;
    private volatile Duration policyRestartRetry = POLICY_RESTART_RETRY;
    /** False while nobody has looked at the desk for a while ({@link #mediaAllowed}). */
    private boolean mediaAllowed = true;
    /** Whether a session has ever sent desk.attention.set. Asked under the lock, so it must not block. */
    private volatile Predicate<String> attended = sessionId -> false;
    private volatile BrowserSteps browserSteps = NO_STEPS;
    /** {@link #restartForPolicy}'s stop has yet to begin. */
    private boolean policyRestartDue;
    /** {@link #restartForPolicy}'s stop has yet to work, so Chromium may be on the wrong policy, and no start goes out. */
    private boolean policyRestartOwed;

    /**
     * @param sessionLive so a request that loses a race with its session's end leaves nothing behind
     * @param viewersChanged runs after the set of sessions wanting the stream may have changed. Must
     *     not block
     * @param browserStarting runs as {@code desk-browser} is asked to start, unless the last start was refused, and
     *     again once it has started. Must not block
     * @param transitions hears each request that changed what its session wants, once it's answered.
     *     Runs with this class's lock held, so it must not block
     * @param restartEvery the smallest gap between two restarts of a Chromium that's off its port, and, while a start is
     *     refused, between the last start of desk-browser and one that a lost Chromium asks for
     * @param marker read here, once, for a refusal an earlier deskd of this boot saw
     */
    BrowserStream(
            Units units,
            Video video,
            Predicate<String> sessionLive,
            Runnable viewersChanged,
            Runnable browserStarting,
            Consumer<Transition> transitions,
            Duration restartEvery,
            RefusalMarker marker) {
        this(units, video, sessionLive, viewersChanged, browserStarting, transitions, restartEvery, marker, () -> false);
    }

    /**
     * @param chromiumRunning whether Chromium is up now, by its port: asked on the worker just before a hold's stop, so
     *     the release can start again a Chromium that was running with nobody viewing
     */
    BrowserStream(
            Units units,
            Video video,
            Predicate<String> sessionLive,
            Runnable viewersChanged,
            Runnable browserStarting,
            Consumer<Transition> transitions,
            Duration restartEvery,
            RefusalMarker marker,
            BooleanSupplier chromiumRunning) {
        this.chromiumRunning = chromiumRunning;
        this.units = units;
        this.video = video;
        this.sessionLive = sessionLive;
        this.viewersChanged = viewersChanged;
        this.browserStarting = browserStarting;
        this.transitions = transitions;
        this.restartEveryNanos = restartEvery.toNanos();
        this.marker = marker;
        this.chromiumRefused = marker.present();
        if (chromiumRefused) {
            log.info("a refused start of Chromium is remembered from before this process");
        }
    }

    /**
     * Sets what this session wants. The want applies from here on, whoever is still waiting. An older
     * request of the session that's overtaken by a newer one changes nothing.
     *
     * @param arrival {@link com.minimalistalliance.desk.deskd.rpc.RpcContext#arrival}
     * @return completes with the session's level once the units are there, or with a
     *     {@link UnitException} if a step this request needed failed
     */
    public CompletableFuture<Level> set(String sessionId, Level level, long arrival) {
        long started = System.nanoTime();
        CompletableFuture<Level> result;
        lock.lock();
        try {
            result = setLocked(sessionId, level, arrival, started);
        } finally {
            lock.unlock();
        }
        viewersChanged.run();
        return result;
    }

    private CompletableFuture<Level> setLocked(String sessionId, Level level, long arrival, long started) {
        if (!sessionLive.test(sessionId)) {
            return CompletableFuture.completedFuture(Level.OFF);
        }
        // Refused before anything changes: what the session wanted before still stands.
        if (held && level != Level.OFF) {
            return CompletableFuture.failedFuture(UnitException.held());
        }
        if (level == Level.LIVE) {
            Instant until = pausedUntil.get();
            if (until != null) {
                return CompletableFuture.failedFuture(UnitException.paused(until));
            }
        }
        Want want = wants.computeIfAbsent(sessionId, id -> new Want());
        if (arrival <= want.arrival) {
            return CompletableFuture.completedFuture(want.level);
        }
        Level from = want.level;
        want.arrival = arrival;
        want.level = level;
        answerEarlierRequests(sessionId, level);
        want.waitingForGate = level == Level.LIVE && !ageGateOpenLocked();
        if (want.waitingForGate) {
            applyMediaLocked();
            return CompletableFuture.failedFuture(UnitException.ageBand());
        }
        Waiter waiter = new Waiter(sessionId, level, from, started);
        switch (level) {
            case LIVE -> {
                waiter.needsBrowser = true;
                waiter.needsStream = true;
                if (browserKnownUp && streamKnownUp) {
                    sendView(sessionId, want, true);
                }
            }
            case WARM -> {
                waiter.needsStream = true;
                if (want.viewing) {
                    sendView(sessionId, want, false);
                }
            }
            case OFF -> {
                sendView(sessionId, want, false);
                retryAFailedStop();
                waiter.needsStop = true;
                if (streamStopRunning()) {
                    current.covered().add(waiter);
                }
            }
        }
        waiters.add(waiter);
        settle();
        startWorkerIfDue();
        return waiter.result;
    }

    /**
     * The session has ended, whichever way. That counts as off, and its video is cut at once. Runs on
     * whatever thread ended it, which may be the rtc reader.
     */
    public void sessionEnded(String sessionId) {
        lock.lock();
        try {
            Want want = wants.remove(sessionId);
            if (want == null && !stopFailed) {
                return;
            }
            if (want != null && want.viewing) {
                sendView(sessionId, want, false);
            }
            if (want != null) {
                answerEarlierRequests(sessionId, Level.OFF);
            }
            if (!anyWant(Level.WARM)) {
                retryAFailedStop();
            }
            settle();
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
        viewersChanged.run();
    }

    /**
     * Chromium has gone away. If someone is watching, it should come back. After a refusal, though, only if the last
     * start of desk-browser was at least {@code restartEvery} ago: something that keeps answering on the port and
     * dropping would otherwise bring a start each time, and each start kept the connector at its smallest gap, so that
     * was about 4 a second for ever. Never asking again would leave a refusal that has since gone away, after a fix or
     * from an earlier deskd, keeping a viewer from the Chromium that's there to be had.
     */
    public void browserLost() {
        lock.lock();
        try {
            browserKnownUp = false;
            if (anyWant(Level.LIVE)
                    && (!chromiumRefused
                            || !browserStartedBefore
                            || System.nanoTime() - lastBrowserStartNanos >= restartEveryNanos)) {
                browserStartDue = true;
                startWorkerIfDue();
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Chromium is up on ::1, as 127.0.0.1 was taken when it started ({@link CdpListener.Kind#DISPLACED}). Nothing else
     * would ever move it, since a start of a running unit does nothing, so it gets a stop and a start, which give it the
     * port if that's free now. It leaves Chromium running, as it found it, whoever wants what. It writes its session on
     * the stop, so the tabs come back, but they reload, and something holding the port unseen would send it back to ::1
     * each time. So this happens at most once per {@code restartEvery}. Not at all while a start is known to be refused:
     * the stop would take away a Chromium that's working, and the start would very likely be refused. For the same reason
     * a restart asked for while a start is on its way is dropped if that start is refused. Runs on whatever thread
     * looked at the port.
     */
    public void browserDisplaced() {
        lock.lock();
        try {
            long now = System.nanoTime();
            if (held
                    || !ageGateOpenLocked()
                    || chromiumRefused
                    || browserRestartDue
                    || browserRestartStarting
                    || (restartedBefore && now - lastRestartNanos < restartEveryNanos)) {
                return;
            }
            restartedBefore = true;
            lastRestartNanos = now;
            browserRestartDue = true;
            browserKnownUp = false;
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
    }

    /**
     * What desk-rtc said about desk-stream. Only one thing matters here: after a restart of deskd alone,
     * desk-stream may still be running with nobody to want it. So the first time a stream shows up before
     * this process has started one, it's stopped unless a session wants it by then. It may still be
     * connecting when this process starts, so a down doesn't settle it. A fresh boot only ever says down
     * until deskd starts the stream, so it costs nothing.
     */
    public void observeStreamState(String state) {
        lock.lock();
        try {
            if (!leftoverPossible || "down".equals(state)) {
                return;
            }
            leftoverPossible = false;
            if (!anyWant(Level.WARM)) {
                stopDue = true;
                startWorkerIfDue();
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Keeps Chromium stopped until {@link #release}: a stop of {@code desk-browser} now, and no start of it after. A
     * {@code live} or {@code warm} still waiting fails with {@link UnitException#held}, and so does any that comes while
     * held, while what sessions had settled on stays as it was. Asked again while held, it's the same stop.
     *
     * <p>If Chromium was up when the stop came (started by this process and not lost since, or its uid on the port), or a
     * restart of it was under way ({@link #browserDisplaced}, which leaves it running), the release starts it again even
     * with nobody wanting {@code live}, so the desk is left as the hold found it.
     *
     * @return completes once that stop has ended, or with the {@link UnitException} it ended in. Chromium is stopped only
     *     if it completes normally
     */
    public CompletableFuture<Void> hold() {
        CompletableFuture<Void> stopped;
        lock.lock();
        try {
            if (held) {
                return holdStopped;
            }
            held = true;
            // A restart's stop clears browserKnownUp, and its start, which this hold drops, would have put Chromium back.
            startAfterHold |= browserKnownUp || browserRestartDue || browserRestartStarting;
            // Released and held again before its stop began, it's that stop, and whoever waits for it hears.
            if (!holdStopDue) {
                holdStopDue = true;
                holdStopped = new CompletableFuture<>();
            }
            stopped = holdStopped;
            browserKnownUp = false;
            // A restart of a Chromium off its port, or a start a lost one asked for, would undo the hold.
            browserRestartDue = false;
            browserRestartStarting = false;
            browserStartDue = false;
            failWaitersForHold();
            applyMediaLocked();
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
        viewersChanged.run();
        return stopped;
    }

    /**
     * Ends {@link #hold}. Chromium comes back if it was running when the hold came, or if anyone still wants {@code live}.
     * Does nothing if it isn't held.
     */
    public void release() {
        lock.lock();
        try {
            if (!held) {
                return;
            }
            held = false;
            // The stop it asked for, if it hasn't begun, still goes, and the start follows it.
            browserStartDue = anyWant(Level.LIVE);
            serveLiveWaitingForGate();
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Where the Platform's bandwidth pause comes from (ma-platform ADR 0095): when it ends, or null while there's none.
     * Asked under this class's lock, so it must not block. Set once, before anything can call.
     */
    void pauseFrom(Supplier<Instant> until) {
        pausedUntil = until;
    }

    /** When the bandwidth pause ends, {@link Instant#MAX} if the Platform didn't say, or null while there's none. */
    Instant pausedUntil() {
        return pausedUntil.get();
    }

    /**
     * Where the age gate comes from: whether the owner's age band lets Chromium start now. Asked under this class's lock, so
     * it must not block. Set once, before anything can call.
     *
     * @param restartRetry how long after a failed stop {@link #restartForPolicy} tries again
     */
    void ageGateFrom(BooleanSupplier open, Duration restartRetry) {
        ageGate = open;
        policyRestartRetry = restartRetry;
    }

    /** False while a start of Chromium has to wait for the owner's age band. Doesn't block, so {@code /health} can ask. */
    boolean ageGateOpen() {
        lock.lock();
        try {
            return ageGateOpenLocked();
        } finally {
            lock.unlock();
        }
    }

    private boolean ageGateOpenLocked() {
        return !policyRestartOwed && ageGate.getAsBoolean();
    }

    /** A start of {@code desk-browser} may go out now. */
    private boolean browserMayStart() {
        return !held && ageGateOpenLocked();
    }

    /**
     * The owner's age band has been dealt with, so the gate may have moved. Opened, whoever's {@code live} was waiting starts,
     * along with anything else that was waiting to start Chromium. Shut, a {@code live} still waiting on a step is answered
     * as a new one would be, and stays wanted. Runs on the thread that heard the Platform, and returns quickly.
     */
    public void ageGateMoved() {
        lock.lock();
        try {
            if (ageGateOpenLocked()) {
                serveLiveWaitingForGate();
            } else {
                failLiveAtTheGate();
            }
            settle();
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
        viewersChanged.run();
    }

    /**
     * Chromium has to come up again under the file as it now is: a stop now, and a start if it was running, or if anyone
     * wants {@code live}. The gate stays shut until the stop has worked, and a start already on its way finishes first, as
     * it may have read the file too soon. Runs on the thread that heard the Platform, and returns quickly.
     */
    public void restartForPolicy() {
        lock.lock();
        try {
            policyRestartOwed = true;
            policyRestartDue = true;
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
    }

    /** Each {@code live} refused at the gate gets the steps a new one would, if they can go now. */
    private void serveLiveWaitingForGate() {
        if (!browserMayStart()) {
            return;
        }
        long now = System.nanoTime();
        for (Map.Entry<String, Want> entry : wants.entrySet()) {
            Want want = entry.getValue();
            if (want.level != Level.LIVE || !want.waitingForGate) {
                continue;
            }
            want.waitingForGate = false;
            Waiter waiter = new Waiter(entry.getKey(), Level.LIVE, Level.OFF, now);
            waiter.needsBrowser = true;
            waiter.needsStream = true;
            if (browserKnownUp && streamKnownUp) {
                sendView(entry.getKey(), want, true);
            }
            waiters.add(waiter);
        }
    }

    /** A {@code live} that came before the gate shut, and hasn't had its start. It's answered, and it stays wanted. */
    private void failLiveAtTheGate() {
        Iterator<Waiter> iterator = waiters.iterator();
        while (iterator.hasNext()) {
            Waiter waiter = iterator.next();
            if (waiter.level != Level.LIVE || !waiter.needsBrowser) {
                continue;
            }
            iterator.remove();
            UnitException failure = UnitException.ageBand();
            Want want = wants.get(waiter.sessionId);
            if (want != null) {
                want.waitingForGate = true;
            }
            waiter.result.completeExceptionally(failure);
            tell(waiter, failure.code());
        }
    }

    /** {@link #restartForPolicy}'s stop failed, and Chromium may still be up. Tried again in a while, on a thread of its own. */
    private void retryPolicyRestartLater() {
        Duration wait = policyRestartRetry;
        Thread.ofVirtual().name("browser-policy-retry").start(() -> {
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                return;
            }
            lock.lock();
            try {
                policyRestartDue = policyRestartOwed;
                startWorkerIfDue();
            } finally {
                lock.unlock();
            }
        });
    }

    /**
     * The bandwidth pause has begun: every session that wants {@code live} has its video cut at once and is left
     * {@code off}, and a {@code live} still waiting fails as a new one would. desk-stream is stopped once nobody wants
     * {@code warm}. Nothing asks for a stop of {@code desk-browser}, so Chromium and its profile are left as they are.
     * Runs on whatever thread heard the Platform, and returns quickly. Does nothing if the pause has already ended.
     */
    public void endLiveForPause() {
        lock.lock();
        try {
            Instant until = pausedUntil.get();
            if (until == null) {
                return;
            }
            Iterator<Waiter> iterator = waiters.iterator();
            while (iterator.hasNext()) {
                Waiter waiter = iterator.next();
                if (waiter.level != Level.LIVE) {
                    continue;
                }
                iterator.remove();
                UnitException failure = UnitException.paused(until);
                takeAwayWant(waiter);
                waiter.result.completeExceptionally(failure);
                tell(waiter, failure.code());
            }
            for (Map.Entry<String, Want> entry : wants.entrySet()) {
                Want want = entry.getValue();
                if (want.level != Level.LIVE) {
                    continue;
                }
                if (want.viewing) {
                    sendView(entry.getKey(), want, false);
                }
                want.level = Level.OFF;
            }
            if (!anyWant(Level.WARM)) {
                retryAFailedStop();
            }
            settle();
            startWorkerIfDue();
        } finally {
            lock.unlock();
        }
        viewersChanged.run();
    }

    /**
     * Where a session's say on whether it looks at the desk comes from ({@link DeskAttention#attended}), and what a start or
     * stop of desk-browser waits for ({@link BrowserFreeze}). Set once, before anything can call.
     */
    void attentionFrom(Predicate<String> attended, BrowserSteps steps) {
        this.attended = attended;
        this.browserSteps = steps;
    }

    /**
     * Whether sessions get media. False cuts it for every session that has it, and true sends it again to every session
     * that would have it, both at once, while what each session wants stays as it is. Must not block.
     */
    void mediaAllowed(boolean allowed) {
        lock.lock();
        try {
            mediaAllowed = allowed;
            applyMediaLocked();
        } finally {
            lock.unlock();
        }
    }

    /** A session has said for the first time whether it looks at the desk, so {@link #legacySeen} may have changed. */
    void attendedChanged() {
        lock.lock();
        try {
            applyMediaLocked();
        } finally {
            lock.unlock();
        }
    }

    /**
     * A session that has never sent desk.attention.set wants {@code warm} or more: a client from before it, which looks at
     * the desk whenever its Browser window is open.
     */
    boolean legacySeen() {
        lock.lock();
        try {
            return legacySeenLocked();
        } finally {
            lock.unlock();
        }
    }

    private boolean legacySeenLocked() {
        for (Map.Entry<String, Want> entry : wants.entrySet()) {
            if (entry.getValue().level.compareTo(Level.WARM) >= 0 && !attended.test(entry.getKey())) {
                return true;
            }
        }
        return false;
    }

    private boolean mediaOnLocked() {
        return mediaAllowed || legacySeenLocked();
    }

    /** Tells desk-rtc about each session whose media the gate has changed, and only those. */
    private void applyMediaLocked() {
        boolean on = mediaOnLocked();
        for (Map.Entry<String, Want> entry : wants.entrySet()) {
            Want want = entry.getValue();
            if (want.viewing && want.sent != on) {
                want.sent = on;
                video.set(entry.getKey(), on);
            }
        }
    }

    /**
     * Nothing of desk-browser is under way or owed: no hold, no start, stop or restart running or due, no request waiting on
     * a start, the age gate open, and no refusal known. What a freeze waits for. Doesn't block.
     */
    boolean browserSettled() {
        lock.lock();
        try {
            boolean browserStepRunning = current != null && current.unit().equals(UnitsClient.DESK_BROWSER);
            return !held
                    && !holdStopDue
                    && !policyRestartDue
                    && ageGateOpenLocked()
                    && !browserRestartDue
                    && !browserRestartStarting
                    && !startAfterHold
                    && !(browserStartDue && anyWant(Level.LIVE))
                    && !anyNeeds(w -> w.needsBrowser)
                    && !browserStepRunning
                    && !chromiumRefused;
        } finally {
            lock.unlock();
        }
    }

    /** True from {@link #hold} until {@link #release}. */
    public boolean held() {
        lock.lock();
        try {
            return held;
        } finally {
            lock.unlock();
        }
    }

    /** Every live or warm still waiting is refused as one that came now would be, and leaves its session off. */
    private void failWaitersForHold() {
        Iterator<Waiter> iterator = waiters.iterator();
        while (iterator.hasNext()) {
            Waiter waiter = iterator.next();
            if (waiter.level == Level.OFF) {
                continue;
            }
            iterator.remove();
            UnitException failure = UnitException.held();
            takeAwayWant(waiter);
            waiter.result.completeExceptionally(failure);
            tell(waiter, failure.code());
        }
    }

    /** True from a refused start of desk-browser until one works ({@link UnitException#browserRefused}). */
    public boolean chromiumRefused() {
        lock.lock();
        try {
            return chromiumRefused;
        } finally {
            lock.unlock();
        }
    }

    /** True if any session wants the stream at all, which also keeps the CDP connection up. */
    public boolean hasViewer() {
        lock.lock();
        try {
            return anyWant(Level.WARM);
        } finally {
            lock.unlock();
        }
    }

    /** The highest level any session wants: off, warm or live. */
    public Level level() {
        lock.lock();
        try {
            return anyWant(Level.LIVE) ? Level.LIVE : anyWant(Level.WARM) ? Level.WARM : Level.OFF;
        } finally {
            lock.unlock();
        }
    }

    private boolean anyWant(Level atLeast) {
        for (Want want : wants.values()) {
            if (want.level.compareTo(atLeast) >= 0) {
                return true;
            }
        }
        return false;
    }

    private void retryAFailedStop() {
        if (stopFailed) {
            stopFailed = false;
            stopDue = true;
        }
    }

    private void sendView(String sessionId, Want want, boolean view) {
        want.viewing = view;
        want.sent = view && mediaOnLocked();
        video.set(sessionId, want.sent);
    }

    /** Whoever is still waiting on this session's earlier request gets the level that now applies. */
    private void answerEarlierRequests(String sessionId, Level level) {
        Iterator<Waiter> iterator = waiters.iterator();
        while (iterator.hasNext()) {
            Waiter waiter = iterator.next();
            if (waiter.sessionId.equals(sessionId)) {
                iterator.remove();
                waiter.result.complete(level);
                tell(waiter, "overtaken");
            }
        }
    }

    private void tell(Waiter waiter, String outcome) {
        if (waiter.from != waiter.level) {
            transitions.accept(new Transition(
                    waiter.from,
                    waiter.level,
                    waiter.started,
                    waiter.browserStartNanos,
                    waiter.streamStartNanos,
                    waiter.stopNanos,
                    System.nanoTime() - waiter.started,
                    outcome));
        }
    }

    /** Answers every request that has nothing left to wait for. */
    private void settle() {
        boolean streamWanted = anyWant(Level.WARM);
        Iterator<Waiter> iterator = waiters.iterator();
        while (iterator.hasNext()) {
            Waiter waiter = iterator.next();
            boolean done = switch (waiter.level) {
                case LIVE -> !waiter.needsBrowser && !waiter.needsStream;
                case WARM -> !waiter.needsStream;
                // With someone else wanting the stream, or nothing to stop, there's nothing to wait for.
                case OFF -> !waiter.needsStop || streamWanted || !stopPendingOrRunning();
            };
            if (!done) {
                continue;
            }
            iterator.remove();
            Want want = wants.get(waiter.sessionId);
            if (want != null) {
                if (waiter.level == Level.LIVE && !want.viewing) {
                    sendView(waiter.sessionId, want, true);
                } else if (waiter.level == Level.WARM) {
                    sendView(waiter.sessionId, want, false);
                }
            }
            waiter.result.complete(waiter.level);
            tell(waiter, "ok");
        }
        // Wants may have changed, and with them whether a client from before desk.attention.set looks.
        applyMediaLocked();
    }

    private boolean stopPendingOrRunning() {
        return stopDue || streamStopRunning();
    }

    /** The step under way is the stream's stop, and not the one of a restart of Chromium. */
    private boolean streamStopRunning() {
        return current != null && current.verb().equals(UnitsClient.STOP) && current.unit().equals(UnitsClient.DESK_STREAM);
    }

    private void startWorkerIfDue() {
        if (worker == null && nextStepExists()) {
            worker = Thread.ofVirtual().name("browser-stream").start(this::work);
        }
    }

    private boolean nextStepExists() {
        return holdStopDue
                || !held && policyRestartDue
                || browserMayStart() && (browserRestartDue
                        || browserRestartStarting
                        || startAfterHold
                        || browserStartDue && anyWant(Level.LIVE)
                        || anyNeeds(w -> w.needsBrowser))
                || anyNeeds(w -> w.needsStream)
                || stopDue && !anyWant(Level.WARM);
    }

    private boolean anyNeeds(Predicate<Waiter> need) {
        for (Waiter waiter : waiters) {
            if (need.test(waiter)) {
                return true;
            }
        }
        return false;
    }

    private List<Waiter> covering(Predicate<Waiter> need) {
        List<Waiter> covered = new ArrayList<>();
        for (Waiter waiter : waiters) {
            if (need.test(waiter)) {
                covered.add(waiter);
            }
        }
        return covered;
    }

    /** The one thing to do next, or null if the units are where they should be. */
    private Step nextStep() {
        if (holdStopDue) {
            holdStopDue = false;
            browserKnownUp = false;
            return new Step(UnitsClient.STOP, UnitsClient.DESK_BROWSER, new ArrayList<>(), holdStopped, false);
        }
        if (!held && policyRestartDue) {
            policyRestartDue = false;
            // This stop is that stop too, and whether a start follows goes by whether Chromium was up.
            browserRestartDue = false;
            startAfterHold |= browserKnownUp;
            browserKnownUp = false;
            return new Step(UnitsClient.STOP, UnitsClient.DESK_BROWSER, new ArrayList<>(), null, true);
        }
        // While held, no start of desk-browser, and nothing waits for one: hold() refused those that would. While the age
        // gate is shut, no start of it either, and what waits for one gets it as the gate opens.
        if (browserMayStart() && browserRestartDue) {
            browserRestartDue = false;
            browserRestartStarting = true;
            browserKnownUp = false;
            return new Step(UnitsClient.STOP, UnitsClient.DESK_BROWSER, new ArrayList<>());
        }
        if (browserMayStart() && (browserRestartStarting || startAfterHold || anyNeeds(w -> w.needsBrowser) || (browserStartDue && anyWant(Level.LIVE)))) {
            browserRestartStarting = false;
            browserStartDue = false;
            startAfterHold = false;
            return new Step(UnitsClient.START, UnitsClient.DESK_BROWSER, covering(w -> w.needsBrowser));
        }
        if (anyNeeds(w -> w.needsStream)) {
            stopDue = true;
            leftoverPossible = false;
            return new Step(UnitsClient.START, UnitsClient.DESK_STREAM, covering(w -> w.needsStream));
        }
        if (stopDue && !anyWant(Level.WARM)) {
            stopDue = false;
            streamKnownUp = false;
            return new Step(UnitsClient.STOP, UnitsClient.DESK_STREAM, covering(w -> w.needsStop));
        }
        return null;
    }

    private void work() {
        while (true) {
            Step step;
            boolean refusedLastTime;
            lock.lock();
            try {
                step = nextStep();
                current = step;
                if (step == null) {
                    worker = null;
                    settle();
                    return;
                }
                refusedLastTime = chromiumRefused;
                if (isBrowserStart(step)) {
                    browserStartedBefore = true;
                    lastBrowserStartNanos = System.nanoTime();
                }
            } finally {
                lock.unlock();
            }
            boolean browserStep = step.unit().equals(UnitsClient.DESK_BROWSER);
            if (browserStep) {
                try {
                    browserSteps.beforeBrowserStep();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            boolean startingBrowser = isBrowserStart(step);
            // Refused last time, it most likely will be again, and a start that works still gets the call below.
            if (startingBrowser && !refusedLastTime) {
                browserStarting.run();
            }
            // Outside the lock, as it reads /proc: whether there's a Chromium for the release to bring back.
            boolean upBeforeStop = (step.hold() != null || step.forPolicy()) && chromiumRunning.getAsBoolean();
            long began = System.nanoTime();
            UnitException failure = run(step);
            long took = System.nanoTime() - began;
            if (browserStep) {
                browserSteps.afterBrowserStep(failure == null);
            }
            if (startingBrowser && failure == null) {
                browserStarting.run();
            }
            boolean changed;
            boolean refusedBefore;
            boolean refusedNow;
            lock.lock();
            try {
                current = null;
                refusedBefore = chromiumRefused;
                if (step.hold() != null) {
                    // A stop that failed left Chromium where it was.
                    startAfterHold = failure == null && (startAfterHold || upBeforeStop);
                }
                changed = finish(step, failure, took);
                if (step.forPolicy()) {
                    if (failure == null) {
                        policyRestartOwed = false;
                        startAfterHold |= upBeforeStop;
                        serveLiveWaitingForGate();
                    } else {
                        failLiveAtTheGate();
                        retryPolicyRestartLater();
                    }
                }
                refusedNow = chromiumRefused;
                settle();
            } finally {
                lock.unlock();
            }
            // On this thread, so the file follows each change in the order they came.
            if (refusedNow != refusedBefore) {
                marker.write(refusedNow);
            }
            if (step.hold() != null) {
                if (failure == null) {
                    step.hold().complete(null);
                } else {
                    step.hold().completeExceptionally(failure);
                }
            }
            if (changed) {
                viewersChanged.run();
            }
        }
    }

    private static boolean isBrowserStart(Step step) {
        return step.verb().equals(UnitsClient.START) && step.unit().equals(UnitsClient.DESK_BROWSER);
    }

    private UnitException run(Step step) {
        try {
            units.run(step.verb(), step.unit());
            return null;
        } catch (UnitException e) {
            return e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new UnitException(step.unit(), UnitException.INTERNAL, null);
        } catch (RuntimeException e) {
            log.error("unit request failed: {}", e.getClass().getName());
            return new UnitException(step.unit(), UnitException.INTERNAL, null);
        }
    }

    /** @return true if a failure took sessions' wants away */
    private boolean finish(Step step, UnitException failure, long took) {
        boolean starting = step.verb().equals(UnitsClient.START);
        boolean browser = step.unit().equals(UnitsClient.DESK_BROWSER);
        for (Waiter waiter : step.covered()) {
            if (browser) {
                waiter.browserStartNanos = took;
            } else if (starting) {
                waiter.streamStartNanos = took;
            } else {
                waiter.stopNanos = took;
            }
        }
        if (failure == null) {
            if (browser) {
                browserKnownUp = starting;
                chromiumRefused &= !starting;
            } else if (starting) {
                streamKnownUp = true;
            }
            for (Waiter waiter : step.covered()) {
                if (browser) {
                    waiter.needsBrowser = false;
                } else if (starting) {
                    waiter.needsStream = false;
                } else {
                    waiter.needsStop = false;
                }
            }
            return false;
        }
        log.warn("{} {} failed: {} {}", step.verb(), step.unit(), failure.code(), failure.text() == null ? "" : failure.text());
        if (browser) {
            browserKnownUp = false;
            if (starting && failure.browserRefused()) {
                chromiumRefused = true;
                // Asked for while this one was on its way, a loss has just had its answer, and a restart of a Chromium
                // off its port would now only stop a browser that works (browserDisplaced).
                browserStartDue = false;
                browserRestartDue = false;
            }
        } else if (starting) {
            streamKnownUp = false;
        } else {
            stopFailed = true;
        }
        boolean changed = false;
        for (Waiter waiter : step.covered()) {
            // A request that's been overtaken has been answered already, and its want is someone else's.
            if (waiters.remove(waiter)) {
                changed |= takeAwayWant(waiter);
                waiter.result.completeExceptionally(failure);
                tell(waiter, failure.code());
            }
        }
        return changed;
    }

    /** A request that failed leaves its session off, and the client can ask again. */
    private boolean takeAwayWant(Waiter waiter) {
        Want want = wants.get(waiter.sessionId);
        if (want == null || waiter.level == Level.OFF) {
            return false;
        }
        if (want.viewing) {
            sendView(waiter.sessionId, want, false);
        }
        want.level = Level.OFF;
        return true;
    }
}
