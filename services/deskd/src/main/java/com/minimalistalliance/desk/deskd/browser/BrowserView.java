package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The phone view: a member controls the desk's Browser from a phone, not just watches it (the owner's "Touch control on
 * phones", Nov 11; API.md section 10, "On a phone"). While the session that looked at the Browser last is a phone's, every
 * one of the member's tabs is laid out as that phone would lay it out, and the pointer desk-rtc moves is a finger to it.
 *
 * <p><b>Who decides.</b> A session's device comes with {@code desk.attention.set} ({@link Device}). Of the sessions that
 * want {@code live} and look at the desk (or have never said, as a client from before), the one that last began to look,
 * went {@code live}, changed its device or put input on the screen is the one the tabs follow. If that's a phone, the view
 * is its; anything else, or nobody, is the desk's own. So a phone leaving, or a desktop's first input after a second's
 * rest, takes it back. A flip waits until what's wanted has held for {@code settle}, and one between a phone and the desk
 * also waits {@code minGap} after the last, so two people taking turns can't reflow a page faster than that.
 *
 * <p><b>The simplified view</b> is {@code warm}, so it never votes, and while it's in use anywhere
 * ({@link #simplified}) the tabs keep the desk's own view, at once: it reads the desk's layout, and it clicks with CDP's
 * mouse, which under touch emulation lands at the screen's scale and never answers.
 *
 * <p><b>What it sets,</b> on each tab's own session, which Chromium drops with the session, so a lost connection or a
 * restart of deskd leaves the desk's own view: {@code Emulation.setDeviceMetricsOverride} with {@code mobile} and the
 * phone's CSS size, at the scale that fits the window, which is also the {@code devicePixelRatio} the page sees, so a
 * box times the ratio is still its place on the screen; {@code setTouchEmulationEnabled}; and
 * {@code setEmitTouchEventsForMouse} ({@code mobile}), so the primary button desk-rtc presses is a finger. Chromium draws
 * the view at the window's top left, so the picture's region is {@code (0, 0)} to the CSS size times the scale. Nothing
 * reloads, and the tab on screen keeps its place ({@link ViewScripts#SAVE}). No user agent changes: a site's sign-in or
 * its bot wall's clearance can be bound to it. Nothing touches the profile (ADR 0035).
 *
 * <p><b>Fields.</b> While the view is a phone's, deskd watches focus in each tab's documents, in a world of its own, and
 * {@value #TOPIC} says what's focused in the tab on screen, so the phone can raise its keyboard. {@value #FIELD_AT} says
 * what a tap would focus before it lands, since iOS raises its keyboard only inside the tap.
 *
 * <p><b>Locks.</b> {@code lock} is held for the model only. CDP calls, the stream's lock and publishing are outside it.
 */
final class BrowserView implements Topic, BrowserTabs.ViewHooks {

    private static final Logger log = LoggerFactory.getLogger(BrowserView.class);

    static final String TOPIC = "browser.view";
    static final String PINCH = "browser.pinch";
    static final String FIELD_AT = "browser.field.at";
    /** A phone's picture, in CSS pixels a side. */
    static final int MIN_SIDE = 160;
    static final int MAX_SIDE = 2048;
    static final double MIN_SCALE = 0.5;
    static final double MAX_SCALE = 4;
    static final double MIN_PINCH = 0.25;
    static final double MAX_PINCH = 4;
    static final int NORMALIZED = 65535;
    static final int TOUCH_POINTS = 5;
    /** What a field's report from the page may be, past which it's dropped: a few fixed words and four numbers. */
    static final int MAX_REPORT_CHARS = 512;
    private static final Duration PINCH_WAIT = Duration.ofSeconds(5);
    static final Set<String> KINDS = Set.of(
            "plain", "query", "email_address", "phone_number", "web_address", "numeric", "decimal", "multiline", "secret",
            "unknown");
    static final Set<String> ENTER_KEYS = Set.of("enter", "done", "go", "next", "previous", "search", "send");

    /**
     * @param settle how long what's wanted must hold before the tabs follow it
     * @param minGap the least time between two flips from a phone to the desk or back
     * @param retry how long a flip that couldn't be done waits before it's tried again, unless something else changes
     * @param request what each CDP command gets
     */
    record Timing(Duration settle, Duration minGap, Duration retry, Duration request) {
        static final Timing DEFAULT = new Timing(Duration.ofMillis(800), Duration.ofSeconds(4), Duration.ofSeconds(2), Duration.ofSeconds(2));
    }

    /** What a session said it's on: a phone, with the CSS size of the box its picture fills, or anything else. */
    record Device(boolean phone, int width, int height) {
        static final Device OTHER = new Device(false, 0, 0);

        /** {@code desk.attention.set}'s {@code device}: absent or null is {@link #OTHER}, as is any kind but {@code phone}. */
        static Device parse(Object raw) throws RpcException {
            if (raw == null) {
                return OTHER;
            }
            if (!(raw instanceof Map<?, ?> map) || !(map.get("kind") instanceof String kind)) {
                throw badDevice();
            }
            if (!"phone".equals(kind)) {
                return OTHER;
            }
            return new Device(true, side(map.get("width")), side(map.get("height")));
        }

        private static int side(Object raw) throws RpcException {
            if (!(raw instanceof Number number) || !Double.isFinite(number.doubleValue())) {
                throw badDevice();
            }
            long side = Math.round(number.doubleValue());
            if (side < MIN_SIDE || side > MAX_SIDE) {
                throw badDevice();
            }
            return (int) side;
        }

        private static RpcException badDevice() {
            return new RpcException(RpcException.BAD_REQUEST, "device must be {kind, width, height}", Map.of("reason", "device"));
        }
    }

    /** The view a phone's session wants. */
    private record Phone(String sessionId, int width, int height) {}

    /**
     * A phone's view as the tabs have it: its CSS size at {@code scale} screen pixels each, from the window's top left, on
     * a screen of this size.
     */
    record Shown(String sessionId, int width, int height, double scale, int screenWidth, int screenHeight) {
        boolean sameEmulation(Shown other) {
            return other != null && width == other.width && height == other.height && scale == other.scale;
        }

        int regionWidth() {
            return (int) Math.round(width * scale);
        }

        int regionHeight() {
            return (int) Math.round(height * scale);
        }
    }

    /** The field focused in the tab on screen, its box normalized to the picture as input is. */
    private record Field(String tabId, String kind, String enterKey, int x, int y, int width, int height) {}

    private static final class Viewer {
        /** Null: it has never said, as a client from before desk.attention.set. */
        Boolean seen;
        Device device = Device.OTHER;
        long lastLook;
        boolean live;
    }

    /** What deskd has set on one tab's session. A new session starts with nothing, as Chromium gives it. */
    private static final class TabState {
        Shown applied;
        /** Bumped on each main frame commit: the focus watch is in one document only. */
        long document;
        long armedDocument = -1;
    }

    private record Step(Phone target, boolean flip) {}

    private final BrowserTabs tabs;
    private final Supplier<Set<String>> liveSessions;
    private final BrowserFreeze freeze;
    private final EventHub hub;
    private final BooleanSupplier seen;
    private volatile Timing timing;

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition moved = lock.newCondition();
    private final ReentrantLock publishing = new ReentrantLock();
    private final ReentrantLock pinching = new ReentrantLock();
    private final Map<String, Viewer> viewers = new HashMap<>();
    private final Map<String, TabState> tabStates = new HashMap<>();
    private Phone wanted;
    private long wantedSince;
    /** What the last flip that worked was for: null for the desk's own view, which is also where every deskd starts. */
    private Phone shownTarget;
    private Shown shown;
    private long lastFlip;
    private long failedAt;
    private boolean failed;
    /** Work that waits for someone to look, as Chromium is frozen and nothing is worth a thaw. */
    private boolean deferred;
    /** The simplified view is in use: no phone's view, and the way back to the desk's own doesn't wait. */
    private boolean simplifiedInUse;
    /** The sessions that wanted live when last asked, for a change that mustn't ask the stream. */
    private Set<String> lastLive = Set.of();
    private boolean reconcileDue;
    private boolean closed;
    private Field field;
    /** The window's size as last read with the desk's own view, for a client's coordinates then. */
    private int[] screen;
    private Thread worker;
    private Map<String, Object> lastPublished;

    /**
     * @param liveSessions the sessions that want {@code live}. Takes the stream's lock, so it's never asked under this one
     * @param seen somebody looks at the desk ({@link DeskAttention#seen}). Must not block
     */
    BrowserView(
            BrowserTabs tabs,
            Supplier<Set<String>> liveSessions,
            BrowserFreeze freeze,
            EventHub hub,
            BooleanSupplier seen,
            Timing timing) {
        this.tabs = tabs;
        this.liveSessions = liveSessions;
        this.freeze = freeze;
        this.hub = hub;
        this.seen = seen;
        this.timing = timing;
        long now = System.nanoTime();
        this.lastFlip = now - timing.minGap().toNanos() - 1;
        this.wantedSince = now;
    }

    void register(RpcDispatcher dispatcher) {
        // A pinch zooms again if it's sent again, so it's a mutation, as the Browser's other drivers are.
        dispatcher.registerMutation(PINCH, BrowserMethods.working(freeze, this::pinch));
        dispatcher.register(FIELD_AT, BrowserMethods.working(freeze, this::fieldAt));
        hub.topics().register(TOPIC, this);
        tabs.listenForView(this);
    }

    void start() {
        lock.lock();
        try {
            if (worker == null && !closed) {
                worker = Thread.ofVirtual().name("browser-view").start(this::work);
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
    }

    /** For tests: shorter waits from now on. */
    void timing(Timing timing) {
        lock.lock();
        try {
            this.timing = timing;
            long now = System.nanoTime();
            lastFlip = now - timing.minGap().toNanos() - 1;
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    // ---- who looks, from what

    /** What a session said with desk.attention.set. Outside every lock of DeskAttention's. */
    void said(String sessionId, boolean looking, Device device) {
        Set<String> live = liveSessions.get();
        lock.lock();
        try {
            Viewer viewer = viewers.computeIfAbsent(sessionId, id -> new Viewer());
            boolean looksAnew = looking && (!Boolean.TRUE.equals(viewer.seen) || !viewer.device.equals(device));
            viewer.seen = looking;
            viewer.device = device;
            if (looksAnew) {
                viewer.lastLook = System.nanoTime();
            }
            recomputeLocked(live);
        } finally {
            lock.unlock();
        }
    }

    /** desk-rtc put this session's input on the screen, after a second with none. */
    void input(String sessionId) {
        Set<String> live = liveSessions.get();
        lock.lock();
        try {
            viewers.computeIfAbsent(sessionId, id -> new Viewer()).lastLook = System.nanoTime();
            recomputeLocked(live);
        } finally {
            lock.unlock();
        }
    }

    void sessionEnded(String sessionId) {
        Set<String> live = liveSessions.get();
        lock.lock();
        try {
            viewers.remove(sessionId);
            recomputeLocked(live);
        } finally {
            lock.unlock();
        }
    }

    /**
     * The simplified view has become in use, or stopped ({@code MinifiedModule#followBrowserTime}). Called under that
     * module's use lock, so the stream isn't asked: the sessions that wanted live last time stand.
     */
    void simplified(boolean inUse) {
        lock.lock();
        try {
            simplifiedInUse = inUse;
            recomputeLocked(lastLive);
        } finally {
            lock.unlock();
        }
    }

    /** What sessions want of the stream, or whether anyone looks, may have changed. Returns quickly. */
    void recompute() {
        Set<String> live = liveSessions.get();
        lock.lock();
        try {
            recomputeLocked(live);
        } finally {
            lock.unlock();
        }
    }

    private void recomputeLocked(Set<String> live) {
        lastLive = live;
        long now = System.nanoTime();
        for (String id : live) {
            Viewer viewer = viewers.computeIfAbsent(id, key -> new Viewer());
            if (!viewer.live) {
                viewer.live = true;
                viewer.lastLook = now;
            }
        }
        String newestId = null;
        Viewer newest = null;
        for (Map.Entry<String, Viewer> entry : viewers.entrySet()) {
            Viewer viewer = entry.getValue();
            if (!live.contains(entry.getKey())) {
                viewer.live = false;
                continue;
            }
            if (Boolean.FALSE.equals(viewer.seen)) {
                continue;
            }
            if (newest == null || viewer.lastLook - newest.lastLook > 0) {
                newest = viewer;
                newestId = entry.getKey();
            }
        }
        Phone want = !simplifiedInUse && newest != null && newest.device.phone()
                ? new Phone(newestId, newest.device.width(), newest.device.height())
                : null;
        if (!Objects.equals(want, wanted)) {
            wanted = want;
            wantedSince = now;
            failed = false;
            moved.signalAll();
        }
        if (deferred) {
            deferred = false;
            reconcileDue = true;
            moved.signalAll();
        }
    }

    // ---- what the Browser tells

    /** Looked at whatever the view: a tab that comes during a flip, after its list was taken, gets it once the flip is done. */
    @Override
    public void onAttached(String tabId, String sessionId) {
        lock.lock();
        try {
            tabStates.put(sessionId, new TabState());
            reconcileDue = true;
            moved.signalAll();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onMainFrameCommitted(String tabId, String sessionId) {
        boolean fieldGone = false;
        lock.lock();
        try {
            TabState state = tabStates.get(sessionId);
            if (state != null) {
                state.document++;
            }
            if (field != null && field.tabId().equals(tabId)) {
                field = null;
                fieldGone = true;
            }
            reconcileDue = true;
            moved.signalAll();
        } finally {
            lock.unlock();
        }
        if (fieldGone) {
            publish();
        }
    }

    /** What the focus watch says, from the page's side: read as untrusted, kept to fixed words and four numbers. */
    @Override
    public void onBinding(String tabId, String sessionId, Map<String, Object> params) {
        if (!ViewScripts.BINDING.equals(Json.string(params, "name"))) {
            return;
        }
        String payload = Json.string(params, "payload");
        if (payload == null || payload.length() > MAX_REPORT_CHARS) {
            return;
        }
        Map<String, Object> report;
        try {
            report = Json.parseObject(payload.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            return;
        }
        boolean visible = report.get("v") instanceof Number v && v.intValue() == 1;
        Map<String, Object> focused = Json.object(report, "f");
        boolean changed;
        lock.lock();
        try {
            // By the tab's own view, not the desk's: the watch's first word can come before the flip it's part of is done.
            TabState state = tabStates.get(sessionId);
            if (state == null || state.applied == null) {
                return;
            }
            Field before = field;
            if (visible) {
                field = focused == null ? null : fieldFrom(tabId, focused, state.applied);
            } else if (field != null && field.tabId().equals(tabId)) {
                field = null;
            }
            changed = !Objects.equals(before, field);
        } finally {
            lock.unlock();
        }
        if (changed) {
            publish();
        }
    }

    @Override
    public void onDisconnected() {
        boolean fieldGone;
        lock.lock();
        try {
            // Chromium has dropped what was set on every session. The tabs that come back get the view again.
            tabStates.clear();
            screen = null;
            fieldGone = field != null;
            field = null;
        } finally {
            lock.unlock();
        }
        if (fieldGone) {
            publish();
        }
    }

    /** With the lock held. Null for anything that isn't a field in deskd's words, or a box that isn't four numbers. */
    private static Field fieldFrom(String tabId, Map<String, Object> focused, Shown view) {
        String kind = Json.string(focused, "k");
        Object enter = focused.get("e");
        if (kind == null || !KINDS.contains(kind) || (enter != null && !(enter instanceof String hint && ENTER_KEYS.contains(hint)))) {
            return null;
        }
        if (!(focused.get("b") instanceof List<?> box) || box.size() != 4) {
            return null;
        }
        double[] at = new double[4];
        for (int i = 0; i < 4; i++) {
            if (!(box.get(i) instanceof Number n) || !Double.isFinite(n.doubleValue())) {
                return null;
            }
            at[i] = n.doubleValue() * view.scale();
        }
        return new Field(
                tabId,
                kind,
                (String) enter,
                normalized(at[0], view.screenWidth()),
                normalized(at[1], view.screenHeight()),
                normalized(at[2], view.screenWidth()),
                normalized(at[3], view.screenHeight()));
    }

    private static int normalized(double pixels, int side) {
        if (side <= 0) {
            return 0;
        }
        return (int) Math.max(0, Math.min(NORMALIZED, Math.round(NORMALIZED * pixels / side)));
    }

    // ---- the worker

    private void work() {
        while (true) {
            Step step;
            lock.lock();
            try {
                step = nextStep();
            } catch (InterruptedException e) {
                return;
            } finally {
                lock.unlock();
            }
            if (step == null) {
                return;
            }
            try {
                run(step);
            } catch (InterruptedException e) {
                return;
            } catch (RuntimeException e) {
                log.warn("the phone view couldn't be set", e);
            }
        }
    }

    /** With the lock held: waits for the next thing to do, or null once closed. */
    private Step nextStep() throws InterruptedException {
        while (!closed) {
            long now = System.nanoTime();
            Timing t = timing;
            if (!deferred && !Objects.equals(wanted, shownTarget)) {
                long due = wantedSince + t.settle().toNanos();
                if ((wanted == null) != (shownTarget == null)) {
                    due = later(due, lastFlip + t.minGap().toNanos());
                }
                if (wanted == null && simplifiedInUse) {
                    // The simplified view's first click can't wait out a gap.
                    due = now;
                }
                if (failed) {
                    due = later(due, failedAt + t.retry().toNanos());
                }
                long left = due - now;
                if (left > 0) {
                    moved.awaitNanos(left);
                    continue;
                }
                return new Step(wanted, true);
            }
            if (!deferred && reconcileDue) {
                reconcileDue = false;
                return new Step(shownTarget, false);
            }
            moved.await();
        }
        return null;
    }

    private static long later(long a, long b) {
        return a - b >= 0 ? a : b;
    }

    private void run(Step step) throws InterruptedException {
        // A frozen Chromium nobody looks at isn't thawed for this: whoever looks next brings it.
        if (!seen.getAsBoolean() && !freeze.cdpAllowed()) {
            lock.lock();
            try {
                deferred = true;
            } finally {
                lock.unlock();
            }
            return;
        }
        Shown result;
        boolean worked;
        try (BrowserFreeze.Use use = freeze.use()) {
            if (step.flip() && step.target() != null) {
                // A connection that's just come up knows its tabs, and which is on screen, once it has read them.
                tabs.viewReady(timing.request());
            }
            List<BrowserTabs.ViewTab> list = tabs.viewTabs();
            Shown target;
            if (step.flip()) {
                target = step.target() == null ? null : measure(step.target(), list);
                worked = step.target() == null || target != null;
            } else {
                lock.lock();
                try {
                    target = shown;
                } finally {
                    lock.unlock();
                }
                worked = true;
            }
            result = target;
            if (worked) {
                forgetGone(list);
                for (BrowserTabs.ViewTab tab : list) {
                    applyTo(tab, target, step.flip() && tab.onScreen(), step.flip());
                }
            }
        }
        if (!step.flip()) {
            return;
        }
        lock.lock();
        try {
            if (worked) {
                shownTarget = step.target();
                shown = result;
                lastFlip = System.nanoTime();
                failed = false;
                if (result == null) {
                    field = null;
                }
            } else {
                failed = true;
                failedAt = System.nanoTime();
            }
        } finally {
            lock.unlock();
        }
        if (worked) {
            log.info("browser view {}", result == null ? "desk" : "phone " + result.width() + "x" + result.height() + " at " + result.scale());
            publish();
        }
    }

    /** The phone's view on this window, or null if the window's size can't be read now. */
    private Shown measure(Phone phone, List<BrowserTabs.ViewTab> list) throws InterruptedException {
        if (list.isEmpty()) {
            return null;
        }
        int[] size;
        try {
            size = tabs.windowSize(list.get(0), timing.request());
        } catch (CdpException e) {
            log.debug("couldn't read the window's size: {}", e.kind());
            return null;
        }
        if (size == null || size[0] <= 0 || size[1] <= 0) {
            return null;
        }
        double fit = Math.min((double) size[0] / phone.width(), (double) size[1] / phone.height());
        double scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(fit * 100) / 100));
        return new Shown(phone.sessionId(), phone.width(), phone.height(), scale, size[0], size[1]);
    }

    private void forgetGone(List<BrowserTabs.ViewTab> list) {
        Set<String> sessions = new HashSet<>();
        for (BrowserTabs.ViewTab tab : list) {
            sessions.add(tab.sessionId());
        }
        lock.lock();
        try {
            tabStates.keySet().retainAll(sessions);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Brings one tab to {@code target}, the desk's own view if null. A tab that fails is left for the next look.
     *
     * @param keepPlace keep the tab's scroll across the change: the tab on screen, on a flip
     * @param flip a flip arms the focus watch again, so it says at once what's focused now
     */
    private void applyTo(BrowserTabs.ViewTab tab, Shown target, boolean keepPlace, boolean flip) throws InterruptedException {
        boolean emulate;
        boolean arm;
        long document;
        TabState state;
        lock.lock();
        try {
            state = tabStates.computeIfAbsent(tab.sessionId(), id -> new TabState());
            Shown applied = state.applied;
            emulate = target == null ? applied != null : !target.sameEmulation(applied);
            arm = target != null && (flip || state.armedDocument != state.document);
            document = state.document;
        } finally {
            lock.unlock();
        }
        Duration wait = timing.request();
        try {
            if (emulate) {
                Number world = keepPlace ? world(tab, wait) : null;
                if (world != null) {
                    call(tab, world, ViewScripts.SAVE, List.of(), false, wait);
                }
                emulate(tab, target, wait);
                lock.lock();
                try {
                    state.applied = target;
                } finally {
                    lock.unlock();
                }
                if (world != null) {
                    Object kept = call(tab, world, ViewScripts.RESTORE, List.of(), true, wait);
                    log.debug("the tab on screen kept its place: {}", kept);
                }
            }
            if (arm) {
                Number world = world(tab, wait);
                if (world != null) {
                    tabs.viewCall(tab, "Runtime.addBinding", Map.of("name", ViewScripts.BINDING, "executionContextId", world), wait);
                    call(tab, world, ViewScripts.ARM, List.of(), false, wait);
                    lock.lock();
                    try {
                        state.armedDocument = document;
                    } finally {
                        lock.unlock();
                    }
                }
            }
        } catch (CdpException e) {
            log.debug("a tab didn't take the view: {}", e.kind());
        }
    }

    private void emulate(BrowserTabs.ViewTab tab, Shown target, Duration wait) throws CdpException, InterruptedException {
        if (target == null) {
            tabs.viewCall(tab, "Emulation.setEmitTouchEventsForMouse", Map.of("enabled", false), wait);
            tabs.viewCall(tab, "Emulation.setTouchEmulationEnabled", Map.of("enabled", false), wait);
            tabs.viewCall(tab, "Emulation.clearDeviceMetricsOverride", Map.of(), wait);
            return;
        }
        boolean portrait = target.height() >= target.width();
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("width", target.width());
        metrics.put("height", target.height());
        metrics.put("deviceScaleFactor", target.scale());
        metrics.put("mobile", true);
        metrics.put("scale", target.scale());
        metrics.put("screenWidth", target.width());
        metrics.put("screenHeight", target.height());
        metrics.put("positionX", 0);
        metrics.put("positionY", 0);
        metrics.put("screenOrientation", Map.of("type", portrait ? "portraitPrimary" : "landscapePrimary", "angle", portrait ? 0 : 90));
        tabs.viewCall(tab, "Emulation.setDeviceMetricsOverride", metrics, wait);
        tabs.viewCall(tab, "Emulation.setTouchEmulationEnabled", Map.of("enabled", true, "maxTouchPoints", TOUCH_POINTS), wait);
        tabs.viewCall(tab, "Emulation.setEmitTouchEventsForMouse", Map.of("enabled", true, "configuration", "mobile"), wait);
    }

    /** deskd's world in the tab's main frame now, or null if Chromium doesn't give one. */
    private Number world(BrowserTabs.ViewTab tab, Duration wait) throws CdpException, InterruptedException {
        Map<String, Object> made = tabs.viewCall(
                tab, "Page.createIsolatedWorld", Map.of("frameId", tab.mainFrameId(), "worldName", ViewScripts.WORLD), wait);
        return made.get("executionContextId") instanceof Number id ? id : null;
    }

    /** One of {@link ViewScripts}' constants in that world, with numbers for arguments. Returns its value. */
    private Object call(BrowserTabs.ViewTab tab, Number world, String function, List<Object> args, boolean awaitPromise, Duration wait)
            throws CdpException, InterruptedException {
        Map<String, Object> reply = tabs.viewCall(tab, "Runtime.callFunctionOn", callParams(world, function, args, awaitPromise), wait);
        Map<String, Object> result = Json.object(reply, "result");
        return result == null ? null : result.get("value");
    }

    private static Map<String, Object> callParams(Number world, String function, List<Object> args, boolean awaitPromise) {
        List<Map<String, Object>> arguments = new ArrayList<>(args.size());
        for (Object arg : args) {
            arguments.add(Map.of("value", arg));
        }
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("functionDeclaration", function);
        params.put("executionContextId", world);
        params.put("arguments", arguments);
        params.put("returnByValue", true);
        params.put("awaitPromise", awaitPromise);
        return params;
    }

    // ---- a client's calls

    private Object pinch(RpcContext context, Map<String, Object> params) throws Exception {
        if (!context.principal().input()) {
            throw BrowserMethods.forbidden();
        }
        int x = coordinate(params, "x");
        int y = coordinate(params, "y");
        if (!(params.get("scale") instanceof Number number)
                || !Double.isFinite(number.doubleValue())
                || number.doubleValue() < MIN_PINCH
                || number.doubleValue() > MAX_PINCH) {
            throw new RpcException(RpcException.BAD_REQUEST, "scale must be from 0.25 to 4", Map.of("reason", "scale"));
        }
        double scale = number.doubleValue();
        BrowserTabs.ViewTab tab = tabs.viewOnScreen();
        double[] at = inView(tab, x, y);
        Object zoom = clientCall(null, tab, ViewScripts.PAGE_SCALE, List.of(), false);
        double pageScale = zoom instanceof Number z && z.doubleValue() > 0 ? z.doubleValue() : 1;
        Map<String, Object> gesture = new LinkedHashMap<>();
        gesture.put("x", round2(at[0] / pageScale));
        gesture.put("y", round2(at[1] / pageScale));
        gesture.put("scaleFactor", scale);
        // A touchpad's pinch, at Chromium's own speed. A touch source never zoomed, in either view, and a faster pinch
        // didn't either (Chrome for Testing 158): this zoomed to the scale asked, around the point, every time.
        gesture.put("gestureSourceType", "mouse");
        // One at a time: a second would start from wherever the first's fingers are.
        pinching.lockInterruptibly();
        try {
            tabs.viewClientCall(context, tab, "Input.synthesizePinchGesture", gesture, PINCH_WAIT);
        } finally {
            pinching.unlock();
        }
        return Map.of();
    }

    private Object fieldAt(RpcContext context, Map<String, Object> params) throws Exception {
        if (!context.principal().video()) {
            throw BrowserMethods.forbidden();
        }
        int x = coordinate(params, "x");
        int y = coordinate(params, "y");
        BrowserTabs.ViewTab tab = tabs.viewKnownOnScreen();
        double[] at = inView(tab, x, y);
        Object found = clientCall(null, tab, ViewScripts.AT, List.of(round2(at[0]), round2(at[1])), false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("field", null);
        if (found instanceof Map<?, ?> map && map.get("k") instanceof String kind && KINDS.contains(kind)) {
            Object enter = map.get("e");
            Map<String, Object> described = new LinkedHashMap<>();
            described.put("kind", kind);
            described.put("enterKey", enter instanceof String hint && ENTER_KEYS.contains(hint) ? hint : null);
            out.put("field", described);
        }
        return out;
    }

    /** A script on the tab on screen, failing as the Browser's own calls do. */
    private Object clientCall(RpcContext context, BrowserTabs.ViewTab tab, String function, List<Object> args, boolean awaitPromise)
            throws RpcException, InterruptedException {
        Map<String, Object> made = tabs.viewClientCall(
                null, tab, "Page.createIsolatedWorld", Map.of("frameId", tab.mainFrameId(), "worldName", ViewScripts.WORLD), timing.request());
        if (!(made.get("executionContextId") instanceof Number world)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The browser isn't reachable", Map.of("reason", "chromium"));
        }
        Map<String, Object> reply = tabs.viewClientCall(context, tab, "Runtime.callFunctionOn", callParams(world, function, args, awaitPromise), timing.request());
        Map<String, Object> result = Json.object(reply, "result");
        return result == null ? null : result.get("value");
    }

    /** A client's normalized point, as the view's own pixels in this tab: its CSS pixels at the page's zoom of 1. */
    private double[] inView(BrowserTabs.ViewTab tab, int x, int y) throws RpcException, InterruptedException {
        Shown applied;
        int[] size;
        lock.lock();
        try {
            TabState state = tabStates.get(tab.sessionId());
            applied = state == null ? null : state.applied;
            size = screen;
        } finally {
            lock.unlock();
        }
        if (applied != null) {
            return new double[] {
                (double) x / NORMALIZED * applied.screenWidth() / applied.scale(),
                (double) y / NORMALIZED * applied.screenHeight() / applied.scale()
            };
        }
        if (size == null) {
            try {
                size = tabs.windowSize(tab, timing.request());
            } catch (CdpException e) {
                size = null;
            }
            if (size == null || size[0] <= 0 || size[1] <= 0) {
                throw new RpcException(RpcException.UNAVAILABLE, "The browser isn't reachable", Map.of("reason", "chromium"));
            }
            lock.lock();
            try {
                screen = size;
            } finally {
                lock.unlock();
            }
        }
        return new double[] {(double) x / NORMALIZED * size[0], (double) y / NORMALIZED * size[1]};
    }

    private static int coordinate(Map<String, Object> params, String name) throws RpcException {
        if (!(params.get(name) instanceof Number number)
                || number.doubleValue() != Math.rint(number.doubleValue())
                || number.doubleValue() < 0
                || number.doubleValue() > NORMALIZED) {
            throw new RpcException(RpcException.BAD_REQUEST, name + " must be a whole number from 0 to 65535", Map.of("reason", name));
        }
        return number.intValue();
    }

    private static double round2(double value) {
        return Math.round(value * 100) / 100.0;
    }

    // ---- the topic

    /** Sends {@value #TOPIC} if what it says has changed. On whatever thread changed it, outside the lock. */
    private void publish() {
        publishing.lock();
        try {
            Map<String, Object> now = state();
            if (now.equals(lastPublished)) {
                return;
            }
            lastPublished = now;
            hub.publish(TOPIC, "snapshot", now);
        } finally {
            publishing.unlock();
        }
    }

    /** The topic's snapshot: API.md section 10, "On a phone". */
    Map<String, Object> state() {
        Shown view;
        Field focused;
        lock.lock();
        try {
            view = shown;
            focused = field;
        } finally {
            lock.unlock();
        }
        Map<String, Object> state = new LinkedHashMap<>();
        if (view == null) {
            state.put("mode", "desktop");
            state.put("field", null);
            return state;
        }
        state.put("mode", "phone");
        state.put("sessionId", view.sessionId());
        state.put("width", view.width());
        state.put("height", view.height());
        state.put("scale", view.scale());
        state.put("region", Map.of("x", 0, "y", 0, "width", view.regionWidth(), "height", view.regionHeight()));
        state.put("screen", Map.of("width", view.screenWidth(), "height", view.screenHeight()));
        if (focused == null) {
            state.put("field", null);
        } else {
            Map<String, Object> described = new LinkedHashMap<>();
            described.put("tabId", focused.tabId());
            described.put("kind", focused.kind());
            described.put("enterKey", focused.enterKey());
            described.put("box", Map.of("x", focused.x(), "y", focused.y(), "width", focused.width(), "height", focused.height()));
            state.put("field", described);
        }
        return state;
    }

    /** What /health says: which view the tabs have, and nothing of whose. */
    String health() {
        lock.lock();
        try {
            return shown == null ? "desktop" : "phone";
        } finally {
            lock.unlock();
        }
    }

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        return state();
    }

    /** What's focused says what's on the page, so it follows what lets a session see the screen. */
    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!principal.video()) {
            throw BrowserMethods.forbidden();
        }
    }
}
