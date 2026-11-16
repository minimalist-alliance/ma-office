package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.browser.minified.AgentView;
import com.minimalistalliance.desk.deskd.browser.minified.CdpFailure;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.browser.minified.TabAccess;
import com.minimalistalliance.desk.deskd.browser.minified.TabEvents;
import com.minimalistalliance.desk.deskd.browser.minified.TabRef;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The Agent's Browser on the desk's one Chromium (draft ADR "the Agent's tools and approvals", sections 2, 5 and 8).
 *
 * <p><b>Contexts.</b> A run's first Browser call makes it an off-the-record context of its own
 * ({@code Target.createBrowserContext}, {@code disposeOnDetach}), with downloads denied, and the run's tabs live there. It
 * has no cookies, sign-ins or saved cards, and writes nothing to {@code /data/browser/profile}. It's disposed of when the
 * run ends, when deskd closes, and by Chromium itself if deskd's connection goes. The member's own context is used only
 * for a site the member granted ({@code browser_use_my_session}): one tab a site, for the rest of that run, closed when it
 * ends, at most {@link #SITES_A_RUN} sites a run.
 *
 * <p><b>Never on the member's screen.</b> Every Agent tab is a hidden target ({@code Target.createTarget} with
 * {@code hidden}): in no window and no tab strip, so never the tab on screen, never activated, never on the streamed
 * display, and Chromium doesn't report it to {@code Target.getTargets} or target discovery. A desk has no window
 * manager: a new window, even "minimized", lands on screen over the member's page, and a background tab in the member's
 * window becomes the tab on screen when the member closes the one beside it (both checked on Chrome 156), so neither is
 * ever used. A target that comes back listed or with a window is closed at once and the call refused. It lives no longer
 * than deskd's connection. {@link BrowserTabs} ignores every Agent target and event ({@link BrowserTabs.AgentTargets}):
 * not in {@code browser.tabs}, the tab on screen, the kept order, downloads or crash handling, and a target an Agent tab
 * or context opens (a pop-up) is closed on sight. Its viewport is set to {@value #WIDTH}x{@value #HEIGHT}, as a hidden
 * target's is otherwise empty.
 *
 * <p><b>Requests.</b> Every Agent tab's document requests stop at Chromium's request stage ({@code Fetch}, documents
 * only, on that tab's session and on the session of every frame of it in a process of its own): one to a host on the
 * desk or its network (loopback, link-local, private, single-label, {@code .local}) is failed, and in a member-session
 * tab so is a main-frame navigation off the granted site, redirects included, which the call then answers
 * {@code off_site}. A tab attaches its out-of-process frames from its start, held until their requests stop here too
 * ({@code Target.setAutoAttach} with {@code waitForDebuggerOnStart}, and the walker's {@link TabAccess#frameAttached}),
 * and keeps that attach for its life (S-14).
 *
 * <p><b>Clicks and keys</b> are deskd's half's own, from deskd's isolated world, never trusted input (the action proxy's
 * Agent mode). After one, no fixed wait: a navigation it started is waited for by Chromium's own signs ({@link #settle}). Before one, where it would navigate is checked ({@link #navRefusal}): another site in a member-session
 * tab is {@code off_site}, a local host or a scheme but http, https and the page's own javascript is {@code blocked};
 * and a navigation the page starts anyway is cancelled at the request, as above.
 *
 * <p><b>CDP.</b> Everything goes through {@link AgentCdp}'s allow-list, the walker's and the action proxy's commands
 * included ({@link Access}), and only to the Agent's own sessions. Nothing clears or writes storage, cookies or history.
 *
 * <p><b>Work.</b> Each call thaws Chromium and holds the grace ({@link BrowserFreeze#use}), as a {@code browser.minified.*}
 * call does. A run's open tabs also hold off a freeze for {@link #HOLD} after its last call ({@link #holdsChromium}),
 * since a freeze closes deskd's connection and every Agent tab with it. Agent browsing is never Browser time on a free
 * desk, and never asks the free tier.
 *
 * <p>Nothing here logs a URL, a title, page text or typed text: counts and outcome words at most.
 */
public final class AgentBrowsing implements AgentBrowser, BrowserTabs.AgentTargets {

    private static final Logger log = LoggerFactory.getLogger(AgentBrowsing.class);

    static final int WIDTH = 1280;
    static final int HEIGHT = 800;
    private static final String BLANK = "about:blank";
    private static final List<Map<String, Object>> DOCUMENTS =
            List.of(Map.of("urlPattern", "*", "resourceType", "Document", "requestStage", "Request"));
    /** Frames in processes of their own attached and held at their start, as the walker's own attach has them. */
    private static final Map<String, Object> FRAMES = Map.of("autoAttach", true, "waitForDebuggerOnStart", true, "flatten", true,
            "filter", List.of(Map.of("type", "iframe")));
    private static final String BLOCKED_BY_ADMINISTRATOR = "net::ERR_BLOCKED_BY_ADMINISTRATOR";
    private static final int MAX_ID_CHARS = 128;
    private static final int MAX_FRAME_SESSIONS = 512;
    private static final int MAX_DOWNLOADS = 256;
    /**
     * How long an action deskd's half said navigates (a link, a form's submit, Back) gets to start its navigation before
     * its result is taken. It ends at the first sign of one, in a few ms as a rule (the Browser bar's gap 5: no fixed wait).
     */
    static final Duration NAV_START = Duration.ofSeconds(1);
    /** A view still being made is looked at again this many times. */
    private static final int PENDING_TRIES = 6;
    private static final Duration PENDING_PAUSE = Duration.ofMillis(250);
    /** How many of a run's tabs closed for memory it remembers, to answer a later call on one. */
    static final int OVER_MEMORY_KEPT = 16;
    /** How many ids that went {@link #went} keeps: far more than can be in flight at once. */
    static final int WENT_KEPT = 4096;
    private static final Pattern SITE = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+");
    private static final Set<String> PUBLIC_SECOND =
            Set.of("co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "sch", "ltd", "plc");
    private static final List<String> LOCAL_SUFFIXES =
            List.of(".localhost", ".local", ".internal", ".home.arpa", ".lan", ".localdomain", ".intranet", ".corp", ".private");

    /** One of the Agent's tabs. Its fields are under {@code lock}, but the counters. */
    private static final class AgentTab {
        final String id;
        final String runId;
        /** The granted site this tab is in the member's session for, or null for the run's own context. */
        final String site;
        final String contextId;
        volatile String sessionId;
        String mainFrameId;
        String loaderId;
        String url = BLANK;
        String title = "";
        boolean loading;
        boolean gone;
        /** Closed for its memory: a call on it then answers {@code too_large}, {@code memory}, never {@code not_found}. */
        volatile boolean overMemory;
        /** Main-frame navigations off the granted site cancelled. */
        final AtomicLong offSite = new AtomicLong();
        /** Document requests to a local host refused. */
        final AtomicLong blocked = new AtomicLong();
        /**
         * Navigations of the main frame requested in this tab: Chromium's renderer says so as a script or a click asks,
         * on the tab's session, so before the act's own reply.
         */
        final AtomicLong requested = new AtomicLong();
        /**
         * Navigations of the main frame begun: its load started, a move within the document, its document request
         * refused here, or one requested for another tab (a pop-up, closed on sight), which leaves nothing to wait for.
         */
        final AtomicLong starts = new AtomicLong();

        AgentTab(String id, String runId, String site, String contextId) {
            this.id = id;
            this.runId = runId;
            this.site = site;
            this.contextId = contextId;
            this.mainFrameId = id;
        }
    }

    /** One run's Browser. */
    private static final class RunState {
        final String runId;
        /** When its last Browser call began ({@link System#nanoTime}): its open tabs hold off a freeze for the hold from it. */
        volatile long lastUse = System.nanoTime();
        /** Its off-the-record context, or null until its first own tab. */
        String contextId;
        final Map<String, AgentTab> tabs = new LinkedHashMap<>();
        /** The sites the member granted this run. A grant stays for the run, its tab or not. */
        final Set<String> sites = new LinkedHashSet<>();
        /** One make of a context or a session tab at a time. */
        final ReentrantLock making = new ReentrantLock();
        /** Its tabs closed for their memory, the last {@link #OVER_MEMORY_KEPT}: a later call on one says why it's gone. */
        final Set<String> overMemory = new LinkedHashSet<>();

        RunState(String runId) {
            this.runId = runId;
        }
    }

    private final BrowserTabs tabs;
    private final BrowserFreeze freeze;
    private final BooleanSupplier freeDesk;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final Map<String, RunState> runs = new HashMap<>();
    /** Read on the read path and with BrowserTabs' lock held, so never behind {@code lock}. */
    private final Map<String, AgentTab> byTarget = new ConcurrentHashMap<>();
    private final Map<String, AgentTab> bySession = new ConcurrentHashMap<>();
    /** A frame's session that Chromium attached under an Agent tab, to the tab's id. */
    private final Map<String, String> frameSessions = new ConcurrentHashMap<>();
    private final Set<String> contexts = ConcurrentHashMap.newKeySet();
    /** Targets an Agent tab or context opened, being closed. */
    private final Set<String> closing = ConcurrentHashMap.newKeySet();
    private final Set<String> downloads = ConcurrentHashMap.newKeySet();
    /**
     * Sessions, targets and contexts that were the Agent's and went, the last {@link #WENT_KEPT} ({@link AgentCdp.Scope#went}):
     * each is added before it leaves the maps above, so a command racing its end is always one or the other.
     */
    private final Set<String> went = Collections.synchronizedSet(Collections.newSetFromMap(new LinkedHashMap<String, Boolean>() {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > WENT_KEPT;
        }
    }));
    private final AgentCdp cdp;
    private final AgentView view;
    /** How long a run's open tabs hold off a freeze after its last Browser call ({@link #HOLD}; tests shorten it). */
    private volatile Duration hold = HOLD;
    /** The cap on a tab's memory and how often it's looked at between calls ({@link #TAB_MEMORY_BYTES}; tests change them). */
    private volatile long memoryCap = TAB_MEMORY_BYTES;
    private volatile Duration memoryEvery = MEMORY_EVERY;
    /** The watch on open tabs' memory between calls, alive only while there are Agent tabs. Under {@code lock}. */
    private Thread memoryWatch;
    private volatile TabEvents walker;
    /** Chromium's default zoom as the Browser's zoom last set it, which an Agent tab's viewport is sized by. */
    private volatile double zoom = 1;
    /** Tabs being made, which count against the cap already. */
    private int making;
    private volatile boolean closed;

    /**
     * @param flags the simplified view's kill switch: off, this is unavailable
     * @param member the member's own simplified view, whose sensitive marks the Agent's walker follows
     * @param freeDesk whether the desk is a free one, with one Agent tab
     */
    AgentBrowsing(BrowserTabs tabs, BrowserFreeze freeze, MinifiedSwitch flags, MinifiedModule.Timing viewTiming, MinifiedModule member,
            BooleanSupplier freeDesk) {
        this.tabs = tabs;
        this.freeze = freeze;
        this.freeDesk = freeDesk;
        // Last: from here on the tab model asks this about every target and event.
        this.cdp = new AgentCdp(tabs.agentHook(this), new AgentCdp.Scope() {
            @Override
            public boolean session(String sessionId) {
                return agentSession(sessionId);
            }

            @Override
            public boolean target(String targetId) {
                return byTarget.containsKey(targetId) || closing.contains(targetId);
            }

            @Override
            public boolean context(String contextId) {
                return contexts.contains(contextId);
            }

            @Override
            public boolean script(String source) {
                AgentView own = view;
                return own != null && own.ownScript(source);
            }

            @Override
            public boolean went(String id) {
                return id != null && went.contains(id);
            }
        });
        this.view = AgentView.create(new Access(), flags, viewTiming, member);
    }

    // ---- AgentBrowser

    @Override
    public boolean available() {
        return !closed && view.on();
    }

    @Override
    public Tab tab(String runId, String tabId) {
        AgentTab tab = tabId == null ? null : byTarget.get(tabId);
        lock.lock();
        try {
            return tab == null || tab.gone || !tab.runId.equals(runId) ? null : snapshot(tab);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public List<Tab> tabs(String runId) {
        lock.lock();
        try {
            RunState run = runs.get(runId);
            List<Tab> list = new ArrayList<>();
            if (run != null) {
                for (AgentTab tab : run.tabs.values()) {
                    if (!tab.gone) {
                        list.add(snapshot(tab));
                    }
                }
            }
            return list;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public int agentTabs() {
        lock.lock();
        try {
            return tabsLocked() + making;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public int tabCap() {
        return freeDesk.getAsBoolean() ? FREE_TAB_CAP : TAB_CAP;
    }

    @Override
    public Set<String> sites(String runId) {
        lock.lock();
        try {
            RunState run = runs.get(runId);
            return run == null ? Set.of() : Set.copyOf(run.sites);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public Navigated open(String runId, String url) throws RpcException, InterruptedException {
        String target = checkUrl(url);
        requireAvailable();
        used(runId);
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            reserve();
            AgentTab tab;
            try {
                tab = create(runId, ownContext(runId), null);
            } finally {
                reserved();
            }
            Navigated navigated;
            try {
                navigated = go(tab, target);
            } catch (RpcException | CdpException e) {
                // A first page that didn't come leaves no tab holding a place.
                closeTab(tab);
                if (tab.overMemory) {
                    throw memoryGone();
                }
                throw e;
            }
            requireWithinMemory(tab);
            return navigated;
        } catch (CdpException e) {
            throw unavailable();
        }
    }

    @Override
    public Navigated navigate(String runId, String tabId, String url) throws RpcException, InterruptedException {
        String target = checkUrl(url);
        AgentTab tab = require(runId, tabId);
        if (tab.site != null && !tab.site.equals(siteOf(target))) {
            throw refused("off_site");
        }
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            Navigated navigated = go(tab, target);
            requireWithinMemory(tab);
            return navigated;
        } catch (RpcException e) {
            throw gone(tab, e);
        } catch (CdpException e) {
            throw gone(tab, unavailable());
        }
    }

    @Override
    public String backUrl(String runId, String tabId) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            Map<String, Object> entry = previousEntry(tab);
            return entry == null ? null : Json.string(entry, "url");
        } catch (CdpException e) {
            throw unavailable();
        }
    }

    @Override
    public Navigated back(String runId, String tabId) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            Map<String, Object> entry = previousEntry(tab);
            if (entry == null || !(entry.get("id") instanceof Number entryId)) {
                return new Navigated(tab.id, null);
            }
            if (tab.site != null && !tab.site.equals(siteOf(Json.string(entry, "url")))) {
                throw refused("off_site");
            }
            long offSite = tab.offSite.get();
            long blocked = tab.blocked.get();
            long requested = tab.requested.get();
            long starts = tab.starts.get();
            send(tab, "Page.navigateToHistoryEntry", Map.of("entryId", entryId), timing().request());
            settle(tab, requested, starts, true);
            refuseCancelled(tab, offSite, blocked);
            requireWithinMemory(tab);
            return new Navigated(tab.id, null);
        } catch (RpcException e) {
            throw gone(tab, e);
        } catch (CdpException e) {
            throw gone(tab, e.kind() == CdpException.Kind.REMOTE ? new RpcException(RpcException.NOT_FOUND, "Gone", Map.of("reason", "gone"))
                    : unavailable());
        }
    }

    @Override
    public void close(String runId, String tabId) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        closeTab(tab);
    }

    @Override
    public Navigated useSession(String runId, String site) throws RpcException, InterruptedException {
        if (!isSite(site)) {
            throw new RpcException(RpcException.BAD_REQUEST, "Not a site", Map.of("reason", "site"));
        }
        if (view.sensitiveSite(site)) {
            throw new RpcException(RpcException.FORBIDDEN, "Never for this site", Map.of("reason", "blocked"));
        }
        requireAvailable();
        RunState run = run(runId);
        used(runId);
        run.making.lockInterruptibly();
        try {
            lock.lock();
            try {
                for (AgentTab tab : run.tabs.values()) {
                    if (!tab.gone && site.equals(tab.site)) {
                        return new Navigated(tab.id, null);
                    }
                }
                if (!run.sites.contains(site) && run.sites.size() >= SITES_A_RUN) {
                    throw new RpcException(RpcException.FORBIDDEN, "Too many sites", Map.of("reason", "ask_cap"));
                }
            } finally {
                lock.unlock();
            }
            try (BrowserFreeze.Use use = freeze.use()) {
                requireReady();
                // A session tab is an Agent tab like any other: under the desk's cap (gap 4).
                reserve();
                AgentTab tab;
                try {
                    tab = create(runId, null, site);
                } finally {
                    reserved();
                }
                lock.lock();
                try {
                    run.sites.add(site);
                } finally {
                    lock.unlock();
                }
                log.info("agent browser: a site of the member's session granted for a run");
                try {
                    Navigated navigated = go(tab, "https://" + site + "/");
                    requireWithinMemory(tab);
                    return navigated;
                } catch (RpcException e) {
                    throw gone(tab, e);
                } catch (CdpException e) {
                    throw gone(tab, unavailable());
                }
            } catch (CdpException e) {
                throw unavailable();
            }
        } finally {
            run.making.unlock();
        }
    }

    @Override
    public Map<String, Object> read(String runId, String tabId) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        requireAvailable();
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            readTitle(tab);
            Map<String, Object> reply = view.read(tab.id);
            for (int i = 0; i < PENDING_TRIES && "pending".equals(reply.get("view")); i++) {
                Thread.sleep(PENDING_PAUSE);
                readTitle(tab);
                reply = view.read(tab.id);
            }
            requireWithinMemory(tab);
            return reply;
        } catch (RpcException e) {
            throw gone(tab, e);
        }
    }

    /** A hidden target's title, which Chromium tells nobody of as it changes: asked for at each read. */
    private void readTitle(AgentTab tab) throws InterruptedException {
        try {
            Map<String, Object> info = Json.object(cdp.send(null, "Target.getTargetInfo", Map.of("targetId", tab.id), timing().request()),
                    "targetInfo");
            String title = info == null ? null : Json.string(info, "title");
            if (title != null) {
                lock.lock();
                try {
                    // A page without a title of its own is called by its address there: that's no title.
                    tab.title = title.equals(Json.string(info, "url")) ? "" : TabText.clean(title, BrowserTabs.TITLE_CHARS);
                } finally {
                    lock.unlock();
                }
            }
        } catch (CdpException e) {
            log.debug("agent browser: a tab's title wasn't read: {}", e.kind());
        }
    }

    @Override
    public Map<String, Object> act(String runId, String tabId, String nodeId, String action, Object value, String fp, String block, long rev,
            boolean spend, boolean submit) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        requireAvailable();
        long offSite = tab.offSite.get();
        long blocked = tab.blocked.get();
        long requested = tab.requested.get();
        long starts = tab.starts.get();
        // Where deskd's half said the act goes, if anywhere: then it waits for that navigation to start.
        String[] goes = new String[1];
        Map<String, Object> done;
        try {
            done = view.act(tab.id, nodeId, action, value, fp, block, rev, url -> {
                goes[0] = url;
                return navRefusal(tab, url);
            }, spend, submit);
        } catch (RpcException e) {
            // Not done: a tab closed for its memory before the act says so.
            throw gone(tab, e);
        }
        boolean navigates = goes[0] != null && (goes[0].startsWith("http:") || goes[0].startsWith("https:"));
        // The act is done from here: what followed it goes in its answer, never as a failure, so an approved send or
        // spend never reads as not done and is never asked for again (Security's BB-L5).
        Map<String, Object> answer = new LinkedHashMap<>(done);
        try (BrowserFreeze.Use use = freeze.use()) {
            settle(tab, requested, starts, navigates || Boolean.TRUE.equals(done.get("submitted")));
            if (tab.offSite.get() != offSite) {
                answer.put("stopped", "off_site");
            } else if (tab.blocked.get() != blocked) {
                answer.put("stopped", "blocked");
            }
            if (tab.overMemory || overMemoryNow(tab)) {
                answer.put("closed", "memory");
            }
        }
        return answer;
    }

    /**
     * Where an Agent click or Enter may navigate, checked before it's done: null to let it go, {@code off_site} for
     * another site in a member-session tab, {@code blocked} for a local host or another scheme. A {@code javascript:}
     * link is the page's own script, whose navigation, if any, stops at the request as every one does.
     */
    static String navRefusal(AgentTab tab, String url) {
        int colon = url.indexOf(':');
        String scheme = colon > 0 ? url.substring(0, colon).toLowerCase(Locale.ROOT) : "";
        if (scheme.equals("javascript")) {
            return null;
        }
        String host = scheme.equals("http") || scheme.equals("https") ? AgentView.hostOf(url) : null;
        if (host == null || isLocalHost(host)) {
            return "blocked";
        }
        return tab.site != null && !tab.site.equals(AgentView.site(host)) ? "off_site" : null;
    }

    @Override
    public Map<String, Object> actLook(String runId, String tabId, String nodeId, String fp, String key)
            throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        requireAvailable();
        try {
            return view.actLook(tab.id, nodeId, fp, key);
        } catch (RpcException e) {
            throw gone(tab, e);
        }
    }

    @Override
    public boolean paymentFrame(String runId, String tabId) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        requireAvailable();
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            // Chromium's own frame tree, every frame's address, the tab's and each out-of-process frame's.
            List<String> sessions = new ArrayList<>();
            String own = tab.sessionId;
            if (own != null) {
                sessions.add(own);
            }
            for (Map.Entry<String, String> frame : frameSessions.entrySet()) {
                if (tab.id.equals(frame.getValue())) {
                    sessions.add(frame.getKey());
                }
            }
            for (String session : sessions) {
                Map<String, Object> tree;
                try {
                    tree = cdp.send(session, "Page.getFrameTree", Map.of(), timing().request());
                } catch (CdpException e) {
                    if (session.equals(own)) {
                        // The tab itself unread: as if there were one, so a click asks as a spend.
                        return true;
                    }
                    continue; // A frame that went has nothing in it.
                }
                if (payingFrame(Json.object(tree, "frameTree"), 0)) {
                    return true;
                }
            }
        }
        // And deskd's half's own look at the document, as the act checks it again.
        return view.paymentFrame(tab.id);
    }

    private boolean payingFrame(Map<String, Object> node, int depth) {
        if (node == null || depth > 32) {
            return false;
        }
        Map<String, Object> frame = Json.object(node, "frame");
        if (frame != null && view.paymentHost(AgentView.hostOf(Json.string(frame, "url")))) {
            return true;
        }
        if (node.get("childFrames") instanceof List<?> children) {
            for (Object child : children) {
                if (child instanceof Map<?, ?> map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> typed = (Map<String, Object>) map;
                    if (payingFrame(typed, depth + 1)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    @Override
    public boolean refusedAsSensitive(String runId, String tabId, String nodeId) {
        return view.refusedAsSensitive(tabId, nodeId);
    }

    @Override
    public boolean sensitiveSite(String site) {
        return view.sensitiveSite(site);
    }

    @Override
    public boolean paymentHost(String host) {
        return view.paymentHost(host);
    }

    @Override
    public void runEnded(String runId) {
        RunState run;
        lock.lock();
        try {
            run = runs.remove(runId);
        } finally {
            lock.unlock();
        }
        if (run != null) {
            Thread.ofVirtual().name("agent-browser-end").start(() -> letGo(run));
        }
    }

    /**
     * As deskd stops: every run's tabs and contexts go, for up to {@link #CLOSE_WAIT}, before the connection does. Chromium
     * drops them with the connection anyway: hidden targets live no longer, and the contexts were made to go with it.
     */
    void close() {
        closed = true;
        List<RunState> all;
        lock.lock();
        try {
            all = new ArrayList<>(runs.values());
            runs.clear();
        } finally {
            lock.unlock();
        }
        List<Thread> going = new ArrayList<>();
        for (RunState run : all) {
            going.add(Thread.ofVirtual().name("agent-browser-close").start(() -> letGo(run)));
        }
        long deadline = System.nanoTime() + CLOSE_WAIT.toNanos();
        try {
            for (Thread thread : going) {
                long left = deadline - System.nanoTime();
                if (left > 0) {
                    thread.join(Duration.ofNanos(left));
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        view.close();
    }

    /** How long deskd's stop waits for the Agent's tabs and contexts to go. */
    static final Duration CLOSE_WAIT = Duration.ofSeconds(2);

    /**
     * The most an Agent tab's page may hold (the draft ADR's §17 Browser row; the Browser bar's gap 7): its V8 heap as
     * committed, Blink's own heap and its array buffers' backing stores, in its own process and every out-of-process frame
     * of it, by Chromium's {@code Runtime.getHeapUsage}. A tab past it is closed, and the call answers {@code too_large},
     * {@code memory}. It leaves out what Chromium doesn't count there (the GPU's tiles, decoded images' caches, the
     * process's own code), which the corpus run measures beside it.
     */
    static final long TAB_MEMORY_BYTES = 300L * 1024 * 1024;
    /** How often open Agent tabs are looked at between calls, while Chromium isn't frozen. */
    static final Duration MEMORY_EVERY = Duration.ofSeconds(30);

    /**
     * How long a run's open tabs hold off a freeze after its last Browser call (the Browser bar's gap 6; ADR 0045): a
     * freeze closes deskd's connection to Chromium, and every Agent tab with it, so a card the member answers a few
     * minutes later would find its page gone, typed text and all. Past this, the freeze may come as before, and a later
     * call on a tab it closed answers {@code not_found}. A run's end closes its tabs at once, so only a run still going,
     * most often one waiting on the member's yes, holds anything.
     */
    static final Duration HOLD = Duration.ofMinutes(10);

    /** For tests: a shorter hold. */
    void holdFor(Duration hold) {
        this.hold = hold;
    }

    /**
     * Whether a run holds Chromium from a freeze: one with a tab open whose last Browser call began under {@link #HOLD}
     * ago. Asked by the freeze's worker; never blocks on Chromium.
     */
    boolean holdsChromium() {
        long now = System.nanoTime();
        long within = hold.toNanos();
        lock.lock();
        try {
            for (RunState run : runs.values()) {
                if (now - run.lastUse >= within) {
                    continue;
                }
                for (AgentTab tab : run.tabs.values()) {
                    if (!tab.gone) {
                        return true;
                    }
                }
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    /** For tests: another cap on a tab's memory, and another pace for the watch between calls. */
    void memoryCap(long bytes, Duration every) {
        this.memoryCap = bytes;
        this.memoryEvery = every;
    }

    /**
     * What a tab's page holds now, in bytes, by Chromium's {@code Runtime.getHeapUsage} on the tab's own session and each
     * of its out-of-process frames' ({@link #TAB_MEMORY_BYTES}): the V8 heap committed, Blink's heap and array buffers'
     * stores. A session that doesn't answer counts nothing. Never thaws Chromium: a caller that may not reach it asks
     * nothing.
     */
    long memoryOf(AgentTab tab) throws InterruptedException {
        return heaps(tab, null).total();
    }

    /**
     * Past the cap by what its page holds: a first look over it is taken again after a full collection in each of the
     * tab's renderers, as V8 keeps what earlier pages left until it collects (the bench read a heavy tab at 1,375 MB that
     * held 22 to 28 MB once collected). The collection costs the page a pause, only when the first look is over. A
     * process the second look can't read keeps its first look's figure (Security's BB-L6): a heap too big to collect in
     * time is never let off for it.
     */
    private boolean pastCap(AgentTab tab) throws InterruptedException {
        Heaps first = heaps(tab, null);
        return first.total() > memoryCap && heaps(tab, first).total() > memoryCap;
    }

    /**
     * Each renderer process's figure in a look at a tab, by its isolate's id, or by the session's when that can't be
     * read, and which key each session's figure went under.
     */
    private record Heaps(Map<String, Long> byKey, Map<String, String> keyOfSession) {
        long total() {
            long sum = 0;
            for (long held : byKey.values()) {
                sum += held;
            }
            return sum;
        }
    }

    /**
     * @param first null for a look as it is; else the first look, after which each process is collected before it's
     *     read, with the load's wait for both, and one that can't be read again keeps its figure from there
     */
    private Heaps heaps(AgentTab tab, Heaps first) throws InterruptedException {
        List<String> sessions = new ArrayList<>();
        String own = tab.sessionId;
        if (own != null) {
            sessions.add(own);
        }
        for (Map.Entry<String, String> frame : frameSessions.entrySet()) {
            if (tab.id.equals(frame.getValue())) {
                sessions.add(frame.getKey());
            }
        }
        Map<String, Long> byKey = new LinkedHashMap<>();
        Map<String, String> keyOfSession = new HashMap<>();
        // A collection and the read behind it can take as long as the heap is big; neither is ever on the read path.
        Duration wait = first == null ? timing().request() : timing().navigate();
        for (String session : sessions) {
            // One renderer process's isolate can hold several of the tab's frames: each counted once (BB-I4). An id
            // that can't be read counts the session as an isolate of its own, never as nothing.
            String isolate = null;
            try {
                isolate = Json.string(cdp.send(session, "Runtime.getIsolateId", Map.of(), timing().request()), "id");
            } catch (CdpException e) {
                log.debug("agent browser: a frame's isolate wasn't read: {}", e.kind());
            } catch (AgentCdp.NotAllowed e) {
                log.debug("agent browser: a frame went before its isolate was read");
            }
            String key = isolate != null ? isolate
                    : first != null && first.keyOfSession().get(session) != null ? first.keyOfSession().get(session)
                    : "session:" + session;
            keyOfSession.put(session, key);
            if (byKey.containsKey(key)) {
                continue;
            }
            try {
                if (first != null) {
                    try {
                        cdp.send(session, "HeapProfiler.collectGarbage", Map.of(), wait);
                    } catch (CdpException e) {
                        // Not collected: the heap is read as it is.
                        log.debug("agent browser: a frame's heap wasn't collected: {}", e.kind());
                    }
                }
                Map<String, Object> usage = cdp.send(session, "Runtime.getHeapUsage", Map.of(), wait);
                byKey.put(key, bytes(usage, "totalSize") + bytes(usage, "embedderHeapUsedSize") + bytes(usage, "backingStorageSize"));
            } catch (CdpException e) {
                log.debug("agent browser: a tab's memory wasn't read: {}", e.kind());
                // A process that's slow to collect or answer keeps its figure; a frame that went holds nothing now.
                if (e.kind() != CdpException.Kind.REMOTE || e.code() != CdpException.SESSION_NOT_FOUND) {
                    keepFirst(first, key, session, byKey);
                }
            } catch (AgentCdp.NotAllowed e) {
                // A frame's session that went between the list and the ask (Security's BB-L4): nothing to count.
                log.debug("agent browser: a frame went before its memory was read");
            }
        }
        return new Heaps(byKey, keyOfSession);
    }

    /**
     * A process the second look couldn't read keeps its first look's figure: under its key now, or under the key its
     * session had then (an isolate id that couldn't be read in the first look and could in the second).
     */
    private static void keepFirst(Heaps first, String key, String session, Map<String, Long> byKey) {
        if (first == null) {
            return;
        }
        Long before = first.byKey().get(key);
        if (before == null && first.keyOfSession().get(session) != null) {
            before = first.byKey().get(first.keyOfSession().get(session));
        }
        if (before != null) {
            byKey.put(key, before);
        }
    }

    private static long bytes(Map<String, Object> usage, String key) {
        return usage != null && usage.get(key) instanceof Number n && n.doubleValue() > 0 ? n.longValue() : 0;
    }

    /**
     * A tab past the cap is closed, and the call that found it answers {@code too_large}, {@code memory}: as does a call
     * whose tab the watch closed under it.
     */
    private void requireWithinMemory(AgentTab tab) throws RpcException, InterruptedException {
        // Closed by the watch while the call waited (a page that grew as it loaded), or past the cap now.
        if (tab.overMemory || overMemoryNow(tab)) {
            throw memoryGone();
        }
    }

    private RpcException memoryGone() {
        return new RpcException(RpcException.TOO_LARGE, "The page held more memory than an agent tab may",
                Map.of("reason", "memory", "limit", memoryCap / (1024 * 1024)));
    }

    /**
     * What a call answers when its tab went under it: {@code too_large}, {@code memory} if the cap closed it (between
     * calls, by the watch, or by another call), so a model never takes a page too big for a tab as one to open again.
     */
    private RpcException gone(AgentTab tab, RpcException e) {
        return tab.overMemory ? memoryGone() : e;
    }

    /** Whether the tab was past the cap just now, and so closed. */
    private boolean overMemoryNow(AgentTab tab) throws InterruptedException {
        if (tab.gone || !cdp.connected() || !freeze.cdpAllowed()) {
            return false;
        }
        if (pastCap(tab)) {
            overMemory(tab);
            return true;
        }
        return false;
    }

    private void overMemory(AgentTab tab) throws InterruptedException {
        if (byTarget.get(tab.id) != tab) {
            return;
        }
        tab.overMemory = true;
        lock.lock();
        try {
            RunState run = runs.get(tab.runId);
            if (run != null) {
                run.overMemory.add(tab.id);
                if (run.overMemory.size() > OVER_MEMORY_KEPT) {
                    run.overMemory.remove(run.overMemory.iterator().next());
                }
            }
        } finally {
            lock.unlock();
        }
        // A count, never which page.
        log.info("agent browser: a tab past its memory was closed");
        closeTab(tab);
    }

    /** Under {@code lock}: the watch on open tabs' memory, started with the first tab and ending with the last. */
    private void watchMemoryLocked() {
        if (memoryWatch == null && !closed) {
            memoryWatch = Thread.ofVirtual().name("agent-browser-memory").start(this::memoryLoop);
        }
    }

    /**
     * Every {@link #MEMORY_EVERY} while there are Agent tabs: a tab whose page grew past the cap between calls is closed (a
     * run waiting on the member's yes keeps its tabs thawed for up to {@link #HOLD}). Skipped while Chromium is frozen or
     * away, when nothing in it runs; it never thaws Chromium or holds off a freeze.
     */
    private void memoryLoop() {
        try {
            memoryLoopUntilDone();
        } finally {
            // However it ended, the next tab starts a watch again (Security's BB-L4).
            lock.lock();
            try {
                if (memoryWatch == Thread.currentThread()) {
                    memoryWatch = null;
                }
            } finally {
                lock.unlock();
            }
        }
    }

    private void memoryLoopUntilDone() {
        try {
            while (true) {
                Thread.sleep(memoryEvery);
                List<AgentTab> open = new ArrayList<>();
                lock.lock();
                try {
                    for (AgentTab tab : byTarget.values()) {
                        if (!tab.gone) {
                            open.add(tab);
                        }
                    }
                    if (open.isEmpty() || closed) {
                        memoryWatch = null;
                        return;
                    }
                } finally {
                    lock.unlock();
                }
                if (!cdp.connected() || !freeze.cdpAllowed()) {
                    continue;
                }
                for (AgentTab tab : open) {
                    try {
                        if (!tab.gone && byTarget.get(tab.id) == tab && pastCap(tab)) {
                            overMemory(tab);
                        }
                    } catch (RuntimeException e) {
                        // One tab's trouble (a target gone between the list and its close) never ends the watch.
                        log.debug("agent browser: a tab's memory look failed: {}", e.getClass().getSimpleName());
                    }
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** A Browser call of this run's begins: its tabs hold off a freeze for {@link #hold} from now. */
    private void used(String runId) {
        lock.lock();
        try {
            RunState run = runs.get(runId);
            if (run != null) {
                run.lastUse = System.nanoTime();
            }
        } finally {
            lock.unlock();
        }
    }

    // ---- making tabs

    /** A place under the cap for a tab about to be made, its own context's or the member's session's (gap 4). */
    private void reserve() throws RpcException {
        lock.lock();
        try {
            int cap = tabCap();
            if (tabsLocked() + making >= cap) {
                throw new RpcException(RpcException.FORBIDDEN, "Too many agent tabs", Map.of("reason", "tab_cap", "limit", cap));
            }
            making++;
        } finally {
            lock.unlock();
        }
    }

    private void reserved() {
        lock.lock();
        try {
            making--;
        } finally {
            lock.unlock();
        }
    }

    /** Every Agent tab on the desk, in its own contexts and in the member's session alike: each is a tab's memory. */
    private int tabsLocked() {
        int count = 0;
        for (AgentTab tab : byTarget.values()) {
            count += tab.gone ? 0 : 1;
        }
        return count;
    }

    /** The run's own off-the-record context, made at its first own tab, with downloads denied in it. */
    private String ownContext(String runId) throws CdpException, InterruptedException, RpcException {
        RunState run = run(runId);
        run.making.lockInterruptibly();
        try {
            lock.lock();
            try {
                if (run.contextId != null && contexts.contains(run.contextId)) {
                    return run.contextId;
                }
            } finally {
                lock.unlock();
            }
            Map<String, Object> made = cdp.send(null, "Target.createBrowserContext", Map.of("disposeOnDetach", true), timing().request());
            String contextId = Json.string(made, "browserContextId");
            if (!isPlainId(contextId)) {
                throw unavailable();
            }
            contexts.add(contextId);
            try {
                // eventsEnabled as the member's own: the flag may be the connection's, and the member's downloads keep it.
                cdp.send(null, "Browser.setDownloadBehavior",
                        Map.of("behavior", "deny", "browserContextId", contextId, "eventsEnabled", true), timing().request());
            } catch (CdpException e) {
                dispose(contextId);
                throw e;
            }
            lock.lock();
            try {
                run.contextId = contextId;
            } finally {
                lock.unlock();
            }
            return contextId;
        } finally {
            run.making.unlock();
        }
    }

    /**
     * A hidden target, about:blank first, so its viewport, its requests' stop and Page are set before any page loads.
     *
     * @param contextId the run's own context, or null for the member's own, with {@code site} the granted site
     */
    private AgentTab create(String runId, String contextId, String site) throws CdpException, InterruptedException, RpcException {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("url", BLANK);
        params.put("hidden", true);
        params.put("background", true);
        if (contextId != null) {
            params.put("browserContextId", contextId);
        }
        // Taken on the read path, in its place among the events: from here on, anything about it is the Agent's.
        Map<String, Object> created = cdp.sendBrowser("Target.createTarget", params, timing().request(), reply -> {
            String id = Json.string(reply, "targetId");
            if (isPlainId(id)) {
                register(new AgentTab(id, runId, site, contextId));
            }
        });
        AgentTab tab = byTarget.get(Json.string(created, "targetId"));
        if (tab == null) {
            throw unavailable();
        }
        try {
            requireHidden(tab);
            attach(tab);
        } catch (CdpException | RpcException | RuntimeException e) {
            closeTab(tab);
            // The watch closed it as it was made: a page can't be over the cap yet, but a blank one in a full process can.
            if (tab.overMemory) {
                throw memoryGone();
            }
            throw e;
        }
        return tab;
    }

    /**
     * A hidden target isn't listed and has no window. One that is, or has, could be on the member's screen: a Chromium
     * that didn't take {@code hidden}. It's closed by the caller, and the call refused.
     */
    private void requireHidden(AgentTab tab) throws CdpException, InterruptedException, RpcException {
        Map<String, Object> listed = cdp.send(null, "Target.getTargets", Map.of(), timing().request());
        if (listed.get("targetInfos") instanceof List<?> infos) {
            for (Object info : infos) {
                if (info instanceof Map<?, ?> map && tab.id.equals(map.get("targetId"))) {
                    log.warn("agent browser: chromium listed a hidden target; refused");
                    throw unavailable();
                }
            }
        }
        try {
            cdp.send(null, "Browser.getWindowForTarget", Map.of("targetId", tab.id), timing().request());
        } catch (CdpException e) {
            if (e.kind() == CdpException.Kind.REMOTE) {
                return; // No window: as it should be.
            }
            throw e;
        }
        log.warn("agent browser: a hidden target had a window; refused");
        throw unavailable();
    }

    private void attach(AgentTab tab) throws CdpException, InterruptedException, RpcException {
        Map<String, Object> attached = cdp.send(null, "Target.attachToTarget", Map.of("targetId", tab.id, "flatten", true), timing().request());
        String session = Json.string(attached, "sessionId");
        if (!isPlainId(session)) {
            throw unavailable();
        }
        tab.sessionId = session;
        bySession.put(session, tab);
        Duration request = timing().request();
        cdp.send(session, "Page.enable", Map.of(), request);
        // A hidden target's viewport is 0x0, where nothing is visible and nothing can be hit: the walker needs a page. Sized
        // by the Browser's zoom, which Chromium applies to the Agent's tabs too, so the page is 1280x800 at a ratio of 1.
        cdp.send(session, "Emulation.setDeviceMetricsOverride", viewport(zoom), request);
        // A hidden target never has the page's focus, so a field's focus event, where a page may turn it into a password
        // one, would never fire for the Agent's click or key: the page is told it has focus, as a member's tab on screen
        // has (S-14). Only this page's own idea of focus; nothing on screen moves.
        cdp.send(session, "Emulation.setFocusEmulationEnabled", Map.of("enabled", true), request);
        cdp.send(session, "Fetch.enable", Map.of("patterns", DOCUMENTS), request);
        // Every frame in a process of its own is held at its start from the first page on, until its own requests stop
        // here too (the walker's frameAttached): without it, one the first page loads would be in no session of deskd's.
        cdp.send(session, "Target.setAutoAttach", FRAMES, request);
    }

    /**
     * The viewport an Agent tab gets, at Chromium's default zoom {@code zoom}: Chromium's page zoom covers the Agent's
     * contexts and the member's alike (Chrome for Testing 156 and 158), so the device's pixels are the zoom times 1280x800
     * and its scale factor one over it. The page then lays out at 1280x800 CSS pixels with a {@code devicePixelRatio} of 1,
     * as at 100%, whatever the member's level.
     */
    static Map<String, Object> viewport(double zoom) {
        if (!(zoom > 0) || Math.abs(zoom - 1) < BrowserZoom.SAME) {
            return Map.of("width", WIDTH, "height", HEIGHT, "deviceScaleFactor", 1, "mobile", false);
        }
        return Map.of(
                "width", (int) Math.round(WIDTH * zoom), "height", (int) Math.round(HEIGHT * zoom), "deviceScaleFactor", 1 / zoom,
                "mobile", false);
    }

    /**
     * Chromium's default zoom is now {@code factor} ({@link BrowserZoom}): every Agent tab's viewport is set for it again, so
     * it stays at 100%. A tab that doesn't take it is left; its next page is still the Agent's. Must not be called under
     * {@code lock}.
     */
    void zoomChanged(double factor) {
        zoom = factor;
        if (closed) {
            return;
        }
        Map<String, Object> metrics = viewport(factor);
        for (AgentTab tab : bySession.values()) {
            try {
                send(tab, "Emulation.setDeviceMetricsOverride", metrics, timing().request());
            } catch (CdpException e) {
                log.debug("agent browser: a tab's viewport wasn't set for the zoom: {}", e.kind());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void register(AgentTab tab) {
        byTarget.put(tab.id, tab);
        lock.lock();
        try {
            RunState run = runs.computeIfAbsent(tab.runId, RunState::new);
            run.tabs.put(tab.id, tab);
            watchMemoryLocked();
        } finally {
            lock.unlock();
        }
    }

    // ---- navigating

    private Navigated go(AgentTab tab, String url) throws CdpException, InterruptedException, RpcException {
        long offSite = tab.offSite.get();
        long blocked = tab.blocked.get();
        Map<String, Object> reply;
        try {
            reply = send(tab, "Page.navigate", Map.of("url", url), timing().navigate());
        } catch (CdpException e) {
            if (e.kind() != CdpException.Kind.TIMEOUT) {
                throw e;
            }
            reply = Map.of();
        }
        String error = Json.string(reply, "errorText");
        awaitLoaded(tab);
        // A hop of a redirect, or the page's own navigation as it loaded, that was cancelled: the call says so.
        refuseCancelled(tab, offSite, blocked);
        if (BLOCKED_BY_ADMINISTRATOR.equals(error)) {
            throw new RpcException(RpcException.FORBIDDEN, "Blocked by the desk's policy", Map.of("reason", "blocked"));
        }
        return new Navigated(tab.id, error == null || error.isEmpty() ? null : TabText.clean(error, 128));
    }

    /**
     * After an act or Back: no fixed wait (the Browser bar's gap 5). A navigation a script or the act itself asked for in
     * this tab was requested before the act's reply came, on the same session, so it's known here already; that one, and
     * one deskd's half said the act starts (a link, a submit, Back), get up to {@link #NAV_START} to begin (its load
     * starts, it moves within the document, or its request is refused here); then whatever loads is waited for, within
     * the load wait. A navigation the page starts later, on a timer, isn't waited for: its requests stop here as every one
     * does, and the next read shows where it went.
     *
     * @param requestedBefore the tab's requested count as the act began
     * @param startsBefore the tab's starts count as the act began
     * @param expected deskd's half said the act navigates
     */
    private void settle(AgentTab tab, long requestedBefore, long startsBefore, boolean expected) throws InterruptedException {
        if (expected || tab.requested.get() != requestedBefore) {
            long left = NAV_START.toNanos();
            lock.lockInterruptibly();
            try {
                while (tab.starts.get() == startsBefore && !tab.gone && left > 0) {
                    left = changed.awaitNanos(left);
                }
            } finally {
                lock.unlock();
            }
        }
        awaitLoaded(tab);
    }

    /** A navigation of the tab's main frame began. It signals the waiters. */
    private void started(AgentTab tab) {
        lock.lock();
        try {
            tab.starts.incrementAndGet();
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    private void awaitLoaded(AgentTab tab) throws InterruptedException {
        long left = timing().navigate().toNanos();
        lock.lockInterruptibly();
        try {
            while (tab.loading && !tab.gone && left > 0) {
                left = changed.awaitNanos(left);
            }
        } finally {
            lock.unlock();
        }
    }

    private void refuseCancelled(AgentTab tab, long offSite, long blocked) throws RpcException {
        if (tab.offSite.get() != offSite) {
            throw refused("off_site");
        }
        if (tab.blocked.get() != blocked) {
            throw new RpcException(RpcException.FORBIDDEN, "Not a site the agent may open", Map.of("reason", "blocked"));
        }
    }

    private Map<String, Object> previousEntry(AgentTab tab) throws CdpException, InterruptedException {
        Map<String, Object> history = send(tab, "Page.getNavigationHistory", Map.of(), timing().request());
        if (history.get("currentIndex") instanceof Number index && history.get("entries") instanceof List<?> entries
                && index.intValue() > 0 && index.intValue() <= entries.size()
                && entries.get(index.intValue() - 1) instanceof Map<?, ?> entry) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) entry;
            String url = Json.string(typed, "url");
            // The blank page every Agent tab starts on is nowhere to go back to.
            return url == null || BLANK.equals(url) ? null : typed;
        }
        return null;
    }

    // ---- letting go

    private void closeTab(AgentTab tab) throws InterruptedException {
        lock.lock();
        try {
            tab.gone = true;
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        if (cdp.connected() && freeze.cdpAllowed()) {
            try {
                cdp.send(null, "Target.closeTarget", Map.of("targetId", tab.id), timing().request());
            } catch (CdpException e) {
                log.debug("agent browser: a tab's close failed: {}", e.kind());
            } catch (AgentCdp.NotAllowed e) {
                // Forgotten already (it went, or another close came first): nothing of the Agent's to close.
                log.debug("agent browser: a tab was gone before its close");
            }
        }
        forget(tab);
    }

    /** A run's tabs closed and its context disposed, without a thaw: a frozen Chromium has neither any more. */
    private void letGo(RunState run) {
        List<AgentTab> its;
        String contextId;
        lock.lock();
        try {
            its = new ArrayList<>(run.tabs.values());
            contextId = run.contextId;
        } finally {
            lock.unlock();
        }
        try {
            for (AgentTab tab : its) {
                closeTab(tab);
            }
            if (contextId != null) {
                dispose(contextId);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void dispose(String contextId) throws InterruptedException {
        if (cdp.connected() && freeze.cdpAllowed() && contexts.contains(contextId)) {
            try {
                cdp.send(null, "Target.disposeBrowserContext", Map.of("browserContextId", contextId), timing().request());
            } catch (CdpException e) {
                log.debug("agent browser: a context's dispose failed: {}", e.kind());
            }
        }
        went.add(contextId);
        contexts.remove(contextId);
    }

    private void forget(AgentTab tab) {
        went.add(tab.id);
        String session = tab.sessionId;
        if (session != null) {
            went.add(session);
        }
        for (Map.Entry<String, String> frame : frameSessions.entrySet()) {
            if (tab.id.equals(frame.getValue())) {
                went.add(frame.getKey());
            }
        }
        byTarget.remove(tab.id, tab);
        if (session != null) {
            bySession.remove(session, tab);
        }
        frameSessions.values().removeIf(tab.id::equals);
        lock.lock();
        try {
            RunState run = runs.get(tab.runId);
            if (run != null) {
                run.tabs.remove(tab.id, tab);
            }
        } finally {
            lock.unlock();
        }
        TabEvents events = walker;
        if (events != null) {
            events.onTabGone(tab.id);
        }
    }

    // ---- BrowserTabs.AgentTargets: on the read path, or with the tab model's lock held

    @Override
    public boolean owns(Map<String, Object> info) {
        String id = Json.string(info, "targetId");
        String context = Json.string(info, "browserContextId");
        String opener = Json.string(info, "openerId");
        return id != null && (byTarget.containsKey(id) || closing.contains(id))
                || context != null && contexts.contains(context)
                || opener != null && byTarget.containsKey(opener);
    }

    @Override
    public boolean wanted() {
        return !byTarget.isEmpty();
    }

    @Override
    public boolean onEvent(String method, String sessionId, Map<String, Object> params) {
        if (sessionId != null) {
            AgentTab tab = bySession.get(sessionId);
            String frameOf = tab == null ? frameSessions.get(sessionId) : null;
            if (tab == null && frameOf == null) {
                return false;
            }
            if (tab != null) {
                onTabEvent(tab, sessionId, method, params);
            } else if ("Fetch.requestPaused".equals(method)) {
                // A frame's own document request, in a process of its own (S-14): a local host is refused there too.
                AgentTab owner = byTarget.get(frameOf);
                onRequestPaused(owner, sessionId, params, true);
            }
            if ("Target.attachedToTarget".equals(method) && frameSessions.size() < MAX_FRAME_SESSIONS) {
                String child = Json.string(params, "sessionId");
                if (isPlainId(child)) {
                    frameSessions.put(child, tab != null ? tab.id : frameOf);
                }
            } else if ("Target.detachedFromTarget".equals(method)) {
                String child = Json.string(params, "sessionId");
                if (child != null && frameSessions.containsKey(child)) {
                    went.add(child);
                    frameSessions.remove(child);
                }
            }
            TabEvents events = walker;
            if (events != null && !"Fetch.requestPaused".equals(method)) {
                events.onEvent(method, sessionId, tab != null ? tab.id : null, params);
            }
            return true;
        }
        switch (method) {
            case "Target.targetCreated", "Target.targetInfoChanged" -> {
                Map<String, Object> info = Json.object(params, "targetInfo");
                if (info == null || !owns(info)) {
                    return false;
                }
                String id = Json.string(info, "targetId");
                if (id != null && !byTarget.containsKey(id) && closing.add(id)) {
                    // A pop-up or a stray of the Agent's: never a member's tab, and never left open.
                    log.info("agent browser: closing a target an agent tab opened");
                    Thread.ofVirtual().name("agent-browser-stray").start(() -> closeStray(id));
                }
                return true;
            }
            case "Target.targetDestroyed", "Target.targetCrashed" -> {
                String id = Json.string(params, "targetId");
                if (id != null && closing.contains(id)) {
                    went.add(id);
                    closing.remove(id);
                    return true;
                }
                AgentTab tab = id == null ? null : byTarget.get(id);
                if (tab == null) {
                    return false;
                }
                lock.lock();
                try {
                    tab.gone = true;
                    changed.signalAll();
                } finally {
                    lock.unlock();
                }
                // Off the read path: the walker hears of it there, as the member's does.
                Thread.ofVirtual().name("agent-browser-gone").start(() -> forget(tab));
                return true;
            }
            case "Target.attachedToTarget" -> {
                Map<String, Object> info = Json.object(params, "targetInfo");
                return info != null && owns(info);
            }
            case "Target.detachedFromTarget" -> {
                String session = Json.string(params, "sessionId");
                String id = Json.string(params, "targetId");
                return session != null && bySession.containsKey(session) || id != null && (byTarget.containsKey(id) || closing.contains(id));
            }
            case "Browser.downloadWillBegin" -> {
                String frame = Json.string(params, "frameId");
                String guid = Json.string(params, "guid");
                if (frame == null || !byTarget.containsKey(frame)) {
                    return false;
                }
                if (guid != null && downloads.size() < MAX_DOWNLOADS) {
                    downloads.add(guid);
                }
                return true;
            }
            case "Browser.downloadProgress" -> {
                String guid = Json.string(params, "guid");
                if (guid == null || !downloads.contains(guid)) {
                    return false;
                }
                if (!"inProgress".equals(Json.string(params, "state"))) {
                    downloads.remove(guid);
                }
                return true;
            }
            default -> {
                return false;
            }
        }
    }

    /** An event on an Agent tab's own session. On the read path. */
    private void onTabEvent(AgentTab tab, String sessionId, String method, Map<String, Object> params) {
        switch (method) {
            case "Fetch.requestPaused" -> onRequestPaused(tab, sessionId, params, false);
            case "Page.frameRequestedNavigation" -> {
                String frameId = Json.string(params, "frameId");
                if (frameId != null && (frameId.equals(tab.mainFrameId) || frameId.equals(tab.id))) {
                    if ("currentTab".equals(Json.string(params, "disposition"))) {
                        tab.requested.incrementAndGet();
                    } else {
                        // A pop-up or a download: nothing loads here for it.
                        started(tab);
                    }
                }
            }
            case "Page.frameNavigated" -> {
                Map<String, Object> frame = Json.object(params, "frame");
                if (frame != null && frame.get("parentId") == null) {
                    lock.lock();
                    try {
                        String frameId = Json.string(frame, "id");
                        if (isPlainId(frameId)) {
                            tab.mainFrameId = frameId;
                        }
                        String loaderId = Json.string(frame, "loaderId");
                        tab.loaderId = isPlainId(loaderId) ? loaderId : null;
                        String url = Json.string(frame, "url");
                        tab.url = url == null ? "" : TabText.clean(url + nullToEmpty(Json.string(frame, "urlFragment")), BrowserTabs.URL_CHARS);
                        tab.title = "";
                    } finally {
                        lock.unlock();
                    }
                }
            }
            case "Page.navigatedWithinDocument" -> {
                String url = Json.string(params, "url");
                lock.lock();
                try {
                    if (url != null && tab.mainFrameId.equals(Json.string(params, "frameId"))) {
                        tab.url = TabText.clean(url, BrowserTabs.URL_CHARS);
                        tab.starts.incrementAndGet();
                        changed.signalAll();
                    }
                } finally {
                    lock.unlock();
                }
            }
            case "Page.frameStartedLoading", "Page.frameStoppedLoading" -> {
                lock.lock();
                try {
                    if (tab.mainFrameId.equals(Json.string(params, "frameId"))) {
                        tab.loading = method.endsWith("StartedLoading");
                        if (tab.loading) {
                            tab.starts.incrementAndGet();
                        }
                        changed.signalAll();
                    }
                } finally {
                    lock.unlock();
                }
            }
            case "Page.loadEventFired" -> {
                lock.lock();
                try {
                    tab.loading = false;
                    changed.signalAll();
                } finally {
                    lock.unlock();
                }
            }
            default -> {
                // The walker's to hear: frames attached, dialogs.
            }
        }
    }

    /**
     * A document request of an Agent tab, stopped at the request stage: a local host is refused, and so is a main-frame
     * navigation off the granted site in a member-session tab, each hop of a redirect included. Everything else goes on.
     * Answered off the read path, as every stopped request must be.
     *
     * @param tab the tab it's of, or null for a frame's whose tab has gone: then it's refused
     * @param ofFrame on the session of a frame in a process of its own, so never the tab's main frame
     */
    private void onRequestPaused(AgentTab tab, String sessionId, Map<String, Object> params, boolean ofFrame) {
        String requestId = Json.string(params, "requestId");
        Map<String, Object> request = Json.object(params, "request");
        String url = request == null ? null : Json.string(request, "url");
        String frameId = Json.string(params, "frameId");
        if (requestId == null) {
            return;
        }
        String host = AgentView.hostOf(url);
        boolean main = false;
        if (tab != null && !ofFrame) {
            lock.lock();
            try {
                main = frameId == null || frameId.equals(tab.mainFrameId) || frameId.equals(tab.id);
            } finally {
                lock.unlock();
            }
        }
        boolean local = url != null && host != null && isLocalHost(host);
        boolean offSite = !local && tab != null && tab.site != null && main && (host == null || !tab.site.equals(AgentView.site(host)));
        if (tab != null && local) {
            tab.blocked.incrementAndGet();
        } else if (offSite) {
            tab.offSite.incrementAndGet();
        }
        boolean refuse = local || offSite || tab == null;
        if (main && refuse) {
            // Counted first, so a waiter it wakes finds the refusal (refuseCancelled).
            started(tab);
        }
        Thread.ofVirtual().name("agent-browser-request").start(() -> {
            try {
                if (refuse) {
                    cdp.send(sessionId, "Fetch.failRequest", Map.of("requestId", requestId, "errorReason", "BlockedByClient"),
                            timing().request());
                } else {
                    cdp.send(sessionId, "Fetch.continueRequest", Map.of("requestId", requestId), timing().request());
                }
            } catch (CdpException e) {
                log.debug("agent browser: a stopped request wasn't answered: {}", e.kind());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }

    private void closeStray(String targetId) {
        try {
            if (cdp.connected()) {
                cdp.send(null, "Target.closeTarget", Map.of("targetId", targetId), timing().request());
            }
        } catch (CdpException e) {
            log.debug("agent browser: a stray's close failed: {}", e.kind());
            went.add(targetId);
            closing.remove(targetId);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void onDisconnected() {
        // Hidden targets live no longer than the connection, and the contexts go with it (disposeOnDetach).
        List<AgentTab> all = new ArrayList<>(byTarget.values());
        lock.lock();
        try {
            for (AgentTab tab : all) {
                tab.gone = true;
            }
            for (RunState run : runs.values()) {
                run.tabs.clear();
                run.contextId = null;
            }
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        went.addAll(byTarget.keySet());
        went.addAll(bySession.keySet());
        went.addAll(frameSessions.keySet());
        went.addAll(contexts);
        went.addAll(closing);
        byTarget.clear();
        bySession.clear();
        frameSessions.clear();
        contexts.clear();
        closing.clear();
        downloads.clear();
        TabEvents events = walker;
        if (events != null) {
            events.onDisconnected();
            for (AgentTab tab : all) {
                events.onTabGone(tab.id);
            }
        }
    }

    // ---- the walker's and the action proxy's way to the Agent's tabs

    /**
     * {@link TabAccess} for the Agent's walker: only the Agent's own tabs, by id, never "the tab on screen", every command
     * through {@link AgentCdp}.
     */
    private final class Access implements TabAccess {

        @Override
        public TabRef resolve(String tabId) throws RpcException, InterruptedException {
            AgentTab tab = tabId == null ? null : byTarget.get(tabId);
            if (tab == null || tab.gone) {
                throw notFound();
            }
            if (!tabs.awaitAgentReady()) {
                throw unavailable();
            }
            lock.lock();
            try {
                if (tab.gone || tab.sessionId == null) {
                    throw notFound();
                }
                return new TabRef(tab.id, tab.sessionId, tab.url, tab.title, tab.mainFrameId, tab.loaderId);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public Map<String, Object> call(TabRef ref, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            return onTab(ref, method, params, timeout, false);
        }

        @Override
        public Map<String, Object> callLong(TabRef ref, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            return onTab(ref, method, params, timeout, true);
        }

        private Map<String, Object> onTab(TabRef ref, String method, Map<String, Object> params, Duration timeout, boolean longReply)
                throws CdpFailure, InterruptedException {
            AgentTab tab = byTarget.get(ref.tabId());
            String session = tab == null ? null : tab.sessionId;
            if (tab == null || tab.gone || session == null) {
                throw new CdpFailure(CdpFailure.Kind.GONE, 0);
            }
            try {
                return longReply ? cdp.sendLong(session, method, params, timeout) : cdp.send(session, method, params, timeout);
            } catch (CdpException e) {
                throw failure(e);
            }
        }

        @Override
        public Map<String, Object> callSession(String sessionId, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            try {
                return cdp.send(sessionId, method, params, timeout);
            } catch (CdpException e) {
                throw failure(e);
            }
        }

        /** An Agent tab is never the tab on screen. */
        @Override
        public boolean isActive(String tabId) {
            return false;
        }

        @Override
        public void listen(TabEvents events, BooleanSupplier wanted) {
            walker = events;
        }

        @Override
        public void wake() {
            tabs.wake();
        }

        @Override
        public AutoCloseable use() throws InterruptedException {
            return freeze.use();
        }

        @Override
        public boolean frozen() {
            return !freeze.cdpAllowed();
        }

        /**
         * A frame of an Agent tab in a process of its own: its document requests stop here before it runs (S-14). One
         * whose requests can't be stopped, after a second try, is never let run: it stays held at its start.
         */
        @Override
        public boolean frameAttached(String sessionId) throws InterruptedException {
            if (!agentSession(sessionId)) {
                return false;
            }
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    cdp.send(sessionId, "Fetch.enable", Map.of("patterns", DOCUMENTS), timing().request());
                    return true;
                } catch (CdpException e) {
                    log.debug("agent browser: a frame's requests weren't stopped: {}", e.kind());
                }
            }
            log.info("agent browser: a frame whose requests couldn't be stopped stays held");
            return false;
        }

        /** An Agent tab's frames stay attached and held at their start for the tab's life. */
        @Override
        public boolean keepsFrameAttach() {
            return true;
        }
    }

    private static CdpFailure failure(CdpException e) {
        return new CdpFailure(switch (e.kind()) {
            case DISCONNECTED -> CdpFailure.Kind.DISCONNECTED;
            case TIMEOUT -> CdpFailure.Kind.TIMEOUT;
            case NOT_SENT -> CdpFailure.Kind.NOT_SENT;
            case REMOTE -> CdpFailure.Kind.REMOTE;
        }, e.code());
    }

    // ---- small things

    private boolean agentSession(String sessionId) {
        return sessionId != null && (bySession.containsKey(sessionId) || frameSessions.containsKey(sessionId));
    }

    private Map<String, Object> send(AgentTab tab, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        String session = tab.sessionId;
        if (session == null || tab.gone) {
            throw CdpException.remote(CdpException.SESSION_NOT_FOUND);
        }
        return cdp.send(session, method, params, timeout);
    }

    private RunState run(String runId) {
        lock.lock();
        try {
            return runs.computeIfAbsent(runId, RunState::new);
        } finally {
            lock.unlock();
        }
    }

    private AgentTab require(String runId, String tabId) throws RpcException {
        AgentTab tab = tabId == null ? null : byTarget.get(tabId);
        lock.lock();
        try {
            RunState run = runs.get(runId);
            if (tab == null || tab.gone || !tab.runId.equals(runId)) {
                // Only this run's own tab closed for its memory says so; any other id is just not there.
                if (tabId != null && (tab != null && tab.overMemory && tab.runId.equals(runId)
                        || run != null && run.overMemory.contains(tabId))) {
                    throw memoryGone();
                }
                throw notFound();
            }
            if (run != null) {
                run.lastUse = System.nanoTime();
            }
            return tab;
        } finally {
            lock.unlock();
        }
    }

    private void requireAvailable() throws RpcException {
        if (!available()) {
            throw new RpcException(RpcException.UNAVAILABLE, "Not turned on for this desk", Map.of("reason", "disabled"));
        }
    }

    private void requireReady() throws RpcException, InterruptedException {
        if (!tabs.awaitAgentReady()) {
            throw unavailable();
        }
    }

    private Tab snapshot(AgentTab tab) {
        return new Tab(tab.id, tab.runId, tab.site, tab.url, tab.title, tab.loaderId == null ? "" : tab.loaderId);
    }

    private BrowserTabs.Timing timing() {
        return tabs.timing();
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    private static boolean isPlainId(String id) {
        if (id == null || id.isEmpty() || id.length() > MAX_ID_CHARS) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && c != '-' && c != '_' && c != '.') {
                return false;
            }
        }
        return true;
    }

    private static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The browser isn't reachable", Map.of("reason", "chromium"));
    }

    private static RpcException notFound() {
        return new RpcException(RpcException.NOT_FOUND, "No such tab", Map.of("reason", "not_found"));
    }

    private static RpcException refused(String reason) {
        return new RpcException(RpcException.CONFLICT, "Refused", Map.of("reason", reason));
    }

    // ---- URLs and sites: the rules every Agent path keeps

    /** {@link AgentBrowser#checkUrl}. */
    static String checkUrl(String raw) throws RpcException {
        if (raw == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "No URL", Map.of("reason", "url"));
        }
        String url;
        try {
            url = BrowserUrl.parse(raw);
        } catch (RpcException e) {
            if (RpcException.TOO_LARGE.equals(e.code())) {
                throw e;
            }
            throw new RpcException(RpcException.BAD_REQUEST, "Not a URL the agent may open", Map.of("reason", "url"));
        }
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            throw new RpcException(RpcException.BAD_REQUEST, "Not a URL the agent may open", Map.of("reason", "url"));
        }
        String host = AgentView.hostOf(url);
        if (uri.getRawUserInfo() != null || host == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "Not a URL the agent may open", Map.of("reason", "url"));
        }
        if (isLocalHost(host)) {
            throw new RpcException(RpcException.FORBIDDEN, "Not a site the agent may open", Map.of("reason", "blocked"));
        }
        return url;
    }

    /** {@link AgentBrowser#originOf}. */
    static String originOf(String url) {
        String host = AgentView.hostOf(url);
        if (host == null) {
            return null;
        }
        try {
            URI uri = new URI(url);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            boolean usual = port < 0 || ("https".equals(scheme) && port == 443) || ("http".equals(scheme) && port == 80);
            return scheme + "://" + host + (usual ? "" : ":" + port);
        } catch (URISyntaxException | RuntimeException e) {
            return null;
        }
    }

    /** {@link AgentBrowser#siteOf}. */
    static String siteOf(String url) {
        return AgentView.site(AgentView.hostOf(url));
    }

    /** {@link AgentBrowser#isSite}. */
    static boolean isSite(String site) {
        if (site == null || site.length() > 253 || !SITE.matcher(site).matches() || isLocalHost(site)) {
            return false;
        }
        String[] labels = site.split("\\.");
        String top = labels[labels.length - 1];
        if (!top.chars().allMatch(Character::isLetter) && !top.startsWith("xn--")) {
            return false;
        }
        // A country's public second level alone, as co.uk, is every site under it.
        if (labels.length == 2 && top.length() == 2 && PUBLIC_SECOND.contains(labels[0])) {
            return false;
        }
        return site.equals(AgentView.site(site));
    }

    /**
     * A host on the desk or its network, which no Agent page may reach: loopback, link-local (the instance's metadata
     * service among them), private and shared ranges, any IPv6 literal, a single label, a number that's an address in
     * another form, and the local-only names. A public name that resolves to a local address isn't seen here.
     */
    static boolean isLocalHost(String rawHost) {
        String host = rawHost.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        if (host.isEmpty() || host.startsWith("[") || host.contains(":") || !host.contains(".") || host.equals("localhost")) {
            return true;
        }
        for (String suffix : LOCAL_SUFFIXES) {
            if (host.endsWith(suffix)) {
                return true;
            }
        }
        String[] labels = host.split("\\.");
        String last = labels[labels.length - 1];
        if (last.isEmpty() || Character.isDigit(last.charAt(0)) || last.startsWith("0x")) {
            if (labels.length != 4) {
                return true;
            }
            int[] octets = new int[4];
            for (int i = 0; i < 4; i++) {
                if (!labels[i].matches("[0-9]{1,3}")) {
                    return true;
                }
                octets[i] = Integer.parseInt(labels[i]);
                if (octets[i] > 255) {
                    return true;
                }
            }
            int a = octets[0];
            int b = octets[1];
            return a == 0 || a == 10 || a == 127 || a >= 224
                    || (a == 100 && b >= 64 && b <= 127)
                    || (a == 169 && b == 254)
                    || (a == 172 && b >= 16 && b <= 31)
                    || (a == 192 && b == 168)
                    || (a == 192 && b == 0 && octets[2] == 0)
                    || (a == 198 && (b == 18 || b == 19));
        }
        return false;
    }

    /** IDNA to ASCII, lower case, or null. */
    static String asciiSite(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return IDN.toASCII(raw.strip(), IDN.ALLOW_UNASSIGNED).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
