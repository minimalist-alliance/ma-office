package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rpc.TokenBucket;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The simplified browsing view's desk side (task 47, Stage A; design section 7; API.md section 14; ADR 0046): the
 * walker that runs the distiller in deskd's isolated world, the MDoc it makes, the {@code browser.minified:<tabId>}
 * topic, the action proxy ({@link ActionProxy}), per-site memory ({@link SiteMemory}) and islands' boxes.
 *
 * <p><b>What it costs while nobody uses it.</b> Nothing: no thread, no timer and no script in any page until a client
 * asks for a tab's view. A tab is watched for changes only while a session is subscribed to its topic, with one parked
 * call into the page that the page's next change answers, never a poll.
 *
 * <p><b>Where page content goes.</b> Only to the sessions that asked, and nowhere else: never logged, never to the
 * heartbeat or Platform, never to disk. A tab's MDoc is in memory only, for at most {@value #KEPT_DOCS} tabs at once,
 * and goes with the tab or the connection to Chromium (Security T47-9).
 *
 * <p><b>Locks.</b> {@code lock} guards the model and is held for model work only, never across a call to Chromium or a
 * publish. Each tab's {@code work} lock orders its snapshots and actions, and is held across calls to Chromium by design:
 * nothing on the read path takes it.
 */
public final class MinifiedModule implements TabEvents, Topic {

    private static final Logger log = LoggerFactory.getLogger(MinifiedModule.class);

    public static final String TOPIC = "browser.minified:";
    /** Tabs whose last MDoc is kept for patches and actions. The rest get a fresh snapshot when next asked. */
    static final int KEPT_DOCS = 3;
    static final int MAX_TABS = 256;
    static final int MAX_FRAME_SESSIONS = 512;
    static final int MAX_FRAMES_PER_TAB = PageWorld.MAX_FRAMES;
    /** Snapshots at once, desk-wide: each holds up to a few MB while it's built. */
    static final int SNAPSHOTS_AT_ONCE = 2;
    /** The distiller's own block limit, and what its text may come to. */
    static final int DISTILLER_BLOCKS = 6000;
    static final int MAX_RAW_CHARS = 1_000_000;
    static final int MAX_MEDIA = 200;
    /** What deskd's half may answer with, in JSON characters, under the 2 MB deskd reads from Chromium in one message. */
    static final int MAX_REPLY_CHARS = 1_800_000;
    static final int MAX_ELEMENTS = 200_000;
    private static final Pattern TAB_ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");

    /**
     * @param request what one command into a page gets
     * @param snapshot what a whole snapshot gets before the tab falls back with {@code timeout} (design 7.4: 1.5 s)
     * @param changeWait how long one parked wait for a change lasts
     * @param debounce how long after a change a snapshot waits, so a burst is one
     * @param minGap the least time between two snapshots of a tab, which also stays above three times the last one's
     *     length, so a heavy page can't take more than a quarter of a core
     * @param guard how long an armed guard lasts if deskd never says it's done: longer than a whole action may take, and
     *     an action refuses to press once its arm is a third of this old
     */
    public record Timing(Duration request, Duration snapshot, Duration changeWait, Duration debounce, Duration minGap, Duration guard) {
        public static final Timing DEFAULT = new Timing(
                Duration.ofSeconds(5), Duration.ofMillis(1500), Duration.ofSeconds(20), Duration.ofMillis(24),
                Duration.ofMillis(100), Duration.ofSeconds(30));
    }

    /** One tab's state. Fields are under the module's {@code lock}, but {@code work}. */
    static final class TabState {
        final String id;
        final ReentrantLock work = new ReentrantLock(true);
        String injectedSession;
        /** A leave waits for the tab to go unused, and only one at a time. */
        boolean leaving;
        /** The watcher is waiting in the page for its next change, and only a {@code wake} op ends that early. */
        boolean parked;
        /** The last action's tail, its frames' disarm after the reply (B8): the next action waits for it. */
        java.util.concurrent.CompletableFuture<Void> settling;
        /** Actions waiting for the tab's work: a re-distill that hasn't started lets them go first (B8). */
        int actionsWaiting;
        long generation;
        MDoc doc;
        long rev;
        Map<String, Object> status;
        Fallback fallback;
        Fallback cause;
        /** Actions between their arming of the tab's frames and their disarming, and the frames held meanwhile (T47D-1). */
        int acting;
        final List<String> heldFrames = new ArrayList<>();
        /** What the last look's confidence check judged on, for the real-site harness: counts, never page text. */
        Map<String, Object> judged;
        long fallbackGeneration = -1;
        boolean dialog;
        long count;
        boolean dirty = true;
        boolean closed;
        Thread watcher;
        long lastSnapshotNanos;
        long lastSnapshotLength;
        final Map<String, String> imageUrls = new HashMap<>();
        final Map<String, String> imageIds = new HashMap<>();
        final Set<String> sensitiveRefs = new HashSet<>();
        final Map<String, String> islandBoxes = new HashMap<>();
        long islandEpoch;
        long usedNanos;
        final Map<String, Long> latestFill = new HashMap<>();
        int queued;
        TokenBucket actions;
        /** Frame sessions of this tab deskd couldn't record: its actions refuse, as those frames can't be armed (T47-3). */
        boolean framesUnrecorded;
        /** The first rev of the tab's current document: an act naming an older one is from another page. */
        long firstRevOfDocument = 1;
        /** The identifier of deskd's script on the injected session, to take it off when the tab leaves the view. */
        String scriptId;
        /** The document deskd last tried a consent banner's reject on, so it tries once per document. */
        long consentGeneration = -1;
        boolean consentRejected;
        /** The label of the button deskd pressed for the member. */
        String consentLabel;

        TabState(String id) {
            this.id = id;
        }
    }

    final TabAccess access;
    final EventHub hub;
    final SiteMemory memory;
    /** The sites the member turned ad blocking off for, for the image's blocklist (T47S-3, deskd's half). */
    final AdblockOff adblock;
    final HostLists lists;
    final PageWorld world;
    final Timing timing;
    /** The view's runtime switch: off, every method answers {@code unavailable} with {@code reason: disabled}. */
    final MinifiedSwitch flags;
    final ReentrantLock lock = new ReentrantLock();
    /** Signalled when a tab has no action waiting for its work. */
    final Condition actionsGone = lock.newCondition();
    private final Condition wake = lock.newCondition();
    /** Wakes so far, under {@code lock}: a watcher waits for a newer one, so none is lost and none spins. */
    private long wakes;
    /** Passes of every watcher's loop, for tests that a parked watcher stays parked. */
    private final java.util.concurrent.atomic.AtomicLong watchPasses = new java.util.concurrent.atomic.AtomicLong();
    private final Map<String, TabState> tabs = new HashMap<>();
    /** A frame's session that Chromium attached under a tab: whose it is, and its target, which is also its frame's id. */
    record FrameSession(String tabId, String targetId) {}

    private final Map<String, FrameSession> frameSessions = new HashMap<>();
    /** Sites (registrable domains) that showed a sensitive signal since deskd started: sticky for the session (T47-7). */
    private final Set<String> sensitiveHosts = new HashSet<>();
    private final Semaphore snapshots = new Semaphore(SNAPSHOTS_AT_ONCE, true);
    final TokenBucket deskActions = new TokenBucket(ActionProxy.DESK_PER_SECOND, ActionProxy.DESK_PER_SECOND, System::nanoTime);
    private final ActionProxy proxy;
    private volatile boolean closed;

    /** @param dataDirectory the data volume's directory, where per-site memory lives, or null to keep it in memory */
    public MinifiedModule(
            TabAccess access, RpcDispatcher dispatcher, EventHub hub, Path dataDirectory, Clock clock, Timing timing, MinifiedSwitch flags) {
        this.access = access;
        this.hub = hub;
        this.timing = timing;
        this.flags = flags;
        this.memory = new SiteMemory(dataDirectory, clock);
        this.adblock = new AdblockOff(dataDirectory);
        this.lists = HostLists.load();
        this.world = new PageWorld(access, Scripts.load());
        this.proxy = new ActionProxy(this);
        access.listen(this, this::wanted);
        new MinifiedMethods(this, proxy).register(dispatcher);
        hub.topics().register(TOPIC, this);
    }

    public void close() {
        closed = true;
        List<Thread> watchers = new ArrayList<>();
        lock.lock();
        try {
            for (TabState state : tabs.values()) {
                if (state.watcher != null) {
                    watchers.add(state.watcher);
                }
            }
            signalWake();
        } finally {
            lock.unlock();
        }
        watchers.forEach(Thread::interrupt);
    }

    /**
     * Whether a path that would hand this tab's content to a model may (T47-7): default deny, and allowed only for a tab
     * on a site that's on no sensitive list, wasn't marked by the member, and showed no sensitive signal this session.
     * Nothing calls this yet: the agent's browser tools are to.
     */
    public boolean mayShareWithModel(String tabId) {
        lock.lock();
        try {
            TabState state = tabs.get(tabId);
            if (state == null || state.doc == null || state.doc.sensitive || state.fallback != null) {
                return false;
            }
            String host = SiteMemory.hostOf(state.doc.url);
            // SiteMemory's lock is a leaf, so it's safe to take under this one.
            return host != null && flags.on() && !sensitiveHosts.contains(SiteMemory.registrable(host)) && !HostLists.on(lists.sensitive, host)
                    && !memory.get(host).sensitive();
        } finally {
            lock.unlock();
        }
    }

    /** For tests and /health: counts, never content. */
    public Map<String, Object> health() {
        lock.lock();
        try {
            int watched = 0;
            int kept = 0;
            for (TabState state : tabs.values()) {
                watched += state.watcher != null ? 1 : 0;
                kept += state.doc != null ? 1 : 0;
            }
            return Map.of("tabs", tabs.size(), "watched", watched, "kept", kept, "frames", frameSessions.size());
        } finally {
            lock.unlock();
        }
    }

    // ---- what the Browser tells

    private boolean wanted() {
        lock.lock();
        try {
            for (TabState state : tabs.values()) {
                if (state.watcher != null) {
                    return true;
                }
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onEvent(String method, String sessionId, String tabId, Map<String, Object> params) {
        switch (method) {
            case "Target.attachedToTarget" -> onAttached(sessionId, tabId, params);
            case "Target.detachedFromTarget" -> {
                lock.lock();
                try {
                    frameSessions.remove(Json.string(params, "sessionId"));
                } finally {
                    lock.unlock();
                }
            }
            case "Page.frameNavigated" -> {
                Map<String, Object> frame = Json.object(params, "frame");
                if (tabId != null && frame != null && frame.get("parentId") == null) {
                    newDocument(tabId);
                }
            }
            case "Page.javascriptDialogOpening", "Page.javascriptDialogClosed" -> {
                if (tabId != null) {
                    dialog(tabId, method.endsWith("Opening"));
                }
            }
            default -> {
                // Everything else Page.enable sends is the Browser's.
            }
        }
    }

    /**
     * A frame in a process of its own, attached because deskd asked. Chromium holds it until it's let go, so that's
     * done on a thread of its own at once, whatever the frame is (T47-3).
     */
    private void onAttached(String parentSession, String tabId, Map<String, Object> params) {
        String child = Json.string(params, "sessionId");
        Map<String, Object> info = Json.object(params, "targetInfo");
        boolean waiting = Boolean.TRUE.equals(params.get("waitingForDebugger"));
        if (child == null || !TAB_ID.matcher(child).matches()) {
            return;
        }
        boolean frame = info != null && "iframe".equals(Json.string(info, "type"));
        // Switched off since the tab was set up: the frame runs free with nothing of deskd's in it, and the tab leaves.
        boolean on = flags.on();
        TabState leaving = null;
        String owner;
        lock.lock();
        try {
            FrameSession parent = frameSessions.get(parentSession);
            owner = tabId != null ? tabId : parent == null ? null : parent.tabId();
            String targetId = info == null ? null : Json.string(info, "targetId");
            TabState ownerState = owner == null ? null : tabs.get(owner);
            if (!on) {
                leaving = ownerState;
            } else if (frame && owner != null && (frameSessions.size() >= MAX_FRAME_SESSIONS || frameCount(owner) >= MAX_FRAMES_PER_TAB
                    || targetId == null || !TAB_ID.matcher(targetId).matches())) {
                // A frame deskd can't keep track of can't be armed, so the tab's actions refuse from here (T47-3).
                if (ownerState != null) {
                    ownerState.framesUnrecorded = true;
                }
            } else if (frame && owner != null) {
                frameSessions.put(child, new FrameSession(owner, targetId));
                String host = SiteMemory.hostOf(Text.clean(Json.string(info, "url"), MDocBuilder.MAX_URL_CHARS));
                TabState state = tabs.get(owner);
                if (host != null && HostLists.on(lists.payment, host) && ownerState != null && ownerState.doc != null) {
                    String tabHost = SiteMemory.hostOf(ownerState.doc.url);
                    if (tabHost != null) {
                        sensitiveHosts.add(SiteMemory.registrable(tabHost));
                    }
                }
            }
        } finally {
            lock.unlock();
        }
        if (leaving != null) {
            leave(leaving, false);
        }
        if (!(frame && on) && !waiting) {
            // Nothing to put in it and nothing to let go: no thread at all, as when the view is off (fully inert).
            return;
        }
        TabState holder = owner == null ? null : existing(owner);
        Thread.ofVirtual().name("minified-frame-attach").start(() -> {
            try {
                if (frame && on) {
                    world.guardFrame(child, timing.request());
                    // T47D-1: a frame born while its tab has an action in flight waits for the action to end.
                    if (waiting && !holdWhileActing(holder, child)) {
                        world.release(child, timing.request());
                    }
                } else if (waiting) {
                    access.callSession(child, "Runtime.runIfWaitingForDebugger", Map.of(), timing.request());
                }
            } catch (CdpFailure e) {
                log.debug("couldn't let a target run: {}", e.kind());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    /** With the lock held. */
    private int frameCount(String tabId) {
        int count = 0;
        for (FrameSession session : frameSessions.values()) {
            count += session.tabId().equals(tabId) ? 1 : 0;
        }
        return count;
    }

    /** The tab's top frame has a new document: what was of the old one goes (images, islands, the fields once sensitive). */
    private void newDocument(String tabId) {
        lock.lock();
        try {
            TabState state = tabs.get(tabId);
            if (state == null) {
                return;
            }
            state.generation++;
            state.dirty = true;
            state.dialog = false;
            // The old page's view goes with it, so nothing answers for it once it's gone (T47-7, model gate included).
            dropView(state);
            state.firstRevOfDocument = state.rev + 1;
            state.framesUnrecorded = false;
            state.imageUrls.clear();
            state.imageIds.clear();
            state.sensitiveRefs.clear();
            state.islandBoxes.clear();
            state.latestFill.clear();
            state.consentRejected = false;
            state.consentLabel = null;
            signalWake();
        } finally {
            lock.unlock();
        }
    }

    private void dialog(String tabId, boolean open) {
        lock.lock();
        try {
            TabState state = tabs.get(tabId);
            if (state == null) {
                return;
            }
            state.dialog = open;
            state.dirty = true;
            signalWake();
            if (!open || state.watcher == null) {
                return;
            }
        } finally {
            lock.unlock();
        }
        // The page is held while a dialog is open, so the watcher may be parked on it: the stream is said from here.
        Thread.ofVirtual().name("minified-dialog").start(() -> {
            TabState state = existing(tabId);
            if (state != null) {
                setFallback(state, Fallback.DIALOG, null, false);
            }
        });
    }

    @Override
    public void onTabGone(String tabId) {
        Thread watcher;
        lock.lock();
        try {
            TabState state = tabs.remove(tabId);
            if (state == null) {
                return;
            }
            state.closed = true;
            state.doc = null;
            frameSessions.values().removeIf(session -> session.tabId().equals(tabId));
            watcher = state.watcher;
            signalWake();
        } finally {
            lock.unlock();
        }
        if (watcher != null) {
            watcher.interrupt();
        }
        // The last word to whoever watched it. Off the read path.
        Thread.ofVirtual().name("minified-tab-gone").start(() -> publish(tabId, "snapshot", closedStatus(tabId)));
    }

    @Override
    public void onTabsNow(Set<String> tabIds) {
        List<String> gone = new ArrayList<>();
        lock.lock();
        try {
            for (String tabId : tabs.keySet()) {
                if (!tabIds.contains(tabId)) {
                    gone.add(tabId);
                }
            }
        } finally {
            lock.unlock();
        }
        for (String tabId : gone) {
            onTabGone(tabId);
        }
    }

    @Override
    public void onDisconnected() {
        lock.lock();
        try {
            frameSessions.clear();
            for (TabState state : tabs.values()) {
                dropView(state);
                state.injectedSession = null;
                state.dirty = true;
                state.generation++;
                state.imageUrls.clear();
                state.imageIds.clear();
                state.sensitiveRefs.clear();
                state.islandBoxes.clear();
            }
            signalWake();
        } finally {
            lock.unlock();
        }
    }

    // ---- the topic

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    /** A page's content is what's on screen, so it follows what lets a session see the screen, as browser.tabs does. */
    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!principal.video()) {
            throw MinifiedMethods.forbidden();
        }
        if (!flags.on()) {
            throw MinifiedMethods.disabled();
        }
        if (!TAB_ID.matcher(topicKey.substring(TOPIC.length())).matches()) {
            throw new RpcException(RpcException.BAD_REQUEST, "No such tab id", Map.of("reason", "tabId"));
        }
    }

    /** What the view is now, never the MDoc itself, which can pass an event's 64 KiB: a client gets that with get. */
    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) throws InterruptedException {
        String tabId = topicKey.substring(TOPIC.length());
        // A SUB's first look is work, as browser.tabs' is: Chromium is thawed for it first (ADR 0045).
        try (AutoCloseable use = access.use()) {
            return snapshot(tabId);
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            return Map.of("tabId", tabId, "rev", 0, "view", "pending");
        }
    }

    private Object snapshot(String tabId) throws InterruptedException {
        TabRef tab;
        try {
            // The tab first: a topic key alone never makes state for a tab that isn't there.
            tab = access.resolve(tabId);
        } catch (RpcException e) {
            return RpcException.NOT_FOUND.equals(e.code()) ? closedStatus(tabId) : Map.of("tabId", tabId, "rev", 0, "view", "pending");
        }
        TabState state = state(tab.tabId());
        if (state == null) {
            return closedStatus(tabId);
        }
        startWatcher(state);
        lock.lock();
        try {
            if (state.status != null) {
                return state.status;
            }
        } finally {
            lock.unlock();
        }
        try {
            refresh(tab, state, false, false);
        } catch (RpcException e) {
            if (RpcException.NOT_FOUND.equals(e.code())) {
                return closedStatus(tabId);
            }
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            log.debug("a view's first look failed: {}", e.getClass().getSimpleName());
        }
        lock.lock();
        try {
            return state.status != null ? state.status : pendingStatus(state);
        } finally {
            lock.unlock();
        }
    }

    /** @return whether the frame is held for the tab's action in flight, to be let go when it ends */
    private boolean holdWhileActing(TabState state, String child) {
        if (state == null) {
            return false;
        }
        lock.lock();
        try {
            if (state.acting > 0 && state.heldFrames.size() < 256) {
                state.heldFrames.add(child);
                return true;
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    /** An action on the tab is arming its frames: frames born from now wait for it (T47D-1). */
    /** An action's tail runs on: the tab's next action waits for it, as if the action still held the work lock (B8). */
    void settling(TabState state, java.util.concurrent.CompletableFuture<Void> tail) {
        lock.lock();
        try {
            state.settling = tail;
        } finally {
            lock.unlock();
        }
    }

    /** With the tab's work held, before an action arms anything: the last action's disarm is done (B8). */
    void awaitSettled(TabState state) throws InterruptedException {
        java.util.concurrent.CompletableFuture<Void> tail;
        lock.lock();
        try {
            tail = state.settling;
        } finally {
            lock.unlock();
        }
        if (tail == null) {
            return;
        }
        try {
            tail.get(timing.request().multipliedBy(4).toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException e) {
            // Each frame's guard lets go by itself, and a disarm keyed to another action never touches this one's.
        }
    }

    /** An action is waiting for the tab's work, or has it now. */
    void actionWaiting(TabState state, boolean waiting) {
        lock.lock();
        try {
            state.actionsWaiting = Math.max(0, state.actionsWaiting + (waiting ? 1 : -1));
            if (state.actionsWaiting == 0) {
                actionsGone.signalAll();
            }
        } finally {
            lock.unlock();
        }
    }

    void beginActing(TabState state) {
        lock.lock();
        try {
            state.acting++;
        } finally {
            lock.unlock();
        }
    }

    /** The action has disarmed the tab's frames: those born meanwhile run now. */
    void endActing(TabState state) {
        List<String> release;
        lock.lock();
        try {
            state.acting = Math.max(0, state.acting - 1);
            if (state.acting > 0) {
                return;
            }
            release = new ArrayList<>(state.heldFrames);
            state.heldFrames.clear();
        } finally {
            lock.unlock();
        }
        if (!release.isEmpty()) {
            // On a thread of its own: an interrupted caller mustn't leave a frame waiting for ever.
            Thread.ofVirtual().name("minified-frame-release").start(() -> {
                for (String child : release) {
                    try {
                        world.release(child, timing.request());
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            });
        }
    }

    /**
     * The counts the last look at a tab was judged on, for the real-site harness ({@code real-sites/README.md}): the
     * page's own (form controls, cover by canvas and other sites' frames, status, the wall's kind) and the document's.
     * Never page text, and no RPC reaches it.
     */
    public Map<String, Object> lastJudged(String tabId) {
        lock.lock();
        try {
            TabState state = tabs.get(tabId);
            return state == null || state.judged == null ? Map.of() : state.judged;
        } finally {
            lock.unlock();
        }
    }

    private static Map<String, Object> judged(MDocBuilder.Raw raw, MDoc doc, MDocBuilder.Built built) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : List.of("formControls", "canvasCover", "frameCover", "status", "ready")) {
            if (raw.stats().get(key) != null) {
                out.put(key, raw.stats().get(key));
            }
        }
        if (raw.stats().get("wall") instanceof Map<?, ?> wall && wall.get("kind") != null) {
            out.put("wall", wall.get("kind"));
        }
        out.put("textChars", doc.textChars);
        out.put("controls", doc.controls);
        out.put("docFormControls", doc.formControls);
        out.put("kind", doc.kind);
        out.put("blocks", doc.blocks.size());
        out.put("fallback", built.fallback() == null ? "" : built.fallback().wire());
        return Map.copyOf(out);
    }

    @Override
    public void subscribersChanged() {
        List<Thread> idle = new ArrayList<>();
        lock.lock();
        try {
            for (TabState state : tabs.values()) {
                if (state.watcher != null && !hub.hasSubscribers(TOPIC + state.id)) {
                    idle.add(state.watcher);
                }
            }
        } finally {
            lock.unlock();
        }
        idle.forEach(Thread::interrupt);
    }

    private void startWatcher(TabState state) {
        lock.lock();
        try {
            if (state.watcher == null && !closed && !state.closed) {
                state.watcher = Thread.ofVirtual().name("minified-watch").start(() -> watch(state));
            }
        } finally {
            lock.unlock();
        }
        access.wake();
    }

    /**
     * Keeps a tab's view current while anyone is subscribed: a snapshot, then one parked call that the page's next change
     * answers. A tab showing the stream waits for something to change that, without asking the page anything.
     */
    private void watch(TabState state) {
        try {
            while (!closed && flags.on() && hub.hasSubscribers(TOPIC + state.id)) {
                watchPasses.incrementAndGet();
                long seen = wakes();
                if (access.frozen()) {
                    // A frozen Chromium is never asked anything, and nothing here asks for a thaw (ADR 0045).
                    awaitWake(seen, Duration.ofSeconds(2));
                    continue;
                }
                TabRef tab;
                try {
                    tab = access.resolve(state.id);
                } catch (RpcException e) {
                    if (RpcException.NOT_FOUND.equals(e.code())) {
                        publish(state.id, "snapshot", closedStatus(state.id));
                        return;
                    }
                    pause(Duration.ofSeconds(1));
                    continue;
                }
                boolean simplified;
                try {
                    simplified = refresh(tab, state, false, false);
                    if (!simplified) {
                        leave(state, false);
                    }
                } catch (RpcException e) {
                    pause(Duration.ofSeconds(1));
                    continue;
                }
                if (!simplified) {
                    awaitWake(seen, Duration.ofSeconds(2));
                    continue;
                }
                awaitChange(tab, state);
                pace(state);
            }
        } catch (InterruptedException e) {
            // Nobody's watching any more, or deskd is closing.
        } finally {
            lock.lock();
            try {
                if (state.watcher == Thread.currentThread()) {
                    state.watcher = null;
                }
            } finally {
                lock.unlock();
            }
            if (!closed) {
                leave(state, false);
            }
        }
    }

    /** How long a tab nobody watches keeps deskd's scripts and its frames' attach after its last use. */
    static final Duration LEAVE_AFTER = Duration.ofMinutes(1);

    /**
     * The tab has left the simplified view: Chromium no longer holds its new frames for deskd's guard, and deskd's script
     * is off the session, so the stream is exactly as it was before (review: waitForDebuggerOnStart). Runs on a thread
     * of its own; with {@code later}, only once the tab has gone unused and unwatched for {@link #LEAVE_AFTER}.
     */
    void leave(TabState state, boolean later) {
        // The watcher itself may leave (review 2): a watched tab that went to the stream lets its frames go.
        Thread caller = Thread.currentThread();
        if (later) {
            // One wait per tab, however many gets there are (review 9).
            lock.lock();
            try {
                if (state.leaving) {
                    return;
                }
                state.leaving = true;
            } finally {
                lock.unlock();
            }
        }
        Thread.ofVirtual().name("minified-leave").start(() -> {
            try {
                if (later) {
                    awaitUnused(state);
                }
                // Looked at and done under the tab's work, so no injection can come between the look and the leave
                // (review 6): an act or get ahead of it re-injects, and this then sees the tab in use and stays.
                state.work.lockInterruptibly();
                try {
                    String session;
                    String scriptId;
                    lock.lock();
                    try {
                        boolean recent = System.nanoTime() - state.usedNanos < LEAVE_AFTER.toNanos();
                        if (state.injectedSession == null || state.watcher != null && state.watcher != caller || (later && recent) || state.closed) {
                            return;
                        }
                        session = state.injectedSession;
                        scriptId = state.scriptId;
                        state.injectedSession = null;
                        state.scriptId = null;
                    } finally {
                        lock.unlock();
                    }
                    TabRef tab = access.resolve(state.id);
                    if (!tab.sessionId().equals(session)) {
                        return;
                    }
                    world.leave(tab, scriptId, timing.request());
                } finally {
                    state.work.unlock();
                }
            } catch (RpcException | CdpFailure e) {
                // A session that's gone took both with it.
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    /** Sleeps until the tab has gone unused for {@link #LEAVE_AFTER}, its uses meanwhile pushing that back. */
    private void awaitUnused(TabState state) throws InterruptedException {
        try {
            while (true) {
                long left;
                lock.lock();
                try {
                    left = LEAVE_AFTER.toNanos() - (System.nanoTime() - state.usedNanos);
                    if (left <= 0 || state.closed) {
                        return;
                    }
                } finally {
                    lock.unlock();
                }
                Thread.sleep(Duration.ofNanos(left));
            }
        } finally {
            lock.lock();
            try {
                state.leaving = false;
            } finally {
                lock.unlock();
            }
        }
    }

    private void awaitChange(TabRef tab, TabState state) throws InterruptedException {
        long since;
        long generation;
        lock.lock();
        try {
            since = state.count;
            generation = state.generation;
            if (state.dirty) {
                return;
            }
        } finally {
            lock.unlock();
        }
        boolean changed;
        setParked(state, true);
        try {
            Map<String, Object> answer = world.run(tab, Map.of("op", "changed", "since", since, "ms", timing.changeWait().toMillis()),
                    timing.changeWait().plus(timing.request()));
            changed = !Boolean.TRUE.equals(answer.get("timeout")) || Boolean.TRUE.equals(answer.get("gone"));
        } catch (CdpFailure e) {
            // The document went (a navigation), or Chromium did: either way, look again.
            changed = true;
            if (e.kind() == CdpFailure.Kind.DISCONNECTED || e.kind() == CdpFailure.Kind.NOT_SENT) {
                pause(Duration.ofMillis(500));
            }
        } finally {
            setParked(state, false);
        }
        if (changed) {
            lock.lock();
            try {
                state.dirty = true;
            } finally {
                lock.unlock();
            }
        }
        if (generation != currentGeneration(state)) {
            // A new document: give it a moment to have something in it.
            pause(timing.debounce().multipliedBy(4));
        }
    }

    private void pace(TabState state) throws InterruptedException {
        long since;
        long length;
        lock.lock();
        try {
            since = System.nanoTime() - state.lastSnapshotNanos;
            length = state.lastSnapshotLength;
        } finally {
            lock.unlock();
        }
        long gap = Math.max(timing.minGap().toNanos(), 3 * length);
        long wait = Math.max(timing.debounce().toNanos(), gap - since);
        pause(Duration.ofNanos(wait));
    }

    private static void pause(Duration duration) throws InterruptedException {
        Thread.sleep(duration);
    }

    /** With {@code lock} held. */
    private void signalWake() {
        wakes++;
        wake.signalAll();
    }

    private long wakes() {
        lock.lock();
        try {
            return wakes;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Parks until a wake newer than {@code seen}, or {@code wait}. Whether the tab is dirty doesn't matter here: a tab
     * whose Chromium is frozen, or that shows the stream, is dirty and still mustn't be looked at again at once (review 1).
     */
    private void awaitWake(long seen, Duration wait) throws InterruptedException {
        lock.lock();
        try {
            long left = wait.toNanos();
            while (wakes == seen && left > 0 && !closed) {
                left = wake.awaitNanos(left);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Passes of the watchers' loops so far: for tests. */
    public long watchPasses() {
        return watchPasses.get();
    }

    private long currentGeneration(TabState state) {
        lock.lock();
        try {
            return state.generation;
        } finally {
            lock.unlock();
        }
    }

    // ---- the view

    /** The tab's state, made if it's new, or null past the limit. */
    TabState state(String tabId) {
        lock.lock();
        try {
            TabState state = tabs.get(tabId);
            if (state == null && tabs.size() < MAX_TABS) {
                state = new TabState(tabId);
                state.actions = new TokenBucket(ActionProxy.TAB_PER_SECOND, ActionProxy.TAB_PER_SECOND, System::nanoTime);
                tabs.put(tabId, state);
            }
            return state;
        } finally {
            lock.unlock();
        }
    }

    TabState existing(String tabId) {
        lock.lock();
        try {
            return tabs.get(tabId);
        } finally {
            lock.unlock();
        }
    }

    /** Whether an act's rev is of the tab's current document, and no newer than what deskd has published. */
    boolean sameDocument(TabState state, long rev) {
        lock.lock();
        try {
            return rev >= state.firstRevOfDocument && rev <= state.rev;
        } finally {
            lock.unlock();
        }
    }

    boolean framesUnrecorded(TabState state) {
        lock.lock();
        try {
            return state.framesUnrecorded;
        } finally {
            lock.unlock();
        }
    }

    /** The targets of this tab's frames in processes of their own, which are their frames' ids too. */
    Set<String> frameTargetsOf(String tabId) {
        lock.lock();
        try {
            Set<String> targets = new HashSet<>();
            for (FrameSession session : frameSessions.values()) {
                if (session.tabId().equals(tabId)) {
                    targets.add(session.targetId());
                }
            }
            return targets;
        } finally {
            lock.unlock();
        }
    }

    /** The session of this tab's frame in a process of its own whose target is that frame, or null. */
    String frameSessionFor(String tabId, String frameId) {
        lock.lock();
        try {
            for (Map.Entry<String, FrameSession> entry : frameSessions.entrySet()) {
                if (entry.getValue().tabId().equals(tabId) && entry.getValue().targetId().equals(frameId)) {
                    return entry.getKey();
                }
            }
            return null;
        } finally {
            lock.unlock();
        }
    }

    /** The frame sessions Chromium attached under this tab. */
    List<String> frameSessionsOf(String tabId) {
        lock.lock();
        try {
            List<String> sessions = new ArrayList<>();
            for (Map.Entry<String, FrameSession> entry : frameSessions.entrySet()) {
                if (entry.getValue().tabId().equals(tabId)) {
                    sessions.add(entry.getKey());
                }
            }
            return sessions;
        } finally {
            lock.unlock();
        }
    }

    /** Something an action did, or a refusal: the view is to be looked at again, and whoever watches told. */
    void markDirty(TabState state) {
        boolean parked;
        lock.lock();
        try {
            state.dirty = true;
            parked = state.parked;
            signalWake();
        } finally {
            lock.unlock();
        }
        if (parked) {
            wakeParked(List.of(state));
        }
    }

    private void setParked(TabState state, boolean parked) {
        lock.lock();
        try {
            state.parked = parked;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Ends the page waits of these tabs' watchers, which hear nothing else until the page changes or the wait's 20 s are
     * up (review 7). On threads of their own: never on the read path or with a lock held.
     */
    private void wakeParked(List<TabState> states) {
        for (TabState state : states) {
            Thread.ofVirtual().name("minified-wake").start(() -> {
                try {
                    if (access.frozen()) {
                        return;
                    }
                    world.run(access.resolve(state.id), Map.of("op", "wake"), timing.request());
                } catch (RpcException | CdpFailure e) {
                    // A tab or document that's gone ends the wait itself.
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }
    }

    boolean dialogOpen(TabState state) {
        lock.lock();
        try {
            return state.dialog;
        } finally {
            lock.unlock();
        }
    }

    /** For an action: the tab's last MDoc, or null. */
    MDoc doc(TabState state) {
        lock.lock();
        try {
            return state.doc;
        } finally {
            lock.unlock();
        }
    }

    /**
     * {@code browser.minified.get}: the view of a tab now.
     *
     * @param since the rev the client has: if it's still the rev, the reply says so and nothing more
     * @param retry ignore what the site's memory and this document's fallback say, as the member asked to try again
     */
    Map<String, Object> get(String tabId, Long since, boolean retry) throws RpcException, InterruptedException {
        TabRef tab;
        Map<String, Object> reply;
        // Work: Chromium is thawed for it first (ADR 0045).
        try (AutoCloseable use = access.use()) {
            tab = access.resolve(tabId);
            reply = getResolved(tab, since, retry);
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw unavailable();
        }
        TabState state = existing(tab.tabId());
        if (state != null) {
            leave(state, true);
        }
        return reply;
    }

    private Map<String, Object> getResolved(TabRef tab, Long since, boolean retry) throws RpcException, InterruptedException {
        TabState state = state(tab.tabId());
        if (state == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Too many tabs in the simplified view", Map.of("reason", "tabs"));
        }
        boolean watched;
        lock.lock();
        try {
            watched = state.watcher != null;
        } finally {
            lock.unlock();
        }
        // A watched tab's view is current unless it's been told otherwise; anything else is looked at now.
        refresh(tab, state, !watched, retry);
        lock.lock();
        try {
            Map<String, Object> status = state.status != null ? state.status : pendingStatus(state);
            if (since != null && since == state.rev) {
                Map<String, Object> same = new LinkedHashMap<>(status);
                same.put("unchanged", true);
                return same;
            }
            Map<String, Object> reply = new LinkedHashMap<>(status);
            if (state.doc != null && state.fallback == null) {
                reply.put("mdoc", state.doc.wire());
            }
            state.usedNanos = System.nanoTime();
            return reply;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Brings the tab's view up to date if anything may have changed, or always with {@code force}, and tells subscribers
     * of any change.
     *
     * @return whether the view is the simplified one
     * @throws RpcException unavailable if Chromium isn't there to ask
     */
    boolean refresh(TabRef tab, TabState state, boolean force, boolean retry) throws RpcException, InterruptedException {
        lockLettingActionsFirst(state);
        try {
            return refreshLocked(tab, state, force, retry);
        } finally {
            state.work.unlock();
        }
    }

    /**
     * Takes the tab's work for a look at the page, letting any action already waiting for it go first (B8): an action
     * waits for a look that's running, but not for the next one. Up to {@link #YIELD_FOR}, so a look always comes.
     */
    private void lockLettingActionsFirst(TabState state) throws InterruptedException {
        boolean reentrant = state.work.isHeldByCurrentThread();
        long deadline = System.nanoTime() + YIELD_FOR.toNanos();
        while (true) {
            state.work.lockInterruptibly();
            if (reentrant || System.nanoTime() >= deadline) {
                return;
            }
            lock.lock();
            try {
                if (state.actionsWaiting == 0) {
                    return;
                }
            } finally {
                lock.unlock();
            }
            state.work.unlock();
            lock.lock();
            try {
                while (state.actionsWaiting > 0) {
                    long left = deadline - System.nanoTime();
                    if (left <= 0) {
                        break;
                    }
                    actionsGone.awaitNanos(left);
                }
            } finally {
                lock.unlock();
            }
        }
    }

    /** How long a look at the page lets waiting actions go first, at most. */
    static final Duration YIELD_FOR = Duration.ofSeconds(2);

    private boolean refreshLocked(TabRef tab, TabState state, boolean force, boolean retry) throws RpcException, InterruptedException {
        String host = SiteMemory.hostOf(tab.url());
        Fallback before = precheck(tab, state, host, retry);
        if (before != null) {
            setFallback(state, before, before == Fallback.REMEMBERED ? memory.remembered(host) : null, false);
            return false;
        }
        long generation;
        lock.lock();
        try {
            if (!force && !state.dirty && state.doc != null && state.fallback == null) {
                return true;
            }
            if (!retry && state.fallback != null && state.fallback.forDocument && state.fallbackGeneration == state.generation) {
                return false;
            }
            generation = state.generation;
        } finally {
            lock.unlock();
        }
        ensureInjected(tab, state);
        snapshots.acquire();
        long started = System.nanoTime();
        Map<String, Object> value;
        try {
            value = world.run(tab, snapshotArgs(), timing.snapshot());
        } catch (CdpFailure e) {
            if (e.tooLarge()) {
                // Past what deskd reads from Chromium in one message: a size failure, not a page that never answered.
                setFallback(state, Fallback.TOO_LARGE, null, true, generation, host);
                return false;
            }
            if (e.kind() == CdpFailure.Kind.TIMEOUT) {
                setFallback(state, Fallback.TIMEOUT, null, true, generation, host);
                return false;
            }
            if (e.kind() == CdpFailure.Kind.REMOTE) {
                // The document went while it was being read: the next look is at the new one.
                return false;
            }
            throw unavailable();
        } finally {
            snapshots.release();
            lock.lock();
            try {
                state.lastSnapshotNanos = System.nanoTime();
                state.lastSnapshotLength = state.lastSnapshotNanos - started;
            } finally {
                lock.unlock();
            }
        }
        if (value.get("error") != null) {
            setFallback(state, Fallback.DISTILLER_ERROR, null, true, generation, host);
            return false;
        }
        if (Boolean.TRUE.equals(value.get("tooLarge"))) {
            setFallback(state, Fallback.TOO_LARGE, null, true, generation, host);
            return false;
        }
        value = withFrameWall(tab, value);
        MDocBuilder.Raw raw = MDocBuilder.Raw.of(value, MAX_RAW_CHARS);
        if (raw == null) {
            setFallback(state, Fallback.DISTILLER_ERROR, null, true, generation, host);
            return false;
        }
        MDocBuilder.Built built = MDocBuilder.build(tab.tabId(), tab.url(), tab.title(), raw, new DocumentContext(state, generation));
        return take(tab, state, built, raw, generation, host);
    }

    /** What says the stream before the page is even looked at. */
    private Fallback precheck(TabRef tab, TabState state, String host, boolean retry) {
        if (host == null) {
            return Fallback.NOT_PAGE;
        }
        SiteMemory.Site site = memory.get(host);
        if (HostLists.on(lists.sensitive, host) || site.sensitive()) {
            return Fallback.SENSITIVE_SITE;
        }
        if (site.view() == SiteMemory.View.STREAM) {
            return Fallback.MEMBER_CHOICE;
        }
        lock.lock();
        try {
            if (state.dialog) {
                return Fallback.DIALOG;
            }
        } finally {
            lock.unlock();
        }
        if (!retry && memory.remembered(host) != null) {
            return Fallback.REMEMBERED;
        }
        return null;
    }

    private Map<String, Object> snapshotArgs() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("op", "snapshot");
        args.put("limit", DISTILLER_BLOCKS);
        args.put("maxChars", MAX_RAW_CHARS);
        args.put("maxNodes", MDocBuilder.MAX_NODES);
        args.put("maxMedia", MAX_MEDIA);
        args.put("maxElements", MAX_ELEMENTS);
        args.put("maxReply", MAX_REPLY_CHARS);
        args.put("payHosts", lists.payment);
        args.put("videoHosts", lists.video);
        args.put("adHosts", lists.ad);
        args.put("consentHosts", lists.consent);
        return args;
    }

    /** deskd's scripts on the tab's session, once per session: a new one has neither them nor the frames' attach. */
    void ensureInjected(TabRef tab, TabState state) throws RpcException, InterruptedException {
        lock.lock();
        try {
            if (tab.sessionId().equals(state.injectedSession)) {
                return;
            }
        } finally {
            lock.unlock();
        }
        String scriptId;
        try {
            scriptId = world.inject(tab, timing.request());
        } catch (CdpFailure e) {
            throw unavailable();
        }
        lock.lock();
        try {
            state.injectedSession = tab.sessionId();
            state.scriptId = scriptId;
        } finally {
            lock.unlock();
        }
    }

    /**
     * A wall the distiller saw drawn by a frame of another site (its {@code kind: frame}, as BBC's terms modal comes from its
     * CMP): deskd reads that frame's words and buttons in its own world there and tells what it is, as the prototype's kit
     * does, so a terms wall needing the member's yes opens the real page ({@code terms_wall}) and the view never shows
     * what the wall hides. Anything that can't be read leaves the wall as the distiller said.
     */
    private Map<String, Object> withFrameWall(TabRef tab, Map<String, Object> value) throws InterruptedException {
        // The distiller's head is the text's first line, which may span pieces.
        if (!(value.get("chunks") instanceof List<?> chunks)) {
            return value;
        }
        StringBuilder first = new StringBuilder();
        for (Object chunk : chunks) {
            if (!(chunk instanceof String piece) || first.length() > 400_000) {
                return value;
            }
            int end = piece.indexOf('\n');
            first.append(end < 0 ? piece : piece.substring(0, end));
            if (end >= 0) {
                break;
            }
        }
        Map<String, Object> meta;
        try {
            meta = Json.parseObject(first.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (com.minimalistalliance.desk.deskd.protocol.JsonFormatException e) {
            return value;
        }
        if (!(meta.get("wall") instanceof Map<?, ?> wall) || !"frame".equals(wall.get("kind")) || !(wall.get("frames") instanceof List<?> urls)) {
            return value;
        }
        Set<String> hosts = new HashSet<>();
        for (Object url : urls) {
            String h = url instanceof String u ? SiteMemory.hostOf(u) : null;
            if (h != null) {
                hosts.add(h);
            }
        }
        if (hosts.isEmpty()) {
            return value;
        }
        String kind = null;
        // A frame of another site attaches a moment after the page is in: a few looks, a moment apart.
        for (int attempt = 0; attempt < 4 && kind == null; attempt++) {
            if (attempt > 0) {
                pause(Duration.ofMillis(250));
            }
            kind = frameWallKind(tab, hosts);
        }
        if (!"terms".equals(kind)) {
            return value;
        }
        // deskd's own wall facts, told it's a terms wall: the builder then opens the real page.
        Map<String, Object> told = new LinkedHashMap<>();
        Map<String, Object> newStats = new LinkedHashMap<>();
        if (value.get("stats") instanceof Map<?, ?> stats) {
            stats.forEach((k, v) -> newStats.put(String.valueOf(k), v));
            if (stats.get("wall") instanceof Map<?, ?> own) {
                own.forEach((k, v) -> told.put(String.valueOf(k), v));
            }
        }
        told.put("kind", "terms");
        told.put("how", "frame");
        newStats.put("wall", told);
        Map<String, Object> out = new LinkedHashMap<>(value);
        out.put("stats", newStats);
        return out;
    }

    /** What a wall in one of these hosts' frames says it is, or null if no such frame could be read. */
    private String frameWallKind(TabRef tab, Set<String> hosts) throws InterruptedException {
        String kind = null;
        try {
            PageWorld.Frames frames = world.frames(tab, frameSessionsOf(tab.tabId()), frameTargetsOf(tab.tabId()), timing.request());
            for (PageWorld.Frame frame : frames == null ? List.<PageWorld.Frame>of() : frames.others()) {
                Map<String, Object> said;
                try {
                    said = world.runIn(tab, frame, Map.of("op", "wallText"), timing.request());
                } catch (CdpFailure e) {
                    continue;
                }
                if (said.get("host") instanceof String h && hosts.contains(h.toLowerCase(java.util.Locale.ROOT))) {
                    List<String> buttons = new ArrayList<>();
                    if (said.get("buttons") instanceof List<?> names) {
                        for (Object name : names) {
                            if (name instanceof String n && buttons.size() < 30) {
                                buttons.add(n.length() > 200 ? n.substring(0, 200) : n);
                            }
                        }
                    }
                    String text = said.get("text") instanceof String t ? t : "";
                    if (!text.isEmpty() || !buttons.isEmpty()) {
                        kind = WallText.classify(text.length() > 2000 ? text.substring(0, 2000) : text, buttons);
                        break;
                    }
                }
            }
        } catch (CdpFailure e) {
            return null;
        }
        return kind;
    }

    /** Takes a build as the view, if it's still of the document on screen. */
    private boolean take(TabRef tab, TabState state, MDocBuilder.Built built, MDocBuilder.Raw raw, long generation, String host) {
        MDoc doc = built.doc();
        boolean pressConsent = false;
        Map<String, Object> event = null;
        String type = null;
        lock.lock();
        try {
            if (state.generation != generation || state.closed) {
                return false;
            }
            state.count = raw.count();
            state.dirty = false;
            state.judged = judged(raw, doc, built);
            String site = SiteMemory.registrable(host);
            if (doc.sensitive) {
                sensitiveHosts.add(site);
            } else if (sensitiveHosts.contains(site)) {
                doc = doc.asSensitive();
            }
            if (state.consentRejected && doc.facts.get("hidden") instanceof Map<?, ?> hidden) {
                Map<String, Object> said = new LinkedHashMap<>();
                hidden.forEach((k, v) -> said.put((String) k, v));
                // The cookie row says what was pressed, by its label (Security's Ask 1, condition 4).
                said.put("done", state.consentLabel == null ? Map.of("cookie", "rejected") : Map.of("cookie", "rejected", "label", state.consentLabel));
                doc = doc.withFact("hidden", said);
            }
            if (host != null && !adblock.on(host)) {
                // The member turned ad blocking off for this site: the head says so (ADR 0073's switch).
                Map<String, Object> said = new LinkedHashMap<>();
                if (doc.facts.get("hidden") instanceof Map<?, ?> hidden) {
                    hidden.forEach((k, v) -> said.put((String) k, v));
                } else {
                    said.put("counts", Map.of());
                }
                said.put("blocking", false);
                doc = doc.withFact("hidden", said);
            }
            if (flags.consentReject() && doc.consent != null && state.consentGeneration != generation && !doc.sensitive) {
                state.consentGeneration = generation;
                pressConsent = true;
            }
            if (built.fallback() == null) {
                boolean same = state.fallback == null && doc.sameAs(state.doc);
                MDoc previous = state.doc;
                if (!same) {
                    state.rev++;
                    doc = doc.withRev(state.rev);
                    state.doc = doc;
                    state.fallback = null;
                    state.cause = null;
                    state.status = simplifiedStatus(state);
                    Map<String, Object> patch = previous == null ? null : doc.patchFrom(previous);
                    event = patch != null ? patch : state.status;
                    type = patch != null ? "patch" : "changed";
                }
                state.usedNanos = System.nanoTime();
                evictBeyondKept(state);
            }
        } finally {
            lock.unlock();
        }
        if (built.fallback() != null) {
            // A page still loading isn't held against its site.
            setFallback(state, built.fallback(), built.cause(), built.fallback().forDocument, generation, raw.loading() ? null : host);
            return false;
        }
        if (event != null) {
            publish(state.id, type, event);
        }
        if (pressConsent) {
            MDoc pressed = doc;
            Thread.ofVirtual().name("minified-consent").start(() -> rejectConsent(tab, state, pressed));
        }
        return true;
    }

    /**
     * Presses a consent banner's exactly labeled reject for the member, once per document, behind its flag, through the
     * same guard as any click (T47-2, T47-3): the fingerprint, every frame armed, the hit-test, and counted only if the
     * button itself got the click. A banner that isn't exactly that is only hidden.
     */
    private void rejectConsent(TabRef tab, TabState state, MDoc doc) {
        // Never a thaw for it, and no freeze between the press and its release (review 9): work, under use().
        if (access.frozen()) {
            return;
        }
        boolean pressed;
        try (AutoCloseable use = access.use()) {
            pressed = proxy.pressConsent(tab, state, doc);
        } catch (RpcException e) {
            log.debug("a consent banner's reject wasn't pressed: {}", e.details().get("reason"));
            return;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        } catch (Exception e) {
            return;
        }
        if (pressed) {
            lock.lock();
            try {
                state.consentRejected = true;
                state.consentLabel = doc.consent.label();
            } finally {
                lock.unlock();
            }
            markDirty(state);
        }
    }

    /** With the lock held. */
    private void evictBeyondKept(TabState keep) {
        List<TabState> holding = new ArrayList<>();
        for (TabState state : tabs.values()) {
            if (state.doc != null) {
                holding.add(state);
            }
        }
        // Unwatched tabs go first. A watched tab goes only with more than KEPT_DOCS watched, and isn't woken for it
        // (review 7): its view hasn't changed, and a woken watcher would take another's place, which would wake that.
        // Its watcher looks again at the page's next change, and a get at once.
        holding.sort((a, b) -> a.watcher == null != (b.watcher == null) ? (a.watcher == null ? -1 : 1) : Long.compare(a.usedNanos, b.usedNanos));
        for (int i = 0; i < holding.size() - KEPT_DOCS; i++) {
            TabState state = holding.get(i);
            if (state != keep) {
                dropView(state);
                state.dirty = true;
            }
        }
    }

    /**
     * With the lock held. The view's document goes, and what {@code get} said of it goes with it: a new rev, and pending
     * until the next look, so no {@code get} answers {@code simplified} without an MDoc, or {@code unchanged} for a page
     * that's gone (review 4). A stream view stays as it is: it never showed more than the page.
     */
    private static void dropView(TabState state) {
        if (state.doc == null) {
            return;
        }
        state.doc = null;
        if (state.fallback == null) {
            state.rev++;
            state.status = null;
        }
    }

    void setFallback(TabState state, Fallback reason, Fallback cause, boolean forDocument) {
        setFallback(state, reason, cause, forDocument, -1, null);
    }

    private void setFallback(TabState state, Fallback reason, Fallback cause, boolean forDocument, long generation, String host) {
        Map<String, Object> event = null;
        lock.lock();
        try {
            if (generation >= 0 && generation != state.generation) {
                return;
            }
            if (forDocument) {
                state.fallbackGeneration = state.generation;
                state.dirty = false;
            }
            if (state.fallback != reason || state.cause != cause) {
                state.fallback = reason;
                state.cause = cause;
                state.doc = null;
                state.rev++;
                state.status = streamStatus(state);
                event = state.status;
            }
        } finally {
            lock.unlock();
        }
        if (host != null && reason.rememberable && event != null) {
            memory.noteFallback(host, reason);
        }
        if (event != null) {
            publish(state.id, "changed", event);
        }
    }

    /**
     * Every tab on this site looks again, as the member changed what the site does. A site is its registrable domain on
     * both sides, as site memory keeps it, so {@code example.com} marks {@code www.example.com} (review 7).
     */
    void siteChanged(String host) {
        String site = SiteMemory.registrable(host);
        List<TabState> parked = new ArrayList<>();
        lock.lock();
        try {
            for (TabState state : tabs.values()) {
                if (state.doc == null || site != null && site.equals(SiteMemory.registrable(SiteMemory.hostOf(state.doc.url)))) {
                    state.dirty = true;
                    state.fallbackGeneration = -1;
                    if (state.parked) {
                        parked.add(state);
                    }
                }
            }
            signalWake();
        } finally {
            lock.unlock();
        }
        wakeParked(parked);
    }

    // ---- statuses: what the topic says, and what get says beside the MDoc

    private Map<String, Object> simplifiedStatus(TabState state) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("tabId", state.id);
        status.put("rev", state.rev);
        status.put("view", "simplified");
        return status;
    }

    private Map<String, Object> streamStatus(TabState state) {
        Map<String, Object> fallback = new LinkedHashMap<>();
        fallback.put("reason", state.fallback.wire());
        if (state.cause != null) {
            fallback.put("cause", state.cause.wire());
        }
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("tabId", state.id);
        status.put("rev", state.rev);
        status.put("view", "stream");
        status.put("fallback", fallback);
        return status;
    }

    private static Map<String, Object> pendingStatus(TabState state) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("tabId", state.id);
        status.put("rev", state.rev);
        status.put("view", "pending");
        return status;
    }

    private static Map<String, Object> closedStatus(String tabId) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("tabId", tabId);
        status.put("view", "closed");
        return status;
    }

    /** Never with a lock held. */
    void publish(String tabId, String type, Map<String, Object> data) {
        try {
            hub.publish(TOPIC + tabId, type, data);
        } catch (IllegalArgumentException e) {
            log.error("a simplified view event was over the limit");
        }
    }

    static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The browser isn't reachable", Map.of("reason", "chromium"));
    }

    // ---- images

    /** The id an image in this document has, made the first time, under the limit. */
    private final class DocumentContext implements MDocBuilder.Context {
        static final int MAX_IMAGES = 400;
        private final TabState state;
        private final long generation;

        DocumentContext(TabState state, long generation) {
            this.state = state;
            this.generation = generation;
        }

        @Override
        public String imageId(String url) {
            lock.lock();
            try {
                if (state.generation != generation) {
                    return null;
                }
                String id = state.imageIds.get(url);
                if (id == null && state.imageIds.size() < MAX_IMAGES) {
                    id = "i" + Long.toString(generation, 36) + "." + Integer.toString(state.imageIds.size() + 1, 36);
                    state.imageIds.put(url, id);
                    state.imageUrls.put(id, url);
                }
                return id;
            } finally {
                lock.unlock();
            }
        }

        @Override
        public boolean wasSensitive(String ref) {
            lock.lock();
            try {
                return state.generation == generation && state.sensitiveRefs.contains(ref);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public void markSensitive(String ref) {
            lock.lock();
            try {
                if (state.generation == generation && state.sensitiveRefs.size() < 10_000) {
                    state.sensitiveRefs.add(ref);
                }
            } finally {
                lock.unlock();
            }
        }
    }

    /** The page URL an image id stands for, in the tab's current document, or null. Never leaves the desk. */
    String imageUrl(TabState state, String imageId) {
        lock.lock();
        try {
            return state.imageUrls.get(imageId);
        } finally {
            lock.unlock();
        }
    }

    /**
     * An island's box changed or it's the first look: a new epoch, so whatever maps input by it drops what's stale
     * (T47-4).
     */
    long islandEpoch(TabState state, String islandId, String box) {
        lock.lock();
        try {
            if (!box.equals(state.islandBoxes.get(islandId))) {
                if (state.islandBoxes.size() >= MDocBuilder.MAX_ISLANDS * 4) {
                    state.islandBoxes.clear();
                }
                state.islandBoxes.put(islandId, box);
                state.islandEpoch++;
            }
            return state.islandEpoch;
        } finally {
            lock.unlock();
        }
    }
}
