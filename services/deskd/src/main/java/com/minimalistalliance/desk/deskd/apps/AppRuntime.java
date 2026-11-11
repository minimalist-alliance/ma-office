package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Which installed apps run, and their links (the desk app contract, sections 1.3 and 2.6).
 *
 * <ul>
 *   <li><b>Start:</b> on first use (a call, a SUB, {@code apps.start}), or with deskd for a {@code background} app. The
 *       helper starts the unit; deskd waits for the socket and the HELLO within the manifest's {@code startTimeoutSec}, or
 *       stops it and says it couldn't start.
 *   <li><b>Stop:</b> an on-demand app 10 minutes after its last call with nobody subscribed to its topics; on
 *       {@code apps.stop}; at removal; and all of them when the switch says {@code off}.
 *   <li><b>A crash</b> (the link ends without deskd asking): counted. A background app or one somebody is subscribed to is
 *       started again after 1 s, 5 s and 30 s. After 3 in 10 minutes it stays {@code failed}, with {@code crashed} or
 *       {@code memory} (an OOM kill, as the helper reports it), until the member starts it again. {@code needs_update} (the
 *       app closed with 4426 or speaks another major) is never retried.
 * </ul>
 *
 * Each app has its own lock, held across a start or a stop, so a call to an app that's starting waits for it rather than
 * starting a second. deskd leaves running apps running when it stops: the next deskd asks the helper and connects again.
 */
final class AppRuntime {

    private static final Logger log = LoggerFactory.getLogger(AppRuntime.class);

    static final String STOPPED = "stopped";
    static final String STARTING = "starting";
    static final String RUNNING = "running";
    static final String FAILED = "failed";
    static final String DISABLED = "disabled";
    static final Duration IDLE = Duration.ofMinutes(10);
    private volatile Duration tick = Duration.ofSeconds(30);
    static final Duration FAILURE_WINDOW = Duration.ofMinutes(10);
    static final int MAX_FAILURES = 3;
    private static final long[] BACKOFF_MS = {1_000, 5_000, 30_000};

    /** One installed app's run state. Fields change under {@link #lock}, and are read without it. */
    static final class Process {
        final String id;
        final ReentrantLock lock = new ReentrantLock();
        volatile AppStore.Entry entry;
        volatile AppManifest manifest;
        volatile String state = STOPPED;
        volatile String problem;
        volatile AppLink link;
        volatile long lastUse;
        volatile long restartAt;
        volatile Map<String, Object> summary;
        final AtomicBoolean savingSummary = new AtomicBoolean();
        final ArrayDeque<Long> failures = new ArrayDeque<>();

        Process(String id) {
            this.id = id;
        }
    }

    /** What the runtime needs from the rest of the module. */
    interface Hooks {
        /** Something about an app's state changed: the {@code apps} topic publishes. Must not block. */
        void changed();

        /** Whether any session is subscribed to one of this app's topics. */
        boolean inUse(String id);

        void linkUp(String id);

        void linkDown(String id);

        /** The app called deskd (section 5.3). */
        Object request(Process process, String method, Map<String, Object> params) throws RpcException;

        /** deskd's HELLO to this app. */
        Map<String, Object> hello(Process process);
    }

    private final AppHost host;
    private final AppStore store;
    private final AppsSwitch toggle;
    private final Supplier<Long> nanoTime;
    private final Map<String, Process> processes = new ConcurrentHashMap<>();
    private final AtomicBoolean ticking = new AtomicBoolean();
    private volatile boolean started;
    private volatile Hooks hooks;
    private volatile Thread ticker;

    AppRuntime(AppHost host, AppStore store, AppsSwitch toggle) {
        this.host = host;
        this.store = store;
        this.toggle = toggle;
        this.nanoTime = System::nanoTime;
    }

    void hooks(Hooks value) {
        hooks = value;
    }

    /** For tests: how often the ticker looks while an app runs. */
    void tickEvery(Duration every) {
        tick = every;
    }

    // ---- what's installed

    /** Takes an installed app's record and manifest, as after an install, an upgrade or deskd's start. */
    Process put(AppStore.Entry entry, AppManifest manifest) {
        Process p = processes.computeIfAbsent(entry.id(), Process::new);
        p.entry = entry;
        p.manifest = manifest;
        if (entry.disabled() != null) {
            p.state = DISABLED;
            p.problem = entry.disabled();
        } else if (DISABLED.equals(p.state)) {
            p.state = STOPPED;
            p.problem = null;
        }
        if (p.summary == null) {
            p.summary = AppSummaryFile.read(store, entry.id());
        }
        return p;
    }

    void forget(String id) {
        processes.remove(id);
    }

    /** After a rollback: the old version is as it was, stopped with nothing against it. */
    void reset(String id) {
        Process p = processes.get(id);
        if (p != null && !DISABLED.equals(p.state)) {
            p.lock.lock();
            try {
                p.state = STOPPED;
                p.problem = null;
                p.failures.clear();
                p.restartAt = 0;
            } finally {
                p.lock.unlock();
            }
            changed();
        }
    }

    Process process(String id) {
        return processes.get(id);
    }

    List<Process> all() {
        return new ArrayList<>(processes.values());
    }

    boolean running(String id) {
        Process p = processes.get(id);
        return p != null && p.link != null && p.link.alive();
    }

    // ---- starting and stopping

    /**
     * The app's link, starting the app if it isn't running.
     *
     * @param explicit the member asked ({@code apps.start}, an install's trial): a {@code failed} app is tried again
     * @throws RpcException {@code not_found} for an app that isn't installed, {@code forbidden} with {@code reason: revoked},
     *     {@code unavailable} with the reason it can't run ({@code switched_off}, {@code no_sandbox}, {@code no_hello},
     *     {@code needs_update}, {@code crashed}, {@code memory}, or the helper's code)
     */
    AppLink ensureRunning(String id, boolean explicit) throws RpcException, InterruptedException {
        Process p = processes.get(id);
        if (p == null) {
            throw new RpcException(RpcException.NOT_FOUND, "No such app", Map.of("reason", "app"));
        }
        AppLink link = p.link;
        if (link != null && link.alive()) {
            p.lastUse = nanoTime.get();
            return link;
        }
        if (!toggle.on()) {
            throw unavailable("switched_off");
        }
        String why = host.unavailable();
        if (why != null) {
            throw unavailable(why);
        }
        p.lock.lockInterruptibly();
        try {
            link = p.link;
            if (link != null && link.alive()) {
                p.lastUse = nanoTime.get();
                return link;
            }
            if (DISABLED.equals(p.state)) {
                throw new RpcException(RpcException.FORBIDDEN, "This app has been withdrawn", Map.of("reason", p.problem == null ? "revoked" : p.problem));
            }
            if (FAILED.equals(p.state) && !explicit) {
                throw unavailable(p.problem == null ? "crashed" : p.problem);
            }
            if (explicit) {
                p.failures.clear();
            }
            return start(p);
        } finally {
            p.lock.unlock();
        }
    }

    /** Under the app's lock. */
    private AppLink start(Process p) throws RpcException, InterruptedException {
        AppStore.Entry entry = p.entry;
        AppManifest manifest = p.manifest;
        p.state = STARTING;
        p.restartAt = 0;
        changed();
        AppLink link;
        try {
            host.start(p.id, entry.uid());
            link = AppLink.open(host.socket(p.id), host.peerUid(entry.uid()), hooks.hello(p),
                    Duration.ofSeconds(manifest.run().startTimeoutSec()), events(p));
        } catch (AppHost.AppHostException e) {
            stopQuietly(p.id);
            failed(p, "host");
            throw unavailable(e.code());
        } catch (AppLink.OpenException e) {
            stopQuietly(p.id);
            failed(p, e.reason());
            throw unavailable(e.reason());
        }
        p.link = link;
        p.state = RUNNING;
        p.problem = null;
        p.lastUse = nanoTime.get();
        log.info("apps: an app started");
        changed();
        if (manifest.widget()) {
            Thread.ofVirtual().name("app-summary").start(() -> subscribeSummary(p, link));
        }
        hooks.linkUp(p.id);
        ensureTicker();
        return link;
    }

    /** Stops the app if it runs. The helper is asked even if deskd has no link, as a unit may run on from before. */
    void stop(String id) throws InterruptedException {
        Process p = processes.get(id);
        if (p == null) {
            return;
        }
        p.lock.lockInterruptibly();
        try {
            AppLink link = p.link;
            p.link = null;
            if (link != null) {
                link.close();
            }
            stopQuietly(id);
            if (!DISABLED.equals(p.state)) {
                p.state = STOPPED;
                p.problem = null;
            }
            p.restartAt = 0;
        } finally {
            p.lock.unlock();
        }
        hooks.linkDown(id);
        changed();
    }

    void stopAll() {
        for (Process p : all()) {
            try {
                stop(p.id);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** Closes deskd's links and leaves the apps running, for deskd's own stop. */
    void detachAll() {
        for (Process p : all()) {
            AppLink link = p.link;
            p.link = null;
            if (link != null) {
                link.close();
            }
        }
    }

    private void stopQuietly(String id) throws InterruptedException {
        try {
            host.stop(id);
        } catch (AppHost.AppHostException e) {
            log.warn("apps: the helper couldn't stop an app: {}", e.code());
        }
    }

    private void failed(Process p, String reason) {
        long now = nanoTime.get();
        p.failures.addLast(now);
        while (!p.failures.isEmpty() && now - p.failures.peekFirst() > FAILURE_WINDOW.toNanos()) {
            p.failures.removeFirst();
        }
        p.problem = reason;
        p.state = "needs_update".equals(reason) || p.failures.size() >= MAX_FAILURES ? FAILED : STOPPED;
        log.info("apps: an app {}: {}", FAILED.equals(p.state) ? "stays stopped" : "stopped", reason);
        changed();
    }

    private AppLink.Events events(Process p) {
        return new AppLink.Events() {
            @Override
            public Object request(String method, Map<String, Object> params) throws RpcException {
                return hooks.request(p, method, params);
            }

            @Override
            public void down(AppLink link, boolean planned, int code) {
                if (!planned) {
                    Thread.ofVirtual().name("app-down").start(() -> crashed(p, link, code));
                }
            }
        };
    }

    private void crashed(Process p, AppLink link, int code) {
        try {
            p.lock.lockInterruptibly();
        } catch (InterruptedException e) {
            return;
        }
        try {
            if (p.link != link) {
                return;
            }
            p.link = null;
            String reason = code == AppLink.CLOSE_API_MISMATCH ? "needs_update" : "crashed";
            if (!"needs_update".equals(reason)) {
                try {
                    if (host.status(p.id).outOfMemory()) {
                        reason = "memory";
                    }
                } catch (AppHost.AppHostException e) {
                    // As a crash.
                }
            }
            stopQuietly(p.id);
            failed(p, reason);
            if (STOPPED.equals(p.state) && (background(p) || hooks.inUse(p.id))) {
                scheduleRestart(p, BACKOFF_MS[Math.min(p.failures.size(), BACKOFF_MS.length) - 1]);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            p.lock.unlock();
        }
        hooks.linkDown(p.id);
    }

    private static boolean background(Process p) {
        return p.manifest.run().background() && p.entry.grants().contains(AppManifest.BACKGROUND);
    }

    // ---- the widget

    private void subscribeSummary(Process p, AppLink link) {
        try {
            link.subscribe("app.summary", Map.of("kind", "desk"), (type, data) -> {
                Map<String, Object> summary = AppSummary.check(data);
                if (summary != null && !summary.equals(p.summary)) {
                    p.summary = summary;
                    AppSummaryFile.write(store, p);
                    changed();
                }
            }, Duration.ofSeconds(5));
        } catch (RpcException e) {
            log.info("apps: an app's widget summary couldn't be subscribed: {}", e.code());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ---- the ticker: idle stops and the switch, only while an app runs

    /** Nothing runs until an app does: {@link #ensureTicker} starts the ticker, and it ends when no app runs. */
    void start() {
        started = true;
    }

    void close() {
        started = false;
        ticking.set(false);
        Thread t = ticker;
        if (t != null) {
            t.interrupt();
        }
    }

    /** Every 30 s while any app runs: stops what's idle, and everything while the switch is off. Then it ends. */
    private void ensureTicker() {
        if (!started || !ticking.compareAndSet(false, true)) {
            return;
        }
        ticker = Thread.ofVirtual().name("apps-ticker").start(() -> {
            try {
                while (started) {
                    Thread.sleep(tick);
                    tick();
                    if (all().stream().noneMatch(p -> p.link != null && p.link.alive())) {
                        break;
                    }
                }
            } catch (InterruptedException e) {
                // Stopping.
            } finally {
                ticking.set(false);
                // An app that started as the loop ended still gets a ticker.
                if (started && all().stream().anyMatch(p -> p.link != null && p.link.alive())) {
                    ensureTicker();
                }
            }
        });
    }

    /** One round: stop what's idle, and everything while the switch is off. */
    void tick() throws InterruptedException {
        long now = nanoTime.get();
        boolean on = toggle.on();
        for (Process p : all()) {
            AppLink link = p.link;
            if (link == null || !link.alive()) {
                continue;
            }
            if (!on) {
                stop(p.id);
            } else if (!background(p) && !hooks.inUse(p.id) && now - p.lastUse > IDLE.toNanos()) {
                log.info("apps: an idle app stopped");
                stop(p.id);
            }
        }
    }

    /** A one-shot timer: the app starts again after its backoff, if nothing else has started or stopped it meanwhile. */
    private void scheduleRestart(Process p, long delayMs) {
        long due = nanoTime.get() + delayMs * 1_000_000L;
        p.restartAt = due;
        Thread.ofVirtual().name("app-restart").start(() -> {
            try {
                Thread.sleep(delayMs);
                if (started && p.restartAt == due && STOPPED.equals(p.state) && toggle.on()) {
                    ensureRunning(p.id, false);
                }
            } catch (RpcException e) {
                // Counted, and told through the state.
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    /** At deskd's start: connects to apps the helper says still run, and starts background apps. */
    void resume() {
        if (!toggle.on() || host.unavailable() != null) {
            return;
        }
        for (Process p : all()) {
            if (DISABLED.equals(p.state)) {
                continue;
            }
            Thread.ofVirtual().name("app-resume").start(() -> {
                try {
                    boolean runs = host.status(p.id).running();
                    if (runs || background(p)) {
                        ensureRunning(p.id, false);
                    }
                } catch (AppHost.AppHostException | RpcException e) {
                    // Started on first use instead, or told through the state.
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }
    }

    // ---- reading it

    /** What {@code apps.list} and the {@code apps} topic say of one app. */
    Map<String, Object> describe(Process p) {
        Map<String, Object> json = new LinkedHashMap<>(p.manifest.summaryJson());
        AppStore.Entry e = p.entry;
        json.put("previous", e.previous());
        json.put("tier", e.tier());
        json.put("grants", e.grants());
        json.put("state", p.state);
        json.put("problem", p.problem);
        json.put("summary", p.summary);
        json.put("installedAt", e.installedAt());
        json.put("updatedAt", e.updatedAt());
        return json;
    }

    Map<String, Integer> counts() {
        int installed = 0;
        int running = 0;
        int failed = 0;
        for (Process p : all()) {
            installed++;
            if (p.link != null && p.link.alive()) {
                running++;
            }
            if (FAILED.equals(p.state)) {
                failed++;
            }
        }
        Map<String, Integer> counts = new LinkedHashMap<>();
        counts.put("installed", installed);
        counts.put("running", running);
        counts.put("failed", failed);
        return counts;
    }

    private void changed() {
        Hooks h = hooks;
        if (h != null) {
            h.changed();
        }
    }

    static RpcException unavailable(String reason) {
        return new RpcException(RpcException.UNAVAILABLE, "The app can't run now", Map.of("reason", reason));
    }

    /** The widget's last summary on the volume, so it shows across restarts. */
    static final class AppSummaryFile {
        private AppSummaryFile() {}

        static Map<String, Object> read(AppStore store, String id) {
            byte[] bytes = store.loadSummary(id);
            if (bytes == null) {
                return null;
            }
            try {
                return AppSummary.check(com.minimalistalliance.desk.deskd.protocol.Json.parseObject(bytes));
            } catch (com.minimalistalliance.desk.deskd.protocol.JsonFormatException e) {
                return null;
            }
        }

        /** How many writers are running, for a test to wait for before it removes the directory they write into. */
        private static final java.util.concurrent.atomic.AtomicInteger writing = new java.util.concurrent.atomic.AtomicInteger();

        static int writers() {
            return writing.get();
        }

        /** One writer per app at a time, which writes again if a newer summary came while it wrote. */
        static void write(AppStore store, Process p) {
            if (!p.savingSummary.compareAndSet(false, true)) {
                return;
            }
            writing.incrementAndGet();
            Thread.ofVirtual().name("app-summary-save").start(() -> {
                Map<String, Object> written = null;
                try {
                    while (true) {
                        Map<String, Object> now = p.summary;
                        if (now == null || now == written) {
                            return;
                        }
                        store.saveSummary(p.id, com.minimalistalliance.desk.deskd.protocol.Json.bytes(now));
                        written = now;
                    }
                } catch (IOException e) {
                    log.info("apps: a widget summary couldn't be kept");
                } finally {
                    p.savingSummary.set(false);
                    if (p.summary != written && p.summary != null) {
                        write(store, p);
                    }
                    writing.decrementAndGet();
                }
            });
        }
    }
}
