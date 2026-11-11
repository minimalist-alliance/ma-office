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
 * Agent mode). Before one, where it would navigate is checked ({@link #navRefusal}): another site in a member-session
 * tab is {@code off_site}, a local host or a scheme but http, https and the page's own javascript is {@code blocked};
 * and a navigation the page starts anyway is cancelled at the request, as above.
 *
 * <p><b>CDP.</b> Everything goes through {@link AgentCdp}'s allow-list, the walker's and the action proxy's commands
 * included ({@link Access}), and only to the Agent's own sessions. Nothing clears or writes storage, cookies or history.
 *
 * <p><b>Work.</b> Each call thaws Chromium and holds the grace ({@link BrowserFreeze#use}), as a {@code browser.minified.*}
 * call does. Agent browsing is never Browser time on a free desk, and never asks the free tier.
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
    /** How long an action's page gets to start a navigation before its result is taken. */
    private static final Duration SETTLE = Duration.ofMillis(300);
    /** A view still being made is looked at again this many times. */
    private static final int PENDING_TRIES = 6;
    private static final Duration PENDING_PAUSE = Duration.ofMillis(250);
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
        /** Main-frame navigations off the granted site cancelled. */
        final AtomicLong offSite = new AtomicLong();
        /** Document requests to a local host refused. */
        final AtomicLong blocked = new AtomicLong();

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
        /** Its off-the-record context, or null until its first own tab. */
        String contextId;
        final Map<String, AgentTab> tabs = new LinkedHashMap<>();
        /** The sites the member granted this run. A grant stays for the run, its tab or not. */
        final Set<String> sites = new LinkedHashSet<>();
        /** One make of a context or a session tab at a time. */
        final ReentrantLock making = new ReentrantLock();

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
    private final AgentCdp cdp;
    private final AgentView view;
    private volatile TabEvents walker;
    /** Own-context tabs being made, which count against the cap already. */
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
            return ownTabsLocked() + making;
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
        try (BrowserFreeze.Use use = freeze.use()) {
            requireReady();
            reserve();
            AgentTab tab;
            try {
                tab = create(runId, ownContext(runId), null);
            } finally {
                lock.lock();
                try {
                    making--;
                } finally {
                    lock.unlock();
                }
            }
            try {
                return go(tab, target);
            } catch (RpcException | CdpException e) {
                // A first page that didn't come leaves no tab holding a place.
                closeTab(tab);
                throw e;
            }
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
            return go(tab, target);
        } catch (CdpException e) {
            throw unavailable();
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
            send(tab, "Page.navigateToHistoryEntry", Map.of("entryId", entryId), timing().request());
            settle(tab);
            refuseCancelled(tab, offSite, blocked);
            return new Navigated(tab.id, null);
        } catch (CdpException e) {
            throw e.kind() == CdpException.Kind.REMOTE ? new RpcException(RpcException.NOT_FOUND, "Gone", Map.of("reason", "gone"))
                    : unavailable();
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
                AgentTab tab = create(runId, null, site);
                lock.lock();
                try {
                    run.sites.add(site);
                } finally {
                    lock.unlock();
                }
                log.info("agent browser: a site of the member's session granted for a run");
                return go(tab, "https://" + site + "/");
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
            return reply;
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
            boolean spend) throws RpcException, InterruptedException {
        AgentTab tab = require(runId, tabId);
        requireAvailable();
        long offSite = tab.offSite.get();
        long blocked = tab.blocked.get();
        Map<String, Object> done = view.act(tab.id, nodeId, action, value, fp, block, rev, url -> navRefusal(tab, url), spend);
        try (BrowserFreeze.Use use = freeze.use()) {
            settle(tab);
        }
        refuseCancelled(tab, offSite, blocked);
        return done;
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

    // ---- making tabs

    private void reserve() throws RpcException {
        lock.lock();
        try {
            int cap = tabCap();
            if (ownTabsLocked() + making >= cap) {
                throw new RpcException(RpcException.FORBIDDEN, "Too many agent tabs", Map.of("reason", "tab_cap", "limit", cap));
            }
            making++;
        } finally {
            lock.unlock();
        }
    }

    private int ownTabsLocked() {
        int count = 0;
        for (AgentTab tab : byTarget.values()) {
            count += tab.site == null && !tab.gone ? 1 : 0;
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
        // A hidden target's viewport is 0x0, where nothing is visible and nothing can be hit: the walker needs a page.
        cdp.send(session, "Emulation.setDeviceMetricsOverride",
                Map.of("width", WIDTH, "height", HEIGHT, "deviceScaleFactor", 1, "mobile", false), request);
        // A hidden target never has the page's focus, so a field's focus event, where a page may turn it into a password
        // one, would never fire for the Agent's click or key: the page is told it has focus, as a member's tab on screen
        // has (S-14). Only this page's own idea of focus; nothing on screen moves.
        cdp.send(session, "Emulation.setFocusEmulationEnabled", Map.of("enabled", true), request);
        cdp.send(session, "Fetch.enable", Map.of("patterns", DOCUMENTS), request);
        // Every frame in a process of its own is held at its start from the first page on, until its own requests stop
        // here too (the walker's frameAttached): without it, one the first page loads would be in no session of deskd's.
        cdp.send(session, "Target.setAutoAttach", FRAMES, request);
    }

    private void register(AgentTab tab) {
        byTarget.put(tab.id, tab);
        lock.lock();
        try {
            RunState run = runs.computeIfAbsent(tab.runId, RunState::new);
            run.tabs.put(tab.id, tab);
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

    /** A navigation the page or a click started gets a moment to start, then until it's loaded, within the load wait. */
    private void settle(AgentTab tab) throws InterruptedException {
        Thread.sleep(SETTLE);
        awaitLoaded(tab);
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
        contexts.remove(contextId);
    }

    private void forget(AgentTab tab) {
        byTarget.remove(tab.id, tab);
        String session = tab.sessionId;
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
                if (child != null) {
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
                if (id != null && closing.remove(id)) {
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
            if (tab == null || tab.gone || !tab.runId.equals(runId)) {
                throw notFound();
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
