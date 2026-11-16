package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Clock;
import java.util.Map;
import java.util.function.Function;

/**
 * The walker and the action proxy for the Agent's Browser tools (draft ADR "the Agent's tools and approvals", sections 2
 * and 5): a second {@link MinifiedModule}, over the Agent's own tabs only, with every check the member's simplified view
 * has. Reads are the MDoc; actions go through {@link ActionProxy} unchanged: the node in the tab's current MDoc with its
 * fingerprint, block and rev, every other frame armed, the hit test, and a sensitive field refused (T47-1, T47-2, T47-3).
 *
 * <p><b>What it never reaches.</b> Its methods and its topic go to a dispatcher and a hub of its own that no session holds,
 * so nothing a client sends gets here and nothing here is published to one. Its site memory is in RAM: the Agent's browsing
 * never writes the member's {@code minified-sites.json} or the ad switch's file. It falls back on every site the member
 * marked sensitive, as the member's own view does, and on deskd's shipped list. deskd's consent press and the media verbs
 * are off here: nothing the member didn't ask for is pressed in a page the Agent has.
 *
 * <p><b>Clicks and keys</b> are deskd's half's own, from deskd's isolated world ({@link ActionProxy}'s Agent mode, S-14):
 * trusted input never reaches the Agent's hidden tabs on a desk's Chromium, and none is ever sent on an Agent path.
 *
 * <p><b>Browser time.</b> None of this counts as Browser time on a free desk, and nothing here asks the free tier: the
 * view's {@code used()} and time checks are its RPC methods', which this never calls (ADR 0090, draft ADR section 8).
 */
public final class AgentView {

    /** deskd's isolated world's name: every script on an Agent path runs there, never in the page's own world. */
    public static final String WORLD = Scripts.WORLD;

    private final MinifiedModule module;
    private final ActionProxy proxy;

    private AgentView(MinifiedModule module) {
        this.module = module;
        this.proxy = new ActionProxy(module, true);
    }

    /**
     * @param access the Agent's tabs, and only those
     * @param flags the member's view's kill switch: off, this is off too
     * @param member the member's own view, whose sensitive marks this follows, read only; or null
     */
    public static AgentView create(TabAccess access, MinifiedSwitch flags, MinifiedModule.Timing timing, MinifiedModule member) {
        MinifiedSwitch agentFlags = new MinifiedSwitch() {
            @Override
            public boolean on() {
                return flags.on();
            }

            @Override
            public boolean mediaActions() {
                return false;
            }

            @Override
            public boolean consentReject() {
                return false;
            }

            /** The pre-scroll is the member's view's: it brings in a member's tab's lazy content as the view shows it. */
            @Override
            public boolean prescroll() {
                return false;
            }
        };
        // A dispatcher and a hub no session holds: the view's RPC methods and topic are registered where nothing reaches.
        MinifiedModule module = new MinifiedModule(
                access, new RpcDispatcher(), new EventHub(new TopicRegistry()), null, Clock.systemUTC(), timing, agentFlags);
        if (member != null) {
            module.alsoSensitive(member::markedSensitive);
        }
        return new AgentView(module);
    }

    /** The kill switch: off, the Agent's Browser tools are unavailable. */
    public boolean on() {
        return module.flags.on();
    }

    /**
     * What the tab shows now, as {@code browser.minified.get} answers it: {@code {tabId, rev, view, mdoc?, fallback?}}. Work:
     * Chromium is thawed for it first.
     */
    public Map<String, Object> read(String tabId) throws RpcException, InterruptedException {
        if (!on()) {
            throw disabled();
        }
        return module.get(tabId, null, false);
    }

    /**
     * One action, as {@code browser.minified.act} does it, with no session's context: {@code {done, reason?}}, or the
     * proxy's refusal ({@code conflict} with {@code changed}, {@code gone}, …; {@code forbidden} {@code sensitive}).
     */
    public Map<String, Object> act(String tabId, String nodeId, String action, Object value, String fp, String block, long rev)
            throws RpcException, InterruptedException {
        return act(tabId, nodeId, action, value, fp, block, rev, null, false, false);
    }

    /**
     * As {@link #act}, with where a click or Enter would navigate checked first, whether the member approved it as a
     * spend, and whether a click may submit a form ({@link ActionProxy.Request}).
     *
     * @param navCheck an absolute URL to a refusal word ({@code off_site}, {@code blocked}), or null to let it go
     * @param submit a click that submits a form may be done; otherwise one that does is refused {@code changed}
     */
    public Map<String, Object> act(String tabId, String nodeId, String action, Object value, String fp, String block, long rev,
            Function<String, String> navCheck, boolean spend, boolean submit) throws RpcException, InterruptedException {
        if (!on()) {
            throw disabled();
        }
        return proxy.act(null, new ActionProxy.Request(tabId, nodeId, action, value, fp, block, rev, navCheck, spend, submit));
    }

    /**
     * What deskd's half says a click on this node, or a key in it, would do (the {@code agentClick} or {@code agentPress}
     * op's look), with nothing done, focused or scrolled: whether it follows a link or submits a form, where to, whether
     * that form is a search (a GET form holding a search box), the submit button's words for a key, and whether a
     * payment provider's frame is on the page. The node must be in the tab's current view with this fingerprint. Work:
     * Chromium is thawed for it first.
     *
     * @param key null for a click, or the key ({@code Enter} is the one that can submit)
     * @return {@code {nav, url, search, button, pay}}; {@code nav} is {@code link}, {@code submit} or null
     * @throws RpcException {@code conflict} {@code changed} or {@code gone} (the node isn't what the view showed),
     *     {@code forbidden} {@code sensitive}, or {@code unavailable}
     */
    public Map<String, Object> actLook(String tabId, String nodeId, String fp, String key) throws RpcException, InterruptedException {
        if (!on()) {
            throw disabled();
        }
        try (AutoCloseable use = module.access.use()) {
            TabRef tab = module.access.resolve(tabId);
            MinifiedModule.TabState state = module.existing(tab.tabId());
            MDoc doc = state == null ? null : module.doc(state);
            MDoc.Node node = doc == null ? null : doc.nodes.get(nodeId);
            if (node == null || !node.fp().equals(fp)) {
                throw conflict("changed");
            }
            Map<String, Object> args = new java.util.LinkedHashMap<>();
            args.put("op", key == null ? "agentClick" : "agentPress");
            args.put("node", nodeId);
            args.put("fp", fp);
            if (key != null) {
                args.put("key", key);
            }
            args.put("payHosts", module.lists.payment);
            args.put("look", true);
            Map<String, Object> got;
            try {
                got = module.world.run(tab, args, module.timing.request());
            } catch (CdpFailure e) {
                throw e.kind() == CdpFailure.Kind.REMOTE ? conflict("changed") : MinifiedModule.unavailable();
            }
            Object refused = got.get("refused");
            if ("sensitive".equals(refused)) {
                throw new RpcException(RpcException.FORBIDDEN, "A sensitive field", Map.of("reason", "sensitive"));
            }
            if (refused != null || got.get("error") != null || Boolean.TRUE.equals(got.get("missing"))) {
                throw conflict("gone".equals(refused) ? "gone" : "changed");
            }
            Map<String, Object> said = new java.util.LinkedHashMap<>();
            Object nav = got.get("nav");
            said.put("nav", "link".equals(nav) || "submit".equals(nav) ? nav : null);
            said.put("url", got.get("url") instanceof String url && url.length() <= 8192 ? url : null);
            said.put("search", Boolean.TRUE.equals(got.get("search")));
            said.put("button", got.get("button") instanceof String button ? Text.clean(button, 200) : null);
            // Anything but a plain no is a payment frame, as paymentFrame has it.
            said.put("pay", !Boolean.FALSE.equals(got.get("pay")));
            return said;
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw MinifiedModule.unavailable();
        }
    }

    private static RpcException conflict(String reason) {
        return new RpcException(RpcException.CONFLICT, "Refused", Map.of("reason", reason));
    }

    /**
     * Whether deskd's half sees a payment provider's frame anywhere in the tab's top document, whatever its size, as the
     * Agent's click checks again at the act (Security, S-14). Anything but a plain no, an unreadable page included, is
     * a yes. Work: Chromium is thawed for it first.
     */
    public boolean paymentFrame(String tabId) throws RpcException, InterruptedException {
        if (!on()) {
            throw disabled();
        }
        try (AutoCloseable use = module.access.use()) {
            TabRef tab = module.access.resolve(tabId);
            Map<String, Object> got = module.world.run(tab, Map.of("op", "payFrames", "payHosts", module.lists.payment),
                    module.timing.request());
            return !Boolean.FALSE.equals(got.get("pay"));
        } catch (RpcException | InterruptedException e) {
            throw e;
        } catch (Exception e) {
            return true;
        }
    }

    /**
     * Whether this is one of deskd's own scripts or functions for its world, as {@code PageWorld} sends them: the only
     * script an Agent path may carry ({@code AgentCdp}). Never anything a model, a client or a page wrote.
     */
    public boolean ownScript(String source) {
        return module.world.ownScript(source);
    }

    /** Whether the proxy has refused this node as a sensitive field in the tab's current document (T47-1). */
    public boolean refusedAsSensitive(String tabId, String nodeId) {
        MinifiedModule.TabState state = module.existing(tabId);
        if (state == null) {
            return false;
        }
        module.lock.lock();
        try {
            return state.sensitiveRefs.contains(nodeId);
        } finally {
            module.lock.unlock();
        }
    }

    /** Whether deskd's shipped list holds this host's site, or the member marked it: a site the walker never reads. */
    public boolean sensitiveSite(String host) {
        return host != null && (HostLists.on(module.lists.sensitive, host) || module.memory.get(host).sensitive()
                || module.alsoSensitiveSite(host));
    }

    /** Whether a frame of a payment provider on deskd's list is on this host. */
    public boolean paymentHost(String host) {
        return host != null && HostLists.on(module.lists.payment, host);
    }

    public void close() {
        module.close();
    }

    /** The site a host is part of (its registrable domain, as site memory keeps it), or null. */
    public static String site(String host) {
        return host == null ? null : SiteMemory.registrable(host);
    }

    /** The host an http or https URL is on, in ASCII and lower case, or null. */
    public static String hostOf(String url) {
        return url == null ? null : SiteMemory.hostOf(url);
    }

    private static RpcException disabled() {
        return new RpcException(RpcException.UNAVAILABLE, "Not turned on for this desk", Map.of("reason", "disabled"));
    }
}
