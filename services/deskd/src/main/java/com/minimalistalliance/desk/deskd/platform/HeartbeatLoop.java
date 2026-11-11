package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcException;
import com.minimalistalliance.desk.deskd.rtc.RtcStats;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * POST /v1/agent/heartbeat every 60 s, or as the last response says, and sooner when something
 * changes, but at least 15 s apart. The one heartbeat that doesn't wait is the one saying ready after
 * a prepare_stop, which agent.md exempts. One parked virtual thread, so idle costs nothing but the
 * timer the contract asks for. A response is authoritative: revocations, a new config, hello_required
 * and prepare_stop all come through here even if the gateway link is down.
 */
public final class HeartbeatLoop {

    private static final Logger log = LoggerFactory.getLogger(HeartbeatLoop.class);
    private static final String CHROMIUM_OLDER_THAN_PROFILE = "older_than_profile";
    private static final String BROWSER_FROZEN = "frozen";

    /**
     * @param spacing the least time between heartbeats. The contract says 15 s by Platform's clock, so
     *     the default leaves a margin. A heartbeat that fails is sent again this long after, doubling while it keeps
     *     failing, up to the period
     * @param maxPeriod the longest gap a reply's {@code nextHeartbeatSeconds} may ask for. agent.md marks a desk unhealthy
     *     after 5 minutes without one, so 2 minutes leaves room for a lost heartbeat and its retry, and keeps the reply's
     *     revocations, its backstop, within 2 minutes
     */
    public record Timing(Duration period, Duration spacing, Duration requestTimeout, Duration maxPeriod) {
        public static final Duration MAX_PERIOD = Duration.ofMinutes(2);
        public static final Timing DEFAULT = new Timing(Duration.ofSeconds(60), Duration.ofSeconds(16), Duration.ofSeconds(10), MAX_PERIOD);

        /** With {@link #MAX_PERIOD}, or the period if that's longer. */
        public Timing(Duration period, Duration spacing, Duration requestTimeout) {
            this(period, spacing, requestTimeout, period.compareTo(MAX_PERIOD) > 0 ? period : MAX_PERIOD);
        }
    }

    private final Supplier<Map<String, Object>> agentFields;
    private final AgentClient agent;
    private final DeskState state;
    private final SessionManager sessions;
    private final RtcClient rtc;
    private final DataVolume volume;
    private final BooleanSupplier chromiumRefused;
    /** Chromium is frozen, as nobody looks at the desk (ADR 0045): {@link #browserFrozenFrom}. */
    private volatile BooleanSupplier browserFrozen = () -> false;
    /** Seconds the Browser has been live to any session since boot (ADR 0090): {@link #browserLiveSecondsFrom}, or none. */
    private volatile LongSupplier browserLiveSeconds;
    /** A guild desk's {@code guild} block (desks.md, "Guild Desk heartbeat"), from desk-rtc's latest stats; null elsewhere. */
    private volatile java.util.function.Function<RtcStats, Map<String, Object>> guildBlock = stats -> null;
    /** A reply's {@code guildVersion}, the roster's version, for a guild desk to read it when it's newer. */
    private volatile java.util.function.LongConsumer guildVersion = version -> {};
    /** desk-notebook's storage state (its health frame's {@code storage}), or null if unknown: {@link #notebookStorageFrom}. */
    private volatile Supplier<Map<String, Object>> notebookStorage = () -> null;
    /** What {@link #notebookStorage} said at the last heartbeat, for the final one, which has no time to ask. */
    private volatile Map<String, Object> lastNotebookStorage;
    /** This deskd's version, as hello and /health say it, or null before {@link #deskdFrom}: then no {@code deskd} block. */
    private volatile String deskdVersion;
    /** GET /health's answer on the admin socket: {@link #deskdFrom}. */
    private volatile BooleanSupplier deskdHealthy = () -> true;
    /** What {@link #deskdHealthy} said at the last heartbeat, for the final one, which has no time to write a file. */
    private volatile Boolean lastDeskdHealthy;
    private final LongSupplier freeBytesSent;
    private final Revocations revocations;
    private final PlatformActions actions;
    private final Clock clock;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private Thread thread;
    private boolean stopped;
    private boolean soon;
    private boolean sentOnce;
    private long lastSentNanos;
    private long nextDueNanos;
    private long notBeforeNanos;
    private long seq;
    /** Only the loop's thread touches this. */
    private boolean delivering;
    /** Heartbeats in a row that failed, not counting a 429 with Retry-After. Only the loop's thread touches this. */
    private int failures;
    /** A stop asked for ready, and Platform hasn't accepted a heartbeat saying so. Only the loop's thread touches this. */
    private boolean readyOwed;
    /** The next heartbeat is the first to say ready for this stop, so it skips the spacing. Only the loop's thread touches this. */
    private boolean readyNow;
    private volatile boolean readyToStop;
    private volatile boolean prepareStopSeen;
    private volatile RtcStats lastStats;
    private volatile MediaTotals restartedAt = MediaTotals.ZERO;
    private volatile MediaTotals reportedMedia;
    private volatile Instant lastConnectedAt;
    private volatile int lastReportedClients;

    /**
     * With no agent runtime: {@code agent.status} is {@code offline}.
     *
     * @param chromiumRefused the image has refused to start Chromium, and nothing has started it since, as far as this
     *     boot knows: it outlives a restart of deskd. Must not block
     * @param freeBytesSent frame bytes handed to desk-rtc for data.read since this process started, which the meter
     *     doesn't count (task 32's draft ADR, decision 8). Must not block
     */
    public HeartbeatLoop(
            AgentClient agent,
            DeskState state,
            SessionManager sessions,
            RtcClient rtc,
            DataVolume volume,
            BooleanSupplier chromiumRefused,
            LongSupplier freeBytesSent,
            Revocations revocations,
            PlatformActions actions,
            Clock clock,
            Timing timing) {
        this(agent, state, sessions, rtc, volume, chromiumRefused, HeartbeatLoop::offlineAgent, freeBytesSent, revocations, actions,
                clock, timing);
    }

    /**
     * @param chromiumRefused the image has refused to start Chromium, and nothing has started it since, as far as this
     *     boot knows: it outlives a restart of deskd. Must not block
     * @param agentFields the heartbeat's {@code agent} object (agent.md), from desk-agent's relay. Must not block
     * @param freeBytesSent as above
     */
    public HeartbeatLoop(
            AgentClient agent,
            DeskState state,
            SessionManager sessions,
            RtcClient rtc,
            DataVolume volume,
            BooleanSupplier chromiumRefused,
            Supplier<Map<String, Object>> agentFields,
            LongSupplier freeBytesSent,
            Revocations revocations,
            PlatformActions actions,
            Clock clock,
            Timing timing) {
        this.agentFields = agentFields;
        this.agent = agent;
        this.state = state;
        this.sessions = sessions;
        this.rtc = rtc;
        this.volume = volume;
        this.chromiumRefused = chromiumRefused;
        this.freeBytesSent = freeBytesSent;
        this.revocations = revocations;
        this.actions = actions;
        this.clock = clock;
        this.timing = timing;
    }

    /**
     * Where {@code health.checks.browser: "frozen"} comes from. It says only that, and only while it's so: nothing of why,
     * or of what the member has open. Not a fault, so the status doesn't change. Set once, before {@link #start}.
     */
    public void browserFrozenFrom(BooleanSupplier frozen) {
        this.browserFrozen = frozen;
    }

    /**
     * Where {@code media.browserLiveSeconds} comes from: whole seconds the Browser's video has gone to any session since the
     * desk booted, which the Platform's meter turns into a free member's Browser time (ADR 0090). Must not block.
     */
    public void browserLiveSecondsFrom(LongSupplier seconds) {
        this.browserLiveSeconds = seconds;
    }

    /**
     * Where {@code health.checks.notebook} comes from: desk-notebook's {@code storage} block, or null when it can't be read
     * (no desk-notebook, or it didn't answer), which sends no check. May park briefly; it's asked once a heartbeat, from
     * the loop's thread. Set once, before {@link #start}.
     */
    public void notebookStorageFrom(Supplier<Map<String, Object>> storage) {
        this.notebookStorage = storage;
    }

    /**
     * Where the heartbeat's {@code deskd} block comes from (ADR 0078 section 3.3, DE-2): this deskd's version, the one hello
     * and {@code GET /health} say, and {@code /health}'s own answer, {@code ok} or {@code failing}, which is serving with its
     * data directory writable (deskd has no databases of its own). So a release switched in where no {@code health} script
     * can run, as in a shared host's slot, is still seen running and healthy by the Platform. A failing deskd also makes
     * {@code health.status} failing. {@code healthy} writes a file, so it's asked once a heartbeat from the loop's thread,
     * and the final heartbeat says what the last one did. Set once, before {@link #start}.
     */
    public void deskdFrom(String version, BooleanSupplier healthy) {
        this.deskdHealthy = healthy;
        this.deskdVersion = version;
    }

    /** A guild desk's {@code guild} block, built from desk-rtc's latest stats at each heartbeat. Set once, before start. */
    public void reportGuild(java.util.function.Function<RtcStats, Map<String, Object>> block) {
        guildBlock = block;
    }

    /** Hears a reply's {@code guildVersion}. Must not block. */
    public void onGuildVersion(java.util.function.LongConsumer listener) {
        guildVersion = listener;
    }

    /** Starts beating, the first one at once. Later calls do nothing. */
    public void start() {
        lock.lock();
        try {
            if (thread == null && !stopped) {
                nextDueNanos = System.nanoTime();
                notBeforeNanos = nextDueNanos;
                thread = Thread.ofVirtual().name("heartbeat").start(this::loop);
            }
        } finally {
            lock.unlock();
        }
    }

    /** True once any heartbeat response of this process has carried prepare_stop. It never goes back. */
    public boolean prepareStopSeen() {
        return prepareStopSeen;
    }

    /** Sessions came or went, so asks for an extra heartbeat if the count differs from the last sent. */
    public void clientsChanged() {
        if (sessions.connectedCount() != lastReportedClients) {
            requestSoon();
        }
    }

    /** Something worth reporting changed: one extra heartbeat, as soon as the spacing allows. */
    public void requestSoon() {
        lock.lock();
        try {
            soon = true;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Ends the loop and sends the last heartbeat, best effort within the budget. After a prepare_stop
     * it's exempt from the 15 s spacing. On a plain restart it isn't: if the previous one was under 15 s
     * ago, Platform turns it down with 429, and that's the end of it.
     *
     * @return the thread sending it, or null if the loop never started, so hello never succeeded
     */
    public Thread stopAndSendFinal(Duration budget) {
        Thread running;
        lock.lock();
        try {
            stopped = true;
            running = thread;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
        if (running == null) {
            return null;
        }
        running.interrupt();
        return Thread.ofVirtual().name("heartbeat-final").start(() -> {
            try {
                running.join(Duration.ofMillis(200));
                beat(true, budget);
            } catch (IOException | RuntimeException e) {
                log.info("last heartbeat wasn't delivered: {}", e.getClass().getSimpleName());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    private void loop() {
        try {
            while (awaitDue()) {
                sendOne();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** @return false once stopped */
    private boolean awaitDue() throws InterruptedException {
        lock.lockInterruptibly();
        try {
            while (!stopped) {
                long now = System.nanoTime();
                long due = nextDueNanos;
                if (soon) {
                    long earliest = sentOnce ? lastSentNanos + timing.spacing().toNanos() : now;
                    due = earliest - due < 0 ? earliest : due;
                }
                if (readyNow) {
                    due = now;
                }
                if (notBeforeNanos - due > 0) {
                    due = notBeforeNanos;
                }
                long wait = due - now;
                if (wait <= 0) {
                    soon = false;
                    readyNow = false;
                    return true;
                }
                wake.awaitNanos(wait);
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    private void sendOne() throws InterruptedException {
        long period = timing.period().toNanos();
        boolean sayingReady = readyToStop;
        try {
            Map<String, Object> response = beat(false, timing.requestTimeout());
            readyOwed &= !sayingReady;
            failures = 0;
            Object next = response.get("nextHeartbeatSeconds");
            if (next instanceof Number seconds && seconds.longValue() > 0) {
                // Held to the contract's bounds: never under the spacing, never so long the desk looks dead (audit D7).
                long asked = seconds.longValue() >= timing.maxPeriod().toSeconds() ? timing.maxPeriod().toNanos() : TimeUnit.SECONDS.toNanos(seconds.longValue());
                period = Math.max(asked, timing.spacing().toNanos());
            }
            if (!delivering) {
                // Once, and again after a failure: enough to read the state from the log, with no line a minute.
                delivering = true;
                log.info("heartbeat accepted, next in {} s", TimeUnit.NANOSECONDS.toSeconds(period));
            }
            handle(response);
        } catch (AgentClient.ApiException e) {
            delivering = false;
            log.warn("heartbeat refused: {}", e.getMessage());
            if (e.retryAfter() != null) {
                // It wasn't delivered, so the next goes as soon as Platform allows, not a whole period later. A
                // restart meets this every time: its first heartbeat is under 15 s after the last process's final one.
                long retryAfter = e.retryAfter().toNanos();
                period = Math.min(period, Math.max(retryAfter, timing.spacing().toNanos()));
                lock.lock();
                try {
                    notBeforeNanos = System.nanoTime() + retryAfter;
                } finally {
                    lock.unlock();
                }
            } else {
                period = afterFailure(period);
            }
        } catch (IOException | RuntimeException e) {
            delivering = false;
            log.warn("heartbeat failed: {}", e.getClass().getSimpleName());
            period = afterFailure(period);
        }
        lock.lock();
        try {
            nextDueNanos = System.nanoTime() + period;
            // stopAt can be only 60 s away, so a ready heartbeat that didn't land goes again at the spacing.
            soon |= readyOwed;
        } finally {
            lock.unlock();
        }
    }

    /**
     * When to try again after a heartbeat that failed (audit D3): the spacing, doubling while they keep failing, up to the
     * period, plus up to a quarter more so a fleet that failed together doesn't retry together. A whole period of silence
     * after each blip would put two blips near the Platform's 5-minute mark.
     */
    private long afterFailure(long period) {
        failures++;
        long base = timing.spacing().toNanos();
        for (int i = 1; i < failures && base < period; i++) {
            base *= 2;
        }
        base = Math.min(base, period);
        return base + (long) (base * 0.25 * java.util.concurrent.ThreadLocalRandom.current().nextDouble());
    }

    private Map<String, Object> beat(boolean last, Duration timeout) throws IOException, InterruptedException {
        Map<String, Object> body = body(last);
        lock.lock();
        try {
            sentOnce = true;
            lastSentNanos = System.nanoTime();
        } finally {
            lock.unlock();
        }
        return agent.heartbeat(body, timeout);
    }

    private void handle(Map<String, Object> response) {
        state.streamingPause().apply(Json.object(response, "streaming"));
        if (response.get("guildVersion") instanceof Number roster) {
            guildVersion.accept(roster.longValue());
        }
        revocations.apply(strings(response.get("revokedSessions")), List.of(), Json.string(response, "tokensValidAfter"));
        if (response.get("configVersion") instanceof Number version) {
            PlatformConfig config = state.config();
            if (config != null && version.longValue() != config.configVersion()) {
                actions.requestConfig();
            }
        }
        List<String> requested = strings(response.get("actions"));
        if (requested.contains("hello_required")) {
            actions.requestHello("requested");
        }
        // There's nothing to checkpoint yet, so the desk is ready at once. Sessions stay open: the
        // gateway closes them at readyToStop + 5 s or at stopAt. Later replies carry prepare_stop as
        // well, and they change nothing, or each would bring another heartbeat.
        boolean prepareStop = requested.contains("prepare_stop");
        prepareStopSeen |= prepareStop;
        if (prepareStop && !readyToStop) {
            log.info("prepare_stop received, stopAt {}, reason {}", Json.string(response, "stopAt"), Json.string(response, "stopReason"));
            readyToStop = true;
            readyOwed = true;
            readyNow = true;
        } else if (!prepareStop) {
            readyToStop = false;
            readyOwed = false;
        }
    }

    private Map<String, Object> body(boolean last) throws InterruptedException {
        // First, because they can park on desk-rtc and desk-notebook, and sentAt should be when it's sent.
        Map<String, Object> media = media(last);
        Map<String, Object> storage = last ? lastNotebookStorage : notebookStorage.get();
        lastNotebookStorage = storage;
        Boolean deskdOk = deskdVersion == null ? null : last && lastDeskdHealthy != null ? lastDeskdHealthy : deskdHealthy();
        lastDeskdHealthy = deskdOk;
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("bootId", state.bootId());
        body.put("seq", nextSeq(now));
        body.put("sentAt", now.toString());
        body.put("clients", clients(now));
        body.put("media", media);
        body.put("agent", agentFields.get());
        body.put("badges", Map.of("total", 0, "apps", Map.of()));
        body.put("health", health(storage, deskdOk));
        if (deskdOk != null) {
            Map<String, Object> deskd = new LinkedHashMap<>();
            deskd.put("version", deskdVersion);
            deskd.put("status", deskdOk ? "ok" : "failing");
            body.put("deskd", deskd);
        }
        body.put("dataVolume", dataVolume());
        body.put("guild", guildBlock.apply(lastStats));
        // Only after a prepare_stop: Platform powers off on this, so a plain restart must never say it.
        body.put("readyToStop", readyToStop || (last && prepareStopSeen));
        body.put("final", last);
        return body;
    }

    /**
     * Chromium's check is there only while it's been refused, and never says ok: it starts on demand, so deskd doesn't
     * know that. A refusal is degraded and no worse, as the desk still works apart from its Browser, and a volume that
     * can't be written is the worse of the two.
     *
     * <p>The volume fails when it can't be written by its mode or has under {@link DataVolume#LOW_SPACE_BYTES} usable
     * (audit D5): a full disk still looks writable. Notebook's check is there only while desk-notebook answers: degraded
     * while its writes fail and edits wait in memory, failing once it refuses edits, and each makes the status the same.
     * A deskd whose own {@code /health} fails ({@code deskdOk} false) is failing too; null is not known.
     */
    private Map<String, Object> health(Map<String, Object> notebookStorage, Boolean deskdOk) {
        boolean volumeOk = volume.looksWritable() && !volume.lowOnSpace();
        boolean rtcOk = rtc.isConfigured();
        boolean refused = chromiumRefused.getAsBoolean();
        String notebook = notebookCheck(notebookStorage);
        Map<String, Object> checks = new LinkedHashMap<>();
        checks.put("rtc", rtcOk ? "ok" : "failing");
        checks.put("dataVolume", volumeOk ? "ok" : "failing");
        if (refused) {
            checks.put("chromium", CHROMIUM_OLDER_THAN_PROFILE);
        }
        if (browserFrozen.getAsBoolean()) {
            checks.put("browser", BROWSER_FROZEN);
        }
        if (notebook != null) {
            checks.put("notebook", notebook);
        }
        boolean notebookFailing = "failing".equals(notebook);
        boolean notebookOk = notebook == null || "ok".equals(notebook);
        Map<String, Object> health = new LinkedHashMap<>();
        boolean failing = !volumeOk || notebookFailing || Boolean.FALSE.equals(deskdOk);
        health.put("status", failing ? "failing" : rtcOk && !refused && notebookOk ? "ok" : "degraded");
        health.put("checks", checks);
        return health;
    }

    /** As the admin socket's /health decides it: a check that throws is failing. */
    private boolean deskdHealthy() {
        try {
            return deskdHealthy.getAsBoolean();
        } catch (RuntimeException e) {
            log.warn("deskd's health check failed: {}", e.getClass().getSimpleName());
            return false;
        }
    }

    /** {@code ok}, {@code degraded} (writes failing, edits kept in memory) or {@code failing} (refusing edits); null if unknown. */
    private static String notebookCheck(Map<String, Object> storage) {
        if (storage == null) {
            return null;
        }
        Object state = storage.get("state");
        if ("ok".equals(state)) {
            return "ok";
        }
        if ("degraded".equals(state)) {
            return Boolean.TRUE.equals(storage.get("refusing")) ? "failing" : "degraded";
        }
        return null;
    }

    /**
     * What's known of the volume, each part only if it's known: its usage, and its record, whose {@code formattedAt} is
     * a JSON null on a volume older than the record. Null with neither. Hello doesn't carry the record.
     */
    private Map<String, Object> dataVolume() {
        DataVolume.Usage usage = volume.usage();
        DataVolume.VolumeRecord record = volume.volumeRecord();
        if (usage == null && record == null) {
            return null;
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        if (usage != null) {
            fields.put("totalBytes", usage.totalBytes());
            fields.put("usedBytes", usage.usedBytes());
        }
        if (record != null) {
            fields.put("volumeId", record.volumeId());
            fields.put("formattedAt", record.formattedAt());
        }
        return fields;
    }

    /**
     * Must rise across a restart of deskd within one boot too, as Platform ignores a seq it has
     * already passed. Whole seconds of the clock do that without saving anything to disk. A ready
     * heartbeat can follow the last within a second, and then it's the last seq + 1.
     */
    private long nextSeq(Instant now) {
        lock.lock();
        try {
            seq = Math.max(seq + 1, now.getEpochSecond());
            return seq;
        } finally {
            lock.unlock();
        }
    }

    private Map<String, Object> clients(Instant now) {
        int connected = sessions.connectedCount();
        lastReportedClients = connected;
        if (connected > 0) {
            lastConnectedAt = now;
        }
        Map<String, Integer> byTransport = sessions.transportCounts();
        Map<String, Object> clients = new LinkedHashMap<>();
        clients.put("connected", connected);
        clients.put("lastConnectedAt", time(lastConnectedAt));
        clients.put("lastInputAt", time(sessions.lastInputAt()));
        clients.put("transports", Map.of(
                "udp", byTransport.getOrDefault("udp", 0),
                "tcp", byTransport.getOrDefault("tcp", 0),
                "relay", byTransport.getOrDefault("relay", 0)));
        return clients;
    }

    /** With no agent runtime, it's honest about that. */
    static Map<String, Object> offlineAgent() {
        Map<String, Object> agent = new LinkedHashMap<>();
        agent.put("status", "offline");
        agent.put("busyUntil", null);
        agent.put("activeTasks", 0);
        agent.put("lastActivityAt", null);
        agent.put("lastLlmCallAt", null);
        return agent;
    }

    /** Asks desk-rtc, except on the way out, when there's no time to and the last figures will do. */
    private Map<String, Object> media(boolean last) throws InterruptedException {
        if (!last && rtc.isConfigured()) {
            try {
                record(rtc.stats());
            } catch (RtcException e) {
                log.debug("no stats from desk-rtc: {}", e.code());
            }
        }
        MediaTotals totals = reportedMedia;
        if (totals == null) {
            return null;
        }
        Map<String, Object> media = new LinkedHashMap<>();
        media.put("bytesSent", totals.sent());
        media.put("bytesReceived", totals.received());
        media.put("peerBytesSent", totals.peerSent());
        media.put("peerBytesReceived", 0);
        // Since this process started, unlike the totals above, which carry across a restart of desk-rtc: a restart of
        // deskd starts it again, as it does bytesSent's carry. bytesSent's growth includes these.
        media.put("freeBytesSent", freeBytesSent.getAsLong());
        LongSupplier live = browserLiveSeconds;
        if (live != null) {
            media.put("browserLiveSeconds", live.getAsLong());
        }
        return media;
    }

    /**
     * desk-rtc keeps its totals in memory, so they start again when it restarts, while agent.md's are
     * cumulative since boot. A total that falls means that happened, so what it had reached carries
     * forward. Bytes since its last stats are lost, as is the carry if deskd restarts too. Those two
     * still under-report, which agent.md says only ever bills the member more (services/CLAUDE.md).
     */
    private void record(RtcStats stats) {
        RtcStats previous = lastStats;
        if (previous != null
                && (stats.bytesSent() < previous.bytesSent()
                        || stats.bytesReceived() < previous.bytesReceived()
                        || stats.peerBytesSent() < previous.peerBytesSent())) {
            restartedAt = restartedAt.plus(previous);
        }
        lastStats = stats;
        reportedMedia = restartedAt.plus(stats);
    }

    private record MediaTotals(long sent, long received, long peerSent) {
        static final MediaTotals ZERO = new MediaTotals(0, 0, 0);

        MediaTotals plus(RtcStats stats) {
            return new MediaTotals(sent + stats.bytesSent(), received + stats.bytesReceived(), peerSent + stats.peerBytesSent());
        }
    }

    private static String time(Instant value) {
        return value == null ? null : value.truncatedTo(ChronoUnit.SECONDS).toString();
    }

    private static List<String> strings(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        return list.stream().filter(String.class::isInstance).map(String.class::cast).toList();
    }
}
