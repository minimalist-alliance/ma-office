package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.browser.minified.CdpFailure;
import com.minimalistalliance.desk.deskd.browser.minified.TabAccess;
import com.minimalistalliance.desk.deskd.browser.minified.TabEvents;
import com.minimalistalliance.desk.deskd.browser.minified.TabRef;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The member's tabs as Chromium reports them, and the things a client may do to them. No RPC reaches
 * CDP except through a method here, and none of them takes a CDP method, a script or a target id it
 * hasn't first found in the model (ADR 0041).
 *
 * <p><b>Who keeps it up.</b> The model exists only while the connection does, and that lasts only while
 * someone is viewing the Browser on a desk somebody looks at, subscribed to {@value #TOPIC}, or has called in the last
 * minute. Never while Chromium is frozen, or may be ({@link BrowserFreeze}): every call, and a SUB's snapshot, waits for
 * a thaw first.
 *
 * <p><b>What's untrusted.</b> Titles and URLs come from web content. They're cut and cleaned on the way
 * in by {@link TabText}, never logged, and go only to the sessions that asked. Nothing reaches the
 * heartbeat or any other way to Platform.
 *
 * <p><b>What events don't say.</b> CDP has no event for a tab becoming active, or for a title changing
 * by itself: targetInfoChanged only carries the title along when the URL changes (checked on Chrome 156).
 * So the tabs are read for those, and a read is two things, side by side. Target.getTargets, over the
 * connection, has titles and URLs as the page set them. /json/list is read for its order alone, which says
 * when a tab was last shown or made, most recent first. It has titles too, but Chromium escapes those for
 * HTML there and only there (checked on Chrome 156), so that Q&amp;A would read Q&amp;amp;A. A read happens for
 * every call that needs it; when a tab comes or goes or a page navigates or finishes loading, at most once per
 * publishEvery; and while someone is both subscribed and viewing, whenever a second has gone by with no read.
 * So a title changing however often costs no more reads than a quiet one.
 *
 * <p><b>Which tab is active.</b> The tab on screen. A tab opened in the background, as a middle click does,
 * comes first in the list while it's hidden, so the list can't say on its own. What it can say is that the
 * tab on screen is above any that's been hidden since, because showing a tab moves it to the top. So with
 * the last tab known to be on screen first in the list, nothing has moved and no tab is asked. Otherwise
 * tabs are asked, from the top down, for {@code document.visibilityState} in an isolated world, where a
 * page can't redefine it. That's a constant, and no client can reach it. The only other scripts deskd runs are the two
 * constants of {@link FilteredSites}, on a teen's desk and only on Chromium's own error page, in the same kind of world,
 * and the simplified view's constants ({@code browser/minified}), in a world of its own, on a tab a client asked to see
 * simplified.
 * A call with no tabId acts only on a tab known that way: if the list can't be read, no tab can answer, or
 * the member is on a page deskd doesn't list, it fails with unavailable rather than guess, because a guess
 * can put a member's text in the wrong page.
 *
 * <p><b>Locks.</b> {@code lock} is held for model work only, and for a look at who's subscribed, which is queue
 * work on the other side and never takes this one. Calls to Chromium happen outside it, and the read path never
 * waits for one. {@code closing} is only ever waited for by another close.
 */
final class BrowserTabs implements CdpClient.Events, Topic {

    private static final Logger log = LoggerFactory.getLogger(BrowserTabs.class);

    static final String TOPIC = "browser.tabs";
    /** Page targets kept, members or not. Past this, new ones aren't seen. */
    static final int MAX_TABS = 256;
    static final int URL_CHARS = 2048;
    static final int TITLE_CHARS = 256;
    /** The tab list has to fit one event (64 KiB) with room for its envelope. */
    static final int MAX_LIST_BYTES = 60 * 1024;
    /** What each tab is cut to if the list wouldn't otherwise fit. Past that, tabs drop off the end. */
    private static final int TIGHT_URL_CHARS = 256;
    private static final int TIGHT_TITLE_CHARS = 64;
    static final int MAX_INSERT_CHARS = 64 * 1024;
    private static final int NET_ERROR_CHARS = 128;
    private static final int MAX_ID_CHARS = 128;
    private static final String BLOCKED = "net::ERR_BLOCKED_BY_ADMINISTRATOR";
    private static final String BLANK = "about:blank";
    private static final String ISOLATED_WORLD = "ma-deskd";
    private static final String VISIBILITY_STATE = "document.visibilityState";
    private static final List<Map<String, Object>> PAGES_ONLY = List.of(Map.of("type", "page"));
    /** Where Chromium's own error page lives, whatever the URL that failed. */
    private static final String ERROR_PAGE_URL = "chrome-error://chromewebdata/";
    /**
     * Chromium's error page puts its net error in an element of this class, without the {@code net::} (checked on Chrome
     * 156). Anything else answers an empty string.
     */
    private static final String ERROR_CODE = "location.href === '" + ERROR_PAGE_URL + "' && document.querySelector('.error-code')"
            + " ? document.querySelector('.error-code').textContent.trim().slice(0, 64) : ''";
    /** How many of {@code Timing.visibility} one read of the list can take, whatever the number of tabs. */
    private static final int VISIBILITY_WAITS = 3;
    /** A new tab, opened by Ctrl+T, is a member's tab though it's a chrome: page. */
    private static final Set<String> NEW_TAB_PAGES =
            Set.of("chrome://newtab", "chrome://newtab/", "chrome://new-tab-page", "chrome://new-tab-page/");
    private static final List<String> INTERNAL_PREFIXES =
            List.of("chrome:", "chrome-extension:", "chrome-untrusted:", "chrome-search:", "devtools:");

    /**
     * @param publishEvery the smallest gap between two events
     * @param recentCall how long a call keeps the connection wanted
     * @param callWait how long a call waits for a connection that's coming up. It doesn't wait for
     *     Chromium to start: a refused connection fails at once
     * @param request what any one CDP command gets
     * @param sessionWait what a call waits for a tab's session before it gives up on sending its command
     * @param navigate what Page.navigate gets, which answers only once the page commits
     * @param settle how long a new connection waits to know the tabs' history before it's ready
     * @param listEvery how long since the last read before the tabs are read just to look, while someone is subscribed
     *     and viewing. publishEvery still comes between any two ticks
     * @param visibility what one tab gets to say whether it's the one on screen
     * @param restartEvery the smallest gap between two restarts of a Chromium that's off its port, and, while a start is
     *     refused, between the last start and one that a lost Chromium asks for ({@link BrowserStream#browserLost})
     */
    record Timing(
            Duration publishEvery,
            Duration recentCall,
            Duration callWait,
            Duration request,
            Duration sessionWait,
            Duration navigate,
            Duration settle,
            Duration listEvery,
            Duration visibility,
            Duration restartEvery,
            CdpClient.Timing cdp) {
        static final Timing DEFAULT = new Timing(
                Duration.ofMillis(250),
                Duration.ofMinutes(1),
                Duration.ofMillis(1500),
                Duration.ofSeconds(5),
                Duration.ofSeconds(5),
                Duration.ofSeconds(30),
                Duration.ofMillis(500),
                Duration.ofSeconds(1),
                Duration.ofSeconds(1),
                Duration.ofMinutes(5),
                CdpClient.Timing.DEFAULT);
    }

    private static final class Tab {
        final String id;
        String mainFrameId;
        /** The main frame's document as of the last commit heard of, or null if none has been since deskd attached. */
        String mainLoaderId;
        /** The last error page handed to {@link FilteredSites}, so that it's handed over once. */
        String filterLoaderId;
        String url = "";
        String title = "";
        boolean member;
        boolean loading;
        boolean canGoBack;
        boolean canGoForward;
        boolean historyDirty;
        String sessionId;
        CompletableFuture<String> attaching;
        Thread attachThread;

        Tab(String id) {
            this.id = id;
            this.mainFrameId = id;
        }
    }

    private final CdpClient cdp;
    private final BrowserFreeze freeze;
    private final EventHub hub;
    private final BooleanSupplier viewer;
    private final Runnable browserLost;
    private final Runnable browserDisplaced;
    private final FilteredSites filtered;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition readyChanged = lock.newCondition();
    private final Condition tickWake = lock.newCondition();
    private final Map<String, Tab> tabs = new LinkedHashMap<>();
    private final Map<String, Tab> bySession = new HashMap<>();
    private volatile long lastCallNanos;
    private volatile boolean closed;
    /** The simplified view, once it listens: told of events after the lock is let go. */
    private volatile TabEvents minifiedEvents;
    private volatile BooleanSupplier minifiedWanted = () -> false;
    private boolean ready;
    private long readySinceNanos;
    private long attemptFailures;
    private long lastFailureNanos;
    private String activeId;
    /** True if the last read of the list told which tab is on screen: {@code activeId}, or none of the member's. */
    private boolean activeKnown;
    /** What a list marks active when none of the member's tabs is on screen: the last that was, or the latest. */
    private String activeGuessId;
    /** Reads of the list so far. A read that finishes after a later one has said its piece says nothing. */
    private long listReads;
    private long activeRead;
    private long titlesRead;
    /** The tabs last found hidden above the active one. Only the first of them can come on screen unmoved. */
    private List<String> hiddenAbove = List.of();
    /** Closes one at a time, so the check for the last tab holds until that close is done. */
    private final ReentrantLock closing = new ReentrantLock();
    /** A subscriber was told nothing, so the next tick publishes whatever there is. */
    private boolean owed;
    /** What subscribers last heard. Null if there's no one it's owed to. */
    private byte[] lastPublished;
    private Thread ticker;
    /** Wakes so far, so a ticker that looked at who's viewing just before one came looks again rather than end. */
    private long wakes;
    private boolean tickDue;
    private boolean listDue;
    private long lastTickNanos;
    /** When the last read of the tabs began, for whatever reason. A read finds what the next would have looked for. */
    private long lastListNanos;

    BrowserTabs(
            PlatformHttp http,
            int port,
            Supplier<CdpListener.Verdict> listener,
            EventHub hub,
            BooleanSupplier viewer,
            Runnable browserLost,
            Runnable browserDisplaced,
            FilteredSites filtered,
            BrowserFreeze freeze,
            Timing timing) {
        this.freeze = freeze;
        this.hub = hub;
        this.viewer = viewer;
        this.browserLost = browserLost;
        this.browserDisplaced = browserDisplaced;
        this.filtered = filtered;
        this.timing = timing;
        this.cdp = new CdpClient(http, port, listener, this, this::wanted, timing.cdp());
        long now = System.nanoTime();
        this.lastCallNanos = now - timing.recentCall().toNanos() - 1;
        this.lastFailureNanos = now - TimeUnit.HOURS.toNanos(1);
    }

    /** What wants the connection, or the list read, may have changed. Never blocks. */
    void wake() {
        if (wanted()) {
            cdp.wake();
        }
        lock.lock();
        try {
            wakes++;
            startTicker();
            tickWake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    void close() {
        closed = true;
        cdp.close();
        lock.lock();
        try {
            readyChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** {@code desk-browser} is being started, or just has been: see {@link CdpClient#hurry}. Never blocks. */
    void browserStarting() {
        cdp.hurry();
    }

    /** A member tab's main frame is loading, as far as deskd has heard: nothing is known with no connection. */
    boolean loading() {
        lock.lock();
        try {
            if (!ready) {
                return false;
            }
            for (Tab tab : tabs.values()) {
                if (tab.member && tab.loading) {
                    return true;
                }
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    /**
     * For a freeze, once {@link BrowserFreeze#cdpAllowed} says no: the connection goes, and so does anything trying to make
     * one, as {@link #wanted} now says no. A connection still being set up finishes that first.
     *
     * @return true if it went within the wait
     */
    boolean letGo(Duration wait) throws InterruptedException {
        cdp.wake();
        return cdp.awaitIdle(wait);
    }

    /**
     * Parks until a connection is up with its tabs known, which is what a client sees of Chromium.
     *
     * @return {@link System#nanoTime} when it came up, or null if the wait ran out first
     */
    Long awaitConnected(Duration wait) throws InterruptedException {
        long remaining = wait.toNanos();
        lock.lockInterruptibly();
        try {
            while (!ready && !closed && remaining > 0) {
                remaining = readyChanged.awaitNanos(remaining);
            }
            return ready ? readySinceNanos : null;
        } finally {
            lock.unlock();
        }
    }

    /**
     * For /health: counts only, never what's in them. {@code refused} and {@code displaced} are as of the last look at
     * the port, as an idle desk doesn't look. {@code listenerUid} goes with the first when the uid is known.
     */
    Map<String, Object> health() {
        Map<String, Object> health = new LinkedHashMap<>();
        CdpListener.Verdict refusal = cdp.refusal();
        lock.lock();
        try {
            boolean displaced = refusal != null && refusal.kind() == CdpListener.Kind.DISPLACED;
            health.put("cdp", displaced ? "displaced"
                    : refusal != null ? "refused"
                    : ready ? "connected"
                    : cdp.isRunning() ? "connecting"
                    : "idle");
            if (refusal != null && !displaced && refusal.uid() >= 0) {
                health.put("listenerUid", refusal.uid());
            }
            health.put("tabs", memberCount());
        } finally {
            lock.unlock();
        }
        return health;
    }

    private boolean wanted() {
        return !closed
                && freeze.cdpAllowed()
                && (viewer.getAsBoolean()
                        || hub.hasSubscribers(TOPIC)
                        || minifiedWanted.getAsBoolean()
                        || System.nanoTime() - lastCallNanos < timing.recentCall().toNanos());
    }

    // ---- the topic

    @Override
    public boolean coalescible() {
        return true;
    }

    /** It only publishes while someone is subscribed, so a client coming back can't have seen it all. */
    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    /** Titles and URLs say what's on screen, so they follow what lets a session see the screen. */
    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!principal.video()) {
            throw BrowserMethods.forbidden();
        }
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) throws InterruptedException {
        try (BrowserFreeze.Use use = freeze.use()) {
            return snapshotThawed();
        }
    }

    private Object snapshotThawed() throws InterruptedException {
        if (!awaitReady()) {
            lock.lock();
            try {
                if (!ready) {
                    owed = true;
                    return NO_SNAPSHOT;
                }
            } finally {
                lock.unlock();
            }
        }
        refreshList();
        refreshHistories();
        lock.lock();
        try {
            // The connection can have gone during those. An empty list would look like no tabs.
            if (!ready) {
                owed = true;
                return NO_SNAPSHOT;
            }
            Map<String, Object> data = Map.of("tabs", tabList());
            if (lastPublished == null) {
                lastPublished = Json.bytes(data);
            }
            startTicker();
            return data;
        } finally {
            lock.unlock();
        }
    }

    // ---- the methods

    /** @return the tabs, in the order deskd first saw them */
    List<Map<String, Object>> list() throws RpcException, InterruptedException {
        requireReady();
        refreshList();
        refreshHistories();
        lock.lock();
        try {
            // The connection can have gone during those. An empty list would look like no tabs.
            if (!ready) {
                throw unavailable();
            }
            return tabList();
        } finally {
            lock.unlock();
        }
    }

    /** @return the result of the method: the tab, and netError if the navigation failed */
    Map<String, Object> navigate(RpcContext context, String tabId, String url) throws RpcException, InterruptedException {
        requireReady();
        Tab tab = resolve(tabId);
        Map<String, Object> reply;
        try {
            reply = applyOnTab(context, tab, "Page.navigate", Map.of("url", url), timing.navigate());
        } catch (CdpException e) {
            if (e.kind() == CdpException.Kind.TIMEOUT) {
                return slowNavigation(tab);
            }
            throw toRpc(e, tab);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("tabId", tab.id);
        String netError = TabText.clean(Json.string(reply, "errorText"), NET_ERROR_CHARS);
        if (BLOCKED.equals(netError)) {
            throw new RpcException(RpcException.FORBIDDEN, "Blocked by the desk's policy", Map.of("reason", "blocked"));
        }
        if (!netError.isEmpty()) {
            result.put("netError", netError);
        }
        return result;
    }

    /**
     * Page.navigate answers when the page commits, and a slow server can take longer than a client
     * waits. If Chromium itself is alive the navigation is just still going: the tab shows it as loading.
     * Only a Page.navigate that went out gets here, as that's all a TIMEOUT means.
     */
    private Map<String, Object> slowNavigation(Tab tab) throws RpcException, InterruptedException {
        try {
            cdp.call(null, "Browser.getVersion", Map.of(), timing.request());
        } catch (CdpException e) {
            throw toRpc(e, tab);
        }
        return Map.of("tabId", tab.id);
    }

    String back(RpcContext context, String tabId) throws RpcException, InterruptedException {
        return throughHistory(context, tabId, -1);
    }

    String forward(RpcContext context, String tabId) throws RpcException, InterruptedException {
        return throughHistory(context, tabId, 1);
    }

    /** There's nothing to do at either end of the history, and the tab's flags already say so. */
    private String throughHistory(RpcContext context, String tabId, int step) throws RpcException, InterruptedException {
        requireReady();
        Tab tab = resolve(tabId);
        try {
            Map<String, Object> history = onTab(tab, "Page.getNavigationHistory", Map.of(), timing.request());
            if (history.get("currentIndex") instanceof Number index && history.get("entries") instanceof List<?> entries) {
                int target = index.intValue() + step;
                if (target >= 0 && target < entries.size()
                        && entries.get(target) instanceof Map<?, ?> entry
                        && entry.get("id") instanceof Number entryId) {
                    applyOnTab(context, tab, "Page.navigateToHistoryEntry", Map.of("entryId", entryId), timing.request());
                }
            }
        } catch (CdpException e) {
            throw toRpc(e, tab);
        }
        return tab.id;
    }

    String reload(RpcContext context, String tabId) throws RpcException, InterruptedException {
        requireReady();
        Tab tab = resolve(tabId);
        try {
            applyOnTab(context, tab, "Page.reload", Map.of(), timing.request());
        } catch (CdpException e) {
            throw toRpc(e, tab);
        }
        return tab.id;
    }

    String activate(RpcContext context, String tabId) throws RpcException, InterruptedException {
        requireReady();
        Tab tab = resolve(tabId);
        aboutToApply(context);
        try {
            cdp.call(null, "Target.activateTarget", Map.of("targetId", tab.id), timing.request());
        } catch (CdpException e) {
            throw toRpc(e, tab);
        }
        lock.lock();
        try {
            activeId = tab.id;
            activeKnown = true;
            // Any read under way began before this, and what it found is out of date.
            activeRead = ++listReads;
            listDue = true;
            scheduleTick();
        } finally {
            lock.unlock();
        }
        return tab.id;
    }

    /** @param url already through {@link BrowserUrl}, or null for an empty tab */
    String open(RpcContext context, String url) throws RpcException, InterruptedException {
        requireReady();
        lock.lock();
        try {
            if (tabs.size() >= MAX_TABS) {
                throw new RpcException(RpcException.TOO_LARGE, "Too many tabs", Map.of("limit", MAX_TABS));
            }
        } finally {
            lock.unlock();
        }
        aboutToApply(context);
        try {
            return createTab(url == null ? BLANK : url);
        } catch (CdpException e) {
            throw toRpc(e, null);
        }
    }

    private String createTab(String url) throws CdpException, InterruptedException {
        Map<String, Object> created =
                cdp.call("Target.createTarget", Map.of("url", url), timing.request(), reply -> takeCreated(reply, url));
        String targetId = Json.string(created, "targetId");
        if (!isPlainId(targetId)) {
            throw CdpException.remote(0);
        }
        return targetId;
    }

    /**
     * The event usually comes first. The result is what's certain. Runs on the read path, as a tab's end can come right
     * after this, and taken any later it would bring the tab back, with nothing left to say otherwise.
     */
    private void takeCreated(Map<String, Object> created, String url) {
        String targetId = Json.string(created, "targetId");
        if (!isPlainId(targetId)) {
            return;
        }
        lock.lock();
        try {
            Tab tab = tabs.get(targetId);
            if (tab == null && tabs.size() < MAX_TABS) {
                tab = new Tab(targetId);
                tab.url = TabText.clean(url, URL_CHARS);
                tab.member = true;
                tabs.put(targetId, tab);
                startAttach(tab);
            }
            listDue = true;
            scheduleTick();
        } finally {
            lock.unlock();
        }
    }

    /** A kiosk Chromium exits with its last tab, so closing that one opens an empty one first. */
    void closeTab(RpcContext context, String tabId) throws RpcException, InterruptedException {
        requireReady();
        Tab tab = resolve(tabId);
        closing.lockInterruptibly();
        try {
            boolean last;
            lock.lock();
            try {
                if (tabs.get(tab.id) != tab) {
                    throw notFound();
                }
                last = memberCount() == 1;
            } finally {
                lock.unlock();
            }
            aboutToApply(context);
            if (last) {
                createTab(BLANK);
            }
            try {
                cdp.call(null, "Target.closeTarget", Map.of("targetId", tab.id), timing.request());
            } catch (CdpException e) {
                // A last tab that went by itself just now leaves the empty one, which is what a close leaves.
                if (!last || !isNoSuchTab(e, tab)) {
                    throw e;
                }
            }
            lock.lock();
            try {
                removeTab(tab.id);
            } finally {
                lock.unlock();
            }
        } catch (CdpException e) {
            throw toRpc(e, tab);
        } finally {
            closing.unlock();
        }
    }

    /**
     * Every cookie of the running Chromium, as {@code Storage.getCookies} on the browser itself gives them, for
     * data.browser.cookies, which keeps only digests of them. Nothing here logs or keeps one. It waits up to
     * {@code request} for a connection, as one may not be up while nobody views, and up to {@code request} again for the
     * answer. That goes through {@link CdpClient#ask}, so a reply that never comes, such as one over
     * {@link CdpClient#MAX_MESSAGE_CHARS}, which is dropped, leaves the connection as it was. Strings are cut at
     * {@link CdpClient#MAX_STRING_CHARS}, past the 4096 bytes Chromium allows a cookie's name and value together.
     *
     * @throws RpcException unavailable, {@code reason: chromium}, if Chromium isn't reachable or doesn't answer
     */
    List<Map<String, Object>> cookies() throws RpcException, InterruptedException {
        if (!awaitReady(timing.request())) {
            throw unavailable();
        }
        AtomicReference<Object> got = new AtomicReference<>();
        CompletableFuture<Void> answered = cdp.ask("Storage.getCookies", Map.of(), result -> got.set(result.get("cookies")));
        try {
            answered.get(timing.request().toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException | ExecutionException e) {
            answered.cancel(false);
            throw unavailable();
        } catch (InterruptedException e) {
            answered.cancel(false);
            throw e;
        }
        List<Map<String, Object>> cookies = new ArrayList<>();
        if (got.get() instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> cookie) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> typed = (Map<String, Object>) cookie;
                    cookies.add(typed);
                }
            }
        }
        return cookies;
    }

    void insertText(RpcContext context, String tabId, String text) throws RpcException, InterruptedException {
        requireReady();
        Tab tab = resolve(tabId);
        try {
            applyOnTab(context, tab, "Input.insertText", Map.of("text", text), timing.request());
        } catch (CdpException e) {
            throw toRpc(e, tab);
        }
    }

    /**
     * Connects if it can within a moment. "Nothing holds the call": a Chromium that isn't there refuses
     * the connection at once, and that's the answer.
     *
     * @return false if Chromium isn't reachable
     */
    private boolean awaitReady() throws InterruptedException {
        return awaitReady(timing.callWait());
    }

    private boolean awaitReady(Duration wait) throws InterruptedException {
        return awaitReady(wait, true);
    }

    /** @param thaw whether a frozen Chromium is thawed for this, or the answer is just no: the simplified view's own looks */
    private boolean awaitReady(Duration wait, boolean thaw) throws InterruptedException {
        // Nothing reaches a frozen Chromium: the connection waits for a thaw. Callers have usually had one already.
        if (!freeze.cdpAllowed() && (!thaw || !freeze.awaitThawed(timing.callWait()))) {
            return false;
        }
        lastCallNanos = System.nanoTime();
        cdp.wake();
        long remaining = wait.toNanos();
        lock.lock();
        try {
            long failures = attemptFailures;
            if (!ready && System.nanoTime() - lastFailureNanos < timing.cdp().minBackoff().toNanos()) {
                return false;
            }
            while (!ready && attemptFailures == failures && remaining > 0 && !closed) {
                remaining = readyChanged.awaitNanos(remaining);
            }
            return ready;
        } finally {
            lock.unlock();
        }
    }

    private void requireReady() throws RpcException, InterruptedException {
        if (!awaitReady()) {
            throw unavailable();
        }
    }

    /** Whether the command may still have applied is for RpcSession to say, from whether aboutToApply ran. */
    private static RpcException unavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The browser isn't reachable", Map.of("reason", "chromium"));
    }

    /** Nothing was done: which tab is on screen can't be told right now, and it won't be guessed. */
    private static RpcException activeTabUnknown() {
        return new RpcException(RpcException.UNAVAILABLE, "Can't tell which tab is on screen", Map.of("reason", "active_tab"));
    }

    private static RpcException notFound() {
        return new RpcException(RpcException.NOT_FOUND, "No such tab", Map.of("reason", "tab"));
    }

    /** @param tabId null for the tab on screen, as of now, or an error if that can't be told */
    private Tab resolve(String tabId) throws RpcException, InterruptedException {
        if (tabId == null) {
            refreshList();
        }
        lock.lock();
        try {
            // The connection can have gone during that read, and with it the model.
            if (!ready) {
                throw unavailable();
            }
            if (tabId == null) {
                return tabOnScreen();
            }
            Tab tab = tabs.get(tabId);
            if (tab == null || !tab.member) {
                throw notFound();
            }
            return tab;
        } finally {
            lock.unlock();
        }
    }

    /** With the lock held. Never the guess {@link #activeTab} can make. */
    private Tab tabOnScreen() throws RpcException {
        if (!activeKnown) {
            throw activeTabUnknown();
        }
        Tab tab = activeId == null ? null : tabs.get(activeId);
        if (tab != null && tab.member) {
            return tab;
        }
        throw memberCount() == 0 ? notFound() : activeTabUnknown();
    }

    /** Right before anything that changes what the member has: last chance for this call to be stopped. */
    private static void aboutToApply(RpcContext context) throws RpcException {
        if (!context.principal().input()) {
            throw BrowserMethods.forbidden();
        }
        context.beginEffect();
    }

    private RpcException toRpc(CdpException error, Tab tab) {
        return isNoSuchTab(error, tab) ? notFound() : unavailable();
    }

    private boolean isNoSuchTab(CdpException error, Tab tab) {
        if (error.kind() != CdpException.Kind.REMOTE) {
            return false;
        }
        lock.lock();
        try {
            boolean gone = tab != null && !tabs.containsKey(tab.id);
            return gone || error.code() == CdpException.INVALID_PARAMS;
        } finally {
            lock.unlock();
        }
    }

    /** A command that only reads. */
    private Map<String, Object> onTab(Tab tab, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        return onSession(tab, sessionFor(tab, timing.sessionWait()), method, params, timeout);
    }

    /** A command that changes something: it gets a session first, as that can take a while. */
    private Map<String, Object> applyOnTab(RpcContext context, Tab tab, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException, RpcException {
        String session = sessionFor(tab, timing.sessionWait());
        aboutToApply(context);
        return onSession(tab, session, method, params, timeout);
    }

    /** A session that's gone gets replaced once. */
    private Map<String, Object> onSession(Tab tab, String session, String method, Map<String, Object> params, Duration timeout)
            throws CdpException, InterruptedException {
        try {
            return cdp.call(session, method, params, timeout);
        } catch (CdpException e) {
            if (e.kind() != CdpException.Kind.REMOTE || e.code() != CdpException.SESSION_NOT_FOUND) {
                throw e;
            }
            lock.lock();
            try {
                forgetSession(tab);
            } finally {
                lock.unlock();
            }
            return cdp.call(sessionFor(tab, timing.sessionWait()), method, params, timeout);
        }
    }

    private String sessionFor(Tab tab, Duration wait) throws CdpException, InterruptedException {
        CompletableFuture<String> attach;
        lock.lock();
        try {
            if (tab.sessionId != null) {
                return tab.sessionId;
            }
            attach = startAttach(tab);
        } finally {
            lock.unlock();
        }
        try {
            return attach.get(wait.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            throw CdpException.notSent();
        } catch (ExecutionException e) {
            // The attach went out and timed out. The command it was for never went out at all.
            if (e.getCause() instanceof CdpException cause) {
                throw cause.kind() == CdpException.Kind.TIMEOUT ? CdpException.notSent() : cause;
            }
            throw CdpException.disconnected();
        }
    }

    // ---- what Chromium says

    /** Clears the model, then takes the targets as they are now. Runs on the connector thread, and {@link #takeTargets} doesn't. */
    @Override
    public void onConnected() throws CdpException, InterruptedException {
        lock.lock();
        try {
            clearModel();
        } finally {
            lock.unlock();
        }
        cdp.call(null, "Target.setDiscoverTargets", Map.of("discover", true, "filter", PAGES_ONLY), timing.request());
        cdp.call("Target.getTargets", Map.of("filter", PAGES_ONLY), timing.request(), this::takeTargets);
        List<Thread> attaching = new ArrayList<>();
        lock.lock();
        try {
            for (Tab tab : tabs.values()) {
                if (tab.attachThread != null) {
                    attaching.add(tab.attachThread);
                }
            }
        } finally {
            lock.unlock();
        }
        long deadline = System.nanoTime() + timing.settle().toNanos();
        for (Thread thread : attaching) {
            long left = deadline - System.nanoTime();
            if (left > 0) {
                thread.join(Duration.ofNanos(left));
            }
        }
        refreshList();
        lock.lock();
        try {
            // It can have gone during all that, and then nothing else would ever clear this.
            if (!cdp.isConnected()) {
                throw CdpException.disconnected();
            }
            ready = true;
            readySinceNanos = System.nanoTime();
            lastTickNanos = readySinceNanos;
            readyChanged.signalAll();
            tickDue = true;
            scheduleTick();
        } finally {
            lock.unlock();
        }
    }

    /**
     * A new connection's first read, the one read that can add a tab, since there's nothing yet for it to be out of date
     * against. Runs on the read path, as a tab's end can come right after this, and taken any later it would bring the
     * tab back, with nothing left to say otherwise.
     */
    private void takeTargets(Map<String, Object> targets) {
        Set<String> now;
        lock.lock();
        try {
            if (!(targets.get("targetInfos") instanceof List<?> infos)) {
                return;
            }
            for (Object info : infos) {
                if (info instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> fields = (Map<String, Object>) info;
                    upsert(fields);
                }
            }
            now = Set.copyOf(tabs.keySet());
        } finally {
            lock.unlock();
        }
        // The simplified view lets go of every tab that went while there was no connection (review 5).
        TabEvents minified = minifiedEvents;
        if (minified != null) {
            minified.onTabsNow(now);
        }
    }

    @Override
    public void onDisconnected(boolean unexpected) {
        lock.lock();
        try {
            clearModel();
            readyChanged.signalAll();
            forgetSubscribersIfNone();
        } finally {
            lock.unlock();
        }
        TabEvents minified = minifiedEvents;
        if (minified != null) {
            minified.onDisconnected();
        }
        // Ready or still settling: either way Chromium was there, and may have gone for good.
        if (unexpected) {
            log.info("chromium connection lost");
            browserLost.run();
        }
    }

    @Override
    public void onAttemptFailed() {
        lock.lock();
        try {
            attemptFailures++;
            lastFailureNanos = System.nanoTime();
            readyChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onDisplaced() {
        browserDisplaced.run();
    }

    @Override
    public void onEvent(String method, String sessionId, Map<String, Object> params) {
        String sessionTab = null;
        String gone = null;
        lock.lock();
        try {
            Tab onSession = sessionId == null ? null : bySession.get(sessionId);
            sessionTab = onSession == null ? null : onSession.id;
            switch (method) {
                case "Target.targetCreated", "Target.targetInfoChanged" -> {
                    Map<String, Object> info = Json.object(params, "targetInfo");
                    if (info != null) {
                        upsert(info);
                    }
                }
                case "Target.targetDestroyed" -> {
                    gone = Json.string(params, "targetId");
                    removeTab(gone);
                }
                case "Target.detachedFromTarget" -> {
                    Tab tab = bySession.get(Json.string(params, "sessionId"));
                    if (tab != null) {
                        forgetSession(tab);
                    }
                }
                case "Target.targetCrashed" -> {
                    Tab tab = tabs.get(Json.string(params, "targetId"));
                    if (tab != null) {
                        setLoading(tab, false);
                    }
                }
                case "Page.frameStartedLoading" -> onLoading(sessionId, Json.string(params, "frameId"), true);
                case "Page.frameStoppedLoading" -> onLoading(sessionId, Json.string(params, "frameId"), false);
                case "Page.frameNavigated" -> onFrameNavigated(sessionId, Json.object(params, "frame"));
                case "Page.navigatedWithinDocument" -> onWithinDocument(sessionId, Json.string(params, "frameId"));
                case "Page.domContentEventFired", "Page.loadEventFired" -> onTitleLikelyNew(sessionId);
                default -> {
                    // Page.enable sends much more, and none of it matters here.
                }
            }
        } finally {
            lock.unlock();
        }
        TabEvents minified = minifiedEvents;
        if (minified != null) {
            if (gone != null) {
                minified.onTabGone(gone);
            } else {
                minified.onEvent(method, sessionId, sessionTab, params);
            }
        }
    }

    // ---- what the simplified view may do

    /** The simplified view's way to the tabs (browser/minified's {@link TabAccess}): nothing but these. */
    TabAccess minifiedAccess() {
        return new MinifiedAccess();
    }

    private final class MinifiedAccess implements TabAccess {

        /** Never asks for a thaw: work does, through {@link #use} first, and a watcher waits for one (ADR 0045). */
        @Override
        public TabRef resolve(String tabId) throws RpcException, InterruptedException {
            if (!awaitReady(timing.callWait(), false)) {
                throw unavailable();
            }
            Tab tab = BrowserTabs.this.resolve(tabId);
            String session;
            try {
                session = sessionFor(tab, timing.sessionWait());
            } catch (CdpException e) {
                throw toRpc(e, tab);
            }
            lock.lock();
            try {
                if (tabs.get(tab.id) != tab) {
                    throw notFound();
                }
                return new TabRef(tab.id, session, tab.url, tab.title, tab.mainFrameId, tab.mainLoaderId);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public Map<String, Object> call(TabRef ref, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            return onRef(ref, method, params, timeout, false);
        }

        @Override
        public Map<String, Object> callLong(TabRef ref, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            return onRef(ref, method, params, timeout, true);
        }

        private Map<String, Object> onRef(TabRef ref, String method, Map<String, Object> params, Duration timeout, boolean longReply)
                throws CdpFailure, InterruptedException {
            lastCallNanos = System.nanoTime();
            Tab tab;
            lock.lock();
            try {
                tab = tabs.get(ref.tabId());
            } finally {
                lock.unlock();
            }
            if (tab == null || !tab.member) {
                throw new CdpFailure(CdpFailure.Kind.GONE, 0);
            }
            try {
                String session = sessionFor(tab, timing.sessionWait());
                if (longReply) {
                    return cdp.callLong(session, method, params, timeout);
                }
                return onSession(tab, session, method, params, timeout);
            } catch (CdpException e) {
                throw failure(e);
            }
        }

        @Override
        public Map<String, Object> callSession(String sessionId, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            lastCallNanos = System.nanoTime();
            try {
                return cdp.call(sessionId, method, params, timeout);
            } catch (CdpException e) {
                throw failure(e);
            }
        }

        @Override
        public boolean isActive(String tabId) {
            lock.lock();
            try {
                return activeKnown && tabId.equals(activeId);
            } finally {
                lock.unlock();
            }
        }

        @Override
        public void listen(TabEvents events, BooleanSupplier wanted) {
            minifiedWanted = wanted;
            minifiedEvents = events;
        }

        @Override
        public void wake() {
            BrowserTabs.this.wake();
        }

        /** Thaws Chromium first, and keeps it from freezing until it's closed and for the grace after (ADR 0045). */
        @Override
        public AutoCloseable use() throws InterruptedException {
            lastCallNanos = System.nanoTime();
            return freeze.use();
        }

        /** From the moment a freeze begins, not just once it's done, so nothing here undoes one by asking. */
        @Override
        public boolean frozen() {
            return !freeze.cdpAllowed();
        }

        private CdpFailure failure(CdpException e) {
            return new CdpFailure(switch (e.kind()) {
                case DISCONNECTED -> CdpFailure.Kind.DISCONNECTED;
                case TIMEOUT -> CdpFailure.Kind.TIMEOUT;
                case NOT_SENT -> CdpFailure.Kind.NOT_SENT;
                case REMOTE -> CdpFailure.Kind.REMOTE;
            }, e.code());
        }
    }

    private void upsert(Map<String, Object> info) {
        String id = Json.string(info, "targetId");
        if (!isPlainId(id) || !isTab(info)) {
            return;
        }
        Tab tab = tabs.get(id);
        if (tab == null) {
            if (tabs.size() >= MAX_TABS) {
                return;
            }
            tab = new Tab(id);
            tabs.put(id, tab);
            listDue = true;
        }
        tab.url = TabText.clean(Json.string(info, "url"), URL_CHARS);
        tab.title = TabText.clean(Json.string(info, "title"), TITLE_CHARS);
        tab.member = isMemberUrl(tab.url);
        if (tab.member && tab.sessionId == null) {
            startAttach(tab);
        }
        scheduleTick();
    }

    /** Only pages, and no prerendered page: that one isn't anything the member opened. */
    private static boolean isTab(Map<String, Object> info) {
        return "page".equals(Json.string(info, "type")) && Json.string(info, "subtype") == null;
    }

    /** Chromium's ids are hex. Anything else isn't one, and this keeps them safe to pass around. */
    private static boolean isPlainId(String id) {
        if (id == null || id.isEmpty() || id.length() > MAX_ID_CHARS) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && c != '-' && c != '_') {
                return false;
            }
        }
        return true;
    }

    private static boolean isMemberUrl(String url) {
        String lower = url.toLowerCase(Locale.ROOT);
        if (NEW_TAB_PAGES.contains(lower)) {
            return true;
        }
        for (String prefix : INTERNAL_PREFIXES) {
            if (lower.startsWith(prefix)) {
                return false;
            }
        }
        return true;
    }

    private void onLoading(String sessionId, String frameId, boolean loading) {
        Tab tab = bySession.get(sessionId);
        if (tab != null && tab.mainFrameId.equals(frameId)) {
            setLoading(tab, loading);
            listDue |= !loading;
        }
    }

    private void onTitleLikelyNew(String sessionId) {
        if (bySession.containsKey(sessionId)) {
            listDue = true;
            scheduleTick();
        }
    }

    private void setLoading(Tab tab, boolean loading) {
        if (tab.loading != loading) {
            tab.loading = loading;
            scheduleTick();
        }
    }

    private void onFrameNavigated(String sessionId, Map<String, Object> frame) {
        Tab tab = bySession.get(sessionId);
        if (tab == null || frame == null || frame.get("parentId") != null) {
            return;
        }
        String frameId = Json.string(frame, "id");
        if (isPlainId(frameId)) {
            tab.mainFrameId = frameId;
        }
        String loaderId = Json.string(frame, "loaderId");
        tab.mainLoaderId = isPlainId(loaderId) ? loaderId : null;
        markHistoryDirty(tab);
        String unreachable = Json.string(frame, "unreachableUrl");
        if (unreachable != null) {
            errorPageCommitted(tab, sessionId, unreachable);
        }
    }

    /**
     * With the lock held, on the read path or right after an attach: the main frame shows Chromium's error page for
     * {@code unreachableUrl}, as of the commit {@code tab.mainLoaderId} names. Each such commit goes to the filter once.
     */
    private void errorPageCommitted(Tab tab, String sessionId, String unreachableUrl) {
        String loaderId = tab.mainLoaderId;
        if (!filtered.active() || loaderId == null || loaderId.equals(tab.filterLoaderId)) {
            return;
        }
        tab.filterLoaderId = loaderId;
        filtered.errorPageCommitted(unreachableUrl, new TabErrorPage(tab, sessionId, tab.mainFrameId, loaderId));
    }

    /**
     * A tab already on an error page when deskd attached, as a restored tab or one opened straight onto a filtered site
     * can be, has no commit to tell of it. Only on a teen's desk, and one call per tab.
     */
    private void lookForErrorPage(Tab tab, String sessionId) throws InterruptedException {
        Map<String, Object> frame;
        try {
            Map<String, Object> tree = Json.object(cdp.call(sessionId, "Page.getFrameTree", Map.of(), timing.request()), "frameTree");
            frame = tree == null ? null : Json.object(tree, "frame");
        } catch (CdpException e) {
            log.debug("couldn't read a tab's frame: {}", e.kind());
            return;
        }
        if (frame == null) {
            return;
        }
        String unreachable = Json.string(frame, "unreachableUrl");
        String loaderId = Json.string(frame, "loaderId");
        String frameId = Json.string(frame, "id");
        if (unreachable == null || !isPlainId(loaderId) || !isPlainId(frameId)) {
            return;
        }
        lock.lock();
        try {
            if (tabs.get(tab.id) != tab || !sessionId.equals(tab.sessionId)) {
                return;
            }
            // A commit heard since the attach is newer than this answer, or the same one.
            if (tab.mainLoaderId == null) {
                tab.mainLoaderId = loaderId;
                tab.mainFrameId = frameId;
            }
            if (loaderId.equals(tab.mainLoaderId)) {
                errorPageCommitted(tab, sessionId, unreachable);
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * One commit of the error page, for {@link FilteredSites}. Each step looks first that no other commit has been heard
     * of since. A world is made in whatever document the frame holds when Chromium gets the call, so that's looked at
     * again once it has answered, and with still no other commit heard of, the world is this page's. Both scripts run in
     * it, and each checks first that it's Chromium's error page.
     */
    private final class TabErrorPage implements FilteredSites.ErrorPage {
        private final Tab tab;
        private final String sessionId;
        private final String frameId;
        private final String loaderId;
        private volatile Number world;

        TabErrorPage(Tab tab, String sessionId, String frameId, String loaderId) {
            this.tab = tab;
            this.sessionId = sessionId;
            this.frameId = frameId;
            this.loaderId = loaderId;
        }

        @Override
        public String errorCode() throws CdpException, InterruptedException {
            if (!stillShown()) {
                return null;
            }
            Map<String, Object> made = cdp.call(
                    sessionId, "Page.createIsolatedWorld", Map.of("frameId", frameId, "worldName", ISOLATED_WORLD), timing.request());
            if (!(made.get("executionContextId") instanceof Number context)) {
                return null;
            }
            String code = evaluate(context, ERROR_CODE);
            if (!stillShown()) {
                return null;
            }
            world = context;
            return code == null || code.isEmpty() ? null : code;
        }

        @Override
        public boolean replace(String html) throws CdpException, InterruptedException {
            Number context = world;
            if (context == null || !stillShown()) {
                return false;
            }
            return "written".equals(evaluate(context, writeExpression(html)));
        }

        /**
         * {@code html} in place of the error page, in the world made in that document, which goes with it: a page that has
         * replaced it since is never written over, as the call fails instead. {@code Page.setDocumentContent} works on an
         * error page too (checked on Chrome 156), but it takes a frame, and so writes over whatever is in it by then.
         */
        private static String writeExpression(String html) {
            return "location.href === '" + ERROR_PAGE_URL + "' ? (document.open(), document.write("
                    + new String(Json.bytes(html), StandardCharsets.UTF_8) + "), document.close(), 'written') : ''";
        }

        private String evaluate(Number context, String expression) throws CdpException, InterruptedException {
            Map<String, Object> reply = cdp.call(
                    sessionId, "Runtime.evaluate", Map.of("expression", expression, "contextId", context, "returnByValue", true),
                    timing.request());
            Map<String, Object> result = Json.object(reply, "result");
            return result == null ? null : Json.string(result, "value");
        }

        private boolean stillShown() {
            lock.lock();
            try {
                return !closed && tabs.get(tab.id) == tab && sessionId.equals(tab.sessionId) && loaderId.equals(tab.mainLoaderId);
            } finally {
                lock.unlock();
            }
        }
    }

    private void onWithinDocument(String sessionId, String frameId) {
        Tab tab = bySession.get(sessionId);
        if (tab != null && tab.mainFrameId.equals(frameId)) {
            markHistoryDirty(tab);
        }
    }

    private void markHistoryDirty(Tab tab) {
        tab.historyDirty = true;
        listDue = true;
        scheduleTick();
    }

    private void removeTab(String id) {
        Tab tab = id == null ? null : tabs.remove(id);
        if (tab != null) {
            if (tab.sessionId != null) {
                bySession.remove(tab.sessionId);
            }
            if (id.equals(activeId)) {
                activeId = null;
            }
            listDue = true;
            scheduleTick();
        }
    }

    private void forgetSession(Tab tab) {
        if (tab.sessionId != null) {
            bySession.remove(tab.sessionId);
            tab.sessionId = null;
        }
    }

    private void clearModel() {
        ready = false;
        tabs.clear();
        bySession.clear();
        activeId = null;
        activeGuessId = null;
        activeKnown = false;
        hiddenAbove = List.of();
    }

    /** With the lock held. A thread, since the read path can't wait for a reply. */
    private CompletableFuture<String> startAttach(Tab tab) {
        if (tab.attaching != null) {
            return tab.attaching;
        }
        CompletableFuture<String> attach = new CompletableFuture<>();
        tab.attaching = attach;
        tab.attachThread = Thread.ofVirtual().name("cdp-attach").start(() -> attach(tab, attach));
        return attach;
    }

    private void attach(Tab tab, CompletableFuture<String> result) {
        try {
            Map<String, Object> attached = cdp.call(
                    null, "Target.attachToTarget", Map.of("targetId", tab.id, "flatten", true), timing.request());
            String sessionId = Json.string(attached, "sessionId");
            if (!isPlainId(sessionId)) {
                throw CdpException.remote(0);
            }
            lock.lock();
            try {
                if (tabs.get(tab.id) == tab) {
                    tab.sessionId = sessionId;
                    bySession.put(sessionId, tab);
                }
                tab.attaching = null;
            } finally {
                lock.unlock();
            }
            result.complete(sessionId);
            // A hung page can leave these unanswered. Calls on the tab don't wait for them.
            cdp.call(sessionId, "Page.enable", Map.of(), timing.request());
            readHistory(tab, sessionId);
            if (filtered.active()) {
                lookForErrorPage(tab, sessionId);
            }
        } catch (CdpException e) {
            lock.lock();
            try {
                tab.attaching = null;
            } finally {
                lock.unlock();
            }
            result.completeExceptionally(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            result.completeExceptionally(CdpException.disconnected());
        } finally {
            lock.lock();
            try {
                tab.attachThread = null;
            } finally {
                lock.unlock();
            }
        }
    }

    private void readHistory(Tab tab, String sessionId) throws CdpException, InterruptedException {
        Map<String, Object> history = cdp.call(sessionId, "Page.getNavigationHistory", Map.of(), timing.request());
        if (!(history.get("currentIndex") instanceof Number index) || !(history.get("entries") instanceof List<?> entries)) {
            return;
        }
        lock.lock();
        try {
            boolean back = index.intValue() > 0;
            boolean forward = index.intValue() < entries.size() - 1;
            if (tab.canGoBack != back || tab.canGoForward != forward) {
                tab.canGoBack = back;
                tab.canGoForward = forward;
                scheduleTick();
            }
        } finally {
            lock.unlock();
        }
    }

    // ---- the model as a client sees it

    private int memberCount() {
        int count = 0;
        for (Tab tab : tabs.values()) {
            if (tab.member) {
                count++;
            }
        }
        return count;
    }

    /** The tab a list marks active: exactly one if there are any, so it's a guess if none is known. */
    private Tab activeTab() {
        for (String id : Arrays.asList(activeId, activeGuessId)) {
            Tab tab = id == null ? null : tabs.get(id);
            if (tab != null && tab.member) {
                return tab;
            }
        }
        for (Tab tab : tabs.values()) {
            if (tab.member) {
                return tab;
            }
        }
        return null;
    }

    private List<Map<String, Object>> tabList() {
        lock.lock();
        try {
            Tab active = activeTab();
            List<Map<String, Object>> list = new ArrayList<>();
            int bytes = 0;
            for (Tab tab : tabs.values()) {
                if (tab.member) {
                    Map<String, Object> entry = entry(tab, tab == active, tab.url, tab.title);
                    bytes += Json.bytes(entry).length + 1;
                    list.add(entry);
                }
            }
            return bytes <= MAX_LIST_BYTES ? list : tightList(active);
        } finally {
            lock.unlock();
        }
    }

    /** Only with hostile or enormous tabs. The active one always stays, and the shape never changes. */
    private List<Map<String, Object>> tightList(Tab active) {
        List<Map<String, Object>> list = new ArrayList<>();
        int bytes = 0;
        if (active != null) {
            Map<String, Object> entry = tightEntry(active, true);
            bytes += Json.bytes(entry).length + 1;
            list.add(entry);
        }
        for (Tab tab : tabs.values()) {
            if (tab.member && tab != active) {
                Map<String, Object> entry = tightEntry(tab, false);
                int size = Json.bytes(entry).length + 1;
                if (bytes + size > MAX_LIST_BYTES) {
                    break;
                }
                bytes += size;
                list.add(entry);
            }
        }
        return list;
    }

    private static Map<String, Object> tightEntry(Tab tab, boolean active) {
        return entry(tab, active, TabText.clean(tab.url, TIGHT_URL_CHARS), TabText.clean(tab.title, TIGHT_TITLE_CHARS));
    }

    private static Map<String, Object> entry(Tab tab, boolean active, String url, String title) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("tabId", tab.id);
        entry.put("url", url);
        entry.put("title", title);
        entry.put("loading", tab.loading);
        entry.put("active", active);
        entry.put("canGoBack", tab.canGoBack);
        entry.put("canGoForward", tab.canGoForward);
        return entry;
    }

    // ---- publishing

    /** With the lock held. */
    private void scheduleTick() {
        tickDue = true;
        startTicker();
        tickWake.signalAll();
    }

    /**
     * With the lock held. At most one ticker exists, and it goes away once nothing has changed and nobody
     * is both subscribed and viewing. It's started again by the next change, by a subscriber or by a viewer.
     */
    private void startTicker() {
        if (ready && ticker == null && !closed) {
            ticker = Thread.ofVirtual().name("browser-tabs-tick").start(this::tickLoop);
        }
    }

    private void tickLoop() {
        try {
            while (true) {
                long wakesBefore;
                lock.lock();
                try {
                    wakesBefore = wakes;
                } finally {
                    lock.unlock();
                }
                boolean poll = viewer.getAsBoolean() && hub.hasSubscribers(TOPIC);
                lock.lock();
                try {
                    if (closed || !ready) {
                        ticker = null;
                        return;
                    }
                    if (!tickDue && !poll) {
                        // A wake while that was asked may have made it true, and found this ticker still here.
                        if (wakes != wakesBefore) {
                            continue;
                        }
                        ticker = null;
                        return;
                    }
                    long now = System.nanoTime();
                    long readIn = lastListNanos + timing.listEvery().toNanos() - now;
                    // Any tick can publish, so none comes sooner than this. With no change waiting, this one is for a read.
                    long wait = lastTickNanos + timing.publishEvery().toNanos() - now;
                    if (!tickDue) {
                        wait = Math.max(wait, readIn);
                    }
                    if (wait > 0) {
                        tickWake.awaitNanos(wait);
                        continue;
                    }
                    tickDue = false;
                    // A tick for a change isn't a read as well: that's how a page changing its title got four a second.
                    listDue |= poll && readIn <= 0;
                    lastTickNanos = now;
                } finally {
                    lock.unlock();
                }
                tick();
            }
        } catch (InterruptedException e) {
            lock.lock();
            try {
                ticker = null;
            } finally {
                lock.unlock();
            }
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            lock.lock();
            try {
                ticker = null;
            } finally {
                lock.unlock();
            }
            log.error("publishing tabs failed: {}", e.getClass().getName());
        }
    }

    /**
     * With the lock held, and it has to be. A SUB counts as subscribed before its snapshot starts, and what a snapshot
     * leaves goes in under this lock, so this comes wholly before that or sees the subscriber. Looked at first and
     * acted on after, it could wipe what a snapshot had just left, and with nothing last published and nothing owed
     * no tick would ever publish to that client again.
     *
     * @return true if nobody is subscribed
     */
    private boolean forgetSubscribersIfNone() {
        if (hub.hasSubscribers(TOPIC)) {
            return false;
        }
        lastPublished = null;
        owed = false;
        return true;
    }

    private void tick() throws InterruptedException {
        boolean readList;
        lock.lock();
        try {
            if (forgetSubscribersIfNone()) {
                // A call looks for itself, so nothing needs doing until someone subscribes.
                return;
            }
            readList = listDue;
        } finally {
            lock.unlock();
        }
        if (readList) {
            refreshList();
        }
        refreshHistories();
        Map<String, Object> data = Map.of("tabs", tabList());
        byte[] encoded = Json.bytes(data);
        lock.lock();
        try {
            // With nothing last published and nothing owed, a SUB's snapshot is on its way, and it says all this does.
            if (!ready || (!owed && (lastPublished == null || Arrays.equals(lastPublished, encoded)))) {
                return;
            }
            owed = false;
            lastPublished = encoded;
        } finally {
            lock.unlock();
        }
        hub.publish(TOPIC, "snapshot", data);
    }

    /**
     * Titles as they are now, and which tab is on screen. Failing to read either isn't worth failing a read
     * over, as a list can show the last it knew, and neither says Chromium has gone. A call that leaves out a
     * tabId goes by {@link #activeKnown}, which needs the order and no title.
     *
     * <p>The two go side by side, and a list that can't be read ends the wait for the other, so a read costs what
     * a list always did, stuck or refused, whatever the targets do.
     */
    private void refreshList() throws InterruptedException {
        long read;
        lock.lock();
        try {
            listDue = false;
            lastListNanos = System.nanoTime();
            read = ++listReads;
        } finally {
            lock.unlock();
        }
        long titlesBy = System.nanoTime() + timing.cdp().http().toNanos();
        CompletableFuture<Void> titles =
                cdp.ask("Target.getTargets", Map.of("filter", PAGES_ONLY), targets -> takeTitles(read, targets));
        List<String> order;
        try {
            order = readOrder();
            if (order != null) {
                awaitTitles(titles, titlesBy);
            }
        } finally {
            titles.cancel(false);
        }
        if (order == null) {
            settleActive(read, new Search(false, null, List.of()), List.of());
            return;
        }
        List<Tab> listed = new ArrayList<>(order.size());
        Tab known;
        List<String> hiddenBefore;
        lock.lock();
        try {
            for (String id : order) {
                Tab tab = tabs.get(id);
                if (tab != null) {
                    listed.add(tab);
                }
            }
            known = activeId == null ? null : tabs.get(activeId);
            known = known != null && known.member ? known : null;
            hiddenBefore = hiddenAbove;
        } finally {
            lock.unlock();
        }
        List<Tab> recentFirst = new ArrayList<>(listed.size());
        boolean internalAbove = false;
        boolean passedKnown = false;
        for (Tab tab : listed) {
            passedKnown |= tab == known;
            if (tab.member) {
                recentFirst.add(tab);
            } else {
                internalAbove |= !passedKnown;
            }
        }
        settleActive(read, findOnScreen(recentFirst, known, internalAbove, hiddenBefore), recentFirst);
    }

    /** @return the ids, most recent first, or null if the list can't be read, as while Chromium may be frozen */
    private List<String> readOrder() throws InterruptedException {
        if (!freeze.cdpAllowed()) {
            return null;
        }
        try {
            return cdp.pageOrder();
        } catch (IOException e) {
            log.debug("couldn't read the target list: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    /** No answer by the deadline, a {@link System#nanoTime}, leaves the titles as they were. */
    private static void awaitTitles(CompletableFuture<Void> titles, long deadline) throws InterruptedException {
        try {
            titles.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
        } catch (TimeoutException | ExecutionException e) {
            log.debug("couldn't read the targets: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * What one read of the targets says of the tabs deskd knows. Runs on the read path. It never adds or removes a
     * tab: those go by the events, as a tab that isn't in here may be new, and one that is may have gone since.
     */
    private void takeTitles(long read, Map<String, Object> targets) {
        lock.lock();
        try {
            if (read < titlesRead || !(targets.get("targetInfos") instanceof List<?> infos)) {
                return;
            }
            titlesRead = read;
            boolean changed = false;
            for (Object entry : infos) {
                if (entry instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> info = (Map<String, Object>) entry;
                    changed |= takeTitle(info);
                }
            }
            // Whoever is reading this may not be the one publishing it.
            if (changed) {
                scheduleTick();
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * With the lock held. An entry that doesn't say leaves what's known.
     *
     * @return whether that changed what a client sees
     */
    private boolean takeTitle(Map<String, Object> info) {
        Tab tab = tabs.get(Json.string(info, "targetId"));
        String rawUrl = Json.string(info, "url");
        String rawTitle = Json.string(info, "title");
        if (tab == null || !isTab(info) || rawUrl == null || rawTitle == null) {
            return false;
        }
        String url = TabText.clean(rawUrl, URL_CHARS);
        String title = TabText.clean(rawTitle, TITLE_CHARS);
        boolean changed = !url.equals(tab.url) || !title.equals(tab.title);
        tab.url = url;
        tab.title = title;
        tab.member = isMemberUrl(url);
        return changed;
    }

    /**
     * @param known whether it's known
     * @param onScreen the tab on screen, or null for none of the member's, if that's known
     * @param hidden the tabs found hidden above it
     */
    private record Search(boolean known, Tab onScreen, List<String> hidden) {}

    /**
     * Showing a tab moves it to the top of the list, so nothing below the last tab known to be on screen
     * can have taken over, and of what's above it only the first can have been shown without moving. So
     * it's rare for this to ask more than one tab, and with that tab first in the list it asks none.
     *
     * @param internalAbove a page that isn't the member's is above that tab, so it may be the one on
     *     screen. deskd never asks those, so that tab is asked instead
     * @param hiddenBefore what the last search found hidden above that tab
     */
    private Search findOnScreen(List<Tab> recentFirst, Tab known, boolean internalAbove, List<String> hiddenBefore)
            throws InterruptedException {
        List<String> above = new ArrayList<>();
        for (Tab tab : recentFirst) {
            if (tab == known) {
                break;
            }
            above.add(tab.id);
        }
        long deadline = System.nanoTime() + timing.visibility().toNanos() * VISIBILITY_WAITS;
        boolean nothingMoved = above.equals(hiddenBefore);
        boolean allAnswered = true;
        for (int i = 0; i < recentFirst.size(); i++) {
            Tab tab = recentFirst.get(i);
            if (tab == known && allAnswered && !internalAbove) {
                return new Search(true, known, above);
            }
            if (i > 0 && nothingMoved && tab != known && allAnswered) {
                continue;
            }
            Boolean onScreen = isOnScreen(tab, deadline);
            if (Boolean.TRUE.equals(onScreen)) {
                return new Search(true, tab, tab == known ? above : List.of());
            }
            allAnswered &= onScreen != null;
            if (tab == known) {
                // It's asked only with a doubt above it, and nothing below it can be the one instead.
                break;
            }
        }
        return new Search(allAnswered, null, allAnswered ? above : List.of());
    }

    /** @return null if the tab didn't say in time, as a hung page won't */
    private Boolean isOnScreen(Tab tab, long deadline) throws InterruptedException {
        long left = deadline - System.nanoTime();
        if (left <= 0) {
            return null;
        }
        Duration wait = Duration.ofNanos(Math.min(left, timing.visibility().toNanos()));
        try {
            String session = sessionFor(tab, wait);
            String frameId;
            lock.lock();
            try {
                frameId = tab.mainFrameId;
            } finally {
                lock.unlock();
            }
            Map<String, Object> world = cdp.call(
                    session, "Page.createIsolatedWorld", Map.of("frameId", frameId, "worldName", ISOLATED_WORLD), wait);
            if (!(world.get("executionContextId") instanceof Number context)) {
                return null;
            }
            Map<String, Object> reply = cdp.call(
                    session, "Runtime.evaluate", Map.of("expression", VISIBILITY_STATE, "contextId", context, "returnByValue", true), wait);
            Map<String, Object> result = Json.object(reply, "result");
            String state = result == null ? null : Json.string(result, "value");
            return state == null ? null : "visible".equals(state);
        } catch (CdpException e) {
            log.debug("a tab didn't say whether it's on screen: {}", e.kind());
            return null;
        }
    }

    private void settleActive(long read, Search search, List<Tab> recentFirst) {
        lock.lock();
        try {
            if (read < activeRead) {
                return;
            }
            activeRead = read;
            activeKnown = search.known();
            hiddenAbove = search.hidden();
            if (search.known()) {
                String id = search.onScreen() == null ? null : search.onScreen().id;
                if (id == null && activeId != null) {
                    activeGuessId = activeId;
                } else if (id == null && (activeGuessId == null || !tabs.containsKey(activeGuessId))) {
                    activeGuessId = recentFirst.isEmpty() ? null : recentFirst.get(0).id;
                }
                if (!Objects.equals(id, activeId)) {
                    activeId = id;
                    scheduleTick();
                }
            }
        } finally {
            lock.unlock();
        }
    }

    private void refreshHistories() throws InterruptedException {
        List<Tab> dirty = new ArrayList<>(0);
        lock.lock();
        try {
            for (Tab tab : tabs.values()) {
                if (tab.historyDirty && tab.sessionId != null) {
                    tab.historyDirty = false;
                    dirty.add(tab);
                }
            }
        } finally {
            lock.unlock();
        }
        for (Tab tab : dirty) {
            String sessionId;
            lock.lock();
            try {
                sessionId = tab.sessionId;
            } finally {
                lock.unlock();
            }
            if (sessionId != null) {
                try {
                    readHistory(tab, sessionId);
                } catch (CdpException e) {
                    log.debug("couldn't read a tab's history: {}", e.kind());
                }
            }
        }
    }
}
