package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.browser.AgentBrowser;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The Browser area of the Agent's tools (draft ADR "the Agent's tools and approvals", sections 2, 5 and 6; API.md section
 * 18): {@code browser_open}, {@code browser_read}, {@code browser_click}, {@code browser_type}, {@code browser_press},
 * {@code browser_back}, {@code browser_close}, {@code browser_tabs} and {@code browser_use_my_session}, on the Agent's own
 * tabs ({@link AgentBrowser}) and nowhere else. Reads are the walker's MDoc as text with refs ({@link BrowserText});
 * actions go through the action proxy with all its checks.
 *
 * <p><b>Refs.</b> Each control the model may act on has a short ref, {@code n12}, the same for the same node while its
 * document lasts. {@link #look} expands it to {@code {node, fp, block, rev}} and adds the {@code label}, {@code role} and
 * {@code origin} the page showed, so an approval binds what the member's card shows; an expanded ref is taken as it is,
 * and the action proxy refuses ({@code changed}, {@code gone}) a page that no longer shows exactly that.
 *
 * <p><b>The class only rises</b> ({@link #look}, {@code Look.risk}), decided before anything is done:
 * <ul>
 *   <li>In the Agent's own context: a click on a control that looks like a form's submit, or {@code Enter} in a field
 *       that sends (not a search box), is {@code send}; a click or {@code Enter} that looks like paying (a control
 *       labelled buy, pay, place order, checkout, subscribe, donate, confirm purchase; a card field on the page; a
 *       payment provider's page; a payment provider's frame anywhere in the page, whatever its size and whatever the
 *       control says, by Chromium's frame tree and by deskd's half, Security's S-14 rule) is {@code spend}. A spend's
 *       payload says {@code spend: true}, so the member's approval binds it, and a click or submit on a page that has
 *       become a payment page since the card is refused {@code changed}.
 *   <li>In a member-session tab: {@code browser_open} and {@code browser_back} are {@code egress}, always, whatever the
 *       run's taint (Security's priority finding), and so is a click on a link, a navigation the Agent starts; every
 *       other click, typing and press is at least {@code write}, and {@code send} or {@code spend} as above. A
 *       navigation off the granted site is refused at look ({@code off_site}, a link by the address the walker read),
 *       again on the element itself as it's clicked, and one a page or a click starts is cancelled at the request
 *       ({@code off_site}).
 *   <li>Typing into a sensitive field (by deskd's walker, the action proxy, or its label), or text that holds a card
 *       number, is refused at look ({@code sensitive}) and again at run, approved or not; so is a click or a key in a
 *       field or select that's sensitive, and Backspace on a payment provider's page.
 * </ul>
 *
 * <p><b>Clicks and keys</b> are deskd's half's own untrusted {@code el.click()} and key events, from deskd's isolated
 * world (the action proxy's Agent mode): trusted input never reaches the Agent's hidden tabs on a desk's Chromium. Every
 * value of the model's (the ref, the text, the key) goes to the page as a JSON argument, never as script.
 *
 * <p><b>Taint.</b> A result with page text adds {@code U}; one from a member-session tab adds {@code S} as well.
 *
 * <p>Nothing here logs or throws a URL, a title, page text or typed text.
 */
public final class BrowserTools implements HostedTool {

    /** The keys {@code browser_press} takes: the action proxy's. */
    static final Set<String> KEYS = Set.of("Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "Backspace");
    static final int MAX_TEXT_CHARS = 64 * 1024;
    /** Kinds of field that typing can't fill, as the action proxy has them. */
    private static final Set<String> UNTYPEABLE = Set.of(
            "file_choice", "colour_choice", "range_choice", "date_choice", "time_choice", "datetime_choice", "month_choice", "week_choice");
    private static final Set<String> CONFLICTS = Set.of("changed", "gone", "off_site", "kind");
    private static final Set<String> FORBIDDEN = Set.of("sensitive", "blocked", "tab_cap", "ask_cap", "off_site");
    private static final String SEP = "\u0000";

    private final AgentBrowser browser;
    /** Each run's tabs' refs, by run and tab. */
    private final Map<String, RefBook> books = new ConcurrentHashMap<>();

    /** One tab's refs in one run: the same node keeps its ref while its document lasts. */
    private static final class RefBook {
        private String document = "";
        private int next = 1;
        private final Map<String, String> byNode = new HashMap<>();
        private Map<String, BrowserText.Ref> byRef = Map.of();
        private final Map<String, BrowserText.Ref> latestByNode = new HashMap<>();
        private boolean payment;
        private boolean fields;

        synchronized void document(String now) {
            if (!Objects.equals(document, now)) {
                document = now;
                next = 1;
                byNode.clear();
                byRef = Map.of();
                latestByNode.clear();
                payment = false;
                fields = false;
            }
        }

        synchronized String refFor(String node) {
            return byNode.computeIfAbsent(node, n -> byNode.size() < 100_000 ? "n" + next++ : null);
        }

        synchronized void take(BrowserText.Rendered rendered) {
            byRef = Map.copyOf(rendered.refs());
            latestByNode.clear();
            for (BrowserText.Ref ref : rendered.refs().values()) {
                latestByNode.put(ref.node(), ref);
            }
            payment = rendered.payment();
            fields = rendered.fields();
        }

        synchronized void clear() {
            byRef = Map.of();
            latestByNode.clear();
            payment = false;
            fields = false;
        }

        synchronized BrowserText.Ref byRef(String ref) {
            return byRef.get(ref);
        }

        synchronized BrowserText.Ref byNode(String node) {
            return latestByNode.get(node);
        }

        synchronized boolean payment() {
            return payment;
        }

        synchronized boolean fields() {
            return fields;
        }
    }

    /** @param browser the Agent's Browser, or null where there's none: then the tools are unavailable */
    public BrowserTools(AgentBrowser browser) {
        this.browser = browser;
    }

    @Override
    public boolean available() {
        return browser != null && browser.available();
    }

    @Override
    public void runEnded(String runId) {
        if (browser != null) {
            browser.runEnded(runId);
        }
        books.keySet().removeIf(key -> key.startsWith(runId + SEP));
    }

    // ---- look

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        requireBrowser();
        return switch (call.tool()) {
            case "browser_open" -> lookOpen(call);
            case "browser_read" -> {
                AgentBrowser.Tab tab = tab(call);
                Map<String, Object> payload = payload("tabId", tab.tabId());
                if (call.args().get("from") != null) {
                    payload.put("from", from(call.args()));
                }
                yield new Look(null, context(tab), siteTarget(tab), payload, null, null);
            }
            case "browser_click", "browser_type", "browser_press" -> lookAct(call);
            case "browser_back" -> lookBack(call);
            case "browser_close" -> {
                AgentBrowser.Tab tab = tab(call);
                yield new Look(null, context(tab), siteTarget(tab), payload("tabId", tab.tabId()), null, null);
            }
            case "browser_tabs" -> Look.plain(Map.of(), Map.of());
            case "browser_use_my_session" -> lookSession(call);
            default -> throw ToolFailure.notFound("tool");
        };
    }

    private Look lookOpen(HostedCall call) throws ToolFailure {
        String raw = string(call.args(), "url");
        Object tabArg = call.args().get("tabId");
        String url;
        String refusal = null;
        try {
            url = AgentBrowser.checkUrl(raw);
        } catch (RpcException e) {
            if (!"blocked".equals(reason(e))) {
                throw ToolFailure.badArgs("url");
            }
            url = raw;
            refusal = "blocked";
        }
        Map<String, Object> payload = payload("url", url);
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("kind", "site");
        target.put("origin", AgentBrowser.originOf(url));
        if (tabArg == null) {
            if (refusal == null && browser.agentTabs() >= browser.tabCap()) {
                refusal = "tab_cap";
            }
            return new Look(null, "agent", target, payload, null, refusal);
        }
        AgentBrowser.Tab tab = tab(call);
        payload.put("tabId", tab.tabId());
        if (!tab.member()) {
            return new Look(null, "agent", target, payload, null, refusal);
        }
        // Security's priority finding: every navigation the Agent starts in the member's session asks, as egress.
        if (refusal == null && !tab.site().equals(AgentBrowser.siteOf(url))) {
            refusal = "off_site";
        }
        return new Look(ToolRisk.EGRESS, context(tab), target, payload, before(tab), refusal);
    }

    private Look lookBack(HostedCall call) throws ToolFailure, InterruptedException {
        AgentBrowser.Tab tab = tab(call);
        Map<String, Object> payload = payload("tabId", tab.tabId());
        if (!tab.member()) {
            return new Look(null, "agent", siteTarget(tab), payload, null, null);
        }
        String refusal = null;
        try {
            String back = browser.backUrl(call.runId(), tab.tabId());
            if (back != null && !tab.site().equals(AgentBrowser.siteOf(back))) {
                refusal = "off_site";
            }
        } catch (RpcException e) {
            throw failure(e);
        }
        return new Look(ToolRisk.EGRESS, context(tab), siteTarget(tab), payload, before(tab), refusal);
    }

    private Look lookSession(HostedCall call) throws ToolFailure {
        String site = site(call.args());
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("kind", "site");
        target.put("site", site);
        String refusal = null;
        if (browser.sensitiveSite(site)) {
            // A site the walker never reads (money, mail, health, identity, or the member's own mark): never granted.
            refusal = "blocked";
        } else {
            Set<String> sites = browser.sites(call.runId());
            if (!sites.contains(site) && sites.size() >= AgentBrowser.SITES_A_RUN) {
                refusal = "ask_cap";
            }
        }
        return new Look(ToolRisk.EGRESS, "member:" + site, target, payload("site", site), null, refusal);
    }

    /** What an action is, as the page showed it when the model read it, and what class it rises to. */
    private record Action(AgentBrowser.Tab tab, BrowserText.Ref ref, String origin, Map<String, Object> payload, ToolRisk risk,
            String refusal) {}

    private Look lookAct(HostedCall call) throws ToolFailure, InterruptedException {
        Action action = action(call);
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("kind", "element");
        target.put("origin", action.origin());
        target.put("pageTitle", action.tab().title());
        target.put("label", action.ref().label());
        target.put("role", action.ref().kind());
        return new Look(action.risk(), context(action.tab()), target, action.payload(), null, action.refusal());
    }

    private Action action(HostedCall call) throws ToolFailure, InterruptedException {
        AgentBrowser.Tab tab = tab(call);
        RefBook book = books.get(key(call.runId(), tab.tabId()));
        BrowserText.Ref ref = expand(book, call.args());
        String origin = AgentBrowser.originOf(tab.url());
        // An approved call names the origin the member saw: a tab that's elsewhere now isn't that page.
        if (call.args().get("origin") != null && !Objects.equals(call.args().get("origin"), origin)) {
            throw ToolFailure.refused("changed");
        }
        Map<String, Object> refMap = new LinkedHashMap<>();
        refMap.put("node", ref.node());
        refMap.put("fp", ref.fp());
        refMap.put("block", ref.block());
        refMap.put("rev", ref.rev());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("tabId", tab.tabId());
        payload.put("ref", refMap);
        payload.put("label", ref.label());
        payload.put("role", ref.kind());
        payload.put("origin", origin);
        boolean member = tab.member();
        boolean payingPage = book != null && book.payment() || browser.paymentHost(AgentBrowser.hostOf(tab.url()));
        ToolRisk risk = member ? ToolRisk.WRITE : null;
        String refusal = null;
        switch (call.tool()) {
            case "browser_click" -> {
                if (payingPage || BrowserText.looksLikePaying(ref) || paymentFrame(call, tab)) {
                    risk = ToolRisk.SPEND;
                } else if (BrowserText.looksLikeSubmit(ref, book != null && book.fields())) {
                    risk = ToolRisk.SEND;
                } else if (member && "link".equals(ref.kind())) {
                    // A navigation the Agent starts in the member's session asks as egress (Security's priority finding).
                    risk = ToolRisk.EGRESS;
                }
                if (sensitiveControl(call.runId(), tab, ref)) {
                    refusal = "sensitive";
                } else {
                    refusal = linkRefusal(tab, ref);
                }
            }
            case "browser_press" -> {
                String key = string(call.args(), "key");
                if (!KEYS.contains(key)) {
                    throw ToolFailure.badArgs("key");
                }
                payload.put("key", key);
                if ("Enter".equals(key) && enterSends(ref)) {
                    if (payingPage || BrowserText.looksLikePaying(ref) || paymentFrame(call, tab)) {
                        risk = ToolRisk.SPEND;
                    } else if (member || !"query".equals(ref.fieldKind())) {
                        // A search box's Enter is a search, as an open of its results would be; any other field's sends a form.
                        risk = ToolRisk.SEND;
                    }
                }
                if (sensitiveControl(call.runId(), tab, ref)
                        || "Backspace".equals(key) && browser.paymentHost(AgentBrowser.hostOf(tab.url()))) {
                    // Backspace edits a field, as typing does.
                    refusal = "sensitive";
                }
            }
            case "browser_type" -> {
                if (!(call.args().get("text") instanceof String text)) {
                    throw ToolFailure.badArgs("text");
                }
                if (text.length() > MAX_TEXT_CHARS) {
                    throw new ToolFailure(RpcException.TOO_LARGE, "too_large", Map.of("limit", MAX_TEXT_CHARS));
                }
                payload.put("text", text);
                if (ref.kind() != null && !"field".equals(ref.kind())) {
                    throw ToolFailure.refused("kind");
                }
                if (ref.fieldKind() != null && UNTYPEABLE.contains(ref.fieldKind())) {
                    throw ToolFailure.refused("kind");
                }
                if (sensitive(call.runId(), tab, ref, text)) {
                    refusal = "sensitive";
                }
            }
            default -> throw ToolFailure.notFound("tool");
        }
        if (risk == ToolRisk.SPEND) {
            payload.put("spend", true);
            // At run the call is what the member approved: a spend they weren't shown as one isn't done.
            if (!call.look() && !Boolean.TRUE.equals(call.args().get("spend"))) {
                throw ToolFailure.refused("changed");
            }
        }
        return new Action(tab, ref, origin, payload, risk, refusal);
    }

    /** A payment provider's frame anywhere in the tab now (Security, S-14). */
    private boolean paymentFrame(HostedCall call, AgentBrowser.Tab tab) throws ToolFailure, InterruptedException {
        try {
            return browser.paymentFrame(call.runId(), tab.tabId());
        } catch (RpcException e) {
            throw failure(e);
        }
    }

    /** A field or a select that's sensitive, by the proxy's own refusal or its label: never clicked or keyed into. */
    private boolean sensitiveControl(String runId, AgentBrowser.Tab tab, BrowserText.Ref ref) {
        return ("field".equals(ref.kind()) || "select".equals(ref.kind()))
                && (browser.refusedAsSensitive(runId, tab.tabId(), ref.node()) || BrowserText.looksSensitive(ref));
    }

    /**
     * A link whose address, as the walker read it, is a local host ({@code blocked}) or, in a member-session tab, another
     * site ({@code off_site}): refused before anyone is asked. The element's own address is checked again as it's clicked.
     */
    private static String linkRefusal(AgentBrowser.Tab tab, BrowserText.Ref ref) {
        if (!"link".equals(ref.kind()) || ref.url() == null) {
            return null;
        }
        String url;
        try {
            url = AgentBrowser.checkUrl(ref.url());
        } catch (RpcException e) {
            return "blocked".equals(reason(e)) ? "blocked" : null;
        }
        return tab.member() && !tab.site().equals(AgentBrowser.siteOf(url)) ? "off_site" : null;
    }

    /** Enter in this sends what's in it: a field that isn't many lines, or one the page submits on Enter. */
    private static boolean enterSends(BrowserText.Ref ref) {
        return "field".equals(ref.kind()) && (!"multiline".equals(ref.fieldKind()) || ref.enter())
                || ref.kind() == null;
    }

    /** Never typed, approved or not (T47-1, draft ADR "Spending"). */
    private boolean sensitive(String runId, AgentBrowser.Tab tab, BrowserText.Ref ref, String text) {
        return browser.refusedAsSensitive(runId, tab.tabId(), ref.node())
                || BrowserText.looksSensitive(ref)
                || BrowserText.holdsCardNumber(text)
                || browser.paymentHost(AgentBrowser.hostOf(tab.url()));
    }

    /**
     * A ref as the model gives it ({@code n12}, from the tab's last read) or already expanded ({@code {node, fp, block,
     * rev}}, as an approved call's payload has it).
     */
    private static BrowserText.Ref expand(RefBook book, Map<String, Object> args) throws ToolFailure {
        Object raw = args.get("ref");
        if (raw instanceof String short_) {
            BrowserText.Ref ref = book == null ? null : book.byRef(short_);
            if (ref == null) {
                throw ToolFailure.notFound("not_found");
            }
            return ref;
        }
        if (!(raw instanceof Map<?, ?> map) || !(map.get("node") instanceof String node) || !(map.get("fp") instanceof String fp)
                || !(map.get("block") instanceof String block) || !(map.get("rev") instanceof Number rev)
                || rev.doubleValue() != rev.longValue() || node.length() > 128 || fp.length() > 32 || block.length() > 32) {
            throw ToolFailure.badArgs("ref");
        }
        BrowserText.Ref known = book == null ? null : book.byNode(node);
        if (known != null && known.fp().equals(fp) && known.block().equals(block)) {
            return new BrowserText.Ref(known.ref(), node, fp, block, rev.longValue(), known.kind(), known.fieldKind(), known.label(),
                    known.name(), known.enter(), known.primary(), known.url());
        }
        // Not as the last read had it: the payload's own words, and the action proxy decides whether the page still shows it.
        String label = args.get("label") instanceof String l ? l : "";
        String role = args.get("role") instanceof String r ? r : null;
        return new BrowserText.Ref(null, node, fp, block, rev.longValue(), role, null, label, null, false, false);
    }

    // ---- run

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        requireBrowser();
        if (!browser.available()) {
            throw ToolFailure.unavailable("disabled");
        }
        String runId = call.runId();
        try {
            return switch (call.tool()) {
                case "browser_open" -> {
                    String url;
                    try {
                        url = AgentBrowser.checkUrl(string(call.args(), "url"));
                    } catch (RpcException e) {
                        throw "blocked".equals(reason(e)) ? ToolFailure.forbidden("blocked") : ToolFailure.badArgs("url");
                    }
                    AgentBrowser.Navigated navigated;
                    if (call.args().get("tabId") == null) {
                        navigated = browser.open(runId, url);
                    } else {
                        AgentBrowser.Tab tab = tab(call);
                        navigated = browser.navigate(runId, tab.tabId(), url);
                    }
                    yield page(runId, navigated.tabId(), 0, navigated.netError(), null);
                }
                case "browser_read" -> {
                    AgentBrowser.Tab tab = tab(call);
                    yield page(runId, tab.tabId(), call.args().get("from") == null ? 0 : from(call.args()), null, null);
                }
                case "browser_click", "browser_type", "browser_press" -> act(call);
                case "browser_back" -> {
                    AgentBrowser.Tab tab = tab(call);
                    AgentBrowser.Navigated navigated = browser.back(runId, tab.tabId());
                    yield page(runId, navigated.tabId(), 0, navigated.netError(), null);
                }
                case "browser_close" -> {
                    AgentBrowser.Tab tab = tab(call);
                    browser.close(runId, tab.tabId());
                    books.remove(key(runId, tab.tabId()));
                    Map<String, Object> chip = chip(tab, siteTarget(tab));
                    yield new Result(Map.of("closed", tab.tabId()), Set.of(), chip);
                }
                case "browser_tabs" -> tabs(runId);
                case "browser_use_my_session" -> {
                    String site = site(call.args());
                    AgentBrowser.Navigated navigated = browser.useSession(runId, site);
                    yield page(runId, navigated.tabId(), 0, navigated.netError(), null);
                }
                default -> throw ToolFailure.notFound("tool");
            };
        } catch (RpcException e) {
            throw failure(e);
        }
    }

    private Result act(HostedCall call) throws ToolFailure, RpcException, InterruptedException {
        Action action = action(call);
        if (action.refusal() != null) {
            // ToolHost refuses these before running; here as well, for any way in.
            throw ToolFailure.forbidden(action.refusal());
        }
        BrowserText.Ref ref = action.ref();
        String verb;
        Object value;
        switch (call.tool()) {
            case "browser_click" -> {
                verb = "click";
                value = null;
            }
            case "browser_type" -> {
                verb = "fill";
                value = action.payload().get("text");
            }
            default -> {
                verb = "press";
                value = action.payload().get("key");
            }
        }
        // A spend the member approved as one: a payment provider's frame on the page is what they saw.
        boolean spend = Boolean.TRUE.equals(call.args().get("spend"));
        Map<String, Object> done = browser.act(call.runId(), action.tab().tabId(), ref.node(), verb, value, ref.fp(), ref.block(), ref.rev(),
                spend);
        Map<String, Object> outcome = new LinkedHashMap<>();
        outcome.put("done", Boolean.TRUE.equals(done.get("done")));
        if (done.get("reason") instanceof String reason) {
            outcome.put("reason", reason);
        }
        if (Boolean.TRUE.equals(done.get("reformatted"))) {
            outcome.put("reformatted", true);
        }
        if (Boolean.TRUE.equals(done.get("submitted"))) {
            outcome.put("submitted", true);
        }
        return page(call.runId(), action.tab().tabId(), 0, null, outcome);
    }

    /**
     * The tab's view as text, one page of it, with what came before it ({@code outcome}, for an action), and the refs
     * taken for the next action.
     */
    private Result page(String runId, String tabId, int from, String netError, Map<String, Object> outcome)
            throws RpcException, InterruptedException, ToolFailure {
        Map<String, Object> reply = browser.read(runId, tabId);
        AgentBrowser.Tab tab = browser.tab(runId, tabId);
        if (tab == null) {
            throw ToolFailure.notFound("gone");
        }
        RefBook book = books.computeIfAbsent(key(runId, tabId), k -> new RefBook());
        book.document(tab.document());
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("tabId", tabId);
        if (outcome != null) {
            content.putAll(outcome);
        }
        content.put("session", tab.member() ? "member" : "agent");
        if (tab.member()) {
            content.put("site", tab.site());
        }
        content.put("url", tab.url());
        content.put("origin", AgentBrowser.originOf(tab.url()));
        content.put("title", tab.title());
        if (netError != null) {
            content.put("netError", netError);
        }
        Map<String, Object> mdoc = Json.object(reply, "mdoc");
        String view = reply.get("view") instanceof String v ? v : "pending";
        if ("simplified".equals(view) && mdoc != null) {
            BrowserText.Rendered rendered = BrowserText.render(mdoc, book::refFor);
            book.take(rendered);
            content.put("view", "page");
            content.putAll(BrowserText.page(rendered.text(), from));
        } else {
            book.clear();
            Map<String, Object> fallback = Json.object(reply, "fallback");
            if ("stream".equals(view) && fallback != null) {
                content.put("view", "not_readable");
                content.put("reason", fallback.get("reason"));
                if (fallback.get("cause") != null) {
                    content.put("cause", fallback.get("cause"));
                }
                content.put("note", "deskd can't read this page as text (" + fallback.get("reason") + "). Only the member can use it, "
                        + "on the real page.");
            } else {
                content.put("view", "loading");
                content.put("note", "The page isn't ready to read yet. Read it again in a moment.");
            }
        }
        Set<String> taints = new LinkedHashSet<>();
        taints.add("U");
        if (tab.member()) {
            taints.add("S");
        }
        return new Result(content, taints, chip(tab, siteTarget(tab)));
    }

    private Result tabs(String runId) {
        List<Object> list = new ArrayList<>();
        boolean titled = false;
        boolean member = false;
        for (AgentBrowser.Tab tab : browser.tabs(runId)) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("tabId", tab.tabId());
            entry.put("session", tab.member() ? "member" : "agent");
            if (tab.member()) {
                entry.put("site", tab.site());
                member = true;
            }
            entry.put("origin", AgentBrowser.originOf(tab.url()));
            entry.put("title", tab.title());
            titled |= !tab.title().isEmpty();
            list.add(entry);
        }
        Set<String> taints = new LinkedHashSet<>();
        if (titled) {
            taints.add("U");
        }
        if (member) {
            taints.add("S");
        }
        return new Result(Map.of("tabs", list), taints, Map.of("session", member ? "member" : "agent"));
    }

    // ---- small things

    private void requireBrowser() throws ToolFailure {
        if (browser == null) {
            throw ToolFailure.unavailable("unavailable");
        }
    }

    private AgentBrowser.Tab tab(HostedCall call) throws ToolFailure {
        if (!(call.args().get("tabId") instanceof String tabId) || tabId.isEmpty() || tabId.length() > 128) {
            throw ToolFailure.badArgs("tabId");
        }
        // Only this run's: another run's tab, or one that's gone, is no tab at all.
        AgentBrowser.Tab tab = browser.tab(call.runId(), tabId);
        if (tab == null) {
            throw ToolFailure.notFound("not_found");
        }
        return tab;
    }

    private static String context(AgentBrowser.Tab tab) {
        return tab.member() ? "member:" + tab.site() : "agent";
    }

    private static Map<String, Object> siteTarget(AgentBrowser.Tab tab) {
        Map<String, Object> target = new LinkedHashMap<>();
        target.put("kind", "site");
        String origin = AgentBrowser.originOf(tab.url());
        if (origin != null) {
            target.put("origin", origin);
        }
        if (tab.member()) {
            target.put("site", tab.site());
        }
        return target;
    }

    /** What a navigation in the member's session leaves: the page's title, read now. */
    private static Map<String, Object> before(AgentBrowser.Tab tab) {
        return tab.title().isEmpty() ? null : Map.of("title", tab.title());
    }

    private static Map<String, Object> chip(AgentBrowser.Tab tab, Map<String, Object> target) {
        Map<String, Object> chip = new LinkedHashMap<>();
        chip.put("session", tab.member() ? "member" : "agent");
        chip.put("target", target);
        return chip;
    }

    private static String key(String runId, String tabId) {
        return runId + SEP + tabId;
    }

    private static Map<String, Object> payload(String key, Object value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(key, value);
        return m;
    }

    private static String string(Map<String, Object> args, String key) throws ToolFailure {
        if (!(args.get(key) instanceof String value) || value.isEmpty()) {
            throw ToolFailure.badArgs(key);
        }
        return value;
    }

    private static String site(Map<String, Object> args) throws ToolFailure {
        String site = AgentBrowser.asciiSite(string(args, "site"));
        if (site == null || !AgentBrowser.isSite(site)) {
            throw ToolFailure.badArgs("site");
        }
        return site;
    }

    private static int from(Map<String, Object> args) throws ToolFailure {
        if (!(args.get("from") instanceof Number n) || n.doubleValue() != n.longValue() || n.longValue() < 0 || n.longValue() > Integer.MAX_VALUE) {
            throw ToolFailure.badArgs("from");
        }
        return n.intValue();
    }

    private static String reason(RpcException e) {
        return e.details() != null && e.details().get("reason") instanceof String r ? r : null;
    }

    /** A Browser refusal as one word ({@link ToolFailure}): never a URL or anything of the page. */
    static ToolFailure failure(RpcException e) {
        String reason = reason(e);
        Map<String, Object> extra = e.details() != null && e.details().get("limit") instanceof Number limit ? Map.of("limit", limit) : Map.of();
        return switch (e.code()) {
            case RpcException.NOT_FOUND -> ToolFailure.notFound("gone".equals(reason) ? "gone" : "not_found");
            case RpcException.CONFLICT -> ToolFailure.refused(reason != null && CONFLICTS.contains(reason) ? reason : "changed");
            case RpcException.FORBIDDEN -> new ToolFailure(RpcException.FORBIDDEN, reason != null && FORBIDDEN.contains(reason) ? reason : "blocked",
                    extra);
            case RpcException.BAD_REQUEST -> ToolFailure.badArgs(reason == null ? "args" : reason);
            case RpcException.TOO_LARGE -> new ToolFailure(RpcException.TOO_LARGE, "too_large", extra);
            case RpcException.RATE_LIMITED -> new ToolFailure(RpcException.RATE_LIMITED, "rate_limited");
            case RpcException.UNAVAILABLE -> ToolFailure.unavailable("disabled".equals(reason) ? "disabled" : "unavailable");
            case RpcException.DEADLINE_EXCEEDED -> ToolFailure.unavailable("timeout");
            default -> new ToolFailure(RpcException.INTERNAL, "internal");
        };
    }
}
