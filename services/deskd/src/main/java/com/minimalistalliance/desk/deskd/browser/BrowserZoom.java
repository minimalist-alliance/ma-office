package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.DoubleConsumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The Browser's zoom (the owner's per-app zoom, Nov 12; API.md section 10, "Zoom"): one level, 50 to 200%, for every
 * member's tab and every site, now and later. It's Chromium's own page zoom, so pages lay out again at the new width
 * and text is drawn sharp at the new size, not a scaled picture and not {@code browser.pinch}.
 *
 * <p><b>How.</b> CDP has no page zoom (Chrome for Testing 156 and 158), so deskd sets Chromium's default zoom with
 * {@code chrome.settingsPrivate.setDefaultZoom}, in a hidden page of Chromium's own ({@link ChromiumPages.Kind#ZOOM}),
 * kept open {@code linger} after its last use, as it costs about 45 MB. Chromium applies it to every tab at once, opens
 * new tabs at it, and keeps it in its own profile across its restarts; deskd never writes {@code /data/browser/profile}
 * (ADR 0035). deskd keeps the level in {@code /data/desk/browser-zoom.json} too, which wins: it's checked and set again
 * on every connection to Chromium, so a start of Chromium, a band's restart of it or a crash that lost Chromium's own copy
 * all come back to it.
 *
 * <p><b>A site's own zoom.</b> Chromium remembers a zoom per site, which beats the default: from Ctrl+= and Ctrl+- in the
 * stream, or from before. Setting the default to a site's level erases it, from Chromium's prefs too. So:
 * <ul>
 *   <li>The first time this desk's Chromium is reached, every level Chromium's keys can make from 50 to 200% is erased
 *       that way, then the level set (the sweep, once, kept in the file).
 *   <li>A member's tab whose page zoom changes ({@code Page.frameResized}) with no new document is the member zooming in
 *       the stream: the level follows it, clamped to the range, and the site's own goes. That's folding it in.
 *   <li>A member's tab whose new document comes at another zoom, or one found so as deskd connects, is a site's
 *       remembered zoom: it's erased, and the level stays.
 * </ul>
 * Ctrl+0 resets a site to the default, which is the level, so it changes nothing.
 *
 * <p><b>Not here.</b> The phone view's mobile emulation sets page zoom aside (it reads 1), so nothing is read while a
 * phone's view is wanted or shown. The Agent's tabs follow the default too, in its own contexts and the member's, so
 * {@link AgentBrowsing} sizes their viewport by it, to keep them at 100% ({@code agent}).
 *
 * <p><b>Locks.</b> {@code lock} for the model; {@code applying} for what goes to Chromium, one thing at a time; the page
 * and Chromium's calls are under {@code applying} only. Nothing logs a URL or a host.
 */
final class BrowserZoom implements BrowserTabs.ZoomHooks {

    private static final Logger log = LoggerFactory.getLogger(BrowserZoom.class);

    static final String GET = "browser.zoom.get";
    static final String SET = "browser.zoom.set";
    static final String FILE = "browser-zoom.json";
    static final int MIN = 50;
    static final int MAX = 200;
    static final int DEFAULT = 100;
    /** Chromium's own zoom steps (its {@code kPresetZoomFactors}): what its keys and wheel can make. */
    static final double[] PRESETS = {0.25, 1.0 / 3, 0.5, 2.0 / 3, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0};
    /**
     * The steps the sweep passes over, those in the range: every open tab reflows at each, and past 200% a page's images
     * can be fetched again at a larger scale. A site left at one outside it is erased as its page commits instead.
     */
    static final double[] SWEPT = java.util.Arrays.stream(PRESETS).filter(f -> f >= 0.5 - 0.001 && f <= 2.0 + 0.001).toArray();
    /** Two zooms closer than this are the same: Chromium reads a factor back as a float. */
    static final double SAME = 0.005;
    private static final int MAX_FILE_BYTES = 4096;
    /** Past this many tabs' commits remembered, those older than the window go. */
    private static final int MAX_COMMITS = 64;
    /**
     * The longest a member's tab gets to say its zoom (at most the request timeout). A tab Chromium restored but hasn't
     * loaded has no renderer to answer {@code Page.getLayoutMetrics}, and every read is under {@code applying}: at the full
     * request timeout each, a connect's check over many such tabs held a client's set for minutes (release 5, the TEST desk
     * with 52 tabs). One that doesn't answer in time is read again at its next change, as a page that hangs always was.
     */
    static final Duration TAB_READ = Duration.ofSeconds(1);
    /** The most a connect's check spends reading the member's tabs, all of them; the rest wait for their next change. */
    static final Duration TABS_READ = Duration.ofSeconds(3);

    static final String GET_DEFAULT = "function () { return chrome.settingsPrivate.getDefaultZoom(); }";
    static final String SET_DEFAULT = "function (zoom) { return chrome.settingsPrivate.setDefaultZoom(zoom).then(() => true); }";

    /**
     * @param settle how long after a tab's last resize or commit it's read, so a burst is read once
     * @param quiet how long after deskd's own change nothing is read: a tab can still show the zoom before it
     * @param commitWindow a tab's zoom found this soon after its new document is the site's, not the member's keys
     * @param linger how long the page stays open after its last use
     * @param retry how long a failed check of the level waits before it's tried again, on the same connection
     * @param load what Chromium's page gets to load
     */
    record Timing(Duration settle, Duration quiet, Duration commitWindow, Duration linger, Duration retry, Duration load) {
        static final Timing DEFAULT = new Timing(
                Duration.ofMillis(300), Duration.ofMillis(500), Duration.ofMillis(1500), Duration.ofSeconds(20), Duration.ofSeconds(5),
                Duration.ofSeconds(10));
    }

    /** What the zoom needs of the tabs and the connection: {@link BrowserTabs#zoomAccess}. */
    interface Chromium extends ChromiumPages.Calls {
        /** The connection is up and its tabs read, now. Never waits, and never brings a connection. */
        boolean ready();

        /** The member's tabs that have deskd's session, the one on screen first. */
        List<BrowserTabs.ViewTab> memberTabs();
    }

    private enum Kind {
        RESIZED,
        COMMITTED
    }

    private static final class Check {
        final String tabId;
        long due;
        Check(String tabId, long due) {
            this.tabId = tabId;
            this.due = due;
        }
    }

    private final Path file;
    private final Chromium chromium;
    private final BrowserFreeze freeze;
    private final ChromiumPages pages;
    private final Timing timing;

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition moved = lock.newCondition();
    /** Fair, so a client's set waiting on it goes next rather than behind the worker's following steps. */
    private final ReentrantLock applying = new ReentrantLock(true);
    private int level;
    /** Every level Chromium's keys make has been erased once on this desk. */
    private boolean swept;
    /** The connection has come up and its level isn't known to be checked yet. */
    private boolean reconcileDue;
    private long reconcileAt;
    /** By the tab's session: a tab to read once {@code due}. */
    private final Map<String, Check> checks = new HashMap<>();
    /** By the tab's session: when its main frame last committed. */
    private final Map<String, Long> commits = new HashMap<>();
    private long lastOwnChange;
    private boolean closed;
    private Thread worker;
    /** Under {@code applying}: the page, while it's open. */
    private ChromiumPages.Page page;
    private volatile long pageUsed;
    private volatile boolean pageOpen;
    private volatile BooleanSupplier phoneInPlay = () -> false;
    private volatile DoubleConsumer agent = zoom -> {};
    private volatile Runnable changed = () -> {};

    /** @param directory deskd's data directory, {@code /data/desk} on a desk */
    BrowserZoom(Path directory, Chromium chromium, BrowserFreeze freeze, Timing timing) {
        this.file = directory.resolve(FILE);
        this.chromium = chromium;
        this.freeze = freeze;
        this.timing = timing;
        this.pages = new ChromiumPages(chromium, timing.load());
        this.level = DEFAULT;
        load();
        this.lastOwnChange = System.nanoTime() - timing.quiet().toNanos() - 1;
    }

    void register(RpcDispatcher dispatcher) {
        dispatcher.register(GET, this::get);
        // It changes what the member sees, as the Browser's other drivers do, so it's a mutation and needs input.
        dispatcher.registerMutation(SET, BrowserMethods.working(freeze, this::set));
    }

    /** The phone view: while it says true, nothing is read, as mobile emulation sets page zoom aside. Must not block. */
    void phoneFrom(BooleanSupplier inPlay) {
        this.phoneInPlay = inPlay;
    }

    /** Told the factor after each change of Chromium's default: the Agent's tabs. Must not block for long. */
    void agentFrom(DoubleConsumer agent) {
        this.agent = agent;
    }

    /** Told when the level changes, on whatever thread changed it: {@code browser.view}'s publish. */
    void onChange(Runnable changed) {
        this.changed = changed;
    }

    void start() {
        lock.lock();
        try {
            if (worker == null && !closed) {
                worker = Thread.ofVirtual().name("browser-zoom").start(this::work);
            }
        } finally {
            lock.unlock();
        }
    }

    void close() {
        lock.lock();
        try {
            closed = true;
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        // The page goes with deskd's connection anyway; this is only sooner.
        if (applying.tryLock()) {
            try {
                closePage();
            } finally {
                applying.unlock();
            }
        }
    }

    /** The level, a whole percent from 50 to 200. */
    int level() {
        lock.lock();
        try {
            return level;
        } finally {
            lock.unlock();
        }
    }

    /** The level as Chromium's zoom factor: 67 is Chromium's 2/3, the rest a hundredth each. */
    double factor() {
        return factor(level());
    }

    static double factor(int level) {
        return level == 67 ? 2.0 / 3 : level / 100.0;
    }

    /** A factor as the nearest whole percent: 2/3 is 67. */
    static int percent(double factor) {
        return (int) Math.round(factor * 100);
    }

    static boolean same(double a, double b) {
        return Math.abs(a - b) < SAME;
    }

    /** Chromium's own step this is, if it's one, so a float read back is set as Chromium has it. */
    static double snap(double factor) {
        for (double preset : PRESETS) {
            if (same(preset, factor)) {
                return preset;
            }
        }
        return factor;
    }

    /** One of Chromium's own steps, which is all its keys and its wheel make. */
    static boolean isPreset(double factor) {
        for (double preset : PRESETS) {
            if (preset == factor) {
                return true;
            }
        }
        return false;
    }

    static int clamp(int level) {
        return Math.max(MIN, Math.min(MAX, level));
    }

    /** /health's: the level, and whether the page is open. Never a site. */
    Map<String, Object> health() {
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("level", level());
        health.put("page", pageOpen);
        return health;
    }

    // ---- a client's calls

    private Object get(RpcContext context, Map<String, Object> params) throws RpcException {
        if (!context.principal().video()) {
            throw BrowserMethods.forbidden();
        }
        return Map.of("level", level());
    }

    private Object set(RpcContext context, Map<String, Object> params) throws Exception {
        if (!context.principal().input()) {
            throw BrowserMethods.forbidden();
        }
        int wanted = parseLevel(params.get("level"));
        lock.lock();
        try {
            // The level it is, kept and with nothing owed to Chromium: no file, no page, no wait behind another set.
            if (level == wanted && !reconcileDue) {
                return Map.of("level", wanted);
            }
        } finally {
            lock.unlock();
        }
        context.beginEffect();
        applying.lockInterruptibly();
        try {
            int before;
            boolean sweptNow;
            lock.lock();
            try {
                before = level;
                sweptNow = swept;
            } finally {
                lock.unlock();
            }
            // Kept first, as it's what wins on every connection: a level Chromium has and the file doesn't would be undone.
            if (!save(wanted, sweptNow)) {
                throw new RpcException(RpcException.INTERNAL, "Internal error", Map.of());
            }
            lock.lock();
            try {
                level = wanted;
            } finally {
                lock.unlock();
            }
            if (before != wanted) {
                log.info("browser zoom {}", wanted);
                changed.run();
            }
            if (chromium.ready() && freeze.cdpAllowed()) {
                try {
                    applyLocked(false);
                } catch (CdpException | ChromiumPages.Failed e) {
                    // Kept, and checked again on this connection and on the next one.
                    log.info("browser zoom: chromium didn't take the level yet ({})", why(e));
                    owe(timing.retry());
                }
            }
            // Otherwise the next connection to Chromium checks it.
        } finally {
            applying.unlock();
        }
        return Map.of("level", wanted);
    }

    /** {@code level}: a whole number from 50 to 200, or {@code bad_request} with {@code reason: level}. */
    static int parseLevel(Object raw) throws RpcException {
        if (!(raw instanceof Number number)
                || !Double.isFinite(number.doubleValue())
                || number.doubleValue() != Math.rint(number.doubleValue())
                || number.doubleValue() < MIN
                || number.doubleValue() > MAX) {
            throw new RpcException(RpcException.BAD_REQUEST, "level must be a whole percent from 50 to 200", Map.of("reason", "level"));
        }
        return number.intValue();
    }

    // ---- what the Browser tells (BrowserTabs.ZoomHooks): quick, never Chromium

    @Override
    public void onConnected() {
        lock.lock();
        try {
            reconcileDue = true;
            reconcileAt = System.nanoTime();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onResized(String tabId, String sessionId) {
        note(tabId, sessionId, Kind.RESIZED);
    }

    @Override
    public void onMainFrameCommitted(String tabId, String sessionId) {
        note(tabId, sessionId, Kind.COMMITTED);
    }

    @Override
    public void onDisconnected() {
        lock.lock();
        try {
            checks.clear();
            commits.clear();
            reconcileDue = false;
        } finally {
            lock.unlock();
        }
        // Chromium closes a hidden page with the connection that made it.
        pageOpen = false;
    }

    private void note(String tabId, String sessionId, Kind kind) {
        lock.lock();
        try {
            long now = System.nanoTime();
            if (kind == Kind.COMMITTED) {
                commits.put(sessionId, now);
                if (commits.size() > MAX_COMMITS) {
                    // Only a commit within the window matters: tabs that went over a long connection don't stay.
                    long window = timing.commitWindow().toNanos();
                    commits.values().removeIf(at -> now - at >= window);
                }
            }
            Check check = checks.computeIfAbsent(sessionId, id -> new Check(tabId, now));
            check.due = now + timing.settle().toNanos();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    // ---- the worker

    private void work() {
        while (true) {
            Runnable step;
            lock.lock();
            try {
                step = next();
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
            if (step == null) {
                return;
            }
            try {
                step.run();
            } catch (RuntimeException e) {
                log.warn("browser zoom: a step failed", e);
            }
            if (Thread.currentThread().isInterrupted()) {
                return;
            }
        }
    }

    /** With the lock held: waits for the next thing to do, or null once closed. */
    private Runnable next() throws InterruptedException {
        while (!closed) {
            long now = System.nanoTime();
            long wait = Long.MAX_VALUE;
            long quietEnds = lastOwnChange + timing.quiet().toNanos();
            if (reconcileDue) {
                long due = later(reconcileAt, quietEnds);
                if (due - now <= 0) {
                    reconcileDue = false;
                    return this::reconcile;
                }
                wait = Math.min(wait, due - now);
            }
            for (Map.Entry<String, Check> entry : checks.entrySet()) {
                long due = later(entry.getValue().due, quietEnds);
                if (due - now <= 0) {
                    String sessionId = entry.getKey();
                    String tabId = entry.getValue().tabId;
                    checks.remove(sessionId);
                    Long committed = commits.get(sessionId);
                    boolean afterCommit = committed != null && now - committed < timing.commitWindow().toNanos();
                    return () -> check(tabId, sessionId, afterCommit);
                }
                wait = Math.min(wait, due - now);
            }
            if (pageOpen) {
                long due = pageUsed + timing.linger().toNanos();
                if (due - now <= 0) {
                    return this::closeIdlePage;
                }
                wait = Math.min(wait, due - now);
            }
            if (wait == Long.MAX_VALUE) {
                moved.await();
            } else {
                moved.awaitNanos(wait);
            }
        }
        return null;
    }

    private static long later(long a, long b) {
        return a - b >= 0 ? a : b;
    }

    private void owe(Duration after) {
        lock.lock();
        try {
            reconcileDue = true;
            reconcileAt = System.nanoTime() + after.toNanos();
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** As deskd connects: Chromium's default is the level, and no tab shows a site's own. */
    private void reconcile() {
        if (!chromium.ready() || !freeze.cdpAllowed()) {
            return; // The next connection brings it.
        }
        try (BrowserFreeze.Use use = freeze.use()) {
            applying.lockInterruptibly();
            try {
                applyLocked(true);
            } finally {
                applying.unlock();
            }
        } catch (CdpException | ChromiumPages.Failed e) {
            log.info("browser zoom: couldn't check chromium's level ({})", why(e));
            if (chromium.ready()) {
                owe(timing.retry());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * With {@code applying} held: Chromium's default made the level, the sweep done once, and with {@code tabs}, every
     * member's tab showing another zoom has its site's erased.
     */
    private void applyLocked(boolean tabs) throws CdpException, ChromiumPages.Failed, InterruptedException {
        double want = factor();
        boolean sweep;
        lock.lock();
        try {
            sweep = !swept;
        } finally {
            lock.unlock();
        }
        List<BrowserTabs.ViewTab> off = new ArrayList<>();
        if (tabs && !sweep && !phoneInPlay.getAsBoolean()) {
            List<BrowserTabs.ViewTab> list = chromium.memberTabs();
            boolean all = !list.isEmpty();
            long readUntil = System.nanoTime() + TABS_READ.toNanos();
            for (BrowserTabs.ViewTab tab : list) {
                if (System.nanoTime() - readUntil >= 0) {
                    all = false; // Not all read: the page checks the default, and the rest are read at their next change.
                    break;
                }
                Double zoom = zoomOf(tab.sessionId());
                if (zoom == null) {
                    all = false;
                } else if (!same(zoom, want)) {
                    off.add(tab);
                }
            }
            if (all && off.isEmpty()) {
                // Every tab shows the level, so Chromium's default is it: no page needed.
                agent.accept(want);
                return;
            }
        }
        Object current = page().call(GET_DEFAULT, chromium.request());
        if (sweep) {
            for (double preset : SWEPT) {
                setDefault(preset);
            }
            setDefault(want);
            lock.lock();
            try {
                swept = true;
            } finally {
                lock.unlock();
            }
            save();
            log.info("browser zoom: every level in the range chromium's keys could have left on a site erased once");
        } else if (!(current instanceof Number now) || !same(now.doubleValue(), want)) {
            setDefault(want);
        }
        agent.accept(want);
        for (BrowserTabs.ViewTab tab : off) {
            Double zoom = zoomOf(tab.sessionId());
            if (zoom != null && !same(zoom, want) && zoom >= PRESETS[0] - SAME && zoom <= PRESETS[PRESETS.length - 1] + SAME) {
                eraseSite(snap(zoom), want);
            }
        }
    }

    /** A member's tab is read, after its burst: the member's keys fold in, a site's own zoom is erased. */
    private void check(String tabId, String sessionId, boolean afterCommit) {
        if (phoneInPlay.getAsBoolean() || !chromium.ready() || !freeze.cdpAllowed()) {
            return;
        }
        try (BrowserFreeze.Use use = freeze.use()) {
            applying.lockInterruptibly();
            try {
                double want = factor();
                Double zoom = zoomOf(sessionId);
                if (zoom == null || same(zoom, want) || phoneInPlay.getAsBoolean()) {
                    return;
                }
                if (!(zoom >= PRESETS[0] - SAME) || !(zoom <= PRESETS[PRESETS.length - 1] + SAME)) {
                    return; // No level Chromium makes: nothing to fold in or erase.
                }
                double seen = snap(zoom);
                if (afterCommit || !isPreset(seen)) {
                    // A site's remembered level, or one no key of Chromium's makes: the site's goes, the level stays.
                    eraseSite(seen, want);
                    log.info("browser zoom: a site's own zoom erased, the level kept");
                } else {
                    foldIn(seen);
                }
            } finally {
                applying.unlock();
            }
        } catch (CdpException | ChromiumPages.Failed e) {
            log.debug("browser zoom: a tab couldn't be read or set: {}", why(e));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** With {@code applying} held: the member zoomed with Chromium's keys, so the level follows, clamped to the range. */
    private void foldIn(double seen) throws CdpException, ChromiumPages.Failed, InterruptedException {
        int folded = clamp(percent(seen));
        // The default at the site's level erases the site's, and a level past the range is then brought back into it.
        setDefault(seen);
        double now = factor(folded);
        if (!same(now, seen)) {
            setDefault(now);
        }
        lock.lock();
        try {
            level = folded;
        } finally {
            lock.unlock();
        }
        save();
        agent.accept(now);
        log.info("browser zoom {}: chromium's own zoom on a tab, folded in", folded);
        changed.run();
    }

    /** With {@code applying} held: erases a site's own {@code zoom} by passing the default over it, then back to {@code want}. */
    private void eraseSite(double zoom, double want) throws CdpException, ChromiumPages.Failed, InterruptedException {
        setDefault(zoom);
        setDefault(want);
        agent.accept(want);
    }

    /** With {@code applying} held. */
    private void setDefault(double zoom) throws CdpException, ChromiumPages.Failed, InterruptedException {
        page().call(SET_DEFAULT, chromium.request(), zoom);
        lock.lock();
        try {
            lastOwnChange = System.nanoTime();
        } finally {
            lock.unlock();
        }
    }

    /** A member's tab's page zoom, which {@code Page.getLayoutMetrics} gives, or null if it doesn't say. */
    private Double zoomOf(String sessionId) throws InterruptedException {
        try {
            Duration request = chromium.request();
            Duration timeout = request.compareTo(TAB_READ) < 0 ? request : TAB_READ;
            Map<String, Object> metrics = chromium.call(sessionId, "Page.getLayoutMetrics", Map.of(), timeout);
            Map<String, Object> viewport = Json.object(metrics, "cssVisualViewport");
            if (viewport != null && viewport.get("zoom") instanceof Number zoom && zoom.doubleValue() > 0) {
                return zoom.doubleValue();
            }
        } catch (CdpException e) {
            // A tab that's going, or a page that hangs: read again at its next change.
        }
        return null;
    }

    /** With {@code applying} held: the open page, or a new one. */
    private ChromiumPages.Page page() throws CdpException, ChromiumPages.Failed, InterruptedException {
        pageUsed = System.nanoTime();
        if (page != null && pageOpen) {
            return page;
        }
        closePage();
        page = pages.open(ChromiumPages.Kind.ZOOM);
        pageOpen = true;
        lock.lock();
        try {
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        return page;
    }

    private void closeIdlePage() {
        if (!applying.tryLock()) {
            pageUsed = System.nanoTime();
            return;
        }
        try {
            if (System.nanoTime() - pageUsed >= timing.linger().toNanos()) {
                closePage();
            }
        } finally {
            applying.unlock();
        }
    }

    /** With {@code applying} held. */
    private void closePage() {
        ChromiumPages.Page open = page;
        page = null;
        pageOpen = false;
        if (open != null) {
            open.close();
        }
    }

    private static String why(Exception e) {
        return e instanceof CdpException cdp ? cdp.kind().toString() : "page";
    }

    // ---- the file

    /** {@code {"level": 150, "swept": true}}: anything else there is the default level, and not swept. */
    private void load() {
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_FILE_BYTES) {
                return;
            }
            Map<String, Object> saved = Json.parseObject(Files.readAllBytes(file));
            level = parseLevel(saved.get("level"));
            swept = Boolean.TRUE.equals(saved.get("swept"));
        } catch (IOException | JsonFormatException | RpcException e) {
            log.warn("browser zoom: {} can't be read, so the level is {}", FILE, DEFAULT);
            level = DEFAULT;
            swept = false;
        }
    }

    /** {@link #save(int, boolean)} with what's in memory. */
    private boolean save() {
        int keep;
        boolean sweptToo;
        lock.lock();
        try {
            keep = level;
            sweptToo = swept;
        } finally {
            lock.unlock();
        }
        // Outside the lock: the read path takes it.
        return save(keep, sweptToo);
    }

    /**
     * The whole file through a new temporary file, synced and renamed over it. A failure is logged.
     *
     * @return whether it's written
     */
    private boolean save(int keep, boolean sweptToo) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("level", keep);
        body.put("swept", sweptToo);
        Path temporary = file.resolveSibling(FILE + ".tmp");
        try {
            Files.deleteIfExists(temporary);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(Json.bytes(body));
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            try {
                Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException e) {
                // Not a POSIX file system: only in a test.
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
                directory.force(true);
            } catch (IOException e) {
                // Some file systems can't open a directory to sync it; the rename is still atomic.
            }
            return true;
        } catch (IOException e) {
            log.warn("browser zoom: {} couldn't be written: {}", FILE, e.getClass().getSimpleName());
            return false;
        } finally {
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException e) {
                // Left for the next write, which removes it first.
            }
        }
    }
}
