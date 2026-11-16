package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.browser.AgentBrowser;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/** The Agent's Browser in memory, for the Browser tools' own tests: tabs, pages as MDocs, and what was done. */
final class FakeAgentBrowser implements AgentBrowser {

    record Act(String runId, String tabId, String node, String action, Object value, String fp, String block, long rev) {}

    final Map<String, Tab> tabs = new ConcurrentHashMap<>();
    final Map<String, Map<String, Object>> pages = new ConcurrentHashMap<>();
    final Map<String, Set<String>> sites = new ConcurrentHashMap<>();
    final Map<String, String> backUrls = new ConcurrentHashMap<>();
    final Set<String> sensitiveSites = ConcurrentHashMap.newKeySet();
    final Set<String> paymentHosts = ConcurrentHashMap.newKeySet();
    final Set<String> refusedNodes = ConcurrentHashMap.newKeySet();
    final List<Act> acts = new CopyOnWriteArrayList<>();
    /** Each act's {@code spend}, in order. */
    final List<Boolean> spends = new CopyOnWriteArrayList<>();
    /** Each act's {@code submit}, in order. */
    final List<Boolean> submits = new CopyOnWriteArrayList<>();
    /** What deskd's half says a click on a node does ({@code {nav, url, search, pay}}), by node; none says nothing. */
    final Map<String, Map<String, Object>> clickLooks = new ConcurrentHashMap<>();
    /** What Enter in a node would submit ({@code {nav, url, search, button, pay}}), by node. */
    final Map<String, Map<String, Object>> enterLooks = new ConcurrentHashMap<>();
    /** Nodes whose click look the page refuses, with the reason. */
    final Map<String, String> clickLookRefusals = new ConcurrentHashMap<>();
    /** Each click look asked, by node. */
    final List<String> clickLooked = new CopyOnWriteArrayList<>();
    /** Tabs with a payment provider's frame somewhere in them. */
    final Set<String> paymentFrames = ConcurrentHashMap.newKeySet();
    final List<String> opened = new CopyOnWriteArrayList<>();
    final List<String> ended = new CopyOnWriteArrayList<>();
    volatile boolean available = true;
    volatile boolean free;
    volatile RpcException actFails;
    /** What a done act answers besides {@code done}: what followed it ({@code stopped}, {@code closed}). */
    volatile Map<String, Object> actAfter = Map.of();
    /** A read after an act fails so, once. */
    volatile RpcException readFailsOnce;
    private int next = 1;

    Tab addTab(String runId, String site, String url, String title) {
        String id = "AT" + next++;
        Tab tab = new Tab(id, runId, site, url, title, "doc1");
        tabs.put(id, tab);
        if (site != null) {
            sites.computeIfAbsent(runId, r -> new LinkedHashSet<>()).add(site);
        }
        return tab;
    }

    void page(String tabId, Map<String, Object> mdoc) {
        pages.put(tabId, mdoc);
    }

    @Override
    public boolean available() {
        return available;
    }

    @Override
    public Tab tab(String runId, String tabId) {
        Tab tab = tabId == null ? null : tabs.get(tabId);
        return tab == null || !tab.runId().equals(runId) ? null : tab;
    }

    @Override
    public List<Tab> tabs(String runId) {
        List<Tab> list = new ArrayList<>();
        for (Tab tab : tabs.values()) {
            if (tab.runId().equals(runId)) {
                list.add(tab);
            }
        }
        return list;
    }

    @Override
    public int agentTabs() {
        return tabs.size();
    }

    @Override
    public int tabCap() {
        return free ? FREE_TAB_CAP : TAB_CAP;
    }

    @Override
    public Set<String> sites(String runId) {
        return Set.copyOf(sites.getOrDefault(runId, Set.of()));
    }

    @Override
    public Navigated open(String runId, String url) throws RpcException {
        if (agentTabs() >= tabCap()) {
            throw new RpcException(RpcException.FORBIDDEN, "cap", Map.of("reason", "tab_cap", "limit", tabCap()));
        }
        opened.add(url);
        Tab tab = addTab(runId, null, url, "Opened");
        return new Navigated(tab.tabId(), null);
    }

    @Override
    public Navigated navigate(String runId, String tabId, String url) throws RpcException {
        Tab tab = require(runId, tabId);
        if (tab.member() && !tab.site().equals(AgentBrowser.siteOf(url))) {
            throw new RpcException(RpcException.CONFLICT, "off", Map.of("reason", "off_site"));
        }
        tabs.put(tabId, new Tab(tabId, runId, tab.site(), url, tab.title(), tab.document()));
        return new Navigated(tabId, null);
    }

    @Override
    public Navigated back(String runId, String tabId) throws RpcException {
        require(runId, tabId);
        return new Navigated(tabId, null);
    }

    @Override
    public String backUrl(String runId, String tabId) throws RpcException {
        require(runId, tabId);
        return backUrls.get(tabId);
    }

    @Override
    public void close(String runId, String tabId) throws RpcException {
        require(runId, tabId);
        tabs.remove(tabId);
    }

    @Override
    public Navigated useSession(String runId, String site) throws RpcException {
        for (Tab tab : tabs.values()) {
            if (tab.runId().equals(runId) && site.equals(tab.site())) {
                return new Navigated(tab.tabId(), null);
            }
        }
        if (agentTabs() >= tabCap()) {
            throw new RpcException(RpcException.FORBIDDEN, "cap", Map.of("reason", "tab_cap", "limit", tabCap()));
        }
        Tab tab = addTab(runId, site, "https://" + site + "/", "Home");
        return new Navigated(tab.tabId(), null);
    }

    @Override
    public Map<String, Object> read(String runId, String tabId) throws RpcException {
        require(runId, tabId);
        RpcException once = readFailsOnce;
        if (once != null) {
            readFailsOnce = null;
            throw once;
        }
        Map<String, Object> mdoc = pages.get(tabId);
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("tabId", tabId);
        reply.put("rev", mdoc == null ? 0 : mdoc.get("rev"));
        if (mdoc == null) {
            reply.put("view", "stream");
            reply.put("fallback", Map.of("reason", "not_page"));
        } else {
            reply.put("view", "simplified");
            reply.put("mdoc", mdoc);
        }
        return reply;
    }

    @Override
    public Map<String, Object> act(String runId, String tabId, String nodeId, String action, Object value, String fp, String block, long rev,
            boolean spend, boolean submit) throws RpcException {
        require(runId, tabId);
        acts.add(new Act(runId, tabId, nodeId, action, value, fp, block, rev));
        spends.add(spend);
        submits.add(submit);
        if (actFails != null) {
            throw actFails;
        }
        // As the action proxy: a click or an Enter that submits a form, not allowed to, is refused changed.
        Map<String, Object> look = "click".equals(action) ? clickLooks.get(nodeId) : "Enter".equals(value) ? enterLooks.get(nodeId) : null;
        if (look != null && "submit".equals(look.get("nav")) && !submit) {
            throw new RpcException(RpcException.CONFLICT, "no", Map.of("reason", "changed"));
        }
        Map<String, Object> answer = new LinkedHashMap<>(actAfter);
        answer.put("done", true);
        return answer;
    }

    @Override
    public Map<String, Object> actLook(String runId, String tabId, String nodeId, String fp, String key) throws RpcException {
        require(runId, tabId);
        clickLooked.add(nodeId);
        String refused = clickLookRefusals.get(nodeId);
        if (refused != null) {
            throw "sensitive".equals(refused) ? new RpcException(RpcException.FORBIDDEN, "no", Map.of("reason", "sensitive"))
                    : new RpcException(RpcException.CONFLICT, "no", Map.of("reason", refused));
        }
        Map<String, Object> said = new LinkedHashMap<>();
        said.put("nav", null);
        said.put("url", null);
        said.put("search", false);
        said.put("pay", paymentFrames.contains(tabId));
        said.put("button", null);
        said.putAll((key == null ? clickLooks : "Enter".equals(key) ? enterLooks : Map.<String, Map<String, Object>>of())
                .getOrDefault(nodeId, Map.of()));
        return said;
    }

    @Override
    public boolean paymentFrame(String runId, String tabId) throws RpcException {
        require(runId, tabId);
        return paymentFrames.contains(tabId);
    }

    @Override
    public boolean refusedAsSensitive(String runId, String tabId, String nodeId) {
        return refusedNodes.contains(nodeId);
    }

    @Override
    public boolean sensitiveSite(String site) {
        return sensitiveSites.contains(site);
    }

    @Override
    public boolean paymentHost(String host) {
        return host != null && paymentHosts.contains(host);
    }

    @Override
    public void runEnded(String runId) {
        ended.add(runId);
        Set<String> gone = new HashSet<>();
        for (Tab tab : tabs.values()) {
            if (tab.runId().equals(runId)) {
                gone.add(tab.tabId());
            }
        }
        tabs.keySet().removeAll(gone);
        sites.remove(runId);
    }

    private Tab require(String runId, String tabId) throws RpcException {
        Tab tab = tab(runId, tabId);
        if (tab == null) {
            throw new RpcException(RpcException.NOT_FOUND, "tab", Map.of("reason", "not_found"));
        }
        return tab;
    }
}
