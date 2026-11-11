package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Agent's Browser, as the Agent's tools use it ({@link AgentBrowsing} on a desk). Every tab here is a run's own: a tab
 * of the run's off-the-record context, or the run's one tab in the member's own session for a site the member granted.
 * None is ever a member's tab, in {@code browser.tabs}, the tab on screen, or on the streamed display.
 *
 * <p>Failures are {@link RpcException}s whose {@code details.reason} is one word: {@code not_found}, {@code tab_cap},
 * {@code ask_cap}, {@code off_site}, {@code url}, {@code blocked}, {@code changed}, {@code gone}, {@code sensitive},
 * {@code timeout}, {@code disabled}, {@code chromium}. None ever holds a URL, a title or page text.
 */
public interface AgentBrowser {

    /** Agent tabs on the desk at once, in the Agent's own contexts. */
    int TAB_CAP = 2;
    /** On a free desk. */
    int FREE_TAB_CAP = 1;
    /** Sites of the member's session a run may hold. */
    int SITES_A_RUN = 2;

    /**
     * One of a run's tabs.
     *
     * @param site the member's site this tab is in their session for, or null for the run's own context
     * @param url where it is now, as Chromium last said; untrusted
     * @param title its title; untrusted
     * @param document its main frame's document as Chromium names it, or empty: a new one is a new page
     */
    record Tab(String tabId, String runId, String site, String url, String title, String document) {
        public boolean member() {
            return site != null;
        }
    }

    /** What a navigation came to: the error Chromium gave, or null. */
    record Navigated(String tabId, String netError) {}

    /** Whether it can work now: the simplified view's kill switch is on, and the Browser is there. */
    boolean available();

    /** The run's tab, or null if it isn't one of this run's, or is gone. */
    Tab tab(String runId, String tabId);

    /** The run's tabs, in the order opened. */
    List<Tab> tabs(String runId);

    /** Tabs in the Agent's own contexts on the desk now, every run's. */
    int agentTabs();

    /** The cap that applies now: {@link #FREE_TAB_CAP} on a free desk. */
    int tabCap();

    /** The sites of the member's session this run holds. */
    Set<String> sites(String runId);

    /** A new tab in the run's own context, at this URL ({@link #checkUrl}'s). */
    Navigated open(String runId, String url) throws RpcException, InterruptedException;

    Navigated navigate(String runId, String tabId, String url) throws RpcException, InterruptedException;

    Navigated back(String runId, String tabId) throws RpcException, InterruptedException;

    /** Where {@link #back} would go, or null for nowhere. */
    String backUrl(String runId, String tabId) throws RpcException, InterruptedException;

    void close(String runId, String tabId) throws RpcException, InterruptedException;

    /** The run's tab in the member's own session for this site, opened at {@code https://<site>/} if it isn't open. */
    Navigated useSession(String runId, String site) throws RpcException, InterruptedException;

    /** The walker's view of the tab: {@code {tabId, rev, view, mdoc?, fallback?}}, as {@code browser.minified.get}. */
    Map<String, Object> read(String runId, String tabId) throws RpcException, InterruptedException;

    /** One action through the action proxy, as {@code browser.minified.act}: {@code {done, reason?}}. Not a spend. */
    default Map<String, Object> act(String runId, String tabId, String nodeId, String action, Object value, String fp, String block,
            long rev) throws RpcException, InterruptedException {
        return act(runId, tabId, nodeId, action, value, fp, block, rev, false);
    }

    /**
     * One action through the action proxy's Agent mode: a click or a key is deskd's half's own, from deskd's world, with
     * where it would navigate checked first ({@code off_site}, {@code blocked}); typing is {@code Input.insertText}.
     *
     * @param spend the member approved it as a spend: a payment provider's frame on the page is then what they saw, where
     *     otherwise a click or a submit there is refused {@code changed}
     * @return {@code {done, reason?, submitted?}}
     */
    Map<String, Object> act(String runId, String tabId, String nodeId, String action, Object value, String fp, String block, long rev,
            boolean spend) throws RpcException, InterruptedException;

    /**
     * Whether a payment provider's frame is anywhere in the tab now, whatever its size: in Chromium's frame tree, the
     * tab's and each out-of-process frame's, or as deskd's half sees the document. Any click or submit there is a spend
     * (Security, S-14). An unreadable tab counts as one.
     */
    boolean paymentFrame(String runId, String tabId) throws RpcException, InterruptedException;

    /** Whether the action proxy has refused this node as a sensitive field. */
    boolean refusedAsSensitive(String runId, String tabId, String nodeId);

    /** Whether the walker never reads this site: deskd's shipped list, or the member's own mark. */
    boolean sensitiveSite(String site);

    /** Whether a payment provider on deskd's list is on this host. */
    boolean paymentHost(String host);

    /** Everything the run holds goes: its tabs closed and its context disposed. Doesn't wait long. */
    void runEnded(String runId);

    /**
     * A URL the Agent may open: {@code http} or {@code https} by deskd's URL rules (API.md section 10), with no user
     * info, and never a host on the desk or its network (loopback, link-local, private, single-label, {@code .local}).
     *
     * @return the URL to give Chromium
     * @throws RpcException {@code bad_request} {@code url}, or {@code forbidden} {@code blocked} for a local host
     */
    static String checkUrl(String raw) throws RpcException {
        return AgentBrowsing.checkUrl(raw);
    }

    /** {@code scheme://host[:port]}, the host in punycode, or null. */
    static String originOf(String url) {
        return AgentBrowsing.originOf(url);
    }

    /** The registrable domain of a URL's host, or null. */
    static String siteOf(String url) {
        return AgentBrowsing.siteOf(url);
    }

    /** Whether this is a registrable domain the member could grant: a name, not an IP, a local name or a public suffix. */
    static boolean isSite(String site) {
        return AgentBrowsing.isSite(site);
    }

    /** A site as given, in ASCII (IDNA) and lower case, or null. */
    static String asciiSite(String raw) {
        return AgentBrowsing.asciiSite(raw);
    }

    /** The host an http or https URL is on, in ASCII and lower case, or null. */
    static String hostOf(String url) {
        return com.minimalistalliance.desk.deskd.browser.minified.AgentView.hostOf(url);
    }
}
