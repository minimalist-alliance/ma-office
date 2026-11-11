package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.files.ImportFiles;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.platform.StreamingPause;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionListener;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The Browser's part of deskd, wired once the session manager exists (milestone 2, desk-runtime.md
 * section 8), the desk's clipboard included ({@link BrowserClipboard}), and what a desk nobody looks at does (ADR 0045):
 * {@link DeskAttention} cuts its media, so nothing is encoded, and {@link BrowserFreeze} freezes its Chromium. A problem
 * in here never fails /health, and never touches the rpc lane, ctl, the heartbeat
 * or the gateway link: unit calls have their own thread, and every wait for Chromium is on the thread of
 * the call that wanted it.
 */
public final class BrowserModule implements SessionListener {

    public static final String TOPIC = BrowserTabs.TOPIC;
    public static final String CLIPBOARD_TOPIC = BrowserClipboard.TOPIC;
    /** The file that keeps a refused start of Chromium across a restart of deskd: beside units.sock ({@link RefusalMarker}). */
    public static final String REFUSAL_MARKER = RefusalMarker.NAME;
    /** The file that says Chromium may be frozen, beside the refusal's ({@link FreezeMarker}). */
    public static final String FREEZE_MARKER = FreezeMarker.NAME;

    private static final Logger log = LoggerFactory.getLogger(BrowserModule.class);

    /** How long a transition's log line waits to say when Chromium connected. Only the line waits. */
    private static final Duration CONNECT_WAIT = Duration.ofMinutes(2);
    private static final long NANOS_PER_MILLI = 1_000_000;
    private static final String CHROMIUM_OLDER_THAN_PROFILE = "older_than_profile";

    private final RtcClient rtc;
    private final BrowserStream stream;
    private final BrowserTabs tabs;
    private final BrowserFreeze freeze;
    private final DeskAttention attention;
    private final BrowserView view;
    private final FilteredSites filtered;
    private final RpcDispatcher dispatcher;
    private final EventHub hub;
    private MinifiedModule minified;
    /** Links Chromium hands the OS, once {@link #serveLinks} has its socket up; null before, or on a desk without one. */
    private volatile BrowserLinks links;
    private volatile LinkSocket linkSocket;
    /** The simplified view's switch and timing, which the Agent's walker follows. */
    private MinifiedSwitch minifiedFlags;
    private MinifiedModule.Timing minifiedTiming;
    /** The Agent's Browser, once enabled. */
    private AgentBrowsing agent;
    /** Signing in, once enabled: what it holds in memory is zeroed as deskd stops. */
    private SignIns signIns;
    private final SessionManager sessions;
    /** At most one thread waits to log, so a client flipping states can't make more. */
    private final AtomicBoolean loggerWaiting = new AtomicBoolean();
    /**
     * The sessions the Browser's video goes to now, which Browser time counts (ADR 0090). Changed under {@link #videoLock}
     * only, by {@link #setVideo} under the stream's lock and as a session ends.
     */
    private final java.util.Set<String> videoOn = new java.util.HashSet<>();
    private final Object videoLock = new Object();
    /** The simplified view is in use ({@link MinifiedModule#followBrowserTime}), which Browser time counts too. Under {@link #videoLock}. */
    private boolean simplifiedOn;
    /** Until when today's Browser time is used up, or null: {@link #followBrowserTime}. */
    private volatile Supplier<Instant> timeUsedUntil = () -> null;
    /** Hears the Browser go live to any session, and stop: {@link #followBrowserTime}. Must not block. */
    private volatile java.util.function.Consumer<Boolean> liveListener = live -> {};
    /** When a move kept the Browser held, or null: {@link #followMovedHold}. Must take no lock of this module's. */
    private volatile Supplier<Instant> movedSince = () -> null;

    public BrowserModule(
            RtcClient rtc,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            PlatformHttp http,
            BrowserStream.Units units,
            Path refusalMarker,
            int cdpPort,
            int cdpUid) {
        this(
                rtc, sessions, dispatcher, hub, http, units, refusalMarker, cdpPort,
                new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, cdpPort, cdpUid),
                BrowserTabs.Timing.DEFAULT);
    }

    BrowserModule(
            RtcClient rtc,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            PlatformHttp http,
            BrowserStream.Units units,
            Path refusalMarker,
            int cdpPort,
            Supplier<CdpListener.Verdict> cdpListener,
            BrowserTabs.Timing timing) {
        this(rtc, sessions, dispatcher, hub, http, units, refusalMarker, cdpPort, cdpListener, timing, BrowserClipboard.Timing.DEFAULT);
    }

    BrowserModule(
            RtcClient rtc,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            PlatformHttp http,
            BrowserStream.Units units,
            Path refusalMarker,
            int cdpPort,
            Supplier<CdpListener.Verdict> cdpListener,
            BrowserTabs.Timing timing,
            BrowserClipboard.Timing clipboardTiming) {
        this(rtc, sessions, dispatcher, hub, http, units, refusalMarker, cdpPort, cdpListener, timing, clipboardTiming, new FamilyDns(http));
    }

    BrowserModule(
            RtcClient rtc,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            PlatformHttp http,
            BrowserStream.Units units,
            Path refusalMarker,
            int cdpPort,
            Supplier<CdpListener.Verdict> cdpListener,
            BrowserTabs.Timing timing,
            BrowserClipboard.Timing clipboardTiming,
            FilteredSites.Lookup familyDns) {
        this(rtc, sessions, dispatcher, hub, http, units, refusalMarker, cdpPort, cdpListener, timing, clipboardTiming, familyDns,
                DeskAttention.Timing.DEFAULT, BrowserFreeze.Timing.DEFAULT);
    }

    BrowserModule(
            RtcClient rtc,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            PlatformHttp http,
            BrowserStream.Units units,
            Path refusalMarker,
            int cdpPort,
            Supplier<CdpListener.Verdict> cdpListener,
            BrowserTabs.Timing timing,
            BrowserClipboard.Timing clipboardTiming,
            FilteredSites.Lookup familyDns,
            DeskAttention.Timing attentionTiming,
            BrowserFreeze.Timing freezeTiming) {
        this.rtc = rtc;
        this.sessions = sessions;
        this.dispatcher = dispatcher;
        this.hub = hub;
        this.filtered = new FilteredSites(familyDns);
        // Beside the refusal's file, so in /run/desk on a desk: it outlives a restart of deskd, and not a reboot.
        this.freeze = new BrowserFreeze(units, freezeTiming, new FreezeMarker(refusalMarker.resolveSibling(FREEZE_MARKER)));
        // Each needs the others only once running, and they're all made before anything can call.
        this.tabs = new BrowserTabs(
                http, cdpPort, cdpListener, hub, this::hasViewer, this::browserLost, this::browserDisplaced, filtered, freeze, timing);
        this.stream = new BrowserStream(
                units,
                this::setVideo,
                sessions::isLive,
                this::viewersChanged,
                tabs::browserStarting,
                this::onTransition,
                timing.restartEvery(),
                new RefusalMarker(refusalMarker),
                () -> {
                    CdpListener.Kind kind = cdpListener.get().kind();
                    return kind == CdpListener.Kind.TRUSTED || kind == CdpListener.Kind.DISPLACED;
                });
        // The phone view goes by who wants live and who looks: what the stream and the attention say.
        this.view = new BrowserView(tabs, stream::liveSessions, freeze, hub, this::looked, BrowserView.Timing.DEFAULT);
        this.attention = new DeskAttention(stream, freeze, hub, sessions::isLive, this::lookChanged, view::said, attentionTiming);
        stream.attentionFrom(attention::attended, freeze);
        freeze.follow(
                stream::browserSettled,
                () -> cdpListener.get().kind() == CdpListener.Kind.TRUSTED,
                new BrowserFreeze.Tabs() {
                    @Override
                    public boolean loading() {
                        return tabs.loading();
                    }

                    @Override
                    public void wake() {
                        tabs.wake();
                    }

                    @Override
                    public boolean letGo(Duration wait) throws InterruptedException {
                        return tabs.letGo(wait);
                    }
                },
                attention::publish);
        new BrowserMethods(stream, tabs, freeze, () -> movedSince.get()).register(dispatcher);
        hub.topics().register(BrowserTabs.TOPIC, tabs);
        new BrowserClipboard(rtc, hub, clipboardTiming).register(dispatcher, freeze);
        attention.register(dispatcher);
        view.register(dispatcher);
        sessions.addSessionListener(this);
        attention.start();
        freeze.start();
        view.start();
    }

    @Override
    public void onSessionEnded(String sessionId) {
        stream.sessionEnded(sessionId);
        attention.sessionEnded(sessionId);
        view.sessionEnded(sessionId);
        noteVideo(sessionId, false);
    }

    /** The stream's {@code session.video}, under its lock: to desk-rtc, and noted for Browser time. Must not block. */
    private void setVideo(String sessionId, boolean view) {
        rtc.setVideo(sessionId, view);
        noteVideo(sessionId, view);
    }

    private void noteVideo(String sessionId, boolean on) {
        synchronized (videoLock) {
            boolean before = inUseLocked();
            if (on) {
                videoOn.add(sessionId);
            } else {
                videoOn.remove(sessionId);
            }
            tellUse(before);
        }
    }

    /**
     * The simplified view has become in use, or stopped: Browser time counts it once with the video, never twice, and the
     * tabs keep the desk's own view while it's in use (BrowserView).
     */
    private void noteSimplified(boolean on) {
        synchronized (videoLock) {
            boolean before = inUseLocked();
            simplifiedOn = on;
            tellUse(before);
        }
        view.simplified(on);
    }

    private boolean inUseLocked() {
        return !videoOn.isEmpty() || simplifiedOn;
    }

    private void tellUse(boolean before) {
        boolean after = inUseLocked();
        if (before != after) {
            liveListener.accept(after);
        }
    }

    /** Input from desk-rtc is work, and thaws Chromium to take it. It's also a session taking the view (BrowserView). */
    @Override
    public void onDeskInput(String sessionId) {
        freeze.input();
        view.input(sessionId);
    }

    @Override
    public void onStreamState(String state) {
        stream.observeStreamState(state);
    }

    /**
     * Lets go of Chromium, leaving it and its tabs as they are, thawed first if it was frozen, for up to 2 s: deskd stops
     * before desk-browser, and systemd won't stop a frozen unit.
     */
    public void close() {
        if (agent != null) {
            // Its tabs and contexts go while the connection is still here; Chromium drops them with it anyway.
            agent.close();
        }
        if (linkSocket != null) {
            linkSocket.close();
        }
        if (minified != null) {
            minified.close();
        }
        if (signIns != null) {
            signIns.close();
        }
        view.close();
        attention.close();
        freeze.close(BrowserFreeze.CLOSE_THAW_WAIT);
        tabs.close();
    }

    /**
     * Serves the simplified view (task 47, API.md section 14): registers its methods and its topic, with per-site memory
     * in {@code dataDirectory}, the data volume. Call once, before the lifecycle starts.
     */
    public MinifiedModule enableMinified(Path dataDirectory) {
        return enableMinified(dataDirectory, java.time.Clock.systemUTC(), MinifiedModule.Timing.DEFAULT, MinifiedSwitch.file(dataDirectory));
    }

    /**
     * Reads the protected-media kill switch from {@code protected-media-switch} in this directory, the data volume
     * (API.md section 10). With no file it is on. Call once, before the lifecycle starts.
     */
    public void followProtectedMediaSwitch(Path dataDirectory) {
        tabs.protectedMediaSwitch(ProtectedMedia.switchIn(dataDirectory));
    }

    /** For tests: any switch. */
    void followProtectedMediaSwitch(java.util.function.BooleanSupplier on) {
        tabs.protectedMediaSwitch(on);
    }

    /**
     * Signing in that works on the desk ({@link SignIns}, API.md section 10, "Signing in"): {@code browser.import} of
     * bookmarks from {@code files}, a passwords file over the session into memory only ({@code browser.import.begin},
     * its bytes on bulk through {@code transfers}, {@code finish} and {@code abort}), {@code browser.bookmarks.list} and
     * the key button's {@code browser.extensions.list}, {@code browser.extension.open} and {@code close}, for the password
     * managers on {@link PasswordManagers#LAUNCH}. Refused unless {@code band} says adult. Call once, before the lifecycle
     * starts.
     */
    public void enableSignIns(ImportFiles files, Transfers transfers, Supplier<AgeBand.Band> band) {
        enableSignIns(files, transfers, band, new PasswordManagers(PasswordManagers.LAUNCH), SignIns.Timing.DEFAULT,
                PasswordUploads.Timing.DEFAULT);
    }

    /** @return the passwords file's table, for tests */
    PasswordUploads enableSignIns(
            ImportFiles files,
            Transfers transfers,
            Supplier<AgeBand.Band> band,
            PasswordManagers managers,
            SignIns.Timing timing,
            PasswordUploads.Timing uploadTiming) {
        PasswordUploads uploads = new PasswordUploads(transfers, sessions::session, uploadTiming);
        signIns = new SignIns(tabs.signInAccess(), freeze, files, uploads, band, managers, timing);
        signIns.register(dispatcher);
        return uploads;
    }

    /** {@link MinifiedModule#mayShareWithModel}, for whatever would hand a tab to a model: default deny (T47-7). */
    public boolean mayShareWithModel(String tabId) {
        return minified != null && minified.mayShareWithModel(tabId);
    }

    /** The simplified view, if it's enabled, for tests. */
    MinifiedModule minified() {
        return minified;
    }

    MinifiedModule enableMinified(Path dataDirectory, java.time.Clock clock, MinifiedModule.Timing timing, MinifiedSwitch flags) {
        if (minified != null) {
            throw new IllegalStateException("the simplified view is enabled already");
        }
        minified = new MinifiedModule(tabs.minifiedAccess(), dispatcher, hub, dataDirectory, clock, timing, flags);
        minifiedFlags = flags;
        minifiedTiming = timing;
        // Browser time (ADR 0090): the view in use counts with the video, and is refused with it once the day's time is used.
        minified.followBrowserTime(() -> timeUsedUntil.get(), attention::seen, this::noteSimplified);
        return minified;
    }

    /**
     * Passes the links Chromium hands the desk's OS to the member's device (API.md section 10, "Links out"): listens on
     * {@code socket} for the image's {@code xdg-open} stand-in, from {@code chromiumUid} alone, and registers the topic
     * {@value BrowserLinks#TOPIC}. A desk whose image has no stand-in has no directory for the socket, so neither happens, and
     * a SUB to the topic gets not_found. Call once, before the lifecycle starts.
     *
     * @return true if it's listening
     */
    public boolean serveLinks(Path socket, int chromiumUid) {
        return serveLinks(socket, chromiumUid, BrowserLinks.Timing.DEFAULT, java.time.Clock.systemUTC(), System::nanoTime);
    }

    boolean serveLinks(Path socket, int chromiumUid, BrowserLinks.Timing timing, java.time.Clock clock, java.util.function.LongSupplier nanos) {
        if (links != null) {
            throw new IllegalStateException("links are served already");
        }
        Path directory = socket.toAbsolutePath().getParent();
        if (directory == null || !java.nio.file.Files.isDirectory(directory)) {
            log.info("links out: no {}, so links Chromium hands the desk's OS go nowhere (an image without the stand-in)", directory);
            return false;
        }
        BrowserLinks topic = new BrowserLinks(hub, tabs::knownTabOnScreen, clock, nanos, timing);
        try {
            LinkSocket server = new LinkSocket(socket, chromiumUid, new LinkSocket.Sink() {
                @Override
                public String offer(String url) {
                    return topic.offer(url);
                }

                @Override
                public String refused(String reason) {
                    return topic.refused(reason);
                }
            });
            server.start();
            linkSocket = server;
        } catch (java.io.IOException e) {
            log.warn("links out: can't listen on {}: {}", socket, e.getClass().getSimpleName());
            return false;
        }
        hub.topics().register(BrowserLinks.TOPIC, topic);
        links = topic;
        log.info("links out: listening on {}", socket);
        return true;
    }

    /**
     * The Agent's Browser (draft ADR "the Agent's tools and approvals", section 5; {@link AgentBrowsing}): a run's own
     * off-the-record context, a granted site of the member's session, hidden tabs that are never the member's, and the
     * simplified view's walker and action proxy over them. It follows the view's kill switch. Call once, after
     * {@link #enableMinified}, before the lifecycle starts.
     *
     * @param freeDesk whether this is a free desk, which has one Agent tab. Must not block
     */
    public AgentBrowser enableAgentBrowsing(java.util.function.BooleanSupplier freeDesk) {
        if (agent != null) {
            throw new IllegalStateException("the agent's browser is enabled already");
        }
        if (minified == null) {
            throw new IllegalStateException("the agent's browser needs the simplified view");
        }
        agent = new AgentBrowsing(tabs, freeze, minifiedFlags, minifiedTiming, minified, freeDesk);
        return agent;
    }

    /** The Agent's Browser, or null if it isn't enabled. */
    public AgentBrowser agentBrowser() {
        return agent;
    }

    /**
     * {@link BrowserStream#hold}, for data.browser.hold. Never blocks: the stop goes through the stream's worker, which
     * looks first at whose the port is, so the release puts back a Chromium nobody was viewing too.
     */
    public CompletableFuture<Void> holdBrowser() {
        return stream.hold();
    }

    /**
     * Follows the Platform's bandwidth pause (ma-platform ADR 0095): while it's on, {@code live} is refused, and as it
     * begins every live session's video is cut and its session left {@code off}. Nothing else in the Browser changes,
     * and Chromium isn't stopped. Call once, before the lifecycle starts.
     */
    public void followStreamingPause(StreamingPause pause) {
        stream.pauseFrom(pause::pausedUntil);
        pause.onPause(stream::endLiveForPause);
    }

    /**
     * Follows the owner's age band (ma-platform contract age.md, section 8): Chromium doesn't start until the band is known
     * and its file can't take the policy off a teen, and a desk that becomes {@code teen} restarts Chromium. Nothing here
     * touches the profile, so cookies and history stay (ADR 0035). While the band is {@code teen}, a site the family filter
     * stopped gets our page in place of Chromium's ({@link FilteredSites}). Call once, before the lifecycle starts.
     */
    public void followAgeBand(AgeBand band) {
        filtered.teenFrom(() -> band.band() == AgeBand.Band.TEEN);
        stream.ageGateFrom(band::browserMayStart, BrowserStream.POLICY_RESTART_RETRY);
        band.onLockBegins(stream::restartForPolicy);
        band.onSettled(stream::ageGateMoved);
    }

    /**
     * Follows Browser time (ADR 0090): whether the Browser's video goes to any session goes to {@code live} as it changes,
     * under the stream's lock, so it must not block; while {@code usedUntil} says when, {@code live} is refused as during
     * the bandwidth pause, with {@code limit: browser_time}, and {@link #browserTimeUsed} ends what's open. Call once,
     * before the lifecycle starts.
     *
     * @param usedUntil until when today's time is used up, or null. Must not block or take a lock of this module's
     */
    public void followBrowserTime(Supplier<Instant> usedUntil, java.util.function.Consumer<Boolean> live) {
        stream.timeUsedFrom(usedUntil);
        timeUsedUntil = usedUntil;
        liveListener = live;
    }

    /** Today's Browser time has just been used up: {@link BrowserStream#endForTimeUsed}. Returns quickly. */
    public void browserTimeUsed() {
        stream.endForTimeUsed();
        MinifiedModule view = minified;
        if (view != null) {
            view.endForTimeUsed();
        }
    }

    /** For tests. */
    BrowserStream stream() {
        return stream;
    }

    /** For tests. */
    BrowserFreeze freeze() {
        return freeze;
    }

    /** For tests. */
    BrowserView view() {
        return view;
    }

    /** {@link FilteredSites#counts}, for tests. */
    FilteredSites.Counts filteredCounts() {
        return filtered.counts();
    }

    /** {@link BrowserStream#release}. Never blocks. */
    public void releaseBrowser() {
        stream.release();
    }

    /**
     * Where a move's kept hold is known (data.browser.keep, Security's NE-2): when the desk was moved, or null. While it's
     * set, a {@code live} or {@code warm} refused for the hold says {@code reason: moved} and since when, and {@code /health}
     * says {@code browser.moved}. Must not block or take a lock of this module's. Set once, before anything can call.
     */
    public void followMovedHold(Supplier<Instant> since) {
        movedSince = since;
    }

    /** {@link BrowserTabs#cookies}, for data.browser.cookies, which keeps only their digests. Parks for a while. */
    public List<Map<String, Object>> cookies() throws RpcException, InterruptedException {
        try (BrowserFreeze.Use use = freeze.use()) {
            return tabs.cookies();
        }
    }

    /** Chromium is frozen, or may be (ADR 0045). Doesn't block, so the heartbeat can ask. */
    public boolean browserFrozen() {
        return freeze.frozen();
    }

    /** {@link BrowserStream#chromiumRefused}. Doesn't block, so the heartbeat can ask. */
    public boolean chromiumRefused() {
        return stream.chromiumRefused();
    }

    /** What /health adds: informational, cheap, and counts rather than content. */
    public Map<String, Object> health() {
        Map<String, Object> streamHealth = new LinkedHashMap<>();
        streamHealth.put("wanted", stream.level().wire());
        streamHealth.put("rtc", rtc.streamState());
        streamHealth.put("seen", attention.seen());
        Map<String, Object> browserHealth = tabs.health();
        browserHealth.put("freeze", freeze.health());
        browserHealth.put("view", view.health());
        if (stream.chromiumRefused()) {
            browserHealth.put("chromium", CHROMIUM_OLDER_THAN_PROFILE);
        }
        if (stream.held()) {
            browserHealth.put("held", true);
        }
        Instant moved = movedSince.get();
        if (moved != null) {
            browserHealth.put("moved", moved.toString());
        }
        if (!stream.ageGateOpen()) {
            // Says only that it's shut, which is true of any desk for a moment, and never whose band is what.
            browserHealth.put("ageGate", "closed");
        }
        Instant timeUsed = stream.timeUsedUntil();
        if (timeUsed != null) {
            browserHealth.put("timeUsedUntil", timeUsed.toString());
        }
        Instant paused = stream.pausedUntil();
        if (paused != null) {
            browserHealth.put("bandwidthPaused", paused.equals(Instant.MAX) ? true : paused.toString());
        }
        BrowserLinks served = links;
        if (served != null) {
            browserHealth.put("links", served.health());
        }
        MinifiedModule view = minified;
        if (view != null) {
            // The simplified view's tabs, frames and pre-scrolls, by what came of them: counts, never a page.
            browserHealth.put("simplified", view.health());
        }
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("browser", browserHealth);
        health.put("stream", streamHealth);
        return health;
    }

    /**
     * The line that says how much of a first Browser use is deskd's (services/CLAUDE.md, Measuring). This runs with
     * the stream's lock held, perhaps on the rtc reader, so the line goes out on a thread of its own. Going live,
     * Chromium connects when it connects, maybe after the RPC has its answer, so the line waits for that. If one is
     * waiting already this line goes out without it, as {@code -}.
     */
    private void onTransition(BrowserStream.Transition transition) {
        Thread.ofVirtual().name("browser-timing").start(() -> {
            if (transition.to() != BrowserStream.Level.LIVE
                    || !"ok".equals(transition.outcome())
                    || !loggerWaiting.compareAndSet(false, true)) {
                logTransition(transition, -1);
                return;
            }
            try {
                Long connected = tabs.awaitConnected(CONNECT_WAIT);
                logTransition(transition, connected == null ? -1 : Math.max(0, connected - transition.started()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                loggerWaiting.set(false);
            }
        });
    }

    private static void logTransition(BrowserStream.Transition t, long connectedNanos) {
        log.info(
                "browser.stream.set timing from={} to={} result={} browserStartMs={} streamStartMs={} stopMs={} unitsMs={} cdpMs={} totalMs={}",
                t.from().wire(),
                t.to().wire(),
                t.outcome(),
                millis(t.browserStartNanos()),
                millis(t.streamStartNanos()),
                millis(t.stopNanos()),
                millis(t.unitsNanos()),
                millis(connectedNanos),
                millis(Math.max(t.unitsNanos(), connectedNanos)));
    }

    private static String millis(long nanos) {
        return nanos < 0 ? "-" : Long.toString(nanos / NANOS_PER_MILLI);
    }

    /** Someone wants the stream, and someone looks at the desk: what keeps the tabs read while subscribed. */
    private boolean hasViewer() {
        return stream.hasViewer() && attention.seen();
    }

    /** Somebody started or stopped looking at the desk: the tabs are woken, and the simplified view's use may have changed. */
    private void lookChanged() {
        tabs.wake();
        MinifiedModule simplified = minified;
        if (simplified != null) {
            simplified.useChanged();
        }
        view.recompute();
    }

    /** Who looks first, so the tabs are woken with it settled. */
    private void viewersChanged() {
        attention.recompute();
        tabs.wake();
        view.recompute();
    }

    /** Somebody looks at the desk. Read through here so the phone view can be made before the attention is. */
    private boolean looked() {
        DeskAttention said = attention;
        return said != null && said.seen();
    }

    private void browserLost() {
        stream.browserLost();
    }

    private void browserDisplaced() {
        stream.browserDisplaced();
    }
}
